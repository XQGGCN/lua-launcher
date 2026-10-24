import { normalizeSettingsQuery } from './settings-search'

export type InstanceSettingsTargetKey = 'instance.name' | 'instance.java' | 'instance.memory-mode' | 'instance.memory-limit' |
  'instance.jvm' | 'instance.width' | 'instance.height' | 'instance.fullscreen' | 'instance.revert' | 'instance.inherit'
export type InstanceSettingsSearchSection = '常用设置' | '高级设置' | '恢复操作'
export type InstanceSettingsSearchKind = 'saved-instance-option' | 'explicit-action'
export interface InstanceSettingsSearchDescriptor {
  readonly targetKey: InstanceSettingsTargetKey
  readonly label: string
  readonly section: InstanceSettingsSearchSection
  readonly kind: InstanceSettingsSearchKind
  readonly aliases: readonly string[]
  readonly advanced: boolean
}
export interface InstanceSettingsSearchContext {
  ownerMatches: boolean
  locked: boolean
  busy: 'save' | 'pick' | 'detect' | null
  hasPicker: boolean
  hasDetect: boolean
}
export interface InstanceSettingsSearchItem extends InstanceSettingsSearchDescriptor {
  readonly availability: 'available' | 'unavailable' | 'unknown'
  readonly availabilityText: string
  readonly effectLabel: string
}
export interface InstanceSettingsSearchResult {
  readonly query: string
  readonly total: number
  readonly items: readonly InstanceSettingsSearchItem[]
  readonly page: 0
  readonly pageSize: 10
  readonly pageCount: 0 | 1
}
export const INSTANCE_SETTINGS_SEARCH_LIMITS = Object.freeze({ queryCodePoints: 100, targets: 10, aliasesPerTarget: 12, descriptorCodePoints: 64, dtoBytes: 16 * 1024 })
export const INSTANCE_SETTINGS_SEARCH_SCOPE = '搜索当前实例这页已有运行设置；点击只定位，不修改、不保存。高级结果可以展开高级设置。'
/** Exactly the global search's existing finite query rules; no second normalization policy. */
export const normalizeInstanceSettingsQuery = normalizeSettingsQuery

// These describe the existing instance page only. Do not add values from name, Java
// paths, runtime arrays, JVM text, saved effective values, diagnostics or account data.
const descriptors: InstanceSettingsSearchDescriptor[] = [
  { targetKey: 'instance.name', label: '实例名称', section: '常用设置', kind: 'saved-instance-option', advanced: false, aliases: ['重命名', '显示名称', '名字'] },
  { targetKey: 'instance.java', label: 'Java 选择', section: '常用设置', kind: 'saved-instance-option', advanced: false, aliases: ['运行环境', '继承全局Java', '本实例自动管理', '指定Java路径', 'java.exe', '可执行文件', '浏览Java', '检测Java'] },
  { targetKey: 'instance.memory-mode', label: '内存分配方式', section: '常用设置', kind: 'saved-instance-option', advanced: false, aliases: ['自动内存', '本实例自动分配', '手动分配方式', 'RAM'] },
  { targetKey: 'instance.memory-limit', label: '手动内存上限', section: '常用设置', kind: 'saved-instance-option', advanced: false, aliases: ['内存上限', '内存MB', '手动堆上限', 'Xmx', 'GB'] },
  { targetKey: 'instance.jvm', label: 'JVM 参数', section: '高级设置', kind: 'saved-instance-option', advanced: true, aliases: ['自定义JVM', '每行一个', '虚拟机参数', 'argv', '系统属性', '本实例替换'] },
  { targetKey: 'instance.width', label: '窗口宽度', section: '高级设置', kind: 'saved-instance-option', advanced: true, aliases: ['游戏宽度', '宽度像素', '分辨率宽'] },
  { targetKey: 'instance.height', label: '窗口高度', section: '高级设置', kind: 'saved-instance-option', advanced: true, aliases: ['游戏高度', '高度像素', '分辨率高'] },
  { targetKey: 'instance.fullscreen', label: '全屏', section: '高级设置', kind: 'saved-instance-option', advanced: true, aliases: ['游戏全屏', '窗口模式', '继承全局全屏'] },
  { targetKey: 'instance.revert', label: '撤销到已保存设置', section: '恢复操作', kind: 'explicit-action', advanced: false, aliases: ['撤销更改', '恢复已保存', '撤销草稿'] },
  { targetKey: 'instance.inherit', label: '全部恢复继承', section: '恢复操作', kind: 'explicit-action', advanced: false, aliases: ['恢复继承', '继承全局', '恢复全部来源'] },
]
const targetKeys = new Set<string>()
if (descriptors.length !== INSTANCE_SETTINGS_SEARCH_LIMITS.targets) throw new Error('实例设置搜索索引无效。')
for (const entry of descriptors) {
  if (targetKeys.has(entry.targetKey) || entry.aliases.length > INSTANCE_SETTINGS_SEARCH_LIMITS.aliasesPerTarget || new Set(entry.aliases.map(normalizeSettingsQuery)).size !== entry.aliases.length ||
      [entry.label, entry.section, ...entry.aliases].some(value => !value || [...value].length > INSTANCE_SETTINGS_SEARCH_LIMITS.descriptorCodePoints || !normalizeSettingsQuery(value))) throw new Error('实例设置搜索索引无效。')
  targetKeys.add(entry.targetKey)
}
export const INSTANCE_SETTINGS_SEARCH_INDEX: readonly InstanceSettingsSearchDescriptor[] = Object.freeze(descriptors.map(entry => Object.freeze({ ...entry, aliases: Object.freeze([...entry.aliases]) })))
const indexed = INSTANCE_SETTINGS_SEARCH_INDEX.map(entry => ({ entry, label: normalizeSettingsQuery(entry.label), section: normalizeSettingsQuery(entry.section), aliases: entry.aliases.map(normalizeSettingsQuery) }))
function context(value: unknown): InstanceSettingsSearchContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('实例设置搜索状态无效，请重新打开实例设置。')
  const keys = ['ownerMatches', 'locked', 'busy', 'hasPicker', 'hasDetect'] as const
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(fields).length !== keys.length || Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !(keys as readonly string[]).includes(key) || !('value' in fields[key])) ||
      keys.some(key => !Object.hasOwn(fields, key)) || ['ownerMatches', 'locked', 'hasPicker', 'hasDetect'].some(key => typeof fields[key].value !== 'boolean') ||
      fields.busy.value !== null && (typeof fields.busy.value !== 'string' || !['save', 'pick', 'detect'].includes(fields.busy.value))) throw new Error('实例设置搜索状态无效，请重新打开实例设置。')
  // Only the own data fields just validated are consumed; inherited flags/getters
  // never become a second context. No real instance ID or draft value is accepted.
  return { ownerMatches: fields.ownerMatches.value, locked: fields.locked.value, busy: fields.busy.value, hasPicker: fields.hasPicker.value, hasDetect: fields.hasDetect.value }
}
function effectLabel(entry: InstanceSettingsSearchDescriptor): string {
  return entry.targetKey === 'instance.revert' ? '需单独点击原撤销按钮；定位不会撤销草稿' : entry.targetKey === 'instance.inherit' ?
    '需单独点击原恢复继承按钮；只改草稿，保存后生效' : '保存实例设置后生效 · 仅当前实例'
}
function availability(entry: InstanceSettingsSearchDescriptor, state: InstanceSettingsSearchContext): Pick<InstanceSettingsSearchItem, 'availability' | 'availabilityText'> {
  if (!state.ownerMatches) return { availability: 'unavailable', availabilityText: '草稿尚未对应当前实例，请等待准备完成；不能定位或修改其他实例。' }
  if (state.busy) {
    const action = { save: '保存此实例设置', pick: '选择 Java 文件', detect: '检测 Java' }[state.busy]
    return { availability: 'unavailable', availabilityText: `正在${action}，请等待完成；可查看原有说明，搜索不会发起操作。` }
  }
  if (state.locked) return { availability: 'unavailable', availabilityText: '当前实例设置已锁定；可定位查看原有说明，不能修改或保存。' }
  if (entry.targetKey === 'instance.java') {
    const tools = state.hasPicker && state.hasDetect ? '浏览文件和检测入口以原控件当前状态为准。' : state.hasPicker ? '当前提供浏览文件入口，不提供检测入口。' : state.hasDetect ? '当前提供检测入口，不提供浏览文件入口。' : '当前不提供浏览文件或检测入口，可在原控件手动填写路径。'
    return { availability: 'available', availabilityText: `定位 Java 选择方式；指定路径需手动选择本实例指定路径。${tools}搜索不会切换方式、选择文件或检测。` }
  }
  if (entry.targetKey === 'instance.memory-mode') return { availability: 'available', availabilityText: '分配方式与手动上限来源独立；搜索不会切换自动或手动分配。' }
  if (entry.targetKey === 'instance.memory-limit') return { availability: 'available', availabilityText: '手动上限需在原控件选择本实例设置；自动分配时仅保留该值，暂不用于分配。搜索不会改来源或数值。' }
  if (entry.advanced) return { availability: 'available', availabilityText: '显式定位可展开高级设置；只聚焦原来源选择器，不切换继承或本实例覆盖，不修改草稿。' }
  if (entry.kind === 'explicit-action') return { availability: 'available', availabilityText: '只定位原操作所在行；不会点击撤销或恢复继承按钮。' }
  return { availability: 'available', availabilityText: '只定位显示名称输入；不会修改名称、移动游戏目录或保存设置。' }
}
function rank(row: typeof indexed[number], query: string, tokens: string[]): number | undefined {
  const fields = [row.label, ...row.aliases, row.section]
  if (!tokens.every(token => fields.some(field => field.includes(token)))) return undefined
  if (row.label === query) return 0
  if (row.label.includes(query)) return 1
  if (row.aliases.some(alias => alias === query)) return 2
  if (row.aliases.some(alias => alias.includes(query))) return 3
  if (tokens.every(token => [row.label, ...row.aliases].some(field => field.includes(token)))) return 4
  return 5
}
/** Read-only fixed-index projection; UI separately verifies real owner, epoch and DOM. */
export function deriveInstanceSettingsResults(input: unknown, inputContext: InstanceSettingsSearchContext): InstanceSettingsSearchResult {
  const state = context(inputContext), query = normalizeSettingsQuery(input)
  if (!query) return { query, total: 0, items: [], page: 0, pageSize: 10, pageCount: 0 }
  const tokens = query.split(' ')
  const matches = indexed.map((row, index) => ({ row, index, rank: rank(row, query, tokens) }))
    .filter((match): match is typeof match & { rank: number } => match.rank !== undefined).sort((left, right) => left.rank - right.rank || left.index - right.index)
  const items: InstanceSettingsSearchItem[] = matches.slice(0, INSTANCE_SETTINGS_SEARCH_LIMITS.targets).map(({ row }) => ({ ...row.entry, aliases: [...row.entry.aliases], ...availability(row.entry, state), effectLabel: effectLabel(row.entry) }))
  const result: InstanceSettingsSearchResult = { query, total: items.length, items, page: 0, pageSize: 10, pageCount: items.length ? 1 : 0 }
  if (new TextEncoder().encode(JSON.stringify(result)).length > INSTANCE_SETTINGS_SEARCH_LIMITS.dtoBytes) throw new Error('实例设置搜索结果超限，请缩短搜索词。')
  return result
}
