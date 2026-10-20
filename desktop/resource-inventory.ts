import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { readResourceRegistry } from './resource-install'

export type InventoryKind = 'mods' | 'resourcepacks' | 'shaderpacks' | 'worlds'
export interface RecordedResourceSource {
  source: 'modrinth' | 'bbsmc'
  projectId: string
  versionId: string
}
export interface InventoryItem {
  id: string
  name: string
  relativePath: string
  entryType: 'file' | 'directory'
  sizeBytes?: number
  modifiedAt: string
  /** Filename suffix only; no archive contents or compatibility have been checked. */
  formatHint?: 'jar' | 'zip'
  /** Historical registry attribution, never proof of current contents or ownership. */
  recordedSource?: RecordedResourceSource
  /** Download receipt only; the current file bytes have not been rehashed by this scan. */
  recordedDownload?: { sha512: string; sha1?: string; size: number; installedAt: string }
  activation: 'unknown' | 'disabled-suffix'
}
export interface InventoryWarning {
  code: 'unsafe-name' | 'symbolic-link' | 'unsupported-entry' | 'entry-unavailable' |
    'directory-unavailable' | 'name-collision' | 'entry-limit' | 'time-limit' |
    'registry-unavailable' | 'registry-invalid' | 'registry-conflict'
  message: string
  relativePath?: string
}
export interface ResourceInventory {
  kind: InventoryKind
  observedAt: string
  items: InventoryItem[]
  warnings: InventoryWarning[]
  truncated: boolean
}
export interface InventoryScanOptions {
  signal?: AbortSignal
  /** A main-process-owned path. Never take an arbitrary renderer file path. */
  managedModsFile?: string
  managedResourcesFile?: string
}
export const INVENTORY_LIMITS = Object.freeze({
  entries: 5000,
  durationMs: 5000,
  registryBytes: 1024 * 1024,
})

const FOLDERS: Record<InventoryKind, string> = {
  mods: 'mods', resourcepacks: 'resourcepacks', shaderpacks: 'shaderpacks', worlds: 'saves',
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i
class TimeLimit extends Error {}
type Budget = { check: () => void }
type RegistryRecord = RecordedResourceSource & { filename: string; download?: InventoryItem['recordedDownload'] }

function key(name: string): string { return name.normalize('NFC').toLowerCase() }
function safeName(name: string): boolean {
  return Boolean(name && name !== '.' && name !== '..' && Buffer.byteLength(name, 'utf8') <= 255 &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff\ufffd]/u.test(name) &&
    !/[ .]$/.test(name) && !WINDOWS_DEVICE.test(name))
}
function absoluteDirectory(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) ||
      /[\u0000-\u001f\u007f]/u.test(value) || value.length > 32768) {
    throw new Error('资源目录必须是有效的绝对路径')
  }
  const directory = path.resolve(value)
  if (directory === path.parse(directory).root) throw new Error('不能扫描文件系统根目录')
  return directory
}
function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code }
function sameIdentity(first: { dev: number; ino: number }, second: { dev: number; ino: number }): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

/** lstat every ancestor; only the fixed system aliases used by macOS temp paths are allowed. */
async function directoryChain(directory: string, budget: Budget): Promise<boolean> {
  const root = path.parse(directory).root
  let current = root
  for (const segment of directory.slice(root.length).split(path.sep)) {
    budget.check()
    current = path.join(current, segment)
    let info
    try { info = await fs.lstat(current) } catch (error) {
      if (errno(error) === 'ENOENT') { budget.check(); return false }
      throw error
    }
    budget.check()
    if (info.isSymbolicLink()) {
      const systemAlias = process.platform === 'darwin' && current !== directory &&
        ((current === '/tmp' && await fs.realpath(current) === '/private/tmp') ||
         (current === '/var' && await fs.realpath(current) === '/private/var'))
      if (systemAlias) continue
      throw new Error('资源目录及其祖先不能是符号链接或 junction')
    }
    if (!info.isDirectory()) throw new Error('资源目录及其祖先必须是普通目录')
  }
  return true
}

function registryShape(value: unknown): RegistryRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('登记记录必须是对象')
  const entries = Object.entries(value)
  if (entries.length > INVENTORY_LIMITS.entries) throw new Error('登记记录数量超出上限')
  const records = new Map<string, RegistryRecord>()
  for (const [rawKey, rawRecord] of entries) {
    const match = /^(?:(modrinth|bbsmc):)?([^:]+)$/.exec(rawKey)
    if (!match || !ID.test(match[2]) || !rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
      throw new Error('登记记录标识无效')
    }
    const record = rawRecord as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'filename,versionId' ||
        typeof record.versionId !== 'string' || !ID.test(record.versionId) ||
        typeof record.filename !== 'string' || !safeName(record.filename)) throw new Error('登记记录字段无效')
    const normalized: RegistryRecord = {
      source: match[1] === 'bbsmc' ? 'bbsmc' : 'modrinth', projectId: match[2],
      versionId: record.versionId, filename: record.filename,
    }
    const projectKey = `${normalized.source}:${normalized.projectId}`
    const existing = records.get(projectKey)
    if (existing && (existing.versionId !== normalized.versionId || existing.filename !== normalized.filename)) {
      throw new Error('旧版与新版登记记录互相冲突')
    }
    records.set(projectKey, normalized)
  }
  return [...records.values()]
}

async function readRegistry(file: string, budget: Budget): Promise<RegistryRecord[]> {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\u0000-\u001f\u007f]/u.test(file)) {
    throw new Error('登记文件路径无效')
  }
  const resolved = path.resolve(file)
  if (!await directoryChain(absoluteDirectory(path.dirname(resolved)), budget)) return []
  budget.check()
  let before
  try { before = await fs.lstat(resolved) } catch (error) {
    if (errno(error) === 'ENOENT') return []
    throw error
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > INVENTORY_LIMITS.registryBytes) {
    throw new Error('登记文件必须是不超过 1 MiB 的普通文件，不能是链接')
  }
  const handle = await fs.open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameIdentity(before, opened)) throw new Error('登记文件在读取期间被替换')
    const buffer = Buffer.alloc(INVENTORY_LIMITS.registryBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      budget.check()
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    budget.check()
    const after = await handle.stat()
    if (offset > INVENTORY_LIMITS.registryBytes || opened.size !== offset || after.size !== offset ||
        opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw new Error('登记文件超出上限或在读取期间发生变化')
    return registryShape(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))))
  } finally { await handle.close() }
}

function attributeSources(result: ResourceInventory, records: RegistryRecord[]): void {
  const names = new Map<string, InventoryItem[]>()
  for (const item of result.items) {
    const folded = key(item.name)
    const group = names.get(folded) ?? []
    group.push(item)
    names.set(folded, group)
  }
  for (const items of names.values()) {
    if (items.length > 1) result.warnings.push({
      code: 'name-collision', message: '文件名在大小写或 Unicode NFC 规范化后冲突，未关联任何来源',
      relativePath: items[0].relativePath,
    })
  }
  const claims = new Map<string, RegistryRecord[]>()
  for (const record of records) {
    const folded = key(record.filename)
    const group = claims.get(folded) ?? []
    group.push(record)
    claims.set(folded, group)
  }
  for (const [folded, owners] of claims) {
    const items = names.get(folded)
    if (owners.length > 1) {
      result.warnings.push({ code: 'registry-conflict', message: '同一文件名有多份来源登记，未关联来源',
        ...(items?.[0] ? { relativePath: items[0].relativePath } : {}) })
      continue
    }
    const item = items?.length === 1 ? items[0] : undefined
    const owner = owners[0]
    if (item && item.name !== owner.filename) {
      result.warnings.push({ code: 'registry-conflict', message: '登记文件名与实际文件名的大小写或 Unicode 写法不一致，未关联来源',
        relativePath: item.relativePath })
      continue
    }
    // Do not infer that renamed/disabled files, differently spelled paths or
    // directories still contain the resource recorded by an earlier download.
    // An incomplete listing cannot rule out another colliding filename.
    if (!result.truncated && item?.entryType === 'file' && item.name === owner.filename) {
      const { source, projectId, versionId } = owner
      item.recordedSource = { source, projectId, versionId }
      if (owner.download) item.recordedDownload = { ...owner.download }
    }
  }
}

/**
 * One-level metadata inventory. No resource files are opened and no directory is
 * created. The optional registry is the only file whose bytes may be read.
 * The elapsed-time budget is checked between filesystem operations; Node cannot
 * cancel an already submitted lstat/opendir call on a stalled filesystem.
 */
export async function scanResourceInventory(
  gameDirectory: string, kind: InventoryKind, options: InventoryScanOptions = {},
): Promise<ResourceInventory> {
  const started = performance.now()
  const budget: Budget = { check: () => {
    if (options.signal?.aborted) throw new DOMException('资源扫描已取消', 'AbortError')
    if (performance.now() - started >= INVENTORY_LIMITS.durationMs) throw new TimeLimit()
  } }
  budget.check()
  if (!Object.hasOwn(FOLDERS, kind)) throw new Error('无效的资源类型')
  const game = absoluteDirectory(gameDirectory)
  const folder = FOLDERS[kind]
  const directory = path.join(game, folder)
  const result: ResourceInventory = {
    kind, observedAt: new Date().toISOString(), items: [], warnings: [], truncated: false,
  }
  let dir: Awaited<ReturnType<typeof fs.opendir>> | undefined
  let records: RegistryRecord[] = []
  try {
    if (!await directoryChain(game, budget) || !await directoryChain(directory, budget)) return result
    const originalDirectory = await fs.lstat(directory)
    budget.check()
    dir = await fs.opendir(directory, { bufferSize: 32 })
    // Recheck after opening, before consuming names, to catch an ordinary replacement.
    if (!await directoryChain(directory, budget) || !sameIdentity(originalDirectory, await fs.lstat(directory))) {
      throw new Error('资源目录在打开期间被替换，请重新扫描')
    }
    let visited = 0
    for (;;) {
      budget.check()
      let entry
      try { entry = await dir.read() } catch (error) {
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(errno(error) ?? '')) throw error
        result.warnings.push({ code: 'directory-unavailable', message: '扫描期间目录不可读取，结果可能不完整' })
        result.truncated = true
        break
      }
      budget.check()
      if (!entry) break
      if (visited++ >= INVENTORY_LIMITS.entries) {
        result.truncated = true
        result.warnings.push({ code: 'entry-limit', message: `仅扫描前 ${INVENTORY_LIMITS.entries} 个目录条目` })
        break
      }
      const name = entry.name
      if (!safeName(name)) {
        result.warnings.push({ code: 'unsafe-name', message: '已跳过包含不安全字符或不可跨平台使用的文件名' })
        continue
      }
      const relativePath = `${folder}/${name}`
      let info
      try { info = await fs.lstat(path.join(directory, name)) } catch (error) {
        result.warnings.push({ code: 'entry-unavailable', message: '条目已消失或无法读取其文件信息', relativePath })
        continue
      }
      budget.check()
      if (info.isSymbolicLink()) {
        result.warnings.push({ code: 'symbolic-link', message: '已跳过符号链接或 junction', relativePath })
        continue
      }
      if (!info.isFile() && !info.isDirectory()) {
        result.warnings.push({ code: 'unsupported-entry', message: '已跳过非常规文件或目录', relativePath })
        continue
      }
      if (!Number.isFinite(info.mtimeMs) || Math.abs(info.mtimeMs) > 8.64e15 ||
          (info.isFile() && (!Number.isSafeInteger(info.size) || info.size < 0))) {
        result.warnings.push({ code: 'entry-unavailable', message: '条目的大小或修改时间无效', relativePath })
        continue
      }
      const suffixName = name.replace(/\.disabled$/i, '')
      const formatHint = /\.jar$/i.test(suffixName) ? 'jar' : /\.zip$/i.test(suffixName) ? 'zip' : undefined
      result.items.push({
        id: `${kind}:${createHash('sha256').update(name, 'utf8').digest('hex')}`,
        name, relativePath, entryType: info.isFile() ? 'file' : 'directory',
        ...(info.isFile() ? { sizeBytes: info.size, ...(formatHint ? { formatHint } : {}) } : {}),
        modifiedAt: new Date(info.mtimeMs).toISOString(),
        activation: info.isFile() && /\.disabled$/i.test(name) ? 'disabled-suffix' : 'unknown',
      })
    }
    if (!await directoryChain(directory, budget)) {
      result.warnings.push({ code: 'directory-unavailable', message: '资源目录在扫描期间消失，当前结果可能不完整' })
      result.truncated = true
    } else if (!sameIdentity(originalDirectory, await fs.lstat(directory))) {
      throw new Error('资源目录在扫描期间被替换，请重新扫描')
    }
    if (kind === 'mods' && options.managedModsFile !== undefined) {
      try { records = await readRegistry(options.managedModsFile, budget) } catch (error) {
        if (error instanceof TimeLimit || options.signal?.aborted) throw error
        result.warnings.push({
          code: /^E[A-Z0-9]+$/.test(errno(error) ?? '') ? 'registry-unavailable' : 'registry-invalid',
          message: '来源登记文件无法安全读取或格式无效；仍显示文件清单，不关联来源',
        })
      }
    }
    if ((kind === 'resourcepacks' || kind === 'shaderpacks') && options.managedResourcesFile !== undefined) {
      try {
        budget.check()
        const registry = await readResourceRegistry(options.managedResourcesFile, options.signal)
        budget.check()
        const resourceKind = kind === 'resourcepacks' ? 'resourcepack' : 'shader'
        records = Object.values(registry.records).filter(record => record.kind === resourceKind).map(record => ({
          source: record.source, projectId: record.projectId, versionId: record.versionId, filename: record.filename,
          download: { sha512: record.sha512, ...(record.sha1 ? { sha1: record.sha1 } : {}), size: record.size, installedAt: record.installedAt },
        }))
      } catch (error) {
        if (error instanceof TimeLimit || options.signal?.aborted) throw error
        result.warnings.push({ code: 'registry-invalid', message: '资源下载登记无法安全读取；仍显示文件清单，不关联来源' })
      }
    }
  } catch (error) {
    if (!(error instanceof TimeLimit)) throw error
    result.truncated = true
    result.warnings.push({ code: 'time-limit', message: '扫描达到时间上限，当前结果可能不完整' })
  } finally { await dir?.close() }
  if (options.signal?.aborted) throw new DOMException('资源扫描已取消', 'AbortError')
  result.items.sort((a, b) => {
    const first = key(a.name), second = key(b.name)
    return first < second ? -1 : first > second ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  attributeSources(result, records)
  return result
}
