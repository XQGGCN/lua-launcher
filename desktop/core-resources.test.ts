import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { LauncherCore, type CoreEvent, type Instance } from './core'
import { ResourceInstallRecoveryError, type ResourceArtifact, type ResourceInstallOptions, type ResourceInstallResult } from './resource-install'
import type { ResourceInstallInput } from './resource-catalog'
import type { ResourceInventory } from './resource-inventory'

type Options = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
const sha = (algorithm: string, bytes: Buffer) => createHash(algorithm).update(bytes).digest('hex')
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function payload() {
  const zip = new AdmZip()
  zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":15,"description":"Test fixture"}}'))
  zip.addFile('assets/test/keep-inside-archive.txt', Buffer.from('No archive extraction or activation.'))
  return zip.toBuffer()
}
function resource(kind: 'resourcepack' | 'shader' = 'resourcepack', source: 'modrinth' | 'bbsmc' = 'modrinth') {
  const bytes = payload()
  const artifact: ResourceArtifact = { kind, source, projectId: 'projectA', versionId: 'versionA',
    filename: kind === 'shader' ? 'Shader Fixture.zip' : 'Resource Fixture.zip',
    url: `https://cdn.${source === 'modrinth' ? 'modrinth.com' : 'bbsmc.net'}/data/projectA/versionA/fixture.zip`,
    size: bytes.length, sha512: sha('sha512', bytes) }
  const { url: _url, size: _size, ...selection } = artifact
  const version = { id: artifact.versionId, project_id: artifact.projectId, name: 'Fixture version',
    game_versions: ['1.20.1'], loaders: kind === 'shader' ? ['iris', 'optifine'] : ['minecraft'], dependencies: [] as unknown[],
    files: [{ filename: artifact.filename, url: artifact.url, size: artifact.size, primary: true, hashes: { sha512: artifact.sha512 } }] }
  const project = { id: artifact.projectId, title: 'Fixture Project', description: 'Local test metadata', project_type: kind }
  return { bytes, artifact, selection: selection as ResourceInstallInput, version, project }
}
type ResourceFixture = ReturnType<typeof resource>
function result(artifact: ResourceArtifact): ResourceInstallResult {
  const { url: _url, ...fields } = artifact
  return { ...fields, folder: artifact.kind === 'shader' ? 'shaderpacks' : 'resourcepacks', reused: false, warnings: [] }
}
function installerGate() {
  const calls: Array<{ directory: string; artifact: ResourceArtifact; options: ResourceInstallOptions; release: ReturnType<typeof deferred<ResourceInstallResult>> }> = []
  const entered = deferred()
  const waiters = new Set<{ count: number; ready: ReturnType<typeof deferred<void>> }>()
  async function waitForCalls(count: number) {
    if (calls.length >= count) return
    const waiter = { count, ready: deferred() }
    waiters.add(waiter)
    // Signal the actual injected-worker boundary; filesystem work may need more
    // event-loop turns under the full suite. This wall-clock limit only diagnoses
    // a fixture that never reaches the boundary, and is not a product timeout.
    const timer = setTimeout(() => waiter.ready.reject(new Error(
      `Installer fixture timed out waiting for ${count} workers; observed ${calls.length}`,
    )), 10_000)
    try { await waiter.ready.promise }
    finally { clearTimeout(timer); waiters.delete(waiter) }
  }
  const install: NonNullable<Options['resourceInstaller']> = async (directory, artifact, options = {}) => {
    const release = deferred<ResourceInstallResult>()
    calls.push({ directory, artifact, options, release }); entered.resolve()
    for (const waiter of waiters) if (calls.length >= waiter.count) waiter.ready.resolve()
    return release.promise
  }
  return { calls, entered, install, waitForCalls }
}
async function fixture(t: TestContext, r = resource(), overrides: Options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-resources-'))
  const instances: Instance[] = Array.from({ length: 5 }, (_, i) => ({ id: randomUUID(), name: `Fixture ${i}`,
    version: '1.20.1', loader: 'fabric', loaderVersion: '0.19.5', status: 'ready', createdAt: '2026-10-21T00:00:00.000Z', playtimeMs: 0 }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances,
    settings: { memoryMode: 'auto', memoryMb: 4096, javaPath: '', concurrentDownloads: 4 } }))
  for (const item of instances) await fs.mkdir(path.join(root, 'instances', item.id, 'game'), { recursive: true })
  const requests: Array<{ url: string; options?: RequestInit }> = []
  let handler: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname === `/v2/project/${r.artifact.projectId}`) return Response.json(r.project)
    if (url.pathname === `/v2/version/${r.artifact.versionId}`) return Response.json(r.version)
    if (url.pathname === `/v2/project/${r.artifact.projectId}/version`) return Response.json([r.version])
    if (String(input) === r.artifact.url) return new Response(Uint8Array.from(r.bytes), { headers: { 'content-type': 'application/zip', 'content-length': String(r.bytes.length) } })
    throw new Error('Unexpected fixture request: ' + String(input))
  }
  const events: CoreEvent[] = []
  const fetcher: typeof fetch = async (input, options) => {
    requests.push({ url: String(input), options }); options?.signal?.throwIfAborted()
    return handler(input, options)
  }
  const core = new LauncherCore(root, event => events.push(event), {
    fetch: fetcher,
    spawn: (() => { throw new Error('These tests never execute Java or a game') }) as Options['spawn'],
    ...overrides,
  })
  await core.init()
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, core, instances, requests, events, r, handle: (next: typeof fetch) => { handler = next },
    install: (index = 0, operationId: string = randomUUID()) => core.installResource(instances[index].id, r.selection, operationId) }
}
const emptyInventory = (): ResourceInventory => ({ kind: 'resourcepacks', observedAt: new Date().toISOString(), items: [], warnings: [], truncated: false })

test('default installer places verified ZIP bytes in both fixed folders without extraction, activation, or launcher state mutation', async t => {
  for (const [kind, source] of [['resourcepack', 'modrinth'], ['shader', 'bbsmc']] as const) {
    const f = await fixture(t, resource(kind, source))
    const instance = f.instances[0], game = f.core.getInstancePath(instance.id)
    await fs.writeFile(path.join(game, 'options.txt'), 'resourcePacks:[]\nfullscreen:false\n')
    const originalState = await fs.readFile(path.join(f.root, 'launcher.json'))
    const before = f.core.snapshot()
    const installed = await f.install()
    assert.deepEqual(await fs.readFile(path.join(game, installed.folder, f.r.artifact.filename)), f.r.bytes)
    assert.equal(installed.reused, false)
    assert.deepEqual(installed.warnings, [])
    assert.equal('url' in installed, false)
    assert.deepEqual(await fs.readdir(game), [installed.folder, 'options.txt'].sort())
    assert.equal(await fs.readFile(path.join(game, 'options.txt'), 'utf8'), 'resourcePacks:[]\nfullscreen:false\n')
    assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), originalState)
    assert.deepEqual(f.core.snapshot(), before)
    const registry = JSON.parse(await fs.readFile(path.join(f.core.instanceDirectory(instance.id), 'managed-resources.json'), 'utf8'))
    assert.equal(registry.schema, 1)
    const record = registry.records[`${kind}:${source}:projectA`]
    assert.equal(record.sha512, f.r.artifact.sha512)
    assert.equal(record.filename, f.r.artifact.filename)
    assert.equal('url' in record, false)
    assert.equal('sha1' in record, false)
    assert.ok(Number.isFinite(Date.parse(record.installedAt)))
    assert.ok(f.requests.every(call => new URL(call.url).hostname.endsWith(source === 'modrinth' ? 'modrinth.com' : 'bbsmc.net')))
    assert.equal(f.requests.filter(call => call.url === f.r.artifact.url).length, 1)
    assert.equal((await f.install()).reused, true)
    assert.equal(f.requests.filter(call => call.url === f.r.artifact.url).length, 1, 'Same bytes must be verified locally and not downloaded twice')
    assert.deepEqual(await fs.readdir(f.core.instanceDirectory(instance.id)), ['game', 'managed-resources.json'])
    assert.ok(f.events.some(event => event.type === 'progress' && event.phase.includes('尚未启用') && event.completed === f.r.bytes.length))
  }
})

test('search preserves provider isolation and builds the supported shader facets without a mod loader', async t => {
  const f = await fixture(t)
  f.handle(async () => Response.json({ hits: [{ project_id: 'projectA', slug: 'fixture.pack+32x', title: 'Fixture',
    description: '', author: 'Tester', downloads: 5, categories: ['iris'], project_type: 'shader', icon_url: 'https://cdn.bbsmc.net/icon.png' }],
    total_hits: 1, offset: 20, limit: 20 }))
  const answer = await f.core.searchResources('自然', { kind: 'shader', source: 'bbsmc', gameVersion: '1.20.1', offset: 20 })
  const url = new URL(f.requests[0].url)
  assert.equal(url.hostname, 'api.bbsmc.net')
  assert.equal(url.searchParams.get('query'), '自然')
  assert.deepEqual(JSON.parse(url.searchParams.get('facets')!), [['project_type:shader'], ['categories:iris', 'categories:optifine'], ['versions:1.20.1']])
  assert.equal(answer.hits[0].slug, 'fixture.pack+32x')
  const count = f.requests.length
  await assert.rejects(f.core.searchResources('', { kind: 'world' as 'shader' }), /类型/)
  await assert.rejects(f.core.searchResources('', { kind: 'shader', source: 'other' as 'bbsmc' }), /来源/)
  assert.equal(f.requests.length, count)
})

test('installed resource inventories associate historical receipts without claiming a current byte or activation check', async t => {
  for (const [kind, source] of [['resourcepack', 'modrinth'], ['shader', 'bbsmc']] as const) {
    const f = await fixture(t, resource(kind, source))
    const installed = await f.install()
    const instanceId = f.instances[0].id
    const target = path.join(f.core.getInstancePath(instanceId), installed.folder, installed.filename)
    const ledger = path.join(f.core.instanceDirectory(instanceId), 'managed-resources.json')
    const ledgerBefore = await fs.readFile(ledger)
    const stateBefore = f.core.snapshot()
    const count = f.requests.length
    const first = await f.core.inventory(instanceId, installed.folder)
    assert.deepEqual(first.warnings, [])
    assert.equal(first.items.length, 1)
    assert.deepEqual(first.items[0].recordedSource, { source, projectId: 'projectA', versionId: 'versionA' })
    assert.equal(first.items[0].recordedDownload!.sha512, f.r.artifact.sha512)
    assert.equal(first.items[0].recordedDownload!.size, f.r.artifact.size)
    assert.equal(first.items[0].recordedDownload!.sha1, undefined)
    assert.equal(first.items[0].activation, 'unknown')
    // Replace even the ZIP signature, keeping the basename. A read-only inventory
    // still reports the historical receipt; it does not open/hash current ZIP bytes.
    const edited = Buffer.from(f.r.bytes)
    edited[0] ^= 0xff
    assert.notEqual(sha('sha512', edited), f.r.artifact.sha512)
    await fs.writeFile(target, edited)
    const beforeStat = await fs.stat(target)
    const second = await f.core.inventory(instanceId, installed.folder)
    assert.deepEqual(second.items[0].recordedSource, first.items[0].recordedSource)
    assert.deepEqual(second.items[0].recordedDownload, first.items[0].recordedDownload)
    assert.equal(second.items[0].activation, 'unknown')
    assert.equal('verified' in second.items[0], false)
    assert.deepEqual(await fs.readFile(target), edited)
    assert.equal((await fs.stat(target)).mtimeMs, beforeStat.mtimeMs)
    assert.deepEqual(await fs.readFile(ledger), ledgerBefore)
    assert.deepEqual(f.core.snapshot(), stateBefore)
    assert.equal(f.requests.length, count)
  }
})

test('versions verify project kind and ID before querying versions, using the selected instance game version', async t => {
  const f = await fixture(t, resource('shader'))
  const versions = await f.core.resourceVersions('projectA', f.instances[0].id, 'shader')
  assert.equal(versions[0].externalOnly, false)
  assert.equal(versions[0].sha512, f.r.artifact.sha512)
  assert.equal('url' in versions[0], false)
  assert.match(f.requests[0].url, /\/project\/projectA$/)
  const query = new URL(f.requests[1].url).searchParams
  assert.deepEqual(JSON.parse(query.get('loaders')!), ['iris', 'optifine'])
  assert.deepEqual(JSON.parse(query.get('game_versions')!), ['1.20.1'])
  f.r.project.project_type = 'resourcepack'
  const start = f.requests.length
  await assert.rejects(f.core.resourceVersions('projectA', f.instances[0].id, 'shader'), /类型不匹配/)
  assert.equal(f.requests.length - start, 1)
})

test('metadata redirects cannot leave the selected API provider, including the other supported provider or its CDN', async t => {
  for (const target of ['https://api.bbsmc.net/v2/search', 'https://cdn.modrinth.com/meta.json', 'http://api.modrinth.com/v2/search', 'http://127.0.0.1/']) {
    const f = await fixture(t)
    let cancelled = false
    f.handle(async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 302, headers: { location: target } }))
    await assert.rejects(f.core.searchResources('', { kind: 'resourcepack' }), /不允许/)
    assert.equal(f.requests.length, 1)
    assert.equal(cancelled, true)
  }
})

test('resource metadata rejects HTML, malformed UTF-8, oversized bodies and malformed lists without calling an installer', async t => {
  const f = await fixture(t)
  for (const response of [new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } }),
    new Response(Uint8Array.of(0xc3, 0x28)), new Response(' '.repeat(4 * 1024 * 1024 + 1)), Response.json({ hits: [] })]) {
    f.handle(async () => response)
    await assert.rejects(f.core.searchResources('', { kind: 'resourcepack' }))
  }
})

test('install re-fetches project and version metadata and rejects stale selected identity, file and hash before download', async t => {
  let installed = 0
  const f = await fixture(t, resource(), { resourceInstaller: async (_directory, artifact) => { installed++; return result(artifact) } })
  const original = structuredClone(f.r.version)
  for (const change of [() => { f.r.version.id = 'differentVersion' }, () => { f.r.version.project_id = 'differentProject' },
    () => { f.r.version.files[0].filename = 'Replaced.zip' }, () => { f.r.version.files[0].hashes.sha512 = 'c'.repeat(128) }]) {
    Object.assign(f.r.version, structuredClone(original)); change()
    await assert.rejects(f.install(), /变化|所属项目不匹配/)
  }
  assert.equal(installed, 0)
  assert.equal(f.requests.length, 8)
  assert.ok(f.requests.every(call => new URL(call.url).hostname === 'api.modrinth.com'))
  Object.assign(f.r.version, original)
  await f.install()
  assert.equal(installed, 1)
})

test('required dependencies, auxiliary primary files and unsupported shader engines remain external-only at install time', async t => {
  let installed = 0
  const f = await fixture(t, resource('shader'), { resourceInstaller: async (_directory, artifact) => { installed++; return result(artifact) } })
  f.r.version.dependencies = [{ dependency_type: 'required', project_id: 'dependency', version_id: null, file_name: null }]
  await assert.rejects(f.install(), /必需或不兼容依赖/)
  f.r.version.dependencies = []
  f.r.version.loaders = ['canvas']
  await assert.rejects(f.install(), /Iris.*OptiFine/)
  f.r.version.loaders = ['iris']
  Object.assign(f.r.version.files[0], { file_type: 'required-resource-pack' })
  await assert.rejects(f.install(), /附带资源包/)
  assert.equal(installed, 0)
})

test('invalid install inputs and a not-installed instance fail without network or installer calls', async t => {
  const f = await fixture(t)
  await assert.rejects(f.core.installResource('../outside', f.r.selection, randomUUID()), /实例不存在/)
  await assert.rejects(f.core.installResource(f.instances[0].id, { ...f.r.selection, url: 'https://cdn.modrinth.com/other.zip' }, randomUUID()), /未知字段/)
  await assert.rejects(f.install(0, 'not-an-operation-id'), /任务标识/)
  const saved = JSON.parse(await fs.readFile(path.join(f.root, 'launcher.json'), 'utf8'))
  saved.instances[0].status = 'not-installed'
  await fs.writeFile(path.join(f.root, 'launcher.json'), JSON.stringify(saved))
  await f.core.init()
  await assert.rejects(f.install(), /完成游戏下载/)
  assert.equal(f.requests.length, 0)
})

test('operation-scoped cancellation during metadata fetch prevents late installer entry and releases the instance lock', async t => {
  const entered = deferred(), response = deferred<Response>()
  let installed = 0, observedSignal: AbortSignal | undefined
  const f = await fixture(t, resource(), { resourceInstaller: async (_directory, artifact) => { installed++; return result(artifact) } })
  f.handle(async (_input, options) => { observedSignal = options?.signal ?? undefined; entered.resolve(); return response.promise })
  const operation = randomUUID(), pending = assert.rejects(f.install(0, operation), /已取消/)
  await entered.promise
  f.core.cancelResourceInstall(f.instances[0].id, randomUUID())
  assert.equal(observedSignal!.aborted, false)
  f.core.cancelResourceInstall(f.instances[0].id, operation)
  assert.equal(observedSignal!.aborted, true)
  response.resolve(Response.json(f.r.project))
  await pending
  assert.equal(installed, 0)
  f.handle(async input => Response.json(new URL(String(input)).pathname.includes('/project/') ? f.r.project : f.r.version))
  await f.install()
  assert.equal(installed, 1)
})

test('a pending resource transaction blocks conflicting instance mutations and inventory until settled', async t => {
  const gate = installerGate(), f = await fixture(t, resource(), { resourceInstaller: gate.install })
  const before = f.core.snapshot(), pending = f.install()
  await gate.entered.promise
  await assert.rejects(f.install(), /正在安装/)
  await assert.rejects(f.core.install(f.instances[0].id), /正在安装/)
  await assert.rejects(f.core.installMod(f.instances[0].id, 'modVersion'), /已有安装任务/)
  await assert.rejects(f.core.updateInstanceSettings(f.instances[0].id, { name: 'Changed', options: {} }), /完成安装/)
  await assert.rejects(f.core.inventory(f.instances[0].id, 'resourcepacks'), /正在安装/)
  assert.deepEqual(f.core.snapshot(), before)
  assert.equal(gate.calls[0].directory, f.core.instanceDirectory(f.instances[0].id))
  assert.ok(gate.calls[0].options.signal instanceof AbortSignal)
  gate.calls[0].release.resolve(result(gate.calls[0].artifact))
  await pending
  assert.deepEqual((await f.core.inventory(f.instances[0].id, 'resourcepacks')).items, [])
})

test('four global resource transactions are allowed, with slots retained through cancellation until workers settle', async t => {
  const gate = installerGate(), f = await fixture(t, resource(), { resourceInstaller: gate.install })
  const operations = f.instances.slice(0, 4).map(() => randomUUID())
  const pending = operations.map((operation, i) => f.install(i, operation))
  // The fifth call runs before any async metadata resolves and must already see all four reservations.
  await assert.rejects(f.install(4), /任务较多/)
  await gate.waitForCalls(4)
  f.core.cancelResourceInstall(f.instances[0].id, operations[0])
  await assert.rejects(f.install(4), /任务较多/)
  const cancelled = assert.rejects(pending[0], /已取消/)
  const cancelledCall = gate.calls.find(call => call.directory === f.core.instanceDirectory(f.instances[0].id))!
  cancelledCall.release.reject(new DOMException('Cancelled', 'AbortError'))
  await cancelled
  const fifth = f.install(4)
  await gate.waitForCalls(5)
  for (const call of gate.calls) if (call !== cancelledCall) call.release.resolve(result(call.artifact))
  await Promise.all([...pending.slice(1), fifth])
})

test('shutdown cancels all resource workers; failure releases locks and preserves ready instance status', async t => {
  const gate = installerGate(), f = await fixture(t, resource(), { resourceInstaller: gate.install })
  const tasks = [f.install(0), f.install(1)]
  const outcomes = tasks.map(task => assert.rejects(task, /已取消/))
  await gate.waitForCalls(2)
  f.core.cancelPendingOperations()
  for (const call of gate.calls) { assert.equal(call.options.signal!.aborted, true); call.release.reject(new DOMException('Cancelled', 'AbortError')) }
  await Promise.all(outcomes)
  assert.ok(f.core.snapshot().instances.every(instance => instance.status === 'ready'))
  await f.core.updateInstanceSettings(f.instances[0].id, { name: 'After cancellation', options: {} })
})

test('a committed installer result wins late cancellation and publishes success, not a cancelled state', async t => {
  const f = await fixture(t, resource(), { resourceInstaller: async (_directory, artifact, options) => {
    f.core.cancelPendingOperations()
    assert.equal(options!.signal!.aborted, true)
    return result(artifact) // Models the installer's successful atomic registry-rename commit boundary.
  } })
  assert.equal((await f.install()).filename, f.r.artifact.filename)
  assert.ok(f.events.some(event => event.type === 'progress' && event.phase.includes('尚未启用')))
  assert.equal(f.events.some(event => event.type === 'log' && event.message === '资源下载已取消'), false)
})

test('a rollback recovery failure marks and persists the instance as error, while an ordinary failure keeps it ready', async t => {
  let recovery = false
  const f = await fixture(t, resource(), { resourceInstaller: async directory => {
    if (recovery) throw new ResourceInstallRecoveryError('Fixture requires recovery', path.join(directory, '.resource-staging-fixture'))
    throw new Error('Fixture download failed')
  } })
  await assert.rejects(f.install(), /download failed/)
  assert.equal(f.core.snapshot().instances[0].status, 'ready')
  recovery = true
  await assert.rejects(f.install(), /requires recovery/)
  assert.equal(f.core.snapshot().instances[0].status, 'error')
  const saved = JSON.parse(await fs.readFile(path.join(f.root, 'launcher.json'), 'utf8'))
  assert.equal(saved.instances[0].status, 'error')
  assert.equal(saved.instances[0].error, 'Fixture requires recovery')
  const calls = f.requests.length
  await assert.rejects(f.install(), /修复/)
  assert.equal(f.requests.length, calls)
})

test('a whole resource install invalidates an earlier inventory scan even if its scanner resolves only after completion', async t => {
  const scan = deferred<ResourceInventory>()
  let scanSignal: AbortSignal | undefined
  const f = await fixture(t, resource(), { inventoryScanner: async (_directory, _kind, options) => {
    scanSignal = options!.signal; return scan.promise
  }, resourceInstaller: async (_directory, artifact) => result(artifact) })
  const earlier = assert.rejects(f.core.inventory(f.instances[0].id, 'resourcepacks'), { name: 'AbortError' })
  await f.install()
  assert.equal(scanSignal!.aborted, true)
  scan.resolve(emptyInventory())
  await earlier
})

test('a pending settings persistence blocks resource install before metadata or transaction entry', async t => {
  const entered = deferred(), release = deferred()
  let block = false
  const f = await fixture(t, resource(), { stateRename: async (from, to) => {
    if (block) { entered.resolve(); await release.promise }
    await fs.rename(from, to)
  } })
  block = true
  const saving = f.core.updateInstanceSettings(f.instances[0].id, { name: 'New name', options: {} })
  await entered.promise
  await assert.rejects(f.install(), /保存设置/)
  assert.equal(f.requests.length, 0)
  release.resolve(); await saving
})
