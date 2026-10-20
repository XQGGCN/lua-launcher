import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { LauncherCore, mavenPath, type LaunchAccount, type ModrinthVersion } from './core'
import { installerArtifact, loaderMetadataUrl, type ForgeLoader } from './loader'

const sha1 = (value: string | Buffer) => createHash('sha1').update(value).digest('hex')
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const runtime = {
  path: path.join(os.tmpdir(), 'lua-loader-fake-runtime', process.platform === 'win32' ? 'java.exe' : 'java'),
  version: '17.0.12', major: 17, arch: process.arch,
}
// These credentials can only reach the injected fake process; no real game runs.
const account: LaunchAccount = { mode: 'microsoft', username: 'LoaderTest', uuid: 'a'.repeat(32), accessToken: 'fictitious-loader-test-token' }
const coordinates = {
  forge: { game: '1.20.1', build: '47.4.0', newer: '47.4.1', main: 'test.forge.Bootstrap' },
  neoforge: { game: '1.20.2', build: '20.2.93', newer: '20.2.94', main: 'test.neoforge.Bootstrap' },
} as const

function networkFixture() {
  const responses = new Map<string, string | Buffer>()
  const projects = new Map<string, ModrinthVersion[]>()
  const requests: string[] = []
  const manifest: unknown[] = []
  const index = JSON.stringify({ objects: {} })
  for (const game of ['1.20.1', '1.20.2']) {
    const url = `https://piston-meta.mojang.com/loader-test/${game}.json`
    const client = `${game} client`
    const library = 'base-library'
    const version = JSON.stringify({
      id: game, type: 'release', mainClass: 'test.Vanilla', javaVersion: { majorVersion: 17 },
      assetIndex: { id: 'test', url: 'https://piston-meta.mojang.com/loader-test/assets.json', sha1: sha1(index), size: index.length },
      downloads: { client: { url: `https://piston-data.mojang.com/loader-test/${game}.jar`, sha1: sha1(client), size: client.length } },
      libraries: [{ name: 'test.shared:library:1.0', downloads: { artifact: {
        url: 'https://libraries.minecraft.net/test/shared/library/1.0/library-1.0.jar',
        path: 'test/shared/library/1.0/library-1.0.jar', sha1: sha1(library), size: library.length,
      } } }],
      arguments: {
        jvm: [
          '-cp', '${classpath}', '-Dtest.classpathSeparator=${classpath_separator}',
          ...['windows', 'linux', 'osx'].map(name => ({
            rules: [{ action: 'allow', os: { name } }], value: `-Dtest.platform=${name}`,
          })),
        ],
        game: ['--username', '${auth_player_name}', '--accessToken', '${auth_access_token}'],
      },
    })
    responses.set(url, version)
    responses.set(`https://piston-data.mojang.com/loader-test/${game}.jar`, client)
    responses.set('https://libraries.minecraft.net/test/shared/library/1.0/library-1.0.jar', library)
    manifest.push({ id: game, type: 'release', releaseTime: '2023-01-01T00:00:00Z', url, sha1: sha1(version) })
  }
  responses.set(MANIFEST, JSON.stringify({ versions: manifest }))
  responses.set('https://piston-meta.mojang.com/loader-test/assets.json', index)
  for (const loader of ['forge', 'neoforge'] as const) {
    const { game, build, newer, main } = coordinates[loader]
    const values = loader === 'forge' ? [`${game}-${build}`, `${game}-${newer}`, '1.20.2-48.1.0'] : [build, newer, '21.1.10', '20.4.100']
    responses.set(loaderMetadataUrl(loader, game), `<versions>${values.map(version => `<version>${version}</version>`).join('')}</versions>`)
    const artifact = installerArtifact(loader, game, build)
    const libraryName = 'test.shared:library:2.0@jar'
    const libraryBytes = `${loader}-library`
    const libraryPath = mavenPath(libraryName)
    const libraryUrl = `${loader === 'forge' ? 'https://maven.minecraftforge.net/' : 'https://maven.neoforged.net/releases/'}${libraryPath}`
    const version = {
      id: `${loader}-${build}`, inheritsFrom: game, mainClass: main,
      libraries: [{ name: libraryName, downloads: { artifact: { path: libraryPath, url: libraryUrl, sha1: sha1(libraryBytes), size: libraryBytes.length } } }],
      arguments: { jvm: ['-DlibraryDirectory=${library_directory}'], game: ['--launchTarget', `${loader}client`, '--loaderVersion', build] },
    }
    const zip = new AdmZip()
    // No processors: installation and manifest wiring are exercised without running Java tools.
    zip.addFile('install_profile.json', Buffer.from(JSON.stringify({ spec: 1, minecraft: game, json: '/version.json', data: {}, libraries: [], processors: [] })))
    zip.addFile('version.json', Buffer.from(JSON.stringify(version)))
    const bytes = zip.toBuffer()
    responses.set(artifact.url, bytes)
    responses.set(`${artifact.url}.sha1`, sha1(bytes))
    responses.set(libraryUrl, libraryBytes)
  }
  responses.set(loaderMetadataUrl('neoforge', '1.20.1'), '<versions><version>1.20.1-47.1.106</version><version>1.20.1-47.1.99</version></versions>')
  const addMod = (id: string, loader: 'forge' | 'neoforge', game: string, dependencies: ModrinthVersion['dependencies'] = []) => {
    const body = `jar-${id}`, url = `https://cdn.modrinth.com/data/${id}/${id}.jar`
    const version: ModrinthVersion = {
      id, project_id: id, name: id, loaders: [loader], game_versions: [game], dependencies,
      files: [{ url, filename: `${id}.jar`, primary: true, size: body.length, hashes: { sha1: sha1(body) } }],
    }
    responses.set(`https://api.modrinth.com/v2/version/${id}`, JSON.stringify(version))
    responses.set(url, body)
    return version
  }
  const fetcher: typeof fetch = async (input, options) => {
    options?.signal?.throwIfAborted()
    const url = String(input)
    requests.push(url)
    const parsed = new URL(url)
    const project = /^\/v2\/project\/([^/]+)\/version$/.exec(parsed.pathname)?.[1]
    if (project && projects.has(project)) return new Response(JSON.stringify(projects.get(project)))
    const body = responses.get(url)
    assert.notEqual(body, undefined, `Unexpected request ${url}`)
    return new Response(body as BodyInit)
  }
  return { responses, requests, projects, addMod, fetcher }
}
function fakeProcesses() {
  const calls: Array<{ command: string; args: string[] }> = []
  const children: ChildProcess[] = []
  const spawnFake = ((command: string, args: string[]) => {
    assert.equal(command, runtime.path)
    calls.push({ command, args: [...args] })
    const stdout = new PassThrough(), stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      pid: 9000 + children.length, stdout, stderr,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => { queueMicrotask(() => { stdout.end(); stderr.end(); child.emit('close', null, signal) }); return true },
    }) as unknown as ChildProcess
    children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    return child
  }) as typeof spawn
  return { spawn: spawnFake, calls, children }
}
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-loader-'))
  const network = networkFixture(), processes = fakeProcesses()
  const core = new LauncherCore(root, undefined, {
    fetch: network.fetcher, spawn: processes.spawn, platform: process.platform, arch: process.arch,
    memorySystem: { totalmem: () => 16 * 1024 ** 3, freemem: () => 12 * 1024 ** 3, platform: () => process.platform },
  })
  await core.init()
  core.detectJava = async () => [runtime]
  t.after(async () => {
    for (const instance of core.snapshot().instances) {
      if (instance.status !== 'running') continue
      const closed = once(processes.children.at(-1)!, 'close')
      core.stop(instance.id)
      await closed
      await core.updateSettings({})
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  const install = async (loader: ForgeLoader) => {
    const target = coordinates[loader]
    const instance = await core.createInstance({ name: `${loader} integration`, version: target.game, loader, loaderVersion: target.build })
    await core.install(instance.id)
    return instance
  }
  return { core, root, network, processes, install }
}

test('loader lists map each game to the official Forge, NeoForge or early NeoForge Maven coordinate', async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.core.loaderVersions('1.20.1', 'forge')).map(v => v.version), ['47.4.1', '47.4.0'])
  assert.deepEqual((await f.core.loaderVersions('1.20.2', 'neoforge')).map(v => v.version), ['20.2.94', '20.2.93'])
  assert.deepEqual((await f.core.loaderVersions('1.20.1', 'neoforge')).map(v => v.version), ['47.1.106', '47.1.99'])
  await assert.rejects(f.core.loaderVersions('1.19.4', 'forge'), /1.20.1/)
})

test('create validates the selected loader pin before persisting an instance', async t => {
  const f = await fixture(t)
  await assert.rejects(f.core.createInstance({ name: 'Invalid Forge', version: '1.20.1', loader: 'forge', loaderVersion: '48.1.0' }), /不支持/)
  await assert.rejects(f.core.createInstance({ name: 'Invalid NeoForge', version: '1.20.2', loader: 'neoforge', loaderVersion: '21.1.10' }), /不支持/)
  await assert.rejects(f.core.createInstance({ name: 'Invalid vanilla pin', version: '1.20.1', loader: 'vanilla', loaderVersion: '47.4.0' }), /不能指定/)
  assert.equal(f.core.snapshot().instances.length, 0)
  assert.equal(f.network.requests.some(url => url.endsWith('.jar')), false)
})

for (const loader of ['forge', 'neoforge'] as const) {
  test(`${loader} preserves the exact pin and wires profile mainClass, library directory and inherited classpath`, async t => {
    const f = await fixture(t), expected = coordinates[loader]
    const instance = await f.install(loader)
    assert.equal(f.core.snapshot().instances[0].status, 'ready')
    assert.equal(f.core.snapshot().instances[0].loaderVersion, expected.build)
    assert.equal(f.processes.calls.length, 0, 'processor-free fixture cannot create a real or fake game during install')
    assert.ok(f.network.requests.includes(installerArtifact(loader, expected.game, expected.build).url))
    assert.equal(f.network.requests.includes(installerArtifact(loader, expected.game, expected.newer).url), false)
    const installed = JSON.parse(await fs.readFile(path.join(f.core.instanceDirectory(instance.id), 'installed.json'), 'utf8'))
    const libraryDirectory = path.join(f.core.instanceDirectory(instance.id), 'loader/libraries')
    assert.equal(installed.mainClass, expected.main)
    assert.equal(installed.platform, process.platform)
    assert.equal(installed.arch, process.arch)
    assert.equal(path.join(f.root, installed.loaderLibraryDirectory), libraryDirectory)
    assert.equal(installed.classpath.length, 2, 'new loader library replaces the inherited artifact rather than duplicating its old version')
    assert.equal(installed.classpath.some((entry: string) => entry.includes('library-1.0.jar')), false)
    assert.equal(installed.classpath.filter((entry: string) => entry === `versions/${expected.game}/${expected.game}.jar`).length, 1)
    await f.core.launch(instance.id, account)
    const args = f.processes.calls[0].args
    assert.ok(args.includes(expected.main))
    assert.ok(args.includes(`-DlibraryDirectory=${libraryDirectory}`))
    assert.equal(args[args.indexOf('--launchTarget') + 1], `${loader}client`)
    assert.equal(args[args.indexOf('--loaderVersion') + 1], expected.build)
    const hostPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
    assert.deepEqual(args.filter(arg => arg.startsWith('-Dtest.platform=')), [`-Dtest.platform=${hostPlatform}`])
    assert.ok(args.includes(`-Dtest.classpathSeparator=${path.delimiter}`))
    // Use the host filesystem and its separator together, preserving Windows drive letters.
    const classpath = args[args.indexOf('-cp') + 1].split(path.delimiter)
    assert.deepEqual(classpath, [
      path.join(libraryDirectory, 'test/shared/library/2.0/library-2.0.jar'),
      path.join(f.root, `versions/${expected.game}/${expected.game}.jar`),
    ])
  })

  test(`${loader} Modrinth queries pin the game and loader, and cross-loader mods cannot be installed`, async t => {
    const f = await fixture(t), expected = coordinates[loader]
    const instance = await f.install(loader)
    const compatible = f.network.addMod('compatible', loader, expected.game)
    const dependency = f.network.addMod('dependency', loader, expected.game)
    f.network.projects.set('dependency-project', [dependency])
    f.network.projects.set('compatible-project', [compatible])
    assert.deepEqual((await f.core.modVersions('compatible-project', instance.id)).map(v => v.id), ['compatible'])
    const query = new URL(f.network.requests.at(-1)!)
    assert.deepEqual(JSON.parse(query.searchParams.get('loaders')!), [loader])
    assert.deepEqual(JSON.parse(query.searchParams.get('game_versions')!), [expected.game])
    const wrongLoader = loader === 'forge' ? 'neoforge' : 'forge'
    const incompatible = f.network.addMod('incompatible', wrongLoader, expected.game)
    await assert.rejects(f.core.installMod(instance.id, incompatible.id), /不兼容/)
    assert.equal(f.network.requests.includes(incompatible.files[0].url), false)
    const parent = f.network.addMod('parent', loader, expected.game, [{ project_id: 'dependency-project', dependency_type: 'required' }])
    await f.core.installMod(instance.id, parent.id)
    assert.equal(await fs.readFile(path.join(f.core.getInstancePath(instance.id), 'mods/parent.jar'), 'utf8'), 'jar-parent')
    assert.equal(await fs.readFile(path.join(f.core.getInstancePath(instance.id), 'mods/dependency.jar'), 'utf8'), 'jar-dependency')
    const dependencyRequest = new URL(f.network.requests.find(url => url.includes('/project/dependency-project/version'))!)
    assert.deepEqual(JSON.parse(dependencyRequest.searchParams.get('loaders')!), [loader])
    const badParent = f.network.addMod('bad-parent', loader, expected.game, [{ version_id: incompatible.id, dependency_type: 'required' }])
    await assert.rejects(f.core.installMod(instance.id, badParent.id), /不兼容/)
    assert.equal(f.network.requests.includes(badParent.files[0].url), false, 'complete dependency validation precedes artifact writes')
    assert.equal(f.core.snapshot().instances[0].status, 'ready')
  })
}

test('invalid Forge installer hashes fail the core install without publishing a ready instance', async t => {
  const f = await fixture(t)
  const target = coordinates.forge
  const artifact = installerArtifact('forge', target.game, target.build)
  f.network.responses.set(`${artifact.url}.sha1`, '0'.repeat(40))
  const instance = await f.core.createInstance({ name: 'Hash rejection', version: target.game, loader: 'forge', loaderVersion: target.build })
  await assert.rejects(f.core.install(instance.id), /SHA-1/)
  assert.equal(f.core.snapshot().instances[0].status, 'error')
  await assert.rejects(fs.access(path.join(f.core.instanceDirectory(instance.id), 'installed.json')), { code: 'ENOENT' })
  assert.equal(f.processes.calls.length, 0)
})
