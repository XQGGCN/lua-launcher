import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkForUpdate, compareVersions, downloadUpdate, replaceAppImage, RELEASES_API } from './updater'

const installer = Buffer.from('fake installer bytes '.repeat(100))
const sha = createHash('sha256').update(installer).digest('hex')
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
  await assert.rejects(downloadUpdate({ ...asset, name: 'b.exe' }, directory, { fetch: served(tampered) }), /校验失败/)
  await assert.rejects(fs.access(path.join(directory, 'b.exe.partial')))
  await assert.rejects(downloadUpdate({ ...asset, name: 'c.exe' }, directory, { fetch: served(installer, 'https://evil.example.com/x') }), /不受信任/)
})

test('AppImage replacement keeps the file executable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-appimage-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const current = path.join(directory, 'Lua.AppImage'), downloaded = path.join(directory, 'new.AppImage')
  await fs.writeFile(current, 'old'); await fs.writeFile(downloaded, 'new')
  await replaceAppImage(downloaded, current)
  assert.equal(await fs.readFile(current, 'utf8'), 'new')
  if (process.platform !== 'win32') assert.equal((await fs.stat(current)).mode & 0o111, 0o111)
})
