import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'
import { crc32 } from './world-zip'
import { parseModMetadata } from './mod-metadata'
import type { InstalledModSelection, ModJarDetails } from './mod-details-types'

export const MOD_JAR_LIMITS = Object.freeze({
  archiveBytes: 512 * 1024 ** 2, entries: 20000, centralDirectoryBytes: 16 * 1024 ** 2,
  metadataBytes: 256 * 1024, metadataTotalBytes: 1024 ** 2, pathBytes: 1024, pathDepth: 32,
  directoryEntries: 5000, prefixIndexBytes: 32 * 1024 ** 2, dtoBytes: 1024 ** 2, durationMs: 30000,
})
export class ModJarReadError extends Error {
  constructor(public readonly code: 'changed' | 'unsafe-path' | 'missing' | 'invalid' | 'unsupported' | 'limit', message: string) {
    super(message); this.name = 'ModJarReadError'
  }
}
export interface ModJarReadOptions { signal?: AbortSignal }
const fail = (code: ModJarReadError['code'], message: string): never => { throw new ModJarReadError(code, message) }
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code
const fold = (value: string) => value.normalize('NFC').toLowerCase()
const sameNode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
const sameFile = (a: BigIntStats, b: BigIntStats) => sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
const metadataNames = new Set(['fabric.mod.json', 'quilt.mod.json', 'quilt.mod.json5', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'META-INF/MANIFEST.MF'])
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
type Chain = Map<string, BigIntStats>
type Budget = { check(): void }
function budget(options: ModJarReadOptions): Budget {
  const end = performance.now() + MOD_JAR_LIMITS.durationMs
  return { check() { options.signal?.throwIfAborted(); if (performance.now() > end) fail('limit', '模组读取超过30秒，请选择较小文件后重试') } }
}
function safeName(value: unknown): value is string {
  return typeof value === 'string' && !!value && value !== '.' && value !== '..' && Buffer.byteLength(value) <= 255 &&
    !/[<>:"/\\|?*\p{Cc}\p{Cf}\ud800-\udfff\ufffd]/u.test(value) && !/[ .]$/.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value)
}
function absoluteFile(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 32768 || /[\u0000-\u001f\u007f]/u.test(value)) fail('unsafe-path', '模组来源需要有效的绝对文件路径')
  const result = path.resolve(value)
  if (result === path.parse(result).root) fail('unsafe-path', '不能读取文件系统根目录')
  return result
}
function safeEntry(value: string, directory: boolean): boolean {
  const parts = (directory ? value.slice(0, -1) : value).split('/')
  return Buffer.byteLength(value) <= MOD_JAR_LIMITS.pathBytes && parts.length <= MOD_JAR_LIMITS.pathDepth && parts.every(safeName)
}
async function chain(directory: string, b: Budget): Promise<Chain> {
  let current = path.parse(directory).root
  const result: Chain = new Map()
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, part); b.check()
    const info = await fs.lstat(current, { bigint: true }); b.check()
    if (info.isSymbolicLink()) {
      const systemAlias = process.platform === 'darwin' && current !== directory &&
        ((current === '/tmp' && await fs.realpath(current) === '/private/tmp') || (current === '/var' && await fs.realpath(current) === '/private/var'))
      if (!systemAlias) fail('unsafe-path', '模组目录或祖先包含链接，无法读取')
    } else if (!info.isDirectory()) fail('unsafe-path', '模组来源的祖先必须是普通目录')
    result.set(current, info)
  }
  return result
}
async function verifyChain(proof: Chain, b: Budget): Promise<void> {
  for (const [file, expected] of proof) {
    b.check()
    const current = await fs.lstat(file, { bigint: true }).catch(() => undefined)
    if (!current || !sameNode(expected, current)) fail('changed', '模组目录在读取期间发生变化，请刷新后重试')
  }
}
async function unique(directory: string, name: string, b: Budget): Promise<void> {
  const handle = await fs.opendir(directory)
  let count = 0, matches = 0, exact = false
  try {
    for await (const entry of handle) {
      b.check(); if (++count > MOD_JAR_LIMITS.directoryEntries) fail('limit', '模组目录条目超过读取上限')
      if (fold(entry.name) === fold(name)) { matches++; exact ||= entry.name === name }
    }
  } finally { await handle.close().catch(() => {}) }
  if (matches !== 1 || !exact) fail(matches ? 'unsafe-path' : 'missing', matches ? '模组名称存在大小写或Unicode冲突' : '所选模组已不存在')
}
async function exact(handle: fs.FileHandle, length: number, position: number, b: Budget): Promise<Buffer> {
  b.check(); const bytes = Buffer.alloc(length); let done = 0
  while (done < length) {
    b.check(); const result = await handle.read(bytes, done, length - done, position + done)
    if (!result.bytesRead) fail('changed', '模组文件在读取期间被截断')
    done += result.bytesRead
  }
  b.check(); return bytes
}
async function hash(handle: fs.FileHandle, size: number, b: Budget): Promise<string> {
  const digest = createHash('sha512')
  for (let offset = 0; offset < size; offset += 1024 ** 2) digest.update(await exact(handle, Math.min(1024 ** 2, size - offset), offset, b))
  return digest.digest('hex')
}
function filename(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return fail('unsupported', 'JAR条目名称不是当前支持的UTF-8编码') }
}
function extraFields(bytes: Buffer): void {
  for (let i = 0; i < bytes.length;) {
    if (i + 4 > bytes.length) fail('invalid', 'JAR扩展字段截断')
    const id = bytes.readUInt16LE(i), length = bytes.readUInt16LE(i + 2); i += 4
    if (i + length > bytes.length) fail('invalid', 'JAR扩展字段越界')
    if (id === 1) fail('unsupported', '当前模组检查器暂不支持ZIP64')
    // Alternate Unicode path fields can give a privileged metadata entry a
    // second name in another ZIP reader; do not interpret such ambiguity.
    if (id === 0x7075) fail('unsupported', 'JAR包含额外Unicode路径声明，当前不解释这种名称歧义')
    i += length
  }
}
interface Entry { name: string; raw: Buffer; offset: number; method: number; flags: number; crc: number; compressed: number; size: number; directory: boolean }
async function selectedPayload(handle: fs.FileHandle, entry: Entry, start: number, b: Budget, signal: AbortSignal | undefined): Promise<Buffer> {
  let count = 0, crc = 0
  const chunks: Buffer[] = []
  const consume = (bytes: Buffer) => {
    b.check(); count += bytes.length
    if (count > entry.size || count > MOD_JAR_LIMITS.metadataBytes) fail('limit', 'JAR元数据实际展开大小超过上限')
    crc = crc32(bytes, crc); chunks.push(Buffer.from(bytes))
  }
  async function* sourceBytes() {
    for (let offset = 0; offset < entry.compressed; offset += 65536) yield await exact(handle, Math.min(65536, entry.compressed - offset), start + offset, b)
  }
  if (entry.method === 0) { for await (const bytes of sourceBytes()) consume(bytes) }
  else {
    const inflater = createInflateRaw(), source = Readable.from(sourceBytes())
    const abort = () => { source.destroy(new DOMException('模组读取已取消', 'AbortError')); inflater.destroy(new DOMException('模组读取已取消', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    source.on('error', error => inflater.destroy(error)); source.pipe(inflater)
    try {
      for await (const bytes of inflater) consume(Buffer.from(bytes))
      if (inflater.bytesWritten !== entry.compressed) fail('invalid', 'JAR元数据压缩载荷含多余字节')
    } catch (error) {
      if (error instanceof ModJarReadError || error instanceof Error && error.name === 'AbortError') throw error
      fail('invalid', 'JAR元数据压缩数据损坏')
    } finally {
      signal?.removeEventListener('abort', abort); source.destroy(); inflater.destroy()
      // Readable.from's generator may still be waiting on a FileHandle read.
      // Wait for its teardown before the caller can close/release the source FD.
      await Promise.allSettled([finished(source), finished(inflater)])
    }
  }
  if (count !== entry.size || crc !== entry.crc) fail('invalid', 'JAR元数据实际大小或CRC不一致')
  return Buffer.concat(chunks)
}
async function readArchive(handle: fs.FileHandle, size: number, b: Budget, signal?: AbortSignal): Promise<Map<string, Uint8Array>> {
  if (size < 22) fail('invalid', 'JAR缺少ZIP结束记录')
  const tailBytes = Math.min(size, 65557), tail = await exact(handle, tailBytes, size - tailBytes, b)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break }
  if (eocd < 0) fail('invalid', 'JAR的ZIP结束记录无效或含尾随内容')
  const end = size - tailBytes + eocd
  if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6)) fail('unsupported', '当前模组检查器不支持分卷JAR')
  const count = tail.readUInt16LE(eocd + 10), centralBytes = tail.readUInt32LE(eocd + 12), centralStart = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralBytes === 0xffffffff || centralStart === 0xffffffff) fail('unsupported', '当前模组检查器暂不支持ZIP64')
  if (count !== tail.readUInt16LE(eocd + 8) || centralStart + centralBytes !== end) fail('invalid', 'JAR中央目录数量或范围无效')
  if (count > MOD_JAR_LIMITS.entries || centralBytes > MOD_JAR_LIMITS.centralDirectoryBytes) fail('limit', 'JAR条目或中央目录超过读取上限')
  const cd = await exact(handle, centralBytes, centralStart, b), entries: Entry[] = [], names = new Map<string, boolean>()
  let cursor = 0, metadataTotal = 0
  for (let i = 0; i < count; i++) {
    b.check()
    if (cursor + 46 > cd.length || cd.readUInt32LE(cursor) !== 0x02014b50) fail('invalid', 'JAR中央目录条目无效')
    const flags = cd.readUInt16LE(cursor + 8), method = cd.readUInt16LE(cursor + 10), nameLength = cd.readUInt16LE(cursor + 28)
    const extraLength = cd.readUInt16LE(cursor + 30), commentLength = cd.readUInt16LE(cursor + 32), stop = cursor + 46 + nameLength + extraLength + commentLength
    if (!nameLength || stop > cd.length) fail('invalid', 'JAR名称或扩展长度无效')
    if (flags & ~0x080e || flags & 1 || ![0, 8].includes(method)) fail('unsupported', 'JAR使用不支持的加密、标志或压缩方式')
    if (method === 0 && flags & 6) fail('invalid', 'JAR存储条目的压缩标志无效')
    const raw = Buffer.from(cd.subarray(cursor + 46, cursor + 46 + nameLength)), name = filename(raw), directory = name.endsWith('/')
    if (!safeEntry(name, directory)) fail('invalid', 'JAR包含不安全条目路径')
    extraFields(cd.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength))
    const external = cd.readUInt32LE(cursor + 38), type = external >>> 16 & 0xf000
    if (type && type !== (directory ? 0x4000 : 0x8000) || external & 0x10 && !directory) fail('invalid', 'JAR包含链接、特殊条目或矛盾的目录标志')
    if (cd.readUInt16LE(cursor + 34)) fail('unsupported', '当前模组检查器不支持分卷JAR')
    const compressed = cd.readUInt32LE(cursor + 20), entrySize = cd.readUInt32LE(cursor + 24), offset = cd.readUInt32LE(cursor + 42)
    if ([compressed, entrySize, offset].includes(0xffffffff)) fail('unsupported', '当前模组检查器暂不支持ZIP64')
    if (directory && (entrySize || cd.readUInt32LE(cursor + 16) || method === 0 && compressed)) fail('invalid', 'JAR目录条目不能含展开载荷')
    const key = fold(directory ? name.slice(0, -1) : name)
    if (names.has(key)) fail('invalid', 'JAR存在重复或大小写Unicode等价的条目')
    names.set(key, directory)
    if (!directory && metadataNames.has(name)) {
      metadataTotal += entrySize
      if (entrySize > MOD_JAR_LIMITS.metadataBytes || metadataTotal > MOD_JAR_LIMITS.metadataTotalBytes) fail('limit', 'JAR选定元数据大小超过单项或累计上限')
    }
    entries.push({ name, raw, offset, flags, method, crc: cd.readUInt32LE(cursor + 16), compressed, size: entrySize, directory }); cursor = stop
    if ((i & 255) === 255) await new Promise<void>(resolve => setImmediate(resolve))
  }
  if (cursor !== cd.length) fail('invalid', 'JAR中央目录含多余内容')
  const prefixes = new Map<string, string>(); let prefixBytes = 0, indexed = 0
  for (const entry of entries) {
    b.check()
    const parts = entry.name.replace(/\/$/, '').split('/')
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'), key = fold(prefix), previous = prefixes.get(key)
      if (previous !== undefined && previous !== prefix) fail('invalid', 'JAR目录前缀存在大小写或Unicode名称冲突')
      if (previous === undefined) { prefixBytes += Buffer.byteLength(prefix) * 4 + 64; if (prefixBytes > MOD_JAR_LIMITS.prefixIndexBytes) fail('limit', 'JAR路径索引超过读取预算'); prefixes.set(key, prefix) }
      if (i < parts.length && names.get(key) === false) fail('invalid', 'JAR文件与子目录路径冲突')
    }
    if ((++indexed & 255) === 0) await new Promise<void>(resolve => setImmediate(resolve))
  }
  const result = new Map<string, Uint8Array>(), sorted = [...entries].sort((a, c) => a.offset - c.offset)
  let previousEnd = 0
  for (const entry of sorted) {
    b.check()
    if (entry.offset < previousEnd || entry.offset + 30 > centralStart) fail('invalid', 'JAR本地条目重叠或越界')
    const local = await exact(handle, 30, entry.offset, b)
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags || local.readUInt16LE(8) !== entry.method) fail('invalid', 'JAR本地条目与中央目录不一致')
    const nameLength = local.readUInt16LE(26), extraLength = local.readUInt16LE(28), dataStart = entry.offset + 30 + nameLength + extraLength, dataEnd = dataStart + entry.compressed
    if (dataStart > centralStart || dataEnd > centralStart) fail('invalid', 'JAR载荷范围越界')
    if (nameLength !== entry.raw.length || !(await exact(handle, nameLength, entry.offset + 30, b)).equals(entry.raw)) fail('invalid', 'JAR本地与中央名称不一致')
    extraFields(await exact(handle, extraLength, entry.offset + 30 + nameLength, b))
    const descriptor = !!(entry.flags & 8), declared = [entry.crc, entry.compressed, entry.size]
    if ([local.readUInt32LE(14), local.readUInt32LE(18), local.readUInt32LE(22)].some((value, i) => descriptor ? value !== 0 && value !== declared[i] : value !== declared[i])) fail('invalid', 'JAR本地大小或校验声明不一致')
    previousEnd = dataEnd
    if (descriptor) {
      if (dataEnd + 12 > centralStart) fail('invalid', 'JAR数据描述符越界')
      const first = await exact(handle, 4, dataEnd, b), signature = first.readUInt32LE(0) === 0x08074b50, length = signature ? 16 : 12
      if (dataEnd + length > centralStart) fail('invalid', 'JAR数据描述符越界')
      const bytes = await exact(handle, length, dataEnd, b), offset = signature ? 4 : 0
      if (declared.some((value, i) => bytes.readUInt32LE(offset + i * 4) !== value)) fail('invalid', 'JAR数据描述符与中央目录不一致')
      previousEnd += length
    }
    if (!entry.directory && metadataNames.has(entry.name)) result.set(entry.name, await selectedPayload(handle, entry, dataStart, b, signal))
  }
  return result
}
async function inspect(file: string, options: ModJarReadOptions, installed: boolean, expected?: InstalledModSelection, sharedBudget?: Budget): Promise<ModJarDetails> {
  const selected = absoluteFile(file), name = path.basename(selected), disabledSuffix = /\.jar\.disabled$/i.test(name), b = sharedBudget ?? budget(options)
  if (!safeName(name) || !(installed ? /\.jar(?:\.disabled)?$/i : /\.jar$/i).test(name)) fail('unsafe-path', installed ? '所选条目必须是普通JAR或禁用后缀文件' : '请选择本地普通.jar文件，预览不导入或启用它')
  const observedAt = new Date().toISOString()
  try {
    const ancestors = await chain(path.dirname(selected), b), before = await fs.lstat(selected, { bigint: true }); b.check()
    if (!before.isFile() || before.isSymbolicLink()) fail('unsafe-path', '只读取普通模组文件，不读取链接或设备')
    if (expected) {
      // Inventory explicitly serializes new Date(Stats.mtimeMs). Stats.mtime
      // can round fractional milliseconds instead, so it is not interchangeable
      // with that public row contract. This is display matching only; the
      // BigInt FD/path proof below still has to remain unchanged.
      const display = await fs.lstat(selected)
      if (before.size !== BigInt(expected.sizeBytes) || new Date(display.mtimeMs).toISOString() !== expected.modifiedAt) fail('changed', '模组大小或修改时间与清单不同，请刷新后重试')
    }
    if (before.size > BigInt(MOD_JAR_LIMITS.archiveBytes)) fail('limit', 'JAR超过512 MiB读取上限')
    const handle = await fs.open(selected, readFlags)
    try {
      if (!sameFile(before, await handle.stat({ bigint: true }))) fail('changed', '模组文件在打开期间发生变化')
      await verifyChain(ancestors, b)
      const size = Number(before.size), beforeHash = await hash(handle, size, b)
      const raw = await readArchive(handle, size, b, options.signal)
      const documents = parseModMetadata(raw)
      b.check()
      const afterHash = await hash(handle, size, b)
      await verifyChain(ancestors, b)
      if (!sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await fs.lstat(selected, { bigint: true })) || beforeHash !== afterHash) fail('changed', '模组文件在读取期间发生变化，请重新选择')
      if (expected) await unique(path.dirname(selected), name, b)
      b.check()
      const status = documents.some(d => d.status === 'invalid') ? 'invalid' : documents.some(d => d.format !== 'manifest' && d.status === 'read') ? 'metadata-read' : documents.some(d => d.status === 'unsupported') ? 'unsupported' : 'no-metadata'
      const result: ModJarDetails = { name, disabledSuffix, observedAt, status, archiveBytes: size,
        ...(status === 'invalid' || status === 'unsupported' ? {} : { sha512: afterHash }), documents,
        warnings: ['只校验选定声明条目；外层SHA-512不等于全部JAR载荷、签名、模组代码安全或实际加载已验证',
          ...(!documents.some(d => d.format !== 'manifest' && d.status === 'read') ? ['未取得当前支持的模组声明；此文件可能是普通库、使用其他加载器或不受支持的元数据'] : [])] }
      if (Buffer.byteLength(JSON.stringify(result)) > MOD_JAR_LIMITS.dtoBytes) fail('limit', '模组详情超过返回大小预算')
      return result
    } catch (error) {
      // A changed file can first look like a malformed ZIP. Do not mint even a
      // diagnostic view from a displaced/mutating source observation.
      b.check(); await verifyChain(ancestors, b)
      const current = await fs.lstat(selected, { bigint: true }).catch(() => undefined)
      if (!current || !sameFile(before, current) || !sameFile(before, await handle.stat({ bigint: true }))) fail('changed', '模组文件在读取期间发生变化，请重新选择')
      throw error
    } finally { await handle.close() }
  } catch (error) {
    if (error instanceof ModJarReadError && ['invalid', 'unsupported', 'limit'].includes(error.code)) return { name, disabledSuffix, observedAt,
      status: error.code === 'invalid' ? 'invalid' : 'unsupported', documents: [], warnings: [error.message] }
    if (errno(error) === 'ENOENT') fail('missing', '所选模组或目录已不存在，请刷新后重试')
    throw error
  }
}
/** Main-only path; never accept a native path from renderer IPC. */
export async function inspectModJar(file: string, options: ModJarReadOptions = {}): Promise<ModJarDetails> { return inspect(file, options, false) }

/** Fresh observation of one direct mods row; does not authenticate a prior inode absent from its DTO. */
export async function inspectInstalledMod(instanceDirectory: string, selection: InstalledModSelection, options: ModJarReadOptions = {}): Promise<ModJarDetails> {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || ![Object.prototype, null].includes(Object.getPrototypeOf(selection)) ||
      Reflect.ownKeys(selection).length !== 4 || Reflect.ownKeys(selection).some(key => typeof key !== 'string' || !['itemId', 'name', 'sizeBytes', 'modifiedAt'].includes(key) || !('value' in Object.getOwnPropertyDescriptor(selection, key)!)) ||
      !safeName(selection.name) || !/\.jar(?:\.disabled)?$/i.test(selection.name) || selection.itemId !== 'mods:' + createHash('sha256').update(selection.name).digest('hex') ||
      !Number.isSafeInteger(selection.sizeBytes) || selection.sizeBytes < 0 || typeof selection.modifiedAt !== 'string' || !Number.isFinite(Date.parse(selection.modifiedAt))) fail('unsafe-path', '模组清单选择无效，请刷新后重试')
  const instance = absoluteFile(instanceDirectory), directory = path.join(instance, 'game', 'mods'), b = budget(options)
  const ancestors = await chain(directory, b)
  await unique(directory, selection.name, b)
  const result = await inspect(path.join(directory, selection.name), options, true, selection, b)
  await verifyChain(ancestors, b); await unique(directory, selection.name, b); b.check()
  return result
}
