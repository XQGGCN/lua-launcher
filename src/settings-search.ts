import type { WindowPreferencesStatus } from './api'

export type SettingsTargetKey = 'launcher.appearance' | 'launcher.minimize' | 'launcher.auto-update' | 'launcher.check-update' |
  'window.titlebar' | 'window.remember' | 'window.reset' | 'window.zoom' | 'game.memory' | 'game.java' |
  'game.java-detect' | 'game.java-download' | 'game.jvm' | 'game.width' | 'game.height' | 'game.fullscreen' | 'download.source' | 'download.parallel'
export type SettingsSearchSection = '启动器' | '启动器窗口' | '全局游戏运行' | 'JVM 与游戏窗口' | '下载与存储'
export type SettingsSearchKind = 'immediate-local' | 'separate-window-preference' | 'saved-game-default' | 'explicit-action'
export interface SettingsSearchDescriptor {
  readonly targetKey: SettingsTargetKey
  readonly label: string
  readonly aliases: readonly string[]
  readonly section: SettingsSearchSection
  readonly kind: SettingsSearchKind
}
export interface SettingsSearchItem extends SettingsSearchDescriptor {
  readonly availability: 'available' | 'unavailable' | 'unknown'
  readonly availabilityText: string
  readonly effectLabel: string
}
export interface SettingsSearchResult {
  readonly query: string
  readonly total: number
  readonly items: readonly SettingsSearchItem[]
  readonly page: 0
  readonly pageCount: 0 | 1
  readonly pageSize: 18
}
export interface SettingsSearchOptions {
  desktop: boolean
  windowStatus?: WindowPreferencesStatus | null
  windowBusy?: boolean
  gameSaving?: boolean
  checkingUpdate?: boolean
}
export const SETTINGS_SEARCH_LIMITS = Object.freeze({ queryCodePoints: 100, targets: 18, aliasesPerTarget: 12, descriptorCodePoints: 64, dtoBytes: 32 * 1024 })
export const SETTINGS_SEARCH_SCOPE = '搜索这页已有设置，不搜索实例、路径、账户或游戏文件。'
const queryError = '设置搜索词需为最多100个字符的文字，不能含控制字符；请缩短或修改后重试。'

/** No clipping or coercion: the caller retains the original input when validation fails. */
export function normalizeSettingsQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > SETTINGS_SEARCH_LIMITS.queryCodePoints * 2 ||
      [...value].length > SETTINGS_SEARCH_LIMITS.queryCodePoints || /[\p{Cc}\ud800-\udfff\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error(queryError)
  const normalized = value.normalize('NFC')
  if ([...normalized].length > SETTINGS_SEARCH_LIMITS.queryCodePoints) throw new Error(queryError)
  const folded = normalized.toLocaleLowerCase('zh-CN')
  if ([...folded].length > SETTINGS_SEARCH_LIMITS.queryCodePoints) throw new Error(queryError)
  return folded.trim().replace(/\s+/gu, ' ')
}

// These entries describe existing controls only. Never append runtime paths, user drafts,
// account values, errors, arbitrary DOM text or remote metadata to this index.
const descriptors: SettingsSearchDescriptor[] = [
  { targetKey: 'launcher.appearance', label: '外观', section: '启动器', kind: 'immediate-local', aliases: ['主题', '浅色', '深色', '跟随系统', 'theme', 'light', 'dark'] },
  { targetKey: 'launcher.minimize', label: '启动游戏后最小化启动器', section: '启动器', kind: 'immediate-local', aliases: ['收起', '最小化', '启动后', 'minimize'] },
  { targetKey: 'launcher.auto-update', label: '自动检查更新', section: '启动器', kind: 'immediate-local', aliases: ['自动检查新版本', 'GitHub', 'update'] },
  { targetKey: 'launcher.check-update', label: '检查更新 / 更新到已有版本', section: '启动器', kind: 'explicit-action', aliases: ['当前版本', '检查更新', '安装包', '更新提示'] },
  { targetKey: 'window.titlebar', label: '标题栏样式', section: '启动器窗口', kind: 'separate-window-preference', aliases: ['融合', '原生', '系统标题栏', 'titlebar'] },
  { targetKey: 'window.remember', label: '记住窗口大小、位置与最大化状态', section: '启动器窗口', kind: 'separate-window-preference', aliases: ['记住最大化状态', '窗口记忆', '位置', '大小', 'remember'] },
  { targetKey: 'window.reset', label: '恢复窗口摆放', section: '启动器窗口', kind: 'explicit-action', aliases: ['恢复默认大小', '恢复默认大小和位置', '窗口移回', 'reset'] },
  { targetKey: 'window.zoom', label: '界面缩放', section: '启动器窗口', kind: 'separate-window-preference', aliases: ['比例', '90%', '100%', '110%', '125%', '放大', '缩小', '恢复100%', 'zoom'] },
  { targetKey: 'game.memory', label: '内存分配', section: '全局游戏运行', kind: 'saved-game-default', aliases: ['自动内存', '手动内存', '手动内存上限', '内存上限', '最大堆', 'Xmx', 'RAM', 'MB', 'GB'] },
  { targetKey: 'game.java', label: 'Java 运行环境', section: '全局游戏运行', kind: 'saved-game-default', aliases: ['Java选择方式', '指定本机Java', '自动管理', 'Java路径', 'Java可执行文件路径', 'java.exe', '可执行文件', 'JRE', 'JDK'] },
  { targetKey: 'game.java-detect', label: '本机可用 Java', section: '全局游戏运行', kind: 'explicit-action', aliases: ['重新检测', '检测Java', '本机运行时', '本地Java'] },
  { targetKey: 'game.java-download', label: '提前下载 Java', section: '全局游戏运行', kind: 'explicit-action', aliases: ['安装Java', '准备运行时', '下载Java', 'Java17', 'Java21', 'Java25'] },
  { targetKey: 'game.jvm', label: '自定义 JVM 参数', section: 'JVM 与游戏窗口', kind: 'saved-game-default', aliases: ['虚拟机参数', 'JVM', 'argv', '启动参数', '每行一个', '系统属性'] },
  { targetKey: 'game.width', label: '全局窗口宽度', section: 'JVM 与游戏窗口', kind: 'saved-game-default', aliases: ['游戏宽度', '宽度像素', '分辨率宽', '1280'] },
  { targetKey: 'game.height', label: '全局窗口高度', section: 'JVM 与游戏窗口', kind: 'saved-game-default', aliases: ['游戏高度', '高度像素', '分辨率高', '720'] },
  { targetKey: 'game.fullscreen', label: '全屏状态', section: 'JVM 与游戏窗口', kind: 'saved-game-default', aliases: ['游戏全屏', '窗口模式', '沿用游戏设置', 'fullscreen'] },
  { targetKey: 'download.source', label: '下载源', section: '下载与存储', kind: 'saved-game-default', aliases: ['镜像', 'BMCLAPI', '国内', '官方优先', 'official', 'mirror'] },
  { targetKey: 'download.parallel', label: '并行下载数', section: '下载与存储', kind: 'saved-game-default', aliases: ['并发', '下载线程', '同时下载'] },
]
const keys = new Set<string>()
if (descriptors.length !== SETTINGS_SEARCH_LIMITS.targets) throw new Error('设置搜索索引无效。')
for (const entry of descriptors) {
  if (keys.has(entry.targetKey) || entry.aliases.length > SETTINGS_SEARCH_LIMITS.aliasesPerTarget ||
      new Set(entry.aliases.map(normalizeSettingsQuery)).size !== entry.aliases.length ||
      [entry.label, entry.section, ...entry.aliases].some(text => !text || [...text].length > SETTINGS_SEARCH_LIMITS.descriptorCodePoints || !normalizeSettingsQuery(text))) throw new Error('设置搜索索引无效。')
  keys.add(entry.targetKey)
}
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchDescriptor[] = Object.freeze(descriptors.map(entry => Object.freeze({ ...entry, aliases: Object.freeze([...entry.aliases]) })))
const indexed = SETTINGS_SEARCH_INDEX.map(entry => ({ entry, label: normalizeSettingsQuery(entry.label), section: normalizeSettingsQuery(entry.section), aliases: entry.aliases.map(normalizeSettingsQuery) }))
const effects: Record<SettingsSearchKind, string> = {
  'immediate-local': '立即生效 · 本机启动器偏好',
  'separate-window-preference': '窗口偏好单独保存，无需保存全局游戏设置',
  'saved-game-default': '保存设置后作为全局游戏默认值；实例覆盖保持不变',
  'explicit-action': '需要单独点击原操作按钮；搜索只定位',
}
const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}
function context(options: SettingsSearchOptions): SettingsSearchOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Reflect.ownKeys(options).some(key => typeof key !== 'string' || !['desktop', 'windowStatus', 'windowBusy', 'gameSaving', 'checkingUpdate'].includes(key) || !('value' in Object.getOwnPropertyDescriptor(options, key)!)) ||
      typeof own(options, 'desktop') !== 'boolean' || ['windowBusy', 'gameSaving', 'checkingUpdate'].some(key => own(options, key) !== undefined && typeof own(options, key) !== 'boolean')) throw new Error('设置搜索状态无效，请重新打开设置页。')
  // Consume the own fields just validated, not inherited optional values/getters.
  return { desktop: own(options, 'desktop') as boolean, windowStatus: own(options, 'windowStatus') as WindowPreferencesStatus | null | undefined,
    windowBusy: own(options, 'windowBusy') === true, gameSaving: own(options, 'gameSaving') === true, checkingUpdate: own(options, 'checkingUpdate') === true }
}
interface Availability { availability: SettingsSearchItem['availability']; availabilityText: string; label?: string }
function windowAvailability(entry: SettingsSearchDescriptor, options: SettingsSearchOptions): Availability {
  if (!options.desktop) return { availability: 'unavailable', availabilityText: '浏览器预览不支持真实窗口设置；可定位查看说明。' }
  const status = own(options, 'windowStatus'), zoom = own(status, 'zoom')
  if (options.windowBusy || own(zoom, 'busy') === true) return { availability: 'unavailable', availabilityText: '正在处理窗口偏好，请等待完成；可定位查看当前状态。' }
  if (!status || typeof status !== 'object' || Array.isArray(status)) return { availability: 'unknown', availabilityText: '窗口偏好尚未读取或读取失败；可定位查看原有状态与重试入口。' }
  if (entry.targetKey === 'window.titlebar') {
    const supported = own(status, 'supportsTitleBarStyle')
    return supported === false ? { availability: 'unavailable', availabilityText: '当前环境不支持切换标题栏；可定位查看原有说明。' } : supported === true ?
      { availability: 'available', availabilityText: '更改后在下次正常打开启动器窗口时生效。' } :
      { availability: 'unknown', availabilityText: '标题栏切换能力尚未确认；以窗口设置中的实际状态为准。' }
  }
  if (entry.targetKey === 'window.remember' || entry.targetKey === 'window.reset') {
    const managed = own(status, 'positionManagedByDesktop')
    if (typeof managed !== 'boolean') return { availability: 'unknown', availabilityText: '窗口位置管理方式尚未确认；可定位查看实际状态。' }
    if (managed) return entry.targetKey === 'window.remember' ?
      { label: '记住最大化状态', availability: 'available', availabilityText: '只记住最大化状态；普通窗口大小和位置由桌面环境管理。' } :
      { label: '恢复默认大小', availability: 'available', availabilityText: '只提供恢复默认大小；位置由桌面环境安排。搜索不会执行恢复。' }
    return { availability: 'available', availabilityText: entry.targetKey === 'window.remember' ? '记住普通窗口大小、位置与最大化状态，不恢复最小化或全屏。' : '可在原控件恢复默认大小和位置；搜索不会执行恢复。' }
  }
  if (!zoom || typeof zoom !== 'object' || Array.isArray(zoom)) return typeof own(status, 'supportsTitleBarStyle') === 'boolean' && typeof own(status, 'positionManagedByDesktop') === 'boolean' ?
    { availability: 'unavailable', availabilityText: '此桌面版本暂不提供界面缩放；可定位查看说明。' } :
    { availability: 'unknown', availabilityText: '界面缩放能力尚未确认；以窗口设置中的实际状态为准。' }
  const supported = own(zoom, 'supportedPercents'), actual = own(zoom, 'effectivePercent')
  if (!Array.isArray(supported) || supported.length > 4 || supported.some(value => typeof value !== 'number' || ![90, 100, 110, 125].includes(value)) || new Set(supported).size !== supported.length) return { availability: 'unknown', availabilityText: '可用缩放档位尚未确认；以窗口设置中的实际状态为准。' }
  if (!supported.length) return { availability: 'unavailable', availabilityText: '当前没有可选缩放档位；可定位查看原有说明。' }
  const current = actual === null || typeof actual !== 'number' || ![90, 100, 110, 125].includes(actual) ? '当前比例尚未确认。' : `当前比例 ${actual}%。`
  return { availability: 'available', availabilityText: `${current}可选：${supported.map(percent => `${percent}%`).join('、')}；搜索不会改变比例。` }
}
function availability(entry: SettingsSearchDescriptor, options: SettingsSearchOptions): Availability {
  if (entry.targetKey.startsWith('window.')) return windowAvailability(entry, options)
  if (entry.kind === 'saved-game-default' && options.gameSaving) return { availability: 'unavailable', availabilityText: '正在保存全局设置，请等待完成；可定位查看设置行。' }
  if (entry.targetKey === 'launcher.check-update') return !options.desktop ? { availability: 'unavailable', availabilityText: '版本检查与安装包操作需要桌面版；搜索不会执行更新。' } : options.checkingUpdate ?
    { availability: 'unavailable', availabilityText: '正在检查更新，请等待完成；搜索不会再次检查。' } : { availability: 'available', availabilityText: '可定位当前版本操作；不会自动检查或安装更新。' }
  if (entry.targetKey === 'game.java-detect' || entry.targetKey === 'game.java-download') return !options.desktop ?
    { availability: 'unavailable', availabilityText: '检测或准备本机 Java 需要桌面版；可定位查看说明。' } : options.gameSaving ?
      { availability: 'unavailable', availabilityText: '正在保存全局设置，请等待完成；搜索不会检测或下载 Java。' } :
      { availability: 'available', availabilityText: '可定位原操作区域；以任务或文件选择状态为准，不会检测或下载 Java。' }
  if (entry.targetKey === 'game.memory') return { availability: 'available', availabilityText: '手动上限需在原控件切换到手动设置；搜索不会改变分配方式或数值。' }
  if (entry.targetKey === 'game.java') return { availability: 'available', availabilityText: '指定路径需在原控件选择本机 Java；搜索不会切换方式、选择文件或修改路径。' }
  if (entry.targetKey === 'game.jvm' || entry.targetKey === 'game.width' || entry.targetKey === 'game.height') return { availability: 'available', availabilityText: '自定义输入需在原控件手动选择；搜索不会切换模式或修改草稿。' }
  return { availability: 'available', availabilityText: '定位已有控件；以原控件当前状态为准，搜索不会修改设置。' }
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
/** Synchronous fixed-index search only; at most eighteen copied DTOs, no business actions or persistence. */
export function deriveSettingsResults(input: unknown, options: SettingsSearchOptions): SettingsSearchResult {
  const validated = context(options)
  const query = normalizeSettingsQuery(input)
  if (!query) return { query, items: [], total: 0, page: 0, pageCount: 0, pageSize: 18 }
  const tokens = query.split(' '), matches = indexed.map((row, index) => ({ row, index, rank: rank(row, query, tokens) }))
    .filter((row): row is typeof row & { rank: number } => row.rank !== undefined).sort((a, b) => a.rank - b.rank || a.index - b.index)
  const items: SettingsSearchItem[] = matches.slice(0, SETTINGS_SEARCH_LIMITS.targets).map(({ row }) => {
    const state = availability(row.entry, validated)
    return { ...row.entry, ...state, aliases: [...row.entry.aliases], effectLabel: effects[row.entry.kind] }
  })
  const result: SettingsSearchResult = { query, items, total: items.length, page: 0, pageCount: items.length ? 1 : 0, pageSize: 18 }
  if (new TextEncoder().encode(JSON.stringify(result)).length > SETTINGS_SEARCH_LIMITS.dtoBytes) throw new Error('设置搜索结果超限，请缩短搜索词。')
  return result
}
