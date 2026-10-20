import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import type { Stats } from 'node:fs'
import metadata from '../package.json'

export type ResourceKind = 'resourcepack' | 'shader'
export type ResourceSource = 'modrinth' | 'bbsmc'
export interface ResourceArtifact {
  kind: ResourceKind
  source: ResourceSource
  projectId: string
  versionId: string
  filename: string
  url: string
  size: number
  sha512: string
  sha1?: string
}
export type ResourceRegistryRecord = Omit<ResourceArtifact, 'url'> & { installedAt: string }
export interface ResourceRegistry { schema: 1; records: Record<string, ResourceRegistryRecord> }
export interface ResourceInstallResult extends Omit<ResourceArtifact, 'url'> {
  folder: 'resourcepacks' | 'shaderpacks'
  reused: boolean
  warnings: string[]
}
export interface ResourceInstallProgress {
  phase: 'download' | 'verify' | 'commit'
  completedBytes: number
  totalBytes: number
}
export interface ResourceInstallOptions {
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  onProgress?: (event: ResourceInstallProgress) => void
  rename?: typeof fs.rename
  link?: typeof fs.link
}
export class ResourceInstallRecoveryError extends Error {
  readonly code = 'RESOURCE_INSTALL_RECOVERY_REQUIRED'
  constructor(message: string, readonly stagingDirectory: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResourceInstallRecoveryError'
  }
}
export const RESOURCE_INSTALL_LIMITS = Object.freeze({
  fileBytes: 512 * 1024 * 1024, registryBytes: 1024 * 1024, directoryEntries: 5000,
  redirects: 4, downloadMs: 120_000,
})
const CDN = { modrinth: 'cdn.modrinth.com', bbsmc: 'cdn.bbsmc.net' } as const
const FOLDER = { resourcepack: 'resourcepacks', shader: 'shaderpacks' } as const
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const active = new Set<string>()
type Identity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>
interface RegistrySnapshot { registry: ResourceRegistry; bytes?: Buffer; info?: Identity }
interface OwnedFile { file: string; info: Identity }

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('资源安装已取消', 'AbortError')
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code }
function sameInode(first: Identity, second: Identity): boolean { return first.dev === second.dev && first.ino === second.ino }
function sameFile(first: Identity, second: Identity): boolean {
  return sameInode(first, second) && first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs
}
function canonical(value: string): string { return value.normalize('NFC').toLowerCase() }
function absoluteDirectory(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value) || value.length > 32768) {
    throw new Error('资源安装目录必须是有效的绝对路径')
  }
  const resolved = path.resolve(value)
  if (resolved === path.parse(resolved).root) throw new Error('不能使用文件系统根目录安装资源')
  return resolved
}
function safeFilename(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 255 ||
      !/\.zip$/i.test(value) || /[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff\ufffd]/u.test(value) ||
      /[ .]$/.test(value) || /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value)) {
    throw new Error('资源文件名必须是安全的单层 .zip 文件名')
  }
  return value
}
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('资源元数据格式无效')
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, name)!)) throw new Error('资源元数据字段无效')
  }
  return value as Record<string, unknown>
}
function downloadUrl(value: unknown, source: ResourceSource): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new Error('资源下载链接无效')
  const url = new URL(value)
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1]
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      authority?.toLowerCase() !== CDN[source] || url.hostname !== CDN[source]) {
    throw new Error('资源下载仅允许对应来源的官方 HTTPS CDN，不允许端口、凭据或其他主机')
  }
  return url.href
}
function validateArtifact(value: unknown, record = false): ResourceArtifact | ResourceRegistryRecord {
  const input = plain(value)
  const keys = ['kind', 'source', 'projectId', 'versionId', 'filename', 'size', 'sha512', ...(input.sha1 === undefined ? [] : ['sha1']), record ? 'installedAt' : 'url']
  const actual = Object.keys(input).filter(key => key !== 'sha1' || input.sha1 !== undefined)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new Error('资源元数据包含缺失或未知字段')
  if (input.kind !== 'resourcepack' && input.kind !== 'shader') throw new Error('不支持的资源类型')
  if (input.source !== 'modrinth' && input.source !== 'bbsmc') throw new Error('不支持的资源来源')
  if (typeof input.projectId !== 'string' || !ID.test(input.projectId) || typeof input.versionId !== 'string' || !ID.test(input.versionId)) {
    throw new Error('资源项目或版本标识无效')
  }
  if (typeof input.size !== 'number' || !Number.isSafeInteger(input.size) || input.size < 22 || input.size > RESOURCE_INSTALL_LIMITS.fileBytes) {
    throw new Error('资源 ZIP 大小必须在 22 字节至 512 MiB 之间')
  }
  if (typeof input.sha512 !== 'string' || !/^[a-f0-9]{128}$/i.test(input.sha512) ||
      (input.sha1 !== undefined && (typeof input.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(input.sha1)))) {
    throw new Error('资源必须包含有效 SHA-512；可选 SHA-1 也必须有效')
  }
  const common: Omit<ResourceArtifact, 'url'> = {
    kind: input.kind, source: input.source, projectId: input.projectId, versionId: input.versionId,
    filename: safeFilename(input.filename), size: input.size, sha512: input.sha512.toLowerCase(),
    ...(typeof input.sha1 === 'string' ? { sha1: input.sha1.toLowerCase() } : {}),
  }
  if (record) {
    if (typeof input.installedAt !== 'string' || !Number.isFinite(Date.parse(input.installedAt)) ||
        new Date(input.installedAt).toISOString() !== input.installedAt) throw new Error('资源登记时间无效')
    return { ...common, installedAt: input.installedAt }
  }
  return { ...common, url: downloadUrl(input.url, input.source) }
}
function registryKey(record: Pick<ResourceArtifact, 'kind' | 'source' | 'projectId'>): string {
  return record.kind + ':' + record.source + ':' + record.projectId
}
function parseRegistry(bytes: Buffer): ResourceRegistry {
  const raw = plain(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  if (Object.keys(raw).sort().join(',') !== 'records,schema' || raw.schema !== 1) throw new Error('资源登记格式版本无效')
  const entries = Object.entries(plain(raw.records))
  if (entries.length > RESOURCE_INSTALL_LIMITS.directoryEntries) throw new Error('资源登记数量超出上限')
  const records: ResourceRegistry['records'] = Object.create(null)
  for (const [key, value] of entries) {
    const record = validateArtifact(value, true) as ResourceRegistryRecord
    if (key !== registryKey(record)) throw new Error('资源登记标识与字段不一致')
    records[key] = record
  }
  return { schema: 1, records }
}

/** The only accepted symlink ancestors are macOS's fixed /tmp and /var aliases. */
async function safeDirectory(directory: string, create: boolean, signal?: AbortSignal): Promise<boolean> {
  const root = path.parse(directory).root
  let current = root
  for (const part of directory.slice(root.length).split(path.sep)) {
    check(signal)
    current = path.join(current, part)
    let info
    try { info = await fs.lstat(current) } catch (error) {
      if (code(error) !== 'ENOENT') throw error
      if (!create) { check(signal); return false }
      await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (code(error) !== 'EEXIST') throw error })
      info = await fs.lstat(current)
    }
    if (info.isSymbolicLink()) {
      const alias = process.platform === 'darwin' && current !== directory &&
        ((current === '/tmp' && await fs.realpath(current) === '/private/tmp') ||
         (current === '/var' && await fs.realpath(current) === '/private/var'))
      if (alias) continue
      throw new Error('资源目录及其祖先不能是符号链接或 junction')
    }
    if (!info.isDirectory()) throw new Error('资源路径必须是普通目录')
  }
  check(signal)
  return true
}
async function regular(file: string): Promise<Stats | undefined> {
  try {
    const info = await fs.lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('资源目标与登记必须是普通文件，不能是链接或目录')
    return info
  } catch (error) { if (code(error) === 'ENOENT') return; throw error }
}
async function registrySnapshot(file: string, signal?: AbortSignal): Promise<RegistrySnapshot> {
  check(signal)
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\u0000-\u001f\u007f]/u.test(file)) throw new Error('资源登记路径无效')
  const resolved = path.resolve(file)
  const empty = (): RegistrySnapshot => ({ registry: { schema: 1, records: Object.create(null) } })
  if (!await safeDirectory(absoluteDirectory(path.dirname(resolved)), false, signal)) return empty()
  const before = await regular(resolved)
  if (!before) return empty()
  if (before.size > RESOURCE_INSTALL_LIMITS.registryBytes) throw new Error('资源登记超过 1 MiB')
  const handle = await fs.open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('资源登记在打开期间发生变化')
    const buffer = Buffer.alloc(RESOURCE_INSTALL_LIMITS.registryBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      check(signal)
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    check(signal)
    const after = await handle.stat()
    if (offset > RESOURCE_INSTALL_LIMITS.registryBytes || offset !== after.size || !sameFile(opened, after)) {
      throw new Error('资源登记在读取期间变化或超过大小上限')
    }
    const bytes = Buffer.from(buffer.subarray(0, offset))
    return { registry: parseRegistry(bytes), bytes, info: after }
  } finally { await handle.close() }
}
export async function readResourceRegistry(file: string, signal?: AbortSignal): Promise<ResourceRegistry> {
  return (await registrySnapshot(file, signal)).registry
}
async function unchangedRegistry(file: string, expected: RegistrySnapshot, signal?: AbortSignal): Promise<void> {
  const current = await registrySnapshot(file, signal)
  if (Boolean(current.info) !== Boolean(expected.info) ||
      (current.info && expected.info && (!sameFile(current.info, expected.info) || !current.bytes!.equals(expected.bytes!)))) {
    throw new Error('资源登记已被其他操作修改，本次未覆盖，请刷新后重试')
  }
}
async function noFilenameCollision(directory: string, filename: string, signal?: AbortSignal): Promise<void> {
  if (!await safeDirectory(directory, false, signal)) return
  const dir = await fs.opendir(directory)
  let count = 0
  try {
    for (;;) {
      check(signal)
      const entry = await dir.read()
      if (!entry) break
      if (++count > RESOURCE_INSTALL_LIMITS.directoryEntries) throw new Error('资源目录条目过多，无法安全排除文件名冲突')
      if (canonical(entry.name) === canonical(filename) && entry.name !== filename) throw new Error('资源文件名与现有条目存在大小写或 Unicode 冲突')
    }
  } finally { await dir.close() }
}
function zipMagic(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
}
async function verifyFile(file: string, artifact: ResourceArtifact, signal?: AbortSignal): Promise<Identity> {
  check(signal)
  const before = await regular(file)
  if (!before || before.size !== artifact.size) throw new Error('已有资源或下载文件大小不符；不会替换不同内容')
  const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('资源文件在打开期间发生变化')
    const sha512 = createHash('sha512'), sha1 = artifact.sha1 ? createHash('sha1') : undefined
    const buffer = Buffer.alloc(256 * 1024)
    let offset = 0
    while (offset <= artifact.size) {
      check(signal)
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, artifact.size - offset + 1), offset)
      if (!bytesRead) break
      if (!offset && !zipMagic(buffer.subarray(0, bytesRead))) throw new Error('资源内容不是 ZIP，可能是验证网页或错误响应')
      offset += bytesRead
      if (offset > artifact.size) throw new Error('资源文件超过声明大小')
      sha512.update(buffer.subarray(0, bytesRead)); sha1?.update(buffer.subarray(0, bytesRead))
    }
    check(signal)
    const after = await handle.stat()
    if (offset !== artifact.size || !sameFile(opened, after)) throw new Error('资源文件在校验期间发生变化')
    if (sha512.digest('hex') !== artifact.sha512 || (sha1 && sha1.digest('hex') !== artifact.sha1)) {
      throw new Error('资源 SHA-512 / SHA-1 校验失败；不会替换不同内容')
    }
    return after
  } finally { await handle.close() }
}
async function writeNew(file: string, bytes: Buffer, owned: OwnedFile[]): Promise<void> {
  const handle = await fs.open(file, 'wx', 0o600)
  try {
    owned.push({ file, info: await handle.stat() })
    await handle.writeFile(bytes); await handle.sync()
  } finally { await handle.close() }
}
async function download(
  file: string, artifact: ResourceArtifact, owned: OwnedFile[], options: ResourceInstallOptions,
): Promise<void> {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(RESOURCE_INSTALL_LIMITS.downloadMs)])
  let url = artifact.url
  let response: Response | undefined
  for (let redirects = 0; redirects <= RESOURCE_INSTALL_LIMITS.redirects; redirects++) {
    check(signal)
    url = downloadUrl(url, artifact.source)
    response = await (options.fetch ?? globalThis.fetch)(url, {
      redirect: 'manual', signal,
      headers: { 'User-Agent': 'LuaLauncher/' + metadata.version + ' (+https://github.com/XQGGCN/lua-launcher)', Accept: 'application/zip, application/octet-stream' },
    })
    try {
      check(signal)
      if (response.url) downloadUrl(response.url, artifact.source)
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error }
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirects === RESOURCE_INSTALL_LIMITS.redirects) throw new Error('资源下载重定向过多或缺少目标')
    // Inspect a raw authority before URL normalization removes an explicit :443.
    if (/^[a-z][a-z0-9+.-]*:/i.test(location)) downloadUrl(location, artifact.source)
    else if (location.startsWith('//')) downloadUrl('https:' + location, artifact.source)
    url = downloadUrl(new URL(location, url).href, artifact.source)
    response = undefined
  }
  if (!response) throw new Error('资源下载没有返回文件')
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(response.status === 401 || response.status === 403
      ? '来源拒绝直接下载，请前往官方资源页面；启动器不会绕过登录或访问验证'
      : '资源下载失败：HTTP ' + response.status)
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (/html|json/.test(contentType)) {
    await response.body?.cancel()
    throw new Error('来源返回 HTML / JSON 验证或错误页面，不是资源 ZIP；请前往官方资源页面')
  }
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== artifact.size)) {
    await response.body?.cancel()
    throw new Error('资源响应大小与元数据不符')
  }
  if (!response.body) throw new Error('资源下载响应没有内容')
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  let completed = 0
  try {
    check(signal)
    handle = await fs.open(file, 'wx', 0o600)
    owned.push({ file, info: await handle.stat() })
    options.onProgress?.({ phase: 'download', completedBytes: 0, totalBytes: artifact.size })
    for (;;) {
      check(signal)
      const { value, done } = await reader.read()
      check(signal)
      if (done) break
      completed += value.byteLength
      if (completed > artifact.size) throw new Error('资源下载超过声明大小')
      await handle.writeFile(value)
      options.onProgress?.({ phase: 'download', completedBytes: completed, totalBytes: artifact.size })
    }
    if (completed !== artifact.size) throw new Error('资源下载不完整，大小与元数据不符')
    await handle.sync()
    check(signal)
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    await handle?.close()
  }
}
async function cleanStage(directory: string, identity: Identity, owned: OwnedFile[], root: string, rootIdentity: Identity): Promise<void> {
  if (!await safeDirectory(root, false) || !sameInode(rootIdentity, await fs.lstat(root))) throw new Error('实例目录已变化，保留暂存文件')
  const current = await fs.lstat(directory).catch(error => { if (code(error) === 'ENOENT') return undefined; throw error })
  if (!current) return
  if (!current.isDirectory() || current.isSymbolicLink() || !sameInode(identity, current)) throw new Error('暂存目录已变化，未清理其他文件')
  for (const item of [...owned].reverse()) {
    const info = await regular(item.file)
    if (!info) continue
    if (!sameInode(item.info, info)) throw new Error('暂存文件已被替换，未删除其他文件')
    await fs.unlink(item.file)
  }
  await fs.rmdir(directory)
}

/** Download ZIP bytes without extraction or activation; the registry rename is the commit boundary. */
export async function installResourceZip(
  instanceDirectory: string, input: ResourceArtifact, options: ResourceInstallOptions = {},
): Promise<ResourceInstallResult> {
  check(options.signal)
  let artifact = validateArtifact(input) as ResourceArtifact
  const root = absoluteDirectory(instanceDirectory)
  if (active.has(root)) throw new Error('此实例已有资源安装正在进行')
  active.add(root)
  const folder = FOLDER[artifact.kind]
  const game = path.join(root, 'game'), destinationDirectory = path.join(game, folder)
  const destination = path.join(destinationDirectory, artifact.filename)
  const registryFile = path.join(root, 'managed-resources.json')
  const staging = path.join(root, '.resource-staging-' + randomUUID())
  const payload = path.join(staging, 'payload.zip'), ledgerFile = path.join(staging, 'registry.json')
  const owned: OwnedFile[] = []
  let stageIdentity: Identity | undefined, rootIdentity: Identity | undefined, targetIdentity: Identity | undefined
  let linked = false, linkAttempted = false, payloadIdentity: Identity | undefined, committed = false
  const warnings: string[] = []
  let reused = false
  try {
    if (!await safeDirectory(root, false, options.signal)) throw new Error('实例目录不存在')
    rootIdentity = await fs.lstat(root)
    await safeDirectory(destinationDirectory, false, options.signal)
    let folderIdentity = await fs.lstat(destinationDirectory).catch(error => { if (code(error) === 'ENOENT') return undefined; throw error })
    const original = await registrySnapshot(registryFile, options.signal)
    const key = registryKey(artifact), previous = original.registry.records[key]
    if (previous && previous.versionId !== artifact.versionId) throw new Error('暂不支持更新其他版本；已有资源与登记均保留')
    if (previous && (previous.filename !== artifact.filename || previous.size !== artifact.size || previous.sha512 !== artifact.sha512 ||
        (previous.sha1 && artifact.sha1 && previous.sha1 !== artifact.sha1))) throw new Error('此版本的文件元数据与原登记不同，不会替换已有资源')
    if (previous?.sha1 && !artifact.sha1) artifact = { ...artifact, sha1: previous.sha1 }
    for (const [otherKey, record] of Object.entries(original.registry.records)) {
      if (otherKey !== key && record.kind === artifact.kind && canonical(record.filename) === canonical(artifact.filename)) {
        throw new Error('该文件名已由其他项目或来源登记，请先人工处理冲突')
      }
    }
    await noFilenameCollision(destinationDirectory, artifact.filename, options.signal)
    const existing = await regular(destination)
    if (existing) {
      options.onProgress?.({ phase: 'verify', completedBytes: artifact.size, totalBytes: artifact.size })
      targetIdentity = await verifyFile(destination, artifact, options.signal)
      reused = true
    }
    const { url: _url, ...fields } = artifact
    const record: ResourceRegistryRecord = { ...fields, installedAt: previous?.installedAt ?? new Date().toISOString() }
    const registry: ResourceRegistry = { schema: 1, records: { ...original.registry.records, [key]: record } }
    const registryBytes = Buffer.from(JSON.stringify(registry, null, 2))
    if (registryBytes.length > RESOURCE_INSTALL_LIMITS.registryBytes) throw new Error('新增登记后超过 1 MiB，安装未进行')
    const sameRecord = previous && JSON.stringify(previous) === JSON.stringify(record)
    const ensureDirectories = async () => {
      if (!await safeDirectory(root, false, options.signal) || !sameInode(rootIdentity!, await fs.lstat(root))) throw new Error('实例目录在安装期间被替换')
      await safeDirectory(destinationDirectory, false, options.signal)
      if (folderIdentity && !sameInode(folderIdentity, await fs.lstat(destinationDirectory))) throw new Error('资源目录在安装期间被替换')
    }
    if (reused && sameRecord) {
      options.onProgress?.({ phase: 'commit', completedBytes: artifact.size, totalBytes: artifact.size })
      await ensureDirectories()
      const current = await regular(destination)
      if (!current || !sameFile(targetIdentity!, current)) throw new Error('资源文件已被其他操作修改，请重试')
      await unchangedRegistry(registryFile, original, options.signal)
      check(options.signal)
      return { ...fields, folder, reused, warnings }
    }
    check(options.signal)
    await fs.mkdir(staging, { mode: 0o700 })
    stageIdentity = await fs.lstat(staging)
    if (!(stageIdentity as Stats).isDirectory() || (stageIdentity as Stats).isSymbolicLink()) throw new Error('资源暂存目录不安全')
    if (original.bytes) await writeNew(path.join(staging, 'previous-registry.json'), original.bytes, owned)
    await writeNew(path.join(staging, 'recovery.json'), Buffer.from(JSON.stringify({
      schema: 1, destination: 'game/' + folder + '/' + artifact.filename,
      registryPreviouslyExisted: Boolean(original.info), artifact: fields,
    }, null, 2)), owned)
    if (!reused) {
      await download(payload, artifact, owned, options)
      options.onProgress?.({ phase: 'verify', completedBytes: artifact.size, totalBytes: artifact.size })
      payloadIdentity = await verifyFile(payload, artifact, options.signal)
    }
    await writeNew(ledgerFile, registryBytes, owned)
    await ensureDirectories()
    await safeDirectory(destinationDirectory, true, options.signal)
    folderIdentity ??= await fs.lstat(destinationDirectory)
    await noFilenameCollision(destinationDirectory, artifact.filename, options.signal)
    await unchangedRegistry(registryFile, original, options.signal)
    options.onProgress?.({ phase: 'commit', completedBytes: artifact.size, totalBytes: artifact.size })
    check(options.signal)
    if (!reused) {
      const currentPayload = await regular(payload)
      if (!currentPayload || !sameFile(payloadIdentity!, currentPayload)) throw new Error('暂存资源在提交前发生变化')
      linkAttempted = true
      await (options.link ?? fs.link)(payload, destination)
      linked = true
      targetIdentity = await verifyFile(destination, artifact, options.signal)
      if (!sameInode(payloadIdentity!, targetIdentity)) throw new Error('资源目标在提交期间被替换')
    } else {
      const current = await regular(destination)
      if (!current || !sameFile(targetIdentity!, current)) throw new Error('已有资源在提交前发生变化，未覆盖原文件')
    }
    await ensureDirectories()
    const finalTarget = await regular(destination)
    if (!finalTarget || !sameFile(targetIdentity!, finalTarget)) throw new Error('资源目标在登记前发生变化')
    const candidate = await registrySnapshot(ledgerFile, options.signal)
    const ledgerIdentity = owned.find(item => item.file === ledgerFile)!.info
    if (!candidate.info || !sameInode(ledgerIdentity, candidate.info) || !candidate.bytes?.equals(registryBytes)) {
      throw new Error('暂存登记在提交前被修改，未发布该登记')
    }
    await unchangedRegistry(registryFile, original, options.signal)
    check(options.signal)
    await (options.rename ?? fs.rename)(ledgerFile, registryFile)
    committed = true
    try { await cleanStage(staging, stageIdentity, owned, root, rootIdentity) }
    catch { warnings.push('资源和来源登记已提交，但暂存目录清理失败；请保留该目录以便检查：' + staging) }
    return { ...fields, folder, reused, warnings }
  } catch (error) {
    if (!committed && stageIdentity && rootIdentity) {
      try {
        if (linked || linkAttempted) {
          if (!await safeDirectory(destinationDirectory, false) ||
              !sameInode(rootIdentity, await fs.lstat(root))) throw new Error('回滚时实例目录已变化')
          const current = await regular(destination)
          if (current && payloadIdentity && sameInode(payloadIdentity, current)) {
            if (targetIdentity && !sameFile(targetIdentity, current)) throw new Error('回滚时新资源已被其他操作修改')
            if (!targetIdentity && (current.size !== payloadIdentity.size || current.mtimeMs !== payloadIdentity.mtimeMs)) {
              throw new Error('回滚时新资源的内容可能已被其他操作修改')
            }
            await fs.unlink(destination)
          } else if (linked && current) throw new Error('回滚时目标已由其他文件替换，未删除该文件')
        }
        await cleanStage(staging, stageIdentity, owned, root, rootIdentity)
      } catch (rollbackError) {
        throw new ResourceInstallRecoveryError('资源安装未完成且无法安全回滚；暂存资料已保留，请检查实例后再重试', staging, {
          cause: new AggregateError([error, rollbackError], '资源安装和回滚失败'),
        })
      }
    }
    throw error
  } finally { active.delete(root) }
}
