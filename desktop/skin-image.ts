import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { PNG } from 'pngjs'
import { crc32 } from './world-zip'

export const SKIN_IMAGE_LIMITS = Object.freeze({ fileBytes: 2 * 1024 ** 2, chunks: 1024, inflatedBytes: 128 * 1024,
  normalizedBytes: 32 * 1024, dataUrlBytes: 48 * 1024 })
export class SkinImageError extends Error {
  constructor(readonly code: 'invalid' | 'unsupported' | 'limit', message: string) { super(message); this.name = 'SkinImageError' }
}
export interface SkinImageResult {
  width: 64
  height: 32 | 64
  layout: 'legacy' | 'modern'
  sourceSha256: string
  /** SHA256 of the decoded RGBA samples; dimensions are independently bound. */
  pixelsSha256: string
  normalizedSha256: string
  normalizedPng: Buffer
  rgba: Buffer
  alpha: { transparentPixels: number; partialAlphaPixels: number }
  warnings: string[]
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const resultProof = new WeakSet<SkinImageResult>()
const fail = (code: SkinImageError['code'], message: string): never => { throw new SkinImageError(code, message) }
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface CheckedPng { sanitized: Buffer; idat: Buffer; height: 32 | 64; channels: number; stripped: boolean }
function checkPng(bytes: Buffer, signal?: AbortSignal): CheckedPng {
  if (bytes.length > SKIN_IMAGE_LIMITS.fileBytes) fail('limit', '皮肤PNG超过2MiB读取上限')
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) fail('invalid', '所选文件不是有效PNG皮肤图像')
  let offset = 8, chunks = 0, height: 32 | 64 | undefined, colorType = -1, channels = 0, paletteEntries = 0,
    seenPalette = false, seenTransparency = false, seenData = false, dataEnded = false, seenEnd = false, stripped = false
  const retained: Buffer[] = [signature], data: Buffer[] = []
  while (offset < bytes.length) {
    signal?.throwIfAborted()
    if (++chunks > SKIN_IMAGE_LIMITS.chunks) fail('limit', '皮肤PNG的数据段数量超过上限')
    if (offset + 12 > bytes.length) fail('invalid', '皮肤PNG数据段被截断')
    const length = bytes.readUInt32BE(offset), stop = offset + 12 + length
    if (length > SKIN_IMAGE_LIMITS.fileBytes || stop > bytes.length) fail('invalid', '皮肤PNG数据段范围无效')
    const typeBytes = bytes.subarray(offset + 4, offset + 8), type = typeBytes.toString('latin1'), payload = bytes.subarray(offset + 8, offset + 8 + length)
    if (!/^[A-Za-z]{4}$/.test(type) || typeBytes[2] & 32) fail('invalid', '皮肤PNG数据段类型无效')
    if (crc32(payload, crc32(typeBytes)) !== bytes.readUInt32BE(offset + 8 + length)) fail('invalid', '皮肤PNG数据段CRC校验失败')
    if (chunks === 1 && type !== 'IHDR' || chunks > 1 && type === 'IHDR') fail('invalid', '皮肤PNG需要唯一且位于开头的IHDR')
    if (seenEnd) fail('invalid', '皮肤PNG在IEND后包含多余内容')
    if (seenData && type !== 'IDAT') dataEnded = true
    let keep = true
    switch (type) {
      case 'IHDR': {
        if (length !== 13) fail('invalid', '皮肤PNG的IHDR长度无效')
        const width = payload.readUInt32BE(0), imageHeight = payload.readUInt32BE(4)
        if (width !== 64 || imageHeight !== 32 && imageHeight !== 64) fail('unsupported', '本版只支持64×64或64×32皮肤PNG')
        height = imageHeight as 32 | 64; colorType = payload[9]
        const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
        if (!depths[colorType]?.includes(payload[8]) || payload[10] !== 0 || payload[11] !== 0 || ![0, 1].includes(payload[12])) fail('invalid', '皮肤PNG的位深、颜色或压缩参数无效')
        if (payload[8] !== 8 || payload[12] !== 0) fail('unsupported', '本版皮肤检查仅支持8bit非交错PNG；未自动转换其他格式')
        channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
        break
      }
      case 'PLTE':
        if (seenPalette || seenTransparency || seenData || ![2, 3, 6].includes(colorType) || length === 0 || length % 3 !== 0 || length > 768) fail('invalid', '皮肤PNG调色板或顺序无效')
        seenPalette = true; paletteEntries = length / 3; break
      case 'tRNS':
        if (seenTransparency || seenData || colorType === 3 && (!seenPalette || length === 0 || length > paletteEntries) || colorType === 0 && length !== 2 || colorType === 2 && length !== 6 || ![0, 2, 3].includes(colorType)) fail('invalid', '皮肤PNG透明色声明或顺序无效')
        if (colorType === 0 || colorType === 2) for (let at = 0; at < length; at += 2) if (payload.readUInt16BE(at) > 255) fail('invalid', '皮肤PNG透明色超出8bit采样范围')
        seenTransparency = true; break
      case 'IDAT':
        if (dataEnded || colorType === 3 && !seenPalette) fail('invalid', '皮肤PNG图像数据顺序或调色板无效')
        seenData = true; data.push(payload); break
      case 'IEND':
        if (length !== 0 || !seenData || stop !== bytes.length) fail('invalid', '皮肤PNG结束记录无效或包含尾随内容')
        seenEnd = true; break
      case 'acTL': case 'fcTL': case 'fdAT': fail('unsupported', '本版不支持动画PNG皮肤')
      default:
        if (!(typeBytes[0] & 32)) fail('unsupported', '皮肤PNG含当前不支持的关键数据段')
        // Ancillary payloads, including compressed profiles/text, are never
        // decompressed or forwarded to the codec or renderer.
        stripped = true; keep = false
    }
    if (keep) retained.push(bytes.subarray(offset, stop))
    offset = stop
  }
  if (!height || !seenEnd || !data.length) fail('invalid', '皮肤PNG缺少完整图像或结束记录')
  return { sanitized: Buffer.concat(retained), idat: Buffer.concat(data), height: height as 32 | 64, channels, stripped }
}
/** Main only: exact bounded decoding, never a filesystem/URL or account API. */
export function normalizeSkinImage(input: Uint8Array, options: { signal?: AbortSignal } = {}): SkinImageResult {
  options.signal?.throwIfAborted()
  if (!(input instanceof Uint8Array)) fail('invalid', '皮肤来源必须是PNG字节')
  if (input.byteLength > SKIN_IMAGE_LIMITS.fileBytes) fail('limit', '皮肤PNG超过2MiB读取上限')
  const bytes = Buffer.from(input), checked = checkPng(bytes, options.signal)
  const expected = (64 * checked.channels + 1) * checked.height
  try {
    // Node's info:true returns both the buffer and the consumed input count;
    // some Node type versions still declare only the ordinary Buffer result.
    const expanded = inflateSync(checked.idat, { maxOutputLength: SKIN_IMAGE_LIMITS.inflatedBytes, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
    if (!Buffer.isBuffer(expanded.buffer) || expanded.buffer.length !== expected || expanded.engine?.bytesWritten !== checked.idat.length) fail('invalid', '皮肤PNG展开大小不符或压缩数据含尾随内容')
    const stride = 64 * checked.channels + 1
    for (let at = 0; at < expanded.buffer.length; at += stride) if (expanded.buffer[at] > 4) fail('invalid', '皮肤PNG含无效扫描行过滤器')
  } catch (error) {
    if (error instanceof SkinImageError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') fail('limit', '皮肤PNG展开数据超过128KiB硬上限')
    fail('invalid', '皮肤PNG压缩图像数据损坏')
  }
  options.signal?.throwIfAborted()
  let decoded: { width: number; height: number; data: Buffer }
  try { decoded = PNG.sync.read(checked.sanitized, { checkCRC: true }) } catch { return fail('invalid', '皮肤PNG未通过像素解码检查') }
  if (decoded.width !== 64 || decoded.height !== checked.height || !Buffer.isBuffer(decoded.data) || decoded.data.length !== 64 * checked.height * 4) fail('invalid', '皮肤PNG解码像素尺寸不符')
  const rgba = Buffer.from(decoded.data)
  let normalizedPng: Buffer
  try { normalizedPng = PNG.sync.write({ width: 64, height: checked.height, data: rgba }, {
    bitDepth: 8, colorType: 6, inputColorType: 6, inputHasAlpha: true, filterType: 0, deflateLevel: 9,
  }) } catch { return fail('invalid', '无法生成已检查的皮肤PNG副本') }
  if (normalizedPng.length > SKIN_IMAGE_LIMITS.normalizedBytes) fail('limit', '皮肤规范化副本超过输出大小预算')
  const alpha = { transparentPixels: 0, partialAlphaPixels: 0 }
  for (let at = 3; at < rgba.length; at += 4) { if (rgba[at] === 0) alpha.transparentPixels++; else if (rgba[at] < 255) alpha.partialAlphaPixels++ }
  const warnings: string[] = ['仅完成PNG图片检查与本地预览；不表示官方服务接受或实际游戏显示已验证']
  if (checked.height === 32) warnings.push('旧版64×32布局本版仅支持经典模型镜像预览，没有现代独立左侧肢体或全身外层')
  if (checked.stripped) warnings.push('收藏副本不保留PNG附加元数据；没有修改所选原文件')
  if (alpha.transparentPixels || alpha.partialAlphaPixels) warnings.push('透明采样保持原样；本地预览不推断游戏对基础层透明度的处理')
  options.signal?.throwIfAborted()
  const result: SkinImageResult = { width: 64, height: checked.height, layout: checked.height === 32 ? 'legacy' : 'modern', rgba, normalizedPng,
    sourceSha256: sha256(bytes), pixelsSha256: sha256(rgba), normalizedSha256: sha256(normalizedPng), alpha, warnings }
  Object.freeze(alpha); Object.freeze(warnings); Object.freeze(result); resultProof.add(result)
  return result
}
/** Small data URL from checked canonical PNG bytes, not an arbitrary source. */
export function skinTextureDataUrl(input: SkinImageResult | Uint8Array): string {
  const value = input instanceof Uint8Array ? normalizeSkinImage(input) : input
  if (!resultProof.has(value) || sha256(value.normalizedPng) !== value.normalizedSha256) fail('invalid', '皮肤检查结果已变化，请重新读取')
  const url = 'data:image/png;base64,' + value.normalizedPng.toString('base64')
  if (Buffer.byteLength(url) > SKIN_IMAGE_LIMITS.dataUrlBytes) fail('limit', '皮肤预览超过返回大小预算')
  return url
}
