import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { javaProcessEnvironment } from './java-environment'

// Mojang's runtime catalog and manifests are data, never executable installer scripts.
export const JAVA_RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'
export type JavaRuntimeRequest = { component: string; major: number; platform?: NodeJS.Platform; arch?: string }
export interface ManagedJavaRuntime {
  path: string; version: string; major: number; arch: string; component: string
  source: 'mojang'; manifestSha1: string; installedAt: string
}
export interface JavaRuntimeProgress {
  phase: 'metadata' | 'download' | 'verify' | 'probe' | 'commit'
  completedBytes: number; totalBytes: number; file?: string
}
export type JavaRuntimeProbe = (executable: string, signal?: AbortSignal) => Promise<{ version: string; major: number; arch: string }>
interface Options { fetch?: typeof globalThis.fetch; probe?: JavaRuntimeProbe }
interface EnsureOptions { signal?: AbortSignal; onProgress?: (progress: JavaRuntimeProgress) => void }
interface Request { component: string; major: number; platform: NodeJS.Platform; arch: string; platformKey: string }
interface Download { url: string; sha1: string; size: number }
type Entry = { type: 'directory' } | { type: 'file'; executable: boolean; downloads: { raw: Download } } | { type: 'link'; target: string }
interface Manifest { files: Record<string, Entry> }
interface Receipt {
  schema: 1; source: 'mojang'; request: Request; manifest: Download; versionName: string
  installedAt: string; executable: string; licenses: string[]
}
interface Task {
  controller: AbortController; listeners: Set<(progress: JavaRuntimeProgress) => void>
  users: Set<symbol>; promise: Promise<ManagedJavaRuntime>; progress?: JavaRuntimeProgress; committed?: ManagedJavaRuntime
}

const META_LIMIT = 2 * 1024 ** 2
const FILE_LIMIT = 256 * 1024 ** 2
const TOTAL_LIMIT = 512 * 1024 ** 2
const FILE_COUNT_LIMIT = 10_000
const RECEIPT = '.lua-runtime.json'
const MANIFEST = '.lua-runtime-manifest.json'
const STAGING = '.lua-staging.json'
const HOSTS = new Set(['launchermeta.mojang.com', 'piston-meta.mojang.com', 'piston-data.mojang.com'])
const USER_AGENT = 'LuaLauncher (+https://github.com/XQGGCN/lua-launcher)'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Java 运行时元数据无效')
  return value as Record<string, unknown>
}
function abortError(): Error { return new DOMException('Java 下载已取消', 'AbortError') }
function check(signal?: AbortSignal): void { if (signal?.aborted) throw abortError() }
function normalizeArch(arch: string): string {
  return ['amd64', 'x86_64', 'x64'].includes(arch) ? 'x64' : ['aarch64', 'arm64'].includes(arch) ? 'arm64' : arch
}
function versionMajor(version: string): number { return Number(version.split(/[.+-]/)[0]) }
function request(input: JavaRuntimeRequest): Request {
  const platform = input.platform ?? process.platform, arch = input.arch ?? process.arch
  if (typeof input.component !== 'string' || !/^java-runtime-[a-z]+$/.test(input.component) || !Number.isInteger(input.major) || input.major < 17 || input.major > 99) {
    throw new Error('Java 运行时组件或主版本无效')
  }
  const mapping: Record<string, string> = {
    'win32/x64': 'windows-x64', 'win32/arm64': 'windows-arm64',
    'darwin/x64': 'mac-os', 'darwin/arm64': 'mac-os-arm64', 'linux/x64': 'linux',
  }
  const platformKey = mapping[`${platform}/${arch}`]
  if (!platformKey) throw new Error(`Mojang 暂无 ${platform}/${arch} 官方运行时，请手动选择同架构 Java ${input.major}`)
  return { component: input.component, major: input.major, platform, arch, platformKey }
}
function url(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Java 下载地址无效')
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname) || parsed.port || parsed.username || parsed.password || parsed.hash) {
    throw new Error('Java 下载地址必须使用允许的 Mojang HTTPS 域名')
  }
  return parsed.href
}
function download(value: unknown, limit: number): Download {
  const item = object(value)
  if (typeof item.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(item.sha1) ||
      !Number.isSafeInteger(item.size) || Number(item.size) < 0 || Number(item.size) > limit) {
    throw new Error('Java 下载大小或 SHA-1 无效')
  }
  return { url: url(item.url), size: Number(item.size), sha1: item.sha1.toLowerCase() }
}
function relative(value: string): string {
  if (!value || value.length > 1024 || /[\\:\u0000-\u001f\u007f]/u.test(value) || value.startsWith('/') || value.split('/').length > 40) {
    throw new Error('Java 文件路径无效')
  }
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[<>"|?*]/.test(part)) throw new Error('Java 文件路径无效')
  }
  return value
}
function targetOf(name: string, target: string): string {
  if (!target || target.length > 1024 || /[\\:\u0000-\u001f\u007f]/u.test(target) || target.startsWith('/')) throw new Error('Java 符号链接目标无效')
  return relative(path.posix.normalize(path.posix.join(path.posix.dirname(name), target)))
}
function parseManifest(bytes: Buffer, platform: NodeJS.Platform): { manifest: Manifest; total: number; executable: string; licenses: string[] } {
  const raw = object(object(JSON.parse(bytes.toString('utf8'))).files)
  const names = Object.keys(raw)
  if (!names.length || names.length > FILE_COUNT_LIMIT) throw new Error('Java 文件清单数量超出限制')
  const files: Record<string, Entry> = Object.create(null)
  const folded = new Set<string>()
  let total = 0
  for (const name of names) {
    relative(name)
    if ([RECEIPT, MANIFEST, STAGING].includes(name.toLowerCase()) || folded.has(name.toLowerCase())) throw new Error('Java 文件清单存在重复或保留路径')
    folded.add(name.toLowerCase())
    const entry = object(raw[name])
    if (entry.type === 'directory') files[name] = { type: 'directory' }
    else if (entry.type === 'file') {
      const rawFile = download(object(entry.downloads).raw, FILE_LIMIT)
      total += rawFile.size
      if (typeof entry.executable !== 'boolean') throw new Error('Java 文件执行权限标记无效')
      files[name] = { type: 'file', executable: entry.executable, downloads: { raw: rawFile } }
    } else if (entry.type === 'link' && typeof entry.target === 'string') {
      files[name] = { type: 'link', target: entry.target }
    } else throw new Error('Java 文件类型无效')
  }
  if (total > TOTAL_LIMIT) throw new Error('Java 运行时总体积超出限制')
  for (const [name, entry] of Object.entries(files)) {
    let parent = path.posix.dirname(name)
    while (parent !== '.') {
      // Require explicit parents; this also prevents case-variant implicit directories.
      if (files[parent]?.type !== 'directory') throw new Error('Java 文件祖先目录缺失或包含符号链接')
      parent = path.posix.dirname(parent)
    }
    if (entry.type === 'link') {
      // Official manifests use links directly to regular license files, never link chains.
      if (files[targetOf(name, entry.target)]?.type !== 'file') throw new Error('Java 符号链接必须指向清单内的普通文件')
      if (platform === 'win32') throw new Error('Windows Java 清单不支持符号链接')
    }
  }
  const executable = platform === 'darwin' ? 'jre.bundle/Contents/Home/bin/java' : platform === 'win32' ? 'bin/java.exe' : 'bin/java'
  const java = files[executable]
  if (java?.type !== 'file' || !java.executable) throw new Error('Java 清单缺少可执行文件')
  const licenses = names.filter(name => /(?:^|\/)(?:legal(?:\/|$)|LICENSE(?:\.|$)|NOTICE(?:\.|$))/i.test(name))
  if (!licenses.some(name => files[name].type === 'file')) throw new Error('Java 清单缺少许可证文件')
  return { manifest: { files }, total, executable, licenses }
}
async function plainDirectory(directory: string, create = false): Promise<void> {
  if (create) await fs.mkdir(directory, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await fs.lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Java 运行时目录不能是符号链接')
}
async function readRegular(file: string, limit: number): Promise<Buffer> {
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Java 元数据文件无效')
  return fs.readFile(file)
}
async function hashFile(file: string, expected: Download, signal?: AbortSignal): Promise<void> {
  check(signal)
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.size) throw new Error('Java 文件大小或类型不匹配')
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(file, { signal })) { check(signal); hash.update(chunk) }
  if (hash.digest('hex') !== expected.sha1) throw new Error('Java 文件 SHA-1 校验失败')
}
function validateProbe(value: { version: string; major: number; arch: string }, req: Request): { version: string; major: number; arch: string } {
  if (typeof value.version !== 'string' || !/^\d+(?:[.\dA-Za-z+_-]*)$/.test(value.version) ||
      value.major !== versionMajor(value.version) || value.major !== req.major) throw new Error(`Java 探测主版本不符，需要 Java ${req.major}`)
  if (normalizeArch(value.arch) !== req.arch) throw new Error(`Java 探测架构不符，需要 ${req.arch}`)
  return { ...value, arch: normalizeArch(value.arch) }
}
export const probeJavaRuntime: JavaRuntimeProbe = async (executable, signal) => {
  check(signal)
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ['-XshowSettings:properties', '-version'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: javaProcessEnvironment(),
    })
    let failure: Error | undefined
    const chunks: Buffer[] = []
    let bytes = 0
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL') }
    const abort = () => stop(abortError())
    const timer = setTimeout(() => stop(new Error('Java 版本探测超时')), 15_000)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const collect = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 256 * 1024) stop(new Error('Java 版本探测输出超出限制'))
      else chunks.push(chunk)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', error => { failure ??= error })
    // close follows process exit and stream closure, including spawn failures.
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`Java 版本探测失败（退出码 ${code}）`))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
  check(signal)
  const version = /(?:openjdk|java) version "([^"]+)"/.exec(output)?.[1] ?? /java\.version\s*=\s*(\S+)/.exec(output)?.[1]
  const arch = /os\.arch\s*=\s*(\S+)/.exec(output)?.[1]
  if (!version || !arch) throw new Error('Java 版本探测未返回版本或架构')
  return { version, major: versionMajor(version), arch: normalizeArch(arch) }
}

export class JavaRuntimeManager {
  private readonly directory: string
  private readonly fetcher: typeof globalThis.fetch
  private readonly probe: JavaRuntimeProbe
  private readonly tasks = new Map<string, Task>()
  constructor(rootDirectory: string, options: Options = {}) {
    this.directory = path.join(path.resolve(rootDirectory), 'runtimes')
    this.fetcher = options.fetch ?? globalThis.fetch
    this.probe = options.probe ?? probeJavaRuntime
  }

  async ensure(input: JavaRuntimeRequest, options: EnsureOptions = {}): Promise<ManagedJavaRuntime> {
    const req = request(input), key = `${req.platformKey}/${req.component}/${req.major}`
    check(options.signal)
    let task = this.tasks.get(key)
    if (task?.controller.signal.aborted) {
      await task.promise.catch(() => {})
      check(options.signal)
      return this.ensure(input, options)
    }
    if (!task) {
      task = { controller: new AbortController(), listeners: new Set(), users: new Set(), promise: undefined! }
      const created = task
      this.tasks.set(key, task)
      task.promise = Promise.resolve().then(() => this.install(req, created.controller.signal, progress => {
        created.progress = progress
        for (const listener of created.listeners) { try { listener({ ...progress }) } catch { /* UI listeners do not own the download. */ } }
      }, value => { created.committed = value })).finally(() => { if (this.tasks.get(key) === created) this.tasks.delete(key) })
      void task.promise.catch(() => {})
    }
    return this.subscribe(task, options)
  }

  private subscribe(task: Task, options: EnsureOptions): Promise<ManagedJavaRuntime> {
    const user = Symbol()
    const listener = options.onProgress ? (progress: JavaRuntimeProgress) => options.onProgress!(progress) : undefined
    task.users.add(user)
    if (listener) task.listeners.add(listener)
    return new Promise((resolve, reject) => {
      let finished = false
      const finish = (error?: unknown, value?: ManagedJavaRuntime) => {
        if (finished) return
        finished = true
        task.users.delete(user)
        if (listener) task.listeners.delete(listener)
        options.signal?.removeEventListener('abort', cancel)
        if (error) reject(error); else resolve(value!)
      }
      const cancel = () => {
        if (task.committed) { finish(undefined, task.committed); return }
        task.users.delete(user)
        if (listener) task.listeners.delete(listener)
        if (task.users.size) finish(abortError())
        else {
          task.controller.abort()
          // The last subscriber waits for downloads/probes to stop and staging cleanup.
          void task.promise.then(value => finish(task.committed ? undefined : abortError(), value), () => finish(abortError()))
        }
      }
      options.signal?.addEventListener('abort', cancel, { once: true })
      if (options.signal?.aborted) cancel()
      else if (task.progress && listener) { try { listener({ ...task.progress }) } catch {} }
      void task.promise.then(value => finish(!task.committed && options.signal?.aborted ? abortError() : undefined, value), error => finish(error))
    })
  }

  async discover(): Promise<ManagedJavaRuntime[]> {
    return this.discoverFor()
  }

  private async discoverFor(wanted?: Request, signal?: AbortSignal): Promise<ManagedJavaRuntime[]> {
    check(signal)
    try { await plainDirectory(this.directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const found: ManagedJavaRuntime[] = []
    let count = 0
    for (const platform of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!platform.isDirectory() || (wanted && platform.name !== wanted.platformKey)) continue
      if (!['windows-x64', 'windows-arm64', 'mac-os', 'mac-os-arm64', 'linux'].includes(platform.name)) continue
      const platformPath = path.join(this.directory, platform.name)
      await plainDirectory(platformPath)
      for (const component of await fs.readdir(platformPath, { withFileTypes: true })) {
        if (!component.isDirectory() || !/^java-runtime-[a-z]+$/.test(component.name) || (wanted && component.name !== wanted.component)) continue
        const componentPath = path.join(platformPath, component.name)
        await plainDirectory(componentPath)
        for (const installation of await fs.readdir(componentPath, { withFileTypes: true })) {
          check(signal)
          if (installation.isDirectory() && /^\.staging-[a-f0-9]{40}-[a-f0-9-]{36}$/.test(installation.name)) {
            await this.cleanAbandoned(path.join(componentPath, installation.name))
            continue
          }
          if (!installation.isDirectory() || !/^[a-f0-9]{40}-[a-f0-9-]{36}$/.test(installation.name)) continue
          if (++count > 128) throw new Error('Java 托管安装数量超出限制')
          try {
            const runtime = await this.readInstalled(path.join(componentPath, installation.name), signal, wanted)
            if (runtime) found.push(runtime)
          } catch (error) { check(signal) /* Incomplete or damaged runtimes are not usable candidates. */ }
        }
      }
    }
    return found.sort((a, b) => b.installedAt.localeCompare(a.installedAt))
  }

  private async cleanAbandoned(directory: string): Promise<void> {
    // Never reclaim another live process's stage. Unknown/legacy stages remain ignored.
    try {
      await plainDirectory(directory)
      const owner = object(JSON.parse((await readRegular(path.join(directory, STAGING), 1024)).toString('utf8')))
      if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || typeof owner.createdAt !== 'string') return
      try { process.kill(Number(owner.pid), 0); return } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
      }
      await fs.rm(directory, { recursive: true, force: true })
    } catch { /* Missing/unknown ownership is not permission to delete a directory. */ }
  }

  private async readInstalled(directory: string, signal?: AbortSignal, wanted?: Request): Promise<ManagedJavaRuntime | undefined> {
    await plainDirectory(directory)
    const raw = object(JSON.parse((await readRegular(path.join(directory, RECEIPT), META_LIMIT)).toString('utf8')))
    const req = request(object(raw.request) as unknown as JavaRuntimeRequest)
    if (raw.schema !== 1 || raw.source !== 'mojang' || typeof raw.installedAt !== 'string' || !Number.isFinite(Date.parse(raw.installedAt))) throw new Error('Java 安装记录无效')
    if (wanted && (wanted.component !== req.component || wanted.major !== req.major || wanted.platformKey !== req.platformKey)) return
    const descriptor = download(raw.manifest, META_LIMIT)
    if (path.basename(path.dirname(directory)) !== req.component || path.basename(path.dirname(path.dirname(directory))) !== req.platformKey ||
        !path.basename(directory).startsWith(`${descriptor.sha1}-`)) throw new Error('Java 安装目录与记录不符')
    const bytes = await readRegular(path.join(directory, MANIFEST), META_LIMIT)
    this.verifyBytes(bytes, descriptor)
    const parsed = parseManifest(bytes, req.platform)
    if (raw.executable !== parsed.executable) throw new Error('Java 安装可执行路径不符')
    await this.verifyTree(directory, parsed.manifest, signal)
    const executable = path.join(directory, parsed.executable)
    const result = validateProbe(await this.probe(executable, signal), req)
    check(signal)
    return { ...result, path: executable, component: req.component, source: 'mojang', manifestSha1: descriptor.sha1, installedAt: raw.installedAt }
  }

  private verifyBytes(bytes: Buffer, expected: Download): void {
    if (bytes.length !== expected.size) throw new Error('Java 元数据大小校验失败')
    if (createHash('sha1').update(bytes).digest('hex') !== expected.sha1) throw new Error('Java 元数据 SHA-1 校验失败')
  }

  private async response(address: string, signal: AbortSignal): Promise<Response> {
    let current = url(address)
    for (let redirects = 0; redirects <= 3; redirects++) {
      check(signal)
      const result = await this.fetcher(current, { signal, redirect: 'manual', headers: { 'User-Agent': USER_AGENT } })
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const location = result.headers.get('location')
        await result.body?.cancel()
        if (!location || redirects === 3) throw new Error('Java 下载重定向无效')
        current = url(new URL(location, current).href)
        continue
      }
      if (result.status !== 200) { await result.body?.cancel(); throw new Error(`Java 下载请求失败（HTTP ${result.status}）`) }
      if (/text\/html|application\/xhtml/i.test(result.headers.get('content-type') ?? '')) {
        await result.body?.cancel(); throw new Error('Java 下载返回了验证网页，未保存为运行时')
      }
      return result
    }
    throw new Error('Java 下载重定向过多')
  }

  private async bytes(address: string, limit: number, signal: AbortSignal): Promise<Buffer> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
    const response = await this.response(address, bounded)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Java 下载响应为空')
    const parts: Buffer[] = []
    let size = 0
    try {
      while (true) {
        check(bounded)
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) throw new Error('Java 元数据大小超出限制')
        parts.push(Buffer.from(value))
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    check(bounded)
    return Buffer.concat(parts)
  }

  private async file(destination: string, expected: Download, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(90_000)])
    const response = await this.response(expected.url, bounded)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Java 下载响应为空')
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    const hash = createHash('sha1')
    let size = 0
    try {
      handle = await fs.open(destination, 'wx', 0o600)
      while (true) {
        check(bounded)
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > expected.size) throw new Error('Java 文件大小超出清单限制')
        hash.update(value)
        // FileHandle.write may perform a partial write; writeFile consumes the full chunk.
        await handle.writeFile(value)
        progress(value.byteLength)
      }
      if (size !== expected.size || hash.digest('hex') !== expected.sha1) throw new Error('Java 文件大小或 SHA-1 校验失败')
      check(bounded)
    } finally {
      await reader.cancel().catch(() => {}); reader.releaseLock()
      await handle?.close()
    }
  }

  private async verifyTree(directory: string, manifest: Manifest, signal?: AbortSignal): Promise<void> {
    // Check every directory before following any descendant path from a persisted install.
    for (const [name, entry] of Object.entries(manifest.files).sort((a, b) => a[0].split('/').length - b[0].split('/').length)) {
      check(signal)
      if (entry.type === 'directory') await plainDirectory(path.join(directory, name))
    }
    for (const [name, entry] of Object.entries(manifest.files)) {
      check(signal)
      const file = path.join(directory, name)
      if (entry.type === 'file') {
        await hashFile(file, entry.downloads.raw, signal)
        if (entry.executable && process.platform !== 'win32') await fs.access(file, fs.constants.X_OK)
      } else if (entry.type === 'link') {
        if (!(await fs.lstat(file)).isSymbolicLink() || await fs.readlink(file) !== entry.target) throw new Error('Java 符号链接校验失败')
        if (await fs.realpath(file) !== await fs.realpath(path.join(directory, targetOf(name, entry.target)))) {
          throw new Error('Java 符号链接实际目标不符')
        }
      }
    }
  }

  private async install(
    req: Request, signal: AbortSignal, emit: (progress: JavaRuntimeProgress) => void,
    onCommitted: (runtime: ManagedJavaRuntime) => void,
  ): Promise<ManagedJavaRuntime> {
    const existing = (await this.discoverFor(req, signal))[0]
    if (existing) { check(signal); onCommitted(existing); return existing }
    emit({ phase: 'metadata', completedBytes: 0, totalBytes: 0 })
    const index = object(JSON.parse((await this.bytes(JAVA_RUNTIME_INDEX, META_LIMIT, signal)).toString('utf8')))
    const platform = object(index[req.platformKey])
    const candidates = platform[req.component]
    if (!Array.isArray(candidates)) throw new Error(`Mojang 未提供 ${req.component} / ${req.platformKey}`)
    const selected = candidates.map(object).find(item => {
      const version = object(item.version)
      return typeof version.name === 'string' && versionMajor(version.name) === req.major
    })
    if (!selected) throw new Error(`Mojang 未提供 Java ${req.major} 的 ${req.component} / ${req.platformKey} 下载`)
    const descriptor = download(selected.manifest, META_LIMIT)
    const manifestBytes = await this.bytes(descriptor.url, descriptor.size, signal)
    this.verifyBytes(manifestBytes, descriptor)
    const parsed = parseManifest(manifestBytes, req.platform)
    check(signal)
    // Each immutable installation has a hash-keyed directory; repairs never overwrite one in use.
    await plainDirectory(path.dirname(this.directory))
    await plainDirectory(this.directory, true)
    const platformDirectory = path.join(this.directory, req.platformKey)
    await plainDirectory(platformDirectory, true)
    const parent = path.join(platformDirectory, req.component)
    await plainDirectory(parent, true)
    const installationId = `${descriptor.sha1}-${randomUUID()}`
    const staging = path.join(parent, `.staging-${installationId}`)
    const final = path.join(parent, installationId)
    await fs.mkdir(staging, { mode: 0o700 })
    let committed = false
    let completedBytes = 0
    const event = (phase: JavaRuntimeProgress['phase'], file?: string) => emit({ phase, completedBytes, totalBytes: parsed.total, ...(file ? { file } : {}) })
    try {
      await fs.writeFile(path.join(staging, STAGING), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
      const entries = Object.entries(parsed.manifest.files)
      for (const [name, entry] of entries.sort((a, b) => a[0].split('/').length - b[0].split('/').length)) {
        check(signal)
        if (entry.type === 'directory') await fs.mkdir(path.join(staging, name), { mode: 0o755 })
      }
      const files = entries.filter((entry): entry is [string, Extract<Entry, { type: 'file' }>] => entry[1].type === 'file')
      const workers = new AbortController()
      const workerSignal = AbortSignal.any([signal, workers.signal])
      let cursor = 0
      let failure: unknown
      event('download')
      await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
        try {
          while (cursor < files.length) {
            check(workerSignal)
            const [name, entry] = files[cursor++]
            const destination = path.join(staging, name)
            await this.file(destination, entry.downloads.raw, workerSignal, bytes => {
              completedBytes += bytes; event('download', name)
            })
            await fs.chmod(destination, entry.executable ? 0o755 : 0o644)
          }
        } catch (error) { failure ??= error; workers.abort() }
      }))
      if (failure) throw failure
      check(signal)
      for (const [name, entry] of entries) {
        if (entry.type === 'link') await fs.symlink(entry.target, path.join(staging, name), 'file')
      }
      event('verify')
      await this.verifyTree(staging, parsed.manifest, signal)
      await fs.writeFile(path.join(staging, MANIFEST), manifestBytes, { flag: 'wx', mode: 0o644 })
      const installedAt = new Date().toISOString()
      const receipt: Receipt = {
        schema: 1, source: 'mojang', request: req, manifest: descriptor, versionName: String(object(selected.version).name),
        installedAt, executable: parsed.executable, licenses: parsed.licenses,
      }
      await fs.writeFile(path.join(staging, RECEIPT), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o644 })
      event('probe')
      const result = validateProbe(await this.probe(path.join(staging, parsed.executable), signal), req)
      check(signal)
      event('commit')
      check(signal)
      await fs.rm(path.join(staging, STAGING))
      check(signal)
      // Atomic rename is the commit boundary. Once invoked, a successful commit wins
      // a late cancellation; callers receive success and no published runtime is removed.
      await fs.rename(staging, final)
      committed = true
      const runtime: ManagedJavaRuntime = { ...result, path: path.join(final, parsed.executable), component: req.component, source: 'mojang', manifestSha1: descriptor.sha1, installedAt }
      onCommitted(runtime)
      return runtime
    } finally {
      if (!committed) await fs.rm(staging, { recursive: true, force: true })
    }
  }
}
