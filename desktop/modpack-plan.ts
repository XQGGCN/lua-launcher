import { createHash } from 'node:crypto'
import { MODPACK_LIMITS, validatePackPath, type PackFile, type ParsedModpack, type PackProvenance } from './modpack'
import type { PackPlanCounts, PackPlanPage, PackPlanPageOptions, PackPlanRow, PackPlanSummary } from './modpack-plan-types'
export type { PackPlanCounts, PackPlanPage, PackPlanPageOptions, PackPlanRow, PackPlanSummary } from './modpack-plan-types'

export const MODPACK_PLAN_LIMITS = Object.freeze({ rows: MODPACK_LIMITS.files + MODPACK_LIMITS.entries,
  pageRows: 100, pageBytes: 512 * 1024, summaryBytes: 512 * 1024, queryCharacters: 200 })
/** This whole object is main-only. Only summary and bounded pages cross IPC. */
export interface ModpackPlan { readonly summary: PackPlanSummary; readonly rows: readonly PackPlanRow[] }
interface PrivatePlan { pack: ParsedModpack; rows: readonly PackPlanRow[]; optional: Map<string, string>; overrideHashes: Map<string, string>; digest: string; archiveHash: string }
const plans = new WeakMap<ModpackPlan, PrivatePlan>()
const fail = (message: string): never => { throw new Error(message) }
const hash = (algorithm: 'sha1' | 'sha256' | 'sha512', value: string | Buffer) => createHash(algorithm).update(value).digest('hex')
const cloneFile = (file: PackFile): PackFile => ({ ...file, downloads: [...file.downloads], hashes: { ...file.hashes } })
const cloneProvenance = (row: PackProvenance): PackProvenance => ({ ...row, ...(row.environment ? { environment: { ...row.environment } } : {}) })
function source(plan: ModpackPlan): PrivatePlan { const result = plans.get(plan); if (!result) fail('整合包规划无效，请重新读取归档'); return result! }
function selected(proof: PrivatePlan, ids: readonly string[] | undefined, defaultAll: boolean): Set<string> {
  if (ids === undefined && defaultAll) return new Set(proof.optional.keys())
  if (!Array.isArray(ids) || ids.length > MODPACK_LIMITS.files) fail('请选择当前规划中有效的可选文件')
  const result = new Set<string>()
  for (const id of ids!) {
    if (typeof id !== 'string' || !proof.optional.has(id) || result.has(id)) fail('可选文件选择含重复、过期或不可选择的条目，请重新预览')
    result.add(id)
  }
  return result
}
function counts(rows: readonly PackPlanRow[], ids: Set<string>): PackPlanCounts {
  const result: PackPlanCounts = { requiredFiles: 0, optionalFiles: 0, selectedOptionalFiles: 0, skippedOptionalFiles: 0,
    downloadFiles: 0, downloadBytes: 0, overrideFiles: 0, overrideBytes: 0, writeFiles: 0, writeBytes: 0, excludedFiles: 0, shadowedFiles: 0 }
  for (const row of rows) {
    if (row.role === 'server-excluded') { result.excludedFiles++; continue }
    if (!row.effective) { result.shadowedFiles++; continue }
    if (row.origin === 'indexed') {
      if (row.selectable) {
        result.optionalFiles++
        if (!ids.has(row.id)) { result.skippedOptionalFiles++; continue }
        result.selectedOptionalFiles++
      } else result.requiredFiles++
      result.downloadFiles++; result.downloadBytes += row.bytes
    } else { result.overrideFiles++; result.overrideBytes += row.bytes }
  }
  result.writeFiles = result.downloadFiles + result.overrideFiles
  result.writeBytes = result.downloadBytes + result.overrideBytes
  return result
}
function dtoBudget(value: unknown, maximum: number, name: string): void {
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) fail(name + '超过返回大小预算，请缩小页面后重试')
}
function assertProvenance(pack: ParsedModpack): void {
  if (!pack || !Buffer.isBuffer(pack.archive) || !Array.isArray(pack.provenance) || pack.provenance.length > MODPACK_PLAN_LIMITS.rows ||
    !Array.isArray(pack.files) || !Array.isArray(pack.overrides) || pack.files.length + pack.overrides.length > MODPACK_LIMITS.files) fail('整合包没有受支持的完整文件规划')
  const downloads = new Map(pack.files.map(file => [file.path, file])), overrides = new Map(pack.overrides.map(file => [file.path, file]))
  if (downloads.size !== pack.files.length || overrides.size !== pack.overrides.length) fail('整合包有效输出存在重复路径')
  const effective = new Set<string>()
  for (let index = 0; index < pack.provenance.length; index++) {
    const row = pack.provenance[index]
    validatePackPath(row.path)
    if (!['indexed', 'overrides', 'client-overrides', 'server-overrides'].includes(row.origin) || !['required', 'optional', 'server-excluded', 'overrides', 'client-overrides'].includes(row.role) ||
      !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > MODPACK_LIMITS.downloadedFileBytes || typeof row.effective !== 'boolean') fail('整合包文件来源规划无效')
    if (row.shadowedBy !== undefined) {
      const next = pack.provenance[row.shadowedBy]
      if (row.effective || !Number.isSafeInteger(row.shadowedBy) || row.shadowedBy <= index || !next || next.path !== row.path || !['overrides', 'client-overrides'].includes(next.origin)) fail('整合包覆盖来源链无效')
    }
    if (!row.effective) continue
    if (row.role === 'server-excluded' || effective.has(row.path)) fail('整合包有效输出角色或路径有歧义')
    effective.add(row.path)
    if (row.origin === 'indexed') {
      const file = downloads.get(row.path)
      if (!file || overrides.has(row.path) || file.fileSize !== row.bytes || file.optional !== (row.role === 'optional') ||
        file.hashes.sha1 !== row.sha1 || file.hashes.sha512 !== row.sha512 || row.sizeBasis !== 'declared-download' || row.hashBasis !== 'index-declaration') fail('整合包索引来源与实际有效下载不一致')
      downloads.delete(row.path)
    } else {
      const file = overrides.get(row.path)
      if (!file || !['overrides', 'client-overrides'].includes(row.origin) || row.role !== row.origin || row.sizeBasis !== 'verified-archive' ||
        row.hashBasis !== 'archive-payload' || file.data.length !== row.bytes || hash('sha1', file.data) !== row.sha1 || hash('sha512', file.data) !== row.sha512) fail('整合包覆盖来源与实际载荷不一致')
      overrides.delete(row.path)
    }
  }
  if (downloads.size || overrides.size || effective.size !== pack.files.length + pack.overrides.length) fail('整合包文件规划不完整')
}
/** Build stable row IDs from exact archive bytes, source position and role. No
 * content is fetched and no filesystem or Java process is touched here. */
export function createModpackPlan(pack: ParsedModpack): ModpackPlan {
  assertProvenance(pack)
  const archiveSha512 = hash('sha512', pack.archive)
  const ids = pack.provenance.map((row, index) => hash('sha256', JSON.stringify(['lua-mrpack-row', 1, archiveSha512, index, row.origin, row.path])))
  if (new Set(ids).size !== ids.length) fail('整合包文件标识冲突，请重新读取归档')
  const shadows = new Map<number, string[]>()
  for (let index = 0; index < pack.provenance.length; index++) {
    let next = pack.provenance[index].shadowedBy, depth = 0
    while (next !== undefined) {
      if (++depth > 2) fail('整合包覆盖层数超过当前规划支持范围')
      const existing = shadows.get(next) ?? []; existing.push(ids[index]); shadows.set(next, existing)
      next = pack.provenance[next].shadowedBy
    }
  }
  const origins = new Map(ids.map((id, index) => [id, pack.provenance[index].origin]))
  const rows = pack.provenance.map((row, index): PackPlanRow => {
    const { shadowedBy, ...rest } = cloneProvenance(row)
    const previous = shadows.get(index) ?? []
    return { ...rest, id: ids[index], selectable: row.effective && row.origin === 'indexed' && row.role === 'optional', selected: row.effective,
      ...(shadowedBy === undefined ? {} : { shadowedBy: ids[shadowedBy], shadowedByOrigin: pack.provenance[shadowedBy].origin }),
      shadows: previous, shadowOrigins: previous.map(id => origins.get(id)!) }
  })
  const defaultOptionalIds = rows.filter(row => row.selectable).map(row => row.id)
  const initialCounts = counts(rows, new Set(defaultOptionalIds))
  if (initialCounts.writeFiles !== pack.preview.fileCount || initialCounts.writeBytes !== pack.preview.totalBytes || initialCounts.optionalFiles !== pack.preview.optionalFileCount) fail('整合包预览统计与有效文件规划不一致')
  const planDigest = hash('sha512', JSON.stringify({ schema: 1, archiveSha512, preview: pack.preview, rows }))
  const summary: PackPlanSummary = { schema: 1, archiveSha512, planDigest, preview: { ...pack.preview }, counts: initialCounts, defaultOptionalIds }
  dtoBudget(summary, MODPACK_PLAN_LIMITS.summaryBytes, '整合包摘要')
  // Freeze only JSON DTOs; the archive and override buffers stay private and are
  // rehashed before selection application rather than being duplicated in RAM.
  for (const row of rows) { if (row.environment) Object.freeze(row.environment); Object.freeze(row.shadows); Object.freeze(row.shadowOrigins); Object.freeze(row) }
  Object.freeze(summary.preview); Object.freeze(summary.counts); Object.freeze(summary.defaultOptionalIds); Object.freeze(summary)
  const plan: ModpackPlan = Object.freeze({ summary, rows: Object.freeze(rows) })
  plans.set(plan, { pack: { ...pack, preview: { ...pack.preview }, files: pack.files.map(cloneFile), overrides: pack.overrides.map(file => ({ ...file })), provenance: pack.provenance.map(cloneProvenance) },
    rows, optional: new Map(rows.filter(row => row.selectable).map(row => [row.id, row.path])),
    overrideHashes: new Map(rows.filter(row => row.effective && row.origin !== 'indexed').map(row => [row.path, row.sha512!])), digest: planDigest, archiveHash: archiveSha512 })
  return plan
}
/** Bounded renderer projection; search and pagination never change the complete
 * selection set or include URL/private-path/override-content fields. */
export function modpackPlanPage(plan: ModpackPlan, options: PackPlanPageOptions = {}): PackPlanPage {
  const proof = source(plan)
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['offset', 'limit', 'query', 'includeExcluded', 'role', 'selectedOptionalIds'].includes(key))) fail('整合包文件查询参数无效')
  const offset = options.offset ?? 0, limit = options.limit ?? MODPACK_PLAN_LIMITS.pageRows, query = options.query ?? '', role = options.role ?? 'all'
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MODPACK_PLAN_LIMITS.rows || !Number.isSafeInteger(limit) || limit < 1 || limit > MODPACK_PLAN_LIMITS.pageRows ||
    typeof query !== 'string' || query.length > MODPACK_PLAN_LIMITS.queryCharacters || /[\p{Cc}\p{Cf}]/u.test(query) ||
    options.includeExcluded !== undefined && typeof options.includeExcluded !== 'boolean' || !['all', 'required', 'optional', 'server-excluded', 'overrides', 'client-overrides'].includes(role)) fail('整合包文件查询超出范围或格式无效')
  const selection = selected(proof, options.selectedOptionalIds, true), needle = query.normalize('NFC').toLowerCase()
  const filtered = proof.rows.filter(row => (options.includeExcluded || row.effective) && (role === 'all' || row.role === role) && row.path.normalize('NFC').toLowerCase().includes(needle))
  const items = filtered.slice(offset, offset + limit).map(row => ({ ...row, ...(row.environment ? { environment: { ...row.environment } } : {}), shadows: [...row.shadows], shadowOrigins: [...row.shadowOrigins], selected: row.effective && (!row.selectable || selection.has(row.id)) }))
  const page: PackPlanPage = { schema: 1, archiveSha512: proof.archiveHash, planDigest: proof.digest, offset, limit, total: filtered.length,
    ...(offset + items.length < filtered.length ? { nextOffset: offset + items.length } : {}), counts: counts(proof.rows, selection), items }
  dtoBudget(page, MODPACK_PLAN_LIMITS.pageBytes, '整合包文件页面')
  return page
}
/** Main-only admission. Explicit [] means no optional downloads; undefined is
 * never an implicit authorization to install all files. */
export function applyOptionalSelection(plan: ModpackPlan, selectedOptionalIds: readonly string[]): ParsedModpack {
  const proof = source(plan), selection = selected(proof, selectedOptionalIds, false)
  if (hash('sha512', proof.pack.archive) !== proof.archiveHash) fail('整合包归档在预览后发生变化，请重新读取')
  for (const file of proof.pack.overrides) {
    if (hash('sha512', file.data) !== proof.overrideHashes.get(file.path)) fail('整合包覆盖载荷在预览后发生变化，请重新读取')
  }
  const selectedPaths = new Set([...selection].map(id => proof.optional.get(id)!))
  const files = proof.pack.files.filter(file => !file.optional || selectedPaths.has(file.path)).map(cloneFile)
  const count = counts(proof.rows, selection)
  return { archive: proof.pack.archive, files, overrides: proof.pack.overrides.map(file => ({ ...file })), provenance: proof.pack.provenance.map(cloneProvenance),
    preview: { ...proof.pack.preview, fileCount: count.writeFiles, totalBytes: count.writeBytes, optionalFileCount: count.selectedOptionalFiles } }
}
