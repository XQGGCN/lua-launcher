import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { checkForUpdate, compareVersions, downloadUpdate, replaceAppImage, RELEASES_API, UpdateRecoveryError } from './updater'

const installer = Buffer.from('fake installer bytes '.repeat(100))
const sha = createHash('sha256').update(installer).digest('hex')
const checksum = (bytes: Buffer) => ({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
const downloadAsset = (bytes = installer, name = 'Lua-Setup-0.10.4.exe') => ({ name, ...checksum(bytes), url: `https://github.com/XQGGCN/lua-launcher/releases/download/v0.10.4/${name}` })
const servedBytes = (bytes = installer) => (async () => new Response(new Uint8Array(bytes))) as typeof fetch
async function temp(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lua-update-hardening-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
function patch<K extends 'open' | 'link' | 'rename'>(t: TestContext, method: K, value: typeof fs[K]) {
  const original = fs[method]
  ;(fs as unknown as Record<string, unknown>)[method] = value; syncBuiltinESMExports()
  t.after(() => { (fs as unknown as Record<string, unknown>)[method] = original; syncBuiltinESMExports() })
}
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag, draft: false, prerelease: true, body: `notes ${tag}`, published_at: '2026-10-22T00:00:00Z',
  html_url: `https://github.com/XQGGCN/lua-launcher/releases/tag/${tag}`,
  assets: [
    { name: `Lua-Setup-${tag.slice(1)}.exe`, size: installer.length, digest: `sha256:${sha}`, browser_download_url: `https://github.com/XQGGCN/lua-launcher/releases/download/${tag}/Lua-Setup-${tag.slice(1)}.exe` },
    { name: `Lua-${tag.slice(1)}-arm64.dmg`, size: installer.length, digest: `sha256:${sha}`, browser_download_url: `https://github.com/XQGGCN/lua-launcher/releases/download/${tag}/Lua-${tag.slice(1)}-arm64.dmg` },
    { name: `Lua-${tag.slice(1)}.AppImage`, size: installer.length, digest: `sha256:${sha}`, browser_download_url: `https://github.com/XQGGCN/lua-launcher/releases/download/${tag}/Lua-${tag.slice(1)}.AppImage` },
  ],
  ...extra,
})
const api = (releases: unknown[]) => (async (input: string | URL | Request) => {
  assert.equal(String(input), RELEASES_API)
  return new Response(JSON.stringify(releases))
}) as typeof fetch

test('versions compare numerically with prereleases below releases', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(compareVersions('0.9.0', '0.9.1'), -1)
})

test('the newest non-draft release is offered with the right asset per platform', async () => {
  const releases = [release('v0.9.0'), release('v1.0.0', { draft: true }), release('v0.10.0')]
  const windows = await checkForUpdate('0.9.0', { fetch: api(releases), platform: 'win32', arch: 'x64' })
  assert.equal(windows?.version, '0.10.0'); assert.equal(windows?.action, 'installer'); assert.equal(windows?.asset?.name, 'Lua-Setup-0.10.0.exe')
  assert.equal(windows?.asset?.sha256, sha)
  const mac = await checkForUpdate('0.9.0', { fetch: api(releases), platform: 'darwin', arch: 'arm64' })
  assert.equal(mac?.action, 'open-dmg'); assert.match(mac!.asset!.name, /arm64\.dmg$/)
  const linux = await checkForUpdate('0.9.0', { fetch: api(releases), platform: 'linux', arch: 'x64', appImage: '/opt/Lua.AppImage' })
  assert.equal(linux?.action, 'appimage')
  const linuxNoAppImage = await checkForUpdate('0.9.0', { fetch: api(releases), platform: 'linux', arch: 'x64' })
  assert.equal(linuxNoAppImage?.action, 'page')
  assert.equal(await checkForUpdate('0.10.0', { fetch: api(releases), platform: 'win32' }), null)
})

test('assets without a GitHub digest or from other hosts are not installable', async () => {
  const noDigest = release('v0.10.0'); (noDigest.assets[0] as { digest: string | null }).digest = null
  assert.equal((await checkForUpdate('0.9.0', { fetch: api([noDigest]), platform: 'win32' }))?.action, 'page')
  const foreign = release('v0.10.0'); foreign.assets[0].browser_download_url = 'https://evil.example.com/Lua-Setup.exe'
  assert.equal((await checkForUpdate('0.9.0', { fetch: api([foreign]), platform: 'win32' }))?.asset, undefined)
})

test('downloads follow GitHub redirects, verify SHA-256 and reject tampering', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-update-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const asset = { name: 'Lua-Setup-0.10.0.exe', size: installer.length, sha256: sha, url: 'https://github.com/XQGGCN/lua-launcher/releases/download/v0.10.0/Lua-Setup-0.10.0.exe' }
  const served = (body: Buffer, redirect = 'https://release-assets.githubusercontent.com/file') => (async (input: string | URL | Request) => {
    if (String(input) === asset.url) return new Response(null, { status: 302, headers: { location: redirect } })
    return new Response(new Uint8Array(body))
  }) as typeof fetch
  const progress: number[] = []
  const file = await downloadUpdate(asset, directory, { fetch: served(installer), onProgress: received => progress.push(received) })
  assert.deepEqual(await fs.readFile(file), installer)
  assert.equal(progress.at(-1), installer.length)
  const tampered = Buffer.from(installer); tampered[3] ^= 1
  await assert.rejects(downloadUpdate({ ...asset, name: 'b.exe', url: asset.url.replace(asset.name, 'b.exe') }, directory, { fetch: served(tampered) }), /校验失败/)
  await assert.rejects(fs.access(path.join(directory, 'b.exe.partial')))
  await assert.rejects(downloadUpdate({ ...asset, name: 'c.exe', url: asset.url.replace(asset.name, 'c.exe') }, directory, { fetch: (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } })) as typeof fetch }), /不受信任/)
})

test('AppImage replacement keeps the file executable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-appimage-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const current = path.join(directory, 'Lua.AppImage'), downloaded = path.join(directory, 'new.AppImage')
  await fs.writeFile(current, 'old'); await fs.writeFile(downloaded, 'new')
  await replaceAppImage(downloaded, current, { expected: checksum(Buffer.from('new')) })
  assert.equal(await fs.readFile(current, 'utf8'), 'new')
  if (process.platform !== 'win32') assert.equal((await fs.stat(current)).mode & 0o111, 0o111)
})

test('downloads isolate each operation and preserve preexisting shared files and partial links', async t => {
  const root = await temp(t), asset = downloadAsset(), victim = path.join(root, 'unrelated.txt')
  await fs.writeFile(victim, 'unrelated private bytes')
  await fs.writeFile(path.join(root, asset.name), 'old shared installer')
  await fs.symlink(victim, path.join(root, `${asset.name}.partial`))
  const file = await downloadUpdate(asset, root, { fetch: servedBytes() })
  assert.notEqual(path.dirname(file), root)
  assert.deepEqual(await fs.readFile(file), installer)
  assert.equal(await fs.readFile(victim, 'utf8'), 'unrelated private bytes')
  assert.equal(await fs.readFile(path.join(root, asset.name), 'utf8'), 'old shared installer')
  assert.equal((await fs.lstat(path.join(root, `${asset.name}.partial`))).isSymbolicLink(), true)
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700)
})

test('parallel same-name downloads cannot remove or corrupt a previously completed peer', async t => {
  const root = await temp(t), a = Buffer.alloc(2000, 65), b = Buffer.alloc(2000, 66)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
  const body = new ReadableStream<Uint8Array>({ async start(controller) {
    controller.enqueue(a.subarray(0, 1000)); await gate; controller.enqueue(a.subarray(1000)); controller.close()
  } })
  const first = downloadUpdate(downloadAsset(a), root, { fetch: (async () => new Response(body)) as typeof fetch, onProgress: received => { if (received === 1000) entered() } })
  await reached
  const secondFile = await downloadUpdate(downloadAsset(b), root, { fetch: servedBytes(b) })
  release()
  const firstFile = await first
  assert.notEqual(firstFile, secondFile)
  assert.deepEqual(await fs.readFile(firstFile), a)
  assert.deepEqual(await fs.readFile(secondFile), b)
})

test('short writes are completed and disk corruption after network verification is rejected', async t => {
  const root = await temp(t), original = fs.open
  let corruptOnSync = false, writeCalls = 0
  patch(t, 'open', (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (String(args[0]).endsWith('payload.partial') && args[1] === 'wx') {
      const write = handle.write.bind(handle), sync = handle.sync.bind(handle)
      handle.write = (async (buffer: Uint8Array, offset: number, length: number, position: number | null) => {
        writeCalls++
        return write(buffer, offset, Math.min(length, 17), position)
      }) as typeof handle.write
      handle.sync = async () => { if (corruptOnSync) await write(Buffer.from('bad!'), 0, 4, 0); await sync() }
    }
    return handle
  }) as typeof fs.open)
  const file = await downloadUpdate(downloadAsset(), root, { fetch: servedBytes() })
  assert.ok(writeCalls > 1)
  assert.deepEqual(await fs.readFile(file), installer)
  corruptOnSync = true
  await assert.rejects(downloadUpdate(downloadAsset(), root, { fetch: servedBytes() }), /校验失败/)
  assert.deepEqual(await fs.readFile(file), installer)
})

test('zero progress writes fail without spinning, close their descriptor, and preserve unrelated files', async t => {
  const root = await temp(t), original = fs.open
  let writes = 0, closes = 0
  patch(t, 'open', (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (String(args[0]).endsWith('payload.partial') && args[1] === 'wx') {
      const close = handle.close.bind(handle)
      handle.write = (async () => { writes++; return { bytesWritten: 0, buffer: installer } }) as unknown as typeof handle.write
      handle.close = async () => { closes++; await close() }
    }
    return handle
  }) as typeof fs.open)
  await assert.rejects(downloadUpdate(downloadAsset(), root, { fetch: servedBytes() }), /完整写入/)
  assert.equal(writes, 1); assert.equal(closes, 1)
})

test('oversized, interrupted and cancelled bodies are cancelled and unlocked without a verified result', async t => {
  const root = await temp(t)
  for (const scenario of ['oversize', 'error', 'abort'] as const) {
    let cancelled = false
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        if (scenario === 'oversize') stream.enqueue(Buffer.alloc(installer.length + 1))
        else if (scenario === 'error') stream.error(new Error('injected stream fault'))
        else stream.enqueue(installer.subarray(0, 20))
      }, cancel() { cancelled = true },
    })
    await assert.rejects(downloadUpdate(downloadAsset(), root, { fetch: (async () => new Response(body)) as typeof fetch, signal: controller.signal,
      onProgress: () => { if (scenario === 'abort') controller.abort() } }))
    assert.equal(body.locked, false)
    if (scenario !== 'error') assert.equal(cancelled, true)
  }
})

test('headers and idle reads have finite timeouts even for a fetch substitute ignoring AbortSignal', async t => {
  const root = await temp(t)
  await assert.rejects(downloadUpdate(downloadAsset(), root, { fetch: (() => new Promise(() => {})) as typeof fetch, idleTimeoutMs: 20 }), { name: 'TimeoutError' })
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  await assert.rejects(downloadUpdate(downloadAsset(), root, { fetch: (async () => new Response(body)) as typeof fetch, idleTimeoutMs: 20 }), { name: 'TimeoutError' })
  assert.equal(cancelled, true); assert.equal(body.locked, false)
})

test('observers cannot turn a verified download into failure and async rejection is contained', async t => {
  const root = await temp(t)
  for (const observer of [() => { throw new Error('observer') }, async () => { throw new Error('async observer') }]) {
    const file = await downloadUpdate(downloadAsset(), root, { fetch: servedBytes(), onProgress: observer })
    assert.deepEqual(await fs.readFile(file), installer)
  }
})

test('unsafe descriptors and redirect credentials, ports or schemes fail before file publication', async t => {
  const root = await temp(t)
  let requests = 0
  for (const changed of [{ name: '../escape.exe' }, { name: 'CON.exe' }, { size: -1 }, { size: 1024 ** 3 + 1 }, { sha256: 'bad' },
    { url: 'https://github.com:444/XQGGCN/lua-launcher/releases/download/v0.10.4/Lua-Setup-0.10.4.exe' },
    { url: 'https://user:pass@github.com/XQGGCN/lua-launcher/releases/download/v0.10.4/Lua-Setup-0.10.4.exe' },
    { url: 'https://github.com/foreign/repo/releases/download/v0.10.4/Lua-Setup-0.10.4.exe' }]) {
    await assert.rejects(downloadUpdate({ ...downloadAsset(), ...changed }, root, { fetch: (async () => { requests++; return new Response(installer) }) as typeof fetch }))
  }
  assert.equal(requests, 0); assert.deepEqual(await fs.readdir(root), [])
  for (const location of ['http://release-assets.githubusercontent.com/x', 'https://release-assets.githubusercontent.com:444/x', 'https://u:p@release-assets.githubusercontent.com/x', 'https://example.com/x']) {
    await assert.rejects(downloadUpdate(downloadAsset(), root, { fetch: (async () => new Response(null, { status: 302, headers: { location } })) as typeof fetch }), /不受信任/)
  }
})

test('download parent links are rejected instead of writing through them', async t => {
  const root = await temp(t), outside = path.join(root, 'outside'), link = path.join(root, 'linked')
  await fs.mkdir(outside); await fs.symlink(outside, link, 'junction')
  await assert.rejects(downloadUpdate(downloadAsset(), path.join(link, 'updates'), { fetch: servedBytes() }), /安全条件/)
  await assert.rejects(downloadUpdate(downloadAsset(), `${link}${path.sep}..${path.sep}updates`, { fetch: servedBytes() }), /安全条件/)
  assert.deepEqual(await fs.readdir(outside), [])
})

test('AppImage replacement uses a unique stage, retains the previous file and never touches a fixed .update sibling', async t => {
  const root = await temp(t), current = path.join(root, 'Lua.AppImage'), downloaded = path.join(root, 'downloaded.AppImage'), fixed = path.join(root, '.Lua.AppImage.update')
  await fs.writeFile(current, 'old application'); await fs.writeFile(downloaded, installer); await fs.writeFile(fixed, 'unrelated staging bytes')
  await replaceAppImage(downloaded, current, { expected: checksum(installer) })
  assert.deepEqual(await fs.readFile(current), installer)
  assert.equal(await fs.readFile(fixed, 'utf8'), 'unrelated staging bytes')
  const stage = (await fs.readdir(root)).find(name => name.startsWith('.lua-update-'))!
  assert.equal(await fs.readFile(path.join(root, stage, 'previous.AppImage'), 'utf8'), 'old application')
})

test('AppImage copy and rename failures keep the original, allow retry, and refuse symlink targets', async t => {
  const root = await temp(t), current = path.join(root, 'Lua.AppImage'), downloaded = path.join(root, 'downloaded.AppImage')
  await fs.writeFile(current, 'old'); await fs.writeFile(downloaded, installer)
  const originalRename = fs.rename
  let failing = true
  patch(t, 'rename', (async (...args: Parameters<typeof fs.rename>) => { if (failing) throw Object.assign(new Error('rename failure'), { code: 'EACCES' }); await originalRename(...args) }) as typeof fs.rename)
  await assert.rejects(replaceAppImage(downloaded, current, { expected: checksum(installer) }), /未完成/)
  assert.equal(await fs.readFile(current, 'utf8'), 'old')
  assert.equal((await fs.lstat(current)).nlink, 1)
  failing = false
  await replaceAppImage(downloaded, current, { expected: checksum(installer) })
  assert.deepEqual(await fs.readFile(current), installer)
  const link = path.join(root, 'link.AppImage'); await fs.symlink(downloaded, link)
  await assert.rejects(replaceAppImage(downloaded, link, { expected: checksum(installer) }), /安全条件/)
  assert.deepEqual(await fs.readFile(downloaded), installer)
})

test('a stream producing only empty chunks fails after a finite number of reads', async t => {
  const root = await temp(t)
  let pulls = 0, cancelled = false
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array()) }, cancel() { cancelled = true } })
  await assert.rejects(downloadUpdate(downloadAsset(), root, { fetch: (async () => new Response(body)) as typeof fetch }), /没有数据/)
  assert.ok(pulls <= 11)
  assert.equal(body.locked, false); assert.equal(cancelled, true)
})

test('AppImage rejects modified downloaded bytes and copy write faults without changing the old executable', async t => {
  const root = await temp(t), current = path.join(root, 'Lua.AppImage'), downloaded = path.join(root, 'downloaded.AppImage'), original = fs.open
  await fs.writeFile(current, 'old'); await fs.writeFile(downloaded, Buffer.alloc(installer.length, 77))
  await assert.rejects(replaceAppImage(downloaded, current, { expected: checksum(installer) }), /校验失败/)
  assert.equal(await fs.readFile(current, 'utf8'), 'old')
  await fs.writeFile(downloaded, installer)
  patch(t, 'open', (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (String(args[0]).endsWith('next.AppImage') && args[1] === 'wx') handle.write = (async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) }) as typeof handle.write
    return handle
  }) as typeof fs.open)
  await assert.rejects(replaceAppImage(downloaded, current, { expected: checksum(installer) }), /未完成/)
  assert.equal(await fs.readFile(current, 'utf8'), 'old')
})

test('a changed current AppImage is not overwritten after the replacement copy completes', async t => {
  const root = await temp(t), current = path.join(root, 'Lua.AppImage'), downloaded = path.join(root, 'downloaded.AppImage'), original = fs.open
  await fs.writeFile(current, 'old'); await fs.writeFile(downloaded, installer)
  let changed = false
  patch(t, 'open', (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (!changed && String(args[0]).endsWith('next.AppImage') && args[1] === 'wx') {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { changed = true; await fs.writeFile(current, 'external new app'); await sync() }
    }
    return handle
  }) as typeof fs.open)
  await assert.rejects(replaceAppImage(downloaded, current, { expected: checksum(installer) }), /大小|变化/)
  assert.equal(await fs.readFile(current, 'utf8'), 'external new app')
})

test('AppImage commit acknowledgement loss resolves only with proof, otherwise reports recovery required', async t => {
  const root = await temp(t), downloaded = path.join(root, 'downloaded.AppImage'), original = fs.rename
  await fs.writeFile(downloaded, installer)
  const first = path.join(root, 'first.AppImage'); await fs.writeFile(first, 'old first')
  let makeAmbiguous = false
  patch(t, 'rename', (async (...args: Parameters<typeof fs.rename>) => {
    await original(...args)
    if (makeAmbiguous) await fs.unlink(args[1])
    throw Object.assign(new Error('lost acknowledgement'), { code: 'EIO' })
  }) as typeof fs.rename)
  await replaceAppImage(downloaded, first, { expected: checksum(installer) })
  assert.deepEqual(await fs.readFile(first), installer)
  const second = path.join(root, 'second.AppImage'); await fs.writeFile(second, 'old second'); makeAmbiguous = true
  await assert.rejects(replaceAppImage(downloaded, second, { expected: checksum(installer) }), (error: unknown) => error instanceof UpdateRecoveryError && error.code === 'RECOVERY_REQUIRED')
  const old = await Promise.all((await fs.readdir(root)).filter(name => name.startsWith('.lua-update-')).map(async name => fs.readFile(path.join(root, name, 'previous.AppImage'), 'utf8')))
  assert.ok(old.includes('old second'))
})

test('AppImage success wins a late cancellation after rename; cancellation before commit keeps the old file', async t => {
  const root = await temp(t), current = path.join(root, 'Lua.AppImage'), downloaded = path.join(root, 'downloaded.AppImage'), original = fs.rename
  await fs.writeFile(current, 'old'); await fs.writeFile(downloaded, installer)
  const controller = new AbortController()
  patch(t, 'rename', (async (...args: Parameters<typeof fs.rename>) => { await original(...args); controller.abort() }) as typeof fs.rename)
  await replaceAppImage(downloaded, current, { expected: checksum(installer), signal: controller.signal })
  assert.deepEqual(await fs.readFile(current), installer)
  const unchanged = path.join(root, 'unchanged.AppImage'); await fs.writeFile(unchanged, 'old unchanged')
  await assert.rejects(replaceAppImage(downloaded, unchanged, { expected: checksum(installer), signal: controller.signal }), { name: 'AbortError' })
  assert.equal(await fs.readFile(unchanged, 'utf8'), 'old unchanged')
})
