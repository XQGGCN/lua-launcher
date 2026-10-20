import assert from 'node:assert/strict'
import test from 'node:test'
import { LaunchPreparations } from './launch-preparation'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('a cancellation while credentials are pending prevents all later runtime or spawn work', async () => {
  const queue = new LaunchPreparations(), credentials = deferred()
  let prepared = false
  const operation = queue.run('instance', async signal => {
    await credentials.promise
    signal.throwIfAborted()
    prepared = true
  })
  const rejected = assert.rejects(operation, /取消/)
  await assert.rejects(queue.run('instance', async () => {}), /正在准备/)
  queue.cancel('instance')
  credentials.resolve()
  await rejected
  assert.equal(prepared, false)
  await queue.run('instance', async signal => { signal.throwIfAborted(); prepared = true })
  assert.equal(prepared, true)
})

test('shutdown cancels an early credential request and refuses late launch requests', async () => {
  const queue = new LaunchPreparations(), credentials = deferred()
  let spawned = false
  const operation = queue.run('first', async signal => {
    await credentials.promise
    signal.throwIfAborted()
    spawned = true
  })
  const rejected = assert.rejects(operation, /退出/)
  queue.close()
  credentials.resolve()
  await rejected
  await assert.rejects(queue.run('second', async () => { spawned = true }), /退出/)
  assert.equal(spawned, false)
})

test('cancelling one instance does not cancel another and failed preparation releases its reservation', async () => {
  const queue = new LaunchPreparations(), credentials = deferred()
  const first = queue.run('first', async signal => { await credentials.promise; signal.throwIfAborted() })
  const rejected = assert.rejects(first, /取消/)
  const second = queue.run('second', async signal => { await credentials.promise; signal.throwIfAborted(); return 42 })
  queue.cancel('first'); credentials.resolve()
  await rejected
  assert.equal(await second, 42)
  await assert.rejects(queue.run('third', async () => { throw new Error('credential refresh failed') }), /refresh failed/)
  assert.equal(await queue.run('third', async () => 43), 43)
})
