import { performance } from 'node:perf_hooks'
import { setImmediate as yieldTurn } from 'node:timers/promises'

/** Product limits, not a claim about the maximum size of valid Minecraft data. */
export const NBT_LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024, depth: 64, tags: 100_000, listEntries: 100_000,
  compoundEntries: 10_000, stringBytes: 4 * 1024 * 1024,
  arrayBytes: 16 * 1024 * 1024, projectedStringUnits: 4096, durationMs: 5000,
})
export class NbtReadError extends Error {
  constructor(public readonly code: 'invalid-nbt' | 'limit-exceeded', message: string) {
    super(message); this.name = 'NbtReadError'
  }
}
export interface NbtProjectedTag {
  type: number
  /** Longs stay bigint inside the main process. Arrays/containers have no value. */
  value?: number | bigint | string
  truncated?: boolean
}
export interface NbtReadOptions {
  signal?: AbortSignal
  /** Monotonic performance.now() deadline shared with the file reader. */
  deadline?: number
  /** Main-process tests may lower, but never raise, a product limit. */
  limits?: Partial<Record<keyof typeof NBT_LIMITS, number>>
}
export const nbtPathKey = (segments: readonly string[]) => JSON.stringify(segments)
const invalid = (message: string): never => { throw new NbtReadError('invalid-nbt', message) }
const limited = (): never => { throw new NbtReadError('limit-exceeded', 'NBT 超出读取预算') }

/**
 * Validate one entire big-endian, named Compound NBT root, retaining only exact
 * requested paths. Lists cannot impersonate compound paths. No general NBT tree
 * is constructed; unknown subtrees still consume all validation budgets.
 *
 * Strings accept canonical Java DataOutput modified UTF-8 (including UTF-16
 * surrogate units). Raw NUL and unnecessary overlong encodings are deliberately
 * rejected, even though Java DataInput.readUTF tolerates some of those forms.
 * https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/io/DataInput.html
 */
export async function readNbtProjection(
  input: Uint8Array, paths: readonly (readonly string[])[], options: NbtReadOptions = {},
): Promise<Map<string, NbtProjectedTag>> {
  const limits: Record<keyof typeof NBT_LIMITS, number> = { ...NBT_LIMITS }
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value! <= 0 ||
        value! > NBT_LIMITS[key as keyof typeof NBT_LIMITS]) throw new TypeError('NBT 预算无效')
    limits[key as keyof typeof limits] = value!
  }
  if (!Array.isArray(paths) || paths.length > 64 || paths.some(parts => !Array.isArray(parts) ||
      parts.length > 16 || parts.some(part => typeof part !== 'string' || part.length > 256))) {
    throw new TypeError('NBT 投影路径无效')
  }
  if (!(input instanceof Uint8Array)) throw new TypeError('NBT 输入必须为字节')
  const deadline = Math.min(options.deadline ?? Infinity, performance.now() + limits.durationMs)
  if (Number.isNaN(deadline)) throw new TypeError('NBT 截止时间无效')
  const check = () => {
    if (options.signal?.aborted) throw new DOMException('世界读取已取消', 'AbortError')
    if (performance.now() >= deadline) limited()
  }
  check()
  if (input.byteLength > limits.bytes) limited()
  // The caller owns the immutable input until this asynchronous parse finishes.
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  let offset = 0, tags = 0, stringBytes = 0, arrayBytes = 0, work = 0
  const projected = new Map<string, NbtProjectedTag>()
  const wanted = new Set(paths.map(nbtPathKey))
  const prefixes = new Set(paths.flatMap((parts: readonly string[]) => parts.map((_, index) => nbtPathKey(parts.slice(0, index + 1)))))
  async function checkpoint(units = 1) {
    work += units
    if (work >= 512) { work = 0; await yieldTurn(); check() }
  }
  function take(length: number): number {
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) invalid('NBT 数据被截断')
    const start = offset; offset += length; return start
  }
  const u8 = () => bytes.readUInt8(take(1))
  const i32 = () => bytes.readInt32BE(take(4))
  async function string(retainUnits: number): Promise<{ text: string; truncated: boolean }> {
    const length = bytes.readUInt16BE(take(2))
    stringBytes += length
    if (stringBytes > limits.stringBytes) limited()
    const start = take(length), end = start + length
    let text = '', units = 0
    for (let cursor = start; cursor < end;) {
      const a = bytes[cursor++]
      let code = 0
      if (a >= 1 && a <= 0x7f) code = a
      else if (a >= 0xc0 && a <= 0xdf) {
        if (cursor >= end) invalid('NBT modified UTF-8 被截断')
        const b = bytes[cursor++]
        if ((b & 0xc0) !== 0x80) invalid('NBT modified UTF-8 无效')
        code = ((a & 31) << 6) | (b & 63)
        if (code < 0x80 && !(a === 0xc0 && b === 0x80)) invalid('NBT modified UTF-8 非规范编码')
      } else if (a >= 0xe0 && a <= 0xef) {
        if (cursor + 1 >= end) invalid('NBT modified UTF-8 被截断')
        const b = bytes[cursor++], c = bytes[cursor++]
        if ((b & 0xc0) !== 0x80 || (c & 0xc0) !== 0x80) invalid('NBT modified UTF-8 无效')
        code = ((a & 15) << 12) | ((b & 63) << 6) | (c & 63)
        if (code < 0x800) invalid('NBT modified UTF-8 非规范编码')
      } else invalid('NBT modified UTF-8 无效')
      if (units++ < retainUnits) text += String.fromCharCode(code)
      // Yield while decoding large unknown strings as well as selected fields.
      if ((units & 2047) === 0) { await yieldTurn(); check() }
    }
    // Do not create an unpaired high surrogate by truncating a valid pair.
    if (units > retainUnits && /[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1)
    return { text, truncated: units > retainUnits }
  }
  function lengthCount(max: number): number {
    const count = i32()
    if (count < 0) invalid('NBT 长度不能为负数')
    if (count > max) limited()
    return count
  }
  async function payload(type: number, depth: number, current?: readonly string[]): Promise<void> {
    if (type < 1 || type > 12) invalid('NBT 标签类型无效')
    if (depth > limits.depth || ++tags > limits.tags) limited()
    await checkpoint()
    const selectedKey = current ? nbtPathKey(current) : undefined
    const selected = selectedKey !== undefined && wanted.has(selectedKey)
    const tag: NbtProjectedTag = { type }
    switch (type) {
      case 1: { const start = take(1); if (selected) tag.value = bytes.readInt8(start); break }
      case 2: { const start = take(2); if (selected) tag.value = bytes.readInt16BE(start); break }
      case 3: { const value = i32(); if (selected) tag.value = value; break }
      case 4: { const start = take(8); if (selected) tag.value = bytes.readBigInt64BE(start); break }
      case 5: { const start = take(4); if (selected) tag.value = bytes.readFloatBE(start); break }
      case 6: { const start = take(8); if (selected) tag.value = bytes.readDoubleBE(start); break }
      case 7: case 11: case 12: {
        const width = type === 7 ? 1 : type === 11 ? 4 : 8
        const count = lengthCount(Math.floor(limits.arrayBytes / width))
        arrayBytes += count * width
        if (arrayBytes > limits.arrayBytes) limited()
        take(count * width) // No array allocation, including for unknown Player data.
        break
      }
      case 8: {
        const value = await string(selected ? limits.projectedStringUnits : 0)
        if (selected) { tag.value = value.text; if (value.truncated) tag.truncated = true }
        break
      }
      case 9: {
        const element = u8(), count = lengthCount(limits.listEntries)
        if (element > 12 || (element === 0 && count !== 0)) invalid('NBT List 类型无效')
        if (tags + count > limits.tags) limited()
        for (let i = 0; i < count; i++) await payload(element, depth + 1)
        break
      }
      case 10: {
        const names = new Set<string>()
        while (true) {
          const childType = u8()
          if (childType === 0) break
          if (childType > 12) invalid('NBT 标签类型无效')
          if (names.size >= limits.compoundEntries) limited()
          const name = (await string(65535)).text
          if (names.has(name)) invalid('NBT Compound 包含重复键')
          names.add(name)
          const next = current ? [...current, name] : undefined
          await payload(childType, depth + 1, next && prefixes.has(nbtPathKey(next)) ? next : undefined)
        }
        break
      }
    }
    if (selected) projected.set(selectedKey!, tag)
  }
  if (u8() !== 10) invalid('NBT 根必须为 Compound')
  await string(0) // Root name is valid MUTF-8, but is never a projected path segment.
  await payload(10, 1, [])
  check()
  if (offset !== bytes.length) invalid('NBT 根结束后存在额外数据')
  return projected
}
