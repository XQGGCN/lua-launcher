import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { BACKUP_LIMITS, BACKUP_UUID, backupIdentifier, backupSafeName, parseBackupManifest, parseBackupReceipt,
  type BackupEntry, type BackupManifest } from './world-backup-manifest'
import { worldBackupDirectory } from './world-backup'
import type { WorldZipList, WorldZipProgress, WorldZipResult, WorldZipSummary } from './world-zip-types'

/*
 * Lua world ZIP export (format "LuaWorldZip" schema 1).
 *
 *   lua-backup/                 directory
 *   lua-backup/format.json      small strict description of the archive
 *   lua-backup/manifest.json    exact bytes of the completed directory backup manifest
 *   world/                      the world folder, exactly the manifest tree
 *
 * The archive is written by a small streaming ZIP/ZIP64 writer (no whole-file buffering),
 * then read back by an independent strict reader that inflates every entry and checks
 * CRC-32, byte count and SHA-256 against both the central directory and the manifest.
 * Only a fully verified archive is published (hard link, never overwriting).
 */

export type WorldZipErrorCode = 'INVALID_INPUT' | 'BUSY' | 'BACKUP_INVALID' | 'BACKUP_CHANGED' |
  'ARCHIVE_INVALID' | 'LIMIT_EXCEEDED' | 'INSUFFICIENT_SPACE' | 'IO_ERROR'
const messages: Record<WorldZipErrorCode, string> = {
  INVALID_INPUT: 'ZIP 导出参数无效',
  BUSY: '已有 ZIP 导出正在进行，请稍后再试',
  BACKUP_INVALID: '所选备份不完整或记录无效，无法导出',
  BACKUP_CHANGED: '备份文件与完成时的校验记录不一致，未生成 ZIP',
  ARCHIVE_INVALID: 'ZIP 回读校验失败，未发布此文件',
  LIMIT_EXCEEDED: '备份超出 ZIP 导出的大小或数量上限',
  INSUFFICIENT_SPACE: '磁盘可用空间不足，无法导出 ZIP',
  IO_ERROR: 'ZIP 导出文件操作失败',
}
export class WorldZipError extends Error {
  constructor(public readonly code: WorldZipErrorCode, detail?: string) {
    super(detail ? `${messages[code]}：${detail}` : messages[code]); this.name = 'WorldZipError'
  }
}
const fail = (code: WorldZipErrorCode, detail?: string): never => { throw new WorldZipError(code, detail) }

export const ZIP_LIMITS = Object.freeze({
  entries: BACKUP_LIMITS.entries + 4,
  centralDirectoryBytes: 160 * 1024 ** 2,
  archiveBytes: BACKUP_LIMITS.totalBytes + 16 * 1024 ** 3,
  chunkBytes: 1024 ** 2,
  controlBytes: 64 * 1024,
  exports: 500,
})

const UINT32_MAX = 0xffffffff
const ZIP64_THRESHOLD = 0xf0000000
const readFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)

// ---------------------------------------------------------------- CRC-32
let crcTable: Uint32Array | undefined
function softwareCrc32(data: Uint8Array, previous: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = (previous ^ UINT32_MAX) >>> 0
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ UINT32_MAX) >>> 0
}
const nativeCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number }).crc32
export function crc32(data: Uint8Array, previous = 0): number {
  return nativeCrc32 ? nativeCrc32(data, previous) >>> 0 : softwareCrc32(data, previous)
}
export const crc32Software = softwareCrc32

// ---------------------------------------------------------------- DOS time
function dosDateTime(date: Date): { time: number; date: number } {
  let year = date.getFullYear()
  if (Number.isNaN(year) || year < 1980) return { time: 0, date: (0 << 9) | (1 << 5) | 1 }
  if (year > 2107) year = 2107
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}
function mtimeFromNs(value: string): Date {
  try { return new Date(Number(BigInt(value) / 1_000_000n)) } catch { return new Date(0) }
}

// ---------------------------------------------------------------- writer
interface CentralRecord {
  name: Buffer; directory: boolean; method: 0 | 8; flags: number; crc: number
  compressed: number; size: number; offset: number; time: number; date: number; zip64: boolean
}
export interface EntryDigest { crc: number; size: number; sha256: string }

export class ZipWriter {
  offset = 0
  readonly records: CentralRecord[] = []
  readonly #hash = createHash('sha256')
  constructor(private readonly handle: fs.FileHandle, private readonly forceZip64 = false,
    private readonly signal?: AbortSignal) {}

  get sha256(): string { return this.#hash.copy().digest('hex') }

  async #write(buffer: Uint8Array): Promise<void> {
    let done = 0
    while (done < buffer.length) {
      const { bytesWritten } = await this.handle.write(buffer, done, buffer.length - done, null)
      if (bytesWritten <= 0) fail('IO_ERROR')
      done += bytesWritten
    }
    this.#hash.update(buffer)
    this.offset += buffer.length
    if (this.offset > ZIP_LIMITS.archiveBytes) fail('LIMIT_EXCEEDED')
  }

  #localHeader(name: Buffer, flags: number, method: number, crc: number, compressed: number, size: number,
    stamp: { time: number; date: number }, zip64: boolean): Buffer {
    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0)
    if (zip64) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2) } // sizes follow in the data descriptor
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(zip64 ? 45 : 20, 4)
    header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(stamp.time, 10)
    header.writeUInt16LE(stamp.date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(zip64 ? UINT32_MAX : compressed, 18)
    header.writeUInt32LE(zip64 ? UINT32_MAX : size, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(extra.length, 28)
    return Buffer.concat([header, name, extra])
  }

  async addDirectory(name: string, modified: Date): Promise<void> {
    const encoded = Buffer.from(name.endsWith('/') ? name : `${name}/`, 'utf8')
    const stamp = dosDateTime(modified), offset = this.offset
    await this.#write(this.#localHeader(encoded, 0x0800, 0, 0, 0, 0, stamp, false))
    this.records.push({ name: encoded, directory: true, method: 0, flags: 0x0800, crc: 0, compressed: 0, size: 0,
      offset, ...stamp, zip64: this.forceZip64 })
  }

  async addBuffer(name: string, data: Buffer, modified: Date): Promise<EntryDigest> {
    return this.addStream(name, data.length, modified, (async function* () { if (data.length) yield data })())
  }

  /** Streams one file. `size` is the expected uncompressed size; any difference fails. */
  async addStream(name: string, size: number, modified: Date, source: AsyncIterable<Buffer>): Promise<EntryDigest> {
    const encoded = Buffer.from(name, 'utf8'), stamp = dosDateTime(modified), offset = this.offset
    const hash = createHash('sha256')
    let crc = 0, seen = 0
    const observe = (chunk: Buffer) => {
      seen += chunk.length
      if (seen > size) fail('BACKUP_CHANGED', '文件大小与清单不符')
      crc = crc32(chunk, crc); hash.update(chunk)
    }
    if (size === 0) {
      for await (const chunk of source) observe(chunk)
      await this.#write(this.#localHeader(encoded, 0x0800, 0, 0, 0, 0, stamp, false))
      this.records.push({ name: encoded, directory: false, method: 0, flags: 0x0800, crc: 0, compressed: 0, size: 0,
        offset, ...stamp, zip64: this.forceZip64 })
      return { crc: 0, size: 0, sha256: hash.digest('hex') }
    }
    const zip64 = this.forceZip64 || size >= ZIP64_THRESHOLD
    const flags = 0x0808
    await this.#write(this.#localHeader(encoded, flags, 8, 0, 0, 0, stamp, zip64))
    const start = this.offset
    const writer = this
    const signal = this.signal
    await pipeline(
      Readable.from((async function* () {
        for await (const chunk of source) {
          signal?.throwIfAborted()
          observe(chunk)
          yield chunk
        }
      })(), { objectMode: false }),
      zlib.createDeflateRaw({ level: 6, chunkSize: 256 * 1024 }),
      new Writable({
        write(chunk: Buffer, _encoding, callback) { writer.#write(chunk).then(() => callback(), callback) },
      }),
    )
    if (seen !== size) fail('BACKUP_CHANGED', '文件大小与清单不符')
    const compressed = this.offset - start
    const descriptor = Buffer.alloc(zip64 ? 24 : 16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(crc, 4)
    if (zip64) { descriptor.writeBigUInt64LE(BigInt(compressed), 8); descriptor.writeBigUInt64LE(BigInt(size), 16) }
    else {
      if (compressed > UINT32_MAX) fail('LIMIT_EXCEEDED')
      descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(size, 12)
    }
    await this.#write(descriptor)
    this.records.push({ name: encoded, directory: false, method: 8, flags, crc, compressed, size, offset, ...stamp, zip64 })
    return { crc, size, sha256: hash.digest('hex') }
  }

  async finish(): Promise<void> {
    if (this.records.length > ZIP_LIMITS.entries) fail('LIMIT_EXCEEDED')
    const cdOffset = this.offset
    for (const record of this.records) {
      const bigSizes = record.zip64 || record.size > UINT32_MAX || record.compressed > UINT32_MAX
      const bigOffset = this.forceZip64 || record.offset >= UINT32_MAX
      const parts: Buffer[] = []
      if (bigSizes) {
        const sizes = Buffer.alloc(16)
        sizes.writeBigUInt64LE(BigInt(record.size), 0); sizes.writeBigUInt64LE(BigInt(record.compressed), 8)
        parts.push(sizes)
      }
      if (bigOffset) { const offset = Buffer.alloc(8); offset.writeBigUInt64LE(BigInt(record.offset)); parts.push(offset) }
      let extra = Buffer.alloc(0)
      if (parts.length) {
        const body = Buffer.concat(parts), head = Buffer.alloc(4)
        head.writeUInt16LE(0x0001, 0); head.writeUInt16LE(body.length, 2)
        extra = Buffer.concat([head, body])
      }
      const header = Buffer.alloc(46)
      header.writeUInt32LE(0x02014b50, 0)
      header.writeUInt16LE((3 << 8) | 45, 4)
      header.writeUInt16LE(parts.length ? 45 : 20, 6)
      header.writeUInt16LE(record.flags, 8)
      header.writeUInt16LE(record.method, 10)
      header.writeUInt16LE(record.time, 12)
      header.writeUInt16LE(record.date, 14)
      header.writeUInt32LE(record.crc, 16)
      header.writeUInt32LE(bigSizes ? UINT32_MAX : record.compressed, 20)
      header.writeUInt32LE(bigSizes ? UINT32_MAX : record.size, 24)
      header.writeUInt16LE(record.name.length, 28)
      header.writeUInt16LE(extra.length, 30)
      header.writeUInt16LE(0, 32)
      header.writeUInt16LE(0, 34)
      header.writeUInt16LE(0, 36)
      header.writeUInt32LE(record.directory ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38)
      header.writeUInt32LE(bigOffset ? UINT32_MAX : record.offset, 42)
      await this.#write(Buffer.concat([header, record.name, extra]))
    }
    const cdSize = this.offset - cdOffset, count = this.records.length
    const zip64 = this.forceZip64 || count >= 0xffff || cdSize >= UINT32_MAX || cdOffset >= UINT32_MAX
    if (zip64) {
      const zip64EndOffset = this.offset
      const record = Buffer.alloc(56)
      record.writeUInt32LE(0x06064b50, 0)
      record.writeBigUInt64LE(44n, 4)
      record.writeUInt16LE((3 << 8) | 45, 12)
      record.writeUInt16LE(45, 14)
      record.writeUInt32LE(0, 16)
      record.writeUInt32LE(0, 20)
      record.writeBigUInt64LE(BigInt(count), 24)
      record.writeBigUInt64LE(BigInt(count), 32)
      record.writeBigUInt64LE(BigInt(cdSize), 40)
      record.writeBigUInt64LE(BigInt(cdOffset), 48)
      const locator = Buffer.alloc(20)
      locator.writeUInt32LE(0x07064b50, 0)
      locator.writeUInt32LE(0, 4)
      locator.writeBigUInt64LE(BigInt(zip64EndOffset), 8)
      locator.writeUInt32LE(1, 16)
      await this.#write(Buffer.concat([record, locator]))
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(zip64 ? 0xffff : count, 8)
    end.writeUInt16LE(zip64 ? 0xffff : count, 10)
    end.writeUInt32LE(zip64 ? UINT32_MAX : cdSize, 12)
    end.writeUInt32LE(zip64 ? UINT32_MAX : cdOffset, 16)
    end.writeUInt16LE(0, 20)
    await this.#write(end)
  }
}

// ---------------------------------------------------------------- strict reader
export interface ZipEntryRead { name: string; directory: boolean; crc: number; size: number; sha256: string }

async function readExactly(handle: fs.FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done)
    if (bytesRead <= 0) fail('ARCHIVE_INVALID', '文件提前结束')
    done += bytesRead
  }
  return buffer
}

interface CentralEntry { name: string; rawName: Buffer; flags: number; method: number; crc: number; compressed: number; size: number; offset: number }

function parseZip64Extra(extra: Buffer, want: { size: boolean; compressed: boolean; offset: boolean }) {
  let position = 0
  while (position + 4 <= extra.length) {
    const id = extra.readUInt16LE(position), length = extra.readUInt16LE(position + 2)
    const body = position + 4
    if (body + length > extra.length) fail('ARCHIVE_INVALID', '扩展字段越界')
    if (id === 0x0001) {
      let cursor = body
      const take = () => {
        if (cursor + 8 > body + length) fail('ARCHIVE_INVALID', 'ZIP64 字段缺失')
        const value = extra.readBigUInt64LE(cursor); cursor += 8
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('LIMIT_EXCEEDED')
        return Number(value)
      }
      return { size: want.size ? take() : undefined, compressed: want.compressed ? take() : undefined, offset: want.offset ? take() : undefined }
    }
    position = body + length
  }
  if (want.size || want.compressed || want.offset) fail('ARCHIVE_INVALID', 'ZIP64 字段缺失')
  return {}
}

/**
 * Reads a ZIP produced by this module and verifies every entry by inflating it.
 * The layout must be strictly sequential: local entries in central-directory order,
 * no gaps, no overlap, no comments, no encryption. Returns per-entry digests.
 */
export async function readZipStrict(file: string, options: { signal?: AbortSignal; onBytes?: (bytes: number) => void } = {}): Promise<{ entries: ZipEntryRead[]; archiveBytes: number; archiveSha256: string }> {
  const handle = await fs.open(file, readFlags)
  try {
    const info = await handle.stat()
    if (!info.isFile()) fail('ARCHIVE_INVALID', '不是普通文件')
    const size = info.size
    if (size < 22 || size > ZIP_LIMITS.archiveBytes) fail('ARCHIVE_INVALID', '文件大小无效')
    const end = await readExactly(handle, 22, size - 22)
    if (end.readUInt32LE(0) !== 0x06054b50 || end.readUInt16LE(20) !== 0) fail('ARCHIVE_INVALID', '缺少结束记录')
    if (end.readUInt16LE(4) !== 0 || end.readUInt16LE(6) !== 0) fail('ARCHIVE_INVALID', '不支持分卷')
    let count = end.readUInt16LE(10), cdSize = end.readUInt32LE(12), cdOffset = end.readUInt32LE(16)
    let cdLimit = size - 22
    if (count === 0xffff || cdSize === UINT32_MAX || cdOffset === UINT32_MAX) {
      if (size < 22 + 20 + 56) fail('ARCHIVE_INVALID', 'ZIP64 结构缺失')
      const locator = await readExactly(handle, 20, size - 42)
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(16) !== 1) fail('ARCHIVE_INVALID', 'ZIP64 定位记录无效')
      const recordOffset = Number(locator.readBigUInt64LE(8))
      if (recordOffset !== size - 42 - 56) fail('ARCHIVE_INVALID', 'ZIP64 结束记录位置无效')
      const record = await readExactly(handle, 56, recordOffset)
      if (record.readUInt32LE(0) !== 0x06064b50 || record.readBigUInt64LE(4) !== 44n) fail('ARCHIVE_INVALID', 'ZIP64 结束记录无效')
      const total = record.readBigUInt64LE(32), cdBytes = record.readBigUInt64LE(40), cdStart = record.readBigUInt64LE(48)
      if (record.readBigUInt64LE(24) !== total || total > BigInt(ZIP_LIMITS.entries) ||
          cdBytes > BigInt(ZIP_LIMITS.centralDirectoryBytes) || cdStart > BigInt(size)) fail('LIMIT_EXCEEDED')
      count = Number(total); cdSize = Number(cdBytes); cdOffset = Number(cdStart); cdLimit = recordOffset
    }
    if (count > ZIP_LIMITS.entries || cdSize > ZIP_LIMITS.centralDirectoryBytes) fail('LIMIT_EXCEEDED')
    if (cdOffset + cdSize !== cdLimit) fail('ARCHIVE_INVALID', '中央目录位置无效')
    const directory = await readExactly(handle, cdSize, cdOffset)
    const entries: CentralEntry[] = []
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let cursor = 0
    for (let i = 0; i < count; i++) {
      options.signal?.throwIfAborted()
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) fail('ARCHIVE_INVALID', '中央目录记录无效')
      const flags = directory.readUInt16LE(cursor + 8), method = directory.readUInt16LE(cursor + 10)
      const crc = directory.readUInt32LE(cursor + 16)
      let compressed = directory.readUInt32LE(cursor + 20), entrySize = directory.readUInt32LE(cursor + 24)
      const nameLength = directory.readUInt16LE(cursor + 28), extraLength = directory.readUInt16LE(cursor + 30)
      const commentLength = directory.readUInt16LE(cursor + 32)
      let offset = directory.readUInt32LE(cursor + 42)
      if (directory.readUInt16LE(cursor + 34) !== 0 || commentLength !== 0) fail('ARCHIVE_INVALID', '不支持的条目字段')
      if (flags & 0x0001 || flags & 0x0040) fail('ARCHIVE_INVALID', '不支持加密条目')
      if (method !== 0 && method !== 8) fail('ARCHIVE_INVALID', '不支持的压缩方式')
      const start = cursor + 46
      if (start + nameLength + extraLength > directory.length) fail('ARCHIVE_INVALID', '中央目录越界')
      const rawName = directory.subarray(start, start + nameLength)
      let name: string
      try { name = decoder.decode(rawName) } catch { return fail('ARCHIVE_INVALID', '条目名称不是 UTF-8') }
      const extra = directory.subarray(start + nameLength, start + nameLength + extraLength)
      const want = { size: entrySize === UINT32_MAX, compressed: compressed === UINT32_MAX, offset: offset === UINT32_MAX }
      if (want.size || want.compressed || want.offset) {
        const values = parseZip64Extra(extra, want)
        if (values.size !== undefined) entrySize = values.size
        if (values.compressed !== undefined) compressed = values.compressed
        if (values.offset !== undefined) offset = values.offset
      }
      entries.push({ name, rawName: Buffer.from(rawName), flags, method, crc, compressed, size: entrySize, offset })
      cursor = start + nameLength + extraLength
    }
    if (cursor !== directory.length) fail('ARCHIVE_INVALID', '中央目录长度不一致')

    const result: ZipEntryRead[] = []
    const names = new Set<string>()
    let expectedOffset = 0
    for (const entry of entries) {
      options.signal?.throwIfAborted()
      if (names.has(entry.name)) fail('ARCHIVE_INVALID', '条目名称重复')
      names.add(entry.name)
      if (entry.offset !== expectedOffset) fail('ARCHIVE_INVALID', '条目布局不连续')
      const local = await readExactly(handle, 30, entry.offset)
      if (local.readUInt32LE(0) !== 0x04034b50) fail('ARCHIVE_INVALID', '本地文件头无效')
      if (local.readUInt16LE(6) !== entry.flags || local.readUInt16LE(8) !== entry.method) fail('ARCHIVE_INVALID', '本地文件头与中央目录不一致')
      const nameLength = local.readUInt16LE(26), extraLength = local.readUInt16LE(28)
      const localName = await readExactly(handle, nameLength, entry.offset + 30)
      if (!localName.equals(entry.rawName)) fail('ARCHIVE_INVALID', '本地文件名与中央目录不一致')
      const dataStart = entry.offset + 30 + nameLength + extraLength
      const hasDescriptor = Boolean(entry.flags & 0x0008)
      const zip64Descriptor = hasDescriptor && local.readUInt32LE(18) === UINT32_MAX
      if (!hasDescriptor && (local.readUInt32LE(14) !== entry.crc || local.readUInt32LE(18) !== entry.compressed || local.readUInt32LE(22) !== entry.size)) {
        fail('ARCHIVE_INVALID', '本地文件头校验值不一致')
      }
      const dataEnd = dataStart + entry.compressed
      if (dataEnd > cdOffset) fail('ARCHIVE_INVALID', '条目数据越界')
      const directoryEntry = entry.name.endsWith('/')
      if (directoryEntry && (entry.size !== 0 || entry.compressed !== 0)) fail('ARCHIVE_INVALID', '目录条目含数据')
      const hash = createHash('sha256')
      let crc = 0, produced = 0
      const consume = (chunk: Buffer) => {
        produced += chunk.length
        if (produced > entry.size) fail('ARCHIVE_INVALID', '解压大小超出记录')
        crc = crc32(chunk, crc); hash.update(chunk)
      }
      if (entry.compressed > 0) {
        const source = Readable.from((async function* () {
          let position = dataStart
          while (position < dataEnd) {
            options.signal?.throwIfAborted()
            const length = Math.min(ZIP_LIMITS.chunkBytes, dataEnd - position)
            const chunk = await readExactly(handle, length, position)
            position += length
            options.onBytes?.(length)
            yield chunk
          }
        })())
        const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { try { consume(chunk); callback() } catch (error) { callback(error as Error) } } })
        try {
          if (entry.method === 8) await pipeline(source, zlib.createInflateRaw({ chunkSize: 256 * 1024 }), sink)
          else await pipeline(source, sink)
        } catch (error) {
          if (options.signal?.aborted) throw error
          if (error instanceof WorldZipError) throw error
          fail('ARCHIVE_INVALID', '压缩数据损坏')
        }
      }
      if (produced !== entry.size || crc !== entry.crc) fail('ARCHIVE_INVALID', `${entry.name} 的 CRC 或大小不一致`)
      let next = dataEnd
      if (hasDescriptor) {
        const descriptor = await readExactly(handle, zip64Descriptor ? 24 : 16, dataEnd)
        if (descriptor.readUInt32LE(0) !== 0x08074b50 || descriptor.readUInt32LE(4) !== entry.crc) fail('ARCHIVE_INVALID', '数据描述符无效')
        const compressed = zip64Descriptor ? Number(descriptor.readBigUInt64LE(8)) : descriptor.readUInt32LE(8)
        const uncompressed = zip64Descriptor ? Number(descriptor.readBigUInt64LE(16)) : descriptor.readUInt32LE(12)
        if (compressed !== entry.compressed || uncompressed !== entry.size) fail('ARCHIVE_INVALID', '数据描述符大小不一致')
        next += descriptor.length
      }
      expectedOffset = next
      result.push({ name: entry.name, directory: directoryEntry, crc, size: produced, sha256: hash.digest('hex') })
    }
    if (expectedOffset !== cdOffset) fail('ARCHIVE_INVALID', '条目数据与中央目录之间有未知内容')
    const after = await handle.stat()
    if (after.size !== size || after.mtimeMs !== info.mtimeMs) fail('ARCHIVE_INVALID', '校验期间文件发生变化')
    // Whole-file identity hash, read sequentially.
    const whole = createHash('sha256')
    for (let position = 0; position < size;) {
      options.signal?.throwIfAborted()
      const length = Math.min(ZIP_LIMITS.chunkBytes, size - position)
      whole.update(await readExactly(handle, length, position))
      position += length
    }
    return { entries: result, archiveBytes: size, archiveSha256: whole.digest('hex') }
  } finally { await handle.close() }
}

// ---------------------------------------------------------------- export / list
interface ExportReceipt {
  schema: 1; exportId: string; instanceId: string; backupId: string; worldFolderName: string; fileName: string
  archiveBytes: number; archiveSha256: string; manifestSha256: string
  fileCount: number; directoryCount: number; totalBytes: number; completedAt: string
}
const RECEIPT_KEYS = ['schema', 'exportId', 'instanceId', 'backupId', 'worldFolderName', 'fileName', 'archiveBytes',
  'archiveSha256', 'manifestSha256', 'fileCount', 'directoryCount', 'totalBytes', 'completedAt']
const SHA = /^[0-9a-f]{64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const safeCount = (value: unknown, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max

export function parseExportReceipt(bytes: Uint8Array): ExportReceipt {
  if (bytes.byteLength > ZIP_LIMITS.controlBytes) fail('ARCHIVE_INVALID', '记录过大')
  let value: Record<string, unknown>
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return fail('ARCHIVE_INVALID', '记录无法解析') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== RECEIPT_KEYS.length ||
      !RECEIPT_KEYS.every(key => Object.prototype.hasOwnProperty.call(value, key))) fail('ARCHIVE_INVALID', '记录字段无效')
  if (value.schema !== 1 || typeof value.exportId !== 'string' || !BACKUP_UUID.test(value.exportId) ||
      !backupIdentifier(value.instanceId) || typeof value.backupId !== 'string' || !BACKUP_UUID.test(value.backupId) ||
      !backupSafeName(value.worldFolderName) || !backupSafeName(value.fileName) || !String(value.fileName).endsWith('.zip') ||
      !safeCount(value.archiveBytes, ZIP_LIMITS.archiveBytes) || typeof value.archiveSha256 !== 'string' || !SHA.test(value.archiveSha256) ||
      typeof value.manifestSha256 !== 'string' || !SHA.test(value.manifestSha256) ||
      !safeCount(value.fileCount, BACKUP_LIMITS.entries) || !safeCount(value.directoryCount, BACKUP_LIMITS.entries) ||
      !safeCount(value.totalBytes, BACKUP_LIMITS.totalBytes) || typeof value.completedAt !== 'string' || !ISO.test(value.completedAt)) {
    fail('ARCHIVE_INVALID', '记录内容无效')
  }
  return value as unknown as ExportReceipt
}

function summary(receipt: ExportReceipt): WorldZipSummary {
  return {
    exportId: receipt.exportId, instanceId: receipt.instanceId, backupId: receipt.backupId, worldFolderName: receipt.worldFolderName,
    fileName: receipt.fileName, format: 'lua-world-zip', schema: 1, archiveBytes: receipt.archiveBytes, archiveSha256: receipt.archiveSha256,
    fileCount: receipt.fileCount, directoryCount: receipt.directoryCount, totalBytes: receipt.totalBytes,
    completedAt: receipt.completedAt, verifiedAtCompletion: true,
  }
}

function absolute(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 32768 || /[\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_INPUT')
  return path.resolve(value)
}

async function readSmall(file: string, max: number): Promise<Buffer> {
  const handle = await fs.open(file, readFlags)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > max) fail('BACKUP_INVALID')
    return await readExactly(handle, info.size, 0)
  } finally { await handle.close() }
}

async function* readFileChunks(file: string, expectedSize: number, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const handle = await fs.open(file, readFlags)
  try {
    const info = await handle.stat()
    if (!info.isFile()) fail('BACKUP_CHANGED', '备份条目不是普通文件')
    if (info.size !== expectedSize) fail('BACKUP_CHANGED', '文件大小与清单不符')
    let position = 0
    while (position < expectedSize) {
      signal?.throwIfAborted()
      const buffer = Buffer.allocUnsafe(Math.min(ZIP_LIMITS.chunkBytes, expectedSize - position))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead <= 0) fail('BACKUP_CHANGED', '文件提前结束')
      position += bytesRead
      yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead)
    }
  } finally { await handle.close() }
}

function exportFileName(worldFolderName: string, when: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  let base = worldFolderName
  while (Buffer.byteLength(`${base}-${stamp}.zip`) > 200) base = base.slice(0, -1)
  const name = `${base.replace(/[ .]+$/u, '') || 'world'}-${stamp}.zip`
  return backupSafeName(name) ? name : `world-${stamp}.zip`
}

export interface WorldZipExportOptions {
  exportRoot: string
  operationId: string
  signal?: AbortSignal
  onProgress?: (progress: WorldZipProgress) => void
  /** Test hook: forces ZIP64 records on small fixtures. */
  forceZip64?: boolean
  now?: () => Date
}

let activeExport = false

export async function exportWorldBackupZip(backupRoot: string, instanceId: string, backupId: string, options: WorldZipExportOptions): Promise<WorldZipResult> {
  if (!backupIdentifier(instanceId) || typeof backupId !== 'string' || !BACKUP_UUID.test(backupId) || !backupIdentifier(options.operationId)) fail('INVALID_INPUT')
  const exportRoot = absolute(options.exportRoot)
  if (activeExport) fail('BUSY')
  activeExport = true
  const signal = options.signal
  const now = options.now ?? (() => new Date())
  let lastProgress = 0
  const report = (progress: WorldZipProgress, force = false) => {
    const time = Date.now()
    if (!force && time - lastProgress < 120) return
    lastProgress = time
    try { options.onProgress?.(structuredClone(progress)) } catch { /* Observers cannot affect the export. */ }
  }
  let container = '', published = false
  try {
    report({ phase: 'validate-backup', filesDone: 0, bytesDone: 0 }, true)
    let backupDirectory: string
    try { backupDirectory = await worldBackupDirectory(absolute(backupRoot), instanceId, backupId) }
    catch { return fail('BACKUP_INVALID') }
    signal?.throwIfAborted()
    const manifestBytes = await readSmall(path.join(backupDirectory, 'manifest.json'), BACKUP_LIMITS.manifestBytes)
    const receipt = parseBackupReceipt(await readSmall(path.join(backupDirectory, 'COMPLETE.json'), BACKUP_LIMITS.controlBytes))
    const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
    let manifest: BackupManifest
    try { manifest = parseBackupManifest(manifestBytes) } catch { return fail('BACKUP_INVALID') }
    if (receipt.backupId !== backupId || receipt.manifestSha256 !== manifestSha256 || manifest.backupId !== backupId ||
        manifest.instanceId !== instanceId) fail('BACKUP_INVALID')

    await fs.mkdir(path.join(exportRoot, instanceId), { recursive: true })
    try {
      const space = await fs.statfs(path.join(exportRoot, instanceId))
      const needed = manifest.totalBytes * 1.01 + manifest.entries.length * 512 + 32 * 1024 ** 2
      if (Number(space.bavail) * Number(space.bsize) < needed) fail('INSUFFICIENT_SPACE')
    } catch (error) { if (error instanceof WorldZipError) throw error /* statfs unsupported: continue, writes still fail safely. */ }

    const exportId = randomUUID()
    container = path.join(exportRoot, instanceId, exportId)
    await fs.mkdir(container)
    const createdAt = now()
    await fs.writeFile(path.join(container, 'intent.json'), JSON.stringify({ schema: 1, exportId, instanceId, backupId,
      operationId: options.operationId, createdAt: createdAt.toISOString() }), { flag: 'wx' })

    const partial = path.join(container, 'archive.partial')
    const handle = await fs.open(partial, 'wx')
    const files = manifest.entries.filter((entry): entry is Extract<BackupEntry, { type: 'file' }> => entry.type === 'file')
    const progress: WorldZipProgress = { phase: 'export', filesDone: 0, filesTotal: files.length, bytesDone: 0, bytesTotal: manifest.totalBytes }
    const format = Buffer.from(JSON.stringify({ magic: 'LuaWorldZip', schema: 1, payloadRoot: 'world', manifestSha256,
      sourceBackupId: backupId, worldFolderName: manifest.worldFolderName, exportedAt: createdAt.toISOString(),
      compression: 'deflate', hashAlgorithm: 'sha256' }, null, 2))
    try {
      const writer = new ZipWriter(handle, options.forceZip64, signal)
      await writer.addDirectory('lua-backup/', createdAt)
      await writer.addBuffer('lua-backup/format.json', format, createdAt)
      await writer.addBuffer('lua-backup/manifest.json', manifestBytes, createdAt)
      await writer.addDirectory('world/', createdAt)
      const worldRoot = path.join(backupDirectory, 'world')
      report(progress, true)
      for (const entry of manifest.entries) {
        signal?.throwIfAborted()
        const modified = mtimeFromNs(entry.sourceMtimeNs)
        if (entry.type === 'directory') { await writer.addDirectory(`world/${entry.path}/`, modified); continue }
        const chunks = readFileChunks(path.join(worldRoot, ...entry.path.split('/')), entry.sizeBytes, signal)
        const counted = (async function* () {
          for await (const chunk of chunks) { progress.bytesDone += chunk.length; report(progress); yield chunk }
        })()
        const digest = await writer.addStream(`world/${entry.path}`, entry.sizeBytes, modified, counted)
        if (digest.sha256 !== entry.sha256 || digest.size !== entry.sizeBytes) fail('BACKUP_CHANGED', entry.path)
        progress.filesDone++
        report(progress)
      }
      await writer.finish()
      await handle.sync()
    } finally { await handle.close() }

    // Independent read-back: inflate every entry and compare with the manifest.
    const verify: WorldZipProgress = { phase: 'verify-archive', filesDone: 0, filesTotal: manifest.entries.length + 4, bytesDone: 0 }
    report(verify, true)
    const read = await readZipStrict(partial, { signal, onBytes: bytes => { verify.bytesDone += bytes; report(verify) } })
    const expected = new Map<string, { directory: boolean; size: number; sha256?: string }>([
      ['lua-backup/', { directory: true, size: 0 }],
      ['lua-backup/format.json', { directory: false, size: format.length, sha256: createHash('sha256').update(format).digest('hex') }],
      ['lua-backup/manifest.json', { directory: false, size: manifestBytes.length, sha256: manifestSha256 }],
      ['world/', { directory: true, size: 0 }],
    ])
    for (const entry of manifest.entries) {
      expected.set(entry.type === 'directory' ? `world/${entry.path}/` : `world/${entry.path}`,
        entry.type === 'directory' ? { directory: true, size: 0 } : { directory: false, size: entry.sizeBytes, sha256: entry.sha256 })
    }
    if (read.entries.length !== expected.size) fail('ARCHIVE_INVALID', '条目数量不一致')
    for (const entry of read.entries) {
      const want = expected.get(entry.name)
      if (!want || want.directory !== entry.directory || want.size !== entry.size || (want.sha256 && want.sha256 !== entry.sha256)) {
        fail('ARCHIVE_INVALID', entry.name)
      }
      verify.filesDone++
    }
    report(verify, true)

    report({ phase: 'commit', filesDone: files.length, filesTotal: files.length, bytesDone: manifest.totalBytes, bytesTotal: manifest.totalBytes }, true)
    signal?.throwIfAborted()
    const completedAt = now()
    const fileName = exportFileName(manifest.worldFolderName, completedAt)
    const exportReceipt: ExportReceipt = {
      schema: 1, exportId, instanceId, backupId, worldFolderName: manifest.worldFolderName, fileName,
      archiveBytes: read.archiveBytes, archiveSha256: read.archiveSha256, manifestSha256,
      fileCount: manifest.fileCount, directoryCount: manifest.directoryCount, totalBytes: manifest.totalBytes,
      completedAt: completedAt.toISOString(),
    }
    const receiptHandle = await fs.open(path.join(container, 'verification.json'), 'wx')
    try { await receiptHandle.writeFile(JSON.stringify(exportReceipt, null, 2)); await receiptHandle.sync() }
    finally { await receiptHandle.close() }
    // Publication boundary: never overwrites (link fails with EEXIST).
    await fs.link(partial, path.join(container, fileName))
    published = true
    await fs.unlink(partial).catch(() => {})
    return { ...summary(exportReceipt), warnings: [] }
  } catch (error) {
    if (container && !published) {
      // Only files this operation created are removed; the source backup is never touched.
      for (const name of ['archive.partial', 'verification.json', 'intent.json']) await fs.unlink(path.join(container, name)).catch(() => {})
      await fs.rmdir(container).catch(() => {})
    }
    if (signal?.aborted) throw new DOMException('ZIP 导出已取消', 'AbortError')
    if (error instanceof WorldZipError) throw error
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOSPC') throw new WorldZipError('INSUFFICIENT_SPACE')
    throw new WorldZipError('IO_ERROR')
  } finally { activeExport = false }
}

async function completedExport(exportRoot: string, instanceId: string, exportId: string): Promise<{ receipt: ExportReceipt; file: string }> {
  const container = path.join(exportRoot, instanceId, exportId)
  const receipt = parseExportReceipt(await readSmall(path.join(container, 'verification.json'), ZIP_LIMITS.controlBytes))
  if (receipt.exportId !== exportId || receipt.instanceId !== instanceId) fail('ARCHIVE_INVALID')
  const file = path.join(container, receipt.fileName)
  const info = await fs.lstat(file)
  if (!info.isFile() || info.size !== receipt.archiveBytes) fail('ARCHIVE_INVALID')
  return { receipt, file }
}

/** Completion receipts only; does not rehash archives (an explicit re-verify does). */
export async function listWorldBackupZips(exportRoot: string, instanceId: string): Promise<WorldZipList> {
  const root = absolute(exportRoot)
  if (!backupIdentifier(instanceId)) fail('INVALID_INPUT')
  const result: WorldZipList = { items: [], incompleteCount: 0, warnings: [], truncated: false }
  let names: string[]
  try { names = await fs.readdir(path.join(root, instanceId)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw new WorldZipError('IO_ERROR') }
  for (const name of names.sort()) {
    if (!BACKUP_UUID.test(name)) continue
    if (result.items.length + result.incompleteCount >= ZIP_LIMITS.exports) { result.truncated = true; break }
    try { result.items.push(summary((await completedExport(root, instanceId, name)).receipt)) }
    catch { result.incompleteCount++ }
  }
  result.items.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.exportId.localeCompare(b.exportId))
  if (result.incompleteCount) result.warnings.push('有未完成或记录无效的导出目录，已保留未删除。')
  if (result.truncated) result.warnings.push('导出记录较多，只显示部分条目。')
  return result
}

/** Main-process-only path to a completed export archive. */
export async function worldBackupZipPath(exportRoot: string, instanceId: string, exportId: string): Promise<string> {
  const root = absolute(exportRoot)
  if (!backupIdentifier(instanceId) || typeof exportId !== 'string' || !BACKUP_UUID.test(exportId)) fail('INVALID_INPUT')
  return (await completedExport(root, instanceId, exportId)).file
}

/** Re-reads a completed export end to end and compares it with its receipt. */
export async function verifyWorldBackupZip(exportRoot: string, instanceId: string, exportId: string, signal?: AbortSignal): Promise<WorldZipSummary> {
  const root = absolute(exportRoot)
  if (!backupIdentifier(instanceId) || typeof exportId !== 'string' || !BACKUP_UUID.test(exportId)) fail('INVALID_INPUT')
  const { receipt, file } = await completedExport(root, instanceId, exportId)
  const read = await readZipStrict(file, { signal })
  if (read.archiveSha256 !== receipt.archiveSha256 || read.archiveBytes !== receipt.archiveBytes) fail('ARCHIVE_INVALID', '文件与导出记录不一致')
  const manifest = read.entries.find(entry => entry.name === 'lua-backup/manifest.json')
  if (!manifest || manifest.sha256 !== receipt.manifestSha256) fail('ARCHIVE_INVALID', '清单不一致')
  return summary(receipt)
}
