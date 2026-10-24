import type { DatapackCompatibility, DatapackMetadata, DatapackInspectionStatus } from './datapack-types'

// Exact release adapters only. Never infer adjacent patch versions, snapshots,
// DataVersion or resource-pack format. Primary sources are recorded in docs.
export const DATAPACK_VERSION_ADAPTERS = Object.freeze({
  '1.20.1': { major: 15, minor: 0, generation: 'single' },
  '1.20.2': { major: 18, minor: 0, generation: 'range' },
  '1.21': { major: 48, minor: 0, generation: 'range' },
  '1.21.1': { major: 48, minor: 0, generation: 'range' },
  '1.21.9': { major: 88, minor: 0, generation: 'minor' },
} as const)

export function datapackCompatibility(
  metadata: DatapackMetadata | undefined, version?: string, inspectionStatus: DatapackInspectionStatus = 'checked',
): DatapackCompatibility {
  const base = version ? { version } : {}
  const unknown = (message: string): DatapackCompatibility => ({ ...base, status: 'unknown', message })
  if (inspectionStatus !== 'checked' || !metadata) return unknown('尚未完成可用的元数据检查，兼容性未知')
  if (!version || !Object.hasOwn(DATAPACK_VERSION_ADAPTERS, version)) return unknown('此确切游戏版本的格式映射尚未核实，兼容性未知')
  const adapter = DATAPACK_VERSION_ADAPTERS[version as keyof typeof DATAPACK_VERSION_ADAPTERS]
  const expectedFormat = `${adapter.major}${adapter.generation === 'minor' ? `.${adapter.minor}` : ''}`
  const result = (status: DatapackCompatibility['status'], message: string) => ({ ...base, expectedFormat, status, message })
  if (metadata.features.length || metadata.overlays.length || metadata.warnings.length) {
    return result('unknown', '包含未完整解释的特性、叠加层或扩展字段，兼容性未知')
  }
  let fits: boolean
  if (adapter.generation === 'single') {
    if (metadata.packFormat === undefined) return result('declared-incompatible', '此游戏版本要求 pack_format，当前声明未提供')
    // supported_formats was introduced in 1.20.2 and cannot expand 1.20.1's
    // accepted declaration. Unresolved extension behavior remains unknown.
    if (metadata.supportedFormats) return result('unknown', '此旧版本不使用 supported_formats，本版不确认带此字段的旧版安装')
    fits = metadata.packFormat === adapter.major
  } else if (adapter.generation === 'range') {
    if (metadata.packFormat === undefined) return result('declared-incompatible', '此游戏版本要求 pack_format，当前声明未提供')
    const range = metadata.supportedFormats ?? [metadata.packFormat, metadata.packFormat]
    if (metadata.packFormat < range[0] || metadata.packFormat > range[1]) return result('unknown', 'supported_formats 未包含 pack_format，无法确认声明')
    fits = range[0] <= adapter.major && adapter.major <= range[1]
  } else {
    const minimum = metadata.minFormat, maximum = metadata.maxFormat
    if (!minimum || !maximum) return result('declared-incompatible', '此游戏版本要求 min_format 与 max_format，当前声明不完整')
    if (minimum[0] < 82) {
      const old = metadata.supportedFormats
      if (metadata.packFormat === undefined || !old || metadata.packFormat < old[0] || metadata.packFormat > old[1]) {
        return result('unknown', '声明跨越旧格式，但缺少有效的旧版格式字段')
      }
    } else if (metadata.supportedFormats) return result('unknown', '仅支持新格式的声明仍含 supported_formats，无法确认声明')
    const maxMinor = maximum[1] ?? 0x7fffffff
    if (minimum[0] > maximum[0] || minimum[0] === maximum[0] && minimum[1] > maxMinor) return result('unknown', '格式范围顺序无效')
    fits = (minimum[0] < adapter.major || minimum[0] === adapter.major && minimum[1] <= adapter.minor) &&
      (maximum[0] > adapter.major || maximum[0] === adapter.major && maxMinor >= adapter.minor)
  }
  return fits ? result('declared-compatible', '格式声明包含此版本；不代表实际内容、依赖或加载已验证') :
    result('declared-incompatible', '格式声明不包含此版本')
}
