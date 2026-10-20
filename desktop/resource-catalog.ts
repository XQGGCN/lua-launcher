import type { ResourceArtifact, ResourceKind, ResourceSource } from './resource-install'
export type { ResourceKind, ResourceSource } from './resource-install'

export interface ResourceDependency { type: 'required' | 'optional' | 'incompatible' | 'embedded'; projectId?: string; versionId?: string; filename?: string }
export interface ResourceVersion {
  id: string; projectId: string; name: string; gameVersions: string[]; loaders: string[]
  filename?: string; size?: number; sha512?: string
  externalOnly: boolean; externalReason?: string; projectUrl: string; dependencies: ResourceDependency[]
}
export interface ResourceInstallInput { kind: ResourceKind; source: ResourceSource; projectId: string; versionId: string; filename: string; sha512: string }
export interface ResourceProject { id: string; title: string; description: string; kind: ResourceKind; projectUrl: string }
export interface ResourceSearchHit {
  project_id: string; slug: string; title: string; description: string; icon_url: string | null
  author: string; downloads: number; categories: string[]; project_type: ResourceKind
}
export interface ResourceSearchResult { hits: ResourceSearchHit[]; total_hits: number; offset: number; limit: number; omittedHits?: number }
export interface ResourceContext { source: ResourceSource; kind: ResourceKind; projectId: string; gameVersion: string }
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SHA512 = /^[a-f0-9]{128}$/i
const SHA1 = /^[a-f0-9]{40}$/i
const CONTROL = /[\u0000-\u001f\u007f]/u
export const RESOURCE_ZIP_BYTES = 512 * 1024 * 1024

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => !('value' in Object.getOwnPropertyDescriptor(value, key)!))) throw new Error('资源元数据格式无效')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || (!allowEmpty && !value.trim())) throw new Error('资源文本字段无效')
  return value
}
function description(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error('资源简介字段无效')
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('资源标识无效')
  return value
}
function strings(value: unknown, count: number, max: number): string[] {
  if (!Array.isArray(value) || value.length > count) throw new Error('资源列表字段无效')
  return value.map(item => text(item, max))
}
export function resourceKind(value: unknown): ResourceKind {
  if (value !== 'resourcepack' && value !== 'shader') throw new Error('不支持的资源类型')
  return value
}
export function catalogSource(value: unknown): ResourceSource {
  if (value !== 'modrinth' && value !== 'bbsmc') throw new Error('不支持的资源来源')
  return value
}
export function resourceProjectLink(source: ResourceSource, kind: ResourceKind, projectId: string): string {
  catalogSource(source); resourceKind(kind)
  return `https://${source === 'modrinth' ? 'modrinth.com' : 'bbsmc.net'}/${kind}/${encodeURIComponent(id(projectId))}`
}
function hasKind(raw: Record<string, unknown>, kind: ResourceKind): boolean {
  if (raw.project_types !== undefined && !strings(raw.project_types, 16, 40).includes(kind) && raw.project_type !== kind) return false
  return raw.project_type === kind || (Array.isArray(raw.project_types) && raw.project_types.includes(kind))
}
export function parseResourceProject(value: unknown, context: Pick<ResourceContext, 'kind' | 'source' | 'projectId'>): ResourceProject {
  const raw = object(value)
  resourceKind(context.kind); catalogSource(context.source); id(context.projectId)
  if (id(raw.id) !== context.projectId || !hasKind(raw, context.kind)) throw new Error('项目标识或资源类型不匹配，未开始下载')
  return { id: context.projectId, kind: context.kind, title: text(raw.title, 256),
    description: description(raw.description ?? ''), projectUrl: resourceProjectLink(context.source, context.kind, context.projectId) }
}
function gameVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value)) throw new Error('游戏版本无效')
  return value
}
export function resourceSearchParameters(query: string, options: { kind: ResourceKind; gameVersion?: string; offset?: number }): URLSearchParams {
  resourceKind(options.kind)
  if (typeof query !== 'string' || query.length > 200 || CONTROL.test(query)) throw new Error('搜索关键词无效或过长')
  const offset = options.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new Error('无效的分页参数')
  const facets = [[`project_type:${options.kind}`]]
  if (options.kind === 'shader') facets.push(['categories:iris', 'categories:optifine'])
  if (options.gameVersion) facets.push([`versions:${gameVersion(options.gameVersion)}`])
  return new URLSearchParams({ query, facets: JSON.stringify(facets), offset: String(offset), limit: '20', index: query ? 'relevance' : 'downloads' })
}
export function resourceVersionsParameters(kind: ResourceKind, version: string): URLSearchParams {
  resourceKind(kind)
  return new URLSearchParams({ game_versions: JSON.stringify([gameVersion(version)]),
    loaders: JSON.stringify(kind === 'resourcepack' ? ['minecraft'] : ['iris', 'optifine']), include_changelog: 'false' })
}
function downloadUrl(value: unknown, source: ResourceSource): string {
  const url = new URL(text(value, 8192))
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      url.hostname !== (source === 'modrinth' ? 'cdn.modrinth.com' : 'cdn.bbsmc.net')) throw new Error('下载地址不在此来源的受支持 HTTPS CDN 内')
  return url.href
}
export function resourceFilename(value: unknown): string {
  const name = text(value, 255)
  if (new TextEncoder().encode(name).length > 255 || !/\.zip$/i.test(name) ||
      /[<>:"/\\|?*\u202a-\u202e\u2066-\u2069\ud800-\udfff\ufffd]/u.test(name) ||
      /[ .]$/.test(name) || /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) throw new Error('ZIP 文件名不安全或不可跨平台使用')
  return name
}
function dependencies(value: unknown): ResourceDependency[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('资源依赖字段无效')
  return value.map(item => {
    const raw = object(item)
    if (typeof raw.dependency_type !== 'string' || !['required', 'optional', 'incompatible', 'embedded'].includes(raw.dependency_type)) throw new Error('资源包含无法识别的依赖关系')
    return { type: raw.dependency_type as ResourceDependency['type'],
      ...(raw.project_id == null ? {} : { projectId: id(raw.project_id) }),
      ...(raw.version_id == null ? {} : { versionId: id(raw.version_id) }),
      ...(raw.file_name == null ? {} : { filename: text(raw.file_name, 255) }) }
  })
}
export function prepareResourceVersion(value: unknown, context: ResourceContext): { info: ResourceVersion; artifact?: ResourceArtifact } {
  resourceKind(context.kind); catalogSource(context.source); id(context.projectId); gameVersion(context.gameVersion)
  const raw = object(value)
  if (id(raw.project_id) !== context.projectId) throw new Error('版本所属项目不匹配，未开始下载')
  const info: ResourceVersion = { id: id(raw.id), projectId: context.projectId, name: text(raw.name, 256),
    gameVersions: strings(raw.game_versions, 1000, 80), loaders: strings(raw.loaders, 64, 40),
    projectUrl: resourceProjectLink(context.source, context.kind, context.projectId), dependencies: dependencies(raw.dependencies), externalOnly: true }
  let reason: string | undefined
  if (raw.disk_only !== undefined && typeof raw.disk_only !== 'boolean') throw new Error('下载来源字段无效')
  if (raw.disk_only) reason = '此版本只提供外部站点或网盘文件，请前往官网获取'
  else if (!info.gameVersions.includes(context.gameVersion)) reason = '此发布未声明支持当前实例的 Minecraft 版本'
  else if (context.kind === 'resourcepack' ? !info.loaders.includes('minecraft') : !info.loaders.some(loader => loader === 'iris' || loader === 'optifine')) {
    reason = context.kind === 'shader' ? '本轮仅支持 Iris / OptiFine 光影；Canvas / Vanilla 等方案请按作者说明安装' : '此版本未声明 Minecraft 资源包加载方式'
  } else if (info.dependencies.some(item => item.type === 'required' || item.type === 'incompatible')) {
    reason = '此版本声明了必需或不兼容依赖，本轮不能安全自动处理，请查看官网要求'
  }
  if (!Array.isArray(raw.files) || raw.files.length > 100) throw new Error('资源文件列表无效')
  const files = raw.files.map(object)
  if (files.some(file => typeof file.primary !== 'boolean' || (file.file_type != null && typeof file.file_type !== 'string'))) throw new Error('资源文件属性无效')
  const primaries = files.filter(file => file.primary)
  const mainZips = files.filter(file => file.file_type == null && typeof file.filename === 'string' && /\.zip$/i.test(file.filename))
  const selected = primaries.length === 1 ? primaries[0] : primaries.length === 0 && mainZips.length === 1 ? mainZips[0] : undefined
  let artifact: ResourceArtifact | undefined
  if (!reason) {
    try {
      if (!selected || selected.file_type != null) throw new Error('未找到唯一的主 ZIP 文件；附带资源包或多个候选文件需到官网选择')
      const filename = resourceFilename(selected.filename)
      const hashes = object(selected.hashes)
      if (typeof hashes.sha512 !== 'string' || !SHA512.test(hashes.sha512) ||
          (hashes.sha1 !== undefined && (typeof hashes.sha1 !== 'string' || !SHA1.test(hashes.sha1)))) throw new Error('缺少有效的 SHA-512 或提供的 SHA-1 无效')
      if (!Number.isSafeInteger(selected.size) || (selected.size as number) <= 0 || (selected.size as number) > RESOURCE_ZIP_BYTES) throw new Error('文件大小无效或超过 512 MiB 上限')
      artifact = { kind: context.kind, source: context.source, projectId: context.projectId, versionId: info.id,
        filename, url: downloadUrl(selected.url, context.source), size: selected.size as number,
        sha512: hashes.sha512.toLowerCase(), ...(typeof hashes.sha1 === 'string' ? { sha1: hashes.sha1.toLowerCase() } : {}) }
      info.filename = filename; info.size = artifact.size; info.sha512 = artifact.sha512
    } catch (error) { reason = error instanceof Error ? error.message : '文件不能安全自动下载，请前往官网获取' }
  }
  info.externalOnly = Boolean(reason)
  if (reason) info.externalReason = reason
  return { info, ...(artifact ? { artifact } : {}) }
}
export function validateResourceSelection(value: unknown): ResourceInstallInput {
  const raw = object(value)
  if (Object.keys(raw).some(key => !['kind', 'source', 'projectId', 'versionId', 'filename', 'sha512'].includes(key))) throw new Error('资源安装请求包含未知字段')
  if (typeof raw.sha512 !== 'string' || !SHA512.test(raw.sha512)) throw new Error('所选文件校验值无效')
  return { kind: resourceKind(raw.kind), source: catalogSource(raw.source), projectId: id(raw.projectId),
    versionId: id(raw.versionId), filename: resourceFilename(raw.filename), sha512: raw.sha512.toLowerCase() }
}
export function assertResourceSelection(input: ResourceInstallInput, artifact: ResourceArtifact): void {
  if (input.kind !== artifact.kind || input.source !== artifact.source || input.projectId !== artifact.projectId ||
      input.versionId !== artifact.versionId || input.filename !== artifact.filename || input.sha512 !== artifact.sha512) {
    throw new Error('所选发布文件已经变化，请重新读取版本并确认后再安装')
  }
}
export function normalizeResourceSearch(value: unknown, kind: ResourceKind, source: ResourceSource): ResourceSearchResult {
  resourceKind(kind); catalogSource(source)
  const raw = object(value)
  if (!Array.isArray(raw.hits) || raw.hits.length > 100 ||
      !['total_hits', 'offset', 'limit'].every(key => Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0) || (raw.limit as number) < 1 || (raw.limit as number) > 100) throw new Error('资源搜索结果格式无效')
  const seen = new Set<string>()
  let omittedHits = 0
  const hits = raw.hits.flatMap(value => {
    const hit = object(value), projectId = id(hit.project_id)
    if (seen.has(projectId)) throw new Error('资源搜索返回重复项目')
    seen.add(projectId)
    if (hit.project_type === undefined && hit.project_types === undefined) throw new Error('资源搜索项目缺少类型')
    if (hit.project_type !== undefined) text(hit.project_type, 40)
    if (hit.project_types !== undefined && !strings(hit.project_types, 16, 40).length && hit.project_type === undefined) throw new Error('资源搜索项目缺少类型')
    // Some providers return resourcepacks in a shader search. Omit them rather
    // than changing their type; installation still validates project metadata.
    if (!hasKind(hit, kind)) { omittedHits++; return [] }
    let icon: string | null = null
    if (hit.icon_url != null) { try { icon = downloadUrl(hit.icon_url, source) } catch { /* Untrusted image URLs do not load. */ } }
    if (!Number.isSafeInteger(hit.downloads) || (hit.downloads as number) < 0) throw new Error('资源下载统计无效')
    return [{ project_id: projectId, slug: text(hit.slug, 128), title: text(hit.title, 256), description: description(hit.description),
      icon_url: icon, author: text(hit.author, 256, true), downloads: hit.downloads as number, categories: strings(hit.categories, 100, 80), project_type: kind }]
  })
  return { hits, total_hits: raw.total_hits as number, offset: raw.offset as number, limit: raw.limit as number, ...(omittedHits ? { omittedHits } : {}) }
}
