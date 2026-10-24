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
import { scanResourceInventory, type InventoryKind, type ResourceInventory } from './resource-inventory'
import { readWorldDetails, type WorldRead } from './world-details'
import { captureDatapackWorld, inventoryDatapacks, verifyDatapackWorld, inspectDatapackItem, inspectDatapackZip, type DatapackWorldProof } from './datapack-inspect'
import { datapackCompatibility } from './datapack-compatibility'
import type { DatapackMetadata, DatapackPreview, WorldDatapackInventory, WorldDatapackPreview } from './datapack-types'
import { searchDatapackCatalog, readDatapackProjectVersions } from './datapack-catalog'
import type { DatapackCatalogFile, DatapackCatalogProject, DatapackCatalogVersion, WorldDatapackSearch, WorldDatapackVersions } from './datapack-discovery-types'
import type { WorldSelection, WorldSource, WorldDetails, WorldSeed, WorldMetadata } from './world-types'
import { createWorldDirectoryBackup, listWorldDirectoryBackups, worldBackupDirectory, WorldBackupError } from './world-backup'
import type { WorldBackupTask, WorldBackupResult, WorldBackupList } from './world-backup-types'
import { createMirrorFetch, defaultDownloadSource, isDownloadSource, type DownloadSource } from './download-mirror'
import { analyzeCrash, type CrashAnalysis } from './crash-analysis'
import { readWorldMapInfo, renderRegionTile, type MapDimension, type WorldMapInfo } from './world-map'
import { inspectWorldZip, restoreWorldFromBackup, restoreWorldFromZip, safeWorldFolderName, type WorldRestoreResult, type WorldZipInspection } from './world-restore'
import { inspectWorldRestoreRecovery, WorldRestoreRecoveryError } from './world-restore-transaction'
import { isGameVersionId, javaRequirementOf, launchArguments, legacyAssetCopies, needsRosetta, type AssetIndex } from './legacy-version'
import { exportWorldBackupZip, listWorldBackupZips, verifyWorldBackupZip, worldBackupZipPath, WorldZipError } from './world-zip'
import type { WorldZipList, WorldZipResult, WorldZipSummary, WorldZipTask } from './world-zip-types'
import { installResourceZip, ResourceInstallRecoveryError, type ResourceInstallResult } from './resource-install'
import { prepareModToggle, commitModToggle, inspectModToggleRecovery, assertNoDisabledModPartners,
  ModToggleRecoveryError, ModToggleBusyError, type ModTogglePrepared, type ModToggleSelection, type ModToggleResult } from './mod-toggle'
import { assertResourceSelection, catalogSource, normalizeResourceSearch, parseResourceProject, prepareResourceVersion,
  resourceKind, resourceSearchParameters, resourceVersionsParameters, validateResourceSelection,
  type ResourceKind, type ResourceVersion, type ResourceSearchResult } from './resource-catalog'
export type { PackPreview } from './modpack'
export interface InstanceInventory extends ResourceInventory { instanceId: string }
export interface ModTogglePreview {
  token: string; instanceId: string; itemId: string; fromName: string; toName: string; enabled: boolean
  sizeBytes: number; modifiedAt: string; expiresAt: number
}

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
  /** Official servers, the BMCLAPI mirror, or automatic fallback between them. */
  downloadSource?: DownloadSource
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
  | { type: 'worldBackupTask'; task: WorldBackupTask }
  | { type: 'worldExportTask'; task: WorldZipTask }
  | { type: 'crash'; instanceId: string; analysis: CrashAnalysis }
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
  minecraftArguments?: string
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
  /** Architecture of the Java used for this version (x64 under Rosetta for old versions on Apple silicon). */
  javaArch?: string
  /** Legacy asset layout: assets copied to assets/virtual/<id> or game/resources. */
  legacyAssets?: 'virtual' | 'resources'
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
  inventoryScanner?: typeof scanResourceInventory
  resourceInstaller?: typeof installResourceZip
  modTogglePreparer?: typeof prepareModToggle
  modToggleCommitter?: typeof commitModToggle
  modToggleRecovery?: typeof inspectModToggleRecovery
  modToggleNow?: () => number
  worldDetailsReader?: typeof readWorldDetails
  worldDetailsNow?: () => number
  datapackEngine?: { capture: typeof captureDatapackWorld; inventory: typeof inventoryDatapacks; verify: typeof verifyDatapackWorld;
    item: typeof inspectDatapackItem; zip: typeof inspectDatapackZip }
  datapackCatalog?: { search: typeof searchDatapackCatalog; versions: typeof readDatapackProjectVersions }
  worldBackupCreator?: typeof createWorldDirectoryBackup
  worldBackupLister?: typeof listWorldDirectoryBackups
  worldBackupResolver?: typeof worldBackupDirectory
  worldZipExporter?: typeof exportWorldBackupZip
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
function publicDatapackMetadata(value?: DatapackMetadata): DatapackMetadata | undefined {
  if (!value) return undefined
  return structuredClone({ description: value.description, formatSummary: value.formatSummary, packFormat: value.packFormat,
    supportedFormats: value.supportedFormats, minFormat: value.minFormat, maxFormat: value.maxFormat,
    features: value.features, overlays: value.overlays, warnings: value.warnings })
}
function publicDatapackPreview(value: DatapackPreview): DatapackPreview {
  return structuredClone({ name: value.name, kind: value.kind, status: value.status, reason: value.reason,
    archiveBytes: value.archiveBytes, sha512: value.sha512, fileCount: value.fileCount,
    metadata: publicDatapackMetadata(value.metadata), warnings: value.warnings })
}
function publicDatapackCatalogProject(value: DatapackCatalogProject): DatapackCatalogProject {
  return structuredClone({ projectId: value.projectId, slug: value.slug, title: value.title, description: value.description,
    projectTypes: value.projectTypes, projectUrl: value.projectUrl })
}
function publicDatapackCatalogFile(value: DatapackCatalogFile): DatapackCatalogFile {
  return structuredClone({ filename: value.filename, primary: value.primary, role: value.role, size: value.size,
    sha512: value.sha512, sha1: value.sha1, eligible: value.eligible, reason: value.reason })
}
function publicDatapackCatalogVersion(value: DatapackCatalogVersion): DatapackCatalogVersion {
  return structuredClone({ id: value.id, projectId: value.projectId, name: value.name, versionNumber: value.versionNumber,
    datePublished: value.datePublished, releaseType: value.releaseType, gameVersions: value.gameVersions, loaders: value.loaders,
    declaresCurrentGameVersion: value.declaresCurrentGameVersion, declaresDatapack: value.declaresDatapack,
    files: value.files.map(publicDatapackCatalogFile), mainFile: value.mainFile ? publicDatapackCatalogFile(value.mainFile) : undefined,
    dependencies: value.dependencies.map(item => ({ type: item.type, projectId: item.projectId, versionId: item.versionId, filename: item.filename })),
    externalOnly: value.externalOnly, reasons: value.reasons, warnings: value.warnings })
}
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
  private readonly inventoryScanner: typeof scanResourceInventory
  private readonly resourceInstaller: typeof installResourceZip
  private readonly modTogglePreparer: typeof prepareModToggle
  private readonly modToggleCommitter: typeof commitModToggle
  private readonly modToggleRecovery: typeof inspectModToggleRecovery
  private readonly modToggleNow: () => number
  private modToggleTokens = new Map<string, { instanceId: string; generation: number; expiresAt: number; prepared: ModTogglePrepared }>()
  private mutationGeneration = new Map<string, number>()
  private modRecoveryBlocked = new Set<string>()
  private modPreparationEpoch = 0
  private readonly worldDetailsReader: typeof readWorldDetails
  private readonly worldDetailsNow: () => number
  private worldReads = new Map<string, { instanceId: string; controller: AbortController; promise: Promise<WorldRead> }>()
  private worldViews = new Map<string, { instanceId: string; source: WorldSource }>()
  private worldRevisions = new Map<string, { instanceId: string; selection: WorldSelection; source: WorldSource;
    revisionKey: string; generation: number; expiresAt: number; view: { instanceId: string; source: WorldSource } }>()
  private worldReadEpoch = 0
  private readonly datapackEngine: NonNullable<CoreOptions['datapackEngine']>
  private readonly datapackCatalog: NonNullable<CoreOptions['datapackCatalog']>
  private datapackCatalogViews = new Map<string, object>()
  private datapackReads = new Map<string, { instanceId: string; inspecting: boolean; controller: AbortController }>()
  private datapackOperationIds = new Set<string>()
  private datapackViews = new Map<string, object>()
  private datapackRevisions = new Map<string, { instanceId: string; selection: WorldSelection; proof: DatapackWorldProof;
    generation: number; epoch: number; expiresAt: number; itemIds: Set<string> }>()
  private readonly worldBackupCreator: typeof createWorldDirectoryBackup
  private readonly worldBackupLister: typeof listWorldDirectoryBackups
  private readonly worldBackupResolver: typeof worldBackupDirectory
  private worldBackupOperations = new Map<string, { operationId: string; controller: AbortController }>()
  private worldBackupHistory = new Map<string, WorldBackupTask>()
  private worldBackupOperationIds = new Set<string>()
  private readonly worldZipExporter: typeof exportWorldBackupZip
  private worldExportOperation?: { instanceId: string; operationId: string; controller: AbortController }
  private worldExportHistory = new Map<string, WorldZipTask>()
  private worldRestores = new Map<string, AbortController>()
  private worldMapTiles = new Map<string, Uint8Array>()
  private worldMapActive = 0
  private worldMapQueue: Array<() => void> = []
  private resourceDownloads = new Map<string, { operationId: string; controller: AbortController }>()
  private inventoryScans = new Map<string, { instanceId: string; controller: AbortController; promise: Promise<InstanceInventory> }>()
  private javaTasks = new Map<string, JavaRuntimeTask>()
  private javaDownloads = new Map<string, AbortController>()
  private launchControllers = new Map<string, AbortController>()
  private instanceSettingsSaving = new Set<string>()
  private installs = new Map<string, AbortController>()
  private processes = new Map<string, ChildProcess>()
  private launching = new Set<string>()
  private stopping = new Set<string>()
  private writes: Promise<void> = Promise.resolve()
  private pendingWrites = 0
  private pendingLauncherOperations = 0
  private launcherUpdateReserved = false
  private initialized = false
  private manifestCache?: { at: number; value: ManifestIndex }
  readonly rootDir: string

  constructor(rootDir: string, private readonly emit: (event: CoreEvent) => void = () => {}, options: CoreOptions = {}) {
    this.rootDir = path.resolve(rootDir)
    // Injected fetchers (tests) are used as-is; the real network goes through the optional mirror.
    this.fetcher = options.fetch ?? createMirrorFetch(globalThis.fetch, {
      source: () => this.settings.downloadSource ?? defaultDownloadSource(),
    })
    this.spawnProcess = options.spawn ?? spawn
    this.renameFile = options.renameFile ?? fs.rename
    this.stateRename = options.stateRename ?? fs.rename
    this.platform = options.platform ?? process.platform
    this.arch = normalizeArch(options.arch ?? process.arch)
    this.memorySystem = options.memorySystem ?? {}
    this.javaRuntimeManager = options.javaRuntimeManager ?? new JavaRuntimeManager(this.rootDir, { fetch: this.fetcher, probe: options.javaRuntimeProbe })
    this.inventoryScanner = options.inventoryScanner ?? scanResourceInventory
    this.resourceInstaller = options.resourceInstaller ?? installResourceZip
    this.modTogglePreparer = options.modTogglePreparer ?? prepareModToggle
    this.modToggleCommitter = options.modToggleCommitter ?? commitModToggle
    this.modToggleRecovery = options.modToggleRecovery ?? inspectModToggleRecovery
    this.modToggleNow = options.modToggleNow ?? Date.now
    this.worldDetailsReader = options.worldDetailsReader ?? readWorldDetails
    this.worldDetailsNow = options.worldDetailsNow ?? Date.now
    this.datapackEngine = options.datapackEngine ?? { capture: captureDatapackWorld, inventory: inventoryDatapacks,
      verify: verifyDatapackWorld, item: inspectDatapackItem, zip: inspectDatapackZip }
    this.datapackCatalog = options.datapackCatalog ?? { search: searchDatapackCatalog, versions: readDatapackProjectVersions }
    this.worldBackupCreator = options.worldBackupCreator ?? createWorldDirectoryBackup
    this.worldBackupLister = options.worldBackupLister ?? listWorldDirectoryBackups
    this.worldBackupResolver = options.worldBackupResolver ?? worldBackupDirectory
    this.worldZipExporter = options.worldZipExporter ?? exportWorldBackupZip
  }

  async init(): Promise<LauncherSnapshot> {
    const finish = this.beginLauncherOperation()
    try {
    await fs.mkdir(this.rootDir, { recursive: true })
    try {
      const state = JSON.parse(await fs.readFile(path.join(this.rootDir, 'launcher.json'), 'utf8'))
      if (state.schema !== 1 || !Array.isArray(state.instances)) throw new Error('不支持的启动器数据格式')
      this.instances = state.instances.map((item: Instance) => {
        if (!/^[a-f0-9-]{36}$/.test(item.id) || !isGameVersionId(item.version) ||
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
    for (const instance of this.instances) {
      try { await this.assertInstanceUsable(instance.id) }
      catch { /* Preserve the instance and its recovery evidence; expose its error below. */ }
    }
    await this.save()
    this.initialized = true
    return this.snapshot()
    } finally { finish() }
  }

  snapshot(): LauncherSnapshot {
    return structuredClone({ instances: this.instances, settings: this.settings, rootDir: this.rootDir })
  }

  /** Main holds this lease through download and installer/restart handoff. */
  reserveLauncherUpdate(): () => void {
    this.assertNoLauncherUpdate()
    if (!this.initialized || this.pendingWrites || this.pendingLauncherOperations ||
        this.installs.size || this.processes.size || this.launching.size || this.stopping.size ||
        this.launchControllers.size || this.instanceSettingsSaving.size || this.javaDownloads.size ||
        this.resourceDownloads.size || this.worldBackupOperations.size || this.worldExportOperation ||
        this.worldRestores.size || this.inventoryScans.size || this.worldReads.size || this.datapackReads.size ||
        this.worldMapActive || this.worldMapQueue.length ||
        [...this.javaTasks.values()].some(task => ['queued', 'active', 'cancelling'].includes(task.status)) ||
        [...this.worldBackupHistory.values(), ...this.worldExportHistory.values()].some(task => ['active', 'cancelling'].includes(task.status)) ||
        this.instances.some(instance => instance.status === 'running' || instance.status === 'installing')) {
      throw new Error('请先等待游戏、安装、备份、登录准备或设置保存结束，再更新启动器')
    }
    this.launcherUpdateReserved = true
    let held = true
    return () => {
      if (!held) return
      held = false
      this.launcherUpdateReserved = false
    }
  }

  private assertNoLauncherUpdate(): void {
    if (this.launcherUpdateReserved) throw new Error('启动器正在更新，请等待更新结束后再操作')
  }

  /** Covers metadata/validation waits before an operation acquires its existing file lock. */
  private beginLauncherOperation(): () => void {
    this.assertNoLauncherUpdate()
    this.pendingLauncherOperations++
    let held = true
    return () => {
      if (!held) return
      held = false
      this.pendingLauncherOperations--
    }
  }

  private async save(prepare?: () => { instances?: Instance[]; settings?: LauncherSettings; commit: () => void }): Promise<void> {
    this.assertNoLauncherUpdate()
    // Count synchronously, including time queued behind another write. A Promise's
    // existence alone cannot tell the update coordinator whether writes have settled.
    this.pendingWrites++
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
    try {
      await run
      this.emit({ type: 'state', snapshot: this.snapshot() })
    } finally { this.pendingWrites-- }
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

  async inventory(id: string, kind: InventoryKind): Promise<InstanceInventory> {
    this.instance(id)
    if (!['mods', 'resourcepacks', 'shaderpacks', 'worlds'].includes(kind)) throw new Error('无效的资源类型')
    if (this.installs.has(id)) throw new Error('此实例正在安装，请完成或取消后刷新资源清单')
    const generation = this.mutationGeneration.get(id) || 0
    const key = `${id}:${kind}`
    const active = this.inventoryScans.get(key)
    if (active) return structuredClone(await active.promise)
    if (this.inventoryScans.size >= 4) throw new Error('资源扫描任务较多，请稍后刷新')
    const controller = new AbortController()
    const scan = () => this.inventoryScanner(this.getInstancePath(id), kind, {
      signal: controller.signal,
      ...(kind === 'mods' ? { managedModsFile: safeJoin(this.instanceDirectory(id), 'managed-mods.json') } : {}),
      ...(kind === 'resourcepacks' || kind === 'shaderpacks' ? { managedResourcesFile: safeJoin(this.instanceDirectory(id), 'managed-resources.json') } : {}),
    })
    // Reserve the key/global slot before asynchronous recovery inspection, so
    // installation invalidation and shutdown also reach scans waiting at the gate.
    const pending = kind === 'worlds' ? Promise.resolve().then(async () => {
      await this.assertWorldRestoreSafe(id, controller.signal)
      if (generation !== (this.mutationGeneration.get(id) || 0) || this.installs.has(id)) throw new Error('实例已变化，请刷新世界清单')
      return scan()
    }) : scan()
    const promise = pending.then(result => {
      controller.signal.throwIfAborted()
      if (this.installs.has(id) || generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('扫描期间此实例已变化，请完成文件操作后刷新资源清单')
      return { ...result, instanceId: id }
    }).finally(() => { this.inventoryScans.delete(key) })
    this.inventoryScans.set(key, { instanceId: id, controller, promise })
    return structuredClone(await promise)
  }

  private invalidateInventory(id: string): void {
    this.invalidateModTokens(id)
    for (const scan of this.inventoryScans.values()) if (scan.instanceId === id) {
      scan.controller.abort(new DOMException('实例开始安装，原资源扫描已取消；请在安装完成后刷新', 'AbortError'))
    }
  }

  private invalidateModTokens(id: string): void {
    this.mutationGeneration.set(id, (this.mutationGeneration.get(id) || 0) + 1)
    for (const [token, value] of this.modToggleTokens) if (value.instanceId === id) this.modToggleTokens.delete(token)
    for (const [token, value] of this.worldRevisions) if (value.instanceId === id) this.worldRevisions.delete(token)
    for (const [key, value] of this.worldViews) if (value.instanceId === id) this.worldViews.delete(key)
    this.datapackViews.delete(id)
    for (const key of this.datapackCatalogViews.keys()) if (key.startsWith(`${id}:`)) this.datapackCatalogViews.delete(key)
    for (const [token, value] of this.datapackRevisions) if (value.instanceId === id) this.datapackRevisions.delete(token)
    for (const read of this.datapackReads.values()) if (read.instanceId === id) read.controller.abort(new DOMException('实例已变化', 'AbortError'))
    for (const read of this.worldReads.values()) if (read.instanceId === id) {
      read.controller.abort(new DOMException('实例状态已变化，请重新读取世界详情', 'AbortError'))
    }
  }

  /** Called synchronously before main-process credential refresh reserves a launch. */
  invalidateInstanceReads(id: string): void { this.instance(id); this.invalidateModTokens(id) }

  private assertWorldReadable(id: string): void {
    const instance = this.instance(id)
    if (this.installs.has(id) || this.launching.has(id) || this.processes.has(id) || this.instanceSettingsSaving.has(id) ||
        instance.status === 'running' || instance.status === 'installing') throw new Error('请先关闭游戏并等待此实例的文件操作或设置保存完成，再读取世界详情')
    // Error and uninstalled instances may still contain useful worlds. Never call
    // assertInstanceUsable here: its recovery cleanup would violate read-only access.
  }

  /** Read-only recovery inspection: unlike mod recovery this never changes files. */
  private async assertWorldRestoreSafe(id: string, signal?: AbortSignal): Promise<void> {
    this.instance(id)
    signal?.throwIfAborted()
    const recovery = await inspectWorldRestoreRecovery(safeJoin(this.instanceDirectory(id), '.restore-staging'), safeJoin(this.instanceDirectory(id), 'game/saves'))
    signal?.throwIfAborted()
    if (recovery.blocked) throw new WorldRestoreRecoveryError()
  }

  private worldSelection(input: unknown): WorldSelection {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 2 ||
        Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['itemId', 'name'].includes(key) ||
          !('value' in Object.getOwnPropertyDescriptor(input, key)!))) throw new Error('世界选择格式无效')
    const value = input as WorldSelection
    if (typeof value.name !== 'string' || !value.name || Buffer.byteLength(value.name) > 255 ||
        value.name === '.' || value.name === '..' || /[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff\ufffd]/u.test(value.name) ||
        /[ .]$/.test(value.name) || /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value.name) ||
        value.itemId !== 'worlds:' + createHash('sha256').update(value.name, 'utf8').digest('hex')) throw new Error('世界条目无效，请刷新清单后重新选择')
    return { itemId: value.itemId, name: value.name }
  }

  private worldBackupRoot(): string { return safeJoin(this.rootDir, 'backups/worlds') }

  private assertDatapackIdle(id: string): void {
    if ([...this.datapackReads.values()].some(read => read.instanceId === id)) throw new Error('请先完成或取消数据包预览，等待读取结束后再操作此实例')
  }

  private async withDatapackRead<T>(id: string, operationId: string, inspecting: boolean,
    work: (signal: AbortSignal, check: () => void) => Promise<T>,
    failureMessage = '数据包读取未完成，目标可能已变化、忙碌或超出读取范围；请关闭游戏后刷新重试'): Promise<T> {
    const finish = this.beginLauncherOperation()
    let read: { instanceId: string; inspecting: boolean; controller: AbortController } | undefined
    try {
      this.assertWorldReadable(id)
      if (typeof operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId) || this.datapackOperationIds.has(operationId)) throw new Error('数据包读取标识无效或已使用，请重新操作')
      if (this.datapackReads.size >= 2 || inspecting && [...this.datapackReads.values()].some(item => item.inspecting)) throw new Error('数据包读取任务较多，请等待结束后重试')
      read = { instanceId: id, inspecting, controller: new AbortController() }
      this.datapackOperationIds.add(operationId)
      while (this.datapackOperationIds.size > 256) {
        const candidate = [...this.datapackOperationIds].find(key => !this.datapackReads.has(key))
        if (!candidate) break
        this.datapackOperationIds.delete(candidate)
      }
      this.datapackReads.set(operationId, read)
      const generation = this.mutationGeneration.get(id) || 0, epoch = this.worldReadEpoch
      const controller = read.controller
      const check = () => {
        controller.signal.throwIfAborted()
        this.assertNoLauncherUpdate()
        this.assertWorldReadable(id)
        if (generation !== (this.mutationGeneration.get(id) || 0) || epoch !== this.worldReadEpoch) throw new Error('实例已变化，请刷新数据包列表')
      }
      await this.assertWorldRestoreSafe(id, controller.signal)
      check()
      const result = await work(controller.signal, check)
      check()
      return structuredClone(result)
    } catch (error) {
      if (read?.controller.signal.aborted || error instanceof Error && error.name === 'AbortError') throw new DOMException('数据包读取已取消，请刷新后重试', 'AbortError')
      // Do not serialize OS errors with native selected paths over IPC.
      throw new Error(failureMessage)
    } finally {
      if (read && this.datapackReads.get(operationId) === read) this.datapackReads.delete(operationId)
      finish()
    }
  }

  cancelDatapackRead(id: string, operationId: string): void {
    this.instance(id)
    const read = this.datapackReads.get(operationId)
    if (read?.instanceId === id) read.controller.abort(new DOMException('数据包读取已取消', 'AbortError'))
  }

  async worldDatapacks(id: string, input: unknown, operationId: string): Promise<WorldDatapackInventory> {
    this.assertNoLauncherUpdate()
    this.assertWorldReadable(id)
    const selection = this.worldSelection(input)
    const view = {}
    // This view changes before any await, invalidating earlier reads of this instance.
    this.datapackViews.set(id, view)
    for (const key of this.datapackCatalogViews.keys()) if (key.startsWith(`${id}:`)) this.datapackCatalogViews.delete(key)
    for (const [key, value] of this.datapackRevisions) if (value.instanceId === id) this.datapackRevisions.delete(key)
    return this.withDatapackRead(id, operationId, false, async (signal, check) => {
      const proof = await this.datapackEngine.capture(this.instanceDirectory(id), selection, { signal })
      const result = await this.datapackEngine.inventory(proof, { signal })
      await this.datapackEngine.verify(proof, { signal })
      check()
      if (this.datapackViews.get(id) !== view) throw new Error('世界选择已变化')
      const revision = randomUUID()
      this.datapackRevisions.set(revision, { instanceId: id, selection, proof, generation: this.mutationGeneration.get(id) || 0,
        epoch: this.worldReadEpoch, expiresAt: this.worldDetailsNow() + 120_000, itemIds: new Set(result.items.map(item => item.itemId)) })
      while (this.datapackRevisions.size > 32) this.datapackRevisions.delete(this.datapackRevisions.keys().next().value!)
      return { observedAt: result.observedAt, directoryPresent: result.directoryPresent, truncated: result.truncated,
        warnings: [...result.warnings], items: result.items.map(item => ({ itemId: item.itemId, name: item.name, kind: item.kind,
          modifiedAt: item.modifiedAt, sizeBytes: item.sizeBytes, activation: item.activation, warnings: [...item.warnings],
          metadata: publicDatapackMetadata(item.metadata) })), instanceId: id, world: selection, revision }
    })
  }

  private datapackRevision(id: string, revision: string) {
    const value = this.datapackRevisions.get(revision)
    if (!value || value.instanceId !== id || value.expiresAt <= this.worldDetailsNow() || value.epoch !== this.worldReadEpoch ||
        value.generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('数据包列表已过期，请刷新后重新选择')
    return value
  }

  private async datapackPreview(id: string, revision: string, operationId: string,
    inspect: (view: ReturnType<LauncherCore['datapackRevision']>, signal: AbortSignal) => Promise<DatapackPreview | null>): Promise<WorldDatapackPreview | null> {
    return this.withDatapackRead(id, operationId, true, async (signal, check) => {
      const view = this.datapackRevision(id, revision)
      await this.datapackEngine.verify(view.proof, { signal })
      const result = await inspect(view, signal)
      signal.throwIfAborted()
      if (!result) return null
      // Saved-world format is assessed separately. A missing/unsupported NBT field
      // stays unknown, and never falls back to the instance version or old copy.
      let worldVersion: string | undefined
      try { worldVersion = (await this.readSelectedWorld(id, view.selection, 'level.dat', false)).details.metadata.savedVersionName }
      catch { signal.throwIfAborted() }
      await this.datapackEngine.verify(view.proof, { signal })
      check()
      if (this.datapackRevision(id, revision) !== view) throw new Error('数据包列表已变化')
      return { ...publicDatapackPreview(result), instanceId: id, world: view.selection, revision, previewId: randomUUID(),
        instanceCompatibility: datapackCompatibility(result.metadata, this.instance(id).version, result.status),
        worldCompatibility: datapackCompatibility(result.metadata, worldVersion, result.status) }
    })
  }

  async inspectWorldDatapack(id: string, revision: string, itemId: string, operationId: string): Promise<WorldDatapackPreview> {
    return (await this.datapackPreview(id, revision, operationId, (view, signal) => {
      if (!view.itemIds.has(itemId)) throw new Error('数据包条目不属于当前列表')
      return this.datapackEngine.item(view.proof, itemId, { signal })
    }))!
  }

  /** Main-only picker callback; neither absolute path nor callable comes from IPC. */
  async previewLocalDatapack(id: string, revision: string, operationId: string,
    chooseFile: () => Promise<string | undefined>): Promise<WorldDatapackPreview | null> {
    return this.datapackPreview(id, revision, operationId, async (view, signal) => {
      const file = await chooseFile()
      signal.throwIfAborted()
      await this.datapackEngine.verify(view.proof, { signal })
      return file ? this.datapackEngine.zip(file, { signal }) : null
    })
  }

  private async queryDatapackCatalog<T>(id: string, revision: string, operationId: string, kind: 'search' | 'versions',
    query: (gameVersion: string, signal: AbortSignal) => Promise<T>): Promise<{ value: T; world: WorldSelection; gameVersion: string }> {
    this.assertNoLauncherUpdate()
    this.assertWorldReadable(id)
    const view = this.datapackRevision(id, revision)
    const key = `${id}:${revision}:${kind}`, ticket = {}
    // Allocate before any await: a slow earlier request cannot become the current view.
    this.datapackCatalogViews.set(key, ticket)
    if (kind === 'search') this.datapackCatalogViews.delete(`${id}:${revision}:versions`)
    while (this.datapackCatalogViews.size > 64) this.datapackCatalogViews.delete(this.datapackCatalogViews.keys().next().value!)
    return this.withDatapackRead(id, operationId, false, async (signal, check) => {
      const gameVersion = this.instance(id).version
      await this.datapackEngine.verify(view.proof, { signal })
      check()
      if (this.datapackRevision(id, revision) !== view || this.datapackCatalogViews.get(key) !== ticket) throw new Error('站点查询已被更新的请求取代')
      const value = await query(gameVersion, signal)
      await this.datapackEngine.verify(view.proof, { signal })
      check()
      if (this.datapackRevision(id, revision) !== view || this.datapackCatalogViews.get(key) !== ticket || this.instance(id).version !== gameVersion) throw new Error('世界或查询已变化')
      return { value, world: view.selection, gameVersion }
    }, '数据包站点查询未完成，请检查网络并重试；世界或列表变化、过期时请先刷新世界列表')
  }

  async searchDatapacks(id: string, revision: string, input: unknown, operationId: string): Promise<WorldDatapackSearch> {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key =>
          typeof key !== 'string' || !['query', 'offset'].includes(key) || !('value' in Object.getOwnPropertyDescriptor(input, key)!))) throw new Error('数据包搜索参数无效')
    const raw = input as { query?: unknown; offset?: unknown }
    if (typeof raw.query !== 'string' || raw.query.length > 200 || /[\u0000-\u001f\u007f]/u.test(raw.query) ||
        raw.offset !== undefined && (!Number.isSafeInteger(raw.offset) || Number(raw.offset) < 0 || Number(raw.offset) > 100000)) throw new Error('数据包搜索参数无效')
    const query = raw.query, offset = raw.offset === undefined ? 0 : Number(raw.offset)
    const { value, world, gameVersion } = await this.queryDatapackCatalog(id, revision, operationId, 'search', (gameVersion, signal) =>
      this.datapackCatalog.search(query, { gameVersion, offset, signal, fetch: this.fetcher, userAgent: USER_AGENT }))
    return { instanceId: id, revision, world, gameVersion, totalHits: value.totalHits, offset: value.offset, limit: value.limit,
      omittedHits: value.omittedHits, hits: value.hits.map(item => ({ projectId: item.projectId, slug: item.slug, title: item.title,
        description: item.description, author: item.author, downloads: item.downloads, projectTypes: [...item.projectTypes], projectUrl: item.projectUrl })) }
  }

  async datapackProjectVersions(id: string, revision: string, projectId: string, operationId: string): Promise<WorldDatapackVersions> {
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new Error('数据包项目标识无效')
    const { value, world, gameVersion } = await this.queryDatapackCatalog(id, revision, operationId, 'versions', (gameVersion, signal) =>
      this.datapackCatalog.versions(projectId, { gameVersion, signal, fetch: this.fetcher, userAgent: USER_AGENT }))
    return { instanceId: id, revision, world, gameVersion, project: publicDatapackCatalogProject(value.project),
      versions: value.versions.map(publicDatapackCatalogVersion), upstreamVersionCount: value.upstreamVersionCount, omittedVersions: value.omittedVersions }
  }

  worldBackupTasks(): WorldBackupTask[] { return structuredClone([...this.worldBackupHistory.values()]) }

  private publishWorldBackupTask(task: WorldBackupTask): void {
    // Observers cannot change whether bytes have committed or release the lock.
    try { this.emit({ type: 'worldBackupTask', task: structuredClone(task) }) } catch { /* Task history remains queryable. */ }
  }

  async backupWorld(id: string, input: unknown, options: unknown): Promise<WorldBackupResult> {
    this.assertNoLauncherUpdate()
    this.assertDatapackIdle(id)
    this.assertWorldReadable(id)
    const selection = this.worldSelection(input)
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Reflect.ownKeys(options).length !== 2 ||
        Reflect.ownKeys(options).some(key => typeof key !== 'string' || !['closedExternalWorldConfirmed', 'operationId'].includes(key) ||
          !('value' in Object.getOwnPropertyDescriptor(options, key)!))) throw new Error('备份选项无效')
    const value = options as { closedExternalWorldConfirmed: unknown; operationId: unknown }
    if (value.closedExternalWorldConfirmed !== true) throw new Error('请先关闭所有正在使用此世界的游戏或服务端，并确认后再备份')
    const operationId = value.operationId
    if (typeof operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)) throw new Error('备份任务标识无效')
    if (this.worldBackupOperationIds.has(operationId)) throw new Error('此备份任务已提交，请查看原任务，不要重复创建')
    if (this.worldBackupOperations.size) throw new Error('已有世界备份正在进行，请等待完成或取消后再试')
    if (this.worldBackupOperationIds.size >= 4096) throw new Error('本次会话备份记录较多，请重启启动器后再创建备份')
    const controller = new AbortController()
    const task: WorldBackupTask = { id: operationId, instanceId: id, worldItemId: selection.itemId, worldFolderName: selection.name,
      startedAt: new Date().toISOString(), status: 'active', progress: { phase: 'scan', filesDone: 0, bytesDone: 0 } }
    // Reuse the established per-instance file lock before the first await. This
    // also blocks launch credentials in main through assertLaunchAvailable.
    this.installs.set(id, controller)
    this.worldBackupOperations.set(id, { operationId, controller })
    this.worldBackupOperationIds.add(operationId)
    while (this.worldBackupHistory.size >= 30) {
      const oldest = [...this.worldBackupHistory].find(([, item]) => !['active', 'cancelling'].includes(item.status))
      if (!oldest) break
      this.worldBackupHistory.delete(oldest[0])
    }
    this.worldBackupHistory.set(operationId, task)
    this.invalidateInventory(id)
    this.publishWorldBackupTask(task)
    try {
      // Do not call mod recovery here: a backup must never repair/delete source
      // files, including an unrelated marker in an error instance.
      await this.assertWorldRestoreSafe(id, controller.signal)
      const result = await this.worldBackupCreator(this.instanceDirectory(id), selection, {
        backupRoot: this.worldBackupRoot(), instanceId: id, operationId, signal: controller.signal,
        onProgress: progress => {
          if (this.worldBackupOperations.get(id)?.operationId !== operationId) return
          task.progress = structuredClone(progress)
          this.publishWorldBackupTask(task)
        },
      })
      // The completed marker is the module's boundary. A late abort or observer
      // failure must never turn a committed backup into a cancelled task.
      task.status = 'complete'; task.result = structuredClone(result)
      return structuredClone(result)
    } catch (error) {
      if (error instanceof WorldRestoreRecoveryError) {
        task.status = 'error'; task.error = error.message
        throw error
      }
      const code = error instanceof WorldBackupError ? error.code : ''
      if (controller.signal.aborted && code !== 'RECOVERY_REQUIRED') {
        task.status = 'cancelled'
        task.error = '备份已取消；已创建的未完成资料会保留，源世界不变'
      } else {
        task.status = 'error'
        const messages: Record<string, string> = {
          SOURCE_CHANGED: '世界内容在备份期间发生变化，请关闭所有相关游戏或服务端后重试',
          UNSAFE_PATH: '世界或备份目录不符合安全条件，请检查路径与链接',
          NAME_COLLISION: '文件名存在大小写或 Unicode 冲突，无法完整备份',
          UNSUPPORTED_ENTRY: '世界包含不支持的链接、特殊文件或挂载项，未创建完整备份',
          LIMIT_EXCEEDED: '世界超过当前备份的大小、数量、路径或时间预算',
          INSUFFICIENT_SPACE: '备份磁盘可用空间不足，请释放空间后重试',
          RECOVERY_REQUIRED: '备份资料需要人工检查，已保留未完成目录，源世界不变',
        }
        task.error = messages[code] || '备份未完成，源世界不变；已创建的未完成资料会保留，请检查磁盘和权限后重试'
      }
      throw new Error(task.error)
    } finally {
      task.finishedAt = new Date().toISOString()
      this.invalidateInventory(id)
      if (this.worldBackupOperations.get(id)?.operationId === operationId) this.worldBackupOperations.delete(id)
      if (this.installs.get(id) === controller) this.installs.delete(id)
      this.publishWorldBackupTask(task)
    }
  }

  cancelWorldBackup(id: string, operationId: string): void {
    this.instance(id)
    const active = this.worldBackupOperations.get(id)
    if (!active || active.operationId !== operationId) return
    const task = this.worldBackupHistory.get(operationId)
    if (task && task.status === 'active') { task.status = 'cancelling'; this.publishWorldBackupTask(task) }
    active.controller.abort(new DOMException('世界备份已取消', 'AbortError'))
  }

  async worldBackups(id: string): Promise<WorldBackupList> {
    this.instance(id)
    try { return structuredClone(await this.worldBackupLister(this.worldBackupRoot(), id)) }
    catch { throw new Error('无法读取此实例的备份记录，请检查备份目录与权限') }
  }

  /** Main-only path for shell.openPath; never expose this as a renderer path API. */
  async worldBackupPath(id: string, backupId: string): Promise<string> {
    this.instance(id)
    if (typeof backupId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(backupId)) throw new Error('备份标识无效')
    try { return await this.worldBackupResolver(this.worldBackupRoot(), id, backupId) }
    catch { throw new Error('该备份尚未完成、记录已变化或目录无法安全打开，请刷新备份列表') }
  }

  private worldExportRoot(): string { return safeJoin(this.rootDir, 'world-exports') }

  worldExportTasks(): WorldZipTask[] { return structuredClone([...this.worldExportHistory.values()]) }

  private publishWorldExportTask(task: WorldZipTask): void {
    try { this.emit({ type: 'worldExportTask', task: structuredClone(task) }) } catch { /* Task history remains queryable. */ }
  }

  /** Exports a completed directory backup as a verified ZIP. Reads only the backup, never the live world. */
  async exportWorldBackup(id: string, backupId: string, operationId: string): Promise<WorldZipResult> {
    this.assertNoLauncherUpdate()
    this.assertDatapackIdle(id)
    this.instance(id)
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
    if (typeof backupId !== 'string' || !uuid.test(backupId)) throw new Error('备份标识无效')
    if (typeof operationId !== 'string' || !uuid.test(operationId)) throw new Error('导出任务标识无效')
    if (this.worldExportHistory.has(operationId)) throw new Error('此导出任务已提交，请查看原任务')
    if (this.worldExportOperation) throw new Error('已有 ZIP 导出正在进行，请等待完成或取消后再试')
    const controller = new AbortController()
    const task: WorldZipTask = { id: operationId, instanceId: id, backupId, worldFolderName: '', startedAt: new Date().toISOString(),
      status: 'active', progress: { phase: 'validate-backup', filesDone: 0, bytesDone: 0 } }
    // Reserve the single export slot before the first await.
    this.worldExportOperation = { instanceId: id, operationId, controller }
    while (this.worldExportHistory.size >= 30) {
      const oldest = [...this.worldExportHistory].find(([, item]) => !['active', 'cancelling'].includes(item.status))
      if (!oldest) break
      this.worldExportHistory.delete(oldest[0])
    }
    this.worldExportHistory.set(operationId, task)
    this.publishWorldExportTask(task)
    try {
      try { task.worldFolderName = (await this.worldBackupLister(this.worldBackupRoot(), id)).items.find(item => item.backupId === backupId)?.worldFolderName || '' }
      catch { /* The exporter validates the backup itself. */ }
      const result = await this.worldZipExporter(this.worldBackupRoot(), id, backupId, {
        exportRoot: this.worldExportRoot(), operationId, signal: controller.signal,
        onProgress: progress => {
          if (this.worldExportOperation?.operationId !== operationId) return
          task.progress = structuredClone(progress)
          this.publishWorldExportTask(task)
        },
      })
      task.status = 'complete'; task.result = structuredClone(result); task.worldFolderName = result.worldFolderName
      return structuredClone(result)
    } catch (error) {
      if (controller.signal.aborted) {
        task.status = 'cancelled'; task.error = '导出已取消，未完成的 ZIP 已移除，备份不变'
      } else {
        task.status = 'error'
        task.error = error instanceof WorldZipError ? `${error.message}。原备份不受影响` : 'ZIP 导出未完成，原备份不受影响，请检查磁盘空间和权限后重试'
      }
      throw new Error(task.error)
    } finally {
      task.finishedAt = new Date().toISOString()
      if (this.worldExportOperation?.operationId === operationId) this.worldExportOperation = undefined
      this.publishWorldExportTask(task)
    }
  }

  cancelWorldExport(id: string, operationId: string): void {
    this.instance(id)
    const active = this.worldExportOperation
    if (!active || active.instanceId !== id || active.operationId !== operationId) return
    const task = this.worldExportHistory.get(operationId)
    if (task && task.status === 'active') { task.status = 'cancelling'; this.publishWorldExportTask(task) }
    active.controller.abort(new DOMException('ZIP 导出已取消', 'AbortError'))
  }

  async worldExports(id: string): Promise<WorldZipList> {
    this.instance(id)
    try { return structuredClone(await listWorldBackupZips(this.worldExportRoot(), id)) }
    catch { throw new Error('无法读取此实例的 ZIP 导出记录，请检查目录权限') }
  }

  /** Main-only path for shell.showItemInFolder; never exposed to the renderer. */
  async worldExportPath(id: string, exportId: string): Promise<string> {
    this.instance(id)
    try { return await worldBackupZipPath(this.worldExportRoot(), id, exportId) }
    catch { throw new Error('此 ZIP 导出记录无效或文件已被移动，请刷新列表') }
  }

  async verifyWorldExport(id: string, exportId: string): Promise<WorldZipSummary> {
    this.instance(id)
    try { return await verifyWorldBackupZip(this.worldExportRoot(), id, exportId) }
    catch (error) { throw new Error(error instanceof WorldZipError ? error.message : '无法重新校验此 ZIP，请检查文件是否仍在原位置') }
  }

  private worldFolder(id: string, input: unknown): string {
    this.instance(id)
    const selection = this.worldSelection(input)
    return safeJoin(this.instanceDirectory(id), `game/saves/${selection.name}`)
  }

  /** Spawn point, player position and region lists for the read-only map preview. */
  async worldMap(id: string, input: unknown): Promise<WorldMapInfo> {
    this.assertWorldReadable(id)
    const generation = this.mutationGeneration.get(id) || 0
    await this.assertWorldRestoreSafe(id)
    this.assertWorldReadable(id)
    if (generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('实例已变化，请刷新地图')
    const folder = this.worldFolder(id, input)
    try { if (!(await fs.lstat(folder)).isDirectory()) throw new Error() } catch { throw new Error('找不到这个世界，请刷新列表') }
    const result = await readWorldMapInfo(folder)
    this.assertWorldReadable(id)
    if (generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('实例已变化，请刷新地图')
    return result
  }

  /** One 512×512 PNG tile. At most two regions render at a time; recent tiles are cached. */
  async worldMapTile(id: string, input: unknown, dimension: unknown, x: unknown, z: unknown): Promise<Uint8Array> {
    this.assertWorldReadable(id)
    const generation = this.mutationGeneration.get(id) || 0
    await this.assertWorldRestoreSafe(id)
    this.assertWorldReadable(id)
    if (generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('实例已变化，请刷新地图')
    if (dimension !== 'overworld' && dimension !== 'nether' && dimension !== 'end') throw new Error('维度无效')
    if (!Number.isInteger(x) || !Number.isInteger(z)) throw new Error('区域坐标无效')
    const folder = this.worldFolder(id, input)
    const regionFile = await (async () => {
      for (const relative of dimension === 'overworld' ? ['region', 'dimensions/minecraft/overworld/region'] : dimension === 'nether' ? ['DIM-1/region', 'dimensions/minecraft/the_nether/region'] : ['DIM1/region', 'dimensions/minecraft/the_end/region']) {
        try { const info = await fs.stat(path.join(folder, ...relative.split('/'), `r.${x}.${z}.mca`)); return `${relative}:${info.size}:${info.mtimeMs}` } catch { /* next */ }
      }
      return 'missing'
    })()
    this.assertWorldReadable(id)
    if (generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('实例已变化，请刷新地图')
    const key = JSON.stringify([folder, dimension, x, z, regionFile])
    const cached = this.worldMapTiles.get(key)
    if (cached) { this.worldMapTiles.delete(key); this.worldMapTiles.set(key, cached); return cached }
    if (this.worldMapActive >= 2) await new Promise<void>(resolve => this.worldMapQueue.push(resolve))
    this.worldMapActive++
    try {
      this.assertWorldReadable(id)
      if (generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('实例已变化，请刷新地图')
      const tile = await renderRegionTile(folder, dimension as MapDimension, x as number, z as number)
      this.assertWorldReadable(id)
      if (generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('实例已变化，请刷新地图')
      this.worldMapTiles.set(key, tile.png)
      while (this.worldMapTiles.size > 64) this.worldMapTiles.delete(this.worldMapTiles.keys().next().value!)
      return tile.png
    } finally {
      this.worldMapActive--
      this.worldMapQueue.shift()?.()
    }
  }

  private async runWorldRestore(id: string, operation: (options: { saves: string; staging: string; signal: AbortSignal; onProgress: (progress: { phase: string; filesDone: number; filesTotal?: number; bytesDone: number; bytesTotal?: number }) => void }) => Promise<WorldRestoreResult>): Promise<WorldRestoreResult> {
    this.assertNoLauncherUpdate()
    this.assertDatapackIdle(id)
    const instance = this.instance(id)
    if (this.installs.has(id)) throw new Error('此实例正在安装、备份或恢复，请稍后再试')
    if (this.processes.has(id) || this.launching.has(id) || instance.status === 'running') throw new Error('请先关闭此实例的游戏，再恢复或导入世界')
    if (this.instanceSettingsSaving.has(id)) throw new Error('请等待此实例的设置保存完成')
    const controller = new AbortController()
    this.installs.set(id, controller)
    this.worldRestores.set(id, controller)
    this.invalidateInventory(id)
    const phases: Record<string, string> = { scan: '正在检查世界文件', copy: '正在恢复世界文件', commit: '正在完成恢复' }
    try {
      await this.assertInstanceUsable(id, controller.signal)
      const result = await operation({
        saves: safeJoin(this.instanceDirectory(id), 'game/saves'), staging: safeJoin(this.instanceDirectory(id), '.restore-staging'), signal: controller.signal,
        onProgress: progress => this.emit({ type: 'progress', instanceId: id, phase: phases[progress.phase] ?? '正在恢复世界', completed: progress.bytesDone, total: progress.bytesTotal ?? 0, bytesDownloaded: progress.bytesDone, unit: 'bytes' }),
      })
      this.log(id, 'info', `世界已恢复为 saves/${result.folderName}（${result.fileCount} 个文件）`)
      return result
    } catch (error) {
      const recovery = await inspectWorldRestoreRecovery(safeJoin(this.instanceDirectory(id), '.restore-staging'), safeJoin(this.instanceDirectory(id), 'game/saves'))
      if (recovery.blocked) {
        instance.status = 'error'
        instance.error = new WorldRestoreRecoveryError().message
      }
      if (error instanceof WorldRestoreRecoveryError) throw error
      if (controller.signal.aborted) throw new Error('世界恢复已取消；暂存和可能创建的新目录已保留，请检查 .restore-staging 后重启；原世界未被替换')
      if (error instanceof Error && error.name === 'WorldRestoreError') throw new Error(error.message)
      throw new Error('世界恢复未完成；已保留暂存和可能创建的新目录，请检查 .restore-staging、磁盘空间与权限后重启；原世界未被替换')
    } finally {
      if (this.installs.get(id) === controller) this.installs.delete(id)
      this.worldRestores.delete(id)
      this.invalidateInventory(id)
      this.emit({ type: 'state', snapshot: this.snapshot() })
    }
  }

  /** Restores a completed backup (from any instance) as a new world in `targetId`. Never overwrites. */
  async restoreWorldBackup(targetId: string, sourceInstanceId: string, backupId: string, folderName?: string): Promise<WorldRestoreResult> {
    const finish = this.beginLauncherOperation()
    try {
    this.instance(sourceInstanceId)
    if (folderName !== undefined && !safeWorldFolderName(folderName)) throw new Error('世界名称不能包含特殊字符，也不能以点开头')
    const directory = await this.worldBackupPath(sourceInstanceId, backupId)
    return await this.runWorldRestore(targetId, options => restoreWorldFromBackup(directory, { ...options, folderName }))
    } finally { finish() }
  }

  /** Main-process only: `file` comes from a native file dialog, never from the renderer. */
  async inspectWorldZip(file: string): Promise<WorldZipInspection> { return inspectWorldZip(file) }

  async importWorldZip(targetId: string, file: string, folderName?: string): Promise<WorldRestoreResult> {
    if (folderName !== undefined && !safeWorldFolderName(folderName)) throw new Error('世界名称不能包含特殊字符，也不能以点开头')
    return this.runWorldRestore(targetId, options => restoreWorldFromZip(file, { ...options, folderName }))
  }

  cancelWorldRestore(id: string): void {
    this.instance(id)
    this.worldRestores.get(id)?.abort(new DOMException('世界恢复已取消', 'AbortError'))
  }

  private async readSelectedWorld(id: string, selection: WorldSelection, source: WorldSource, includeSeed: boolean): Promise<WorldRead> {
    this.assertWorldReadable(id)
    const key = JSON.stringify([id, selection.itemId, source, includeSeed])
    const active = this.worldReads.get(key)
    if (active) return structuredClone(await active.promise)
    if (this.worldReads.size >= 2) throw new Error('世界详情读取任务较多，请稍后重试')
    const generation = this.mutationGeneration.get(id) || 0, epoch = this.worldReadEpoch
    const controller = new AbortController()
    const promise = Promise.resolve().then(async () => {
      await this.assertWorldRestoreSafe(id, controller.signal)
      this.assertWorldReadable(id)
      if (epoch !== this.worldReadEpoch || generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('实例已变化，请重新读取世界详情')
      return this.worldDetailsReader(this.instanceDirectory(id), selection, { source, signal: controller.signal, includeSeed })
    })
      .then(result => {
        controller.signal.throwIfAborted()
        if (epoch !== this.worldReadEpoch || generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('实例已变化，请重新读取世界详情')
        this.assertWorldReadable(id)
        return result
      }).catch(error => {
        if (controller.signal.aborted) throw new DOMException('世界详情读取已取消，请刷新后重试', 'AbortError')
        // Format/path problems are structured results. Unexpected filesystem
        // exceptions must never expose absolute paths or raw NBT values over IPC.
        if (error instanceof Error && error.message === '实例已变化，请重新读取世界详情') throw error
        throw new Error('世界详情读取未完成，请关闭游戏后刷新重试')
      }).finally(() => { if (this.worldReads.get(key)?.promise === promise) this.worldReads.delete(key) })
    this.worldReads.set(key, { instanceId: id, controller, promise })
    return structuredClone(await promise)
  }

  async worldDetails(id: string, input: unknown, options: { source?: WorldSource } = {}): Promise<WorldDetails> {
    this.assertWorldReadable(id)
    const selection = this.worldSelection(input)
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Reflect.ownKeys(options).some(key =>
          key !== 'source' || !('value' in Object.getOwnPropertyDescriptor(options, key)!))) throw new Error('世界详情读取选项无效')
    const source = options.source ?? 'level.dat'
    if (source !== 'level.dat' && source !== 'level.dat_old') throw new Error('世界元数据来源无效')
    const generation = this.mutationGeneration.get(id) || 0, epoch = this.worldReadEpoch
    const viewKey = JSON.stringify([id, selection.itemId])
    const readKey = JSON.stringify([id, selection.itemId, source, false])
    let view = this.worldViews.get(viewKey)
    // Same pending request shares a view. A refresh or source change creates a
    // new view, so an older completion cannot issue a new reveal capability.
    if (!view || view.source !== source || !this.worldReads.has(readKey)) {
      view = { instanceId: id, source }
      this.worldViews.delete(viewKey)
      if (this.worldViews.size >= 64) this.worldViews.delete(this.worldViews.keys().next().value!)
      this.worldViews.set(viewKey, view)
    }
    // A fresh read/source selection invalidates earlier views of this world.
    for (const [token, value] of this.worldRevisions) if (value.instanceId === id && value.selection.itemId === selection.itemId) this.worldRevisions.delete(token)
    const result = await this.readSelectedWorld(id, selection, source, false)
    if (epoch !== this.worldReadEpoch || generation !== (this.mutationGeneration.get(id) || 0) ||
        this.worldViews.get(viewKey) !== view) throw new Error('世界详情来源或实例已变化，请重新读取')
    this.assertWorldReadable(id)
    const data = result.details
    const metadata: WorldMetadata = {}
    for (const key of ['levelName', 'savedVersionName', 'dataVersion', 'versionId', 'snapshot', 'gameMode', 'difficulty',
      'hardcore', 'allowCommands', 'timeTicks', 'dayTimeTicks', 'lastPlayed'] as const) {
      if (Object.hasOwn(data.metadata, key)) Object.assign(metadata, { [key]: structuredClone(data.metadata[key]) })
    }
    // Explicit projection is the boundary: no seed, private revisionKey, paths,
    // or unrequested NBT fields can arrive through a spread of the module result.
    const dto: WorldDetails = { instanceId: id, itemId: selection.itemId, folderName: selection.name, source,
      observedAt: data.observedAt, status: data.status, ...(data.reasonCode ? { reasonCode: data.reasonCode } : {}),
      ...(data.file ? { file: { sizeBytes: data.file.sizeBytes, modifiedAt: data.file.modifiedAt } } : {}),
      metadata, fieldWarnings: data.fieldWarnings.map(value => ({ field: value.field, code: value.code })),
      warnings: [...data.warnings], seedAvailable: data.seedAvailable }
    if (data.status !== 'unavailable' && result.revisionKey) {
      const now = this.worldDetailsNow()
      for (const [token, value] of this.worldRevisions) if (value.expiresAt <= now) this.worldRevisions.delete(token)
      if (this.worldRevisions.size >= 32) this.worldRevisions.delete(this.worldRevisions.keys().next().value!)
      const revision = randomUUID()
      this.worldRevisions.set(revision, { instanceId: id, selection, source, revisionKey: result.revisionKey,
        generation, expiresAt: now + 120_000, view })
      dto.revision = revision
    }
    return dto
  }

  async worldDetailsWithSeed(id: string, revision: string): Promise<WorldSeed> {
    this.assertWorldReadable(id)
    const view = this.worldRevisions.get(revision)
    if (!view || view.instanceId !== id || view.expiresAt <= this.worldDetailsNow() ||
        view.generation !== (this.mutationGeneration.get(id) || 0) ||
        this.worldViews.get(JSON.stringify([id, view.selection.itemId])) !== view.view) throw new Error('世界详情已过期，请先刷新详情再查看种子')
    const result = await this.readSelectedWorld(id, view.selection, view.source, true)
    if (this.worldRevisions.get(revision) !== view || this.worldViews.get(JSON.stringify([id, view.selection.itemId])) !== view.view || view.expiresAt <= this.worldDetailsNow() ||
        view.generation !== (this.mutationGeneration.get(id) || 0) || result.details.status === 'unavailable' ||
        result.revisionKey !== view.revisionKey) {
      this.worldRevisions.delete(revision)
      throw new Error('世界文件已变化或详情已过期，请刷新详情后重试')
    }
    const seed = result.seed
    if (seed !== undefined && (typeof seed !== 'string' || !/^-?\d{1,20}$/.test(seed) ||
        BigInt(seed) < -(1n << 63n) || BigInt(seed) > (1n << 63n) - 1n)) throw new Error('世界种子格式无效，请刷新详情后重试')
    return { instanceId: id, itemId: view.selection.itemId, source: view.source, revision,
      observedAt: result.details.observedAt, available: seed !== undefined, ...(seed === undefined ? {} : { seed }) }
  }

  /** Recovery evidence is checked independently of launcher.json's retryable status. */
  async assertInstanceUsable(id: string, signal?: AbortSignal): Promise<void> {
    const finish = this.beginLauncherOperation()
    try {
    const instance = this.instance(id)
    try { await this.assertWorldRestoreSafe(id, signal) }
    catch (error) {
      if (signal?.aborted) throw error
      this.invalidateModTokens(id)
      instance.status = 'error'
      instance.error = new WorldRestoreRecoveryError().message
      this.emit({ type: 'state', snapshot: this.snapshot() })
      throw new WorldRestoreRecoveryError()
    }
    if (this.modRecoveryBlocked.has(id)) throw new Error(instance.error || '模组文件修改需要人工检查，请先保留恢复资料')
    let blocked = false
    try {
      const recovery = await this.modToggleRecovery(this.instanceDirectory(id), { signal })
      for (const warning of recovery.warnings) this.log(id, 'warn', warning)
      blocked = recovery.blocked
    } catch (error) {
      if (signal?.aborted || error instanceof ModToggleBusyError) throw error
      blocked = true
      this.log(id, 'error', errorMessage(error))
    }
    if (blocked) {
      this.modRecoveryBlocked.add(id)
      this.invalidateModTokens(id)
      instance.status = 'error'
      instance.error = '无法安全确认模组文件操作状态，请检查实例目录与 .mod-toggle-* 恢复资料；不会自动删除或覆盖文件'
      // This safety state must reach the UI even when no configuration write
      // was requested, or a subsequent launcher.json save is unavailable.
      this.emit({ type: 'state', snapshot: this.snapshot() })
      throw new Error(instance.error)
    }
    } finally { finish() }
  }

  private assertModToggleIdle(id: string): Instance {
    this.assertNoLauncherUpdate()
    this.assertDatapackIdle(id)
    const instance = this.instance(id)
    if (instance.status !== 'ready' || instance.loader === 'vanilla') throw new Error('请先安装模组加载器并关闭游戏，再修改模组文件')
    if (this.installs.has(id) || this.launching.has(id) || this.processes.has(id) || this.instanceSettingsSaving.has(id)) {
      throw new Error('此实例正在安装、启动、运行或保存设置，请稍后再修改模组文件')
    }
    if (this.modRecoveryBlocked.has(id)) throw new Error(instance.error || '请先检查模组文件修改的恢复资料')
    return instance
  }

  assertLaunchAvailable(id: string): void {
    this.assertNoLauncherUpdate()
    this.assertDatapackIdle(id)
    const instance = this.instance(id)
    if (this.installs.has(id) || this.launching.has(id) || this.processes.has(id) || this.instanceSettingsSaving.has(id)) {
      throw new Error('请等待此实例的文件操作、启动或设置保存结束')
    }
    if (this.modRecoveryBlocked.has(id)) throw new Error(instance.error || '请先检查模组文件修改的恢复资料')
    if (instance.status !== 'ready') throw new Error('请先安装或修复该实例')
  }

  async prepareModToggle(id: string, selection: unknown, enabled: boolean): Promise<ModTogglePreview> {
    const finish = this.beginLauncherOperation()
    try {
    this.assertModToggleIdle(id)
    if (typeof enabled !== 'boolean') throw new Error('模组文件目标状态无效')
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(selection)) ||
        Reflect.ownKeys(selection).length !== 4 || Reflect.ownKeys(selection).some(key =>
          typeof key !== 'string' || !['itemId', 'name', 'sizeBytes', 'modifiedAt'].includes(key) ||
          !('value' in Object.getOwnPropertyDescriptor(selection, key)!))) throw new Error('模组文件选择格式无效')
    const raw = selection as ModToggleSelection
    if (typeof raw.itemId !== 'string' || typeof raw.name !== 'string' || typeof raw.modifiedAt !== 'string' ||
        !Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 0) throw new Error('模组文件选择字段无效')
    const input = { itemId: raw.itemId, name: raw.name, sizeBytes: raw.sizeBytes, modifiedAt: raw.modifiedAt }
    const generation = this.mutationGeneration.get(id) || 0
    const epoch = this.modPreparationEpoch
    await this.assertInstanceUsable(id)
    const prepared = await this.modTogglePreparer(this.instanceDirectory(id), input, enabled)
    this.assertModToggleIdle(id)
    if (epoch !== this.modPreparationEpoch || generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('检查期间实例已变化或操作已取消，请刷新清单后重试')
    const now = this.modToggleNow()
    for (const [token, value] of this.modToggleTokens) if (value.expiresAt <= now) this.modToggleTokens.delete(token)
    if (this.modToggleTokens.size >= 32) throw new Error('模组文件确认请求较多，请稍后重新检查')
    const token = randomUUID(), expiresAt = now + 120_000
    this.modToggleTokens.set(token, { instanceId: id, generation, expiresAt, prepared })
    return { token, instanceId: id, itemId: input.itemId, fromName: input.name,
      toName: enabled ? input.name.slice(0, -'.disabled'.length) : input.name + '.disabled', enabled,
      sizeBytes: input.sizeBytes, modifiedAt: input.modifiedAt, expiresAt }
    } finally { finish() }
  }

  async setModEnabled(id: string, token: string): Promise<ModToggleResult> {
    this.assertNoLauncherUpdate()
    this.instance(id)
    const pending = this.modToggleTokens.get(token)
    // Consume before the first await: an old confirmation can never invert a later request.
    if (pending?.instanceId === id) this.modToggleTokens.delete(token)
    if (!pending || pending.instanceId !== id || pending.expiresAt <= this.modToggleNow() ||
        pending.generation !== (this.mutationGeneration.get(id) || 0)) throw new Error('模组文件确认已过期，请刷新并重新检查')
    this.assertModToggleIdle(id)
    const controller = new AbortController()
    this.installs.set(id, controller)
    this.invalidateInventory(id)
    try {
      await this.assertInstanceUsable(id, controller.signal)
      const result = await this.modToggleCommitter(this.instanceDirectory(id), pending.prepared, { signal: controller.signal })
      this.log(id, 'info', `模组文件名已修改：${result.fromName} → ${result.toName}；未检查加载、依赖或兼容性`)
      for (const warning of result.warnings) this.log(id, 'warn', warning)
      return result
    } catch (error) {
      if (error instanceof ModToggleRecoveryError) {
        this.modRecoveryBlocked.add(id)
        const instance = this.instance(id)
        instance.status = 'error'; instance.error = error.message
        this.emit({ type: 'state', snapshot: this.snapshot() })
        try { await this.save() } catch (saveError) { this.log(id, 'error', `恢复状态保存失败；文件恢复资料仍保留：${errorMessage(saveError)}`) }
      }
      throw error
    } finally {
      this.invalidateInventory(id)
      this.installs.delete(id)
    }
  }

  instanceOptions(id: string): ResolvedInstanceOptions {
    const { concurrentDownloads: _downloads, ...global } = this.settings
    // Schema 1 historically allowed the bare command "java" as automatic mode.
    return resolveInstanceOptions({ ...global, javaPath: global.javaPath === 'java' ? '' : global.javaPath,
      manualJavaPath: global.manualJavaPath === 'java' ? '' : global.manualJavaPath }, this.instance(id).options)
  }

  async updateInstanceSettings(id: string, input: { name: string; options: unknown }): Promise<LauncherSnapshot> {
    this.assertNoLauncherUpdate()
    this.assertDatapackIdle(id)
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
    this.invalidateModTokens(id)
    try {
      await this.assertInstanceUsable(id)
      await this.save(() => {
        if (this.installs.has(id) || this.launching.has(id) || this.processes.has(id)) throw new Error('此实例正在安装或运行，设置未保存')
        return {
          instances: this.instances.map(item => item.id === id ? { ...item, name, options } : item),
          commit: () => { instance.name = name; instance.options = options },
        }
      })
      return this.snapshot()
    } finally { this.invalidateModTokens(id); this.instanceSettingsSaving.delete(id) }
  }

  private assertInstanceIdle(id: string): Instance {
    this.assertNoLauncherUpdate()
    this.assertDatapackIdle(id)
    const instance = this.instance(id)
    if (this.installs.has(id) || this.launching.has(id) || this.processes.has(id) || instance.status === 'running' || instance.status === 'installing') {
      throw new Error('请先关闭游戏并等待安装、备份等操作完成')
    }
    if (this.instanceSettingsSaving.has(id)) throw new Error('请等待此实例的设置保存完成')
    return instance
  }

  /** Main-only: directory to move to the system trash before `forgetInstance`. */
  removableInstancePath(id: string): string {
    this.assertInstanceIdle(id)
    return this.instanceDirectory(id)
  }

  /** Main-only native trash port. Reserve before its first await, through record save. */
  async removeInstance(id: string, trash: (directory: string) => Promise<void>): Promise<{ trashed: boolean }> {
    const finish = this.beginLauncherOperation()
    let controller: AbortController | undefined
    try {
      this.assertInstanceIdle(id)
      controller = new AbortController()
      this.installs.set(id, controller)
      this.invalidateInventory(id)
      const directory = this.instanceDirectory(id)
      const [original, parent] = await Promise.all([fs.lstat(directory, { bigint: true }), fs.lstat(path.dirname(directory), { bigint: true })])
      if (!original.isDirectory() || original.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()) throw new Error('实例目录或父目录不安全，请检查后重试')
      const assertOriginal = async () => {
        const [current, currentParent] = await Promise.all([fs.lstat(directory, { bigint: true }).catch(() => undefined), fs.lstat(path.dirname(directory), { bigint: true }).catch(() => undefined)])
        if (!current || !currentParent || !current.isDirectory() || current.isSymbolicLink() ||
            current.dev !== original.dev || current.ino !== original.ino || current.mode !== original.mode ||
            currentParent.dev !== parent.dev || currentParent.ino !== parent.ino || currentParent.mode !== parent.mode) {
          throw new Error('实例目录在移除期间发生变化，已保留记录；请检查回收站和原目录后再操作')
        }
      }
      let trashed = true
      try { await trash(directory) }
      catch {
        await assertOriginal()
        const target = safeJoin(this.rootDir, `deleted-instances/${id}-${randomUUID()}`)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await assertOriginal()
        await fs.rename(directory, target)
        trashed = false
      }
      await this.save(() => {
        const instances = this.instances.filter(item => item.id !== id)
        return { instances, commit: () => { this.instances = instances } }
      })
      return { trashed }
    } finally {
      if (controller && this.installs.get(id) === controller) this.installs.delete(id)
      finish()
    }
  }

  /** Removes the instance record. The caller has already trashed or archived its folder. */
  async forgetInstance(id: string): Promise<LauncherSnapshot> {
    const finish = this.beginLauncherOperation()
    try {
    this.assertInstanceIdle(id)
    this.instances = this.instances.filter(item => item.id !== id)
    this.invalidateInventory(id)
    await this.save()
    return this.snapshot()
    } finally { finish() }
  }

  /** Fallback when the system trash is unavailable: move the folder aside instead of deleting it. */
  async archiveInstanceFolder(id: string): Promise<string> {
    const finish = this.beginLauncherOperation()
    try {
    const source = this.removableInstancePath(id)
    const target = safeJoin(this.rootDir, `deleted-instances/${id}-${Date.now()}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rename(source, target)
    return target
    } finally { finish() }
  }

  /** Copies an idle instance (game files, settings and installed state) under a new name. */
  async duplicateInstance(id: string, name: string): Promise<Instance> {
    const finish = this.beginLauncherOperation()
    try {
    const source = this.assertInstanceIdle(id)
    const trimmed = String(name ?? '').trim()
    if (!trimmed || trimmed.length > 64 || /[\u0000-\u001f\u007f]/u.test(trimmed)) throw new Error('实例名称需要 1–64 个字符')
    const copy: Instance = { ...structuredClone(source), id: randomUUID(), name: trimmed, createdAt: new Date().toISOString(), playtimeMs: 0 }
    delete copy.lastPlayed; delete copy.error
    if (copy.status !== 'ready') copy.status = 'not-installed'
    const from = this.instanceDirectory(id), to = safeJoin(this.rootDir, `instances/${copy.id}`)
    this.installs.set(id, new AbortController())
    try {
      await this.assertInstanceUsable(id)
      await fs.cp(from, to, {
        recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true,
        filter: file => !/(^|[\\/])(\.restore-staging|\.mod-staging-[^\\/]*|\.mod-toggle-[^\\/]*)$/.test(path.relative(from, file)),
      })
    } catch (error) {
      await fs.rm(to, { recursive: true, force: true }).catch(() => {})
      throw new Error(`复制实例失败：${errorMessage(error)}`)
    } finally { this.installs.delete(id) }
    this.instances.push(copy)
    await this.save()
    return structuredClone(copy)
    } finally { finish() }
  }

  async createInstance(input: { name: string; version: string; loader: Loader; loaderVersion?: string }): Promise<Instance> {
    const finish = this.beginLauncherOperation()
    try {
    const name = String(input.name ?? '').trim()
    if (!name || name.length > 64) throw new Error('实例名称需要 1–64 个字符')
    if (!isGameVersionId(input.version)) throw new Error('无效的 Minecraft 版本')
    if (!['vanilla', 'fabric', 'forge', 'neoforge'].includes(input.loader)) throw new Error('无效的模组加载器')
    if (input.loaderVersion && input.loader === 'vanilla') throw new Error('原版实例不能指定加载器版本')
    if (input.loader !== 'vanilla') {
      const available = await this.loaderVersions(input.version, input.loader)
      if (!available.length || (input.loaderVersion && !available.some(loader => loader.version === input.loaderVersion))) {
        throw new Error('此 Minecraft 版本不支持所选加载器版本')
      }
    }
    const versions = await this.versions()
    if (!versions.some(item => item.id === input.version)) throw new Error('官方版本列表中没有这个 Minecraft 版本')
    const instance: Instance = {
      id: randomUUID(), name, version: input.version, loader: input.loader, loaderVersion: input.loaderVersion,
      status: 'not-installed', createdAt: new Date().toISOString(), playtimeMs: 0,
    }
    await fs.mkdir(safeJoin(this.rootDir, `instances/${instance.id}/game`), { recursive: true })
    this.instances.push(instance)
    await this.save()
    return structuredClone(instance)
    } finally { finish() }
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
    if (input.downloadSource !== undefined && !isDownloadSource(input.downloadSource)) throw new Error('无效的下载源')
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
      concurrentDownloads: input.concurrentDownloads, ...(input.downloadSource ? { downloadSource: input.downloadSource } : {}), ...advanced }
  }

  async updateSettings(settings: Partial<LauncherSettings>): Promise<LauncherSnapshot> {
    this.assertNoLauncherUpdate()
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
  private async resourceJson(url: string, source: ResourceSource, signal?: AbortSignal): Promise<unknown> {
    const provider = resourceProvider(source)
    const response = await this.request(url, signal, new Set([new URL(provider.api).hostname]))
    if (response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
      await response.body?.cancel()
      throw new Error('资源站返回了网页，未读取为资源元数据；请稍后重试或前往官网')
    }
    const bytes = await this.readResponse(response, 4 * 1024 * 1024)
    signal?.throwIfAborted()
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
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
    // Every channel is returned; the interface decides which ones to show.
    return (await this.manifest(signal)).versions.filter(v => isGameVersionId(v.id) && ['release', 'snapshot', 'old_beta', 'old_alpha'].includes(v.type))
      .map(({ id, type, releaseTime }) => ({ id, type, releaseTime }))
  }

  async fabricVersions(version: string, signal?: AbortSignal): Promise<FabricVersion[]> {
    signal?.throwIfAborted()
    if (!isGameVersionId(version)) throw new Error('无效的 Minecraft 版本')
    const loaders = await this.json<Array<{ loader: FabricVersion }>>(`${FABRIC_URL}/versions/loader/${encodeURIComponent(version)}`, signal)
    return loaders.map(item => ({ version: sanitizeId(item.loader.version), stable: Boolean(item.loader.stable) }))
  }

  private async text(url: string, signal?: AbortSignal): Promise<string> {
    return (await this.readResponse(await this.request(url, signal), 4 * 1024 * 1024)).toString('utf8')
  }

  async loaderVersions(version: string, loader: Exclude<Loader, 'vanilla'>, signal?: AbortSignal): Promise<LoaderVersion[]> {
    if (loader === 'fabric') return this.fabricVersions(version, signal)
    if (!isSupportedVersion(version)) throw new Error('Forge 与 NeoForge 目前支持 Minecraft 1.20.1 及之后的正式版本')
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
    this.assertNoLauncherUpdate()
    this.assertDatapackIdle(id)
    const instance = this.instance(id)
    if (this.instanceSettingsSaving.has(id)) throw new Error('请等待此实例的设置保存完成')
    if (this.installs.has(id)) throw new Error('该实例正在安装')
    if (this.processes.has(id) || this.launching.has(id)) throw new Error('请先关闭正在运行或启动中的游戏')
    const controller = new AbortController()
    const signal = controller.signal
    const preferences = this.instanceOptions(id).values
    this.installs.set(id, controller)
    this.invalidateInventory(id)
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
      await this.assertInstanceUsable(id, signal)
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
      const entry = (await this.manifest(signal)).versions.find(v => v.id === instance.version)
      if (!entry || !isGameVersionId(entry.id)) throw new Error('官方版本列表中找不到该 Minecraft 版本')
      const versionFile = safeJoin(this.rootDir, `versions/${sanitizeId(instance.version)}/${sanitizeId(instance.version)}.json`)
      await this.download({ file: versionFile, download: entry }, signal)
      const version: VersionManifest = JSON.parse(await fs.readFile(versionFile, 'utf8'))
      if (!version.downloads?.client || !version.assetIndex || !Array.isArray(version.libraries)) throw new Error('该版本的启动格式暂不支持')
      // Normalise legacy manifests (minecraftArguments, missing Java metadata) to the modern shape.
      version.arguments = launchArguments(version) as VersionManifest['arguments']
      version.javaVersion = javaRequirementOf(version)
      const javaArch = needsRosetta(this.platform, this.arch, version.libraries) ? 'x64' : this.arch
      if (javaArch !== this.arch) this.log(id, 'info', '此版本没有 Apple 芯片原生库，将通过 Rosetta 2 使用 x86-64 Java 运行。')
      const javaRequirement = this.javaRequirement(version, instance)
      progress(`正在准备 Java ${javaRequirement.major}`, true)
      const runtime = await this.selectJava(javaRequirement.major, javaRequirement.component, {
        signal, javaPath: preferences.javaPath, arch: javaArch, onProgress: update => {
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
        if (!rulesAllow(library.rules, this.platform, javaArch)) continue
        if (library.downloads?.artifact || !library.downloads) {
          const download = await this.libraryDownload(library, signal)
          const relative = `libraries/${download.path ?? mavenPath(library.name)}`
          const file = safeJoin(this.rootDir, relative)
          jobs.push({ file, download })
          classpath.push(relative)
          libraryClasspath.set(libraryKey(library.name), relative)
        }
        const nativeKey = library.natives?.[platformName(this.platform)]?.replace('${arch}', javaArch === 'ia32' ? '32' : '64')
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
      const assets: AssetIndex = JSON.parse(await fs.readFile(assetIndexFile, 'utf8'))
      if (!assets.objects || typeof assets.objects !== 'object') throw new Error('资源索引格式无效')
      const legacyAssets = legacyAssetCopies(assets)
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
      if (legacyAssets.mode !== 'none') {
        progress('正在整理旧版资源文件', true)
        const target = legacyAssets.mode === 'virtual' ? safeJoin(this.rootDir, `assets/virtual/${assetId}`) : safeJoin(this.instanceDirectory(id), 'game/resources')
        for (const file of legacyAssets.files) {
          signal.throwIfAborted()
          const destination = safeJoin(target, file.name)
          const source = safeJoin(this.rootDir, `assets/objects/${file.hash.slice(0, 2)}/${file.hash}`)
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.copyFile(source, destination)
        }
      }
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
        ...(javaArch !== this.arch ? { javaArch } : {}),
        ...(legacyAssets.mode !== 'none' ? { legacyAssets: legacyAssets.mode } : {}),
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
    if (this.worldBackupOperations.has(id)) throw new Error('这是世界备份任务，请使用该备份任务的取消按钮')
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
    const finish = this.beginLauncherOperation()
    try {
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
    } finally { finish() }
  }

  async managedJava(): Promise<ManagedJavaRuntime[]> {
    const finish = this.beginLauncherOperation()
    try { return await this.javaRuntimeManager.discover() }
    finally { finish() }
  }
  runtimeTasks(): JavaRuntimeTask[] { return structuredClone([...this.javaTasks.values()]) }

  startJavaInstall(major: number): JavaRuntimeTask {
    this.assertNoLauncherUpdate()
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
    this.modPreparationEpoch++
    this.modToggleTokens.clear()
    this.worldReadEpoch++
    this.worldRevisions.clear()
    this.worldViews.clear()
    this.datapackViews.clear()
    this.datapackCatalogViews.clear()
    this.datapackRevisions.clear()
    for (const read of this.datapackReads.values()) read.controller.abort(new DOMException('启动器正在退出', 'AbortError'))
    for (const controller of [...this.installs.values(), ...this.javaDownloads.values(), ...this.launchControllers.values(),
      ...[...this.inventoryScans.values()].map(scan => scan.controller), ...[...this.worldReads.values()].map(read => read.controller), ...(this.worldExportOperation ? [this.worldExportOperation.controller] : [])]) {
      controller.abort(new DOMException('启动器正在退出', 'AbortError'))
    }
  }

  async detectJava(additionalPath?: string): Promise<JavaRuntime[]> {
    const finish = this.beginLauncherOperation()
    try {
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
      const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432,
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[]
      for (const root of [...new Set(roots)]) {
        for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'IBM', 'Liberica', 'Oracle', 'GraalVM']) {
          try {
            for (const folder of await fs.readdir(path.join(root, vendor))) candidates.add(path.join(root, vendor, folder, 'bin', 'java.exe'))
          } catch {}
        }
      }
      // Registry entries written by Oracle, Adoptium, Zulu and Microsoft installers.
      for (const key of ['HKLM\\SOFTWARE\\JavaSoft', 'HKLM\\SOFTWARE\\Eclipse Adoptium', 'HKLM\\SOFTWARE\\Eclipse Foundation', 'HKLM\\SOFTWARE\\Azul Systems\\Zulu', 'HKLM\\SOFTWARE\\Microsoft\\JDK']) {
        try {
          const { stdout } = await execFileAsync('reg', ['query', key, '/s'], { timeout: 5000, windowsHide: true, maxBuffer: 512 * 1024 })
          for (const match of stdout.matchAll(/(?:JavaHome|InstallationPath|Path)\s+REG_SZ\s+(.+)/g)) {
            const home = match[1].trim()
            if (path.isAbsolute(home)) candidates.add(path.join(home, 'bin', 'java.exe'))
          }
        } catch {}
      }
      // Runtimes bundled with the official Minecraft Launcher.
      for (const runtime of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Minecraft Launcher', 'runtime'),
        process.env.APPDATA && path.join(process.env.APPDATA, '.minecraft', 'runtime')].filter(Boolean) as string[]) {
        try {
          for (const component of await fs.readdir(runtime)) {
            for (const platformFolder of ['windows-x64', 'windows-arm64', 'windows-x86']) candidates.add(path.join(runtime, component, platformFolder, component, 'bin', 'java.exe'))
          }
        } catch {}
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
    } finally { finish() }
  }

  async launch(id: string, account: LaunchAccount, beforeSpawn?: () => void): Promise<{ pid: number | undefined }> {
    this.assertNoLauncherUpdate()
    this.assertDatapackIdle(id)
    if (this.installs.has(id)) throw new Error('请等待此实例的安装或文件操作完成')
    if (this.instanceSettingsSaving.has(id)) throw new Error('请等待此实例的设置保存完成')
    if (this.launching.has(id)) throw new Error('该实例正在启动')
    // Acquire synchronously: installed-manifest reads and Java detection both yield before spawn.
    this.launching.add(id)
    this.invalidateModTokens(id)
    const controller = new AbortController()
    this.launchControllers.set(id, controller)
    try {
      await this.assertInstanceUsable(id, controller.signal)
      return await this.launchInstance(id, account, () => { controller.signal.throwIfAborted(); beforeSpawn?.() }, controller.signal)
    } finally {
      this.invalidateModTokens(id)
      this.launching.delete(id)
      this.launchControllers.delete(id)
    }
  }

  private async selectJava(required: number, component?: string, options: { signal?: AbortSignal; javaPath?: string; arch?: string; onProgress?: (progress: JavaRuntimeProgress) => void } = {}): Promise<JavaRuntime> {
    const arch = options.arch ?? this.arch
    options.signal?.throwIfAborted()
    const configured = options.javaPath ?? this.settings.javaPath
    const explicitPath = configured && configured !== 'java' ? configured : ''
    const runtimes = await this.detectJava(explicitPath)
    options.signal?.throwIfAborted()
    let runtime = explicitPath
      ? runtimes.find(java => java.path === explicitPath)
      : runtimes.find(java => java.major === required && java.arch === arch)
    if (!runtime && explicitPath) throw new Error(`指定的 Java 路径不可用，需要 Java ${required}（${arch}）。请在设置中修正路径或切换自动选择。`)
    if (!runtime) {
      if (!component) throw new Error(`需要 Java ${required}（${arch}），版本清单缺少官方运行时组件。请重新安装修复实例，或在设置中指定匹配的 Java。`)
      try { runtime = await this.javaRuntimeManager.ensure({ component, major: required, platform: this.platform, arch }, options) }
      catch (error) {
        if (arch !== this.arch && this.platform === 'darwin' && !(error instanceof DOMException)) {
          throw new Error(`${errorMessage(error)}。旧版本需要 Rosetta 2，可在终端运行 softwareupdate --install-rosetta 安装后重试。`)
        }
        throw error
      }
    }
    if (runtime.major !== required) throw new Error(`该版本需要 Java ${required}，当前选择的是 Java ${runtime.major}`)
    if (runtime.arch !== arch) throw new Error(arch !== this.arch ? `此旧版本需要 ${arch} 架构的 Java ${required}（通过 Rosetta 2 运行），当前选择的是 ${runtime.arch}` : `Java 架构 ${runtime.arch} 与启动器架构 ${this.arch} 不一致`)
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
    const javaArch = installed.javaArch === 'x64' && this.platform === 'darwin' ? 'x64' : this.arch
    const runtime = await this.selectJava(requirement.major, requirement.component, { signal, javaPath: preferences.javaPath, arch: javaArch, onProgress: update => {
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
      game_assets: installed.legacyAssets === 'virtual' ? safeJoin(this.rootDir, `assets/virtual/${sanitizeId(installed.version.assetIndex.id)}`)
        : installed.legacyAssets === 'resources' ? safeJoin(gameDir, 'resources') : safeJoin(this.rootDir, 'assets'),
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
    const launchArgs = launchArguments(installed.version) as VersionManifest['arguments']
    const jvm = resolveArguments([...launchArgs.jvm, ...installed.fabricArguments.jvm], variables, this.platform, javaArch, features)
    const game = resolveArguments([...launchArgs.game, ...installed.fabricArguments.game], variables, this.platform, javaArch, features)
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
    const recent: string[] = []
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
        if (line.trim()) {
          const clean = scrub(line).slice(0, 8192)
          recent.push(clean); if (recent.length > 400) recent.shift()
          this.log(id, xmlLevel, clean)
        }
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
      // The child has ended, but its diagnostics and state write have not. Retain
      // an operation lease before removing the process so update cannot slip in.
      const finishExit = this.beginLauncherOperation()
      let crashWork: Promise<unknown> = Promise.resolve()
      this.processes.delete(id)
      const requestedStop = this.stopping.delete(id)
      instance.playtimeMs += Math.max(0, Date.now() - started)
      instance.status = 'ready'
      if (code !== 0 && !requestedStop) {
        instance.error = signal
          ? `游戏异常退出，信号 ${signal}；请查看游戏日志。`
          : `游戏已退出，退出码 ${code ?? '未知'}；请查看游戏日志。`
        this.log(id, 'error', instance.error)
        crashWork = this.crashReport(gameDir, started).then(report => {
          const analysis = analyzeCrash(recent, report)
          instance.error = `${analysis.title}（${signal ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`}）。${analysis.hints[0]}`
          this.log(id, 'error', `崩溃分析：${analysis.title}`)
          this.emit({ type: 'crash', instanceId: id, analysis })
          this.emit({ type: 'state', snapshot: this.snapshot() })
        }).catch(() => {})
      } else { delete instance.error; this.log(id, 'info', '游戏已关闭') }
      void Promise.allSettled([crashWork, this.save().catch(error => this.log(id, 'error', errorMessage(error)))])
        .finally(finishExit)
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

  /** Newest crash report (or JVM hs_err log) written since the game started; bounded read. */
  private async crashReport(gameDir: string, since: number): Promise<{ name: string; text: string } | undefined> {
    const candidates: Array<{ file: string; name: string; time: number }> = []
    for (const [directory, pattern] of [[path.join(gameDir, 'crash-reports'), /^crash-.*\.txt$/], [gameDir, /^hs_err_pid\d+\.log$/]] as const) {
      try {
        for (const name of await fs.readdir(directory)) {
          if (!pattern.test(name)) continue
          const info = await fs.stat(path.join(directory, name))
          if (info.isFile() && info.mtimeMs >= since - 2000) candidates.push({ file: path.join(directory, name), name, time: info.mtimeMs })
        }
      } catch { /* folder absent */ }
    }
    const newest = candidates.sort((a, b) => b.time - a.time)[0]
    if (!newest) return undefined
    const handle = await fs.open(newest.file, 'r')
    try {
      const buffer = Buffer.alloc(256 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return { name: newest.name, text: buffer.subarray(0, bytesRead).toString('utf8') }
    } finally { await handle.close() }
  }

  /** Main-only: folder that holds crash reports for shell.openPath. */
  crashReportsPath(id: string): string {
    this.instance(id)
    return safeJoin(this.instanceDirectory(id), 'game/crash-reports')
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

  async searchResources(query: string, options: { kind: ResourceKind; gameVersion?: string; offset?: number; source?: ResourceSource }): Promise<ResourceSearchResult> {
    const source = catalogSource(options.source ?? 'modrinth')
    const provider = resourceProvider(source)
    const params = resourceSearchParameters(query, options)
    return normalizeResourceSearch(await this.resourceJson(`${provider.api}/search?${params}`, source), options.kind, source)
  }

  async resourceVersions(projectId: string, instanceId: string, kind: ResourceKind, source: ResourceSource = 'modrinth'): Promise<ResourceVersion[]> {
    const instance = this.instance(instanceId)
    resourceKind(kind); catalogSource(source); sanitizeId(projectId)
    const provider = resourceProvider(source)
    const context = { projectId, kind, source, gameVersion: instance.version }
    parseResourceProject(await this.resourceJson(`${provider.api}/project/${encodeURIComponent(projectId)}`, source), context)
    const params = resourceVersionsParameters(kind, instance.version)
    const raw = await this.resourceJson(`${provider.api}/project/${encodeURIComponent(projectId)}/version?${params}`, source)
    if (!Array.isArray(raw) || raw.length > 1000) throw new Error('资源版本列表格式无效或过大')
    return raw.map(version => prepareResourceVersion(version, context).info)
  }

  cancelResourceInstall(instanceId: string, operationId: string): void {
    this.instance(instanceId)
    const pending = this.resourceDownloads.get(instanceId)
    if (pending?.operationId === operationId) pending.controller.abort(new DOMException('资源下载已取消', 'AbortError'))
  }

  async installResource(instanceId: string, selection: unknown, operationId: string): Promise<ResourceInstallResult> {
    this.assertNoLauncherUpdate()
    this.assertDatapackIdle(instanceId)
    const instance = this.instance(instanceId)
    const input = validateResourceSelection(selection)
    if (typeof operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(operationId)) throw new Error('资源任务标识无效')
    if (instance.status !== 'ready') throw new Error('请先完成游戏下载或修复并关闭游戏，再安装资源')
    if (this.installs.has(instanceId) || this.launching.has(instanceId) || this.processes.has(instanceId) || this.instanceSettingsSaving.has(instanceId)) {
      throw new Error('此实例正在安装、启动、运行或保存设置，请稍后再试')
    }
    if (this.resourceDownloads.size >= 4) throw new Error('资源下载任务较多，请等待当前任务结束')
    const controller = new AbortController(), signal = controller.signal
    this.installs.set(instanceId, controller)
    this.resourceDownloads.set(instanceId, { operationId, controller })
    this.invalidateInventory(instanceId)
    try {
      await this.assertInstanceUsable(instanceId, signal)
      this.emit({ type: 'progress', instanceId, phase: '正在核对所选资源版本', completed: 0, total: 0, bytesDownloaded: 0, unit: 'bytes' })
      const provider = resourceProvider(input.source)
      const context = { ...input, gameVersion: instance.version }
      const project = parseResourceProject(await this.resourceJson(`${provider.api}/project/${encodeURIComponent(input.projectId)}`, input.source, signal), context)
      const raw = await this.resourceJson(`${provider.api}/version/${encodeURIComponent(input.versionId)}`, input.source, signal)
      const prepared = prepareResourceVersion(raw, context)
      if (!prepared.artifact) throw new Error(`${prepared.info.externalReason || '此资源不能安全自动安装'}：${prepared.info.projectUrl}`)
      assertResourceSelection(input, prepared.artifact)
      signal.throwIfAborted()
      const result = await this.resourceInstaller(this.instanceDirectory(instanceId), prepared.artifact, {
        fetch: this.fetcher, signal, rename: this.renameFile,
        onProgress: update => this.emit({ type: 'progress', instanceId,
          phase: update.phase === 'download' ? `正在下载：${project.title}` : update.phase === 'verify' ? '正在校验资源文件' : '正在提交资源文件',
          completed: update.completedBytes, total: update.totalBytes, bytesDownloaded: update.completedBytes, unit: 'bytes' }),
      })
      // A successful registry commit wins a cancellation delivered during rename.
      this.log(instanceId, 'info', `${project.title} 已${result.reused ? '校验复用' : '下载'}到 game/${result.folder}/${result.filename}；尚未自动启用`)
      for (const warning of result.warnings) this.log(instanceId, 'warn', warning)
      this.emit({ type: 'progress', instanceId, phase: '资源已放入实例目录，尚未启用', completed: result.size, total: result.size, bytesDownloaded: result.size, unit: 'bytes' })
      return result
    } catch (error) {
      if (error instanceof ResourceInstallRecoveryError) {
        instance.status = 'error'; instance.error = error.message
        await this.save()
      }
      if (signal.aborted && !(error instanceof ResourceInstallRecoveryError)) {
        this.log(instanceId, 'info', '资源下载已取消')
        throw new Error('资源下载已取消')
      }
      this.log(instanceId, signal.aborted ? 'info' : 'error', errorMessage(error))
      throw error
    } finally {
      this.invalidateInventory(instanceId)
      this.resourceDownloads.delete(instanceId)
      this.installs.delete(instanceId)
    }
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
    const finish = this.beginLauncherOperation()
    try {
    return await this.createPackInstance(await readModpack(filePath), options, { source: 'local' })
    } finally { finish() }
  }

  async installModpack(versionId: string, options: { name?: string; source?: ResourceSource } = {}): Promise<LauncherSnapshot> {
    this.assertNoLauncherUpdate()
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
    const finish = this.beginLauncherOperation()
    try {
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
    } finally { finish() }
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
    this.assertNoLauncherUpdate()
    this.assertDatapackIdle(instanceId)
    if (this.instanceSettingsSaving.has(instanceId)) throw new Error('请等待此实例的设置保存完成')
    const provider = resourceProvider(source)
    const instance = this.instance(instanceId)
    if (instance.loader === 'vanilla' || instance.status !== 'ready') throw new Error('请先安装 Fabric、Forge 或 NeoForge 实例，并关闭游戏')
    if (this.launching.has(instanceId) || this.processes.has(instanceId)) throw new Error('请先关闭正在运行或启动中的游戏')
    if (this.installs.has(instanceId)) throw new Error('该实例已有安装任务')
    const controller = new AbortController()
    this.installs.set(instanceId, controller)
    this.invalidateInventory(instanceId)
    const visited = new Set<string>()
    const projects = new Map<string, string>()
    const plan: Array<{ version: ModrinthVersion; job: DownloadJob }> = []
    const staging = safeJoin(this.instanceDirectory(instanceId), `.mod-staging-${randomUUID()}`)
    let keepRecoveryFiles = false
    try {
      await this.assertInstanceUsable(instanceId, controller.signal)
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
      const partnerNames: string[] = []
      const affectedFiles = new Set<string>([registryPath])
      for (const item of plan) {
        const filename = path.basename(item.job.file)
        partnerNames.push(filename)
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
          partnerNames.push(previous.filename)
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
      await assertNoDisabledModPartners(this.instanceDirectory(instanceId), partnerNames, { signal: controller.signal })
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
