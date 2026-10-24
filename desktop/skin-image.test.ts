import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { PNG } from 'pngjs'
import { crc32 } from './world-zip'
import { normalizeSkinImage, skinTextureDataUrl, SkinImageError, SKIN_IMAGE_LIMITS } from './skin-image'

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function chunk(name: string | Buffer, payload: Buffer = Buffer.alloc(0)) {
  const type = typeof name === 'string' ? Buffer.from(name, 'latin1') : name, output = Buffer.alloc(payload.length + 12)
  output.writeUInt32BE(payload.length); type.copy(output, 4); payload.copy(output, 8)
  output.writeUInt32BE(crc32(payload, crc32(type)), output.length - 4)
  return output
}
function header(width = 64, height = 64, color = 6, depth = 8, interlace = 0) {
  const h = Buffer.alloc(13); h.writeUInt32BE(width); h.writeUInt32BE(height, 4); h[8] = depth; h[9] = color; h[12] = interlace; return h
}
function scanlines(height = 64, channels = 4, pixel: (x: number, y: number) => number[] = (x, y) => [x, y, x ^ y, 255]) {
  const raw = Buffer.alloc((64 * channels + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < 64; x++) for (let c = 0; c < channels; c++) raw[y * (64 * channels + 1) + 1 + x * channels + c] = pixel(x, y)[c]
  return raw
}
function png(options: { width?: number; height?: number; color?: number; depth?: number; interlace?: number; raw?: Buffer; compressed?: Buffer; before?: Buffer[]; after?: Buffer[] } = {}) {
  const height = options.height ?? 64, color = options.color ?? 6, channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color] ?? 4
  return Buffer.concat([sig, chunk('IHDR', header(options.width ?? 64, height, color, options.depth ?? 8, options.interlace ?? 0)), ...(options.before ?? []),
    chunk('IDAT', options.compressed ?? deflateSync(options.raw ?? scanlines(height, channels))), ...(options.after ?? []), chunk('IEND')])
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function invalid(bytes: Buffer, code: SkinImageError['code'] = 'invalid') {
  assert.throws(() => normalizeSkinImage(bytes), error => error instanceof SkinImageError && error.code === code)
}
function rgbaAt(bytes: Buffer, x: number, y: number) { return [...bytes.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)] }
function types(bytes: Buffer) { const result = []; for (let at = 8; at < bytes.length; at += bytes.readUInt32BE(at) + 12) result.push(bytes.toString('latin1', at + 4, at + 8)); return result }

test('modern and legacy original RGBA pixels normalize with exact hashes and source untouched', () => {
  for (const height of [32, 64] as const) {
    const source = png({ height }), saved = Buffer.from(source), image = normalizeSkinImage(source)
    assert.equal(image.width, 64); assert.equal(image.height, height); assert.equal(image.layout, height === 32 ? 'legacy' : 'modern')
    assert.equal(image.sourceSha256, sha(source)); assert.equal(image.pixelsSha256, sha(image.rgba)); assert.equal(image.normalizedSha256, sha(image.normalizedPng))
    assert.deepEqual(rgbaAt(image.rgba, 17, 20), [17, 20, 17 ^ 20, 255]); assert.deepEqual(source, saved)
    assert.deepEqual(PNG.sync.read(image.normalizedPng, { checkCRC: true }).data, image.rgba)
    assert.ok(image.normalizedPng.length <= SKIN_IMAGE_LIMITS.normalizedBytes)
  }
})
test('8bit RGB and grayscale decode into known opaque RGBA without guessing model', () => {
  const rgb = normalizeSkinImage(png({ color: 2, raw: scanlines(64, 3, (x, y) => [x + 1, y + 2, 77]) }))
  assert.deepEqual(rgbaAt(rgb.rgba, 5, 6), [6, 8, 77, 255])
  const gray = normalizeSkinImage(png({ color: 0, raw: scanlines(64, 1, (x, y) => [x + y]) }))
  assert.deepEqual(rgbaAt(gray.rgba, 5, 6), [11, 11, 11, 255]); assert.equal('model' in rgb, false)
})
test('8bit grayscale alpha preserves full, partial and empty alpha samples', () => {
  const image = normalizeSkinImage(png({ color: 4, raw: scanlines(64, 2, x => [80, x % 3 === 0 ? 0 : x % 3 === 1 ? 128 : 255]) }))
  assert.deepEqual(rgbaAt(image.rgba, 1, 2), [80, 80, 80, 128]); assert.deepEqual(rgbaAt(image.rgba, 0, 2), [80, 80, 80, 0])
  assert.equal(image.alpha.transparentPixels, 22 * 64); assert.equal(image.alpha.partialAlphaPixels, 21 * 64)
  assert.match(image.warnings.join(''), /透明采样保持原样/)
})
test('8bit palette with tRNS has independently expected RGBA and is re-encoded as ordinary RGBA', () => {
  const palette = Buffer.from([255, 0, 0, 0, 0, 255, 0, 255, 0, 255, 255, 255])
  const image = normalizeSkinImage(png({ color: 3, raw: scanlines(64, 1, x => [x % 4]), before: [chunk('PLTE', palette), chunk('tRNS', Buffer.from([255, 0, 128, 255]))] }))
  assert.deepEqual(rgbaAt(image.rgba, 0, 0), [255, 0, 0, 255]); assert.deepEqual(rgbaAt(image.rgba, 1, 0), [0, 0, 255, 0]); assert.deepEqual(rgbaAt(image.rgba, 2, 0), [0, 255, 0, 128])
  assert.deepEqual(types(image.normalizedPng), ['IHDR', 'IDAT', 'IEND']); assert.equal(image.normalizedPng[25], 6)
})
test('RGB/grayscale transparent-colour chunks decode as transparent without inventing opacity', () => {
  const rgbTrns = Buffer.from([0, 3, 0, 4, 0, 5]), grayTrns = Buffer.from([0, 9])
  const rgb = normalizeSkinImage(png({ color: 2, raw: scanlines(64, 3, () => [3, 4, 5]), before: [chunk('tRNS', rgbTrns)] }))
  const gray = normalizeSkinImage(png({ color: 0, raw: scanlines(64, 1, () => [9]), before: [chunk('tRNS', grayTrns)] }))
  assert.deepEqual(rgbaAt(rgb.rgba, 0, 0), [0, 0, 0, 0]); assert.deepEqual(rgbaAt(gray.rgba, 0, 0), [0, 0, 0, 0])
})
test('valid scanline filters1-4 are actually decoded by the codec', () => {
  for (const filter of [1, 2, 3, 4]) {
    const raw = Buffer.alloc(64 * 257); for (let y = 0; y < 64; y++) raw[y * 257] = filter
    const image = normalizeSkinImage(png({ raw })); assert.ok(image.rgba.every(byte => byte === 0))
  }
})
test('ancillary private/text/profile payloads are CRC checked but never decompressed or returned', () => {
  const marker = 'ORIGINAL_PRIVATE_METADATA_SHOULD_NOT_REACH_RENDERER', image = normalizeSkinImage(png({ before: [chunk('tEXt', Buffer.from(marker)), chunk('iCCP', Buffer.from('invalid compressed profile deliberately never inflated'))] }))
  assert.deepEqual(types(image.normalizedPng), ['IHDR', 'IDAT', 'IEND']); assert.equal(image.normalizedPng.includes(Buffer.from(marker)), false)
  assert.equal(JSON.stringify(image.warnings).includes(marker), false); assert.match(image.warnings.join(''), /不保留PNG附加元数据/)
})
test('signature, truncation, CRC corruption and trailing standalone PNG bytes reject', () => {
  invalid(Buffer.from('<svg></svg>')); const wrong = png(); wrong[0] = 0; invalid(wrong)
  invalid(png().subarray(0, 40)); const crc = png(); crc[29] ^= 1; invalid(crc)
  invalid(Buffer.concat([png(), Buffer.from('trailing')])); invalid(png().subarray(0, -12))
})
test('IHDR dimensions, repeated headers, invalid colour/depth/compression and malformed chunk names reject', () => {
  for (const [width, height] of [[32, 64], [64, 63], [4096, 4096], [0, 64]]) invalid(png({ width, height }), 'unsupported')
  invalid(png({ before: [chunk('IHDR', header())] })); invalid(png({ color: 5 })); invalid(png({ color: 2, depth: 4 }))
  invalid(png({ before: [chunk(Buffer.from([0xc1, 66, 67, 68]))] })); invalid(png({ before: [chunk('abca')] }))
  const bytes = png(), ihdr = header(); ihdr[10] = 1; invalid(Buffer.concat([sig, chunk('IHDR', ihdr), bytes.subarray(33)]))
})
test('valid unsupported depth/interlace and APNG are explicit unsupported before decoding', () => {
  for (const options of [{ depth: 16 }, { color: 0, depth: 1 }, { color: 3, depth: 4 }, { interlace: 1 }]) invalid(png(options), 'unsupported')
  for (const type of ['acTL', 'fcTL', 'fdAT']) invalid(png({ before: [chunk(type)] }), 'unsupported')
  invalid(png({ before: [chunk('ABCD')] }), 'unsupported')
})
test('palette and transparency structures and ordering are finite', () => {
  const palette = chunk('PLTE', Buffer.from([1, 2, 3]))
  invalid(png({ color: 3 })); invalid(png({ color: 3, before: [palette, palette] })); invalid(png({ color: 3, before: [chunk('PLTE', Buffer.alloc(2))] }))
  invalid(png({ color: 3, before: [chunk('tRNS', Buffer.from([255])), palette] })); invalid(png({ color: 3, before: [palette, chunk('tRNS', Buffer.from([255, 255]))] }))
  invalid(png({ color: 6, before: [chunk('tRNS', Buffer.from([0, 1]))] }))
  invalid(png({ color: 2, before: [chunk('tRNS', Buffer.from([1, 0, 0, 1, 0, 2]))] }))
  invalid(png({ color: 3, before: [palette], raw: scanlines(64, 1, () => [1]) }))
})
test('IDAT must be contiguous, compression complete and output exactly bounded scanlines', () => {
  const raw = scanlines(), compressed = deflateSync(raw), h = chunk('IHDR', header())
  invalid(Buffer.concat([sig, h, chunk('IDAT', compressed.subarray(0, 5)), chunk('tEXt', Buffer.from('gap')), chunk('IDAT', compressed.subarray(5)), chunk('IEND')]))
  invalid(png({ compressed: Buffer.concat([compressed, Buffer.from('tail')]) })); invalid(png({ raw: Buffer.alloc(raw.length + 1) }))
  invalid(png({ compressed: Buffer.from('invalid zlib') })); const badFilter = scanlines(); badFilter[0] = 5; invalid(png({ raw: badFilter }))
  invalid(png({ raw: Buffer.alloc(SKIN_IMAGE_LIMITS.inflatedBytes + 1) }), 'limit')
})
test('file and chunk budgets fail without allowing huge declared images into decoder', () => {
  invalid(Buffer.alloc(SKIN_IMAGE_LIMITS.fileBytes + 1), 'limit')
  invalid(png({ before: Array.from({ length: SKIN_IMAGE_LIMITS.chunks }, () => chunk('teXt')) }), 'limit')
  const range = png(); range.writeUInt32BE(0xffffffff, 8); invalid(range)
})
test('canonical normalized PNG is deterministic and idempotent while source hash preserves original bytes', () => {
  const original = png({ before: [chunk('tEXt', Buffer.from('source marker'))] }), first = normalizeSkinImage(original), second = normalizeSkinImage(first.normalizedPng)
  assert.notEqual(first.sourceSha256, first.normalizedSha256); assert.equal(second.sourceSha256, first.normalizedSha256)
  assert.deepEqual(second.rgba, first.rgba); assert.equal(second.pixelsSha256, first.pixelsSha256); assert.deepEqual(second.normalizedPng, first.normalizedPng)
})
test('single canonical texture data URL is bounded and forged or changed image observations reject', () => {
  const image = normalizeSkinImage(png()), url = skinTextureDataUrl(image)
  assert.ok(url.startsWith('data:image/png;base64,')); assert.ok(Buffer.byteLength(url) < SKIN_IMAGE_LIMITS.dataUrlBytes)
  assert.deepEqual(Buffer.from(url.split(',')[1], 'base64'), image.normalizedPng); assert.equal(skinTextureDataUrl(image.normalizedPng), url)
  assert.throws(() => skinTextureDataUrl({ ...image }), /已变化/)
  image.normalizedPng[10] ^= 1; assert.throws(() => skinTextureDataUrl(image), /已变化/)
})
test('pre-cancelled decode has no result and never modifies input bytes', () => {
  const bytes = png(), copy = Buffer.from(bytes), controller = new AbortController(); controller.abort()
  assert.throws(() => normalizeSkinImage(bytes, { signal: controller.signal }), { name: 'AbortError' }); assert.deepEqual(bytes, copy)
})
