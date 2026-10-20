import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import type { WorldSelection } from './world-types'
import type { WorldBackupList, WorldBackupProgress, WorldBackupResult, WorldBackupSummary } from './world-backup-types'
import { BACKUP_LIMITS, BACKUP_UUID, backupIdentifier, backupNameKey, backupRelativePath, backupSafeName,
  backupSummary, parseBackupIntent, parseBackupManifest, parseBackupReceipt, worldItemId,
  type BackupEntry, type BackupIntent, type BackupManifest, type BackupReceipt } from './world-backup-manifest'
export { BACKUP_LIMITS } from './world-backup-manifest'

export type WorldBackupErrorCode = 'INVALID_INPUT' | 'BUSY' | 'SOURCE_CHANGED' | 'DESTINATION_CHANGED' |
  'UNSAFE_PATH' | 'NAME_COLLISION' | 'UNSUPPORTED_ENTRY' | 'LIMIT_EXCEEDED' | 'INSUFFICIENT_SPACE' | 'IO_ERROR' | 'RECOVERY_REQUIRED'
const messages: Record<WorldBackupErrorCode, string> = {
  INVALID_INPUT: '世界备份参数无效', BUSY: '已有世界备份进行中，请稍后重试', SOURCE_CHANGED: '源世界发生变化，请关闭游戏后重新备份',
  DESTINATION_CHANGED: '备份目录发生变化，未完成资料已保留', UNSAFE_PATH: '备份路径包含不安全的目录或文件',
  NAME_COLLISION: '备份文件名存在大小写或 Unicode 冲突', UNSUPPORTED_ENTRY: '世界含不支持的链接、特殊文件或挂载目录，未跳过这些内容',
  LIMIT_EXCEEDED: '世界备份超出文件数量、大小、路径或耗时上限', INSUFFICIENT_SPACE: '备份磁盘可用空间不足',
  IO_ERROR: '世界备份文件操作未完成', RECOVERY_REQUIRED: '备份提交状态无法确认，资料已保留，请检查备份目录',
}
export class WorldBackupError extends Error {
  constructor(public readonly code: WorldBackupErrorCode, public readonly retainedBackupId?: string) {
    super(messages[code]); this.name = 'WorldBackupError'
  }
}
export interface WorldBackupOptions {
  backupRoot: string; instanceId: string; operationId: string; signal?: AbortSignal
  onProgress?: (progress: WorldBackupProgress) => void
}
type Budget = { check(): void; consumeMetadata(bytes: number): void }
type Chain = Map<string, BigIntStats>
type TreeEntry = { type: 'file' | 'directory'; info: BigIntStats }
type Tree = Map<string, TreeEntry>
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code
const fail = (code: WorldBackupErrorCode): never => { throw new WorldBackupError(code) }
const readFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
const sameNode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
const sameStable = (a: BigIntStats, b: BigIntStats) => sameNode(a, b) && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
const fileAt = (root: string, relative: string) => relative ? path.join(root, ...relative.split('/')) : root
let activeBackup = false

function budgetFor(signal?: AbortSignal, list = false): Budget {
  const end = performance.now() + (list ? BACKUP_LIMITS.listDurationMs : BACKUP_LIMITS.durationMs)
  let metadata = 0
  return { check() {
    if (signal?.aborted) throw new DOMException('世界备份已取消；未完成目录会保留', 'AbortError')
    if (performance.now() >= end) fail('LIMIT_EXCEEDED')
  }, consumeMetadata(bytes) {
    metadata += bytes
    if (list && metadata > BACKUP_LIMITS.listMetadataBytes) fail('LIMIT_EXCEEDED')
  } }
}
const committedBudget: Budget = { check() {}, consumeMetadata() {} }
function absolute(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 32768 || /[\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_INPUT')
  const normalized = path.resolve(value)
  if (normalized === path.parse(normalized).root) fail('INVALID_INPUT')
  return normalized
}
function selectionCheck(selection: WorldSelection): void {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(selection)) || Reflect.ownKeys(selection).length !== 2 ||
      Reflect.ownKeys(selection).some(key => typeof key !== 'string' || !['itemId', 'name'].includes(key) ||
        !('value' in Object.getOwnPropertyDescriptor(selection, key)!)) ||
      !backupSafeName(selection.name) || selection.itemId !== worldItemId(selection.name)) fail('INVALID_INPUT')
}
function mappedError(error: unknown, retainedBackupId?: string): WorldBackupError {
  if (error instanceof WorldBackupError) return new WorldBackupError(error.code, retainedBackupId ?? error.retainedBackupId)
  return new WorldBackupError(['ENOSPC', 'EDQUOT'].includes(errno(error) ?? '') ? 'INSUFFICIENT_SPACE' : 'IO_ERROR', retainedBackupId)
}

/** No recursive mkdir: validate every existing/created ancestor, including junctions. */
async function chain(directory: string, budget: Budget, create = false, allowMissing = false): Promise<Chain> {
  let current = path.parse(directory).root
  const result: Chain = new Map()
  for (const segment of directory.slice(current.length).split(path.sep)) {
    budget.check()
    const parent = current; current = path.join(current, segment)
    let info: BigIntStats
    try { info = await fs.lstat(current, { bigint: true }) } catch (error) {
      if (errno(error) !== 'ENOENT') throw error
      if (!create) { if (allowMissing) return result; throw error }
      const previous = result.get(parent)
      if (previous && !sameNode(previous, await fs.lstat(parent, { bigint: true }))) fail('DESTINATION_CHANGED')
      try { await fs.mkdir(current, { mode: 0o700 }) } catch (mkdirError) { if (errno(mkdirError) !== 'EEXIST') throw mkdirError }
      info = await fs.lstat(current, { bigint: true })
    }
    budget.check()
    if (info.isSymbolicLink()) {
      const allowed = process.platform === 'darwin' && current !== directory &&
        ((current === '/tmp' && await fs.realpath(current) === '/private/tmp') ||
         (current === '/var' && await fs.realpath(current) === '/private/var'))
      if (!allowed) fail('UNSAFE_PATH')
    } else if (!info.isDirectory()) fail('UNSAFE_PATH')
    result.set(current, info)
  }
  return result
}
async function verifyChain(expected: Chain, budget: Budget, code: WorldBackupErrorCode): Promise<void> {
  const last = [...expected.keys()].at(-1)
  if (!last) fail(code)
  const actual = await chain(last!, budget)
  for (const [name, info] of expected) if (!actual.has(name) || !sameNode(info, actual.get(name)!)) fail(code)
}
async function canonicalCandidate(directory: string, budget: Budget): Promise<string> {
  const existing = await chain(directory, budget, false, true)
  const ancestor = [...existing.keys()].at(-1) ?? path.parse(directory).root
  return path.join(await fs.realpath(ancestor), path.relative(ancestor, directory))
}
function overlaps(first: string, second: string): boolean {
  const a = process.platform === 'win32' ? first.toLowerCase() : first
  const b = process.platform === 'win32' ? second.toLowerCase() : second
  const within = (x: string, y: string) => { const r = path.relative(x, y); return !r || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)) }
  return within(a, b) || within(b, a)
}
async function names(directory: string, max: number, budget: Budget): Promise<string[]> {
  budget.check()
  const handle = await fs.opendir(directory), result: string[] = []
  try {
    while (true) {
      budget.check(); const entry = await handle.read(); budget.check()
      if (!entry) break
      if (result.length >= max) fail('LIMIT_EXCEEDED')
      result.push(entry.name)
      if ((result.length & 255) === 0) await yieldTurn()
    }
  } finally { await handle.close() }
  return result.sort()
}
async function selectedWorld(saves: string, selected: string, budget: Budget) {
  const candidates = (await names(saves, BACKUP_LIMITS.directoryEntries, budget)).filter(name => backupNameKey(name) === backupNameKey(selected))
  if (candidates.length !== 1 || candidates[0] !== selected) fail(candidates.length ? 'NAME_COLLISION' : 'SOURCE_CHANGED')
}
async function scanTree(root: string, budget: Budget, progress?: (entries: number) => void): Promise<Tree> {
  const rootInfo = await fs.lstat(root, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('UNSAFE_PATH')
  const result: Tree = new Map([['', { type: 'directory', info: rootInfo }]])
  let total = 0, manifestEstimate = 1024
  async function visit(relative: string, expected: BigIntStats): Promise<void> {
    budget.check()
    const directory = fileAt(root, relative)
    const before = await fs.lstat(directory, { bigint: true })
    if (!sameStable(expected, before) || !before.isDirectory() || before.isSymbolicLink()) fail('SOURCE_CHANGED')
    const children = await names(directory, BACKUP_LIMITS.directoryEntries, budget), keys = new Set<string>()
    for (const name of children) {
      budget.check()
      if (!backupSafeName(name)) fail('UNSAFE_PATH')
      const key = backupNameKey(name)
      if (keys.has(key)) fail('NAME_COLLISION')
      keys.add(key)
      const next = relative ? `${relative}/${name}` : name
      if (!backupRelativePath(next) || result.size - 1 >= BACKUP_LIMITS.entries) fail('LIMIT_EXCEEDED')
      manifestEstimate += Buffer.byteLength(next) + 256
      if (manifestEstimate > BACKUP_LIMITS.manifestBytes) fail('LIMIT_EXCEEDED')
      const info = await fs.lstat(fileAt(root, next), { bigint: true })
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || info.dev !== rootInfo.dev ||
          (info.isFile() && info.nlink !== 1n)) fail('UNSUPPORTED_ENTRY')
      if (info.isFile()) {
        if (info.size < 0n || info.size > BigInt(BACKUP_LIMITS.fileBytes)) fail('LIMIT_EXCEEDED')
        total += Number(info.size)
        if (total > BACKUP_LIMITS.totalBytes) fail('LIMIT_EXCEEDED')
      }
      result.set(next, { type: info.isDirectory() ? 'directory' : 'file', info })
      progress?.(result.size - 1)
      if (info.isDirectory()) await visit(next, info)
    }
    if (!sameStable(before, await fs.lstat(directory, { bigint: true }))) fail('SOURCE_CHANGED')
  }
  await visit('', rootInfo)
  return result
}
function compareTrees(before: Tree, after: Tree, code: WorldBackupErrorCode) {
  if (before.size !== after.size) fail(code)
  for (const [name, entry] of before) {
    const actual = after.get(name)
    if (!actual || actual.type !== entry.type || !sameStable(entry.info, actual.info)) fail(code)
  }
}
async function treeAncestors(root: string, relative: string, tree: Tree, budget: Budget, strict: boolean, code: WorldBackupErrorCode) {
  const parts = relative.split('/').slice(0, -1)
  for (let i = 0; i <= parts.length; i++) {
    budget.check()
    const key = parts.slice(0, i).join('/'), expected = tree.get(key)
    const actual = await fs.lstat(fileAt(root, key), { bigint: true })
    if (!expected || !actual.isDirectory() || actual.isSymbolicLink() ||
        !(strict ? sameStable : sameNode)(expected.info, actual)) fail(code)
  }
}
async function closeAll(handles: (fs.FileHandle | undefined)[]): Promise<void> {
  const results = await Promise.allSettled(handles.filter(Boolean).map(handle => handle!.close()))
  if (results.some(result => result.status === 'rejected')) fail('IO_ERROR')
}
async function verifyOpenFile(file: string, expected: BigIntStats, handle: fs.FileHandle, code: WorldBackupErrorCode) {
  const current = await fs.lstat(file, { bigint: true }), descriptor = await handle.stat({ bigint: true })
  if (!current.isFile() || current.isSymbolicLink() || !descriptor.isFile() ||
      !sameStable(current, expected) || !sameStable(descriptor, expected)) fail(code)
}
async function writeAll(handle: fs.FileHandle, bytes: Buffer, position: number, budget: Budget): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    budget.check()
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset)
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.length - offset) fail('IO_ERROR')
    offset += bytesWritten
  }
}
async function transfer(
  source: string, expected: BigIntStats, budget: Budget, onBytes: (count: number) => void, destination?: string,
  changedCode: WorldBackupErrorCode = 'SOURCE_CHANGED',
): Promise<{ digest: string; destinationInfo?: BigIntStats }> {
  let input: fs.FileHandle | undefined, output: fs.FileHandle | undefined
  try {
    budget.check()
    const before = await fs.lstat(source, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !sameStable(before, expected)) fail(changedCode)
    input = await fs.open(source, readFlags)
    await verifyOpenFile(source, expected, input, changedCode)
    if (destination) output = await fs.open(destination, 'wx', 0o600)
    const hash = createHash('sha256'), buffer = Buffer.alloc(BACKUP_LIMITS.bufferBytes)
    let offset = 0
    while (offset < Number(expected.size)) {
      budget.check()
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, Number(expected.size) - offset), offset)
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > Math.min(buffer.length, Number(expected.size) - offset)) fail(changedCode)
      const data = buffer.subarray(0, bytesRead)
      if (output) await writeAll(output, data, offset, budget)
      hash.update(data); offset += bytesRead; onBytes(bytesRead)
    }
    budget.check()
    await verifyOpenFile(source, expected, input, changedCode)
    let destinationInfo: BigIntStats | undefined
    if (output) {
      await output.sync(); destinationInfo = await output.stat({ bigint: true })
      if (!destinationInfo.isFile() || destinationInfo.nlink !== 1n || destinationInfo.size !== expected.size) fail('DESTINATION_CHANGED')
      await verifyOpenFile(destination!, destinationInfo, output, 'DESTINATION_CHANGED')
    }
    return { digest: hash.digest('hex'), destinationInfo }
  } finally { await closeAll([input, output]) }
}
async function writeControl(file: string, bytes: Buffer, budget: Budget): Promise<BigIntStats> {
  let handle: fs.FileHandle | undefined
  try {
    budget.check(); handle = await fs.open(file, 'wx', 0o600)
    await writeAll(handle, bytes, 0, budget); await handle.sync()
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(bytes.length)) fail('DESTINATION_CHANGED')
    await verifyOpenFile(file, info, handle, 'DESTINATION_CHANGED')
    return info
  } finally { await closeAll([handle]) }
}
async function readControl(file: string, max: number, budget: Budget, allowReceiptLink = false): Promise<{ bytes: Buffer; info: BigIntStats }> {
  let handle: fs.FileHandle | undefined
  try {
    budget.check()
    const info = await fs.lstat(file, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink() || info.size < 0n || info.size > BigInt(max) ||
        (info.nlink !== 1n && !(allowReceiptLink && info.nlink === 2n))) fail('UNSAFE_PATH')
    budget.consumeMetadata(Number(info.size))
    handle = await fs.open(file, readFlags); await verifyOpenFile(file, info, handle, 'DESTINATION_CHANGED')
    const bytes = Buffer.alloc(Number(info.size))
    let offset = 0
    while (offset < bytes.length) {
      budget.check()
      const result = await handle.read(bytes, offset, Math.min(BACKUP_LIMITS.bufferBytes, bytes.length - offset), offset)
      if (result.bytesRead <= 0) fail('DESTINATION_CHANGED')
      offset += result.bytesRead
    }
    await verifyOpenFile(file, info, handle, 'DESTINATION_CHANGED'); budget.check()
    return { bytes, info }
  } finally { await closeAll([handle]) }
}
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
async function validateControls(container: string, expectedNames: string[], budget: Budget) {
  const actual = await names(container, 8, budget)
  if (actual.join('\0') !== [...expectedNames].sort().join('\0')) fail('DESTINATION_CHANGED')
}

/** Copies ordinary files only. Failure/cancellation retains the whole incomplete container; no cleanup deletes anything. */
export async function createWorldDirectoryBackup(
  instanceDirectory: string, selection: WorldSelection, options: WorldBackupOptions,
): Promise<WorldBackupResult> {
  let retained: string | undefined, reserved = false
  const warnings: string[] = []
  try {
    selectionCheck(selection)
    if (!options || !backupIdentifier(options.instanceId) || !backupIdentifier(options.operationId)) fail('INVALID_INPUT')
    const instance = absolute(instanceDirectory), backupRoot = absolute(options.backupRoot)
    const budget = budgetFor(options.signal); budget.check()
    if (activeBackup) fail('BUSY')
    activeBackup = reserved = true
    const saves = path.join(instance, 'game', 'saves'), world = path.join(saves, selection.name)
    const sourceChain = await chain(world, budget)
    await selectedWorld(saves, selection.name, budget)
    if (overlaps(await fs.realpath(world), await canonicalCandidate(backupRoot, budget))) fail('UNSAFE_PATH')
    function progress(value: WorldBackupProgress) {
      const warn = () => { if (!warnings.includes('进度通知失败；备份操作仍按实际校验结果完成。')) warnings.push('进度通知失败；备份操作仍按实际校验结果完成。') }
      try {
        const result: unknown = options.onProgress?.({ ...value })
        // A TypeScript void callback can still be async. Never let its rejected
        // promise escape as an unhandled rejection or become the commit result.
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') void Promise.resolve(result).catch(warn)
      } catch { warn() }
    }
    progress({ phase: 'scan', filesDone: 0, bytesDone: 0 })
    const sourceTree = await scanTree(world, budget, () => {})
    const entries: BackupEntry[] = [...sourceTree].filter(([name]) => name).map(([name, entry]) => entry.type === 'directory' ?
      { path: name, type: 'directory', sourceMtimeNs: String(entry.info.mtimeNs), sourceMode: Number(entry.info.mode) } :
      { path: name, type: 'file', sourceMtimeNs: String(entry.info.mtimeNs), sourceMode: Number(entry.info.mode), sizeBytes: Number(entry.info.size), sha256: '' })
    const files = entries.filter((entry): entry is Extract<BackupEntry, { type: 'file' }> => entry.type === 'file')
    const totalBytes = files.reduce((sum, entry) => sum + entry.sizeBytes, 0)
    const parent = path.join(backupRoot, options.instanceId)
    const destinationChain = await chain(parent, budget, true)
    if (overlaps(await fs.realpath(world), await fs.realpath(backupRoot))) fail('UNSAFE_PATH')
    const space = await fs.statfs(parent, { bigint: true }); budget.check()
    const reserve = BigInt(Math.max(256 * 1024 ** 2, Math.ceil(totalBytes * 0.05)))
    if (space.bavail * space.bsize < BigInt(totalBytes + BACKUP_LIMITS.manifestBytes) + reserve) fail('INSUFFICIENT_SPACE')
    const backupId = randomUUID(), container = path.join(parent, backupId), payload = path.join(container, 'world')
    await verifyChain(sourceChain, budget, 'SOURCE_CHANGED'); await verifyChain(destinationChain, budget, 'DESTINATION_CHANGED')
    budget.check(); await fs.mkdir(container, { mode: 0o700 }); retained = backupId
    const containerChain = await chain(container, budget)
    const createdAt = new Date().toISOString()
    const intent: BackupIntent = { schema: 1, backupId, instanceId: options.instanceId, operationId: options.operationId,
      worldItemId: selection.itemId, worldFolderName: selection.name, createdAt }
    const intentBytes = jsonBytes(intent)
    const intentInfo = await writeControl(path.join(container, 'intent.json'), intentBytes, budget)
    await fs.mkdir(payload, { mode: 0o700 })
    const created: Tree = new Map([['', { type: 'directory', info: await fs.lstat(payload, { bigint: true }) }]])
    let filesDone = 0, bytesDone = 0
    for (const entry of entries) {
      budget.check(); await verifyChain(sourceChain, budget, 'SOURCE_CHANGED'); await verifyChain(containerChain, budget, 'DESTINATION_CHANGED')
      await treeAncestors(world, entry.path, sourceTree, budget, true, 'SOURCE_CHANGED')
      await treeAncestors(payload, entry.path, created, budget, false, 'DESTINATION_CHANGED')
      const target = fileAt(payload, entry.path)
      if (entry.type === 'directory') {
        await fs.mkdir(target, { mode: 0o700 }); created.set(entry.path, { type: 'directory', info: await fs.lstat(target, { bigint: true }) })
      } else {
        const copied = await transfer(fileAt(world, entry.path), sourceTree.get(entry.path)!.info, budget, amount => {
          bytesDone += amount; progress({ phase: 'copy', filesDone, filesTotal: files.length, bytesDone, bytesTotal: totalBytes })
        }, target)
        entry.sha256 = copied.digest; created.set(entry.path, { type: 'file', info: copied.destinationInfo! }); filesDone++
        progress({ phase: 'copy', filesDone, filesTotal: files.length, bytesDone, bytesTotal: totalBytes })
      }
    }
    const destinationTree = await scanTree(payload, budget)
    if (destinationTree.size !== created.size) fail('DESTINATION_CHANGED')
    for (const [name, entry] of created) {
      const actual = destinationTree.get(name)
      if (!actual || actual.type !== entry.type || !(entry.type === 'file' ? sameStable : sameNode)(entry.info, actual.info)) fail('DESTINATION_CHANGED')
    }
    for (const [phase, base, tree] of [
      ['verify-destination', payload, destinationTree], ['verify-source', world, sourceTree],
    ] as const) {
      await verifyChain(sourceChain, budget, 'SOURCE_CHANGED'); await verifyChain(containerChain, budget, 'DESTINATION_CHANGED')
      if (phase === 'verify-source') compareTrees(sourceTree, await scanTree(world, budget), 'SOURCE_CHANGED')
      filesDone = bytesDone = 0; progress({ phase, filesDone, filesTotal: files.length, bytesDone, bytesTotal: totalBytes })
      for (const entry of files) {
        await treeAncestors(base, entry.path, tree, budget, true, phase === 'verify-source' ? 'SOURCE_CHANGED' : 'DESTINATION_CHANGED')
        const verified = await transfer(fileAt(base, entry.path), tree.get(entry.path)!.info, budget, amount => {
          bytesDone += amount; progress({ phase, filesDone, filesTotal: files.length, bytesDone, bytesTotal: totalBytes })
        }, undefined, phase === 'verify-source' ? 'SOURCE_CHANGED' : 'DESTINATION_CHANGED')
        if (verified.digest !== entry.sha256) fail(phase === 'verify-source' ? 'SOURCE_CHANGED' : 'DESTINATION_CHANGED')
        filesDone++; progress({ phase, filesDone, filesTotal: files.length, bytesDone, bytesTotal: totalBytes })
      }
    }
    compareTrees(sourceTree, await scanTree(world, budget), 'SOURCE_CHANGED')
    compareTrees(destinationTree, await scanTree(payload, budget), 'DESTINATION_CHANGED')
    const completedAt = new Date(Math.max(Date.now(), Date.parse(createdAt))).toISOString()
    const manifest: BackupManifest = { schema: 1, backupId, instanceId: options.instanceId, worldItemId: selection.itemId,
      worldFolderName: selection.name, format: 'directory', createdAt, completedAt, fileCount: files.length,
      directoryCount: entries.length - files.length, totalBytes, verification: { algorithm: 'sha256', destinationReadback: true, sourceSecondPass: true }, entries }
    const manifestBytes = jsonBytes(manifest)
    if (manifestBytes.length > BACKUP_LIMITS.manifestBytes) fail('LIMIT_EXCEEDED')
    parseBackupManifest(manifestBytes)
    const manifestInfo = await writeControl(path.join(container, 'manifest.json'), manifestBytes, budget)
    const receipt: BackupReceipt = { schema: 1, backupId, completedAt, manifestSha256: sha(manifestBytes) }
    const receiptBytes = jsonBytes(receipt), temporaryName = `.complete-${randomUUID()}.tmp`
    const temporary = path.join(container, temporaryName), complete = path.join(container, 'COMPLETE.json')
    const receiptInfo = await writeControl(temporary, receiptBytes, budget)
    progress({ phase: 'commit', filesDone: files.length, filesTotal: files.length, bytesDone: totalBytes, bytesTotal: totalBytes })
    // Observers may run arbitrary UI callbacks: final verification happens after notification.
    await verifyChain(sourceChain, budget, 'SOURCE_CHANGED'); await verifyChain(containerChain, budget, 'DESTINATION_CHANGED')
    await selectedWorld(saves, selection.name, budget)
    compareTrees(sourceTree, await scanTree(world, budget), 'SOURCE_CHANGED')
    compareTrees(destinationTree, await scanTree(payload, budget), 'DESTINATION_CHANGED')
    await validateControls(container, ['world', 'intent.json', 'manifest.json', temporaryName], budget)
    for (const [file, bytes, info, max] of [
      [path.join(container, 'intent.json'), intentBytes, intentInfo, BACKUP_LIMITS.controlBytes],
      [path.join(container, 'manifest.json'), manifestBytes, manifestInfo, BACKUP_LIMITS.manifestBytes],
      [temporary, receiptBytes, receiptInfo, BACKUP_LIMITS.controlBytes],
    ] as const) {
      const actual = await readControl(file, max, budget)
      if (!sameStable(info, actual.info) || !actual.bytes.equals(bytes)) fail('DESTINATION_CHANGED')
    }
    budget.check()
    let linkError: unknown
    try { await fs.link(temporary, complete) } catch (error) { linkError = error }
    // A link may have succeeded despite an acknowledgement error (e.g. NFS).
    // From this point a provable commit wins over cancellation/deadline.
    try {
      await verifyChain(containerChain, committedBudget, 'DESTINATION_CHANGED')
      const published = await readControl(complete, BACKUP_LIMITS.controlBytes, committedBudget, true)
      const original = await readControl(temporary, BACKUP_LIMITS.controlBytes, committedBudget, true)
      if (!sameNode(receiptInfo, published.info) || receiptInfo.size !== published.info.size || receiptInfo.mtimeNs !== published.info.mtimeNs ||
          !sameStable(published.info, original.info) || published.info.nlink !== 2n ||
          !published.bytes.equals(receiptBytes) || !original.bytes.equals(receiptBytes)) fail('RECOVERY_REQUIRED')
    } catch {
      // Only an unchanged container with an actually absent marker proves that
      // we may report the original write failure. Inaccessibility is not absence.
      let definitelyAbsent = false
      try {
        await verifyChain(containerChain, committedBudget, 'DESTINATION_CHANGED')
        try { await fs.lstat(complete, { bigint: true }) }
        catch (error) { if (errno(error) === 'ENOENT') definitelyAbsent = true }
      } catch { /* Keep the uncertain transaction visible for inspection. */ }
      if (linkError && definitelyAbsent) throw linkError
      fail('RECOVERY_REQUIRED')
    }
    if (linkError) warnings.push('完成凭据的提交响应异常；已通过本次文件身份与字节确认提交成功。')
    // Retain intent and the linked temporary receipt. No deletion, including on failure.
    let directoryHandle: fs.FileHandle | undefined
    try {
      directoryHandle = await fs.open(container, readFlags)
      if (!sameNode(containerChain.get(container)!, await directoryHandle.stat({ bigint: true }))) fail('DESTINATION_CHANGED')
      await directoryHandle.sync()
    } catch { warnings.push('目录同步未确认；完成凭据已提交，不能保证存储设备断电耐久性。') }
    finally { try { await directoryHandle?.close() } catch { warnings.push('备份目录句柄关闭未确认。') } }
    return { ...backupSummary(manifest), warnings }
  } catch (error) {
    if (error instanceof WorldBackupError && error.code === 'RECOVERY_REQUIRED') throw mappedError(error, retained)
    if (options?.signal?.aborted) throw Object.assign(new DOMException('世界备份已取消；未完成目录会保留', 'AbortError'),
      retained ? { retainedBackupId: retained } : {})
    throw mappedError(error, retained)
  } finally { if (reserved) activeBackup = false }
}

async function completedContainer(root: string, instanceId: string, backupId: string, budget: Budget): Promise<WorldBackupSummary> {
  const container = path.join(root, instanceId, backupId), expected = await chain(container, budget)
  const controls = await names(container, 8, budget)
  const temporary = controls.filter(name => /^\.complete-[0-9a-f-]+\.tmp$/.test(name) && BACKUP_UUID.test(name.slice(10, -4)))
  if (temporary.length > 1 || controls.length !== 4 + temporary.length ||
      controls.some(name => !['world', 'intent.json', 'manifest.json', 'COMPLETE.json', ...temporary].includes(name))) fail('RECOVERY_REQUIRED')
  const payloadInfo = await fs.lstat(path.join(container, 'world'), { bigint: true })
  if (!payloadInfo.isDirectory() || payloadInfo.isSymbolicLink()) fail('UNSAFE_PATH')
  const intentRead = await readControl(path.join(container, 'intent.json'), BACKUP_LIMITS.controlBytes, budget)
  const intent = parseBackupIntent(intentRead.bytes)
  const manifestRead = await readControl(path.join(container, 'manifest.json'), BACKUP_LIMITS.manifestBytes, budget)
  const manifest = parseBackupManifest(manifestRead.bytes)
  const receiptRead = await readControl(path.join(container, 'COMPLETE.json'), BACKUP_LIMITS.controlBytes, budget, true)
  const receipt = parseBackupReceipt(receiptRead.bytes)
  const controlIdentities = new Map([['intent.json', intentRead.info], ['manifest.json', manifestRead.info], ['COMPLETE.json', receiptRead.info]])
  if (manifest.backupId !== backupId || manifest.instanceId !== instanceId || receipt.backupId !== backupId ||
      receipt.manifestSha256 !== sha(manifestRead.bytes) || receipt.completedAt !== manifest.completedAt ||
      intent.backupId !== backupId || intent.instanceId !== instanceId || intent.worldItemId !== manifest.worldItemId ||
      intent.worldFolderName !== manifest.worldFolderName || intent.createdAt !== manifest.createdAt) fail('RECOVERY_REQUIRED')
  if (temporary[0]) {
    const temp = await readControl(path.join(container, temporary[0]), BACKUP_LIMITS.controlBytes, budget, true)
    if (!sameStable(temp.info, receiptRead.info) || temp.info.nlink !== 2n || !temp.bytes.equals(receiptRead.bytes)) fail('RECOVERY_REQUIRED')
    controlIdentities.set(temporary[0], temp.info)
  } else if (receiptRead.info.nlink !== 1n) fail('RECOVERY_REQUIRED')
  await verifyChain(expected, budget, 'DESTINATION_CHANGED')
  const payloadAfter = await fs.lstat(path.join(container, 'world'), { bigint: true })
  if (!sameNode(payloadInfo, payloadAfter) || payloadAfter.isSymbolicLink()) fail('DESTINATION_CHANGED')
  await validateControls(container, controls, budget)
  for (const [name, info] of controlIdentities) {
    budget.check()
    if (!sameStable(info, await fs.lstat(path.join(container, name), { bigint: true }))) fail('DESTINATION_CHANGED')
  }
  return backupSummary(manifest)
}

/** Historical completion receipts only. This does not rehash the GB-sized world payload. */
export async function listWorldDirectoryBackups(
  backupRoot: string, instanceId: string, options: { signal?: AbortSignal } = {},
): Promise<WorldBackupList> {
  try {
    const root = absolute(backupRoot)
    if (!backupIdentifier(instanceId)) fail('INVALID_INPUT')
    const budget = budgetFor(options.signal, true); budget.check()
    const parent = path.join(root, instanceId), expected = await chain(parent, budget, false, true)
    const result: WorldBackupList = { items: [], incompleteCount: 0, warnings: [], truncated: false }
    if (!expected.has(parent)) return result
    const handle = await fs.opendir(parent), children: string[] = []
    try {
      while (true) {
        budget.check(); const entry = await handle.read(); budget.check()
        if (!entry) break
        if (children.length >= BACKUP_LIMITS.backups) { result.truncated = true; break }
        children.push(entry.name)
      }
    } finally { await handle.close() }
    for (const name of children.sort()) {
      budget.check()
      if (!BACKUP_UUID.test(name)) { if (!result.warnings.includes('备份根中存在未知条目，未读取或删除。')) result.warnings.push('备份根中存在未知条目，未读取或删除。'); continue }
      try { result.items.push(await completedContainer(root, instanceId, name, budget)) }
      catch (error) {
        budget.check()
        if (error instanceof WorldBackupError && error.code === 'LIMIT_EXCEEDED') { result.truncated = true; break }
        result.incompleteCount++
      }
    }
    await verifyChain(expected, budget, 'DESTINATION_CHANGED')
    result.items.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.backupId.localeCompare(b.backupId))
    if (result.items.length) result.warnings.push('列表仅核对完成凭据与清单；未重新校验当前世界备份的全部文件字节。')
    if (result.incompleteCount) result.warnings.push('未完成或无法确认的备份资料已保留，仍会占用磁盘空间；不会自动删除或续传。')
    if (result.truncated) result.warnings.push('备份列表超出读取预算，只显示部分条目。')
    return result
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('备份列表读取已取消', 'AbortError')
    throw mappedError(error)
  }
}

/** Main-process-only path, derived exclusively from validated IDs and completion controls. */
export async function worldBackupDirectory(backupRoot: string, instanceId: string, backupId: string): Promise<string> {
  try {
    const root = absolute(backupRoot)
    if (!backupIdentifier(instanceId) || typeof backupId !== 'string' || !BACKUP_UUID.test(backupId)) fail('INVALID_INPUT')
    await completedContainer(root, instanceId, backupId, budgetFor(undefined, true))
    return path.join(root, instanceId, backupId)
  } catch (error) { throw mappedError(error) }
}
