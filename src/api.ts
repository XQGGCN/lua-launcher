export interface Instance {
  id: string
  name: string
  version: string
  loader: 'vanilla' | 'fabric'
  loaderVersion?: string
  status: 'not-installed' | 'installing' | 'ready' | 'running' | 'error'
  createdAt: string
  lastPlayed?: string
  playtimeMs: number
  error?: string
}
export interface Settings { memoryMb: number; javaPath: string; concurrentDownloads: number }
export interface Snapshot { instances: Instance[]; settings: Settings; rootDir: string }
export interface Version { id: string; type: string; releaseTime: string }
export interface JavaRuntime { path: string; version: string; major: number; arch: string }
export interface Account { mode: 'microsoft' | 'offline'; username: string; uuid: string }
export interface Mod {
  project_id: string; slug: string; title: string; description: string
  icon_url: string | null; author: string; downloads: number
  categories: string[]; project_type: string
}
export interface SearchResult { hits: Mod[]; total_hits: number; offset: number; limit: number }
export interface ModVersion { id: string; name: string; game_versions: string[]; loaders: string[]; files: { size: number; primary: boolean; filename: string }[] }
export interface Progress { type: 'progress'; instanceId: string; phase: string; completed: number; total: number; bytesDownloaded: number }
export interface DeviceCode { type: 'deviceCode'; userCode: string; verificationUri: string; expiresAt: number }
export interface LogEvent { type: 'log'; instanceId: string; level: string; message: string }
export type LauncherEvent = Progress | DeviceCode | LogEvent
  | { type: 'state'; snapshot: Snapshot }
  | { type: 'account'; account: Account | null }

declare global {
  interface Window {
    launcher?: {
      call: (method: string, ...args: unknown[]) => Promise<unknown>
      onEvent: (callback: (event: LauncherEvent) => void) => () => void
    }
  }
}
export const isDesktop = Boolean(window.launcher)
const defaultSnapshot: Snapshot = {
  instances: [],
  settings: { memoryMb: 4096, javaPath: '', concurrentDownloads: 6 },
  rootDir: '浏览器预览 · 数据保存在此浏览器',
}
function readPreview(): Snapshot {
  try {
    const raw = JSON.parse(localStorage.getItem('lua-preview') || 'null') as Snapshot | null
    if (raw && Array.isArray(raw.instances) && raw.settings) return raw
  } catch { /* Storage can be unavailable in private browsing. */ }
  return structuredClone(defaultSnapshot)
}
let preview = readPreview()
function savePreview() {
  try { localStorage.setItem('lua-preview', JSON.stringify(preview)) } catch { /* Session-only preview remains usable. */ }
}
async function json(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`服务暂时不可用（HTTP ${response.status}），请稍后重试。`)
  return response.json()
}
// Keep the browser preview aligned with desktop/core.ts's supported releases.
function isSupportedVersion(version: string): boolean {
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(version)
  if (match) return Number(match[1]) > 20 || (Number(match[1]) === 20 && Number(match[2] ?? 0) >= 1)
  return /^2[6-9]\.\d+(?:\.\d+)?$/.test(version)
}
export async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  if (window.launcher) return window.launcher.call(method, ...args) as Promise<T>
  let result: unknown
  switch (method) {
    case 'snapshot': result = structuredClone(preview); break
    case 'account': result = null; break
    case 'versions': {
      const manifest = await json('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json') as { versions: Version[] }
      result = manifest.versions.filter(version => version.type === 'release' && isSupportedVersion(version.id))
      break
    }
    case 'createInstance': {
      const options = args[0] as Pick<Instance, 'name' | 'version' | 'loader'>
      if (!isSupportedVersion(options.version)) throw new Error('首版支持 Minecraft 1.20.1 及之后的正式版本。')
      const instance: Instance = { ...options, id: crypto.randomUUID(), createdAt: new Date().toISOString(), playtimeMs: 0, status: 'not-installed' }
      preview.instances.push(instance)
      savePreview()
      result = instance
      break
    }
    case 'updateSettings':
      preview.settings = { ...preview.settings, ...args[0] as Partial<Settings> }
      savePreview()
      result = structuredClone(preview)
      break
    case 'searchMods': {
      const options = (args[1] || {}) as { loader?: string; gameVersion?: string; offset?: number }
      const facets = [['project_type:mod']]
      if (options.loader) facets.push([`categories:${options.loader}`])
      if (options.gameVersion) facets.push([`versions:${options.gameVersion}`])
      const query = new URLSearchParams({ query: String(args[0] || ''), facets: JSON.stringify(facets), limit: '12', offset: String(options.offset || 0), index: 'relevance' })
      result = await json(`https://api.modrinth.com/v2/search?${query}`)
      break
    }
    case 'openExternal':
      window.open(String(args[0]), '_blank', 'noopener,noreferrer')
      break
    case 'logs': result = []; break
    default: throw new Error('此功能需要桌面版。当前为界面预览，无法安装游戏、访问本地 Java 或启动 Minecraft。')
  }
  return result as T
}
export function onEvent(callback: (event: LauncherEvent) => void) {
  return window.launcher?.onEvent(callback) ?? (() => {})
}
export function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
