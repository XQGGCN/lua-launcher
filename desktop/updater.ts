import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Update checks against this project's GitHub Releases. Installers are downloaded only from
 * GitHub hosts and must match the SHA-256 digest GitHub publishes for the asset.
 */
export const RELEASES_API = 'https://api.github.com/repos/XQGGCN/lua-launcher/releases?per_page=10'
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'api.github.com'])

export interface UpdateAsset { name: string; size: number; url: string; sha256: string }
export interface UpdateInfo {
  version: string
  current: string
  notes: string
  publishedAt: string
  page: string
  asset?: UpdateAsset
  /** What `installUpdate` will do on this platform. */
  action: 'installer' | 'appimage' | 'open-dmg' | 'page'
}

export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core, pre = ''] = value.replace(/^v/, '').split('-', 2)
    return { parts: core.split('.').map(part => Number(part) || 0), pre }
  }
  const left = parse(a), right = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff) return Math.sign(diff)
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre < right.pre ? -1 : 1
}

function pickAsset(assets: Array<{ name: string; size: number; browser_download_url: string; digest?: string | null }>, platform: NodeJS.Platform, arch: string): UpdateAsset | undefined {
  const pattern = platform === 'win32' ? /\.exe$/i : platform === 'darwin' ? (arch === 'arm64' ? /arm64\.dmg$/i : /(?<!arm64)\.dmg$/i) : /\.AppImage$/
  const asset = assets.find(item => pattern.test(item.name))
  const digest = asset?.digest && /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1]
  if (!asset || !digest || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3) return undefined
  const url = new URL(asset.browser_download_url)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/XQGGCN/lua-launcher/releases/download/')) return undefined
  return { name: asset.name.replace(/[^\w.\-]/g, '_'), size: asset.size, url: url.href, sha256: digest }
}

export async function checkForUpdate(current: string, options: { fetch?: typeof fetch; platform?: NodeJS.Platform; arch?: string; appImage?: string; signal?: AbortSignal } = {}): Promise<UpdateInfo | null> {
  const fetcher = options.fetch ?? fetch
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch
  const response = await fetcher(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `LuaLauncher/${current}` },
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`)
  const releases = await response.json() as Array<{ tag_name: string; draft: boolean; body?: string; published_at?: string; html_url: string; assets: Parameters<typeof pickAsset>[0] }>
  if (!Array.isArray(releases)) throw new Error('更新信息格式无效')
  const candidates = releases.filter(release => !release.draft && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.tag_name))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
  const latest = candidates[0]
  if (!latest || compareVersions(latest.tag_name, current) <= 0) return null
  const asset = pickAsset(latest.assets ?? [], platform, arch)
  const action: UpdateInfo['action'] = !asset ? 'page' : platform === 'win32' ? 'installer' : platform === 'darwin' ? 'open-dmg' : options.appImage ? 'appimage' : 'page'
  return {
    version: latest.tag_name.slice(1), current, notes: String(latest.body ?? '').slice(0, 4000), publishedAt: String(latest.published_at ?? ''),
    page: new URL(latest.html_url).hostname === 'github.com' ? latest.html_url : 'https://github.com/XQGGCN/lua-launcher/releases',
    ...(asset ? { asset } : {}), action,
  }
}

/** Streams the asset to `directory`, verifying size and SHA-256 before it is renamed into place. */
export async function downloadUpdate(asset: UpdateAsset, directory: string, options: { fetch?: typeof fetch; signal?: AbortSignal; onProgress?: (received: number, total: number) => void } = {}): Promise<string> {
  const fetcher = options.fetch ?? fetch
  await fs.mkdir(directory, { recursive: true })
  const target = path.join(directory, asset.name), partial = `${target}.partial`
  let current = asset.url, response: Response | undefined
  for (let redirects = 0; redirects <= 5; redirects++) {
    const url = new URL(current)
    if (url.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(url.hostname)) throw new Error('更新下载地址不受信任')
    response = await fetcher(current, { redirect: 'manual', signal: options.signal, headers: { 'User-Agent': 'LuaLauncher-Updater' } })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    await response.body?.cancel().catch(() => {})
    const location = response.headers.get('location')
    if (!location) throw new Error('更新下载重定向无效')
    current = new URL(location, current).href
    response = undefined
  }
  if (!response?.ok || !response.body) throw new Error(`更新下载失败${response ? `（HTTP ${response.status}）` : ''}`)
  const hash = createHash('sha256')
  const handle = await fs.open(partial, 'w')
  let received = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (received > asset.size) throw new Error('更新文件大小与发布信息不符')
      hash.update(value)
      await handle.write(value)
      options.onProgress?.(received, asset.size)
    }
  } catch (error) {
    await handle.close(); await fs.rm(partial, { force: true }); throw error
  }
  await handle.close()
  if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
    await fs.rm(partial, { force: true })
    throw new Error('更新文件校验失败，已删除，请稍后重试')
  }
  await fs.rm(target, { force: true })
  await fs.rename(partial, target)
  return target
}

/** Replaces the running AppImage atomically (same directory), keeping it executable. */
export async function replaceAppImage(downloaded: string, appImage: string): Promise<void> {
  const staged = path.join(path.dirname(appImage), `.${path.basename(appImage)}.update`)
  await fs.copyFile(downloaded, staged)
  await fs.chmod(staged, 0o755)
  await fs.rename(staged, appImage)
}
