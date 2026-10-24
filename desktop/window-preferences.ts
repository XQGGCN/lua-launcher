import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { isWindowRect } from './window-geometry'
import type { WindowPreferences, WindowPreferencesSnapshot, WindowState } from './window-preferences-types'
export type { WindowPreferences, WindowPreferencesSnapshot, WindowPreferencesStatus, WindowRect, WindowState } from './window-preferences-types'

export const WINDOW_PREFERENCE_LIMITS = Object.freeze({ bytes: 16 * 1024, retainedFailures: 32, path: 4096 })
export const DEFAULT_WINDOW_PREFERENCES: Readonly<WindowPreferences> = Object.freeze({ titleBarStyle: 'integrated', rememberBounds: true })
export interface WindowPreferenceHooks {
  write?: (handle: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number) => Promise<number>
  beforePublish?: () => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
  link?: (from: string, to: string) => Promise<void>
  afterPublish?: () => Promise<void>
}
export interface WindowPreferenceStoreOptions { hooks?: WindowPreferenceHooks }
type Chain = Map<string, string>
type Proof = { identity: string; node: string; hash: string; bytes: Buffer }
type Persisted = { schema: 1; preferences: WindowPreferences; windowState: WindowState }
type Temp = { file: string; node?: string; written: number; bytes: Buffer }
const identity = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs, s.nlink].map(String).join(':')
const node = (s: BigIntStats) => [s.dev, s.ino, s.mode].map(String).join(':')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
const READ_ISSUE = '窗口偏好文件无法验证，已使用默认设置；原文件已保留，当前暂停写入。'
const WRITE_ISSUE = '窗口偏好未能保存，仍使用上次已保存的设置；准备文件已保留或安全移除。'
const CHANGED_ISSUE = '窗口偏好文件或目录已变化，保留上次设置并暂停写入；请检查原文件。'
class InvalidWindowPreferences extends Error { constructor() { super('窗口偏好参数无效，请使用受支持的标题栏样式、记忆开关和有限窗口尺寸。'); this.name = 'InvalidWindowPreferences' } }
const invalid = (): never => { throw new InvalidWindowPreferences() }
function fields(value: unknown, keys: string[], required: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  const object = value as Record<string, unknown>, own = Reflect.ownKeys(object)
  if (own.some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(object, key)!)) || required.some(key => !Object.hasOwn(object, key))) invalid()
}
function preferencePatch(value: unknown): Partial<WindowPreferences> {
  fields(value, ['titleBarStyle', 'rememberBounds'])
  if (Object.hasOwn(value, 'titleBarStyle') && value.titleBarStyle !== 'integrated' && value.titleBarStyle !== 'native' || Object.hasOwn(value, 'rememberBounds') && typeof value.rememberBounds !== 'boolean') invalid()
  return { ...value } as Partial<WindowPreferences>
}
function statePatch(value: unknown): WindowState {
  fields(value, ['normalBounds', 'maximized'], ['maximized'])
  if (typeof value.maximized !== 'boolean' || value.normalBounds !== undefined && !isWindowRect(value.normalBounds)) invalid()
  return Object.hasOwn(value, 'normalBounds') ? { normalBounds: value.normalBounds === undefined ? undefined : { ...value.normalBounds as NonNullable<WindowState['normalBounds']> }, maximized: value.maximized as boolean } : { maximized: value.maximized as boolean }
}
/** Small duplicate-key-aware JSON reader. This schema needs objects and scalar values only. */
function parseJSON(bytes: Buffer): unknown {
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  let at = 0, nodes = 0
  const whitespace = () => { while (at < source.length && /[\x20\t\r\n]/.test(source[at])) at++ }
  const string = (): string => {
    whitespace(); if (source[at] !== '"') invalid()
    const start = at++
    while (at < source.length) { const char = source[at++]; if (char === '\\') at++; else if (char === '"') return JSON.parse(source.slice(start, at)) as string }
    return invalid()
  }
  const value = (depth: number): unknown => {
    whitespace(); if (++nodes > 64 || depth > 4) invalid()
    if (source[at] === '"') return string()
    if (source[at] === '{') {
      at++; const result: Record<string, unknown> = Object.create(null), seen = new Set<string>(); whitespace()
      if (source[at] === '}') { at++; return result }
      while (at < source.length) {
        const key = string(); if (seen.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) invalid(); seen.add(key)
        whitespace(); if (source[at++] !== ':') invalid()
        result[key] = value(depth + 1); whitespace(); const stop = source[at++]; if (stop === '}') return result; if (stop !== ',') invalid()
      }
      return invalid()
    }
    if (source.startsWith('true', at)) { at += 4; return true }
    if (source.startsWith('false', at)) { at += 5; return false }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at))
    if (!match) return invalid()
    at += match[0].length; return Number(match[0])
  }
  const result = value(0); whitespace(); if (at !== source.length) invalid(); return result
}

/** Nonfatal launcher-only preference storage; unrelated settings, accounts and instances are never read. */
export class WindowPreferenceStore {
  private value: WindowPreferencesSnapshot = { preferences: { ...DEFAULT_WINDOW_PREFERENCES }, state: { maximized: false } }
  private expected?: Proof
  private chain: Chain = new Map()
  private initial?: Promise<void>
  private queue: Promise<void> = Promise.resolve()
  private blocked = false
  private retainedFailures = 0
  private readonly file: string
  private readonly hooks: WindowPreferenceHooks
  constructor(private readonly root: string, options: WindowPreferenceStoreOptions = {}) { this.file = path.join(root, 'window-preferences.json'); this.hooks = options.hooks ?? {} }

  initialize(): Promise<void> {
    if (this.initial) return this.initial
    this.initial = (async () => {
      try {
        if (!path.isAbsolute(this.root) || this.root.length > WINDOW_PREFERENCE_LIMITS.path || /[\p{Cc}\p{Cf}]/u.test(this.root) || path.resolve(this.root) === path.parse(this.root).root) invalid()
        this.chain = await this.captureChain(this.root)
        const proof = await this.readOptional(this.file)
        if (!proof) return
        const raw = parseJSON(proof.bytes); fields(raw, ['schema', 'preferences', 'windowState'], ['schema', 'preferences', 'windowState'])
        if (raw.schema !== 1) invalid()
        fields(raw.preferences, ['titleBarStyle', 'rememberBounds'], ['titleBarStyle', 'rememberBounds'])
        const preferences = preferencePatch(raw.preferences) as WindowPreferences, state = statePatch(raw.windowState)
        this.expected = proof; this.value = { preferences, state }
      } catch { this.blocked = true; this.value.issue = READ_ISSUE }
    })()
    return this.initial
  }
  snapshot(): WindowPreferencesSnapshot { return structuredClone(this.value) }

  updatePreferences(value: unknown): Promise<WindowPreferencesSnapshot> {
    let patch: Partial<WindowPreferences>
    try { patch = preferencePatch(value) } catch { return Promise.reject(new InvalidWindowPreferences()) }
    return this.enqueue(current => ({ preferences: { ...current.preferences, ...patch }, state: current.state }))
  }
  saveWindowState(value: unknown): Promise<WindowPreferencesSnapshot> {
    let patch: WindowState
    try { patch = statePatch(value) } catch { return Promise.reject(new InvalidWindowPreferences()) }
    return this.enqueue(current => {
      const state = { ...current.state, ...patch }
      if (state.normalBounds === undefined) delete state.normalBounds
      return { preferences: current.preferences, state }
    })
  }
  flush(): Promise<void> { return Promise.all([this.initial ?? Promise.resolve(), this.queue]).then(() => {}) }

  private enqueue(merge: (value: WindowPreferencesSnapshot) => WindowPreferencesSnapshot): Promise<WindowPreferencesSnapshot> {
    const pending = this.queue.then(async () => {
      await this.initialize()
      if (this.blocked) return this.snapshot()
      const next = structuredClone(merge(this.snapshot()))
      if (JSON.stringify(next.preferences) === JSON.stringify(this.value.preferences) && JSON.stringify(next.state) === JSON.stringify(this.value.state)) return this.snapshot()
      await this.persist(next)
      return this.snapshot()
    })
    this.queue = pending.then(() => {}, () => {})
    return pending
  }
  private async persist(next: WindowPreferencesSnapshot): Promise<void> {
    const persisted: Persisted = { schema: 1, preferences: next.preferences, windowState: next.state }, bytes = encode(persisted),
      temp: Temp = { file: path.join(this.root, '.window-preferences-' + randomUUID() + '.tmp'), written: 0, bytes }
    if (bytes.length > WINDOW_PREFERENCE_LIMITS.bytes || this.retainedFailures >= WINDOW_PREFERENCE_LIMITS.retainedFailures) { this.value.issue = WRITE_ISSUE; return }
    let published = false
    try {
      await this.sameCurrent()
      const handle = await fs.open(temp.file, 'wx', 0o600)
      try {
        const opened = await handle.stat({ bigint: true }); temp.node = node(opened)
        if (!opened.isFile() || opened.nlink !== 1n) throw new Error('private file unavailable')
        while (temp.written < bytes.length) {
          const remaining = bytes.length - temp.written, count = this.hooks.write ? await this.hooks.write(handle, bytes, temp.written, remaining, temp.written) :
            (await handle.write(bytes, temp.written, remaining, temp.written)).bytesWritten
          if (!Number.isSafeInteger(count) || count < 1 || count > remaining) throw new Error('short write unavailable')
          temp.written += count
        }
        await handle.sync()
      } finally { await handle.close() }
      const prepared = await this.readOptional(temp.file)
      if (!prepared || prepared.node !== temp.node || prepared.hash !== hash(bytes) || !prepared.bytes.equals(bytes) || prepared.identity.split(':').at(-1) !== '1') throw new Error('private readback unavailable')
      await this.hooks.beforePublish?.()
      await this.sameCurrent()
      const privateFresh = await this.readOptional(temp.file)
      if (!privateFresh || privateFresh.identity !== prepared.identity || privateFresh.hash !== prepared.hash) throw new Error('private file changed')
      await this.checkChain()
      let publishError: unknown
      try {
        if (this.expected) { if (this.hooks.rename) await this.hooks.rename(temp.file, this.file); else await fs.rename(temp.file, this.file) }
        else { if (this.hooks.link) await this.hooks.link(temp.file, this.file); else await fs.link(temp.file, this.file) }
      } catch (error) { publishError = error }
      await this.hooks.afterPublish?.()
      let actual = await this.readOptional(this.file)
      if (!actual || actual.node !== prepared.node || actual.hash !== prepared.hash || !actual.bytes.equals(bytes)) throw publishError ?? new Error('publish result unknown')
      published = true
      if (!this.expected) {
        // First creation is a no-replace hard link. Only remove our still-proven private link.
        const linked = await this.readOptional(temp.file)
        if (linked?.node === prepared.node && linked.hash === prepared.hash) await fs.unlink(temp.file).catch(() => {})
        const final = await this.readOptional(this.file)
        if (!final || final.node !== actual.node || final.hash !== actual.hash) throw new Error('final result unknown')
        actual = final
      }
      this.expected = actual
      this.value = { preferences: structuredClone(next.preferences), state: structuredClone(next.state) }
    } catch {
      let unchanged = false
      try { await this.sameCurrent(); unchanged = true } catch { /* Unknown current data must be preserved. */ }
      if (!unchanged || published) { this.blocked = true; this.value.issue = CHANGED_ISSUE }
      else this.value.issue = WRITE_ISSUE
      if (!await this.removeOwn(temp)) this.retainedFailures++
    }
  }

  private async sameCurrent(): Promise<void> {
    const current = await this.readOptional(this.file)
    if (this.expected ? !current || current.identity !== this.expected.identity || current.hash !== this.expected.hash : current !== undefined) throw new Error('current file changed')
  }
  private async captureChain(directory: string): Promise<Chain> {
    let current = path.parse(directory).root; const chain: Chain = new Map()
    for (const part of ['', ...directory.slice(current.length).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part)
      const stat = await fs.lstat(current, { bigint: true })
      if (stat.isSymbolicLink()) {
        const allowed = process.platform === 'darwin' && current !== directory && (current === '/tmp' && await fs.realpath(current) === '/private/tmp' || current === '/var' && await fs.realpath(current) === '/private/var')
        if (!allowed) throw new Error('ancestor unavailable')
      } else if (!stat.isDirectory()) throw new Error('directory unavailable')
      chain.set(current, node(stat))
    }
    return chain
  }
  private async checkChain(): Promise<void> {
    if (!this.chain.size) throw new Error('directory unavailable')
    for (const [directory, expected] of this.chain) if (node(await fs.lstat(directory, { bigint: true })) !== expected) throw new Error('directory changed')
  }
  private async readOptional(file: string): Promise<Proof | undefined> {
    await this.checkChain()
    const before = await fs.lstat(file, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (!before) { await this.checkChain(); return undefined }
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(WINDOW_PREFERENCE_LIMITS.bytes)) throw new Error('bounded file unavailable')
    const expected = identity(before), handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      if (identity(await handle.stat({ bigint: true })) !== expected) throw new Error('file changed')
      const bytes = Buffer.alloc(Number(before.size)); let read = 0
      while (read < bytes.length) { const part = await handle.read(bytes, read, bytes.length - read, read); if (!part.bytesRead) throw new Error('file incomplete'); read += part.bytesRead }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, read)
      if (extra.bytesRead || identity(await handle.stat({ bigint: true })) !== expected || identity(await fs.lstat(file, { bigint: true })) !== expected) throw new Error('file changed')
      await this.checkChain()
      return { identity: expected, node: node(before), hash: hash(bytes), bytes }
    } finally { await handle.close() }
  }
  private async removeOwn(temp: Temp): Promise<boolean> {
    try {
      await this.checkChain()
      const before = await fs.lstat(temp.file, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
      if (!before) return true
      if (!temp.node || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || node(before) !== temp.node || before.size !== BigInt(temp.written)) return false
      if (temp.written) { const proof = await this.readOptional(temp.file); if (!proof || proof.hash !== hash(temp.bytes.subarray(0, temp.written)) || proof.identity !== identity(before)) return false }
      if (identity(await fs.lstat(temp.file, { bigint: true })) !== identity(before)) return false
      await this.checkChain(); await fs.unlink(temp.file); return true
    } catch { return false }
  }
}
