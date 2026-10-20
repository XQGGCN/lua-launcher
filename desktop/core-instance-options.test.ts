import assert from 'node:assert/strict'
import type { ChildProcess, spawn, SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test, { type TestContext } from 'node:test'
import { LauncherCore, type CoreEvent, type JavaRuntime, type LaunchAccount } from './core'
import { InstanceOptionsError } from './instance-options'

type CoreOptions = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
const MIB = 1024 * 1024
const MAIN_CLASS = 'net.minecraft.client.main.Main'
const runtime: JavaRuntime = {
  path: path.join(os.tmpdir(), 'lua-unit-test-java', process.platform === 'win32' ? 'java.exe' : 'java'),
  major: 17, version: '17.0.12', arch: process.arch,
}
// Only the injected fake process can receive these fictitious credentials.
const account: LaunchAccount = {
  mode: 'microsoft', username: 'OptionsTest',
  uuid: '0123456789abcdef0123456789abcdef', accessToken: 'fictitious-options-test-token',
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}

function networkFixture(): typeof fetch {
  const sha1 = (text: string) => createHash('sha1').update(text).digest('hex')
  const versionUrl = 'https://piston-meta.mojang.com/options-test/1.20.1.json'
  const assetsUrl = 'https://piston-meta.mojang.com/options-test/assets.json'
  const clientUrl = 'https://piston-data.mojang.com/options-test/client.jar'
  const libraryUrl = 'https://libraries.minecraft.net/test/options/1.0/options-1.0.jar'
  const assets = JSON.stringify({ objects: {} })
  const client = 'verified options test client; never executed'
  const library = 'verified options test library; never executed'
  const version = JSON.stringify({
    id: '1.20.1', type: 'release', mainClass: MAIN_CLASS,
    javaVersion: { majorVersion: 17, component: 'java-runtime-gamma' },
    assetIndex: { id: '5', url: assetsUrl, sha1: sha1(assets), size: Buffer.byteLength(assets) },
    downloads: { client: { url: clientUrl, sha1: sha1(client), size: Buffer.byteLength(client) } },
    libraries: [{
      name: 'test:options:1.0',
      downloads: { artifact: {
        path: 'test/options/1.0/options-1.0.jar',
        url: libraryUrl, sha1: sha1(library), size: Buffer.byteLength(library),
      } },
    }],
    arguments: {
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
      game: [
        '--username', '${auth_player_name}', '--accessToken', '${auth_access_token}',
        { rules: [{ action: 'allow', features: { has_custom_resolution: true } }],
          value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] },
      ],
    },
  })
  const responses = new Map([
    ['https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', JSON.stringify({
      versions: [{ id: '1.20.1', type: 'release', releaseTime: '2023-06-12T13:25:51Z',
        url: versionUrl, sha1: sha1(version), size: Buffer.byteLength(version) }],
    })],
    [versionUrl, version], [assetsUrl, assets], [clientUrl, client], [libraryUrl, library],
  ])
  return async (input, options) => {
    options?.signal?.throwIfAborted()
    const url = String(input)
    assert.ok(responses.has(url), `Unexpected network request in isolated fixture: ${url}`)
    return new Response(responses.get(url))
  }
}

function processHarness() {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions; child: ChildProcess }> = []
  const spawned = deferred()
  const spawnFake = ((command: string, args: string[], options: SpawnOptions) => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      pid: 8000 + calls.length,
      stdout, stderr,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        queueMicrotask(() => { stdout.end(); stderr.end(); child.emit('close', null, signal) })
        return true
      },
    }) as unknown as ChildProcess
    calls.push({ command, args: [...args], options: { ...options, env: { ...options.env } }, child })
    spawned.resolve()
    queueMicrotask(() => child.emit('spawn'))
    return child
  }) as typeof spawn
  return { calls, spawn: spawnFake, firstSpawn: spawned.promise }
}

async function fixture(t: TestContext, overrides: CoreOptions = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-instance-options-'))
  const processes = processHarness()
  const events: CoreEvent[] = []
  const provisioned: unknown[] = []
  const options: CoreOptions = {
    fetch: networkFixture(), spawn: processes.spawn, platform: process.platform, arch: process.arch,
    memorySystem: { totalmem: () => 32768 * MIB, freemem: () => 24576 * MIB, platform: () => 'linux' },
    javaRuntimeManager: {
      discover: async () => [],
      ensure: async request => {
        provisioned.push(request)
        throw new Error('Unexpected runtime download: fixture must explicitly select or supply Java')
      },
    },
    ...overrides,
  }
  const core = new LauncherCore(directory, event => events.push(event), options)
  await core.init()
  core.detectJava = async () => [runtime]
  const stop = async (id: string) => {
    if (core.snapshot().instances.find(instance => instance.id === id)?.status !== 'running') return
    const gameDirectory = core.getInstancePath(id)
    const child = [...processes.calls].reverse().find(call => call.options.cwd === gameDirectory)?.child
    assert.ok(child)
    const closed = once(child, 'close')
    core.stop(id)
    await closed
    // Flush the close listener's serialized state save before another operation.
    await core.updateSettings({})
  }
  t.after(async () => {
    try {
      for (const instance of core.snapshot().instances) await stop(instance.id)
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })
  const create = async (name = 'Instance options', install = true) => {
    const instance = await core.createInstance({ name, version: '1.20.1', loader: 'vanilla' })
    if (install) await core.install(instance.id)
    return instance
  }
  const reopen = async () => {
    const reopened = new LauncherCore(directory, undefined, options)
    reopened.detectJava = async () => [runtime]
    await reopened.init()
    return reopened
  }
  return { directory, core, processes, events, provisioned, create, reopen, stop }
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  assert.notEqual(index, -1, `Missing ${flag}`)
  assert.ok(index < args.length - 1, `Missing value after ${flag}`)
  return args[index + 1]
}

test('schema 1 bare java commands migrate to canonical automatic settings without losing a remembered manual path', async t => {
  const f = await fixture(t)
  const instance = await f.create('Legacy Java preference', false)
  const file = path.join(f.directory, 'launcher.json')
  const old = JSON.parse(await fs.readFile(file, 'utf8'))
  old.settings.javaPath = 'java'
  old.settings.manualJavaPath = 'java'
  await fs.writeFile(file, JSON.stringify(old))
  const reopened = await f.reopen()
  assert.equal(reopened.snapshot().settings.javaPath, '')
  assert.equal(reopened.snapshot().settings.manualJavaPath, '')
  assert.equal(reopened.instanceOptions(instance.id).values.javaPath, '')
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(persisted.settings.javaPath, '')
  persisted.settings.javaPath = 'java'
  persisted.settings.manualJavaPath = runtime.path
  await fs.writeFile(file, JSON.stringify(persisted))
  const remembered = await f.reopen()
  assert.equal(remembered.snapshot().settings.javaPath, '')
  assert.equal(remembered.snapshot().settings.manualJavaPath, runtime.path)
})
function heap(args: string[]) { return args.filter(argument => argument.startsWith('-Xmx')) }
async function persisted(directory: string) {
  return JSON.parse(await fs.readFile(path.join(directory, 'launcher.json'), 'utf8'))
}

test('instance overrides inherit by field, reset to globals, and survive renaming/restart without moving game data', async t => {
  const { core, directory, create, reopen } = await fixture(t)
  const instance = await create()
  const gameDirectory = core.getInstancePath(instance.id)
  await fs.writeFile(path.join(gameDirectory, 'keep-world.txt'), 'world content')
  await core.updateSettings({
    memoryMode: 'manual', memoryMb: 6144, windowWidth: 1600, windowHeight: 900,
    jvmArgs: ['-Dglobal.setting=hello world'],
  })
  assert.equal(core.instanceOptions(instance.id).sources.memoryMb, 'global')
  assert.equal(core.instanceOptions(instance.id).sources.fullscreen, 'default')
  await core.updateInstanceSettings(instance.id, {
    name: '  Renamed / display only  ', options: { memoryMb: 8192, windowHeight: 1080, jvmArgs: [] },
  })
  const resolved = core.instanceOptions(instance.id)
  assert.equal(resolved.values.memoryMode, 'manual')
  assert.equal(resolved.values.memoryMb, 8192)
  assert.equal(resolved.values.windowWidth, 1600)
  assert.equal(resolved.values.windowHeight, 1080)
  assert.deepEqual(resolved.values.jvmArgs, [])
  assert.equal(resolved.sources.memoryMode, 'global')
  assert.equal(resolved.sources.memoryMb, 'instance')
  assert.equal(core.snapshot().instances[0].name, 'Renamed / display only')
  assert.equal(core.getInstancePath(instance.id), gameDirectory)
  assert.equal(await fs.readFile(path.join(gameDirectory, 'keep-world.txt'), 'utf8'), 'world content')
  const reopened = await reopen()
  assert.deepEqual(reopened.instanceOptions(instance.id), resolved)
  assert.equal(reopened.getInstancePath(instance.id), gameDirectory)
  await reopened.updateInstanceSettings(instance.id, { name: 'Renamed again', options: {} })
  assert.equal(reopened.instanceOptions(instance.id).values.memoryMb, 6144)
  assert.equal(reopened.instanceOptions(instance.id).sources.memoryMb, 'global')
  assert.deepEqual(reopened.instanceOptions(instance.id).values.jvmArgs, ['-Dglobal.setting=hello world'])
  assert.deepEqual((await persisted(directory)).instances[0].options, {})
  assert.deepEqual(await fs.readdir(path.join(directory, 'instances')), [instance.id])
})

test('instance Java selection honors a manual path and explicit automatic mode overrides global manual Java', async t => {
  const { core, create, processes, stop, provisioned } = await fixture(t)
  const instance = await create()
  const globalJava = { ...runtime, path: path.join(path.dirname(runtime.path), 'global java', path.basename(runtime.path)) }
  const instanceJava = { ...runtime, path: path.join(path.dirname(runtime.path), 'instance java', path.basename(runtime.path)) }
  const detected: Array<string | undefined> = []
  core.detectJava = async additionalPath => {
    detected.push(additionalPath)
    return [runtime, globalJava, instanceJava]
  }
  await core.updateSettings({ javaPath: globalJava.path })
  await core.updateInstanceSettings(instance.id, {
    name: instance.name, options: { javaPath: instanceJava.path, manualJavaPath: instanceJava.path },
  })
  await core.install(instance.id)
  await core.launch(instance.id, account)
  assert.equal(processes.calls.at(-1)!.command, instanceJava.path)
  assert.deepEqual(detected, [instanceJava.path, instanceJava.path])
  await stop(instance.id)
  await core.updateInstanceSettings(instance.id, {
    name: instance.name, options: { javaPath: '', manualJavaPath: instanceJava.path },
  })
  await core.launch(instance.id, account)
  assert.equal(processes.calls.at(-1)!.command, runtime.path)
  assert.equal(detected.at(-1), '')
  assert.equal(core.instanceOptions(instance.id).sources.javaPath, 'instance')
  assert.equal(core.snapshot().settings.javaPath, globalJava.path)
  assert.equal(core.instanceOptions(instance.id).values.manualJavaPath, instanceJava.path)
  assert.equal(provisioned.length, 0)
})

test('an unavailable explicit instance Java fails without falling back or changing the saved preference', async t => {
  const { core, create, processes, provisioned } = await fixture(t)
  const instance = await create()
  const missing = path.join(path.dirname(runtime.path), 'missing', path.basename(runtime.path))
  await core.updateInstanceSettings(instance.id, { name: instance.name, options: { javaPath: missing } })
  await assert.rejects(core.launch(instance.id, account), /指定的 Java 路径不可用/)
  assert.equal(processes.calls.length, 0)
  assert.equal(provisioned.length, 0)
  assert.equal(core.instanceOptions(instance.id).values.javaPath, missing)
  assert.equal(core.snapshot().instances[0].status, 'ready')
})

test('custom JVM argv retain boundaries before the main class, while managed heap/classpath/native flags remain authoritative', async t => {
  const { core, create, directory, processes } = await fixture(t)
  const instance = await create()
  const custom = ['-XX:+UseG1GC', '-Ddemo.message=hello world;$(not-a-shell)', '--add-opens', 'java.base/java.lang=ALL-UNNAMED']
  await core.updateInstanceSettings(instance.id, { name: instance.name, options: { jvmArgs: custom, memoryMode: 'manual', memoryMb: 7168 } })
  await core.launch(instance.id, account)
  const { args, options } = processes.calls[0]
  assert.deepEqual(heap(args), ['-Xmx7168M'])
  const customIndex = args.indexOf(custom[0])
  assert.deepEqual(args.slice(customIndex, customIndex + custom.length), custom)
  assert.equal(args.indexOf(MAIN_CLASS), customIndex + custom.length)
  assert.equal(args.filter(arg => arg === '-cp').length, 1)
  assert.deepEqual(valueAfter(args, '-cp').split(path.delimiter), [
    path.join(directory, 'libraries/test/options/1.0/options-1.0.jar'),
    path.join(directory, 'versions/1.20.1/1.20.1.jar'),
  ])
  assert.deepEqual(args.filter(arg => arg.startsWith('-Djava.library.path=')), [
    `-Djava.library.path=${path.join(directory, 'instances', instance.id, 'natives')}`,
  ])
  assert.equal(options.shell, false)
  assert.equal(valueAfter(args, '--accessToken'), account.accessToken)
})

test('production settings API rejects heap/classpath/entry/auth overrides and invalid argv without saving any changes', async t => {
  const { core, directory, create } = await fixture(t)
  const instance = await create()
  const original = await fs.readFile(path.join(directory, 'launcher.json'))
  const invalidArguments = [
    ['-Xmx32G'], ['-XX:MaxRAMPercentage=95'], ['-cp', 'foreign.jar'], ['--class-path=foreign.jar'],
    ['-jar', 'foreign.jar'], ['@arguments.txt'], ['-Djava.library.path=/foreign'],
    ['-Dauth_access_token=foreign'], ['--add-opens'], ['-XX:+UseG1GC -Xmx16G'],
    ['-Ddemo=first\n-Xmx32G'], Array.from({ length: 65 }, () => '-Xint'), [`-Ddemo=${'x'.repeat(8192)}`],
  ]
  for (const jvmArgs of invalidArguments) {
    await assert.rejects(core.updateInstanceSettings(instance.id, {
      name: 'Must not persist', options: { jvmArgs },
    }), InstanceOptionsError)
  }
  await assert.rejects(core.updateInstanceSettings(instance.id, { name: 'No', options: { javaPath: 'java -Xmx4G' } }), InstanceOptionsError)
  assert.equal(core.snapshot().instances[0].name, instance.name)
  assert.equal(core.snapshot().instances[0].options, undefined)
  assert.deepEqual(await fs.readFile(path.join(directory, 'launcher.json')), original)
})

test('two instances resolve separate memory/window preferences and explicit fullscreen writes an exact backup', async t => {
  const { core, create, directory, processes } = await fixture(t)
  const first = await create('First')
  const second = await create('Second')
  await core.updateSettings({ memoryMode: 'manual', memoryMb: 4096, windowWidth: 1600, windowHeight: 900, fullscreen: true })
  await core.updateInstanceSettings(first.id, {
    name: first.name, options: { memoryMb: 8192, windowWidth: 1920, windowHeight: 1080, fullscreen: false },
  })
  const original = Buffer.from('unknown:keep:with:colons\r\nfullscreen:true\r\nmusic:0.5\r\n')
  await fs.writeFile(path.join(core.getInstancePath(first.id), 'options.txt'), original)
  await core.launch(first.id, account)
  await core.launch(second.id, account)
  const firstCall = processes.calls[0]
  const secondCall = processes.calls[1]
  assert.deepEqual(heap(firstCall.args), ['-Xmx8192M'])
  assert.deepEqual(heap(secondCall.args), ['-Xmx4096M'])
  assert.equal(valueAfter(firstCall.args, '--width'), '1920')
  assert.equal(valueAfter(firstCall.args, '--height'), '1080')
  assert.equal(valueAfter(secondCall.args, '--width'), '1600')
  assert.equal(valueAfter(secondCall.args, '--height'), '900')
  assert.equal(firstCall.args.includes('--fullscreen'), false)
  assert.equal(secondCall.args.filter(arg => arg === '--fullscreen').length, 1)
  assert.equal(await fs.readFile(path.join(core.getInstancePath(first.id), 'options.txt'), 'utf8'),
    'unknown:keep:with:colons\r\nfullscreen:false\r\nmusic:0.5\r\n')
  assert.equal(await fs.readFile(path.join(core.getInstancePath(second.id), 'options.txt'), 'utf8'), 'fullscreen:true\n')
  const backups = path.join(directory, 'instances', first.id, 'backups/window-options')
  const files = await fs.readdir(backups)
  assert.equal(files.length, 1)
  assert.deepEqual(await fs.readFile(path.join(backups, files[0])), original)
  assert.equal(core.instanceOptions(second.id).sources.memoryMb, 'global')
  assert.equal(core.instanceOptions(first.id).sources.memoryMb, 'instance')
})

test('unset fullscreen preserves existing game options and makes no backup, while default resolution still reaches Java', async t => {
  const { core, create, directory, processes } = await fixture(t)
  const instance = await create()
  const file = path.join(core.getInstancePath(instance.id), 'options.txt')
  const original = Buffer.from('fullscreen:true\nunknown:do not touch\n')
  await fs.writeFile(file, original)
  const before = await fs.stat(file)
  await core.launch(instance.id, account)
  assert.equal(core.instanceOptions(instance.id).sources.fullscreen, 'default')
  assert.deepEqual(await fs.readFile(file), original)
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs)
  await assert.rejects(fs.access(path.join(directory, 'instances', instance.id, 'backups')), { code: 'ENOENT' })
  assert.equal(valueAfter(processes.calls[0].args, '--width'), '1280')
  assert.equal(valueAfter(processes.calls[0].args, '--height'), '720')
  assert.equal(processes.calls[0].args.includes('--fullscreen'), false)
})

test('settings cannot change while an instance is installing, preparing its launch, or running', async t => {
  const { core, create, stop, processes } = await fixture(t)
  const instance = await create('Busy', false)
  const installEntered = deferred()
  const releaseInstall = deferred()
  core.detectJava = async () => { installEntered.resolve(); await releaseInstall.promise; return [runtime] }
  const installing = core.install(instance.id)
  await installEntered.promise
  try {
    await assert.rejects(core.updateInstanceSettings(instance.id, { name: 'Changed', options: { memoryMb: 8192 } }), /安装|关闭/)
  } finally { releaseInstall.resolve() }
  await installing
  const launchEntered = deferred()
  const releaseLaunch = deferred()
  core.detectJava = async () => { launchEntered.resolve(); await releaseLaunch.promise; return [runtime] }
  const launching = core.launch(instance.id, account)
  await launchEntered.promise
  try {
    assert.equal(processes.calls.length, 0)
    await assert.rejects(core.updateInstanceSettings(instance.id, { name: 'Changed', options: {} }), /安装|关闭/)
  } finally { releaseLaunch.resolve() }
  await launching
  await assert.rejects(core.updateInstanceSettings(instance.id, { name: 'Changed', options: {} }), /安装|关闭/)
  await stop(instance.id)
  await core.updateInstanceSettings(instance.id, { name: 'After close', options: { memoryMb: 8192 } })
  assert.equal(core.snapshot().instances[0].name, 'After close')
})

test('failed instance persistence never publishes candidate values or leaks them into a concurrent global save', async t => {
  let block = false
  const entered = deferred()
  const release = deferred()
  const { core, directory, create, reopen } = await fixture(t, {
    stateRename: async (source, target) => {
      if (block) {
        block = false
        entered.resolve()
        await release.promise
        throw Object.assign(new Error('simulated state commit failure'), { code: 'EIO' })
      }
      await fs.rename(source, target)
    },
  })
  const instance = await create()
  block = true
  const failed = assert.rejects(core.updateInstanceSettings(instance.id, {
    name: 'Never committed', options: { memoryMb: 8192, fullscreen: true },
  }), { code: 'EIO' })
  await entered.promise
  try {
    assert.equal(core.snapshot().instances[0].name, instance.name)
    assert.equal(core.snapshot().instances[0].options, undefined)
    assert.equal(core.instanceOptions(instance.id).values.memoryMb, 4096)
    await assert.rejects(core.launch(instance.id, account), /保存/)
    await assert.rejects(core.install(instance.id), /保存/)
    await assert.rejects(core.installMod(instance.id, 'not-fetched-while-settings-save'), /保存/)
    await assert.rejects(core.updateInstanceSettings(instance.id, { name: 'Also blocked', options: {} }), /保存/)
  } finally { release.resolve() }
  const globalSave = core.updateSettings({ memoryMb: 6144 })
  await Promise.all([failed, globalSave])
  assert.equal(core.snapshot().settings.memoryMb, 6144)
  assert.equal(core.snapshot().instances[0].name, instance.name)
  assert.equal(core.snapshot().instances[0].options, undefined)
  const disk = await persisted(directory)
  assert.equal(disk.instances[0].name, instance.name)
  assert.equal(disk.instances[0].options, undefined)
  assert.equal(disk.settings.memoryMb, 6144)
  assert.deepEqual((await reopen()).snapshot().instances[0].options, undefined)
  assert.deepEqual((await fs.readdir(directory)).filter(file => file.endsWith('.tmp')), [])
  await core.updateInstanceSettings(instance.id, { name: 'Retry succeeds', options: { memoryMb: 7168 } })
  assert.equal(core.instanceOptions(instance.id).values.memoryMb, 7168)
})

test('pending global settings remain invisible to concurrent launch, and a failed save cannot contaminate later global writes', async t => {
  let block = false
  const entered = deferred()
  const release = deferred()
  const { core, directory, create, processes } = await fixture(t, {
    stateRename: async (source, target) => {
      if (block) {
        block = false
        entered.resolve()
        await release.promise
        throw Object.assign(new Error('simulated global commit failure'), { code: 'EIO' })
      }
      await fs.rename(source, target)
    },
  })
  const instance = await create()
  await core.updateSettings({ memoryMode: 'manual', memoryMb: 4096 })
  const uncommittedJava = { ...runtime, path: path.join(path.dirname(runtime.path), 'uncommitted', path.basename(runtime.path)) }
  core.detectJava = async () => [runtime, uncommittedJava]
  block = true
  const failed = assert.rejects(core.updateSettings({
    javaPath: uncommittedJava.path, memoryMb: 12288, fullscreen: true,
  }), { code: 'EIO' })
  await entered.promise
  let launching: ReturnType<LauncherCore['launch']> | undefined
  try {
    assert.equal(core.snapshot().settings.javaPath, '')
    assert.equal(core.snapshot().settings.memoryMb, 4096)
    assert.equal(core.instanceOptions(instance.id).values.memoryMb, 4096)
    launching = core.launch(instance.id, account)
    // Spawn occurs before launch's queued persistence. Also observe early failures.
    await Promise.race([processes.firstSpawn, launching])
    assert.equal(processes.calls[0].command, runtime.path)
    assert.deepEqual(heap(processes.calls[0].args), ['-Xmx4096M'])
    assert.equal(processes.calls[0].args.includes('--fullscreen'), false)
  } finally { release.resolve() }
  const succeeding = core.updateSettings({ concurrentDownloads: 3 })
  await Promise.all([failed, launching, succeeding])
  const disk = await persisted(directory)
  assert.equal(disk.settings.memoryMb, 4096)
  assert.equal(disk.settings.javaPath, '')
  assert.equal(disk.settings.fullscreen, undefined)
  assert.equal(disk.settings.concurrentDownloads, 3)
})

test('failure of the first installation state save releases the lock and permits a successful retry', async t => {
  let failNext = false
  const { core, create } = await fixture(t, {
    stateRename: async (source, target) => {
      if (failNext) {
        failNext = false
        throw Object.assign(new Error('simulated initial installation save failure'), { code: 'EIO' })
      }
      await fs.rename(source, target)
    },
  })
  const instance = await create('Retry installation', false)
  failNext = true
  await assert.rejects(core.install(instance.id), /simulated initial installation save failure/)
  await core.updateInstanceSettings(instance.id, { name: 'Can edit after failure', options: {} })
  await core.install(instance.id)
  assert.equal(core.snapshot().instances[0].status, 'ready')
})

test('an install started during a pending failed global save selects the last committed Java preference', async t => {
  let block = false
  const entered = deferred()
  const release = deferred()
  const { core, create } = await fixture(t, {
    stateRename: async (source, target) => {
      if (block) {
        block = false
        entered.resolve()
        await release.promise
        throw Object.assign(new Error('simulated global commit failure'), { code: 'EIO' })
      }
      await fs.rename(source, target)
    },
  })
  const instance = await create('Install with committed preferences', false)
  const uncommittedJava = { ...runtime, path: path.join(path.dirname(runtime.path), 'not-committed', path.basename(runtime.path)) }
  const selections: Array<string | undefined> = []
  core.detectJava = async additionalPath => {
    selections.push(additionalPath)
    return [runtime, uncommittedJava]
  }
  block = true
  const failed = assert.rejects(core.updateSettings({ javaPath: uncommittedJava.path }), { code: 'EIO' })
  await entered.promise
  const installing = core.install(instance.id)
  release.resolve()
  await Promise.all([failed, installing])
  assert.deepEqual(selections, [''])
  assert.equal(core.snapshot().settings.javaPath, '')
  assert.equal(core.snapshot().instances[0].status, 'ready')
})

test('spawn environment strips Java option injection without altering the host environment', async t => {
  const names = ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH'] as const
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  t.after(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })
  for (const name of names) process.env[name] = `must-not-reach-java-${name}`
  const { core, create, processes } = await fixture(t)
  const instance = await create()
  await core.launch(instance.id, account)
  const environment = processes.calls[0].options.env!
  for (const name of names) {
    assert.equal(Object.hasOwn(environment, name), false)
    assert.equal(process.env[name], `must-not-reach-java-${name}`)
  }
  assert.equal(environment.PATH, process.env.PATH)
  assert.equal(processes.calls[0].options.shell, false)
})

test('Windows spawn environment also strips case-insensitive Java injection variable names', async t => {
  const blocked = new Set(['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH'])
  const original = Object.entries(process.env).filter(([name]) => blocked.has(name.toUpperCase()))
  const clear = () => {
    for (const name of Object.keys(process.env)) if (blocked.has(name.toUpperCase())) delete process.env[name]
  }
  t.after(() => {
    clear()
    for (const [name, value] of original) process.env[name] = value
  })
  clear()
  const variants = ['java_tool_options', 'Jdk_Java_Options', '_java_OPTIONS', 'classPath']
  for (const name of variants) process.env[name] = `must-not-reach-java-${name}`
  // Exercise Windows process semantics on every CI host, without running Java.
  const { core, create, processes } = await fixture(t, { platform: 'win32' })
  const instance = await create()
  await core.launch(instance.id, account)
  assert.deepEqual(Object.keys(processes.calls[0].options.env!).filter(name => blocked.has(name.toUpperCase())), [])
  for (const name of variants) assert.equal(process.env[name], `must-not-reach-java-${name}`)
})
