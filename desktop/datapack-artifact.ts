import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeDatapackVersions } from './datapack-catalog'
import type { DatapackArtifactSelection } from './datapack-install-plan-types'
export type { DatapackArtifactSelection } from './datapack-install-plan-types'

/** Private main-process artifact: never return this object over IPC. */
export interface ModrinthDatapackArtifact extends DatapackArtifactSelection { source: 'modrinth'; url: string }
export interface DatapackArtifactResolveOptions {
  gameVersion: string
  fetch?: typeof fetch
  signal?: AbortSignal
  userAgent?: string
  /** Internal test budgets; never accepted from renderer input. */
  timeoutMs?: number
  headersTimeoutMs?: number
  idleTimeoutMs?: number
}
export interface DatapackArtifactDownloadOptions extends Omit<DatapackArtifactResolveOptions, 'gameVersion'> {
  onProgress?: (completedBytes: number, totalBytes: number) => void
}
export interface DownloadedDatapackSource {
  file: string
  filename: string
  archiveBytes: number
  sha512: string
  sha1?: string
}
export class DatapackArtifactError extends Error {
  constructor(message: string) { super(message); this.name = 'DatapackArtifactError' }
}
export const DATAPACK_ARTIFACT_LIMITS = Object.freeze({
  metadataBytes: 2 * 1024 ** 2, archiveBytes: 512 * 1024 ** 2,
  metadataMs: 20000, downloadMs: 120000, headersMs: 10000, idleMs: 8000,
  cleanupMs: 200, redirects: 3, sourceDirectories: 256, jsonDepth: 32, jsonNodes: 100000,
})
type NetworkOptions = Omit<DatapackArtifactResolveOptions, 'gameVersion'>
const API = 'api.modrinth.com', CDN = 'cdn.modrinth.com'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const GAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/
function fail(message: string): never { throw new DatapackArtifactError(message) }
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) fail('数据包文件声明无效')
  return value as Record<string, unknown>
}
function filename(value: unknown): string {
  if (typeof value !== 'string' || !value || !/\.zip$/i.test(value) || Buffer.byteLength(value) > 255 ||
      /[<>:"/\\|?*\p{Cc}\p{Cf}\ud800-\udfff\ufffd]/u.test(value) || /[ .]$/.test(value) ||
      /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value)) fail('数据包主文件名不受支持')
  return value
}
function selection(input: unknown, privateArtifact = false): DatapackArtifactSelection {
  const raw = plain(input), keys = ['projectId', 'versionId', 'filename', 'size', 'sha512', ...(raw.sha1 === undefined ? [] : ['sha1']), ...(privateArtifact ? ['source', 'url'] : [])]
  if (Object.keys(raw).filter(key => key !== 'sha1' || raw.sha1 !== undefined).sort().join(',') !== keys.sort().join(',')) fail('数据包文件选择包含缺失或未知字段')
  if (typeof raw.projectId !== 'string' || !ID.test(raw.projectId) || typeof raw.versionId !== 'string' || !ID.test(raw.versionId) ||
      !Number.isSafeInteger(raw.size) || Number(raw.size) < 22 || Number(raw.size) > DATAPACK_ARTIFACT_LIMITS.archiveBytes ||
      typeof raw.sha512 !== 'string' || !/^[a-f0-9]{128}$/i.test(raw.sha512) ||
      raw.sha1 !== undefined && (typeof raw.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(raw.sha1))) fail('数据包文件选择无效或超过范围')
  return { projectId: raw.projectId, versionId: raw.versionId, filename: filename(raw.filename), size: Number(raw.size), sha512: raw.sha512.toLowerCase(),
    ...(typeof raw.sha1 === 'string' ? { sha1: raw.sha1.toLowerCase() } : {}) }
}
function allowedUrl(value: unknown, host: string, metadata = false): URL {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\p{Cc}\p{Cf}]/u.test(value)) fail('数据包地址不受支持')
  let url: URL
  try { url = new URL(value) } catch { return fail('数据包地址不受支持') }
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1]
  if (url.protocol !== 'https:' || url.hostname !== host || authority?.toLowerCase() !== host || url.port || url.username || url.password || url.hash ||
      metadata && !url.pathname.startsWith('/v2/')) fail('数据包地址不属于受支持的官方 HTTPS 来源')
  return url
}
function agent(options: NetworkOptions): string {
  const value = options.userAgent ?? 'LuaLauncher/datapack-install (+https://github.com/XQGGCN/lua-launcher)'
  if (!value.trim() || value.length > 512 || /[\p{Cc}\p{Cf}]/u.test(value)) fail('请求标识无效')
  return value
}
function milliseconds(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('请求时间预算无效')
  return value
}
function waitFor<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  if (signal.aborted) { void promise.then(value => late?.(value), () => {}); return Promise.reject(signal.reason) }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const abort = () => { settled = true; signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { if (settled) late?.(value); else { settled = true; signal.removeEventListener('abort', abort); resolve(value) } }, error => {
      if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(error) }
    })
  })
}
async function cleanup(work: () => Promise<unknown> | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([Promise.resolve().then(work).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, DATAPACK_ARTIFACT_LIMITS.cleanupMs) })]) }
  finally { if (timer) clearTimeout(timer) }
}
async function operation<T>(options: NetworkOptions, maximum: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  agent(options)
  const timeout = milliseconds(options.timeoutMs, maximum), controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason ?? new DOMException('数据包准备已取消', 'AbortError'))
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new DatapackArtifactError('数据包请求超时，请重试')), timeout)
  try { controller.signal.throwIfAborted(); return await work(controller.signal) }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
}
async function responseFor(input: URL, host: string, options: NetworkOptions, signal: AbortSignal, metadata = false): Promise<Response> {
  let url = allowedUrl(input.href, host, metadata)
  const fetcher = options.fetch ?? fetch
  for (let hop = 0; hop <= DATAPACK_ARTIFACT_LIMITS.redirects; hop++) {
    signal.throwIfAborted()
    const header = new AbortController(), combined = AbortSignal.any([signal, header.signal])
    const timer = setTimeout(() => header.abort(new DatapackArtifactError('数据包响应等待超时')), milliseconds(options.headersTimeoutMs, DATAPACK_ARTIFACT_LIMITS.headersMs))
    let response: Response
    try {
      response = await waitFor(Promise.resolve().then(() => fetcher(url.href, { method: 'GET', redirect: 'manual',
        headers: { Accept: metadata ? 'application/json' : 'application/zip, application/octet-stream', 'User-Agent': agent(options) }, signal: combined })), combined,
      late => { void cleanup(() => late.body?.cancel()) })
    } catch (error) { if (combined.aborted) throw combined.reason; throw new DatapackArtifactError('无法连接数据包来源，请检查网络后重试') }
    finally { clearTimeout(timer) }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await cleanup(() => response.body?.cancel())
      if (hop === DATAPACK_ARTIFACT_LIMITS.redirects || !response.headers.get('location')) fail('数据包重定向超过范围')
      url = allowedUrl(new URL(response.headers.get('location')!, url).href, host, metadata); continue
    }
    if (!response.ok) { await cleanup(() => response.body?.cancel()); fail(`数据包请求失败（HTTP ${response.status}）`) }
    return response
  }
  return fail('数据包重定向未完成')
}
async function readBody(response: Response, maximum: number, options: NetworkOptions, signal: AbortSignal,
  consume: (part: Uint8Array) => Promise<void>): Promise<number> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await cleanup(() => response.body?.cancel()); fail('数据包响应大小超过范围')
  }
  if (!response.body) fail('数据包响应没有内容')
  const reader = response.body.getReader()
  let size = 0, empty = 0, complete = false
  try {
    while (true) {
      signal.throwIfAborted()
      const idle = new AbortController(), timer = setTimeout(() => idle.abort(new DatapackArtifactError('数据包传输停滞，请重试')), milliseconds(options.idleTimeoutMs, DATAPACK_ARTIFACT_LIMITS.idleMs))
      let part: ReadableStreamReadResult<Uint8Array>
      try { part = await waitFor(reader.read(), AbortSignal.any([signal, idle.signal])) } finally { clearTimeout(timer) }
      if (part.done) { complete = true; break }
      if (!(part.value instanceof Uint8Array)) fail('数据包流格式无效')
      if (!part.value.byteLength) { if (++empty > 8) fail('数据包传输没有取得进展'); continue }
      empty = 0; size += part.value.byteLength
      if (size > maximum) fail('数据包实际响应超过大小范围')
      await consume(part.value); signal.throwIfAborted()
    }
    signal.throwIfAborted()
    // fetch decodes a compressed response body while Content-Length still
    // describes wire bytes. The actual decoded budget always applies.
    if (declared !== null && identityEncoding(response) && size !== Number(declared)) fail('数据包响应长度不完整')
    return size
  } finally {
    if (!complete) await cleanup(() => reader.cancel())
    try { reader.releaseLock() } catch { /* Uncooperative streams cannot retain this operation forever. */ }
  }
}
function identityEncoding(response: Response): boolean {
  const value = response.headers.get('content-encoding')
  return value === null || value.trim().toLowerCase() === 'identity'
}
function shape(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth > DATAPACK_ARTIFACT_LIMITS.jsonDepth || ++budget.nodes > DATAPACK_ARTIFACT_LIMITS.jsonNodes) fail('数据包元数据结构超过范围')
  if (value && typeof value === 'object') for (const child of Object.values(value)) shape(child, depth + 1, budget)
}
async function jsonRequest(url: URL, options: NetworkOptions, signal: AbortSignal): Promise<unknown> {
  const response = await responseFor(url, API, options, signal, true)
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await cleanup(() => response.body?.cancel()); fail('数据包来源返回的不是 JSON 元数据')
  }
  const chunks: Uint8Array[] = []
  await readBody(response, DATAPACK_ARTIFACT_LIMITS.metadataBytes, options, signal, async part => { chunks.push(Buffer.from(part)) })
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { return fail('数据包元数据无法解析') }
  shape(value); return value
}

/** Re-fetch exact metadata; neither a renderer URL nor a stale discovery DTO authorizes bytes. */
export async function resolveDatapackArtifact(input: DatapackArtifactSelection, options: DatapackArtifactResolveOptions): Promise<ModrinthDatapackArtifact> {
  const selected = selection(input)
  if (typeof options.gameVersion !== 'string' || !GAME.test(options.gameVersion)) fail('游戏版本无效')
  return operation(options, DATAPACK_ARTIFACT_LIMITS.metadataMs, async signal => {
    const project = await jsonRequest(new URL(`/v2/project/${encodeURIComponent(selected.projectId)}`, `https://${API}`), options, signal)
    if (plain(project).id !== selected.projectId) fail('项目已变化，请重新选择')
    const raw = await jsonRequest(new URL(`/v2/version/${encodeURIComponent(selected.versionId)}`, `https://${API}`), options, signal)
    const normalized = normalizeDatapackVersions(project, [raw], selected.projectId, options.gameVersion)
    const version = normalized.versions[0], main = version?.mainFile
    if (!version || normalized.omittedVersions || version.id !== selected.versionId || version.externalOnly || !main || !main.eligible || main.role !== 'main') fail('此版本的文件、依赖或交付方式不再符合安装条件，请重新查看作者说明')
    if (main.filename !== selected.filename || main.size !== selected.size || main.sha512 !== selected.sha512 || main.sha1 !== selected.sha1) fail('站点主文件声明已变化，请刷新后重新选择')
    const rawFiles = plain(raw).files
    if (!Array.isArray(rawFiles)) fail('主文件地址缺失')
    const found = rawFiles.filter(file => plain(file).filename === selected.filename)
    if (found.length !== 1) fail('主文件声明不唯一')
    const url = allowedUrl(plain(found[0]).url, CDN)
    return { ...selected, source: 'modrinth', url: url.href }
  })
}

function sameNode(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode }
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
}
type Chain = Map<string, BigIntStats>
async function chain(directory: string, signal: AbortSignal): Promise<Chain> {
  if (!path.isAbsolute(directory) || directory !== path.resolve(directory) || directory === path.parse(directory).root || directory.length > 32768 || /[\p{Cc}\p{Cf}]/u.test(directory)) fail('数据包准备目录无效')
  let current = path.parse(directory).root
  const result: Chain = new Map()
  for (const segment of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, segment); signal.throwIfAborted()
    const info = await fs.lstat(current, { bigint: true }); signal.throwIfAborted()
    if (info.isSymbolicLink()) {
      const allowed = process.platform === 'darwin' && current !== directory &&
        ((current === '/tmp' && await fs.realpath(current) === '/private/tmp') || (current === '/var' && await fs.realpath(current) === '/private/var'))
      if (!allowed) fail('数据包准备目录或祖先包含链接')
    } else if (!info.isDirectory()) fail('数据包准备目录必须是普通目录')
    result.set(current, info)
  }
  return result
}
async function verifyChain(expected: Chain, signal: AbortSignal): Promise<void> {
  const last = [...expected.keys()].at(-1)
  if (!last) fail('数据包准备目录无效')
  const actual = await chain(last!, signal)
  for (const [name, info] of expected) if (!actual.has(name) || !sameNode(info, actual.get(name)!)) fail('数据包准备目录已变化')
}
async function makeChild(parent: string, name: string, parentChain: Chain, signal: AbortSignal, existing: boolean): Promise<Chain> {
  await verifyChain(parentChain, signal)
  const child = path.join(parent, name)
  try { await fs.mkdir(child, { mode: 0o700 }) } catch (error) { if (!existing || errno(error) !== 'EEXIST') throw error }
  await verifyChain(parentChain, signal)
  const result = await chain(child, signal)
  return result
}
async function boundedNames(directory: string, signal: AbortSignal): Promise<void> {
  const handle = await fs.opendir(directory)
  let count = 0
  try { while (true) { signal.throwIfAborted(); const entry = await handle.read(); if (!entry) break; if (++count >= DATAPACK_ARTIFACT_LIMITS.sourceDirectories) fail('数据包准备资料较多，请先保留并检查旧资料') } }
  finally { await handle.close() }
}
async function writeAll(file: fs.FileHandle, bytes: Uint8Array, position: number, signal: AbortSignal): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    signal.throwIfAborted()
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, position + offset)
    signal.throwIfAborted()
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) fail('数据包文件写入没有取得进展')
    offset += bytesWritten
  }
}
async function diskHash(file: string, expected: BigIntStats, signal: AbortSignal): Promise<{ size: number; sha512: string; sha1: string }> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || !sameFile(before, expected) || !sameFile(before, await fs.lstat(file, { bigint: true }))) fail('数据包暂存文件已变化')
    const sha512 = createHash('sha512'), sha1 = createHash('sha1'), buffer = Buffer.alloc(1024 * 1024)
    let size = 0
    while (true) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size)
      signal.throwIfAborted()
      if (!bytesRead) break
      size += bytesRead
      if (size > DATAPACK_ARTIFACT_LIMITS.archiveBytes) fail('数据包磁盘文件超过范围')
      sha512.update(buffer.subarray(0, bytesRead)); sha1.update(buffer.subarray(0, bytesRead))
    }
    if (!sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await fs.lstat(file, { bigint: true }))) fail('数据包磁盘校验期间发生变化')
    return { size, sha512: sha512.digest('hex'), sha1: sha1.digest('hex') }
  } finally { await handle.close() }
}

/** Unique private retained source preparation, outside saves and install journals. */
export async function downloadDatapackArtifact(instanceDirectory: string, artifactInput: ModrinthDatapackArtifact,
  options: DatapackArtifactDownloadOptions = {}): Promise<DownloadedDatapackSource> {
  const artifact = selection(artifactInput, true), raw = plain(artifactInput)
  if (raw.source !== 'modrinth') fail('数据包下载来源无效')
  const url = allowedUrl(raw.url, CDN)
  return operation(options, DATAPACK_ARTIFACT_LIMITS.downloadMs, async signal => {
    const original = await chain(instanceDirectory, signal)
    const sourceRoot = path.join(instanceDirectory, '.datapack-sources')
    const sourceChain = await makeChild(instanceDirectory, '.datapack-sources', original, signal, true)
    await boundedNames(sourceRoot, signal)
    const stageId = randomUUID(), stage = path.join(sourceRoot, stageId)
    const stageChain = await makeChild(sourceRoot, stageId, sourceChain, signal, false)
    const file = path.join(stage, 'payload.zip')
    await verifyChain(stageChain, signal)
    const handle = await fs.open(file, 'wx', 0o600)
    let expected: BigIntStats
    try {
      const initial = await handle.stat({ bigint: true })
      if (!initial.isFile() || initial.nlink !== 1n) fail('数据包暂存文件无效')
      const response = await responseFor(url, CDN, options, signal)
      const declared = response.headers.get('content-length')
      if (declared !== null && (!/^\d+$/.test(declared) || identityEncoding(response) && Number(declared) !== artifact.size)) {
        await cleanup(() => response.body?.cancel()); fail('数据包响应长度与确认声明不一致')
      }
      const sha512 = createHash('sha512'), sha1 = createHash('sha1')
      let position = 0
      const size = await readBody(response, artifact.size, options, signal, async part => {
        await writeAll(handle, part, position, signal)
        sha512.update(part); sha1.update(part); position += part.byteLength
        try { options.onProgress?.(position, artifact.size) } catch { /* Observers cannot affect the write outcome. */ }
      })
      if (size !== artifact.size || sha512.digest('hex') !== artifact.sha512 || (artifact.sha1 && sha1.digest('hex') !== artifact.sha1)) fail('数据包传输校验失败')
      await handle.sync(); signal.throwIfAborted()
      expected = await handle.stat({ bigint: true })
      if (!sameNode(initial, expected) || expected.nlink !== 1n || Number(expected.size) !== artifact.size || !sameFile(expected, await fs.lstat(file, { bigint: true }))) fail('数据包写入后的文件身份或大小不符')
    } finally { await handle.close() }
    await verifyChain(stageChain, signal)
    const checked = await diskHash(file, expected!, signal)
    if (checked.size !== artifact.size || checked.sha512 !== artifact.sha512 || artifact.sha1 && checked.sha1 !== artifact.sha1) fail('数据包独立磁盘校验失败')
    await verifyChain(stageChain, signal)
    return { file, filename: artifact.filename, archiveBytes: checked.size, sha512: checked.sha512, ...(artifact.sha1 ? { sha1: checked.sha1 } : {}) }
  })
}
