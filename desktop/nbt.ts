/**
 * Small, bounded, general NBT parser used for map rendering (region chunks and level.dat).
 * Compounds become plain objects, lists become arrays, numeric arrays become typed views.
 * Long arrays are returned as BigInt64Array; everything is read big-endian (Java edition).
 */
export type NbtValue = number | bigint | string | NbtValue[] | NbtCompound | Int8Array | Int32Array | BigInt64Array
export interface NbtCompound { [key: string]: NbtValue }

export class NbtError extends Error {}
const LIMITS = { depth: 64, listLength: 1 << 20, arrayLength: 1 << 24, stringBytes: 1 << 16 }
const decoder = new TextDecoder('utf-8', { fatal: false })

export function parseNbt(buffer: Uint8Array): NbtCompound {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let position = 0
  const need = (bytes: number) => { if (position + bytes > buffer.byteLength) throw new NbtError('NBT 数据提前结束') }
  const u8 = () => { need(1); return view.getUint8(position++) }
  const i16 = () => { need(2); const value = view.getInt16(position); position += 2; return value }
  const i32 = () => { need(4); const value = view.getInt32(position); position += 4; return value }
  const string = () => {
    need(2); const length = view.getUint16(position); position += 2
    need(length); const value = decoder.decode(buffer.subarray(position, position + length)); position += length
    return value
  }
  const length = (max: number) => { const value = i32(); if (value < 0 || value > max) throw new NbtError('NBT 数组长度无效'); return value }
  function payload(type: number, depth: number): NbtValue {
    if (depth > LIMITS.depth) throw new NbtError('NBT 嵌套过深')
    switch (type) {
      case 1: { need(1); return view.getInt8(position++) }
      case 2: return i16()
      case 3: return i32()
      case 4: { need(8); const value = view.getBigInt64(position); position += 8; return value }
      case 5: { need(4); const value = view.getFloat32(position); position += 4; return value }
      case 6: { need(8); const value = view.getFloat64(position); position += 8; return value }
      case 7: {
        const count = length(LIMITS.arrayLength); need(count)
        const value = new Int8Array(buffer.buffer, buffer.byteOffset + position, count); position += count
        return value
      }
      case 8: return string()
      case 9: {
        const itemType = u8(), count = length(LIMITS.listLength)
        const items: NbtValue[] = []
        for (let i = 0; i < count; i++) items.push(payload(itemType, depth + 1))
        return items
      }
      case 10: {
        const compound: NbtCompound = Object.create(null)
        for (;;) {
          const tag = u8()
          if (tag === 0) return compound
          const name = string()
          compound[name] = payload(tag, depth + 1)
        }
      }
      case 11: {
        const count = length(LIMITS.arrayLength); need(count * 4)
        const value = new Int32Array(count)
        for (let i = 0; i < count; i++) value[i] = view.getInt32(position + i * 4)
        position += count * 4
        return value
      }
      case 12: {
        const count = length(LIMITS.arrayLength); need(count * 8)
        const value = new BigInt64Array(count)
        // Fill through a 32-bit view (little-endian hosts) to avoid creating a BigInt per element.
        const words = new Uint32Array(value.buffer)
        for (let i = 0; i < count; i++) { words[i * 2 + 1] = view.getUint32(position + i * 8); words[i * 2] = view.getUint32(position + i * 8 + 4) }
        position += count * 8
        return value
      }
      default: throw new NbtError(`未知的 NBT 类型 ${type}`)
    }
  }
  const rootType = u8()
  if (rootType !== 10) throw new NbtError('NBT 根节点不是复合标签')
  string()
  return payload(10, 0) as NbtCompound
}

export const compound = (value: NbtValue | undefined): NbtCompound | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value) ? value as NbtCompound : undefined
export const list = (value: NbtValue | undefined): NbtValue[] => Array.isArray(value) ? value : []
export const int = (value: NbtValue | undefined): number | undefined =>
  typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : undefined
