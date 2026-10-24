import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { LauncherCore, type Instance } from './core'
import { inspectModJar, inspectInstalledMod } from './mod-jar'
import type { InstalledModSelection, ModJarDetails } from './mod-details-types'

type Options = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const digest = (bytes: Uint8Array, kind = 'sha512') => createHash(kind).update(bytes).digest('hex')
async function fixture(t: TestContext, options: Options = {}, loaders: Instance['loader'][] = ['fabric', 'fabric', 'vanilla']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-mod-details-'))
  const instances: Instance[] = loaders.map((loader, index) => ({ id: randomUUID(), name: `Original ${index}`, version: '1.21.1', loader,
    status: 'ready', createdAt: '2026-10-24T00:00:00Z', playtimeMs: 0 }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances, settings: { javaPath: '', memoryMode: 'auto', memoryMb: 2048, concurrentDownloads: 4 } }))
  const calls: string[] = []
  const core = new LauncherCore(root, undefined, { fetch: async () => { calls.push('network'); throw new Error('No network') },
    spawn: (() => { calls.push('spawn'); throw new Error('No Java or game') }) as Options['spawn'],
    javaRuntimeManager: { ensure: async () => { throw new Error('No Java') }, discover: async () => [] }, ...options })
  await core.init()
  const zip = new AdmZip()
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'original_fixture', version: '1.0-original', name: 'Original fixture',
    authors: ['Original author'], license: 'MIT', environment: 'client', depends: { minecraft: '~1.21', fabricloader: '>=0.16' } })))
  zip.addFile('inert.txt', Buffer.from('Original inert bytes; not a compiled class or executable'))
  const local = path.join(root, 'Original-local.jar'); await fs.writeFile(local, zip.toBuffer())
  const id = (i = 0) => instances[i].id, mods = (i = 0) => path.join(core.getInstancePath(id(i)), 'mods')
  const add = async (name = 'Original.jar', i = 0) => { await fs.mkdir(mods(i), { recursive: true }); const file = path.join(mods(i), name); await fs.copyFile(local, file); return file }
  const selection = async (name = 'Original.jar', i = 0): Promise<InstalledModSelection> => { const info = await fs.stat(path.join(mods(i), name)); return {
    itemId: 'mods:' + digest(Buffer.from(name), 'sha256'), name, sizeBytes: info.size, modifiedAt: new Date(info.mtimeMs).toISOString(),
  } }
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, core, id, mods, add, selection, local, calls }
}
async function fingerprint(file: string) {
  const bytes = await fs.readFile(file), s = await fs.lstat(file, { bigint: true })
  return [digest(bytes), ...[s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String)]
}

test('selected installed JAR returns bounded declarations and outer hash without source or state writes', async t => {
  const f = await fixture(t), file = await f.add(), before = await fingerprint(file), state = await fingerprint(path.join(f.root, 'launcher.json'))
  const result = await f.core.inspectInstanceMod(f.id(), await f.selection(), randomUUID())
  assert.equal(result.instanceId, f.id()); assert.equal(result.source, 'installed'); assert.match(result.viewId, /^[a-f0-9-]{36}$/)
  assert.equal(result.status, 'metadata-read'); assert.equal(result.assessment.status, 'matches-declaration')
  assert.equal(result.sha512, digest(await fs.readFile(file))); assert.equal(result.documents[0].mods[0].id, 'original_fixture')
  assert.equal(result.documents[0].mods[0].version, '1.0-original'); assert.ok(result.documents[0].mods[0].dependencies.length)
  assert.ok(!JSON.stringify(result).includes(f.root)); assert.ok(!JSON.stringify(result).includes('capabilityId'))
  assert.deepEqual(await fingerprint(file), before); assert.deepEqual(await fingerprint(path.join(f.root, 'launcher.json')), state); assert.deepEqual(f.calls, [])
})
test('disabled JAR can be inspected without enabling it or changing historical source records', async t => {
  const f = await fixture(t), file = await f.add('Original.jar.disabled'), before = await fingerprint(file)
  const registry = path.join(f.core.instanceDirectory(f.id()), 'managed-mods.json')
  await fs.writeFile(registry, JSON.stringify({ schema: 1, mods: { Original: { filename: 'Original.jar', versionId: 'Historical' } } }))
  const registryBefore = await fingerprint(registry)
  const result = await f.core.inspectInstanceMod(f.id(), await f.selection('Original.jar.disabled'), randomUUID())
  assert.equal(result.disabledSuffix, true); assert.equal(result.documents[0].mods[0].id, 'original_fixture')
  await assert.rejects(fs.stat(path.join(f.mods(), 'Original.jar')), { code: 'ENOENT' })
  assert.deepEqual(await fingerprint(file), before); assert.deepEqual(await fingerprint(registry), registryBefore)
})
test('local picker preview works when instance/mods does not exist and never creates directories', async t => {
  const f = await fixture(t), before = await fingerprint(f.local), state = await fingerprint(path.join(f.root, 'launcher.json'))
  const result = await f.core.previewLocalModJar(f.id(), randomUUID(), async () => f.local)
  assert.equal(result?.source, 'local'); assert.equal(result?.itemId, undefined); assert.equal(result?.name, 'Original-local.jar')
  await assert.rejects(fs.stat(f.core.instanceDirectory(f.id())), { code: 'ENOENT' })
  assert.deepEqual(await fingerprint(f.local), before); assert.deepEqual(await fingerprint(path.join(f.root, 'launcher.json')), state)
})
test('exact cancel holds reader, launch and updater exclusion through actual worker settlement', async t => {
  const entered = deferred<void>(), release = deferred<void>()
  const f = await fixture(t, { modDetailsReader: { local: inspectModJar, installed: async (...args) => { entered.resolve(); await release.promise; return inspectInstalledMod(...args) } } })
  await f.add(); const op = randomUUID(), pending = f.core.inspectInstanceMod(f.id(), await f.selection(), op), rejected = assert.rejects(pending, /取消/)
  await entered.promise
  f.core.cancelModDetails(f.id(1), op); f.core.cancelModDetails(f.id(), randomUUID())
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/); assert.throws(() => f.core.assertLaunchAvailable(f.id()), /模组详情/)
  await assert.rejects(f.core.updateInstanceSettings(f.id(), { name: 'Blocked', options: {} }), /模组详情/)
  await assert.rejects(f.core.prepareModToggle(f.id(), await f.selection(), false), /模组详情/)
  await f.core.updateInstanceSettings(f.id(1), { name: 'Allowed B', options: {} })
  f.core.cancelModDetails(f.id(), op)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  release.resolve(); await rejected
  f.core.assertLaunchAvailable(f.id()); const end = f.core.reserveLauncherUpdate(); end()
})
test('picker wait is reserved and cancellation is not released by an early cancel acknowledgement', async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<string>(), op = randomUUID()
  const pending = f.core.previewLocalModJar(f.id(), op, async () => { entered.resolve(); return release.promise }), rejected = assert.rejects(pending, /取消/)
  await entered.promise; f.core.cancelModDetails(f.id(), op)
  assert.throws(() => f.core.assertLaunchAvailable(f.id()), /模组详情/)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  release.resolve(f.local); await rejected
  f.core.assertLaunchAvailable(f.id())
})
test('new inventory refresh invalidates a late metadata result instead of minting a current view', async t => {
  const entered = deferred<void>(), release = deferred<void>()
  const f = await fixture(t, { modDetailsReader: { local: async (...args) => { entered.resolve(); await release.promise; return inspectModJar(...args) }, installed: inspectInstalledMod } })
  const pending = f.core.previewLocalModJar(f.id(), randomUUID(), async () => f.local), rejected = assert.rejects(pending, /读取未完成/)
  await entered.promise; await f.core.inventory(f.id(), 'mods'); release.resolve(); await rejected
})
test('invalid selection objects and wrong row identity are rejected without leaking a native path', async t => {
  const f = await fixture(t); await f.add(); const selected = await f.selection()
  await assert.rejects(f.core.inspectInstanceMod(f.id(), { ...selected, path: f.local }, randomUUID()), /格式/)
  await assert.rejects(f.core.inspectInstanceMod(f.id(), { ...selected, name: '../Original.jar' }, randomUUID()))
  await assert.rejects(f.core.inspectInstanceMod(f.id(1), selected, randomUUID()))
  await assert.rejects(f.core.inspectInstanceMod(f.id(), { ...selected, sizeBytes: selected.sizeBytes + 1 }, randomUUID()))
  const getter = { ...selected }; Object.defineProperty(getter, 'name', { enumerable: true, get() { throw new Error('not invoked') } })
  await assert.rejects(f.core.inspectInstanceMod(f.id(), getter, randomUUID()), /格式/)
})
test('future private fields from a reader do not cross the public DTO projection', async t => {
  const f = await fixture(t, { modDetailsReader: { installed: inspectInstalledMod, local: async (...args) => {
    const result = await inspectModJar(...args)
    return { ...result, secretPath: '/private/secret', documents: result.documents.map(doc => ({ ...doc, secretHandle: 'privateFD', mods: doc.mods.map(mod => ({ ...mod, secretToken: 'private-token' })) })) } as ModJarDetails
  } } })
  const result = await f.core.previewLocalModJar(f.id(), randomUUID(), async () => f.local)
  assert.ok(!/secretPath|privateFD|private-token/.test(JSON.stringify(result)))
})
test('raw native errors are sanitized, and failures release all read reservations', async t => {
  const f = await fixture(t, { modDetailsReader: { installed: inspectInstalledMod, local: async () => { throw new Error('/private/secret source-token upstream-body') } } })
  await assert.rejects(f.core.previewLocalModJar(f.id(), randomUUID(), async () => f.local), error => {
    assert.ok(error instanceof Error); assert.ok(!/private|token|body/.test(error.message)); return true
  })
  f.core.assertLaunchAvailable(f.id()); const end = f.core.reserveLauncherUpdate(); end()
})
test('two global readers are allowed, a third rejects, and source instances remain isolated', async t => {
  const entered = deferred<void>(), release = deferred<void>(); let count = 0
  const f = await fixture(t, { modDetailsReader: { installed: inspectInstalledMod, local: async (...args) => { if (++count === 2) entered.resolve(); await release.promise; return inspectModJar(...args) } } })
  const a = f.core.previewLocalModJar(f.id(), randomUUID(), async () => f.local), b = f.core.previewLocalModJar(f.id(1), randomUUID(), async () => f.local)
  await entered.promise
  await assert.rejects(f.core.previewLocalModJar(f.id(2), randomUUID(), async () => f.local))
  release.resolve(); const [first, second] = await Promise.all([a,b]); assert.equal(first?.instanceId, f.id()); assert.equal(second?.instanceId, f.id(1))
})
test('loader assessment is declaration-only and vanilla or Forge does not inherit Fabric compatibility', async t => {
  const f = await fixture(t, {}, ['fabric', 'forge', 'vanilla'])
  const a = await f.core.previewLocalModJar(f.id(), randomUUID(), async () => f.local)
  const b = await f.core.previewLocalModJar(f.id(1), randomUUID(), async () => f.local)
  const c = await f.core.previewLocalModJar(f.id(2), randomUUID(), async () => f.local)
  assert.equal(a?.assessment.status, 'matches-declaration'); assert.match(a!.assessment.message, /未核实/)
  assert.equal(b?.assessment.status, 'unknown'); assert.equal(c?.assessment.status, 'mismatch')
})
test('operation replay and update reservation refuse before a new picker', async t => {
  const f = await fixture(t), op = randomUUID(); let picks = 0
  assert.equal(await f.core.previewLocalModJar(f.id(), op, async () => { picks++; return undefined }), null)
  await assert.rejects(f.core.previewLocalModJar(f.id(), op, async () => { picks++; return undefined }))
  const end = f.core.reserveLauncherUpdate()
  try { await assert.rejects(f.core.previewLocalModJar(f.id(), randomUUID(), async () => { picks++; return undefined })) } finally { end() }
  assert.equal(picks, 1)
})
test('shutdown and explicit instance read invalidation suppress old results without touching source', async t => {
  for (const shutdown of [false, true]) {
    const entered = deferred<void>(), release = deferred<void>()
    const f = await fixture(t, { modDetailsReader: { local: async (...args) => { entered.resolve(); await release.promise; return inspectModJar(...args) }, installed: inspectInstalledMod } })
    const before = await fingerprint(f.local), pending = f.core.previewLocalModJar(f.id(), randomUUID(), async () => f.local), rejected = assert.rejects(pending, /取消/)
    await entered.promise
    if (shutdown) f.core.cancelPendingOperations(); else f.core.invalidateInstanceReads(f.id())
    release.resolve(); await rejected; assert.deepEqual(await fingerprint(f.local), before)
  }
})
