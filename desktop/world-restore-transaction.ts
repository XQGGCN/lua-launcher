import { createHash, randomUUID } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { BACKUP_LIMITS, BACKUP_UUID, backupNameKey, backupRelativePath, backupSafeName } from './world-backup-manifest'

/**
 * Node rename() may replace an empty directory. Reserve the new world with mkdir
 * instead, then copy only into that reservation and publish an external receipt.
 * The directory is not atomically visible to external launchers. Incomplete journals
 * therefore block Lua from launching/mutating this instance, including after restart.
 * No recovery evidence or partially copied user data is automatically deleted.
 */
export class WorldRestoreRecoveryError extends Error {
  readonly code = 'RECOVERY_REQUIRED'
  constructor() { super('世界恢复资料需要人工检查；已保留暂存与新目录，不会自动删除或覆盖，请检查 .restore-staging 后重启'); this.name = 'WorldRestoreRecoveryError' }
}
export type RestoreEntry = { path: string; type: 'directory' } | { path: string; type: 'file'; size: number; sha256: string }
interface Manifest { schema: 1; id: string; entries: RestoreEntry[]; totalBytes: number }
interface Target { schema: 1; id: string; name: string; dev: string; ino: string }
export interface RestoreTransaction { id: string; directory: string; payload: string }
export interface RestoreRecovery { blocked: boolean; blockedNames: string[]; warnings: string[] }
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const safeName = (value: unknown): value is string => backupSafeName(value) && value.length <= 80 && !value.startsWith('.')
function recovery(): never { throw new WorldRestoreRecoveryError() }
const object = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)))

async function directoryChain(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) recovery()
  let current = path.parse(directory).root
  for (const part of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const info = await fs.lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) recovery()
  }
}
async function canonicalDirectory(directory: string): Promise<string> {
  // macOS exposes its system temp roots through these fixed OS aliases. Resolve
  // only the known system prefix, never arbitrary game/instance ancestor links.
  if (process.platform === 'darwin') for (const [alias, actual] of [['/var', '/private/var'], ['/tmp', '/private/tmp']]) {
    if (directory === alias || directory.startsWith(`${alias}/`)) {
      if (await fs.realpath(alias) !== actual) recovery()
      directory = actual + directory.slice(alias.length)
      break
    }
  }
  await directoryChain(directory)
  return directory
}
async function ensureDirectory(directory: string): Promise<string> {
  try { return await canonicalDirectory(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parent = await ensureDirectory(path.dirname(directory))
  const target = path.join(parent, path.basename(directory))
  try { await fs.mkdir(target, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  return canonicalDirectory(target)
}
interface ReadBudget { remaining: number; deadline: number }
const checkBudget = (budget?: ReadBudget) => { if (budget && Date.now() > budget.deadline) recovery() }
async function readControl(file: string, max = BACKUP_LIMITS.controlBytes, budget?: ReadBudget): Promise<Buffer> {
  checkBudget(budget)
  await directoryChain(path.dirname(file))
  const handle = await fs.open(file, readFlags)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(max) || before.nlink > 2n) recovery()
    const length = Number(before.size)
    if (budget && length > budget.remaining) recovery()
    // Allocate only the already bounded snapshot size. readFile() could allocate
    // without limit if another process grew a control file after the initial stat.
    const bytes = Buffer.alloc(length)
    for (let done = 0; done < length;) {
      checkBudget(budget)
      const { bytesRead } = await handle.read(bytes, done, Math.min(BACKUP_LIMITS.bufferBytes, length - done), done)
      if (!bytesRead) recovery()
      done += bytesRead
      if (budget) budget.remaining -= bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, length)).bytesRead) recovery()
    checkBudget(budget)
    const after = await handle.stat({ bigint: true }), linked = await fs.lstat(file, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        before.ino !== linked.ino || before.dev !== linked.dev || linked.isSymbolicLink() || bytes.length !== Number(before.size)) recovery()
    return bytes
  } finally { await handle.close() }
}
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
async function writeControl(file: string, value: unknown): Promise<Buffer> {
  const bytes = Buffer.from(JSON.stringify(value))
  const handle = await fs.open(file, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  return bytes
}
function parseManifest(bytes: Uint8Array, id: string): Manifest {
  const value = decode(bytes)
  if (!object(value, ['schema', 'id', 'entries', 'totalBytes']) || value.schema !== 1 || value.id !== id || !Array.isArray(value.entries) || value.entries.length > BACKUP_LIMITS.entries ||
      !Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) < 0 || (value.totalBytes as number) > BACKUP_LIMITS.totalBytes) recovery()
  const names = new Set<string>(), types = new Map<string, string>()
  let total = 0
  for (const entry of value.entries) {
    if (!object(entry, entry?.type === 'file' ? ['path', 'type', 'size', 'sha256'] : ['path', 'type']) || !backupRelativePath(entry.path) ||
        !['file', 'directory'].includes(entry.type as string) || names.has(backupNameKey(entry.path))) recovery()
    names.add(backupNameKey(entry.path)); types.set(entry.path, entry.type as string)
    if (entry.type === 'file') {
      if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0 || (entry.size as number) > BACKUP_LIMITS.fileBytes || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) recovery()
      total += entry.size as number
    }
  }
  if (total !== value.totalBytes) recovery()
  for (const name of types.keys()) {
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++) if (types.get(parts.slice(0, i).join('/')) !== 'directory') recovery()
  }
  return value as unknown as Manifest
}
function parseTarget(bytes: Uint8Array, id: string): Target {
  const value = decode(bytes)
  if (!object(value, ['schema', 'id', 'name', 'dev', 'ino']) || value.schema !== 1 || value.id !== id || !safeName(value.name) ||
      typeof value.dev !== 'string' || !/^\d+$/.test(value.dev) || typeof value.ino !== 'string' || !/^\d+$/.test(value.ino)) recovery()
  return value as unknown as Target
}
async function completed(directory: string, id: string, budget?: ReadBudget): Promise<boolean> {
  const manifest = await readControl(path.join(directory, 'manifest.json'), BACKUP_LIMITS.manifestBytes, budget)
  parseManifest(manifest, id)
  const target = await readControl(path.join(directory, 'target.json'), BACKUP_LIMITS.controlBytes, budget)
  parseTarget(target, id)
  const receipt = decode(await readControl(path.join(directory, 'COMPLETE.json'), BACKUP_LIMITS.controlBytes, budget))
  if (!object(receipt, ['schema', 'id', 'manifestSha256', 'targetSha256']) || receipt.schema !== 1 || receipt.id !== id ||
      receipt.manifestSha256 !== digest(manifest) || receipt.targetSha256 !== digest(target)) recovery()
  const intent = decode(await readControl(path.join(directory, 'intent.json'), BACKUP_LIMITS.controlBytes, budget))
  if (!object(intent, ['schema', 'id']) || intent.schema !== 1 || intent.id !== id) recovery()
  // This is a historical completion receipt. Playing, moving or deleting the new
  // world afterwards must not invalidate it or permanently lock the instance.
  return true
}
export async function inspectWorldRestoreRecovery(staging: string, _saves: string): Promise<RestoreRecovery> {
  const result: RestoreRecovery = { blocked: false, blockedNames: [], warnings: [] }
  const budget: ReadBudget = { remaining: BACKUP_LIMITS.listMetadataBytes, deadline: Date.now() + BACKUP_LIMITS.listDurationMs }
  let entries: Dirent[]
  try { staging = await canonicalDirectory(staging); entries = await fs.readdir(staging, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    return { blocked: true, blockedNames: [], warnings: ['无法安全读取世界恢复资料，请检查 .restore-staging'] }
  }
  if (entries.length > BACKUP_LIMITS.backups) return { blocked: true, blockedNames: [], warnings: ['世界恢复历史数量超出检查上限，请保留并人工检查 .restore-staging'] }
  for (const entry of entries) {
    if (entry.name === '.DS_Store' && entry.isFile()) continue
    const directory = path.join(staging, entry.name)
    try {
      if (!entry.isDirectory() || !BACKUP_UUID.test(entry.name)) recovery()
      checkBudget(budget)
      await completed(directory, entry.name, budget)
    } catch {
      result.blocked = true
      try { result.blockedNames.push(parseTarget(await readControl(path.join(directory, 'target.json'), BACKUP_LIMITS.controlBytes, budget), entry.name).name) } catch { /* Unknown target blocks the entire instance. */ }
      if (budget.remaining <= 0 || Date.now() > budget.deadline) break
    }
  }
  if (result.blocked) result.warnings.push('存在未完成或无法确认的世界恢复资料，请保留 .restore-staging 及新目录并人工检查；原世界未被替换')
  return result
}

export async function beginWorldRestoreTransaction(staging: string): Promise<RestoreTransaction> {
  staging = await ensureDirectory(staging)
  const existing = await inspectWorldRestoreRecovery(staging, '')
  if (existing.blocked) recovery()
  if ((await fs.readdir(staging)).length >= BACKUP_LIMITS.backups) throw new Error('世界恢复历史数量已达上限，请先保留并人工整理 .restore-staging')
  const id = randomUUID(), directory = path.join(staging, id), payload = path.join(directory, 'payload')
  await fs.mkdir(directory, { mode: 0o700 })
  await writeControl(path.join(directory, 'intent.json'), { schema: 1, id })
  await fs.mkdir(payload, { mode: 0o700 })
  return { id, directory, payload }
}

async function hashFile(file: string, expected: number, signal?: AbortSignal): Promise<string> {
  await directoryChain(path.dirname(file))
  const handle = await fs.open(file, readFlags), hash = createHash('sha256')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(expected) || before.nlink !== 1n) recovery()
    const buffer = Buffer.allocUnsafe(BACKUP_LIMITS.bufferBytes)
    for (let position = 0; position < expected;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected - position), position)
      if (!bytesRead) recovery()
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead
    }
    const after = await handle.stat({ bigint: true }), linked = await fs.lstat(file, { bigint: true })
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.ino !== linked.ino || before.dev !== linked.dev || linked.isSymbolicLink()) recovery()
    return hash.digest('hex')
  } finally { await handle.close() }
}
async function verifyTree(directory: string, entries: RestoreEntry[], signal?: AbortSignal): Promise<void> {
  const actual: string[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    signal?.throwIfAborted(); await directoryChain(current)
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!backupRelativePath(name) || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) recovery()
      actual.push(`${entry.isDirectory() ? 'directory' : 'file'}:${name}`)
      if (actual.length > BACKUP_LIMITS.entries) recovery()
      if (entry.isDirectory()) await walk(path.join(current, entry.name), name)
    }
  }
  await walk(directory, '')
  const expected = entries.map(entry => `${entry.type}:${entry.path}`).sort()
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) recovery()
  for (const entry of entries) if (entry.type === 'file' && await hashFile(path.join(directory, ...entry.path.split('/')), entry.size, signal) !== entry.sha256) recovery()
}
async function assertTarget(saves: string, record: Target): Promise<string> {
  await directoryChain(saves)
  const target = path.join(saves, record.name), info = await fs.lstat(target, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== record.dev || String(info.ino) !== record.ino) recovery()
  const aliases = (await fs.readdir(saves)).filter(name => backupNameKey(name) === backupNameKey(record.name))
  if (aliases.length !== 1 || aliases[0] !== record.name) recovery()
  return target
}
async function copyExclusive(source: string, target: string, entry: Extract<RestoreEntry, { type: 'file' }>, signal?: AbortSignal): Promise<void> {
  await directoryChain(path.dirname(source)); await directoryChain(path.dirname(target))
  const input = await fs.open(source, readFlags)
  let output: fs.FileHandle | undefined
  try {
    const before = await input.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(entry.size)) recovery()
    output = await fs.open(target, 'wx', 0o600)
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(BACKUP_LIMITS.bufferBytes)
    for (let position = 0; position < entry.size;) {
      signal?.throwIfAborted()
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, entry.size - position), position)
      if (!bytesRead) recovery()
      hash.update(buffer.subarray(0, bytesRead))
      for (let offset = 0; offset < bytesRead;) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null)
        if (!bytesWritten) recovery()
        offset += bytesWritten
      }
      position += bytesRead
    }
    if (hash.digest('hex') !== entry.sha256) recovery()
    const after = await input.stat({ bigint: true })
    if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size) recovery()
    await output.sync()
  } finally {
    const closed = await Promise.allSettled([...(output ? [output.close()] : []), input.close()])
    const failure = closed.find((item): item is PromiseRejectedResult => item.status === 'rejected')
    if (failure) throw failure.reason
  }
}

export async function publishWorldRestore(transaction: RestoreTransaction, saves: string, preferred: string, entries: RestoreEntry[], signal?: AbortSignal): Promise<string> {
  if (!safeName(preferred)) recovery()
  signal?.throwIfAborted()
  const totalBytes = entries.reduce((total, entry) => total + (entry.type === 'file' ? entry.size : 0), 0)
  const manifest: Manifest = { schema: 1, id: transaction.id, entries, totalBytes }
  const manifestBytes = Buffer.from(JSON.stringify(manifest)); parseManifest(manifestBytes, transaction.id)
  if (manifestBytes.length > BACKUP_LIMITS.manifestBytes) recovery()
  await verifyTree(transaction.payload, entries, signal)
  await writeControl(path.join(transaction.directory, 'manifest.json'), manifest)
  saves = await ensureDirectory(saves)
  const space = await fs.statfs(saves)
  const required = totalBytes + Math.max(128 * 1024 ** 2, Math.ceil(totalBytes * 0.05))
  if (space.bavail * space.bsize < required) throw new Error('磁盘可用空间不足，无法安全完成世界恢复；暂存资料已保留')
  let record: Target | undefined
  for (let index = 1; index < 1000; index++) {
    signal?.throwIfAborted()
    const suffix = index === 1 ? '' : ` (${index})`
    let base = preferred
    while (base.length + suffix.length > 80 || Buffer.byteLength(base + suffix) > 255) base = Array.from(base).slice(0, -1).join('')
    const name = base + suffix
    if (!safeName(name)) continue
    if ((await fs.readdir(saves)).some(item => backupNameKey(item) === backupNameKey(name))) continue
    try { await fs.mkdir(path.join(saves, name), { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error }
    const info = await fs.lstat(path.join(saves, name), { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) recovery()
    record = { schema: 1, id: transaction.id, name, dev: String(info.dev), ino: String(info.ino) }
    break
  }
  if (!record) throw new Error('同名世界过多，请换一个名称；暂存资料已保留')
  const targetBytes = await writeControl(path.join(transaction.directory, 'target.json'), record)
  for (const entry of entries.filter(entry => entry.type === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    signal?.throwIfAborted(); const target = await assertTarget(saves, record)
    await directoryChain(path.dirname(path.join(target, ...entry.path.split('/'))))
    await fs.mkdir(path.join(target, ...entry.path.split('/')), { mode: 0o700 })
  }
  for (const entry of entries) if (entry.type === 'file') {
    signal?.throwIfAborted(); const target = await assertTarget(saves, record)
    await copyExclusive(path.join(transaction.payload, ...entry.path.split('/')), path.join(target, ...entry.path.split('/')), entry, signal)
  }
  const target = await assertTarget(saves, record)
  await verifyTree(target, entries, signal)
  await assertTarget(saves, record)
  signal?.throwIfAborted()
  const receipt = { schema: 1, id: transaction.id, manifestSha256: digest(manifestBytes), targetSha256: digest(targetBytes) }
  await writeControl(path.join(transaction.directory, 'complete.tmp'), receipt)
  // After a link acknowledgement is lost, inspect the final receipt independently.
  // A proven receipt wins late cancellation. Ambiguity never masquerades as cancelled.
  try { await fs.link(path.join(transaction.directory, 'complete.tmp'), path.join(transaction.directory, 'COMPLETE.json')) }
  catch {
    try { if (await completed(transaction.directory, transaction.id)) return record.name } catch { /* Preserve the uncertainty. */ }
    recovery()
  }
  try { await completed(transaction.directory, transaction.id) } catch { recovery() }
  return record.name
}
