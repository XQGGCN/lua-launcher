import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { LauncherCore, type Instance } from './core'
import { createWorldDirectoryBackup } from './world-backup'
import { installWorldDatapack } from './datapack-install'
import type { WorldRead } from './world-details'

type Options = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
const selected = { name: 'Original World', itemId: 'worlds:' + createHash('sha256').update('Original World').digest('hex') }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function fixture(t: TestContext, options: Options = {}, versions = ['1.21', '1.21']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-pack-install-'))
  const instances: Instance[] = versions.map((version, i) => ({ id: randomUUID(), name: `Original ${i}`, version, loader: 'vanilla',
    status: 'ready', createdAt: '2026-10-24T00:00:00Z', playtimeMs: 0 }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances, settings: { memoryMode: 'auto', memoryMb: 2048, javaPath: '', concurrentDownloads: 4 } }))
  const world = (i = 0) => path.join(root, 'instances', instances[i].id, 'game/saves', selected.name)
  for (let i = 0; i < instances.length; i++) {
    await fs.mkdir(world(i), { recursive: true })
    await fs.writeFile(path.join(world(i), 'level.dat'), 'Original inert world bytes; reader is explicitly injected')
    await fs.writeFile(path.join(world(i), 'session.lock'), 'Original session lock')
  }
  const ports: string[] = []
  const core = new LauncherCore(root, undefined, {
    fetch: async () => { ports.push('network'); throw new Error('No real network') },
    spawn: (() => { ports.push('spawn'); throw new Error('No Java or game') }) as Options['spawn'],
    javaRuntimeManager: { ensure: async () => { throw new Error('No Java') }, discover: async () => [] },
    worldDetailsReader: async (directory, input) => {
      const bytes = await fs.readFile(path.join(directory, 'game/saves', input.name, 'level.dat'))
      return { details: { itemId: input.itemId, folderName: input.name, source: 'level.dat', observedAt: new Date().toISOString(), status: 'ok',
        metadata: { savedVersionName: '1.21' }, fieldWarnings: [], warnings: [], seedAvailable: false },
        revisionKey: createHash('sha256').update(bytes).digest('hex') } satisfies WorldRead
    }, ...options,
  })
  await core.init()
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  const zip = new AdmZip()
  zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 48, description: 'Original inert pack' } })))
  zip.addFile('data/lua/function/example.mcfunction', Buffer.from('# Original inert fixture, never executed'))
  const file = path.join(root, 'Original.zip'); await fs.writeFile(file, zip.toBuffer())
  const id = (i = 0) => instances[i].id
  const plan = async (i = 0) => {
    const inventory = await core.worldDatapacks(id(i), selected, randomUUID())
    const prepared = await core.prepareLocalDatapackInstall(id(i), inventory.revision, randomUUID(), async () => file)
    assert.ok(prepared); return prepared
  }
  return { core, root, world, file, id, plan, ports }
}
const options = () => ({ closedExternalWorldConfirmed: true, operationId: randomUUID() })
async function fingerprint(file: string) {
  const bytes = await fs.readFile(file), s = await fs.lstat(file, { bigint: true })
  return [createHash('sha256').update(bytes).digest('hex'), ...[s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String)]
}

test('local preparation issues a private one-use capability and leaves world and launcher state unchanged', async t => {
  const f = await fixture(t), before = await fingerprint(f.file), state = await fingerprint(path.join(f.root, 'launcher.json'))
  const plan = await f.plan()
  assert.equal(plan.canInstall, true); assert.ok(plan.capabilityId); assert.notEqual(plan.capabilityId, plan.previewId)
  assert.equal(plan.worldCompatibility.status, 'declared-compatible'); assert.equal(plan.source, 'local')
  assert.equal(plan.filename, 'Original.zip'); assert.equal(plan.sha512, createHash('sha512').update(await fs.readFile(f.file)).digest('hex'))
  assert.ok(!JSON.stringify(plan).includes(f.root)); assert.ok(!JSON.stringify(plan).includes('revisionKey'))
  await assert.rejects(fs.stat(path.join(f.world(), 'datapacks')), { code: 'ENOENT' })
  assert.deepEqual(await fingerprint(f.file), before); assert.deepEqual(await fingerprint(path.join(f.root, 'launcher.json')), state)
  assert.deepEqual(f.ports, [])
})
test('real Core installation creates a fresh full backup and exactly one ZIP without changing original bytes', async t => {
  const f = await fixture(t), before = await fingerprint(f.file), level = await fingerprint(path.join(f.world(), 'level.dat'))
  const lock = await fingerprint(path.join(f.world(), 'session.lock')), state = await fingerprint(path.join(f.root, 'launcher.json'))
  const plan = await f.plan(), result = await f.core.installDatapack(f.id(), plan.capabilityId!, options())
  assert.equal(result.instanceId, f.id()); assert.deepEqual(result.world, selected); assert.equal(result.filename, plan.filename)
  assert.equal(result.sha512, plan.sha512); assert.equal(result.backup.worldFolderName, selected.name)
  assert.equal(result.backup.verifiedAtCompletion, true)
  assert.deepEqual(await fs.readFile(path.join(f.world(), 'datapacks/Original.zip')), await fs.readFile(f.file))
  const backups = await f.core.worldBackups(f.id()); assert.ok(backups.items.some(b => b.backupId === result.backup.backupId))
  assert.deepEqual(await fingerprint(f.file), before); assert.deepEqual(await fingerprint(path.join(f.world(), 'level.dat')), level)
  assert.deepEqual(await fingerprint(path.join(f.world(), 'session.lock')), lock); assert.deepEqual(await fingerprint(path.join(f.root, 'launcher.json')), state)
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, options()), /失效/)
  const inventory = await f.core.worldDatapacks(f.id(), selected, randomUUID()); assert.equal(inventory.items.length, 1)
  assert.ok(!JSON.stringify(result).includes(f.root)); assert.deepEqual(f.ports, [])
})
test('unknown or mismatching instance/world formats have no install capability', async t => {
  const f = await fixture(t, {}, ['unknown-snapshot', '1.20.2'])
  for (const n of [0, 1]) {
    const plan = await f.plan(n); assert.equal(plan.canInstall, false); assert.equal(plan.capabilityId, undefined); assert.ok(plan.reasons.length)
    await assert.rejects(f.core.installDatapack(f.id(n), plan.previewId, options()), /失效/)
  }
})
test('confirmation must explicitly close external games and contains only exact allowed fields', async t => {
  const f = await fixture(t), plan = await f.plan()
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, { closedExternalWorldConfirmed: false, operationId: randomUUID() }), /关闭/)
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, { ...options(), path: f.file }), /格式/)
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, { ...options(), operationId: 'invalid' }), /标识/)
  await assert.rejects(f.core.installDatapack(f.id(1), plan.capabilityId!, options()), /失效/)
  await f.core.installDatapack(f.id(), plan.capabilityId!, options())
})
test('expired, refreshed and replaced preparation capabilities are rejected before installer', async t => {
  let now = 100, calls = 0
  const f = await fixture(t, { worldDetailsNow: () => now, datapackInstaller: async () => { calls++; throw new Error('must not enter') } })
  let plan = await f.plan(); now += 120001
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, options()), /失效/)
  plan = await f.plan(); await f.core.worldDatapacks(f.id(), selected, randomUUID())
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, options()), /失效/)
  plan = await f.plan(); await f.plan()
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, options()), /失效/)
  assert.equal(calls, 0)
})
test('same-byte replaced source file and changed main level.dat invalidate confirmation before backup', async t => {
  let backups = 0
  const f = await fixture(t, { worldBackupCreator: async (...args) => { backups++; return createWorldDirectoryBackup(...args) } })
  let plan = await f.plan(); const original = await fs.readFile(f.file)
  await fs.rename(f.file, f.file + '.old'); await fs.writeFile(f.file, original)
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, options()), /未完成安装/)
  plan = await f.plan(); await fs.writeFile(path.join(f.world(), 'level.dat'), 'Original changed main file')
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, options()), /未完成安装/)
  assert.equal(backups, 0)
  await assert.rejects(fs.stat(path.join(f.world(), 'datapacks')), { code: 'ENOENT' })
})
test('native picker reservation and exact preparation cancellation last until picker actually settles', async t => {
  const f = await fixture(t), inventory = await f.core.worldDatapacks(f.id(), selected, randomUUID())
  const entered = deferred<void>(), release = deferred<string>(), operationId = randomUUID()
  const pending = f.core.prepareLocalDatapackInstall(f.id(), inventory.revision, operationId, async () => { entered.resolve(); return release.promise })
  const rejected = assert.rejects(pending, /取消/); await entered.promise
  f.core.cancelDatapackRead(f.id(1), operationId)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  f.core.cancelDatapackRead(f.id(), operationId)
  assert.throws(() => f.core.assertLaunchAvailable(f.id()), /数据包/)
  release.resolve(f.file); await rejected
  f.core.assertLaunchAvailable(f.id()); const finish = f.core.reserveLauncherUpdate(); finish()
})
test('installation reserves before backup await, wrong cancellation does nothing, exact cancel holds locks until settlement', async t => {
  const entered = deferred<void>(), release = deferred<void>()
  const f = await fixture(t, { worldBackupCreator: async (...args) => { entered.resolve(); await release.promise; return createWorldDirectoryBackup(...args) } })
  const plan = await f.plan(), confirmation = options(), pending = f.core.installDatapack(f.id(), plan.capabilityId!, confirmation)
  const rejected = assert.rejects(pending, /取消/); await entered.promise
  f.core.cancelDatapackInstall(f.id(1), confirmation.operationId); f.core.cancelDatapackInstall(f.id(), randomUUID())
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  assert.throws(() => f.core.assertLaunchAvailable(f.id()), /文件操作/)
  await assert.rejects(f.core.updateInstanceSettings(f.id(), { name: 'Blocked', options: {} }))
  await assert.rejects(f.core.worldDatapacks(f.id(), selected, randomUUID()))
  assert.throws(() => f.core.cancelInstall(f.id()), /精确取消/)
  await f.core.updateInstanceSettings(f.id(1), { name: 'B permitted', options: {} })
  f.core.cancelDatapackInstall(f.id(), confirmation.operationId)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  release.resolve(); await rejected
  await assert.rejects(fs.stat(path.join(f.world(), 'datapacks')), { code: 'ENOENT' })
  f.core.assertLaunchAvailable(f.id())
})
test('Modrinth preparation uses current Core game version, private download path and provider filename', async t => {
  let fixtureFile = '', calls: string[] = []
  const f = await fixture(t, { datapackArtifact: {
    resolve: async (selection, config) => { calls.push('resolve'); assert.equal(config.gameVersion, '1.21'); assert.ok(config.signal); assert.match(config.userAgent!, /^LuaLauncher\//)
      return { ...selection, source: 'modrinth', url: 'https://cdn.modrinth.com/data/Original/versions/Original/Provider.zip' } },
    download: async (_directory, artifact) => { calls.push('download'); return { file: fixtureFile, filename: artifact.filename, archiveBytes: artifact.size, sha512: artifact.sha512 } },
  } })
  fixtureFile = f.file
  const bytes = await fs.readFile(f.file), selection = { projectId: 'Original', versionId: 'Release', filename: 'Provider.zip', size: bytes.length, sha512: createHash('sha512').update(bytes).digest('hex') }
  const inventory = await f.core.worldDatapacks(f.id(), selected, randomUUID())
  const plan = await f.core.prepareModrinthDatapackInstall(f.id(), inventory.revision, selection, randomUUID())
  assert.ok(plan?.canInstall); assert.equal(plan?.filename, 'Provider.zip'); assert.equal(plan?.source, 'modrinth')
  assert.ok(!JSON.stringify(plan).includes('https://')); assert.ok(!JSON.stringify(plan).includes(f.root))
  await f.core.installDatapack(f.id(), plan!.capabilityId!, options())
  assert.ok(await fs.stat(path.join(f.world(), 'datapacks/Provider.zip'))); assert.deepEqual(calls, ['resolve', 'download'])
})
test('errors redact private paths and raw upstream body and always release reservation after real worker settlement', async t => {
  const f = await fixture(t, { datapackInstaller: async () => { throw new Error('/private/secret.zip raw token private upstream body') } })
  const plan = await f.plan()
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, options()), error => {
    assert.ok(error instanceof Error); assert.ok(!/private|token|upstream/.test(error.message)); return true
  })
  f.core.assertLaunchAvailable(f.id()); const end = f.core.reserveLauncherUpdate(); end()
})
test('a completed engine result wins over cancellation arriving after actual publication', async t => {
  let finished = deferred<void>(), release = deferred<void>()
  const f = await fixture(t, { datapackInstaller: async (...args) => {
    const result = await installWorldDatapack(...args); finished.resolve(); await release.promise; return result
  } })
  const plan = await f.plan(), confirmation = options(), pending = f.core.installDatapack(f.id(), plan.capabilityId!, confirmation)
  await finished.promise; f.core.cancelDatapackInstall(f.id(), confirmation.operationId)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  release.resolve(); const result = await pending
  assert.equal(result.filename, 'Original.zip'); f.core.assertLaunchAvailable(f.id())
})
test('shutdown invalidates unused capability without touching source or installing a ZIP', async t => {
  const f = await fixture(t), plan = await f.plan(), before = await fingerprint(f.file)
  f.core.cancelPendingOperations()
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, options()), /失效/)
  assert.deepEqual(await fingerprint(f.file), before)
  await assert.rejects(fs.stat(path.join(f.world(), 'datapacks')), { code: 'ENOENT' })
})
test('unresolved intent blocks fresh Core init and subsequent world writes without removing any evidence', async t => {
  const f = await fixture(t, { datapackInstaller: (directory, world, source, config) => installWorldDatapack(directory, world, source, {
    ...config, hooks: { afterIntent: async () => { throw new Error('Original post-intent interruption') } },
  }) })
  const plan = await f.plan()
  await assert.rejects(f.core.installDatapack(f.id(), plan.capabilityId!, options()), /人工检查/)
  assert.equal(f.core.snapshot().instances[0].status, 'error')
  await assert.rejects(f.core.worldDatapacks(f.id(), selected, randomUUID()))
  await assert.rejects(f.core.duplicateInstance(f.id(), 'Blocked copy'))
  const directory = path.join(f.core.instanceDirectory(f.id()), '.datapack-staging')
  const names = await fs.readdir(directory); assert.equal(names.length, 1)
  const intent = await fingerprint(path.join(directory, names[0], 'INTENT.json'))
  await f.core.init()
  assert.equal(f.core.snapshot().instances[0].status, 'error')
  assert.match(f.core.snapshot().instances[0].error!, /数据包安装/)
  assert.deepEqual(await fingerprint(path.join(directory, names[0], 'INTENT.json')), intent)
  assert.throws(() => f.core.assertLaunchAvailable(f.id()))
})
test('missing instance directories with no journals remain ordinary not-installed instances at init', async t => {
  const f = await fixture(t)
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'launcher.json'), 'utf8'))
  state.instances[0].status = 'not-installed'
  await fs.writeFile(path.join(f.root, 'launcher.json'), JSON.stringify(state))
  await fs.rm(f.core.instanceDirectory(f.id()), { recursive: true })
  const snapshot = await f.core.init()
  assert.equal(snapshot.instances[0].status, 'not-installed'); assert.equal(snapshot.instances[0].error, undefined)
  await assert.rejects(fs.stat(f.core.instanceDirectory(f.id())), { code: 'ENOENT' })
})
test('duplicating a completed instance excludes transaction controls and provider source cache', async t => {
  const f = await fixture(t), plan = await f.plan()
  await f.core.installDatapack(f.id(), plan.capabilityId!, options())
  await fs.mkdir(path.join(f.core.instanceDirectory(f.id()), '.datapack-sources'))
  await fs.writeFile(path.join(f.core.instanceDirectory(f.id()), '.datapack-sources', 'Original-cache'), 'Original preparation cache')
  const copy = await f.core.duplicateInstance(f.id(), 'Original duplicate')
  for (const name of ['.datapack-sources', '.datapack-staging']) await assert.rejects(fs.stat(path.join(f.core.instanceDirectory(copy.id), name)), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(path.join(f.core.instanceDirectory(copy.id), 'game/saves', selected.name, 'datapacks/Original.zip')), await fs.readFile(f.file))
  await f.core.assertInstanceUsable(copy.id)
})
