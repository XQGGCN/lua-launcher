import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { DATAPACK_ARTIFACT_LIMITS, downloadDatapackArtifact, resolveDatapackArtifact,
  type DatapackArtifactSelection, type ModrinthDatapackArtifact } from './datapack-artifact'

const bytes = Buffer.from('Original inert transport bytes; ZIP parsing belongs to the separate inspector.')
const digest = (algorithm: string, input = bytes) => createHash(algorithm).update(input).digest('hex')
const selected = (patch: Partial<DatapackArtifactSelection> = {}): DatapackArtifactSelection => ({
  projectId: 'Project1', versionId: 'Version1', filename: 'Original.zip', size: bytes.length, sha512: digest('sha512'), sha1: digest('sha1'), ...patch,
})
const artifact = (patch: Partial<ModrinthDatapackArtifact> = {}): ModrinthDatapackArtifact => ({
  ...selected(), source: 'modrinth', url: 'https://cdn.modrinth.com/data/Project1/versions/Version1/Original.zip', ...patch,
})
const project = () => ({ id: 'Project1', slug: 'original', title: 'Original fixture', description: 'Authored test metadata', project_type: 'mod', loaders: ['datapack', 'fabric'] })
const version = () => ({ id: 'Version1', project_id: 'Project1', name: 'Original release', version_number: '1.0',
  date_published: '2026-01-01T00:00:00Z', version_type: 'release', game_versions: ['1.21.1'], loaders: ['datapack'],
  files: [{ filename: 'Original.zip', primary: true, size: bytes.length, url: artifact().url, hashes: { sha512: digest('sha512'), sha1: digest('sha1') } }], dependencies: [] as unknown[] })
const json = (value: unknown, headers: HeadersInit = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } })
function metadataFetch(raw = version(), info = project(), requests: string[] = []): typeof fetch {
  return async (url, init) => {
    requests.push(String(url)); assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'manual')
    assert.equal(new Headers(init?.headers).get('user-agent'), 'OriginalTest/1')
    return String(url).includes('/project/') ? json(info) : json(raw)
  }
}
const noFetch: typeof fetch = async () => { throw new Error('unexpected network') }
const options = { gameVersion: '1.21.1', userAgent: 'OriginalTest/1' }
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-datapack-artifact-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const instance = path.join(root, 'instance'); await fs.mkdir(instance)
  await fs.writeFile(path.join(instance, 'keep.txt'), 'unaltered original')
  return { root, instance, stages: async () => fs.readdir(path.join(instance, '.datapack-sources')) }
}
const bodyFetch = (body = bytes, headers: HeadersInit = {}): typeof fetch => async (_url, init) => {
  assert.equal(init?.redirect, 'manual'); assert.equal(new Headers(init?.headers).get('user-agent'), 'OriginalTest/1')
  return new Response(Uint8Array.from(body), { headers })
}
const mutableFs = createRequire(import.meta.url)('node:fs/promises') as typeof fs
function hook<K extends keyof typeof fs>(t: TestContext, name: K, fn: typeof fs[K]) {
  const mock = t.mock.method(mutableFs, name, fn as never); syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
}
const aborted = (error: unknown) => error instanceof Error && error.name === 'AbortError'

test('fresh exact project/version main declaration becomes private artifact only after both bounded GETs', async () => {
  const requests: string[] = []
  assert.deepEqual(await resolveDatapackArtifact(selected(), { ...options, fetch: metadataFetch(version(), project(), requests) }), artifact())
  assert.deepEqual(requests, ['https://api.modrinth.com/v2/project/Project1', 'https://api.modrinth.com/v2/version/Version1'])
})
test('invalid or arbitrary renderer fields reject before network', async () => {
  for (const value of [selected({ filename: '../foreign.zip' }), selected({ projectId: '..' }), selected({ size: 21 }),
    selected({ sha512: 'bad' }), { ...selected(), url: artifact().url }, { ...selected(), other: true }, []]) {
    await assert.rejects(resolveDatapackArtifact(value as DatapackArtifactSelection, { ...options, fetch: noFetch }))
  }
  await assert.rejects(resolveDatapackArtifact(selected(), { ...options, gameVersion: '../1.21', fetch: noFetch }))
})
test('changed project is rejected before selected-version request', async () => {
  const requests: string[] = []
  await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: metadataFetch(version(), { ...project(), id: 'Other' }, requests) }))
  assert.equal(requests.length, 1)
})
test('selected-version identity, project, loader and game declaration are freshly required', async () => {
  for (const patch of [{ id: 'Other' }, { project_id: 'Other' }, { loaders: ['fabric'] }, { game_versions: ['1.21'] }]) {
    await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: metadataFetch({ ...version(), ...patch }) }))
  }
})
test('changed filename size SHA-512 or SHA-1 cannot silently replace the confirmed main file', async () => {
  for (const patch of [{ filename: 'Changed.zip' }, { size: bytes.length + 1 }, { hashes: { sha512: 'a'.repeat(128), sha1: digest('sha1') } },
    { hashes: { sha512: digest('sha512'), sha1: 'a'.repeat(40) } }]) {
    const v = version(); v.files[0] = { ...v.files[0], ...patch }
    await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: metadataFetch(v) }), /变化/)
  }
  await assert.rejects(resolveDatapackArtifact(selected({ sha1: undefined }), { ...options, fetch: metadataFetch() }), /变化/)
})
test('fresh required/incompatible dependencies and required sidecar remain blocked', async () => {
  for (const type of ['required', 'incompatible']) {
    await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: metadataFetch({ ...version(), dependencies: [{ dependency_type: type, project_id: 'Dependency1' }] }) }))
  }
  const v = version(); v.files.push({ ...v.files[0], filename: 'Resources.zip', primary: false, file_type: 'required-resource-pack' } as typeof v.files[number])
  await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: metadataFetch(v) }))
})
test('optional dependency and optional resource pack do not become automatically downloaded sidecars', async () => {
  const v = version(); v.dependencies.push({ dependency_type: 'optional', project_id: 'Dependency1' })
  v.files.push({ ...v.files[0], filename: 'Resources.zip', primary: false, file_type: 'optional-resource-pack' } as typeof v.files[number])
  const value = await resolveDatapackArtifact(selected(), { ...options, fetch: metadataFetch(v) })
  assert.deepEqual(value, artifact()); assert.equal(Object.hasOwn(value, 'dependencies'), false)
})
test('duplicate case-folded or ambiguous primary file declarations reject', async () => {
  for (const name of ['Original.zip', 'original.zip', 'Other.zip']) {
    const v = version(); v.files.push({ ...v.files[0], filename: name })
    await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: metadataFetch(v) }))
  }
})
test('untrusted CDN URL, credentials explicit port and fragments never enter private artifact', async () => {
  for (const url of ['http://cdn.modrinth.com/a.zip', 'https://evil.invalid/a.zip', 'https://cdn.modrinth.com:443/a.zip',
    'https://user@cdn.modrinth.com/a.zip', 'https://cdn.modrinth.com/a.zip#fragment']) {
    const v = version(); v.files[0].url = url
    await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: metadataFetch(v) }))
  }
})
test('metadata redirects remain official-only and rejected responses release their bodies', async () => {
  let cancelled = 0
  const bad: typeof fetch = async () => new Response(new ReadableStream({ cancel() { cancelled++ } }), { status: 302, headers: { location: 'https://evil.invalid/v2/file' } })
  await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: bad }))
  assert.equal(cancelled, 1)
})
test('non-JSON, oversized declaration and excessive JSON depth reject bounded metadata', async () => {
  const bad: typeof fetch = async () => new Response('{}', { headers: { 'content-type': 'text/html' } })
  await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: bad }))
  await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: async () => json({}, { 'content-length': String(DATAPACK_ARTIFACT_LIMITS.metadataBytes + 1) }) }))
  let deep: unknown = 1; for (let i = 0; i < 35; i++) deep = [deep]
  await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: async () => json(deep) }))
})
test('decoded compressed metadata is bounded by actual bytes rather than encoded Content-Length', async () => {
  const fetcher: typeof fetch = async input => json(String(input).includes('/project/') ? project() : version(), { 'content-encoding': 'gzip', 'content-length': '12' })
  assert.deepEqual(await resolveDatapackArtifact(selected(), { ...options, fetch: fetcher }), artifact())
})
test('late header resolution is cancelled after bounded metadata wait', async () => {
  let finish!: (response: Response) => void, cancelled = 0
  const pending: typeof fetch = async () => new Promise<Response>(resolve => { finish = resolve })
  await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: pending, headersTimeoutMs: 5, timeoutMs: 30 }), /超时/)
  finish(new Response(new ReadableStream({ cancel() { cancelled++ } }), { headers: { 'content-type': 'application/json' } }))
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(cancelled, 1)
})
test('stalled metadata body cancels and releases its reader', async () => {
  let stream!: ReadableStream<Uint8Array>, cancelled = 0
  const pending: typeof fetch = async () => new Response(stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++ } }), { headers: { 'content-type': 'application/json' } })
  await assert.rejects(resolveDatapackArtifact(selected(), { ...options, fetch: pending, idleTimeoutMs: 5 }), /停滞/)
  assert.equal(cancelled, 1); assert.equal(stream.locked, false)
})
test('download writes a unique private source, independently hashes disk and preserves the instance', async t => {
  const f = await fixture(t), before = await fs.stat(path.join(f.instance, 'keep.txt'), { bigint: true })
  const positions: number[] = []
  const result = await downloadDatapackArtifact(f.instance, artifact(), { userAgent: options.userAgent, fetch: bodyFetch(bytes, { 'content-length': String(bytes.length) }), onProgress: n => { positions.push(n) } })
  assert.equal(result.filename, 'Original.zip'); assert.equal(result.archiveBytes, bytes.length); assert.equal(result.sha512, digest('sha512'))
  assert.equal(result.sha1, digest('sha1')); assert.equal(path.basename(result.file), 'payload.zip')
  assert.equal(path.basename(path.dirname(path.dirname(result.file))), '.datapack-sources')
  assert.deepEqual(await fs.readFile(result.file), bytes); assert.deepEqual(positions, [bytes.length])
  const after = await fs.stat(path.join(f.instance, 'keep.txt'), { bigint: true })
  assert.equal(before.ino, after.ino); assert.equal(before.mtimeNs, after.mtimeNs); assert.equal(before.ctimeNs, after.ctimeNs)
  await assert.rejects(fs.access(path.join(f.instance, 'game')), { code: 'ENOENT' })
  const second = await downloadDatapackArtifact(f.instance, artifact(), { userAgent: options.userAgent, fetch: bodyFetch() })
  assert.notEqual(second.file, result.file); assert.deepEqual(await fs.readFile(result.file), bytes)
})
test('invalid private artifact and already-aborted request do not create preparation directories', async t => {
  const f = await fixture(t)
  for (const value of [artifact({ source: 'bbsmc' as 'modrinth' }), artifact({ url: 'https://evil.invalid/a.zip' }), { ...artifact(), extra: true }]) {
    await assert.rejects(downloadDatapackArtifact(f.instance, value, { fetch: noFetch }))
  }
  await assert.rejects(downloadDatapackArtifact(f.instance, artifact(), { fetch: noFetch, signal: AbortSignal.abort() }), aborted)
  assert.deepEqual(await fs.readdir(f.instance), ['keep.txt'])
})
test('preparation directory symlinks and non-directories are rejected before network', async t => {
  for (const scenario of ['link', 'file']) {
    const f = await fixture(t), target = path.join(f.instance, '.datapack-sources')
    if (scenario === 'link') await fs.symlink(f.root, target)
    else await fs.writeFile(target, 'foreign')
    await assert.rejects(downloadDatapackArtifact(f.instance, artifact(), { fetch: noFetch }))
    if (scenario === 'file') assert.equal(await fs.readFile(target, 'utf8'), 'foreign')
  }
})
test('short disk writes loop until the complete original payload is retained', async t => {
  const f = await fixture(t), original = fs.open
  hook(t, 'open', (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[1] === 'wx') {
      const write = handle.write.bind(handle)
      handle.write = (async (buffer: Uint8Array, offset: number, length: number, position: number) => write(buffer, offset, Math.min(length, 7), position)) as typeof handle.write
    }
    return handle
  }) as typeof fs.open)
  const result = await downloadDatapackArtifact(f.instance, artifact(), { userAgent: options.userAgent, fetch: bodyFetch() })
  assert.deepEqual(await fs.readFile(result.file), bytes)
})
test('zero disk write retains private evidence without touching the instance', async t => {
  const f = await fixture(t), original = fs.open
  hook(t, 'open', (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[1] === 'wx') handle.write = (async (buffer: Uint8Array) => ({ bytesWritten: 0, buffer })) as typeof handle.write
    return handle
  }) as typeof fs.open)
  await assert.rejects(downloadDatapackArtifact(f.instance, artifact(), { userAgent: options.userAgent, fetch: bodyFetch() }), /进展/)
  assert.equal((await f.stages()).length, 1); assert.equal(await fs.readFile(path.join(f.instance, 'keep.txt'), 'utf8'), 'unaltered original')
})
test('actual write ENOSPC rejects and retains the unfinished private file', async t => {
  const f = await fixture(t), original = fs.open
  hook(t, 'open', (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[1] === 'wx') handle.write = (async () => { throw Object.assign(new Error('Original injected full disk'), { code: 'ENOSPC' }) }) as typeof handle.write
    return handle
  }) as typeof fs.open)
  await assert.rejects(downloadDatapackArtifact(f.instance, artifact(), { userAgent: options.userAgent, fetch: bodyFetch() }), { code: 'ENOSPC' })
  assert.equal((await f.stages()).length, 1); assert.equal(await fs.readFile(path.join(f.instance, 'keep.txt'), 'utf8'), 'unaltered original')
})
test('wrong network digest size and declared length cannot produce a successful source', async t => {
  for (const scenario of ['hash', 'short', 'oversize', 'header']) {
    const f = await fixture(t)
    const body = scenario === 'short' ? bytes.subarray(1) : scenario === 'oversize' ? Buffer.concat([bytes, Buffer.from('x')]) : scenario === 'hash' ? Buffer.alloc(bytes.length) : bytes
    await assert.rejects(downloadDatapackArtifact(f.instance, artifact(), { userAgent: options.userAgent,
      fetch: bodyFetch(body, scenario === 'header' ? { 'content-length': String(bytes.length + 1) } : {}) }))
    assert.equal((await f.stages()).length, 1)
  }
})
test('compressed wire length cannot replace the actual ZIP size and digest check', async t => {
  const f = await fixture(t)
  const result = await downloadDatapackArtifact(f.instance, artifact(), { userAgent: options.userAgent,
    fetch: bodyFetch(bytes, { 'content-encoding': 'gzip', 'content-length': '12' }) })
  assert.deepEqual(await fs.readFile(result.file), bytes)
  await assert.rejects(downloadDatapackArtifact(f.instance, artifact(), { userAgent: options.userAgent,
    fetch: bodyFetch(bytes.subarray(1), { 'content-encoding': 'gzip', 'content-length': '12' }) }))
})
test('independent readback catches actual on-disk corruption after the network stream succeeded', async t => {
  const f = await fixture(t)
  const original = fs.open
  hook(t, 'open', (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[1] === 'wx') {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { await handle.write(Buffer.from('X'), 0, 1, 0); await sync() }
    }
    return handle
  }) as typeof fs.open)
  await assert.rejects(downloadDatapackArtifact(f.instance, artifact(), { userAgent: options.userAgent, fetch: bodyFetch() }), /磁盘校验/)
})
test('cancel after a real write settles the file handle and retains only private source data', async t => {
  const f = await fixture(t), controller = new AbortController()
  await assert.rejects(downloadDatapackArtifact(f.instance, artifact(), { signal: controller.signal, userAgent: options.userAgent,
    fetch: bodyFetch(), onProgress: () => controller.abort() }), aborted)
  assert.equal((await f.stages()).length, 1)
  assert.deepEqual(await fs.readdir(f.instance), ['.datapack-sources', 'keep.txt'])
})
test('download redirect host changes and HTTP failures cancel response bodies', async t => {
  const f = await fixture(t); let cancelled = 0
  const rejected: typeof fetch = async () => new Response(new ReadableStream({ cancel() { cancelled++ } }), { status: 302, headers: { location: 'https://api.modrinth.com/not-a-file' } })
  await assert.rejects(downloadDatapackArtifact(f.instance, artifact(), { fetch: rejected }))
  assert.equal(cancelled, 1)
  await assert.rejects(downloadDatapackArtifact(f.instance, artifact(), { fetch: async () => new Response('no', { status: 429 }) }), /429/)
})
test('stalled source body cancels and releases the stream before returning', async t => {
  const f = await fixture(t); let stream!: ReadableStream<Uint8Array>, cancelled = 0
  await assert.rejects(downloadDatapackArtifact(f.instance, artifact(), { idleTimeoutMs: 5,
    fetch: async () => new Response(stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++ } })) }), /停滞/)
  assert.equal(cancelled, 1); assert.equal(stream.locked, false)
})
