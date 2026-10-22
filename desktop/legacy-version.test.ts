import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, spawn } from 'node:child_process'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { LauncherCore, type LaunchAccount } from './core'
import { isGameVersionId, javaRequirementOf, launchArguments, legacyAssetCopies, needsRosetta, LEGACY_JVM_ARGUMENTS } from './legacy-version'

const sha1 = (body: string | Buffer) => createHash('sha1').update(body).digest('hex')

test('version ids accept releases, snapshots and historic ids but not unsafe names', () => {
  for (const id of ['1.8.9', '24w14a', '1.21-pre1', 'b1.7.3', 'a1.0.4', 'rd-132211', '1.14.4-rc1', '26.1']) assert.equal(isGameVersionId(id), true, id)
  for (const id of ['', '../x', '1.0/2', 'a b', '.hidden', 'x'.repeat(65)]) assert.equal(isGameVersionId(id), false, id)
})

test('legacy minecraftArguments become modern argument arrays with resolution and default JVM flags', () => {
  const args = launchArguments({ minecraftArguments: '--username ${auth_player_name} --session ${auth_session}  --gameDir ${game_directory} --assetsDir ${game_assets}' })
  assert.deepEqual(args.game.slice(0, 8), ['--username', '${auth_player_name}', '--session', '${auth_session}', '--gameDir', '${game_directory}', '--assetsDir', '${game_assets}'])
  assert.equal(typeof args.game[8], 'object')
  assert.equal(args.jvm, LEGACY_JVM_ARGUMENTS)
  const modern = { game: ['--a'], jvm: ['-b'] }
  assert.deepEqual(launchArguments({ arguments: modern }), modern)
  assert.throws(() => launchArguments({}), /启动参数/)
})

test('Java requirement falls back to Java 8 for manifests without metadata', () => {
  assert.deepEqual(javaRequirementOf({}), { majorVersion: 8, component: 'jre-legacy' })
  assert.deepEqual(javaRequirementOf({ javaVersion: { majorVersion: 21, component: 'java-runtime-delta' } }), { majorVersion: 21, component: 'java-runtime-delta' })
  assert.deepEqual(javaRequirementOf({ javaVersion: { majorVersion: 8 } }), { majorVersion: 8, component: 'jre-legacy' })
})

test('Rosetta is needed only on Apple silicon for versions without arm64 natives', () => {
  const lwjgl2 = [{ name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4', natives: { osx: 'natives-osx' } }]
  const lwjgl331 = [{ name: 'org.lwjgl:lwjgl:3.3.1' }, { name: 'org.lwjgl:lwjgl:3.3.1:natives-macos-arm64' }]
  assert.equal(needsRosetta('darwin', 'arm64', lwjgl2), true)
  assert.equal(needsRosetta('darwin', 'arm64', lwjgl331), false)
  assert.equal(needsRosetta('darwin', 'x64', lwjgl2), false)
  assert.equal(needsRosetta('win32', 'arm64', lwjgl2), false)
})

test('legacy asset layouts list safe copy targets and reject traversal', () => {
  assert.deepEqual(legacyAssetCopies({ objects: { a: { hash: 'x', size: 1 } } }), { mode: 'none', files: [] })
  assert.equal(legacyAssetCopies({ virtual: true, objects: { 'sound/a.ogg': { hash: 'h', size: 1 } } }).mode, 'virtual')
  assert.equal(legacyAssetCopies({ map_to_resources: true, objects: { 'sound/a.ogg': { hash: 'h', size: 1 } } }).mode, 'resources')
  assert.throws(() => legacyAssetCopies({ virtual: true, objects: { '../evil': { hash: 'h', size: 1 } } }), /不安全/)
})

test('a legacy release installs with natives and virtual assets, then launches under Rosetta with x64 Java 8', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-legacy-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const zip = new AdmZip(); zip.addFile('liblwjgl.dylib', Buffer.from('native')); zip.addFile('META-INF/MANIFEST.MF', Buffer.from('x'))
  const nativeJar = zip.toBuffer()
  const asset = 'legacy sound'
  const index = JSON.stringify({ virtual: true, objects: { 'sound/step/grass1.ogg': { hash: sha1(asset), size: asset.length } } })
  const version = JSON.stringify({
    id: '1.7.2', type: 'release', mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments: '--username ${auth_player_name} --session ${auth_session} --version ${version_name} --gameDir ${game_directory} --assetsDir ${game_assets} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userProperties ${user_properties} --userType ${user_type}',
    assetIndex: { id: 'legacy', url: 'https://piston-meta.mojang.com/legacy.json', sha1: sha1(index), size: index.length },
    downloads: { client: { url: 'https://piston-data.mojang.com/client.jar', sha1: sha1('client'), size: 6 } },
    libraries: [
      { name: 'org.lwjgl.lwjgl:lwjgl:2.9.0', downloads: { artifact: { url: 'https://libraries.minecraft.net/lwjgl.jar', path: 'org/lwjgl/lwjgl.jar', sha1: sha1('lwjgl'), size: 5 } } },
      { name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.0', natives: { osx: 'natives-osx', windows: 'natives-windows' }, extract: { exclude: ['META-INF/'] },
        downloads: { classifiers: { 'natives-osx': { url: 'https://libraries.minecraft.net/natives-osx.jar', path: 'org/lwjgl/natives-osx.jar', sha1: sha1(nativeJar), size: nativeJar.length } } } },
    ],
  })
  const responses = new Map<string, string | Buffer>([
    ['https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', JSON.stringify({ versions: [
      { id: '1.7.2', type: 'release', releaseTime: '2013-10-25T13:00:00Z', url: 'https://piston-meta.mojang.com/1.7.2.json', sha1: sha1(version) }] })],
    ['https://piston-meta.mojang.com/1.7.2.json', version], ['https://piston-meta.mojang.com/legacy.json', index],
    ['https://piston-data.mojang.com/client.jar', 'client'], ['https://libraries.minecraft.net/lwjgl.jar', 'lwjgl'],
    ['https://libraries.minecraft.net/natives-osx.jar', nativeJar],
    [`https://resources.download.minecraft.net/${sha1(asset).slice(0, 2)}/${sha1(asset)}`, asset],
  ])
  const fetcher: typeof fetch = async input => {
    const body = responses.get(String(input))
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(typeof body === "string" ? body : new Uint8Array(body))
  }
  const calls: Array<{ command: string; args: string[] }> = []
  const spawnFake = ((command: string, args: string[]) => {
    calls.push({ command, args })
    const child = Object.assign(new EventEmitter(), { pid: 1, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcess
    queueMicrotask(() => child.emit('spawn'))
    return child
  }) as typeof spawn
  const requested: string[] = []
  const core = new LauncherCore(directory, undefined, {
    fetch: fetcher, spawn: spawnFake, platform: 'darwin', arch: 'arm64',
    memorySystem: { totalmem: () => 16 * 1024 ** 3, freemem: () => 12 * 1024 ** 3 },
    javaRuntimeManager: { discover: async () => [], ensure: async request => { requested.push(`${request.major}/${request.arch}/${request.component}`); throw new Error('no download in test') } },
  })
  core.detectJava = async () => [
    { path: '/java/arm64-8/bin/java', version: '1.8.0_402', major: 8, arch: 'arm64' },
    { path: '/java/x64-8/bin/java', version: '1.8.0_402', major: 8, arch: 'x64' },
  ]
  await core.init()
  const instance = await core.createInstance({ name: 'Legacy', version: '1.7.2', loader: 'vanilla' })
  await core.install(instance.id)
  assert.equal(core.snapshot().instances[0].status, 'ready')
  assert.equal(await fs.readFile(path.join(directory, 'assets/virtual/legacy/sound/step/grass1.ogg'), 'utf8'), asset)
  assert.equal(await fs.readFile(path.join(directory, 'instances', instance.id, 'natives/liblwjgl.dylib'), 'utf8'), 'native')
  const installed = JSON.parse(await fs.readFile(path.join(directory, 'instances', instance.id, 'installed.json'), 'utf8'))
  assert.equal(installed.javaArch, 'x64'); assert.equal(installed.legacyAssets, 'virtual')
  const account: LaunchAccount = { mode: 'microsoft', username: 'LuaTest', uuid: '0123456789abcdef0123456789abcdef', accessToken: 'fictitious-token' }
  await core.launch(instance.id, account)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, '/java/x64-8/bin/java')
  const args = calls[0].args
  assert.ok(args.includes('-XstartOnFirstThread'))
  assert.equal(args[args.indexOf('--assetsDir') + 1], path.join(directory, 'assets/virtual/legacy'))
  assert.ok(args.some(arg => arg.startsWith('-Djava.library.path=') && arg.endsWith('natives')))
  assert.ok(args.includes('--width'))
  assert.deepEqual(requested, [])
})
