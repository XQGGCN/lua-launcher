import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

export const PACK_SELECTION_LIMITS = Object.freeze({ archiveBytes: 256 * 1024 ** 2, selections: 8,
  lifetimeMs: 60 * 60 * 1000, bufferBytes: 1024 * 1024, operationMs: 120_000 })
/** Main-process cache evidence. This is not a one-use installation authorization. */
export interface PackSelectionArchive { bytes: number; sha1: string; sha512: string }
export interface PackSelectionOptions { signal?: AbortSignal }
export interface VerifiedPackSelectionOptions extends PackSelectionOptions { archiveBytes: number; sha1: string; sha512: string }
export interface PackSelectionHooks {
  write?: (handle: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number) => Promise<number>
  afterCopyChunk?: (context: { source: string; copy: string; bytes: number }) => Promise<void>
  afterCopied?: (copy: string) => Promise<void>
  beforeUse?: (copy: string) => Promise<void>
}
type Chain = Map<string, string>
type Proof = { identity: string; archive: PackSelectionArchive }
type Slot = { file: string; expires: number; inUse: number; ready: boolean; invalid: boolean;
  node?: string; proof?: Proof; knownBytes: number; knownSha512: string }
const identity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].map(String).join(':')
const node = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode].map(String).join(':')
const cloneArchive = (archive: PackSelectionArchive): PackSelectionArchive => ({ ...archive })
const emptySha512 = createHash('sha512').digest('hex')

/** Opaque, reusable private cache handles. Core owns short-lived, one-use plan confirmation. */
export class PackSelections<T> {
  private readonly entries = new Map<string, Slot>()
  private readonly active = new Map<Promise<unknown>, AbortController>()
  private directory = ''
  private directoryChain: Chain = new Map()
  private state: 'new' | 'initializing' | 'ready' | 'closing' | 'closed' = 'new'
  private initial?: Promise<void>
  private closing?: Promise<void>
  private prepares = 0
  private serial: Promise<void> = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly inspect: (file: string, options?: PackSelectionOptions) => Promise<T>,
    private readonly now: () => number = Date.now,
    private readonly hooks: PackSelectionHooks = {},
  ) {}

  init(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.state === 'initializing') return this.initial!
    if (this.state !== 'new') return Promise.reject(new Error('整合包选择器已经关闭'))
    this.state = 'initializing'
    this.initial = this.initialize().then(() => { if (this.state === 'initializing') this.state = 'ready' })
      .catch(error => { if (this.state === 'initializing') this.state = 'new'; throw error })
    return this.initial
  }

  private async initialize(): Promise<void> {
    this.validatePath(this.root)
    const root = path.resolve(this.root), chain = await this.captureChain(root)
    const base = path.join(root, 'import-cache')
    await fs.mkdir(base, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    await this.checkChain(chain)
    const baseChain = await this.captureChain(base)
    // Historical sessions are never swept by name or age: this process has no ownership proof for them.
    this.directory = await fs.mkdtemp(path.join(base, 'session-'))
    await this.checkChain(baseChain)
    this.directoryChain = await this.captureChain(this.directory)
  }

  choose(file: string, options: PackSelectionOptions = {}): Promise<{ token: string; preview: T; archive: PackSelectionArchive }> {
    return this.prepare(file, undefined, options)
  }

  /** Main only: clone an online archive after its transport has checked the exact selected file. */
  registerVerified(file: string, options: VerifiedPackSelectionOptions): Promise<{ token: string; preview: T; archive: PackSelectionArchive }> {
    if (!options || !Number.isSafeInteger(options.archiveBytes) || options.archiveBytes < 1 || options.archiveBytes > PACK_SELECTION_LIMITS.archiveBytes ||
        typeof options.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(options.sha1) || typeof options.sha512 !== 'string' || !/^[a-f0-9]{128}$/i.test(options.sha512)) {
      return Promise.reject(new Error('整合包已验证来源的大小或双摘要无效'))
    }
    return this.prepare(file, { bytes: options.archiveBytes, sha1: options.sha1.toLowerCase(), sha512: options.sha512.toLowerCase() }, options)
  }

  private prepare(file: string, expected: PackSelectionArchive | undefined, options: PackSelectionOptions): Promise<{ token: string; preview: T; archive: PackSelectionArchive }> {
    if (this.state !== 'ready') return Promise.reject(new Error('整合包选择器尚未准备就绪或已经关闭'))
    if (this.prepares >= PACK_SELECTION_LIMITS.selections) return Promise.reject(new Error('正在准备的整合包过多，请等待当前任务完成'))
    this.prepares++
    return this.run(options, async check => {
      let slot: Slot | undefined, token = ''
      try {
        this.validatePath(file); check()
        if (path.dirname(path.resolve(file)) === this.directory) throw new Error('不能将当前私有缓存当作新的整合包来源')
        await this.exclusive(async () => {
          check(); await this.prune()
          while (this.entries.size >= PACK_SELECTION_LIMITS.selections) {
            const oldest = [...this.entries].find(([, value]) => !value.inUse)
            if (!oldest || !await this.removeOwn(oldest[1])) throw new Error('私有整合包缓存已满或身份变化，请先结束任务并检查缓存')
            this.entries.delete(oldest[0])
          }
          check(); await this.checkChain(this.directoryChain)
          token = randomUUID()
          slot = { file: path.join(this.directory, token + '.mrpack'), expires: this.now() + PACK_SELECTION_LIMITS.lifetimeMs,
            inUse: 1, ready: false, invalid: false, knownBytes: 0, knownSha512: emptySha512 }
          this.entries.set(token, slot)
        })
        const current = slot!
        const sourceChain = await this.captureChain(path.dirname(file), check)
        const before = await fs.lstat(file, { bigint: true }); check()
        this.checkArchiveStat(before)
        const sourceIdentity = identity(before)
        const input = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        let archive: PackSelectionArchive
        try {
          if (identity(await input.stat({ bigint: true })) !== sourceIdentity) throw new Error('整合包源文件在打开时变化')
          await this.checkChain(sourceChain, check)
          await this.checkChain(this.directoryChain, check)
          const output = await fs.open(current.file, 'wx', 0o600)
          try {
            const opened = await output.stat({ bigint: true }); current.node = node(opened)
            if (!opened.isFile() || opened.nlink !== 1n) throw new Error('整合包私有副本不是独占普通文件')
            const sha1 = createHash('sha1'), sha512 = createHash('sha512'), buffer = Buffer.alloc(PACK_SELECTION_LIMITS.bufferBytes)
            let done = 0
            while (done < Number(before.size)) {
              check(); const read = await input.read(buffer, 0, Math.min(buffer.length, Number(before.size) - done), done); check()
              if (!read.bytesRead) throw new Error('整合包源文件未完整读取')
              let written = 0
              while (written < read.bytesRead) {
                check()
                const count = this.hooks.write ? await this.hooks.write(output, buffer, written, read.bytesRead - written, done + written) :
                  (await output.write(buffer, written, read.bytesRead - written, done + written)).bytesWritten
                if (!Number.isSafeInteger(count) || count < 1 || count > read.bytesRead - written) throw new Error('整合包私有副本写入不完整')
                sha1.update(buffer.subarray(written, written + count)); sha512.update(buffer.subarray(written, written + count))
                written += count; current.knownBytes += count; current.knownSha512 = sha512.copy().digest('hex'); check()
              }
              done += read.bytesRead
              await this.hooks.afterCopyChunk?.({ source: file, copy: current.file, bytes: done }); check()
            }
            const extra = await input.read(buffer, 0, 1, done); check()
            if (extra.bytesRead || identity(await input.stat({ bigint: true })) !== sourceIdentity) throw new Error('整合包源文件在复制中变化')
            archive = { bytes: done, sha1: sha1.digest('hex'), sha512: sha512.digest('hex') }
            if (expected && !this.sameArchive(archive, expected)) throw new Error('整合包归档与已验证来源的大小或双摘要不符')
            await output.sync(); check()
          } finally { await output.close() }
        } finally { await input.close() }
        const copyProof = await this.readProof(current.file, this.directoryChain, check)
        if (current.node !== copyProof.identity.split(':').slice(0, 3).join(':') || copyProof.identity.split(':').at(-1) !== '1' ||
            !this.sameArchive(copyProof.archive, archive!)) throw new Error('整合包私有副本磁盘读回不符')
        current.proof = copyProof
        const sourceProof = await this.readProof(file, sourceChain, check)
        if (sourceProof.identity !== sourceIdentity || !this.sameArchive(sourceProof.archive, archive!)) throw new Error('整合包源文件二次校验变化')
        await this.hooks.afterCopied?.(current.file); check()
        const preview = await this.inspect(current.file, { signal: check.signal }); check()
        await this.verifySlot(current, check)
        await this.checkChain(sourceChain, check)
        if (identity(await fs.lstat(file, { bigint: true })) !== sourceIdentity) throw new Error('整合包源文件在检查时变化')
        current.ready = true; current.expires = this.now() + PACK_SELECTION_LIMITS.lifetimeMs
        return { token, preview, archive: cloneArchive(current.proof.archive) }
      } catch (error) {
        if (slot) {
          slot.invalid = true
          await this.exclusive(async () => { if (slot && await this.removeOwn(slot)) this.entries.delete(token) }).catch(() => {})
        }
        throw error
      } finally { if (slot) slot.inUse--; this.prepares-- }
    })
  }

  use<R>(token: string, work: (file: string, archive: PackSelectionArchive, signal: AbortSignal) => Promise<R>, options: PackSelectionOptions = {}): Promise<R> {
    if (this.state !== 'ready') return Promise.reject(new Error('整合包选择器尚未准备就绪或已经关闭'))
    const entry = this.entries.get(token)
    if (!entry?.ready || entry.invalid) return Promise.reject(new Error('整合包选择已过期或私有副本变化，请重新选择文件'))
    if (entry.expires <= this.now()) {
      entry.ready = false // At most one cleanup task can be queued for an expired handle.
      return this.run(options, async () => {
        await this.exclusive(() => this.prune())
        throw new Error('整合包选择已过期或私有副本变化，请重新选择文件')
      })
    }
    if (entry.inUse) return Promise.reject(new Error('这个整合包正在导入，请等待当前任务完成'))
    entry.inUse++ // Before the first await; cleanup cannot remove a reserved copy.
    return this.run(options, async check => {
      try {
        await this.hooks.beforeUse?.(entry.file); check()
        await this.verifySlot(entry, check)
        return await work(entry.file, cloneArchive(entry.proof!.archive), check.signal)
      } finally {
        entry.inUse--
        await this.exclusive(() => this.prune())
      }
    })
  }

  verify(token: string, options: PackSelectionOptions = {}): Promise<PackSelectionArchive> {
    return this.use(token, async (_file, archive) => archive, options)
  }

  private async verifySlot(slot: Slot, check: Check): Promise<void> {
    if (!slot.proof || slot.invalid) throw new Error('整合包私有副本没有完整校验凭据')
    try {
      const fresh = await this.readProof(slot.file, this.directoryChain, check)
      if (fresh.identity !== slot.proof.identity || !this.sameArchive(fresh.archive, slot.proof.archive)) throw new Error('整合包私有副本身份或摘要变化')
    } catch (error) { if (!check.signal.aborted) slot.invalid = true; throw error }
  }

  private sameArchive(a: PackSelectionArchive, b: PackSelectionArchive): boolean { return a.bytes === b.bytes && a.sha1 === b.sha1 && a.sha512 === b.sha512 }
  private validatePath(file: string): void {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(file) || path.resolve(file) === path.parse(path.resolve(file)).root) throw new Error('整合包路径无效')
  }
  private checkArchiveStat(stat: BigIntStats): void {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1n || stat.size > BigInt(PACK_SELECTION_LIMITS.archiveBytes)) throw new Error('请选择不超过 256 MB 的普通整合包文件，不能使用链接')
  }
  private async captureChain(directory: string, check: () => void = () => {}): Promise<Chain> {
    let current = path.parse(directory).root
    check(); const root = await fs.lstat(current, { bigint: true }); check()
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('整合包路径根不是普通目录')
    const chain: Chain = new Map([[current, node(root)]])
    for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      check(); current = path.join(current, part)
      const stat = await fs.lstat(current, { bigint: true }); check()
      if (stat.isSymbolicLink()) {
        const allowed = process.platform === 'darwin' && current !== directory &&
          (current === '/tmp' && await fs.realpath(current) === '/private/tmp' || current === '/var' && await fs.realpath(current) === '/private/var')
        if (!allowed) throw new Error('整合包路径祖先含链接')
      } else if (!stat.isDirectory()) throw new Error('整合包路径祖先不是普通目录')
      chain.set(current, node(stat))
    }
    return chain
  }
  private async checkChain(chain: Chain, check: () => void = () => {}): Promise<void> {
    if (!chain.size) throw new Error('整合包私有目录凭据无效')
    for (const [directory, expected] of chain) {
      check(); if (node(await fs.lstat(directory, { bigint: true })) !== expected) throw new Error('整合包路径祖先在操作期间变化'); check()
    }
  }
  private async readProof(file: string, chain: Chain, check: () => void): Promise<Proof> {
    check(); await this.checkChain(chain, check)
    const stat = await fs.lstat(file, { bigint: true }); check(); this.checkArchiveStat(stat)
    const expected = identity(stat), handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      if (identity(await handle.stat({ bigint: true })) !== expected) throw new Error('整合包文件在打开时变化')
      const buffer = Buffer.alloc(PACK_SELECTION_LIMITS.bufferBytes), sha1 = createHash('sha1'), sha512 = createHash('sha512')
      let bytes = 0
      while (bytes < Number(stat.size)) {
        check(); const read = await handle.read(buffer, 0, Math.min(buffer.length, Number(stat.size) - bytes), bytes); check()
        if (!read.bytesRead) throw new Error('整合包文件读取不完整')
        sha1.update(buffer.subarray(0, read.bytesRead)); sha512.update(buffer.subarray(0, read.bytesRead)); bytes += read.bytesRead
      }
      const extra = await handle.read(buffer, 0, 1, bytes); check()
      if (extra.bytesRead || identity(await handle.stat({ bigint: true })) !== expected || identity(await fs.lstat(file, { bigint: true })) !== expected) throw new Error('整合包文件读取期间变化')
      await this.checkChain(chain, check)
      return { identity: expected, archive: { bytes, sha1: sha1.digest('hex'), sha512: sha512.digest('hex') } }
    } finally { await handle.close() }
  }

  private exclusive<R>(work: () => Promise<R>): Promise<R> {
    const result = this.serial.then(work, work)
    this.serial = result.then(() => {}, () => {})
    return result
  }
  private async removeOwn(slot: Slot): Promise<boolean> {
    try {
      await this.checkChain(this.directoryChain)
      const stat = await fs.lstat(slot.file, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
      if (!stat) return true
      if (!slot.node || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || node(stat) !== slot.node) return false
      if (slot.proof) {
        const fresh = await this.readProof(slot.file, this.directoryChain, () => {})
        if (fresh.identity !== slot.proof.identity || !this.sameArchive(fresh.archive, slot.proof.archive)) return false
      } else {
        // Partial-copy cleanup needs independent evidence of exactly the bytes whose writes were acknowledged.
        if (stat.size !== BigInt(slot.knownBytes)) return false
        if (slot.knownBytes) {
          const fresh = await this.readProof(slot.file, this.directoryChain, () => {})
          if (fresh.archive.bytes !== slot.knownBytes || fresh.archive.sha512 !== slot.knownSha512) return false
        }
      }
      if (identity(await fs.lstat(slot.file, { bigint: true })) !== identity(stat)) return false
      await this.checkChain(this.directoryChain)
      await fs.unlink(slot.file)
      return true
    } catch { return false }
  }
  private async prune(): Promise<void> {
    for (const [token, entry] of this.entries) if (!entry.inUse && entry.expires <= this.now() && await this.removeOwn(entry)) this.entries.delete(token)
  }

  private run<R>(options: PackSelectionOptions, work: (check: Check) => Promise<R>): Promise<R> {
    const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
      deadline = performance.now() + PACK_SELECTION_LIMITS.operationMs
    const check: Check = Object.assign(() => { signal.throwIfAborted(); if (performance.now() > deadline) throw new Error('整合包准备或校验超过时间预算') }, { signal })
    const timer = setTimeout(() => controller.abort(new Error('整合包准备或校验超过时间预算')), PACK_SELECTION_LIMITS.operationMs)
    timer.unref?.()
    // Start asynchronously only after the active record exists, including an already-aborted request.
    const promise = Promise.resolve().then(() => work(check))
    this.active.set(promise, controller)
    void promise.then(() => { this.active.delete(promise); clearTimeout(timer) }, () => { this.active.delete(promise); clearTimeout(timer) })
    return promise
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.state = 'closing'
    for (const controller of this.active.values()) controller.abort(new DOMException('整合包选择器正在关闭', 'AbortError'))
    this.closing = (async () => {
      await this.initial?.catch(() => {})
      await Promise.allSettled([...this.active.keys()])
      await this.exclusive(async () => {
        for (const [token, entry] of this.entries) if (!entry.inUse && await this.removeOwn(entry)) this.entries.delete(token)
        if (this.directory) {
          await this.checkChain(this.directoryChain).then(() => fs.rmdir(this.directory)).catch(() => {})
        }
      })
      this.state = 'closed'
    })()
    return this.closing
  }
}
type Check = (() => void) & { signal: AbortSignal }
