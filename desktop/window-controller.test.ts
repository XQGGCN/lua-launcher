import test from 'node:test'
import assert from 'node:assert/strict'
import { boundedWindowFlush, WindowController, type WindowPort } from './window-controller'
import type { WindowPreferencesSnapshot, WindowRect } from './window-preferences-types'

function fixture() {
  let snapshot: WindowPreferencesSnapshot = { preferences: { titleBarStyle: 'integrated', rememberBounds: true }, state: { maximized: false } }
  const flags = { minimized: false, maximized: false, full: false, visible: true, destroyed: false }
  let bounds: WindowRect = { x: 20, y: 30, width: 1000, height: 700 }; let writes = 0; let moves = 0
  let beforeSave: (() => Promise<void>) | undefined
  const w: WindowPort = {
    isDestroyed: () => flags.destroyed, isMinimized: () => flags.minimized, isMaximized: () => flags.maximized,
    isFullScreen: () => flags.full, isVisible: () => flags.visible, getNormalBounds: () => ({ ...bounds }),
    setBounds: b => { bounds = { ...b }; moves++ }, setSize: (width, height) => { bounds = { ...bounds, width, height }; moves++ },
    setMinimumSize: () => {}, unmaximize: () => { flags.maximized = false },
  }
  const store = { snapshot: () => structuredClone(snapshot), saveWindowState: async (state: WindowPreferencesSnapshot['state']) => { await beforeSave?.(); writes++; snapshot = { ...snapshot, state }; return structuredClone(snapshot) }, flush: async () => {} }
  const changes: unknown[] = []
  const options = { store, window: w, platform: 'darwin', effectiveTitleBarStyle: 'integrated' as const, positionManagedByDesktop: false, displays: () => ({ workAreas: [{ x: 0, y: 0, width: 1440, height: 900 }] }), background: async <T>(work: () => Promise<T>) => work(), changed: (s: unknown) => changes.push(s), debounceMs: 60000 }
  const c = new WindowController(options)
  return { c, options, w, flags, store, changes, get bounds() { return bounds }, set bounds(b: WindowRect) { bounds = b }, get writes() { return writes }, get moves() { return moves }, setSnapshot: (s: WindowPreferencesSnapshot) => { snapshot = s }, setBeforeSave: (fn: () => Promise<void>) => { beforeSave = fn } }
}
test('bounded close wait resolves false for hung/rejected flush, true only for settled work', async () => {
  assert.equal(await boundedWindowFlush(() => new Promise(() => {}), 20), false)
  assert.equal(await boundedWindowFlush(async () => { throw Error('disk') }, 20), false)
  assert.equal(await boundedWindowFlush(async () => {}, 20), true)
  let release!: () => void; const pending = new Promise<void>(r => { release = r })
  assert.equal(await boundedWindowFlush(() => pending, 20), false); release(); await pending
})
test('normal placement and maximized memory persist separately; minimize/fullscreen/hidden do not overwrite', async () => {
  const f = fixture(); f.c.capture(); await f.c.flush(); assert.equal(f.writes, 1)
  f.flags.maximized = true; f.c.capture('maximize'); await f.c.flush(); assert.equal(f.store.snapshot().state.maximized, true)
  const normal = f.store.snapshot().state.normalBounds
  for (const key of ['minimized', 'full', 'visible'] as const) { const old = f.flags[key]; f.flags[key] = key !== 'visible'; f.bounds = { x: 999, y: 999, width: 999, height: 999 }; f.c.capture(); await f.c.flush(); f.flags[key] = old }
  assert.equal(f.writes, 2); assert.deepEqual(f.store.snapshot().state.normalBounds, normal); assert.equal(f.store.snapshot().state.maximized, true); f.c.stop()
})
test('preferred native is pending without touching current window or effective chrome', async () => {
  const f = fixture(); f.setSnapshot({ preferences: { titleBarStyle: 'native', rememberBounds: true }, state: { maximized: false } })
  const status = await f.c.preferencesChanged(); assert.equal(status.effectiveTitleBarStyle, 'integrated'); assert.equal(status.pendingTitleBarChange, true); assert.equal(f.moves, 0); f.c.stop()
})
test('maximized native bounds cannot replace last known ordinary placement', async () => {
  const f = fixture(); f.c.capture(); await f.c.flush(); const normal = f.store.snapshot().state.normalBounds
  f.flags.maximized = true; f.bounds = { x: 0, y: 39, width: 1800, height: 1130 }; f.c.capture('maximize'); await f.c.flush()
  assert.equal(f.store.snapshot().state.maximized, true); assert.deepEqual(f.store.snapshot().state.normalBounds, normal); f.c.stop()
})
test('intermediate animated zoom resize is not sampled before maximize settles', async () => {
  const f = fixture(); f.c.capture(); await f.c.flush(); const normal = f.store.snapshot().state.normalBounds
  f.bounds = { x: 0, y: 39, width: 1789, height: 1125 }; f.c.capture()
  f.flags.maximized = true; f.c.capture('maximize'); await f.c.flush()
  assert.deepEqual(f.store.snapshot().state.normalBounds, normal); f.c.stop()
})
test('startup maximized state without saved normal bounds keeps constructor placement as fallback', async () => {
  const f = fixture(); f.c.stop(); f.setSnapshot({ preferences: { titleBarStyle: 'integrated', rememberBounds: true }, state: { maximized: true } })
  const c = new WindowController(f.options), normal = { ...f.bounds }; f.flags.maximized = true; f.bounds = { x: 0, y: 39, width: 1800, height: 1130 }; c.capture('maximize'); await c.flush()
  assert.deepEqual(f.store.snapshot().state.normalBounds, normal); c.stop()
})
test('stop drops old callbacks and cannot move or queue writes for a successor', async () => {
  const f = fixture(); f.c.stop(); f.c.capture(); f.c.reconcile(); await f.c.flush(); assert.equal(f.writes, 0); assert.equal(f.moves, 0)
})
test('disable remember ignores geometry; explicit reset still resizes current window', async () => {
  const f = fixture(); f.setSnapshot({ preferences: { titleBarStyle: 'integrated', rememberBounds: false }, state: { maximized: false } }); f.c.capture(); await f.c.flush(); assert.equal(f.writes, 0)
  await f.c.resetPlacement(); assert.equal(f.moves, 1); assert.equal(f.writes, 0); f.c.stop()
})
test('re-enabling memory captures current ordinary window instead of obsolete disabled maximized state', async () => {
  const f = fixture(); f.c.stop(); f.setSnapshot({ preferences: { titleBarStyle: 'integrated', rememberBounds: false }, state: { maximized: true } })
  const c = new WindowController(f.options); f.setSnapshot({ preferences: { titleBarStyle: 'integrated', rememberBounds: true }, state: { maximized: true } })
  await c.preferencesChanged(); assert.equal(f.store.snapshot().state.maximized, false); assert.deepEqual(f.store.snapshot().state.normalBounds, f.bounds); c.stop()
})
test('a move during in-flight save is flushed after actual first write, never silently lost', async () => {
  const f = fixture(); let release!: () => void; const wait = new Promise<void>(r => { release = r }); let called = false
  f.setBeforeSave(async () => { if (!called) { called = true; await wait } }); f.c.capture(); const pending = f.c.flush()
  f.bounds = { x: -300, y: 100, width: 1100, height: 750 }; f.c.capture(); release(); await pending
  assert.equal(f.writes, 2); assert.deepEqual(f.store.snapshot().state.normalBounds, f.bounds); f.c.stop()
})
test('updater exclusion rejects background save without weakening gate or faking persisted position', async () => {
  const f = fixture(); f.options.background = async () => { throw Error('updating') }; f.c.capture(); await f.c.flush(); assert.equal(f.writes, 0); assert.match(f.c.status().issue!, /尚未保存/); f.c.stop()
})
test('display correction only moves an unusable normal window, keeps maximized state', async () => {
  const f = fixture(); f.bounds = { x: 9999, y: 9999, width: 1200, height: 800 }; f.c.reconcile(); assert.equal(f.moves, 1); assert.ok(f.bounds.x < 1440)
  f.flags.maximized = true; f.bounds = { x: 9999, y: 9999, width: 1200, height: 800 }; f.c.reconcile(); assert.equal(f.moves, 1); assert.equal(f.flags.maximized, true); f.c.stop()
})
test('desktop-managed position does not record invented coordinates or call setBounds', async () => {
  const f = fixture(); f.c.stop(); const c = new WindowController({ ...f.options, platform: 'linux', positionManagedByDesktop: true, effectiveTitleBarStyle: 'native' }); f.flags.maximized = true; c.capture('maximize'); await c.flush(); assert.equal(f.store.snapshot().state.normalBounds, undefined); assert.equal(c.status().supportsTitleBarStyle, false)
  c.reconcile(); await c.resetPlacement(); assert.equal(f.moves, 1); assert.equal(f.store.snapshot().state.maximized, false); c.stop()
})
