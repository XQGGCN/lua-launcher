import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, spawn, SpawnOptions } from 'node:child_process'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { installForge, installerArtifact, loaderMetadataUrl, parseInstaller, parseLoaderVersions, runProcessor, type ForgeInstallOptions, type ProcessorCommand } from './loader'
import { mavenPath } from './core'
const hash = (bytes: Buffer | string) => createHash('sha1').update(bytes).digest('hex')
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function jar(contents = 'test') {
  const zip = new AdmZip()
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nMain-Class: test.Processor\r\n\r\n'))
  zip.addFile('data.txt', Buffer.from(contents))
  return zip.toBuffer()
}
function archiveFixture(change?: (install: any, version: any) => void) {
  const processor = jar('processor'), output = jar('patched game'), runtime = jar('runtime')
  const library = (name: string, bytes: Buffer, url = `https://maven.minecraftforge.net/${mavenPath(name)}`) => ({
    name, downloads: { artifact: { path: mavenPath(name), url, sha1: hash(bytes), size: bytes.length } },
  })
  const tool = library('net.minecraftforge:tool:1.0', processor)
  const patched = library('net.minecraftforge:forge:1.20.1-47.0.0:client', output, '')
  const version = {
    id: '1.20.1-forge-47.0.0', inheritsFrom: '1.20.1', mainClass: 'test.Main',
    libraries: [library('net.minecraftforge:runtime:1.0', runtime), patched],
    arguments: { game: ['--launchTarget', 'forgeclient'], jvm: ['-DlibraryDirectory=${library_directory}'] },
  }
  const install = {
    spec: 1, minecraft: '1.20.1', json: '/version.json', libraries: [tool],
    data: { PATCHED: { client: '[net.minecraftforge:forge:1.20.1-47.0.0:client]' }, PATCHED_SHA: { client: `'${hash(output)}'` }, MOJMAPS: { client: '[net.minecraft:client:1.20.1:mappings@txt]' } },
    processors: [
      { sides: ['server'], jar: tool.name, classpath: [], args: ['--output', '{ROOT}/server-only.jar'] },
      { jar: tool.name, classpath: [], args: ['--task', 'DOWNLOAD_MOJMAPS', '--output', '{MOJMAPS}'] },
      { sides: ['client'], jar: tool.name, classpath: [], args: ['--output', '{PATCHED}', '--input', '{MINECRAFT_JAR}'], outputs: { '{PATCHED}': '{PATCHED_SHA}' } },
    ],
  }
  change?.(install, version)
  const zip = new AdmZip()
  zip.addFile('install_profile.json', Buffer.from(JSON.stringify(install)))
  zip.addFile('version.json', Buffer.from(JSON.stringify(version)))
  return { archive: zip.toBuffer(), install, version, output, processor, runtime }
}
async function fixture(t: TestContext, change?: (install: any, version: any) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-loader-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const instanceDir = path.join(root, 'instances', 'test')
  await fs.mkdir(instanceDir, { recursive: true })
  const fake = archiveFixture(change)
  const artifact = installerArtifact('forge', '1.20.1', '47.0.0')
  const mapping = 'official mappings'
  const responses = new Map<string, Buffer>([
    [artifact.url, fake.archive], ['https://piston-data.mojang.com/mappings.txt', Buffer.from(mapping)],
    ['https://maven.minecraftforge.net/net/minecraftforge/tool/1.0/tool-1.0.jar', fake.processor],
    ['https://maven.minecraftforge.net/net/minecraftforge/runtime/1.0/runtime-1.0.jar', fake.runtime],
  ])
  const calls: ProcessorCommand[] = []
  const downloads: string[] = []
  const controller = new AbortController()
  const options: ForgeInstallOptions = {
    loader: 'forge', game: '1.20.1', build: '47.0.0', rootDir: root, instanceDir,
    java: '/fake/java', clientFile: path.join(root, 'client.jar'),
    clientMappings: { url: 'https://piston-data.mojang.com/mappings.txt', sha1: hash(mapping), size: mapping.length },
    signal: controller.signal,
    text: async url => { assert.equal(url, `${artifact.url}.sha1`); return hash(fake.archive) },
    download: async (file, download) => {
      controller.signal.throwIfAborted()
      const body = responses.get(download.url)
      assert.ok(body, `Unknown URL ${download.url}`)
      assert.equal(hash(body), download.sha1)
      downloads.push(download.url)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, body)
    },
    log: () => {}, progress: () => {},
    run: async command => { calls.push(command); await fs.writeFile(command.args[command.args.indexOf('--output') + 1], fake.output) },
  }
  return { ...fake, options, calls, downloads, controller, root, instanceDir }
}
async function noStaging(directory: string) {
  assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.loader-')), false)
}

test('official Maven coordinates and version mapping keep Forge and NeoForge separate', () => {
  assert.equal(installerArtifact('forge', '1.20.1', '47.4.0').url, 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-installer.jar')
  assert.equal(installerArtifact('neoforge', '1.20.1', '47.1.106').url, 'https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar')
  assert.equal(installerArtifact('neoforge', '1.21.1', '21.1.264').url, 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.264/neoforge-21.1.264-installer.jar')
  assert.ok(loaderMetadataUrl('neoforge', '1.20.1').includes('/net/neoforged/forge/'))
  const xml = '<versions><version>1.20.1-47.4.2</version><version>1.20.1-47.4.10</version><version>1.20.2-48.1.0</version></versions>'
  assert.deepEqual(parseLoaderVersions(xml, 'forge', '1.20.1', '47.4.2'), [{ version: '47.4.10', stable: true }, { version: '47.4.2', stable: true, recommended: true }])
  const neo = '<versions><version>21.0.5-beta</version><version>21.1.264</version><version>26.1.0.4</version><version>26.1.1.5</version><version>26.1.0.0-alpha.1+snapshot-1</version></versions>'
  assert.deepEqual(parseLoaderVersions(neo, 'neoforge', '1.21'), [{ version: '21.0.5-beta', stable: false }])
  assert.deepEqual(parseLoaderVersions(neo, 'neoforge', '26.1'), [{ version: '26.1.0.4', stable: true }])
  assert.throws(() => parseLoaderVersions('<!DOCTYPE injected>', 'forge', '1.20.1'), /清单无效/)
  assert.throws(() => installerArtifact('forge', '1.20.1', '../escape'), /无效/)
})

test('installer rejects wrong game, unsupported spec, unsafe paths and unhashed libraries', () => {
  assert.throws(() => parseInstaller(archiveFixture().archive, '1.20.2'), /暂不支持/)
  for (const change of [
    (p: any) => { p.spec = 2 },
    (p: any) => { p.json = '../outside.json' },
    (p: any) => { p.libraries[0].downloads.artifact.sha1 = '' },
    (p: any) => { p.libraries[0].downloads.artifact.path = '../outside.jar' },
  ]) assert.throws(() => parseInstaller(archiveFixture(change).archive, '1.20.1'))
})

test('client installation skips server processors, verifies mappings and commits all artifacts together', async t => {
  const f = await fixture(t)
  const result = await installForge(f.options)
  assert.equal(result.profile.mainClass, 'test.Main')
  assert.equal(f.calls.length, 1, 'server task is skipped and mappings use the checked downloader')
  assert.ok(f.downloads.includes('https://piston-data.mojang.com/mappings.txt'))
  assert.equal(f.calls[0].args.includes('test.Processor'), true)
  assert.equal(f.calls[0].args.includes(f.options.clientFile), true)
  assert.equal(result.classpath.length, 2)
  assert.equal(hash(await fs.readFile(result.classpath[1].file)), hash(f.output))
  await assert.rejects(fs.access(path.join(f.instanceDir, 'loader/server-only.jar')), { code: 'ENOENT' })
  await noStaging(f.instanceDir)
})

test('a missing or corrupt processor artifact cannot become ready or replace a previous loader', async t => {
  const f = await fixture(t)
  const previous = path.join(f.instanceDir, 'loader')
  await fs.mkdir(previous)
  await fs.writeFile(path.join(previous, 'previous.txt'), 'keep me')
  await assert.rejects(installForge({ ...f.options, run: async () => {} }), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(previous, 'previous.txt'), 'utf8'), 'keep me')
  await noStaging(f.instanceDir)
  await assert.rejects(installForge({ ...f.options, run: async command => {
    await fs.writeFile(command.args[command.args.indexOf('--output') + 1], 'corrupt')
  } }), /SHA-1/)
  assert.equal(await fs.readFile(path.join(previous, 'previous.txt'), 'utf8'), 'keep me')
  await noStaging(f.instanceDir)
})

test('failed atomic replacement restores the previous loader and cleans the staging tree', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.instanceDir, 'loader'))
  await fs.writeFile(path.join(f.instanceDir, 'loader/previous.txt'), 'keep me')
  await assert.rejects(installForge({ ...f.options, rename: async (source, target) => {
    if (String(source).includes('.loader-staging-')) throw new Error('simulated rename failure')
    await fs.rename(source, target)
  } }), /simulated rename failure/)
  assert.equal(await fs.readFile(path.join(f.instanceDir, 'loader/previous.txt'), 'utf8'), 'keep me')
  await noStaging(f.instanceDir)
})

test('cancelled processing finishes before staging cleanup and leaves the old installation intact', async t => {
  const f = await fixture(t)
  const started = deferred(), release = deferred()
  await fs.mkdir(path.join(f.instanceDir, 'loader'))
  await fs.writeFile(path.join(f.instanceDir, 'loader/previous.txt'), 'keep me')
  const pending = installForge({ ...f.options, run: async command => { started.resolve(); await release.promise; command.signal.throwIfAborted() } })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await started.promise
  f.controller.abort()
  release.resolve()
  await rejected
  assert.equal(await fs.readFile(path.join(f.instanceDir, 'loader/previous.txt'), 'utf8'), 'keep me')
  await noStaging(f.instanceDir)
})

test('processor output paths cannot escape staging', async t => {
  const f = await fixture(t, install => { install.processors[2].outputs = { "'{ROOT}/../../escape.jar'": "'" + 'a'.repeat(40) + "'" } })
  await assert.rejects(installForge(f.options), /超出临时目录/)
  assert.equal(f.calls.length, 0)
  await noStaging(f.instanceDir)
})

test('processor arguments cannot escape staging even when no outputs map is declared', async t => {
  const f = await fixture(t, install => {
    install.processors[2].args = ['--output', '{ROOT}/../../outside.jar']
    install.processors[2].outputs = {}
  })
  await assert.rejects(installForge(f.options), /不安全路径/)
  assert.equal(f.calls.length, 0)
  await noStaging(f.instanceDir)
})

test('profiles without official output hashes still require a readable generated JAR', async t => {
  const f = await fixture(t, (install, version) => {
    delete install.data.PATCHED_SHA
    install.processors[2].outputs = {}
    version.libraries[1].downloads.artifact.sha1 = hash('invalid jar')
  })
  await assert.rejects(installForge({ ...f.options, run: async command => {
    await fs.writeFile(command.args[command.args.indexOf('--output') + 1], 'invalid jar')
  } }), /JAR 无效/)
  await noStaging(f.instanceDir)
})

function fakeProcess() {
  const kills: Array<NodeJS.Signals | number | undefined> = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill(signal?: NodeJS.Signals | number) {
      kills.push(signal)
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal))
      return true
    },
  }) as unknown as ChildProcess
  const spawnFake = (() => child) as typeof spawn
  return { child, kills, spawn: spawnFake }
}
const command = (signal: AbortSignal): ProcessorCommand => ({ java: '/fake/java', args: [], cwd: '/tmp', signal })

test('timed out processors are force-killed if SIGTERM is ignored and only then reject', async () => {
  const fake = fakeProcess()
  await assert.rejects(runProcessor(command(new AbortController().signal), () => {}, fake.spawn, { timeoutMs: 10, killGraceMs: 10 }), /超时/)
  assert.deepEqual(fake.kills, ['SIGTERM', 'SIGKILL'])
})

test('cancellation waits for the processor to exit before allowing cleanup', async () => {
  const fake = fakeProcess(), controller = new AbortController()
  const pending = runProcessor(command(controller.signal), () => {}, fake.spawn, { timeoutMs: 500, killGraceMs: 10 })
  const rejected = assert.rejects(pending, /取消/)
  controller.abort()
  await rejected
  assert.deepEqual(fake.kills, ['SIGTERM', 'SIGKILL'])
})

test('processor nonzero and signal exits are errors, and successful exit is accepted', async () => {
  for (const [code, signal] of [[1, null], [null, 'SIGSEGV'], [0, null]] as const) {
    const fake = fakeProcess()
    const pending = runProcessor(command(new AbortController().signal), () => {}, fake.spawn, { timeoutMs: 100 })
    const outcome = code === 0 ? pending : assert.rejects(pending, /处理器失败/)
    queueMicrotask(() => fake.child.emit('close', code, signal))
    await outcome
    assert.deepEqual(fake.kills, [])
  }
})

test('loader processors remove case-insensitive Java injection variables while preserving unrelated environment', async t => {
  const blocked = new Set(['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH'])
  const original = Object.entries(process.env).filter(([name]) => blocked.has(name.toUpperCase()))
  const preservedName = 'LUA_PROCESSOR_TEST_PRESERVED'
  const preservedOriginal = process.env[preservedName]
  const clear = () => {
    for (const name of Object.keys(process.env)) if (blocked.has(name.toUpperCase())) delete process.env[name]
  }
  t.after(() => {
    clear()
    for (const [name, value] of original) process.env[name] = value
    if (preservedOriginal === undefined) delete process.env[preservedName]
    else process.env[preservedName] = preservedOriginal
  })
  const variants = ['java_tool_options', 'Jdk_Java_Options', '_java_OPTIONS', 'classPath']
  clear()
  for (const name of variants) process.env[name] = `must-not-reach-processor-${name}`
  process.env[preservedName] = 'retain this exact value with spaces'
  const fake = fakeProcess()
  let captured: SpawnOptions | undefined
  const requested = { ...command(new AbortController().signal), args: ['-cp', 'verified-tool.jar', 'test.Processor'] }
  const spawnFake = ((java: string, args: string[], options: SpawnOptions) => {
    assert.equal(java, requested.java)
    assert.deepEqual(args, requested.args)
    captured = options
    queueMicrotask(() => fake.child.emit('close', 0, null))
    return fake.child
  }) as typeof spawn
  await runProcessor(requested, () => {}, spawnFake, { timeoutMs: 1000 })
  assert.ok(captured?.env)
  assert.equal(captured.shell, false)
  assert.equal(captured.cwd, requested.cwd)
  assert.deepEqual(Object.keys(captured.env).filter(name => blocked.has(name.toUpperCase())), [])
  assert.equal(captured.env[preservedName], process.env[preservedName])
  assert.equal(captured.env.PATH, process.env.PATH)
  for (const name of variants) assert.equal(process.env[name], `must-not-reach-processor-${name}`)
  assert.deepEqual(fake.kills, [])
})
