import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import type { PackPlanEnvironment, PackPlanOrigin, PackPlanRole } from './modpack-plan-types'

/** https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack */
export const MODPACK_LIMITS = {
  archiveBytes: 256 * 1024 * 1024,
  indexBytes: 8 * 1024 * 1024,
  entries: 10_000,
  files: 5_000,
  entryBytes: 128 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  downloadedFileBytes: 512 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024 * 1024,
} as const

// Redirect-only GitHub hosts are deliberately not accepted as arbitrary source URLs.
export const PACK_SOURCE_HOSTS = new Set(['cdn.modrinth.com', 'cdn.bbsmc.net', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'])
export const PACK_REDIRECT_HOSTS = new Set([
  ...PACK_SOURCE_HOSTS, 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
])

export interface PackPreview {
  name: string
  versionId: string
  summary?: string
  minecraftVersion: string
  loader: 'vanilla' | 'fabric' | 'forge' | 'neoforge'
  loaderVersion?: string
  fileCount: number
  totalBytes: number
  optionalFileCount: number
  unsupportedReason?: string
}
export interface PackFile {
  path: string
  downloads: string[]
  hashes: { sha1: string; sha512: string }
  fileSize: number
  optional: boolean
}
export interface PackOverride { path: string; data: Buffer }
/** Main-only provenance; paths are game-relative, never native paths or URLs. */
export interface PackProvenance {
  origin: PackPlanOrigin
  role: PackPlanRole
  path: string
  bytes: number
  sizeBasis: 'declared-download' | 'verified-archive' | 'declared-archive'
  environment?: { client: PackPlanEnvironment; server: PackPlanEnvironment; implicit: boolean }
  sha1?: string
  sha512?: string
  hashBasis?: 'index-declaration' | 'archive-payload'
  effective: boolean
  /** Index in this same bounded provenance array, not a renderer-supplied path. */
  shadowedBy?: number
}
export interface ParsedModpack {
  preview: PackPreview
  archive: Buffer
  files: PackFile[]
  overrides: PackOverride[]
  provenance: PackProvenance[]
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`整合包 ${field} 格式无效`)
  return value as Record<string, unknown>
}
function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new Error(`整合包 ${field} 格式无效`)
  }
  return value
}
function integer(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`整合包 ${field} 大小超出限制或格式无效`)
  }
  return value
}

/** Reject aliases that differ across Windows, macOS, and Linux before touching disk. */
export function validatePackPath(input: unknown): string {
  const value = text(input, '文件路径', 1024)
  if (value.includes('\\') || value.startsWith('/') || /[\x00-\x1f\x7f:<>|"?*]/.test(value)) {
    throw new Error(`不安全的整合包路径：${value}`)
  }
  const parts = value.split('/')
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`不安全的整合包路径：${value}`)
  }
  return value
}
export function validatePackUrl(input: unknown): string {
  const value = text(input, '下载链接', 8192)
  if (/\s|[\x00-\x1f\x7f]/.test(value)) throw new Error('整合包下载链接包含未编码字符')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || !PACK_SOURCE_HOSTS.has(url.hostname)) {
    throw new Error(`不允许的整合包下载来源：${url.hostname}`)
  }
  return url.href
}
function canonical(value: string): string { return value.normalize('NFC').toLowerCase() }
function supportedMinecraft(version: string): boolean {
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(version)
  if (match) return Number(match[1]) > 20 || (Number(match[1]) === 20 && Number(match[2] ?? 0) >= 1)
  return /^2[6-9]\.\d+(?:\.\d+)?$/.test(version)
}

/** Tracks implicit directories as well as files, so a/b and a cannot coexist as files. */
class PathIndex {
  private entries = new Map<string, { path: string; directory: boolean; explicit: boolean }>()
  get size(): number { return this.entries.size }
  add(value: string, directory = false, replaceExact = false): void {
    const parts = value.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const current = parts.slice(0, index).join('/')
      const isDirectory = index < parts.length || directory
      const key = canonical(current)
      const previous = this.entries.get(key)
      if (previous) {
        if (previous.path !== current || previous.directory !== isDirectory) throw new Error(`整合包路径冲突：${value}`)
        if (!isDirectory && !replaceExact) throw new Error(`整合包包含重复路径：${value}`)
        if (index === parts.length && directory && previous.explicit) throw new Error(`整合包包含重复目录：${value}`)
        if (index === parts.length && directory) previous.explicit = true
      } else {
        this.entries.set(key, { path: current, directory: isDirectory, explicit: index === parts.length })
      }
    }
  }
}

/** Bound directory parsing before adm-zip allocates entries or synthesizes parent directories. */
function preflightZip(archive: Buffer): void {
  let end = -1
  for (let position = archive.length - 22; position >= Math.max(0, archive.length - 65_557); position--) {
    if (archive.readUInt32LE(position) === 0x06054b50 &&
        position + 22 + archive.readUInt16LE(position + 20) === archive.length) {
      end = position
      break
    }
  }
  if (end < 0) throw new Error('整合包 ZIP 目录无效')
  const count = archive.readUInt16LE(end + 10)
  const directorySize = archive.readUInt32LE(end + 12)
  const directoryOffset = archive.readUInt32LE(end + 16)
  if (archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) ||
      count !== archive.readUInt16LE(end + 8) || count === 0xffff ||
      directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('不支持分卷或 ZIP64 整合包')
  }
  if (count > MODPACK_LIMITS.entries || directoryOffset + directorySize !== end) throw new Error('整合包 ZIP 目录数量或范围无效')
  const tail = archive.subarray(Math.max(0, end - 65_557), end)
  if (tail.includes(Buffer.from('504b0606', 'hex')) || tail.includes(Buffer.from('504b0607', 'hex'))) {
    throw new Error('不支持 ZIP64 整合包')
  }
  const paths = new PathIndex()
  let offset = directoryOffset
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('整合包 ZIP 中央目录损坏')
    const nameLength = archive.readUInt16LE(offset + 28)
    const recordLength = 46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32)
    if (offset + recordLength > end) throw new Error('整合包 ZIP 中央目录越界')
    const name = new TextDecoder('utf-8', { fatal: true }).decode(archive.subarray(offset + 46, offset + 46 + nameLength))
    const directory = name.endsWith('/')
    paths.add(validatePackPath(directory ? name.slice(0, -1) : name), directory)
    if (paths.size > MODPACK_LIMITS.entries) throw new Error('整合包 ZIP 条目和父目录数量超出限制')
    offset += recordLength
  }
  if (offset !== end) throw new Error('整合包 ZIP 目录长度不符')
}

function getEntryData(entry: AdmZip.IZipEntry): Buffer {
  // adm-zip 0.6+ bounds inflate output to the declared size and checks CRC. Verify length as well.
  const data = entry.getData()
  if (data.length !== entry.header.size) throw new Error(`整合包 ZIP 条目大小不符：${entry.entryName}`)
  return data
}

export async function readModpack(filePath: string): Promise<ParsedModpack> {
  const handle = await fs.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MODPACK_LIMITS.archiveBytes) throw new Error('整合包必须是小于 256 MiB 的普通 .mrpack 文件')
    const archive = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < archive.length) {
      const result = await handle.read(archive, offset, archive.length - offset, offset)
      if (!result.bytesRead) throw new Error('读取期间整合包文件大小发生变化，请重新选择')
      offset += result.bytesRead
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset)
    if (extra.bytesRead) throw new Error('读取期间整合包文件大小发生变化，请重新选择')
    return parseModpack(archive)
  } finally { await handle.close() }
}

export function parseModpack(archive: Buffer): ParsedModpack {
  if (!Buffer.isBuffer(archive) || archive.length > MODPACK_LIMITS.archiveBytes || archive.length < 22) {
    throw new Error('整合包 ZIP 文件无效或超过 256 MiB')
  }
  preflightZip(archive)
  const zip = new AdmZip(archive)
  const entries = zip.getEntries()
  if (entries.length > MODPACK_LIMITS.entries) throw new Error('整合包 ZIP 条目数量超出限制')
  let expanded = 0
  const archivePaths = new PathIndex()
  for (const entry of entries) {
    const name = entry.isDirectory ? entry.entryName.replace(/\/$/, '') : entry.entryName
    validatePackPath(name)
    archivePaths.add(name, entry.isDirectory)
    if (((entry.attr >>> 16) & 0xf000) === 0xa000) throw new Error('整合包 ZIP 不能包含符号链接')
    if (entry.header.flags & 1) throw new Error('不支持加密的整合包 ZIP')
    if (![0, 8].includes(entry.header.method)) throw new Error('不支持此整合包 ZIP 压缩方式')
    const size = integer(entry.header.size, 'ZIP 条目', MODPACK_LIMITS.entryBytes)
    expanded += size
    if (expanded > MODPACK_LIMITS.expandedBytes ||
        (size > 1024 * 1024 && size > Math.max(1, entry.header.compressedSize) * 1000)) {
      throw new Error('整合包 ZIP 解压大小或压缩比超出限制')
    }
  }
  const indexEntry = entries.find(entry => entry.entryName === 'modrinth.index.json' && !entry.isDirectory)
  if (!indexEntry || indexEntry.header.size > MODPACK_LIMITS.indexBytes) throw new Error('缺少有效的 modrinth.index.json')
  const index = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(getEntryData(indexEntry))), '索引')
  if (index.formatVersion !== 1 || index.game !== 'minecraft') throw new Error('仅支持 Minecraft 的 Modrinth 整合包格式 1')
  const name = text(index.name, '名称', 256)
  const versionId = text(index.versionId, '版本标识', 256)
  const summary = index.summary === undefined || index.summary === '' ? undefined : text(index.summary, '说明', 4096)
  const dependencies = object(index.dependencies, '依赖')
  if (Object.keys(dependencies).length > 16 || Object.keys(dependencies).some(key => key.length > 64)) throw new Error('整合包依赖列表无效')
  const minecraftVersion = text(dependencies.minecraft, 'Minecraft 版本', 64)
  const loaderKeys = { 'fabric-loader': 'fabric', forge: 'forge', neoforge: 'neoforge' } as const
  const selected = Object.keys(loaderKeys).filter(key => dependencies[key] !== undefined) as Array<keyof typeof loaderKeys>
  if (selected.length > 1) throw new Error('整合包不能同时指定多个模组加载器')
  const unsupported = Object.keys(dependencies).filter(key => key !== 'minecraft' && !(key in loaderKeys))
  const loader: PackPreview['loader'] = selected.length ? loaderKeys[selected[0]] : 'vanilla'
  const loaderVersion = selected.length ? text(dependencies[selected[0]], '加载器版本', 64) : undefined
  if (loaderVersion && (!/^[a-zA-Z0-9_.+\-]+$/.test(loaderVersion) || loaderVersion.includes('..'))) throw new Error('加载器版本格式无效')
  const unsupportedReason = unsupported.length
    ? `暂不支持整合包依赖：${unsupported.join('、')}；当前支持原版、Fabric、Forge 和 NeoForge`
    : !supportedMinecraft(minecraftVersion) ? '当前仅支持 Minecraft 1.20.1 及之后的正式版本' : undefined
  if (!Array.isArray(index.files) || index.files.length > MODPACK_LIMITS.files) throw new Error('整合包文件列表无效或数量超出限制')
  const indexedPaths = new PathIndex()
  const outputPaths = new PathIndex()
  const files: PackFile[] = []
  const provenance: PackProvenance[] = [], effectiveRecords = new Map<string, number>()
  let downloadBytes = 0
  for (const item of index.files) {
    const file = object(item, '文件')
    const filePath = validatePackPath(file.path)
    indexedPaths.add(filePath)
    const hashes = object(file.hashes, '文件校验值')
    if (typeof hashes.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(hashes.sha1) ||
        typeof hashes.sha512 !== 'string' || !/^[a-f0-9]{128}$/i.test(hashes.sha512)) {
      throw new Error(`整合包文件缺少有效的 SHA-1 / SHA-512：${filePath}`)
    }
    const fileSize = integer(file.fileSize, '文件', MODPACK_LIMITS.downloadedFileBytes)
    if (!Array.isArray(file.downloads) || !file.downloads.length || file.downloads.length > 8) throw new Error('整合包文件下载链接无效')
    const downloads = file.downloads.map(validatePackUrl)
    const environment = file.env === undefined ? undefined : object(file.env, '客户端环境')
    if (environment && (Object.keys(environment).some(side => !['client', 'server'].includes(side)) || ['client', 'server'].some(side => !['required', 'optional', 'unsupported'].includes(String(environment[side]))))) {
      throw new Error('整合包文件环境必须使用 required、optional 或 unsupported')
    }
    const client = (environment?.client ?? 'required') as PackPlanEnvironment, server = (environment?.server ?? 'required') as PackPlanEnvironment
    const recordIndex = provenance.length
    provenance.push({ origin: 'indexed', role: client === 'unsupported' ? 'server-excluded' : client === 'optional' ? 'optional' : 'required', path: filePath,
      bytes: fileSize, sizeBasis: 'declared-download', environment: { client, server, implicit: environment === undefined },
      sha1: hashes.sha1.toLowerCase(), sha512: hashes.sha512.toLowerCase(), hashBasis: 'index-declaration', effective: client !== 'unsupported' })
    if (environment?.client === 'unsupported') continue
    outputPaths.add(filePath)
    effectiveRecords.set(filePath, recordIndex)
    downloadBytes += fileSize
    if (downloadBytes > MODPACK_LIMITS.totalBytes) throw new Error('整合包下载总大小超出 8 GiB 限制')
    files.push({ path: filePath, downloads, hashes: { sha1: hashes.sha1.toLowerCase(), sha512: hashes.sha512.toLowerCase() },
      fileSize, optional: environment?.client === 'optional' })
  }
  const overrides = new Map<string, PackOverride>()
  for (const prefix of ['overrides/', 'client-overrides/']) {
    for (const entry of entries) {
      if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue
      const relative = validatePackPath(entry.entryName.slice(prefix.length))
      outputPaths.add(relative, false, true)
      const data = getEntryData(entry), origin = prefix === 'overrides/' ? 'overrides' : 'client-overrides', recordIndex = provenance.length
      const previous = effectiveRecords.get(relative)
      if (previous !== undefined) { provenance[previous].effective = false; provenance[previous].shadowedBy = recordIndex }
      provenance.push({ origin, role: origin, path: relative, bytes: data.length, sizeBasis: 'verified-archive',
        sha1: createHash('sha1').update(data).digest('hex'), sha512: createHash('sha512').update(data).digest('hex'), hashBasis: 'archive-payload', effective: true })
      effectiveRecords.set(relative, recordIndex)
      overrides.set(relative, { path: relative, data })
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory || !entry.entryName.startsWith('server-overrides/')) continue
    const relative = validatePackPath(entry.entryName.slice('server-overrides/'.length))
    // The client does not inflate excluded server overrides. Header sizes are
    // bounded above but not represented as verified payload bytes or CRCs.
    provenance.push({ origin: 'server-overrides', role: 'server-excluded', path: relative, bytes: entry.header.size,
      sizeBasis: 'declared-archive', effective: false })
  }
  // Final override content replaces any indexed download at the same exact path.
  const effectiveFiles = files.filter(file => !overrides.has(file.path))
  const overrideList = [...overrides.values()]
  const totalBytes = effectiveFiles.reduce((sum, file) => sum + file.fileSize, 0) +
    overrideList.reduce((sum, file) => sum + file.data.length, 0)
  if (totalBytes > MODPACK_LIMITS.totalBytes || effectiveFiles.length + overrides.size > MODPACK_LIMITS.files) {
    throw new Error('整合包客户端文件总大小或数量超出限制')
  }
  return {
    archive, files: effectiveFiles, overrides: overrideList, provenance,
    preview: { name, versionId, summary, minecraftVersion, loader, loaderVersion,
      fileCount: effectiveFiles.length + overrides.size, totalBytes,
      optionalFileCount: effectiveFiles.filter(file => file.optional).length, unsupportedReason },
  }
}
