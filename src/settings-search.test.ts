import assert from 'node:assert/strict'
import test from 'node:test'
import type { WindowPreferencesStatus } from './api'
import { SETTINGS_SEARCH_INDEX, SETTINGS_SEARCH_LIMITS, SETTINGS_SEARCH_SCOPE, deriveSettingsResults, normalizeSettingsQuery, type SettingsSearchOptions, type SettingsTargetKey } from './settings-search'

const targetKeys: SettingsTargetKey[] = ['launcher.appearance', 'launcher.minimize', 'launcher.auto-update', 'launcher.check-update', 'window.titlebar', 'window.remember', 'window.reset', 'window.zoom', 'game.memory', 'game.java', 'game.java-detect', 'game.java-download', 'game.jvm', 'game.width', 'game.height', 'game.fullscreen', 'download.source', 'download.parallel']
const desktop: SettingsSearchOptions = { desktop: true }
function windowStatus(patch: Partial<WindowPreferencesStatus> = {}): WindowPreferencesStatus {
  return { preferences: { titleBarStyle: 'native', rememberBounds: true }, effectiveTitleBarStyle: 'native', pendingTitleBarChange: false, supportsTitleBarStyle: true, positionManagedByDesktop: false,
    zoom: { requestedPercent: 100, effectivePercent: 100, supportedPercents: [90, 100, 110, 125], busy: false }, ...patch }
}
function item(targetKey: SettingsTargetKey, options: SettingsSearchOptions = desktop) {
  const descriptor = SETTINGS_SEARCH_INDEX.find(entry => entry.targetKey === targetKey)!
  return deriveSettingsResults(descriptor.label, options).items.find(entry => entry.targetKey === targetKey)!
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

test('fixed index has exactly eighteen existing stable targets and finite descriptors', () => {
  assert.deepEqual(SETTINGS_SEARCH_INDEX.map(entry => entry.targetKey), targetKeys)
  assert.equal(new Set(targetKeys).size, 18)
  assert.equal(SETTINGS_SEARCH_LIMITS.targets, 18)
  assert.match(SETTINGS_SEARCH_SCOPE, /不搜索实例、路径、账户或游戏文件/)
  for (const entry of SETTINGS_SEARCH_INDEX) {
    assert.ok(entry.label && entry.section && entry.kind)
    assert.ok(entry.aliases.length <= SETTINGS_SEARCH_LIMITS.aliasesPerTarget)
    assert.equal(new Set(entry.aliases.map(normalizeSettingsQuery)).size, entry.aliases.length)
    for (const text of [entry.label, entry.section, ...entry.aliases]) assert.ok([...text].length <= SETTINGS_SEARCH_LIMITS.descriptorCodePoints)
  }
})
test('exported index is deeply frozen, including alias arrays', () => {
  assert.ok(Object.isFrozen(SETTINGS_SEARCH_INDEX))
  for (const entry of SETTINGS_SEARCH_INDEX) { assert.ok(Object.isFrozen(entry)); assert.ok(Object.isFrozen(entry.aliases)) }
  assert.throws(() => { (SETTINGS_SEARCH_INDEX as unknown as unknown[]).pop() }, TypeError)
  assert.throws(() => { (SETTINGS_SEARCH_INDEX[0].aliases as unknown as string[]).push('foreign') }, TypeError)
})
test('every fixed title and alias finds its own target without runtime data', () => {
  for (const entry of SETTINGS_SEARCH_INDEX) {
    for (const query of [entry.label, ...entry.aliases]) {
      assert.ok(deriveSettingsResults(query, desktop).items.some(result => result.targetKey === entry.targetKey), `${entry.targetKey}: ${query}`)
    }
  }
})
test('exact titles precede contains and section matches; equal ranks keep source order', () => {
  assert.equal(deriveSettingsResults('内存分配', desktop).items[0].targetKey, 'game.memory')
  assert.deepEqual(deriveSettingsResults('Java', desktop).items.map(entry => entry.targetKey), ['game.java', 'game.java-detect', 'game.java-download'])
  const windows = deriveSettingsResults('窗口', desktop).items.map(entry => entry.targetKey)
  assert.deepEqual(windows, ['window.remember', 'window.reset', 'game.width', 'game.height', 'game.fullscreen', 'window.titlebar', 'window.zoom', 'game.jvm'])
  assert.deepEqual(deriveSettingsResults('窗口', desktop), deriveSettingsResults('窗口', desktop))
})
test('AND tokens can span title, static aliases and section but never OR together', () => {
  assert.deepEqual(deriveSettingsResults(' java   17 ', desktop).items.map(entry => entry.targetKey), ['game.java-download'])
  assert.deepEqual(deriveSettingsResults('全局 内存', desktop).items.map(entry => entry.targetKey), ['game.memory'])
  assert.equal(deriveSettingsResults('内存 BMCLAPI', desktop).total, 0)
  assert.equal(deriveSettingsResults('游戏宽度', desktop).items[0].targetKey, 'game.width')
})
test('empty and unmatched queries return one bounded empty page', () => {
  for (const query of ['', '   ', '\u3000 \u00a0', '没有这个已有设置']) {
    const result = deriveSettingsResults(query, desktop)
    assert.equal(result.total, 0); assert.equal(result.items.length, 0); assert.equal(result.page, 0); assert.equal(result.pageCount, 0); assert.equal(result.pageSize, 18)
  }
})
test('query normalization uses NFC and case folding, not compatibility character substitution', () => {
  assert.equal(normalizeSettingsQuery('  JAVA\u3000路径 '), 'java 路径')
  assert.equal(normalizeSettingsQuery('E\u0301'), 'é')
  assert.equal(normalizeSettingsQuery('90％'), '90％')
  assert.equal(deriveSettingsResults('90％', desktop).total, 0)
  assert.equal(deriveSettingsResults('90%', desktop).items[0].targetKey, 'window.zoom')
})
test('raw, NFC and folded code point budgets each reject expansion rather than clip', () => {
  assert.equal(normalizeSettingsQuery('a'.repeat(100)), 'a'.repeat(100))
  assert.throws(() => normalizeSettingsQuery('a'.repeat(101)), /最多100/)
  assert.throws(() => normalizeSettingsQuery(' '.repeat(100) + 'a'), /最多100/)
  assert.equal([...normalizeSettingsQuery('\u0344'.repeat(50))].length, 100)
  assert.throws(() => normalizeSettingsQuery('\u0344'.repeat(51)), /最多100/)
  assert.equal([...normalizeSettingsQuery('İ'.repeat(50))].length, 100)
  assert.throws(() => normalizeSettingsQuery('İ'.repeat(51)), /最多100/)
})
test('valid astral pairs and joiners are accepted; isolated surrogate code units are rejected', () => {
  assert.equal(normalizeSettingsQuery('😀'.repeat(100)), '😀'.repeat(100))
  assert.throws(() => normalizeSettingsQuery('😀'.repeat(101)), /最多100/)
  assert.equal(normalizeSettingsQuery('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦')
  for (const query of ['\ud800', '\udfff', 'x\ud800y', '\udc00\ud800']) assert.throws(() => normalizeSettingsQuery(query), /控制字符/)
})
test('control and bidi control input is explicit error with no token laundering', () => {
  for (const query of ['java\n路径', 'java\t路径', 'java\r路径', '\0', '\u007f', '\u0085', '\u202e', '\u2066']) assert.throws(() => normalizeSettingsQuery(query), /控制字符/)
})
test('query never coerces objects, calls a getter or accepts nonstring values', () => {
  let called = 0
  for (const query of [undefined, null, true, 1, {}, ['Java'], { toString() { called++; return 'Java' } }]) assert.throws(() => normalizeSettingsQuery(query), /设置搜索词/)
  assert.equal(called, 0)
})
test('regex and HTML characters are literal search text, without interpretation', () => {
  for (const query of ['.*', '[Java]', '<script>', '${path}', '(?=Java)', 'java|内存', 'java\\.exe']) assert.equal(deriveSettingsResults(query, desktop).total, 0)
  assert.equal(deriveSettingsResults('java.exe', desktop).items[0].targetKey, 'game.java')
})
test('unimplemented settings are not invented as aliases or metadata targets', () => {
  for (const query of ['Xms', 'JFR', 'GC预设', 'ZGC', '代理', '带宽限速', '限速', '200%', '调整数据目录', 'Quilt', '设置收藏', '通知提示音']) assert.equal(deriveSettingsResults(query, desktop).total, 0, query)
})
test('dynamic values including status diagnostics never enter search or result DTOs', () => {
  const secret = '/original/private/fixture-secret-java'
  const status = { ...windowStatus(), issue: secret, dynamicJvm: '-Dfixture.secret=true', account: 'PrivatePlayer' }
  for (const query of [secret, 'fixture.secret', 'PrivatePlayer']) assert.equal(deriveSettingsResults(query, { desktop: true, windowStatus: status }).total, 0)
  assert.ok(!JSON.stringify(deriveSettingsResults('窗口', { desktop: true, windowStatus: status })).includes(secret))
})
test('fresh result arrays and alias arrays cannot mutate the fixed index or later calls', () => {
  const first = deriveSettingsResults('外观', desktop)
  const mutable = first as unknown as { items: { label: string; aliases: string[] }[] }
  mutable.items[0].label = 'changed'; mutable.items[0].aliases.push('fake'); mutable.items.pop()
  const next = deriveSettingsResults('外观', desktop)
  assert.equal(next.items[0].label, '外观'); assert.ok(!next.items[0].aliases.includes('fake'))
  assert.equal(SETTINGS_SEARCH_INDEX[0].label, '外观')
})
test('browser results retain unavailable desktop targets and leave ordinary draft controls findable', () => {
  for (const key of ['window.titlebar', 'window.remember', 'window.reset', 'window.zoom', 'game.java-detect', 'game.java-download', 'launcher.check-update'] as SettingsTargetKey[]) assert.equal(item(key, { desktop: false }).availability, 'unavailable', key)
  assert.equal(item('game.memory', { desktop: false }).availability, 'available')
  assert.equal(item('game.java', { desktop: false }).availability, 'available')
})
test('missing or incomplete window capabilities remain explicitly unknown, without platform guesses', () => {
  for (const status of [undefined, null, {} as WindowPreferencesStatus]) assert.equal(item('window.titlebar', { desktop: true, windowStatus: status }).availability, 'unknown')
  assert.equal(item('window.remember', { desktop: true, windowStatus: {} as WindowPreferencesStatus }).availability, 'unknown')
  assert.equal(item('window.zoom', { desktop: true, windowStatus: {} as WindowPreferencesStatus }).availability, 'unknown')
  assert.equal(item('window.titlebar', { desktop: true, windowStatus: windowStatus({ supportsTitleBarStyle: false }) }).availability, 'unavailable')
  assert.equal(item('window.titlebar', { desktop: true, windowStatus: windowStatus({ supportsTitleBarStyle: true }) }).availability, 'available')
})
test('desktop-managed position changes only the two truthful display labels and descriptions', () => {
  const options = { desktop: true, windowStatus: windowStatus({ positionManagedByDesktop: true }) }
  assert.equal(item('window.remember', options).label, '记住最大化状态')
  assert.match(item('window.remember', options).availabilityText, /普通窗口大小和位置由桌面环境管理/)
  assert.equal(item('window.reset', options).label, '恢复默认大小')
  assert.match(item('window.reset', options).availabilityText, /不会执行恢复/)
  assert.equal(SETTINGS_SEARCH_INDEX.find(entry => entry.targetKey === 'window.remember')!.label, '记住窗口大小、位置与最大化状态')
})
test('window busy and actual zoom busy preserve targets and reflect the same shared busy gate', () => {
  for (const options of [{ desktop: true, windowBusy: true, windowStatus: windowStatus() }, { desktop: true, windowStatus: windowStatus({ zoom: { requestedPercent: 100, effectivePercent: 100, supportedPercents: [100], busy: true } }) }]) {
    for (const key of ['window.titlebar', 'window.remember', 'window.reset', 'window.zoom'] as SettingsTargetKey[]) assert.equal(item(key, options).availability, 'unavailable')
  }
})
test('zoom description uses only actual finite supported presets and never invents an effective value', () => {
  const options = { desktop: true, windowStatus: windowStatus({ zoom: { requestedPercent: 125, effectivePercent: null, supportedPercents: [100], busy: false, reason: 'original private message' } }) }
  const zoom = item('window.zoom', options)
  assert.equal(zoom.availability, 'available'); assert.match(zoom.availabilityText, /当前比例尚未确认/)
  assert.match(zoom.availabilityText, /可选：100%/); assert.ok(!zoom.availabilityText.includes('125%'))
  assert.ok(!zoom.availabilityText.includes('original private message'))
  assert.equal(item('window.zoom', { desktop: true, windowStatus: windowStatus({ zoom: undefined }) }).availability, 'unavailable')
})
test('unproven zoom preset lists are unknown while a verified empty list is unavailable', () => {
  for (const presets of [[80], [100, 100], [90, 100, 110, 125, 100], ['100'], null]) {
    const status = windowStatus({ zoom: { requestedPercent: 100, effectivePercent: 100, supportedPercents: presets as number[] as never, busy: false } })
    assert.equal(item('window.zoom', { desktop: true, windowStatus: status }).availability, 'unknown')
  }
  assert.equal(item('window.zoom', { desktop: true, windowStatus: windowStatus({ zoom: { requestedPercent: 100, effectivePercent: 100, supportedPercents: [], busy: false } }) }).availability, 'unavailable')
})
test('global save and update check flags do not disable unrelated immediate settings or invent business actions', () => {
  const options = { desktop: true, gameSaving: true, checkingUpdate: true }
  for (const key of ['game.memory', 'game.java', 'game.jvm', 'game.width', 'game.height', 'game.fullscreen', 'download.source', 'download.parallel', 'game.java-detect', 'game.java-download', 'launcher.check-update'] as SettingsTargetKey[]) assert.equal(item(key, options).availability, 'unavailable')
  assert.equal(item('launcher.appearance', options).availability, 'available')
  assert.equal(item('launcher.minimize', options).availability, 'available')
  assert.equal(item('launcher.auto-update', options).availability, 'available')
})
test('effect labels distinguish immediate, separately saved, global drafts and explicit actions', () => {
  assert.match(item('launcher.appearance').effectLabel, /立即生效/)
  assert.match(item('window.titlebar').effectLabel, /单独保存/)
  assert.match(item('game.jvm').effectLabel, /保存设置后/)
  assert.match(item('game.java-download').effectLabel, /单独点击原操作按钮/)
})
test('frozen source options are unchanged and inherited/accessor capability fields are not executed', () => {
  const original = freeze({ desktop: true, windowStatus: windowStatus(), windowBusy: false, gameSaving: false })
  const before = JSON.stringify(original)
  deriveSettingsResults('窗口', original)
  assert.equal(JSON.stringify(original), before)
  let called = 0
  const status = { get supportsTitleBarStyle() { called++; return true } } as WindowPreferencesStatus
  assert.equal(item('window.titlebar', { desktop: true, windowStatus: status }).availability, 'unknown')
  const inherited = Object.create({ supportsTitleBarStyle: true }) as WindowPreferencesStatus
  assert.equal(item('window.titlebar', { desktop: true, windowStatus: inherited }).availability, 'unknown')
  assert.equal(called, 0)
})
test('context rejects foreign/coerced flags and accessor options without calling accessors', () => {
  let called = 0
  const accessor = { desktop: true, get gameSaving() { called++; return true } }
  const bad = [null, [], {}, { desktop: 'yes' }, { desktop: true, gameSaving: null }, { desktop: true, windowBusy: 1 }, { desktop: true, checkingUpdate: 'false' }, { desktop: true, javaPath: '/foreign' }, accessor]
  for (const options of bad) assert.throws(() => deriveSettingsResults('Java', options as SettingsSearchOptions), /设置搜索状态无效/)
  assert.equal(called, 0)
})
test('result pagination and JSON byte size stay bounded across every fixed token and query', () => {
  for (const query of ['设置', '游戏', '窗口', 'Java', ...SETTINGS_SEARCH_INDEX.flatMap(entry => [entry.label, ...entry.aliases])]) {
    const result = deriveSettingsResults(query, { desktop: true, windowStatus: windowStatus() })
    assert.ok(result.items.length <= 18); assert.equal(result.total, result.items.length); assert.equal(result.page, 0); assert.equal(result.pageSize, 18)
    assert.equal(result.pageCount, result.items.length ? 1 : 0)
    assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= SETTINGS_SEARCH_LIMITS.dtoBytes)
    assert.ok(result.items.every(entry => targetKeys.includes(entry.targetKey)))
  }
})

test('inherited optional flags and getters are ignored in favor of validated own context fields', () => {
  let called = 0
  const inherited = { get windowBusy() { called++; return true }, get gameSaving() { called++; return true }, get checkingUpdate() { called++; return true } }
  const options = Object.assign(Object.create(inherited), { desktop: true, windowStatus: windowStatus() }) as SettingsSearchOptions
  for (const query of ['窗口', '内存', '检查更新']) assert.deepEqual(deriveSettingsResults(query, options), deriveSettingsResults(query, { desktop: true, windowStatus: windowStatus() }))
  assert.equal(called, 0)
  const ownFalse = Object.create(inherited, Object.fromEntries(Object.entries({ desktop: true, windowStatus: windowStatus(), windowBusy: false, gameSaving: false, checkingUpdate: false }).map(([key, value]) => [key, { value, enumerable: true }]))) as SettingsSearchOptions
  assert.deepEqual(deriveSettingsResults('窗口', ownFalse), deriveSettingsResults('窗口', { desktop: true, windowStatus: windowStatus() }))
  assert.equal(called, 0)
})
