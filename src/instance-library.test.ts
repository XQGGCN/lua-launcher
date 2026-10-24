import assert from 'node:assert/strict'
import test from 'node:test'
import type { Instance } from './api'
import { DEFAULT_LIBRARY_PREFERENCES, INSTANCE_LIBRARY_LIMITS, LIBRARY_PAGE_SIZE, LIBRARY_PREFERENCE_KEYS,
  deriveInstanceLibrary, libraryDate, normalizeLibraryQuery, parseLibraryPreferences, readLibraryPreferences,
  resetLibraryPreferences, saveLibraryPreferences, type LibraryPreferences, type LibraryStorage } from './instance-library'

const preferences = (patch: Partial<LibraryPreferences> = {}): LibraryPreferences => ({ ...DEFAULT_LIBRARY_PREFERENCES, ...patch })
const instance = (i: number, patch: Partial<Instance> = {}): Instance => ({ id: 'original-' + String(i).padStart(4, '0'), name: '实例 ' + i, version: '1.21.1', loader: 'vanilla', status: 'ready',
  createdAt: new Date(i * 1000).toISOString(), playtimeMs: 0, options: { jvmArgs: ['-Doriginal.fixture=true'] }, ...patch })
const derive = (values: readonly Instance[], patch: Parameters<typeof deriveInstanceLibrary>[1] = { preferences: preferences() }) => deriveInstanceLibrary(values, patch)
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object') { for (const nested of Object.values(value)) deepFreeze(nested); Object.freeze(value) } return value }
function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial)), reads: string[] = [], writes: string[] = []
  const port: LibraryStorage = { getItem: key => { reads.push(key); return values.get(key) ?? null }, setItem: (key, value) => { writes.push(key); values.set(key, value) } }
  return { values, reads, writes, port }
}

test('default finite preference shape is copied, and explicit parse rejects unknown/prototype/accessor fields', () => {
  assert.deepEqual(DEFAULT_LIBRARY_PREFERENCES, { schema: 1, layout: 'list', density: 'standard', sortBy: 'createdAt', direction: 'asc' })
  const parsed = parseLibraryPreferences(DEFAULT_LIBRARY_PREFERENCES); parsed.layout = 'grid'; assert.equal(DEFAULT_LIBRARY_PREFERENCES.layout, 'list')
  let accessed = false, coerced = false
  for (const bad of [null, [], {}, { ...preferences(), schema: 2 }, { ...preferences(), layout: 'cards' }, { ...preferences(), density: 'dense' }, { ...preferences(), sortBy: 'playtimeMs' }, { ...preferences(), direction: 'up' },
    { ...preferences(), query: 'private query' }, Object.assign(Object.create({ foreign: true }), preferences()), { ...preferences(), get layout() { accessed = true; return 'grid' } }, { ...preferences(), layout: { toString: () => { coerced = true; return 'grid' } } }]) assert.throws(() => parseLibraryPreferences(bad), /显示参数无效/)
  assert.equal(accessed, false); assert.equal(coerced, false)
})
test('reading missing display preferences does not write or mutate unrelated selection/account keys', () => {
  const f = storage({ 'lua-selected-instance-desktop': 'keep-selected', session: 'original inert session' }), before = [...f.values]
  assert.deepEqual(readLibraryPreferences(f.port, 'desktop'), { preferences: preferences() }); assert.deepEqual(f.writes, []); assert.deepEqual([...f.values], before)
  const a = readLibraryPreferences(undefined, 'desktop'), b = readLibraryPreferences(undefined, 'desktop'); a.preferences.layout = 'grid'; assert.equal(b.preferences.layout, 'list'); assert.ok(a.issue)
})
test('desktop and preview keys are distinct and explicit save/reset touches only its own finite enum record', () => {
  const f = storage({ 'lua-selected-instance-desktop': 'original-id', 'lua-theme': 'dark', 'launcher-account': 'inert fixture' }), selected = f.values.get('lua-selected-instance-desktop')
  saveLibraryPreferences(f.port, 'desktop', preferences({ layout: 'grid', density: 'compact', sortBy: 'version', direction: 'desc' }))
  saveLibraryPreferences(f.port, 'preview', preferences({ sortBy: 'name' }))
  assert.notEqual(LIBRARY_PREFERENCE_KEYS.desktop, LIBRARY_PREFERENCE_KEYS.preview)
  assert.equal(readLibraryPreferences(f.port, 'desktop').preferences.layout, 'grid'); assert.equal(readLibraryPreferences(f.port, 'preview').preferences.layout, 'list')
  resetLibraryPreferences(f.port, 'desktop'); assert.deepEqual(readLibraryPreferences(f.port, 'desktop').preferences, preferences())
  assert.equal(f.values.get('lua-selected-instance-desktop'), selected); assert.equal(f.values.get('lua-theme'), 'dark'); assert.equal(f.values.get('launcher-account'), 'inert fixture')
  assert.equal(f.writes.every(key => key === LIBRARY_PREFERENCE_KEYS.desktop || key === LIBRARY_PREFERENCE_KEYS.preview), true)
  const body = JSON.parse(f.values.get(LIBRARY_PREFERENCE_KEYS.desktop)!); assert.deepEqual(Object.keys(body).sort(), ['density', 'direction', 'layout', 'schema', 'sortBy'])
})
test('bad/unknown/oversized/duplicate local records default nonfatally and remain byte-for-byte untouched', () => {
  for (const raw of ['bad JSON', JSON.stringify({ ...preferences(), schema: 2 }), JSON.stringify({ ...preferences(), path: '/private/fixture' }), ' '.repeat(INSTANCE_LIBRARY_LIMITS.preferencesBytes + 1),
    '{"schema":1,"layout":"list","layout":"grid","density":"standard","sortBy":"name","direction":"asc"}',
    '{"schema":1,"layout":"list","layo\\u0075t":"grid","density":"standard","sortBy":"name","direction":"asc"}']) {
    const f = storage({ [LIBRARY_PREFERENCE_KEYS.desktop]: raw }), result = readLibraryPreferences(f.port, 'desktop')
    assert.deepEqual(result.preferences, preferences()); assert.ok(result.issue); assert.deepEqual(f.writes, []); assert.equal(f.values.get(LIBRARY_PREFERENCE_KEYS.desktop), raw)
  }
})
test('human-formatted known display preferences read without an automatic rewrite', () => {
  const values = { direction: 'desc', sortBy: 'name', density: 'compact', layout: 'grid', schema: 1 }, raw = JSON.stringify(values, null, 2), f = storage({ [LIBRARY_PREFERENCE_KEYS.preview]: raw })
  assert.deepEqual(readLibraryPreferences(f.port, 'preview'), { preferences: preferences(values as LibraryPreferences) }); assert.deepEqual(f.writes, []); assert.equal(f.values.get(LIBRARY_PREFERENCE_KEYS.preview), raw)
})
test('storage failures return fixed issues, preserve requested in-memory enum values, and never expose thrown paths', () => {
  const port: LibraryStorage = { getItem: () => { throw new Error('/private/sensitive read') }, setItem: () => { throw new Error('/private/sensitive write') } }, requested = preferences({ layout: 'grid' })
  const read = readLibraryPreferences(port, 'desktop'), saved = saveLibraryPreferences(port, 'desktop', requested)
  assert.deepEqual(read.preferences, preferences()); assert.deepEqual(saved.preferences, requested); assert.ok(read.issue); assert.ok(saved.issue); assert.equal(saved.issue.includes('/private/'), false)
  assert.deepEqual(saveLibraryPreferences(undefined, 'desktop', requested).preferences, requested)
  assert.throws(() => saveLibraryPreferences(port, 'desktop', { ...requested, freeQuery: 'not persisted' }), /显示参数无效/)
})
test('query NFC/case normalization checks raw/NFC/lowercase expansions instead of truncating them', () => {
  assert.equal(normalizeLibraryQuery('  CAFÉ Fabric  '), 'café fabric'); assert.equal(normalizeLibraryQuery('Cafe\u0301'), 'café')
  assert.equal(normalizeLibraryQuery('😀'.repeat(200)), '😀'.repeat(200)); assert.equal(normalizeLibraryQuery('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦')
  for (const value of [undefined, null, 5, 'x'.repeat(201), '😀'.repeat(201), '\u0344'.repeat(101), '\u0130'.repeat(101), 'line\nnext', '\ud800', '\u202eabc']) assert.throws(() => normalizeLibraryQuery(value), /搜索词/)
  assert.equal(normalizeLibraryQuery(' x '), 'x')
})
test('0/1/3/4/24/25/200/1000 original instances paginate only after derivation without mutation', () => {
  for (const size of [0, 1, 3, 4, 24, 25, 200, 1000]) {
    const values = deepFreeze(Array.from({ length: size }, (_v, i) => instance(i))), before = JSON.stringify(values), result = derive(values)
    assert.equal(result.total, size); assert.equal(result.filteredTotal, size); assert.equal(result.items.length, Math.min(size, LIBRARY_PAGE_SIZE)); assert.equal(result.pageCount, Math.ceil(size / 24)); assert.equal(result.pageSize, 24); assert.equal(result.page, 0)
    assert.deepEqual(result.selection, { kind: 'none' }); assert.equal(JSON.stringify(values), before)
    if (size > 24) assert.equal(derive(values, { preferences: preferences(), page: 1 }).items[0].id, values[24].id)
  }
})
test('name/version/loader label and version/modpack fields are searchable with NFC and case-insensitive AND tokens', () => {
  const values = [instance(1, { name: 'Cafe\u0301 World', version: '1.20.1', loader: 'fabric', loaderVersion: '0.16.9', modpack: { name: 'Original Sky Pack' } as Instance['modpack'] }), instance(2, { name: 'Other', loader: 'forge', loaderVersion: '47.3.0' })]
  for (const query of ['CAFÉ', 'café fabric', '1.20.1 0.16.9', 'SKY pack']) assert.equal(derive(values, { preferences: preferences(), query }).items[0].id, values[0].id)
  assert.equal(derive(values, { preferences: preferences(), query: 'fabric 47.3.0' }).filteredTotal, 0)
  assert.equal(derive(values, { preferences: preferences(), query: '-Doriginal.fixture' }).filteredTotal, 0)
})
test('loader filters are exact, includingForge versusNeoForge and Chinese vanilla label', () => {
  const values = [instance(0), instance(1, { loader: 'forge' }), instance(2, { loader: 'neoforge' })]
  assert.deepEqual(derive(values, { preferences: preferences(), loaderFilter: 'forge' }).items.map(v => v.id), [values[1].id])
  assert.deepEqual(derive(values, { preferences: preferences(), loaderFilter: 'neoforge' }).items.map(v => v.id), [values[2].id])
  assert.deepEqual(derive(values, { preferences: preferences(), query: '原版' }).items.map(v => v.id), [values[0].id])
})
test('name natural ordering and normalized/case-insensitive ties resolve deterministically by exact name then ID', () => {
  const values = [instance(3, { name: 'World 10' }), instance(2, { name: 'world 2' }), instance(1, { name: 'World 2' }), instance(0, { name: 'World 2' })]
  assert.deepEqual(derive(values, { preferences: preferences({ sortBy: 'name' }) }).items.map(v => v.id), [values[3].id, values[2].id, values[1].id, values[0].id])
  const expected = derive(values, { preferences: preferences({ sortBy: 'name' }) }).items.map(v => v.id)
  assert.deepEqual(derive([...values].reverse(), { preferences: preferences({ sortBy: 'name' }) }).items.map(v => v.id), expected)
})
test('version sort is a natural display-name order, not semantic compatibility or release chronology', () => {
  const values = ['1.10', '1.9', '26.1', '1.21.1', '24w14a', 'b1.7.3', '1.2'].map((version, i) => instance(i, { version }))
  assert.deepEqual(derive(values, { preferences: preferences({ sortBy: 'version' }) }).items.map(v => v.version), ['1.2', '1.9', '1.10', '1.21.1', '24w14a', '26.1', 'b1.7.3'])
  assert.equal(derive(values, { preferences: preferences({ sortBy: 'version', direction: 'desc' }) }).items[0].version, 'b1.7.3')
})
test('strict ISO dates include epoch0/real leap days/timezone offsets and reject normalized impossible calendar dates', () => {
  const zero = libraryDate('1970-01-01T00:00:00.000Z'); assert.equal(zero.kind, 'known'); if (zero.kind === 'known') assert.equal(zero.epochMs, 0)
  for (const value of ['2000-02-29T12:00:00Z', '2024-02-29T23:59:59.999+08:00', '2024-01-01T00:00:00-05:30', '0000-02-29T00:00:00Z']) assert.equal(libraryDate(value).kind, 'known')
  for (const value of ['2023-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2024-02-30T00:00:00Z', '2024-04-31T00:00:00Z', '2024-13-01T00:00:00Z', '2024-00-01T00:00:00Z', '2024-01-00T00:00:00Z', '2024-01-01T24:00:00Z', '2024-01-01T00:60:00Z', '2024-01-01T00:00:60Z', '2024-01-01T00:00:00+24:00', '2024-01-01T00:00:00+08:60', '2024-01-01', '0', 0, Infinity, {}, 'bad']) assert.equal(libraryDate(value).kind, 'invalid')
})
test('absent/invalid date labels never invent never-played or current-time records', () => {
  for (const value of [undefined, null, '']) { const result = libraryDate(value); assert.equal(result.kind, 'absent'); assert.equal('epochMs' in result, false); assert.equal(/玩过|Invalid Date/.test(result.label), false) }
  const result = libraryDate('invalid'); assert.equal(result.kind, 'invalid'); assert.equal('epochMs' in result, false)
  let coerced = false; assert.equal(libraryDate({ toString: () => { coerced = true; return '1970-01-01T00:00:00Z' } }).kind, 'invalid'); assert.equal(coerced, false)
})
test('created date sorting keeps absent and invalid records last in both directions', () => {
  const values = [instance(0, { createdAt: 'invalid', name: 'Unknown A' }), instance(1, { createdAt: undefined as unknown as string, name: 'Unknown B' }), instance(2, { createdAt: '1970-01-01T00:00:00Z' }), instance(3, { createdAt: '2024-01-01T00:00:00Z' })]
  assert.deepEqual(derive(values, { preferences: preferences({ sortBy: 'createdAt' }) }).items.map(v => v.id), [values[2].id, values[3].id, values[0].id, values[1].id])
  assert.deepEqual(derive(values, { preferences: preferences({ sortBy: 'createdAt', direction: 'desc' }) }).items.map(v => v.id), [values[3].id, values[2].id, values[0].id, values[1].id])
})
test('lastPlayed ordering uses only recorded spawn times and ignoresplaytime/status/fake compatibility', () => {
  const values = [instance(0, { lastPlayed: undefined, playtimeMs: 999999, status: 'running' }), instance(1, { lastPlayed: '2024-01-01T00:00:00Z', status: 'error' }), instance(2, { lastPlayed: '1970-01-01T00:00:00Z' }), instance(3, { lastPlayed: '2024-02-30T00:00:00Z' })]
  const result = derive(values, { preferences: preferences({ sortBy: 'lastPlayed', direction: 'desc' }) })
  assert.deepEqual(result.items.map(v => v.id), [values[1].id, values[2].id, values[0].id, values[3].id]); assert.equal(result.items[0].status, 'error')
})
test('unknown name/version strings stay last in each direction without modifying underlying unknown metadata', () => {
  for (const sortBy of ['name', 'version'] as const) for (const direction of ['asc', 'desc'] as const) {
    const values = [instance(1), instance(2, { [sortBy]: '' }), instance(3, { [sortBy]: undefined })] as Instance[], result = derive(values, { preferences: preferences({ sortBy, direction }) })
    assert.equal(result.items[0].id, values[0].id); assert.equal(result.items.length, 3); assert.equal(values[1][sortBy], '')
  }
})
test('fixed24 pagination happens after global sorting/filtering and clamps page after filters shrink', () => {
  const values = Array.from({ length: 1000 }, (_v, i) => instance(i)).reverse(), result = derive(values, { preferences: preferences({ sortBy: 'name' }), page: 1 })
  assert.equal(result.items[0].name, '实例 24'); assert.equal(result.items.at(-1)?.name, '实例 47')
  const last = derive(values, { preferences: preferences(), page: 9999 }); assert.equal(last.page, 41); assert.equal(last.items.length, 16)
  const empty = derive(values, { preferences: preferences(), query: 'definitely absent', page: 9999 }); assert.equal(empty.page, 0); assert.equal(empty.pageCount, 0); assert.deepEqual(empty.items, [])
})
test('selection hints use the true original ID and never silently replace filtered or offpage selection', () => {
  const values = Array.from({ length: 25 }, (_v, i) => instance(i)), selected = values[24].id
  assert.deepEqual(derive(values, { preferences: preferences(), selectedId: selected }).selection, { kind: 'other-page', itemId: selected, page: 1 })
  assert.deepEqual(derive(values, { preferences: preferences(), selectedId: selected, page: 1 }).selection, { kind: 'visible', itemId: selected, page: 1 })
  assert.deepEqual(derive(values, { preferences: preferences(), selectedId: selected, query: '实例 0' }).selection, { kind: 'filtered-out', itemId: selected })
  assert.deepEqual(derive(values, { preferences: preferences(), selectedId: 'real-missing-id' }).selection, { kind: 'missing', itemId: 'real-missing-id' })
  assert.deepEqual(derive(values, { preferences: preferences(), selectedId: '' }).selection, { kind: 'none' })
})
test('result items are independent deep clones and frozen source option/draft-shaped data is never changed', () => {
  const values = deepFreeze([instance(1, { name: '原始 <b>名字</b>', error: 'original error', options: { jvmArgs: ['-Dprivate.original=true'], windowWidth: 1280 } })]), before = JSON.stringify(values), result = derive(values)
  result.items[0].name = 'changed only result'; result.items[0].options!.jvmArgs![0] = 'changed clone'
  assert.equal(JSON.stringify(values), before); assert.equal(values[0].name, '原始 <b>名字</b>')
})
test('long Unicode names and family-emoji queries work without clipping names or altering raw normalization', () => {
  const name = 'Cafe\u0301 ' + '很长'.repeat(300) + ' 👨‍👩‍👧‍👦', values = [instance(0, { name })], before = JSON.stringify(values)
  const result = derive(values, { preferences: preferences(), query: 'CAFÉ 👨‍👩‍👧‍👦' }); assert.equal(result.filteredTotal, 1); assert.equal(result.items[0].name, name); assert.equal(JSON.stringify(values), before)
})
test('bad derive filters/pages/unknown options and invalid queries reject explicitly instead of selecting first item', () => {
  const values = [instance(0)], base = { preferences: preferences() }
  for (const options of [{ ...base, loaderFilter: 'Forge' }, { ...base, loaderFilter: {} }, { ...base, loaderFilter: null }, { ...base, page: -1 }, { ...base, page: 1.5 }, { ...base, page: NaN }, { ...base, page: Infinity }, { ...base, page: null }, { ...base, selectedId: 1 }, { ...base, nativePath: '/unknown' }, { ...base, query: 'x'.repeat(201) }, { ...base, query: null }]) assert.throws(() => derive(values, options as Parameters<typeof derive>[1]))
  assert.equal(values[0].id, 'original-0000')
})
test('duplicate or empty true IDs cannot be turned into ambiguous row/action selection', () => {
  assert.throws(() => derive([instance(0), instance(1, { id: instance(0).id })]), /显示参数无效/)
  assert.throws(() => derive([instance(0, { id: '' })]), /显示参数无效/)
})
