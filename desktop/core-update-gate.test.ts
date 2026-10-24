import assert from 'node:assert/strict'
import type { ChildProcess, spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test, { type TestContext } from 'node:test'
import { LauncherCore, type Instance, type LaunchAccount } from './core'

type Options = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(condition: () => boolean) {
  for (let index = 0; index < 2000; index++) {
    if (condition()) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.fail('fixture did not reach the expected async boundary')
}
async function fixture(t: TestContext, options: Options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-update-gate-'))
  const instances: Instance[] = [0, 1].map(index => ({ id: randomUUID(), name: `Update fixture ${index}`, version: '1.20.1',
    loader: 'fabric', loaderVersion: '0.16.10', status: 'ready', createdAt: '2026-10-24T00:00:00Z', playtimeMs: 0 }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances,
    settings: { memoryMode: 'auto', memoryMb: 4096, javaPath: '', concurrentDownloads: 4 } }))
  for (const instance of instances) await fs.mkdir(path.join(root, 'instances', instance.id, 'game'), { recursive: true })
  const requests: string[] = []
  const core = new LauncherCore(root, undefined, {
    platform: 'linux', arch: 'x64',
    fetch: async input => { requests.push(String(input)); throw new Error('No real network in update-gate tests') },
    spawn: (() => { throw new Error('No real Java/game in update-gate tests') }) as Options['spawn'],
    javaRuntimeManager: { ensure: async () => { throw new Error('No Java provisioning in update-gate tests') }, discover: async () => [] },
    ...options,
  })
  await core.init()
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  return { core, root, requests, id: (index = 0) => instances[index].id }
}
const account: LaunchAccount = { mode: 'microsoft', username: 'UpdateFixture', uuid: '0123456789abcdef0123456789abcdef', accessToken: 'inert-unit-test-token' }
const selection = { name: 'Original tree', itemId: `worlds:${createHash('sha256').update('Original tree').digest('hex')}` }

test('update reservation is exclusive, releases idempotently and does not block snapshot reads', async t => {
  const f = await fixture(t)
  const notInitialized = new LauncherCore(path.join(f.root, 'uninitialized'))
  assert.throws(() => notInitialized.reserveLauncherUpdate(), /等待/)
  const release = f.core.reserveLauncherUpdate()
  t.after(release)
  assert.throws(() => f.core.reserveLauncherUpdate(), /更新/)
  assert.equal(f.core.snapshot().instances.length, 2)
  assert.equal(f.core.instanceOptions(f.id()).values.memoryMb, 4096)
  assert.throws(() => f.core.assertLaunchAvailable(f.id()), /更新/)
  assert.throws(() => f.core.removableInstancePath(f.id()), /更新/)
  release(); release()
  const next = f.core.reserveLauncherUpdate()
  // Releasing an old lease again must not release a later reservation.
  release()
  assert.throws(() => f.core.startJavaInstall(17), /更新/)
  next()
  await f.core.updateSettings({ memoryMb: 6144 })
  assert.equal(f.core.snapshot().settings.memoryMb, 6144)
})

test('reserved update rejects every public write/start entry before network or filesystem changes', async t => {
  const f = await fixture(t)
  const before = await fs.readFile(path.join(f.root, 'launcher.json'))
  const release = f.core.reserveLauncherUpdate()
  t.after(release)
  const operations = [
    () => f.core.createInstance({ name: 'New', version: '1.20.1', loader: 'vanilla' }),
    () => f.core.install(f.id()),
    () => f.core.installMod(f.id(), 'inert-version'),
    () => f.core.installModpack('inert-version'),
    () => f.core.importModpack(path.join(f.root, 'absent.mrpack')),
    () => f.core.importWorldZip(f.id(), path.join(f.root, 'absent.zip')),
    () => f.core.restoreWorldBackup(f.id(), f.id(1), randomUUID()),
    () => f.core.backupWorld(f.id(), selection, { operationId: randomUUID(), closedExternalWorldConfirmed: true }),
    () => f.core.exportWorldBackup(f.id(), randomUUID(), randomUUID()),
    () => f.core.installResource(f.id(), {}, randomUUID()),
    () => f.core.prepareModToggle(f.id(), {}, false),
    () => f.core.setModEnabled(f.id(), 'missing'),
    () => f.core.updateInstanceSettings(f.id(), { name: 'Changed', options: {} }),
    () => f.core.updateSettings({ memoryMb: 6144 }),
    () => f.core.duplicateInstance(f.id(), 'Copy'),
    () => f.core.forgetInstance(f.id()),
    () => f.core.archiveInstanceFolder(f.id()),
    () => f.core.launch(f.id(), account),
    () => f.core.assertInstanceUsable(f.id()),
    () => f.core.managedJava(),
    () => f.core.runtimeRequirement(f.id()),
    () => f.core.detectJava(),
  ]
  for (const operation of operations) await assert.rejects(operation(), /更新/)
  assert.throws(() => f.core.startJavaInstall(17), /更新/)
  assert.deepEqual(f.requests, [])
  assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), before)
  assert.deepEqual((await fs.readdir(path.join(f.root, 'instances'))).sort(), [f.id(), f.id(1)].sort())
})

test('queued configuration writes block update immediately and through each worker settlement', async t => {
  let gateEnabled = false
  const gates: ReturnType<typeof deferred<void>>[] = []
  const f = await fixture(t, { stateRename: async (from, to) => {
    if (gateEnabled) { const gate = deferred(); gates.push(gate); await gate.promise }
    return fs.rename(from, to)
  } })
  gateEnabled = true
  const first = f.core.updateSettings({ memoryMb: 6144 })
  const second = f.core.updateSettings({ concurrentDownloads: 6 })
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  await until(() => gates.length === 1)
  gates[0].resolve()
  await first
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  await until(() => gates.length === 2)
  gates[1].resolve()
  await second
  f.core.reserveLauncherUpdate()()
  assert.equal(f.core.snapshot().settings.concurrentDownloads, 6)
})

test('failed queued save releases its update barrier only after the worker rejects', async t => {
  let fail = false
  const gate = deferred(), entered = deferred()
  const f = await fixture(t, { stateRename: async (from, to) => {
    if (fail) { entered.resolve(); await gate.promise; throw new Error('injected state rename failure') }
    return fs.rename(from, to)
  } })
  fail = true
  const pending = f.core.updateSettings({ memoryMb: 6144 }), rejected = assert.rejects(pending, /injected/)
  await entered.promise
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  gate.resolve(); await rejected
  assert.equal(f.core.snapshot().settings.memoryMb, 4096)
  f.core.reserveLauncherUpdate()()
})

test('create/import metadata waits are reserved before the first await, including failure cleanup', async t => {
  const response = deferred<Response>(), entered = deferred()
  const f = await fixture(t, { fetch: async () => { entered.resolve(); return response.promise } })
  const pending = f.core.createInstance({ name: 'Created after metadata', version: '1.20.1', loader: 'vanilla' })
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  await entered.promise
  response.resolve(new Response(JSON.stringify({ versions: [{ id: '1.20.1', type: 'release', releaseTime: '2023-06-12T00:00:00Z' }] })))
  await pending
  f.core.reserveLauncherUpdate()()
  const imported = f.core.importModpack(path.join(f.root, 'missing.mrpack'))
  const rejected = assert.rejects(imported)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  await rejected
  f.core.reserveLauncherUpdate()()
})

test('Java task return and cancellation do not release update exclusion before ensure settles', async t => {
  const work = deferred<never>(), entered = deferred()
  let signal: AbortSignal | undefined
  const f = await fixture(t, { javaRuntimeManager: {
    discover: async () => [],
    ensure: async (_request, options) => { signal = options?.signal; entered.resolve(); return work.promise },
  } })
  const task = f.core.startJavaInstall(17)
  await entered.promise
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  f.core.cancelJavaInstall(task.id)
  assert.equal(signal?.aborted, true)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  work.reject(new DOMException('fixture cancellation', 'AbortError'))
  await until(() => f.core.runtimeTasks()[0].status === 'cancelled')
  f.core.reserveLauncherUpdate()()
  // Finished history is not an active task and must not block every future update.
  assert.equal(f.core.runtimeTasks().length, 1)
})

test('runtime requirement metadata download holds update exclusion before reading or caching files', async t => {
  const version = JSON.stringify({ javaVersion: { majorVersion: 17, component: 'java-runtime-gamma' } })
  const url = 'https://piston-data.mojang.com/update-gate/version.json'
  const entered = deferred(), response = deferred<Response>()
  const f = await fixture(t, { fetch: async input => {
    if (String(input) === 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json') {
      return new Response(JSON.stringify({ versions: [{ id: '1.20.1', type: 'release', url,
        sha1: createHash('sha1').update(version).digest('hex'), size: Buffer.byteLength(version) }] }))
    }
    assert.equal(String(input), url)
    entered.resolve()
    return response.promise
  } })
  const pending = f.core.runtimeRequirement(f.id())
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  await entered.promise
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  response.resolve(new Response(version))
  assert.equal((await pending).major, 17)
  assert.equal(await fs.readFile(path.join(f.root, 'versions', '1.20.1', '1.20.1.json'), 'utf8'), version)
  f.core.reserveLauncherUpdate()()
})

test('global update reservation sees a backup in another instance until cancelled worker settles', async t => {
  const work = deferred<never>(), entered = deferred()
  const f = await fixture(t, { worldBackupCreator: async () => { entered.resolve(); return work.promise } })
  const operationId = randomUUID()
  const pending = f.core.backupWorld(f.id(1), selection, { operationId, closedExternalWorldConfirmed: true })
  const rejected = assert.rejects(pending, /取消/)
  await entered.promise
  assert.equal(f.core.snapshot().instances.find(item => item.id === f.id())?.status, 'ready')
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  f.core.cancelWorldBackup(f.id(1), operationId)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  work.reject(new DOMException('fixture cancellation', 'AbortError')); await rejected
  f.core.reserveLauncherUpdate()()
})

test('ZIP export outside the instance install map still excludes update through cancellation', async t => {
  const work = deferred<never>(), entered = deferred()
  const f = await fixture(t, { worldZipExporter: async () => { entered.resolve(); return work.promise } })
  const operationId = randomUUID()
  const pending = f.core.exportWorldBackup(f.id(), randomUUID(), operationId)
  const rejected = assert.rejects(pending, /取消/)
  await entered.promise
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  f.core.cancelWorldExport(f.id(), operationId)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  work.reject(new DOMException('fixture cancellation', 'AbortError')); await rejected
  f.core.reserveLauncherUpdate()()
})

test('running fake game and its post-exit diagnostics/write are busy until all workers finish', async t => {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcess
  const fakeSpawn = (() => { queueMicrotask(() => child.emit('spawn')); return child }) as typeof spawn
  const f = await fixture(t, { spawn: fakeSpawn, memorySystem: { totalmem: () => 16 * 1024 ** 3, freemem: () => 12 * 1024 ** 3 } })
  const runtime = { path: '/inert/java', major: 17, version: '17.0.12', arch: 'x64' }
  f.core.detectJava = async () => [runtime]
  await fs.writeFile(path.join(f.root, 'instances', f.id(), 'installed.json'), JSON.stringify({
    schema: 1, platform: 'linux', arch: 'x64', classpath: [], mainClass: 'inert.Main', fabricArguments: { jvm: [], game: [] },
    version: { id: '1.20.1', type: 'release', javaVersion: { majorVersion: 17, component: 'java-runtime-gamma' },
      assetIndex: { id: 'fixture' }, arguments: { jvm: [], game: [] }, libraries: [] },
  }))
  const diagnostics = deferred<undefined>(), diagnosticsStarted = deferred()
  // A diagnostic reader substitute, never actual game output or user data.
  Object.assign(f.core, { crashReport: async () => { diagnosticsStarted.resolve(); return diagnostics.promise } })
  await f.core.launch(f.id(), account)
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  child.emit('close', 1, null)
  await diagnosticsStarted.promise
  await f.core.updateSettings({}) // Queue behind the close listener's real save.
  assert.equal(f.core.snapshot().instances[0].status, 'ready')
  assert.throws(() => f.core.reserveLauncherUpdate(), /等待/)
  diagnostics.resolve(undefined)
  await until(() => {
    try { f.core.reserveLauncherUpdate()(); return true } catch { return false }
  })
})
