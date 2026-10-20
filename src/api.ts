import { categoryFacet } from './mod-categories'
import { resolveInstanceOptions, validateInstanceOptions, type InstanceOptions } from '../desktop/instance-options'
export type { InstanceOptions, ResolvedInstanceOptions } from '../desktop/instance-options'

export type ResourceSource = 'modrinth' | 'bbsmc'
export type Loader = 'vanilla' | 'fabric' | 'forge' | 'neoforge'
export const loaderNames: Record<Loader, string> = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }
export interface Instance {
  id: string
  name: string
  version: string
  loader: Loader
  loaderVersion?: string
  status: 'not-installed' | 'installing' | 'ready' | 'running' | 'error'
  createdAt: string
  lastPlayed?: string
  playtimeMs: number
  error?: string
  options?: InstanceOptions
  modpack?: {
    name: string
    versionId: string
    source: 'local' | ResourceSource
    projectId?: string
    modrinthVersionId?: string
    remoteVersionId?: string
    archiveSha1: string
    archiveSha512: string
    applied: boolean
  }
}
export interface Settings extends InstanceOptions { memoryMode: 'auto' | 'manual'; memoryMb: number; javaPath: string; concurrentDownloads: number }
export interface MemoryInfo {
  totalMb: number
  availableMb: number
  reservedMb: number
  safeMaxMb: number
  recommendedMb: number
  minimumMb: number
  canLaunch: boolean
  availableBasis: 'free-memory-conservative' | 'os-available'
  reason: string
}
export interface Snapshot { instances: Instance[]; settings: Settings; rootDir: string }
export interface Version { id: string; type: string; releaseTime: string }
export interface JavaRuntime { path: string; version: string; major: number; arch: string }
export type { JavaRequirement, JavaRuntimeTask } from '../desktop/core'
export interface Account { mode: 'microsoft'; username: string; uuid: string }
export interface AuthConfig { configured: boolean; clientId: string; source: 'built-in' | 'custom' | 'none' }
export interface AuthStatus { stage: string; message: string }
export interface AuthState { active: boolean; status: AuthStatus | null; deviceCode: DeviceCode | null }
export interface PackPreview {
  name: string
  versionId: string
  summary?: string
  minecraftVersion: string
  loader: Loader
  loaderVersion?: string
  fileCount: number
  totalBytes: number
  optionalFileCount?: number
  unsupportedReason?: string
}
export interface ChosenModpack { token: string; preview: PackPreview }
export interface LoaderVersion { version: string; stable: boolean; recommended?: boolean }
export type FabricVersion = LoaderVersion
export interface Mod {
  project_id: string; slug: string; title: string; description: string
  icon_url: string | null; author: string; downloads: number
  categories: string[]; project_type: string
}
export interface SearchResult { hits: Mod[]; total_hits: number; offset: number; limit: number }
export interface ModVersion {
  id: string; name: string; game_versions: string[]; loaders: string[]
  files: { size: number; primary: boolean; filename: string }[]
  source?: ResourceSource
  externalOnly?: boolean
  externalReason?: string
  projectUrl?: string
}
export interface Progress { type: 'progress'; instanceId: string; phase: string; completed: number; total: number; bytesDownloaded: number; unit?: 'bytes' }
export interface DeviceCode { type: 'deviceCode'; userCode: string; verificationUri: string; expiresAt: number }
export interface LogEvent { type: 'log'; instanceId: string; level: string; message: string }
export type LauncherEvent = Progress | DeviceCode | LogEvent
  | { type: 'state'; snapshot: Snapshot }
  | { type: 'account'; account: Account | null }
  | ({ type: 'authStatus' } & AuthStatus)
  | { type: 'authState'; state: AuthState }
  | { type: 'javaTask'; task: import('../desktop/core').JavaRuntimeTask }

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
  settings: { memoryMode: 'auto', memoryMb: 4096, javaPath: '', manualJavaPath: '', concurrentDownloads: 6 },
  rootDir: '浏览器预览 · 数据保存在此浏览器',
}
function readPreview(): Snapshot {
  try {
    const raw = JSON.parse(localStorage.getItem('lua-preview') || 'null') as Snapshot | null
    if (raw && Array.isArray(raw.instances) && raw.settings) {
      const javaPath = raw.settings.javaPath === 'java' ? '' : raw.settings.javaPath || ''
      const manual = raw.settings.manualJavaPath ?? javaPath
      return { ...raw, settings: { ...defaultSnapshot.settings, ...raw.settings, javaPath,
        manualJavaPath: manual === 'java' ? '' : manual,
        memoryMode: raw.settings.memoryMode === 'manual' ? 'manual' : 'auto' } }
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  return structuredClone(defaultSnapshot)
}
let preview = readPreview()
function savePreview() {
  try { localStorage.setItem('lua-preview', JSON.stringify(preview)) } catch { /* Session-only preview remains usable. */ }
}
function previewSettings(input: Settings): Settings {
  const { concurrentDownloads, ...options } = input
  const validated = validateInstanceOptions({ ...options,
    javaPath: options.javaPath === 'java' ? '' : options.javaPath,
    manualJavaPath: options.manualJavaPath === 'java' ? '' : options.manualJavaPath })
  if (!Number.isInteger(concurrentDownloads) || concurrentDownloads < 1 || concurrentDownloads > 16) {
    throw new Error('并发下载数需要在 1–16 之间')
  }
  const values = { ...defaultSnapshot.settings, ...validated, concurrentDownloads }
  if (values.javaPath) values.manualJavaPath = values.javaPath
  return values
}
async function json(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`服务暂时不可用（HTTP ${response.status}），请稍后重试。`)
  return response.json()
}
function resourceAPI(source: unknown) {
  if (source === undefined || source === 'modrinth') return 'https://api.modrinth.com/v2'
  if (source === 'bbsmc') return 'https://api.bbsmc.net/v2'
  throw new Error('不支持的资源来源')
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
    case 'authConfig': result = { configured: false, clientId: '', source: 'none' }; break
    case 'authState': result = { active: false, status: null, deviceCode: null }; break
    case 'versions': {
      const manifest = await json('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json') as { versions: Version[] }
      result = manifest.versions.filter(version => version.type === 'release' && isSupportedVersion(version.id))
      break
    }
    case 'fabricVersions': {
      const list = await json(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(String(args[0]))}`) as { loader: FabricVersion }[]
      result = list.map(item => item.loader)
      break
    }
    case 'loaderVersions': {
      if (args[1] !== 'fabric') throw new Error('Forge / NeoForge 的兼容版本需在桌面版读取。当前为浏览器界面预览。')
      const list = await json(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(String(args[0]))}`) as { loader: LoaderVersion }[]
      result = list.map(item => item.loader)
      break
    }
    case 'createInstance': {
      const options = args[0] as Pick<Instance, 'name' | 'version' | 'loader' | 'loaderVersion'>
      if (!isSupportedVersion(options.version)) throw new Error('首版支持 Minecraft 1.20.1 及之后的正式版本。')
      const instance: Instance = { ...options, id: crypto.randomUUID(), createdAt: new Date().toISOString(), playtimeMs: 0, status: 'not-installed' }
      preview.instances.push(instance)
      savePreview()
      result = instance
      break
    }
    case 'updateSettings':
      preview.settings = previewSettings({ ...preview.settings, ...args[0] as Partial<Settings> })
      savePreview()
      result = structuredClone(preview)
      break
    case 'instanceOptions': {
      const instance = preview.instances.find(item => item.id === args[0])
      if (!instance) throw new Error('实例不存在')
      const { concurrentDownloads: _downloads, ...global } = previewSettings(preview.settings)
      result = resolveInstanceOptions(global, instance.options)
      break
    }
    case 'updateInstanceSettings': {
      const instance = preview.instances.find(item => item.id === args[0])
      if (!instance) throw new Error('实例不存在')
      const input = args[1] as { name: string; options: unknown }
      if (typeof input?.name !== 'string' || !input.name.trim() || input.name.trim().length > 64 || /[\u0000-\u001f\u007f]/u.test(input.name)) throw new Error('实例名称需要 1–64 个字符，不能包含控制字符')
      const options = validateInstanceOptions(input.options)
      instance.name = input.name.trim(); instance.options = options
      savePreview(); result = structuredClone(preview)
      break
    }
    case 'searchMods':
    case 'searchModpacks': {
      const options = (args[1] || {}) as { loader?: string; gameVersion?: string; offset?: number; source?: ResourceSource; category?: string }
      const facets = [[`project_type:${method === 'searchModpacks' ? 'modpack' : 'mod'}`]]
      if (options.loader) facets.push([`categories:${options.loader}`])
      if (options.gameVersion) facets.push([`versions:${options.gameVersion}`])
      if (options.category) facets.push([`categories:${categoryFacet(options.category, options.source)}`])
      const query = new URLSearchParams({ query: String(args[0] || ''), facets: JSON.stringify(facets), limit: '12', offset: String(options.offset || 0), index: 'relevance' })
      result = await json(`${resourceAPI(options.source)}/search?${query}`)
      break
    }
    case 'modpackVersions':
      result = await json(`${resourceAPI(args[1])}/project/${encodeURIComponent(String(args[0]))}/version`)
      break
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
