import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'
import { MODPACK_LIMITS, PACK_REDIRECT_HOSTS, readModpack, validatePackPath, validatePackUrl, type PackPreview, type ParsedModpack } from './modpack'
import { installForge, loaderMetadataUrl, parseLoaderVersions, type LoaderVersion } from './loader'
import { effectiveMemory, type MemorySystem } from './memory'
import { javaProcessEnvironment } from './java-environment'
import { JavaRuntimeManager, type ManagedJavaRuntime, type JavaRuntimeProgress, type JavaRuntimeProbe } from './java-runtime'
import metadata from '../package.json'
import { validateInstanceOptions, resolveInstanceOptions, type InstanceOptions, type ResolvedInstanceOptions } from './instance-options'
import { applyGameWindowSettings } from './game-window'
export type { PackPreview } from './modpack'

const execFileAsync = promisify(execFile)
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const FABRIC_URL = 'https://meta.fabricmc.net/v2'
const MODRINTH_URL = 'https://api.modrinth.com/v2'
const USER_AGENT = `LuaLauncher/${metadata.version} (+https://github.com/XQGGCN/lua-launcher)`
const NETWORK_HOSTS = new Set([
  'piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com',
  'launcher.mojang.com', 'libraries.minecraft.net', 'resources.download.minecraft.net',
  'meta.fabricmc.net', 'maven.fabricmc.net', 'api.modrinth.com', 'cdn.modrinth.com',
  'api.bbsmc.net', 'cdn.bbsmc.net',
  'maven.minecraftforge.net', 'maven.neoforged.net', 'files.minecraftforge.net',
])

export type ResourceSource = 'modrinth' | 'bbsmc'
const RESOURCE_PROVIDERS = {
  modrinth: { name: 'Modrinth', api: MODRINTH_URL, website: 'https://modrinth.com', downloads: new Set(['cdn.modrinth.com']) },
  bbsmc: { name: 'BBSMC', api: 'https://api.bbsmc.net/v2', website: 'https://bbsmc.net', downloads: new Set(['cdn.bbsmc.net']) },
} as const
function resourceProvider(source: ResourceSource = 'modrinth') {
  if (source !== 'modrinth' && source !== 'bbsmc') throw new Error('无效的资源来源')
  return RESOURCE_PROVIDERS[source]
}
const BBSMC_MOD_CATEGORIES: Record<string, string> = {
  adventure: '冒险', cursed: '诅咒', decoration: '装饰', economy: '经济', equipment: '装备',
  food: '食物', 'game-mechanics': '游戏机制', library: '前置', magic: '魔法', management: '管理',
  minigame: '小游戏', mobs: '生物', optimization: '优化', social: '社交', storage: '存储',
  technology: '科技', transportation: '交通', utility: '实用工具', worldgen: '世界生成',
}
/** Permission and browser-verification responses should not trigger automatic download retries. */
class RemoteAccessError extends Error {}

export type Loader = 'vanilla' | 'fabric' | 'forge' | 'neoforge'
export type InstanceStatus = 'not-installed' | 'installing' | 'ready' | 'running' | 'error'
export interface Instance {
  id: string
  name: string
  version: string
  loader: Loader
  loaderVersion?: string
  status: InstanceStatus
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
export interface LauncherSettings {
  memoryMode?: 'auto' | 'manual'
  memoryMb: number
  javaPath: string
  /** Retain the explicit preference while automatic selection is enabled. */
  manualJavaPath?: string
  jvmArgs?: string[]
  windowWidth?: number
  windowHeight?: number
  fullscreen?: boolean
  concurrentDownloads: number
}
export interface LauncherSnapshot {
  instances: Instance[]
  settings: LauncherSettings
  rootDir: string
}
export type CoreEvent =
  | { type: 'state'; snapshot: LauncherSnapshot }
  | { type: 'progress'; instanceId: string; phase: string; completed: number; total: number; bytesDownloaded: number; unit?: 'bytes' }
  | { type: 'log'; instanceId: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'javaTask'; task: JavaRuntimeTask }
export interface LaunchAccount {
  mode: 'microsoft'
  username: string
  uuid: string
  accessToken: string
  xuid?: string
  clientId?: string
}
export interface JavaRuntime { path: string; version: string; major: number; arch: string }
export interface JavaRequirement { instanceName: string; major: number; component?: string }
export interface JavaRuntimeTask {
  id: string; major: number; component: string
  status: 'queued' | 'active' | 'cancelling' | 'complete' | 'cancelled' | 'error'
  phase: string; source: string; completedBytes: number; totalBytes: number
  error?: string; path?: string
}
const JAVA_COMPONENTS: Record<number, string> = { 17: 'java-runtime-gamma', 21: 'java-runtime-delta', 25: 'java-runtime-epsilon' }
const JAVA_PHASES: Record<JavaRuntimeProgress['phase'], string> = {
  metadata: '正在读取官方运行时清单', download: '正在下载 Java', verify: '正在校验 Java 文件',
  probe: '正在检测 Java 版本与架构', commit: '正在完成 Java 安装',
}
export interface VersionSummary { id: string; type: string; releaseTime: string }
export interface FabricVersion { version: string; stable: boolean }
export interface ModrinthProject {
  source?: ResourceSource
  project_id: string
  slug: string
  title: string
  description: string
  author: string
  icon_url: string | null
  downloads: number
  follows: number
  categories: string[]
  versions: string[]
  project_type: string
}
export interface ModrinthSearchResponse {
  hits: ModrinthProject[]
  offset: number
  limit: number
  total_hits: number
}
export interface ModrinthVersion {
  source?: ResourceSource
  projectUrl?: string
  externalOnly?: boolean
  externalReason?: string
  /** BBSMC may expose a web/drive link in files instead of a downloadable artifact. */
  disk_only?: boolean
  id: string
  project_id: string
  name: string
  game_versions: string[]
  loaders: string[]
  files: Array<{ url: string; filename: string; primary: boolean; size: number; hashes: { sha1?: string; sha512?: string } }>
  dependencies: Array<{ project_id?: string; version_id?: string; dependency_type: string }>
}
interface Download { url: string; sha1?: string; sha512?: string; size?: number; path?: string }
export interface Rule {
  action: 'allow' | 'disallow'
  os?: { name?: string; arch?: string; version?: string }
  features?: Record<string, boolean>
}
export type GameArgument = string | { rules: Rule[]; value: string | string[] }
interface Library {
  name: string
  url?: string
  sha1?: string
  downloads?: { artifact?: Download; classifiers?: Record<string, Download> }
  natives?: Record<string, string>
  extract?: { exclude?: string[] }
  rules?: Rule[]
}
interface VersionManifest {
  id: string
  type: string
  mainClass: string
  assetIndex: Download & { id: string }
  downloads: { client: Download; client_mappings?: Download }
  libraries: Library[]
  arguments: { game: GameArgument[]; jvm: GameArgument[] }
  javaVersion?: { majorVersion: number; component?: string }
  logging?: { client?: { argument: string; file: Download & { id: string } } }
}
interface InstalledManifest {
  schema: 1
  version: VersionManifest
  platform: string
  arch: string
  classpath: string[]
  mainClass: string
  fabricArguments: { game: GameArgument[]; jvm: GameArgument[] }
  loggingFile?: string
  loaderLibraryDirectory?: string
}
interface ManifestIndex { versions: Array<VersionSummary & Download> }
interface CoreOptions {
  /** Dependency injection for deterministic network, process, and filesystem failure tests. */
  fetch?: typeof globalThis.fetch
  spawn?: typeof spawn
  renameFile?: typeof fs.rename
  stateRename?: typeof fs.rename
  platform?: NodeJS.Platform
  arch?: string
  memorySystem?: MemorySystem
  javaRuntimeManager?: Pick<JavaRuntimeManager, 'ensure' | 'discover'>
  javaRuntimeProbe?: JavaRuntimeProbe
}
interface DownloadJob { file: string; download: Download; allowedHosts?: ReadonlySet<string> }

/** All remote paths are treated as untrusted, including paths in official manifests. */
export function safeJoin(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.includes('\0') ||
      relative.includes(':') || path.posix.isAbsolute(relative) ||
      relative.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`不安全的文件路径：${relative}`)
  }
  const target = path.resolve(root, relative)
  const base = path.resolve(root) + path.sep
  if (!target.startsWith(base)) throw new Error('文件路径超出实例目录')
  return target
}

function platformName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux'
}
function normalizeArch(arch: string): string {
  return ({ aarch64: 'arm64', amd64: 'x64', x86_64: 'x64', x86: 'ia32' } as Record<string, string>)[arch] ?? arch
}
export function rulesAllow(
  rules: Rule[] | undefined, platform: NodeJS.Platform = process.platform,
  arch: string = process.arch, features: Record<string, boolean> = {},
): boolean {
  if (!rules?.length) return true
  let allowed = false
  for (const rule of rules) {
    if (rule.os?.name && rule.os.name !== platformName(platform)) continue
    if (rule.os?.arch && normalizeArch(rule.os.arch) !== normalizeArch(arch)) continue
    if (rule.os?.version && !new RegExp(rule.os.version).test(os.release())) continue
    if (rule.features && Object.entries(rule.features).some(([key, value]) => Boolean(features[key]) !== value)) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}
export function resolveArguments(
  args: GameArgument[], variables: Record<string, string>, platform: NodeJS.Platform = process.platform,
  arch: string = process.arch, features: Record<string, boolean> = {},
): string[] {
  const result: string[] = []
  for (const item of args) {
    if (typeof item !== 'string' && !rulesAllow(item.rules, platform, arch, features)) continue
    for (const value of typeof item === 'string' ? [item] : Array.isArray(item.value) ? item.value : [item.value]) {
      result.push(value.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
        if (!(key in variables)) throw new Error(`启动参数包含未支持的变量：${key}`)
        return variables[key]
      }))
    }
  }
  return result
}
export function isSupportedVersion(version: string): boolean {
  // Only stable releases with modern launcher manifests are advertised.
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(version)
  if (match) return Number(match[1]) > 20 || (Number(match[1]) === 20 && Number(match[2] ?? 0) >= 1)
  return /^2[6-9]\.\d+(?:\.\d+)?$/.test(version)
}
export function mavenPath(coordinate: string): string {
  const [body, extension = 'jar'] = coordinate.split('@')
  const parts = body.split(':')
  if (parts.length < 3 || parts.length > 4 || parts.some(part => !/^[a-zA-Z0-9_.+\-]+$/.test(part)) ||
      !/^[a-zA-Z0-9]+$/.test(extension)) throw new Error('无效的 Maven 坐标')
  const [group, artifact, version, classifier] = parts
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function validHash(hash: string | undefined): hash is string { return Boolean(hash && /^[a-f0-9]{40}$/i.test(hash)) }
function sanitizeId(value: string): string {
  if (!/^[a-zA-Z0-9_.+\-]+$/.test(value) || value.includes('..')) throw new Error('无效的资源标识')
  return value
}
function assertNetworkUrl(input: string, allowedHosts: ReadonlySet<string> = NETWORK_HOSTS): URL {
  const url = new URL(input)
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.has(url.hostname) ||
      (url.port && url.port !== '443')) throw new Error(`不允许的下载来源：${url.hostname}`)
  return url
}
async function sha1File(file: string): Promise<string> {
  return hashFile(file, 'sha1')
}
async function hashFile(file: string, algorithm: 'sha1' | 'sha512'): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export class LauncherCore {
  private instances: Instance[] = []
  private settings: LauncherSettings = { memoryMode: 'auto', memoryMb: 4096, javaPath: '', manualJavaPath: '', concurrentDownloads: 8 }
  private readonly fetcher: typeof globalThis.fetch
  private readonly spawnProcess: typeof spawn
  private readonly renameFile: typeof fs.rename
  private readonly stateRename: typeof fs.rename
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly memorySystem: MemorySystem
  private readonly javaRuntimeManager: Pick<JavaRuntimeManager, 'ensure' | 'discover'>
  private javaTasks = new Map<string, JavaRuntimeTask>()
  private javaDownloads = new Map<string, AbortController>()
  private launchControllers = new Map<string, AbortController>()
  private instanceSettingsSaving = new Set<string>()
  private installs = new Map<string, AbortController>()
  private processes = new Map<string, ChildProcess>()
  private launching = new Set<string>()
  private stopping = new Set<string>()
  private writes: Promise<void> = Promise.resolve()
  private manifestCache?: { at: number; value: ManifestIndex }
  readonly rootDir: string

  constructor(rootDir: string, private readonly emit: (event: CoreEvent) => void = () => {}, options: CoreOptions = {}) {
    this.rootDir = path.resolve(rootDir)
    this.fetcher = options.fetch ?? globalThis.fetch
    this.spawnProcess = options.spawn ?? spawn
    this.renameFile = options.renameFile ?? fs.rename
    this.stateRename = options.stateRename ?? fs.rename
    this.platform = options.platform ?? process.platform
    this.arch = normalizeArch(options.arch ?? process.arch)
    this.memorySystem = options.memorySystem ?? {}
    this.javaRuntimeManager = options.javaRuntimeManager ?? new JavaRuntimeManager(this.rootDir, { fetch: this.fetcher, probe: options.javaRuntimeProbe })
  }

  async init(): Promise<LauncherSnapshot> {
    await fs.mkdir(this.rootDir, { recursive: true })
    try {
      const state = JSON.parse(await fs.readFile(path.join(this.rootDir, 'launcher.json'), 'utf8'))
      if (state.schema !== 1 || !Array.isArray(state.instances)) throw new Error('不支持的启动器数据格式')
      this.instances = state.instances.map((item: Instance) => {
        if (!/^[a-f0-9-]{36}$/.test(item.id) || !isSupportedVersion(item.version) ||
            !['vanilla', 'fabric', 'forge', 'neoforge'].includes(item.loader) || typeof item.name !== 'string') {
          throw new Error('实例数据损坏，请检查 launcher.json')
        }
        return { ...item, ...(item.options === undefined ? {} : { options: validateInstanceOptions(item.options) }),
          status: item.status === 'running' ? 'ready' : item.status === 'installing' ? 'not-installed' : item.status }
      })
      this.settings = this.validateSettings({ ...this.settings, ...state.settings })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.save()
    return this.snapshot()
  }

  snapshot(): LauncherSnapshot {
    return structuredClone({ instances: this.instances, settings: this.settings, rootDir: this.rootDir })
  }

  private async save(prepare?: () => { instances?: Instance[]; settings?: LauncherSettings; commit: () => void }): Promise<void> {
    const run = this.writes.catch(() => {}).then(async () => {
      const file = path.join(this.rootDir, 'launcher.json')
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        // Settings remain committed values for readers and launch preparation
        // until their candidate file has been atomically published.
        const candidate = prepare?.()
        const content = JSON.stringify({ schema: 1, instances: candidate?.instances ?? this.instances,
          settings: candidate?.settings ?? this.settings }, null, 2)
        await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
        await this.stateRename(temporary, file)
        candidate?.commit()
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {})
        throw error
      }
    })
    this.writes = run
    await run
    this.emit({ type: 'state', snapshot: this.snapshot() })
  }

  private instance(id: string): Instance {
    const instance = this.instances.find(item => item.id === id)
    if (!instance) throw new Error('实例不存在')
    return instance
  }
  instanceDirectory(id: string): string {
    this.instance(id)
    return safeJoin(this.rootDir, `instances/${id}`)
  }
  getInstancePath(id: string): string {
    return safeJoin(this.instanceDirectory(id), 'game')
  }

  instanceOptions(id: string): ResolvedInstanceOptions {
    const { concurrentDownloads: _downloads, ...global } = this.settings
    // Schema 1 historically allowed the bare command "java" as automatic mode.
    return resolveInstanceOptions({ ...global, javaPath: global.javaPath === 'java' ? '' : global.javaPath,
      manualJavaPath: global.manualJavaPath === 'java' ? '' : global.manualJavaPath }, this.instance(id).options)
  }

  async updateInstanceSettings(id: string, input: { name: string; options: unknown }): Promise<LauncherSnapshot> {
    const instance = this.instance(id)
    if (this.instanceSettingsSaving.has(id)) throw new Error('此实例的设置正在保存')
    if (this.installs.has(id) || this.launching.has(id) || this.processes.has(id)) {
      throw new Error('请先完成安装或关闭此实例的游戏，再修改实例设置')
    }
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 64 || /[\u0000-\u001f\u007f]/u.test(input.name)) {
      throw new Error('实例名称需要 1–64 个字符，不能包含控制字符')
    }
    const options = validateInstanceOptions(input.options)
    const name = input.name.trim()
    this.instanceSettingsSaving.add(id)
    try {
      await this.save(() => {
        if (this.installs.has(id) || this.launching.has(id) || this.processes.has(id)) throw new Error('此实例正在安装或运行，设置未保存')
        return {
          instances: this.instances.map(item => item.id === id ? { ...item, name, options } : item),
          commit: () => { instance.name = name; instance.options = options },
        }
      })
      return this.snapshot()
    } finally { this.instanceSettingsSaving.delete(id) }
  }

  async createInstance(input: { name: string; version: string; loader: Loader; loaderVersion?: string }): Promise<Instance> {
    const name = String(input.name ?? '').trim()
    if (!name || name.length > 64) throw new Error('实例名称需要 1–64 个字符')
    if (!isSupportedVersion(input.version)) throw new Error('首版支持 Minecraft 1.20.1 及之后的正式版本')
    if (!['vanilla', 'fabric', 'forge', 'neoforge'].includes(input.loader)) throw new Error('无效的模组加载器')
    if (input.loaderVersion && input.loader === 'vanilla') throw new Error('原版实例不能指定加载器版本')
    if (input.loader !== 'vanilla') {
      const available = await this.loaderVersions(input.version, input.loader)
      if (!available.length || (input.loaderVersion && !available.some(loader => loader.version === input.loaderVersion))) {
        throw new Error('此 Minecraft 版本不支持所选加载器版本')
      }
    }
    const versions = await this.versions()
    if (!versions.some(item => item.id === input.version)) throw new Error('该 Minecraft 正式版本不存在')
    const instance: Instance = {
      id: randomUUID(), name, version: input.version, loader: input.loader, loaderVersion: input.loaderVersion,
      status: 'not-installed', createdAt: new Date().toISOString(), playtimeMs: 0,
    }
    await fs.mkdir(safeJoin(this.rootDir, `instances/${instance.id}/game`), { recursive: true })
    this.instances.push(instance)
    await this.save()
    return structuredClone(instance)
  }

  private validateSettings(input: LauncherSettings): LauncherSettings {
    if (input.memoryMode !== undefined && input.memoryMode !== 'auto' && input.memoryMode !== 'manual') throw new Error('无效的内存分配方式')
    if (!Number.isInteger(input.memoryMb) || input.memoryMb < 1024 || input.memoryMb > 65536) {
      throw new Error('内存需要在 1024–65536 MB 之间')
    }
    if (typeof input.javaPath !== 'string' || input.javaPath.includes('\0') ||
        (input.javaPath !== '' && input.javaPath !== 'java' && !path.isAbsolute(input.javaPath))) {
      throw new Error('请选择 Java 可执行文件的绝对路径')
    }
    if (!Number.isInteger(input.concurrentDownloads) || input.concurrentDownloads < 1 || input.concurrentDownloads > 16) {
      throw new Error('并发下载数需要在 1–16 之间')
    }
    const manualJavaPath = input.manualJavaPath ?? input.javaPath
    if (typeof manualJavaPath !== 'string' || manualJavaPath.includes('\0') ||
        (manualJavaPath !== '' && manualJavaPath !== 'java' && !path.isAbsolute(manualJavaPath))) {
      throw new Error('请选择 Java 可执行文件的绝对路径')
    }
    const advanced = validateInstanceOptions({ jvmArgs: input.jvmArgs, windowWidth: input.windowWidth,
      windowHeight: input.windowHeight, fullscreen: input.fullscreen })
    return { memoryMode: input.memoryMode ?? 'auto', memoryMb: input.memoryMb, javaPath: input.javaPath === 'java' ? '' : input.javaPath,
      manualJavaPath: input.javaPath && input.javaPath !== 'java' ? input.javaPath : manualJavaPath === 'java' ? '' : manualJavaPath,
      concurrentDownloads: input.concurrentDownloads, ...advanced }
  }

  async updateSettings(settings: Partial<LauncherSettings>): Promise<LauncherSnapshot> {
    await this.save(() => {
      const next = this.validateSettings({ ...this.settings, ...settings })
      return { settings: next, commit: () => { this.settings = next } }
    })
    return this.snapshot()
  }

  private async request(url: string, signal?: AbortSignal, allowedHosts: ReadonlySet<string> = NETWORK_HOSTS): Promise<Response> {
    assertNetworkUrl(url, allowedHosts)
    let current = url
    // Follow redirects manually so a remote response cannot redirect into a local/private service.
    for (let redirects = 0; redirects <= 4; redirects++) {
      const response = await this.fetcher(current, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
        headers: { 'User-Agent': USER_AGENT }, redirect: 'manual',
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location) throw new Error('下载服务器返回了无效重定向')
        current = new URL(location, current).href
        assertNetworkUrl(current, allowedHosts)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        if ([401, 403].includes(response.status) && ['api.bbsmc.net', 'cdn.bbsmc.net'].includes(new URL(current).hostname)) {
          throw new RemoteAccessError(`BBSMC 此资源需要登录、购买或访问权限，请前往官网处理：https://bbsmc.net（HTTP ${response.status}）`)
        }
        if (response.status === 429) {
          throw new RemoteAccessError('资源站请求次数过多，请稍后再试（HTTP 429）')
        }
        throw new Error(`下载失败：HTTP ${response.status}（${new URL(current).hostname}）`)
      }
      if (['api.bbsmc.net', 'cdn.bbsmc.net'].includes(new URL(current).hostname) &&
          response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
        await response.body?.cancel()
        throw new RemoteAccessError('BBSMC 返回了网页验证页面，请在官网完成验证或获取资源：https://bbsmc.net')
      }
      return response
    }
    throw new Error('下载重定向次数过多')
  }
  private async json<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await this.request(url, signal)
    const bytes = await this.readResponse(response, 32 * 1024 * 1024)
    return JSON.parse(bytes.toString('utf8')) as T
  }
  private async readResponse(response: Response, limit: number): Promise<Buffer> {
    if (!response.body) throw new Error('下载服务器返回了空响应')
    const chunks: Uint8Array[] = []
    let length = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > limit) throw new Error('下载文件超过允许的大小')
        chunks.push(value)
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
    finally { reader.releaseLock() }
    return Buffer.concat(chunks)
  }
  private async manifest(signal?: AbortSignal): Promise<ManifestIndex> {
    signal?.throwIfAborted()
    if (this.manifestCache && Date.now() - this.manifestCache.at < 5 * 60_000) return this.manifestCache.value
    const value = await this.json<ManifestIndex>(MANIFEST_URL, signal)
    if (!Array.isArray(value.versions)) throw new Error('Minecraft 版本清单格式无效')
    this.manifestCache = { at: Date.now(), value }
    return value
  }
  async versions(signal?: AbortSignal): Promise<VersionSummary[]> {
    return (await this.manifest(signal)).versions.filter(v => v.type === 'release' && isSupportedVersion(v.id))
      .map(({ id, type, releaseTime }) => ({ id, type, releaseTime }))
  }

  async fabricVersions(version: string, signal?: AbortSignal): Promise<FabricVersion[]> {
    signal?.throwIfAborted()
    if (!isSupportedVersion(version)) throw new Error('当前仅支持 Minecraft 1.20.1 及之后的正式版本')
    const loaders = await this.json<Array<{ loader: FabricVersion }>>(`${FABRIC_URL}/versions/loader/${encodeURIComponent(version)}`, signal)
    return loaders.map(item => ({ version: sanitizeId(item.loader.version), stable: Boolean(item.loader.stable) }))
  }

  private async text(url: string, signal?: AbortSignal): Promise<string> {
    return (await this.readResponse(await this.request(url, signal), 4 * 1024 * 1024)).toString('utf8')
  }

  async loaderVersions(version: string, loader: Exclude<Loader, 'vanilla'>, signal?: AbortSignal): Promise<LoaderVersion[]> {
    if (!isSupportedVersion(version)) throw new Error('当前仅支持 Minecraft 1.20.1 及之后的正式版本')
    if (loader === 'fabric') return this.fabricVersions(version, signal)
    if (loader !== 'forge' && loader !== 'neoforge') throw new Error('无效的模组加载器')
    const xml = await this.text(loaderMetadataUrl(loader, version), signal)
    return parseLoaderVersions(xml, loader, version)
  }

  private async download(job: DownloadJob, signal: AbortSignal, onBytes: (bytes: number) => void = () => {}): Promise<void> {
    const { file, download } = job
    if (!validHash(download.sha1)) throw new Error(`缺少有效的 SHA-1 校验：${path.basename(file)}`)
    if (download.sha512 !== undefined && !/^[a-f0-9]{128}$/i.test(download.sha512)) {
      throw new Error(`缺少有效的 SHA-512 校验：${path.basename(file)}`)
    }
    const expectedHash = download.sha1.toLowerCase()
    try {
      const stat = await fs.stat(file)
      if (stat.isFile() && (download.size === undefined || stat.size === download.size) && await sha1File(file) === expectedHash &&
          (!download.sha512 || await hashFile(file, 'sha512') === download.sha512.toLowerCase())) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted()
      const temporary = `${file}.${randomUUID()}.part`
      try {
        const response = await this.request(download.url, signal, job.allowedHosts)
        if (!response.body) throw new Error('服务器返回了空下载')
        const reader = response.body.getReader()
        const handle = await fs.open(temporary, 'wx', 0o600)
        let length = 0
        const hash = createHash('sha1')
        const strongHash = download.sha512 ? createHash('sha512') : undefined
        try {
          for (;;) {
            signal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            length += value.length
            if (length > (download.size ?? 512 * 1024 * 1024)) throw new Error('下载文件大小不符')
            hash.update(value)
            strongHash?.update(value)
            // FileHandle.write can perform short writes; writeFile on the handle handles these.
            await handle.writeFile(value)
            onBytes(value.length)
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
          await handle.close()
        }
        if (download.size !== undefined && length !== download.size) throw new Error('下载文件不完整')
        if (hash.digest('hex') !== expectedHash) throw new Error(`SHA-1 校验失败：${path.basename(file)}`)
        if (strongHash && strongHash.digest('hex') !== download.sha512!.toLowerCase()) {
          throw new Error(`SHA-512 校验失败：${path.basename(file)}`)
        }
        signal.throwIfAborted()
        await fs.rename(temporary, file)
        return
      } catch (error) {
        await fs.rm(temporary, { force: true })
        if (signal.aborted || error instanceof RemoteAccessError || attempt === 2) throw error
      }
    }
  }

  private async libraryDownload(library: Library, signal: AbortSignal): Promise<Download> {
    if (library.downloads?.artifact) return library.downloads.artifact
    const relative = mavenPath(library.name)
    const base = library.url ?? 'https://libraries.minecraft.net/'
    const url = new URL(relative, base.endsWith('/') ? base : `${base}/`).href
    let hash = library.sha1
    if (!validHash(hash)) {
      const checksum = await this.request(`${url}.sha1`, signal)
      hash = (await this.readResponse(checksum, 1024)).toString('utf8').trim().split(/\s/)[0]
    }
    if (!validHash(hash)) throw new Error(`无法校验 Fabric 库：${library.name}`)
    return { url, path: relative, sha1: hash }
  }

  async install(id: string): Promise<LauncherSnapshot> {
    const instance = this.instance(id)
    if (this.instanceSettingsSaving.has(id)) throw new Error('请等待此实例的设置保存完成')
    if (this.installs.has(id)) throw new Error('该实例正在安装')
    if (this.processes.has(id) || this.launching.has(id)) throw new Error('请先关闭正在运行或启动中的游戏')
    const controller = new AbortController()
    const signal = controller.signal
    const preferences = this.instanceOptions(id).values
    this.installs.set(id, controller)
    instance.status = 'installing'
    delete instance.error
    let downloadedBytes = 0
    let completed = 0
    let total = 1
    let lastUpdate = 0
    const progress = (phase: string, force = false) => {
      if (force || Date.now() - lastUpdate > 100) {
        lastUpdate = Date.now()
        this.emit({ type: 'progress', instanceId: id, phase, completed, total, bytesDownloaded: downloadedBytes })
      }
    }
    try {
      await this.save()
      signal.throwIfAborted()
      progress('正在获取官方版本信息', true)
      let pack: ParsedModpack | undefined
      if (instance.modpack && !instance.modpack.applied) {
        const archiveFile = safeJoin(this.instanceDirectory(id), 'pack.mrpack')
        if (!validHash(instance.modpack.archiveSha1) || !/^[a-f0-9]{128}$/i.test(instance.modpack.archiveSha512)) {
          throw new Error('整合包安装记录校验值无效，请重新导入')
        }
        pack = await readModpack(archiveFile)
        if (createHash('sha1').update(pack.archive).digest('hex') !== instance.modpack.archiveSha1 ||
            createHash('sha512').update(pack.archive).digest('hex') !== instance.modpack.archiveSha512) {
          throw new Error('保存的整合包已被修改，请重新导入')
        }
        if (pack.preview.unsupportedReason) throw new Error(pack.preview.unsupportedReason)
        if (pack.preview.minecraftVersion !== instance.version || pack.preview.loader !== instance.loader ||
            pack.preview.loaderVersion !== instance.loaderVersion) {
          throw new Error('整合包与实例的游戏或加载器版本不一致')
        }
      }
      const entry = (await this.manifest(signal)).versions.find(v => v.id === instance.version && v.type === 'release')
      if (!entry) throw new Error('找不到该 Minecraft 正式版本')
      const versionFile = safeJoin(this.rootDir, `versions/${sanitizeId(instance.version)}/${sanitizeId(instance.version)}.json`)
      await this.download({ file: versionFile, download: entry }, signal)
      const version: VersionManifest = JSON.parse(await fs.readFile(versionFile, 'utf8'))
      if (!version.arguments?.game || !version.arguments?.jvm || !version.downloads?.client ||
          !version.assetIndex || !Array.isArray(version.libraries)) throw new Error('该版本的启动格式暂不支持')
      const javaRequirement = this.javaRequirement(version, instance)
      progress(`正在准备 Java ${javaRequirement.major}`, true)
      const runtime = await this.selectJava(javaRequirement.major, javaRequirement.component, {
        signal, javaPath: preferences.javaPath, onProgress: update => {
          this.emit({ type: 'progress', instanceId: id, phase: `${JAVA_PHASES[update.phase]}（Java ${javaRequirement.major}）`,
            completed: update.completedBytes, total: update.totalBytes, bytesDownloaded: update.completedBytes, unit: 'bytes' })
        },
      })
      signal.throwIfAborted()
      let libraries = [...version.libraries]
      let mainClass = version.mainClass
      let fabricArguments: InstalledManifest['fabricArguments'] = { game: [], jvm: [] }
      if (instance.loader === 'fabric') {
        progress('正在解析 Fabric Loader', true)
        const loaders = await this.json<Array<{ loader: { version: string; stable: boolean } }>>(
          `${FABRIC_URL}/versions/loader/${encodeURIComponent(instance.version)}`, signal,
        )
        const loader = instance.loaderVersion
          ? loaders.find(item => item.loader.version === instance.loaderVersion)?.loader
          : loaders.find(item => item.loader.stable)?.loader
        if (!loader) throw new Error(instance.loaderVersion ? '整合包或实例指定的 Fabric Loader 不可用' : '此 Minecraft 版本尚无稳定的 Fabric Loader')
        const profile = await this.json<{ mainClass: string; libraries: Library[]; arguments?: Partial<InstalledManifest['fabricArguments']> }>(
          `${FABRIC_URL}/versions/loader/${encodeURIComponent(instance.version)}/${encodeURIComponent(loader.version)}/profile/json`, signal,
        )
        const byName = new Map<string, Library>()
        for (const library of [...libraries, ...profile.libraries]) {
          const coordinate = library.name.split(':')
          byName.set(`${coordinate[0]}:${coordinate[1]}:${coordinate[3] ?? ''}`, library)
        }
        libraries = [...byName.values()]
        mainClass = profile.mainClass
        fabricArguments = { game: profile.arguments?.game ?? [], jvm: profile.arguments?.jvm ?? [] }
        instance.loaderVersion = loader.version
      }
      const clientRelative = `versions/${sanitizeId(instance.version)}/${sanitizeId(instance.version)}.jar`
      const jobs: DownloadJob[] = [{ file: safeJoin(this.rootDir, clientRelative), download: version.downloads.client }]
      let classpath: string[] = []
      const libraryClasspath = new Map<string, string>()
      const libraryKey = (name: string) => {
        const [group, artifact, , classifier = ''] = name.split(':')
        return `${group}:${artifact}:${classifier}`
      }
      const natives: Array<{ file: string; exclude: string[] }> = []
      for (const library of libraries) {
        signal.throwIfAborted()
        if (!rulesAllow(library.rules, this.platform, this.arch)) continue
        if (library.downloads?.artifact || !library.downloads) {
          const download = await this.libraryDownload(library, signal)
          const relative = `libraries/${download.path ?? mavenPath(library.name)}`
          const file = safeJoin(this.rootDir, relative)
          jobs.push({ file, download })
          classpath.push(relative)
          libraryClasspath.set(libraryKey(library.name), relative)
        }
        const nativeKey = library.natives?.[platformName(this.platform)]?.replace('${arch}', this.arch === 'ia32' ? '32' : '64')
        if (nativeKey) {
          const native = library.downloads?.classifiers?.[nativeKey]
          if (!native?.path) throw new Error(`缺少平台原生库：${library.name}`)
          const file = safeJoin(this.rootDir, `libraries/${native.path}`)
          jobs.push({ file, download: native })
          natives.push({ file, exclude: library.extract?.exclude ?? ['META-INF/'] })
        }
      }
      classpath.push(clientRelative)
      const assetId = sanitizeId(version.assetIndex.id)
      const assetIndexFile = safeJoin(this.rootDir, `assets/indexes/${assetId}.json`)
      await this.download({ file: assetIndexFile, download: version.assetIndex }, signal)
      const assets: { objects: Record<string, { hash: string; size: number }>; virtual?: boolean; map_to_resources?: boolean } =
        JSON.parse(await fs.readFile(assetIndexFile, 'utf8'))
      if (assets.virtual || assets.map_to_resources) throw new Error('该版本使用旧版资源布局，首版暂不支持')
      for (const asset of Object.values(assets.objects)) {
        if (!validHash(asset.hash)) throw new Error('资源索引包含无效的 SHA-1')
        const suffix = `${asset.hash.slice(0, 2)}/${asset.hash}`
        jobs.push({ file: safeJoin(this.rootDir, `assets/objects/${suffix}`), download: {
          url: `https://resources.download.minecraft.net/${suffix}`, sha1: asset.hash, size: asset.size,
        } })
      }
      let loggingFile: string | undefined
      if (version.logging?.client) {
        loggingFile = `assets/log_configs/${sanitizeId(version.logging.client.file.id)}`
        jobs.push({ file: safeJoin(this.rootDir, loggingFile), download: version.logging.client.file })
      }
      const uniqueJobs = [...new Map(jobs.map(job => [job.file, job])).values()]
      total = uniqueJobs.length
      progress('正在下载游戏、运行库和资源', true)
      let cursor = 0
      // All workers settle before final state changes, including cancellation and failures.
      const workers = Array.from({ length: Math.min(this.settings.concurrentDownloads, total) }, async () => {
        for (;;) {
          signal.throwIfAborted()
          const job = uniqueJobs[cursor++]
          if (!job) return
          await this.download(job, signal, bytes => { downloadedBytes += bytes; progress('正在下载游戏、运行库和资源') })
          completed++
          progress('正在下载游戏、运行库和资源')
        }
      })
      const outcomes = await Promise.allSettled(workers.map(worker => worker.catch(error => { controller.abort(error); throw error })))
      const failure = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult | undefined
      if (failure) throw failure.reason
      signal.throwIfAborted()
      const nativeDir = safeJoin(this.instanceDirectory(id), 'natives')
      await fs.rm(nativeDir, { recursive: true, force: true })
      await fs.mkdir(nativeDir, { recursive: true })
      progress('正在准备原生库', true)
      for (const native of natives) await this.extractNatives(native.file, nativeDir, native.exclude, signal)
      let loaderLibraryDirectory: string | undefined
      if (instance.loader === 'forge' || instance.loader === 'neoforge') {
        const available = await this.loaderVersions(instance.version, instance.loader, signal)
        const selected = instance.loaderVersion
          ? available.find(item => item.version === instance.loaderVersion)
          : available.find(item => item.recommended) ?? available.find(item => item.stable) ?? available[0]
        if (!selected) throw new Error('所选加载器版本不可用')
        signal.throwIfAborted()
        const result = await installForge({
          loader: instance.loader, game: instance.version, build: selected.version,
          rootDir: this.rootDir, instanceDir: this.instanceDirectory(id), java: runtime.path,
          clientFile: safeJoin(this.rootDir, clientRelative), clientMappings: version.downloads.client_mappings, signal,
          download: (file, download) => this.download({ file, download }, signal, bytes => { downloadedBytes += bytes }),
          text: url => this.text(url, signal),
          progress: message => progress(message, true), log: message => this.log(id, 'info', message),
          prepareJava: async requirement => {
            signal.throwIfAborted()
            if (requirement && requirement.majorVersion !== javaRequirement.major) {
              throw new Error(`加载器要求 Java ${requirement.majorVersion}，与游戏要求的 Java ${javaRequirement.major} 不一致，请选择兼容的加载器版本`)
            }
            if (requirement?.component && javaRequirement.component && requirement.component !== javaRequirement.component) {
              throw new Error('加载器与游戏的 Java 运行时组件不一致，请选择兼容的加载器版本')
            }
            return runtime.path
          },
        })
        const relative = (file: string) => path.relative(this.rootDir, file).split(path.sep).join('/')
        for (const library of result.classpath) libraryClasspath.set(libraryKey(library.name), relative(library.file))
        classpath = [...libraryClasspath.values(), clientRelative]
        mainClass = result.profile.mainClass
        fabricArguments = result.profile.arguments
        loaderLibraryDirectory = relative(result.directory)
        if (result.profile.javaVersion) version.javaVersion = { ...version.javaVersion, ...result.profile.javaVersion }
        instance.loaderVersion = selected.version
      }
      signal.throwIfAborted()
      const installed: InstalledManifest = {
        schema: 1, version, platform: this.platform, arch: this.arch,
        classpath, mainClass, fabricArguments, loggingFile, loaderLibraryDirectory,
      }
      await fs.writeFile(safeJoin(this.instanceDirectory(id), 'installed.json'), JSON.stringify(installed, null, 2), { mode: 0o600 })
      if (pack) {
        await this.installPackFiles(id, pack, signal)
        instance.modpack!.applied = true
      }
      instance.status = 'ready'
      delete instance.error
      progress('安装完成', true)
      const label = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }[instance.loader]
      this.log(id, 'info', `${instance.name} 安装完成（${label}${instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}）`)
    } catch (error) {
      // Only a user-requested abort has AbortError; worker failures retain their actual error.
      const cancelled = signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'AbortError'
      instance.status = cancelled ? 'not-installed' : 'error'
      instance.error = cancelled ? undefined : errorMessage(error)
      this.log(id, cancelled ? 'info' : 'error', cancelled ? '安装已取消；已校验的文件会在下次安装时复用。' : errorMessage(error))
      throw cancelled ? new Error('安装已取消') : error
    } finally {
      this.installs.delete(id)
      await this.save()
    }
    return this.snapshot()
  }

  cancelInstall(id: string): void {
    const controller = this.installs.get(id)
    if (!controller) { this.instance(id); return }
    controller.abort(new DOMException('安装已取消', 'AbortError'))
  }

  private async extractNatives(file: string, directory: string, excludes: string[], signal: AbortSignal): Promise<void> {
    const zip = new AdmZip(file)
    let expanded = 0
    for (const entry of zip.getEntries()) {
      signal.throwIfAborted()
      if (entry.isDirectory || excludes.some(prefix => entry.entryName.startsWith(prefix))) continue
      const target = safeJoin(directory, entry.entryName)
      if (((entry.attr >>> 16) & 0xf000) === 0xa000) throw new Error('原生库压缩包不能包含符号链接')
      expanded += entry.header.size
      if (entry.header.size > 128 * 1024 * 1024 || expanded > 512 * 1024 * 1024) throw new Error('原生库解压大小超出限制')
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, entry.getData(), { mode: 0o755 })
    }
  }

  private javaRequirement(version: VersionManifest, instance: Instance): JavaRequirement {
    const major = version.javaVersion?.majorVersion
    const component = version.javaVersion?.component
    if (!Number.isInteger(major) || major! < 8 || major! > 99 ||
        (component !== undefined && (typeof component !== 'string' || !/^[a-z0-9-]{1,80}$/.test(component)))) {
      throw new Error('官方版本清单缺少有效的 Java 要求，请重新安装修复实例')
    }
    return { instanceName: instance.name, major: major!, ...(component ? { component } : {}) }
  }

  async runtimeRequirement(id: string): Promise<JavaRequirement> {
    const instance = this.instance(id)
    let installed: InstalledManifest | undefined
    try {
      installed = JSON.parse(await fs.readFile(safeJoin(this.instanceDirectory(id), 'installed.json'), 'utf8')) as InstalledManifest
      const requirement = this.javaRequirement(installed.version, instance)
      if (installed.schema === 1 && requirement.component) return requirement
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const signal = AbortSignal.timeout(90_000)
    const entry = (await this.manifest(signal)).versions.find(version => version.id === instance.version && version.type === 'release')
    if (!entry) throw new Error('找不到该 Minecraft 正式版本')
    const versionFile = safeJoin(this.rootDir, `versions/${sanitizeId(instance.version)}/${sanitizeId(instance.version)}.json`)
    await this.download({ file: versionFile, download: entry }, signal)
    const base = this.javaRequirement(JSON.parse(await fs.readFile(versionFile, 'utf8')) as VersionManifest, instance)
    if (installed?.version.javaVersion && installed.version.javaVersion.majorVersion !== base.major) {
      throw new Error('已安装加载器与官方游戏的 Java 要求不一致，请重新安装修复实例')
    }
    return base
  }

  managedJava(): Promise<ManagedJavaRuntime[]> { return this.javaRuntimeManager.discover() }
  runtimeTasks(): JavaRuntimeTask[] { return structuredClone([...this.javaTasks.values()]) }

  startJavaInstall(major: number): JavaRuntimeTask {
    if (!Number.isInteger(major) || !JAVA_COMPONENTS[major]) throw new Error('请选择 Java 17、21 或 25')
    const previous = [...this.javaTasks.values()].find(task => task.major === major && ['queued', 'active', 'cancelling'].includes(task.status))
    if (previous) return structuredClone(previous)
    // Keep a bounded, honest in-process history. Installed runtimes survive restarts.
    for (const [id, task] of this.javaTasks) {
      if (this.javaTasks.size < 30) break
      if (['complete', 'cancelled', 'error'].includes(task.status)) this.javaTasks.delete(id)
    }
    const task: JavaRuntimeTask = { id: randomUUID(), major, component: JAVA_COMPONENTS[major], status: 'queued',
      phase: '等待准备 Java', source: 'Mojang 官方', completedBytes: 0, totalBytes: 0 }
    const controller = new AbortController()
    this.javaTasks.set(task.id, task)
    this.javaDownloads.set(task.id, controller)
    const announce = () => this.emit({ type: 'javaTask', task: structuredClone(task) })
    announce()
    void (async () => {
      try {
        task.status = 'active'
        announce()
        const runtime = await this.javaRuntimeManager.ensure({ component: task.component, major, platform: this.platform, arch: this.arch }, {
          signal: controller.signal, onProgress: progress => {
            if (controller.signal.aborted) return
            task.phase = JAVA_PHASES[progress.phase]
            task.completedBytes = progress.completedBytes
            task.totalBytes = progress.totalBytes
            announce()
          },
        })
        task.status = 'complete'; task.phase = 'Java 安装完成'; task.path = runtime.path
      } catch (error) {
        const cancelled = controller.signal.aborted
        task.status = cancelled ? 'cancelled' : 'error'
        task.phase = cancelled ? '安装已取消' : 'Java 安装失败'
        if (!cancelled) task.error = errorMessage(error)
      } finally {
        this.javaDownloads.delete(task.id)
        announce()
      }
    })()
    return structuredClone(task)
  }

  cancelJavaInstall(id: string): void {
    const task = this.javaTasks.get(id)
    if (!task) throw new Error('Java 下载任务不存在')
    const controller = this.javaDownloads.get(id)
    if (!controller) return
    task.status = 'cancelling'; task.phase = '正在取消 Java 安装'
    controller.abort(new DOMException('Java 安装已取消', 'AbortError'))
    this.emit({ type: 'javaTask', task: structuredClone(task) })
  }

  cancelLaunch(id: string): void {
    this.instance(id)
    this.launchControllers.get(id)?.abort(new DOMException('启动准备已取消', 'AbortError'))
  }

  cancelPendingOperations(): void {
    for (const controller of [...this.installs.values(), ...this.javaDownloads.values(), ...this.launchControllers.values()]) {
      controller.abort(new DOMException('启动器正在退出', 'AbortError'))
    }
  }

  async detectJava(additionalPath?: string): Promise<JavaRuntime[]> {
    const executable = this.platform === 'win32' ? 'java.exe' : 'java'
    const candidates = new Set<string>([additionalPath, this.settings.javaPath, 'java'].filter((value): value is string => Boolean(value)))
    if (process.env.JAVA_HOME) candidates.add(path.join(process.env.JAVA_HOME, 'bin', executable))
    if (this.platform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('/usr/libexec/java_home', [], { timeout: 5000 })
        if (stdout.trim()) candidates.add(path.join(stdout.trim(), 'bin', 'java'))
      } catch {}
      for (const root of ['/Library/Java/JavaVirtualMachines', path.join(os.homedir(), 'Library/Java/JavaVirtualMachines')]) {
        try {
          for (const folder of await fs.readdir(root)) candidates.add(path.join(root, folder, 'Contents/Home/bin/java'))
        } catch {}
      }
      for (const version of ['17', '21', '25']) {
        candidates.add(`/opt/homebrew/opt/openjdk@${version}/bin/java`)
        candidates.add(`/usr/local/opt/openjdk@${version}/bin/java`)
      }
    } else if (this.platform === 'linux') {
      try { for (const folder of await fs.readdir('/usr/lib/jvm')) candidates.add(`/usr/lib/jvm/${folder}/bin/java`) } catch {}
    } else if (this.platform === 'win32') {
      for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
        for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft']) {
          try {
            for (const folder of await fs.readdir(path.join(root, vendor))) candidates.add(path.join(root, vendor, folder, 'bin/java.exe'))
          } catch {}
        }
      }
    }
    const runtimes = await Promise.all([...candidates].map(async candidate => {
      try {
        const { stdout, stderr } = await execFileAsync(candidate, ['-XshowSettings:properties', '-version'], {
          timeout: 8000, windowsHide: true, maxBuffer: 256 * 1024, env: javaProcessEnvironment(),
        })
        const output = `${stdout}\n${stderr}`
        const version = /(?:openjdk|java) version "([^"]+)"/.exec(output)?.[1] ??
          /java\.version\s*=\s*(\S+)/.exec(output)?.[1]
        if (!version) return undefined
        const major = Number(version.startsWith('1.') ? version.split('.')[1] : version.split(/[.+\-]/)[0])
        const arch = normalizeArch(/os\.arch\s*=\s*(\S+)/.exec(output)?.[1] ?? this.arch)
        const javaHome = /java\.home\s*=\s*(.+)/.exec(output)?.[1].trim()
        const resolvedPath = (candidate === additionalPath || candidate === this.settings.javaPath) && candidate !== 'java'
          ? candidate : javaHome ? path.join(javaHome, 'bin', executable) : candidate
        return { path: resolvedPath, version, major, arch }
      } catch { return undefined }
    }))
    const managed = await this.javaRuntimeManager.discover()
    return [...new Map([...runtimes.filter((runtime): runtime is JavaRuntime => Boolean(runtime)), ...managed].map(runtime => [runtime.path, runtime])).values()]
      .sort((a, b) => b.major - a.major)
  }

  async launch(id: string, account: LaunchAccount, beforeSpawn?: () => void): Promise<{ pid: number | undefined }> {
    if (this.instanceSettingsSaving.has(id)) throw new Error('请等待此实例的设置保存完成')
    if (this.launching.has(id)) throw new Error('该实例正在启动')
    // Acquire synchronously: installed-manifest reads and Java detection both yield before spawn.
    this.launching.add(id)
    const controller = new AbortController()
    this.launchControllers.set(id, controller)
    try {
      return await this.launchInstance(id, account, () => { controller.signal.throwIfAborted(); beforeSpawn?.() }, controller.signal)
    } finally {
      this.launching.delete(id)
      this.launchControllers.delete(id)
    }
  }

  private async selectJava(required: number, component?: string, options: { signal?: AbortSignal; javaPath?: string; onProgress?: (progress: JavaRuntimeProgress) => void } = {}): Promise<JavaRuntime> {
    options.signal?.throwIfAborted()
    const configured = options.javaPath ?? this.settings.javaPath
    const explicitPath = configured && configured !== 'java' ? configured : ''
    const runtimes = await this.detectJava(explicitPath)
    options.signal?.throwIfAborted()
    let runtime = explicitPath
      ? runtimes.find(java => java.path === explicitPath)
      : runtimes.find(java => java.major === required && java.arch === this.arch)
    if (!runtime && explicitPath) throw new Error(`指定的 Java 路径不可用，需要 Java ${required}（${this.arch}）。请在设置中修正路径或切换自动选择。`)
    if (!runtime) {
      if (!component) throw new Error(`需要 Java ${required}（${this.arch}），版本清单缺少官方运行时组件。请重新安装修复实例，或在设置中指定匹配的 Java。`)
      runtime = await this.javaRuntimeManager.ensure({ component, major: required, platform: this.platform, arch: this.arch }, options)
    }
    if (runtime.major !== required) throw new Error(`该版本需要 Java ${required}，当前选择的是 Java ${runtime.major}`)
    if (runtime.arch !== this.arch) throw new Error(`Java 架构 ${runtime.arch} 与启动器架构 ${this.arch} 不一致`)
    return runtime
  }

  private async launchInstance(id: string, account: LaunchAccount, beforeSpawn?: () => void, signal?: AbortSignal): Promise<{ pid: number | undefined }> {
    const instance = this.instance(id)
    if (this.installs.has(id)) throw new Error('请等待安装完成')
    if (this.processes.has(id)) throw new Error('该实例已经在运行')
    if (instance.status !== 'ready') throw new Error('请先安装或修复该实例')
    if (!account || account.mode !== 'microsoft') throw new Error('请先登录拥有 Minecraft Java 版的 Microsoft 账户')
    if (typeof account.username !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(account.username)) {
      throw new Error('微软账户游戏档案无效，请重新登录')
    }
    if (
      typeof account.uuid !== 'string' ||
      !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(account.uuid) ||
      typeof account.accessToken !== 'string' || !account.accessToken || account.accessToken === '0' ||
      account.accessToken.length > 32_768 || /[\s\u0000-\u001f\u007f]/u.test(account.accessToken)
    ) {
      throw new Error('微软账户凭据无效，请重新登录')
    }
    // Keep the validated credentials stable while filesystem and Java checks await.
    const credentials = { ...account }
    const resolved = this.instanceOptions(id)
    const preferences = resolved.values
    const token = credentials.accessToken
    const directory = this.instanceDirectory(id)
    const installed: InstalledManifest = JSON.parse(await fs.readFile(safeJoin(directory, 'installed.json'), 'utf8'))
    if (installed.schema !== 1 || installed.platform !== this.platform || installed.arch !== this.arch) {
      throw new Error('此实例来自其他系统或架构，请重新安装以下载正确的原生库')
    }
    const requirement = installed.version.javaVersion?.component
      ? this.javaRequirement(installed.version, instance) : await this.runtimeRequirement(id)
    const runtime = await this.selectJava(requirement.major, requirement.component, { signal, javaPath: preferences.javaPath, onProgress: update => {
      this.emit({ type: 'progress', instanceId: id, phase: `${JAVA_PHASES[update.phase]}（Java ${requirement.major}）`,
        completed: update.completedBytes, total: update.totalBytes, bytesDownloaded: update.completedBytes, unit: 'bytes' })
    } })
    const classpath = installed.classpath.map(relative => safeJoin(this.rootDir, relative))
    for (const file of classpath) {
      try { await fs.access(file) } catch { throw new Error(`缺少游戏文件 ${path.basename(file)}，请重新安装修复`) }
    }
    const gameDir = safeJoin(directory, 'game')
    await fs.mkdir(gameDir, { recursive: true })
    const variables: Record<string, string> = {
      auth_player_name: credentials.username,
      auth_uuid: credentials.uuid.replace(/-/g, ''),
      auth_access_token: token,
      auth_session: token,
      auth_xuid: credentials.xuid ?? '',
      clientid: credentials.clientId ?? '',
      version_name: instance.version,
      version_type: installed.version.type ?? 'release',
      game_directory: gameDir,
      assets_root: safeJoin(this.rootDir, 'assets'),
      assets_index_name: installed.version.assetIndex.id,
      natives_directory: safeJoin(directory, 'natives'),
      launcher_name: 'LuaLauncher',
      launcher_version: metadata.version,
      classpath: classpath.join(this.platform === 'win32' ? ';' : ':'),
      classpath_separator: this.platform === 'win32' ? ';' : ':',
      library_directory: safeJoin(this.rootDir, installed.loaderLibraryDirectory ?? 'libraries'),
      user_type: 'msa',
      user_properties: '{}',
      resolution_width: String(preferences.windowWidth),
      resolution_height: String(preferences.windowHeight),
    }
    const features = { has_custom_resolution: true }
    const jvm = resolveArguments([...installed.version.arguments.jvm, ...installed.fabricArguments.jvm], variables, this.platform, this.arch, features)
    const game = resolveArguments([...installed.version.arguments.game, ...installed.fabricArguments.game], variables, this.platform, this.arch, features)
    const allocation = effectiveMemory(preferences, {
      gameVersion: instance.version, modded: instance.loader !== 'vanilla', javaArch: runtime.arch,
    }, this.memorySystem)
    const args = ['-Xms512M', `-Xmx${allocation.effectiveMb}M`, ...jvm, ...preferences.jvmArgs]
    if (installed.loggingFile && installed.version.logging?.client) {
      args.push(installed.version.logging.client.argument.replace('${path}', safeJoin(this.rootDir, installed.loggingFile)))
    }
    args.push(installed.mainClass, ...game)
    if (resolved.sources.fullscreen !== 'default') {
      await applyGameWindowSettings(gameDir, preferences.fullscreen, {
        backupDirectory: safeJoin(directory, 'backups/window-options'), signal,
      })
      // Explicit false must also override a previous persisted true game option.
      // Remove a forced flag from the resolved metadata before adding our choice.
      const mainIndex = args.indexOf(installed.mainClass)
      for (let index = args.length - 1; index > mainIndex; index--) {
        if (args[index] === '--fullscreen') args.splice(index, 1)
      }
      if (preferences.fullscreen) args.push('--fullscreen')
    }
    this.log(id, 'info', `正在使用 Java ${runtime.version} 启动 ${instance.name}`)
    this.log(id, 'info', `${allocation.mode === 'auto' ? '自动' : '手动'}分配内存：${allocation.effectiveMb} MB${allocation.clamped ? `（已按当前可用内存限制，原目标 ${allocation.requestedMb} MB）` : ''}`)
    // No await between the coordinator's final session check and creating Java.
    beforeSpawn?.()
    const child = this.spawnProcess(runtime.path, args, { cwd: gameDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: javaProcessEnvironment() })
    this.processes.set(id, child)
    const started = Date.now()
    const scrub = (text: string) => text.split(token).join('[REDACTED]')
    for (const [stream, level] of [[child.stdout, 'info'], [child.stderr, 'warn']] as const) {
      let pending = ''
      let xmlLevel: 'info' | 'warn' | 'error' = level
      const logLine = (raw: string) => {
        const eventLevel = /<log4j:Event\b[^>]*\blevel="([A-Z]+)"/.exec(raw)?.[1]
        if (eventLevel) {
          xmlLevel = ['ERROR', 'FATAL'].includes(eventLevel) ? 'error' : eventLevel === 'WARN' ? 'warn' : 'info'
          return
        }
        if (/^\s*<\/log4j:Event>\s*$/.test(raw)) return
        const line = raw.replace(/^\s*<log4j:(?:Message|Throwable)><!\[CDATA\[/, '')
          .replace(/\]\]><\/log4j:(?:Message|Throwable)>\s*$/, '')
        if (line.trim()) this.log(id, xmlLevel, scrub(line).slice(0, 8192))
      }
      stream?.setEncoding('utf8')
      stream?.on('data', (chunk: string) => {
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) logLine(line)
        if (pending.length > 32_768) { logLine(pending); pending = '' }
      })
      stream?.on('end', () => { if (pending.trim()) logLine(pending) })
    }
    child.once('close', (code, signal) => {
      // A failed older child may report close after a successful retry already owns this instance.
      if (this.processes.get(id) !== child) return
      this.processes.delete(id)
      const requestedStop = this.stopping.delete(id)
      instance.playtimeMs += Math.max(0, Date.now() - started)
      instance.status = 'ready'
      if (code !== 0 && !requestedStop) {
        instance.error = signal
          ? `游戏异常退出，信号 ${signal}；请查看游戏日志。`
          : `游戏已退出，退出码 ${code ?? '未知'}；请查看游戏日志。`
        this.log(id, 'error', instance.error)
      } else { delete instance.error; this.log(id, 'info', '游戏已关闭') }
      void this.save().catch(error => this.log(id, 'error', errorMessage(error)))
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    }).catch(error => {
      if (this.processes.get(id) === child) this.processes.delete(id)
      this.log(id, 'error', errorMessage(error))
      throw new Error(`无法启动 Java：${errorMessage(error)}`)
    })
    instance.status = 'running'
    instance.lastPlayed = new Date().toISOString()
    delete instance.error
    await this.save()
    return { pid: child.pid }
  }

  stop(id: string): void {
    this.instance(id)
    const process = this.processes.get(id)
    if (!process) return
    this.stopping.add(id)
    if (process.kill('SIGTERM')) this.log(id, 'info', '已向游戏发送关闭请求')
    else this.stopping.delete(id)
  }

  private log(instanceId: string, level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', instanceId, level, message })
  }

  async searchMods(query: string, options: { loader?: string; gameVersion?: string; category?: string; offset?: number; source?: ResourceSource } = {}): Promise<ModrinthSearchResponse> {
    const source = options.source ?? 'modrinth'
    const provider = resourceProvider(source)
    if (query.length > 200) throw new Error('搜索关键词过长')
    const facets = [['project_type:mod']]
    if (options.category) {
      if (!Object.hasOwn(BBSMC_MOD_CATEGORIES, options.category)) throw new Error('无效的模组功能分类')
      const category = source === 'bbsmc' ? BBSMC_MOD_CATEGORIES[options.category] : options.category
      facets.push([`categories:${category}`])
    }
    if (options.loader) {
      if (!['fabric', 'forge', 'quilt', 'neoforge'].includes(options.loader)) throw new Error('无效的模组加载器')
      facets.push([`categories:${options.loader}`])
    }
    if (options.gameVersion) { sanitizeId(options.gameVersion); facets.push([`versions:${options.gameVersion}`]) }
    const offset = options.offset ?? 0
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new Error('无效的分页参数')
    const params = new URLSearchParams({
      query, facets: JSON.stringify(facets), offset: String(offset), limit: '20', index: query ? 'relevance' : 'downloads',
    })
    const result = await this.json<ModrinthSearchResponse>(`${provider.api}/search?${params}`)
    return { ...result, hits: result.hits.map(hit => ({ ...hit, source })) }
  }

  async searchModpacks(query: string, options: { offset?: number; source?: ResourceSource } = {}): Promise<ModrinthSearchResponse> {
    const source = options.source ?? 'modrinth'
    const provider = resourceProvider(source)
    if (typeof query !== 'string' || query.length > 200) throw new Error('搜索关键词过长')
    const offset = options.offset ?? 0
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new Error('无效的分页参数')
    const params = new URLSearchParams({
      query, offset: String(offset), limit: '20', index: query ? 'relevance' : 'downloads',
      facets: JSON.stringify([['project_type:modpack'], ['categories:fabric', 'categories:forge', 'categories:neoforge', 'categories:minecraft', 'categories:vanilla']]),
    })
    const result = await this.json<ModrinthSearchResponse>(`${provider.api}/search?${params}`)
    return { ...result, hits: result.hits.map(hit => ({ ...hit, source })) }
  }

  private resourceVersion(version: ModrinthVersion, source: ResourceSource, kind: 'mod' | 'modpack'): ModrinthVersion {
    const provider = resourceProvider(source)
    const extension = kind === 'mod' ? '.jar' : '.mrpack'
    const candidates = version.files.filter(file => file.filename?.toLowerCase().endsWith(extension))
    const file = candidates.find(file => file.primary) ?? candidates[0]
    let reason: string | undefined
    if (version.disk_only) reason = '此版本使用网盘或外部站点下载，请到资源官网获取'
    else if (!file) reason = `此版本没有可直接安装的 ${extension} 文件，请到资源官网获取`
    else if (!validHash(file.hashes?.sha1) ||
        ((kind === 'modpack' || source === 'bbsmc' || file.hashes.sha512 !== undefined) &&
         !/^[a-f0-9]{128}$/i.test(file.hashes.sha512 ?? ''))) {
      reason = '此版本缺少有效的文件校验值，请到资源官网获取'
    } else if (!Number.isSafeInteger(file.size) || file.size <= 0 ||
        file.size > (kind === 'modpack' ? MODPACK_LIMITS.archiveBytes : MODPACK_LIMITS.downloadedFileBytes)) {
      reason = '此版本文件大小不符合安装限制，请到资源官网获取'
    } else {
      try { assertNetworkUrl(file.url, provider.downloads) }
      catch { reason = '此版本使用外部下载地址，请到资源官网获取' }
    }
    return {
      ...version, source, projectUrl: `${provider.website}/${kind}/${encodeURIComponent(sanitizeId(version.project_id))}`,
      externalOnly: Boolean(reason), ...(reason ? { externalReason: reason } : {}),
    }
  }

  async modpackVersions(projectId: string, source: ResourceSource = 'modrinth'): Promise<ModrinthVersion[]> {
    const provider = resourceProvider(source)
    const versions = await this.json<ModrinthVersion[]>(
      `${provider.api}/project/${encodeURIComponent(sanitizeId(projectId))}/version?include_changelog=false`,
    )
    return versions.filter(version =>
      version.game_versions.some(isSupportedVersion) &&
      version.loaders.some(loader => ['fabric', 'forge', 'neoforge', 'minecraft', 'vanilla'].includes(loader)) &&
      (source === 'bbsmc' || version.files.some(file => file.filename.toLowerCase().endsWith('.mrpack'))),
    ).map(version => this.resourceVersion(version, source, 'modpack'))
  }

  async inspectModpack(filePath: string): Promise<PackPreview> {
    return structuredClone((await readModpack(filePath)).preview)
  }

  async importModpack(filePath: string, options: { name?: string } = {}): Promise<LauncherSnapshot> {
    return this.createPackInstance(await readModpack(filePath), options, { source: 'local' })
  }

  async installModpack(versionId: string, options: { name?: string; source?: ResourceSource } = {}): Promise<LauncherSnapshot> {
    const source = options.source ?? 'modrinth'
    const provider = resourceProvider(source)
    const taskId = source === 'modrinth' ? `modpack-${sanitizeId(versionId)}` : `modpack-${source}-${sanitizeId(versionId)}`
    if (this.installs.has(taskId)) throw new Error('该整合包版本正在下载')
    const controller = new AbortController()
    this.installs.set(taskId, controller)
    try {
      this.emit({ type: 'progress', instanceId: taskId, phase: '正在获取整合包信息', completed: 0, total: 1, bytesDownloaded: 0 })
      const version = this.resourceVersion(
        await this.json<ModrinthVersion>(`${provider.api}/version/${encodeURIComponent(versionId)}`, controller.signal), source, 'modpack',
      )
      if (version.externalOnly) throw new Error(`${version.externalReason}：${version.projectUrl}`)
      if (!version.game_versions.some(isSupportedVersion) ||
          !version.loaders.some(loader => ['fabric', 'forge', 'neoforge', 'minecraft', 'vanilla'].includes(loader))) {
        throw new Error('此整合包需要未支持的 Minecraft 或加载器版本')
      }
      const candidates = version.files.filter(file => file.filename.toLowerCase().endsWith('.mrpack'))
      const file = candidates.find(file => file.primary) ?? candidates[0]
      if (!file || !Number.isSafeInteger(file.size) || file.size < 22 || file.size > MODPACK_LIMITS.archiveBytes) {
        throw new Error('整合包缺少有效的 .mrpack 文件，或文件超过 256 MiB')
      }
      if (!validHash(file.hashes.sha1) || !file.hashes.sha512 || !/^[a-f0-9]{128}$/i.test(file.hashes.sha512)) {
        throw new Error('整合包文件缺少 SHA-1 / SHA-512 校验')
      }
      const url = validatePackUrl(file.url)
      assertNetworkUrl(url, provider.downloads)
      const archivePath = safeJoin(this.rootDir, `packs/${file.hashes.sha512.toLowerCase()}.mrpack`)
      let bytes = 0
      let lastProgress = 0
      await this.download({
        file: archivePath, download: { url, sha1: file.hashes.sha1, sha512: file.hashes.sha512, size: file.size },
        allowedHosts: provider.downloads,
      }, controller.signal, count => {
        bytes += count
        if (Date.now() - lastProgress > 100) {
          lastProgress = Date.now()
          this.emit({ type: 'progress', instanceId: taskId, phase: '正在下载整合包', completed: Math.min(bytes, file.size), total: file.size, bytesDownloaded: bytes })
        }
      })
      controller.signal.throwIfAborted()
      const pack = await readModpack(archivePath)
      return await this.createPackInstance(pack, options, {
        source, projectId: version.project_id, remoteVersionId: version.id,
        ...(source === 'modrinth' ? { modrinthVersionId: version.id } : {}),
      }, controller.signal)
    } finally { this.installs.delete(taskId) }
  }

  private async createPackInstance(
    pack: ParsedModpack, options: { name?: string },
    source: Pick<NonNullable<Instance['modpack']>, 'source' | 'projectId' | 'modrinthVersionId' | 'remoteVersionId'>,
    signal?: AbortSignal,
  ): Promise<LauncherSnapshot> {
    signal?.throwIfAborted()
    const preview = pack.preview
    if (preview.unsupportedReason) throw new Error(preview.unsupportedReason)
    const name = (options.name ?? preview.name.slice(0, 64)).trim()
    if (!name || name.length > 64) throw new Error('实例名称需要 1–64 个字符')
    if (!(await this.versions(signal)).some(version => version.id === preview.minecraftVersion)) throw new Error('整合包指定的 Minecraft 正式版本不存在')
    if (preview.loader !== 'vanilla' && preview.loaderVersion && !(await this.loaderVersions(preview.minecraftVersion, preview.loader, signal)).some(loader => loader.version === preview.loaderVersion)) {
      throw new Error('整合包指定的加载器版本不可用')
    }
    signal?.throwIfAborted()
    const instance: Instance = {
      id: randomUUID(), name, version: preview.minecraftVersion, loader: preview.loader,
      loaderVersion: preview.loaderVersion, status: 'not-installed', createdAt: new Date().toISOString(), playtimeMs: 0,
      modpack: {
        name: preview.name, versionId: preview.versionId, ...source,
        archiveSha1: createHash('sha1').update(pack.archive).digest('hex'),
        archiveSha512: createHash('sha512').update(pack.archive).digest('hex'), applied: false,
      },
    }
    const directory = safeJoin(this.rootDir, `instances/${instance.id}`)
    try {
      await fs.mkdir(safeJoin(directory, 'game'), { recursive: true })
      await fs.writeFile(safeJoin(directory, 'pack.mrpack'), pack.archive, { mode: 0o600, flag: 'wx' })
      signal?.throwIfAborted()
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true })
      throw error
    }
    // Persist the immutable source archive and exact loader before the first install attempt.
    // An interrupted import therefore remains a normal, retryable instance on the next app run.
    this.instances.push(instance)
    await this.save()
    const abort = () => this.cancelInstall(instance.id)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const installing = this.install(instance.id)
      if (signal?.aborted) abort()
      return await installing
    } finally { signal?.removeEventListener('abort', abort) }
  }

  private async installPackFiles(id: string, pack: ParsedModpack, signal: AbortSignal): Promise<void> {
    const directory = this.instanceDirectory(id)
    const gameDirectory = safeJoin(directory, 'game')
    const staging = safeJoin(directory, `.pack-staging-${randomUUID()}`)
    const paths = [...pack.files.map(file => file.path), ...pack.overrides.map(file => file.path)]
    const backups: Array<{ original: string; backup: string }> = []
    const placed: string[] = []
    const createdDirectories: string[] = []
    let recoveryNeeded = false
    let bytesDownloaded = 0
    let completed = 0
    let lastProgress = 0
    const progress = (phase: string, force = false) => {
      if (force || Date.now() - lastProgress > 100) {
        lastProgress = Date.now()
        this.emit({ type: 'progress', instanceId: id, phase, completed, total: paths.length, bytesDownloaded })
      }
    }
    try {
      await fs.mkdir(safeJoin(staging, 'files'), { recursive: true })
      await fs.mkdir(safeJoin(staging, 'backups'), { recursive: true })
      progress('正在下载整合包文件', true)
      const failed = new AbortController()
      const downloadSignal = AbortSignal.any([signal, failed.signal])
      let cursor = 0
      const workers = Array.from({ length: Math.min(pack.files.length, this.settings.concurrentDownloads) }, async () => {
        for (;;) {
          downloadSignal.throwIfAborted()
          const file = pack.files[cursor++]
          if (!file) return
          const cacheFile = safeJoin(this.rootDir, `packs/files/${file.hashes.sha512}`)
          let lastError: unknown
          for (const url of file.downloads) {
            try {
              await this.download({
                file: cacheFile, download: { url, ...file.hashes, size: file.fileSize }, allowedHosts: PACK_REDIRECT_HOSTS,
              }, downloadSignal, bytes => { bytesDownloaded += bytes; progress('正在下载整合包文件') })
              lastError = undefined
              break
            } catch (error) {
              downloadSignal.throwIfAborted()
              lastError = error
            }
          }
          if (lastError) throw lastError
          const destination = safeJoin(staging, `files/${file.path}`)
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.copyFile(cacheFile, destination)
          completed++
          progress('正在下载整合包文件')
        }
      })
      const outcomes = await Promise.allSettled(workers.map(worker => worker.catch(error => { failed.abort(error); throw error })))
      const failure = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult | undefined
      if (failure) throw failure.reason
      for (const override of pack.overrides) {
        signal.throwIfAborted()
        const destination = safeJoin(staging, `files/${override.path}`)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, override.data, { mode: 0o600 })
        completed++
        progress('正在准备整合包配置')
      }
      signal.throwIfAborted()
      if (!(await fs.lstat(gameDirectory)).isDirectory()) throw new Error('实例游戏目录不是普通目录')
      // Build parents one component at a time and refuse pre-existing symlinks before commit.
      for (const relative of paths) {
        validatePackPath(relative)
        const parts = relative.split('/')
        for (let count = 1; count < parts.length; count++) {
          const parent = safeJoin(gameDirectory, parts.slice(0, count).join('/'))
          const existing = await fs.lstat(parent).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
          })
          if (existing && !existing.isDirectory()) throw new Error(`整合包目标目录包含符号链接或非目录：${relative}`)
          if (!existing) { await fs.mkdir(parent); createdDirectories.push(parent) }
        }
      }
      try {
        for (const relative of paths) {
          signal.throwIfAborted()
          const original = safeJoin(gameDirectory, relative)
          const existing = await fs.lstat(original).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
          })
          if (!existing) continue
          if (!existing.isFile()) throw new Error(`整合包目标不是普通文件：${relative}`)
          const backup = safeJoin(staging, `backups/${backups.length}`)
          await this.renameFile(original, backup)
          backups.push({ original, backup })
        }
        for (const relative of paths) {
          signal.throwIfAborted()
          const target = safeJoin(gameDirectory, relative)
          await this.renameFile(safeJoin(staging, `files/${relative}`), target)
          placed.push(target)
        }
        signal.throwIfAborted()
      } catch (error) {
        const rollbackErrors: unknown[] = []
        for (const file of placed.reverse()) {
          try { await fs.rm(file, { force: true }) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        }
        for (const { original, backup } of backups.reverse()) {
          try { await this.renameFile(backup, original) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        }
        if (rollbackErrors.length) {
          recoveryNeeded = true
          throw new AggregateError([error, ...rollbackErrors], `整合包回滚失败；恢复备份保留在 ${staging}`)
        }
        throw error
      }
      progress('整合包文件安装完成', true)
    } finally {
      if (!recoveryNeeded) await fs.rm(staging, { recursive: true, force: true })
      // Empty directories created by an unsuccessful commit are harmless, but remove them when possible.
      for (const directory of createdDirectories.reverse()) await fs.rmdir(directory).catch(() => {})
    }
  }

  async modVersions(projectId: string, instanceId: string, source: ResourceSource = 'modrinth', signal?: AbortSignal): Promise<ModrinthVersion[]> {
    const provider = resourceProvider(source)
    const instance = this.instance(instanceId)
    if (instance.loader === 'vanilla') throw new Error('请先选择 Fabric、Forge 或 NeoForge 实例')
    const params = new URLSearchParams({ loaders: JSON.stringify([instance.loader]), game_versions: JSON.stringify([instance.version]) })
    const versions = await this.json<ModrinthVersion[]>(`${provider.api}/project/${encodeURIComponent(sanitizeId(projectId))}/version?${params}`, signal)
    return versions.map(version => this.resourceVersion(version, source, 'mod'))
  }

  /** Installs required dependencies too; rejects incompatible versions instead of guessing. */
  async installMod(instanceId: string, versionId: string, source: ResourceSource = 'modrinth'): Promise<LauncherSnapshot> {
    if (this.instanceSettingsSaving.has(instanceId)) throw new Error('请等待此实例的设置保存完成')
    const provider = resourceProvider(source)
    const instance = this.instance(instanceId)
    if (instance.loader === 'vanilla' || instance.status !== 'ready') throw new Error('请先安装 Fabric、Forge 或 NeoForge 实例，并关闭游戏')
    if (this.launching.has(instanceId) || this.processes.has(instanceId)) throw new Error('请先关闭正在运行或启动中的游戏')
    if (this.installs.has(instanceId)) throw new Error('该实例已有安装任务')
    const controller = new AbortController()
    this.installs.set(instanceId, controller)
    const visited = new Set<string>()
    const projects = new Map<string, string>()
    const plan: Array<{ version: ModrinthVersion; job: DownloadJob }> = []
    const staging = safeJoin(this.instanceDirectory(instanceId), `.mod-staging-${randomUUID()}`)
    let keepRecoveryFiles = false
    try {
      const visit = async (id: string): Promise<void> => {
        if (visited.has(id)) return
        if (visited.size >= 100) throw new Error('模组依赖数量超出限制')
        visited.add(id)
        const version = this.resourceVersion(
          await this.json<ModrinthVersion>(`${provider.api}/version/${encodeURIComponent(sanitizeId(id))}`, controller.signal), source, 'mod',
        )
        if (version.externalOnly) throw new Error(`${version.externalReason}：${version.projectUrl}`)
        if (!version.loaders.includes(instance.loader) || !version.game_versions.includes(instance.version)) {
          throw new Error(`模组 ${version.name} 与此加载器 / Minecraft 版本不兼容`)
        }
        const otherVersion = projects.get(version.project_id)
        if (otherVersion && otherVersion !== version.id) throw new Error(`模组 ${version.name} 的依赖版本发生冲突`)
        projects.set(version.project_id, version.id)
        const candidates = version.files.filter(file => file.filename.toLowerCase().endsWith('.jar'))
        const file = candidates.find(file => file.primary) ?? candidates[0]
        if (!file || !file.filename.toLowerCase().endsWith('.jar') || file.filename.includes('/') || file.filename.includes('\\')) {
          throw new Error('模组文件格式不支持')
        }
        if (!validHash(file.hashes.sha1)) throw new Error('模组缺少 SHA-1 校验值')
        plan.push({ version, job: {
          file: safeJoin(this.instanceDirectory(instanceId), `game/mods/${file.filename}`),
          download: { url: file.url, sha1: file.hashes.sha1, sha512: file.hashes.sha512, size: file.size },
          allowedHosts: provider.downloads,
        } })
        for (const dependency of version.dependencies.filter(item => item.dependency_type === 'required')) {
          let dependencyVersion = dependency.version_id
          if (!dependencyVersion && dependency.project_id) {
            dependencyVersion = (await this.modVersions(dependency.project_id, instanceId, source, controller.signal))
              .find(version => !version.externalOnly)?.id
          }
          if (!dependencyVersion) throw new Error(`找不到 ${version.name} 的兼容依赖，请稍后重试`)
          await visit(dependencyVersion)
        }
      }
      await visit(versionId)
      const registryPath = safeJoin(this.instanceDirectory(instanceId), 'managed-mods.json')
      const registry: Record<string, { versionId: string; filename: string }> = Object.create(null)
      try {
        const previous = JSON.parse(await fs.readFile(registryPath, 'utf8')) as Record<string, { versionId: string; filename: string }>
        // Versions before resource providers used unqualified Modrinth project IDs.
        for (const [key, value] of Object.entries(previous)) {
          const migrated = key.includes(':') ? key : `modrinth:${key}`
          if (!(migrated in registry) || key.includes(':')) registry[migrated] = value
        }
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const filenames = new Set<string>()
      const affectedFiles = new Set<string>([registryPath])
      for (const item of plan) {
        const filename = path.basename(item.job.file)
        const canonicalFilename = filename.normalize('NFC').toLowerCase()
        const registryKey = `${source}:${item.version.project_id}`
        if (filenames.has(canonicalFilename)) throw new Error('不同模组使用了相同文件名，无法安全安装')
        filenames.add(canonicalFilename)
        if (Object.entries(registry).some(([key, value]) => key !== registryKey &&
            typeof value?.filename === 'string' && value.filename.normalize('NFC').toLowerCase() === canonicalFilename)) {
          throw new Error(`文件 ${filename} 已由其他来源或项目管理，请先移除该模组后再切换来源`)
        }
        affectedFiles.add(item.job.file)
        const previous = registry[registryKey]
        if (previous && previous.filename !== filename) {
          if (typeof previous.filename !== 'string' || previous.filename.includes('/') ||
              previous.filename.includes('\\') || !previous.filename.endsWith('.jar')) {
            throw new Error('已安装模组记录包含无效的文件名')
          }
          affectedFiles.add(safeJoin(this.instanceDirectory(instanceId), `game/mods/${previous.filename}`))
        }
        const existing = await fs.stat(item.job.file).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        })
        if (existing && await sha1File(item.job.file) !== item.job.download.sha1 &&
            registry[registryKey]?.filename !== filename) {
          throw new Error(`文件 ${filename} 已存在且不是启动器管理的此模组，请先手动移走该文件`)
        }
      }
      // Download every required artifact outside game/mods. Failures and cancellation here cannot
      // replace any installed jar or expose a new mod without its dependencies to the next launch.
      await fs.mkdir(safeJoin(staging, 'files'), { recursive: true })
      await fs.mkdir(safeJoin(staging, 'backups'), { recursive: true })
      let completed = 0
      let bytesDownloaded = 0
      for (const item of plan) {
        const filename = path.basename(item.job.file)
        await this.download({ ...item.job, file: safeJoin(staging, `files/${filename}`) }, controller.signal, bytes => { bytesDownloaded += bytes })
        completed++
        this.emit({ type: 'progress', instanceId, phase: `准备模组：${item.version.name}`, completed, total: plan.length, bytesDownloaded })
        registry[`${source}:${item.version.project_id}`] = { versionId: item.version.id, filename }
      }
      const stagedRegistry = safeJoin(staging, 'managed-mods.json')
      await fs.writeFile(stagedRegistry, JSON.stringify(registry, null, 2), { mode: 0o600 })
      controller.signal.throwIfAborted()
      await fs.mkdir(safeJoin(this.instanceDirectory(instanceId), 'game/mods'), { recursive: true })
      const backups: Array<{ original: string; backup: string }> = []
      const placed: string[] = []
      try {
        // Existing jars and the registry remain recoverable until all new files have committed.
        for (const original of affectedFiles) {
          controller.signal.throwIfAborted()
          const existing = await fs.lstat(original).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
          })
          if (!existing) continue
          if (!existing.isFile()) throw new Error(`模组安装目标不是普通文件：${path.basename(original)}`)
          const backup = safeJoin(staging, `backups/${backups.length}`)
          await this.renameFile(original, backup)
          backups.push({ original, backup })
        }
        for (const item of plan) {
          controller.signal.throwIfAborted()
          await this.renameFile(safeJoin(staging, `files/${path.basename(item.job.file)}`), item.job.file)
          placed.push(item.job.file)
        }
        controller.signal.throwIfAborted()
        await this.renameFile(stagedRegistry, registryPath)
        placed.push(registryPath)
        controller.signal.throwIfAborted()
      } catch (error) {
        const rollbackErrors: unknown[] = []
        for (const file of placed.reverse()) {
          try { await fs.rm(file, { force: true }) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        }
        for (const { original, backup } of backups.reverse()) {
          try { await this.renameFile(backup, original) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        }
        if (rollbackErrors.length) {
          keepRecoveryFiles = true
          instance.status = 'error'
          instance.error = `模组安装回滚失败，请先恢复 ${staging} 中的备份。`
          this.log(instanceId, 'error', instance.error)
          await this.save()
          throw new AggregateError([error, ...rollbackErrors], instance.error)
        }
        throw error
      }
      this.emit({ type: 'progress', instanceId, phase: '模组安装完成', completed, total: plan.length, bytesDownloaded })
      this.log(instanceId, 'info', `已安装 ${plan.length} 个模组文件（包括必要依赖）`)
      return this.snapshot()
    } finally {
      try {
        if (!keepRecoveryFiles) {
          try { await fs.rm(staging, { recursive: true, force: true }) }
          catch (error) {
            this.log(instanceId, 'warn', `临时文件清理失败：${errorMessage(error)}`)
          }
        }
      } finally { this.installs.delete(instanceId) }
    }
  }
}
