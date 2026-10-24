import type { DatapackCatalogDependency, DatapackCatalogFile, DatapackCatalogHit, DatapackCatalogProject,
  DatapackCatalogSearch, DatapackCatalogVersion, DatapackCatalogVersions } from './datapack-discovery-types'

export const DATAPACK_CATALOG_LIMITS = Object.freeze({ bodyBytes: 2 * 1024 ** 2, dtoBytes: 512 * 1024,
  versions: 500, displayedVersions: 100, files: 100, dependencies: 100, jsonDepth: 32, jsonNodes: 100000,
  timeoutMs: 20000, headersTimeoutMs: 10000, idleTimeoutMs: 8000, cleanupTimeoutMs: 200 })
const API = 'https://api.modrinth.com'
const CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/
const ZIP_LIMIT = 512 * 1024 ** 2
const SHA512 = /^[a-f0-9]{128}$/i, SHA1 = /^[a-f0-9]{40}$/i

export interface DatapackCatalogOptions {
  gameVersion: string
  offset?: number
  signal?: AbortSignal
  fetch?: typeof fetch
  userAgent?: string
  /** Internal test budgets, never copied from renderer input. */
  timeoutMs?: number
  headersTimeoutMs?: number
  idleTimeoutMs?: number
}
export class DatapackCatalogError extends Error {
  constructor(message: string) { super(message); this.name = 'DatapackCatalogError' }
}
function fail(message = 'Modrinth 数据包元数据格式无效'): never { throw new DatapackCatalogError(message) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) fail()
  return value as Record<string, unknown>
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || (!empty && !value.trim())) fail()
  return value
}
function description(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) fail()
  return value
}
function id(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) fail('Modrinth 项目标识无效'); return value }
function gameVersion(value: unknown): string { if (typeof value !== 'string' || !VERSION.test(value)) fail('游戏版本无效'); return value }
function list(value: unknown, max: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > max) fail()
  return value.map(item => text(item, length))
}
function count(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) fail(); return Number(value) }
function types(raw: Record<string, unknown>): string[] {
  const values: string[] = []
  if (raw.project_type !== undefined) values.push(text(raw.project_type, 40))
  for (const key of ['all_project_types', 'project_types']) if (raw[key] !== undefined) values.push(...list(raw[key], 16, 40))
  // v2 project GET may expose only primary project_type plus delivery loaders.
  if (raw.loaders !== undefined && list(raw.loaders, 64, 40).includes('datapack')) values.push('datapack')
  return [...new Set(values)]
}
export function datapackProjectUrl(projectId: string): string { return `https://modrinth.com/datapack/${encodeURIComponent(id(projectId))}` }
export function datapackSearchParameters(query: string, game: string, offset = 0): URLSearchParams {
  text(query, 200, true); gameVersion(game)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) fail('搜索分页无效')
  return new URLSearchParams({ query, offset: String(offset), limit: '20', index: query.trim() ? 'relevance' : 'downloads',
    facets: JSON.stringify([['all_project_types:datapack'], [`versions:${game}`]]) })
}
export function datapackVersionsParameters(game: string): URLSearchParams {
  return new URLSearchParams({ loaders: JSON.stringify(['datapack']), game_versions: JSON.stringify([gameVersion(game)]), include_changelog: 'false' })
}
export function normalizeDatapackSearch(value: unknown, game: string, offset = 0): DatapackCatalogSearch {
  gameVersion(game)
  const raw = object(value), totalHits = count(raw.total_hits), reportedOffset = count(raw.offset), limit = count(raw.limit)
  if (reportedOffset !== offset || limit !== 20 || !Array.isArray(raw.hits) || raw.hits.length > limit) fail('搜索分页或结果格式不符合本次请求')
  if (raw.hits.length && reportedOffset + raw.hits.length > totalHits) fail('搜索结果数量与分页总数不一致，请重新搜索')
  let omittedHits = 0
  const seen = new Set<string>(), hits: DatapackCatalogHit[] = []
  for (const entry of raw.hits) {
    try {
      const hit = object(entry), projectId = id(hit.project_id), projectTypes = types(hit)
      if (seen.has(projectId)) { omittedHits++; continue }
      seen.add(projectId)
      if (!projectTypes.includes('datapack') || !list(hit.versions, 2000, 80).includes(game)) { omittedHits++; continue }
      const item: DatapackCatalogHit = { projectId, slug: id(hit.slug), title: text(hit.title, 256), description: description(hit.description ?? ''),
        author: text(hit.author ?? '', 256, true), downloads: count(hit.downloads), projectTypes, projectUrl: datapackProjectUrl(projectId) }
      if (Buffer.byteLength(JSON.stringify([...hits, item])) > DATAPACK_CATALOG_LIMITS.dtoBytes) { omittedHits++; continue }
      hits.push(item)
    } catch { omittedHits++ }
  }
  return { hits, totalHits, offset: reportedOffset, limit, omittedHits }
}
function project(value: unknown, projectId: string): DatapackCatalogProject {
  const raw = object(value)
  if (id(raw.id) !== projectId) fail('返回的项目与所选项目不一致')
  return { projectId, slug: id(raw.slug), title: text(raw.title, 256), description: description(raw.description ?? ''),
    projectTypes: types(raw), projectUrl: datapackProjectUrl(projectId) }
}
function filename(value: unknown): string {
  const name = text(value, 255)
  if (Buffer.byteLength(name) > 255 || /[<>:"/\\|?*\ud800-\udfff\ufffd]|\p{Cf}/u.test(name) || /[ .]$/.test(name) ||
      /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) fail('文件名不符合跨平台条件')
  return name
}
function cdn(value: unknown): void {
  let url: URL
  try { url = new URL(text(value, 8192)) } catch { return fail('文件未提供受支持的 HTTPS 地址') }
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.modrinth.com' || url.username || url.password || url.port || url.hash) fail('文件地址不属于受支持的 Modrinth CDN')
}
function parseFile(value: unknown): DatapackCatalogFile {
  const raw = object(value), name = text(raw.filename, 255)
  if (typeof raw.primary !== 'boolean' || raw.file_type != null && typeof raw.file_type !== 'string') fail()
  const role: DatapackCatalogFile['role'] = raw.file_type == null ? 'main' : raw.file_type === 'required-resource-pack' || raw.file_type === 'optional-resource-pack' ? raw.file_type : 'other'
  const result: DatapackCatalogFile = { filename: name, primary: raw.primary, role, eligible: false }
  try {
    filename(name)
    if (!Number.isSafeInteger(raw.size) || Number(raw.size) <= 0 || Number(raw.size) > ZIP_LIMIT) fail('文件大小未知或超过 512 MiB')
    result.size = Number(raw.size)
    const hashes = object(raw.hashes)
    if (typeof hashes.sha512 !== 'string' || !SHA512.test(hashes.sha512)) fail('缺少有效的 SHA-512 声明')
    result.sha512 = hashes.sha512.toLowerCase()
    if (hashes.sha1 !== undefined) {
      if (typeof hashes.sha1 !== 'string' || !SHA1.test(hashes.sha1)) fail('提供的 SHA-1 声明无效')
      result.sha1 = hashes.sha1.toLowerCase()
    }
    cdn(raw.url)
    if (role !== 'main') fail(role === 'required-resource-pack' ? '作者声明的必需附带资源包，不是数据包主文件' : role === 'optional-resource-pack' ? '作者声明的可选附带资源包，不是数据包主文件' : '此文件角色不作为数据包主文件')
    if (!/\.zip$/i.test(name)) fail('此文件不是 ZIP 数据包候选')
    result.eligible = true
  } catch (error) { result.reason = error instanceof DatapackCatalogError ? error.message : '文件元数据不完整，需前往项目页查看' }
  return result
}
function dependencies(value: unknown): DatapackCatalogDependency[] {
  if (!Array.isArray(value) || value.length > DATAPACK_CATALOG_LIMITS.dependencies) fail()
  return value.map(entry => {
    const raw = object(entry)
    if (!['required', 'optional', 'incompatible', 'embedded'].includes(String(raw.dependency_type))) fail()
    return { type: raw.dependency_type as DatapackCatalogDependency['type'],
      ...(raw.project_id == null ? {} : { projectId: id(raw.project_id) }), ...(raw.version_id == null ? {} : { versionId: id(raw.version_id) }),
      ...(raw.file_name == null ? {} : { filename: text(raw.file_name, 255) }) }
  })
}
function parseVersion(value: unknown, projectId: string, game: string): DatapackCatalogVersion {
  const raw = object(value), versionId = id(raw.id)
  if (id(raw.project_id) !== projectId) fail('版本所属项目不一致')
  const gameVersions = list(raw.game_versions, 2000, 80), loaders = list(raw.loaders, 64, 40)
  if (!gameVersions.includes(game) || !loaders.includes('datapack')) fail('版本未声明当前游戏的数据包交付方式')
  if (!Array.isArray(raw.files) || raw.files.length > DATAPACK_CATALOG_LIMITS.files) fail()
  const files = raw.files.map(parseFile), deps = dependencies(raw.dependencies)
  const primary = files.filter(file => file.primary), main = files.filter(file => file.role === 'main' && /\.zip$/i.test(file.filename))
  const candidate = primary.length === 1 ? primary[0] : primary.length === 0 && main.length === 1 ? main[0] : undefined
  const reasons: string[] = [], warnings: string[] = ['仅为站点元数据声明；本版没有下载或检查 ZIP 内容']
  if (new Set(files.map(file => file.filename.normalize('NFC').toLowerCase())).size !== files.length) reasons.push('文件名存在重复或大小写/Unicode冲突，需前往项目页核对')
  if (!candidate || candidate.role !== 'main' || !candidate.eligible) reasons.push(candidate?.reason ?? '没有唯一且受支持的主 ZIP，请到项目页选择')
  if (files.some(file => file.role === 'required-resource-pack')) reasons.push('作者声明了必需附带资源包，本版不自动处理')
  if (deps.some(item => item.type === 'required' || item.type === 'incompatible')) reasons.push('含必需或不兼容依赖，需按作者说明处理')
  if (files.some(file => file.role === 'other')) warnings.push('存在其他文件角色，本版不将它们当作数据包')
  if (files.some(file => file.role === 'optional-resource-pack')) warnings.push('存在可选附带资源包，未下载或启用')
  if (!['release', 'beta', 'alpha'].includes(String(raw.version_type))) fail()
  const published = text(raw.date_published, 80)
  if (!Number.isFinite(Date.parse(published))) fail()
  return { id: versionId, projectId, name: text(raw.name, 256), versionNumber: text(raw.version_number, 256), datePublished: published,
    releaseType: raw.version_type as DatapackCatalogVersion['releaseType'], gameVersions, loaders, declaresCurrentGameVersion: true, declaresDatapack: true,
    files, dependencies: deps, ...(candidate?.role === 'main' && candidate.eligible ? { mainFile: structuredClone(candidate) } : {}),
    externalOnly: reasons.length > 0, reasons, warnings }
}
export function normalizeDatapackVersions(projectValue: unknown, versionValue: unknown, projectId: string, game: string): DatapackCatalogVersions {
  id(projectId); gameVersion(game)
  const info = project(projectValue, projectId)
  if (!Array.isArray(versionValue) || versionValue.length > DATAPACK_CATALOG_LIMITS.versions) fail('版本列表超过本版读取范围，请前往项目页')
  const versions: DatapackCatalogVersion[] = [], seen = new Set<string>()
  let omittedVersions = 0
  for (const raw of versionValue) {
    try {
      const value = parseVersion(raw, projectId, game)
      if (seen.has(value.id)) { omittedVersions++; continue }
      seen.add(value.id)
      if (versions.length >= DATAPACK_CATALOG_LIMITS.displayedVersions || Buffer.byteLength(JSON.stringify({ project: info, versions: [...versions, value] })) > DATAPACK_CATALOG_LIMITS.dtoBytes) { omittedVersions++; continue }
      versions.push(value)
    } catch { omittedVersions++ }
  }
  if (versions.length && !info.projectTypes.includes('datapack')) info.projectTypes.push('datapack')
  return { project: info, versions, upstreamVersionCount: versionValue.length, omittedVersions }
}

function safeApi(input: string): URL {
  const url = new URL(input)
  if (url.origin !== API || url.username || url.password || url.port || url.hash || !url.pathname.startsWith('/v2/')) fail('元数据地址不受支持')
  return url
}
function waitFor<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  if (signal.aborted) { void promise.then(value => late?.(value), () => {}); return Promise.reject(signal.reason) }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const abort = () => { settled = true; signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { if (settled) late?.(value); else { settled = true; signal.removeEventListener('abort', abort); resolve(value) } }, error => {
      if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(error) }
    })
  })
}
async function cleanup(work: () => Promise<unknown> | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([Promise.resolve().then(work).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, DATAPACK_CATALOG_LIMITS.cleanupTimeoutMs) })]) }
  finally { if (timer) clearTimeout(timer) }
}
function milliseconds(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) fail('读取时间预算无效')
  return value
}
function validateJsonShape(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth > DATAPACK_CATALOG_LIMITS.jsonDepth || ++budget.nodes > DATAPACK_CATALOG_LIMITS.jsonNodes) fail('元数据结构超过读取范围')
  if (value && typeof value === 'object') for (const child of Object.values(value)) validateJsonShape(child, depth + 1, budget)
}
async function operation<T>(options: DatapackCatalogOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  gameVersion(options.gameVersion)
  const timeout = milliseconds(options.timeoutMs, DATAPACK_CATALOG_LIMITS.timeoutMs)
  const controller = new AbortController(), abort = () => controller.abort(options.signal?.reason ?? new DOMException('元数据读取已取消', 'AbortError'))
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new DatapackCatalogError('Modrinth 元数据读取超时，请稍后重试')), timeout)
  try { controller.signal.throwIfAborted(); return await work(controller.signal) }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
}
async function jsonRequest(input: URL, options: DatapackCatalogOptions, signal: AbortSignal): Promise<unknown> {
  let url = safeApi(input.href)
  const fetcher = options.fetch ?? fetch, agent = options.userAgent ?? 'LuaLauncher/datapack-discovery (+https://github.com/XQGGCN/lua-launcher)'
  text(agent, 512)
  const headersMs = milliseconds(options.headersTimeoutMs, DATAPACK_CATALOG_LIMITS.headersTimeoutMs), idleMs = milliseconds(options.idleTimeoutMs, DATAPACK_CATALOG_LIMITS.idleTimeoutMs)
  for (let hop = 0; hop <= 3; hop++) {
    signal.throwIfAborted()
    const headerController = new AbortController(), combined = AbortSignal.any([signal, headerController.signal])
    const headerTimer = setTimeout(() => headerController.abort(new DatapackCatalogError('Modrinth 响应等待超时')), headersMs)
    let response: Response
    try {
      response = await waitFor(Promise.resolve().then(() => fetcher(url.href, { method: 'GET', redirect: 'manual',
        headers: { Accept: 'application/json', 'User-Agent': agent }, signal: combined })), combined,
      late => { void cleanup(() => late.body?.cancel()) })
    } catch (error) { if (combined.aborted) throw combined.reason; throw new DatapackCatalogError('无法读取 Modrinth 元数据，请检查网络后重试') }
    finally { clearTimeout(headerTimer) }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await cleanup(() => response.body?.cancel())
      if (hop === 3 || !response.headers.get('location')) fail('元数据重定向过多或地址无效')
      url = safeApi(new URL(response.headers.get('location')!, url).href); continue
    }
    if (!response.ok) { await cleanup(() => response.body?.cancel()); fail(`Modrinth 元数据请求失败（HTTP ${response.status}）`) }
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await cleanup(() => response.body?.cancel()); fail('Modrinth 返回的不是 JSON 元数据')
    }
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > DATAPACK_CATALOG_LIMITS.bodyBytes)) {
      await cleanup(() => response.body?.cancel()); fail('元数据响应超过读取上限')
    }
    if (!response.body) fail('元数据响应没有内容')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0, empty = 0, complete = false
    try {
      while (true) {
        signal.throwIfAborted()
        const idle = new AbortController(), timer = setTimeout(() => idle.abort(new DatapackCatalogError('Modrinth 数据读取停滞，请稍后重试')), idleMs)
        let part: ReadableStreamReadResult<Uint8Array>
        try { part = await waitFor(reader.read(), AbortSignal.any([signal, idle.signal])) } finally { clearTimeout(timer) }
        if (part.done) { complete = true; break }
        if (!(part.value instanceof Uint8Array)) fail()
        if (!part.value.byteLength) { if (++empty > 8) fail('元数据流没有取得进展'); continue }
        empty = 0; size += part.value.byteLength
        if (size > DATAPACK_CATALOG_LIMITS.bodyBytes) fail('元数据响应超过读取上限')
        chunks.push(Buffer.from(part.value))
      }
      signal.throwIfAborted()
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { return fail('Modrinth JSON 元数据无法解析') }
      validateJsonShape(value)
      return value
    } finally {
      if (!complete) await cleanup(() => reader.cancel())
      try { reader.releaseLock() } catch { /* An uncooperative stream must not keep the operation pending. */ }
    }
  }
  return fail('元数据重定向未完成')
}
export async function searchDatapackCatalog(query: string, options: DatapackCatalogOptions): Promise<DatapackCatalogSearch> {
  const parameters = datapackSearchParameters(query, options.gameVersion, options.offset)
  return operation(options, async signal => normalizeDatapackSearch(await jsonRequest(new URL(`/v2/search?${parameters}`, API), options, signal), options.gameVersion, options.offset ?? 0))
}
export async function readDatapackProjectVersions(projectId: string, options: DatapackCatalogOptions): Promise<DatapackCatalogVersions> {
  id(projectId)
  const parameters = datapackVersionsParameters(options.gameVersion)
  return operation(options, async signal => {
    const info = await jsonRequest(new URL(`/v2/project/${encodeURIComponent(projectId)}`, API), options, signal)
    // Check selected-project identity before requesting its versions.
    project(info, projectId)
    const versions = await jsonRequest(new URL(`/v2/project/${encodeURIComponent(projectId)}/version?${parameters}`, API), options, signal)
    return normalizeDatapackVersions(info, versions, projectId, options.gameVersion)
  })
}
