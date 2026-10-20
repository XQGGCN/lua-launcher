import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { gzipSync } from 'node:zlib'
import { LauncherCore, type CoreEvent, type Instance } from './core'
import type { WorldRead, WorldReadOptions } from './world-details'
import type { WorldSelection, WorldSource } from './world-types'

type Options = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const selection = (name = 'Fixture World'): WorldSelection => ({
  itemId: 'worlds:' + createHash('sha256').update(name).digest('hex'), name,
})
function readResult(input = selection(), source: WorldSource = 'level.dat', revisionKey = 'private-proof'): WorldRead {
  return { details: { itemId: input.itemId, folderName: input.name, source, observedAt: '2026-10-21T00:00:00.000Z',
    status: 'ok', metadata: { levelName: 'Fixture metadata', gameMode: { raw: 1, label: '创造' } },
    fieldWarnings: [], warnings: [], seedAvailable: true }, revisionKey }
}
function readerGate() {
  const calls: Array<{ directory: string; selection: WorldSelection; options: WorldReadOptions; release: ReturnType<typeof deferred<WorldRead>> }> = []
  const waiters = new Set<{ count: number; ready: ReturnType<typeof deferred<void>> }>()
  async function waitForCalls(count: number) {
    if (calls.length >= count) return
    const waiter = { count, ready: deferred() }
    waiters.add(waiter)
    const timer = setTimeout(() => waiter.ready.reject(new Error(`World reader expected ${count} entries, observed ${calls.length}`)), 10_000)
    try { await waiter.ready.promise } finally { clearTimeout(timer); waiters.delete(waiter) }
  }
  const read: NonNullable<Options['worldDetailsReader']> = async (directory, input, options = {}) => {
    const release = deferred<WorldRead>()
    calls.push({ directory, selection: input, options, release })
    for (const waiter of waiters) if (calls.length >= waiter.count) waiter.ready.resolve()
    return release.promise
  }
  return { calls, read, waitForCalls }
}
async function fixture(t: TestContext, options: Options = {}, patch: Partial<Instance> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-world-details-'))
  const instances: Instance[] = Array.from({ length: 3 }, (_, index) => ({ id: randomUUID(), name: `Fixture ${index}`,
    version: '1.20.1', loader: 'vanilla', status: 'ready', createdAt: '2026-10-21T00:00:00.000Z', playtimeMs: 0, ...patch }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances,
    settings: { memoryMode: 'auto', memoryMb: 4096, javaPath: '', concurrentDownloads: 4 } }))
  for (const item of instances) await fs.mkdir(path.join(root, 'instances', item.id, 'game', 'saves'), { recursive: true })
  const requests: string[] = [], events: CoreEvent[] = []
  const core = new LauncherCore(root, event => events.push(event), {
    fetch: async input => { requests.push(String(input)); throw new Error('Unexpected network in world-details test') },
    spawn: (() => { throw new Error('Never execute Java or a game in these tests') }) as Options['spawn'],
    javaRuntimeManager: { ensure: async () => { throw new Error('Never prepare Java in these tests') }, discover: async () => [] },
    ...options,
  })
  await core.init()
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  const id = (index = 0) => instances[index].id
  const directory = (index = 0) => core.instanceDirectory(id(index))
  const world = (input = selection(), index = 0) => path.join(directory(index), 'game', 'saves', input.name)
  return { root, core, instances, requests, events, id, directory, world }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
// Original tiny NBT fixtures, not Minecraft-generated worlds. All strings here
// use BMP characters for which UTF-8 and canonical MUTF-8 have the same bytes.
function stringPayload(value: string) {
  const bytes = Buffer.from(value), size = Buffer.alloc(2)
  size.writeUInt16BE(bytes.length)
  return Buffer.concat([size, bytes])
}
function named(type: number, name: string, bytes: Buffer) { return Buffer.concat([Buffer.from([type]), stringPayload(name), bytes]) }
function compound(name: string, ...children: Buffer[]) { return named(10, name, Buffer.concat([...children, Buffer.from([0])])) }
function stringTag(name: string, value: string) { return named(8, name, stringPayload(value)) }
function intTag(name: string, value: number) { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return named(3, name, bytes) }
function longTag(name: string, value: bigint) { const bytes = Buffer.alloc(8); bytes.writeBigInt64BE(value); return named(4, name, bytes) }
function byteTag(name: string, value: number) { const bytes = Buffer.alloc(1); bytes.writeInt8(value); return named(1, name, bytes) }
function worldBytes(name = '原创世界', seed: bigint | undefined = -9223372036854775808n) {
  return gzipSync(compound('', compound('Data', stringTag('LevelName', name), intTag('DataVersion', 3465),
    compound('Version', stringTag('Name', '1.20.1'), intTag('Id', 3465), byteTag('Snapshot', 0)),
    intTag('GameType', 0), byteTag('Difficulty', 2), byteTag('hardcore', 0), byteTag('allowCommands', 1),
    longTag('Time', 9223372036854775807n), longTag('DayTime', -24000n), longTag('LastPlayed', 0n),
    compound('Player', stringTag('PrivateFixture', 'DO-NOT-EXPOSE-PLAYER')),
    ...(seed === undefined ? [] : [compound('WorldGenSettings', longTag('seed', seed))]))))
}
async function addWorld(f: Fixture, bytes = worldBytes(), input = selection(), index = 0, source: WorldSource = 'level.dat') {
  await fs.mkdir(f.world(input, index), { recursive: true })
  const file = path.join(f.world(input, index), source)
  await fs.writeFile(file, bytes)
  return file
}

test('switching a world source prevents a late earlier read from issuing a usable revision', async t => {
  const gate = readerGate(), f = await fixture(t, { worldDetailsReader: gate.read })
  const original = f.core.worldDetails(f.id(), selection())
  await gate.waitForCalls(1)
  const current = f.core.worldDetails(f.id(), selection(), { source: 'level.dat_old' })
  await gate.waitForCalls(2)
  gate.calls[1].release.resolve(readResult(selection(), 'level.dat_old', 'old-file-proof'))
  const currentView = await current
  assert.equal(currentView.source, 'level.dat_old')
  const stale = assert.rejects(original, /变化|过期|取消|刷新/)
  gate.calls[0].release.resolve(readResult())
  await stale
  const reveal = f.core.worldDetailsWithSeed(f.id(), currentView.revision!)
  await gate.waitForCalls(3)
  assert.equal(gate.calls[2].options.source, 'level.dat_old')
  gate.calls[2].release.resolve({ ...readResult(selection(), 'level.dat_old', 'old-file-proof'), seed: '17' })
  assert.equal((await reveal).seed, '17')
})

test('default reader projects original gzip fixtures and reveals exact int64 only on request without writes or network', async t => {
  const f = await fixture(t), file = await addWorld(f)
  const bytes = await fs.readFile(file), before = await fs.stat(file, { bigint: true })
  const state = await fs.readFile(path.join(f.root, 'launcher.json')), snapshot = f.core.snapshot()
  f.events.length = 0
  const view = await f.core.worldDetails(f.id(), selection())
  assert.equal(view.status, 'ok'); assert.equal(view.source, 'level.dat')
  assert.equal(view.metadata.levelName, '原创世界'); assert.equal(view.metadata.savedVersionName, '1.20.1')
  assert.equal(view.metadata.dataVersion, 3465); assert.equal(view.metadata.gameMode?.raw, 0)
  assert.equal(view.metadata.hardcore, false); assert.equal(view.metadata.allowCommands, true)
  assert.equal(view.metadata.timeTicks, '9223372036854775807'); assert.equal(view.metadata.dayTimeTicks, '-24000')
  assert.deepEqual(view.metadata.lastPlayed, { epochMs: '0', iso: '1970-01-01T00:00:00.000Z' })
  assert.equal(view.seedAvailable, true); assert.match(view.revision!, /^[a-f0-9-]{36}$/)
  for (const privateValue of ['seed"', 'revisionKey', 'DO-NOT-EXPOSE-PLAYER', f.root, '-9223372036854775808']) {
    assert.equal(JSON.stringify(view).includes(privateValue), false)
  }
  const revealed = await f.core.worldDetailsWithSeed(f.id(), view.revision!)
  assert.equal(revealed.available, true); assert.equal(revealed.seed, '-9223372036854775808')
  assert.deepEqual(Object.keys(revealed).sort(), ['instanceId', 'itemId', 'source', 'revision', 'observedAt', 'available', 'seed'].sort())
  assert.deepEqual(await fs.readFile(file), bytes)
  const after = await fs.stat(file, { bigint: true })
  for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key])
  assert.deepEqual(await fs.readdir(f.world()), ['level.dat'])
  assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), state)
  assert.deepEqual(f.core.snapshot(), snapshot); assert.deepEqual(f.events, []); assert.deepEqual(f.requests, [])
})

test('a corrupt main file never falls back to or merges the explicitly selected old file', async t => {
  const f = await fixture(t)
  await addWorld(f, Buffer.from('not gzip'))
  await addWorld(f, worldBytes('独立旧副本', 0n), selection(), 0, 'level.dat_old')
  const main = await f.core.worldDetails(f.id(), selection())
  assert.equal(main.status, 'unavailable'); assert.equal(main.reasonCode, 'unsupported-compression')
  assert.deepEqual(main.metadata, {}); assert.equal('revision' in main, false); assert.equal(main.seedAvailable, false)
  const old = await f.core.worldDetails(f.id(), selection(), { source: 'level.dat_old' })
  assert.equal(old.source, 'level.dat_old'); assert.equal(old.metadata.levelName, '独立旧副本')
  assert.equal((await f.core.worldDetailsWithSeed(f.id(), old.revision!)).seed, '0')
  assert.deepEqual(await fs.readdir(f.world()), ['level.dat', 'level.dat_old'])
})

test('invalid instances, selections and options fail before reader entry and never evaluate accessors', async t => {
  let calls = 0, gets = 0
  const f = await fixture(t, { worldDetailsReader: async () => { calls++; return readResult() } })
  await assert.rejects(f.core.worldDetails(randomUUID(), selection()), /不存在/)
  const invalid = [null, [], {}, { ...selection(), path: '/private/world' }, { ...selection(), itemId: 'worlds:forged' },
    ...['..', '../outside', 'C:world', 'NUL', 'trailing.', 'bad\u202ename', '\ud800'].map(name => selection(name)),
    Object.create({ name: selection().name, itemId: selection().itemId }),
    Object.defineProperty({ itemId: selection().itemId }, 'name', { enumerable: true, get() { gets++; return selection().name } })]
  for (const input of invalid) await assert.rejects(f.core.worldDetails(f.id(), input), /世界/)
  for (const options of [null, [], { source: '../level.dat' }, { includeSeed: true }, Object.create({ source: 'level.dat' }),
    Object.defineProperty({}, 'source', { enumerable: true, get() { gets++; return 'level.dat' } })]) {
    await assert.rejects(f.core.worldDetails(f.id(), selection(), options as { source?: WorldSource }), /世界/)
  }
  assert.equal(calls, 0); assert.equal(gets, 0)
})

test('Core default DTO strips private reader proof, seed and unrequested metadata before IPC', async t => {
  const secret = 'PRIVATE-SEED', result = readResult()
  Object.assign(result, { seed: secret, privatePath: '/private/world' })
  Object.assign(result.details, { seed: secret, Player: { secret }, revisionKey: 'PRIVATE-PROOF' })
  Object.assign(result.details.metadata, { seed: secret, Player: { secret } })
  result.revisionKey = 'PRIVATE-PROOF'
  const f = await fixture(t, { worldDetailsReader: async () => result })
  f.events.length = 0
  const view = await f.core.worldDetails(f.id(), selection())
  const serialized = JSON.stringify(view)
  assert.equal('seed' in view, false)
  for (const denied of [secret, 'PRIVATE-PROOF', '/private/world', 'Player', 'privatePath']) assert.equal(serialized.includes(denied), false)
  assert.deepEqual(f.events, [])
})

test('unexpected reader failures are sanitized and do not log raw file paths or NBT values', async t => {
  const f = await fixture(t, { worldDetailsReader: async () => { throw new Error('/private/world/level.dat seed=secret-value') } })
  f.events.length = 0
  await assert.rejects(f.core.worldDetails(f.id(), selection()), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /世界详情读取未完成/)
    assert.equal(error.message.includes('secret-value'), false); assert.equal(error.message.includes('/private'), false)
    return true
  })
  assert.deepEqual(f.events, [])
})

test('same pending key shares a reader but returns detached DTOs while two different reads reserve global slots', async t => {
  const gate = readerGate(), f = await fixture(t, { worldDetailsReader: gate.read })
  const first = f.core.worldDetails(f.id(), selection()), shared = f.core.worldDetails(f.id(), selection())
  const other = f.core.worldDetails(f.id(1), selection())
  await assert.rejects(f.core.worldDetails(f.id(2), selection()), /任务较多/)
  await gate.waitForCalls(2)
  assert.equal(gate.calls.length, 2)
  for (const call of gate.calls) call.release.resolve(readResult(call.selection))
  const [a, b, c] = await Promise.all([first, shared, other])
  assert.notEqual(a, b); assert.notEqual(a.metadata, b.metadata); assert.notEqual(a.metadata.gameMode, b.metadata.gameMode)
  assert.notEqual(a.revision, b.revision)
  a.metadata.gameMode!.raw = 99; a.warnings.push('client-only')
  assert.equal(b.metadata.gameMode!.raw, 1); assert.deepEqual(b.warnings, [])
  assert.equal(c.instanceId, f.id(1))
})

test('revisions are instance-bound, expire after two minutes and retain only 32 global capabilities', async t => {
  let now = 1000, calls = 0
  const f = await fixture(t, { worldDetailsNow: () => now, worldDetailsReader: async (_directory, input, options = {}) => {
    calls++; return { ...readResult(input, options.source), ...(options.includeSeed ? { seed: '0' } : {}) }
  } })
  const first = await f.core.worldDetails(f.id(), selection('first'))
  const count = calls
  await assert.rejects(f.core.worldDetailsWithSeed(f.id(1), first.revision!), /过期/)
  await assert.rejects(f.core.worldDetailsWithSeed(f.id(), randomUUID()), /过期/)
  assert.equal(calls, count)
  for (let i = 0; i < 32; i++) await f.core.worldDetails(f.id(i % 3), selection(`World ${i}`))
  await assert.rejects(f.core.worldDetailsWithSeed(f.id(), first.revision!), /过期/)
  const recent = await f.core.worldDetails(f.id(), selection('recent'))
  now += 119_999
  assert.equal((await f.core.worldDetailsWithSeed(f.id(), recent.revision!)).seed, '0')
  now++
  const beforeExpiry = calls
  await assert.rejects(f.core.worldDetailsWithSeed(f.id(), recent.revision!), /过期/)
  assert.equal(calls, beforeExpiry)
})

test('expiration during reveal rejects a completed reader result rather than releasing its seed', async t => {
  let now = 0
  const gate = readerGate(), f = await fixture(t, { worldDetailsReader: gate.read, worldDetailsNow: () => now })
  const initial = f.core.worldDetails(f.id(), selection())
  await gate.waitForCalls(1); gate.calls[0].release.resolve(readResult())
  const view = await initial
  const revealing = f.core.worldDetailsWithSeed(f.id(), view.revision!)
  const expired = assert.rejects(revealing, /过期|变化/)
  await gate.waitForCalls(2); now = 120_000
  gate.calls[1].release.resolve({ ...readResult(), seed: '42' })
  await expired
  await assert.rejects(f.core.worldDetailsWithSeed(f.id(), view.revision!), /过期/)
})

test('a refreshed view invalidates an already-issued revision and an earlier pending seed reveal', async t => {
  const gate = readerGate(), f = await fixture(t, { worldDetailsReader: gate.read })
  const first = f.core.worldDetails(f.id(), selection())
  await gate.waitForCalls(1); gate.calls[0].release.resolve(readResult())
  const view = await first
  const oldReveal = f.core.worldDetailsWithSeed(f.id(), view.revision!), stale = assert.rejects(oldReveal, /过期|变化/)
  await gate.waitForCalls(2)
  const refresh = f.core.worldDetails(f.id(), selection())
  await gate.waitForCalls(3); gate.calls[2].release.resolve(readResult())
  const refreshed = await refresh
  assert.notEqual(refreshed.revision, view.revision)
  gate.calls[1].release.resolve({ ...readResult(), seed: '13' })
  await stale
  await assert.rejects(f.core.worldDetailsWithSeed(f.id(), view.revision!), /过期/)
})

test('default reveal rereads the file and rejects a same-path edited snapshot', async t => {
  const f = await fixture(t), file = await addWorld(f)
  const view = await f.core.worldDetails(f.id(), selection())
  const changed = worldBytes('外部编辑', 123n)
  await fs.writeFile(file, changed)
  await assert.rejects(f.core.worldDetailsWithSeed(f.id(), view.revision!), /变化|过期/)
  assert.deepEqual(await fs.readFile(file), changed)
  const next = await f.core.worldDetails(f.id(), selection())
  assert.equal(next.metadata.levelName, '外部编辑')
  assert.equal((await f.core.worldDetailsWithSeed(f.id(), next.revision!)).seed, '123')
})

test('shutdown cancels reads without releasing their slots until ignored-signal workers settle', async t => {
  const gate = readerGate(), f = await fixture(t, { worldDetailsReader: gate.read })
  const pending = [f.core.worldDetails(f.id(), selection()), f.core.worldDetails(f.id(1), selection())]
  const rejected = pending.map(value => assert.rejects(value, /取消|变化/))
  await gate.waitForCalls(2)
  f.core.cancelPendingOperations()
  assert.ok(gate.calls.every(call => call.options.signal?.aborted))
  await assert.rejects(f.core.worldDetails(f.id(2), selection()), /任务较多/)
  gate.calls[0].release.resolve(readResult()); gate.calls[1].release.resolve(readResult())
  await Promise.all(rejected)
  const again = f.core.worldDetails(f.id(2), selection())
  await gate.waitForCalls(3); gate.calls[2].release.resolve(readResult())
  assert.ok((await again).revision)
})

test('completed instance-settings mutation invalidates old reads even after its lock has gone', async t => {
  const gate = readerGate(), f = await fixture(t, { worldDetailsReader: gate.read })
  const pending = f.core.worldDetails(f.id(), selection()), rejected = assert.rejects(pending, /取消|变化/)
  await gate.waitForCalls(1)
  await f.core.updateInstanceSettings(f.id(), { name: 'After mutation', options: {} })
  assert.equal(gate.calls[0].options.signal?.aborted, true)
  gate.calls[0].release.resolve(readResult())
  await rejected
  assert.equal(f.core.snapshot().instances[0].name, 'After mutation')
})

test('settings-save reservation prevents reads before the persistence worker settles', async t => {
  let armed = false, calls = 0
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { stateRename: async (from, to) => {
    if (armed) { entered.resolve(); await release.promise }
    return fs.rename(from, to)
  }, worldDetailsReader: async () => { calls++; return readResult() } })
  armed = true
  const saving = f.core.updateInstanceSettings(f.id(), { name: 'Save gate', options: {} })
  await entered.promise
  await assert.rejects(f.core.worldDetails(f.id(), selection()), /保存|文件操作/)
  assert.equal(calls, 0)
  release.resolve(); await saving
  assert.equal((await f.core.worldDetails(f.id(), selection())).metadata.levelName, 'Fixture metadata')
})

test('a full failed install cycle cancels the old read and does not publish it after the install lock is released', async t => {
  const gate = readerGate(), entered = deferred(), release = deferred<Response>()
  const f = await fixture(t, { worldDetailsReader: gate.read, fetch: async () => { entered.resolve(); return release.promise } })
  const old = f.core.worldDetails(f.id(), selection()), rejected = assert.rejects(old, /取消|变化/)
  await gate.waitForCalls(1)
  const installing = f.core.install(f.id()), failed = assert.rejects(installing, /403|访问|权限/)
  await entered.promise
  await assert.rejects(f.core.worldDetails(f.id(), selection()), /文件操作|关闭游戏/)
  assert.equal(gate.calls[0].options.signal?.aborted, true)
  release.resolve(new Response('No fixture access', { status: 403 }))
  await failed
  gate.calls[0].release.resolve(readResult()); await rejected
  assert.equal(f.core.snapshot().instances[0].status, 'error')
})

test('preflight invalidation clears issued capabilities and rejects a late reader without starting a game', async t => {
  const gate = readerGate(), f = await fixture(t, { worldDetailsReader: gate.read })
  const first = f.core.worldDetails(f.id(), selection())
  await gate.waitForCalls(1); gate.calls[0].release.resolve(readResult())
  const view = await first
  const pending = f.core.worldDetails(f.id(), selection('Other World')), rejected = assert.rejects(pending, /取消|变化/)
  await gate.waitForCalls(2)
  f.core.invalidateInstanceReads(f.id())
  await assert.rejects(f.core.worldDetailsWithSeed(f.id(), view.revision!), /过期/)
  gate.calls[1].release.resolve(readResult(selection('Other World')))
  await rejected
  assert.deepEqual(f.requests, [])
})

test('an error instance can be inspected without mod recovery cleanup, state persistence or new log events', async t => {
  let recoveryCalls = 0, armed = false
  const f = await fixture(t, { modToggleRecovery: async () => { recoveryCalls++; return { blocked: false, warnings: [] } },
    stateRename: async (from, to) => { if (armed) throw new Error('World reads must not persist state'); return fs.rename(from, to) } },
  { status: 'error', error: 'Existing diagnostic state' })
  await addWorld(f)
  const marker = path.join(f.directory(), `.mod-toggle-${randomUUID()}`)
  await fs.mkdir(marker); await fs.writeFile(path.join(marker, 'intent.json'), 'preserve ambiguous external evidence')
  const bytes = await fs.readFile(path.join(f.root, 'launcher.json')), snapshot = f.core.snapshot()
  armed = true; recoveryCalls = 0; f.events.length = 0
  const view = await f.core.worldDetails(f.id(), selection())
  assert.equal(view.status, 'ok'); assert.equal(recoveryCalls, 0)
  assert.equal(await fs.readFile(path.join(marker, 'intent.json'), 'utf8'), 'preserve ambiguous external evidence')
  assert.deepEqual(f.core.snapshot(), snapshot); assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), bytes)
  assert.deepEqual(f.events, [])
})

test('missing supported seed data remains unavailable and does not read independent world data files', async t => {
  const f = await fixture(t)
  // An explicit compound without WorldGenSettings, like the supported projection
  // of a newer layout. This is still an original fixture, not a real 26.x save.
  const bytes = gzipSync(compound('', compound('Data', stringTag('LevelName', 'Partial fixture'), intTag('DataVersion', 5000))))
  await addWorld(f, bytes)
  await fs.mkdir(path.join(f.world(), 'data', 'minecraft'), { recursive: true })
  const excluded = path.join(f.world(), 'data', 'minecraft', 'world_gen_settings.dat')
  await fs.writeFile(excluded, worldBytes('must not be followed', 91n))
  const view = await f.core.worldDetails(f.id(), selection())
  assert.equal(view.status, 'partial'); assert.equal(view.seedAvailable, false)
  assert.equal('seed' in view, false); assert.equal(view.metadata.hardcore, undefined)
  const revealed = await f.core.worldDetailsWithSeed(f.id(), view.revision!)
  assert.equal(revealed.available, false); assert.equal('seed' in revealed, false)
  assert.deepEqual(await fs.readFile(excluded), worldBytes('must not be followed', 91n))
})

test('reveal rejects an invalid or out-of-int64 reader seed without echoing its value', async t => {
  let seed: unknown = '9223372036854775808'
  const f = await fixture(t, { worldDetailsReader: async (_directory, input, options = {}) => ({
    ...readResult(input), ...(options.includeSeed ? { seed: seed as string } : {}),
  }) })
  for (seed of ['9223372036854775808', '-9223372036854775809', 'private-malformed-value', 42]) {
    const view = await f.core.worldDetails(f.id(), selection())
    await assert.rejects(f.core.worldDetailsWithSeed(f.id(), view.revision!), error => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes(String(seed)), false)
      assert.match(error.message, /种子格式无效/); return true
    })
  }
})
