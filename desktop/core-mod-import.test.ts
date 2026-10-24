import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { LauncherCore, type Instance } from './core'
import { inspectModJarForImport } from './mod-jar'
import { assessLocalModImport } from './mod-import-policy'
import { importLocalModJar } from './mod-import'

type Options = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
const imports = { inspect: inspectModJarForImport, assess: assessLocalModImport, commit: importLocalModJar }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const confirmation = () => ({ operationId: randomUUID(), closedExternalGameConfirmed: true })
async function fixture(t: TestContext, options: Options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-local-import-'))
  const instances: Instance[] = ['fabric', 'forge'].map((loader, i) => ({ id: randomUUID(), name: `Original ${i}`, version: i ? '1.20.1' : '1.21.1', loader: loader as Instance['loader'], loaderVersion: i ? '47.2.0' : '0.16.10',
    status: 'ready', createdAt: '2026-10-24T00:00:00Z', playtimeMs: 0 }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances, settings: { javaPath: '', memoryMode: 'auto', memoryMb: 2048, concurrentDownloads: 4 } }))
  for (const instance of instances) {
    const directory = path.join(root, 'instances', instance.id)
    await fs.mkdir(path.join(directory, 'game'), { recursive: true })
    await fs.writeFile(path.join(directory, 'installed.json'), JSON.stringify({ schema: 1, version: { id: instance.version }, platform: process.platform, arch: process.arch,
      classpath: [], mainClass: 'original.InertNeverExecuted', fabricArguments: { game: [], jvm: [] } }))
  }
  const ports: string[] = []
  const core = new LauncherCore(root, undefined, { fetch: async () => { ports.push('network'); throw new Error('No network') },
    spawn: (() => { ports.push('spawn'); throw new Error('No Java or game') }) as Options['spawn'],
    javaRuntimeManager: { ensure: async () => { throw new Error('No Java') }, discover: async () => [] }, ...options })
  await core.init()
  const id = (i = 0) => instances[i].id, directory = (i = 0) => core.instanceDirectory(id(i)), mods = (i = 0) => path.join(directory(i), 'game/mods')
  const jar = async (filename: string, entries: Record<string, string | object>) => {
    const zip = new AdmZip(); for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)))
    zip.addFile('data/original.txt', Buffer.from('Original inert bytes, never executed'))
    const file = path.join(root, filename); await fs.writeFile(file, zip.toBuffer()); return file
  }
  const fabric = await jar('Original-fabric.jar', { 'fabric.mod.json': { schemaVersion: 1, id: 'original_fabric', version: '1.0.0', name: 'Original Fabric', environment: 'client',
    depends: { minecraft: '1.21.1', fabricloader: '>=0.16.0' } } })
  const forge = await jar('Original-forge.jar', { 'META-INF/mods.toml': 'modLoader="javafml"\nloaderVersion="[47,)"\nlicense="MIT"\n[[mods]]\nmodId="original_forge"\nversion="1.0.0"\ndisplayName="Original Forge"\n[[dependencies.original_forge]]\nmodId="minecraft"\nmandatory=true\nversionRange="[1.20.1]"\nordering="NONE"\nside="BOTH"\n' })
  const plan = async (i = 0, file = fabric) => { const result = await core.prepareLocalModImport(id(i), randomUUID(), async () => file); assert.ok(result); return result }
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, core, id, directory, mods, fabric, forge, jar, plan, ports }
}
async function fingerprint(file: string) {
  const bytes = await fs.readFile(file), s = await fs.lstat(file, { bigint: true })
  return [createHash('sha512').update(bytes).digest('hex'), ...[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].map(String)]
}

test('fresh local preparation is separate from metadata view, holds private paths and leaves game/state unchanged', async t => {
  const f = await fixture(t), source = await fingerprint(f.fabric), state = await fingerprint(path.join(f.root, 'launcher.json'))
  const plan = await f.plan()
  assert.equal(plan.assessment.eligible, true); assert.ok(plan.capabilityId); assert.deepEqual(plan.assessment.candidateIds, ['original_fabric'])
  assert.equal(plan.details.status, 'metadata-read'); assert.equal(plan.sha512, createHash('sha512').update(await fs.readFile(f.fabric)).digest('hex'))
  assert.equal(plan.source, 'local'); assert.ok(!JSON.stringify(plan).includes(f.root)); assert.ok(!JSON.stringify(plan).includes('metadata":{}'))
  await assert.rejects(fs.stat(f.mods()), { code: 'ENOENT' })
  assert.deepEqual(await fingerprint(f.fabric), source); assert.deepEqual(await fingerprint(path.join(f.root, 'launcher.json')), state); assert.deepEqual(f.ports, [])
})
test('real full pipelines import original Fabric and Forge into separate explicit instances without rewriting sources', async t => {
  const f = await fixture(t), fabric = await fingerprint(f.fabric), forge = await fingerprint(f.forge), state = await fingerprint(path.join(f.root, 'launcher.json'))
  for (const [i, file] of [[0, f.fabric], [1, f.forge]] as const) {
    const plan = await f.plan(i, file); assert.ok(plan.assessment.eligible, plan.assessment.reasons.join('; '))
    const request = confirmation(), result = await f.core.commitLocalModImport(f.id(i), plan.capabilityId!, request)
    assert.equal(result.operationId, request.operationId); assert.equal(result.instanceId, f.id(i)); assert.equal(result.sha512, plan.sha512)
    assert.deepEqual(await fs.readFile(path.join(f.mods(i), result.filename)), await fs.readFile(file)); assert.ok(!JSON.stringify(result).includes(f.root))
    await assert.rejects(f.core.commitLocalModImport(f.id(i), plan.capabilityId!, confirmation()), /失效/)
    await assert.rejects(fs.stat(path.join(f.directory(i), 'managed-mods.json')), { code: 'ENOENT' })
  }
  assert.deepEqual(await fingerprint(f.fabric), fabric); assert.deepEqual(await fingerprint(f.forge), forge); assert.deepEqual(await fingerprint(path.join(f.root, 'launcher.json')), state)
  assert.deepEqual(f.ports, [])
})
test('required missing or unknown Java dependencies and wrong loader stay blocked without an import capability', async t => {
  const f = await fixture(t)
  for (const dependency of ['missing_required_mod', 'java']) {
    const file = await f.jar(`Original-${dependency}.jar`, { 'fabric.mod.json': { schemaVersion: 1, id: 'original_candidate', version: '1.0.0', depends: { [dependency]: '>=1' } } })
    const plan = await f.plan(0, file); assert.equal(plan.assessment.eligible, false); assert.equal(plan.capabilityId, undefined); assert.ok(plan.assessment.reasons.length)
  }
  const wrong = await f.plan(1, f.fabric); assert.equal(wrong.assessment.eligible, false)
  await assert.rejects(fs.stat(f.mods()), { code: 'ENOENT' })
})
test('existing disabled same mod under another filename blocks duplicate ID before any publication', async t => {
  const f = await fixture(t); await fs.mkdir(f.mods()); const existing = path.join(f.mods(), 'Renamed-old.jar.disabled'); await fs.copyFile(f.fabric, existing)
  const before = await fingerprint(existing), plan = await f.plan()
  assert.equal(plan.assessment.eligible, false); assert.equal(plan.capabilityId, undefined)
  assert.deepEqual(await fingerprint(existing), before)
  await assert.rejects(fs.stat(path.join(f.mods(), path.basename(f.fabric))), { code: 'ENOENT' })
})
test('source same-byte inode replacement and installed profile replacement invalidate confirmation before commit', async t => {
  let commits = 0
  const f = await fixture(t, { localModImport: { ...imports, commit: async () => { commits++; throw new Error('must not enter') } } })
  let plan = await f.plan(); const bytes = await fs.readFile(f.fabric); await fs.rename(f.fabric, f.fabric + '.old'); await fs.writeFile(f.fabric, bytes)
  await assert.rejects(f.core.commitLocalModImport(f.id(), plan.capabilityId!, confirmation()), /未完成/)
  plan = await f.plan(); const profile = path.join(f.directory(), 'installed.json'), contents = await fs.readFile(profile)
  await fs.rename(profile, profile + '.old'); await fs.writeFile(profile, contents)
  await assert.rejects(f.core.commitLocalModImport(f.id(), plan.capabilityId!, confirmation()), /未完成/)
  assert.equal(commits, 0)
})
test('new installed file after plan changes the private index fingerprint and preserves foreign bytes', async t => {
  const f = await fixture(t), plan = await f.plan(); await fs.mkdir(f.mods())
  const other = await f.jar('Other.jar', { 'fabric.mod.json': { schemaVersion: 1, id: 'original_other', version: '1.0.0' } })
  const target = path.join(f.mods(), 'Other.jar'); await fs.copyFile(other, target); const before = await fingerprint(target)
  await assert.rejects(f.core.commitLocalModImport(f.id(), plan.capabilityId!, confirmation()), /未完成/)
  assert.deepEqual(await fingerprint(target), before)
})
test('explicit closed-game confirmation, exact input shape, cross-instance and expiration are enforced', async t => {
  let now = 100
  const f = await fixture(t, { worldDetailsNow: () => now }), plan = await f.plan()
  await assert.rejects(f.core.commitLocalModImport(f.id(), plan.capabilityId!, { ...confirmation(), closedExternalGameConfirmed: false }), /关闭/)
  await assert.rejects(f.core.commitLocalModImport(f.id(), plan.capabilityId!, { ...confirmation(), path: f.fabric }), /格式/)
  await assert.rejects(f.core.commitLocalModImport(f.id(1), plan.capabilityId!, confirmation()), /失效/)
  now += 120001; await assert.rejects(f.core.commitLocalModImport(f.id(), plan.capabilityId!, confirmation()), /失效/)
})
test('read-only viewId cannot authorize import and refreshing mods invalidates an unused capability', async t => {
  const f = await fixture(t), preview = await f.core.previewLocalModJar(f.id(), randomUUID(), async () => f.fabric)
  await assert.rejects(f.core.commitLocalModImport(f.id(), preview!.viewId, confirmation()), /失效/)
  const plan = await f.plan(); await f.core.inventory(f.id(), 'mods')
  await assert.rejects(f.core.commitLocalModImport(f.id(), plan.capabilityId!, confirmation()), /失效/)
})
test('picker cancellation holds whole instance and updater until actual picker promise settles', async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<string>(), op = randomUUID()
  const pending = f.core.prepareLocalModImport(f.id(), op, async () => { entered.resolve(); return release.promise }), rejected = assert.rejects(pending, /取消/)
  await entered.promise; f.core.cancelLocalModImport(f.id(1), op); f.core.cancelLocalModImport(f.id(), randomUUID())
  assert.throws(() => f.core.assertLaunchAvailable(f.id())); assert.throws(() => f.core.reserveLauncherUpdate())
  await assert.rejects(f.core.updateInstanceSettings(f.id(), { name: 'Blocked', options: {} }))
  await assert.rejects(f.core.previewLocalModJar(f.id(), randomUUID(), async () => f.fabric))
  assert.throws(() => f.core.cancelInstall(f.id()), /精确取消/)
  f.core.cancelLocalModImport(f.id(), op); assert.throws(() => f.core.reserveLauncherUpdate())
  release.resolve(f.fabric); await rejected; f.core.assertLaunchAvailable(f.id())
})
test('commit cancellation stays reserved through real worker settlement, while actual completed result wins late abort', async t => {
  const committed = deferred<void>(), release = deferred<void>()
  const f = await fixture(t, { localModImport: { ...imports, commit: async (...args) => { const result = await importLocalModJar(...args); committed.resolve(); await release.promise; return result } } })
  const plan = await f.plan(), request = confirmation(), pending = f.core.commitLocalModImport(f.id(), plan.capabilityId!, request)
  await committed.promise; f.core.cancelLocalModImport(f.id(), request.operationId); assert.throws(() => f.core.reserveLauncherUpdate())
  release.resolve(); const result = await pending; assert.equal(result.filename, path.basename(f.fabric)); f.core.assertLaunchAvailable(f.id())
})
test('unresolved intent is preserved and blocks fresh init and later launch/world/mod operations', async t => {
  const f = await fixture(t, { localModImport: { ...imports, commit: (directory, source, options) => importLocalModJar(directory, source, { ...options,
    hooks: { afterIntent: async () => { throw new Error('Original interrupted mutation boundary') } } }) } })
  const plan = await f.plan(); await assert.rejects(f.core.commitLocalModImport(f.id(), plan.capabilityId!, confirmation()), /人工检查/)
  const stage = path.join(f.directory(), '.mod-import-staging'), [operation] = await fs.readdir(stage), intent = path.join(stage, operation, 'INTENT.json'), before = await fingerprint(intent)
  await f.core.init(); assert.equal(f.core.snapshot().instances[0].status, 'error'); assert.match(f.core.snapshot().instances[0].error!, /本地模组/)
  assert.throws(() => f.core.assertLaunchAvailable(f.id())); await assert.rejects(f.core.previewLocalModJar(f.id(), randomUUID(), async () => f.fabric))
  assert.deepEqual(await fingerprint(intent), before)
})
test('native path and raw worker errors are sanitized; failed workers release locks', async t => {
  const f = await fixture(t, { localModImport: { ...imports, inspect: async () => { throw new Error('/private/secret.jar token raw body') } } })
  await assert.rejects(f.core.prepareLocalModImport(f.id(), randomUUID(), async () => f.fabric), error => { assert.ok(error instanceof Error); assert.ok(!/private|token|body/.test(error.message)); return true })
  f.core.assertLaunchAvailable(f.id()); const end = f.core.reserveLauncherUpdate(); end()
})
test('new source preparation and shutdown invalidate older unused confirmations', async t => {
  const f = await fixture(t), old = await f.plan(); await f.plan()
  await assert.rejects(f.core.commitLocalModImport(f.id(), old.capabilityId!, confirmation()), /失效/)
  const plan = await f.plan(); f.core.cancelPendingOperations()
  await assert.rejects(f.core.commitLocalModImport(f.id(), plan.capabilityId!, confirmation()), /失效/)
})
