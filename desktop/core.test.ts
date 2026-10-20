import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { LauncherCore, isSupportedVersion, mavenPath, resolveArguments, rulesAllow, safeJoin, type CoreEvent, type LaunchAccount } from './core'

const sha1 = (body: string) => createHash('sha1').update(body).digest('hex')
const packHashes = (body: string | Buffer) => ({
  sha1: createHash('sha1').update(body).digest('hex'), sha512: createHash('sha512').update(body).digest('hex'),
})
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
    arguments: {
      jvm: ['-cp', '${classpath}', '-Dminecraft.launcher.version=${launcher_version}'],
      game: [
        '--username', '${auth_player_name}', '--uuid', '${auth_uuid}',
        '--accessToken', '${auth_access_token}', '--userType', '${user_type}',
        '--clientId', '${clientid}', '--xuid', '${auth_xuid}',
      ],
    },
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
  const calls: Array<{ command: string; args: string[] }> = []
  const spawnFake = ((command: string, args: string[]) => {
    calls.push({ command, args: [...args] })
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
  return { children, calls, spawn: spawnFake }
}

// Fictitious credentials are used only with the injected fake process.
const microsoftAccount: LaunchAccount = {
  mode: 'microsoft', username: 'LuaTest', uuid: '0123456789abcdef0123456789abcdef',
  accessToken: 'fictitious-minecraft-access-token', clientId: '11111111-2222-4333-8444-555555555555',
  xuid: '1234567890123456',
}
const testRuntime = { path: '/fake/java', version: '17.0.12', major: 17, arch: 'x64' }

async function assertNoStaging(core: LauncherCore, id: string) {
  assert.equal((await fs.readdir(core.instanceDirectory(id))).some(file => file.startsWith('.mod-staging-')), false)
}

function packDownload(filePath: string, body: string, extra: Record<string, unknown> = {}) {
  return { path: filePath, downloads: [`https://cdn.modrinth.com/packs/${filePath}`],
    hashes: packHashes(body), fileSize: Buffer.byteLength(body), ...extra }
}
function testPack(files: unknown[] = [], overrides: Record<string, string> = {}, dependencies: Record<string, string> = {
  minecraft: '1.20.1', 'fabric-loader': '0.16.10',
}): Buffer {
  const zip = new AdmZip()
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1, game: 'minecraft', name: 'Test Modpack', versionId: '1.0',
    dependencies, files,
  })))
  for (const [name, body] of Object.entries(overrides)) zip.addFile(name, Buffer.from(body))
  return zip.toBuffer()
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

test('advertised releases are modern stable versions', () => {
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
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher, spawn: processes.spawn, memorySystem: { totalmem: () => 16 * 1024 ** 3, freemem: () => 12 * 1024 ** 3 }, platform: 'linux', arch: 'x64' })
  await core.init()
  const instance = await core.createInstance({ name: 'Launch lock', version: '1.20.1', loader: 'vanilla' })
  await core.install(instance.id)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const detecting = new Promise<void>(resolve => { entered = resolve })
  let detections = 0
  core.detectJava = async () => { detections++; entered(); await gate; return [testRuntime] }
  const first = core.launch(instance.id, microsoftAccount)
  await detecting
  await assert.rejects(core.launch(instance.id, microsoftAccount), /正在启动/)
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

test('launch rejects offline and invalid credentials before preparing Java', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-online-only-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  const processes = processHarness()
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher, spawn: processes.spawn, memorySystem: { totalmem: () => 16 * 1024 ** 3, freemem: () => 12 * 1024 ** 3 }, platform: 'linux', arch: 'x64' })
  await core.init()
  const instance = await core.createInstance({ name: 'Microsoft credentials', version: '1.20.1', loader: 'vanilla' })
  await core.install(instance.id)
  let detections = 0
  core.detectJava = async () => { detections++; return [testRuntime] }
  const invalid: unknown[] = [
    null, undefined, { ...microsoftAccount, mode: 'offline' },
    { ...microsoftAccount, accessToken: '0' }, { ...microsoftAccount, accessToken: '' },
    { ...microsoftAccount, accessToken: ' ' }, { ...microsoftAccount, accessToken: 'bad\ntoken' },
    { ...microsoftAccount, accessToken: 123 }, { ...microsoftAccount, uuid: '' },
    { ...microsoftAccount, uuid: 123 }, { ...microsoftAccount, uuid: `${microsoftAccount.uuid}-` },
    { ...microsoftAccount, username: '' },
  ]
  for (const account of invalid) {
    await assert.rejects(core.launch(instance.id, account as LaunchAccount), /Microsoft|微软账户/)
  }
  assert.equal(detections, 0)
  assert.equal(processes.children.length, 0)
  assert.equal(core.snapshot().instances[0].status, 'ready')
  await core.launch(instance.id, microsoftAccount)
  assert.equal(processes.children.length, 1, 'invalid requests release the launch reservation')
  const closed = once(processes.children[0], 'close')
  core.stop(instance.id)
  await closed
  await core.updateSettings({})
})

test('the final session guard blocks a logout during preparation and releases the launch reservation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-session-guard-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  const processes = processHarness()
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher, spawn: processes.spawn, memorySystem: { totalmem: () => 16 * 1024 ** 3, freemem: () => 12 * 1024 ** 3 }, platform: 'linux', arch: 'x64' })
  await core.init()
  const instance = await core.createInstance({ name: 'Session guard', version: '1.20.1', loader: 'vanilla' })
  await core.install(instance.id)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const detecting = new Promise<void>(resolve => { entered = resolve })
  core.detectJava = async () => { entered(); await gate; return [testRuntime] }
  let generation = 1
  const authorizedGeneration = generation
  let guardCalls = 0
  const guardError = new Error('session changed before spawn')
  const pending = core.launch(instance.id, microsoftAccount, () => {
    guardCalls++
    if (generation !== authorizedGeneration) throw guardError
  })
  const rejected = assert.rejects(pending, error => error === guardError)
  await detecting
  generation++ // The coordinator increments this immediately on logout.
  release()
  await rejected
  assert.equal(guardCalls, 1)
  assert.equal(processes.children.length, 0)
  assert.equal(core.snapshot().instances[0].status, 'ready')

  core.detectJava = async () => [testRuntime]
  let retriedGuard = false
  await core.launch(instance.id, microsoftAccount, () => { retriedGuard = true })
  assert.equal(retriedGuard, true)
  assert.equal(processes.children.length, 1)
  const args = processes.calls[0].args
  const argument = (flag: string) => args[args.indexOf(flag) + 1]
  assert.equal(argument('--username'), microsoftAccount.username)
  assert.equal(argument('--uuid'), microsoftAccount.uuid)
  assert.equal(argument('--accessToken'), microsoftAccount.accessToken)
  assert.equal(argument('--userType'), 'msa')
  assert.equal(argument('--clientId'), microsoftAccount.clientId)
  assert.equal(argument('--xuid'), microsoftAccount.xuid)
  assert.ok(args.includes('-Dminecraft.launcher.version=0.3.0'))
  const closed = once(processes.children[0], 'close')
  core.stop(instance.id)
  await closed
  await core.updateSettings({})
})

test('a failed prelaunch releases its reservation so the same instance can retry', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-launch-retry-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  const processes = processHarness()
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher, spawn: processes.spawn, memorySystem: { totalmem: () => 16 * 1024 ** 3, freemem: () => 12 * 1024 ** 3 }, platform: 'linux', arch: 'x64' })
  await core.init()
  const instance = await core.createInstance({ name: 'Launch retry', version: '1.20.1', loader: 'vanilla' })
  await core.install(instance.id)
  core.detectJava = async () => []
  await assert.rejects(core.launch(instance.id, microsoftAccount), /需要 Java 17/)
  core.detectJava = async () => [testRuntime]
  await core.launch(instance.id, microsoftAccount)
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
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher, spawn: processes.spawn, memorySystem: { totalmem: () => 16 * 1024 ** 3, freemem: () => 12 * 1024 ** 3 }, platform: 'linux', arch: 'x64' })
  await core.init()
  const instance = await core.createInstance({ name: 'Child ownership', version: '1.20.1', loader: 'vanilla' })
  await core.install(instance.id)
  core.detectJava = async () => [testRuntime]
  await assert.rejects(core.launch(instance.id, microsoftAccount), /simulated spawn failure/)
  await core.launch(instance.id, microsoftAccount)
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
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher, spawn: processes.spawn, memorySystem: { totalmem: () => 16 * 1024 ** 3, freemem: () => 12 * 1024 ** 3 }, platform: 'linux', arch: 'x64' })
  await core.init()
  const instance = await core.createInstance({ name: 'Crash signals', version: '1.20.1', loader: 'vanilla' })
  await core.install(instance.id)
  core.detectJava = async () => [testRuntime]
  for (const signal of ['SIGSEGV', 'SIGABRT', 'SIGKILL']) {
    await core.launch(instance.id, microsoftAccount)
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

test('local modpack import pins its Fabric version and becomes ready only after client files and overrides', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-pack-local-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fabricFixture()
  fake.responses.set('https://meta.fabricmc.net/v2/versions/loader/1.20.1', JSON.stringify([
    { loader: { version: '0.19.5', stable: true } }, { loader: { version: '0.16.10', stable: true } },
  ]))
  const client = packDownload('mods/client.jar', 'client mod')
  const server = packDownload('mods/server.jar', 'server mod', { env: { client: 'unsupported', server: 'required' } })
  fake.responses.set(client.downloads[0], 'client mod')
  const archiveFile = path.join(directory, 'import.mrpack')
  await fs.writeFile(archiveFile, testPack([client, server], {
    'overrides/config/example.json': 'common', 'client-overrides/config/example.json': 'client',
    'server-overrides/config/server.json': 'server',
  }))
  const readyEvents: boolean[] = []
  const core = new LauncherCore(path.join(directory, 'data'), event => {
    if (event.type === 'state') readyEvents.push(event.snapshot.instances.some(instance => instance.status === 'ready'))
  }, { fetch: fake.fetcher })
  await core.init()
  const result = await core.importModpack(archiveFile, { name: 'My pack' })
  const instance = result.instances[0]
  assert.equal(instance.status, 'ready')
  assert.equal(instance.loaderVersion, '0.16.10')
  assert.equal(instance.modpack?.applied, true)
  assert.deepEqual(readyEvents, [false, false, false, true])
  assert.equal(await fs.readFile(path.join(core.getInstancePath(instance.id), 'mods/client.jar'), 'utf8'), 'client mod')
  assert.equal(await fs.readFile(path.join(core.getInstancePath(instance.id), 'config/example.json'), 'utf8'), 'client')
  await assert.rejects(fs.access(path.join(core.getInstancePath(instance.id), 'config/server.json')))
  assert.equal(fake.requests.includes(server.downloads[0]), false)
  assert(fake.requests.includes('https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.16.10/profile/json'))
  assert.equal(fake.requests.some(url => url.endsWith('/0.19.5/profile/json')), false)
})

test('cancelled modpack imports retain their source and retry successfully after an app restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-pack-cancel-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fabricFixture()
  const file = packDownload('mods/client.jar', 'client mod')
  fake.responses.set(file.downloads[0], 'client mod')
  const archiveFile = path.join(directory, 'source.mrpack')
  await fs.writeFile(archiveFile, testPack([file]))
  let entered!: () => void
  const downloadingPackFile = new Promise<void>(resolve => { entered = resolve })
  const slowFetch: typeof fetch = async (url, options) => {
    if (String(url) === file.downloads[0]) {
      entered()
      await new Promise<void>((_, reject) => {
        if (options?.signal?.aborted) return reject(options.signal.reason)
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
    }
    return fake.fetcher(url, options)
  }
  const core = new LauncherCore(path.join(directory, 'data'), undefined, { fetch: slowFetch })
  await core.init()
  const pending = core.importModpack(archiveFile)
  const rejected = assert.rejects(pending, /安装已取消/)
  await downloadingPackFile
  const instance = core.snapshot().instances[0]
  assert.equal(instance.status, 'installing')
  core.cancelInstall(instance.id)
  await rejected
  assert.equal(core.snapshot().instances[0].status, 'not-installed')
  assert.equal(core.snapshot().instances[0].modpack?.applied, false)
  await fs.rm(archiveFile)
  const reopened = new LauncherCore(path.join(directory, 'data'), undefined, { fetch: fake.fetcher })
  await reopened.init()
  await reopened.install(instance.id)
  assert.equal(reopened.snapshot().instances[0].status, 'ready')
  assert.equal(reopened.snapshot().instances[0].modpack?.applied, true)
  assert.equal(await fs.readFile(path.join(reopened.getInstancePath(instance.id), file.path), 'utf8'), 'client mod')
  assert.equal((await fs.readdir(reopened.instanceDirectory(instance.id))).some(name => name.startsWith('.pack-staging-')), false)
})

test('pack files require SHA-512 as well as SHA-1 and failed imports never publish a ready instance', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-pack-hash-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  const file = packDownload('mods/untrusted.jar', 'jar body', {
    hashes: { sha1: sha1('jar body'), sha512: '0'.repeat(128) },
  })
  fake.responses.set(file.downloads[0], 'jar body')
  const archiveFile = path.join(directory, 'bad-hash.mrpack')
  await fs.writeFile(archiveFile, testPack([file], {}, { minecraft: '1.20.1' }))
  const core = new LauncherCore(path.join(directory, 'data'), undefined, { fetch: fake.fetcher })
  await core.init()
  await assert.rejects(core.importModpack(archiveFile), /SHA-512/)
  const instance = core.snapshot().instances[0]
  assert.equal(instance.status, 'error')
  assert.equal(instance.modpack?.applied, false)
  await assert.rejects(fs.access(path.join(core.getInstancePath(instance.id), file.path)))
  await fs.access(path.join(core.instanceDirectory(instance.id), 'pack.mrpack'))
})

test('online modpack installs verify the archive and expose a cancellable download task', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-pack-online-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  const contents = testPack([], { 'overrides/options.txt': 'fullscreen:false' }, { minecraft: '1.20.1' })
  const archiveUrl = 'https://cdn.modrinth.com/data/pack/versions/pack1/test.mrpack'
  fake.responses.set('https://api.modrinth.com/v2/version/pack1', JSON.stringify({
    id: 'pack1', project_id: 'testpack', name: 'Online Pack', game_versions: ['1.20.1'], loaders: ['minecraft'],
    files: [{ filename: 'test.mrpack', url: archiveUrl, primary: true, size: contents.length, hashes: packHashes(contents) }],
    dependencies: [],
  }))
  const events: CoreEvent[] = []
  const fetcher: typeof fetch = (input, options) => String(input) === archiveUrl
    ? Promise.resolve(new Response(new Uint8Array(contents))) : fake.fetcher(input, options)
  const core = new LauncherCore(directory, event => events.push(event), { fetch: fetcher })
  await core.init()
  const result = await core.installModpack('pack1', { name: 'Online copy' })
  assert.equal(result.instances[0].status, 'ready')
  assert.equal(result.instances[0].modpack?.source, 'modrinth')
  assert.equal(result.instances[0].modpack?.projectId, 'testpack')
  assert.equal(result.instances[0].modpack?.modrinthVersionId, 'pack1')
  assert(events.some(event => event.type === 'progress' && event.instanceId === 'modpack-pack1'))
  assert.equal(await fs.readFile(path.join(core.getInstancePath(result.instances[0].id), 'options.txt'), 'utf8'), 'fullscreen:false')
})

test('online pack cancellation interrupts archive, manifest, and Fabric preparation and permits a retry', { timeout: 5000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-pack-preparation-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const archiveUrl = 'https://cdn.modrinth.com/data/pack/versions/pack1/test.mrpack'
  const fabricUrl = 'https://meta.fabricmc.net/v2/versions/loader/1.20.1'
  for (const [index, blockedUrl] of [archiveUrl, MANIFEST, fabricUrl].entries()) {
    const fake = fabricFixture()
    const contents = testPack()
    fake.responses.set('https://api.modrinth.com/v2/version/pack1', JSON.stringify({
      id: 'pack1', project_id: 'testpack', name: 'Online Pack', game_versions: ['1.20.1'], loaders: ['fabric'],
      files: [{ filename: 'test.mrpack', url: archiveUrl, primary: true, size: contents.length, hashes: packHashes(contents) }],
      dependencies: [],
    }))
    let entered!: () => void
    const preparationStarted = new Promise<void>(resolve => { entered = resolve })
    let block = true
    let observedAbort = false
    const fetcher: typeof fetch = async (input, options) => {
      if (block && String(input) === blockedUrl) {
        entered()
        await new Promise<void>((_, reject) => {
          const abort = () => { observedAbort = true; reject(options?.signal?.reason) }
          if (options?.signal?.aborted) abort()
          else options?.signal?.addEventListener('abort', abort, { once: true })
        })
      }
      return String(input) === archiveUrl ? new Response(new Uint8Array(contents)) : fake.fetcher(input, options)
    }
    const core = new LauncherCore(path.join(directory, String(index)), undefined, { fetch: fetcher })
    await core.init()
    const pending = core.installModpack('pack1')
    const rejected = assert.rejects(pending, /安装已取消/)
    await preparationStarted
    core.cancelInstall('modpack-pack1')
    await rejected
    assert.equal(observedAbort, true, `request must receive cancellation: ${blockedUrl}`)
    assert.deepEqual(core.snapshot().instances, [])
    block = false
    const result = await core.installModpack('pack1')
    assert.equal(result.instances.length, 1)
    assert.equal(result.instances[0].status, 'ready')
    assert.equal(result.instances[0].loaderVersion, '0.16.10')
  }
})

test('unsupported modpacks are inspectable but rejected before creating an instance or downloading game files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-pack-unsupported-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const archiveFile = path.join(directory, 'quilt.mrpack')
  await fs.writeFile(archiveFile, testPack([], {}, { minecraft: '1.20.1', 'quilt-loader': '0.26.0' }))
  const fake = fixture()
  const core = new LauncherCore(path.join(directory, 'data'), undefined, { fetch: fake.fetcher })
  await core.init()
  assert.match((await core.inspectModpack(archiveFile)).unsupportedReason ?? '', /quilt-loader/)
  await assert.rejects(core.importModpack(archiveFile), /quilt-loader/)
  assert.deepEqual(core.snapshot().instances, [])
  assert.deepEqual(fake.requests, [])
})

test('modpack commit failure rolls back changed files and the saved package supports retry', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-pack-rollback-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fixture()
  const file = packDownload('mods/client.jar', 'client mod')
  fake.responses.set(file.downloads[0], 'client mod')
  const archiveFile = path.join(directory, 'test.mrpack')
  await fs.writeFile(archiveFile, testPack([file], { 'overrides/config/example.json': 'new config' }, { minecraft: '1.20.1' }))
  let failCommit = true
  let partialCommitObserved = false
  const renameFile: typeof fs.rename = async (from, to) => {
    if (failCommit && String(from).includes('.pack-staging-') && String(from).includes(`${path.sep}files${path.sep}config${path.sep}`)) {
      partialCommitObserved = true
      throw new Error('simulated pack commit failure')
    }
    await fs.rename(from, to)
  }
  const core = new LauncherCore(path.join(directory, 'data'), undefined, { fetch: fake.fetcher, renameFile })
  await core.init()
  await assert.rejects(core.importModpack(archiveFile), /simulated pack commit failure/)
  const instance = core.snapshot().instances[0]
  assert.equal(partialCommitObserved, true)
  assert.equal(instance.status, 'error')
  await assert.rejects(fs.access(path.join(core.getInstancePath(instance.id), file.path)))
  failCommit = false
  await fs.rm(archiveFile)
  await core.install(instance.id)
  assert.equal(core.snapshot().instances[0].status, 'ready')
  assert.equal(await fs.readFile(path.join(core.getInstancePath(instance.id), 'config/example.json'), 'utf8'), 'new config')
})

test('Fabric selection and modpack version lists only offer supported configurations', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-pack-versions-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fabricFixture()
  const version = { id: 'a', project_id: 'example', game_versions: ['1.20.1'], loaders: ['fabric'], files: [{ filename: 'pack.mrpack' }] }
  fake.responses.set('https://api.modrinth.com/v2/project/example/version?include_changelog=false', JSON.stringify([
    version, { ...version, id: 'old', game_versions: ['1.19.4'] }, { ...version, id: 'forge', loaders: ['forge'] },
    { ...version, id: 'wrong-file', files: [{ filename: 'something.jar' }] },
  ]))
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher })
  await core.init()
  assert.deepEqual(await core.fabricVersions('1.20.1'), [{ version: '0.16.10', stable: true }])
  assert.deepEqual((await core.modpackVersions('example')).map(version => version.id), ['a', 'forge'])
  await assert.rejects(core.createInstance({ name: 'Wrong loader', version: '1.20.1', loader: 'fabric', loaderVersion: '99.0.0' }), /不支持所选/)
})

test('BBSMC searches use their own API and external versions remain visible with official-page guidance', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-bbsmc-search-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fabricFixture()
  const searchUrls: URL[] = []
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input))
    if (url.hostname === 'api.bbsmc.net' && url.pathname === '/v2/search') {
      searchUrls.push(url)
      return new Response(JSON.stringify({ hits: [{ project_id: 'shared', title: '中文资源' }], offset: 0, limit: 20, total_hits: 1 }))
    }
    return fake.fetcher(input, options)
  }
  const external = { id: 'drive', project_id: 'shared', name: '网盘版本', game_versions: ['1.20.1'], loaders: ['fabric'],
    disk_only: true, files: [{ filename: '', hashes: {}, size: 0, url: 'https://pan.quark.cn/s/example' }], dependencies: [] }
  fake.responses.set('https://api.bbsmc.net/v2/project/shared/version?include_changelog=false', JSON.stringify([external]))
  fake.responses.set('https://api.bbsmc.net/v2/version/drive', JSON.stringify(external))
  const core = new LauncherCore(directory, undefined, { fetch: fetcher })
  await core.init()
  assert.equal((await core.searchMods('中文', { source: 'bbsmc', loader: 'fabric' })).hits[0].source, 'bbsmc')
  await core.searchModpacks('', { source: 'bbsmc' })
  assert(searchUrls.every(url => url.hostname === 'api.bbsmc.net'))
  assert.equal(searchUrls[0].searchParams.get('query'), '中文')
  assert.deepEqual(JSON.parse(searchUrls[1].searchParams.get('facets')!), [
    ['project_type:modpack'], ['categories:fabric', 'categories:forge', 'categories:neoforge', 'categories:minecraft', 'categories:vanilla'],
  ])
  const versions = await core.modpackVersions('shared', 'bbsmc')
  assert.equal(versions.length, 1)
  assert.equal(versions[0].externalOnly, true)
  assert.match(versions[0].externalReason ?? '', /网盘/)
  assert.equal(versions[0].projectUrl, 'https://bbsmc.net/modpack/shared')
  await assert.rejects(core.installModpack('drive', { source: 'bbsmc' }), /官网/)
  assert.deepEqual(core.snapshot().instances, [])
  assert.equal(fake.requests.some(url => url.includes('quark')), false)
  await assert.rejects(core.searchMods('', { source: 'unknown' as 'bbsmc' }), /无效的资源来源/)
})

test('provider-qualified mod registries preserve colliding project IDs, legacy records, and same-source dependencies', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-bbsmc-registry-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = modFixture()
  fake.addMod('mr1', 'shared', 'modrinth first')
  fake.addMod('mr2', 'shared', 'modrinth second')
  const addBbs = (id: string, project: string, dependencies: unknown[] = [], filename = `${id}.jar`) => {
    const body = `bbsmc ${id}`
    const url = `https://cdn.bbsmc.net/bbsmc/data/${project}/versions/${id}/${filename}`
    fake.responses.set(`https://api.bbsmc.net/v2/version/${id}`, JSON.stringify({
      id, project_id: project, name: id, game_versions: ['1.20.1'], loaders: ['fabric'], dependencies,
      files: [{ url, filename, primary: true, size: body.length, hashes: packHashes(body) }],
    }))
    fake.responses.set(url, body)
  }
  addBbs('dep1', 'dependency')
  addBbs('bbs1', 'shared', [{ dependency_type: 'required', project_id: 'dependency' }])
  addBbs('bbs2', 'shared', [{ dependency_type: 'required', version_id: 'dep1' }])
  addBbs('collision', 'other', [], 'mr2.jar')
  const dependency = JSON.parse(fake.responses.get('https://api.bbsmc.net/v2/version/dep1')!)
  const params = new URLSearchParams({ loaders: '["fabric"]', game_versions: '["1.20.1"]' })
  fake.responses.set(`https://api.bbsmc.net/v2/project/dependency/version?${params}`, JSON.stringify([dependency]))
  const core = new LauncherCore(directory, undefined, { fetch: fake.fetcher })
  await core.init()
  const instance = await core.createInstance({ name: 'Multiple sources', version: '1.20.1', loader: 'fabric' })
  await core.install(instance.id)
  await core.installMod(instance.id, 'mr1')
  const registryFile = path.join(core.instanceDirectory(instance.id), 'managed-mods.json')
  const firstRegistry = JSON.parse(await fs.readFile(registryFile, 'utf8'))
  // Simulate the v0.2.0 registry so migration is exercised during a different-source install.
  await fs.writeFile(registryFile, JSON.stringify({ shared: firstRegistry['modrinth:shared'] }))
  await core.installMod(instance.id, 'bbs1', 'bbsmc')
  const mods = path.join(core.getInstancePath(instance.id), 'mods')
  assert.deepEqual((await fs.readdir(mods)).sort(), ['bbs1.jar', 'dep1.jar', 'mr1.jar'])
  await core.installMod(instance.id, 'mr2')
  await core.installMod(instance.id, 'bbs2', 'bbsmc')
  assert.deepEqual((await fs.readdir(mods)).sort(), ['bbs2.jar', 'dep1.jar', 'mr2.jar'])
  const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'))
  assert.equal(registry['modrinth:shared'].versionId, 'mr2')
  assert.equal(registry['bbsmc:shared'].versionId, 'bbs2')
  assert.equal(registry['bbsmc:dependency'].versionId, 'dep1')
  assert.equal(registry.shared, undefined)
  assert(fake.requests.includes(`https://api.bbsmc.net/v2/project/dependency/version?${params}`))
  assert.equal(fake.requests.some(url => url.startsWith('https://api.modrinth.com/') && url.includes('dep1')), false)
  await assert.rejects(core.installMod(instance.id, 'collision', 'bbsmc'), /其他来源或项目/)
  assert.equal(await fs.readFile(path.join(mods, 'mr2.jar'), 'utf8'), 'modrinth second')
  await assertNoStaging(core, instance.id)
})

test('BBSMC rejects permissions, untrusted redirects, and incorrect strong hashes without changing installed files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-bbsmc-download-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fabricFixture()
  const artifactUrl = 'https://cdn.bbsmc.net/bbsmc/data/example/versions/test/test.jar'
  const version = { id: 'test', project_id: 'example', name: 'Test', loaders: ['fabric'], game_versions: ['1.20.1'],
    dependencies: [], files: [{ filename: 'test.jar', primary: true, url: artifactUrl, size: 4, hashes: packHashes('body') }] }
  fake.responses.set('https://api.bbsmc.net/v2/version/test', JSON.stringify(version))
  let mode = 'forbidden'
  const requests: string[] = []
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input)
    requests.push(url)
    if (mode === 'forbidden' && url === 'https://api.bbsmc.net/v2/version/test') return new Response(null, { status: 403 })
    if (url === artifactUrl && mode === 'verification') {
      return new Response('<script src="/_guard/html.js?js=captcha_html"></script>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (url === artifactUrl && mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } })
    if (url === artifactUrl) return new Response('body')
    return fake.fetcher(input, options)
  }
  const core = new LauncherCore(directory, undefined, { fetch: fetcher })
  await core.init()
  const instance = await core.createInstance({ name: 'Verified BBSMC', version: '1.20.1', loader: 'fabric' })
  await core.install(instance.id)
  await assert.rejects(core.installMod(instance.id, 'test', 'bbsmc'), /登录、购买或访问权限.*bbsmc.net/)
  mode = 'verification'
  const beforeVerification = requests.filter(url => url === artifactUrl).length
  await assert.rejects(core.installMod(instance.id, 'test', 'bbsmc'), /网页验证.*官网/)
  assert.equal(requests.filter(url => url === artifactUrl).length - beforeVerification, 1, 'browser verification must not be retried')
  mode = 'redirect'
  await assert.rejects(core.installMod(instance.id, 'test', 'bbsmc'), /不允许的下载来源/)
  assert.equal(requests.some(url => url.includes('127.0.0.1')), false)
  mode = 'corrupt'
  version.files[0].hashes.sha512 = '0'.repeat(128)
  fake.responses.set('https://api.bbsmc.net/v2/version/test', JSON.stringify(version))
  await assert.rejects(core.installMod(instance.id, 'test', 'bbsmc'), /SHA-512/)
  await assert.rejects(fs.access(path.join(core.getInstancePath(instance.id), 'mods/test.jar')))
  assert.equal(core.snapshot().instances[0].status, 'ready')
  await assertNoStaging(core, instance.id)
})

test('BBSMC mrpack downloads can cancel by source-specific task ID and install verified BBSMC content on retry', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-bbsmc-pack-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fake = fabricFixture()
  const client = packDownload('mods/client.jar', 'client mod', { downloads: ['https://cdn.bbsmc.net/bbsmc/client.jar'] })
  fake.responses.set(client.downloads[0], 'client mod')
  const contents = testPack([client], { 'overrides/options.txt': 'fullscreen:false' })
  const archiveUrl = 'https://cdn.bbsmc.net/bbsmc/data/pack/versions/pack1/test.mrpack'
  const modrinthArchiveUrl = 'https://cdn.modrinth.com/data/pack/versions/pack1/test.mrpack'
  fake.responses.set('https://api.bbsmc.net/v2/version/pack1', JSON.stringify({
    id: 'pack1', project_id: 'testpack', name: 'BBSMC Pack', game_versions: ['1.20.1'], loaders: ['fabric'],
    files: [{ filename: 'test.mrpack', url: archiveUrl, primary: true, size: contents.length, hashes: packHashes(contents) }],
    dependencies: [],
  }))
  fake.responses.set('https://api.modrinth.com/v2/version/pack1', JSON.stringify({
    id: 'pack1', project_id: 'testpack', name: 'Modrinth Pack', game_versions: ['1.20.1'], loaders: ['fabric'],
    files: [{ filename: 'test.mrpack', url: modrinthArchiveUrl, primary: true, size: contents.length, hashes: packHashes(contents) }],
    dependencies: [],
  }))
  let entered!: () => void
  const downloading = new Promise<void>(resolve => { entered = resolve })
  let block = true
  const fetcher: typeof fetch = async (input, options) => {
    if (String(input) === modrinthArchiveUrl) return new Response(new Uint8Array(contents))
    if (String(input) !== archiveUrl) return fake.fetcher(input, options)
    if (block) {
      entered()
      await new Promise<void>((_, reject) => {
        if (options?.signal?.aborted) reject(options.signal.reason)
        else options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
    }
    return new Response(new Uint8Array(contents))
  }
  const events: CoreEvent[] = []
  const core = new LauncherCore(directory, event => events.push(event), { fetch: fetcher })
  await core.init()
  const pending = core.installModpack('pack1', { source: 'bbsmc' })
  const rejected = assert.rejects(pending, /安装已取消/)
  await downloading
  assert(events.some(event => event.type === 'progress' && event.instanceId === 'modpack-bbsmc-pack1'))
  // The same version ID on another provider must not share or overwrite the active controller.
  const modrinthResult = await core.installModpack('pack1')
  assert.equal(modrinthResult.instances[0].modpack?.source, 'modrinth')
  core.cancelInstall('modpack-bbsmc-pack1')
  await rejected
  assert.equal(core.snapshot().instances.length, 1)
  assert.equal(core.snapshot().instances[0].status, 'ready')
  block = false
  const result = await core.installModpack('pack1', { source: 'bbsmc', name: 'Chinese pack' })
  assert.equal(result.instances.length, 2)
  const installed = result.instances.find(instance => instance.modpack?.source === 'bbsmc')!
  assert.equal(installed.modpack?.remoteVersionId, 'pack1')
  assert.equal(installed.modpack?.modrinthVersionId, undefined)
  assert.equal(installed.status, 'ready')
  assert.equal(await fs.readFile(path.join(core.getInstancePath(installed.id), client.path), 'utf8'), 'client mod')
})

test('mod category filters combine with version and loader, mapping BBSMC native labels', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-categories-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const urls: URL[] = []
  const core = new LauncherCore(directory, undefined, { fetch: async input => {
    urls.push(new URL(String(input)))
    return new Response(JSON.stringify({ hits: [], total_hits: 0, offset: 0, limit: 20 }))
  } })
  await core.searchMods('', { category: 'optimization', loader: 'neoforge', gameVersion: '1.21.1' })
  await core.searchMods('', { category: 'optimization', loader: 'forge', gameVersion: '1.20.1', source: 'bbsmc' })
  assert.equal(urls[0].hostname, 'api.modrinth.com')
  assert.deepEqual(JSON.parse(urls[0].searchParams.get('facets')!), [
    ['project_type:mod'], ['categories:optimization'], ['categories:neoforge'], ['versions:1.21.1'],
  ])
  assert.equal(urls[1].hostname, 'api.bbsmc.net')
  assert.deepEqual(JSON.parse(urls[1].searchParams.get('facets')!), [
    ['project_type:mod'], ['categories:优化'], ['categories:forge'], ['versions:1.20.1'],
  ])
  await assert.rejects(core.searchMods('', { category: 'optimization],[project_type:modpack' }), /功能分类/)
  await assert.rejects(core.searchMods('', { category: '__proto__' }), /功能分类/)
  assert.equal(urls.length, 2)
})
