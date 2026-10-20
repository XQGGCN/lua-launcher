import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'

const execFileAsync = promisify(execFile)
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const FABRIC_URL = 'https://meta.fabricmc.net/v2'
const MODRINTH_URL = 'https://api.modrinth.com/v2'
const USER_AGENT = 'LuaLauncher/0.1.0 (+https://github.com/XQGGCN/lua-launcher)'
const NETWORK_HOSTS = new Set([
  'piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com',
  'launcher.mojang.com', 'libraries.minecraft.net', 'resources.download.minecraft.net',
  'meta.fabricmc.net', 'maven.fabricmc.net', 'api.modrinth.com', 'cdn.modrinth.com',
])

export type Loader = 'vanilla' | 'fabric'
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
}
export interface LauncherSettings {
  memoryMb: number
  javaPath: string
  concurrentDownloads: number
}
export interface LauncherSnapshot {
  instances: Instance[]
  settings: LauncherSettings
  rootDir: string
}
export type CoreEvent =
  | { type: 'state'; snapshot: LauncherSnapshot }
  | { type: 'progress'; instanceId: string; phase: string; completed: number; total: number; bytesDownloaded: number }
  | { type: 'log'; instanceId: string; level: 'info' | 'warn' | 'error'; message: string }
export interface LaunchAccount {
  mode: 'offline' | 'microsoft'
  username: string
  uuid: string
  accessToken: string
  xuid?: string
  clientId?: string
}
export interface JavaRuntime { path: string; version: string; major: number; arch: string }
export interface VersionSummary { id: string; type: string; releaseTime: string }
export interface ModrinthProject {
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
  id: string
  project_id: string
  name: string
  game_versions: string[]
  loaders: string[]
  files: Array<{ url: string; filename: string; primary: boolean; size: number; hashes: { sha1?: string; sha512?: string } }>
  dependencies: Array<{ project_id?: string; version_id?: string; dependency_type: string }>
}
interface Download { url: string; sha1?: string; size?: number; path?: string }
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
  downloads: { client: Download }
  libraries: Library[]
  arguments: { game: GameArgument[]; jvm: GameArgument[] }
  javaVersion?: { majorVersion: number }
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
}
interface ManifestIndex { versions: Array<VersionSummary & Download> }
interface CoreOptions {
  /** Dependency injection for deterministic network, process, and filesystem failure tests. */
  fetch?: typeof globalThis.fetch
  spawn?: typeof spawn
  renameFile?: typeof fs.rename
  platform?: NodeJS.Platform
  arch?: string
}
interface DownloadJob { file: string; download: Download }

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
export function offlineUuid(username: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  return hash.toString('hex')
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
function assertNetworkUrl(input: string): URL {
  const url = new URL(input)
  if (url.protocol !== 'https:' || url.username || url.password || !NETWORK_HOSTS.has(url.hostname) ||
      (url.port && url.port !== '443')) throw new Error(`不允许的下载来源：${url.hostname}`)
  return url
}
async function sha1File(file: string): Promise<string> {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export class LauncherCore {
  private instances: Instance[] = []
  private settings: LauncherSettings = { memoryMb: 4096, javaPath: '', concurrentDownloads: 8 }
  private readonly fetcher: typeof globalThis.fetch
  private readonly spawnProcess: typeof spawn
  private readonly renameFile: typeof fs.rename
  private readonly platform: NodeJS.Platform
  private readonly arch: string
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
    this.platform = options.platform ?? process.platform
    this.arch = normalizeArch(options.arch ?? process.arch)
  }

  async init(): Promise<LauncherSnapshot> {
    await fs.mkdir(this.rootDir, { recursive: true })
    try {
      const state = JSON.parse(await fs.readFile(path.join(this.rootDir, 'launcher.json'), 'utf8'))
      if (state.schema !== 1 || !Array.isArray(state.instances)) throw new Error('不支持的启动器数据格式')
      this.instances = state.instances.map((item: Instance) => {
        if (!/^[a-f0-9-]{36}$/.test(item.id) || !isSupportedVersion(item.version) ||
            !['vanilla', 'fabric'].includes(item.loader) || typeof item.name !== 'string') {
          throw new Error('实例数据损坏，请检查 launcher.json')
        }
        return { ...item, status: item.status === 'running' ? 'ready' : item.status === 'installing' ? 'not-installed' : item.status }
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

  private async save(): Promise<void> {
    const content = JSON.stringify({ schema: 1, instances: this.instances, settings: this.settings }, null, 2)
    const run = this.writes.catch(() => {}).then(async () => {
      const file = path.join(this.rootDir, 'launcher.json')
      const temporary = `${file}.${randomUUID()}.tmp`
      await fs.writeFile(temporary, content, { mode: 0o600 })
      await fs.rename(temporary, file)
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

  async createInstance(input: { name: string; version: string; loader: Loader }): Promise<Instance> {
    const name = String(input.name ?? '').trim()
    if (!name || name.length > 64) throw new Error('实例名称需要 1–64 个字符')
    if (!isSupportedVersion(input.version)) throw new Error('首版支持 Minecraft 1.20.1 及之后的正式版本')
    if (input.loader !== 'vanilla' && input.loader !== 'fabric') throw new Error('首版仅支持原版和 Fabric')
    const versions = await this.versions()
    if (!versions.some(item => item.id === input.version)) throw new Error('该 Minecraft 正式版本不存在')
    const instance: Instance = {
      id: randomUUID(), name, version: input.version, loader: input.loader,
      status: 'not-installed', createdAt: new Date().toISOString(), playtimeMs: 0,
    }
    await fs.mkdir(safeJoin(this.rootDir, `instances/${instance.id}/game`), { recursive: true })
    this.instances.push(instance)
    await this.save()
    return structuredClone(instance)
  }

  private validateSettings(input: LauncherSettings): LauncherSettings {
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
    return { memoryMb: input.memoryMb, javaPath: input.javaPath, concurrentDownloads: input.concurrentDownloads }
  }

  async updateSettings(settings: Partial<LauncherSettings>): Promise<LauncherSnapshot> {
    this.settings = this.validateSettings({ ...this.settings, ...settings })
    await this.save()
    return this.snapshot()
  }

  private async request(url: string, signal?: AbortSignal): Promise<Response> {
    assertNetworkUrl(url)
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
        assertNetworkUrl(current)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`下载失败：HTTP ${response.status}（${new URL(current).hostname}）`)
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
    if (this.manifestCache && Date.now() - this.manifestCache.at < 5 * 60_000) return this.manifestCache.value
    const value = await this.json<ManifestIndex>(MANIFEST_URL, signal)
    if (!Array.isArray(value.versions)) throw new Error('Minecraft 版本清单格式无效')
    this.manifestCache = { at: Date.now(), value }
    return value
  }
  async versions(): Promise<VersionSummary[]> {
    return (await this.manifest()).versions.filter(v => v.type === 'release' && isSupportedVersion(v.id))
      .map(({ id, type, releaseTime }) => ({ id, type, releaseTime }))
  }

  private async download(job: DownloadJob, signal: AbortSignal, onBytes: (bytes: number) => void = () => {}): Promise<void> {
    const { file, download } = job
    if (!validHash(download.sha1)) throw new Error(`缺少有效的 SHA-1 校验：${path.basename(file)}`)
    const expectedHash = download.sha1.toLowerCase()
    try {
      const stat = await fs.stat(file)
      if (stat.isFile() && (download.size === undefined || stat.size === download.size) && await sha1File(file) === expectedHash) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted()
      const temporary = `${file}.${randomUUID()}.part`
      try {
        const response = await this.request(download.url, signal)
        if (!response.body) throw new Error('服务器返回了空下载')
        const reader = response.body.getReader()
        const handle = await fs.open(temporary, 'wx', 0o600)
        let length = 0
        const hash = createHash('sha1')
        try {
          for (;;) {
            signal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            length += value.length
            if (length > (download.size ?? 512 * 1024 * 1024)) throw new Error('下载文件大小不符')
            hash.update(value)
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
        signal.throwIfAborted()
        await fs.rename(temporary, file)
        return
      } catch (error) {
        await fs.rm(temporary, { force: true })
        if (signal.aborted || attempt === 2) throw error
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
    if (this.installs.has(id)) throw new Error('该实例正在安装')
    if (this.processes.has(id) || this.launching.has(id)) throw new Error('请先关闭正在运行或启动中的游戏')
    const controller = new AbortController()
    const signal = controller.signal
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
    await this.save()
    progress('正在获取官方版本信息', true)
    try {
      const entry = (await this.manifest(signal)).versions.find(v => v.id === instance.version && v.type === 'release')
      if (!entry) throw new Error('找不到该 Minecraft 正式版本')
      const versionFile = safeJoin(this.rootDir, `versions/${sanitizeId(instance.version)}/${sanitizeId(instance.version)}.json`)
      await this.download({ file: versionFile, download: entry }, signal)
      const version: VersionManifest = JSON.parse(await fs.readFile(versionFile, 'utf8'))
      if (!version.arguments?.game || !version.arguments?.jvm || !version.downloads?.client ||
          !version.assetIndex || !Array.isArray(version.libraries)) throw new Error('该版本的启动格式暂不支持')
      let libraries = [...version.libraries]
      let mainClass = version.mainClass
      let fabricArguments: InstalledManifest['fabricArguments'] = { game: [], jvm: [] }
      if (instance.loader === 'fabric') {
        progress('正在解析 Fabric Loader', true)
        const loaders = await this.json<Array<{ loader: { version: string; stable: boolean } }>>(
          `${FABRIC_URL}/versions/loader/${encodeURIComponent(instance.version)}`, signal,
        )
        const loader = loaders.find(item => item.loader.stable)?.loader
        if (!loader) throw new Error('此 Minecraft 版本尚无稳定的 Fabric Loader')
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
      const classpath: string[] = []
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
      const installed: InstalledManifest = {
        schema: 1, version, platform: this.platform, arch: this.arch,
        classpath, mainClass, fabricArguments, loggingFile,
      }
      await fs.writeFile(safeJoin(this.instanceDirectory(id), 'installed.json'), JSON.stringify(installed, null, 2), { mode: 0o600 })
      instance.status = 'ready'
      delete instance.error
      progress('安装完成', true)
      this.log(id, 'info', `${instance.name} 安装完成（${instance.loader === 'fabric' ? `Fabric ${instance.loaderVersion}` : '原版'}）`)
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
    this.instance(id)
    this.installs.get(id)?.abort(new DOMException('安装已取消', 'AbortError'))
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

  async detectJava(): Promise<JavaRuntime[]> {
    const executable = this.platform === 'win32' ? 'java.exe' : 'java'
    const candidates = new Set<string>([this.settings.javaPath, 'java'].filter(Boolean))
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
          timeout: 8000, windowsHide: true, maxBuffer: 256 * 1024,
        })
        const output = `${stdout}\n${stderr}`
        const version = /(?:openjdk|java) version "([^"]+)"/.exec(output)?.[1] ??
          /java\.version\s*=\s*(\S+)/.exec(output)?.[1]
        if (!version) return undefined
        const major = Number(version.startsWith('1.') ? version.split('.')[1] : version.split(/[.+\-]/)[0])
        const arch = normalizeArch(/os\.arch\s*=\s*(\S+)/.exec(output)?.[1] ?? this.arch)
        const javaHome = /java\.home\s*=\s*(.+)/.exec(output)?.[1].trim()
        const resolvedPath = candidate === this.settings.javaPath && candidate !== 'java'
          ? candidate : javaHome ? path.join(javaHome, 'bin', executable) : candidate
        return { path: resolvedPath, version, major, arch }
      } catch { return undefined }
    }))
    return [...new Map(runtimes.filter((runtime): runtime is JavaRuntime => Boolean(runtime)).map(runtime => [runtime.path, runtime])).values()]
      .sort((a, b) => b.major - a.major)
  }

  async launch(id: string, account: LaunchAccount): Promise<{ pid: number | undefined }> {
    if (this.launching.has(id)) throw new Error('该实例正在启动')
    // Acquire synchronously: installed-manifest reads and Java detection both yield before spawn.
    this.launching.add(id)
    try {
      return await this.launchInstance(id, account)
    } finally {
      this.launching.delete(id)
    }
  }

  private async launchInstance(id: string, account: LaunchAccount): Promise<{ pid: number | undefined }> {
    const instance = this.instance(id)
    if (this.installs.has(id)) throw new Error('请等待安装完成')
    if (this.processes.has(id)) throw new Error('该实例已经在运行')
    if (instance.status !== 'ready') throw new Error('请先安装或修复该实例')
    if (account.mode !== 'offline' && account.mode !== 'microsoft') throw new Error('请选择微软账户或显式离线模式')
    if (!/^[A-Za-z0-9_]{3,16}$/.test(account.username)) throw new Error('游戏名称需要 3–16 个字母、数字或下划线')
    if (account.mode === 'microsoft' && (!/^[0-9a-f]{32}$/i.test(account.uuid.replace(/-/g, '')) || !account.accessToken)) {
      throw new Error('微软账户凭据无效，请重新登录')
    }
    const directory = this.instanceDirectory(id)
    const installed: InstalledManifest = JSON.parse(await fs.readFile(safeJoin(directory, 'installed.json'), 'utf8'))
    if (installed.schema !== 1 || installed.platform !== this.platform || installed.arch !== this.arch) {
      throw new Error('此实例来自其他系统或架构，请重新安装以下载正确的原生库')
    }
    const required = installed.version.javaVersion?.majorVersion ?? 17
    const runtimes = await this.detectJava()
    let runtime: JavaRuntime | undefined
    if (this.settings.javaPath) {
      runtime = runtimes.find(java => java.path === this.settings.javaPath)
      if (!runtime && this.settings.javaPath === 'java') runtime = runtimes.find(java => java.major === required && java.arch === this.arch)
    } else {
      runtime = runtimes.find(java => java.major === required && java.arch === this.arch)
    }
    if (!runtime) throw new Error(`需要 Java ${required}（${this.arch}）。请安装对应版本，并在设置中选择 Java 可执行文件。`)
    if (runtime.major !== required) throw new Error(`该版本需要 Java ${required}，当前选择的是 Java ${runtime.major}`)
    if (runtime.arch !== this.arch) throw new Error(`Java 架构 ${runtime.arch} 与启动器架构 ${this.arch} 不一致`)
    const classpath = installed.classpath.map(relative => safeJoin(this.rootDir, relative))
    for (const file of classpath) {
      try { await fs.access(file) } catch { throw new Error(`缺少游戏文件 ${path.basename(file)}，请重新安装修复`) }
    }
    const gameDir = safeJoin(directory, 'game')
    await fs.mkdir(gameDir, { recursive: true })
    const token = account.mode === 'offline' ? '0' : account.accessToken
    const variables: Record<string, string> = {
      auth_player_name: account.username,
      auth_uuid: account.mode === 'offline' ? offlineUuid(account.username) : account.uuid.replace(/-/g, ''),
      auth_access_token: token,
      auth_session: token,
      auth_xuid: account.xuid ?? '',
      clientid: account.clientId ?? '',
      version_name: instance.version,
      version_type: installed.version.type ?? 'release',
      game_directory: gameDir,
      assets_root: safeJoin(this.rootDir, 'assets'),
      assets_index_name: installed.version.assetIndex.id,
      natives_directory: safeJoin(directory, 'natives'),
      launcher_name: 'LuaLauncher',
      launcher_version: '0.1.0',
      classpath: classpath.join(this.platform === 'win32' ? ';' : ':'),
      classpath_separator: this.platform === 'win32' ? ';' : ':',
      library_directory: safeJoin(this.rootDir, 'libraries'),
      user_type: account.mode === 'microsoft' ? 'msa' : 'legacy',
      user_properties: '{}',
      resolution_width: '1280',
      resolution_height: '800',
    }
    const features = { has_custom_resolution: true }
    const jvm = resolveArguments([...installed.version.arguments.jvm, ...installed.fabricArguments.jvm], variables, this.platform, this.arch, features)
    const game = resolveArguments([...installed.version.arguments.game, ...installed.fabricArguments.game], variables, this.platform, this.arch, features)
    const args = [`-Xms512M`, `-Xmx${this.settings.memoryMb}M`, ...jvm]
    if (installed.loggingFile && installed.version.logging?.client) {
      args.push(installed.version.logging.client.argument.replace('${path}', safeJoin(this.rootDir, installed.loggingFile)))
    }
    args.push(installed.mainClass, ...game)
    this.log(id, 'info', `正在使用 Java ${runtime.version} 启动 ${instance.name}${account.mode === 'offline' ? '（离线模式）' : ''}`)
    const child = this.spawnProcess(runtime.path, args, { cwd: gameDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    this.processes.set(id, child)
    const started = Date.now()
    const scrub = (text: string) => token && token !== '0' ? text.split(token).join('[REDACTED]') : text
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

  async searchMods(query: string, options: { loader?: string; gameVersion?: string; offset?: number } = {}): Promise<ModrinthSearchResponse> {
    if (query.length > 200) throw new Error('搜索关键词过长')
    const facets = [['project_type:mod']]
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
    return this.json<ModrinthSearchResponse>(`${MODRINTH_URL}/search?${params}`)
  }

  async modVersions(projectId: string, instanceId: string): Promise<ModrinthVersion[]> {
    const instance = this.instance(instanceId)
    if (instance.loader !== 'fabric') throw new Error('请先选择一个 Fabric 实例')
    const params = new URLSearchParams({ loaders: '["fabric"]', game_versions: JSON.stringify([instance.version]) })
    return this.json<ModrinthVersion[]>(`${MODRINTH_URL}/project/${encodeURIComponent(sanitizeId(projectId))}/version?${params}`)
  }

  /** Installs required dependencies too; rejects incompatible versions instead of guessing. */
  async installMod(instanceId: string, versionId: string): Promise<LauncherSnapshot> {
    const instance = this.instance(instanceId)
    if (instance.loader !== 'fabric' || instance.status !== 'ready') throw new Error('请先安装一个 Fabric 实例，并关闭游戏')
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
        const version = await this.json<ModrinthVersion>(`${MODRINTH_URL}/version/${encodeURIComponent(sanitizeId(id))}`, controller.signal)
        if (!version.loaders.includes('fabric') || !version.game_versions.includes(instance.version)) {
          throw new Error(`模组 ${version.name} 与此 Fabric / Minecraft 版本不兼容`)
        }
        const otherVersion = projects.get(version.project_id)
        if (otherVersion && otherVersion !== version.id) throw new Error(`模组 ${version.name} 的依赖版本发生冲突`)
        projects.set(version.project_id, version.id)
        const file = version.files.find(file => file.primary) ?? version.files[0]
        if (!file || !file.filename.toLowerCase().endsWith('.jar') || file.filename.includes('/') || file.filename.includes('\\')) {
          throw new Error('模组文件格式不支持')
        }
        if (!validHash(file.hashes.sha1)) throw new Error('模组缺少 SHA-1 校验值')
        plan.push({ version, job: {
          file: safeJoin(this.instanceDirectory(instanceId), `game/mods/${file.filename}`),
          download: { url: file.url, sha1: file.hashes.sha1, size: file.size },
        } })
        for (const dependency of version.dependencies.filter(item => item.dependency_type === 'required')) {
          let dependencyVersion = dependency.version_id
          if (!dependencyVersion && dependency.project_id) {
            dependencyVersion = (await this.modVersions(dependency.project_id, instanceId))[0]?.id
          }
          if (!dependencyVersion) throw new Error(`找不到 ${version.name} 的兼容依赖，请稍后重试`)
          await visit(dependencyVersion)
        }
      }
      await visit(versionId)
      const registryPath = safeJoin(this.instanceDirectory(instanceId), 'managed-mods.json')
      const registry: Record<string, { versionId: string; filename: string }> = Object.create(null)
      try { Object.assign(registry, JSON.parse(await fs.readFile(registryPath, 'utf8'))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const filenames = new Set<string>()
      const affectedFiles = new Set<string>([registryPath])
      for (const item of plan) {
        const filename = path.basename(item.job.file)
        if (filenames.has(filename)) throw new Error('不同模组使用了相同文件名，无法安全安装')
        filenames.add(filename)
        affectedFiles.add(item.job.file)
        const previous = registry[item.version.project_id]
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
            registry[item.version.project_id]?.filename !== filename) {
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
        registry[item.version.project_id] = { versionId: item.version.id, filename }
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
