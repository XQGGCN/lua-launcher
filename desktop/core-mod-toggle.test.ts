import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { LauncherCore, type CoreEvent, type Instance, type LaunchAccount, type ModrinthVersion, type ResourceSource } from './core'
import type { ResourceInventory } from './resource-inventory'
import { prepareModToggle, commitModToggle, inspectModToggleRecovery, ModToggleRecoveryError } from './mod-toggle'

type Options = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
const digest = (bytes: Buffer, algorithm = 'sha1') => createHash(algorithm).update(bytes).digest('hex')
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function fileExists(file: string) {
  return fs.lstat(file).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}
async function fixture(t: TestContext, options: Options = {}, patch: Partial<Instance> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-mod-toggle-'))
  const instances: Instance[] = Array.from({ length: 2 }, (_, index) => ({
    id: randomUUID(), name: `Fixture ${index}`, version: '1.20.1', loader: 'fabric', loaderVersion: '0.19.5',
    status: 'ready', createdAt: '2026-10-21T00:00:00.000Z', playtimeMs: 0, ...patch,
  }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances,
    settings: { memoryMode: 'auto', memoryMb: 4096, javaPath: '', concurrentDownloads: 4 } }))
  for (const instance of instances) await fs.mkdir(path.join(root, 'instances', instance.id, 'game', 'mods'), { recursive: true })
  const requests: string[] = [], events: CoreEvent[] = []
  const responses = new Map<string, unknown>(), binaries = new Map<string, Buffer>()
  let handler: typeof fetch = async input => {
    const url = String(input)
    if (responses.has(url)) return Response.json(responses.get(url))
    const bytes = binaries.get(url)
    if (bytes) return new Response(Uint8Array.from(bytes))
    throw new Error(`Unexpected fixture request: ${url}`)
  }
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(String(input)); init?.signal?.throwIfAborted()
    return handler(input, init)
  }
  const core = new LauncherCore(root, event => events.push(event), {
    fetch: fetcher,
    spawn: (() => { throw new Error('This suite must never execute Java or a game') }) as Options['spawn'],
    javaRuntimeManager: { ensure: async () => { throw new Error('No Java preparation in these tests') }, discover: async () => [] },
    ...options,
  })
  await core.init()
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  const directory = (index = 0) => core.instanceDirectory(instances[index].id)
  const mods = (index = 0) => path.join(core.getInstancePath(instances[index].id), 'mods')
  const registry = (index = 0) => path.join(directory(index), 'managed-mods.json')
  const addMod = (id: string, projectId: string, filename: string, dependencies: ModrinthVersion['dependencies'] = [], source: ResourceSource = 'modrinth') => {
    const bytes = Buffer.from(`Fixture JAR bytes: ${source}/${projectId}/${id}`)
    const host = source === 'modrinth' ? 'modrinth.com' : 'bbsmc.net'
    const url = `https://cdn.${host}/data/${projectId}/${id}/${encodeURIComponent(filename)}`
    const version: ModrinthVersion = { id, project_id: projectId, name: id, game_versions: ['1.20.1'], loaders: ['fabric'],
      dependencies, files: [{ filename, url, size: bytes.length, primary: true,
        hashes: { sha1: digest(bytes), sha512: digest(bytes, 'sha512') } }] }
    responses.set(`https://api.${host}/v2/version/${id}`, version); binaries.set(url, bytes)
    return { bytes, version, url }
  }
  return { root, core, instances, requests, events, responses, binaries, directory, mods, registry, addMod,
    handle: (next: typeof fetch) => { handler = next } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function selection(f: Fixture, filename = 'local.jar', index = 0) {
  const file = path.join(f.mods(index), filename)
  const info = await fs.stat(file)
  return { itemId: `mods:${digest(Buffer.from(filename), 'sha256')}`, name: filename,
    sizeBytes: info.size, modifiedAt: new Date(info.mtimeMs).toISOString() }
}
async function addLocal(f: Fixture, filename = 'local.jar', index = 0) {
  await fs.writeFile(path.join(f.mods(index), filename), 'local ordinary file; never opened as an archive')
  return selection(f, filename, index)
}
const emptyInventory = (): ResourceInventory => ({ kind: 'mods', observedAt: new Date().toISOString(), items: [], warnings: [], truncated: false })
async function unchangedAfterRejectedInstall(f: Fixture, versionId: string, source: ResourceSource = 'modrinth') {
  const beforeFiles = new Map(await Promise.all((await fs.readdir(f.mods())).map(async name => [name, await fs.readFile(path.join(f.mods(), name))] as const)))
  const registryBefore = await fs.readFile(f.registry()).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  const stateBefore = await fs.readFile(path.join(f.root, 'launcher.json'))
  const directoryBefore = await fs.stat(f.directory(), { bigint: true })
  await assert.rejects(f.core.installMod(f.instances[0].id, versionId, source), /禁用|disabled|冲突|同名|其他来源|手动|记录|普通文件/)
  assert.equal(f.requests.filter(url => new URL(url).hostname.startsWith('cdn.')).length, 0)
  assert.deepEqual(await fs.readdir(f.mods()), [...beforeFiles.keys()])
  for (const [name, bytes] of beforeFiles) assert.deepEqual(await fs.readFile(path.join(f.mods(), name)), bytes)
  assert.deepEqual(await fs.readFile(f.registry()).catch(error => { if (error.code === 'ENOENT') return undefined; throw error }), registryBefore)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), stateBefore)
  assert.equal((await fs.readdir(f.directory())).some(name => name.startsWith('.mod-staging-')), false)
  assert.equal((await fs.stat(f.directory(), { bigint: true })).mtimeNs, directoryBefore.mtimeNs,
    'Conflict detection must precede creating and deleting a staging directory')
}

test('installMod rejects a manually disabled candidate before artifact requests or staging and leaves the registry absent', async t => {
  const f = await fixture(t)
  f.addMod('new1', 'projectA', 'manual.jar')
  await fs.writeFile(path.join(f.mods(), 'manual.jar.disabled'), 'manually disabled bytes')
  await unchangedAfterRejectedInstall(f, 'new1')
})

test('installMod rejects a renamed upgrade when the registered previous filename is disabled, including legacy keys', async t => {
  for (const source of ['modrinth', 'bbsmc'] as const) for (const legacy of source === 'modrinth' ? [false, true] : [false]) {
    const f = await fixture(t)
    f.addMod('new2', 'projectA', 'renamed-v2.jar', [], source)
    await fs.writeFile(path.join(f.mods(), 'old-v1.jar.disabled'), 'old disabled version')
    await fs.writeFile(f.registry(), JSON.stringify({ [legacy ? 'projectA' : `${source}:projectA`]: { versionId: 'old1', filename: 'old-v1.jar' } }, null, 2))
    await unchangedAfterRejectedInstall(f, 'new2', source)
  }
})

test('installMod checks required dependency disabled partners before downloading even the selected mod', async t => {
  const f = await fixture(t)
  f.addMod('selected', 'projectA', 'selected.jar', [{ dependency_type: 'required', version_id: 'dep-new' }])
  f.addMod('dep-new', 'dependency', 'dependency-v2.jar')
  await fs.writeFile(path.join(f.mods(), 'dependency-v1.jar.disabled'), 'required dependency remains disabled')
  await fs.writeFile(f.registry(), JSON.stringify({ 'modrinth:dependency': { versionId: 'dep-old', filename: 'dependency-v1.jar' } }))
  await unchangedAfterRejectedInstall(f, 'selected')
  assert.ok(f.requests.some(url => url.endsWith('/version/dep-new')))
})

test('installMod refuses enabled and disabled partners together even when enabled bytes match the download', async t => {
  const f = await fixture(t)
  const mod = f.addMod('new1', 'projectA', 'same.jar')
  await fs.writeFile(path.join(f.mods(), 'same.jar'), mod.bytes)
  await fs.writeFile(path.join(f.mods(), 'same.jar.disabled'), mod.bytes)
  await fs.writeFile(f.registry(), JSON.stringify({ 'modrinth:projectA': { versionId: 'old', filename: 'same.jar' } }))
  await unchangedAfterRejectedInstall(f, 'new1')
})

test('installMod protects disabled files across provider boundaries and case-normalized names', async t => {
  for (const filename of ['shared.jar.disabled', 'SHARED.JAR.DISABLED']) {
    const f = await fixture(t)
    f.addMod('new1', 'projectA', 'shared.jar', [], 'bbsmc')
    await fs.writeFile(path.join(f.mods(), filename), 'do not implicitly enable from another provider')
    await fs.writeFile(f.registry(), JSON.stringify({ 'modrinth:projectA': { versionId: 'old', filename: 'shared.jar' } }))
    await unchangedAfterRejectedInstall(f, 'new1', 'bbsmc')
  }
})

test('default Core toggle changes one local name both ways, preserves bytes and historical registry, and performs no network', async t => {
  const f = await fixture(t)
  const input = await addLocal(f)
  const id = f.instances[0].id
  await fs.writeFile(f.registry(), JSON.stringify({ 'modrinth:local-project': { versionId: 'historical', filename: input.name } }))
  const registryBefore = await fs.readFile(f.registry()), stateBefore = await fs.readFile(path.join(f.root, 'launcher.json'))
  const bytes = await fs.readFile(path.join(f.mods(), input.name))
  const initial = (await f.core.inventory(id, 'mods')).items[0]
  assert.equal(initial.recordedSource?.projectId, 'local-project')
  const preview = await f.core.prepareModToggle(id, input, false)
  assert.deepEqual(Object.keys(preview).sort(), ['enabled', 'expiresAt', 'fromName', 'instanceId', 'itemId', 'modifiedAt', 'sizeBytes', 'toName', 'token'].sort())
  assert.match(preview.token, /^[a-f0-9-]{36}$/)
  assert.equal(preview.fromName, input.name); assert.equal(preview.toName, 'local.jar.disabled')
  assert.equal(preview.enabled, false)
  assert.deepEqual(await fs.readdir(f.directory()), ['game', 'managed-mods.json'])
  const disabled = await f.core.setModEnabled(id, preview.token)
  assert.equal(disabled.fromName, input.name); assert.equal(disabled.toName, preview.toName)
  assert.equal(await fileExists(path.join(f.mods(), input.name)), false)
  assert.deepEqual(await fs.readFile(path.join(f.mods(), preview.toName)), bytes)
  const disabledInventory = (await f.core.inventory(id, 'mods')).items[0]
  assert.equal(disabledInventory.activation, 'disabled-suffix')
  assert.equal(disabledInventory.recordedSource, undefined, 'A suffix must not invent historical provenance')
  const restoredPreview = await f.core.prepareModToggle(id, await selection(f, preview.toName), true)
  await f.core.setModEnabled(id, restoredPreview.token)
  assert.deepEqual(await fs.readdir(f.mods()), [input.name])
  assert.deepEqual(await fs.readFile(path.join(f.mods(), input.name)), bytes)
  assert.deepEqual((await f.core.inventory(id, 'mods')).items[0].recordedSource, initial.recordedSource)
  assert.deepEqual(await fs.readFile(f.registry()), registryBefore)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), stateBefore)
  assert.equal(f.requests.length, 0)
  assert.equal(f.events.some(event => event.type === 'progress'), false, 'Local rename is not a download task')
})

test('Core validates selection and desired state without accepting renderer paths or fabricated stale metadata', async t => {
  const f = await fixture(t), input = await addLocal(f), id = f.instances[0].id
  for (const bad of [null, [], { ...input, filePath: '/tmp/arbitrary.jar' }, { ...input, name: '../local.jar' },
    { ...input, itemId: 'mods:' + '0'.repeat(64) }, { ...input, sizeBytes: input.sizeBytes + 1 },
    { ...input, modifiedAt: '2000-01-01T00:00:00.000Z' }]) {
    await assert.rejects(f.core.prepareModToggle(id, bad, false))
  }
  await assert.rejects(f.core.prepareModToggle(id, input, 'false' as unknown as boolean), /状态/)
  await assert.rejects(f.core.prepareModToggle('../escape', input, false), /不存在/)
  assert.deepEqual(await fs.readdir(f.mods()), ['local.jar'])
  assert.deepEqual(await fs.readdir(f.directory()), ['game'])
  assert.equal(f.requests.length, 0)
})

test('tokens expire, cannot replay, and cannot authorize another instance', async t => {
  let now = 1000, commits = 0
  const f = await fixture(t, { modToggleNow: () => now, modToggleCommitter: async (...args) => { commits++; return commitModToggle(...args) } })
  const input = await addLocal(f), id = f.instances[0].id
  const expired = await f.core.prepareModToggle(id, input, false)
  assert.equal(expired.expiresAt, now + 120_000)
  now = expired.expiresAt
  await assert.rejects(f.core.setModEnabled(id, expired.token), /过期/)
  const valid = await f.core.prepareModToggle(id, input, false)
  await assert.rejects(f.core.setModEnabled(f.instances[1].id, valid.token), /过期/)
  assert.equal(commits, 0)
  await f.core.setModEnabled(id, valid.token)
  await assert.rejects(f.core.setModEnabled(id, valid.token), /过期/)
  assert.equal(commits, 1)
  assert.deepEqual(await fs.readdir(f.mods()), ['local.jar.disabled'])
})

test('token capacity is bounded globally and expired confirmations are reclaimed', async t => {
  let now = 1000
  const f = await fixture(t, { modToggleNow: () => now }), input = await addLocal(f), id = f.instances[0].id
  for (let index = 0; index < 32; index++) await f.core.prepareModToggle(id, input, false)
  await assert.rejects(f.core.prepareModToggle(id, input, false), /较多/)
  now += 120_000
  await f.core.prepareModToggle(id, input, false)
  assert.deepEqual(await fs.readdir(f.directory()), ['game'])
})

test('non-ready and Vanilla instances reject preparation before the file preparer', async t => {
  for (const patch of [{ status: 'not-installed' }, { status: 'error' }, { loader: 'vanilla' }] as Partial<Instance>[]) {
    let calls = 0
    const f = await fixture(t, { modTogglePreparer: async (...args) => { calls++; return prepareModToggle(...args) } }, patch)
    await assert.rejects(f.core.prepareModToggle(f.instances[0].id, await addLocal(f), false), /加载器|关闭游戏/)
    assert.equal(calls, 0)
  }
})

test('a confirmation is consumed and the instance lock is held before the commit worker first yields', async t => {
  const entered = deferred(), release = deferred()
  let calls = 0
  const f = await fixture(t, { modToggleCommitter: async (...args) => { calls++; entered.resolve(); await release.promise; return commitModToggle(...args) } })
  const input = await addLocal(f), id = f.instances[0].id, preview = await f.core.prepareModToggle(id, input, false)
  const pending = f.core.setModEnabled(id, preview.token)
  const settled = pending.catch(() => {})
  try {
    await assert.rejects(f.core.setModEnabled(id, preview.token), /过期/)
    await assert.rejects(f.core.installMod(id, 'must-not-be-requested'), /任务|安装/)
    await assert.rejects(f.core.installResource(id, { kind: 'resourcepack', source: 'modrinth', projectId: 'fixture',
      versionId: 'fixture1', filename: 'fixture.zip', sha512: 'a'.repeat(128) }, randomUUID()), /安装/)
    assert.throws(() => f.core.assertLaunchAvailable(id), /文件操作|安装/)
    await assert.rejects(f.core.launch(id, {} as LaunchAccount), /安装|操作正在进行/)
    await assert.rejects(f.core.updateInstanceSettings(id, { name: 'Blocked', options: {} }), /安装|运行/)
    await assert.rejects(f.core.inventory(id, 'mods'), /安装/)
    await entered.promise
    assert.equal(calls, 1); assert.equal(f.requests.length, 0)
    const other = await addLocal(f, 'other.jar', 1)
    await f.core.prepareModToggle(f.instances[1].id, other, false)
  } finally { release.resolve(); await settled }
  await pending
})

test('completed settings mutation invalidates both minted tokens and an in-flight preparation', async t => {
  const entered = deferred(), release = deferred()
  let gate = false
  const f = await fixture(t, { modTogglePreparer: async (...args) => {
    const prepared = await prepareModToggle(...args)
    if (gate) { entered.resolve(); await release.promise }
    return prepared
  } })
  const input = await addLocal(f), id = f.instances[0].id
  const minted = await f.core.prepareModToggle(id, input, false)
  gate = true
  const pending = f.core.prepareModToggle(id, input, false), rejected = assert.rejects(pending, /变化|过期/)
  await entered.promise
  await f.core.updateInstanceSettings(id, { name: 'New name', options: {} })
  release.resolve(); await rejected
  await assert.rejects(f.core.setModEnabled(id, minted.token), /过期/)
  assert.deepEqual(await fs.readdir(f.mods()), ['local.jar'])
})

test('an old inventory scan cannot publish after a complete toggle even if it ignores cancellation', async t => {
  const entered = deferred(), release = deferred<ResourceInventory>()
  let oldSignal: AbortSignal | undefined
  const f = await fixture(t, { inventoryScanner: async (_root, _kind, options = {}) => {
    oldSignal = options.signal; entered.resolve(); return release.promise
  } })
  const input = await addLocal(f), id = f.instances[0].id
  const old = f.core.inventory(id, 'mods'), rejected = assert.rejects(old, /取消|Abort|安装/)
  await entered.promise
  const prepared = await f.core.prepareModToggle(id, input, false)
  await f.core.setModEnabled(id, prepared.token)
  assert.equal(oldSignal?.aborted, true)
  release.resolve(emptyInventory()); await rejected
  assert.deepEqual(await fs.readdir(f.mods()), ['local.jar.disabled'])
})

test('shutdown aborts a commit without releasing its lock until the worker has settled', async t => {
  const entered = deferred(), release = deferred()
  let signal: AbortSignal | undefined
  const f = await fixture(t, { modToggleCommitter: async (...args) => {
    signal = args[2]?.signal; entered.resolve(); await release.promise
    return commitModToggle(...args)
  } })
  const input = await addLocal(f), id = f.instances[0].id, preview = await f.core.prepareModToggle(id, input, false)
  const pending = f.core.setModEnabled(id, preview.token), rejected = assert.rejects(pending, /退出|Abort|取消/)
  await entered.promise; f.core.cancelPendingOperations()
  assert.equal(signal?.aborted, true)
  await assert.rejects(f.core.installMod(id, 'must-not-fetch'), /任务|安装/)
  assert.equal(f.requests.length, 0)
  release.resolve(); await rejected
  assert.deepEqual(await fs.readdir(f.mods()), ['local.jar'])
  assert.deepEqual(await fs.readdir(f.directory()), ['game'])
})

test('shutdown invalidates already minted tokens and preparations that return after the exit signal', async t => {
  const entered = deferred(), release = deferred()
  let gate = false
  const f = await fixture(t, { modTogglePreparer: async (...args) => {
    const prepared = await prepareModToggle(...args)
    if (gate) { entered.resolve(); await release.promise }
    return prepared
  } })
  const input = await addLocal(f), id = f.instances[0].id, minted = await f.core.prepareModToggle(id, input, false)
  gate = true
  const pending = f.core.prepareModToggle(id, input, false), rejected = assert.rejects(pending, /变化|过期|退出|取消/)
  await entered.promise; f.core.cancelPendingOperations(); release.resolve(); await rejected
  await assert.rejects(f.core.setModEnabled(id, minted.token), /过期|退出/)
  assert.deepEqual(await fs.readdir(f.mods()), ['local.jar'])
})

test('concurrent read-only preparations never turn module contention into a permanent recovery error', async t => {
  const f = await fixture(t), input = await addLocal(f), id = f.instances[0].id
  const diskBefore = await fs.readFile(path.join(f.root, 'launcher.json'))
  const results = await Promise.allSettled([
    f.core.prepareModToggle(id, input, false), f.core.prepareModToggle(id, input, false),
  ])
  assert.equal(f.core.snapshot().instances[0].status, 'ready', JSON.stringify(results))
  assert.deepEqual(await fs.readdir(f.directory()), ['game'])
  assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), diskBefore)
  await f.core.assertInstanceUsable(id)
  await f.core.prepareModToggle(id, input, false)
})

test('corrupt or missing historical download ledgers do not prevent safe local filename changes or create a new ledger', async t => {
  for (const registryBytes of [undefined, Buffer.from('{malformed historical registry')]) {
    const f = await fixture(t), input = await addLocal(f), id = f.instances[0].id
    if (registryBytes) await fs.writeFile(f.registry(), registryBytes)
    const preview = await f.core.prepareModToggle(id, input, false)
    await f.core.setModEnabled(id, preview.token)
    assert.deepEqual(await fs.readFile(f.registry()).catch(error => { if (error.code === 'ENOENT') return undefined; throw error }), registryBytes)
    assert.deepEqual(await fs.readdir(f.mods()), ['local.jar.disabled'])
    assert.equal(f.requests.length, 0)
  }
})

test('RecoveryError remains an in-memory safety gate when saving launcher state fails', async t => {
  let failSave = false
  let marker = ''
  const f = await fixture(t, {
    stateRename: async (from, to) => {
      if (failSave) throw new Error('Injected state save failure')
      await fs.rename(from, to)
    },
    modToggleCommitter: async (directory, prepared, options) => {
      failSave = true
      try {
        return await commitModToggle(directory, prepared, { ...options,
          unlink: async () => { throw new Error('Injected failure deleting both the original and rollback target') } })
      } catch (error) {
        if (error instanceof ModToggleRecoveryError) marker = error.stagingDirectory
        throw error
      }
    },
  })
  const input = await addLocal(f), id = f.instances[0].id, stateBefore = await fs.readFile(path.join(f.root, 'launcher.json'))
  const preview = await f.core.prepareModToggle(id, input, false)
  f.events.length = 0
  await assert.rejects(f.core.setModEnabled(id, preview.token), ModToggleRecoveryError)
  const journalBefore = await fs.readFile(path.join(marker, 'intent.json'))
  assert.equal(f.core.snapshot().instances[0].status, 'error')
  const stateEvent = f.events.slice().reverse().find(event => event.type === 'state')
  assert.ok(stateEvent?.type === 'state', 'Unsafe rollback must publish its error even when launcher.json saving fails')
  assert.equal(stateEvent.snapshot.instances.find(item => item.id === id)?.status, 'error')
  assert.match(stateEvent.snapshot.instances.find(item => item.id === id)?.error || '', /恢复|检查/)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), stateBefore)
  await assert.rejects(f.core.updateInstanceSettings(id, { name: 'Must not save', options: {} }), /恢复|检查/)
  await assert.rejects(f.core.install(id))
  await assert.rejects(f.core.installMod(id, 'must-not-fetch'))
  await assert.rejects(f.core.installResource(id, { kind: 'resourcepack', source: 'modrinth', projectId: 'fixture',
    versionId: 'fixture1', filename: 'fixture.zip', sha512: 'a'.repeat(128) }, randomUUID()))
  await assert.rejects(f.core.launch(id, {} as LaunchAccount), /恢复|检查/)
  await assert.rejects(f.core.assertInstanceUsable(id), /恢复|检查/)
  assert.equal(f.requests.length, 0)
  assert.deepEqual(await fs.readdir(f.mods()), ['local.jar', 'local.jar.disabled'])
  assert.deepEqual(await fs.readFile(path.join(marker, 'intent.json')), journalBefore)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), stateBefore)
  assert.equal(f.core.snapshot().instances[0].name, 'Fixture 0')
  assert.ok(f.events.some(event => event.type === 'log' && event.message.includes('保存失败')))
})

test('init preserves ambiguous double-name and malformed journals and prevents ordinary install from hiding them', async t => {
  for (const mode of ['double-name', 'malformed'] as const) {
    const f = await fixture(t), input = await addLocal(f), id = f.instances[0].id
    const prepared = await prepareModToggle(f.directory(), input, false)
    const operationId = randomUUID(), stage = path.join(f.directory(), '.mod-toggle-' + operationId)
    await fs.mkdir(stage)
    const journal = mode === 'malformed' ? '{broken json' : JSON.stringify({ schema: 1, operationId,
      createdAt: new Date().toISOString(), prepared })
    await fs.writeFile(path.join(stage, 'intent.json'), journal)
    if (mode === 'double-name') await fs.link(path.join(f.mods(), input.name), path.join(f.mods(), 'local.jar.disabled'))
    const stateBefore = await fs.readFile(path.join(f.root, 'launcher.json'))
    f.events.length = 0
    await assert.rejects(f.core.prepareModToggle(id, input, false), /恢复|检查/)
    const stateEvent = f.events.slice().reverse().find(event => event.type === 'state')
    assert.ok(stateEvent?.type === 'state', 'A newly detected recovery error must reach the renderer without a state-file save')
    assert.equal(stateEvent.snapshot.instances.find(item => item.id === id)?.status, 'error')
    assert.match(stateEvent.snapshot.instances.find(item => item.id === id)?.error || '', /恢复|检查/)
    assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), stateBefore,
      'Emitting the safety state must not depend on successfully writing launcher.json')
    let requests = 0
    const restarted = new LauncherCore(f.root, () => {}, { fetch: async () => { requests++; throw new Error('Must not fetch') } })
    const loaded = await restarted.init()
    assert.equal(loaded.instances[0].status, 'error')
    assert.equal(await fs.readFile(path.join(stage, 'intent.json'), 'utf8'), journal)
    await assert.rejects(restarted.install(id), /恢复|检查/)
    await assert.rejects(restarted.updateInstanceSettings(id, { name: 'Blocked', options: {} }), /恢复|检查/)
    await assert.rejects(restarted.launch(id, {} as LaunchAccount), /恢复|检查/)
    assert.equal(requests, 0)
    assert.equal(await fs.readFile(path.join(stage, 'intent.json'), 'utf8'), journal)
    assert.deepEqual(await fs.readdir(f.mods()), mode === 'double-name' ? ['local.jar', 'local.jar.disabled'] : ['local.jar'])
    restarted.cancelPendingOperations()
  }
})

test('init cleans only an unambiguous unfinished journal and leaves its surviving file unchanged', async t => {
  for (const committed of [false, true]) {
    const f = await fixture(t), input = await addLocal(f)
    const prepared = await prepareModToggle(f.directory(), input, false)
    const operationId = randomUUID(), stage = path.join(f.directory(), '.mod-toggle-' + operationId)
    await fs.mkdir(stage)
    await fs.writeFile(path.join(stage, 'intent.json'), JSON.stringify({ schema: 1, operationId, createdAt: new Date().toISOString(), prepared }))
    const bytes = await fs.readFile(path.join(f.mods(), input.name))
    if (committed) {
      await fs.link(path.join(f.mods(), input.name), path.join(f.mods(), 'local.jar.disabled'))
      await fs.unlink(path.join(f.mods(), input.name))
    }
    const restarted = new LauncherCore(f.root)
    const loaded = await restarted.init()
    assert.equal(loaded.instances[0].status, 'ready')
    assert.equal(await fileExists(stage), false)
    const expected = committed ? 'local.jar.disabled' : input.name
    assert.deepEqual(await fs.readdir(f.mods()), [expected])
    assert.deepEqual(await fs.readFile(path.join(f.mods(), expected)), bytes)
    assert.deepEqual(await inspectModToggleRecovery(f.directory()), { blocked: false, warnings: [] })
    restarted.cancelPendingOperations()
  }
})

test('a token cannot rename a replacement at the same filename, and a failed confirmation stays consumed', async t => {
  const f = await fixture(t), input = await addLocal(f), id = f.instances[0].id
  const preview = await f.core.prepareModToggle(id, input, false)
  await fs.unlink(path.join(f.mods(), input.name))
  await fs.writeFile(path.join(f.mods(), input.name), 'new external file after the confirmation was prepared')
  const replacement = await fs.readFile(path.join(f.mods(), input.name))
  await assert.rejects(f.core.setModEnabled(id, preview.token), /变化|修改|替换/)
  await assert.rejects(f.core.setModEnabled(id, preview.token), /过期/)
  assert.deepEqual(await fs.readFile(path.join(f.mods(), input.name)), replacement)
  assert.deepEqual(await fs.readdir(f.directory()), ['game'])
  assert.equal(f.core.snapshot().instances[0].status, 'ready')
})

test('a completed filename commit wins a late shutdown signal and never reverses the file', async t => {
  let stop = () => {}
  const f = await fixture(t, { modToggleCommitter: async (...args) => {
    const result = await commitModToggle(...args)
    stop()
    return result
  } })
  stop = () => f.core.cancelPendingOperations()
  const input = await addLocal(f), id = f.instances[0].id
  const preview = await f.core.prepareModToggle(id, input, false)
  const result = await f.core.setModEnabled(id, preview.token)
  assert.equal(result.enabled, false)
  assert.deepEqual(await fs.readdir(f.mods()), ['local.jar.disabled'])
  assert.deepEqual(await fs.readdir(f.directory()), ['game'])
  assert.equal(f.core.snapshot().instances[0].status, 'ready')
})
