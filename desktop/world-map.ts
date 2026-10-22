import * as fs from 'node:fs/promises'
import path from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import zlib from 'node:zlib'
import { crc32 } from './world-zip'
import { blockColor, isWater, legacyBlockName } from './map-colors'
import { compound, int, list, parseNbt, type NbtCompound, type NbtValue } from './nbt'

/*
 * Read-only top-down map preview. Region files (.mca) are read whole (bounded), chunks are
 * inflated and parsed one by one, and each 512×512 region becomes a PNG tile. Supports the
 * palette chunk formats of 1.13 and later (including 1.18+ "sections") and the numeric-ID
 * format of older versions. Nothing in the world folder is ever written.
 */
export type MapDimension = 'overworld' | 'nether' | 'end'
export interface MapRegion { x: number; z: number }
export interface WorldMapInfo {
  spawn: { x: number; z: number }
  player?: { x: number; z: number; dimension: MapDimension }
  dimensions: Record<MapDimension, MapRegion[]>
}
export interface MapTile { png: Uint8Array; chunks: number }

const REGION_LIMIT_BYTES = 192 * 1024 * 1024
const CHUNK_LIMIT_BYTES = 8 * 1024 * 1024
const MAX_REGIONS = 4096

const dimensionFolders: Record<MapDimension, string[]> = {
  overworld: ['region', 'dimensions/minecraft/overworld/region'],
  nether: ['DIM-1/region', 'dimensions/minecraft/the_nether/region'],
  end: ['DIM1/region', 'dimensions/minecraft/the_end/region'],
}

async function regionFolder(world: string, dimension: MapDimension): Promise<string | undefined> {
  for (const relative of dimensionFolders[dimension]) {
    const folder = path.join(world, ...relative.split('/'))
    try { if ((await fs.lstat(folder)).isDirectory()) return folder } catch { /* try next layout */ }
  }
  return undefined
}

async function listRegions(world: string, dimension: MapDimension): Promise<MapRegion[]> {
  const folder = await regionFolder(world, dimension)
  if (!folder) return []
  const regions: MapRegion[] = []
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const match = /^r\.(-?\d{1,6})\.(-?\d{1,6})\.mca$/.exec(entry.name)
    if (!match || !entry.isFile()) continue
    try { if ((await fs.stat(path.join(folder, entry.name))).size <= 8192) continue } catch { continue }
    regions.push({ x: Number(match[1]), z: Number(match[2]) })
    if (regions.length >= MAX_REGIONS) break
  }
  return regions.sort((a, b) => a.x - b.x || a.z - b.z)
}

const dimensionOf = (value: NbtValue | undefined): MapDimension => {
  if (value === -1 || value === 'minecraft:the_nether' || value === 'the_nether') return 'nether'
  if (value === 1 || value === 'minecraft:the_end' || value === 'the_end') return 'end'
  return 'overworld'
}

export async function readWorldMapInfo(world: string): Promise<WorldMapInfo> {
  let spawn = { x: 0, z: 0 }, player: WorldMapInfo['player']
  try {
    const raw = await fs.readFile(path.join(world, 'level.dat'))
    if (raw.length > 8 * 1024 * 1024) throw new Error('too large')
    const data = compound(parseNbt(zlib.gunzipSync(raw, { maxOutputLength: 32 * 1024 * 1024 })).Data)
    if (data) {
      const nested = compound(data.spawn)
      const pos = nested ? list(nested.pos) : []
      const sx = int(data.SpawnX) ?? int(pos[0]), sz = int(data.SpawnZ) ?? int(pos[2])
      if (sx !== undefined && sz !== undefined) spawn = { x: sx, z: sz }
      const playerData = compound(data.Player)
      const position = playerData ? list(playerData.Pos) : []
      if (position.length === 3 && typeof position[0] === 'number' && typeof position[2] === 'number') {
        player = { x: Math.floor(position[0]), z: Math.floor(position[2]), dimension: dimensionOf(playerData?.Dimension) }
      }
    }
  } catch { /* level.dat unreadable: still show regions around 0,0 */ }
  const [overworld, nether, end] = await Promise.all((['overworld', 'nether', 'end'] as const).map(dimension => listRegions(world, dimension)))
  return { spawn, ...(player ? { player } : {}), dimensions: { overworld, nether, end } }
}

// ---------------------------------------------------------------- chunk decoding
function unpack(data: BigInt64Array | undefined, bits: number, count: number, spanning: boolean): Uint16Array {
  const out = new Uint16Array(count)
  if (!data || bits <= 0 || bits > 16) return out
  const words = new Uint32Array(data.buffer, data.byteOffset, data.length * 2)
  const mask = (1 << bits) - 1
  const read = (word: number, offset: number) => {
    const lo = words[word * 2], hi = words[word * 2 + 1]
    if (offset + bits <= 32) return (lo >>> offset) & mask
    if (offset >= 32) return (hi >>> (offset - 32)) & mask
    return ((lo >>> offset) | (hi << (32 - offset))) & mask
  }
  if (!spanning) {
    const perLong = Math.floor(64 / bits)
    for (let i = 0, word = 0, slot = 0; i < count && word < data.length; i++) {
      out[i] = read(word, slot * bits)
      if (++slot === perLong) { slot = 0; word++ }
    }
  } else {
    for (let i = 0; i < count; i++) {
      const bit = i * bits, word = bit >> 6, offset = bit & 63
      if (word >= data.length) break
      if (offset + bits <= 64) out[i] = read(word, offset)
      else {
        const first = 64 - offset
        const low = (words[word * 2 + 1] >>> (offset - 32)) & ((1 << first) - 1)
        const high = word + 1 < data.length ? words[(word + 1) * 2] & ((1 << (bits - first)) - 1) : 0
        out[i] = low | (high << first)
      }
    }
  }
  return out
}
const bitsFor = (size: number, minimum: number) => Math.max(minimum, Math.ceil(Math.log2(Math.max(2, size))))
/** Packed arrays carry their own width: derive it from the array length when possible. */
function widthOf(data: BigInt64Array | undefined, count: number, spanning: boolean, fallback: number): number {
  if (!data) return fallback
  const fits = (bits: number) => data.length === (spanning ? Math.ceil(count * bits / 64) : Math.ceil(count / Math.floor(64 / bits)))
  if (fits(fallback)) return fallback
  for (let bits = 1; bits <= 32; bits++) if (fits(bits)) return bits
  return fallback
}

interface Section { palette: string[]; indices?: Uint16Array; raw?: BigInt64Array; bits?: number; spanning?: boolean; legacy?: Int8Array; legacyAdd?: Int8Array }
interface Chunk { x: number; z: number; minY: number; maxY: number; heights?: Uint16Array; sections: Map<number, Section>; spanning: boolean; legacy: boolean }

function decodeChunk(root: NbtCompound): Chunk | undefined {
  const level = compound(root.Level) ?? root
  const dataVersion = int(root.DataVersion) ?? int(level.DataVersion) ?? 0
  const status = typeof level.Status === 'string' ? level.Status.replace('minecraft:', '') : undefined
  if (status && !['full', 'postprocessed', 'fullchunk', 'heightmaps', 'spawn', 'light', 'features', 'surface', 'liquid_carvers', 'carvers', 'initialize_light'].includes(status)) return undefined
  const x = int(level.xPos), z = int(level.zPos)
  if (x === undefined || z === undefined) return undefined
  const spanning = dataVersion < 2527
  const sections = new Map<number, Section>()
  const modern = list(level.sections)
  const legacyList = list(level.Sections)
  let legacy = false
  for (const raw of modern.length ? modern : legacyList) {
    const section = compound(raw)
    if (!section) continue
    const y = int(section.Y)
    if (y === undefined) continue
    const states = compound(section.block_states)
    if (states) {
      const palette = list(states.palette).map(entry => { const name = compound(entry)?.Name; return typeof name === 'string' ? name : 'minecraft:air' })
      sections.set(y, { palette, ...(palette.length > 1 ? { raw: states.data as BigInt64Array | undefined, bits: widthOf(states.data as BigInt64Array | undefined, 4096, false, bitsFor(palette.length, 4)), spanning: false } : {}) })
    } else if (Array.isArray(section.Palette)) {
      const palette = list(section.Palette).map(entry => { const name = compound(entry)?.Name; return typeof name === 'string' ? name : 'minecraft:air' })
      sections.set(y, { palette, ...(palette.length > 1 ? { raw: section.BlockStates as BigInt64Array | undefined, bits: widthOf(section.BlockStates as BigInt64Array | undefined, 4096, spanning, bitsFor(palette.length, 4)), spanning } : {}) })
    } else if (section.Blocks instanceof Int8Array) {
      legacy = true
      sections.set(y, { palette: [], legacy: section.Blocks, ...(section.Add instanceof Int8Array ? { legacyAdd: section.Add } : {}) })
    }
  }
  if (!sections.size) return undefined
  const yPos = int(level.yPos)
  const minY = yPos !== undefined ? yPos * 16 : dataVersion >= 2825 ? -64 : 0
  const maxSection = Math.max(...sections.keys())
  const maxY = (maxSection + 1) * 16 - 1
  let heights: Uint16Array | undefined
  const heightmaps = compound(level.Heightmaps)
  const surface = heightmaps?.WORLD_SURFACE ?? heightmaps?.MOTION_BLOCKING
  if (surface instanceof BigInt64Array) heights = unpack(surface, widthOf(surface, 256, spanning, 9), 256, spanning)
  else if (level.HeightMap instanceof Int32Array && level.HeightMap.length === 256) heights = Uint16Array.from(level.HeightMap, value => Math.max(0, value))
  return { x, z, minY, maxY, heights, sections, spanning, legacy }
}

function blockAt(chunk: Chunk, x: number, y: number, z: number): string {
  const section = chunk.sections.get(Math.floor(y / 16))
  if (!section) return 'minecraft:air'
  const index = ((y & 15) * 16 + z) * 16 + x
  if (section.legacy) {
    let id = section.legacy[index] & 0xff
    if (section.legacyAdd) id |= ((section.legacyAdd[index >> 1] >> ((index & 1) * 4)) & 0xf) << 8
    return legacyBlockName(id)
  }
  if (section.bits && !section.indices) section.indices = unpack(section.raw, section.bits, 4096, Boolean(section.spanning))
  if (!section.indices) return section.palette[0] ?? 'minecraft:air'
  return section.palette[section.indices[index]] ?? 'minecraft:air'
}

// ---------------------------------------------------------------- rendering
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1')
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

function inflateChunk(region: Buffer, index: number): Buffer | undefined {
  const location = region.readUInt32BE(index * 4)
  const offset = (location >>> 8) * 4096, sectors = location & 0xff
  if (!offset || !sectors || offset + 5 > region.length) return undefined
  const length = region.readUInt32BE(offset)
  const compression = region[offset + 4]
  if (length < 1 || length > CHUNK_LIMIT_BYTES || offset + 4 + length > region.length || compression & 0x80) return undefined
  const data = region.subarray(offset + 5, offset + 4 + length)
  const limit = { maxOutputLength: 64 * 1024 * 1024 }
  if (compression === 1) return zlib.gunzipSync(data, limit)
  if (compression === 2) return zlib.inflateSync(data, limit)
  if (compression === 3) return Buffer.from(data)
  return undefined
}

export async function renderRegionTile(world: string, dimension: MapDimension, regionX: number, regionZ: number, signal?: AbortSignal): Promise<MapTile> {
  if (!Number.isInteger(regionX) || !Number.isInteger(regionZ) || Math.abs(regionX) > 1e6 || Math.abs(regionZ) > 1e6) throw new Error('区域坐标无效')
  const folder = await regionFolder(world, dimension)
  const rgba = new Uint8Array(512 * 512 * 4)
  const heights = new Int16Array(512 * 512).fill(-32768)
  const water = new Uint8Array(512 * 512)
  let rendered = 0
  if (folder) {
    const file = path.join(folder, `r.${regionX}.${regionZ}.mca`)
    let region: Buffer | undefined
    try {
      const info = await fs.lstat(file)
      if (info.isFile() && info.size > 8192 && info.size <= REGION_LIMIT_BYTES) region = await fs.readFile(file)
    } catch { region = undefined }
    for (let index = 0; region && index < 1024; index++) {
      signal?.throwIfAborted()
      if (index % 32 === 0) await yieldTurn()
      let chunk: Chunk | undefined
      try {
        const bytes = inflateChunk(region, index)
        chunk = bytes ? decodeChunk(parseNbt(bytes)) : undefined
      } catch { chunk = undefined }
      if (!chunk) continue
      const localX = index & 31, localZ = index >> 5
      rendered++
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        let y: number
        if (dimension === 'nether') {
          y = Math.min(chunk.maxY, 127)
          while (y > chunk.minY && blockColor(blockAt(chunk, x, y, z)) !== null) y--
          while (y > chunk.minY && blockColor(blockAt(chunk, x, y, z)) === null) y--
        } else if (chunk.heights) {
          y = chunk.minY + chunk.heights[z * 16 + x] - 1
        } else {
          y = chunk.maxY
          while (y > chunk.minY && blockColor(blockAt(chunk, x, y, z)) === null) y--
        }
        let name = blockAt(chunk, x, y, z)
        // Skip transparent tops the heightmap can report (e.g. barriers or glass panes).
        for (let guard = 0; guard < 4 && blockColor(name) === null && y > chunk.minY; guard++) name = blockAt(chunk, x, --y, z)
        let color = blockColor(name)
        if (!color) continue
        const pixel = (localZ * 16 + z) * 512 + localX * 16 + x
        let [r, g, b] = color
        if (isWater(name)) {
          let depth = 0
          while (depth < 24 && y - depth - 1 > chunk.minY && isWater(blockAt(chunk, x, y - depth - 1, z))) depth++
          const floor = blockColor(blockAt(chunk, x, y - depth - 1, z)) ?? color
          const t = Math.min(1, 0.45 + depth / 20)
          r = floor[0] * (1 - t) + r * t; g = floor[1] * (1 - t) + g * t; b = floor[2] * (1 - t) + b * t
          const shade = 1 - Math.min(0.35, depth / 50)
          r *= shade; g *= shade; b *= shade
          water[pixel] = 1
        }
        rgba[pixel * 4] = r; rgba[pixel * 4 + 1] = g; rgba[pixel * 4 + 2] = b; rgba[pixel * 4 + 3] = 255
        heights[pixel] = y
      }
    }
  }
  // Relief shading against the northern neighbour, like in-game maps.
  for (let z = 1; z < 512; z++) for (let x = 0; x < 512; x++) {
    const pixel = z * 512 + x, here = heights[pixel], north = heights[pixel - 512]
    if (here === -32768 || north === -32768 || water[pixel]) continue
    const factor = here > north ? 1.1 : here < north ? 0.84 : 1
    if (factor === 1) continue
    for (let channel = 0; channel < 3; channel++) rgba[pixel * 4 + channel] = Math.min(255, rgba[pixel * 4 + channel] * factor)
  }
  return { png: new Uint8Array(encodePng(512, 512, rgba)), chunks: rendered }
}
