import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import AdmZip from 'adm-zip'
import { javaProcessEnvironment } from './java-environment'
import { mavenPath, safeJoin, type GameArgument } from './core'

// Official processor/data contract; implementation below is original TypeScript.
// https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/json/Install.java
// https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/actions/PostProcessors.java
export type ForgeLoader = 'forge' | 'neoforge'
export interface LoaderVersion { version: string; stable: boolean; recommended?: boolean }
export interface LoaderDownload { url: string; path?: string; sha1?: string; size?: number }
interface InstallerLibrary { name: string; downloads: { artifact: LoaderDownload } }
interface Processor { sides?: string[]; jar: string; classpath?: string[]; args?: string[]; outputs?: Record<string, string> }
interface InstallProfile {
  spec: number; minecraft: string; json: string; data: Record<string, { client: string; server?: string }>
  libraries: InstallerLibrary[]; processors: Processor[]
}
export interface LoaderProfile {
  id: string; inheritsFrom: string; mainClass: string; libraries: InstallerLibrary[]
  arguments: { game: GameArgument[]; jvm: GameArgument[] }
  javaVersion?: { majorVersion: number; component?: string }
}
export interface ParsedInstaller { zip: AdmZip; install: InstallProfile; version: LoaderProfile }
const MAVEN = { forge: 'https://maven.minecraftforge.net/', neoforge: 'https://maven.neoforged.net/releases/' }
const ID = /^[a-zA-Z0-9_.+\-]+$/
function id(value: string): string {
  if (!ID.test(value) || value.includes('..') || value.length > 128) throw new Error('加载器版本标识无效')
  return value
}
function coordinate(loader: ForgeLoader, game: string, build: string): string {
  id(game); id(build)
  return loader === 'forge' ? `net.minecraftforge:forge:${game}-${build}:installer`
    : game === '1.20.1' ? `net.neoforged:forge:${game}-${build}:installer` : `net.neoforged:neoforge:${build}:installer`
}
export function installerArtifact(loader: ForgeLoader, game: string, build: string): { path: string; url: string } {
  const relative = mavenPath(coordinate(loader, game, build))
  return { path: relative, url: `${MAVEN[loader]}${relative}` }
}
export function loaderMetadataUrl(loader: ForgeLoader, game: string): string {
  return loader === 'forge' ? `${MAVEN.forge}net/minecraftforge/forge/maven-metadata.xml`
    : `${MAVEN.neoforge}net/neoforged/${game === '1.20.1' ? 'forge' : 'neoforge'}/maven-metadata.xml`
}
export function parseLoaderVersions(xml: string, loader: ForgeLoader, game: string, recommended?: string): LoaderVersion[] {
  if (xml.length > 4 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('加载器版本清单无效')
  id(game)
  const candidates = [...xml.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)].map(match => match[1])
  let versions: string[]
  if (loader === 'forge' || game === '1.20.1') {
    versions = candidates.filter(value => value.startsWith(`${game}-`)).map(value => value.slice(game.length + 1))
  } else {
    const legacy = /^1\.(\d+)\.(\d+)$/.exec(game) ?? /^1\.(\d+)$/.exec(game)
    const prefix = legacy ? `${legacy[1]}.${legacy[2] ?? '0'}.` : `${game.split('.').length === 2 ? `${game}.0` : game}.`
    versions = candidates.filter(value => value.startsWith(prefix))
  }
  return [...new Set(versions)].filter(value => /^[\d]+(?:\.[\d]+)+(?:-(?:beta|alpha)(?:\.\d+)?)?$/.test(value))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map(version => ({ version, stable: !/(?:alpha|beta)/.test(version), ...(recommended === version ? { recommended: true } : {}) }))
}

function boundedZip(bytes: Buffer): AdmZip {
  if (bytes.length > 64 * 1024 * 1024) throw new Error('加载器安装器超过 64 MiB 限制')
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break }
  }
  if (end < 0 || bytes.readUInt16LE(end + 10) > 20_000 || bytes.readUInt16LE(end + 4) !== 0 ||
      bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10) ||
      bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12) !== end) throw new Error('加载器 ZIP 目录无效')
  // Inspect the central directory before the ZIP library synthesizes parent paths.
  let offset = bytes.readUInt32LE(end + 16)
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('加载器 ZIP 中央目录损坏')
    const length = bytes.readUInt16LE(offset + 28)
    const next = offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
    if (next > end || length > 2048) throw new Error('加载器 ZIP 路径超出限制')
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + length)).replace(/\/$/, '')
    safeJoin('/lua-installer', name)
    if (name.split('/').length > 40) throw new Error('加载器 ZIP 路径层数超出限制')
    offset = next
  }
  if (offset !== end) throw new Error('加载器 ZIP 中央目录长度无效')
  const zip = new AdmZip(bytes)
  const names = new Set<string>()
  let expanded = 0
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\/$/, '')
    safeJoin('/lua-installer', name)
    const key = name.toLowerCase()
    if (names.has(key)) throw new Error('加载器 ZIP 存在重复路径')
    names.add(key)
    if (((entry.attr >>> 16) & 0xf000) === 0xa000 || (entry.header.flags & 1) || ![0, 8].includes(entry.header.method)) {
      throw new Error('加载器 ZIP 含不支持的链接、加密或压缩方式')
    }
    expanded += entry.header.size
    if (entry.header.size > 128 * 1024 * 1024 || expanded > 512 * 1024 * 1024) throw new Error('加载器 ZIP 解压大小超出限制')
  }
  return zip
}
function entryData(zip: AdmZip, name: string, limit = 128 * 1024 * 1024): Buffer {
  const relative = name.replace(/^\//, '')
  safeJoin('/lua-installer', relative)
  const entry = zip.getEntry(relative)
  if (!entry || entry.isDirectory || entry.header.size > limit) throw new Error(`安装器缺少有效文件：${relative}`)
  const bytes = entry.getData()
  if (bytes.length !== entry.header.size) throw new Error(`安装器文件长度错误：${relative}`)
  return bytes
}
export function parseInstaller(bytes: Buffer, game: string): ParsedInstaller {
  const zip = boundedZip(bytes)
  const install = JSON.parse(entryData(zip, 'install_profile.json', 8 * 1024 * 1024).toString('utf8')) as InstallProfile
  if (install.spec !== 1 || install.minecraft !== game || typeof install.json !== 'string' ||
      !Array.isArray(install.libraries) || !Array.isArray(install.processors) || install.processors.length > 100 ||
      !install.data || typeof install.data !== 'object') throw new Error('此加载器安装格式或 Minecraft 版本暂不支持')
  const version = JSON.parse(entryData(zip, install.json, 8 * 1024 * 1024).toString('utf8')) as LoaderProfile
  if (version.inheritsFrom !== game || typeof version.id !== 'string' ||
      !/^[a-zA-Z_$][\w.$]*$/.test(version.mainClass) || !Array.isArray(version.libraries) ||
      !Array.isArray(version.arguments?.game) || !Array.isArray(version.arguments?.jvm)) throw new Error('加载器启动清单格式无效')
  for (const library of [...install.libraries, ...version.libraries]) {
    mavenPath(library.name)
    const download = library.downloads?.artifact
    if (!download || !/^[a-f\d]{40}$/i.test(download.sha1 ?? '') || typeof download.url !== 'string') throw new Error('加载器运行库缺少 SHA-1 校验')
    if (download.path && download.path !== mavenPath(library.name)) throw new Error('加载器运行库路径与 Maven 坐标不一致')
    if (download.size !== undefined && (!Number.isSafeInteger(download.size) || download.size < 0 || download.size > 512 * 1024 * 1024)) throw new Error('加载器运行库大小无效')
  }
  for (const processor of install.processors) {
    mavenPath(processor.jar)
    if (processor.sides && (!Array.isArray(processor.sides) || processor.sides.some(side => typeof side !== 'string'))) throw new Error('加载器处理器 side 无效')
    for (const dependency of processor.classpath ?? []) mavenPath(dependency)
    if (!Array.isArray(processor.args) || processor.args.length > 512 || processor.args.some(arg => typeof arg !== 'string' || arg.length > 32768 || arg.includes('\0'))) throw new Error('加载器处理器参数无效')
  }
  return { zip, install, version }
}
async function sha1(file: string): Promise<string> {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function verify(file: string, expected?: string): Promise<void> {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`加载器缺少有效产物：${path.basename(file)}`)
  if (expected && await sha1(file) !== expected.toLowerCase()) throw new Error(`加载器产物 SHA-1 校验失败：${path.basename(file)}`)
}
async function verifyGenerated(file: string, expected?: string): Promise<void> {
  await verify(file, expected)
  // Newer NeoForge profiles omit the output hash. A zero-exit processor must
  // still produce a readable JAR with valid CRCs, not an empty or partial file.
  if (!expected && file.endsWith('.jar')) {
    if ((await fs.stat(file)).size > 256 * 1024 * 1024) throw new Error('加载器生成的 JAR 超出大小限制')
    try {
      const zip = new AdmZip(file)
      const entries = zip.getEntries()
      if (!entries.length || entries.length > 100_000 ||
          entries.reduce((sum, entry) => sum + entry.header.size, 0) > 512 * 1024 * 1024 ||
          !zip.test()) throw new Error('Invalid generated ZIP')
    } catch { throw new Error(`加载器生成的 JAR 无效：${path.basename(file)}`) }
  }
}
export interface ProcessorCommand { java: string; args: string[]; cwd: string; signal: AbortSignal }
export async function runProcessor(
  command: ProcessorCommand, log: (message: string) => void, spawnProcess: typeof spawn = spawn,
  limits: { timeoutMs?: number; killGraceMs?: number } = {},
): Promise<void> {
  command.signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let terminationError: Error | undefined
    const timeout = setTimeout(() => {
      terminationError = new Error('加载器处理器运行超时，请重试或检查 Java')
      terminate()
    }, limits.timeoutMs ?? 10 * 60_000)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      command.signal.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    // Wait for close before resolving/rejecting. Clearing this timer in the
    // timeout callback would leave a child which ignores SIGTERM running.
    const terminate = () => {
      if (killTimer || settled) return
      child?.kill('SIGTERM')
      killTimer = setTimeout(() => child?.kill('SIGKILL'), limits.killGraceMs ?? 2000)
    }
    const abort = () => { terminate() }
    try {
      child = spawnProcess(command.java, command.args, { cwd: command.cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: javaProcessEnvironment() })
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); return }
    // Bound UI output even if a processor unexpectedly writes continuously.
    let loggedBytes = 0
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (data: Buffer) => {
      if (loggedBytes < 512 * 1024) { loggedBytes += data.length; log(data.toString('utf8').slice(0, 4096).trim()) }
    })
    child.once('error', error => finish(error))
    child.once('close', (code, signal) => {
      if (command.signal.aborted) finish(new Error('加载器安装已取消'))
      else finish(terminationError ?? (code === 0 ? undefined : new Error(`加载器处理器失败（${signal ?? code ?? '未知退出状态'}）`)))
    })
    command.signal.addEventListener('abort', abort, { once: true })
    if (command.signal.aborted) abort()
  })
}
export interface ForgeInstallOptions {
  loader: ForgeLoader; game: string; build: string; rootDir: string; instanceDir: string
  java: string; clientFile: string; clientMappings?: LoaderDownload; signal: AbortSignal
  download: (file: string, download: LoaderDownload) => Promise<void>
  text: (url: string) => Promise<string>
  progress: (message: string) => void
  log: (message: string) => void
  /** Validate the verified loader's requirement before running any processor. */
  prepareJava?: (requirement: LoaderProfile['javaVersion']) => Promise<string>
  run?: (command: ProcessorCommand) => Promise<void>
  rename?: typeof fs.rename
}
export interface InstalledLoader { profile: LoaderProfile; directory: string; classpath: Array<{ name: string; file: string }> }

/** Each instance builds in its own staging tree; shared downloads are immutable hash-checked inputs. */
export async function installForge(options: ForgeInstallOptions): Promise<InstalledLoader> {
  const o = options
  o.signal.throwIfAborted()
  const artifact = installerArtifact(o.loader, o.game, o.build)
  o.progress(`正在下载 ${o.loader === 'forge' ? 'Forge' : 'NeoForge'} 安装器`)
  const checksum = (await o.text(`${artifact.url}.sha1`)).trim().split(/\s/)[0]
  if (!/^[a-f\d]{40}$/i.test(checksum)) throw new Error('官方安装器缺少 SHA-1 校验')
  const installerFile = safeJoin(o.rootDir, `loader-cache/${artifact.path}`)
  await o.download(installerFile, { url: artifact.url, sha1: checksum })
  if ((await fs.stat(installerFile)).size > 64 * 1024 * 1024) throw new Error('加载器安装器超过 64 MiB 限制')
  await verify(installerFile, checksum)
  const parsed = parseInstaller(await fs.readFile(installerFile), o.game)
  const java = o.prepareJava ? await o.prepareJava(parsed.version.javaVersion) : o.java
  o.signal.throwIfAborted()
  const staging = safeJoin(o.instanceDir, `.loader-staging-${randomUUID()}`)
  const final = safeJoin(o.instanceDir, 'loader')
  const backup = safeJoin(o.instanceDir, `.loader-backup-${randomUUID()}`)
  const libraries = safeJoin(staging, 'libraries')
  const rename = o.rename ?? fs.rename
  await fs.mkdir(libraries, { recursive: true })
  let backedUp = false
  let committed = false
  try {
    const allLibraries = new Map<string, InstallerLibrary>()
    for (const library of [...parsed.install.libraries, ...parsed.version.libraries]) {
      const relative = mavenPath(library.name)
      const previous = allLibraries.get(relative)
      if (previous && previous.downloads.artifact.sha1 !== library.downloads.artifact.sha1) throw new Error('加载器包含校验值冲突的运行库')
      allLibraries.set(relative, library)
    }
    const libraryFiles = [...allLibraries.entries()]
    let cursor = 0
    let downloadFailed = false
    const workers = Array.from({ length: Math.min(6, libraryFiles.length) }, async () => {
      for (;;) {
        o.signal.throwIfAborted()
        if (downloadFailed) return
        const item = libraryFiles[cursor++]
        if (!item) return
        const [relative, library] = item
        const destination = safeJoin(libraries, relative)
        const download = library.downloads.artifact
        await fs.mkdir(path.dirname(destination), { recursive: true })
        const embedded = parsed.zip.getEntry(`maven/${relative}`)
        if (embedded) {
          await fs.writeFile(destination, entryData(parsed.zip, `maven/${relative}`), { mode: 0o600 })
        } else if (download.url) {
          const cache = safeJoin(o.rootDir, `libraries/${relative}`)
          await o.download(cache, download)
          await fs.copyFile(cache, destination)
        } else continue // Processor output: verify after processing.
        await verify(destination, download.sha1)
        o.progress(`正在准备加载器依赖 ${Math.min(cursor, libraryFiles.length)}/${libraryFiles.length}`)
      }
    }).map(work => work.catch(error => { downloadFailed = true; throw error }))
    const outcomes = await Promise.allSettled(workers)
    const failed = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult | undefined
    if (failed) throw failed.reason
    o.signal.throwIfAborted()
    const data: Record<string, string> = Object.create(null)
    const artifactFile = (value: string) => safeJoin(libraries, mavenPath(value))
    for (const [key, entry] of Object.entries(parsed.install.data)) {
      if (!/^[A-Z0-9_]+$/.test(key) || typeof entry.client !== 'string') throw new Error('加载器处理器数据无效')
      const value = entry.client
      if (value.startsWith('[') && value.endsWith(']')) data[key] = artifactFile(value.slice(1, -1))
      else if (value.startsWith("'") && value.endsWith("'")) data[key] = value.slice(1, -1)
      else {
        const file = safeJoin(staging, `data/${key}`)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, entryData(parsed.zip, value), { mode: 0o600 })
        data[key] = file
      }
    }
    Object.assign(data, { SIDE: 'client', MINECRAFT_JAR: o.clientFile, MINECRAFT_VERSION: o.game, ROOT: staging, INSTALLER: installerFile, LIBRARY_DIR: libraries })
    const expand = (value: string): string => {
      if (value.startsWith('[') && value.endsWith(']')) return artifactFile(value.slice(1, -1))
      if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
      return value.replace(/\{([A-Z0-9_]+)\}/g, (_, key: string) => {
        if (!(key in data)) throw new Error(`加载器处理器缺少变量：${key}`)
        return data[key]
      })
    }
    const insideStaging = (file: string): string => {
      if (!path.resolve(file).startsWith(path.resolve(staging) + path.sep)) throw new Error('加载器处理器输出超出临时目录')
      return file
    }
    const processors = parsed.install.processors.filter(proc => !proc.sides || proc.sides.includes('client'))
    for (let index = 0; index < processors.length; index++) {
      o.signal.throwIfAborted()
      const processor = processors[index]
      const outputs = Object.entries(processor.outputs ?? {}).map(([file, hash]) => {
        const expected = expand(hash)
        if (!/^[a-f\d]{40}$/i.test(expected)) throw new Error('加载器处理器产物校验值无效')
        return { file: insideStaging(expand(file)), hash: expected }
      })
      const args = (processor.args ?? []).map(expand)
      for (const arg of args) {
        if (arg.split(/[\\/]/).includes('..')) throw new Error('加载器处理器参数包含不安全路径')
        if (path.isAbsolute(arg) && arg !== staging && arg !== o.clientFile && arg !== installerFile) insideStaging(arg)
        if (/^[A-Za-z]:/.test(arg) && !path.isAbsolute(arg)) throw new Error('加载器处理器参数包含不安全路径')
      }
      o.progress(`正在安装加载器 ${index + 1}/${processors.length}：${processor.jar.split(':')[1]}`)
      if (args.includes('--task') && args[args.indexOf('--task') + 1] === 'DOWNLOAD_MOJMAPS') {
        const output = args[args.indexOf('--output') + 1]
        if (!o.clientMappings || !args.includes('--output') || !output) throw new Error('此 Minecraft 版本缺少客户端官方映射')
        await o.download(insideStaging(output), o.clientMappings)
      } else {
        const jar = artifactFile(processor.jar)
        const classpath = [jar, ...(processor.classpath ?? []).map(artifactFile)]
        for (const file of classpath) await verify(file)
        const manifest = entryData(new AdmZip(jar), 'META-INF/MANIFEST.MF', 1024 * 1024).toString('utf8').replace(/\r?\n /g, '')
        const main = /^Main-Class:\s*([\w.$]+)\s*$/m.exec(manifest)?.[1]
        if (!main) throw new Error(`加载器处理器缺少 Main-Class：${processor.jar}`)
        for (const arg of args) if (arg.startsWith(staging + path.sep)) await fs.mkdir(path.dirname(insideStaging(arg)), { recursive: true })
        const command: ProcessorCommand = {
          java, cwd: staging, signal: o.signal,
          args: ['-Xmx2048M', '-XX:ActiveProcessorCount=2', '-cp', classpath.join(path.delimiter), main, ...args],
        }
        await (o.run ? o.run(command) : runProcessor(command, o.log))
      }
      for (const output of outputs) await verify(output.file, output.hash)
    }
    // Some modern installers omit processor.outputs. Required client artifacts
    // still must exist; when official *_SHA data is supplied, verify it as well.
    for (const key of ['PATCHED', 'MC_EXTRA', 'MC_SLIM']) {
      if (data[key]) await verifyGenerated(insideStaging(data[key]), data[`${key}_SHA`])
    }
    if (processors.length && !data.PATCHED) throw new Error('此加载器未声明可校验的客户端补丁产物')
    for (const [relative, library] of allLibraries) await verify(safeJoin(libraries, relative), library.downloads.artifact.sha1)
    o.signal.throwIfAborted()
    try { await rename(final, backup); backedUp = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { await rename(staging, final); committed = true } catch (error) {
      if (backedUp) { await rename(backup, final); backedUp = false }
      throw error
    }
    if (backedUp) { await fs.rm(backup, { recursive: true, force: true }); backedUp = false }
    return {
      profile: parsed.version, directory: safeJoin(final, 'libraries'),
      classpath: parsed.version.libraries.map(library => ({ name: library.name, file: safeJoin(final, `libraries/${mavenPath(library.name)}`) })),
    }
  } finally {
    if (!committed) await fs.rm(staging, { recursive: true, force: true })
    // Leave the backup in place if a rollback itself failed, for recovery.
  }
}
