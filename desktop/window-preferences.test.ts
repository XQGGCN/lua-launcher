import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { WindowPreferenceStore, WINDOW_PREFERENCE_LIMITS, type WindowPreferenceStoreOptions } from './window-preferences'
const rect = { x: -1600, y: 80, width: 1240, height: 840 }
const defaults = { preferences: { titleBarStyle: 'integrated', rememberBounds: true }, state: { maximized: false } }
const body = (titleBarStyle = 'native') => ({ schema: 1, preferences: { titleBarStyle, rememberBounds: true }, windowState: { normalBounds: rect, maximized: true } })
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture(t: TestContext, options: WindowPreferenceStoreOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-window-preferences-')), file = path.join(root, 'window-preferences.json'), store = new WindowPreferenceStore(root, options)
  t.after(async () => { await store.flush(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, file, store }
}
async function proof(file: string) { const s = await fs.lstat(file, { bigint: true }); return { bytes: await fs.readFile(file), identity: [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs, s.nlink].map(String).join(':') } }

test('missing file gives defaults without eager write; first explicit change creates a checked schema1 file', async t => {
  const f = await fixture(t); await f.store.initialize(); assert.deepEqual(f.store.snapshot(), defaults); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' })
  const saved = await f.store.updatePreferences({ titleBarStyle: 'native' })
  assert.deepEqual(saved, { ...defaults, preferences: { ...defaults.preferences, titleBarStyle: 'native' } })
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).schema, 1)
  assert.deepEqual(await fs.readdir(f.root), ['window-preferences.json'])
})
test('valid human-formatted persisted preferences restore bounds/maximized and snapshots are independent copies', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, JSON.stringify(body(), null, 2)); const before = await proof(f.file)
  await Promise.all([f.store.initialize(), f.store.initialize()]); const snapshot = f.store.snapshot()
  assert.equal(snapshot.preferences.titleBarStyle, 'native'); assert.deepEqual(snapshot.state.normalBounds, rect); assert.equal(snapshot.state.maximized, true)
  snapshot.preferences.rememberBounds = false; snapshot.state.normalBounds!.x = 0
  assert.equal(f.store.snapshot().preferences.rememberBounds, true); assert.equal(f.store.snapshot().state.normalBounds?.x, -1600); assert.deepEqual(await proof(f.file), before)
})
test('serialized preference/state patches merge latest committed data and flush waits the real blocked write', async t => {
  const entered = gate(), release = gate(); let first = true
  const f = await fixture(t, { hooks: { beforePublish: async () => { if (first) { first = false; entered.resolve(); await release.promise } } } })
  const a = f.store.updatePreferences({ titleBarStyle: 'native' }), b = f.store.updatePreferences({ rememberBounds: false }), c = f.store.saveWindowState({ normalBounds: rect, maximized: true })
  await entered.promise; let flushed = false; const flush = f.store.flush().then(() => { flushed = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(flushed, false); assert.deepEqual(f.store.snapshot(), defaults)
  release.resolve(); await Promise.all([a, b, c, flush]); const result = f.store.snapshot()
  assert.deepEqual(result.preferences, { titleBarStyle: 'native', rememberBounds: false }); assert.deepEqual(result.state, { normalBounds: rect, maximized: true }); assert.equal(flushed, true)
})
test('maximize-only state saves preserve normal bounds; explicit undefined clears bounds', async t => {
  const f = await fixture(t); await f.store.saveWindowState({ normalBounds: rect, maximized: false }); await f.store.saveWindowState({ maximized: true })
  assert.deepEqual(f.store.snapshot().state, { normalBounds: rect, maximized: true })
  await f.store.saveWindowState({ normalBounds: undefined, maximized: false }); assert.deepEqual(f.store.snapshot().state, { maximized: false })
})
test('invalid renderer preference patches reject without getters/prototype execution or poisoning queued good work', async t => {
  const f = await fixture(t); let touched = false
  for (const bad of [null, [], true, { titleBarStyle: 'frameless' }, { rememberBounds: 'true' }, { titleBarStyle: undefined }, { zoomPercent: 126 }, { x: 1 }, Object.create({ rememberBounds: true }), { get rememberBounds() { touched = true; return true } }]) await assert.rejects(f.store.updatePreferences(bad), /窗口偏好参数无效/)
  assert.equal(touched, false); assert.equal((await f.store.updatePreferences({ titleBarStyle: 'native' })).preferences.titleBarStyle, 'native')
})
test('state only accepts finite integer exact rectangles/boolean and invalid saves do not reach disk', async t => {
  const f = await fixture(t)
  for (const bad of [{}, { maximized: 'false' }, { maximized: false, fullscreen: true }, { maximized: false, normalBounds: { ...rect, x: NaN } }, { maximized: false, normalBounds: { ...rect, width: 1.5 } }, { maximized: false, normalBounds: { ...rect, x: 1_000_001 } }, { maximized: false, normalBounds: { ...rect, height: 0 } }]) await assert.rejects(f.store.saveWindowState(bad))
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' }); assert.deepEqual(await f.store.saveWindowState({ normalBounds: rect, maximized: false }), { ...defaults, state: { normalBounds: rect, maximized: false } })
})
test('bad JSON/schema/fields/bounds/duplicates/oversize files use nonfatal defaults and never auto-overwrite', async t => {
  const invalid = [Buffer.from('not JSON'), encode({ ...body(), schema: 2 }), encode({ ...body(), zoomPercent: 125 }), encode({ ...body(), preferences: { titleBarStyle: 'native', rememberBounds: 'yes' } }), encode({ ...body(), windowState: { maximized: true, normalBounds: { ...rect, x: Infinity } } }),
    Buffer.from('{"schema":1,"schema":1,"preferences":{"titleBarStyle":"native","rememberBounds":true},"windowState":{"maximized":false}}'), Buffer.alloc(WINDOW_PREFERENCE_LIMITS.bytes + 1), Buffer.from('')]
  for (const bytes of invalid) {
    const f = await fixture(t); await fs.writeFile(f.file, bytes); const before = await proof(f.file); await f.store.initialize()
    assert.deepEqual(f.store.snapshot().preferences, defaults.preferences); assert.ok(f.store.snapshot().issue)
    const result = await f.store.updatePreferences({ titleBarStyle: 'native' }); assert.equal(result.preferences.titleBarStyle, 'integrated'); assert.ok(result.issue); assert.deepEqual(await proof(f.file), before)
  }
})
test('static config and root symlinks are preserved and their foreign targets are never read as preferences or written', async t => {
  const f = await fixture(t), target = path.join(f.root, 'foreign.json'); await fs.writeFile(target, encode(body())); const before = await proof(target); await fs.symlink(target, f.file)
  await f.store.initialize(); assert.equal(f.store.snapshot().preferences.titleBarStyle, 'integrated'); assert.ok(f.store.snapshot().issue)
  await f.store.updatePreferences({ rememberBounds: false }); assert.deepEqual(await proof(target), before); assert.equal((await fs.lstat(f.file)).isSymbolicLink(), true)
  const real = path.join(f.root, 'real'), alias = path.join(f.root, 'alias'); await fs.mkdir(real); await fs.symlink(real, alias)
  const linked = new WindowPreferenceStore(alias); await linked.initialize(); assert.ok(linked.snapshot().issue); await linked.updatePreferences({ titleBarStyle: 'native' }); assert.deepEqual(await fs.readdir(real), [])
})
test('a missing data root fails nonfatally and is never recursively created', async t => {
  const f = await fixture(t), missing = path.join(f.root, 'missing', 'data'), store = new WindowPreferenceStore(missing)
  await store.initialize(); assert.ok(store.snapshot().issue); await store.updatePreferences({ titleBarStyle: 'native' }); await assert.rejects(fs.stat(path.dirname(missing)), { code: 'ENOENT' })
})
test('short writes complete full bytes with independent readback', async t => {
  let writes = 0
  const f = await fixture(t, { hooks: { write: async (handle, bytes, offset, length, position) => { writes++; return (await handle.write(bytes, offset, Math.min(length, 7), position)).bytesWritten } } })
  const result = await f.store.updatePreferences({ titleBarStyle: 'native' }); assert.equal(result.issue, undefined); assert.ok(writes > 1)
  const again = new WindowPreferenceStore(f.root); await again.initialize(); assert.deepEqual(again.snapshot(), result)
})
test('zero/invalid/disk-full writes keep committed data, redact OS errors and do not poison future queue', async t => {
  for (const mode of ['zero', 'nan', 'oversize', 'disk']) {
    let failing = true
    const f = await fixture(t, { hooks: { write: async (handle, bytes, offset, length, position) => {
      if (failing) { failing = false; if (mode === 'zero') return 0; if (mode === 'nan') return NaN; if (mode === 'oversize') return length + 1; throw new Error('ENOSPC /private/secret-user') }
      return (await handle.write(bytes, offset, length, position)).bytesWritten
    } } })
    const failed = await f.store.updatePreferences({ titleBarStyle: 'native' }); assert.equal(failed.preferences.titleBarStyle, 'integrated'); assert.ok(failed.issue); assert.equal(failed.issue.includes('/private/secret-user'), false)
    const result = await f.store.updatePreferences({ rememberBounds: false }); assert.deepEqual(result.preferences, { titleBarStyle: 'integrated', rememberBounds: false }); assert.equal(result.issue, undefined)
  }
})
test('rename failure preserves the last complete settings and a subsequent explicit retry can succeed', async t => {
  let failing = true
  const f = await fixture(t, { hooks: { rename: async (from, to) => { if (failing) { failing = false; throw new Error('simulated permission failure') } await fs.rename(from, to) } } })
  await f.store.updatePreferences({ titleBarStyle: 'native' }); const before = await proof(f.file)
  const failed = await f.store.updatePreferences({ rememberBounds: false }); assert.equal(failed.preferences.rememberBounds, true); assert.ok(failed.issue); assert.deepEqual(await proof(f.file), before)
  const result = await f.store.updatePreferences({ rememberBounds: false }); assert.equal(result.preferences.rememberBounds, false); assert.equal(result.issue, undefined)
})
test('lost rename and first-link acknowledgements are resolved by exact known generated node/hash', async t => {
  const f = await fixture(t, { hooks: { link: async (from, to) => { await fs.link(from, to); throw new Error('link ACK lost') }, rename: async (from, to) => { await fs.rename(from, to); throw new Error('rename ACK lost') } } })
  assert.equal((await f.store.updatePreferences({ titleBarStyle: 'native' })).issue, undefined)
  assert.equal((await f.store.updatePreferences({ rememberBounds: false })).issue, undefined)
  assert.equal(f.store.snapshot().preferences.rememberBounds, false)
})
test('foreign file appearing before initial publish is preserved by no-replace and fresh absence proof', async t => {
  let file = ''
  const f = await fixture(t, { hooks: { beforePublish: async () => { await fs.writeFile(file, 'foreign data') } } }); file = f.file
  const result = await f.store.updatePreferences({ titleBarStyle: 'native' }); assert.equal(result.preferences.titleBarStyle, 'integrated'); assert.ok(result.issue)
  assert.equal(await fs.readFile(f.file, 'utf8'), 'foreign data'); await f.store.saveWindowState({ maximized: true }); assert.equal(await fs.readFile(f.file, 'utf8'), 'foreign data')
})
test('same-size current file change blocks replacement even if valid JSON and never overwrites the unknown bytes', async t => {
  let file = '', modify = false
  const f = await fixture(t, { hooks: { beforePublish: async () => { if (modify) { const bytes = await fs.readFile(file); bytes[bytes.length - 1] = 0x20; await fs.writeFile(file, bytes) } } } }); file = f.file
  await f.store.updatePreferences({ titleBarStyle: 'native' }); modify = true
  const result = await f.store.updatePreferences({ rememberBounds: false }); assert.equal(result.preferences.rememberBounds, true); assert.ok(result.issue); const after = await proof(f.file)
  await f.store.saveWindowState({ maximized: true }); assert.deepEqual(await proof(f.file), after)
})
test('post-publish unknown bytes fail without fake committed snapshot or broad cleanup', async t => {
  let file = ''
  const f = await fixture(t, { hooks: { afterPublish: async () => { await fs.writeFile(file, 'unknown result') } } }); file = f.file
  const result = await f.store.updatePreferences({ titleBarStyle: 'native' }); assert.equal(result.preferences.titleBarStyle, 'integrated'); assert.ok(result.issue); assert.equal(await fs.readFile(file, 'utf8'), 'unknown result')
  await f.store.updatePreferences({ rememberBounds: false }); assert.equal(await fs.readFile(file, 'utf8'), 'unknown result')
})
test('private temp identity replacement is retained and never deleted as if owned', async t => {
  let root = '', changed = ''
  const f = await fixture(t, { hooks: { beforePublish: async () => { const [name] = (await fs.readdir(root)).filter(name => name.startsWith('.window-preferences-')); changed = path.join(root, name); await fs.rename(changed, changed + '.original'); await fs.writeFile(changed, 'foreign temp-looking data') } } }); root = f.root
  const result = await f.store.updatePreferences({ titleBarStyle: 'native' }); assert.ok(result.issue); assert.equal(await fs.readFile(changed, 'utf8'), 'foreign temp-looking data')
})
test('failed write acknowledgement with unacknowledged bytes retains that uncertain private file', async t => {
  const f = await fixture(t, { hooks: { write: async (handle, bytes, offset, length, position) => { await handle.write(bytes, offset, Math.min(length, 11), position); throw new Error('write ACK lost') } } })
  const result = await f.store.updatePreferences({ titleBarStyle: 'native' }); assert.ok(result.issue)
  const files = await fs.readdir(f.root); assert.equal(files.length, 1); assert.equal((await fs.stat(path.join(f.root, files[0]))).size, 11); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' })
})
test('unrelated instance/account files and unknown old temp files remain byte and identity unchanged', async t => {
  const f = await fixture(t), names = ['launcher-state.json', 'session.json', '.window-preferences-old.tmp'], before = new Map<string, Awaited<ReturnType<typeof proof>>>()
  for (const name of names) { const file = path.join(f.root, name); await fs.writeFile(file, 'original inert sentinel ' + name); before.set(file, await proof(file)) }
  await f.store.updatePreferences({ titleBarStyle: 'native' }); await f.store.saveWindowState({ normalBounds: rect, maximized: true }); await f.store.flush()
  for (const [file, expected] of before) assert.deepEqual(await proof(file), expected)
})

const body2 = (zoomPercent: unknown) => ({ ...body(), schema: 2, preferences: { ...body().preferences, zoomPercent } })
test('schema1 read/state/titlebar autosaves retain exact legacy preferences without adding default zoom', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, JSON.stringify(body(), null, 2)); const before = await proof(f.file)
  await f.store.initialize(); assert.equal(Object.hasOwn(f.store.snapshot().preferences, 'zoomPercent'), false); assert.equal(f.store.snapshot().preferences.zoomPercent ?? 100, 100); assert.deepEqual(await proof(f.file), before)
  await f.store.saveWindowState({ maximized: false }); await f.store.updatePreferences({ titleBarStyle: 'integrated' })
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(stored.schema, 1); assert.equal(Object.hasOwn(stored.preferences, 'zoomPercent'), false); assert.deepEqual(stored.windowState.normalBounds, rect)
})
test('explicit100 on legacy/default data is a no-op; combined patch still writes only schema1', async t => {
  const empty = await fixture(t); assert.equal(Object.hasOwn((await empty.store.updatePreferences({ zoomPercent: 100 })).preferences, 'zoomPercent'), false); await assert.rejects(fs.stat(empty.file), { code: 'ENOENT' })
  const f = await fixture(t); await fs.writeFile(f.file, encode(body())); await f.store.initialize(); const before = await proof(f.file)
  await f.store.updatePreferences({ zoomPercent: 100 }); assert.deepEqual(await proof(f.file), before)
  await f.store.updatePreferences({ zoomPercent: 100, rememberBounds: false }); const stored = JSON.parse(await fs.readFile(f.file, 'utf8'))
  assert.equal(stored.schema, 1); assert.deepEqual(stored.preferences, { titleBarStyle: 'native', rememberBounds: false })
})
test('each nondefault explicit zoom promotes to required schema2 and restores on a new store', async t => {
  for (const zoomPercent of [90, 110, 125] as const) {
    const f = await fixture(t), result = await f.store.updatePreferences({ zoomPercent })
    assert.equal(result.preferences.zoomPercent, zoomPercent); assert.equal(result.issue, undefined)
    const stored = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(stored.schema, 2); assert.equal(stored.preferences.zoomPercent, zoomPercent)
    const again = new WindowPreferenceStore(f.root); await again.initialize(); assert.deepEqual(again.snapshot(), result)
  }
})
test('schema2 exact four enums including100 restore read-only without rewriting human formatting', async t => {
  for (const zoomPercent of [90, 100, 110, 125]) {
    const f = await fixture(t); await fs.writeFile(f.file, JSON.stringify(body2(zoomPercent), null, 2)); const before = await proof(f.file)
    await f.store.initialize(); const snapshot = f.store.snapshot(); assert.equal(snapshot.preferences.zoomPercent, zoomPercent); assert.deepEqual(snapshot.state.normalBounds, rect); assert.equal(snapshot.issue, undefined); assert.deepEqual(await proof(f.file), before)
  }
})
test('all later state/style writes and reset100 retain an already committed schema2', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, encode(body2(125))); await f.store.initialize()
  await f.store.saveWindowState({ maximized: false }); await f.store.updatePreferences({ titleBarStyle: 'integrated', rememberBounds: false }); assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).preferences.zoomPercent, 125)
  await f.store.updatePreferences({ zoomPercent: 100 }); await f.store.saveWindowState({ normalBounds: { ...rect, y: 120 }, maximized: true })
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(stored.schema, 2); assert.equal(stored.preferences.zoomPercent, 100); assert.equal(stored.windowState.normalBounds.y, 120)
  const before = await proof(f.file); await f.store.updatePreferences({ zoomPercent: 100 }); assert.deepEqual(await proof(f.file), before)
})
test('zoom enum validation rejects undefined/NaN/fractional/string/object/unknown fields before persistence', async t => {
  const f = await fixture(t); let touched = false
  for (const zoomPercent of [undefined, null, NaN, Infinity, -Infinity, 0, 89, 91, 101, 124, 126, 1.25, '110', 110n, {}, []]) await assert.rejects(f.store.updatePreferences({ zoomPercent }), /窗口偏好参数无效/)
  await assert.rejects(f.store.updatePreferences({ zoomLevel: 1 })); await assert.rejects(f.store.updatePreferences({ get zoomPercent() { touched = true; return 110 } })); assert.equal(touched, false)
  assert.deepEqual(f.store.snapshot(), defaults); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' })
})
test('schema1 with zoom and malformed/unknown schema2 never downgrade to writable defaults', async t => {
  const records = [
    { ...body2(110), schema: 1 }, { ...body(), schema: 2 }, body2(105), body2('110'), body2(null),
    { ...body2(110), preferences: { ...body2(110).preferences, future: true } }, { ...body2(110), schema: 3 },
    { ...body2(110), preferences: { zoomPercent: 110, titleBarStyle: 'native' } },
  ]
  for (const record of records) {
    const f = await fixture(t); await fs.writeFile(f.file, encode(record)); const before = await proof(f.file); await f.store.initialize()
    assert.ok(f.store.snapshot().issue); assert.equal(Object.hasOwn(f.store.snapshot().preferences, 'zoomPercent'), false)
    await f.store.updatePreferences({ zoomPercent: 100 }); await f.store.saveWindowState({ maximized: true }); assert.deepEqual(await proof(f.file), before)
  }
})
test('duplicate or escaped duplicate zoom keys remain invalid persisted input', async t => {
  for (const key of ['zoomPercent', 'zoom\\u0050ercent']) {
    const f = await fixture(t), raw = Buffer.from('{"schema":2,"preferences":{"titleBarStyle":"native","rememberBounds":true,"zoomPercent":110,"' + key + '":125},"windowState":{"maximized":false}}')
    await fs.writeFile(f.file, raw); const before = await proof(f.file); await f.store.initialize(); assert.ok(f.store.snapshot().issue); await f.store.updatePreferences({ zoomPercent: 90 }); assert.deepEqual(await proof(f.file), before)
  }
})
test('queued110 then100 plus state/style patches resolve lazy schema from latest committed state', async t => {
  const entered = gate(), release = gate(); let first = true
  const f = await fixture(t, { hooks: { beforePublish: async () => { if (first) { first = false; entered.resolve(); await release.promise } } } })
  const promote = f.store.updatePreferences({ zoomPercent: 110 }), reset = f.store.updatePreferences({ zoomPercent: 100 }), state = f.store.saveWindowState({ normalBounds: rect, maximized: true }), style = f.store.updatePreferences({ titleBarStyle: 'native', rememberBounds: false })
  await entered.promise; assert.equal(Object.hasOwn(f.store.snapshot().preferences, 'zoomPercent'), false); release.resolve(); await Promise.all([promote, reset, state, style]); await f.store.flush()
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(stored.schema, 2); assert.deepEqual(stored.preferences, { titleBarStyle: 'native', rememberBounds: false, zoomPercent: 100 }); assert.deepEqual(stored.windowState, { normalBounds: rect, maximized: true })
})
test('failed promotion preserves schema1/value and later state autosave does not accidentally migrate', async t => {
  let fail = true
  const f = await fixture(t, { hooks: { rename: async (from, to) => { if (fail) { fail = false; throw new Error('injected transient promotion failure') } await fs.rename(from, to) } } })
  await fs.writeFile(f.file, encode(body())); await f.store.initialize(); const before = await proof(f.file)
  const failed = await f.store.updatePreferences({ zoomPercent: 110 }); assert.ok(failed.issue); assert.equal(Object.hasOwn(failed.preferences, 'zoomPercent'), false); assert.deepEqual(await proof(f.file), before)
  await f.store.saveWindowState({ maximized: false }); assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).schema, 1)
  await f.store.updatePreferences({ zoomPercent: 125 }); assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).schema, 2)
})
test('failed first zoom creation is not remembered as migrated when a later geometry save succeeds', async t => {
  let fail = true
  const f = await fixture(t, { hooks: { link: async (from, to) => { if (fail) { fail = false; throw new Error('injected first-creation failure') } await fs.link(from, to) } } })
  const failed = await f.store.updatePreferences({ zoomPercent: 90 }); assert.ok(failed.issue); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' })
  await f.store.saveWindowState({ normalBounds: rect, maximized: true }); const legacy = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(legacy.schema, 1); assert.equal(Object.hasOwn(legacy.preferences, 'zoomPercent'), false)
})
test('failed schema2 reset keeps old zoom/schema and unrelated saves cannot forget that value', async t => {
  let fail = true
  const f = await fixture(t, { hooks: { rename: async (from, to) => { if (fail) { fail = false; throw new Error('injected reset failure') } await fs.rename(from, to) } } })
  await fs.writeFile(f.file, encode(body2(110))); await f.store.initialize(); const failed = await f.store.updatePreferences({ zoomPercent: 100 })
  assert.ok(failed.issue); assert.equal(failed.preferences.zoomPercent, 110)
  await f.store.updatePreferences({ titleBarStyle: 'integrated' }); assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).preferences.zoomPercent, 110)
  await f.store.updatePreferences({ zoomPercent: 100 }); const stored = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(stored.schema, 2); assert.equal(stored.preferences.zoomPercent, 100)
})
test('promotion/reset with lost publication acknowledgements retain checked schema2 and finite enum values', async t => {
  const f = await fixture(t, { hooks: { link: async (from, to) => { await fs.link(from, to); throw new Error('first ACK lost') }, rename: async (from, to) => { await fs.rename(from, to); throw new Error('rename ACK lost') } } })
  assert.equal((await f.store.updatePreferences({ zoomPercent: 90 })).preferences.zoomPercent, 90)
  assert.equal((await f.store.updatePreferences({ zoomPercent: 100 })).preferences.zoomPercent, 100)
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(stored.schema, 2); assert.equal(stored.preferences.zoomPercent, 100); assert.equal(f.store.snapshot().issue, undefined)
})
test('schema2 target behind a static symlink is not adopted or overwritten during reset100', async t => {
  const f = await fixture(t), target = path.join(f.root, 'unknown-settings.json'); await fs.writeFile(target, encode(body2(125))); await fs.symlink(target, f.file); const before = await proof(target)
  await f.store.initialize(); assert.ok(f.store.snapshot().issue); await f.store.updatePreferences({ zoomPercent: 100 }); assert.deepEqual(await proof(target), before); assert.equal((await fs.lstat(f.file)).isSymbolicLink(), true)
})
