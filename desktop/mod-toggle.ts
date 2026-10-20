import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

export interface ModToggleSelection { itemId: string; name: string; sizeBytes: number; modifiedAt: string }
interface Identity { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; nlink: string }
/** Main-process-only proof. Never return these paths/identities to the renderer. */
export interface ModTogglePrepared {
  schema: 1
  instanceDirectory: string
  fromName: string
  toName: string
  enabled: boolean
  oldItemId: string
  newItemId: string
  sourceIdentity: Identity
  rootIdentity: Identity
  modsIdentity: Identity
}
export interface ModToggleResult {
  fromName: string; toName: string; enabled: boolean; oldItemId: string; newItemId: string; warnings: string[]
}
export interface ModToggleOptions {
  signal?: AbortSignal
  link?: typeof fs.link
  unlink?: typeof fs.unlink
}
export class ModToggleRecoveryError extends Error {
  readonly code = 'MOD_TOGGLE_RECOVERY_REQUIRED'
  constructor(message: string, readonly stagingDirectory: string, options?: ErrorOptions) {
    super(message, options); this.name = 'ModToggleRecoveryError'
  }
}
export class ModToggleBusyError extends Error {
  readonly code = 'MOD_TOGGLE_BUSY'
  constructor() { super('此实例已有模组文件操作正在进行'); this.name = 'ModToggleBusyError' }
}
export const MOD_TOGGLE_LIMITS = Object.freeze({ entries: 5000, journals: 64, journalBytes: 64 * 1024, durationMs: 5000 })
const active = new Set<string>()
const JOURNAL = /^\.mod-toggle-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/
interface Journal { schema: 1; operationId: string; createdAt: string; prepared: ModTogglePrepared }
interface Layout { root: string; mods: string }
interface Budget { check(): void }

function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('模组文件操作已取消', 'AbortError') }
function budget(signal?: AbortSignal): Budget {
  const started = performance.now()
  return { check() {
    abort(signal)
    if (performance.now() - started >= MOD_TOGGLE_LIMITS.durationMs) throw new Error('模组目录检查超时，请稍后刷新重试')
  } }
}
function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code }
function absolute(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 32768 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('实例目录必须是有效的绝对路径')
  }
  const result = path.resolve(value)
  if (result === path.parse(result).root) throw new Error('不能使用文件系统根目录操作模组')
  return result
}
function layout(root: string): Layout { return { root, mods: path.join(root, 'game', 'mods') } }
function filename(value: unknown): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || Buffer.byteLength(value, 'utf8') > 255 ||
      /[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff\ufffd]/u.test(value) || /[ .]$/.test(value) ||
      /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value)) throw new Error('模组文件名不安全或不可跨平台使用')
  return value
}
function names(from: string, enabled: boolean): { fromName: string; toName: string } {
  filename(from)
  if (typeof enabled !== 'boolean') throw new Error('模组目标状态必须是布尔值')
  if (enabled ? !from.endsWith('.jar.disabled') : !from.endsWith('.jar')) {
    throw new Error('仅支持 .jar 与 .jar.disabled 的规范后缀，请刷新后选择对应文件')
  }
  const to = enabled ? from.slice(0, -'.disabled'.length) : from + '.disabled'
  filename(to)
  return { fromName: from, toName: to }
}
function itemId(name: string): string { return 'mods:' + createHash('sha256').update(name, 'utf8').digest('hex') }
function folded(name: string): string { return name.normalize('NFC').toLowerCase() }
function identity(info: BigIntStats): Identity {
  return { dev: String(info.dev), ino: String(info.ino), size: String(info.size),
    mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), nlink: String(info.nlink) }
}
function inode(a: Identity, b: Identity): boolean { return a.dev === b.dev && a.ino === b.ino }
function contentIdentity(a: Identity, b: Identity): boolean {
  return inode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs
}
function sameFile(a: Identity, b: Identity): boolean {
  return contentIdentity(a, b) && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
}
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).length !== keys.length || Reflect.ownKeys(input).some(key =>
        typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(input, key)!))) {
    throw new Error('模组操作记录格式无效')
  }
  return input as Record<string, unknown>
}
function validateIdentity(input: unknown): Identity {
  const value = object(input, ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'])
  for (const key of Object.keys(value)) {
    const signedTime = key === 'mtimeNs' || key === 'ctimeNs'
    if (typeof value[key] !== 'string' || !(signedTime ? /^-?\d{1,40}$/ : /^\d{1,40}$/).test(value[key])) {
      throw new Error('模组文件身份记录无效')
    }
  }
  return value as unknown as Identity
}
function validatePrepared(input: unknown, root: string): ModTogglePrepared {
  const value = object(input, ['schema', 'instanceDirectory', 'fromName', 'toName', 'enabled', 'oldItemId',
    'newItemId', 'sourceIdentity', 'rootIdentity', 'modsIdentity'])
  if (value.schema !== 1 || value.instanceDirectory !== root || typeof value.fromName !== 'string' || typeof value.enabled !== 'boolean') {
    throw new Error('模组操作记录不属于此实例')
  }
  const expected = names(value.fromName, value.enabled)
  if (expected.toName !== value.toName || value.oldItemId !== itemId(expected.fromName) || value.newItemId !== itemId(expected.toName)) {
    throw new Error('模组操作文件名或标识不一致')
  }
  return { schema: 1, instanceDirectory: root, ...expected, enabled: value.enabled,
    oldItemId: itemId(expected.fromName), newItemId: itemId(expected.toName),
    sourceIdentity: { ...validateIdentity(value.sourceIdentity) }, rootIdentity: { ...validateIdentity(value.rootIdentity) },
    modsIdentity: { ...validateIdentity(value.modsIdentity) } }
}
async function directoryChain(directory: string, check: () => void): Promise<boolean> {
  const root = path.parse(directory).root
  let current = root
  for (const part of directory.slice(root.length).split(path.sep)) {
    check()
    current = path.join(current, part)
    let info: BigIntStats
    try { info = await fs.lstat(current, { bigint: true }) } catch (error) {
      if (errno(error) === 'ENOENT') { check(); return false }
      throw error
    }
    if (info.isSymbolicLink()) {
      const alias = process.platform === 'darwin' && current !== directory &&
        ((current === '/tmp' && await fs.realpath(current) === '/private/tmp') ||
         (current === '/var' && await fs.realpath(current) === '/private/var'))
      if (!alias) throw new Error('实例及模组目录不能包含符号链接或 junction')
    } else if (!info.isDirectory()) throw new Error('实例及模组路径必须是普通目录')
  }
  check()
  return true
}
async function regular(file: string): Promise<BigIntStats | undefined> {
  try {
    const info = await fs.lstat(file, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('模组和操作记录必须是普通文件，不能是链接或目录')
    return info
  } catch (error) { if (errno(error) === 'ENOENT') return; throw error }
}
async function entries(directory: string, time: Budget): Promise<string[]> {
  if (!await directoryChain(directory, time.check)) return []
  const original = identity(await fs.lstat(directory, { bigint: true }))
  const handle = await fs.opendir(directory, { bufferSize: 32 })
  const result: string[] = []
  try {
    if (!await directoryChain(directory, time.check) || !inode(original, identity(await fs.lstat(directory, { bigint: true })))) {
      throw new Error('检查期间目录被替换')
    }
    for (;;) {
      time.check()
      const entry = await handle.read()
      if (!entry) break
      if (result.length >= MOD_TOGGLE_LIMITS.entries) throw new Error('模组目录条目超过检查上限，无法排除冲突')
      result.push(entry.name)
    }
    if (!await directoryChain(directory, time.check) || !inode(original, identity(await fs.lstat(directory, { bigint: true })))) {
      throw new Error('检查期间目录被替换')
    }
    return result
  } finally { await handle.close() }
}
async function verifyDirectories(where: Layout, proof: ModTogglePrepared, signal?: AbortSignal): Promise<void> {
  const check = () => abort(signal)
  if (!await directoryChain(where.mods, check) ||
      !inode(proof.rootIdentity, identity(await fs.lstat(where.root, { bigint: true }))) ||
      !inode(proof.modsIdentity, identity(await fs.lstat(where.mods, { bigint: true })))) throw new Error('实例或模组目录已变化，请重新准备操作')
}
async function collisions(mods: string, fromName: string, toName: string, allowOwnTarget: boolean, signal?: AbortSignal): Promise<void> {
  for (const entry of await entries(mods, budget(signal))) {
    if (folded(entry) === folded(fromName) && entry !== fromName) throw new Error('源文件名存在大小写或 Unicode 冲突')
    if (folded(entry) === folded(toName) && (!allowOwnTarget || entry !== toName)) {
      throw new Error('启用与禁用文件同时存在或目标名称冲突；不会覆盖或自动合并')
    }
  }
}
async function readBounded(file: string, signal?: AbortSignal): Promise<{ bytes: Buffer; info: Identity }> {
  abort(signal)
  const before = await regular(file)
  if (!before || before.size > BigInt(MOD_TOGGLE_LIMITS.journalBytes)) throw new Error('模组操作记录缺失或超过 64 KiB')
  const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameFile(identity(before), identity(opened))) throw new Error('模组操作记录在打开时变化')
    const bytes = Buffer.alloc(MOD_TOGGLE_LIMITS.journalBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      abort(signal)
      const next = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!next.bytesRead) break
      offset += next.bytesRead
    }
    abort(signal)
    const after = await handle.stat({ bigint: true })
    if (offset > MOD_TOGGLE_LIMITS.journalBytes || BigInt(offset) !== after.size || !sameFile(identity(opened), identity(after))) {
      throw new Error('模组操作记录在读取时变化')
    }
    return { bytes: bytes.subarray(0, offset), info: identity(after) }
  } finally { await handle.close() }
}
async function cleanJournal(where: Layout, proof: ModTogglePrepared, stage: string, stageIdentity: Identity,
  fileIdentity: Identity | undefined, expectedBytes: Buffer | undefined): Promise<void> {
  await verifyDirectories(where, proof)
  if (!await directoryChain(stage, () => {}) || !inode(stageIdentity, identity(await fs.lstat(stage, { bigint: true })))) {
    throw new Error('模组恢复目录已变化，未清理')
  }
  const children = await entries(stage, budget())
  if (children.some(name => name !== 'intent.json')) throw new Error('恢复目录含其他文件，已保留')
  const journalFile = path.join(stage, 'intent.json')
  const current = await regular(journalFile)
  if (current) {
    if (!fileIdentity || !expectedBytes || !sameFile(fileIdentity, identity(current))) throw new Error('模组恢复记录已被修改或替换，未删除其他文件')
    const verified = await readBounded(journalFile)
    if (!sameFile(fileIdentity, verified.info) || !expectedBytes.equals(verified.bytes)) throw new Error('模组恢复记录内容已变化，未删除外部编辑')
    const latest = await regular(journalFile)
    if (!latest || !sameFile(fileIdentity, identity(latest))) throw new Error('模组恢复记录在清理前发生变化')
    await fs.unlink(journalFile)
  }
  await fs.rmdir(stage)
}
async function inspect(where: Layout, signal?: AbortSignal): Promise<{ blocked: boolean; warnings: string[] }> {
  const time = budget(signal), warnings: string[] = []
  if (!await directoryChain(where.root, time.check)) return { blocked: false, warnings }
  // Even without journals, refuse an unsafe existing game/mods chain.
  await directoryChain(where.mods, time.check)
  let blocked = false
  const markers = (await entries(where.root, time)).filter(name => name.startsWith('.mod-toggle-'))
  if (markers.length > MOD_TOGGLE_LIMITS.journals) return { blocked: true, warnings: ['模组恢复记录超过检查上限，请人工检查实例目录'] }
  for (const name of markers) {
    time.check()
    const stage = path.join(where.root, name)
    try {
      const match = JOURNAL.exec(name)
      if (!match || !await directoryChain(stage, time.check)) throw new Error('恢复目录名称或类型无效')
      const stageIdentity = identity(await fs.lstat(stage, { bigint: true }))
      const file = path.join(stage, 'intent.json')
      const current = await readBounded(file, signal)
      const raw = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(current.bytes)),
        ['schema', 'operationId', 'createdAt', 'prepared'])
      if (raw.schema !== 1 || raw.operationId !== match[1] || typeof raw.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(raw.createdAt)) || new Date(raw.createdAt).toISOString() !== raw.createdAt) throw new Error('恢复记录格式无效')
      const proof = validatePrepared(raw.prepared, where.root)
      await verifyDirectories(where, proof, signal)
      const source = await regular(path.join(where.mods, proof.fromName))
      const destination = await regular(path.join(where.mods, proof.toName))
      // Link/unlink legitimately changes ctime and nlink. Only a single surviving
      // expected name with the original inode/size/mtime is unambiguous on restart.
      if ((!source && !destination) || (source && destination) ||
          (source && !contentIdentity(proof.sourceIdentity, identity(source))) ||
          (destination && !contentIdentity(proof.sourceIdentity, identity(destination)))) throw new Error('启用/禁用文件状态不明确')
      await collisions(where.mods, proof.fromName, proof.toName, Boolean(destination), signal)
      const secondSource = await regular(path.join(where.mods, proof.fromName))
      const secondDestination = await regular(path.join(where.mods, proof.toName))
      if (Boolean(source) !== Boolean(secondSource) || Boolean(destination) !== Boolean(secondDestination) ||
          (source && secondSource && !sameFile(identity(source), identity(secondSource))) ||
          (destination && secondDestination && !sameFile(identity(destination), identity(secondDestination)))) throw new Error('恢复检查期间文件发生变化')
      const latest = await readBounded(file, signal)
      if (!sameFile(current.info, latest.info) || !current.bytes.equals(latest.bytes)) throw new Error('恢复记录发生变化')
      abort(signal)
      await cleanJournal(where, proof, stage, stageIdentity, current.info, current.bytes)
      warnings.push(source ? '已清理未提交的模组操作记录；原文件保留' : '已确认上次文件名修改完成；未更改模组字节')
    } catch (error) {
      abort(signal)
      blocked = true
      warnings.push('模组操作需要人工恢复，已保留文件和记录：' + name + '（' + (error instanceof Error ? error.message : '无法安全检查') + '）')
    }
  }
  abort(signal)
  return { blocked, warnings }
}
async function locked<T>(root: string, work: () => Promise<T>): Promise<T> {
  if (active.has(root)) throw new ModToggleBusyError()
  active.add(root)
  try { return await work() } finally { active.delete(root) }
}

export async function inspectModToggleRecovery(instanceDirectory: string, options: { signal?: AbortSignal } = {}):
  Promise<{ blocked: boolean; warnings: string[] }> {
  const root = absolute(instanceDirectory)
  abort(options.signal)
  return locked(root, () => inspect(layout(root), options.signal))
}

export async function prepareModToggle(instanceDirectory: string, selection: ModToggleSelection, enabled: boolean,
  options: { signal?: AbortSignal } = {}): Promise<ModTogglePrepared> {
  const root = absolute(instanceDirectory)
  const value = object(selection, ['itemId', 'name', 'sizeBytes', 'modifiedAt'])
  if (typeof value.name !== 'string' || value.itemId !== itemId(filename(value.name)) ||
      typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 ||
      typeof value.modifiedAt !== 'string' || !Number.isFinite(Date.parse(value.modifiedAt)) ||
      new Date(value.modifiedAt).toISOString() !== value.modifiedAt) throw new Error('所选模组条目无效，请重新扫描')
  const pair = names(value.name, enabled)
  return locked(root, async () => {
    abort(options.signal)
    const where = layout(root)
    const recovery = await inspect(where, options.signal)
    if (recovery.blocked) throw new ModToggleRecoveryError('存在未解决的模组操作记录，请先恢复实例', root)
    if (!await directoryChain(where.mods, () => abort(options.signal))) throw new Error('模组目录不存在，请刷新')
    const rootIdentity = identity(await fs.lstat(root, { bigint: true }))
    const modsIdentity = identity(await fs.lstat(where.mods, { bigint: true }))
    await collisions(where.mods, pair.fromName, pair.toName, false, options.signal)
    const current = await regular(path.join(where.mods, pair.fromName))
    if (!current || current.size !== BigInt(value.sizeBytes as number) ||
        new Date(Number(current.mtimeNs) / 1e6).toISOString() !== value.modifiedAt) throw new Error('所选文件已变化或消失，请重新扫描')
    const prepared: ModTogglePrepared = { schema: 1, instanceDirectory: root, ...pair, enabled,
      oldItemId: itemId(pair.fromName), newItemId: itemId(pair.toName), sourceIdentity: identity(current), rootIdentity, modsIdentity }
    await verifyDirectories(where, prepared, options.signal)
    abort(options.signal)
    return prepared
  })
}

export async function commitModToggle(instanceDirectory: string, input: ModTogglePrepared, options: ModToggleOptions = {}): Promise<ModToggleResult> {
  const root = absolute(instanceDirectory), proof = validatePrepared(input, root), where = layout(root)
  return locked(root, async () => {
    const warnings: string[] = []
    const operationId = randomUUID(), stage = path.join(root, '.mod-toggle-' + operationId), file = path.join(stage, 'intent.json')
    const source = path.join(where.mods, proof.fromName), destination = path.join(where.mods, proof.toName)
    let stageIdentity: Identity | undefined, journalIdentity: Identity | undefined, linkedIdentity: Identity | undefined
    let journalBytes: Buffer | undefined
    let created = false, linked = false, linkAttempted = false, committed = false
    try {
      abort(options.signal)
      const recovery = await inspect(where, options.signal)
      if (recovery.blocked) throw new ModToggleRecoveryError('存在未解决的模组操作记录，请先恢复实例', root)
      await verifyDirectories(where, proof, options.signal)
      await collisions(where.mods, proof.fromName, proof.toName, false, options.signal)
      const initial = await regular(source)
      if (!initial || !sameFile(proof.sourceIdentity, identity(initial))) throw new Error('准备后的模组文件已变化，请刷新后重试')
      abort(options.signal)
      await fs.mkdir(stage, { mode: 0o700 }); created = true
      const stageInfo = await fs.lstat(stage, { bigint: true })
      if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) throw new Error('新建模组恢复目录被替换')
      stageIdentity = identity(stageInfo)
      if (!await directoryChain(stage, () => abort(options.signal))) throw new Error('模组暂存目录不存在')
      const journal: Journal = { schema: 1, operationId, createdAt: new Date().toISOString(), prepared: proof }
      journalBytes = Buffer.from(JSON.stringify(journal))
      const handle = await fs.open(file, 'wx', 0o600)
      try {
        journalIdentity = identity(await handle.stat({ bigint: true }))
        await handle.writeFile(journalBytes); await handle.sync()
        journalIdentity = identity(await handle.stat({ bigint: true }))
      } finally { await handle.close() }
      const verifyJournal = async () => {
        if (!await directoryChain(stage, () => abort(options.signal)) ||
            !inode(stageIdentity!, identity(await fs.lstat(stage, { bigint: true })))) throw new Error('恢复目录在提交前被替换')
        const current = await readBounded(file, options.signal)
        if (!sameFile(journalIdentity!, current.info) || !current.bytes.equals(journalBytes!)) throw new Error('恢复记录在提交前被修改')
      }
      await verifyDirectories(where, proof, options.signal)
      await collisions(where.mods, proof.fromName, proof.toName, false, options.signal)
      await verifyJournal()
      const beforeLink = await regular(source)
      if (!beforeLink || !sameFile(proof.sourceIdentity, identity(beforeLink))) throw new Error('模组文件在提交前被修改')
      abort(options.signal)
      linkAttempted = true
      await (options.link ?? fs.link)(source, destination)
      linked = true
      const afterLink = await regular(destination), afterSource = await regular(source)
      if (!afterLink || !afterSource || !sameFile(identity(afterLink), identity(afterSource)) ||
          !contentIdentity(proof.sourceIdentity, identity(afterLink)) ||
          afterLink.nlink !== BigInt(proof.sourceIdentity.nlink) + 1n) throw new Error('建立目标文件名后原文件被修改或替换')
      linkedIdentity = identity(afterLink)
      await verifyDirectories(where, proof, options.signal)
      await collisions(where.mods, proof.fromName, proof.toName, true, options.signal)
      await verifyJournal()
      const finalSource = await regular(source), finalTarget = await regular(destination)
      if (!finalSource || !finalTarget || !sameFile(linkedIdentity, identity(finalSource)) ||
          !sameFile(linkedIdentity, identity(finalTarget))) throw new Error('模组文件在最终提交前被修改或替换')
      abort(options.signal)
      await (options.unlink ?? fs.unlink)(source)
      committed = true
      // Successful unlink of the old name is the commit boundary. Never undo it
      // because a cancellation or metadata cleanup error arrives afterwards.
      try { await cleanJournal(where, proof, stage, stageIdentity, journalIdentity, journalBytes) }
      catch { warnings.push('文件名已修改，但恢复记录未能清理；下次检查将重新核对：' + stage) }
      return { fromName: proof.fromName, toName: proof.toName, enabled: proof.enabled,
        oldItemId: proof.oldItemId, newItemId: proof.newItemId, warnings }
    } catch (error) {
      if (created && !committed) {
        try {
          if (!stageIdentity) throw new Error('无法确认新建恢复目录身份')
          await verifyDirectories(where, proof)
          const currentSource = await regular(source), currentTarget = await regular(destination)
          if (linkAttempted) {
            if (!linked && currentTarget) throw new Error('目标建立结果不明确，未删除任何目标')
            if (linked) {
              if (!currentSource || !currentTarget || !sameFile(identity(currentSource), identity(currentTarget)) ||
                  !contentIdentity(proof.sourceIdentity, identity(currentSource)) ||
                  (linkedIdentity && !sameFile(linkedIdentity, identity(currentTarget))) ||
                  (!linkedIdentity && currentTarget.nlink !== BigInt(proof.sourceIdentity.nlink) + 1n)) {
                throw new Error('回滚时文件已被外部编辑或替换，保留源和目标')
              }
              await (options.unlink ?? fs.unlink)(destination)
            }
          }
          await cleanJournal(where, proof, stage, stageIdentity, journalIdentity, journalBytes)
        } catch (rollbackError) {
          throw new ModToggleRecoveryError('模组文件操作无法安全回滚，请先检查恢复记录；未覆盖外部文件', stage, {
            cause: new AggregateError([error, rollbackError], '模组操作及恢复失败'),
          })
        }
      }
      throw error
    }
  })
}

/** Read-only guard for every planned new jar AND its historical registered filename. */
export async function assertNoDisabledModPartners(instanceDirectory: string, filenames: string[],
  options: { signal?: AbortSignal } = {}): Promise<void> {
  const root = absolute(instanceDirectory)
  if (!Array.isArray(filenames) || filenames.length > 200) throw new Error('模组文件计划无效或过多')
  const wanted = filenames.map(value => {
    const name = filename(value)
    if (!/\.jar$/i.test(name)) throw new Error('模组安装计划只能包含 JAR 文件名')
    return name
  })
  abort(options.signal)
  return locked(root, async () => {
    if (!wanted.length) return
    const actual = await entries(layout(root).mods, budget(options.signal))
    for (const name of wanted) for (const entry of actual) {
      if (folded(entry) === folded(name + '.disabled')) throw new Error('模组已有禁用副本 ' + entry + '；请先在实例清单明确恢复，安装器不会自动启用')
      if (folded(entry) === folded(name) && entry !== name) throw new Error('模组文件名存在大小写或 Unicode 冲突：' + entry)
    }
    abort(options.signal)
  })
}
