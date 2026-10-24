import assert from 'node:assert/strict'
import test from 'node:test'
import { UpdateActivityGate, UpdateCoordinator } from './update-coordinator'
import type { UpdateInfo } from './updater'

const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const info = (version = '0.20.0', action: UpdateInfo['action'] = 'open-dmg'): UpdateInfo => ({ version, current: '0.10.4', notes: 'inert fixture', publishedAt: '',
  page: 'https://github.com/XQGGCN/lua-launcher/releases', action,
  asset: { name: 'fixture.dmg', url: 'https://github.com/XQGGCN/lua-launcher/releases/download/v0.20.0/fixture.dmg', size: 8, sha256: 'a'.repeat(64) } })
function fixture(overrides: Partial<ConstructorParameters<typeof UpdateCoordinator>[0]> = {}) {
  const activity = new UpdateActivityGate(), calls: string[] = []
  let coreHeld = false, sequence = 0
  const coordinator = new UpdateCoordinator({ activity, reserveCore: () => { assert.equal(coreHeld, false); coreHeld = true; return () => { coreHeld = false } },
    check: async () => info(), download: async selected => { calls.push(`download:${selected.version}`); return 'fixture-file' },
    openPage: async () => { calls.push('page') }, openInstaller: async () => { calls.push('open') }, startInstaller: async () => { calls.push('spawn') },
    replaceAppImage: async () => { calls.push('replace') }, handoff: action => { calls.push(`handoff:${action}`) },
    selectionId: () => `selection-${++sequence}`, ...overrides })
  return { activity, coordinator, calls, held: () => coreHeld }
}

test('early IPC metadata, credentials and picker waits reserve activity before their first await', async () => {
  const f = fixture(), gate = deferred()
  const selection = await f.coordinator.check()
  const pending = f.activity.operation(async () => { await gate.promise })
  await assert.rejects(f.coordinator.install(selection!.selectionId), /有操作/)
  assert.equal(f.held(), false); assert.deepEqual(f.calls, [])
  gate.resolve(); await pending
  assert.equal(await f.coordinator.install(selection!.selectionId), 'opened-installer')
  assert.equal(f.held(), false)
})

test('account and auth-config disk reads stay tracked; only cached status dispatches bypass the update lease', async () => {
  for (const method of ['account', 'authConfig', 'unknown-future-operation']) {
    const f = fixture(), gate = deferred(), selected = await f.coordinator.check()
    const read = f.activity.dispatch(method, async () => { await gate.promise })
    await assert.rejects(f.coordinator.install(selected!.selectionId), /有操作/)
    gate.resolve(); await read
    const release = f.activity.reserve(() => () => {})
    await assert.rejects(f.activity.dispatch(method, async () => {}), /有操作/)
    assert.equal(await f.activity.dispatch('snapshot', () => 'cached-status'), 'cached-status')
    release()
  }
})

test('a slow obsolete check cannot replace the newer confirmed selection', async () => {
  const first = deferred<UpdateInfo | null>(); let reads = 0
  const f = fixture({ check: async () => ++reads === 1 ? first.promise : info('0.21.0') })
  const slow = f.coordinator.check(), rejected = assert.rejects(slow, /较新/)
  const newer = await f.coordinator.check()
  first.resolve(info('0.19.0')); await rejected
  assert.equal(newer?.version, '0.21.0')
  await f.coordinator.install(newer!.selectionId)
  assert.equal(f.calls[0], 'download:0.21.0')
})

test('old confirmation tokens cannot install a rechecked release, including the same version', async () => {
  const f = fixture(), old = await f.coordinator.check(), current = await f.coordinator.check()
  assert.notEqual(old!.selectionId, current!.selectionId)
  await assert.rejects(f.coordinator.install(old!.selectionId), /重新检查/)
  assert.deepEqual(f.calls, [])
})

test('during download the exact selected release is pinned and all new operations and checks are refused', async () => {
  const gate = deferred<string>(), f = fixture({ download: async () => gate.promise })
  const selected = await f.coordinator.check(), pending = f.coordinator.install(selected!.selectionId)
  assert.equal(f.held(), true)
  await assert.rejects(f.activity.operation(async () => { throw new Error('must not start a game') }), /有操作/)
  await assert.rejects(f.coordinator.check(), /有操作/)
  await assert.rejects(f.coordinator.install(selected!.selectionId), /有操作/)
  gate.resolve('inert-file'); assert.equal(await pending, 'opened-installer')
  assert.equal(f.held(), false)
})

test('cancel requests retain the update lease until the actual download worker settles', async () => {
  const worker = deferred<string>()
  const f = fixture({ download: async (_selected, signal) => { await worker.promise; signal.throwIfAborted(); return 'never-open' } })
  const selected = await f.coordinator.check(), pending = f.coordinator.install(selected!.selectionId), rejected = assert.rejects(pending, /取消/)
  f.coordinator.cancel()
  assert.equal(f.held(), true)
  await assert.rejects(f.activity.operation(async () => {}), /有操作/)
  worker.resolve('settled'); await rejected
  assert.equal(f.held(), false); assert.deepEqual(f.calls, [])
})

test('an installer spawn failure releases the lease and never schedules launcher exit', async () => {
  const f = fixture({ check: async () => info('0.20.0', 'installer'), startInstaller: async () => { throw new Error('spawn failed') } })
  const selected = await f.coordinator.check()
  await assert.rejects(f.coordinator.install(selected!.selectionId), /spawn failed/)
  assert.equal(f.held(), false); assert.ok(!f.calls.some(call => call.startsWith('handoff')))
})

test('a successful installer handoff keeps new work blocked until shutdown', async () => {
  const f = fixture({ check: async () => info('0.20.0', 'installer') }), selected = await f.coordinator.check()
  assert.equal(await f.coordinator.install(selected!.selectionId), 'installing')
  assert.equal(f.held(), true); assert.equal(f.calls.at(-1), 'handoff:installer')
  f.coordinator.cancel(); assert.equal(f.held(), true)
  await assert.rejects(f.activity.operation(async () => {}), /有操作/)
  f.coordinator.close(); await assert.rejects(f.coordinator.check(), /有操作/)
})

test('a proved AppImage replacement wins late cancellation and retains the handoff lease', async () => {
  let cancel!: () => void
  const f = fixture({ check: async () => info('0.20.0', 'appimage'), replaceAppImage: async () => { cancel() } })
  cancel = () => f.coordinator.cancel()
  const selected = await f.coordinator.check()
  assert.equal(await f.coordinator.install(selected!.selectionId), 'restarting')
  assert.equal(f.calls.at(-1), 'handoff:appimage'); assert.equal(f.held(), true)
})

test('an uncertain replacement keeps new work blocked and never schedules automatic restart', async () => {
  const f = fixture({ check: async () => info('0.20.0', 'appimage'), replaceAppImage: async () => { throw Object.assign(new Error('manual inspection required'), { code: 'RECOVERY_REQUIRED' }) } })
  const selected = await f.coordinator.check()
  await assert.rejects(f.coordinator.install(selected!.selectionId), /inspection/)
  assert.equal(f.held(), true)
  assert.ok(!f.calls.some(call => call.startsWith('handoff')))
  await assert.rejects(f.activity.operation(async () => {}), /有操作/)
})

test('opening a download page or DMG releases the lease, and close invalidates in-flight checks', async () => {
  const f = fixture({ check: async () => ({ ...info(), action: 'page', asset: undefined }) }), selected = await f.coordinator.check()
  assert.equal(await f.coordinator.install(selected!.selectionId), 'opened-page'); assert.equal(f.held(), false)
  const waiting = deferred<UpdateInfo | null>(), closed = fixture({ check: async () => waiting.promise })
  const pending = closed.coordinator.check(), rejected = assert.rejects(pending)
  closed.coordinator.close(); waiting.resolve(info()); await rejected
  await assert.rejects(closed.activity.operation(async () => {}), /有操作/)
})
