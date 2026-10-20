import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { LauncherCore, type CoreEvent, type Instance, type LaunchAccount } from './core'
import type { WorldBackupList, WorldBackupResult } from './world-backup-types'
import type { WorldSelection } from './world-types'
import type { ResourceInventory } from './resource-inventory'
import type { WorldRead } from './world-details'
import { WorldBackupError } from './world-backup'

type Options = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
type Creator = NonNullable<Options['worldBackupCreator']>
type CreatorOptions = Parameters<Creator>[2]
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const selection = (name = 'Original Fixture'): WorldSelection => ({ name, itemId: `worlds:${digest(name)}` })
const confirmation = (operationId = randomUUID()) => ({ operationId, closedExternalWorldConfirmed: true })
const credentials: LaunchAccount = { mode: 'microsoft', username: 'TestOnly', uuid: '0123456789abcdef0123456789abcdef', accessToken: 'not-a-real-credential' }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function result(input: WorldSelection, instanceId: string): WorldBackupResult {
  return { backupId: randomUUID(), instanceId, worldItemId: input.itemId, worldFolderName: input.name,
    format: 'directory', createdAt: '2026-10-21T00:00:00.000Z', completedAt: '2026-10-21T00:00:01.000Z',
    fileCount: 1, directoryCount: 1, totalBytes: 7, verifiedAtCompletion: true, warnings: [] }
}
function creatorGate() {
  const calls: Array<{ directory: string; selection: WorldSelection; options: CreatorOptions; release: ReturnType<typeof deferred<WorldBackupResult>> }> = []
  const waiters = new Set<{ count: number; ready: ReturnType<typeof deferred<void>> }>()
  const create: Creator = async (directory, input, options) => {
    const release = deferred<WorldBackupResult>()
    calls.push({ directory, selection: input, options, release })
    for (const waiter of waiters) if (calls.length >= waiter.count) waiter.ready.resolve()
    return release.promise
  }
  async function waitForCalls(count: number) {
    if (calls.length >= count) return
    const waiter = { count, ready: deferred() }; waiters.add(waiter)
    const timer = setTimeout(() => waiter.ready.reject(new Error(`Backup worker expected ${count} entries, observed ${calls.length}`)), 10_000)
    try { await waiter.ready.promise } finally { clearTimeout(timer); waiters.delete(waiter) }
  }
  const complete = (index = 0) => {
    const call = calls[index]; const completed = result(call.selection, call.options.instanceId)
    call.release.resolve(completed); return completed
  }
  return { calls, create, waitForCalls, complete }
}
async function fixture(t: TestContext, options: Options = {}, patch: Partial<Instance> = {}, observe?: (event: CoreEvent) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-world-backup-'))
  const instances: Instance[] = Array.from({ length: 3 }, (_, index) => ({ id: randomUUID(), name: `Fixture ${index}`,
    version: '1.20.1', loader: 'fabric', loaderVersion: '0.19.5', status: 'ready',
    createdAt: '2026-10-21T00:00:00.000Z', playtimeMs: 0, ...patch }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances,
    settings: { memoryMode: 'auto', memoryMb: 4096, javaPath: '', concurrentDownloads: 4 } }))
  for (const instance of instances) {
    const game = path.join(root, 'instances', instance.id, 'game')
    await fs.mkdir(path.join(game, 'mods'), { recursive: true })
    await fs.mkdir(path.join(game, 'saves', selection().name), { recursive: true })
  }
  const requests: string[] = [], events: CoreEvent[] = []
  const core = new LauncherCore(root, event => { events.push(event); observe?.(event) }, {
    fetch: async input => { requests.push(String(input)); throw new Error('No network allowed in world-backup tests') },
    spawn: (() => { throw new Error('Never execute Java or a game in this suite') }) as Options['spawn'],
    javaRuntimeManager: { ensure: async () => { throw new Error('No Java preparation') }, discover: async () => [] },
    ...options,
  })
  await core.init()
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  const id = (index = 0) => instances[index].id
  const directory = (index = 0) => core.instanceDirectory(id(index))
  const world = (index = 0) => path.join(directory(index), 'game', 'saves', selection().name)
  const backup = (index = 0, operationId = randomUUID()) => core.backupWorld(id(index), selection(), confirmation(operationId))
  return { root, instances, core, requests, events, id, directory, world, backup }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function sourceSnapshot(directory: string): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = {}
  async function visit(relative: string) {
    const location = path.join(directory, relative), info = await fs.lstat(location, { bigint: true })
    output[relative] = { dev: String(info.dev), ino: String(info.ino), mode: String(info.mode),
      mtime: String(info.mtimeNs), ctime: String(info.ctimeNs), size: String(info.size),
      bytes: info.isFile() ? (await fs.readFile(location)).toString('hex') : undefined }
    if (info.isDirectory()) for (const name of (await fs.readdir(location)).sort()) await visit(path.join(relative, name))
  }
  await visit(''); return output
}
async function localMod(f: Fixture) {
  const name = 'fixture.jar', file = path.join(f.directory(), 'game', 'mods', name)
  await fs.writeFile(file, 'Original inert bytes, not a JAR archive')
  const info = await fs.stat(file)
  return { itemId: `mods:${digest(name)}`, name, sizeBytes: info.size, modifiedAt: new Date(info.mtimeMs).toISOString() }
}
const resourceSelection = { kind: 'resourcepack', source: 'modrinth', projectId: 'projectA', versionId: 'versionA',
  filename: 'fixture.zip', sha512: 'a'.repeat(128) }
const emptyInventory = (): ResourceInventory => ({ kind: 'worlds', observedAt: new Date().toISOString(), items: [], warnings: [], truncated: false })
const readResult = (): WorldRead => ({ details: { itemId: selection().itemId, folderName: selection().name,
  source: 'level.dat', observedAt: new Date().toISOString(), status: 'partial', metadata: {}, fieldWarnings: [], warnings: [], seedAvailable: true }, revisionKey: 'private-fixture-proof' })

test('production default backup copies an entire original inert tree and exposes only completed summaries without source or state changes', async t => {
  const f = await fixture(t), originalState = await fs.readFile(path.join(f.root, 'launcher.json'))
  await fs.mkdir(path.join(f.world(), 'region'), { recursive: true })
  await fs.mkdir(path.join(f.world(), 'data', 'empty'), { recursive: true })
  const files = new Map([['level.dat', Buffer.from('Not NBT; backup must preserve arbitrary bytes')],
    ['session.lock', Buffer.from([0, 1, 2, 255])], ['.hidden', Buffer.from('private fixture')],
    ['region/r.0.0.mca', Buffer.alloc(131079, 29)], ['COMPLETE.json', Buffer.from('world-owned control-looking filename')]])
  for (const [name, bytes] of files) await fs.writeFile(path.join(f.world(), name), bytes)
  const before = await sourceSnapshot(f.world()), beforeSnapshot = f.core.snapshot()
  f.events.length = 0
  const completed = await f.backup()
  assert.equal(completed.format, 'directory'); assert.equal(completed.verifiedAtCompletion, true)
  assert.equal(completed.instanceId, f.id()); assert.equal(completed.worldItemId, selection().itemId)
  assert.equal(completed.fileCount, files.size)
  assert.equal(completed.totalBytes, [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0))
  const container = path.join(f.root, 'backups', 'worlds', f.id(), completed.backupId)
  for (const [name, bytes] of files) assert.deepEqual(await fs.readFile(path.join(container, 'world', name)), bytes)
  assert.equal((await fs.stat(path.join(container, 'world', 'data', 'empty'))).isDirectory(), true)
  const listed = await f.core.worldBackups(f.id())
  assert.equal(listed.items.length, 1); assert.equal(listed.incompleteCount, 0)
  assert.equal(listed.items[0].backupId, completed.backupId)
  assert.equal(listed.items[0].verifiedAtCompletion, true)
  assert.equal(await f.core.worldBackupPath(f.id(), completed.backupId), container)
  await assert.rejects(f.core.worldBackupPath(f.id(1), completed.backupId))
  assert.deepEqual(await sourceSnapshot(f.world()), before)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), originalState)
  assert.deepEqual(f.core.snapshot(), beforeSnapshot); assert.deepEqual(f.requests, [])
  assert.ok(f.events.length > 0); assert.ok(f.events.every(event => event.type === 'worldBackupTask'))
  assert.equal(JSON.stringify({ completed, listed, tasks: f.core.worldBackupTasks() }).includes(f.root), false)
})

test('error and uninstalled instances can back up without recovery cleanup, state persistence or interpreting malformed world bytes', async t => {
  for (const status of ['error', 'not-installed'] as const) {
    let armed = false, recoveryCalls = 0
    const f = await fixture(t, { modToggleRecovery: async () => { recoveryCalls++; if (armed) throw new Error('Backup must not inspect journals'); return { blocked: false, warnings: [] } },
      stateRename: async (from, to) => { if (armed) throw new Error('Backup must not persist instance state'); return fs.rename(from, to) } }, { status, ...(status === 'error' ? { error: 'Existing unrelated fixture error' } : {}) })
    const marker = path.join(f.directory(), '.mod-toggle-' + randomUUID())
    await fs.mkdir(marker); await fs.writeFile(path.join(marker, 'intent.json'), 'Keep this ambiguous source evidence')
    await fs.writeFile(path.join(f.world(), 'level.dat'), 'malformed fixture; no NBT parsing allowed')
    const before = await sourceSnapshot(f.directory()), state = await fs.readFile(path.join(f.root, 'launcher.json'))
    const callsBefore = recoveryCalls; armed = true; f.events.length = 0
    const backup = await f.backup()
    assert.equal(backup.verifiedAtCompletion, true); assert.equal(recoveryCalls, callsBefore)
    assert.deepEqual(await sourceSnapshot(f.directory()), before)
    assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), state)
    assert.equal(f.core.snapshot().instances[0].status, status)
    assert.ok(f.events.every(event => event.type === 'worldBackupTask'))
  }
})

test('invalid selections, confirmation, operation IDs and unknown/accessor fields fail before worker entry', async t => {
  let calls = 0, getters = 0
  const f = await fixture(t, { worldBackupCreator: async (_directory, input, options) => { calls++; return result(input, options.instanceId) } })
  await assert.rejects(f.core.backupWorld('../bad', selection(), confirmation()))
  for (const input of [null, [], { ...selection(), path: '/outside' }, selection('../escape'), selection('NUL'),
    { ...selection(), itemId: 'worlds:wrong' }, Object.create(selection())]) {
    await assert.rejects(f.core.backupWorld(f.id(), input, confirmation()))
  }
  const accessor = Object.defineProperty({ operationId: randomUUID() }, 'closedExternalWorldConfirmed', { enumerable: true, get() { getters++; return true } })
  for (const input of [null, [], {}, { operationId: randomUUID() }, { ...confirmation(), closedExternalWorldConfirmed: false },
    { ...confirmation(), closedExternalWorldConfirmed: 'true' }, { ...confirmation(), operationId: '../outside' },
    { ...confirmation(), operationId: randomUUID().toUpperCase() }, { ...confirmation(), backupRoot: '/outside' }, accessor]) {
    await assert.rejects(f.core.backupWorld(f.id(), selection(), input))
  }
  assert.equal(calls, 0); assert.equal(getters, 0); assert.deepEqual(f.core.worldBackupTasks(), [])
  assert.equal((await fs.readdir(f.root)).includes('backups'), false)
})

test('backup reserves its instance before the first await and blocks every write/launch entry before credentials or network', async t => {
  const gate = creatorGate(), f = await fixture(t, { worldBackupCreator: gate.create })
  const mod = await localMod(f), prepared = await f.core.prepareModToggle(f.id(), mod, false)
  const pending = f.backup(), rejects = [
    f.core.install(f.id()), f.core.installMod(f.id(), 'versionA'),
    f.core.installResource(f.id(), resourceSelection, randomUUID()),
    f.core.updateInstanceSettings(f.id(), { name: 'Changed', options: {} }),
    f.core.prepareModToggle(f.id(), mod, false), f.core.setModEnabled(f.id(), prepared.token),
    f.core.launch(f.id(), credentials), f.core.inventory(f.id(), 'worlds'),
    f.core.worldDetails(f.id(), selection()),
  ].map(promise => assert.rejects(promise))
  let credentialCalls = 0
  assert.throws(() => { f.core.assertLaunchAvailable(f.id()); credentialCalls++ })
  assert.equal(credentialCalls, 0); assert.deepEqual(f.requests, [])
  await Promise.all(rejects); await gate.waitForCalls(1)
  assert.equal(gate.calls[0].directory, f.directory())
  assert.equal(gate.calls[0].options.backupRoot, path.join(f.root, 'backups', 'worlds'))
  gate.complete(); await pending
  assert.doesNotThrow(() => f.core.assertLaunchAvailable(f.id()))
})

test('existing install, resource, mod-install, mod-toggle and launch reservations reject backup in the opposite direction', async t => {
  for (const operation of ['install', 'resource', 'mod-install', 'mod-toggle', 'launch'] as const) {
    let armed = false, backupCalls = 0
    const entered = deferred(), release = deferred<{ blocked: boolean; warnings: string[] }>()
    const f = await fixture(t, { modToggleRecovery: async () => {
      if (!armed) return { blocked: false, warnings: [] }; entered.resolve(); return release.promise
    }, worldBackupCreator: async (_directory, input, options) => { backupCalls++; return result(input, options.instanceId) } })
    const mod = await localMod(f), prepared = await f.core.prepareModToggle(f.id(), mod, false)
    armed = true
    const active = operation === 'install' ? f.core.install(f.id()) : operation === 'resource' ? f.core.installResource(f.id(), resourceSelection, randomUUID()) :
      operation === 'mod-install' ? f.core.installMod(f.id(), 'versionA') : operation === 'mod-toggle' ? f.core.setModEnabled(f.id(), prepared.token) : f.core.launch(f.id(), credentials)
    const stopped = assert.rejects(active)
    await assert.rejects(f.backup()); await entered.promise
    assert.equal(backupCalls, 0); assert.deepEqual(f.core.worldBackupTasks(), [])
    release.reject(new DOMException('Deliberate fixture stop before any network or Java', 'AbortError'))
    await stopped; assert.deepEqual(f.requests, [])
  }
})

test('pending settings persistence excludes backup and releases the reservation only after its worker settles', async t => {
  let armed = false, backups = 0
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { stateRename: async (from, to) => { if (armed) { entered.resolve(); await release.promise } return fs.rename(from, to) },
    worldBackupCreator: async (_directory, input, options) => { backups++; return result(input, options.instanceId) } })
  armed = true
  const saving = f.core.updateInstanceSettings(f.id(), { name: 'Saved', options: {} })
  await assert.rejects(f.backup()); await entered.promise; assert.equal(backups, 0)
  release.resolve(); await saving
  await f.backup(); assert.equal(backups, 1)
})

test('one global backup slot does not lock unrelated-instance settings and cannot be stolen by another operation ID', async t => {
  const gate = creatorGate(), f = await fixture(t, { worldBackupCreator: gate.create })
  const operationId = randomUUID(), pending = f.backup(0, operationId)
  await gate.waitForCalls(1)
  await assert.rejects(f.backup(1), /已有世界备份/)
  await f.core.updateInstanceSettings(f.id(1), { name: 'Other instance remains independent', options: {} })
  f.core.cancelWorldBackup(f.id(), randomUUID()); f.core.cancelWorldBackup(f.id(1), operationId)
  assert.equal(gate.calls[0].options.signal?.aborted, false)
  assert.throws(() => f.core.cancelInstall(f.id()), /备份/)
  gate.complete(); await pending
  const next = f.backup(1); await gate.waitForCalls(2); gate.complete(1); await next
})

test('exact cancellation retains both locks until an ignored-signal worker settles and never reuses its operation ID', async t => {
  const gate = creatorGate(), f = await fixture(t, { worldBackupCreator: gate.create }), operationId = randomUUID()
  const pending = f.backup(0, operationId), rejected = assert.rejects(pending, /取消/)
  await gate.waitForCalls(1)
  f.core.cancelWorldBackup(f.id(), operationId)
  assert.equal(gate.calls[0].options.signal?.aborted, true)
  assert.equal(f.core.worldBackupTasks()[0].status, 'cancelling')
  await assert.rejects(f.backup(1)); assert.throws(() => f.core.assertLaunchAvailable(f.id()))
  gate.calls[0].release.reject(new DOMException('not an exposed cancellation string', 'AbortError'))
  await rejected
  const task = f.core.worldBackupTasks()[0]
  assert.equal(task.status, 'cancelled'); assert.ok(task.finishedAt); assert.equal(task.result, undefined)
  assert.doesNotThrow(() => f.core.assertLaunchAvailable(f.id()))
  await assert.rejects(f.backup(1, operationId), /已提交/)
  const retry = f.backup(1); await gate.waitForCalls(2); gate.complete(1); await retry
})

test('shutdown signals the actual backup worker and does not release its global or instance lock early', async t => {
  const gate = creatorGate(), f = await fixture(t, { worldBackupCreator: gate.create })
  const pending = f.backup(), rejected = assert.rejects(pending, /取消/)
  await gate.waitForCalls(1); f.core.cancelPendingOperations()
  assert.equal(gate.calls[0].options.signal?.aborted, true)
  await assert.rejects(f.backup(1)); assert.throws(() => f.core.assertLaunchAvailable(f.id()))
  gate.calls[0].release.reject(new DOMException('shutdown fixture', 'AbortError')); await rejected
  assert.equal(f.core.worldBackupTasks()[0].status, 'cancelled')
  assert.doesNotThrow(() => f.core.assertLaunchAvailable(f.id()))
})

test('module success after the commit boundary wins late cancellation and throwing event observers', async t => {
  const gate = creatorGate()
  const f = await fixture(t, { worldBackupCreator: gate.create }, {}, event => {
    if (event.type === 'worldBackupTask') throw new Error('Observer failure must not rewrite committed bytes')
  })
  const operationId = randomUUID(), pending = f.backup(0, operationId)
  await gate.waitForCalls(1)
  gate.calls[0].options.onProgress?.({ phase: 'copy', filesDone: 0, filesTotal: 1, bytesDone: 3, bytesTotal: 7 })
  f.core.cancelWorldBackup(f.id(), operationId)
  const completed = gate.complete(); assert.deepEqual(await pending, completed)
  const task = f.core.worldBackupTasks()[0]
  assert.equal(task.status, 'complete'); assert.equal(task.result?.backupId, completed.backupId)
  assert.ok(task.finishedAt); assert.equal(task.error, undefined)
  assert.doesNotThrow(() => f.core.assertLaunchAvailable(f.id()))
})

test('unexpected backup failures are sanitized, preserve source status and state, and leave retries available with a new ID', async t => {
  const gate = creatorGate(), f = await fixture(t, { worldBackupCreator: gate.create })
  const state = await fs.readFile(path.join(f.root, 'launcher.json')), snapshot = f.core.snapshot(), operationId = randomUUID()
  f.events.length = 0
  const pending = f.backup(0, operationId)
  const rejected = assert.rejects(pending, error => error instanceof Error && !/SECRET|\/private\//.test(error.message))
  await gate.waitForCalls(1); gate.calls[0].release.reject(new Error('/private/user/world/SECRET.raw NBT=SECRET'))
  await rejected
  assert.equal(f.core.worldBackupTasks()[0].status, 'error')
  assert.equal(JSON.stringify(f.core.worldBackupTasks()).includes('SECRET'), false)
  assert.deepEqual(f.core.snapshot(), snapshot); assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), state)
  assert.ok(f.events.every(event => event.type === 'worldBackupTask'))
  await assert.rejects(f.backup(0, operationId), /已提交/)
  const retry = f.backup(); await gate.waitForCalls(2); gate.complete(1); await retry
})

test('task progress, return values and queried history do not share mutable objects with observers or workers', async t => {
  const gate = creatorGate(), f = await fixture(t, { worldBackupCreator: gate.create })
  const pending = f.backup(); await gate.waitForCalls(1)
  const progress = { phase: 'copy' as const, filesDone: 1, filesTotal: 2, bytesDone: 7, bytesTotal: 20 }
  gate.calls[0].options.onProgress?.(progress); progress.bytesDone = 999
  const event = f.events.filter((value): value is Extract<CoreEvent, { type: 'worldBackupTask' }> => value.type === 'worldBackupTask').at(-1)!
  event.task.progress.bytesDone = 888
  const queried = f.core.worldBackupTasks(); queried[0].progress.bytesDone = 777
  assert.equal(f.core.worldBackupTasks()[0].progress.bytesDone, 7)
  const completed = gate.complete(), returned = await pending
  completed.warnings.push('Worker changed its copy'); returned.warnings.push('Caller changed its copy')
  assert.deepEqual(f.core.worldBackupTasks()[0].result?.warnings, [])
})

test('terminal task history is bounded while evicted operation IDs still cannot replay', async t => {
  const f = await fixture(t, { worldBackupCreator: async (_directory, input, options) => result(input, options.instanceId) })
  const operationIds = Array.from({ length: 35 }, () => randomUUID())
  for (const operationId of operationIds) await f.backup(0, operationId)
  const tasks = f.core.worldBackupTasks()
  assert.equal(tasks.length, 30); assert.equal(tasks[0].id, operationIds[5])
  await assert.rejects(f.backup(0, operationIds[0]), /已提交/)
})

test('list and path APIs bind the fixed backup root and instance, clone results and sanitize raw reader failures', async t => {
  const calls: unknown[][] = [], summaries: WorldBackupList = { items: [], incompleteCount: 3, warnings: ['Incomplete folders occupy disk space'], truncated: false }
  let fail = false
  const f = await fixture(t, { worldBackupLister: async (...args) => { calls.push(args); if (fail) throw new Error('/private/SECRET'); return summaries },
    worldBackupResolver: async (...args) => { calls.push(args); if (fail) throw new Error('/private/SECRET'); return path.join(args[0], args[1], args[2]) } })
  const before = f.core.snapshot(), listed = await f.core.worldBackups(f.id())
  listed.warnings.push('Caller edit'); assert.equal(summaries.warnings.length, 1)
  assert.deepEqual(calls[0], [path.join(f.root, 'backups', 'worlds'), f.id()])
  const backupId = randomUUID()
  assert.equal(await f.core.worldBackupPath(f.id(), backupId), path.join(f.root, 'backups', 'worlds', f.id(), backupId))
  const count = calls.length
  await assert.rejects(f.core.worldBackupPath(f.id(), '../outside'))
  await assert.rejects(f.core.worldBackups('../outside')); assert.equal(calls.length, count)
  fail = true
  for (const promise of [f.core.worldBackups(f.id()), f.core.worldBackupPath(f.id(), backupId)]) {
    await assert.rejects(promise, error => error instanceof Error && !error.message.includes('SECRET'))
  }
  assert.deepEqual(f.core.snapshot(), before); assert.deepEqual(f.requests, [])
})

test('a complete backup cycle invalidates prior world revisions and late reads/scans even after its lock is gone', async t => {
  const readGate = deferred<WorldRead>(), inventoryGate = deferred<ResourceInventory>()
  const readEntered = deferred(), inventoryEntered = deferred()
  let reads = 0
  const gate = creatorGate(), f = await fixture(t, { worldBackupCreator: gate.create,
    worldDetailsReader: async () => { if (++reads === 1) return readResult(); readEntered.resolve(); return readGate.promise },
    inventoryScanner: async () => { inventoryEntered.resolve(); return inventoryGate.promise } })
  const old = await f.core.worldDetails(f.id(), selection())
  const reading = f.core.worldDetails(f.id(), selection()), scanning = f.core.inventory(f.id(), 'worlds')
  const readRejected = assert.rejects(reading), scanRejected = assert.rejects(scanning)
  await Promise.all([readEntered.promise, inventoryEntered.promise])
  const backup = f.backup(); await gate.waitForCalls(1); gate.complete(); await backup
  readGate.resolve(readResult()); inventoryGate.resolve(emptyInventory())
  await Promise.all([readRejected, scanRejected])
  const callsBefore = reads
  await assert.rejects(f.core.worldDetailsWithSeed(f.id(), old.revision!), /过期/)
  assert.equal(reads, callsBefore)
})

test('backup invalidates a previously prepared mod confirmation without touching the mod file', async t => {
  const f = await fixture(t, { worldBackupCreator: async (_directory, input, options) => result(input, options.instanceId) })
  const mod = await localMod(f), preview = await f.core.prepareModToggle(f.id(), mod, false)
  const before = await sourceSnapshot(path.join(f.directory(), 'game', 'mods'))
  await f.backup()
  await assert.rejects(f.core.setModEnabled(f.id(), preview.token), /过期/)
  assert.deepEqual(await sourceSnapshot(path.join(f.directory(), 'game', 'mods')), before)
})

test('production cancellation preserves the entire unfinished container and lists its disk-space warning without touching source', async t => {
  let f!: Fixture, cancelled = false
  const operationId = randomUUID()
  f = await fixture(t, {}, {}, event => {
    if (event.type === 'worldBackupTask' && event.task.status === 'active' && event.task.progress.phase === 'copy' && event.task.progress.bytesDone > 0 && !cancelled) {
      cancelled = true; f.core.cancelWorldBackup(f.id(), operationId)
    }
  })
  await fs.writeFile(path.join(f.world(), 'region.bin'), Buffer.alloc(2 * 1024 * 1024 + 7, 83))
  const before = await sourceSnapshot(f.world()), state = await fs.readFile(path.join(f.root, 'launcher.json'))
  await assert.rejects(f.backup(0, operationId), /取消/)
  assert.equal(cancelled, true); assert.equal(f.core.worldBackupTasks()[0].status, 'cancelled')
  const parent = path.join(f.root, 'backups', 'worlds', f.id()), containers = await fs.readdir(parent)
  assert.equal(containers.length, 1)
  const retained = path.join(parent, containers[0]), retainedSnapshot = await sourceSnapshot(retained)
  assert.equal((await fs.stat(path.join(retained, 'world', 'region.bin'))).size > 0, true)
  await assert.rejects(fs.lstat(path.join(retained, 'COMPLETE.json')), { code: 'ENOENT' })
  const listed = await f.core.worldBackups(f.id())
  assert.deepEqual(listed.items, []); assert.equal(listed.incompleteCount, 1)
  assert.match(listed.warnings.join(' '), /空间.*不会自动删除/)
  await assert.rejects(f.core.worldBackupPath(f.id(), containers[0]))
  assert.deepEqual(await sourceSnapshot(retained), retainedSnapshot)
  assert.deepEqual(await sourceSnapshot(f.world()), before)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), state)
  assert.doesNotThrow(() => f.core.assertLaunchAvailable(f.id()))
})

test('an ambiguous commit remains an error despite cancellation and cannot be presented as harmless cancelled work', async t => {
  const gate = creatorGate(), f = await fixture(t, { worldBackupCreator: gate.create }), operationId = randomUUID()
  const pending = f.backup(0, operationId), rejected = assert.rejects(pending, /确认|检查/)
  await gate.waitForCalls(1); f.core.cancelWorldBackup(f.id(), operationId)
  gate.calls[0].release.reject(new WorldBackupError('RECOVERY_REQUIRED', randomUUID()))
  await rejected
  const task = f.core.worldBackupTasks()[0]
  assert.equal(task.status, 'error'); assert.equal(task.result, undefined)
  assert.match(task.error!, /确认|检查/)
  assert.doesNotThrow(() => f.core.assertLaunchAvailable(f.id()))
})

test('list entries are historical completion evidence rather than a new hash of changed backup payloads', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.world(), 'data.bin'), 'Original synthetic bytes')
  const completed = await f.backup(), container = await f.core.worldBackupPath(f.id(), completed.backupId)
  await fs.writeFile(path.join(container, 'world', 'data.bin'), 'Explicit later fixture edit')
  const listed = await f.core.worldBackups(f.id())
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].verifiedAtCompletion, true)
  assert.match(listed.warnings.join(' '), /未重新校验/)
  assert.equal(await fs.readFile(path.join(f.world(), 'data.bin'), 'utf8'), 'Original synthetic bytes')
})
