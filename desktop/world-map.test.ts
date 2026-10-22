import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import zlib from 'node:zlib'
import { blockColor } from './map-colors'
import { parseNbt } from './nbt'
import { readWorldMapInfo, renderRegionTile } from './world-map'

// ---- minimal NBT writer for original fixtures
type Tag = { type: number; value: unknown }
const byte = (value: number): Tag => ({ type: 1, value })
const int = (value: number): Tag => ({ type: 3, value })
const long = (value: bigint): Tag => ({ type: 4, value })
const double = (value: number): Tag => ({ type: 6, value })
const str = (value: string): Tag => ({ type: 8, value })
const listOf = (itemType: number, items: Tag[]): Tag => ({ type: 9, value: { itemType, items } })
const comp = (entries: Record<string, Tag>): Tag => ({ type: 10, value: entries })
const ints = (values: number[]): Tag => ({ type: 11, value: values })
const longs = (values: bigint[]): Tag => ({ type: 12, value: values })
const bytes = (values: number[]): Tag => ({ type: 7, value: values })
function payload(tag: Tag): Buffer {
  const b = (n: number, size: number, write: (buf: Buffer) => void) => { const buf = Buffer.alloc(size); write(buf); return buf }
  switch (tag.type) {
    case 1: return b(0, 1, buf => buf.writeInt8(tag.value as number))
    case 3: return b(0, 4, buf => buf.writeInt32BE(tag.value as number))
    case 4: return b(0, 8, buf => buf.writeBigInt64BE(tag.value as bigint))
    case 6: return b(0, 8, buf => buf.writeDoubleBE(tag.value as number))
    case 7: { const values = tag.value as number[]; return Buffer.concat([b(0, 4, buf => buf.writeInt32BE(values.length)), Buffer.from(Int8Array.from(values).buffer)]) }
    case 8: { const text = Buffer.from(tag.value as string); return Buffer.concat([b(0, 2, buf => buf.writeUInt16BE(text.length)), text]) }
    case 9: { const { itemType, items } = tag.value as { itemType: number; items: Tag[] }; return Buffer.concat([Buffer.from([itemType]), b(0, 4, buf => buf.writeInt32BE(items.length)), ...items.map(payload)]) }
    case 10: return Buffer.concat([...Object.entries(tag.value as Record<string, Tag>).map(([name, child]) => Buffer.concat([Buffer.from([child.type]), payload(str(name)), payload(child)])), Buffer.from([0])])
    case 11: { const values = tag.value as number[]; return Buffer.concat([b(0, 4, buf => buf.writeInt32BE(values.length)), ...values.map(v => b(0, 4, buf => buf.writeInt32BE(v)))]) }
    case 12: { const values = tag.value as bigint[]; return Buffer.concat([b(0, 4, buf => buf.writeInt32BE(values.length)), ...values.map(v => b(0, 8, buf => buf.writeBigInt64BE(v)))]) }
    default: throw new Error('unsupported')
  }
}
const nbtFile = (root: Tag) => Buffer.concat([Buffer.from([10]), payload(str('')), payload(root)])
function pack(values: number[], bits: number, spanning: boolean): bigint[] {
  const out: bigint[] = []
  if (!spanning) {
    const perLong = Math.floor(64 / bits)
    for (let i = 0; i < values.length; i += perLong) {
      let word = 0n
      for (let j = 0; j < perLong && i + j < values.length; j++) word |= BigInt(values[i + j]) << BigInt(j * bits)
      out.push(BigInt.asIntN(64, word))
    }
    return out
  }
  const total = Math.ceil(values.length * bits / 64), words = new Array<bigint>(total).fill(0n)
  values.forEach((value, i) => {
    const bit = i * bits, index = bit >> 6, offset = bit & 63
    words[index] |= (BigInt(value) << BigInt(offset)) & ((1n << 64n) - 1n)
    if (offset + bits > 64) words[index + 1] |= BigInt(value) >> BigInt(64 - offset)
  })
  return words.map(word => BigInt.asIntN(64, word))
}
function regionFile(chunks: Array<{ index: number; nbt: Buffer }>): Buffer {
  const header = Buffer.alloc(8192)
  const bodies: Buffer[] = []
  let sector = 2
  for (const chunk of chunks) {
    const compressed = zlib.deflateSync(chunk.nbt)
    const body = Buffer.concat([Buffer.alloc(4), Buffer.from([2]), compressed])
    body.writeUInt32BE(compressed.length + 1, 0)
    const sectors = Math.ceil(body.length / 4096)
    const padded = Buffer.alloc(sectors * 4096); body.copy(padded)
    header.writeUInt32BE((sector << 8) | sectors, chunk.index * 4)
    bodies.push(padded); sector += sectors
  }
  return Buffer.concat([header, ...bodies])
}
function decodePng(png: Uint8Array): Uint8Array {
  const buffer = Buffer.from(png)
  assert.deepEqual([...buffer.subarray(1, 4)], [0x50, 0x4e, 0x47])
  let offset = 8; const idat: Buffer[] = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), out = new Uint8Array(512 * 512 * 4)
  for (let y = 0; y < 512; y++) raw.copy(Buffer.from(out.buffer), y * 2048, y * 2049 + 1, y * 2049 + 2049)
  return out
}
const pixel = (rgba: Uint8Array, x: number, z: number) => [...rgba.subarray((z * 512 + x) * 4, (z * 512 + x) * 4 + 4)]

async function world(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-map-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

function modernChunk(chunkX: number, chunkZ: number) {
  // Section Y=4 covers y 64..79. Column (0,0) is water over sand, everything else grass at y=64.
  const palette = ['minecraft:air', 'minecraft:grass_block', 'minecraft:water', 'minecraft:sand']
  const blocks = new Array(4096).fill(0)
  const at = (x: number, y: number, z: number) => ((y - 64) * 16 + z) * 16 + x
  const heights: number[] = []
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    if (x === 0 && z === 0) { blocks[at(x, 64, z)] = 3; blocks[at(x, 65, z)] = 2; blocks[at(x, 66, z)] = 2; heights.push(66 + 64 + 1) }
    else { blocks[at(x, 64, z)] = 1; heights.push(64 + 64 + 1) }
  }
  return nbtFile(comp({
    DataVersion: int(3955), xPos: int(chunkX), zPos: int(chunkZ), yPos: int(-4), Status: str('minecraft:full'),
    Heightmaps: comp({ WORLD_SURFACE: longs(pack(heights, 9, false)) }),
    sections: listOf(10, [comp({ Y: byte(4), block_states: comp({ palette: listOf(10, palette.map(name => comp({ Name: str(name) }))), data: longs(pack(blocks, 4, false)) }) })]),
  }))
}

test('NBT parser reads compounds, lists and long arrays', () => {
  const parsed = parseNbt(nbtFile(comp({ a: int(5), b: listOf(8, [str('x')]), c: longs([1n, -2n]), d: comp({ e: double(1.5) }) })))
  assert.equal(parsed.a, 5); assert.deepEqual(parsed.b, ['x']); assert.deepEqual([...(parsed.c as BigInt64Array)], [1n, -2n])
  assert.equal((parsed.d as { e: number }).e, 1.5)
  assert.throws(() => parseNbt(Buffer.from([10, 0, 0, 3])), /提前结束/)
})

test('block colours cover common blocks, dyes, woods and treat air as transparent', () => {
  assert.deepEqual(blockColor('minecraft:grass_block'), [112, 156, 72])
  assert.equal(blockColor('minecraft:air'), null)
  assert.notEqual(blockColor('minecraft:red_wool'), null)
  assert.notEqual(blockColor('minecraft:cherry_planks'), null)
  assert.notEqual(blockColor('somemod:strange_block'), null)
})

test('modern 1.18+ chunks render grass, water depth and spawn info from level.dat', async t => {
  const root = await world(t)
  await fs.mkdir(path.join(root, 'region'), { recursive: true })
  await fs.writeFile(path.join(root, 'region', 'r.0.0.mca'), regionFile([{ index: 0, nbt: modernChunk(0, 0) }, { index: 33, nbt: modernChunk(1, 1) }]))
  await fs.writeFile(path.join(root, 'region', 'r.-1.0.mca'), Buffer.alloc(100))
  await fs.writeFile(path.join(root, 'level.dat'), zlib.gzipSync(nbtFile(comp({ Data: comp({ SpawnX: int(8), SpawnZ: int(-3),
    Player: comp({ Pos: listOf(6, [double(10.5), double(70), double(20.2)]), Dimension: str('minecraft:overworld') }) }) }))))
  const info = await readWorldMapInfo(root)
  assert.deepEqual(info.spawn, { x: 8, z: -3 })
  assert.deepEqual(info.player, { x: 10, z: 20, dimension: 'overworld' })
  assert.deepEqual(info.dimensions.overworld, [{ x: 0, z: 0 }])
  assert.deepEqual(info.dimensions.nether, [])
  const tile = await renderRegionTile(root, 'overworld', 0, 0)
  assert.equal(tile.chunks, 2)
  const rgba = decodePng(tile.png)
  assert.deepEqual(pixel(rgba, 5, 5), [112, 156, 72, 255])
  const waterPixel = pixel(rgba, 0, 0)
  assert.equal(waterPixel[3], 255); assert.ok(waterPixel[2] > waterPixel[0], 'water is blue')
  assert.deepEqual(pixel(rgba, 20, 20), [112, 156, 72, 255])
  assert.equal(pixel(rgba, 40, 5)[3], 0, 'missing chunks are transparent')
  const empty = await renderRegionTile(root, 'overworld', 5, 5)
  assert.equal(empty.chunks, 0)
})

test('1.13-1.15 spanning palettes and pre-1.13 numeric chunks both render', async t => {
  const root = await world(t)
  await fs.mkdir(path.join(root, 'region'), { recursive: true })
  const palette = ['minecraft:air', 'minecraft:stone', 'minecraft:sand', 'minecraft:snow_block', 'minecraft:oak_planks']
  const blocks = new Array(4096).fill(0)
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) blocks[(0 * 16 + z) * 16 + x] = x < 8 ? 2 : 3
  const heights = new Array(256).fill(0).map(() => 4 + 1)
  const spanningChunk = nbtFile(comp({ DataVersion: int(1976), Level: comp({ xPos: int(0), zPos: int(0), Status: str('full'),
    Heightmaps: comp({ WORLD_SURFACE: longs(pack(heights, 9, true)) }),
    Sections: listOf(10, [comp({ Y: byte(0), Palette: listOf(10, palette.map(name => comp({ Name: str(name) }))), BlockStates: longs(pack(blocks, 4, true)) })]) }) }))
  // Spanning packing with 5 palette bits is the tricky case; place the target block at y=4.
  const blocks5 = new Array(4096).fill(0)
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) blocks5[(4 * 16 + z) * 16 + x] = x < 8 ? 2 : 3
  const bigPalette = [...palette, ...Array.from({ length: 12 }, (_, i) => `minecraft:filler_${i}`)]
  const spanning5 = nbtFile(comp({ DataVersion: int(1976), Level: comp({ xPos: int(1), zPos: int(0), Status: str('full'),
    Heightmaps: comp({ WORLD_SURFACE: longs(pack(heights, 9, true)) }),
    Sections: listOf(10, [comp({ Y: byte(0), Palette: listOf(10, bigPalette.map(name => comp({ Name: str(name) }))), BlockStates: longs(pack(blocks5, 5, true)) })]) }) }))
  const legacyBlocks = new Array(4096).fill(0)
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) legacyBlocks[(2 * 16 + z) * 16 + x] = 12
  const legacyChunk = nbtFile(comp({ Level: comp({ xPos: int(2), zPos: int(0), HeightMap: ints(new Array(256).fill(3)),
    Sections: listOf(10, [comp({ Y: byte(0), Blocks: bytes(legacyBlocks.map(v => v > 127 ? v - 256 : v)) })]) }) }))
  await fs.writeFile(path.join(root, 'region', 'r.0.0.mca'), regionFile([{ index: 0, nbt: spanningChunk }, { index: 1, nbt: spanning5 }, { index: 2, nbt: legacyChunk }]))
  const rgba = decodePng((await renderRegionTile(root, 'overworld', 0, 0)).png)
  assert.deepEqual(pixel(rgba, 7, 3).slice(0, 3), blockColor('minecraft:sand'))
  assert.deepEqual(pixel(rgba, 9, 3).slice(0, 3), blockColor('minecraft:snow_block'))
  assert.deepEqual(pixel(rgba, 16 + 7, 3).slice(0, 3), blockColor('minecraft:sand'))
  assert.deepEqual(pixel(rgba, 16 + 9, 3).slice(0, 3), blockColor('minecraft:snow_block'))
  assert.deepEqual(pixel(rgba, 32 + 4, 3).slice(0, 3), blockColor('minecraft:sand'))
})

test('corrupt chunks are skipped and invalid coordinates rejected', async t => {
  const root = await world(t)
  await fs.mkdir(path.join(root, 'region'), { recursive: true })
  const region = regionFile([{ index: 0, nbt: modernChunk(0, 0) }, { index: 1, nbt: modernChunk(1, 0) }])
  region[8192 + 4096 + 10] ^= 0xff // corrupt the second chunk's compressed body
  await fs.writeFile(path.join(root, 'region', 'r.0.0.mca'), region)
  const tile = await renderRegionTile(root, 'overworld', 0, 0)
  assert.equal(tile.chunks, 1)
  await assert.rejects(renderRegionTile(root, 'overworld', 1.5, 0), /坐标/)
})
