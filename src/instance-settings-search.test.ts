import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSettingsQuery, SETTINGS_SEARCH_INDEX } from './settings-search'
import { INSTANCE_SETTINGS_SEARCH_INDEX, INSTANCE_SETTINGS_SEARCH_LIMITS, INSTANCE_SETTINGS_SEARCH_SCOPE, deriveInstanceSettingsResults, normalizeInstanceSettingsQuery,
  type InstanceSettingsSearchContext, type InstanceSettingsTargetKey } from './instance-settings-search'

const keys: InstanceSettingsTargetKey[] = ['instance.name', 'instance.java', 'instance.memory-mode', 'instance.memory-limit', 'instance.jvm', 'instance.width', 'instance.height', 'instance.fullscreen', 'instance.revert', 'instance.inherit']
const ready = (): InstanceSettingsSearchContext => ({ ownerMatches: true, locked: false, busy: null, hasPicker: true, hasDetect: true })
function item(targetKey: InstanceSettingsTargetKey, context = ready()) {
  const descriptor = INSTANCE_SETTINGS_SEARCH_INDEX.find(entry => entry.targetKey === targetKey)!
  return deriveInstanceSettingsResults(descriptor.label, context).items.find(entry => entry.targetKey === targetKey)!
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

test('instance index has exactly eight existing settings and two explicit restoration actions', () => {
  assert.deepEqual(INSTANCE_SETTINGS_SEARCH_INDEX.map(entry => entry.targetKey), keys)
  assert.equal(new Set(keys).size, 10)
  assert.equal(INSTANCE_SETTINGS_SEARCH_INDEX.filter(entry => entry.kind === 'saved-instance-option').length, 8)
  assert.deepEqual(INSTANCE_SETTINGS_SEARCH_INDEX.filter(entry => entry.kind === 'explicit-action').map(entry => entry.targetKey), ['instance.revert', 'instance.inherit'])
  assert.equal(INSTANCE_SETTINGS_SEARCH_LIMITS.targets, 10)
  assert.match(INSTANCE_SETTINGS_SEARCH_SCOPE, /当前实例/)
  assert.match(INSTANCE_SETTINGS_SEARCH_SCOPE, /不修改、不保存/)
})
test('advanced flags correspond exactly to the four controls inside existing advanced details', () => {
  assert.deepEqual(INSTANCE_SETTINGS_SEARCH_INDEX.filter(entry => entry.advanced).map(entry => entry.targetKey), ['instance.jvm', 'instance.width', 'instance.height', 'instance.fullscreen'])
  assert.ok(INSTANCE_SETTINGS_SEARCH_INDEX.filter(entry => entry.advanced).every(entry => entry.section === '高级设置'))
  assert.ok(INSTANCE_SETTINGS_SEARCH_INDEX.filter(entry => !entry.advanced).every(entry => entry.section !== '高级设置'))
})
test('independent target namespace leaves global eighteen-target index untouched', () => {
  const before = JSON.stringify(SETTINGS_SEARCH_INDEX)
  for (const targetKey of keys) assert.ok(!SETTINGS_SEARCH_INDEX.some(entry => String(entry.targetKey) === targetKey))
  deriveInstanceSettingsResults('窗口', ready())
  assert.equal(SETTINGS_SEARCH_INDEX.length, 18)
  assert.equal(JSON.stringify(SETTINGS_SEARCH_INDEX), before)
})
test('descriptors and alias arrays are frozen, unique and individually bounded', () => {
  assert.ok(Object.isFrozen(INSTANCE_SETTINGS_SEARCH_INDEX))
  for (const descriptor of INSTANCE_SETTINGS_SEARCH_INDEX) {
    assert.ok(Object.isFrozen(descriptor)); assert.ok(Object.isFrozen(descriptor.aliases))
    assert.ok(descriptor.aliases.length <= INSTANCE_SETTINGS_SEARCH_LIMITS.aliasesPerTarget)
    assert.equal(new Set(descriptor.aliases.map(normalizeSettingsQuery)).size, descriptor.aliases.length)
    for (const field of [descriptor.label, descriptor.section, ...descriptor.aliases]) assert.ok([...field].length <= INSTANCE_SETTINGS_SEARCH_LIMITS.descriptorCodePoints)
  }
  assert.throws(() => { (INSTANCE_SETTINGS_SEARCH_INDEX as unknown as unknown[]).pop() }, TypeError)
  assert.throws(() => { (INSTANCE_SETTINGS_SEARCH_INDEX[0].aliases as unknown as string[]).push('foreign') }, TypeError)
})
test('each existing title and finite alias finds only records from the instance namespace', () => {
  for (const descriptor of INSTANCE_SETTINGS_SEARCH_INDEX) {
    for (const query of [descriptor.label, ...descriptor.aliases]) {
      const result = deriveInstanceSettingsResults(query, ready())
      assert.ok(result.items.some(entry => entry.targetKey === descriptor.targetKey), `${descriptor.targetKey}: ${query}`)
      assert.ok(result.items.every(entry => keys.includes(entry.targetKey)))
    }
  }
})
test('empty and unmatched input give a finite empty page without a synthetic first target', () => {
  for (const query of ['', '   ', '\u3000', '不存在的原创字段']) assert.deepEqual(deriveInstanceSettingsResults(query, ready()), { query: normalizeSettingsQuery(query), total: 0, items: [], page: 0, pageSize: 10, pageCount: 0 })
})
test('title matches precede aliases and section-only matches while ties keep source order', () => {
  assert.deepEqual(deriveInstanceSettingsResults('窗口', ready()).items.map(entry => entry.targetKey), ['instance.width', 'instance.height', 'instance.fullscreen'])
  assert.deepEqual(deriveInstanceSettingsResults('继承全局', ready()).items.map(entry => entry.targetKey), ['instance.inherit', 'instance.java', 'instance.fullscreen'])
  assert.deepEqual(deriveInstanceSettingsResults('设置', ready()).items.map(entry => entry.targetKey), ['instance.revert', 'instance.name', 'instance.java', 'instance.memory-mode', 'instance.memory-limit', 'instance.jvm', 'instance.width', 'instance.height', 'instance.fullscreen'])
})
test('AND tokens can span section and aliases, without turning into an OR search', () => {
  assert.deepEqual(deriveInstanceSettingsResults(' 常用   Java ', ready()).items.map(entry => entry.targetKey), ['instance.java'])
  assert.deepEqual(deriveInstanceSettingsResults('高级 分辨率', ready()).items.map(entry => entry.targetKey), ['instance.width', 'instance.height'])
  assert.equal(deriveInstanceSettingsResults('Java 内存', ready()).total, 0)
  assert.equal(deriveInstanceSettingsResults('常用 高级', ready()).total, 0)
})
test('the same existing query normalizer is reused rather than a relaxed per-instance policy', () => {
  assert.equal(normalizeInstanceSettingsQuery, normalizeSettingsQuery)
  assert.equal(deriveInstanceSettingsResults(' JAVA\u3000选择 ', ready()).query, 'java 选择')
  for (const invalid of ['a'.repeat(101), '\u0344'.repeat(51), 'İ'.repeat(51), '\ud800', 'Java\n路径']) {
    assert.throws(() => deriveInstanceSettingsResults(invalid, ready()), /设置搜索词/)
  }
  assert.equal(deriveInstanceSettingsResults('😀'.repeat(100), ready()).total, 0)
})
test('query punctuation stays literal and no user-value or missing-control aliases are invented', () => {
  for (const query of ['.*', '<script>', '[Java]', 'JFR', 'Xms', 'ZGC', '代理', '下载源', 'BMCLAPI', '标题栏', '主题', '界面缩放', '下载Java17', '游戏参数', '通知提示音', '迁移目录']) assert.equal(deriveInstanceSettingsResults(query, ready()).total, 0, query)
  assert.equal(deriveInstanceSettingsResults('java.exe', ready()).items[0].targetKey, 'instance.java')
})
test('owner mismatch is nonactionable for every target and takes precedence over unrelated locks', () => {
  for (const key of keys) {
    const result = item(key, { ...ready(), ownerMatches: false, locked: true, busy: 'save' })
    assert.equal(result.availability, 'unavailable'); assert.match(result.availabilityText, /草稿尚未对应当前实例/)
    assert.ok(!result.availabilityText.includes('正在保存'))
  }
})
test('locked settings remain searchable but never become available to change or save', () => {
  for (const key of keys) {
    const result = item(key, { ...ready(), locked: true })
    assert.equal(result.availability, 'unavailable'); assert.match(result.availabilityText, /已锁定/)
  }
})
test('save, picker and detection busy gates describe their exact known operation', () => {
  for (const [busy, word] of [['save', '保存此实例设置'], ['pick', '选择 Java 文件'], ['detect', '检测 Java']] as const) {
    for (const key of keys) {
      const result = item(key, { ...ready(), busy })
      assert.equal(result.availability, 'unavailable'); assert.ok(result.availabilityText.includes(word))
    }
  }
})
test('missing Java picker or detection does not pretend the Java mode select is unavailable', () => {
  const cases = [
    { hasPicker: false, hasDetect: false, expected: '不提供浏览文件或检测入口' },
    { hasPicker: true, hasDetect: false, expected: '提供浏览文件入口，不提供检测入口' },
    { hasPicker: false, hasDetect: true, expected: '提供检测入口，不提供浏览文件入口' },
    { hasPicker: true, hasDetect: true, expected: '浏览文件和检测入口以原控件当前状态为准' },
  ]
  for (const row of cases) {
    const result = item('instance.java', { ...ready(), hasPicker: row.hasPicker, hasDetect: row.hasDetect })
    assert.equal(result.availability, 'available'); assert.ok(result.availabilityText.includes(row.expected))
    assert.match(result.availabilityText, /搜索不会切换方式、选择文件或检测/)
    assert.equal(item('instance.name', { ...ready(), hasPicker: row.hasPicker, hasDetect: row.hasDetect }).availability, 'available')
  }
})
test('memory allocation mode and saved manual cap stay distinct truthful target descriptions', () => {
  const mode = item('instance.memory-mode'), cap = item('instance.memory-limit')
  assert.notEqual(mode.targetKey, cap.targetKey)
  assert.match(mode.availabilityText, /分配方式与手动上限来源独立/)
  assert.match(cap.availabilityText, /自动分配时仅保留该值，暂不用于分配/)
  assert.match(cap.availabilityText, /不会改来源或数值/)
})
test('advanced results describe presentation-only expansion without changing overrides or drafts', () => {
  for (const key of ['instance.jvm', 'instance.width', 'instance.height', 'instance.fullscreen'] as const) {
    const result = item(key)
    assert.equal(result.advanced, true); assert.equal(result.availability, 'available')
    assert.match(result.availabilityText, /显式定位可展开高级设置/)
    assert.match(result.availabilityText, /不切换继承或本实例覆盖，不修改草稿/)
  }
})
test('restore actions have separate no-execution and pending-draft semantics', () => {
  const revert = item('instance.revert'), inherit = item('instance.inherit')
  assert.equal(revert.kind, 'explicit-action'); assert.equal(inherit.kind, 'explicit-action')
  assert.match(revert.effectLabel, /不会撤销草稿/)
  assert.match(inherit.effectLabel, /只改草稿，保存后生效/)
  assert.match(revert.availabilityText, /不会点击撤销或恢复继承按钮/)
  assert.match(item('instance.name').effectLabel, /保存实例设置后生效/)
})
test('contexts are exact required own finite fields and private extra values are rejected without echo', () => {
  const bad: unknown[] = [null, [], {}, { ...ready(), busy: undefined }, { ...ready(), busy: 'install' }, { ...ready(), locked: 'false' }, { ...ready(), hasPicker: null }, { ...ready(), ownerMatches: 1 }, { ...ready(), javaPath: '/original/private/path' }, { ...ready(), jvmText: '-Dfixture.private=true' }, { ...ready(), name: 'PrivateOriginalName' }, { ...ready(), instanceId: 'original-id' }]
  for (const context of bad) assert.throws(() => deriveInstanceSettingsResults('Java', context as InstanceSettingsSearchContext), error => error instanceof Error && /实例设置搜索状态无效/.test(error.message) && !/private|Original|original-id/.test(error.message))
  for (const key of Object.keys(ready())) {
    const incomplete = { ...ready() } as unknown as Record<string, unknown>; delete incomplete[key]
    assert.throws(() => deriveInstanceSettingsResults('Java', incomplete as unknown as InstanceSettingsSearchContext), /实例设置搜索状态无效/)
  }
})
test('own accessors and inherited required getters are rejected without being called', () => {
  let called = 0
  const accessor = { ...ready(), get locked() { called++; return true } }
  assert.throws(() => deriveInstanceSettingsResults('Java', accessor), /实例设置搜索状态无效/)
  const { locked: _, ...others } = ready()
  const inherited = Object.assign(Object.create({ get locked() { called++; return true } }), others)
  assert.throws(() => deriveInstanceSettingsResults('Java', inherited), /实例设置搜索状态无效/)
  assert.equal(called, 0)
})
test('required own data fields shadow inherited getters while null-prototype context is supported', () => {
  let called = 0
  const inherited = { get locked() { called++; return true }, get busy() { called++; return 'save' } }
  const ownContext = Object.create(inherited, Object.fromEntries(Object.entries(ready()).map(([key, value]) => [key, { value, enumerable: true }]))) as InstanceSettingsSearchContext
  assert.deepEqual(deriveInstanceSettingsResults('窗口', ownContext), deriveInstanceSettingsResults('窗口', ready()))
  assert.deepEqual(deriveInstanceSettingsResults('Java', Object.assign(Object.create(null), ready())), deriveInstanceSettingsResults('Java', ready()))
  assert.equal(called, 0)
})
test('frozen contexts and static descriptors are unchanged by repeated derivation', () => {
  const state = freeze(ready()), beforeContext = JSON.stringify(state), beforeIndex = JSON.stringify(INSTANCE_SETTINGS_SEARCH_INDEX)
  deriveInstanceSettingsResults('Java', state); deriveInstanceSettingsResults('设置', state); deriveInstanceSettingsResults('窗口', state)
  assert.equal(JSON.stringify(state), beforeContext); assert.equal(JSON.stringify(INSTANCE_SETTINGS_SEARCH_INDEX), beforeIndex)
})
test('returned descriptor and alias copies cannot contaminate the fixed index or next query', () => {
  const first = deriveInstanceSettingsResults('Java', ready()) as unknown as { items: { label: string; advanced: boolean; aliases: string[] }[] }
  first.items[0].label = 'foreign'; first.items[0].advanced = true; first.items[0].aliases.push('foreign'); first.items.pop()
  const next = item('instance.java')
  assert.equal(next.label, 'Java 选择'); assert.equal(next.advanced, false); assert.ok(!next.aliases.includes('foreign'))
})
test('DTO contains only fixed descriptor fields, finite state text and normalized query', () => {
  const result = deriveInstanceSettingsResults('Java', ready())
  assert.deepEqual(Object.keys(result).sort(), ['items', 'page', 'pageCount', 'pageSize', 'query', 'total'])
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['advanced', 'aliases', 'availability', 'availabilityText', 'effectLabel', 'kind', 'label', 'section', 'targetKey'])
  assert.ok(!/instanceId|javaPath|jvmText|memoryMb|account|username|rootDir|runtimePath/.test(JSON.stringify(result)))
})
test('fixed result count, one-page metadata and 16KiB UTF8 budget hold across all descriptors and finite states', () => {
  const contexts = [ready(), { ...ready(), ownerMatches: false }, { ...ready(), locked: true }, ...(['save', 'pick', 'detect'] as const).map(busy => ({ ...ready(), busy })), { ...ready(), hasPicker: false, hasDetect: false }]
  for (const state of contexts) {
    for (const query of ['设置', '窗口', 'Java', ...INSTANCE_SETTINGS_SEARCH_INDEX.flatMap(entry => [entry.label, ...entry.aliases])]) {
      const result = deriveInstanceSettingsResults(query, state)
      assert.ok(result.items.length <= 10); assert.equal(result.total, result.items.length); assert.equal(result.page, 0); assert.equal(result.pageSize, 10); assert.equal(result.pageCount, result.items.length ? 1 : 0)
      assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= INSTANCE_SETTINGS_SEARCH_LIMITS.dtoBytes)
    }
  }
})
