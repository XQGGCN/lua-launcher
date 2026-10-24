import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { LauncherCore, type Instance } from './core'
import type { DatapackCatalogSearch, DatapackCatalogVersions } from './datapack-discovery-types'

type Options = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
const selection = { name: 'Original World', itemId: 'worlds:' + createHash('sha256').update('Original World').digest('hex') }
const hit = { projectId: 'LuaPack01', slug: 'original-fixture', title: 'Original fixture', description: 'Original inert metadata', author: 'Fixture', downloads: 12,
  projectTypes: ['mod', 'datapack'], projectUrl: 'https://modrinth.com/datapack/LuaPack01' }
const searchResult = (): DatapackCatalogSearch => ({ hits: [hit], totalHits: 21, offset: 0, limit: 20, omittedHits: 0 })
const versionsResult = (projectId = 'LuaPack01'): DatapackCatalogVersions => ({ project: { ...hit, projectId }, versions: [{ id: 'Version1', projectId, name: 'Original version', versionNumber: '1',
  datePublished: '2026-10-24T00:00:00Z', releaseType: 'release', gameVersions: ['1.21.1'], loaders: ['datapack'], declaresCurrentGameVersion: true, declaresDatapack: true,
  files: [{ filename: 'original.zip', primary: true, role: 'main', size: 32, sha512: 'a'.repeat(128), eligible: true }],
  dependencies: [], externalOnly: false, reasons: [], warnings: [] }], upstreamVersionCount: 1, omittedVersions: 0 })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function fixture(t: TestContext, options: Options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-catalog-'))
  const instances: Instance[] = [0, 1].map(index => ({ id: randomUUID(), name: `Original ${index}`, version: '1.21.1', loader: 'vanilla', status: 'ready', createdAt: '2026-10-24T00:00:00Z', playtimeMs: 0 }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances, settings: { memoryMode: 'auto', memoryMb: 2048, javaPath: '', concurrentDownloads: 4 } }))
  for (const instance of instances) await fs.mkdir(path.join(root, 'instances', instance.id, 'game', 'saves', selection.name), { recursive: true })
  const calls: string[] = []
  const core = new LauncherCore(root, undefined, { fetch: async url => { calls.push(String(url)); throw new Error('No unexpected network') },
    spawn: (() => { throw new Error('No Java/game') }) as Options['spawn'],
    javaRuntimeManager: { ensure: async () => { throw new Error('No Java') }, discover: async () => [] },
    datapackCatalog: { search: async () => searchResult(), versions: async id => versionsResult(id) }, ...options })
  await core.init()
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  const id = (index = 0) => instances[index].id
  const world = (index = 0) => path.join(core.instanceDirectory(id(index)), 'game', 'saves', selection.name)
  const view = (index = 0) => core.worldDatapacks(id(index), selection, randomUUID())
  return { root, core, calls, id, world, view }
}
async function identity(file: string) {
  const s = await fs.stat(file, { bigint: true }), b = await fs.readFile(file)
  return [createHash('sha256').update(b).digest('hex'), ...[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs,s.nlink].map(String)]
}

test('search is bound to selected world and instance version, sends its User-Agent and never writes missing datapacks', async t => {
  let captured: { gameVersion: string; userAgent?: string; offset?: number } | undefined
  const f = await fixture(t, { datapackCatalog: { search: async (_query, options) => { captured = options; return searchResult() }, versions: async () => versionsResult() } })
  const state = await identity(path.join(f.root, 'launcher.json')), view = await f.view()
  const result = await f.core.searchDatapacks(f.id(), view.revision, { query: 'original', offset: 20 }, randomUUID())
  assert.equal(captured?.gameVersion, '1.21.1'); assert.equal(captured?.offset, 20); assert.match(captured?.userAgent ?? '', /^LuaLauncher\//)
  assert.deepEqual(result.world, selection); assert.equal(result.gameVersion, '1.21.1'); assert.equal(result.revision, view.revision)
  assert.deepEqual(result.hits[0].projectTypes, ['mod', 'datapack'])
  assert.ok(!JSON.stringify(result).includes(f.root))
  await assert.rejects(fs.stat(path.join(f.world(), 'datapacks')), { code: 'ENOENT' })
  assert.deepEqual(await identity(path.join(f.root, 'launcher.json')), state); assert.deepEqual(f.calls, [])
})
test('invalid input, wrong-instance revision and expired revision never invoke catalog transport', async t => {
  let requests = 0, now = 100
  const f = await fixture(t, { worldDetailsNow: () => now, datapackCatalog: { search: async () => { requests++; return searchResult() }, versions: async () => { requests++; return versionsResult() } } })
  const view = await f.view()
  for (const input of [{ query: '', url: 'https://evil.invalid' }, { query: 'x', gameVersion: 'other' }, { query: '\n' }, { query: 'x', offset: -1 }, { query: 1 }]) {
    await assert.rejects(f.core.searchDatapacks(f.id(), view.revision, input, randomUUID()))
  }
  await assert.rejects(f.core.searchDatapacks(f.id(1), view.revision, { query: '' }, randomUUID()))
  await assert.rejects(f.core.datapackProjectVersions(f.id(), view.revision, '../evil', randomUUID()))
  now += 120001
  await assert.rejects(f.core.searchDatapacks(f.id(), view.revision, { query: '' }, randomUUID()))
  assert.equal(requests, 0)
})
test('project and file DTOs discard internal transport URLs, paths and future private reader fields', async t => {
  const secret = '/private/original-inert-proof'
  const f = await fixture(t, { datapackCatalog: { search: async () => ({ ...searchResult(), raw: secret, hits: [{ ...hit, raw: secret }] }),
    versions: async () => { const v = versionsResult(); return { ...v, raw: secret, project: { ...v.project, raw: secret }, versions: v.versions.map(version => ({ ...version, raw: secret,
      files: version.files.map(file => ({ ...file, url: secret })), dependencies: [{ type: 'optional', filename: 'fixture.zip', secret } as const] })) } } } })
  const view = await f.view()
  assert.ok(!JSON.stringify(await f.core.searchDatapacks(f.id(), view.revision, { query: '' }, randomUUID())).includes(secret))
  const result = await f.core.datapackProjectVersions(f.id(), view.revision, 'LuaPack01', randomUUID())
  assert.equal(result.versions[0].files[0].filename, 'original.zip')
  assert.ok(!JSON.stringify(result).includes(secret)); assert.equal(result.instanceId, f.id())
})
test('cancel targets one catalog operation and reservations persist until an ignoring worker settles', async t => {
  const entered = deferred<void>(), release = deferred<DatapackCatalogSearch>()
  const f = await fixture(t, { datapackCatalog: { search: async () => { entered.resolve(); return release.promise }, versions: async () => versionsResult() } })
  const view = await f.view(), op = randomUUID()
  const pending = f.core.searchDatapacks(f.id(), view.revision, { query: '' }, op), rejected = assert.rejects(pending, /取消/)
  await entered.promise
  f.core.cancelDatapackRead(f.id(1), op); f.core.cancelDatapackRead(f.id(), randomUUID())
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/); assert.throws(() => f.core.assertLaunchAvailable(f.id()), /数据包/)
  await assert.rejects(f.core.updateInstanceSettings(f.id(), { name: 'blocked', options: {} }), /数据包/)
  let trashed = false
  await assert.rejects(f.core.removeInstance(f.id(), async () => { trashed = true }), /数据包/); assert.equal(trashed, false)
  f.core.cancelDatapackRead(f.id(), op)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  release.resolve(searchResult()); await rejected
  const end = f.core.reserveLauncherUpdate(); end()
})
test('a slow earlier search cannot return after a newer query replaces the view', async t => {
  const entered = deferred<void>(), release = deferred<DatapackCatalogSearch>(); let count = 0
  const f = await fixture(t, { datapackCatalog: { search: async () => { if (++count === 1) { entered.resolve(); return release.promise } return searchResult() }, versions: async () => versionsResult() } })
  const view = await f.view(), old = f.core.searchDatapacks(f.id(), view.revision, { query: 'old' }, randomUUID()), rejected = assert.rejects(old)
  await entered.promise
  const current = await f.core.searchDatapacks(f.id(), view.revision, { query: 'new' }, randomUUID())
  release.resolve(searchResult()); await rejected
  assert.equal(current.gameVersion, '1.21.1')
})
test('new search supersedes pending project versions and permits a later current project read', async t => {
  const entered = deferred<void>(), release = deferred<DatapackCatalogVersions>(); let count = 0
  const f = await fixture(t, { datapackCatalog: { search: async () => searchResult(), versions: async id => { if (++count === 1) { entered.resolve(); return release.promise } return versionsResult(id) } } })
  const view = await f.view(), old = f.core.datapackProjectVersions(f.id(), view.revision, 'LuaPack01', randomUUID()), rejected = assert.rejects(old)
  await entered.promise
  await f.core.searchDatapacks(f.id(), view.revision, { query: 'new' }, randomUUID())
  release.resolve(versionsResult()); await rejected
  const current = await f.core.datapackProjectVersions(f.id(), view.revision, 'LuaPack02', randomUUID())
  assert.equal(current.project.projectId, 'LuaPack02')
})
test('a later project selection wins over a slow earlier project response in the same world', async t => {
  const entered = deferred<void>(), release = deferred<DatapackCatalogVersions>()
  const f = await fixture(t, { datapackCatalog: { search: async () => searchResult(), versions: async id => {
    if (id === 'LuaPack01') { entered.resolve(); return release.promise }
    return versionsResult(id)
  } } })
  const view = await f.view(), old = f.core.datapackProjectVersions(f.id(), view.revision, 'LuaPack01', randomUUID()), rejected = assert.rejects(old)
  await entered.promise
  const current = await f.core.datapackProjectVersions(f.id(), view.revision, 'LuaPack02', randomUUID())
  release.resolve(versionsResult('LuaPack01')); await rejected
  assert.equal(current.project.projectId, 'LuaPack02')
})
test('world replacement or refresh while metadata is waiting prevents delivery of a stale result', async t => {
  const entered = deferred<void>(), release = deferred<DatapackCatalogSearch>()
  const f = await fixture(t, { datapackCatalog: { search: async () => { entered.resolve(); return release.promise }, versions: async () => versionsResult() } })
  const view = await f.view(), pending = f.core.searchDatapacks(f.id(), view.revision, { query: '' }, randomUUID()), rejected = assert.rejects(pending)
  await entered.promise
  await fs.rename(f.world(), f.world() + '-previous'); await fs.mkdir(f.world())
  release.resolve(searchResult()); await rejected
})
test('world-list refresh and expiry during a network wait invalidate results; no automatic renewal', async t => {
  let now = 100
  const entered = deferred<void>(), release = deferred<DatapackCatalogSearch>()
  const f = await fixture(t, { worldDetailsNow: () => now, datapackCatalog: { search: async () => { entered.resolve(); return release.promise }, versions: async () => versionsResult() } })
  const view = await f.view(), pending = f.core.searchDatapacks(f.id(), view.revision, { query: '' }, randomUUID()), rejected = assert.rejects(pending)
  await entered.promise
  now += 120001
  const refreshed = await f.view()
  release.resolve(searchResult()); await rejected
  assert.notEqual(view.revision, refreshed.revision)
})
test('expiry alone while metadata waits rejects completion even when the world and generation stay unchanged', async t => {
  let now = 100
  const entered = deferred<void>(), release = deferred<DatapackCatalogSearch>()
  const f = await fixture(t, { worldDetailsNow: () => now, datapackCatalog: { search: async () => { entered.resolve(); return release.promise }, versions: async () => versionsResult() } })
  const view = await f.view(), pending = f.core.searchDatapacks(f.id(), view.revision, { query: '' }, randomUUID()), rejected = assert.rejects(pending)
  await entered.promise; now += 120001
  release.resolve(searchResult()); await rejected
})
test('active update and shutdown prevent catalog calls before transport, and errors do not reveal transport paths', async t => {
  const f = await fixture(t, { datapackCatalog: { search: async () => { throw new Error('/private/secret-path-from-inert-substitute') }, versions: async () => versionsResult() } })
  const view = await f.view(), end = f.core.reserveLauncherUpdate()
  await assert.rejects(f.core.searchDatapacks(f.id(), view.revision, { query: '' }, randomUUID()), /更新/)
  await assert.rejects(f.core.datapackProjectVersions(f.id(), view.revision, 'LuaPack01', randomUUID()), /更新/)
  end()
  await assert.rejects(f.core.searchDatapacks(f.id(), view.revision, { query: '' }, randomUUID()), e => e instanceof Error && !e.message.includes('/private/') && e.message.includes('网络'))
  f.core.cancelPendingOperations()
  await assert.rejects(f.core.searchDatapacks(f.id(), view.revision, { query: '' }, randomUUID()))
})
