import assert from 'node:assert/strict'
import test from 'node:test'
import { DATAPACK_CATALOG_LIMITS, datapackSearchParameters, datapackVersionsParameters, normalizeDatapackSearch,
  normalizeDatapackVersions, readDatapackProjectVersions, searchDatapackCatalog } from './datapack-catalog'

const projectId = 'OriginalP', game = '1.21.1'
const file = (patch: Record<string, unknown> = {}) => ({ filename: 'original.zip', primary: true, file_type: null, size: 1024,
  url: 'https://cdn.modrinth.com/data/OriginalP/versions/OriginalV/original.zip', hashes: { sha512: 'a'.repeat(128), sha1: 'b'.repeat(40) }, ...patch })
const version = (patch: Record<string, unknown> = {}) => ({ id: 'OriginalV', project_id: projectId, name: 'Original data pack', version_number: '1.0',
  version_type: 'release', date_published: '2026-10-24T00:00:00Z', game_versions: [game], loaders: ['datapack'], files: [file()], dependencies: [], ...patch })
const project = (patch: Record<string, unknown> = {}) => ({ id: projectId, slug: 'original-data', title: 'Original fixture', description: 'Original inert metadata', project_type: 'mod', loaders: ['fabric', 'datapack'], ...patch })
const hit = (patch: Record<string, unknown> = {}) => ({ project_id: projectId, slug: 'original-data', title: 'Original fixture', description: 'Original inert metadata',
  project_type: 'mod', all_project_types: ['mod', 'datapack'], versions: [game], author: 'Original author', downloads: 12, ...patch })
const search = (hits: unknown[], offset = 0) => ({ hits, total_hits: 42, offset, limit: 20 })
const json = (value: unknown) => Response.json(value)
function fetcher(values: unknown[], calls: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
  let index = 0
  return (async (input, init) => { calls.push({ url: String(input), init }); return json(values[index++]) }) as typeof fetch
}
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)) }
  assert.fail('fixture boundary did not settle')
}

test('search uses all_project_types and exact game facets with upstream pagination', () => {
  const params = datapackSearchParameters('original', game, 20)
  assert.deepEqual(JSON.parse(params.get('facets')!), [['all_project_types:datapack'], [`versions:${game}`]])
  assert.equal(params.get('offset'), '20'); assert.equal(params.get('limit'), '20')
  const result = normalizeDatapackSearch(search([hit(), hit({ project_id: 'WrongType', all_project_types: ['mod'] }), hit({ project_id: 'WrongGame', versions: ['1.20'] })], 20), game, 20)
  assert.equal(result.hits.length, 1); assert.equal(result.totalHits, 42); assert.equal(result.offset, 20); assert.equal(result.limit, 20); assert.equal(result.omittedHits, 2)
  assert.deepEqual(result.hits[0].projectTypes, ['mod', 'datapack'])
})
test('malformed duplicate and unknown search hits are omitted without fabricated types or totals', () => {
  const result = normalizeDatapackSearch(search([hit(), hit(), hit({ project_id: 'MissingType', project_type: undefined, all_project_types: undefined }), hit({ project_id: 'BadTitle', title: '\u0000' })]), game)
  assert.equal(result.hits.length, 1); assert.equal(result.omittedHits, 3); assert.equal(result.totalHits, 42)
  assert.ok(!JSON.stringify(result).includes('icon_url'))
  assert.throws(() => normalizeDatapackSearch({ ...search([]), offset: 20 }, game, 0))
  assert.throws(() => normalizeDatapackSearch({ ...search([]), limit: 2 }, game, 0))
})
test('nonempty search pages cannot exceed the declared total while empty stale pages remain valid', () => {
  assert.throws(() => normalizeDatapackSearch({ ...search([hit()]), total_hits: 0 }, game), /总数/)
  assert.throws(() => normalizeDatapackSearch({ ...search([hit()], 20), total_hits: 20 }, game, 20), /总数/)
  const empty = normalizeDatapackSearch({ ...search([], 20), total_hits: 0 }, game, 20)
  assert.deepEqual(empty, { hits: [], totalHits: 0, offset: 20, limit: 20, omittedHits: 0 })
})
test('query version and pagination input cannot create arbitrary metadata requests', async () => {
  for (const query of ['x'.repeat(201), 'a\n']) assert.throws(() => datapackSearchParameters(query, game))
  for (const offset of [-1, 0.5, 100001]) assert.throws(() => datapackSearchParameters('', game, offset))
  assert.throws(() => datapackSearchParameters('', '../unsafe'))
  let called = false
  await assert.rejects(readDatapackProjectVersions('../unsafe', { gameVersion: game, fetch: async () => { called = true; return json([]) } }))
  assert.equal(called, false)
})
test('mixed primary mod project GET without all_project_types is accepted only for independently matching versions', () => {
  const result = normalizeDatapackVersions(project(), [version()], projectId, game)
  assert.deepEqual(result.project.projectTypes, ['mod', 'datapack'])
  const v = result.versions[0]
  assert.equal(v.declaresCurrentGameVersion, true); assert.equal(v.declaresDatapack, true)
  assert.equal(v.mainFile?.filename, 'original.zip'); assert.equal(v.externalOnly, false)
  assert.ok(v.warnings.some(value => value.includes('没有下载')))
  assert.ok(!JSON.stringify(result).includes('cdn.modrinth.com'))
})
test('matching request filters never substitute for version project game and loader checks', () => {
  const result = normalizeDatapackVersions(project(), [version({ project_id: 'ForeignP' }), version({ game_versions: ['1.20'] }), version({ loaders: ['fabric'] }), version()], projectId, game)
  assert.equal(result.versions.length, 1); assert.equal(result.upstreamVersionCount, 4); assert.equal(result.omittedVersions, 3)
  assert.throws(() => normalizeDatapackVersions(project({ id: 'ForeignP' }), [version()], projectId, game))
})
test('one unique unmarked main ZIP is a candidate but ambiguous or resource-pack primary files stay external', () => {
  assert.equal(normalizeDatapackVersions(project(), [version({ files: [file({ primary: false })] })], projectId, game).versions[0].mainFile?.filename, 'original.zip')
  for (const files of [
    [file({ primary: false }), file({ filename: 'second.zip', primary: false })],
    [file(), file({ filename: 'second.zip' })],
    [file({ file_type: 'optional-resource-pack' })],
    [file({ file_type: 'signature' })],
  ]) {
    const result = normalizeDatapackVersions(project(), [version({ files })], projectId, game).versions[0]
    assert.equal(result.externalOnly, true); assert.equal(result.mainFile, undefined); assert.ok(result.reasons.length)
  }
})
test('required sidecars block automatic handling and optional sidecars stay informational', () => {
  const required = normalizeDatapackVersions(project(), [version({ files: [file(), file({ filename: 'required.zip', primary: false, file_type: 'required-resource-pack' })] })], projectId, game).versions[0]
  assert.equal(required.externalOnly, true); assert.equal(required.files[1].role, 'required-resource-pack'); assert.ok(required.reasons.some(value => value.includes('必需附带')))
  const optional = normalizeDatapackVersions(project(), [version({ files: [file(), file({ filename: 'optional.zip', primary: false, file_type: 'optional-resource-pack' })] })], projectId, game).versions[0]
  assert.equal(optional.externalOnly, false); assert.equal(optional.files[1].eligible, false); assert.ok(optional.warnings.some(value => value.includes('可选附带')))
})
test('dependency types are explicit; required and incompatible dependencies stay external-only', () => {
  for (const type of ['required', 'incompatible', 'optional', 'embedded']) {
    const value = normalizeDatapackVersions(project(), [version({ dependencies: [{ dependency_type: type, project_id: 'DepP', version_id: null, file_name: null }] })], projectId, game).versions[0]
    assert.equal(value.dependencies[0].type, type); assert.equal(value.externalOnly, type === 'required' || type === 'incompatible')
  }
  const bad = normalizeDatapackVersions(project(), [version({ dependencies: [{ dependency_type: 'future' }] })], projectId, game)
  assert.equal(bad.omittedVersions, 1)
})
test('invalid hashes size filename or CDN remain visible external-only file reasons', () => {
  for (const patch of [{ hashes: { sha512: 'bad' } }, { hashes: { sha512: 'a'.repeat(128), sha1: 'bad' } }, { size: ZIP_MAX + 1 }, { filename: '../bad.zip' },
    { filename: '\ufeffbad.zip' }, { url: 'http://cdn.modrinth.com/file.zip' }, { url: 'https://cdn.modrinth.com.evil.invalid/file.zip' }, { url: 'https://user@cdn.modrinth.com/file.zip' }, { url: 'https://cdn.modrinth.com:444/file.zip' }]) {
    const value = normalizeDatapackVersions(project(), [version({ files: [file(patch)] })], projectId, game).versions[0]
    assert.equal(value.externalOnly, true); assert.equal(value.files[0].eligible, false); assert.ok(value.files[0].reason)
  }
})
const ZIP_MAX = 512 * 1024 ** 2
test('duplicate case-folded file names and duplicate version IDs do not create a unique install candidate', () => {
  const files = [file(), file({ filename: 'ORIGINAL.zip', primary: false })]
  assert.equal(normalizeDatapackVersions(project(), [version({ files })], projectId, game).versions[0].externalOnly, true)
  const value = normalizeDatapackVersions(project(), [version(), version()], projectId, game)
  assert.equal(value.versions.length, 1); assert.equal(value.omittedVersions, 1)
})
test('project and version network routes use GET User-Agent exact delivery filters and no archive URL', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const result = await readDatapackProjectVersions(projectId, { gameVersion: game, userAgent: 'LuaLauncher/fixture', fetch: fetcher([project(), [version()]], calls) })
  assert.equal(result.versions.length, 1); assert.equal(calls.length, 2)
  assert.equal(calls[0].url, `https://api.modrinth.com/v2/project/${projectId}`)
  const target = new URL(calls[1].url)
  assert.equal(target.searchParams.get('include_changelog'), 'false')
  assert.deepEqual(JSON.parse(target.searchParams.get('loaders')!), ['datapack']); assert.deepEqual(JSON.parse(target.searchParams.get('game_versions')!), [game])
  assert.equal(new Headers(calls[1].init?.headers).get('User-Agent'), 'LuaLauncher/fixture'); assert.equal(calls[1].init?.redirect, 'manual')
  assert.deepEqual(datapackVersionsParameters(game).get('loaders'), '["datapack"]')
})
test('a wrong project response prevents the second request', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  await assert.rejects(readDatapackProjectVersions(projectId, { gameVersion: game, fetch: fetcher([project({ id: 'WrongP' })], calls) }))
  assert.equal(calls.length, 1)
})
test('only same-origin v2 metadata redirects are followed and redirect bodies are cancelled', async () => {
  let cancelled = false, calls = 0
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  const fetch = (async () => { calls++; return new Response(body, { status: 302, headers: { location: 'https://cdn.modrinth.com/archive.zip' } }) }) as typeof globalThis.fetch
  await assert.rejects(searchDatapackCatalog('', { gameVersion: game, fetch }))
  assert.equal(calls, 1); assert.equal(cancelled, true)
})
test('same-origin metadata redirects succeed without changing the output context', async () => {
  let calls = 0
  const fetch = (async () => ++calls === 1 ? new Response(null, { status: 307, headers: { location: '/v2/search?fixture=1' } }) : json(search([hit()]))) as typeof globalThis.fetch
  const value = await searchDatapackCatalog('', { gameVersion: game, fetch }); assert.equal(value.hits.length, 1); assert.equal(calls, 2)
})
test('HTTP errors and HTML bodies are cancelled without parsing or returning raw URLs', async () => {
  for (const [status, type] of [[429, 'application/json'], [200, 'text/html']] as const) {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    await assert.rejects(searchDatapackCatalog('', { gameVersion: game, fetch: (async () => new Response(body, { status, headers: { 'Content-Type': type } })) as typeof fetch }))
    assert.equal(cancelled, true)
  }
})
test('actual streamed bytes are capped even when Content-Length falsely says zero; reader unlocks', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(DATAPACK_CATALOG_LIMITS.bodyBytes + 1)) }, cancel() { cancelled = true } })
  await assert.rejects(searchDatapackCatalog('', { gameVersion: game, fetch: (async () => new Response(stream, { headers: { 'Content-Type': 'application/json', 'Content-Length': '0' } })) as typeof fetch }))
  assert.equal(cancelled, true); assert.equal(stream.locked, false)
})
test('invalid UTF-8 JSON and excessive structure are rejected', async () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{broken'), Buffer.from('['.repeat(40) + '0' + ']'.repeat(40))]) {
    await assert.rejects(searchDatapackCatalog('', { gameVersion: game, fetch: (async () => new Response(bytes, { headers: { 'Content-Type': 'application/json' } })) as typeof fetch }))
  }
})
test('ignoring AbortSignal cannot keep a headers wait pending; late response is cancelled', async () => {
  let resolve!: (r: Response) => void, cancelled = false
  const pending = new Promise<Response>(yes => { resolve = yes })
  const started = Date.now()
  await assert.rejects(searchDatapackCatalog('', { gameVersion: game, headersTimeoutMs: 15, timeoutMs: 80, fetch: (() => pending) as typeof fetch }), /超时/)
  assert.ok(Date.now() - started < 1000)
  resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), { headers: { 'Content-Type': 'application/json' } }))
  await until(() => cancelled)
})
test('idle stream failure cancels and releases the reader even when cancel itself never settles', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise(() => {}) } })
  const started = Date.now()
  await assert.rejects(searchDatapackCatalog('', { gameVersion: game, idleTimeoutMs: 15, timeoutMs: 100, fetch: (async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } })) as typeof fetch }), /停滞|超时/)
  assert.ok(Date.now() - started < 1000); assert.equal(cancelled, true); assert.equal(stream.locked, false)
})
test('explicit cancellation is bounded and a stream of empty chunks cannot spin indefinitely', async () => {
  const controller = new AbortController(), stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array()) } })
  await assert.rejects(searchDatapackCatalog('', { gameVersion: game, fetch: (async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } })) as typeof fetch }), /进展/)
  assert.equal(stream.locked, false)
  const pending = searchDatapackCatalog('', { gameVersion: game, signal: controller.signal, fetch: (() => new Promise(() => {})) as typeof fetch })
  controller.abort(new DOMException('Original fixture cancellation', 'AbortError'))
  await assert.rejects(pending, { name: 'AbortError' })
})
test('total shared budget spans project and version requests', async () => {
  let calls = 0
  const fetch = (async () => { calls++; if (calls === 1) return json(project()); return new Promise<Response>(() => {}) }) as typeof globalThis.fetch
  const started = Date.now()
  await assert.rejects(readDatapackProjectVersions(projectId, { gameVersion: game, timeoutMs: 20, fetch }), /超时/)
  assert.equal(calls, 2); assert.ok(Date.now() - started < 1000)
})
test('version arrays and output DTOs are bounded with honest omitted counts', () => {
  const input = Array.from({ length: 120 }, (_, n) => version({ id: `Original${n}`, name: 'n'.repeat(256), files: [file()] }))
  const value = normalizeDatapackVersions(project(), input, projectId, game)
  assert.equal(value.versions.length, 100); assert.equal(value.omittedVersions, 20); assert.equal(value.upstreamVersionCount, 120)
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < DATAPACK_CATALOG_LIMITS.dtoBytes)
  assert.throws(() => normalizeDatapackVersions(project(), new Array(501).fill(version()), projectId, game))
})
