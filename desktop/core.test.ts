import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { LauncherCore, isSupportedVersion, mavenPath, offlineUuid, resolveArguments, rulesAllow, safeJoin, type CoreEvent } from './core'

const sha1 = (body: string) => createHash('sha1').update(body).digest('hex')
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const VERSION = 'https://piston-meta.mojang.com/test/1.20.1.json'
const INDEX = 'https://piston-meta.mojang.com/test/assets.json'
const CLIENT = 'https://piston-data.mojang.com/test/client.jar'
const LIBRARY = 'https://libraries.minecraft.net/test/library.jar'

function fixture(corruptClient = false) {
  const assetBody = 'a tiny but hash-checked asset'
  const indexBody = JSON.stringify({ objects: { 'sounds/test.ogg': { hash: sha1(assetBody), size: Buffer.byteLength(assetBody) } } })
  const versionBody = JSON.stringify({
    id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    javaVersion: { majorVersion: 17 },
    assetIndex: { id: '5', url: INDEX, sha1: sha1(indexBody), size: Buffer.byteLength(indexBody) },
    downloads: { client: { url: CLIENT, sha1: sha1('client jar'), size: 10 } },
    libraries: [{ name: 'test:library:1.0', downloads: { artifact: {
      url: LIBRARY, path: 'test/library/1.0/library-1.0.jar', sha1: sha1('test library'), size: 12,
    } } }],
    arguments: { jvm: ['-cp', '${classpath}'], game: ['--username', '${auth_player_name}'] },
  })
  const responses = new Map([
    [MANIFEST, JSON.stringify({ versions: [
      { id: '1.20.1', type: 'release', releaseTime: '2023-06-12T13:25:51Z', url: VERSION, sha1: sha1(versionBody) },
      { id: '1.19.4', type: 'release', releaseTime: '', url: VERSION, sha1: sha1(versionBody) },
      { id: '25w41a', type: 'snapshot', releaseTime: '', url: VERSION, sha1: sha1(versionBody) },
    ] })],
    [VERSION, versionBody], [INDEX, indexBody],
    [CLIENT, corruptClient ? 'bad client' : 'client jar'], [LIBRARY, 'test library'],
    [`https://resources.download.minecraft.net/${sha1(assetBody).slice(0, 2)}/${sha1(assetBody)}`, assetBody],
  ])
  const requests: string[] = []
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input)
    options?.signal?.throwIfAborted()
    requests.push(url)
    const body = responses.get(url)
    return body === undefined ? new Response('Not found', { status: 404 }) : new Response(body)
  }
  return { responses, requests, fetcher }
}

function fabricFixture() {
  const fake = fixture()
  const jarUrl = 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar'
  fake.responses.set('https://meta.fabricmc.net/v2/versions/loader/1.20.1', JSON.stringify([{ loader: { version: '0.16.10', stable: true } }]))
  fake.responses.set('https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.16.10/profile/json', JSON.stringify({
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.10', url: 'https://maven.fabricmc.net/' }],
    arguments: { jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '], game: [] },
  }))
  fake.responses.set(jarUrl, 'fabric loader')
  fake.responses.set(`${jarUrl}.sha1`, sha1('fabric loader'))
  return fake
}

function modFixture() {
  const fake = fabricFixture()
  const addMod = (id: string, project: string, body: string, dependencies: unknown[] = [], gameVersions = ['1.20.1']) => {
    const url = `https://cdn.modrinth.com/data/${project}/versions/${id}/${id}.jar`
    fake.responses.set(`https://api.modrinth.com/v2/version/${id}`, JSON.stringify({
      id, project_id: project, name: id, game_versions: gameVersions, loaders: ['fabric'], dependencies,
      files: [{ url, filename: `${id}.jar`, primary: true, size: body.length, hashes: { sha1: sha1(body) } }],
    }))
    fake.responses.set(url, body)
    return url
  }
  return { ...fake, addMod }
}

function processHarness(failures = 0) {
  const children: ChildProcess[] = []
  const spawnFake = (() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 1000 + children.length, stdout: new PassThrough(), stderr: new PassThrough(),
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        queueMicrotask(() => child.emit('close', null, signal))
        return true
      },
    }) as unknown as ChildProcess
    children.push(child)
    queueMicrotask(() => {
      if (failures-- > 0) child.emit('error', new Error('simulated spawn failure'))
      else child.emit('spawn')
    })
    return child
  }) as typeof spawn
  return { children, spawn: spawnFake }
}

const offlineAccount = { mode: 'offline' as const, username: 'LuaTest', uuid: '', accessToken: '' }
const testRuntime = { path: '/fake/java', version: '17.0.12', major: 17, arch: 'x64' }

async function assertNoStaging(core: LauncherCore, id: string) {
  assert.equal((await fs.readdir(core.instanceDirectory(id))).some(file => file.startsWith('.mod-staging-')), false)
}

test('remote paths cannot escape the launcher directory', () => {
  const root = path.join(os.tmpdir(), 'launcher-path-test')
  for (const relative of ['../outside', 'a/../../outside', '/etc/passwd', 'C:\\Windows', 'a\\..\\outside', 'a/./b', 'file\0name', 'file:stream']) {
    assert.throws(() => safeJoin(root, relative))
  }
  assert.equal(safeJoin(root, 'libraries/org/test.jar'), path.join(root, 'libraries/org/test.jar'))
  assert.throws(() => mavenPath('org.example:../../escape:1.0'))
  assert.equal(mavenPath('org.lwjgl:lwjgl:3.3.1:natives-macos-arm64'), 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-macos-arm64.jar')
})

test('OS, CPU and feature rules follow Mojang ordered allow/disallow semantics', () => {
  assert.equal(rulesAllow(undefined), true)
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'windows' } }], 'darwin', 'arm64'), false)
  assert.equal(rulesAllow([
    { action: 'allow' },
    { action: 'disallow', os: { name: 'osx' } },
  ], 'darwin', 'arm64'), false)
  assert.equal(rulesAllow([{ action: 'allow', os: { arch: 'aarch64' } }], 'darwin', 'arm64'), true)
  assert.equal(rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], 'linux', 'x64'), false)
})

test('argument substitution preserves spaces and excludes optional unsupported features', () => {
  assert.deepEqual(resolveArguments([
    '--gameDir', '${game_directory}',
    { rules: [{ action: 'allow', features: { is_quick_play_singleplayer: true } }], value: ['--quickPlaySingleplayer', '${quickPlaySingleplayer}'] },
    { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-XstartOnFirstThread' },
  ], { game_directory: '/Users/test/My Games' }, 'darwin', 'arm64'), [
    '--gameDir', '/Users/test/My Games', '-XstartOnFirstThread',
  ])
  assert.throws(() => resolveArguments(['${unknown}'], {}), /未支持的变量/)
})

test('offline identities are stable UUID v3 values and advertised releases are modern', () => {
  assert.equal(offlineUuid('Steve'), '5627dd98e6be3c21b8a8e92344183641')
  assert.equal(offlineUuid('Steve').length, 32)
  assert.equal(isSupportedVersion('1.20'), false)
  assert.equal(isSupportedVersion('1.20.1'), true)
  assert.equal(isSupportedVersion('1.21.11'), true)
  assert.equal(isSupportedVersion('26.1'), true)
  assert.equal(isSupportedVersion('26.1-rc.1'), false)
})

test('installer downloads verified files, persists ready state, and reuses its cache', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  const events: CoreEvent[] = []
  const core = new LauncherCore(directory, event => events.push(event), { fetch: fake.fetcher, platform: 'darwin', arch: 'arm64' })
  await core.init()
  assert.deepEqual((await core.versions()).map(v => v.id), ['1.20.1'])
  const instance = await core.createInstance({ name: 'Test world', version: '1.20.1', loader: 'vanilla' })
  await core.install(instance.id)
  assert.equal(core.snapshot().instances[0].status, 'ready')
  assert.equal(await fs.readFile(path.join(directory, 'versions/1.20.1/1.20.1.jar'), 'utf8'), 'client jar')
  assert.equal(core.getInstancePath(instance.id), path.join(directory, 'instances', instance.id, 'game'))
  const firstDownloadCount = fake.requests.length
  await core.install(instance.id)
  assert.equal(fake.requests.length, firstDownloadCount)
  assert(events.some(event => event.type === 'progress' && event.phase === '安装完成' && event.total === event.completed))
  const reopened = new LauncherCore(directory, undefined, { fetch: fake.fetcher })
  await reopened.init()
  assert.equal(reopened.snapshot().instances[0].id, instance.id)
  assert.equal(reopened.snapshot().instances[0].status, 'ready')
  assert.throws(() => core.getInstancePath('../../escape'), /实例不存在/)
})

test('corrupt downloads never become installed artifacts and can be retried', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-corrupt-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture(true)
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher })
  await core.init()
  const instance = await core.createInstance({ name: 'Broken download', version: '1.20.1', loader: 'vanilla' })
  await assert.rejects(core.install(instance.id), /SHA-1/)
  assert.equal(core.snapshot().instances[0].status, 'error')
  await assert.rejects(fs.access(path.join(directory, 'versions/1.20.1/1.20.1.jar')))
  fake.responses.set(CLIENT, 'client jar')
  await core.install(instance.id)
  assert.equal(core.snapshot().instances[0].status, 'ready')
})

test('cancellation settles all workers and leaves an instance that can resume', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-cancel-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  let release!: () => void
  const reachedClient = new Promise<void>(resolve => { release = resolve })
  const slowFetch: typeof fetch = async (input, options) => {
    if (String(input) === CLIENT) {
      release()
      await new Promise<void>((_, reject) => {
        if (options?.signal?.aborted) return reject(options.signal.reason)
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
    }
    return fake.fetcher(input, options)
  }
  const core = new LauncherCore(directory, undefined, { fetch: slowFetch })
  await core.init()
  const instance = await core.createInstance({ name: 'Cancel test', version: '1.20.1', loader: 'vanilla' })
  const installing = core.install(instance.id)
  const rejects = assert.rejects(installing, /安装已取消/)
  await reachedClient
  core.cancelInstall(instance.id)
  await rejects
  assert.equal(core.snapshot().instances[0].status, 'not-installed')
  const reopened = new LauncherCore(directory, undefined, { fetch: fake.fetcher })
  await reopened.init()
  await reopened.install(instance.id)
  assert.equal(reopened.snapshot().instances[0].status, 'ready')
})

test('Fabric installation merges the loader profile and verifies Maven libraries', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-fabric-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fabricFixture()
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher })
  await core.init()
  const instance = await core.createInstance({ name: 'Fabric world', version: '1.20.1', loader: 'fabric' })
  await core.install(instance.id)
  const installed = JSON.parse(await fs.readFile(path.join(directory, 'instances', instance.id, 'installed.json'), 'utf8'))
  assert.equal(core.snapshot().instances[0].loaderVersion, '0.16.10')
  assert.equal(installed.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient')
  assert(installed.classpath.includes('libraries/net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar'))
})

test('Modrinth required dependencies are verified, and managed upgrades remove only the previous version', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-mods-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = modFixture()
  const { addMod } = fake
  addMod('dependency1', 'api', 'api jar')
  addMod('modv1', 'example', 'example v1', [{ dependency_type: 'required', version_id: 'dependency1' }])
  addMod('modv2', 'example', 'example v2', [{ dependency_type: 'required', version_id: 'dependency1' }])
  addMod('incompatible', 'wrong', 'wrong jar', [], ['1.21.1'])
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher })
  await core.init()
  const instance = await core.createInstance({ name: 'Mod world', version: '1.20.1', loader: 'fabric' })
  await core.install(instance.id)
  await core.installMod(instance.id, 'modv1')
  const mods = path.join(core.getInstancePath(instance.id), 'mods')
  await fs.writeFile(path.join(mods, 'manually-added.jar'), 'keep me')
  assert.equal(await fs.readFile(path.join(mods, 'dependency1.jar'), 'utf8'), 'api jar')
  await core.installMod(instance.id, 'modv2')
  assert.deepEqual((await fs.readdir(mods)).sort(), ['dependency1.jar', 'manually-added.jar', 'modv2.jar'])
  await assert.rejects(core.installMod(instance.id, 'incompatible'), /不兼容/)
  assert.equal(core.snapshot().instances[0].status, 'ready')
  await assertNoStaging(core, instance.id)
})

test('one launch owns an instance while Java detection is pending', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-launch-lock-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  const processes = processHarness()
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher, spawn: processes.spawn, platform: 'linux', arch: 'x64' })
  await core.init()
  const instance = await core.createInstance({ name: 'Launch lock', version: '1.20.1', loader: 'vanilla' })
  await core.install(instance.id)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const detecting = new Promise<void>(resolve => { entered = resolve })
  let detections = 0
  core.detectJava = async () => { detections++; entered(); await gate; return [testRuntime] }
  const first = core.launch(instance.id, offlineAccount)
  await detecting
  await assert.rejects(core.launch(instance.id, offlineAccount), /正在启动/)
  await assert.rejects(core.install(instance.id), /启动中的游戏/)
  assert.equal(detections, 1)
  assert.equal(processes.children.length, 0)
  release()
  await first
  assert.equal(processes.children.length, 1)
  assert.equal(core.snapshot().instances[0].status, 'running')
  const closed = once(processes.children[0], 'close')
  core.stop(instance.id)
  await closed
  await core.updateSettings({})
  assert.equal(core.snapshot().instances[0].status, 'ready')
  assert.equal(core.snapshot().instances[0].error, undefined)
})

test('a failed prelaunch releases its reservation so the same instance can retry', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-launch-retry-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  const processes = processHarness()
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher, spawn: processes.spawn, platform: 'linux', arch: 'x64' })
  await core.init()
  const instance = await core.createInstance({ name: 'Launch retry', version: '1.20.1', loader: 'vanilla' })
  await core.install(instance.id)
  core.detectJava = async () => []
  await assert.rejects(core.launch(instance.id, offlineAccount), /需要 Java 17/)
  core.detectJava = async () => [testRuntime]
  await core.launch(instance.id, offlineAccount)
  assert.equal(processes.children.length, 1)
  const closed = once(processes.children[0], 'close')
  core.stop(instance.id)
  await closed
  await core.updateSettings({})
})

test('a late close from a failed child cannot erase a newer running process', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-child-owner-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  const processes = processHarness(1)
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher, spawn: processes.spawn, platform: 'linux', arch: 'x64' })
  await core.init()
  const instance = await core.createInstance({ name: 'Child ownership', version: '1.20.1', loader: 'vanilla' })
  await core.install(instance.id)
  core.detectJava = async () => [testRuntime]
  await assert.rejects(core.launch(instance.id, offlineAccount), /simulated spawn failure/)
  await core.launch(instance.id, offlineAccount)
  processes.children[0].emit('close', 1, null)
  assert.equal(core.snapshot().instances[0].status, 'running')
  const closed = once(processes.children[1], 'close')
  core.stop(instance.id)
  await closed
  await core.updateSettings({})
  assert.equal(core.snapshot().instances[0].status, 'ready')
})

test('unexpected crash signals are reported instead of being treated as normal stops', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-crash-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  const processes = processHarness()
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher, spawn: processes.spawn, platform: 'linux', arch: 'x64' })
  await core.init()
  const instance = await core.createInstance({ name: 'Crash signals', version: '1.20.1', loader: 'vanilla' })
  await core.install(instance.id)
  core.detectJava = async () => [testRuntime]
  for (const signal of ['SIGSEGV', 'SIGABRT', 'SIGKILL']) {
    await core.launch(instance.id, offlineAccount)
    processes.children.at(-1)!.emit('close', null, signal)
    await core.updateSettings({})
    assert.match(core.snapshot().instances[0].error ?? '', new RegExp(signal))
  }
})

test('a failed dependency download leaves installed mods and their registry unchanged', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-mod-failure-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = modFixture()
  fake.addMod('old', 'example', 'old jar')
  fake.addMod('new', 'example', 'new jar', [{ dependency_type: 'required', version_id: 'dependency' }])
  const dependencyUrl = fake.addMod('dependency', 'api', 'dep jar')
  fake.responses.set(dependencyUrl, 'bad jar')
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher })
  await core.init()
  const instance = await core.createInstance({ name: 'Failed dependency', version: '1.20.1', loader: 'fabric' })
  await core.install(instance.id)
  await core.installMod(instance.id, 'old')
  const registryPath = path.join(core.instanceDirectory(instance.id), 'managed-mods.json')
  const registry = await fs.readFile(registryPath, 'utf8')
  await assert.rejects(core.installMod(instance.id, 'new'), /SHA-1/)
  const mods = path.join(core.getInstancePath(instance.id), 'mods')
  assert.deepEqual(await fs.readdir(mods), ['old.jar'])
  assert.equal(await fs.readFile(path.join(mods, 'old.jar'), 'utf8'), 'old jar')
  assert.equal(await fs.readFile(registryPath, 'utf8'), registry)
  assert.equal(core.snapshot().instances[0].status, 'ready')
  await assertNoStaging(core, instance.id)
})

test('cancelling a mod download keeps the prior complete installation launchable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-mod-cancel-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = modFixture()
  fake.addMod('old', 'example', 'old jar')
  fake.addMod('new', 'example', 'new jar', [{ dependency_type: 'required', version_id: 'dependency' }])
  const dependencyUrl = fake.addMod('dependency', 'api', 'dep jar')
  let entered!: () => void
  const downloadingDependency = new Promise<void>(resolve => { entered = resolve })
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url) === dependencyUrl) {
      entered()
      await new Promise<void>((_, reject) => {
        if (options?.signal?.aborted) return reject(options.signal.reason)
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
    }
    return fake.fetcher(url, options)
  }
  const core = new LauncherCore(directory, undefined, { fetch: fetcher })
  await core.init()
  const instance = await core.createInstance({ name: 'Cancelled dependency', version: '1.20.1', loader: 'fabric' })
  await core.install(instance.id)
  await core.installMod(instance.id, 'old')
  const registryPath = path.join(core.instanceDirectory(instance.id), 'managed-mods.json')
  const registry = await fs.readFile(registryPath, 'utf8')
  const pending = core.installMod(instance.id, 'new')
  const rejected = assert.rejects(pending, /安装已取消/)
  await downloadingDependency
  const mods = path.join(core.getInstancePath(instance.id), 'mods')
  assert.deepEqual(await fs.readdir(mods), ['old.jar'])
  core.cancelInstall(instance.id)
  await rejected
  assert.deepEqual(await fs.readdir(mods), ['old.jar'])
  assert.equal(await fs.readFile(registryPath, 'utf8'), registry)
  assert.equal(core.snapshot().instances[0].status, 'ready')
  await assertNoStaging(core, instance.id)
})

test('a commit failure after placing a new jar restores the old jars and registry', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-mod-rollback-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = modFixture()
  fake.addMod('old', 'example', 'old jar')
  fake.addMod('new', 'example', 'new jar', [{ dependency_type: 'required', version_id: 'dependency' }])
  fake.addMod('dependency', 'api', 'dep jar')
  let sawPartialCommit = false
  const renameFile: typeof fs.rename = async (from, to) => {
    if (path.basename(String(from)) === 'dependency.jar' && path.basename(path.dirname(String(from))) === 'files') {
      assert.equal(await fs.readFile(path.join(path.dirname(String(to)), 'new.jar'), 'utf8'), 'new jar')
      sawPartialCommit = true
      throw new Error('simulated disk failure during commit')
    }
    await fs.rename(from, to)
  }
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher, renameFile })
  await core.init()
  const instance = await core.createInstance({ name: 'Commit rollback', version: '1.20.1', loader: 'fabric' })
  await core.install(instance.id)
  await core.installMod(instance.id, 'old')
  const registryPath = path.join(core.instanceDirectory(instance.id), 'managed-mods.json')
  const registry = await fs.readFile(registryPath, 'utf8')
  await assert.rejects(core.installMod(instance.id, 'new'), /simulated disk failure/)
  assert.equal(sawPartialCommit, true)
  const mods = path.join(core.getInstancePath(instance.id), 'mods')
  assert.deepEqual(await fs.readdir(mods), ['old.jar'])
  assert.equal(await fs.readFile(path.join(mods, 'old.jar'), 'utf8'), 'old jar')
  assert.equal(await fs.readFile(registryPath, 'utf8'), registry)
  assert.equal(core.snapshot().instances[0].status, 'ready')
  await assertNoStaging(core, instance.id)
})

test('metadata cannot redirect the downloader into a local service', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-redirect-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const requests: string[] = []
  const fetcher: typeof fetch = async input => {
    requests.push(String(input))
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } })
  }
  const core = new LauncherCore(directory, undefined, { fetch: fetcher })
  await core.init()
  await assert.rejects(core.versions(), /不允许的下载来源/)
  assert.deepEqual(requests, [MANIFEST])
})
