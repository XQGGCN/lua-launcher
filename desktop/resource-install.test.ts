import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import {
  installResourceZip, readResourceRegistry, RESOURCE_INSTALL_LIMITS, ResourceInstallRecoveryError,
  type ResourceArtifact, type ResourceInstallOptions,
} from './resource-install'

const archive = new AdmZip()
archive.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":15,"description":"test"}}'))
archive.addFile('nested/retained.txt', Buffer.from('remain inside the archive'))
const bytes = archive.toBuffer()
const sha = (algorithm: string, value: Buffer) => createHash(algorithm).update(value).digest('hex')
function artifact(overrides: Partial<ResourceArtifact> = {}): ResourceArtifact {
  return {
    kind: 'resourcepack', source: 'modrinth', projectId: 'Project1', versionId: 'Version1',
    filename: 'Fixture.zip', url: 'https://cdn.modrinth.com/data/Project1/versions/Version1/Fixture.zip',
    size: bytes.length, sha512: sha('sha512', bytes), sha1: sha('sha1', bytes), ...overrides,
  }
}
const noFetch: typeof fetch = async () => { throw new Error('unexpected download') }
function fetchBytes(value = bytes, headers: HeadersInit = {}): typeof fetch {
  return async (_url, init) => {
    assert.equal(init?.redirect, 'manual')
    assert.ok(new Headers(init?.headers).get('user-agent')?.startsWith('LuaLauncher/'))
    return new Response(Uint8Array.from(value), { headers: { 'content-type': 'application/zip', ...headers } })
  }
}
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-resource-install-'))
  t.after(() => fs.rm(root, { force: true, recursive: true }))
  const directory = path.join(root, 'game', 'resourcepacks')
  const target = path.join(directory, 'Fixture.zip')
  const registry = path.join(root, 'managed-resources.json')
  const stages = async () => (await fs.readdir(root)).filter(name => name.startsWith('.resource-staging-'))
  const absent = async () => {
    await assert.rejects(fs.access(target), { code: 'ENOENT' })
    await assert.rejects(fs.access(registry), { code: 'ENOENT' })
    assert.deepEqual(await stages(), [])
  }
  return { root, directory, target, registry, stages, absent }
}
const mutableFs = createRequire(import.meta.url)('node:fs/promises') as typeof fs
function hook<K extends keyof typeof fs>(t: TestContext, name: K, fn: typeof fs[K]) {
  const mocked = t.mock.method(mutableFs, name, fn as never)
  syncBuiltinESMExports()
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports() }
  t.after(restore)
  return restore
}
const diskError = () => Object.assign(new Error('injected EIO'), { code: 'EIO' })
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'

for (const kind of ['resourcepack', 'shader'] as const) {
  for (const source of ['modrinth', 'bbsmc'] as const) {
    test(kind + ' / ' + source + ' installs only opaque ZIP and exact source registry', async t => {
      const f = await fixture(t)
      const input = artifact({ kind, source, url: 'https://' + (source === 'modrinth' ? 'cdn.modrinth.com' : 'cdn.bbsmc.net') + '/fixture.zip' })
      const progress: string[] = []
      const result = await installResourceZip(f.root, input, {
        fetch: fetchBytes(), onProgress: event => {
          assert.ok(event.completedBytes >= 0 && event.completedBytes <= bytes.length)
          assert.equal(event.totalBytes, bytes.length)
          progress.push(event.phase)
        },
      })
      assert.equal(result.reused, false)
      assert.equal(result.folder, kind === 'shader' ? 'shaderpacks' : 'resourcepacks')
      assert.equal(result.sha512, input.sha512)
      assert.deepEqual(result.warnings, [])
      const folder = path.join(f.root, 'game', result.folder)
      assert.deepEqual(await fs.readdir(folder), [input.filename])
      assert.deepEqual(await fs.readFile(path.join(folder, input.filename)), bytes)
      const registry = await readResourceRegistry(f.registry)
      const record = registry.records[kind + ':' + source + ':' + input.projectId]
      assert.equal(record.filename, input.filename)
      assert.equal(record.sha512, input.sha512)
      assert.ok(Number.isFinite(Date.parse(record.installedAt)))
      assert.equal(Object.hasOwn(record, 'url'), false)
      assert.deepEqual([...new Set(progress)], ['download', 'verify', 'commit'])
      assert.deepEqual(await f.stages(), [])
    })
  }
}

test('same registered bytes reuse without download, link, rename or registry timestamp changes', async t => {
  const f = await fixture(t)
  await installResourceZip(f.root, artifact(), { fetch: fetchBytes() })
  const before = await fs.stat(f.registry)
  const original = await fs.readFile(f.registry)
  const result = await installResourceZip(f.root, artifact({ sha1: undefined }), {
    fetch: noFetch, link: async () => { throw diskError() }, rename: async () => { throw diskError() },
  })
  assert.equal(result.reused, true)
  assert.equal(result.sha1, sha('sha1', bytes))
  const after = await fs.stat(f.registry)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.deepEqual(await fs.readFile(f.registry), original)
  assert.deepEqual(await f.stages(), [])
})

test('missing registered file repairs the same version while preserving installedAt', async t => {
  const f = await fixture(t)
  await installResourceZip(f.root, artifact(), { fetch: fetchBytes() })
  const old = await fs.readFile(f.registry)
  await fs.unlink(f.target)
  const result = await installResourceZip(f.root, artifact(), { fetch: fetchBytes() })
  assert.equal(result.reused, false)
  assert.deepEqual(await fs.readFile(f.target), bytes)
  assert.deepEqual(await fs.readFile(f.registry), old)
})

test('identical unregistered file may be registered without changing its inode or bytes', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.directory, { recursive: true })
  await fs.writeFile(f.target, bytes)
  const before = await fs.stat(f.target)
  const result = await installResourceZip(f.root, artifact(), { fetch: noFetch })
  assert.equal(result.reused, true)
  assert.equal((await fs.stat(f.target)).ino, before.ino)
  assert.deepEqual(await fs.readFile(f.target), bytes)
  assert.equal(Object.keys((await readResourceRegistry(f.registry)).records).length, 1)
})

test('different versions, changed pinned metadata and another source filename claim fail before download', async t => {
  const f = await fixture(t)
  await installResourceZip(f.root, artifact(), { fetch: fetchBytes() })
  const old = await fs.readFile(f.registry)
  for (const input of [
    artifact({ versionId: 'Version2' }), artifact({ sha512: 'a'.repeat(128) }),
    artifact({ sha1: 'a'.repeat(40) }), artifact({ filename: 'Other.zip' }),
    artifact({ source: 'bbsmc', projectId: 'Other', url: 'https://cdn.bbsmc.net/same.zip' }),
  ]) await assert.rejects(installResourceZip(f.root, input, { fetch: noFetch }), /更新|元数据|其他项目/)
  assert.deepEqual(await fs.readFile(f.registry), old)
  assert.deepEqual(await fs.readFile(f.target), bytes)
  assert.deepEqual(await f.stages(), [])
})

test('existing differing bytes, directories and case/NFC collisions are never overwritten', async t => {
  for (const scenario of ['bytes', 'size', 'directory', 'case', 'unicode']) {
    const f = await fixture(t)
    await fs.mkdir(f.directory, { recursive: true })
    let input = artifact()
    if (scenario === 'bytes') await fs.writeFile(f.target, Buffer.alloc(bytes.length))
    if (scenario === 'size') await fs.writeFile(f.target, 'keep me')
    if (scenario === 'directory') await fs.mkdir(f.target)
    if (scenario === 'case') await fs.writeFile(path.join(f.directory, 'fixture.zip'), 'keep me')
    if (scenario === 'unicode') {
      input = artifact({ filename: 'café.zip' })
      await fs.writeFile(path.join(f.directory, 'cafe\u0301.zip'), 'keep me')
    }
    const before = await fs.readdir(f.directory)
    await assert.rejects(installResourceZip(f.root, input, { fetch: noFetch }), /ZIP|大小|普通文件|冲突/)
    assert.deepEqual(await fs.readdir(f.directory), before)
    assert.deepEqual(await f.stages(), [])
    await assert.rejects(fs.access(f.registry), { code: 'ENOENT' })
  }
})

test('metadata rejects unsafe filenames, keys, sizes, hashes, URLs and unknown fields without writes', async t => {
  const f = await fixture(t)
  const invalid: ResourceArtifact[] = [
    ...['../escape.zip', 'C:\\escape.zip', 'a/b.zip', 'NUL.zip', 'COM1.zip', 'x.zip.', 'a:stream.zip', 'a\u202ezip.zip', 'x.jar']
      .map(filename => artifact({ filename })),
    artifact({ projectId: '../bad' }), artifact({ size: 21 }), artifact({ size: RESOURCE_INSTALL_LIMITS.fileBytes + 1 }),
    artifact({ size: NaN }), artifact({ sha512: '' }), artifact({ sha1: 'bad' }),
    ...['http://cdn.modrinth.com/a.zip', 'https://cdn.modrinth.com:443/a.zip',
      'https://cdn.modrinth.com.evil.test/a.zip', 'https://user@cdn.modrinth.com/a.zip',
      'https://cdn.bbsmc.net/a.zip', 'file:///tmp/a.zip', 'https://cdn.modrinth.com/a.zip#fragment']
      .map(url => artifact({ url })),
    { ...artifact(), unexpected: true } as ResourceArtifact,
  ]
  for (const input of invalid) await assert.rejects(installResourceZip(f.root, input, { fetch: noFetch }))
  assert.deepEqual(await fs.readdir(f.root), [])
  await assert.rejects(installResourceZip('relative/path', artifact(), { fetch: noFetch }), /绝对路径/)
})

test('SHA512 and optional SHA1 are both enforced and bad downloads leave no file or registry', async t => {
  for (const overrides of [{ sha512: 'f'.repeat(128) }, { sha1: 'f'.repeat(40) }]) {
    const f = await fixture(t)
    await assert.rejects(installResourceZip(f.root, artifact(overrides), { fetch: fetchBytes() }), /校验失败/)
    await f.absent()
  }
  const valid = await fixture(t)
  const result = await installResourceZip(valid.root, artifact({ sha1: undefined }), { fetch: fetchBytes() })
  assert.equal(result.sha1, undefined)
})

test('HTML/JSON responses, non-ZIP bodies, truncation, excess bytes and header mismatches are rejected', async t => {
  const cases: Array<{ value: Buffer; headers: Record<string, string>; pattern: RegExp }> = [
    { value: bytes, headers: { 'content-type': 'text/html' }, pattern: /HTML/ },
    { value: bytes, headers: { 'content-type': 'application/problem+json' }, pattern: /JSON/ },
    { value: Buffer.alloc(bytes.length, 60), headers: {}, pattern: /不是 ZIP/ },
    { value: bytes.subarray(0, bytes.length - 1), headers: {}, pattern: /不完整/ },
    { value: Buffer.concat([bytes, Buffer.of(0)]), headers: {}, pattern: /超过/ },
    { value: bytes, headers: { 'content-length': '7' }, pattern: /大小/ },
  ]
  for (const item of cases) {
    const f = await fixture(t)
    const input = artifact(item.pattern.source === '不是 ZIP' ? { sha512: sha('sha512', item.value), sha1: sha('sha1', item.value) } : {})
    await assert.rejects(installResourceZip(f.root, input, { fetch: fetchBytes(item.value, item.headers) }), item.pattern)
    await f.absent()
  }
})

test('401/403 never retry or bypass provider access checks', async t => {
  for (const status of [401, 403]) {
    const f = await fixture(t)
    let calls = 0
    await assert.rejects(installResourceZip(f.root, artifact(), { fetch: async () => {
      calls++; return new Response('restricted', { status })
    } }), /官方资源页面/)
    assert.equal(calls, 1)
    await f.absent()
  }
})

test('redirects are manual, bounded and checked before requesting each exact provider host', async t => {
  for (const location of ['https://evil.test/pack.zip', 'http://cdn.modrinth.com/p.zip',
    'https://cdn.bbsmc.net/p.zip', '//cdn.modrinth.com:443/p.zip', 'https://cdn.modrinth.com:443/p.zip',
    'https://user@cdn.modrinth.com/p.zip']) {
    const f = await fixture(t)
    let calls = 0
    await assert.rejects(installResourceZip(f.root, artifact(), { fetch: async () => {
      calls++; return new Response(null, { status: 302, headers: { location } })
    } }))
    assert.equal(calls, 1)
    await f.absent()
  }
  const good = await fixture(t)
  let calls = 0
  await installResourceZip(good.root, artifact(), { fetch: async (url, init) => {
    calls++
    assert.equal(init?.redirect, 'manual')
    return calls === 1 ? new Response(null, { status: 307, headers: { location: '/safe.zip' } })
      : (assert.equal(String(url), 'https://cdn.modrinth.com/safe.zip'), new Response(Uint8Array.from(bytes)))
  } })
  assert.equal(calls, 2)
  const loop = await fixture(t)
  calls = 0
  await assert.rejects(installResourceZip(loop.root, artifact(), { fetch: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: '/again.zip' } })
  } }), /重定向/)
  assert.equal(calls, RESOURCE_INSTALL_LIMITS.redirects + 1)
  await loop.absent()
})

test('symlink ancestors, target files and registry files are refused', async t => {
  const f = await fixture(t)
  const outside = await fixture(t)
  const link = path.join(f.root, 'linked-instance')
  await fs.symlink(outside.root, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(installResourceZip(link, artifact(), { fetch: noFetch }), /链接|junction/)
  await fs.symlink(outside.root, path.join(f.root, 'game'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(installResourceZip(f.root, artifact(), { fetch: noFetch }), /链接|junction/)
  await fs.unlink(path.join(f.root, 'game'))
  await fs.mkdir(f.directory, { recursive: true })
  const actual = path.join(outside.root, 'actual.zip')
  await fs.writeFile(actual, bytes)
  await fs.symlink(actual, f.target, 'file')
  await assert.rejects(installResourceZip(f.root, artifact(), { fetch: noFetch }), /链接/)
  await fs.unlink(f.target)
  const ledger = path.join(outside.root, 'registry.json')
  await fs.writeFile(ledger, '{"schema":1,"records":{}}')
  await fs.symlink(ledger, f.registry, 'file')
  await assert.rejects(readResourceRegistry(f.registry), /链接/)
  await assert.rejects(installResourceZip(f.root, artifact(), { fetch: noFetch }), /链接/)
  assert.deepEqual(await fs.readFile(actual), bytes)
  assert.equal(await fs.readFile(ledger, 'utf8'), '{"schema":1,"records":{}}')
})

test('registry read is bounded, strict, readonly, and rejects conflicting record keys', async t => {
  const f = await fixture(t)
  assert.equal(Object.keys((await readResourceRegistry(f.registry)).records).length, 0)
  assert.deepEqual(await fs.readdir(f.root), [])
  for (const value of [
    Buffer.alloc(RESOURCE_INSTALL_LIMITS.registryBytes + 1),
    Buffer.from([0xff]), Buffer.from('[]'), Buffer.from('{"schema":2,"records":{}}'),
    Buffer.from('{"schema":1,"records":{},"extra":true}'),
    Buffer.from(JSON.stringify({ schema: 1, records: { wrong: { ...artifact(), installedAt: new Date().toISOString() } } })),
  ]) {
    await fs.writeFile(f.registry, value)
    await assert.rejects(readResourceRegistry(f.registry))
    assert.deepEqual(await fs.readFile(f.registry), value)
    await assert.rejects(installResourceZip(f.root, artifact(), { fetch: noFetch }))
    assert.deepEqual(await f.stages(), [])
  }
})

test('cancellation before work and during a pending stream leaves no installation and cancels body', async t => {
  const f = await fixture(t)
  const already = new AbortController(); already.abort()
  await assert.rejects(installResourceZip(f.root, artifact(), { signal: already.signal, fetch: noFetch }), isAbort)
  assert.deepEqual(await fs.readdir(f.root), [])
  const controller = new AbortController()
  let cancelled = 0
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) { streamController.enqueue(bytes.subarray(0, 5)) },
    cancel() { cancelled++ },
  })
  await assert.rejects(installResourceZip(f.root, artifact(), {
    fetch: async () => new Response(stream), signal: controller.signal,
    onProgress: event => { if (event.phase === 'download' && event.completedBytes > 0) controller.abort() },
  }), isAbort)
  assert.equal(cancelled, 1)
  await f.absent()
})

test('per-instance concurrency is rejected while unrelated instances remain usable', async t => {
  const f = await fixture(t), other = await fixture(t)
  let release!: () => void, started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = installResourceZip(f.root, artifact(), { fetch: async () => {
    started(); await gate; return new Response(Uint8Array.from(bytes))
  } })
  await ready
  await assert.rejects(installResourceZip(f.root, artifact(), { fetch: noFetch }), /正在进行/)
  await installResourceZip(other.root, artifact(), { fetch: fetchBytes() })
  release()
  await first
  assert.equal((await installResourceZip(f.root, artifact(), { fetch: noFetch })).reused, true)
})

test('cancelling an already pending reader wakes it even when an injected fetch ignores the signal', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  let cancelled = 0, waiting = false
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      waiting = true
      setImmediate(() => controller.abort())
      return new Promise<void>(() => {})
    },
    cancel() { cancelled++ },
  }, { highWaterMark: 0 })
  await assert.rejects(installResourceZip(f.root, artifact(), {
    fetch: async () => new Response(stream), signal: controller.signal,
  }), isAbort)
  assert.equal(waiting, true)
  assert.equal(cancelled, 1)
  await f.absent()
})

test('pre-commit and after-link cancellation roll back; successful registry rename wins late cancellation', async t => {
  for (const phase of ['progress', 'link', 'rename'] as const) {
    const f = await fixture(t)
    const controller = new AbortController()
    const options: ResourceInstallOptions = { fetch: fetchBytes(), signal: controller.signal }
    if (phase === 'progress') options.onProgress = event => { if (event.phase === 'commit') controller.abort() }
    if (phase === 'link') options.link = async (source, destination) => { await fs.link(source, destination); controller.abort() }
    if (phase === 'rename') options.rename = async (source, destination) => { await fs.rename(source, destination); controller.abort() }
    if (phase === 'rename') {
      const result = await installResourceZip(f.root, artifact(), options)
      assert.equal(result.reused, false)
      assert.deepEqual(await fs.readFile(f.target), bytes)
      assert.equal(Object.keys((await readResourceRegistry(f.registry)).records).length, 1)
    } else {
      await assert.rejects(installResourceZip(f.root, artifact(), options), isAbort)
      await f.absent()
    }
  }
})

test('registry rename failure rolls back only the new file and preserves old ledger bytes', async t => {
  const f = await fixture(t)
  const old = Buffer.from('{\n "schema":1, "records":{}\n}\n')
  await fs.writeFile(f.registry, old)
  await assert.rejects(installResourceZip(f.root, artifact(), {
    fetch: fetchBytes(), rename: async () => { throw diskError() },
  }), /injected EIO/)
  await assert.rejects(fs.access(f.target), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(f.registry), old)
  assert.deepEqual(await f.stages(), [])
  await installResourceZip(f.root, artifact(), { fetch: fetchBytes() })
})

test('registry failure cannot delete an identical pre-existing unregistered resource', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.directory, { recursive: true })
  await fs.writeFile(f.target, bytes)
  const original = await fs.stat(f.target)
  await assert.rejects(installResourceZip(f.root, artifact(), { fetch: noFetch, rename: async () => { throw diskError() } }), /EIO/)
  assert.deepEqual(await fs.readFile(f.target), bytes)
  assert.equal((await fs.stat(f.target)).ino, original.ino)
  await assert.rejects(fs.access(f.registry), { code: 'ENOENT' })
  assert.deepEqual(await f.stages(), [])
})

test('no-overwrite link preserves a concurrently created user file', async t => {
  const f = await fixture(t)
  await assert.rejects(installResourceZip(f.root, artifact(), { fetch: fetchBytes(), link: async (source, destination) => {
    await fs.writeFile(destination, 'new external file')
    await fs.link(source, destination)
  } }), { code: 'EEXIST' })
  assert.equal(await fs.readFile(f.target, 'utf8'), 'new external file')
  await assert.rejects(fs.access(f.registry), { code: 'ENOENT' })
  assert.deepEqual(await f.stages(), [])
})

test('external registry edits during download survive and abort the new installation', async t => {
  const f = await fixture(t)
  const changed = '{"schema":1,"records":{}}\n'
  await assert.rejects(installResourceZip(f.root, artifact(), { fetch: async () => {
    await fs.writeFile(f.registry, changed)
    return new Response(Uint8Array.from(bytes))
  } }), /其他操作修改/)
  assert.equal(await fs.readFile(f.registry, 'utf8'), changed)
  await assert.rejects(fs.access(f.target), { code: 'ENOENT' })
  assert.deepEqual(await f.stages(), [])
})

test('external target substitution after linking is preserved and exposes recovery staging', async t => {
  const f = await fixture(t)
  let recovery: ResourceInstallRecoveryError | undefined
  await assert.rejects(installResourceZip(f.root, artifact(), { fetch: fetchBytes(), rename: async () => {
    await fs.unlink(f.target)
    await fs.writeFile(f.target, 'external replacement')
    throw diskError()
  } }), error => {
    assert.ok(error instanceof ResourceInstallRecoveryError)
    recovery = error
    return true
  })
  assert.equal(await fs.readFile(f.target, 'utf8'), 'external replacement')
  assert.equal(recovery!.code, 'RESOURCE_INSTALL_RECOVERY_REQUIRED')
  assert.ok((await fs.readdir(recovery!.stagingDirectory)).includes('recovery.json'))
  assert.deepEqual(await fs.readFile(path.join(recovery!.stagingDirectory, 'payload.zip')), bytes)
  await assert.rejects(fs.access(f.registry), { code: 'ENOENT' })
})

test('in-place external editing after link also prevents destructive rollback', async t => {
  const f = await fixture(t)
  await assert.rejects(installResourceZip(f.root, artifact(), { fetch: fetchBytes(), link: async (source, destination) => {
    await fs.link(source, destination)
    await fs.writeFile(destination, 'user wrote to this new inode')
  } }), ResourceInstallRecoveryError)
  assert.equal(await fs.readFile(f.target, 'utf8'), 'user wrote to this new inode')
  assert.equal((await f.stages()).length, 1)
  await assert.rejects(fs.access(f.registry), { code: 'ENOENT' })
})

test('staged registry tampering is detected before publishing the ledger', async t => {
  const f = await fixture(t)
  await assert.rejects(installResourceZip(f.root, artifact(), { fetch: fetchBytes(), link: async (source, destination) => {
    await fs.link(source, destination)
    await fs.writeFile(path.join(path.dirname(String(source)), 'registry.json'), '{"schema":1,"records":{}}')
  } }), /暂存登记/)
  await f.absent()
})

test('rollback unlink failure preserves payload and recovery evidence', async t => {
  const f = await fixture(t)
  const original = fs.unlink
  hook(t, 'unlink', async file => { if (String(file) === f.target) throw diskError(); await original(file) })
  await assert.rejects(installResourceZip(f.root, artifact(), {
    fetch: fetchBytes(), rename: async () => { throw diskError() },
  }), ResourceInstallRecoveryError)
  assert.deepEqual(await fs.readFile(f.target), bytes)
  const stages = await f.stages()
  assert.equal(stages.length, 1)
  assert.ok((await fs.readdir(path.join(f.root, stages[0]))).includes('recovery.json'))
})

test('post-commit cleanup failure returns success with a warning and valid registry', async t => {
  const f = await fixture(t)
  const original = fs.rmdir
  hook(t, 'rmdir', async (file, options) => {
    if (path.basename(String(file)).startsWith('.resource-staging-')) throw diskError()
    await original(file, options)
  })
  const result = await installResourceZip(f.root, artifact(), { fetch: fetchBytes() })
  assert.equal(result.warnings.length, 1)
  assert.deepEqual(await fs.readFile(f.target), bytes)
  assert.equal(Object.keys((await readResourceRegistry(f.registry)).records).length, 1)
})

test('failed payload open and unsafe response URL both cancel the downloaded body', async t => {
  for (const scenario of ['open', 'url']) {
    const f = await fixture(t)
    let cancelled = 0
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++ } })
    let restore = () => {}
    if (scenario === 'open') {
      const original = fs.open
      restore = hook(t, 'open', async (...args) => {
        if (path.basename(String(args[0])) === 'payload.zip') throw diskError()
        return original(...args)
      })
    }
    try {
      await assert.rejects(installResourceZip(f.root, artifact(), { fetch: async () => {
        const response = new Response(body)
        if (scenario === 'url') Object.defineProperty(response, 'url', { value: 'https://evil.test/file.zip' })
        return response
      } }))
      assert.equal(cancelled, 1)
      await f.absent()
    } finally { restore() }
  }
})
