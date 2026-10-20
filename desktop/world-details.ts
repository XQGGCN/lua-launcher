import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { NbtReadError, nbtPathKey, readNbtProjection, type NbtProjectedTag } from './nbt-reader'
import type { WorldDetailsData, WorldMetadata, WorldReason, WorldSelection, WorldSource } from './world-types'

export interface WorldRead {
  details: WorldDetailsData
  /** Main-process-only fingerprint. Do not expose filesystem identities to the renderer. */
  revisionKey?: string
  /** Deliberately absent unless includeSeed was explicitly requested. Never in details. */
  seed?: string
}
export interface WorldReadOptions { source?: WorldSource; signal?: AbortSignal; includeSeed?: boolean }
export const WORLD_READ_LIMITS = Object.freeze({
  compressedBytes: 8 * 1024 * 1024, expandedBytes: 32 * 1024 * 1024,
  directoryEntries: 5000, durationMs: 5000, dtoBytes: 128 * 1024,
})
class WorldReadFailure extends Error {
  constructor(public readonly code: WorldReason) { super(code); this.name = 'WorldReadFailure' }
}
const fail = (code: WorldReason): never => { throw new WorldReadFailure(code) }
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code
const folded = (name: string) => name.normalize('NFC').toLowerCase()
const id = (name: string) => `worlds:${createHash('sha256').update(name).digest('hex')}`
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i
function safeName(name: unknown): name is string {
  return typeof name === 'string' && Boolean(name && name !== '.' && name !== '..' &&
    Buffer.byteLength(name, 'utf8') <= 255 && !/[ .]$/.test(name) && !WINDOWS_DEVICE.test(name) &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff\ufffd]/u.test(name))
}
function sameNode(a: BigIntStats, b: BigIntStats) { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode }
function sameFile(a: BigIntStats, b: BigIntStats) {
  return sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
}
function proof(info: BigIntStats, file = false): string[] {
  return (file ? [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs, info.nlink] :
    [info.dev, info.ino, info.mode]).map(String)
}
type Budget = { check: () => void; deadline: number }

/** Every ancestor is inspected; only macOS's exact system /tmp and /var aliases are allowed. */
async function directoryChain(directory: string, budget: Budget): Promise<Map<string, BigIntStats>> {
  const root = path.parse(directory).root
  let current = root
  const chain = new Map<string, BigIntStats>()
  for (const segment of directory.slice(root.length).split(path.sep)) {
    budget.check(); current = path.join(current, segment)
    const info = await fs.lstat(current, { bigint: true }); budget.check()
    if (info.isSymbolicLink()) {
      const systemAlias = process.platform === 'darwin' && current !== directory &&
        ((current === '/tmp' && await fs.realpath(current) === '/private/tmp') ||
         (current === '/var' && await fs.realpath(current) === '/private/var'))
      if (!systemAlias) fail('unsafe-path')
    } else if (!info.isDirectory()) fail('unsafe-path')
    chain.set(current, info)
  }
  return chain
}
async function uniqueWorld(saves: string, name: string, budget: Budget): Promise<void> {
  budget.check()
  const directory = await fs.opendir(saves)
  let entries = 0, matched = 0, exact = false
  try {
    while (true) {
      budget.check()
      const entry = await directory.read(); budget.check()
      if (!entry) break
      if (++entries > WORLD_READ_LIMITS.directoryEntries) fail('limit-exceeded')
      if (folded(entry.name) === folded(name)) { matched++; exact ||= entry.name === name }
    }
  } finally { await directory.close() }
  if (matched > 1 || (matched === 1 && !exact)) fail('name-collision')
  if (!matched) fail('missing')
}
async function recheck(
  world: string, saves: string, name: string, chain: Map<string, BigIntStats>,
  file: string, original: BigIntStats, handle: fs.FileHandle, budget: Budget,
) {
  try {
    const now = await directoryChain(world, budget)
    for (const [directory, before] of chain) {
      if (!now.has(directory) || !sameNode(before, now.get(directory)!)) fail('changed')
    }
    await uniqueWorld(saves, name, budget)
    const current = await fs.lstat(file, { bigint: true }), open = await handle.stat({ bigint: true })
    budget.check()
    if (!current.isFile() || current.isSymbolicLink() || !open.isFile() ||
        !sameFile(original, current) || !sameFile(original, open)) fail('changed')
  } catch (error) {
    if (error instanceof WorldReadFailure && error.code === 'limit-exceeded') throw error
    if (error instanceof Error && error.name === 'AbortError') throw error
    // A once-validated path disappearing, becoming unsafe or inaccessible is a
    // changing snapshot. No partially parsed values escape that snapshot.
    fail('changed')
  }
}

async function expand(compressed: Buffer, budget: Budget, signal?: AbortSignal): Promise<Buffer> {
  if (compressed.length < 3 || compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed[2] !== 8) {
    fail('unsupported-compression')
  }
  const chunks: Buffer[] = []
  let size = 0
  const source = Readable.from((function* () {
    for (let offset = 0; offset < compressed.length; offset += 64 * 1024) {
      budget.check(); yield compressed.subarray(offset, offset + 64 * 1024)
    }
  })())
  const gunzip = createGunzip()
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) {
    try {
      budget.check(); size += chunk.length
      if (size > WORLD_READ_LIMITS.expandedBytes) fail('limit-exceeded')
      chunks.push(chunk); done()
    } catch (error) { done(error as Error) }
  } })
  try {
    // Default finish behavior verifies CRC/truncation. Never use Z_SYNC_FLUSH.
    // All gzip members share this output budget; the parser rejects trailing NBT.
    await pipeline(source, gunzip, sink, { signal })
    budget.check()
    return Buffer.concat(chunks, size)
  } catch (error) {
    budget.check()
    if (error instanceof WorldReadFailure) throw error
    return fail('invalid-gzip')
  }
}

const PATHS = [
  ['Data'], ['Data', 'Version'], ['Data', 'WorldGenSettings'],
  ['Data', 'LevelName'], ['Data', 'Version', 'Name'], ['Data', 'DataVersion'], ['Data', 'Version', 'Id'],
  ['Data', 'Version', 'Snapshot'], ['Data', 'GameType'], ['Data', 'Difficulty'], ['Data', 'hardcore'],
  ['Data', 'allowCommands'], ['Data', 'Time'], ['Data', 'DayTime'], ['Data', 'LastPlayed'],
  ['Data', 'WorldGenSettings', 'seed'],
  ['Data', 'difficulty_settings'], ['Data', 'difficulty_settings', 'difficulty'],
  ['Data', 'difficulty_settings', 'hardcore'],
] as const

function project(tags: Map<string, NbtProjectedTag>, details: WorldDetailsData): string | undefined {
  const get = (segments: readonly string[]) => tags.get(nbtPathKey(segments))
  if (get(['Data'])?.type !== 10) fail('unsupported-layout')
  const warning = (field: string, code: WorldDetailsData['fieldWarnings'][number]['code']) => {
    details.fieldWarnings.push({ field, code })
  }
  function field(key: string, segments: readonly string[], type: number, optional = false): NbtProjectedTag | undefined {
    const value = get(segments)
    // A known ancestor of the wrong type is a mismatch, not an invented missing child.
    if (segments.slice(1, -1).some((_, index) => {
      const parent = get(segments.slice(0, index + 2)); return parent && parent.type !== 10
    })) { warning(key, 'type-mismatch'); return }
    if (!value) { if (!optional) warning(key, 'missing'); return }
    if (value.type !== type) { warning(key, 'type-mismatch'); return }
    if (value.truncated) warning(key, 'truncated')
    return value
  }
  const metadata: WorldMetadata = details.metadata
  for (const [key, segments] of [
    ['levelName', ['Data', 'LevelName']], ['savedVersionName', ['Data', 'Version', 'Name']],
  ] as const) {
    const value = field(key, segments, 8)
    if (value) metadata[key] = value.value as string
  }
  for (const [key, segments] of [
    ['dataVersion', ['Data', 'DataVersion']], ['versionId', ['Data', 'Version', 'Id']],
  ] as const) {
    const value = field(key, segments, 3, key === 'versionId')
    if (value) metadata[key] = value.value as number
  }
  for (const [key, segments] of [
    ['snapshot', ['Data', 'Version', 'Snapshot']],
    ['allowCommands', ['Data', 'allowCommands']],
  ] as const) {
    const value = field(key, segments, 1)
    if (value) {
      if (value.value === 0 || value.value === 1) metadata[key] = value.value === 1
      else warning(key, 'invalid-value')
    }
  }
  for (const [key, segments, type, labels] of [
    ['gameMode', ['Data', 'GameType'], 3, ['生存', '创造', '冒险', '旁观']],
  ] as const) {
    const value = field(key, segments, type)
    if (value) {
      const raw = value.value as number, label = labels[raw]
      metadata[key] = { raw, ...(label !== undefined ? { label } : {}) }
      if (label === undefined) warning(key, 'invalid-value')
    }
  }
  // 26.1 moved difficulty/hardcore within this same file. Never infer either
  // setting from the instance version, and do not combine contradictory layouts.
  const oldDifficulty = get(['Data', 'Difficulty'])
  const newDifficulty = get(['Data', 'difficulty_settings', 'difficulty'])
  const difficulties = ['peaceful', 'easy', 'normal', 'hard']
  const difficultyLabels = ['和平', '简单', '普通', '困难']
  if (oldDifficulty && newDifficulty) {
    if (oldDifficulty.type !== 1 || newDifficulty.type !== 8) warning('difficulty', 'type-mismatch')
    else if (difficulties[oldDifficulty.value as number] !== newDifficulty.value) warning('difficulty', 'invalid-value')
    else metadata.difficulty = { raw: oldDifficulty.value as number, label: difficultyLabels[oldDifficulty.value as number] }
  } else {
    const difficulty = oldDifficulty ? field('difficulty', ['Data', 'Difficulty'], 1) :
      field('difficulty', ['Data', 'difficulty_settings', 'difficulty'], 8)
    if (difficulty) {
      const raw = difficulty.value as number | string
      const index = typeof raw === 'number' ? raw : difficulties.indexOf(raw)
      const label = difficultyLabels[index]
      metadata.difficulty = { raw, ...(label !== undefined ? { label } : {}) }
      if (label === undefined) warning('difficulty', 'invalid-value')
    }
  }
  const oldHardcore = get(['Data', 'hardcore'])
  const newHardcore = get(['Data', 'difficulty_settings', 'hardcore'])
  if (oldHardcore && newHardcore) {
    if (oldHardcore.type !== 1 || newHardcore.type !== 1) warning('hardcore', 'type-mismatch')
    else if (oldHardcore.value !== newHardcore.value || (oldHardcore.value !== 0 && oldHardcore.value !== 1)) warning('hardcore', 'invalid-value')
    else metadata.hardcore = oldHardcore.value === 1
  } else {
    const hardcore = field('hardcore', oldHardcore ? ['Data', 'hardcore'] : ['Data', 'difficulty_settings', 'hardcore'], 1)
    if (hardcore) {
      if (hardcore.value === 0 || hardcore.value === 1) metadata.hardcore = hardcore.value === 1
      else warning('hardcore', 'invalid-value')
    }
  }
  for (const [key, segments] of [
    ['timeTicks', ['Data', 'Time']], ['dayTimeTicks', ['Data', 'DayTime']],
  ] as const) {
    const value = field(key, segments, 4)
    if (value) metadata[key] = (value.value as bigint).toString()
  }
  const lastPlayed = field('lastPlayed', ['Data', 'LastPlayed'], 4)
  if (lastPlayed) {
    const raw = lastPlayed.value as bigint
    const iso = raw >= -8640000000000000n && raw <= 8640000000000000n ? new Date(Number(raw)).toISOString() : undefined
    metadata.lastPlayed = { epochMs: raw.toString(), ...(iso !== undefined ? { iso } : {}) }
    if (iso === undefined || raw < 0n) warning('lastPlayed', 'invalid-value')
  }
  const seed = field('seed', ['Data', 'WorldGenSettings', 'seed'], 4)
  details.seedAvailable = seed !== undefined
  if (!get(['Data', 'DataVersion'])) details.warnings.push('未记录 DataVersion；无法确认保存格式版本。')
  details.status = details.fieldWarnings.length ? 'partial' : 'ok'
  return seed ? (seed.value as bigint).toString() : undefined
}

/**
 * Read one explicitly selected world file without mkdir, writes, repairs, game
 * processes, networking or fallback to level.dat_old. Metadata reads cannot
 * interrupt a filesystem syscall already submitted to the OS. Identity checks
 * detect ordinary concurrent changes, not a consistent live-game snapshot.
 */
export async function readWorldDetails(
  instanceDirectory: string, selection: WorldSelection, options: WorldReadOptions = {},
): Promise<WorldRead> {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
      Object.keys(selection).sort().join(',') !== 'itemId,name' || !safeName(selection.name) ||
      selection.itemId !== id(selection.name)) throw new TypeError('世界选择无效')
  if (typeof instanceDirectory !== 'string' || !path.isAbsolute(instanceDirectory) ||
      instanceDirectory.length > 32768 || /[\u0000-\u001f\u007f]/u.test(instanceDirectory) ||
      path.resolve(instanceDirectory) === path.parse(path.resolve(instanceDirectory)).root) throw new TypeError('实例目录无效')
  const source = options.source ?? 'level.dat'
  if (source !== 'level.dat' && source !== 'level.dat_old') throw new TypeError('世界文件来源无效')
  if (options.includeSeed !== undefined && typeof options.includeSeed !== 'boolean') throw new TypeError('种子选项无效')
  const deadline = performance.now() + WORLD_READ_LIMITS.durationMs
  const budget: Budget = { deadline, check() {
    if (options.signal?.aborted) throw new DOMException('世界读取已取消', 'AbortError')
    if (performance.now() >= deadline) fail('limit-exceeded')
  } }
  budget.check()
  const details: WorldDetailsData = {
    itemId: selection.itemId, folderName: selection.name, source, observedAt: new Date().toISOString(),
    status: 'unavailable', metadata: {}, fieldWarnings: [], warnings: [], seedAvailable: false,
  }
  const saves = path.join(path.resolve(instanceDirectory), 'game', 'saves')
  const world = path.join(saves, selection.name), file = path.join(world, source)
  let handle: fs.FileHandle | undefined
  try {
    const chain = await directoryChain(world, budget)
    await uniqueWorld(saves, selection.name, budget)
    const before = await fs.lstat(file, { bigint: true }); budget.check()
    if (!before.isFile() || before.isSymbolicLink()) fail('unsafe-path')
    if (before.size > BigInt(WORLD_READ_LIMITS.compressedBytes)) fail('limit-exceeded')
    details.file = { sizeBytes: Number(before.size), modifiedAt: new Date(Number(before.mtimeMs)).toISOString() }
    handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat({ bigint: true }); budget.check()
    if (!opened.isFile() || !sameFile(before, opened)) fail('changed')
    const compressed = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < compressed.length) {
      budget.check()
      const { bytesRead } = await handle.read(compressed, offset, Math.min(64 * 1024, compressed.length - offset), offset)
      budget.check()
      if (!bytesRead) fail('changed')
      offset += bytesRead
    }
    await recheck(world, saves, selection.name, chain, file, before, handle, budget)
    const expanded = await expand(compressed, budget, options.signal)
    const tags = await readNbtProjection(expanded, PATHS, { signal: options.signal, deadline })
    const seed = project(tags, details)
    budget.check()
    if (Buffer.byteLength(JSON.stringify(details)) > WORLD_READ_LIMITS.dtoBytes) fail('limit-exceeded')
    await recheck(world, saves, selection.name, chain, file, before, handle, budget)
    const fingerprint = createHash('sha256').update(compressed).update(JSON.stringify([
      source, selection.name, [...chain].map(([directory, info]) => [directory, proof(info)]), proof(before, true),
    ])).digest('hex')
    budget.check()
    return { details, revisionKey: fingerprint, ...(options.includeSeed && seed !== undefined ? { seed } : {}) }
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('世界读取已取消', 'AbortError')
    const reason: WorldReason = performance.now() >= deadline ? 'limit-exceeded' :
      error instanceof WorldReadFailure || error instanceof NbtReadError ? error.code :
      errno(error) === 'ENOENT' ? 'missing' : errno(error) === 'ELOOP' || errno(error) === 'ENOTDIR' ? 'unsafe-path' : 'unreadable'
    details.status = 'unavailable'; details.reasonCode = reason; details.metadata = {}
    details.seedAvailable = false; details.fieldWarnings = []; details.warnings = []
    if (reason === 'changed') delete details.file
    return { details }
  } finally { await handle?.close() }
}
