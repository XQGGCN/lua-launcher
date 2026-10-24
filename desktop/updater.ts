import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
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

const MAX_UPDATE_BYTES = 1024 ** 3
const IO_CHUNK_BYTES = 1024 ** 2
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_IDLE_TIMEOUT_MS = 30_000
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
const verifiedDownloads = new Map<string, { size: number; sha256: string }>()
type Checksum = { size: number; sha256: string }
interface FileProof extends Checksum { stat: BigIntStats }

export class UpdateFileError extends Error {
  constructor(message: string) { super(message); this.name = 'UpdateFileError' }
}
export class UpdateRecoveryError extends UpdateFileError {
  readonly code = 'RECOVERY_REQUIRED'
  constructor() { super('无法确认更新文件的替换状态；原文件恢复资料已保留，请检查后再重启启动器'); this.name = 'UpdateRecoveryError' }
}
function fail(message: string): never { throw new UpdateFileError(message) }
function validChecksum(value: Checksum): boolean {
  return Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_UPDATE_BYTES && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)
}
function safeAssetName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(value) && !/[.]$/.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)
}
function trustedUrl(value: string, initial = false, name?: string): URL {
  let url: URL
  try { url = new URL(value) } catch { return fail('更新下载地址不受信任') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) fail('更新下载地址不受信任')
  if (initial) {
    const match = /^\/XQGGCN\/lua-launcher\/releases\/download\/(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/([^/]+)$/.exec(url.pathname)
    let filename = ''
    try { filename = decodeURIComponent(match?.[2] ?? '') } catch { /* rejected below */ }
    if (url.hostname !== 'github.com' || !match || filename !== name || url.search || url.hash) fail('更新下载地址不受信任')
  }
  return url
}
const sameObject = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
const sameSnapshot = (a: BigIntStats, b: BigIntStats) => sameObject(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

async function directory(directory: string, create = false): Promise<string> {
  if (!path.isAbsolute(directory)) fail('更新目录必须是本机绝对路径')
  if (directory.split(path.sep).some(part => part === '.' || part === '..')) fail('更新目录不符合安全条件')
  // Resolve only macOS's fixed system temp aliases, not arbitrary ancestor links.
  if (process.platform === 'darwin') for (const [alias, actual] of [['/var', '/private/var'], ['/tmp', '/private/tmp']]) {
    if (directory === alias || directory.startsWith(`${alias}/`)) {
      if (await fs.realpath(alias) !== actual) fail('更新目录不符合安全条件')
      directory = actual + directory.slice(alias.length); break
    }
  }
  let current = path.parse(directory).root
  for (const part of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let info: BigIntStats
    try { info = await fs.lstat(current, { bigint: true }) }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await fs.mkdir(current, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      info = await fs.lstat(current, { bigint: true })
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('更新目录不符合安全条件')
  }
  return directory
}
async function assertDirectory(value: string, identity: BigIntStats): Promise<void> {
  await directory(value)
  const current = await fs.lstat(value, { bigint: true })
  if (!sameObject(current, identity) || !current.isDirectory()) fail('更新期间目录已变化，未继续写入')
}
async function fileSnapshot(file: string, expected?: Checksum, signal?: AbortSignal): Promise<FileProof> {
  await directory(path.dirname(file)); signal?.throwIfAborted()
  const linked = await fs.lstat(file, { bigint: true })
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink < 1n || linked.nlink > 2n || linked.size <= 0n || linked.size > BigInt(MAX_UPDATE_BYTES)) fail('更新文件不符合安全条件')
  const handle = await fs.open(file, readFlags), hash = createHash('sha256')
  try {
    const before = await handle.stat({ bigint: true })
    if (!sameSnapshot(linked, before) || !before.isFile()) fail('更新文件已变化，请重新下载')
    const size = Number(before.size), buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES)
    if (expected && (!validChecksum(expected) || size !== expected.size)) fail('更新文件大小与发布信息不符')
    for (let position = 0; position < size;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position)
      if (!bytesRead) fail('更新文件提前结束，请重新下载')
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead
    }
    if ((await handle.read(buffer, 0, 1, size)).bytesRead) fail('更新文件在验证期间发生变化')
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true })
    if (!sameSnapshot(before, after) || !sameSnapshot(before, current) || current.isSymbolicLink()) fail('更新文件在验证期间发生变化')
    const sha256 = hash.digest('hex')
    if (expected && sha256 !== expected.sha256) fail('更新文件校验失败，未使用此文件')
    return { size, sha256, stat: after }
  } finally { await handle.close() }
}
async function writeAll(handle: fs.FileHandle, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  for (let offset = 0; offset < bytes.length;) {
    signal?.throwIfAborted()
    const length = Math.min(IO_CHUNK_BYTES, bytes.length - offset)
    const { bytesWritten } = await handle.write(bytes, offset, length, null)
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > length) fail('无法完整写入更新文件，请检查磁盘空间')
    offset += bytesWritten
  }
}
function waitFor<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  if (signal.aborted) { void promise.then(value => late?.(value), () => {}); return Promise.reject(signal.reason) }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const abort = () => { settled = true; reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(value => { signal.removeEventListener('abort', abort); if (settled) late?.(value); else { settled = true; resolve(value) } }, error => {
      signal.removeEventListener('abort', abort); if (!settled) { settled = true; reject(error) }
    })
  })
}
async function timed<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined, milliseconds: number, late?: (value: T) => void): Promise<T> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new DOMException('更新网络操作超时，请检查网络后重试', 'TimeoutError')), milliseconds)
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  try { return await waitFor(operation(combined), combined, late) }
  finally { clearTimeout(timer) }
}
async function cancelBody(body?: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body || body.locked) return
  await timed(() => body.cancel().catch(() => {}), undefined, 1000).catch(() => {})
}
async function closeReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): Promise<void> {
  await timed(() => reader.cancel(reason).catch(() => {}), undefined, 1000).catch(() => {})
  reader.releaseLock()
}
function observe(callback: ((received: number, total: number) => void) | undefined, received: number, total: number): void {
  try { void Promise.resolve(callback?.(received, total)).catch(() => {}) } catch { /* Observers do not own the transaction. */ }
}

/**
 * Each operation owns a random private directory. Return only after a separate disk
 * read proves the full size/SHA256. Failed files remain isolated; no shared path is
 * truncated, overwritten or deleted. OS file calls settle before cancellation returns.
 */
export async function downloadUpdate(asset: UpdateAsset, base: string, options: { fetch?: typeof fetch; signal?: AbortSignal; onProgress?: (received: number, total: number) => void; timeoutMs?: number; idleTimeoutMs?: number } = {}): Promise<string> {
  if (!asset || !safeAssetName(asset.name) || !validChecksum(asset)) fail('更新文件信息无效')
  const descriptor = { ...asset }
  trustedUrl(descriptor.url, true, descriptor.name)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS, idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  if (![timeoutMs, idleTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= DEFAULT_TIMEOUT_MS)) fail('更新超时设置无效')
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  signal.throwIfAborted()
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, output: fs.FileHandle | undefined
  try {
    base = await directory(base, true)
    const owned = await fs.mkdtemp(path.join(base, 'update-'))
    await fs.chmod(owned, 0o700)
    const owner = await fs.lstat(owned, { bigint: true })
    const partial = path.join(owned, 'payload.partial'), target = path.join(owned, descriptor.name)
    let current = descriptor.url
    for (let redirects = 0; redirects <= 5; redirects++) {
      trustedUrl(current)
      response = await timed(requestSignal => (options.fetch ?? fetch)(current, { redirect: 'manual', signal: requestSignal, headers: { 'User-Agent': 'LuaLauncher-Updater' } }), signal, idleTimeoutMs,
        value => { void cancelBody(value.body) })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      await cancelBody(response.body); response = undefined
      if (!location || redirects === 5) fail('更新下载重定向无效')
      try { current = new URL(location, current).href } catch { fail('更新下载重定向无效') }
    }
    if (!response || response.status !== 200 || !response.body) fail(`更新下载失败${response ? `（HTTP ${response.status}）` : ''}`)
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== descriptor.size)) fail('更新文件大小与发布信息不符')
    await assertDirectory(owned, owner)
    output = await fs.open(partial, 'wx', 0o600)
    reader = response.body.getReader()
    const hash = createHash('sha256')
    let received = 0, emptyChunks = 0
    for (;;) {
      const step = await timed(() => reader!.read(), signal, idleTimeoutMs)
      if (step.done) break
      const value = step.value
      if (!(value instanceof Uint8Array) || value.length > descriptor.size - received) fail('更新文件大小与发布信息不符')
      if (!value.length) {
        if (++emptyChunks > 8) fail('更新下载持续没有数据，请检查网络后重试')
        continue
      }
      emptyChunks = 0
      signal.throwIfAborted()
      received += value.length; hash.update(value)
      await assertDirectory(owned, owner)
      await writeAll(output, value, signal)
      observe(options.onProgress, received, descriptor.size)
    }
    if (received !== descriptor.size || hash.digest('hex') !== descriptor.sha256) fail('更新文件校验失败，未使用此文件')
    signal.throwIfAborted()
    await output.sync(); await output.close(); output = undefined
    const proof = await fileSnapshot(partial, descriptor, signal)
    await assertDirectory(owned, owner); signal.throwIfAborted()
    await fs.link(partial, target)
    const final = await fileSnapshot(target, descriptor, signal)
    if (!sameObject(proof.stat, final.stat)) fail('更新文件发布期间发生变化')
    while (verifiedDownloads.size >= 30) verifiedDownloads.delete(verifiedDownloads.keys().next().value!)
    verifiedDownloads.set(target, { size: descriptor.size, sha256: descriptor.sha256 })
    return target
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof UpdateFileError || error instanceof DOMException) throw error
    return fail('更新下载或磁盘验证未完成；临时资料已隔离保留，请检查网络、磁盘空间与权限后重试')
  } finally {
    await output?.close().catch(() => {})
    if (reader) await closeReader(reader, signal.aborted ? signal.reason : undefined)
    else await cancelBody(response?.body)
  }
}

async function copyVerified(source: string, target: string, expected: Checksum, signal?: AbortSignal): Promise<FileProof> {
  const before = await fileSnapshot(source, expected, signal)
  const input = await fs.open(source, readFlags)
  let output: fs.FileHandle | undefined
  try {
    if (!sameSnapshot(before.stat, await input.stat({ bigint: true }))) fail('更新文件已变化，请重新下载')
    output = await fs.open(target, 'wx', 0o700)
    const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES), hash = createHash('sha256')
    for (let position = 0; position < expected.size;) {
      signal?.throwIfAborted()
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, expected.size - position), position)
      if (!bytesRead) fail('更新文件已变化，请重新下载')
      hash.update(buffer.subarray(0, bytesRead)); await writeAll(output, buffer.subarray(0, bytesRead), signal); position += bytesRead
    }
    if (hash.digest('hex') !== expected.sha256 || !sameSnapshot(before.stat, await input.stat({ bigint: true }))) fail('更新文件已变化，请重新下载')
    await output.chmod(0o755); await output.sync()
  } finally {
    const closed = await Promise.allSettled([input.close(), ...(output ? [output.close()] : [])])
    if (closed.some(value => value.status === 'rejected')) fail('无法安全关闭更新文件，原程序未替换')
  }
  return fileSnapshot(target, expected, signal)
}

/**
 * Verified same-directory replacement, retaining an independently verified previous executable.
 * rename's final OS window is not protection from arbitrary malicious same-user races.
 * A failure/unknown acknowledgement never triggers an automatic destructive rollback.
 */
export async function replaceAppImage(downloaded: string, appImage: string, options: { signal?: AbortSignal; expected?: Checksum } = {}): Promise<void> {
  const expected = options.expected ?? verifiedDownloads.get(downloaded)
  if (!expected || !validChecksum(expected)) fail('请先重新下载并校验更新文件')
  const signal = options.signal
  signal?.throwIfAborted()
  let committing = false
  try {
    const parent = await directory(path.dirname(appImage))
    appImage = path.join(parent, path.basename(appImage))
    const owner = await fs.lstat(parent, { bigint: true }), previous = await fileSnapshot(appImage, undefined, signal)
    if (previous.stat.nlink !== 1n) fail('当前 AppImage 不是独立的普通文件，未替换')
    const space = await fs.statfs(parent)
    const stagingBytes = previous.size + expected.size
    if (space.bavail * space.bsize < stagingBytes + Math.max(128 * 1024 ** 2, Math.ceil(stagingBytes * 0.05))) fail('磁盘可用空间不足，无法安全准备 AppImage 更新与旧版恢复资料')
    const owned = await fs.mkdtemp(path.join(parent, '.lua-update-'))
    await fs.chmod(owned, 0o700)
    const staged = path.join(owned, 'next.AppImage'), retained = path.join(owned, 'previous.AppImage')
    const proof = await copyVerified(downloaded, staged, expected, signal)
    await assertDirectory(parent, owner)
    const current = await fileSnapshot(appImage, previous, signal)
    if (!sameSnapshot(current.stat, previous.stat)) fail('当前 AppImage 在更新期间发生变化，未替换')
    // A separate copy keeps retries possible after a known pre-commit failure;
    // retaining hard links would change the old executable's identity/link count.
    await copyVerified(appImage, retained, previous, signal)
    const reserved = await fileSnapshot(appImage, previous, signal)
    if (!sameSnapshot(previous.stat, reserved.stat)) fail('当前 AppImage 在更新期间发生变化，未替换')
    await assertDirectory(parent, owner)
    signal?.throwIfAborted()
    const last = await fs.lstat(appImage, { bigint: true })
    if (!sameSnapshot(last, reserved.stat) || last.isSymbolicLink() || !last.isFile()) fail('当前 AppImage 在更新期间发生变化，未替换')
    committing = true
    try { await fs.rename(staged, appImage) }
    catch (error) {
      try {
        const actual = await fileSnapshot(appImage, expected)
        if (sameObject(actual.stat, proof.stat)) return
      } catch { /* A proven old file is handled below, uncertainty is preserved. */ }
      const actual = await fs.lstat(appImage, { bigint: true }).catch(() => undefined)
      if (actual && sameSnapshot(actual, reserved.stat)) { committing = false; throw error }
      throw new UpdateRecoveryError()
    }
    const actual = await fileSnapshot(appImage, expected)
    if (!sameObject(actual.stat, proof.stat)) throw new UpdateRecoveryError()
  } catch (error) {
    if (error instanceof UpdateRecoveryError) throw error
    if (committing) throw new UpdateRecoveryError()
    if (signal?.aborted) throw signal.reason
    if (error instanceof UpdateFileError) throw error
    fail('AppImage 更新未完成；原程序与隔离的更新资料已保留，请检查磁盘空间及权限')
  }
}
