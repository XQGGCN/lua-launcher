import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInflateRaw } from 'node:zlib'
import { crc32 } from './world-zip'
import type { WorldSelection } from './world-types'
import type { DatapackInventoryData, DatapackInventoryItem, DatapackMetadata, DatapackPreview } from './datapack-types'

export const DATAPACK_LIMITS = Object.freeze({
  archiveBytes: 512 * 1024 ** 2, entries: 20000, centralDirectoryBytes: 16 * 1024 ** 2,
  totalExpandedBytes: 1024 ** 3, entryBytes: 256 * 1024 ** 2, metadataBytes: 256 * 1024,
  inventoryEntries: 5000, pathBytes: 1024, pathDepth: 32, durationMs: 30000,
  inventoryDtoBytes: 1024 * 1024, inventoryMetadataBytes: 4 * 1024 ** 2,
  warningCount: 64, warningBytes: 16 * 1024, prefixIndexBytes: 32 * 1024 ** 2,
})
export class DatapackReadError extends Error {
  constructor(public readonly code: 'changed' | 'unsafe-path' | 'missing' | 'invalid' | 'unsupported' | 'limit', message: string) {
    super(message); this.name = 'DatapackReadError'
  }
}
function fail(code: DatapackReadError['code'], message: string): never { throw new DatapackReadError(code, message) }
const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code
const folded = (s: string) => s.normalize('NFC').toLowerCase()
const device = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i
const itemId = (name: string) => 'datapack:' + createHash('sha256').update(name).digest('hex')
function safeName(s: unknown): s is string {
  return typeof s === 'string' && !!s && s !== '.' && s !== '..' && Buffer.byteLength(s) <= 255 &&
    !/[<>:"/\\|?*\p{Cc}\p{Cf}\ud800-\udfff\ufffd]/u.test(s) && !/[ .]$/.test(s) && !device.test(s)
}
function safePath(s: string, directory = false): boolean {
  const value = directory && s.endsWith('/') ? s.slice(0, -1) : s
  const parts = value.split('/')
  return !!value && Buffer.byteLength(s) <= DATAPACK_LIMITS.pathBytes && parts.length <= DATAPACK_LIMITS.pathDepth && parts.every(safeName)
}
function sameNode(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode }
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
}
type Options = { signal?: AbortSignal }
function budget(options: Options) {
  const until = performance.now() + DATAPACK_LIMITS.durationMs
  return { check() { options.signal?.throwIfAborted(); if (performance.now() > until) fail('limit', '读取时间超过限制，请选择较小的数据包') } }
}
type Budget = ReturnType<typeof budget>
type Chain = Map<string, BigIntStats>
async function chain(directory: string, b: Budget): Promise<Chain> {
  if (!path.isAbsolute(directory) || directory === path.parse(directory).root) fail('unsafe-path', '目录无效')
  let current = path.parse(directory).root
  const result: Chain = new Map()
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, part); b.check()
    const stat = await fs.lstat(current, { bigint: true }); b.check()
    if (stat.isSymbolicLink()) {
      const system = process.platform === 'darwin' && current !== directory &&
        ((current === '/tmp' && await fs.realpath(current) === '/private/tmp') ||
         (current === '/var' && await fs.realpath(current) === '/private/var'))
      if (!system) fail('unsafe-path', '目录或祖先包含链接，无法读取')
    } else if (!stat.isDirectory()) fail('unsafe-path', '需要普通目录')
    result.set(current, stat)
  }
  return result
}
async function verifyChain(original: Chain, b: Budget): Promise<void> {
  for (const [name, stat] of original) {
    b.check()
    let now
    try { now = await fs.lstat(name, { bigint: true }) } catch { fail('changed', '目录已变化，请刷新后重试') }
    if (!sameNode(stat, now!)) fail('changed', '目录已变化，请刷新后重试')
  }
}
async function unique(directory: string, name: string, b: Budget): Promise<void> {
  const handle = await fs.opendir(directory)
  let count = 0, matches = 0, exact = false
  try {
    for await (const entry of handle) {
      b.check(); if (++count > DATAPACK_LIMITS.inventoryEntries) fail('limit', '目录条目过多')
      if (folded(entry.name) === folded(name)) { matches++; exact ||= entry.name === name }
    }
  } finally { await handle.close().catch(() => {}) }
  if (matches !== 1 || !exact) fail(matches ? 'unsafe-path' : 'missing', matches ? '名称存在大小写或Unicode冲突' : '所选目录已不存在')
}

/** Private main-process proof. It must never be returned through IPC. */
export interface DatapackWorldProof {
  instanceDirectory: string
  selection: WorldSelection
  world: string
  saves: string
  chain: Chain
  datapacks?: BigIntStats | null
  entries: Map<string, { name: string; kind: 'zip' | 'directory'; stat: BigIntStats }>
}
export async function captureDatapackWorld(instanceDirectory: string, selection: WorldSelection, options: Options = {}): Promise<DatapackWorldProof> {
  const b = budget(options)
  if (!safeName(selection?.name) || selection.itemId !== 'worlds:' + createHash('sha256').update(selection.name).digest('hex')) fail('unsafe-path', '世界选择无效')
  const saves = path.join(path.resolve(instanceDirectory), 'game', 'saves'), world = path.join(saves, selection.name)
  const proof: DatapackWorldProof = { instanceDirectory, selection: { ...selection }, world, saves, chain: await chain(world, b), entries: new Map() }
  await unique(saves, selection.name, b); await verifyChain(proof.chain, b)
  return proof
}
export async function verifyDatapackWorld(proof: DatapackWorldProof, options: Options = {}): Promise<void> {
  return verifyProof(proof, budget(options))
}
async function verifyProof(proof: DatapackWorldProof, b: Budget): Promise<void> {
  await verifyChain(proof.chain, b); await unique(proof.saves, proof.selection.name, b)
  if (proof.datapacks !== undefined) {
    const name = path.join(proof.world, 'datapacks')
    let now: BigIntStats | null
    try { now = await fs.lstat(name, { bigint: true }) } catch (e) { if (errno(e) === 'ENOENT') now = null; else throw e }
    if (proof.datapacks === null ? now !== null : !now || !sameFile(proof.datapacks, now)) fail('changed', '数据包目录已变化，请刷新后重试')
  }
  b.check()
}

function utf8(bytes: Uint8Array, filename = false): string {
  // A BOM is content in a ZIP entry name, not a transport marker. Stripping it
  // would turn a different filename into the privileged root pack.mcmeta name.
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: filename }).decode(bytes) } catch { return fail('invalid', '文本不是有效UTF-8') }
}
/** Small JSON parser rejects duplicate decoded keys, depth/node budgets and non-finite numbers. */
function strictJson(text: string): unknown {
  let i = 0, nodes = 0
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) { if (!/[\x20\t\r\n]/.test(text[i])) fail('invalid', 'JSON空白无效'); i++ } }
  const string = (): string => {
    const start = i++
    while (i < text.length) {
      const c = text[i++]
      if (c === '\\') i++
      else if (c === '"') {
        try { return JSON.parse(text.slice(start, i)) } catch { fail('invalid', 'JSON字符串无效') }
      }
    }
    return fail('invalid', 'JSON字符串未结束')
  }
  const value = (depth: number): unknown => {
    ws(); if (depth > 32 || ++nodes > 20000) fail('limit', '元数据结构过大')
    if (text[i] === '"') return string()
    if (text[i] === '{') {
      i++; const object: Record<string, unknown> = Object.create(null), seen = new Set<string>(); ws()
      if (text[i] === '}') { i++; return object }
      while (true) {
        ws(); if (text[i] !== '"') fail('invalid', 'JSON对象键无效')
        const key = string(); if (seen.has(key)) fail('invalid', '元数据含重复JSON键'); seen.add(key)
        ws(); if (text[i++] !== ':') fail('invalid', 'JSON对象缺少冒号')
        object[key] = value(depth + 1); ws()
        const end = text[i++]; if (end === '}') return object; if (end !== ',') fail('invalid', 'JSON对象未结束')
      }
    }
    if (text[i] === '[') {
      i++; const array: unknown[] = []; ws(); if (text[i] === ']') { i++; return array }
      while (true) { array.push(value(depth + 1)); ws(); const end = text[i++]; if (end === ']') return array; if (end !== ',') fail('invalid', 'JSON数组未结束') }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
    if (!match) fail('invalid', 'JSON值无效')
    i += match![0].length
    const parsed = JSON.parse(match![0]); if (typeof parsed === 'number' && !Number.isFinite(parsed)) fail('invalid', 'JSON数字无效')
    return parsed
  }
  const result = value(0); ws(); if (i !== text.length) fail('invalid', 'JSON包含多余内容')
  return result
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
function range(value: unknown): [number, number] | undefined {
  if (integer(value)) return [value, value]
  if (Array.isArray(value) && value.length === 2 && value.every(integer) && value[0] <= value[1]) return [value[0], value[1]]
  if (object(value) && integer(value.min_inclusive) && integer(value.max_inclusive) && value.min_inclusive <= value.max_inclusive) return [value.min_inclusive, value.max_inclusive]
  return undefined
}
function versionPair(value: unknown, upper: boolean): [number, number | null] | undefined {
  if (integer(value)) return [value, upper ? null : 0]
  if (Array.isArray(value) && value.length === 1 && integer(value[0])) return [value[0], upper ? null : 0]
  if (Array.isArray(value) && value.length === 2 && value.every(integer)) return [value[0], value[1]]
  return undefined
}
function description(value: unknown, warnings: string[], depth = 0): string {
  if (depth > 16) fail('limit', '描述结构过深')
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(v => description(v, warnings, depth + 1)).join('')
  if (object(value)) {
    let out = typeof value.text === 'string' ? value.text : ''
    if (Object.hasOwn(value, 'text') && typeof value.text !== 'string') warnings.push('无法解释text描述组件')
    if (Object.hasOwn(value, 'extra') && !Array.isArray(value.extra)) warnings.push('无法解释extra描述组件')
    if (!['text', 'extra', 'translate', 'selector', 'score', 'nbt', 'keybind'].some(k => Object.hasOwn(value, k))) warnings.push('描述组件缺少已识别内容')
    if (Array.isArray(value.extra)) out += value.extra.map(v => description(v, warnings, depth + 1)).join('')
    if ('translate' in value || 'selector' in value || 'score' in value || 'nbt' in value) warnings.push('动态或翻译描述仅显示可读取文字')
    if (Object.keys(value).some(k => !['text', 'extra', 'translate', 'selector', 'score', 'nbt', 'with', 'fallback', 'color', 'font', 'bold', 'italic', 'underlined', 'strikethrough', 'obfuscated', 'insertion', 'clickEvent', 'hoverEvent', 'click_event', 'hover_event'].includes(k))) warnings.push('包含未解释的描述组件')
    return out
  }
  fail('invalid', 'description需要文字或文本组件')
}
export function parseDatapackMetadata(bytes: Uint8Array): DatapackMetadata {
  if (bytes.byteLength > DATAPACK_LIMITS.metadataBytes) fail('limit', 'pack.mcmeta超过读取上限')
  const json = strictJson(utf8(bytes))
  if (!object(json) || !object(json.pack)) fail('invalid', '缺少pack元数据对象')
  const pack = json.pack, warnings: string[] = []
  if (!Object.hasOwn(pack, 'description')) fail('invalid', '缺少数据包描述')
  const metadata: DatapackMetadata = { description: description(pack.description, warnings).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 4096), formatSummary: '', features: [], overlays: [], warnings }
  if (Object.hasOwn(pack, 'pack_format')) { if (!integer(pack.pack_format)) fail('invalid', 'pack_format必须为非负整数'); metadata.packFormat = pack.pack_format }
  if (Object.hasOwn(pack, 'supported_formats')) { const r = range(pack.supported_formats); if (!r) fail('invalid', 'supported_formats范围无效'); metadata.supportedFormats = r }
  if (Object.hasOwn(pack, 'min_format') || Object.hasOwn(pack, 'max_format')) {
    const min = versionPair(pack.min_format, false), max = versionPair(pack.max_format, true)
    if (!min || !max || min[0] > max[0] || (min[0] === max[0] && max[1] !== null && min[1]! > max[1])) fail('invalid', 'min_format/max_format范围无效')
    metadata.minFormat = [min[0], min[1]!]; metadata.maxFormat = max
  }
  if (metadata.packFormat === undefined && !metadata.minFormat) fail('invalid', '缺少可识别的格式声明')
  const formats: string[] = []
  if (metadata.packFormat !== undefined) formats.push(`pack_format ${metadata.packFormat}`)
  if (metadata.supportedFormats) formats.push(`supported_formats ${metadata.supportedFormats.join('–')}`)
  if (metadata.minFormat && metadata.maxFormat) formats.push(`min/max ${metadata.minFormat.join('.')}–${metadata.maxFormat[0]}.${metadata.maxFormat[1] ?? '*'}`)
  metadata.formatSummary = formats.join('；')
  if (object(json.features) && Array.isArray(json.features.enabled)) {
    if (json.features.enabled.length > 128 || !json.features.enabled.every(x => typeof x === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(x) && x.length <= 256)) fail('invalid', 'features声明无效')
    metadata.features = json.features.enabled as string[]
    if (metadata.features.length) warnings.push('包含功能标记，未核实世界是否具备对应功能')
    if (Object.keys(json.features).some(k => k !== 'enabled')) warnings.push('包含未解释的features扩展字段')
  } else if (Object.hasOwn(json, 'features')) warnings.push('无法识别features声明')
  if (Object.hasOwn(json, 'overlays')) {
    if (object(json.overlays) && Array.isArray(json.overlays.entries) && json.overlays.entries.length <= 128) {
      for (const overlay of json.overlays.entries) {
        if (!object(overlay) || typeof overlay.directory !== 'string' || !safePath(overlay.directory)) fail('invalid', 'overlay目录无效')
        metadata.overlays.push(overlay.directory)
      }
    }
    warnings.push('包含overlay声明，本检查器未判断其版本选择与游戏加载结果')
  }
  if (Object.keys(pack).some(k => !['description', 'pack_format', 'supported_formats', 'min_format', 'max_format'].includes(k))) warnings.push('包含未解释的pack扩展字段')
  if (Object.keys(json).some(k => !['pack', 'features', 'overlays'].includes(k))) warnings.push('包含未解释的根元数据扩展字段')
  metadata.warnings = [...new Set(warnings)].slice(0, 32)
  return metadata
}

async function readExactly(handle: fs.FileHandle, length: number, position: number, b: Budget): Promise<Buffer> {
  b.check(); const data = Buffer.alloc(length); let done = 0
  while (done < length) { b.check(); const result = await handle.read(data, done, length - done, position + done); if (!result.bytesRead) fail('changed', '文件被截断'); done += result.bytesRead }
  b.check(); return data
}
async function withFile<T>(file: string, options: Options, read: (handle: fs.FileHandle, stat: BigIntStats, b: Budget) => Promise<T>, sharedBudget?: Budget): Promise<T> {
  const b = sharedBudget ?? budget(options), ancestors = await chain(path.dirname(path.resolve(file)), b)
  const before = await fs.lstat(file, { bigint: true }); b.check()
  if (!before.isFile() || before.isSymbolicLink()) fail('unsafe-path', '只能读取普通文件')
  const handle = await fs.open(file, 'r')
  try {
    if (!sameFile(before, await handle.stat({ bigint: true }))) fail('changed', '文件已变化')
    await verifyChain(ancestors, b)
    const result = await read(handle, before, b)
    await verifyChain(ancestors, b)
    if (!sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await fs.lstat(file, { bigint: true }))) fail('changed', '文件已变化，请重新选择')
    b.check(); return result
  } finally { await handle.close() }
}
async function readMetadataFile(file: string, options: Options, sharedBudget?: Budget, metadataReadBudget?: { remaining: number }): Promise<DatapackMetadata> {
  return withFile(file, options, async (handle, stat, b) => {
    await unique(path.dirname(file), 'pack.mcmeta', b)
    if (stat.size > BigInt(DATAPACK_LIMITS.metadataBytes)) fail('limit', 'pack.mcmeta超过读取上限')
    if (metadataReadBudget) {
      if (stat.size > BigInt(metadataReadBudget.remaining)) { metadataReadBudget.remaining = 0; fail('limit', '本次清单元数据累计读取达到上限') }
      metadataReadBudget.remaining -= Number(stat.size)
    }
    const result = parseDatapackMetadata(await readExactly(handle, Number(stat.size), 0, b))
    await unique(path.dirname(file), 'pack.mcmeta', b)
    return result
  }, sharedBudget)
}
function controlled(error: unknown): { status: 'invalid' | 'unsupported'; reason: string } {
  if (error instanceof DatapackReadError && ['invalid', 'unsupported', 'limit'].includes(error.code)) return { status: error.code === 'invalid' ? 'invalid' : 'unsupported', reason: error.message }
  throw error
}
export async function inventoryDatapacks(proof: DatapackWorldProof, options: Options = {}): Promise<DatapackInventoryData> {
  const b = budget(options); await verifyProof(proof, b)
  const directory = path.join(proof.world, 'datapacks')
  const result: DatapackInventoryData = { observedAt: new Date().toISOString(), items: [], warnings: [], truncated: false, directoryPresent: false }
  let stat: BigIntStats
  try { stat = await fs.lstat(directory, { bigint: true }) } catch (e) {
    if (errno(e) !== 'ENOENT') throw e
    proof.datapacks = null; await verifyProof(proof, b); return result
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-path', '数据包目录不是普通目录')
  proof.datapacks = stat; result.directoryPresent = true; proof.entries.clear()
  const handle = await fs.opendir(directory), seen = new Map<string, string>(), collisions = new Set<string>()
  let count = 0, retainedBytes = 0, warningBytes = 0, dtoFull = false, nameScanTruncated = false
  const metadataReadBudget = { remaining: DATAPACK_LIMITS.inventoryMetadataBytes }
  const warn = (message: string) => {
    const bytes = Buffer.byteLength(JSON.stringify(message)) + 1
    if (result.warnings.length < DATAPACK_LIMITS.warningCount && warningBytes + bytes <= DATAPACK_LIMITS.warningBytes) { result.warnings.push(message); warningBytes += bytes }
    else result.truncated = true
  }
  try {
    for await (const entry of handle) {
      b.check(); if (++count > DATAPACK_LIMITS.inventoryEntries) { result.truncated = true; nameScanTruncated = true; warn('目录条目超过上限，无法排除未读取名称冲突，未返回条目'); break }
      if (!safeName(entry.name)) { warn('已省略不安全文件名'); continue }
      const key = folded(entry.name)
      if (seen.has(key)) { collisions.add(key); continue }
      seen.set(key, entry.name)
      // Continue the bounded name scan after the DTO fills so a later colliding
      // name still removes an earlier visible item. Do not keep more metadata.
      if (dtoFull) continue
      let info: BigIntStats
      try { info = await fs.lstat(path.join(directory, entry.name), { bigint: true }) } catch { warn(`无法读取：${entry.name}`); continue }
      if (info.isSymbolicLink()) { warn(`已省略链接：${entry.name}`); continue }
      const kind = info.isDirectory() ? 'directory' : info.isFile() && /\.zip$/i.test(entry.name) ? 'zip' : undefined
      if (!kind) continue
      const id = itemId(entry.name), item: DatapackInventoryItem = { itemId: id, name: entry.name, kind, modifiedAt: new Date(Number(info.mtimeMs)).toISOString(), warnings: [], activation: 'unknown' }
      if (kind === 'zip') item.sizeBytes = Number(info.size)
      else {
        try {
          if (!metadataReadBudget.remaining) { result.truncated = true; item.warnings.push('本次元数据累计读取达到上限，未读取此条目详情') }
          else item.metadata = await readMetadataFile(path.join(directory, entry.name, 'pack.mcmeta'), options, b, metadataReadBudget)
        }
        catch (e) { if (e instanceof Error && e.name === 'AbortError') throw e; if (e instanceof DatapackReadError && e.code === 'changed') throw e; if (!metadataReadBudget.remaining) result.truncated = true; item.warnings.push('根目录元数据缺失、不可用或不受支持；尚未检查目录内数据') }
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1
      if (retainedBytes + itemBytes > DATAPACK_LIMITS.inventoryDtoBytes - DATAPACK_LIMITS.warningBytes - 4096) {
        dtoFull = true; result.truncated = true; warn('清单详情大小达到上限，后续条目未返回；可单独检查较小目录')
        continue
      }
      retainedBytes += itemBytes
      result.items.push(item); proof.entries.set(id, { name: entry.name, kind, stat: info })
    }
  } finally { await handle.close().catch(() => {}) }
  if (collisions.size) {
    result.items = result.items.filter(i => !collisions.has(folded(i.name)))
    for (const [id, entry] of proof.entries) if (collisions.has(folded(entry.name))) proof.entries.delete(id)
    warn('已省略存在大小写或Unicode冲突的名称')
  }
  if (nameScanTruncated) { result.items = []; proof.entries.clear() }
  result.items.sort((a, c) => a.name.localeCompare(c.name))
  await verifyProof(proof, b); b.check(); return result
}

interface ZipEntry { name: string; raw: Buffer; offset: number; flags: number; method: number; crc: number; compressed: number; size: number; directory: boolean }
async function inspectZip(handle: fs.FileHandle, size: number, b: Budget, signal?: AbortSignal): Promise<{ metadata: DatapackMetadata; count: number; sha512: string }> {
  if (size > DATAPACK_LIMITS.archiveBytes) fail('limit', 'ZIP超过512 MiB检查上限')
  if (size < 22) fail('invalid', 'ZIP结束记录缺失')
  const tailSize = Math.min(size, 65557), tail = await readExactly(handle, tailSize, size - tailSize, b)
  let eocd = -1
  for (let p = tail.length - 22; p >= 0; p--) if (tail.readUInt32LE(p) === 0x06054b50 && p + 22 + tail.readUInt16LE(p + 20) === tail.length) { eocd = p; break }
  if (eocd < 0) fail('invalid', 'ZIP结束记录无效')
  const end = size - tailSize + eocd
  if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6)) fail('unsupported', '暂不支持分卷ZIP')
  const count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdStart = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdStart === 0xffffffff) fail('unsupported', '此版本暂不支持ZIP64数据包预览')
  if (count !== tail.readUInt16LE(eocd + 8)) fail('invalid', 'ZIP条目数量不一致')
  if (count > DATAPACK_LIMITS.entries || cdSize > DATAPACK_LIMITS.centralDirectoryBytes) fail('limit', 'ZIP条目或中央目录超过上限')
  if (cdStart + cdSize !== end) fail('invalid', 'ZIP中央目录范围无效')
  const cd = await readExactly(handle, cdSize, cdStart, b), entries: ZipEntry[] = [], names = new Map<string, boolean>()
  let cursor = 0, expanded = 0
  for (let i = 0; i < count; i++) {
    b.check(); if (cursor + 46 > cd.length || cd.readUInt32LE(cursor) !== 0x02014b50) fail('invalid', 'ZIP中央目录条目无效')
    const flags = cd.readUInt16LE(cursor + 8), method = cd.readUInt16LE(cursor + 10)
    const nameBytes = cd.readUInt16LE(cursor + 28), extraBytes = cd.readUInt16LE(cursor + 30), commentBytes = cd.readUInt16LE(cursor + 32)
    const stop = cursor + 46 + nameBytes + extraBytes + commentBytes
    if (stop > cd.length || !nameBytes) fail('invalid', 'ZIP名称长度无效')
    if (flags & ~0x080e || flags & 1 || ![0, 8].includes(method)) fail('unsupported', 'ZIP使用加密、标志或压缩方式暂不支持')
    if (method === 0 && flags & 6) fail('invalid', '存储条目标志无效')
    const raw = Buffer.from(cd.subarray(cursor + 46, cursor + 46 + nameBytes)), name = utf8(raw, true), directory = name.endsWith('/')
    if (!safePath(name, directory)) fail('invalid', 'ZIP包含不安全路径')
    const external = cd.readUInt32LE(cursor + 38), mode = external >>> 16, type = mode & 0xf000
    if (type && type !== (directory ? 0x4000 : 0x8000)) fail('invalid', 'ZIP包含链接或特殊条目')
    if (!!(external & 0x10) && !directory) fail('invalid', 'ZIP目录标志不一致')
    if (cd.readUInt16LE(cursor + 34)) fail('unsupported', '暂不支持分卷ZIP')
    const compressed = cd.readUInt32LE(cursor + 20), entrySize = cd.readUInt32LE(cursor + 24), offset = cd.readUInt32LE(cursor + 42)
    if ([compressed, entrySize, offset].includes(0xffffffff)) fail('unsupported', '此版本暂不支持ZIP64数据包预览')
    if (entrySize > DATAPACK_LIMITS.entryBytes || (expanded += entrySize) > DATAPACK_LIMITS.totalExpandedBytes || (entrySize > 1024 ** 2 && entrySize / Math.max(1, compressed) > 1000)) fail('limit', 'ZIP展开大小或压缩比超过上限')
    if (directory && entrySize) fail('invalid', 'ZIP目录包含展开载荷')
    const key = folded(directory ? name.slice(0, -1) : name)
    if (names.has(key)) fail('invalid', 'ZIP含重复或大小写Unicode冲突路径')
    names.set(key, directory)
    entries.push({ name, raw, offset, flags, method, crc: cd.readUInt32LE(cursor + 16), compressed, size: entrySize, directory })
    cursor = stop
  }
  if (cursor !== cd.length) fail('invalid', 'ZIP中央目录包含多余内容')
  const prefixes = new Map<string, string>(); let prefixBytes = 0
  for (const entry of entries) {
    const parts = entry.name.replace(/\/$/, '').split('/')
    for (let depth = 1; depth <= parts.length; depth++) {
      const original = parts.slice(0, depth).join('/'), key = folded(original), previous = prefixes.get(key)
      if (previous !== undefined && previous !== original) fail('invalid', 'ZIP含目录前缀大小写或Unicode冲突')
      if (previous === undefined && (prefixBytes += Buffer.byteLength(original) * 4 + 64) > DATAPACK_LIMITS.prefixIndexBytes) fail('limit', 'ZIP路径索引超过检查上限')
      prefixes.set(key, original)
    }
  }
  for (const [name] of names) {
    const parts = name.split('/'); parts.pop()
    while (parts.length) { if (names.get(parts.join('/')) === false) fail('invalid', 'ZIP文件和目录路径冲突'); parts.pop() }
  }
  let metadataBytes: Buffer | undefined, hasData = false, endOfPrevious = 0, actualTotal = 0
  const sorted = [...entries].sort((a, c) => a.offset - c.offset)
  for (const entry of sorted) {
    b.check()
    if (entry.offset < endOfPrevious || entry.offset + 30 > cdStart) fail('invalid', 'ZIP载荷范围重叠或越界')
    const local = await readExactly(handle, 30, entry.offset, b)
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags || local.readUInt16LE(8) !== entry.method) fail('invalid', 'ZIP本地条目与中央目录不一致')
    const localName = local.readUInt16LE(26), localExtra = local.readUInt16LE(28)
    const start = entry.offset + 30 + localName + localExtra, endData = start + entry.compressed
    if (start > cdStart || endData > cdStart) fail('invalid', 'ZIP载荷越界')
    if (localName !== entry.raw.length || !(await readExactly(handle, localName, entry.offset + 30, b)).equals(entry.raw)) fail('invalid', 'ZIP本地名称与中央目录不一致')
    const descriptor = !!(entry.flags & 8)
    if (!descriptor && (local.readUInt32LE(14) !== entry.crc || local.readUInt32LE(18) !== entry.compressed || local.readUInt32LE(22) !== entry.size)) fail('invalid', 'ZIP本地大小或校验声明不一致')
    if (descriptor && [local.readUInt32LE(14), local.readUInt32LE(18), local.readUInt32LE(22)].some((n, i) => n !== 0 && n !== [entry.crc, entry.compressed, entry.size][i])) fail('invalid', 'ZIP描述符占位值无效')
    let actual = 0, crc = 0, metadata: Buffer[] = []
    const collect = (data: Buffer) => {
      b.check(); actual += data.length; actualTotal += data.length
      if (actual > entry.size || actual > DATAPACK_LIMITS.entryBytes || actualTotal > DATAPACK_LIMITS.totalExpandedBytes) fail('limit', 'ZIP实际展开内容超过上限')
      crc = crc32(data, crc)
      if (entry.name === 'pack.mcmeta') { if (actual > DATAPACK_LIMITS.metadataBytes) fail('limit', 'pack.mcmeta超过读取上限'); metadata.push(Buffer.from(data)) }
    }
    async function* compressed() {
      let position = start
      while (position < endData) { b.check(); const bytes = await readExactly(handle, Math.min(65536, endData - position), position, b); position += bytes.length; yield bytes }
    }
    if (entry.method === 0) { for await (const bytes of compressed()) collect(bytes) }
    else {
      const inflater = createInflateRaw(), source = (await import('node:stream')).Readable.from(compressed())
      const abort = () => { source.destroy(new DOMException('读取已取消', 'AbortError')); inflater.destroy(new DOMException('读取已取消', 'AbortError')) }
      signal?.addEventListener('abort', abort, { once: true })
      source.on('error', e => inflater.destroy(e)); source.pipe(inflater)
      try {
        for await (const bytes of inflater) collect(Buffer.from(bytes))
        if (inflater.bytesWritten !== entry.compressed) fail('invalid', 'ZIP压缩载荷包含多余字节')
      } catch (e) {
        if (e instanceof DatapackReadError || (e instanceof Error && e.name === 'AbortError')) throw e
        fail('invalid', 'ZIP压缩数据损坏')
      } finally { signal?.removeEventListener('abort', abort); source.destroy(); inflater.destroy() }
    }
    if (actual !== entry.size || crc !== entry.crc) fail('invalid', 'ZIP实际大小或CRC校验不一致')
    endOfPrevious = endData
    if (descriptor) {
      const first = await readExactly(handle, 4, endData, b), signed = first.readUInt32LE(0) === 0x08074b50, length = signed ? 16 : 12
      if (endData + length > cdStart) fail('invalid', 'ZIP数据描述符越界')
      const data = await readExactly(handle, length, endData, b), at = signed ? 4 : 0
      if (data.readUInt32LE(at) !== entry.crc || data.readUInt32LE(at + 4) !== entry.compressed || data.readUInt32LE(at + 8) !== entry.size) fail('invalid', 'ZIP数据描述符无效')
      endOfPrevious += length
    }
    if (entry.name === 'pack.mcmeta') metadataBytes = Buffer.concat(metadata)
    if (!entry.directory && /^data\/[a-z0-9_.-]+\/.+/.test(entry.name)) hasData = true
  }
  if (!metadataBytes) fail('invalid', entries.some(e => /\/pack\.mcmeta$/.test(e.name)) ? 'pack.mcmeta位于外层文件夹中，请选择根目录直接包含它的ZIP' : 'ZIP根目录缺少pack.mcmeta')
  const metadata = parseDatapackMetadata(metadataBytes)
  if (!hasData) {
    const overlays = metadata.overlays
    hasData = entries.some(e => !e.directory && overlays.some(o => e.name.startsWith(o + '/data/') && /^[a-z0-9_.-]+\/.+/.test(e.name.slice(o.length + 6))))
  }
  if (!hasData) fail('invalid', '未发现data命名空间内容，不能将资源包视为数据包')
  const hash = createHash('sha512')
  for (let p = 0; p < size; p += 1024 ** 2) hash.update(await readExactly(handle, Math.min(1024 ** 2, size - p), p, b))
  return { metadata, count: entries.filter(e => !e.directory).length, sha512: hash.digest('hex') }
}
export async function inspectDatapackZip(file: string, options: Options = {}): Promise<DatapackPreview> {
  const name = path.basename(file)
  if (!safeName(name) || !/\.zip$/i.test(name)) fail('unsafe-path', '请选择普通ZIP数据包')
  try {
    return await withFile(file, options, async (handle, stat, b) => {
      const beforeHash = createHash('sha512'), size = Number(stat.size)
      if (stat.size > BigInt(DATAPACK_LIMITS.archiveBytes)) fail('limit', 'ZIP超过512 MiB检查上限')
      for (let p = 0; p < size; p += 1024 ** 2) beforeHash.update(await readExactly(handle, Math.min(1024 ** 2, size - p), p, b))
      const inspected = await inspectZip(handle, size, b, options.signal)
      if (beforeHash.digest('hex') !== inspected.sha512) fail('changed', 'ZIP读取期间内容已变化')
      return { name, kind: 'zip', status: 'checked', archiveBytes: size, sha512: inspected.sha512, fileCount: inspected.count, metadata: inspected.metadata, warnings: [...inspected.metadata.warnings, '仅检查文件结构和声明，不证明游戏可用或启用状态'] }
    })
  } catch (error) { return { name, kind: 'zip', ...controlled(error), warnings: [] } }
}
export async function inspectDatapackItem(proof: DatapackWorldProof, id: string, options: Options = {}): Promise<DatapackPreview> {
  await verifyDatapackWorld(proof, options)
  const entry = proof.entries.get(id)
  if (!entry) fail('changed', '条目已失效，请刷新清单')
  const file = path.join(proof.world, 'datapacks', entry!.name)
  if (!sameFile(entry!.stat, await fs.lstat(file, { bigint: true }))) fail('changed', '条目已变化，请刷新清单')
  let result: DatapackPreview
  if (entry!.kind === 'zip') result = await inspectDatapackZip(file, options)
  else {
    try { result = { name: entry!.name, kind: 'directory', status: 'checked', metadata: await readMetadataFile(path.join(file, 'pack.mcmeta'), options), warnings: ['仅检查根目录元数据，未递归检查data内容或启用状态'] } }
    catch (error) { if (errno(error) === 'ENOENT') result = { name: entry!.name, kind: 'directory', status: 'invalid', reason: '根目录缺少pack.mcmeta', warnings: [] }; else result = { name: entry!.name, kind: 'directory', ...controlled(error), warnings: [] } }
  }
  if (!sameFile(entry!.stat, await fs.lstat(file, { bigint: true }))) fail('changed', '条目已变化，请刷新清单')
  await verifyDatapackWorld(proof, options)
  return result
}
