import type { Instance, Loader } from './api'

export interface LibraryPreferences {
  schema: 1
  layout: 'list' | 'grid'
  density: 'standard' | 'compact'
  sortBy: 'name' | 'version' | 'lastPlayed' | 'createdAt'
  direction: 'asc' | 'desc'
}
export type LibraryLoaderFilter = 'all' | Loader
export type LibraryStorageMode = 'desktop' | 'preview'
export interface LibraryStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface LibraryPreferencesResult { preferences: LibraryPreferences; issue?: string }
export type LibraryDate = { kind: 'known'; epochMs: number; iso: string; label: string } |
  { kind: 'absent' | 'invalid'; label: string }
export type InstanceLibrarySelection = { kind: 'none' } | { kind: 'missing' | 'filtered-out'; itemId: string } |
  { kind: 'visible' | 'other-page'; itemId: string; page: number }
export interface InstanceLibraryResult {
  items: Instance[]
  total: number
  filteredTotal: number
  page: number
  pageCount: number
  pageSize: 24
  selection: InstanceLibrarySelection
}
export interface InstanceLibraryOptions {
  preferences: LibraryPreferences
  query?: string
  loaderFilter?: LibraryLoaderFilter
  page?: number
  selectedId?: string
}
export const LIBRARY_PAGE_SIZE = 24
export const LIBRARY_PREFERENCE_KEYS = Object.freeze({ desktop: 'lua-instance-library-desktop-v1', preview: 'lua-instance-library-preview-v1' })
export const DEFAULT_LIBRARY_PREFERENCES: Readonly<LibraryPreferences> = Object.freeze({ schema: 1, layout: 'list', density: 'standard', sortBy: 'createdAt', direction: 'asc' })
export const INSTANCE_LIBRARY_LIMITS = Object.freeze({ preferencesBytes: 4 * 1024, queryCodePoints: 200 })
const loaderNames: Record<Loader, string> = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const copyPreferences = (value: Readonly<LibraryPreferences>): LibraryPreferences => ({ ...value })
function invalid(): never { throw new Error('实例库显示参数无效，请重新选择受支持的显示方式。') }
function fields(value: unknown, allowed: string[], required: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) || required.some(key => !Object.hasOwn(value, key))) invalid()
}
export function parseLibraryPreferences(value: unknown): LibraryPreferences {
  fields(value, ['schema', 'layout', 'density', 'sortBy', 'direction'], ['schema', 'layout', 'density', 'sortBy', 'direction'])
  if (value.schema !== 1 || typeof value.layout !== 'string' || !['list', 'grid'].includes(value.layout) || typeof value.density !== 'string' || !['standard', 'compact'].includes(value.density) ||
      typeof value.sortBy !== 'string' || !['name', 'version', 'lastPlayed', 'createdAt'].includes(value.sortBy) || typeof value.direction !== 'string' || !['asc', 'desc'].includes(value.direction)) invalid()
  return { schema: 1, layout: value.layout as LibraryPreferences['layout'], density: value.density as LibraryPreferences['density'],
    sortBy: value.sortBy as LibraryPreferences['sortBy'], direction: value.direction as LibraryPreferences['direction'] }
}
function storageKey(mode: LibraryStorageMode): string { if (mode !== 'desktop' && mode !== 'preview') return invalid(); return LIBRARY_PREFERENCE_KEYS[mode] }
/** Read never rewrites unknown data. Pass lazy getItem/setItem wrappers if access to localStorage itself may throw. */
export function readLibraryPreferences(storage: LibraryStorage | undefined, mode: LibraryStorageMode): LibraryPreferencesResult {
  const key = storageKey(mode)
  try {
    if (!storage) throw new Error('storage unavailable')
    const raw = storage.getItem(key)
    if (raw === null) return { preferences: copyPreferences(DEFAULT_LIBRARY_PREFERENCES) }
    if (typeof raw !== 'string' || raw.length > INSTANCE_LIBRARY_LIMITS.preferencesBytes || new TextEncoder().encode(raw).length > INSTANCE_LIBRARY_LIMITS.preferencesBytes) throw new Error('bounded preferences unavailable')
    const parsed = JSON.parse(raw)
    return { preferences: parseStoredPreferences(raw, parsed) }
  } catch { return { preferences: copyPreferences(DEFAULT_LIBRARY_PREFERENCES), issue: '实例库显示偏好无法读取，本次使用默认显示；原记录未改动。' } }
}
function encodePreferences(value: unknown): string { return JSON.stringify(parseLibraryPreferences(value)) }
/** Small known-shape local records also reject duplicate decoded JSON keys. */
function parseStoredPreferences(raw: string, parsed: unknown): LibraryPreferences {
  const preferences = parseLibraryPreferences(parsed)
  // Local records are small and generated by this helper. Accept whitespace/key-order variations,
  // but detect duplicate decoded keys with an independent top-level JSON key scan.
  const names = new Set<string>(); let at = 0
  const whitespace = () => { while (at < raw.length && /[\x20\t\r\n]/.test(raw[at])) at++ }
  const string = () => {
    whitespace(); if (raw[at] !== '"') return invalid()
    const start = at++
    while (at < raw.length) { const c = raw[at++]; if (c === '\\') at++; else if (c === '"') return JSON.parse(raw.slice(start, at)) as string }
    return invalid()
  }
  whitespace(); if (raw[at++] !== '{') invalid(); whitespace()
  while (raw[at] !== '}') {
    const name = string(); if (names.has(name)) invalid(); names.add(name); whitespace(); if (raw[at++] !== ':') invalid(); whitespace()
    if (raw[at] === '"') string()
    else { const scalar = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(raw.slice(at)); if (!scalar) invalid(); at += scalar![0].length }
    whitespace(); if (raw[at] === '}') break; if (raw[at++] !== ',') invalid()
  }
  at++; whitespace(); if (at !== raw.length || names.size !== 5) invalid()
  return preferences
}
/** Explicit valid writes affect this key only; failed storage still returns the requested in-memory preferences. */
export function saveLibraryPreferences(storage: LibraryStorage | undefined, mode: LibraryStorageMode, value: unknown): LibraryPreferencesResult {
  const key = storageKey(mode), preferences = parseLibraryPreferences(value), encoded = encodePreferences(preferences)
  try { if (!storage) throw new Error('storage unavailable'); storage.setItem(key, encoded); return { preferences } }
  catch { return { preferences, issue: '实例库显示偏好未能保存，本次调整仍然有效。' } }
}
export function resetLibraryPreferences(storage: LibraryStorage | undefined, mode: LibraryStorageMode): LibraryPreferencesResult {
  return saveLibraryPreferences(storage, mode, copyPreferences(DEFAULT_LIBRARY_PREFERENCES))
}

export function normalizeLibraryQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > INSTANCE_LIBRARY_LIMITS.queryCodePoints * 2 || [...value].length > INSTANCE_LIBRARY_LIMITS.queryCodePoints || /[\p{Cc}\ud800-\udfff\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error('搜索词需为最多200个字符的文字，不能含控制字符。')
  const normalized = value.normalize('NFC').trim()
  if ([...normalized].length > INSTANCE_LIBRARY_LIMITS.queryCodePoints) throw new Error('搜索词规范化后超过200个字符，请缩短后再搜索。')
  const folded = normalized.toLocaleLowerCase('zh-CN')
  if ([...folded].length > INSTANCE_LIBRARY_LIMITS.queryCodePoints) throw new Error('搜索词大小写转换后超过200个字符，请缩短后再搜索。')
  return folded
}
export const instanceLibrarySearchQuery = normalizeLibraryQuery
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.normalize('NFC').trim() : undefined
type DateValue = { kind: 'known'; epochMs: number; iso: string } | { kind: 'absent' | 'invalid' }
function dateValue(value: unknown): DateValue {
  if (value === undefined || value === null || value === '') return { kind: 'absent' }
  if (typeof value !== 'string' || value.length > 40) return { kind: 'invalid' }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return { kind: 'invalid' }
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]), hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]),
    leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0), days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59 ||
      match[8] !== 'Z' && (Number(match[8].slice(1, 3)) > 23 || Number(match[8].slice(4, 6)) > 59)) return { kind: 'invalid' }
  const epochMs = Date.parse(value)
  return Number.isFinite(epochMs) ? { kind: 'known', epochMs, iso: new Date(epochMs).toISOString() } : { kind: 'invalid' }
}
/** Instance creation/last-played values are local launcher records, not proof of world creation or game entry. */
export function libraryDate(value: unknown): LibraryDate {
  const date = dateValue(value)
  return date.kind === 'known' ? { ...date, label: dateFormatter.format(new Date(date.epochMs)) } : { ...date, label: date.kind === 'absent' ? '暂无记录' : '记录时间未知' }
}
function compareText(left: string | undefined, right: string | undefined, direction: LibraryPreferences['direction']): number {
  if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? 1 : -1
  return collator.compare(left, right) * (direction === 'asc' ? 1 : -1)
}
function compareDates(left: DateValue, right: DateValue, direction: LibraryPreferences['direction']): number {
  if (left.kind !== 'known' || right.kind !== 'known') return left.kind === 'known' ? -1 : right.kind === 'known' ? 1 : 0
  return (left.epochMs - right.epochMs) * (direction === 'asc' ? 1 : -1)
}

/** Local presentation only: no input mutation, backend method calls or selection replacement. */
export function deriveInstanceLibrary(instances: readonly Instance[], options: InstanceLibraryOptions): InstanceLibraryResult {
  fields(options, ['preferences', 'query', 'loaderFilter', 'page', 'selectedId'], ['preferences'])
  const preferences = parseLibraryPreferences(options.preferences), query = normalizeLibraryQuery(options.query === undefined ? '' : options.query),
    loaderFilter = options.loaderFilter === undefined ? 'all' : options.loaderFilter, requestedPage = options.page === undefined ? 0 : options.page
  if (!Array.isArray(instances) || typeof loaderFilter !== 'string' || !['all', 'vanilla', 'fabric', 'forge', 'neoforge'].includes(loaderFilter) ||
      typeof requestedPage !== 'number' || !Number.isSafeInteger(requestedPage) || requestedPage < 0 || options.selectedId !== undefined && typeof options.selectedId !== 'string') invalid()
  const ids = new Set<string>(), tokens = query.split(/\s+/u).filter(Boolean)
  const rows = instances.map((instance: Instance) => {
    if (!instance || typeof instance !== 'object' || typeof instance.id !== 'string' || !instance.id || ids.has(instance.id)) invalid()
    ids.add(instance.id)
    const name = text(instance.name), version = text(instance.version), label = typeof instance.loader === 'string' && Object.hasOwn(loaderNames, instance.loader) ? loaderNames[instance.loader] : '',
      search = [name, version, label, text(instance.loaderVersion), text(instance.modpack?.name)].filter((value): value is string => !!value).join('\n').toLocaleLowerCase('zh-CN')
    return { instance, name, version, search, created: dateValue(instance.createdAt), played: dateValue(instance.lastPlayed) }
  }).filter(row => (loaderFilter === 'all' || row.instance.loader === loaderFilter) && tokens.every(token => row.search.includes(token)))
  rows.sort((left, right) => {
    const result = preferences.sortBy === 'name' ? compareText(left.name, right.name, preferences.direction) : preferences.sortBy === 'version' ? compareText(left.version, right.version, preferences.direction) :
      compareDates(preferences.sortBy === 'createdAt' ? left.created : left.played, preferences.sortBy === 'createdAt' ? right.created : right.played, preferences.direction)
    if (result) return result
    const names = compareText(left.name, right.name, 'asc')
    if (names) return names
    if (left.name !== right.name && left.name !== undefined && right.name !== undefined) return left.name < right.name ? -1 : 1
    return left.instance.id < right.instance.id ? -1 : left.instance.id === right.instance.id ? 0 : 1
  })
  const pageCount = Math.ceil(rows.length / LIBRARY_PAGE_SIZE), page = Math.min(requestedPage, Math.max(0, pageCount - 1)), selectedId = options.selectedId
  let selection: InstanceLibrarySelection = { kind: 'none' }
  if (selectedId) {
    const selectedIndex = rows.findIndex(row => row.instance.id === selectedId)
    selection = !ids.has(selectedId) ? { kind: 'missing', itemId: selectedId } : selectedIndex < 0 ? { kind: 'filtered-out', itemId: selectedId } :
      { kind: Math.floor(selectedIndex / LIBRARY_PAGE_SIZE) === page ? 'visible' : 'other-page', itemId: selectedId, page: Math.floor(selectedIndex / LIBRARY_PAGE_SIZE) }
  }
  return { items: rows.slice(page * LIBRARY_PAGE_SIZE, (page + 1) * LIBRARY_PAGE_SIZE).map(row => structuredClone(row.instance)), total: instances.length,
    filteredTotal: rows.length, page, pageCount, pageSize: LIBRARY_PAGE_SIZE, selection }
}
