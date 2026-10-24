import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { BACKUP_LIMITS, backupSafeName, parseBackupManifest, type BackupManifest } from './world-backup-manifest'
import { crc32 } from './world-zip'
import { beginWorldRestoreTransaction, publishWorldRestore, type RestoreEntry, type RestoreTransaction } from './world-restore-transaction'

/*
 * Restoring worlds never overwrites anything: files are written into a private staging
 * directory, checked, then copied into an exclusively reserved new folder in saves/.
 * Completion is committed in an external recovery journal. This is not atomic directory
 * visibility to other launchers; incomplete/failed operations are retained and block Lua.
 *
 *  - From a completed directory backup: every file is re-hashed against the manifest.
 *  - From a ZIP (a Lua export or any downloaded map): entries are inflated one at a time
 *    with CRC-32 and size checks; Lua exports additionally check SHA-256 per file.
 */
export interface WorldRestoreProgress { phase: 'scan' | 'copy' | 'commit'; filesDone: number; filesTotal?: number; bytesDone: number; bytesTotal?: number }
export interface WorldRestoreResult { folderName: string; fileCount: number; directoryCount: number; totalBytes: number; source: 'backup' | 'lua-zip' | 'zip' }
export interface WorldZipInspection {
  fileName: string
  format: 'lua-zip' | 'zip'
  suggestedName: string
  fileCount: number
  totalBytes: number
  hasLevelDat: true
}

export const RESTORE_LIMITS = Object.freeze({
  entries: BACKUP_LIMITS.entries, totalBytes: BACKUP_LIMITS.totalBytes, fileBytes: BACKUP_LIMITS.fileBytes,
  centralDirectoryBytes: 160 * 1024 ** 2, chunkBytes: 1024 ** 2, pathBytes: 1024, depth: 64, ratio: 4000,
})
const readFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
const UINT32_MAX = 0xffffffff

export class WorldRestoreError extends Error {
  constructor(message: string) { super(message); this.name = 'WorldRestoreError' }
}
const fail = (message: string): never => { throw new WorldRestoreError(message) }

/** A folder name that is safe on Windows, macOS and Linux. */
export function safeWorldFolderName(value: unknown): value is string {
  return backupSafeName(value) && (value as string).length <= 80 && !(value as string).startsWith('.')
}
/** Picks `name`, `name (2)`, `name (3)`… that does not exist in `saves` (case-insensitively). */
export async function availableWorldName(saves: string, preferred: string): Promise<string> {
  const base = safeWorldFolderName(preferred) ? preferred : 'world'
  let existing: Set<string>
  try { existing = new Set((await fs.readdir(saves)).map(name => name.normalize('NFC').toLowerCase())) } catch { existing = new Set() }
  for (let index = 1; index < 1000; index++) {
    const candidate = index === 1 ? base : `${base} (${index})`
    if (!existing.has(candidate.normalize('NFC').toLowerCase())) return candidate
  }
  return fail('同名世界过多，请换一个名称')
}

async function readExactly(handle: fs.FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done)
    if (bytesRead <= 0) fail('ZIP 文件提前结束或已损坏')
    done += bytesRead
  }
  return buffer
}

// ---------------------------------------------------------------- lenient ZIP reading
export interface ZipEntryInfo { name: string; directory: boolean; method: number; crc: number; compressed: number; size: number; offset: number; flags: number }

/** Reads the central directory of any ordinary ZIP (comments, gaps and data descriptors allowed). */
export async function readZipDirectory(handle: fs.FileHandle, size: number): Promise<ZipEntryInfo[]> {
  if (size < 22) fail('不是有效的 ZIP 文件')
  const tailLength = Math.min(size, 22 + 0xffff)
  const tail = await readExactly(handle, tailLength, size - tailLength)
  let endAt = -1
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { endAt = index; break }
  }
  if (endAt < 0) fail('不是有效的 ZIP 文件')
  const endOffset = size - tailLength + endAt
  if (tail.readUInt16LE(endAt + 4) !== 0 || tail.readUInt16LE(endAt + 6) !== 0) fail('不支持分卷 ZIP')
  let count = tail.readUInt16LE(endAt + 10), cdSize = tail.readUInt32LE(endAt + 12), cdOffset = tail.readUInt32LE(endAt + 16)
  if (count === 0xffff || cdSize === UINT32_MAX || cdOffset === UINT32_MAX) {
    if (endOffset < 20) fail('ZIP64 结构缺失')
    const locator = await readExactly(handle, 20, endOffset - 20)
    if (locator.readUInt32LE(0) !== 0x07064b50) fail('ZIP64 结构缺失')
    const recordOffset = Number(locator.readBigUInt64LE(8))
    if (recordOffset + 56 > size) fail('ZIP64 结构无效')
    const record = await readExactly(handle, 56, recordOffset)
    if (record.readUInt32LE(0) !== 0x06064b50) fail('ZIP64 结构无效')
    count = Number(record.readBigUInt64LE(32)); cdSize = Number(record.readBigUInt64LE(40)); cdOffset = Number(record.readBigUInt64LE(48))
  }
  if (count > RESTORE_LIMITS.entries + 16) fail('ZIP 条目数量超出上限')
  if (cdSize > RESTORE_LIMITS.centralDirectoryBytes || cdOffset + cdSize > size) fail('ZIP 中央目录无效')
  const directory = await readExactly(handle, cdSize, cdOffset)
  const entries: ZipEntryInfo[] = []
  let cursor = 0
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) fail('ZIP 中央目录记录无效')
    const flags = directory.readUInt16LE(cursor + 8), method = directory.readUInt16LE(cursor + 10)
    const crc = directory.readUInt32LE(cursor + 16)
    let compressed = directory.readUInt32LE(cursor + 20), entrySize = directory.readUInt32LE(cursor + 24)
    const nameLength = directory.readUInt16LE(cursor + 28), extraLength = directory.readUInt16LE(cursor + 30), commentLength = directory.readUInt16LE(cursor + 32)
    let offset = directory.readUInt32LE(cursor + 42)
    const externalAttributes = directory.readUInt32LE(cursor + 38)
    const start = cursor + 46
    if (start + nameLength + extraLength + commentLength > directory.length) fail('ZIP 中央目录越界')
    const rawName = directory.subarray(start, start + nameLength)
    const name = flags & 0x0800 ? new TextDecoder('utf-8', { fatal: false }).decode(rawName) : decodeLegacyName(rawName)
    const extra = directory.subarray(start + nameLength, start + nameLength + extraLength)
    if (entrySize === UINT32_MAX || compressed === UINT32_MAX || offset === UINT32_MAX) {
      let position = 0
      while (position + 4 <= extra.length) {
        const id = extra.readUInt16LE(position), length = extra.readUInt16LE(position + 2)
        if (id === 0x0001) {
          let field = position + 4
          if (entrySize === UINT32_MAX) { entrySize = Number(extra.readBigUInt64LE(field)); field += 8 }
          if (compressed === UINT32_MAX) { compressed = Number(extra.readBigUInt64LE(field)); field += 8 }
          if (offset === UINT32_MAX) { offset = Number(extra.readBigUInt64LE(field)) }
          break
        }
        position += 4 + length
      }
    }
    const symlink = ((externalAttributes >>> 16) & 0o170000) === 0o120000
    if (!symlink) entries.push({ name: name.replace(/\\/g, '/'), directory: name.endsWith('/') || name.endsWith('\\'), method, crc, compressed, size: entrySize, offset, flags })
    cursor = start + nameLength + extraLength + commentLength
  }
  return entries
}
function decodeLegacyName(bytes: Uint8Array): string {
  // Many Chinese map archives use GBK names without the UTF-8 flag; try UTF-8, then GB18030.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* fall through */ }
  try { return new TextDecoder('gb18030').decode(bytes) } catch { return new TextDecoder('latin1').decode(bytes) }
}

async function* entryData(handle: fs.FileHandle, entry: ZipEntryInfo, size: number, signal?: AbortSignal): AsyncGenerator<Buffer> {
  if (entry.flags & 0x0001) fail('不支持加密的 ZIP')
  if (entry.method !== 0 && entry.method !== 8) fail('ZIP 使用了不支持的压缩方式')
  if (entry.size > RESTORE_LIMITS.fileBytes || entry.compressed > size) fail('ZIP 中的文件过大')
  if (entry.size > 1024 * 1024 && entry.compressed > 0 && entry.size / entry.compressed > RESTORE_LIMITS.ratio) fail('ZIP 压缩比异常，已拒绝')
  const local = await readExactly(handle, 30, entry.offset)
  if (local.readUInt32LE(0) !== 0x04034b50) fail('ZIP 本地文件头无效')
  const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  const end = start + entry.compressed
  if (end > size) fail('ZIP 数据越界')
  const source = Readable.from((async function* () {
    for (let position = start; position < end;) {
      signal?.throwIfAborted()
      const length = Math.min(RESTORE_LIMITS.chunkBytes, end - position)
      yield await readExactly(handle, length, position)
      position += length
    }
  })())
  const stream = entry.method === 8 ? source.pipe(zlib.createInflateRaw({ chunkSize: 256 * 1024 })) : source
  let produced = 0, crc = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      produced += chunk.length
      if (produced > entry.size) fail('ZIP 解压大小超出记录')
      crc = crc32(chunk, crc)
      yield chunk
    }
  } catch (error) {
    if (signal?.aborted || error instanceof WorldRestoreError) throw error
    fail('ZIP 压缩数据损坏')
  }
  if (produced !== entry.size || crc !== entry.crc) fail(`${entry.name} 的校验值不一致，ZIP 可能已损坏`)
}

function safeRelative(name: string): string | undefined {
  const parts = name.split('/').filter(Boolean)
  if (!parts.length || parts.length > RESTORE_LIMITS.depth || Buffer.byteLength(name) > RESTORE_LIMITS.pathBytes) return undefined
  if (parts.some(part => part === '.' || part === '..' || !backupSafeName(part))) return undefined
  return parts.join('/')
}

interface ZipPlan { format: 'lua-zip' | 'zip'; root: string; suggestedName: string; files: ZipEntryInfo[]; directories: string[]; totalBytes: number; manifest?: BackupManifest }

/** Finds the world inside a ZIP: a Lua export (world/) or the shallowest folder holding level.dat. */
async function planZip(handle: fs.FileHandle, size: number, fileName: string, signal?: AbortSignal): Promise<ZipPlan> {
  const entries = (await readZipDirectory(handle, size)).filter(entry => !/(^|\/)__MACOSX\//.test(entry.name) && !/(^|\/)\.DS_Store$/.test(entry.name))
  const names = new Set(entries.map(entry => entry.name))
  let manifest: BackupManifest | undefined
  let root: string
  let format: ZipPlan['format'] = 'zip'
  let suggested = fileName.replace(/\.zip$/i, '')
  if (names.has('lua-backup/manifest.json') && names.has('lua-backup/format.json') && names.has('world/')) {
    const entry = entries.find(item => item.name === 'lua-backup/manifest.json')!
    if (entry.size > BACKUP_LIMITS.manifestBytes) fail('备份清单过大')
    const chunks: Buffer[] = []
    for await (const chunk of entryData(handle, entry, size, signal)) chunks.push(chunk)
    try { manifest = parseBackupManifest(Buffer.concat(chunks)) } catch { return fail('ZIP 中的备份清单无效') }
    root = 'world/'; format = 'lua-zip'; suggested = manifest.worldFolderName
  } else {
    const levels = entries.filter(entry => !entry.directory && /(^|\/)level\.dat$/.test(entry.name))
      .map(entry => entry.name.slice(0, -'level.dat'.length)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    if (!levels.length) fail('ZIP 里没有找到 level.dat，不是 Minecraft 世界或地图')
    root = levels[0]
    if (root) suggested = root.split('/').filter(Boolean).pop() || suggested
  }
  const files: ZipEntryInfo[] = []
  const directories = new Set<string>()
  let totalBytes = 0
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.name.startsWith(root) || entry.name === root) continue
    const relative = safeRelative(entry.name.slice(root.length))
    if (!relative) fail(`ZIP 包含不安全的路径：${entry.name.slice(0, 120)}`)
    const key = relative!.normalize('NFC').toLowerCase()
    if (seen.has(key)) fail('ZIP 中有重复或仅大小写不同的文件名')
    seen.add(key)
    const parts = relative!.split('/')
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
    if (entry.directory) { directories.add(relative!); continue }
    totalBytes += entry.size
    if (totalBytes > RESTORE_LIMITS.totalBytes) fail('世界解压后超出大小上限')
    files.push({ ...entry, name: relative! })
  }
  if (files.length > RESTORE_LIMITS.entries) fail('世界文件数量超出上限')
  if (!files.some(entry => entry.name === 'level.dat')) fail('ZIP 中的世界缺少 level.dat')
  if (manifest) {
    const expected = new Map(manifest.entries.filter(entry => entry.type === 'file').map(entry => [entry.path, entry]))
    if (expected.size !== files.length || files.some(entry => expected.get(entry.name)?.sizeBytes !== entry.size)) fail('ZIP 内容与备份清单不一致')
  }
  return { format, root, suggestedName: safeWorldFolderName(suggested) ? suggested : 'world', files, directories: [...directories].sort(), totalBytes, manifest }
}

export async function inspectWorldZip(file: string, signal?: AbortSignal): Promise<WorldZipInspection> {
  const handle = await fs.open(file, readFlags)
  try {
    const info = await handle.stat()
    if (!info.isFile()) fail('请选择一个 ZIP 文件')
    const plan = await planZip(handle, info.size, path.basename(file), signal)
    return { fileName: path.basename(file).slice(0, 200), format: plan.format, suggestedName: plan.suggestedName, fileCount: plan.files.length, totalBytes: plan.totalBytes, hasLevelDat: true }
  } finally { await handle.close() }
}

// ---------------------------------------------------------------- restore
export interface RestoreOptions {
  saves: string
  staging: string
  folderName?: string
  signal?: AbortSignal
  onProgress?: (progress: WorldRestoreProgress) => void
}

async function writeStream(target: string, chunks: AsyncIterable<Buffer>, hash?: ReturnType<typeof createHash>): Promise<number> {
  const handle = await fs.open(target, 'wx')
  let written = 0
  try {
    for await (const chunk of chunks) {
      hash?.update(chunk)
      for (let done = 0; done < chunk.length;) {
        const { bytesWritten } = await handle.write(chunk, done, chunk.length - done, null)
        if (bytesWritten <= 0) fail('写入世界文件失败')
        done += bytesWritten
      }
      written += chunk.length
    }
  } finally { await handle.close() }
  return written
}

async function withStaging<T>(options: RestoreOptions, work: (directory: string, transaction: RestoreTransaction) => Promise<T>): Promise<T> {
  options.signal?.throwIfAborted()
  const transaction = await beginWorldRestoreTransaction(options.staging)
  // Failed, cancelled and completed transactions remain as evidence. Never recursively
  // delete a path after an external process may have replaced or edited it.
  return work(transaction.payload, transaction)
}

/** Restores a completed directory backup (`backupDirectory/world` + `manifest.json`) as a new world. */
export async function restoreWorldFromBackup(backupDirectory: string, options: RestoreOptions): Promise<WorldRestoreResult> {
  const manifest = parseBackupManifest(await fs.readFile(path.join(backupDirectory, 'manifest.json')))
  const preferred = options.folderName ?? manifest.worldFolderName
  if (!safeWorldFolderName(preferred)) fail('世界名称不能包含特殊字符')
  return withStaging(options, async (staging, transaction) => {
    const entries: RestoreEntry[] = []
    const progress: WorldRestoreProgress = { phase: 'copy', filesDone: 0, filesTotal: manifest.fileCount, bytesDone: 0, bytesTotal: manifest.totalBytes }
    options.onProgress?.({ ...progress })
    for (const entry of manifest.entries) {
      options.signal?.throwIfAborted()
      const target = path.join(staging, ...entry.path.split('/'))
      if (entry.type === 'directory') { await fs.mkdir(target, { recursive: true }); entries.push({ type: 'directory', path: entry.path }); continue }
      await fs.mkdir(path.dirname(target), { recursive: true })
      const source = path.join(backupDirectory, 'world', ...entry.path.split('/'))
      const handle = await fs.open(source, readFlags)
      const hash = createHash('sha256')
      try {
        const chunks = (async function* () {
          for (let position = 0; ;) {
            options.signal?.throwIfAborted()
            const buffer = Buffer.allocUnsafe(RESTORE_LIMITS.chunkBytes)
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
            if (!bytesRead) return
            position += bytesRead; progress.bytesDone += bytesRead
            yield buffer.subarray(0, bytesRead)
          }
        })()
        const written = await writeStream(target, chunks, hash)
        if (written !== entry.sizeBytes || hash.digest('hex') !== entry.sha256) fail(`备份文件 ${entry.path} 与清单不一致，未恢复`)
        entries.push({ type: 'file', path: entry.path, size: entry.sizeBytes, sha256: entry.sha256 })
      } finally { await handle.close() }
      progress.filesDone++
      options.onProgress?.({ ...progress })
    }
    options.onProgress?.({ ...progress, phase: 'commit' })
    const folderName = await publishWorldRestore(transaction, options.saves, preferred, entries, options.signal)
    return { folderName, fileCount: manifest.fileCount, directoryCount: manifest.directoryCount, totalBytes: manifest.totalBytes, source: 'backup' as const }
  })
}

/** Imports a world from a Lua ZIP export or any map/world ZIP as a new world in `saves`. */
export async function restoreWorldFromZip(file: string, options: RestoreOptions): Promise<WorldRestoreResult> {
  const handle = await fs.open(file, readFlags)
  try {
    const info = await handle.stat()
    if (!info.isFile()) fail('请选择一个 ZIP 文件')
    options.onProgress?.({ phase: 'scan', filesDone: 0, bytesDone: 0 })
    const plan = await planZip(handle, info.size, path.basename(file), options.signal)
    const preferred = options.folderName ?? plan.suggestedName
    if (!safeWorldFolderName(preferred)) fail('世界名称不能包含特殊字符')
    const expected = plan.manifest ? new Map(plan.manifest.entries.flatMap(entry => entry.type === 'file' ? [[entry.path, entry.sha256] as const] : [])) : undefined
    return await withStaging(options, async (staging, transaction) => {
      const entries: RestoreEntry[] = plan.directories.map(name => ({ type: 'directory', path: name }))
      const progress: WorldRestoreProgress = { phase: 'copy', filesDone: 0, filesTotal: plan.files.length, bytesDone: 0, bytesTotal: plan.totalBytes }
      for (const directory of plan.directories) await fs.mkdir(path.join(staging, ...directory.split('/')), { recursive: true })
      for (const entry of plan.files) {
        options.signal?.throwIfAborted()
        const target = path.join(staging, ...entry.name.split('/'))
        await fs.mkdir(path.dirname(target), { recursive: true })
        const hash = createHash('sha256')
        const chunks = (async function* () { for await (const chunk of entryData(handle, entry, info.size, options.signal)) { progress.bytesDone += chunk.length; yield chunk } })()
        const size = await writeStream(target, chunks, hash), sha256 = hash.digest('hex')
        if (expected && expected.get(entry.name) !== sha256) fail(`${entry.name} 与备份清单的 SHA-256 不一致`)
        entries.push({ type: 'file', path: entry.name, size, sha256 })
        progress.filesDone++
        options.onProgress?.({ ...progress })
      }
      options.onProgress?.({ ...progress, phase: 'commit' })
      const folderName = await publishWorldRestore(transaction, options.saves, preferred, entries, options.signal)
      return { folderName, fileCount: plan.files.length, directoryCount: plan.directories.length, totalBytes: plan.totalBytes, source: plan.format }
    })
  } finally { await handle.close() }
}
