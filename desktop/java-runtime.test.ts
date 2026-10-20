import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  JAVA_RUNTIME_INDEX, JavaRuntimeManager, probeJavaRuntime,
  type JavaRuntimeProbe, type JavaRuntimeProgress, type JavaRuntimeRequest,
} from './java-runtime'

const hash = (value: string | Buffer) => createHash('sha1').update(value).digest('hex')
const COMPONENT = 'java-runtime-gamma'
const JAVA = Buffer.from('verified fake Java executable')
const LICENSE = Buffer.from('Test runtime license. Redistribution requires retaining this file.')
const platforms = [
  ['win32', 'x64', 'windows-x64'], ['win32', 'arm64', 'windows-arm64'],
  ['darwin', 'x64', 'mac-os'], ['darwin', 'arm64', 'mac-os-arm64'], ['linux', 'x64', 'linux'],
] as const
type FakeEntry = { type: string; executable?: boolean; downloads?: { raw: { url: string; sha1: string; size: number } }; target?: string }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(t: TestContext, platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-java-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const platformKey = platforms.find(value => value[0] === platform && value[1] === arch)?.[2] ?? 'linux'
  const executable = platform === 'darwin' ? 'jre.bundle/Contents/Home/bin/java' : platform === 'win32' ? 'bin/java.exe' : 'bin/java'
  const base = platform === 'darwin' ? 'jre.bundle/Contents/Home/' : ''
  const files: Record<string, FakeEntry> = {}
  const responses = new Map<string, Buffer>()
  function addFile(name: string, contents: Buffer, executable = false) {
    let parent = path.posix.dirname(name)
    while (parent !== '.') { files[parent] = { type: 'directory' }; parent = path.posix.dirname(parent) }
    const address = `https://piston-data.mojang.com/v1/objects/${hash(contents)}/${encodeURIComponent(path.posix.basename(name))}`
    files[name] = { type: 'file', executable, downloads: { raw: { url: address, size: contents.length, sha1: hash(contents) } } }
    responses.set(address, contents)
  }
  addFile(executable, JAVA, true)
  addFile(`${base}legal/java.base/LICENSE`, LICENSE)
  const manifestUrl = 'https://piston-meta.mojang.com/v1/packages/test/manifest.json'
  const requests: string[] = []
  function refresh() {
    const manifest = Buffer.from(JSON.stringify({ files }))
    responses.set(manifestUrl, manifest)
    responses.set(JAVA_RUNTIME_INDEX, Buffer.from(JSON.stringify({
      [platformKey]: {
        [COMPONENT]: [{ version: { name: '17.0.15', released: '2025-04-01T00:00:00Z' },
          manifest: { url: manifestUrl, sha1: hash(manifest), size: manifest.length } }],
      },
    })))
  }
  refresh()
  let override: ((address: string, options?: RequestInit) => Promise<Response | undefined>) | undefined
  const fetcher: typeof globalThis.fetch = async (input, options) => {
    const address = String(input)
    requests.push(address)
    assert.equal(options?.redirect, 'manual', 'each network hop is validated by the manager')
    options?.signal?.throwIfAborted()
    const custom = await override?.(address, options)
    if (custom) return custom
    const contents = responses.get(address)
    assert.ok(contents, `Unexpected network request: ${address}`)
    return new Response(contents as unknown as BodyInit)
  }
  const probes: string[] = []
  const probe: JavaRuntimeProbe = async (executable, signal) => {
    signal?.throwIfAborted()
    assert.deepEqual(await fs.readFile(executable), JAVA, 'only the fully verified fixture executable can be probed')
    probes.push(executable)
    return { version: '17.0.15', major: 17, arch }
  }
  const makeManager = (custom: { fetch?: typeof fetch; probe?: JavaRuntimeProbe } = {}) => new JavaRuntimeManager(root, { fetch: fetcher, probe, ...custom })
  const request: JavaRuntimeRequest = { component: COMPONENT, major: 17, platform, arch }
  const componentDirectory = path.join(root, 'runtimes', platformKey, COMPONENT)
  const staging = async () => (await fs.readdir(componentDirectory).catch(() => [])).filter(name => name.startsWith('.staging-'))
  return {
    root, request, files, responses, requests, probes, probe, fetcher, makeManager, refresh, addFile, executable, base,
    manifestUrl, componentDirectory, staging,
    setOverride(value: typeof override) { override = value },
  }
}

for (const [platform, arch, platformKey] of platforms) {
  test(`official ${platformKey} selection, executable path, license and restart discovery are exact`, async t => {
    const f = await fixture(t, platform, arch)
    const progress: JavaRuntimeProgress[] = []
    const result = await f.makeManager().ensure(f.request, { onProgress: event => progress.push(event) })
    assert.equal(result.major, 17)
    assert.equal(result.arch, arch)
    assert.equal(result.component, COMPONENT)
    assert.equal(result.source, 'mojang')
    assert.ok(result.path.endsWith(path.join(...f.executable.split('/'))))
    const directory = path.dirname(path.dirname(result.path))
    assert.deepEqual(await fs.readFile(path.join(directory, 'legal/java.base/LICENSE')), LICENSE)
    assert.deepEqual([...new Set(progress.map(event => event.phase))], ['metadata', 'download', 'verify', 'probe', 'commit'])
    assert.equal(progress.at(-1)!.completedBytes, JAVA.length + LICENSE.length)
    assert.equal(progress.at(-1)!.totalBytes, JAVA.length + LICENSE.length)
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i].completedBytes >= progress[i - 1].completedBytes)
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(result.path)).mode & 0o777, 0o755)
      assert.equal((await fs.stat(path.join(directory, 'legal/java.base/LICENSE'))).mode & 0o777, 0o644)
    }
    const restarted = f.makeManager({ fetch: async () => { throw new Error('restart discovery must not access the network') } })
    assert.deepEqual(await restarted.discover(), [result])
    assert.deepEqual(await restarted.ensure(f.request), result)
    assert.deepEqual(await f.staging(), [])
  })
}

test('missing component, incorrect catalog major and Linux ARM64 do not fall back to another runtime', async t => {
  const f = await fixture(t, 'linux', 'x64')
  await assert.rejects(f.makeManager().ensure({ ...f.request, component: 'java-runtime-beta' }), /未提供/)
  await assert.rejects(f.makeManager().ensure({ ...f.request, major: 21 }), /未提供/)
  const before = f.requests.length
  await assert.rejects(f.makeManager().ensure({ ...f.request, arch: 'arm64' }), /暂无 linux\/arm64/)
  assert.equal(f.requests.length, before)
  assert.equal(f.probes.length, 0)
})

test('manifest hash and size mismatch reject before any runtime file is downloaded', async t => {
  for (const field of ['sha1', 'size'] as const) {
    const f = await fixture(t)
    const index = JSON.parse(f.responses.get(JAVA_RUNTIME_INDEX)!.toString())
    const entry = index[Object.keys(index)[0]][COMPONENT][0]
    entry.manifest[field] = field === 'sha1' ? '0'.repeat(40) : entry.manifest.size + 1
    f.responses.set(JAVA_RUNTIME_INDEX, Buffer.from(JSON.stringify(index)))
    await assert.rejects(f.makeManager().ensure(f.request), /校验失败/)
    assert.equal(f.requests.some(address => address.includes('piston-data')), false)
    assert.equal(f.probes.length, 0)
    assert.deepEqual(await f.staging(), [])
  }
})

test('bad file hashes clean staging, do not probe, and allow a complete retry', async t => {
  const f = await fixture(t)
  const address = f.files[f.executable].downloads!.raw.url
  f.responses.set(address, Buffer.from('x'.repeat(JAVA.length)))
  const manager = f.makeManager()
  await assert.rejects(manager.ensure(f.request), /SHA-1/)
  assert.equal(f.probes.length, 0)
  assert.deepEqual(await f.staging(), [])
  assert.deepEqual(await manager.discover(), [])
  f.responses.set(address, JAVA)
  assert.equal((await manager.ensure(f.request)).major, 17)
})

test('manifest path traversal, Windows device/drive paths, reserved and case-colliding entries are rejected', async t => {
  for (const name of ['../escape', '/absolute', 'C:/escape', 'a\\escape', 'NUL.txt', 'bin/a.', 'bin/a ', '.LUA-RUNTIME.JSON', 'BIN']) {
    const f = await fixture(t, 'linux', 'x64')
    f.files[name] = name === 'BIN' ? { type: 'directory' } : { ...f.files[f.executable] }
    f.refresh()
    await assert.rejects(f.makeManager().ensure(f.request), /路径|重复/)
    assert.equal(f.requests.some(address => address.includes('piston-data')), false)
    assert.equal(f.probes.length, 0)
    assert.deepEqual(await f.staging(), [])
  }
})

test('links cannot escape, dangle, form chains or become ancestors of downloaded files', async t => {
  for (const variant of ['escape', 'absolute', 'dangling', 'chain', 'ancestor']) {
    const f = await fixture(t, 'linux', 'x64')
    if (variant === 'ancestor') {
      f.files.legal = { type: 'link', target: 'bin/java' }
    } else {
      f.files['legal/alias'] = {
        type: 'link',
        target: variant === 'escape' ? '../../escape' : variant === 'absolute' ? '/etc/passwd' :
          variant === 'dangling' ? 'missing' : 'second',
      }
      if (variant === 'chain') f.files['legal/second'] = { type: 'link', target: 'java.base/LICENSE' }
    }
    f.refresh()
    await assert.rejects(f.makeManager().ensure(f.request), /链接|路径/)
    assert.equal(f.probes.length, 0)
  }
})

test('valid relative license links are retained on Unix; Windows rejects links without elevation', async t => {
  const f = await fixture(t)
  f.files[`${f.base}legal/java.compiler`] = { type: 'directory' }
  const link = `${f.base}legal/java.compiler/LICENSE`
  f.files[link] = { type: 'link', target: '../java.base/LICENSE' }
  f.refresh()
  if (process.platform === 'win32') {
    await assert.rejects(f.makeManager().ensure(f.request), /Windows Java 清单不支持符号链接/)
  } else {
    const manager = f.makeManager()
    const runtime = await manager.ensure(f.request)
    const root = path.dirname(path.dirname(runtime.path))
    assert.equal(await fs.readlink(path.join(root, 'legal/java.compiler/LICENSE')), '../java.base/LICENSE')
    assert.deepEqual(await fs.readFile(path.join(root, 'legal/java.compiler/LICENSE')), LICENSE)
    assert.deepEqual(await manager.discover(), [runtime])
  }
})

test('unsafe redirects are rejected before their destination is fetched, even on HTTP 200 replacement pages', async t => {
  for (const address of ['http://piston-data.mojang.com/file', 'https://example.com/file', 'https://user@piston-data.mojang.com/file']) {
    const f = await fixture(t)
    f.setOverride(async current => current === JAVA_RUNTIME_INDEX ? new Response(null, { status: 302, headers: { location: address } }) : undefined)
    await assert.rejects(f.makeManager().ensure(f.request), /HTTPS/)
    assert.deepEqual(f.requests, [JAVA_RUNTIME_INDEX])
  }
  const f = await fixture(t)
  f.setOverride(async current => current.includes('piston-data') ? new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } }) : undefined)
  await assert.rejects(f.makeManager().ensure(f.request), /验证网页/)
  assert.equal(f.probes.length, 0)
  assert.deepEqual(await f.staging(), [])
})

test('download byte limits reject overlong/truncated data and manifests with excessive declared size', async t => {
  for (const contents of [Buffer.concat([JAVA, Buffer.from('extra')]), JAVA.subarray(1)]) {
    const f = await fixture(t)
    f.responses.set(f.files[f.executable].downloads!.raw.url, contents)
    await assert.rejects(f.makeManager().ensure(f.request), /大小/)
    assert.equal(f.probes.length, 0)
    assert.deepEqual(await f.staging(), [])
  }
  const f = await fixture(t)
  f.files[f.executable].downloads!.raw.size = 1024 ** 3
  f.refresh()
  await assert.rejects(f.makeManager().ensure(f.request), /大小/)
  assert.equal(f.probes.length, 0)
})

test('concurrent subscribers share downloads and one cancellation preserves the remaining subscriber', async t => {
  const f = await fixture(t)
  const started = deferred(), release = deferred()
  const address = f.files[f.executable].downloads!.raw.url
  f.setOverride(async (current, options) => {
    if (current !== address) return
    started.resolve()
    await release.promise
    options?.signal?.throwIfAborted()
    return undefined
  })
  const manager = f.makeManager()
  const cancelled = new AbortController()
  const progress: JavaRuntimeProgress[] = []
  const listener = (event: JavaRuntimeProgress) => progress.push(event)
  const first = manager.ensure(f.request, { signal: cancelled.signal, onProgress: listener })
  const second = manager.ensure(f.request, { onProgress: listener })
  await started.promise
  cancelled.abort()
  await assert.rejects(first, { name: 'AbortError' })
  release.resolve()
  const result = await second
  assert.equal(result.major, 17)
  assert.equal(f.requests.filter(value => value === JAVA_RUNTIME_INDEX).length, 1)
  assert.equal(f.requests.filter(value => value === address).length, 1)
  assert.equal(f.probes.length, 1)
  assert.equal(progress.at(-1)!.phase, 'commit', 'shared callbacks remain attached for the surviving subscriber')
  assert.deepEqual(await f.staging(), [])
})

test('last cancellation aborts active streams and resolves only after staging cleanup; retry starts fresh', async t => {
  const f = await fixture(t)
  const started = deferred()
  let stopped = false
  f.setOverride(async (current, options) => {
    if (current !== f.files[f.executable].downloads!.raw.url) return
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        started.resolve()
        options!.signal!.addEventListener('abort', () => {
          stopped = true
          controller.error(new DOMException('cancelled', 'AbortError'))
        }, { once: true })
      },
    }))
  })
  const cancelled = new AbortController(), manager = f.makeManager()
  const pending = manager.ensure(f.request, { signal: cancelled.signal })
  await started.promise
  cancelled.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(stopped, true)
  assert.equal(f.probes.length, 0)
  assert.deepEqual(await f.staging(), [])
  f.setOverride(undefined)
  assert.equal((await manager.ensure(f.request)).major, 17)
})

test('a pre-aborted subscriber performs no work and cancellation during probe cannot publish an install', async t => {
  const f = await fixture(t)
  const before = new AbortController()
  before.abort()
  await assert.rejects(f.makeManager().ensure(f.request, { signal: before.signal }), { name: 'AbortError' })
  assert.equal(f.requests.length, 0)
  const entered = deferred(), exited = deferred()
  const during = new AbortController()
  const manager = f.makeManager({ probe: async (_file, signal) => {
    entered.resolve()
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }))
    exited.resolve()
    signal!.throwIfAborted()
    throw new Error('unreachable')
  } })
  const pending = manager.ensure(f.request, { signal: during.signal })
  await entered.promise
  during.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  await exited.promise
  assert.deepEqual(await f.staging(), [])
  assert.deepEqual(await manager.discover(), [])
})

test('cancellation in the commit preparation microtask prevents publishing the runtime', async t => {
  const f = await fixture(t)
  const cancellation = new AbortController()
  const manager = f.makeManager()
  await assert.rejects(manager.ensure(f.request, {
    signal: cancellation.signal,
    onProgress: event => { if (event.phase === 'commit') queueMicrotask(() => cancellation.abort()) },
  }), { name: 'AbortError' })
  assert.deepEqual(await manager.discover(), [])
  assert.deepEqual(await f.staging(), [])
})

test('a successful atomic rename wins a late cancellation and remains discoverable', async t => {
  const f = await fixture(t)
  const mutableFs = createRequire(import.meta.url)('node:fs/promises') as typeof fs
  const originalRename = mutableFs.rename
  const cancellation = new AbortController()
  const rename = t.mock.method(mutableFs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args)
    // The OS has committed, but the manager's await has not yet continued.
    cancellation.abort()
  })
  syncBuiltinESMExports()
  t.after(() => { rename.mock.restore(); syncBuiltinESMExports() })
  const manager = f.makeManager()
  const installed = await manager.ensure(f.request, { signal: cancellation.signal })
  assert.equal(rename.mock.callCount(), 1)
  assert.equal(cancellation.signal.aborted, true)
  assert.deepEqual(await manager.discover(), [installed])
  assert.deepEqual(await f.staging(), [])
})

test('wrong architecture or major from the actual probe cannot commit a runtime', async t => {
  for (const wrong of [{ version: '17.0.15', major: 17, arch: 'ia32' }, { version: '21.0.7', major: 21, arch: process.arch }]) {
    const f = await fixture(t)
    const manager = f.makeManager({ probe: async () => wrong })
    await assert.rejects(manager.ensure(f.request), /探测.*不符/)
    assert.deepEqual(await manager.discover(), [])
    assert.deepEqual(await f.staging(), [])
  }
})

test('failed repair preserves the old directory; repaired content commits separately and corrupt installs are skipped', async t => {
  const f = await fixture(t)
  const manager = f.makeManager()
  const original = await manager.ensure(f.request)
  await fs.writeFile(original.path, 'damaged')
  assert.deepEqual(await manager.discover(), [])
  const failing = f.makeManager({ probe: async () => { throw new Error('probe failed') } })
  await assert.rejects(failing.ensure(f.request), /probe failed/)
  assert.equal(await fs.readFile(original.path, 'utf8'), 'damaged')
  assert.deepEqual(await f.staging(), [])
  const repaired = await manager.ensure(f.request)
  assert.notEqual(repaired.path, original.path)
  assert.deepEqual(await manager.discover(), [repaired])
  assert.equal(await fs.readFile(original.path, 'utf8'), 'damaged')
})

test('a failed newer runtime install cannot replace an existing usable runtime', async t => {
  const f = await fixture(t)
  const manager = f.makeManager()
  const original = await manager.ensure(f.request)
  const index = JSON.parse(f.responses.get(JAVA_RUNTIME_INDEX)!.toString())
  index[Object.keys(index)[0]][COMPONENT][0].version.name = '21.0.7'
  f.responses.set(JAVA_RUNTIME_INDEX, Buffer.from(JSON.stringify(index)))
  await assert.rejects(manager.ensure({ ...f.request, major: 21 }), /探测主版本不符/)
  assert.deepEqual(await fs.readFile(original.path), JAVA)
  assert.deepEqual(await manager.discover(), [original])
  assert.deepEqual(await f.staging(), [])
})

test('persisted directory symlinks are rejected before probing; the outside target is untouched', async t => {
  const f = await fixture(t)
  const manager = f.makeManager()
  const runtime = await manager.ensure(f.request)
  const bin = path.dirname(runtime.path)
  const outside = path.join(f.root, 'outside-bin')
  await fs.mkdir(outside)
  await fs.copyFile(runtime.path, path.join(outside, path.basename(runtime.path)))
  await fs.rm(bin, { recursive: true })
  await fs.symlink(outside, bin, process.platform === 'win32' ? 'junction' : 'dir')
  const before = f.probes.length
  assert.deepEqual(await manager.discover(), [])
  assert.equal(f.probes.length, before)
  const repaired = await manager.ensure(f.request)
  assert.notEqual(repaired.path, runtime.path)
  assert.deepEqual(await fs.readFile(path.join(outside, path.basename(runtime.path))), JAVA)
  assert.ok((await fs.lstat(bin)).isSymbolicLink())
})

test('a redirected managed root is rejected instead of installing through it', async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(f.root, 'runtimes'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.makeManager().ensure(f.request), /不能是符号链接/)
  assert.deepEqual(await fs.readdir(outside), [])
  assert.equal(f.requests.length, 0)
})

test('discovery cleans only stages with a dead owner; live and unknown stages are left intact', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.componentDirectory, { recursive: true })
  const names = ['1', '2', '3'].map(digit => `.staging-${digit.repeat(40)}-${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`)
  for (const name of names) await fs.mkdir(path.join(f.componentDirectory, name))
  await fs.writeFile(path.join(f.componentDirectory, names[0], '.lua-staging.json'), JSON.stringify({ pid: 2147483647, createdAt: new Date().toISOString() }))
  await fs.writeFile(path.join(f.componentDirectory, names[1], '.lua-staging.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
  assert.deepEqual(await f.makeManager().discover(), [])
  assert.deepEqual((await f.staging()).sort(), names.slice(1).sort())
})

test('real Java probing is cancellable and never requires a Minecraft account', async () => {
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(probeJavaRuntime(path.resolve('nonexistent-java'), aborted.signal), { name: 'AbortError' })
  await assert.rejects(probeJavaRuntime(path.resolve('nonexistent-java')), { code: 'ENOENT' })
})
