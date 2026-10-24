import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { LauncherCore, type Instance } from './core'
import { captureDatapackWorld, inventoryDatapacks, verifyDatapackWorld, inspectDatapackItem, inspectDatapackZip } from './datapack-inspect'
import type { WorldRead } from './world-details'

type Options = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
const engine = { capture: captureDatapackWorld, inventory: inventoryDatapacks, verify: verifyDatapackWorld, item: inspectDatapackItem, zip: inspectDatapackZip }
const selection = (name = 'Original World') => ({ name, itemId: 'worlds:' + createHash('sha256').update(name).digest('hex') })
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function fixture(t: TestContext, options: Options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-datapack-'))
  const instances: Instance[] = [0, 1].map(index => ({ id: randomUUID(), name: `Original ${index}`, version: '1.21', loader: 'vanilla', status: 'ready', createdAt: '2026-10-24T00:00:00Z', playtimeMs: 0 }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances, settings: { memoryMode: 'auto', memoryMb: 2048, javaPath: '', concurrentDownloads: 4 } }))
  for (const instance of instances) await fs.mkdir(path.join(root, 'instances', instance.id, 'game', 'saves', selection().name), { recursive: true })
  const calls: string[] = []
  const core = new LauncherCore(root, undefined, { fetch: async () => { calls.push('network'); throw new Error('No network') },
    spawn: (() => { calls.push('spawn'); throw new Error('No Java or game') }) as Options['spawn'],
    javaRuntimeManager: { ensure: async () => { throw new Error('No Java') }, discover: async () => [] }, ...options })
  await core.init()
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  const id = (n = 0) => instances[n].id
  const world = (n = 0) => path.join(core.instanceDirectory(id(n)), 'game', 'saves', selection().name)
  return { root, core, id, world, calls }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function addZip(f: Fixture, name = 'original.zip', index = 0) {
  const zip = new AdmZip()
  zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 48, description: 'Original fixture' } })))
  zip.addFile('data/lua/function/test.mcfunction', Buffer.from('# inert original fixture, never executed'))
  const directory = path.join(f.world(index), 'datapacks')
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, name)
  await fs.writeFile(file, zip.toBuffer())
  return file
}
async function fingerprint(file: string) {
  const b = await fs.readFile(file), s = await fs.stat(file, { bigint: true })
  return [createHash('sha256').update(b).digest('hex'), ...[s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String)]
}

test('missing datapacks returns empty without creating folders or saving state', async t => {
  const f = await fixture(t), state = await fingerprint(path.join(f.root, 'launcher.json'))
  const result = await f.core.worldDatapacks(f.id(), selection(), randomUUID())
  assert.equal(result.instanceId, f.id()); assert.deepEqual(result.world, selection())
  assert.equal(result.directoryPresent, false); assert.deepEqual(result.items, [])
  assert.match(result.revision, /^[a-f0-9-]{36}$/)
  await assert.rejects(fs.stat(path.join(f.world(), 'datapacks')), { code: 'ENOENT' })
  assert.deepEqual(await fingerprint(path.join(f.root, 'launcher.json')), state); assert.deepEqual(f.calls, [])
  assert.ok(!JSON.stringify(result).includes(f.root))
})
test('real original ZIP preview fixes target and separates instance/world declared compatibility without writes', async t => {
  const f = await fixture(t), file = await addZip(f), state = await fingerprint(path.join(f.root, 'launcher.json')), before = await fingerprint(file)
  const inventory = await f.core.worldDatapacks(f.id(), selection(), randomUUID())
  const result = await f.core.inspectWorldDatapack(f.id(), inventory.revision, inventory.items[0].itemId, randomUUID())
  assert.equal(result.status, 'checked'); assert.equal(result.name, 'original.zip')
  assert.equal(result.instanceCompatibility.status, 'declared-compatible'); assert.equal(result.worldCompatibility.status, 'unknown')
  assert.equal(result.sha512, createHash('sha512').update(await fs.readFile(file)).digest('hex'))
  assert.ok(!JSON.stringify(result).includes(f.root)); assert.ok(!JSON.stringify(result).includes('revisionKey'))
  assert.deepEqual(await fingerprint(file), before); assert.deepEqual(await fingerprint(path.join(f.root, 'launcher.json')), state)
  assert.deepEqual(f.calls, [])
})
test('directory preview reads metadata only and never claims full directory verification', async t => {
  const f = await fixture(t), dir = path.join(f.world(), 'datapacks', 'original')
  await fs.mkdir(path.join(dir, 'data'), { recursive: true })
  await fs.writeFile(path.join(dir, 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: 48, description: 'Directory fixture' } }))
  const view = await f.core.worldDatapacks(f.id(), selection(), randomUUID())
  const result = await f.core.inspectWorldDatapack(f.id(), view.revision, view.items[0].itemId, randomUUID())
  assert.equal(result.kind, 'directory'); assert.equal(result.status, 'checked'); assert.equal(result.sha512, undefined)
  assert.ok(result.warnings.length); assert.equal(result.fileCount, undefined)
})
test('revision and item membership reject wrong instance, invented item and expired views before picker', async t => {
  let now = 100
  const f = await fixture(t, { worldDetailsNow: () => now })
  await addZip(f)
  const view = await f.core.worldDatapacks(f.id(), selection(), randomUUID())
  let picks = 0
  await assert.rejects(f.core.previewLocalDatapack(f.id(1), view.revision, randomUUID(), async () => { picks++; return undefined }))
  await assert.rejects(f.core.inspectWorldDatapack(f.id(), view.revision, 'invented', randomUUID()))
  now += 120001
  await assert.rejects(f.core.previewLocalDatapack(f.id(), view.revision, randomUUID(), async () => { picks++; return undefined }))
  assert.equal(picks, 0)
})
test('refresh and same-name replaced files invalidate earlier item confirmation', async t => {
  const f = await fixture(t), file = await addZip(f)
  const first = await f.core.worldDatapacks(f.id(), selection(), randomUUID())
  const next = await f.core.worldDatapacks(f.id(), selection(), randomUUID())
  await assert.rejects(f.core.inspectWorldDatapack(f.id(), first.revision, first.items[0].itemId, randomUUID()))
  await fs.rename(file, file + '.old'); await fs.copyFile(file + '.old', file)
  await assert.rejects(f.core.inspectWorldDatapack(f.id(), next.revision, next.items[0].itemId, randomUUID()))
})
test('cancel targets exactly one operation and holds update/instance exclusion until worker actually settles', async t => {
  const entered = deferred<void>(), release = deferred<void>()
  const f = await fixture(t, { datapackEngine: { ...engine, inventory: async (proof, options) => { entered.resolve(); await release.promise; return engine.inventory(proof, options) } } })
  const op = randomUUID(), pending = f.core.worldDatapacks(f.id(), selection(), op)
  const rejected = assert.rejects(pending, /取消/)
  await entered.promise
  f.core.cancelDatapackRead(f.id(1), op); f.core.cancelDatapackRead(f.id(), randomUUID())
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  assert.throws(() => f.core.assertLaunchAvailable(f.id()), /数据包/)
  await assert.rejects(f.core.updateInstanceSettings(f.id(), { name: 'Blocked', options: {} }), /数据包/)
  await f.core.updateInstanceSettings(f.id(1), { name: 'Allowed B', options: {} })
  f.core.cancelDatapackRead(f.id(), op)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  release.resolve(); await rejected
  const end = f.core.reserveLauncherUpdate(); end()
})
test('same-operation replay and shutdown invalidate capabilities without saving the world', async t => {
  const f = await fixture(t), op = randomUUID()
  const view = await f.core.worldDatapacks(f.id(), selection(), op)
  await assert.rejects(f.core.worldDatapacks(f.id(), selection(), op))
  f.core.cancelPendingOperations()
  let called = false
  await assert.rejects(f.core.previewLocalDatapack(f.id(), view.revision, randomUUID(), async () => { called = true; return undefined }))
  assert.equal(called, false)
})
test('late earlier inventory cannot issue a usable world revision after a newer view', async t => {
  const entered = deferred<void>(), release = deferred<void>(); let count = 0
  const f = await fixture(t, { datapackEngine: { ...engine, inventory: async (proof, options) => {
    if (++count === 1) { entered.resolve(); await release.promise }
    return engine.inventory(proof, options)
  } } })
  const old = f.core.worldDatapacks(f.id(), selection(), randomUUID()), rejected = assert.rejects(old)
  await entered.promise
  const current = await f.core.worldDatapacks(f.id(), selection(), randomUUID())
  release.resolve(); await rejected
  assert.equal((await f.core.previewLocalDatapack(f.id(), current.revision, randomUUID(), async () => undefined)), null)
})
test('native picker cancellation remains reserved and refuses its late selected file', async t => {
  const f = await fixture(t), file = await addZip(f), entered = deferred<void>(), pick = deferred<string>()
  const view = await f.core.worldDatapacks(f.id(), selection(), randomUUID()), op = randomUUID()
  const pending = f.core.previewLocalDatapack(f.id(), view.revision, op, async () => { entered.resolve(); return pick.promise })
  const rejected = assert.rejects(pending, /取消/)
  await entered.promise
  f.core.cancelDatapackRead(f.id(), op)
  assert.throws(() => f.core.assertLaunchAvailable(f.id()), /数据包/)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  pick.resolve(file); await rejected
  f.core.assertLaunchAvailable(f.id())
})
test('world replacement while native picker waits rejects selected local file before inspection', async t => {
  let inspected = 0
  const f = await fixture(t, { datapackEngine: { ...engine, zip: async (...args) => { inspected++; return engine.zip(...args) } } })
  const file = await addZip(f), entered = deferred<void>(), release = deferred<string>()
  const view = await f.core.worldDatapacks(f.id(), selection(), randomUUID())
  const pending = f.core.previewLocalDatapack(f.id(), view.revision, randomUUID(), async () => { entered.resolve(); return release.promise })
  const rejected = assert.rejects(pending)
  await entered.promise
  await fs.rename(f.world(), f.world() + '-old'); await fs.mkdir(f.world())
  release.resolve(file); await rejected
  assert.equal(inspected, 0)
})
test('saved world version is freshly read for each preview and never substituted with instance version', async t => {
  let version = '1.20.2'
  const f = await fixture(t, { worldDetailsReader: async (_directory, input) => ({ details: {
    itemId: input.itemId, folderName: input.name, source: 'level.dat', observedAt: new Date().toISOString(), status: 'ok',
    metadata: { savedVersionName: version }, fieldWarnings: [], warnings: [], seedAvailable: false }, revisionKey: 'private-inert-proof',
  } as WorldRead) })
  await addZip(f)
  const view = await f.core.worldDatapacks(f.id(), selection(), randomUUID())
  const first = await f.core.inspectWorldDatapack(f.id(), view.revision, view.items[0].itemId, randomUUID())
  assert.equal(first.worldCompatibility.status, 'declared-incompatible')
  version = '1.21'
  const second = await f.core.inspectWorldDatapack(f.id(), view.revision, view.items[0].itemId, randomUUID())
  assert.equal(second.worldCompatibility.status, 'declared-compatible')
  assert.ok(!JSON.stringify(second).includes('private-inert-proof'))
})
test('an active update blocks data-pack reads before picker and all read-only work', async t => {
  const f = await fixture(t), end = f.core.reserveLauncherUpdate()
  try {
    await assert.rejects(f.core.worldDatapacks(f.id(), selection(), randomUUID()), /更新/)
    let picks = 0
    await assert.rejects(f.core.previewLocalDatapack(f.id(), randomUUID(), randomUUID(), async () => { picks++; return undefined }), /更新/)
    assert.equal(picks, 0)
  } finally { end() }
})
test('public DTOs explicitly drop internal proof and future reader properties', async t => {
  const secret = '/private/original-inert-proof-never-expose'
  const f = await fixture(t, { datapackEngine: { ...engine,
    inventory: async (...args) => {
      const value = await engine.inventory(...args)
      return { ...value, sourcePath: secret, items: value.items.map(item => ({ ...item, proof: secret,
        metadata: item.metadata && { ...item.metadata, raw: secret } })) }
    },
    item: async (...args) => {
      const value = await engine.item(...args)
      return { ...value, sourcePath: secret, metadata: value.metadata && { ...value.metadata, raw: secret } }
    },
  } })
  await addZip(f)
  const view = await f.core.worldDatapacks(f.id(), selection(), randomUUID())
  const detail = await f.core.inspectWorldDatapack(f.id(), view.revision, view.items[0].itemId, randomUUID())
  assert.ok(!JSON.stringify(view).includes(secret)); assert.ok(!JSON.stringify(detail).includes(secret))
})
test('native removal reserves the instance before asynchronous trash so no data-pack read can race record removal', async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<void>()
  const view = await f.core.worldDatapacks(f.id(), selection(), randomUUID())
  const removal = f.core.removeInstance(f.id(), async directory => {
    entered.resolve(); await release.promise; await fs.rename(directory, directory + '-trashed-inert-fixture')
  })
  await entered.promise
  await assert.rejects(f.core.worldDatapacks(f.id(), selection(), randomUUID()))
  await assert.rejects(f.core.previewLocalDatapack(f.id(), view.revision, randomUUID(), async () => undefined))
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  release.resolve(); assert.deepEqual(await removal, { trashed: true })
  assert.ok(!f.core.snapshot().instances.some(item => item.id === f.id()))
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'launcher.json'), 'utf8'))
  assert.ok(!state.instances.some((item: Instance) => item.id === f.id()))
})
test('native removal is refused before trash if a data-pack worker is active; trash failure uses recoverable archive', async t => {
  const entered = deferred<void>(), release = deferred<void>()
  const f = await fixture(t, { datapackEngine: { ...engine, inventory: async (proof, options) => { entered.resolve(); await release.promise; return engine.inventory(proof, options) } } })
  const pending = f.core.worldDatapacks(f.id(), selection(), randomUUID())
  await entered.promise; let trashed = false
  await assert.rejects(f.core.removeInstance(f.id(), async () => { trashed = true }), /数据包/)
  assert.equal(trashed, false); release.resolve(); await pending
  assert.deepEqual(await f.core.removeInstance(f.id(), async () => { throw new Error('Injected trash failure') }), { trashed: false })
  assert.equal((await fs.readdir(path.join(f.root, 'deleted-instances'))).length, 1)
  assert.ok(!f.core.snapshot().instances.some(item => item.id === f.id()))
})
test('trash acknowledgement loss never archives a foreign replacement directory or forgets its record', async t => {
  const f = await fixture(t), directory = f.core.instanceDirectory(f.id()), foreign = 'Original foreign replacement bytes'
  await assert.rejects(f.core.removeInstance(f.id(), async source => {
    await fs.rename(source, source + '-moved-original')
    await fs.mkdir(source); await fs.writeFile(path.join(source, 'foreign.txt'), foreign)
    throw new Error('Injected native acknowledgement loss')
  }), /变化|保留/)
  assert.equal(await fs.readFile(path.join(directory, 'foreign.txt'), 'utf8'), foreign)
  assert.ok(f.core.snapshot().instances.some(item => item.id === f.id()))
  assert.ok(JSON.parse(await fs.readFile(path.join(f.root, 'launcher.json'), 'utf8')).instances.some((item: Instance) => item.id === f.id()))
  await assert.rejects(fs.stat(path.join(f.root, 'deleted-instances')), { code: 'ENOENT' })
})
