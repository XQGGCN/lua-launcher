import test from 'node:test'
import assert from 'node:assert/strict'
import { initialZoom, shortcutZoom, supportedZoom, WindowZoomController, zoomPercent } from './window-zoom'
import type { WindowPreferencesSnapshot } from './window-preferences-types'

function fixture(platform = 'darwin', chrome: 'native' | 'integrated' = 'native') {
  let snapshot: WindowPreferencesSnapshot = { preferences: { titleBarStyle: chrome, rememberBounds: true }, state: { maximized: false } }
  let factor = 1, writes = 0, sets = 0, publishes = 0, failApply = false
  let beforeSave: (() => Promise<void>) | undefined
  const port = { isDestroyed: () => false, getZoomFactor: () => factor, setZoomFactor: (value: number) => { sets++; if (failApply) throw Error('browser'); factor = value }, setZoomMode: (_mode: 'isolated') => {} }
  const store = { snapshot: () => structuredClone(snapshot), updatePreferences: async (patch: { zoomPercent: 90 | 100 | 110 | 125 }) => { await beforeSave?.(); writes++; if (!snapshot.issue) snapshot.preferences = { ...snapshot.preferences, ...patch }; return structuredClone(snapshot) } }
  const c = new WindowZoomController({ platform, chrome, port, store, changed: () => { publishes++ } })
  return { c, port, store, setSnapshot: (value: WindowPreferencesSnapshot) => { snapshot = value }, setBeforeSave: (fn: () => Promise<void>) => { beforeSave = fn }, setFactor: (v: number) => { factor = v }, failApply: () => { failApply = true }, get factor() { return factor }, get writes() { return writes }, get sets() { return sets }, get publishes() { return publishes } }
}
test('only finite integer presets and verified platform/effective chrome are admitted', () => {
  for (const value of [90, 100, 110, 125]) assert.equal(zoomPercent(value), value)
  for (const value of [0, 99, 1.1, 126, NaN, Infinity, '110', undefined, {}]) assert.throws(() => zoomPercent(value))
  assert.deepEqual(supportedZoom('darwin', 'native'), [90, 100, 110, 125]); assert.deepEqual(supportedZoom('win32', 'native'), [100]); assert.deepEqual(supportedZoom('darwin', 'integrated'), [100])
})
test('constructor zoom clamps unsupported saved value without changing requested preference', () => {
  assert.equal(initialZoom({ titleBarStyle: 'native', rememberBounds: true, zoomPercent: 125 }, 'darwin', 'native'), 125)
  assert.equal(initialZoom({ titleBarStyle: 'native', rememberBounds: true, zoomPercent: 125 }, 'darwin', 'integrated'), 100)
})
test('explicit selection persists then applies/readbacks; regular geometry state stays identical', async () => {
  const f = fixture(), state = f.store.snapshot().state; await f.c.setPercent(110); assert.equal(f.factor, 1.1); assert.equal(f.c.status().effectivePercent, 110); assert.equal(f.c.status().requestedPercent, 110); assert.deepEqual(f.store.snapshot().state, state)
})
test('unsupported chrome never stores nondefault and preserves requested125/effective100', async () => {
  const f = fixture('darwin', 'integrated'); f.setSnapshot({ preferences: { titleBarStyle: 'native', rememberBounds: true, zoomPercent: 125 }, state: { maximized: false } }); f.c.start()
  await assert.rejects(f.c.setPercent(125)); assert.equal(f.writes, 0); assert.equal(f.c.status().requestedPercent, 125); assert.equal(f.c.status().effectivePercent, 100); assert.match(f.c.status().reason!, /融合/)
})
test('failed persistence preserves actual factor and exposes unsaved issue', async () => {
  const f = fixture(); f.setSnapshot({ preferences: { titleBarStyle: 'native', rememberBounds: true }, state: { maximized: false }, issue: 'Original config blocked' }); await f.c.setPercent(125); assert.equal(f.factor, 1); assert.match(f.c.status().issue!, /blocked/)
})
test('unexpected save rejection becomes bounded status error without leaking private text or applying', async () => {
  const f = fixture(); f.store.updatePreferences = async () => { throw Error('/private/original-path') }
  await f.c.setPercent(110); assert.equal(f.factor, 1); assert.equal(f.c.status().busy, false); assert.match(f.c.status().issue!, /未能保存/); assert.ok(!f.c.status().issue?.includes('/private/'))
  f.setFactor(1.25); await f.c.restore(); assert.equal(f.factor, 1); assert.match(f.c.status().issue!, /未能保存/)
})
test('unconfirmed native factor is null, never rounded into a valid published preset', async () => {
  const f = fixture(); f.setFactor(1.23); f.failApply(); await f.c.setPercent(125); assert.equal(f.c.status().requestedPercent, 125); assert.equal(f.c.status().effectivePercent, null); assert.match(f.c.status().issue!, /未能确认/)
})
test('failed live restore reports actual125 against requested100 and never claims an applied100', async () => {
  const f = fixture(); await f.c.setPercent(125); f.failApply(); await f.c.restore(); assert.equal(f.c.status().requestedPercent, 100); assert.equal(f.c.status().effectivePercent, 125); assert.match(f.c.status().issue!, /未能确认/)
})
test('live restore100 works for blocked unknown config, and reload keeps the live override', async () => {
  const f = fixture(); f.setFactor(1.25); f.setSnapshot({ preferences: { titleBarStyle: 'native', rememberBounds: true, zoomPercent: 125 }, state: { maximized: false }, issue: 'Unknown file retained' }); await f.c.restore(); assert.equal(f.factor, 1); assert.equal(f.c.status().requestedPercent, 125); assert.match(f.c.status().issue!, /retained/); f.setFactor(1.25); f.c.reconcile(); assert.equal(f.factor, 1)
})
test('actual original save owns busy through settlement; stopped generation cannot apply or publish later', async () => {
  const f = fixture(); let release!: () => void; f.setBeforeSave(() => new Promise<void>(r => { release = r })); const work = f.c.setPercent(125); assert.equal(f.c.status().busy, true); await assert.rejects(f.c.setPercent(90)); const published = f.publishes; f.c.stop(); release(); await assert.rejects(work, /关闭/); assert.equal(f.sets, 0); assert.equal(f.publishes, published)
})
test('reload/drift correction uses finite expected factor with no persistence writes', async () => {
  const f = fixture(); await f.c.setPercent(90); const writes = f.writes; f.setFactor(1.731); f.c.reconcile(); assert.equal(f.factor, .9); assert.equal(f.writes, writes)
})
test('drift check during failed save is retried once after actual settlement', async () => {
  const f = fixture(); let release!: () => void
  f.setBeforeSave(() => new Promise<void>(r => { release = r }))
  f.setSnapshot({ preferences: { titleBarStyle: 'native', rememberBounds: true }, state: { maximized: false }, issue: 'Original failed save' })
  const work = f.c.setPercent(125); f.setFactor(1.731); f.c.reconcile(); assert.equal(f.c.status().busy, true); release(); await work
  assert.equal(f.factor, 1); assert.equal(f.c.status().effectivePercent, 100); assert.match(f.c.status().issue!, /failed/); assert.equal(f.writes, 1)
})
test('menu steps clamp to presets and reset100 goes through the same finite setter', async () => {
  const f = fixture(); await f.c.step('in'); assert.equal(f.factor, 1.1); await f.c.step('in'); await f.c.step('in'); assert.equal(f.factor, 1.25); await f.c.step('out'); assert.equal(f.factor, 1.1); await f.c.step('reset'); assert.equal(f.factor, 1)
})
test('recognized shortcuts exclude composing/alt/edit keys while repeats can be prevented separately', () => {
  const key = { type: 'keyDown', key: '=', meta: true }; assert.equal(shortcutZoom(key, 'darwin'), 'in'); assert.equal(shortcutZoom({ ...key, key: '0' }, 'darwin'), 'reset'); assert.equal(shortcutZoom({ ...key, key: '-', meta: false, control: true }, 'win32'), 'out')
  for (const value of [{ ...key, isComposing: true }, { ...key, alt: true }, { ...key, type: 'keyUp' }, { ...key, key: 'c' }]) assert.equal(shortcutZoom(value, 'darwin'), undefined)
})
