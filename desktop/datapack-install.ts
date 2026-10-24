import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { captureDatapackWorld, inspectDatapackZip, DATAPACK_LIMITS, verifyDatapackWorld } from './datapack-inspect'
import type { DatapackPreview } from './datapack-types'
import type { DatapackInstallProgress, DatapackInstallRecovery, DatapackInstallResult, DatapackInstallSource } from './datapack-install-types'
import { createWorldDirectoryBackup, worldBackupDirectory } from './world-backup'
import { BACKUP_LIMITS, BACKUP_UUID, backupIdentifier, backupNameKey, backupSafeName, parseBackupIntent, parseBackupReceipt, worldItemId } from './world-backup-manifest'
import type { WorldSelection } from './world-types'

export type { DatapackInstallSource } from './datapack-install-types'
export interface DatapackInstallOptions {
  backupRoot: string
  instanceId: string
  operationId: string
  signal?: AbortSignal
  onProgress?: (progress: DatapackInstallProgress) => void
  /** Core revalidates its world revision and saved-version proof before mutation. */
  verifyWorld?: () => Promise<void>
  /** Core requires both exact instance and saved-world format declarations to match. */
  authorizePreview?: (preview: DatapackPreview) => void | Promise<void>
  backupCreator?: typeof createWorldDirectoryBackup
  /** Test seams; never passed over IPC. */
  hooks?: {
    write?: (handle: fs.FileHandle, bytes: Buffer, offset: number, length: number, position: number) => Promise<number>
    link?: typeof fs.link
    afterIntent?: () => Promise<void>
    beforePublish?: () => Promise<void>
  }
}
export type DatapackInstallErrorCode = 'INVALID_INPUT' | 'BUSY' | 'UNSAFE_PATH' | 'SOURCE_CHANGED' | 'DESTINATION_CHANGED' |
  'NAME_COLLISION' | 'INVALID_ARCHIVE' | 'INSUFFICIENT_SPACE' | 'BACKUP_FAILED' | 'IO_ERROR' | 'LIMIT_EXCEEDED' | 'RECOVERY_REQUIRED'
const messages: Record<DatapackInstallErrorCode, string> = {
  INVALID_INPUT: '数据包安装参数无效，请重新预览文件', BUSY: '此实例的数据包安装尚未结束',
  UNSAFE_PATH: '数据包源或目标包含不支持的路径、链接或特殊文件', SOURCE_CHANGED: '数据包源文件已变化，请重新预览',
  DESTINATION_CHANGED: '所选世界或目标目录已变化，请关闭游戏后刷新重试', NAME_COLLISION: '此世界已有同名或大小写、Unicode冲突条目，未覆盖任何文件',
  INVALID_ARCHIVE: '完整ZIP检查未通过，未安装数据包', INSUFFICIENT_SPACE: '数据包暂存或世界备份所需磁盘空间不足',
  BACKUP_FAILED: '新鲜完整世界备份未完成，未安装数据包，已创建资料保留', IO_ERROR: '数据包文件操作未完成，已创建资料保留',
  LIMIT_EXCEEDED: '数据包安装超过大小、数量或耗时预算',
  RECOVERY_REQUIRED: '数据包安装结果需要人工检查；已保留暂存、备份和目标，不会自动删除或覆盖，请检查 .datapack-staging 后重启',
}
export class DatapackInstallError extends Error {
  constructor(public readonly code: DatapackInstallErrorCode) { super(messages[code]); this.name = 'DatapackInstallError' }
}
function fail(code: DatapackInstallErrorCode): never { throw new DatapackInstallError(code) }
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code
const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const sameNode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
const sameFile = (a: BigIntStats, b: BigIntStats) => sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
const active = new Set<string>()
const LIMITS = { controlBytes: 16 * 1024, operations: 500, directoryEntries: 5000, recoveryBytes: 16 * 1024 ** 2, recoveryMs: 5000, operationMs: 6 * 60 * 60 * 1000 + 120000 }
type Chain = Map<string, BigIntStats>
type Budget = { check(): void }
interface Preparing { schema: 1; operationId: string; instanceId: string; world: WorldSelection; filename: string; sha512: string; archiveBytes: number; createdAt: string }
interface Intent extends Preparing { backupId: string; backupManifestSha256: string; worldDev: string; worldIno: string }
interface Complete { schema: 1; operationId: string; intentSha256: string; installedAt: string }
interface Finalized { schema: 1; operationId: string; completeSha256: string; verifiedSha512: string; verifiedAt: string }

function absolute(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 32768 || /[\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_INPUT')
  const result = path.resolve(value)
  if (result === path.parse(result).root) fail('INVALID_INPUT')
  return result
}
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!)
}
function validSelection(value: unknown): value is WorldSelection {
  return object(value, ['itemId', 'name']) && backupSafeName(value.name) && value.itemId === worldItemId(value.name)
}
function safeZip(value: unknown): value is string { return backupSafeName(value) && /\.zip$/i.test(value) && !/\p{Cf}/u.test(value) }
function timestamp(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value }
function validPreparing(value: unknown, operationId: string): value is Preparing {
  return object(value, ['schema', 'operationId', 'instanceId', 'world', 'filename', 'sha512', 'archiveBytes', 'createdAt']) && value.schema === 1 &&
    value.operationId === operationId && BACKUP_UUID.test(operationId) && backupIdentifier(value.instanceId) && validSelection(value.world) && safeZip(value.filename) &&
    typeof value.sha512 === 'string' && /^[0-9a-f]{128}$/.test(value.sha512) && Number.isSafeInteger(value.archiveBytes) &&
    Number(value.archiveBytes) >= 22 && Number(value.archiveBytes) <= DATAPACK_LIMITS.archiveBytes && timestamp(value.createdAt)
}
function validIntent(value: unknown, preparing: Preparing): value is Intent {
  if (!object(value, [...Object.keys(preparing), 'backupId', 'backupManifestSha256', 'worldDev', 'worldIno'])) return false
  return Object.keys(preparing).every(key => JSON.stringify(value[key]) === JSON.stringify(preparing[key as keyof Preparing])) &&
    typeof value.backupId === 'string' && BACKUP_UUID.test(value.backupId) && typeof value.backupManifestSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.backupManifestSha256) &&
    typeof value.worldDev === 'string' && /^\d{1,30}$/.test(value.worldDev) && typeof value.worldIno === 'string' && /^\d{1,30}$/.test(value.worldIno)
}
function makeBudget(signal?: AbortSignal, duration = LIMITS.operationMs): Budget {
  const until = performance.now() + duration
  return { check() { signal?.throwIfAborted(); if (performance.now() > until) fail('LIMIT_EXCEEDED') } }
}
const committedBudget: Budget = { check() {} }
async function chain(directory: string, budget: Budget, allowMissing = false): Promise<Chain> {
  let current = path.parse(directory).root
  const proof: Chain = new Map()
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, part); budget.check()
    let stat: BigIntStats
    try { stat = await fs.lstat(current, { bigint: true }) }
    catch (error) { if (allowMissing && errno(error) === 'ENOENT') return proof; throw error }
    budget.check()
    if (stat.isSymbolicLink()) {
      const alias = process.platform === 'darwin' && current !== directory && ((current === '/tmp' && await fs.realpath(current) === '/private/tmp') || (current === '/var' && await fs.realpath(current) === '/private/var'))
      if (!alias) fail('UNSAFE_PATH')
    } else if (!stat.isDirectory()) fail('UNSAFE_PATH')
    proof.set(current, stat)
  }
  return proof
}
async function verifyChain(expected: Chain, budget: Budget): Promise<void> {
  const directory = [...expected.keys()].at(-1)
  if (!directory) fail('UNSAFE_PATH')
  const current = await chain(directory!, budget)
  for (const [name, stat] of expected) if (!current.has(name) || !sameNode(stat, current.get(name)!)) fail('DESTINATION_CHANGED')
}
async function list(directory: string, max: number, budget: Budget): Promise<string[]> {
  const result: string[] = [], handle = await fs.opendir(directory)
  try {
    while (true) {
      budget.check(); const entry = await handle.read(); budget.check()
      if (!entry) break
      if (result.length >= max) fail('LIMIT_EXCEEDED')
      result.push(entry.name)
    }
  } finally { await handle.close() }
  return result.sort()
}
async function maybeStat(file: string): Promise<BigIntStats | undefined> {
  try { return await fs.lstat(file, { bigint: true }) } catch (error) { if (errno(error) === 'ENOENT') return undefined; throw error }
}
async function readControl(file: string, budget: Budget): Promise<{ bytes: Buffer; info: BigIntStats }> {
  await chain(path.dirname(file), budget)
  const handle = await fs.open(file, flags)
  try {
    budget.check(); const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(LIMITS.controlBytes) || before.nlink < 1n || before.nlink > 2n) fail('RECOVERY_REQUIRED')
    const bytes = Buffer.alloc(Number(before.size)); let done = 0
    while (done < bytes.length) { budget.check(); const read = await handle.read(bytes, done, bytes.length - done, done); if (!read.bytesRead) fail('RECOVERY_REQUIRED'); done += read.bytesRead }
    const after = await handle.stat({ bigint: true }), atPath = await fs.lstat(file, { bigint: true })
    if (!sameFile(before, after) || !sameFile(after, atPath)) fail('RECOVERY_REQUIRED')
    return { bytes, info: after }
  } finally { await handle.close() }
}
function json(bytes: Buffer): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
function jsonBytes(value: unknown): Buffer { return Buffer.from(JSON.stringify(value) + '\n') }
async function writeAll(handle: fs.FileHandle, bytes: Buffer, position: number, budget: Budget, writer?: NonNullable<DatapackInstallOptions['hooks']>['write']): Promise<void> {
  for (let done = 0; done < bytes.length;) {
    budget.check()
    const count = writer ? await writer(handle, bytes, done, bytes.length - done, position + done) : (await handle.write(bytes, done, bytes.length - done, position + done)).bytesWritten
    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - done) fail('IO_ERROR')
    done += count
  }
}
async function writeControl(file: string, bytes: Buffer, budget: Budget): Promise<BigIntStats> {
  if (bytes.length > LIMITS.controlBytes) fail('LIMIT_EXCEEDED')
  const handle = await fs.open(file, 'wx', 0o600)
  try { await writeAll(handle, bytes, 0, budget); await handle.sync(); budget.check(); return await handle.stat({ bigint: true }) }
  finally { await handle.close() }
}
async function hashFile(file: string, algorithm: 'sha512' | 'sha256', maximum: number, budget: Budget, expected?: BigIntStats) {
  const ancestors = await chain(path.dirname(file), budget), handle = await fs.open(file, flags)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maximum) || before.size < 0n || expected && !sameFile(expected, before)) fail('SOURCE_CHANGED')
    const hash = createHash(algorithm), buffer = Buffer.alloc(1024 ** 2)
    let done = 0
    while (done < Number(before.size)) {
      budget.check(); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - done), done)
      if (!bytesRead) fail('SOURCE_CHANGED'); hash.update(buffer.subarray(0, bytesRead)); done += bytesRead
    }
    budget.check(); const after = await handle.stat({ bigint: true }), atPath = await fs.lstat(file, { bigint: true })
    if (!sameFile(before, after) || !sameFile(after, atPath)) fail('SOURCE_CHANGED')
    await verifyChain(ancestors, budget)
    return { digest: hash.digest('hex'), info: after }
  } finally { await handle.close() }
}
async function noCollision(directory: string, filename: string, budget: Budget): Promise<void> {
  const names = await list(directory, LIMITS.directoryEntries, budget)
  if (names.some(name => backupNameKey(name) === backupNameKey(filename))) fail('NAME_COLLISION')
}
async function snapshotDatapacks(world: string, budget: Budget): Promise<{ info?: BigIntStats; entries: Map<string, BigIntStats> }> {
  const aliases = (await list(world, LIMITS.directoryEntries, budget)).filter(name => backupNameKey(name) === 'datapacks')
  if (aliases.length > 1 || aliases.length === 1 && aliases[0] !== 'datapacks') fail('NAME_COLLISION')
  const directory = path.join(world, 'datapacks'), info = await maybeStat(directory), entries = new Map<string, BigIntStats>()
  if (!info) return { entries }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PATH')
  const names = await list(directory, LIMITS.directoryEntries, budget), keys = new Set<string>()
  for (const name of names) {
    budget.check()
    if (!backupSafeName(name) || keys.has(backupNameKey(name))) fail('NAME_COLLISION')
    keys.add(backupNameKey(name)); const child = await fs.lstat(path.join(directory, name), { bigint: true })
    if (child.isSymbolicLink() || !child.isFile() && !child.isDirectory()) fail('UNSAFE_PATH')
    entries.set(name, child)
  }
  if (!sameFile(info, await fs.lstat(directory, { bigint: true }))) fail('DESTINATION_CHANGED')
  return { info, entries }
}
async function verifyDatapacks(world: string, original: Awaited<ReturnType<typeof snapshotDatapacks>>, budget: Budget): Promise<void> {
  const current = await snapshotDatapacks(world, budget)
  if (!original.info ? !!current.info : !current.info || !sameFile(original.info, current.info)) fail('DESTINATION_CHANGED')
  if (original.entries.size !== current.entries.size) fail('DESTINATION_CHANGED')
  for (const [name, stat] of original.entries) if (!current.entries.has(name) || !sameFile(stat, current.entries.get(name)!)) fail('DESTINATION_CHANGED')
}

/** Read-only historical control validation. Completed targets may later be played, edited or deleted. */
export async function inspectDatapackInstallRecovery(instanceDirectory: string, options: { signal?: AbortSignal } = {}): Promise<DatapackInstallRecovery> {
  const warnings: string[] = []
  try {
    const instance = absolute(instanceDirectory), budget = makeBudget(options.signal, LIMITS.recoveryMs), staging = path.join(instance, '.datapack-staging')
    const instanceChain = await chain(instance, budget, true)
    // A never-installed instance has no private directory or journal. Existing
    // ancestors are still checked; no missing directory is created by this read.
    if (!instanceChain.has(instance)) return { blocked: false, warnings }
    if (!await maybeStat(staging)) return { blocked: false, warnings }
    const stagingChain = await chain(staging, budget), operations = await list(staging, LIMITS.operations, budget)
    let bytesRead = 0, preparations = 0
    const control = async (file: string) => { const read = await readControl(file, budget); bytesRead += read.bytes.length; if (bytesRead > LIMITS.recoveryBytes) fail('LIMIT_EXCEEDED'); return read }
    for (const operationId of operations) {
      budget.check(); if (!BACKUP_UUID.test(operationId)) fail('RECOVERY_REQUIRED')
      const container = path.join(staging, operationId), containerChain = await chain(container, budget), names = await list(container, 8, budget)
      // Crash before PREPARING exists cannot have reached the mandatory INTENT.
      if (!names.length) { preparations++; continue }
      if (names.some(name => !['PREPARING.json', 'payload.zip', 'INTENT.json', 'COMPLETE.json', '.complete.pending', 'FINALIZED.json'].includes(name))) fail('RECOVERY_REQUIRED')
      const preparedRead = await control(path.join(container, 'PREPARING.json')), prepared = json(preparedRead.bytes)
      if (!validPreparing(prepared, operationId)) fail('RECOVERY_REQUIRED')
      if (names.includes('payload.zip')) {
        const payload = await fs.lstat(path.join(container, 'payload.zip'), { bigint: true })
        // A published payload is hard-linked to the user's target. Later game or
        // user edits must not turn a historical completion into an instance lock.
        if (!payload.isFile() || payload.isSymbolicLink() || !names.includes('COMPLETE.json') && payload.size > BigInt(DATAPACK_LIMITS.archiveBytes)) fail('RECOVERY_REQUIRED')
      }
      if (!names.includes('INTENT.json')) {
        if (names.includes('COMPLETE.json') || names.includes('.complete.pending') || names.includes('FINALIZED.json')) fail('RECOVERY_REQUIRED')
        preparations++; await verifyChain(containerChain, budget); continue
      }
      const intentRead = await control(path.join(container, 'INTENT.json')), intent = json(intentRead.bytes)
      if (!validIntent(intent, prepared) || !names.includes('COMPLETE.json') || !names.includes('FINALIZED.json')) fail('RECOVERY_REQUIRED')
      const completeRead = await control(path.join(container, 'COMPLETE.json')), complete = json(completeRead.bytes)
      if (!object(complete, ['schema', 'operationId', 'intentSha256', 'installedAt']) || complete.schema !== 1 || complete.operationId !== operationId ||
          complete.intentSha256 !== sha256(intentRead.bytes) || !timestamp(complete.installedAt) || complete.installedAt < prepared.createdAt) fail('RECOVERY_REQUIRED')
      if (names.includes('.complete.pending')) {
        const pending = await control(path.join(container, '.complete.pending'))
        if (!pending.bytes.equals(completeRead.bytes) || !sameFile(pending.info, completeRead.info) || completeRead.info.nlink !== 2n) fail('RECOVERY_REQUIRED')
      } else if (completeRead.info.nlink !== 1n) fail('RECOVERY_REQUIRED')
      const finalizedRead = await control(path.join(container, 'FINALIZED.json')), finalized = json(finalizedRead.bytes)
      if (!object(finalized, ['schema', 'operationId', 'completeSha256', 'verifiedSha512', 'verifiedAt']) || finalized.schema !== 1 || finalized.operationId !== operationId ||
          finalized.completeSha256 !== sha256(completeRead.bytes) || finalized.verifiedSha512 !== prepared.sha512 || !timestamp(finalized.verifiedAt) || finalized.verifiedAt < complete.installedAt || finalizedRead.info.nlink !== 1n) fail('RECOVERY_REQUIRED')
      await verifyChain(containerChain, budget)
      for (const [name, info] of [['PREPARING.json', preparedRead.info], ['INTENT.json', intentRead.info], ['COMPLETE.json', completeRead.info], ['FINALIZED.json', finalizedRead.info]] as const) if (!sameFile(info, await fs.lstat(path.join(container, name), { bigint: true }))) fail('RECOVERY_REQUIRED')
    }
    await verifyChain(stagingChain, budget)
    if (preparations) warnings.push(`保留了 ${preparations} 项未进入世界写入的数据包准备资料；未自动清理。`)
    return { blocked: false, warnings }
  } catch (error) {
    if (options.signal?.aborted) throw error
    return { blocked: true, warnings: [messages.RECOVERY_REQUIRED] }
  }
}

/** Fresh backup followed by one no-replace ZIP publication. All evidence is retained. */
export async function installWorldDatapack(instanceDirectory: string, selection: WorldSelection, source: DatapackInstallSource, options: DatapackInstallOptions): Promise<DatapackInstallResult> {
  let instance = '', reserved = false, intentAttempted = false
  const warnings = ['安装暂存、完成凭据和新鲜完整世界备份均保留，占用额外磁盘空间；不会自动清理。', 'Lua未修改启用列表；Minecraft可能在下次载入世界时应用此数据包，文件检查不保证游戏内容可用。']
  try {
    if (!validSelection(selection) || !object(source, ['file', 'filename', 'sha512', 'archiveBytes']) || !safeZip(source.filename) ||
        typeof source.sha512 !== 'string' || !/^[0-9a-f]{128}$/.test(source.sha512) || !Number.isSafeInteger(source.archiveBytes) || source.archiveBytes < 22 || source.archiveBytes > DATAPACK_LIMITS.archiveBytes ||
        !options || !backupIdentifier(options.instanceId) || !BACKUP_UUID.test(options.operationId)) fail('INVALID_INPUT')
    instance = absolute(instanceDirectory); const sourceFile = absolute(source.file), backupRoot = absolute(options.backupRoot), budget = makeBudget(options.signal)
    budget.check()
    if (active.has(instance)) fail('BUSY')
    active.add(instance); reserved = true
    const recovery = await inspectDatapackInstallRecovery(instance, { signal: options.signal }); if (recovery.blocked) fail('RECOVERY_REQUIRED')
    const proof = await captureDatapackWorld(instance, selection, { signal: options.signal }), initialDatapacks = await snapshotDatapacks(proof.world, budget)
    if (initialDatapacks.info) await noCollision(path.join(proof.world, 'datapacks'), source.filename, budget)
    const original = await hashFile(sourceFile, 'sha512', DATAPACK_LIMITS.archiveBytes, budget)
    if (original.digest !== source.sha512 || Number(original.info.size) !== source.archiveBytes) fail('SOURCE_CHANGED')
    await options.verifyWorld?.(); budget.check()
    const staging = path.join(instance, '.datapack-staging'), instanceChain = await chain(instance, budget)
    const existing = await maybeStat(staging)
    if (!existing) { await verifyChain(instanceChain, budget); await fs.mkdir(staging, { mode: 0o700 }) }
    const stagingChain = await chain(staging, budget), container = path.join(staging, options.operationId)
    await fs.mkdir(container, { mode: 0o700 }); const containerChain = await chain(container, budget)
    const preparing: Preparing = { schema: 1, operationId: options.operationId, instanceId: options.instanceId, world: { ...selection },
      filename: source.filename, sha512: source.sha512, archiveBytes: source.archiveBytes, createdAt: new Date().toISOString() }
    const preparingBytes = jsonBytes(preparing), preparingInfo = await writeControl(path.join(container, 'PREPARING.json'), preparingBytes, budget)
    const space = await fs.statfs(container, { bigint: true }); budget.check()
    if (space.bavail * space.bsize < BigInt(source.archiveBytes + 64 * 1024 ** 2)) fail('INSUFFICIENT_SPACE')
    const payload = path.join(container, 'payload.zip'), sourceChain = await chain(path.dirname(sourceFile), budget)
    const input = await fs.open(sourceFile, flags)
    let output: fs.FileHandle | undefined
    const progress = (value: DatapackInstallProgress) => {
      try { const returned: unknown = options.onProgress?.({ ...value }); if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') void Promise.resolve(returned).catch(() => {}) } catch { /* Progress cannot decide transaction outcome. */ }
    }
    let payloadInfo: BigIntStats
    try {
      output = await fs.open(payload, 'wx', 0o600)
      if (!sameFile(original.info, await input.stat({ bigint: true }))) fail('SOURCE_CHANGED')
      const buffer = Buffer.alloc(1024 ** 2), transferHash = createHash('sha512'); let done = 0
      progress({ phase: 'prepare', bytesDone: 0, totalBytes: source.archiveBytes })
      while (done < source.archiveBytes) {
        budget.check(); const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, source.archiveBytes - done), done)
        if (!bytesRead) fail('SOURCE_CHANGED')
        const chunk = buffer.subarray(0, bytesRead); transferHash.update(chunk)
        await writeAll(output, chunk, done, budget, options.hooks?.write); done += bytesRead
        progress({ phase: 'prepare', bytesDone: done, totalBytes: source.archiveBytes })
      }
      await output.sync(); budget.check()
      if (transferHash.digest('hex') !== source.sha512 || !sameFile(original.info, await input.stat({ bigint: true })) || !sameFile(original.info, await fs.lstat(sourceFile, { bigint: true }))) fail('SOURCE_CHANGED')
      payloadInfo = await output.stat({ bigint: true }); if (Number(payloadInfo.size) !== source.archiveBytes) fail('SOURCE_CHANGED')
    } finally { await Promise.allSettled([input.close(), ...(output ? [output.close()] : [])]) }
    await verifyChain(sourceChain, budget); await verifyChain(containerChain, budget)
    const staged = await hashFile(payload, 'sha512', DATAPACK_LIMITS.archiveBytes, budget, payloadInfo!)
    if (staged.digest !== source.sha512) fail('SOURCE_CHANGED')
    const preview = await inspectDatapackZip(payload, { signal: options.signal })
    budget.check()
    if (preview.status !== 'checked' || preview.sha512 !== source.sha512 || preview.archiveBytes !== source.archiveBytes || !preview.metadata) fail('INVALID_ARCHIVE')
    await options.authorizePreview?.(preview); await options.verifyWorld?.(); budget.check()
    await verifyDatapackWorld(proof, { signal: options.signal }); await verifyDatapacks(proof.world, initialDatapacks, budget)
    progress({ phase: 'backup', bytesDone: 0 })
    let backup
    try {
      backup = await (options.backupCreator ?? createWorldDirectoryBackup)(instance, selection, { backupRoot, instanceId: options.instanceId, operationId: options.operationId,
        signal: options.signal, onProgress: backupProgress => progress({ phase: 'backup', bytesDone: backupProgress.bytesDone, totalBytes: backupProgress.bytesTotal, backupProgress }) })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (errno(error) === 'ENOSPC' || (error as { code?: string })?.code === 'INSUFFICIENT_SPACE') fail('INSUFFICIENT_SPACE')
      fail('BACKUP_FAILED')
    }
    budget.check()
    if (!backup || backup.instanceId !== options.instanceId || backup.worldItemId !== selection.itemId || backup.worldFolderName !== selection.name || !BACKUP_UUID.test(backup.backupId)) fail('BACKUP_FAILED')
    const backupContainer = await worldBackupDirectory(backupRoot, options.instanceId, backup.backupId)
    const backupManifest = await hashFile(path.join(backupContainer, 'manifest.json'), 'sha256', BACKUP_LIMITS.manifestBytes, budget)
    const backupReceipt = parseBackupReceipt((await readControl(path.join(backupContainer, 'COMPLETE.json'), budget)).bytes)
    const backupIntent = parseBackupIntent((await readControl(path.join(backupContainer, 'intent.json'), budget)).bytes)
    if (backupReceipt.backupId !== backup.backupId || backupReceipt.manifestSha256 !== backupManifest.digest || backupIntent.operationId !== options.operationId ||
        backupIntent.createdAt < preparing.createdAt || backupIntent.instanceId !== options.instanceId || backupIntent.worldItemId !== selection.itemId || backupIntent.worldFolderName !== selection.name) fail('BACKUP_FAILED')
    progress({ phase: 'verify', bytesDone: 0, totalBytes: source.archiveBytes })
    if ((await hashFile(sourceFile, 'sha512', DATAPACK_LIMITS.archiveBytes, budget, original.info)).digest !== source.sha512 ||
        (await hashFile(payload, 'sha512', DATAPACK_LIMITS.archiveBytes, budget, staged.info)).digest !== source.sha512) fail('SOURCE_CHANGED')
    await verifyChain(stagingChain, budget); await verifyChain(containerChain, budget); await verifyDatapackWorld(proof, { signal: options.signal }); await verifyDatapacks(proof.world, initialDatapacks, budget)
    await options.verifyWorld?.(); budget.check()
    const prepareRead = await readControl(path.join(container, 'PREPARING.json'), budget)
    if (!sameFile(preparingInfo, prepareRead.info) || !prepareRead.bytes.equals(preparingBytes)) fail('DESTINATION_CHANGED')
    const intent: Intent = { ...preparing, backupId: backup.backupId, backupManifestSha256: backupManifest.digest,
      worldDev: String(proof.chain.get(proof.world)!.dev), worldIno: String(proof.chain.get(proof.world)!.ino) }
    const intentBytes = jsonBytes(intent)
    // Once creation of INTENT is attempted, any error is conservatively unresolved.
    intentAttempted = true
    const intentInfo = await writeControl(path.join(container, 'INTENT.json'), intentBytes, budget)
    const verifyControls = async () => {
      const prepared = await readControl(path.join(container, 'PREPARING.json'), committedBudget), actualIntent = await readControl(path.join(container, 'INTENT.json'), committedBudget)
      if (!sameFile(preparingInfo, prepared.info) || !prepared.bytes.equals(preparingBytes) || !sameFile(intentInfo, actualIntent.info) || !actualIntent.bytes.equals(intentBytes)) fail('RECOVERY_REQUIRED')
    }
    await options.hooks?.afterIntent?.(); budget.check()
    await verifyChain(containerChain, budget); await verifyDatapackWorld(proof, { signal: options.signal }); await verifyDatapacks(proof.world, initialDatapacks, budget); await options.verifyWorld?.(); budget.check()
    const destination = path.join(proof.world, 'datapacks')
    if (!initialDatapacks.info) await fs.mkdir(destination, { mode: 0o700 })
    const destinationChain = await chain(destination, budget)
    if (initialDatapacks.info && !sameNode(initialDatapacks.info, destinationChain.get(destination)!)) fail('DESTINATION_CHANGED')
    const publicationDatapacks = initialDatapacks.info ? initialDatapacks : await snapshotDatapacks(proof.world, budget)
    if (!initialDatapacks.info && publicationDatapacks.entries.size) fail('DESTINATION_CHANGED')
    await noCollision(destination, source.filename, budget)
    progress({ phase: 'commit', bytesDone: source.archiveBytes, totalBytes: source.archiveBytes })
    await options.hooks?.beforePublish?.(); budget.check()
    await verifyChain(proof.chain, budget); await verifyChain(destinationChain, budget); await verifyChain(containerChain, budget)
    await verifyDatapacks(proof.world, publicationDatapacks, budget)
    await noCollision(destination, source.filename, budget)
    await verifyControls(); budget.check()
    const prePublicationNames = await list(container, 4, budget)
    if (prePublicationNames.join(',') !== ['INTENT.json', 'PREPARING.json', 'payload.zip'].sort().join(',')) fail('RECOVERY_REQUIRED')
    const beforePublication = await hashFile(payload, 'sha512', DATAPACK_LIMITS.archiveBytes, budget, staged.info)
    if (beforePublication.digest !== source.sha512) fail('SOURCE_CHANGED')
    const target = path.join(destination, source.filename), link = options.hooks?.link ?? fs.link
    let publicationError: unknown
    try { await link(payload, target) } catch (error) { publicationError = error }
    // A successful no-replace link can have lost its acknowledgement. Verify bytes
    // and inode with a cancellation-free budget before deciding the outcome.
    const committedTarget = await hashFile(target, 'sha512', DATAPACK_LIMITS.archiveBytes, committedBudget)
    const committedPayload = await fs.lstat(payload, { bigint: true })
    if (!sameNode(staged.info, committedTarget.info) || !sameFile(committedPayload, committedTarget.info) || committedTarget.info.nlink !== 2n || committedTarget.digest !== source.sha512) fail('RECOVERY_REQUIRED')
    await verifyChain(proof.chain, committedBudget); await verifyChain(destinationChain, committedBudget); await verifyChain(containerChain, committedBudget)
    await verifyControls()
    if (publicationError) warnings.push('ZIP发布响应异常；已按文件身份和独立读回确认发布成功。')
    const installedAt = new Date(Math.max(Date.now(), Date.parse(preparing.createdAt))).toISOString()
    const complete: Complete = { schema: 1, operationId: options.operationId, intentSha256: sha256(intentBytes), installedAt }
    const completeBytes = jsonBytes(complete), pending = path.join(container, '.complete.pending'), completeFile = path.join(container, 'COMPLETE.json')
    const completeInfo = await writeControl(pending, completeBytes, committedBudget)
    let completionError: unknown
    try { await link(pending, completeFile) } catch (error) { completionError = error }
    const completedRead = await readControl(completeFile, committedBudget), pendingRead = await readControl(pending, committedBudget)
    if (!sameNode(completeInfo, completedRead.info) || !sameFile(completedRead.info, pendingRead.info) || completedRead.info.nlink !== 2n || !completedRead.bytes.equals(completeBytes) || !pendingRead.bytes.equals(completeBytes)) fail('RECOVERY_REQUIRED')
    await verifyChain(containerChain, committedBudget)
    await verifyControls()
    // The acknowledgement itself is an await boundary. A changed target there
    // is unresolved, not a historical edit after successful finalization. The
    // mandatory final proof is created only after this independent final read.
    const finalTarget = await hashFile(target, 'sha512', DATAPACK_LIMITS.archiveBytes, committedBudget)
    const finalPayload = await fs.lstat(payload, { bigint: true })
    if (!sameNode(staged.info, finalTarget.info) || !sameFile(finalPayload, finalTarget.info) || finalTarget.info.nlink !== 2n || finalTarget.digest !== source.sha512) fail('RECOVERY_REQUIRED')
    await verifyChain(proof.chain, committedBudget); await verifyChain(destinationChain, committedBudget); await verifyChain(containerChain, committedBudget)
    const finalized: Finalized = { schema: 1, operationId: options.operationId, completeSha256: sha256(completeBytes), verifiedSha512: source.sha512,
      verifiedAt: new Date(Math.max(Date.now(), Date.parse(installedAt))).toISOString() }
    const finalizedBytes = jsonBytes(finalized), finalizedFile = path.join(container, 'FINALIZED.json'), finalizedInfo = await writeControl(finalizedFile, finalizedBytes, committedBudget)
    const finalProof = await readControl(finalizedFile, committedBudget)
    if (!sameFile(finalizedInfo, finalProof.info) || finalProof.info.nlink !== 1n || !finalProof.bytes.equals(finalizedBytes)) fail('RECOVERY_REQUIRED')
    await verifyControls()
    const finalNames = await list(container, 7, committedBudget)
    if (finalNames.join(',') !== ['.complete.pending', 'COMPLETE.json', 'FINALIZED.json', 'INTENT.json', 'PREPARING.json', 'payload.zip'].sort().join(',')) fail('RECOVERY_REQUIRED')
    if (completionError) warnings.push('完成凭据响应异常；已按身份和字节确认完成。')
    for (const directory of [destination, container]) {
      let handle: fs.FileHandle | undefined
      try { handle = await fs.open(directory, flags); await handle.sync() } catch { warnings.push('目录同步未确认；不保证设备断电耐久性。') }
      finally { try { await handle?.close() } catch { /* Completion is already proved. */ } }
    }
    return { operationId: options.operationId, instanceId: options.instanceId, world: { ...selection }, filename: source.filename, sha512: source.sha512, archiveBytes: source.archiveBytes,
      backup, installedAt, warnings }
  } catch (error) {
    if (intentAttempted) throw new DatapackInstallError('RECOVERY_REQUIRED')
    if (options?.signal?.aborted) throw new DOMException('数据包安装已取消，未进入世界写入的准备资料和备份会保留', 'AbortError')
    if (error instanceof DatapackInstallError) throw error
    if (['ENOSPC', 'EDQUOT'].includes(errno(error) ?? '')) throw new DatapackInstallError('INSUFFICIENT_SPACE')
    if (errno(error) === 'EEXIST') throw new DatapackInstallError('NAME_COLLISION')
    throw new DatapackInstallError('IO_ERROR')
  } finally { if (reserved) active.delete(instance) }
}
