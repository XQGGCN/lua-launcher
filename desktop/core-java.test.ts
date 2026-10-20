import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { LauncherCore, type CoreEvent, type LaunchAccount } from './core'
import type { JavaRuntimeManager, JavaRuntimeRequest, ManagedJavaRuntime } from './java-runtime'
import { JAVA_RUNTIME_INDEX } from './java-runtime'

const sha1 = (body: string) => createHash('sha1').update(body).digest('hex')
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const components = { 17: 'java-runtime-gamma', 21: 'java-runtime-delta', 25: 'java-runtime-epsilon' } as const
const account: LaunchAccount = { mode: 'microsoft', username: 'JavaTest', uuid: '0123456789abcdef0123456789abcdef', accessToken: 'fictitious-test-token' }
const localJava = { path: path.resolve('/local-test/java'), version: '17.0.12', major: 17, arch: 'x64' }
const managed = (request: JavaRuntimeRequest): ManagedJavaRuntime => ({
  path: path.resolve(`/managed-test/java-${request.major}`), version: `${request.major}.0.1`, major: request.major,
  arch: request.arch ?? 'x64', component: request.component, source: 'mojang', manifestSha1: 'a'.repeat(40), installedAt: new Date().toISOString(),
})
type Manager = Pick<JavaRuntimeManager, 'ensure' | 'discover'>

async function fixture(t: TestContext, ensure?: Manager['ensure'], realManager = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-java-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const events: CoreEvent[] = [], requests: string[] = [], provisions: JavaRuntimeRequest[] = []
  const responses = new Map<string, string>()
  const versions = Object.entries({ '1.20.1': 17, '1.20.5': 21, '26.3': 25 }).map(([id, major]) => {
    const assets = JSON.stringify({ objects: {} }), jar = `test client ${id}`
    const version = JSON.stringify({
      id, type: 'release', mainClass: 'net.minecraft.client.main.Main',
      javaVersion: { majorVersion: major, component: components[major as keyof typeof components] },
      assetIndex: { id, url: `https://piston-meta.mojang.com/java-test/${id}/assets.json`, sha1: sha1(assets), size: Buffer.byteLength(assets) },
      downloads: { client: { url: `https://piston-data.mojang.com/java-test/${id}/client.jar`, sha1: sha1(jar), size: Buffer.byteLength(jar) } },
      libraries: [], arguments: { jvm: ['-cp', '${classpath}'], game: [] },
    })
    const url = `https://piston-meta.mojang.com/java-test/${id}/version.json`
    responses.set(url, version)
    responses.set(`https://piston-meta.mojang.com/java-test/${id}/assets.json`, assets)
    responses.set(`https://piston-data.mojang.com/java-test/${id}/client.jar`, jar)
    responses.set(`https://meta.fabricmc.net/v2/versions/loader/${id}`, JSON.stringify([{ loader: { version: '0.16.10', stable: true } }]))
    responses.set(`https://meta.fabricmc.net/v2/versions/loader/${id}/0.16.10/profile/json`, JSON.stringify({
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', libraries: [], arguments: { jvm: [], game: [] },
    }))
    return { id, type: 'release', releaseTime: '2026-10-21T00:00:00Z', url, sha1: sha1(version), size: Buffer.byteLength(version) }
  })
  responses.set(MANIFEST, JSON.stringify({ versions }))
  if (realManager) {
    const java = 'verified Java fixture', license = 'Test OpenJDK license retained by installation'
    const artifact = (name: string, body: string, executable: boolean) => {
      const url = `https://piston-data.mojang.com/java-test/${name}`
      responses.set(url, body)
      return { type: 'file', executable, downloads: { raw: { url, sha1: sha1(body), size: Buffer.byteLength(body) } } }
    }
    const manifest = JSON.stringify({ files: {
      bin: { type: 'directory' }, legal: { type: 'directory' }, 'legal/java.base': { type: 'directory' },
      'bin/java': artifact('java', java, true), 'legal/java.base/LICENSE': artifact('LICENSE', license, false),
    } })
    const url = 'https://piston-meta.mojang.com/java-test/runtime-manifest.json'
    responses.set(url, manifest)
    responses.set(JAVA_RUNTIME_INDEX, JSON.stringify({ linux: { 'java-runtime-gamma': [{
      version: { name: '17.0.15' }, manifest: { url, sha1: sha1(manifest), size: Buffer.byteLength(manifest) },
    }] } }))
  }
  let spawns = 0
  const core = new LauncherCore(directory, event => events.push(event), {
    platform: 'linux', arch: 'x64', fetch: async (input, options) => {
      options?.signal?.throwIfAborted()
      const url = String(input)
      requests.push(url)
      const body = responses.get(url)
      assert.notEqual(body, undefined, `unexpected fixture request ${url}`)
      return new Response(body)
    },
    memorySystem: { totalmem: () => 16 * 1024 ** 3, freemem: () => 12 * 1024 ** 3 },
    spawn: (() => { spawns++; throw new Error('No game process is permitted in this test') }) as typeof spawn,
    javaRuntimeProbe: realManager ? async executable => {
      assert.equal(await fs.readFile(executable, 'utf8'), 'verified Java fixture')
      return { version: '17.0.15', major: 17, arch: 'x64' }
    } : undefined,
    javaRuntimeManager: realManager ? undefined : {
      discover: async () => [],
      ensure: async (request, options) => {
        provisions.push(request)
        return ensure ? ensure(request, options) : managed(request)
      },
    },
  })
  await core.init()
  core.detectJava = async () => []
  return { core, directory, events, requests, provisions, spawns: () => spawns }
}

test('the production manager wiring provisions Java under a fresh launcher root exactly once', async t => {
  const f = await fixture(t, undefined, true)
  const instance = await f.core.createInstance({ name: 'Fresh real manager', version: '1.20.1', loader: 'vanilla' })
  await assert.rejects(fs.access(path.join(f.directory, 'runtimes')))
  await f.core.install(instance.id)
  const runtimes = await f.core.managedJava()
  assert.equal(runtimes.length, 1)
  assert.ok(runtimes[0].path.startsWith(path.join(f.directory, 'runtimes', 'linux') + path.sep))
  assert.equal(runtimes[0].path.includes(path.join('runtimes', 'runtimes')), false)
  assert.equal(f.core.snapshot().instances[0].status, 'ready')
  assert.equal(f.spawns(), 0)
  assert.ok(f.events.some(event => event.type === 'progress' && event.unit === 'bytes' && event.completed > 0))
})

for (const [version, major] of [['1.20.1', 17], ['1.20.5', 21], ['26.3', 25]] as const) {
  for (const loader of ['vanilla', 'fabric'] as const) {
    test(`${version} ${loader} prepares the exact manifest runtime before marking the game ready`, async t => {
      const f = await fixture(t)
      const instance = await f.core.createInstance({ name: 'Java fixture', version, loader })
      await f.core.install(instance.id)
      assert.deepEqual(f.provisions, [{ major, component: components[major], platform: 'linux', arch: 'x64' }])
      assert.equal(f.core.snapshot().instances[0].status, 'ready')
      assert.equal(f.core.snapshot().settings.javaPath, '')
      assert.equal(f.spawns(), 0)
      assert.deepEqual(await f.core.runtimeRequirement(instance.id), { instanceName: 'Java fixture', major, component: components[major] })
    })
  }
}

test('a matching installed Java is reused; another version or architecture cannot suppress provisioning', async t => {
  const f = await fixture(t)
  const instance = await f.core.createInstance({ name: 'Reuse runtime', version: '1.20.1', loader: 'vanilla' })
  f.core.detectJava = async () => [localJava]
  await f.core.install(instance.id)
  assert.equal(f.provisions.length, 0)
  f.core.detectJava = async () => [{ ...localJava, major: 21 }, { ...localJava, arch: 'arm64' }]
  await f.core.install(instance.id)
  assert.equal(f.provisions.length, 1)
  assert.equal(f.provisions[0].major, 17)
  assert.equal(f.provisions[0].arch, 'x64')
})

test('invalid explicit Java never silently switches to a system or managed runtime', async t => {
  const f = await fixture(t)
  const instance = await f.core.createInstance({ name: 'Explicit runtime', version: '1.20.1', loader: 'vanilla' })
  const selected = path.resolve('/explicit-test/java')
  await f.core.updateSettings({ javaPath: selected })
  f.core.detectJava = async () => [localJava]
  await assert.rejects(f.core.install(instance.id), /指定的 Java 路径不可用/)
  f.core.detectJava = async () => [{ ...localJava, path: selected, major: 21 }]
  await assert.rejects(f.core.install(instance.id), /当前选择的是 Java 21/)
  f.core.detectJava = async () => [{ ...localJava, path: selected, arch: 'arm64' }]
  await assert.rejects(f.core.install(instance.id), /架构/)
  assert.equal(f.provisions.length, 0)
  assert.equal(f.core.snapshot().settings.javaPath, selected)
  assert.equal(f.spawns(), 0)
})

test('automatic selection and provisioning preserve the saved manual path across a restart', async t => {
  const f = await fixture(t)
  const selected = path.resolve('/saved-test/java')
  await f.core.updateSettings({ javaPath: selected })
  await f.core.updateSettings({ javaPath: '' })
  const instance = await f.core.createInstance({ name: 'Remember manual choice', version: '1.20.1', loader: 'vanilla' })
  await f.core.install(instance.id)
  assert.equal(f.core.snapshot().settings.javaPath, '')
  assert.equal(f.core.snapshot().settings.manualJavaPath, selected)
  const reopened = new LauncherCore(f.directory)
  await reopened.init()
  assert.equal(reopened.snapshot().settings.javaPath, '')
  assert.equal(reopened.snapshot().settings.manualJavaPath, selected)
})

test('runtime failure leaves the game unready and retry can finish without replacing settings', async t => {
  let attempts = 0
  const f = await fixture(t, async request => {
    if (++attempts === 1) throw new Error('simulated runtime checksum failure')
    return managed(request)
  })
  const instance = await f.core.createInstance({ name: 'Runtime retry', version: '1.20.1', loader: 'vanilla' })
  await assert.rejects(f.core.install(instance.id), /checksum failure/)
  assert.equal(f.core.snapshot().instances[0].status, 'error')
  await assert.rejects(fs.access(path.join(f.core.instanceDirectory(instance.id), 'installed.json')))
  assert.equal(f.requests.some(url => url.endsWith('/client.jar')), false)
  await f.core.install(instance.id)
  assert.equal(f.core.snapshot().instances[0].status, 'ready')
  assert.equal(f.core.snapshot().settings.javaPath, '')
})

test('cancelling during runtime preparation settles before game installation is released', async t => {
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  let settled = false
  const f = await fixture(t, async (_request, options) => {
    entered()
    try {
      await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }))
      throw new Error('unreachable')
    } finally { settled = true }
  })
  const instance = await f.core.createInstance({ name: 'Cancel runtime', version: '1.20.1', loader: 'vanilla' })
  const install = f.core.install(instance.id)
  const rejected = assert.rejects(install, /安装已取消/)
  await waiting
  f.core.cancelInstall(instance.id)
  await rejected
  assert.equal(settled, true)
  assert.equal(f.core.snapshot().instances[0].status, 'not-installed')
  await assert.rejects(fs.access(path.join(f.core.instanceDirectory(instance.id), 'installed.json')))
  assert.equal(f.spawns(), 0)
})

test('Java task events report bytes and cancellation; duplicate requests reuse the active task', async t => {
  const f = await fixture(t, async (request, options) => {
    options!.onProgress!({ phase: 'download', completedBytes: 12, totalBytes: 100 })
    await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }))
    return managed(request)
  })
  const task = f.core.startJavaInstall(21)
  assert.equal(f.core.startJavaInstall(21).id, task.id)
  assert.equal(f.provisions.length, 1)
  assert.equal(f.core.runtimeTasks()[0].completedBytes, 12)
  f.core.cancelJavaInstall(task.id)
  assert.equal(f.core.runtimeTasks()[0].status, 'cancelling')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.core.runtimeTasks()[0].status, 'cancelled')
  assert.equal(f.core.runtimeTasks()[0].error, undefined)
  assert.ok(f.events.some(event => event.type === 'javaTask' && event.task.status === 'cancelled'))
  for (const invalid of [8, 99, NaN, 17.5]) assert.throws(() => f.core.startJavaInstall(invalid), /请选择/)
})

test('Java completion is published only after the manager finishes and does not change explicit preferences', async t => {
  let complete!: () => void
  const gate = new Promise<void>(resolve => { complete = resolve })
  const f = await fixture(t, async (request, options) => {
    options?.onProgress?.({ phase: 'probe', completedBytes: 100, totalBytes: 100 })
    await gate
    return managed(request)
  })
  const selected = path.resolve('/retained-test/java')
  await f.core.updateSettings({ javaPath: selected })
  const task = f.core.startJavaInstall(17)
  assert.equal(f.core.runtimeTasks()[0].status, 'active')
  complete()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.core.runtimeTasks()[0].status, 'complete')
  assert.equal(f.core.runtimeTasks()[0].path, managed({ major: 17, component: components[17] }).path)
  assert.equal(f.core.snapshot().settings.javaPath, selected)
  assert.ok(f.events.some(event => event.type === 'javaTask' && event.task.id === task.id && event.task.phase.includes('检测')))
})

test('shutdown cancellation prevents a late runtime completion from spawning a game', async t => {
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(t, async request => {
    entered()
    await gate // Deliberately simulate a provider ignoring cancellation.
    return managed(request)
  })
  const instance = await f.core.createInstance({ name: 'Late completion', version: '1.20.1', loader: 'vanilla' })
  f.core.detectJava = async () => [localJava]
  await f.core.install(instance.id)
  f.core.detectJava = async () => []
  const launch = f.core.launch(instance.id, account)
  const rejected = assert.rejects(launch, /退出|取消/)
  await waiting
  f.core.cancelPendingOperations()
  release()
  await rejected
  assert.equal(f.spawns(), 0)
  assert.equal(f.core.snapshot().instances[0].status, 'ready')
})

test('old installed records recover the runtime component from verified official game metadata', async t => {
  const f = await fixture(t)
  const instance = await f.core.createInstance({ name: 'Legacy receipt', version: '1.20.1', loader: 'vanilla' })
  f.core.detectJava = async () => [localJava]
  await f.core.install(instance.id)
  const file = path.join(f.core.instanceDirectory(instance.id), 'installed.json')
  const installed = JSON.parse(await fs.readFile(file, 'utf8'))
  delete installed.version.javaVersion.component
  await fs.writeFile(file, JSON.stringify(installed))
  f.core.detectJava = async () => []
  await assert.rejects(f.core.launch(instance.id, account, () => { throw new Error('session changed before spawn') }), /session changed/)
  assert.equal(f.provisions[0].component, components[17])
  assert.equal(f.spawns(), 0)
})
