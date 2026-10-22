import assert from 'node:assert/strict'
import test from 'node:test'
import { createMirrorFetch, defaultDownloadSource, isPublicHttpsHost, mirrorUrl, type DownloadSource } from './download-mirror'

test('official URLs map to BMCLAPI paths and others are left alone', () => {
  assert.equal(mirrorUrl('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'), 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json')
  assert.equal(mirrorUrl('https://resources.download.minecraft.net/ab/abcdef'), 'https://bmclapi2.bangbang93.com/assets/ab/abcdef')
  assert.equal(mirrorUrl('https://libraries.minecraft.net/org/lwjgl/lwjgl.jar'), 'https://bmclapi2.bangbang93.com/maven/org/lwjgl/lwjgl.jar')
  assert.equal(mirrorUrl('https://meta.fabricmc.net/v2/versions/loader/1.21.1'), 'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.21.1')
  assert.equal(mirrorUrl('https://maven.neoforged.net/releases/net/neoforged/neoforge/x.jar'), 'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/x.jar')
  assert.equal(mirrorUrl('https://cdn.modrinth.com/data/x.jar'), undefined)
})

test('mirror redirects may only reach public HTTPS host names', () => {
  assert.equal(isPublicHttpsHost(new URL('https://node1.openbmclapi.example.com/file')), true)
  for (const url of ['http://example.com/', 'https://127.0.0.1/', 'https://localhost/', 'https://printer.local/', 'https://[::1]/', 'https://intranet/']) assert.equal(isPublicHttpsHost(new URL(url)), false, url)
})

test('default source follows the time zone', () => {
  assert.equal(defaultDownloadSource('Asia/Shanghai'), 'mirror')
  assert.equal(defaultDownloadSource('Asia/Tokyo'), 'auto')
})

function harness(responses: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = []
  const base = (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url)
    const make = responses[url]
    if (!make) throw new TypeError('network unreachable')
    return make()
  }) as typeof fetch
  return { calls, base }
}
const official = 'https://piston-data.mojang.com/v1/objects/abc/client.jar'
const mirror = 'https://bmclapi2.bangbang93.com/v1/objects/abc/client.jar'

test('auto mode uses official first and falls back to the mirror, then remembers the slow host', async () => {
  let clock = 0
  const h = harness({ [mirror]: () => new Response('from mirror') })
  const fetcher = createMirrorFetch(h.base, { source: () => 'auto', now: () => clock })
  assert.equal(await (await fetcher(official)).text(), 'from mirror')
  assert.deepEqual(h.calls, [official, mirror])
  h.calls.length = 0
  await fetcher(official)
  assert.deepEqual(h.calls, [mirror], 'official host skipped while marked unhealthy')
  clock = 11 * 60_000; h.calls.length = 0
  await fetcher(official)
  assert.deepEqual(h.calls, [official, mirror])
})

test('mirror mode prefers the mirror, follows its node redirect and falls back to official on 5xx', async () => {
  const h = harness({
    [mirror]: () => new Response(null, { status: 302, headers: { location: 'https://node.example-cdn.com/client.jar' } }),
    'https://node.example-cdn.com/client.jar': () => new Response('node bytes'),
  })
  const fetcher = createMirrorFetch(h.base, { source: () => 'mirror' })
  assert.equal(await (await fetcher(official)).text(), 'node bytes')
  const failing = harness({ [mirror]: () => new Response('busy', { status: 503 }), [official]: () => new Response('official bytes') })
  assert.equal(await (await createMirrorFetch(failing.base, { source: () => 'mirror' })(official)).text(), 'official bytes')
  const evil = harness({ [mirror]: () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/steal' } }), [official]: () => new Response('safe') })
  assert.equal(await (await createMirrorFetch(evil.base, { source: () => 'mirror' })(official)).text(), 'safe')
})

test('official mode and unmapped URLs never touch the mirror; cancellation is not retried', async () => {
  const h = harness({ [official]: () => new Response('ok'), 'https://cdn.modrinth.com/a.jar': () => new Response('mod') })
  let source: DownloadSource = 'official'
  const fetcher = createMirrorFetch(h.base, { source: () => source })
  await fetcher(official)
  source = 'mirror'
  await fetcher('https://cdn.modrinth.com/a.jar')
  assert.deepEqual(h.calls, [official, 'https://cdn.modrinth.com/a.jar'])
  const controller = new AbortController(); controller.abort()
  const aborting = harness({})
  const abortingFetch = createMirrorFetch((async () => { throw new DOMException('aborted', 'AbortError') }) as typeof fetch, { source: () => 'auto' })
  await assert.rejects(abortingFetch(official, { signal: controller.signal }), /aborted/)
  assert.deepEqual(aborting.calls, [])
})

test('a slow official server times out before headers and the mirror is used', async () => {
  const h = harness({
    [official]: () => new Promise<Response>(() => {}),
    [mirror]: () => new Response('fast mirror'),
  })
  const slowBase = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === official) return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    return h.base(input, init)
  }) as typeof fetch
  const fetcher = createMirrorFetch(slowBase, { source: () => 'auto', headerTimeoutMs: 30 })
  assert.equal(await (await fetcher(official)).text(), 'fast mirror')
})
