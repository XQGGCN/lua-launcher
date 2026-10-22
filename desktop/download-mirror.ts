/**
 * Optional BMCLAPI mirror for players in mainland China.
 *
 * Every official Minecraft / Fabric / Forge / NeoForge URL has a mirror equivalent. The fetch
 * wrapper below tries the preferred source first and falls back to the other on network
 * errors, timeouts before headers arrive, HTTP 404/408/429 or 5xx. Downloaded files are still
 * verified against the hashes in Mojang's manifests, so a mirror cannot slip in other bytes for
 * game files; metadata fetched from the mirror is trusted as a copy of the official data.
 */
export type DownloadSource = 'auto' | 'mirror' | 'official'
export const MIRROR_HOST = 'bmclapi2.bangbang93.com'
const MIRROR = `https://${MIRROR_HOST}`

const prefixes: Array<[string, string]> = [
  ['https://piston-meta.mojang.com/', `${MIRROR}/`],
  ['https://piston-data.mojang.com/', `${MIRROR}/`],
  ['https://launchermeta.mojang.com/', `${MIRROR}/`],
  ['https://launcher.mojang.com/', `${MIRROR}/`],
  ['https://resources.download.minecraft.net/', `${MIRROR}/assets/`],
  ['https://libraries.minecraft.net/', `${MIRROR}/maven/`],
  ['https://meta.fabricmc.net/', `${MIRROR}/fabric-meta/`],
  ['https://maven.fabricmc.net/', `${MIRROR}/maven/`],
  ['https://maven.minecraftforge.net/', `${MIRROR}/maven/`],
  ['https://files.minecraftforge.net/maven/', `${MIRROR}/maven/`],
  ['https://maven.neoforged.net/releases/', `${MIRROR}/maven/`],
]

export function isDownloadSource(value: unknown): value is DownloadSource {
  return value === 'auto' || value === 'mirror' || value === 'official'
}

/** Mirror URL for an official download URL, or undefined when no mirror exists (e.g. Modrinth). */
export function mirrorUrl(url: string): string | undefined {
  for (const [official, mirror] of prefixes) if (url.startsWith(official)) return mirror + url.slice(official.length)
  return undefined
}

/** Hosts a mirror redirect may lead to: public HTTPS names only, never IP literals or local names. */
export function isPublicHttpsHost(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host === 'localhost' || host.endsWith('.internal')) return false
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[') || host.includes(':')) return false
  return true
}

const retryable = (status: number) => status === 404 || status === 408 || status === 429 || status >= 500

export interface MirrorFetchOptions {
  source: () => DownloadSource
  /** How long to wait for response headers from the first choice before trying the other. */
  headerTimeoutMs?: number
  /** In `auto` mode an official host that failed is skipped for this long. */
  stickyMs?: number
  now?: () => number
  onFallback?: (from: string, to: string) => void
}

export function createMirrorFetch(base: typeof fetch, options: MirrorFetchOptions): typeof fetch {
  const unhealthy = new Map<string, number>()
  const now = options.now ?? Date.now
  const headerTimeout = options.headerTimeoutMs ?? 12_000
  const sticky = options.stickyMs ?? 10 * 60_000

  async function attempt(url: string, init: RequestInit | undefined, followRedirects: boolean): Promise<Response> {
    const outer = init?.signal ?? undefined
    const controller = new AbortController()
    const forward = () => controller.abort(outer?.reason)
    if (outer?.aborted) forward(); else outer?.addEventListener('abort', forward, { once: true })
    const timer = setTimeout(() => controller.abort(new DOMException('等待下载服务器响应超时', 'TimeoutError')), headerTimeout)
    try {
      let current = url
      for (let redirects = 0; ; redirects++) {
        const response = await base(current, { ...init, signal: controller.signal, redirect: 'manual' })
        if (!followRedirects || ![301, 302, 303, 307, 308].includes(response.status)) return response
        await response.body?.cancel().catch(() => {})
        const location = response.headers.get('location')
        if (!location || redirects >= 5) throw new Error('镜像返回了无效的重定向')
        const next = new URL(location, current)
        if (!isPublicHttpsHost(next)) throw new Error('镜像重定向到了不允许的地址')
        current = next.href
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const mirror = mirrorUrl(url)
    const mode = options.source()
    if (!mirror || mode === 'official') return base(input, init)
    const host = new URL(url).hostname
    const officialHealthy = (unhealthy.get(host) ?? 0) <= now()
    const order: Array<'official' | 'mirror'> = mode === 'mirror' || !officialHealthy ? ['mirror', 'official'] : ['official', 'mirror']
    let lastError: unknown
    for (const [index, choice] of order.entries()) {
      const last = index === order.length - 1
      try {
        const response = choice === 'mirror' ? await attempt(mirror, init, true) : await attempt(url, init, false)
        if (!last && retryable(response.status)) {
          await response.body?.cancel().catch(() => {})
          lastError = new Error(`HTTP ${response.status}`)
        } else return response
      } catch (error) {
        if (init?.signal?.aborted) throw error
        lastError = error
      }
      if (choice === 'official' && mode === 'auto') unhealthy.set(host, now() + sticky)
      if (!last) options.onFallback?.(choice, order[index + 1])
    }
    throw lastError instanceof Error ? lastError : new Error('下载失败')
  }) as typeof fetch
}

/** Players in mainland China default to the mirror; everyone else tries official servers first. */
export function defaultDownloadSource(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): DownloadSource {
  return ['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Urumqi', 'Asia/Kashgar', 'PRC'].includes(timeZone) ? 'mirror' : 'auto'
}
