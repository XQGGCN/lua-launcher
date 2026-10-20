import assert from 'node:assert/strict'
import type { ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test, { type TestContext } from 'node:test'
import { LauncherCore, type LaunchAccount } from './core'
import type { MemorySystem } from './memory'

const MIB = 1024 * 1024
const runtime = { path: '/fake/java', version: '17.0.12', major: 17, arch: 'x64' }
// These credentials are used exclusively with the fake process below.
const account: LaunchAccount = {
  mode: 'microsoft',
  username: 'MemoryTest',
  uuid: '0123456789abcdef0123456789abcdef',
  accessToken: 'fictitious-unit-test-token',
}

function fixture(): typeof fetch {
  const sha1 = (body: string) => createHash('sha1').update(body).digest('hex')
  const versionUrl = 'https://piston-meta.mojang.com/memory-test/1.20.1.json'
  const indexUrl = 'https://piston-meta.mojang.com/memory-test/assets.json'
  const clientUrl = 'https://piston-data.mojang.com/memory-test/client.jar'
  const client = 'memory integration fixture'
  const index = JSON.stringify({ objects: {} })
  const version = JSON.stringify({
    id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    javaVersion: { majorVersion: 17 },
    assetIndex: { id: '5', url: indexUrl, sha1: sha1(index), size: Buffer.byteLength(index) },
    downloads: { client: { url: clientUrl, sha1: sha1(client), size: Buffer.byteLength(client) } },
    libraries: [],
    arguments: {
      jvm: ['-cp', '${classpath}'],
      game: ['--username', '${auth_player_name}', '--accessToken', '${auth_access_token}'],
    },
  })
  const responses = new Map([
    ['https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', JSON.stringify({
      versions: [{ id: '1.20.1', type: 'release', releaseTime: '2023-06-12T13:25:51Z', url: versionUrl, sha1: sha1(version) }],
    })],
    [versionUrl, version],
    [indexUrl, index],
    [clientUrl, client],
    ['https://meta.fabricmc.net/v2/versions/loader/1.20.1', JSON.stringify([
      { loader: { version: '0.16.10', stable: true } },
    ])],
    ['https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.16.10/profile/json', JSON.stringify({
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      libraries: [],
      arguments: { jvm: [], game: [] },
    })],
  ])
  return async (input, options) => {
    options?.signal?.throwIfAborted()
    const body = responses.get(String(input))
    assert.notEqual(body, undefined, `unexpected fixture request: ${String(input)}`)
    return new Response(body)
  }
}

function processHarness() {
  const children: ChildProcess[] = []
  const calls: Array<{ command: string; args: string[] }> = []
  const spawnFake = ((command: string, args: string[]) => {
    calls.push({ command, args: [...args] })
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      pid: 6000 + children.length,
      stdout,
      stderr,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        queueMicrotask(() => {
          stdout.end()
          stderr.end()
          child.emit('close', null, signal)
        })
        return true
      },
    }) as unknown as ChildProcess
    children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    return child
  }) as typeof spawn
  return { children, calls, spawn: spawnFake }
}

function memorySource(totalMb: number, freeMb: number) {
  const state = { totalMb, freeMb }
  const system: MemorySystem = {
    totalmem: () => state.totalMb * MIB,
    freemem: () => state.freeMb * MIB,
    platform: () => 'linux',
  }
  return { state, system }
}

async function installedWorld(t: TestContext, system: MemorySystem, loader: 'vanilla' | 'fabric' = 'vanilla') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-memory-'))
  const processes = processHarness()
  const core = new LauncherCore(directory, undefined, {
    fetch: fixture(), spawn: processes.spawn, memorySystem: system,
    platform: 'linux', arch: 'x64',
  })
  let instanceId: string | undefined
  const stop = async () => {
    if (!instanceId || core.snapshot().instances.find(instance => instance.id === instanceId)?.status !== 'running') return
    const child = processes.children.at(-1)!
    const closed = once(child, 'close')
    core.stop(instanceId)
    await closed
    // Queue after the close listener's save so cleanup does not race persistence.
    await core.updateSettings({})
  }
  t.after(async () => {
    try { await stop() }
    finally { await fs.rm(directory, { recursive: true, force: true }) }
  })
  await core.init()
  core.detectJava = async () => [runtime]
  const instance = await core.createInstance({ name: 'Memory integration', version: '1.20.1', loader })
  instanceId = instance.id
  await core.install(instance.id)
  return { directory, core, instance, processes, stop }
}

function maximumHeap(args: string[]) {
  return args.filter(argument => /^-Xmx/.test(argument))
}

test('automatic launch passes the vanilla recommendation to Java and preserves the manual preference', async t => {
  const { system } = memorySource(32768, 24576)
  const { core, instance, processes, stop, directory } = await installedWorld(t, system)
  await core.updateSettings({ memoryMb: 16384 })
  assert.equal(core.snapshot().settings.memoryMode, 'auto')
  await core.launch(instance.id, account)
  assert.equal(processes.calls[0].command, runtime.path)
  assert.deepEqual(maximumHeap(processes.calls[0].args), ['-Xmx4096M'])
  assert.equal(core.snapshot().settings.memoryMb, 16384)
  await stop()
  const reopened = new LauncherCore(directory, undefined, { fetch: fixture(), memorySystem: system })
  await reopened.init()
  assert.equal(reopened.snapshot().settings.memoryMode, 'auto')
  assert.equal(reopened.snapshot().settings.memoryMb, 16384)
})

test('automatic launch uses the installed modded workload instead of the vanilla recommendation', async t => {
  const { system } = memorySource(32768, 24576)
  const { core, instance, processes } = await installedWorld(t, system, 'fabric')
  await core.updateSettings({ memoryMode: 'auto', memoryMb: 12288 })
  await core.launch(instance.id, account)
  assert.deepEqual(maximumHeap(processes.calls[0].args), ['-Xmx6144M'])
  assert.ok(processes.calls[0].args.includes('net.fabricmc.loader.impl.launch.knot.KnotClient'))
  assert.equal(core.snapshot().settings.memoryMb, 12288)
})

test('manual launch caps the actual Java heap without replacing the saved manual setting', async t => {
  const { system } = memorySource(8192, 4096)
  const { core, instance, processes, stop, directory } = await installedWorld(t, system)
  await core.updateSettings({ memoryMode: 'manual', memoryMb: 8192 })
  await core.launch(instance.id, account)
  assert.deepEqual(maximumHeap(processes.calls[0].args), ['-Xmx2304M'])
  assert.equal(core.snapshot().settings.memoryMode, 'manual')
  assert.equal(core.snapshot().settings.memoryMb, 8192)
  await stop()
  const reopened = new LauncherCore(directory, undefined, { fetch: fixture(), memorySystem: system })
  await reopened.init()
  assert.equal(reopened.snapshot().settings.memoryMode, 'manual')
  assert.equal(reopened.snapshot().settings.memoryMb, 8192)
  await reopened.updateSettings({ memoryMode: 'auto' })
  assert.equal(reopened.snapshot().settings.memoryMb, 8192)
})

test('launch reads current memory after Java detection instead of using memory from before the wait', async t => {
  const { state, system } = memorySource(32768, 24576)
  const order: string[] = []
  const readFree = system.freemem!
  system.freemem = () => { order.push('memory'); return readFree() }
  const { core, instance, processes } = await installedWorld(t, system)
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  core.detectJava = async () => {
    order.push('detect-start'); enter()
    await gate
    order.push('detect-end')
    return [runtime]
  }
  const launching = core.launch(instance.id, account)
  await entered
  const readsWhileDetecting = order.filter(item => item === 'memory').length
  const spawnsWhileDetecting = processes.calls.length
  state.freeMb = 4096
  release()
  await launching
  assert.equal(readsWhileDetecting, 0)
  assert.equal(spawnsWhileDetecting, 0)
  assert.ok(order.indexOf('memory') > order.indexOf('detect-end'))
  assert.deepEqual(maximumHeap(processes.calls[0].args), ['-Xmx2304M'])
})

test('insufficient memory prevents spawning Java and leaves the instance ready for a later retry', async t => {
  const { state, system } = memorySource(16384, 1024)
  const { core, instance, processes } = await installedWorld(t, system)
  await core.updateSettings({ memoryMode: 'manual', memoryMb: 1024 })
  await assert.rejects(core.launch(instance.id, account), { code: 'INSUFFICIENT_MEMORY' })
  assert.equal(processes.calls.length, 0)
  assert.equal(core.snapshot().instances[0].status, 'ready')
  assert.equal(core.snapshot().instances[0].lastPlayed, undefined)
  state.freeMb = 12000
  await core.launch(instance.id, account)
  assert.equal(processes.calls.length, 1, 'memory rejection must release the launch reservation')
  assert.deepEqual(maximumHeap(processes.calls[0].args), ['-Xmx1024M'])
  assert.equal(core.snapshot().instances[0].status, 'running')
})
