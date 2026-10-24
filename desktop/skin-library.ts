import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { normalizeSkinImage, skinTextureDataUrl, SkinImageError, SKIN_IMAGE_LIMITS, type SkinImageResult } from './skin-image'
import type { SkinDiagnostics, SkinExportResult, SkinItem, SkinLibraryPage, SkinListOptions, SkinMetadata, SkinMutationInput,
  SkinPreview, SkinReadOptions, SkinReadResult, SkinRemoveResult, SkinSummary } from './skin-library-types'

export const SKIN_LIBRARY_LIMITS = Object.freeze({ records: 500, blobsBytes: 32 * 1024 ** 2, indexBytes: 1024 ** 2,
  previewBytes: 32 * 1024 ** 2, previewDirectories: 64, historyCommits: 2048, historyControlBytes: 8 * 1024 ** 2, historyBytes: 128 * 1024 ** 2,
  page: 24, dtoBytes: 512 * 1024, capabilityMs: 120_000, operationMs: 60_000, bufferBytes: 64 * 1024 })
export class SkinLibraryError extends Error {
  constructor(readonly code: 'invalid' | 'limit' | 'stale' | 'busy' | 'io' | 'recovery-required', message: string) { super(message); this.name = 'SkinLibraryError' }
}
export interface SkinLibraryHooks {
  write?: (handle: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number, file: string) => Promise<number>
  afterSourceCopied?: (source: string, copy: string) => Promise<void>
  beforeIndexPublish?: () => Promise<void>
  renameIndex?: (from: string, to: string) => Promise<void>
  afterIndexPublish?: () => Promise<void>
  afterExportWrite?: (file: string) => Promise<void>
}
export interface SkinLibraryOptions { now?: () => number; normalize?: typeof normalizeSkinImage; hooks?: SkinLibraryHooks }
type Check = (() => void) & { signal: AbortSignal }
type Chain = Map<string, string>
type FileProof = { identity: string; node: string; hash: string; bytes: Buffer }
type RecordValue = SkinSummary & { sourceSha256: string; pixelsSha256: string; normalizedSha256: string; blobBytes: number; diagnostics: SkinDiagnostics; removedAt?: string }
type Index = { schema: 1; sequence: number; commitId: string; records: RecordValue[] }
type IndexProof = { value: Index; file: FileProof }
type View = { id: string; expires: number; directory: string; privateChain: Chain; source: string; sourceChain: Chain; sourceProof: FileProof;
  raw: { file: string; proof: FileProof }; normalized: { file: string; proof: FileProof }; image: SkinImageResult }
type Intent = { schema: 1; operationId: string; sequence: number; previousSha256: string; nextSha256: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digest = /^[a-f0-9]{64}$/
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const identity = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs, s.nlink].map(String).join(':')
const node = (s: BigIntStats) => [s.dev, s.ino, s.mode].map(String).join(':')
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
const clone = <T>(value: T): T => structuredClone(value)
function fail(code: SkinLibraryError['code'], message: string): never { throw new SkinLibraryError(code, message) }
const ownObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
function fields(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!ownObject(v) || Reflect.ownKeys(v).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(v, key)!))) fail('invalid', '本地皮肤参数含未知字段或无效结构')
}
function operation(value: unknown): string { if (typeof value !== 'string' || !uuid.test(value)) fail('invalid', '本地皮肤任务标识无效'); return value as string }
function safeText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || [...value].length > maximum || /[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value)) fail('invalid', label + '超限或含控制字符')
  const canonical = value.normalize('NFC').trim()
  if ([...canonical].length > maximum) fail('invalid', label + '规范化后超限')
  return canonical
}
function metadata(value: unknown, layout: 'legacy' | 'modern'): SkinMetadata {
  fields(value, ['name', 'tags', 'model', 'operationId'])
  const name = safeText(value.name, 64, '皮肤名称')
  if (!name || !Array.isArray(value.tags) || value.tags.length > 8 || typeof value.model !== 'string' || !['classic', 'slim'].includes(value.model) || layout === 'legacy' && value.model !== 'classic') fail('invalid', '名称、标签或模型无效；旧布局仅支持经典模型')
  const tags = (value.tags as unknown[]).map(tag => safeText(tag, 24, '皮肤标签'))
  if (tags.some(tag => !tag) || new Set(tags.map(tag => tag.toLocaleLowerCase('en-US'))).size !== tags.length) fail('invalid', '标签不能留空或重复')
  return { name, tags, model: value.model as SkinMetadata['model'] }
}

/** Account-independent local PNG collection. No URL, account, Java, game or world access. */
export class SkinLibrary {
  private readonly now: () => number
  private readonly normalize: typeof normalizeSkinImage
  private readonly hooks: SkinLibraryHooks
  private readonly directory: string
  private chain: Chain = new Map()
  private state: 'new' | 'initializing' | 'ready' | 'closing' | 'closed' = 'new'
  private initial?: Promise<void>
  private active?: { id: string; controller: AbortController; promise: Promise<unknown> }
  private closing?: Promise<void>
  private view?: View
  private readonly usedOperations = new Set<string>()
  private recoveryBlocked = false

  constructor(private readonly root: string, options: SkinLibraryOptions = {}) {
    this.directory = path.join(root, 'skins'); this.now = options.now ?? Date.now
    this.normalize = options.normalize ?? normalizeSkinImage; this.hooks = options.hooks ?? {}
  }
  init(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.state === 'initializing') return this.initial!
    if (this.state !== 'new') return Promise.reject(new SkinLibraryError('io', '本地皮肤库已经关闭'))
    this.state = 'initializing'
    this.initial = this.initialize().then(() => { if (this.state === 'initializing') this.state = 'ready' }).catch(error => {
      if (this.state === 'initializing') this.state = 'new'
      throw this.publicError(error)
    })
    return this.initial
  }
  private async initialize(): Promise<void> {
    this.validPath(this.root)
    const rootChain = await this.captureChain(this.root)
    await this.mkdir(this.directory); await this.checkChain(rootChain)
    for (const name of ['blobs', 'previews', 'history']) await this.mkdir(path.join(this.directory, name))
    this.chain = await this.captureChain(this.directory)
    for (const name of ['blobs', 'previews', 'history']) for (const [file, proof] of await this.captureChain(path.join(this.directory, name))) this.chain.set(file, proof)
    const file = path.join(this.directory, 'library.json')
    const exists = await fs.lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (!exists) {
      if ((await this.names(path.join(this.directory, 'history'), 8192)).length || (await this.names(path.join(this.directory, 'blobs'), 1024)).length) fail('recovery-required', '皮肤库索引缺失且存在历史资料，已停止初始化，不会覆盖为空库')
      await this.writeNew(file, encode({ schema: 1, sequence: 0, commitId: 'initial', records: [] }), this.idleCheck())
    }
    await this.loadIndex(this.idleCheck())
  }

  prepare(operationId: string, pick: () => Promise<string | null | undefined>): Promise<SkinPreview | null> {
    return this.run(operationId, async check => {
      if (typeof pick !== 'function') fail('invalid', '本地皮肤选择回调无效')
      await this.discardView(); check()
      const source = await pick(); check()
      if (source === null || source === undefined) return null
      this.validPath(source)
      await this.previewBudget(check)
      const directory = path.join(this.directory, 'previews', randomUUID()); await this.checkChain(this.chain, check); await fs.mkdir(directory, { mode: 0o700 }); check()
      const privateChain = await this.captureChain(directory, check), sourceChain = await this.captureChain(path.dirname(source), check)
      const sourceProof = await this.readFile(source, SKIN_IMAGE_LIMITS.fileBytes, sourceChain, check)
      const raw = path.join(directory, 'source.png'), normalized = path.join(directory, 'normalized.png')
      let rawProof: FileProof | undefined, normalizedProof: FileProof | undefined
      try {
        rawProof = await this.writeNew(raw, sourceProof.bytes, check)
        await this.hooks.afterSourceCopied?.(source, raw); check()
        const sourceAfter = await this.readFile(source, SKIN_IMAGE_LIMITS.fileBytes, sourceChain, check)
        if (sourceAfter.identity !== sourceProof.identity || sourceAfter.hash !== sourceProof.hash) fail('stale', '皮肤源文件在选择期间变化，请重新选择')
        const image = this.normalize(rawProof.bytes, { signal: check.signal }); check()
        normalizedProof = await this.writeNew(normalized, image.normalizedPng, check)
        await this.checkChain(privateChain, check)
        if (image.sourceSha256 !== sourceProof.hash || normalizedProof.hash !== image.normalizedSha256) fail('stale', '皮肤规范化结果与已检查文件不一致')
        await this.sameFile(raw, rawProof, privateChain, check)
        await this.sameFile(normalized, normalizedProof, privateChain, check)
        const finalSource = await this.readFile(source, SKIN_IMAGE_LIMITS.fileBytes, sourceChain, check)
        if (finalSource.identity !== sourceProof.identity || finalSource.hash !== sourceProof.hash) fail('stale', '皮肤源文件在检查期间变化，请重新选择')
        const view: View = { id: randomUUID(), expires: this.now() + SKIN_LIBRARY_LIMITS.capabilityMs, directory, privateChain, source, sourceChain, sourceProof,
          raw: { file: raw, proof: rawProof }, normalized: { file: normalized, proof: normalizedProof }, image }
        this.view = view
        return this.dto({ viewId: view.id, expiresAt: new Date(view.expires).toISOString(), filename: path.basename(source), width: image.width, height: image.height,
          layout: image.layout, textureDataURL: skinTextureDataUrl(image), diagnostics: this.diagnostics(image) })
      } catch (error) {
        await this.removePrivate(raw, rawProof, privateChain); await this.removePrivate(normalized, normalizedProof, privateChain)
        await this.removeDirectory(directory, privateChain)
        throw error
      }
    })
  }

  save(viewId: string, input: SkinMutationInput): Promise<SkinItem> {
    let operationId: string
    try { operationId = this.inputOperation(input) } catch (error) { return Promise.reject(this.publicError(error)) }
    return this.run(operationId, async check => {
      const view = this.view
      if (!view || view.id !== viewId || view.expires <= this.now()) fail('stale', '本地皮肤收藏确认已过期，请重新选择图片')
      const values = metadata(input, view.image.layout)
      this.view = undefined // Valid metadata consumes this one-use save capability before the first await.
      try {
        const index = await this.loadIndex(check)
        if (index.value.records.length >= SKIN_LIBRARY_LIMITS.records) fail('limit', '本地皮肤历史收藏已达500项，当前没有自动清理功能')
        const privateChain = view.privateChain
        await this.sameFile(view.raw.file, view.raw.proof, privateChain, check)
        const png = await this.sameFile(view.normalized.file, view.normalized.proof, privateChain, check)
        const source = await this.readFile(view.source, SKIN_IMAGE_LIMITS.fileBytes, view.sourceChain, check)
        if (source.identity !== view.sourceProof.identity || source.hash !== view.sourceProof.hash) fail('stale', '皮肤源文件已变化，请重新选择图片')
        const image = this.normalize(png.bytes, { signal: check.signal }); check()
        this.matchImage(image, view.image)
        const blob = await this.ensureBlob(image, check), time = this.timestamp()
        const record: RecordValue = { id: randomUUID(), ...values, width: image.width, height: image.height, layout: image.layout,
          createdAt: time, updatedAt: time, sourceSha256: view.image.sourceSha256, pixelsSha256: image.pixelsSha256, normalizedSha256: image.normalizedSha256,
          blobBytes: image.normalizedPng.length, diagnostics: this.diagnostics(view.image) }
        const next = await this.commit(index, [...index.value.records, record], operation(input.operationId), check)
        return this.item(record, next, blob)
      } finally { await this.discardView(view) }
    })
  }

  list(options: SkinListOptions = {}): Promise<SkinLibraryPage> {
    let id: string
    try { fields(options, ['query', 'offset', 'limit', 'tag', 'operationId']); id = options.operationId === undefined ? randomUUID() : operation(options.operationId) } catch (error) { return Promise.reject(this.publicError(error)) }
    return this.run(id, async check => {
      const query = safeText(options.query ?? '', 200, '皮肤搜索词').toLocaleLowerCase('en-US'), tag = safeText(options.tag ?? '', 24, '皮肤标签筛选').toLocaleLowerCase('en-US'),
        offset = options.offset ?? 0, limit = options.limit ?? SKIN_LIBRARY_LIMITS.page
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > SKIN_LIBRARY_LIMITS.records || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > SKIN_LIBRARY_LIMITS.page) fail('invalid', '皮肤分页参数超限')
      const index = await this.loadIndex(check), active = index.value.records.filter(record => !record.removedAt), filtered = active.filter(record =>
        (!query || [record.name, ...record.tags].some(value => value.toLocaleLowerCase('en-US').includes(query))) && (!tag || record.tags.some(value => value.toLocaleLowerCase('en-US') === tag)))
      return this.dto({ items: filtered.slice(offset, offset + limit).map(record => this.summary(record)), total: filtered.length, offset, limit,
        tags: [...new Set(active.flatMap(record => record.tags))].sort() })
    })
  }
  read(itemId: string, options: SkinReadOptions = {}): Promise<SkinReadResult> {
    let id: string
    try { fields(options, ['operationId']); id = options.operationId === undefined ? randomUUID() : operation(options.operationId) } catch (error) { return Promise.reject(this.publicError(error)) }
    return this.run(id, async check => {
      const index = await this.loadIndex(check), record = this.record(index.value, itemId), { proof, image } = await this.blob(record, check)
      await this.sameIndex(index, check)
      const item = this.item(record, index, proof)
      return this.dto({ item, revision: item.revision, textureDataURL: skinTextureDataUrl(image), diagnostics: clone(record.diagnostics) })
    })
  }
  update(itemId: string, revision: string, input: SkinMutationInput): Promise<SkinItem> {
    let operationId: string
    try { operationId = this.inputOperation(input) } catch (error) { return Promise.reject(this.publicError(error)) }
    return this.run(operationId, async check => {
      const index = await this.loadIndex(check), record = this.record(index.value, itemId), values = metadata(input, record.layout), { proof } = await this.blob(record, check)
      this.requireRevision(record, revision, index, proof)
      const changed: RecordValue = { ...record, ...values, updatedAt: this.timestamp() }, next = await this.commit(index,
        index.value.records.map(value => value.id === record.id ? changed : value), operation(input.operationId), check)
      return this.item(changed, next, proof)
    })
  }
  remove(itemId: string, revision: string, operationId: string): Promise<SkinRemoveResult> {
    return this.run(operationId, async check => {
      const index = await this.loadIndex(check), record = this.record(index.value, itemId), { proof } = await this.blob(record, check)
      this.requireRevision(record, revision, index, proof)
      const time = this.timestamp()
      await this.commit(index, index.value.records.map(value => value.id === record.id ? { ...value, removedAt: time, updatedAt: time } : value), operationId, check)
      return { itemId, removed: true }
    })
  }
  export(itemId: string, revision: string, operationId: string, pickSave: () => Promise<string | null | undefined>): Promise<SkinExportResult> {
    return this.run(operationId, async check => {
      if (typeof pickSave !== 'function') fail('invalid', '本地皮肤导出回调无效')
      const index = await this.loadIndex(check), record = this.record(index.value, itemId), before = await this.blob(record, check)
      this.requireRevision(record, revision, index, before.proof)
      const destination = await pickSave(); check()
      if (destination === undefined || destination === null) return { itemId, exported: false }
      this.validPath(destination)
      await this.sameIndex(index, check)
      const fresh = await this.blob(record, check); this.requireRevision(record, revision, index, fresh.proof)
      const parent = await this.captureChain(path.dirname(destination), check)
      // Native save-dialog overwrite confirmation does not grant replacement permission here.
      let exported: FileProof
      try { exported = await this.writeNew(destination, fresh.proof.bytes, check) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('io', '目标文件已存在，请选择新文件名；未覆盖原文件')
        throw error
      }
      await this.hooks.afterExportWrite?.(destination); check()
      await this.sameFile(destination, exported, parent, check)
      await this.sameIndex(index, check)
      return { itemId, exported: true }
    })
  }

  cancel(operationId: string): Promise<void> {
    try { operation(operationId) } catch (error) { return Promise.reject(this.publicError(error)) }
    const active = this.active
    if (!active || active.id !== operationId) return Promise.resolve()
    active.controller.abort(new DOMException('本地皮肤任务已停止', 'AbortError'))
    return active.promise.then(() => {}, () => {})
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.state = 'closing'; this.active?.controller.abort(new DOMException('本地皮肤库正在关闭', 'AbortError'))
    this.closing = (async () => { await this.initial?.catch(() => {}); await this.active?.promise.catch(() => {}); await this.discardView(); this.state = 'closed' })()
    return this.closing
  }

  private inputOperation(value: unknown): string { fields(value, ['name', 'tags', 'model', 'operationId']); return operation(value.operationId) }
  private run<T>(operationId: string, work: (check: Check) => Promise<T>): Promise<T> {
    try {
      operation(operationId)
      if (this.state !== 'ready') fail('io', '本地皮肤库尚未就绪或已经关闭')
      if (this.recoveryBlocked) fail('recovery-required', '本地皮肤索引结果需要人工检查，已保留准备与历史资料')
      if (this.active) fail('busy', '已有本地皮肤任务正在进行，请等待实际文件操作结束')
      if (this.usedOperations.has(operationId)) fail('invalid', '本地皮肤任务标识已使用，请重新发起操作')
    } catch (error) { return Promise.reject(this.publicError(error)) }
    this.usedOperations.add(operationId)
    while (this.usedOperations.size > 4096) this.usedOperations.delete(this.usedOperations.values().next().value!)
    const controller = new AbortController(), deadline = performance.now() + SKIN_LIBRARY_LIMITS.operationMs,
      check: Check = Object.assign(() => { controller.signal.throwIfAborted(); if (performance.now() > deadline) fail('limit', '本地皮肤任务超过时间预算') }, { signal: controller.signal })
    const timer = setTimeout(() => controller.abort(new DOMException('本地皮肤任务超时', 'AbortError')), SKIN_LIBRARY_LIMITS.operationMs); timer.unref?.()
    const promise = Promise.resolve().then(async () => { await this.checkChain(this.chain, check); return work(check) }).catch(error => { throw this.publicError(error) })
    this.active = { id: operationId, controller, promise }
    void promise.then(() => { if (this.active?.promise === promise) this.active = undefined; clearTimeout(timer) }, () => { if (this.active?.promise === promise) this.active = undefined; clearTimeout(timer) })
    return promise
  }
  private publicError(error: unknown): Error {
    if (error instanceof SkinLibraryError) return error
    if (error instanceof Error && error.name === 'AbortError') return new DOMException('本地皮肤任务已停止；请等待实际文件操作结算', 'AbortError')
    if (error instanceof SkinImageError) return new SkinLibraryError(error.code === 'limit' ? 'limit' : 'invalid', error.code === 'unsupported' ? '此PNG皮肤格式当前不支持，请查看支持的尺寸与编码范围' : '皮肤PNG没有通过受限图像检查')
    return new SkinLibraryError('io', '本地皮肤文件操作未完成，请检查文件变化、空间和权限；已创建资料保留')
  }
  private idleCheck(): Check { return Object.assign(() => {}, { signal: new AbortController().signal }) }
  private timestamp(): string { const now = this.now(); if (!Number.isFinite(now)) fail('invalid', '本地皮肤时间无效'); return new Date(now).toISOString() }
  private summary(record: RecordValue): SkinSummary { const { id, name, tags, model, width, height, layout, createdAt, updatedAt } = record; return { id, name, tags: [...tags], model, width, height, layout, createdAt, updatedAt } }
  private revision(record: RecordValue, index: IndexProof, blob: FileProof): string { return hash(encode({ record, indexHash: index.file.hash, indexIdentity: index.file.identity, blobHash: blob.hash, blobIdentity: blob.identity })) }
  private item(record: RecordValue, index: IndexProof, blob: FileProof): SkinItem { return { ...this.summary(record), revision: this.revision(record, index, blob) } }
  private requireRevision(record: RecordValue, value: string, index: IndexProof, blob: FileProof): void { if (typeof value !== 'string' || !digest.test(value) || value !== this.revision(record, index, blob)) fail('stale', '本地皮肤条目已变化，请重新读取后再操作') }
  private diagnostics(image: SkinImageResult): SkinDiagnostics { return { warnings: [...image.warnings], alpha: { ...image.alpha } } }
  private dto<T>(value: T): T { if (Buffer.byteLength(JSON.stringify(value)) > SKIN_LIBRARY_LIMITS.dtoBytes) fail('limit', '本地皮肤结果超过显示预算'); return clone(value) }
  private record(index: Index, itemId: string): RecordValue { if (typeof itemId !== 'string' || !uuid.test(itemId)) fail('invalid', '皮肤条目标识无效'); const record = index.records.find(value => value.id === itemId && !value.removedAt); if (!record) fail('stale', '本地皮肤条目不存在或已移出收藏'); return record! }
  private matchImage(image: SkinImageResult, expected: Pick<SkinImageResult, 'width' | 'height' | 'layout' | 'pixelsSha256' | 'normalizedSha256'>): void {
    if (image.width !== expected.width || image.height !== expected.height || image.layout !== expected.layout || image.pixelsSha256 !== expected.pixelsSha256 || image.normalizedSha256 !== expected.normalizedSha256) fail('stale', '本地皮肤规范化图片或像素已变化')
  }
  private async blob(record: RecordValue, check: Check): Promise<{ proof: FileProof; image: SkinImageResult }> {
    const proof = await this.readFile(path.join(this.directory, 'blobs', record.normalizedSha256 + '.png'), SKIN_IMAGE_LIMITS.normalizedBytes, this.chain, check)
    if (proof.hash !== record.normalizedSha256 || proof.bytes.length !== record.blobBytes) fail('stale', '本地皮肤图片摘要或大小已变化')
    const image = this.normalize(proof.bytes, { signal: check.signal }); check(); this.matchImage(image, record)
    return { proof, image }
  }
  private async ensureBlob(image: SkinImageResult, check: Check): Promise<FileProof> {
    const directory = path.join(this.directory, 'blobs'), names = await this.names(directory, 1024)
    let total = 0
    for (const name of names) { check(); if (!/^[a-f0-9]{64}\.png$/.test(name)) fail('recovery-required', '本地皮肤图片目录含未知条目，已停止新增'); const stat = await fs.lstat(path.join(directory, name), { bigint: true }); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(SKIN_IMAGE_LIMITS.normalizedBytes)) fail('recovery-required', '本地皮肤图片目录含未知文件'); total += Number(stat.size) }
    const file = path.join(directory, image.normalizedSha256 + '.png')
    if (names.includes(image.normalizedSha256 + '.png')) {
      const proof = await this.readFile(file, SKIN_IMAGE_LIMITS.normalizedBytes, this.chain, check)
      if (proof.hash !== image.normalizedSha256 || !proof.bytes.equals(image.normalizedPng)) fail('stale', '已有本地皮肤图片与内容标识不符，不会覆盖')
      return proof
    }
    if (total + image.normalizedPng.length > SKIN_LIBRARY_LIMITS.blobsBytes) fail('limit', '本地皮肤图片总量超过32MiB，当前没有自动清理功能')
    return this.writeNew(file, image.normalizedPng, check)
  }

  private parseIndex(bytes: Buffer): Index {
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return fail('recovery-required', '本地皮肤索引损坏，不会回退为空库') }
    fields(raw, ['schema', 'sequence', 'commitId', 'records'])
    if (raw.schema !== 1 || !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 0 || Number(raw.sequence) > SKIN_LIBRARY_LIMITS.historyCommits ||
        typeof raw.commitId !== 'string' || (raw.sequence === 0 ? raw.commitId !== 'initial' : !uuid.test(raw.commitId)) || !Array.isArray(raw.records) || raw.records.length > SKIN_LIBRARY_LIMITS.records) fail('recovery-required', '本地皮肤索引结构无效或超限')
    const ids = new Set<string>()
    for (const value of raw.records) {
      fields(value, ['id', 'name', 'tags', 'model', 'width', 'height', 'layout', 'createdAt', 'updatedAt', 'sourceSha256', 'pixelsSha256', 'normalizedSha256', 'blobBytes', 'diagnostics', 'removedAt'])
      if (typeof value.id !== 'string' || !uuid.test(value.id) || ids.has(value.id) || value.width !== 64 || ![32, 64].includes(value.height as number) || value.layout !== (value.height === 32 ? 'legacy' : 'modern')) fail('recovery-required', '本地皮肤索引条目无效')
      ids.add(value.id); const meta = metadata({ name: value.name, tags: value.tags, model: value.model }, value.layout as 'legacy' | 'modern')
      if (meta.name !== value.name || JSON.stringify(meta.tags) !== JSON.stringify(value.tags) || !['sourceSha256', 'pixelsSha256', 'normalizedSha256'].every(key => typeof value[key] === 'string' && digest.test(value[key] as string)) ||
          !Number.isSafeInteger(value.blobBytes) || Number(value.blobBytes) < 1 || Number(value.blobBytes) > SKIN_IMAGE_LIMITS.normalizedBytes || !['createdAt', 'updatedAt', ...(value.removedAt === undefined ? [] : ['removedAt'])].every(key => typeof value[key] === 'string' && new Date(value[key] as string).toISOString() === value[key])) fail('recovery-required', '本地皮肤索引元数据无效')
      const diagnostics = value.diagnostics; fields(diagnostics, ['warnings', 'alpha']); const alpha = diagnostics.alpha; fields(alpha, ['transparentPixels', 'partialAlphaPixels'])
      if (!Array.isArray(diagnostics.warnings) || diagnostics.warnings.length > 32 || diagnostics.warnings.some(warning => typeof warning !== 'string' || warning.length > 512) ||
          !['transparentPixels', 'partialAlphaPixels'].every(key => Number.isSafeInteger(alpha[key]) && Number(alpha[key]) >= 0 && Number(alpha[key]) <= 4096)) fail('recovery-required', '本地皮肤诊断记录无效')
    }
    if (!encode(raw).equals(bytes)) fail('recovery-required', '本地皮肤索引含重复、歧义或非受管格式，不会覆盖')
    return raw as unknown as Index
  }
  private async loadIndex(check: Check): Promise<IndexProof> {
    const file = await this.readFile(path.join(this.directory, 'library.json'), SKIN_LIBRARY_LIMITS.indexBytes, this.chain, check), value = this.parseIndex(file.bytes)
    try { await this.history(value, file.hash, check) } catch (error) {
      if (error instanceof SkinLibraryError || check.signal.aborted) throw error
      fail('recovery-required', '本地皮肤索引历史不完整或身份未知，已保留资料，不会覆盖')
    }
    return { file, value }
  }
  private async sameIndex(expected: IndexProof, check: Check): Promise<void> {
    const current = await this.readFile(path.join(this.directory, 'library.json'), SKIN_LIBRARY_LIMITS.indexBytes, this.chain, check)
    if (current.identity !== expected.file.identity || current.hash !== expected.file.hash) fail('stale', '本地皮肤索引已被其他操作修改，请重新读取')
  }
  private async history(index: Index, currentHash: string, check: Check): Promise<void> {
    const directory = path.join(this.directory, 'history'), names = await this.names(directory, SKIN_LIBRARY_LIMITS.historyCommits * 4), intents = names.filter(name => name.endsWith('.intent.json'))
    if (intents.length > SKIN_LIBRARY_LIMITS.historyCommits || names.some(name => !/^[a-f0-9-]{36}\.(?:intent|complete|previous|pending)\.json$/.test(name))) fail('recovery-required', '本地皮肤索引历史含未知或超限条目')
    await this.historySize(check, names)
    let total = 0, maximum = 0
    const sequences = new Set<number>(), expectedNames = new Set<string>(), chain = new Map<number, { previous: string; next: string }>()
    for (const name of intents) {
      check(); const id = name.slice(0, -'.intent.json'.length), bytes = (await this.readFile(path.join(directory, name), 4096, this.chain, check)).bytes; total += bytes.length
      let intent: unknown; try { intent = JSON.parse(bytes.toString('utf8')) } catch { fail('recovery-required', '本地皮肤索引提交记录损坏') }
      fields(intent, ['schema', 'operationId', 'sequence', 'previousSha256', 'nextSha256'])
      if (intent.schema !== 1 || intent.operationId !== id || !uuid.test(id) || !Number.isSafeInteger(intent.sequence) || Number(intent.sequence) < 1 || Number(intent.sequence) > SKIN_LIBRARY_LIMITS.historyCommits || sequences.has(Number(intent.sequence)) ||
          !digest.test(String(intent.previousSha256)) || !digest.test(String(intent.nextSha256)) || !encode(intent).equals(bytes)) fail('recovery-required', '本地皮肤索引提交记录无效')
      sequences.add(Number(intent.sequence)); maximum = Math.max(maximum, Number(intent.sequence))
      chain.set(Number(intent.sequence), { previous: intent.previousSha256 as string, next: intent.nextSha256 as string })
      const completed = (await this.readFile(path.join(directory, id + '.complete.json'), 4096, this.chain, check)).bytes; total += completed.length
      if (!completed.equals(encode({ schema: 1, operationId: id, intentSha256: hash(bytes), nextSha256: intent.nextSha256 }))) fail('recovery-required', '本地皮肤索引存在未确认结果，已保留全部资料')
      // Historical backup bytes were independently verified when written. Startup does not rehash
      // every old payload or offer restoration, but never accepts a linked/special/unbounded backup.
      const previous = await fs.lstat(path.join(directory, id + '.previous.json'), { bigint: true }); check()
      if (!previous.isFile() || previous.isSymbolicLink() || previous.size < 1n || previous.size > BigInt(SKIN_LIBRARY_LIMITS.indexBytes)) fail('recovery-required', '本地皮肤历史备份不是受限普通文件')
      for (const suffix of ['intent', 'complete', 'previous']) expectedNames.add(id + '.' + suffix + '.json')
      if (intent.sequence === index.sequence && (id !== index.commitId || intent.nextSha256 !== currentHash)) fail('recovery-required', '本地皮肤索引与完成凭据不一致')
      if (total > SKIN_LIBRARY_LIMITS.historyControlBytes) fail('limit', '本地皮肤索引控制凭据读取超过预算')
    }
    if (names.some(name => !expectedNames.has(name)) || names.length !== expectedNames.size || maximum !== index.sequence || sequences.size !== index.sequence) fail('recovery-required', '本地皮肤索引存在不完整历史，不会自动恢复或覆盖')
    let previousHash = hash(encode({ schema: 1, sequence: 0, commitId: 'initial', records: [] }))
    for (let sequence = 1; sequence <= maximum; sequence++) {
      const entry = chain.get(sequence)!
      if (entry.previous !== previousHash) fail('recovery-required', '本地皮肤索引历史哈希链不一致，不会自动修复')
      previousHash = entry.next
    }
  }
  private async commit(previous: IndexProof, records: RecordValue[], operationId: string, check: Check): Promise<IndexProof> {
    if (previous.value.sequence >= SKIN_LIBRARY_LIMITS.historyCommits) fail('limit', '本地皮肤索引历史已达本版有限预算，资料已保留')
    const value: Index = { schema: 1, sequence: previous.value.sequence + 1, commitId: operationId, records }, bytes = encode(value)
    if (bytes.length > SKIN_LIBRARY_LIMITS.indexBytes) fail('limit', '本地皮肤索引超过1MiB预算')
    const directory = path.join(this.directory, 'history'), pending = path.join(directory, operationId + '.pending.json'), intentFile = path.join(directory, operationId + '.intent.json'),
      target = path.join(this.directory, 'library.json'), intent: Intent = { schema: 1, operationId, sequence: value.sequence, previousSha256: previous.file.hash, nextSha256: hash(bytes) }
    const intentBytes = encode(intent), completeBytes = encode({ schema: 1, operationId, intentSha256: hash(intentBytes), nextSha256: intent.nextSha256 })
    // Include the temporary new-index snapshot, retained old snapshot and both controls before writing.
    if (await this.historySize(check) + previous.file.bytes.length + bytes.length + intentBytes.length + completeBytes.length > SKIN_LIBRARY_LIMITS.historyBytes) fail('limit', '本地皮肤索引历史将超过128MiB，资料保留且未开始本次提交')
    let intentAttempted = false
    try {
      await this.sameIndex(previous, check)
      await this.writeNew(path.join(directory, operationId + '.previous.json'), previous.file.bytes, check)
      const prepared = await this.writeNew(pending, bytes, check)
      await this.sameIndex(previous, check)
      intentAttempted = true; const intentProof = await this.writeNew(intentFile, intentBytes, check)
      await this.hooks.beforeIndexPublish?.(); check()
      await this.sameIndex(previous, check)
      await this.sameFile(pending, prepared, this.chain, check)
      await this.sameFile(intentFile, intentProof, this.chain, check)
      await this.checkChain(this.chain, check)
      let renameError: unknown
      try { if (this.hooks.renameIndex) await this.hooks.renameIndex(pending, target); else await fs.rename(pending, target) } catch (error) { renameError = error }
      await this.hooks.afterIndexPublish?.()
      const published = await this.readFile(target, SKIN_LIBRARY_LIMITS.indexBytes, this.chain, this.idleCheck())
      // Our rename may update ctime. Keep its creation node, size, mtime, link count and full bytes bound.
      const renameIdentity = (value: string) => value.split(':').filter((_field, index) => index !== 5).join(':')
      if (renameIdentity(published.identity) !== renameIdentity(prepared.identity) || published.hash !== intent.nextSha256) throw renameError ?? new Error('index outcome unknown')
      // Publication has happened; a late stop cannot turn a fully checked commit into a fake rollback.
      await this.writeNew(path.join(directory, operationId + '.complete.json'), encode({ schema: 1, operationId, intentSha256: intentProof.hash, nextSha256: intent.nextSha256 }), this.idleCheck())
      const final = await this.readFile(target, SKIN_LIBRARY_LIMITS.indexBytes, this.chain, this.idleCheck())
      if (final.identity !== published.identity || final.hash !== published.hash) throw new Error('index final readback changed')
      return { file: final, value }
    } catch (error) {
      if (intentAttempted) { this.recoveryBlocked = true; fail('recovery-required', '本地皮肤索引提交结果需要人工检查，准备、备份和图片均已保留') }
      throw error
    }
  }

  private async historySize(check: Check, names?: string[]): Promise<number> {
    const directory = path.join(this.directory, 'history'), entries = names ?? await this.names(directory, SKIN_LIBRARY_LIMITS.historyCommits * 4)
    let total = 0
    for (const name of entries) {
      check()
      if (!/^[a-f0-9-]{36}\.(?:intent|complete|previous|pending)\.json$/.test(name)) fail('recovery-required', '本地皮肤索引历史含未知条目')
      const stat = await fs.lstat(path.join(directory, name), { bigint: true }); check()
      const maximum = /\.(?:intent|complete)\.json$/.test(name) ? 4096 : SKIN_LIBRARY_LIMITS.indexBytes
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1n || stat.size > BigInt(maximum)) fail('recovery-required', '本地皮肤历史备份不是受限普通文件')
      total += Number(stat.size)
      if (total > SKIN_LIBRARY_LIMITS.historyBytes) fail('limit', '本地皮肤索引历史超过128MiB，当前没有自动清理功能')
    }
    await this.checkChain(this.chain, check)
    return total
  }

  private validPath(file: string): void { if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(file) || path.resolve(file) === path.parse(file).root) fail('invalid', '本地皮肤文件路径无效') }
  private async mkdir(directory: string): Promise<void> { await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }); const s = await fs.lstat(directory, { bigint: true }); if (!s.isDirectory() || s.isSymbolicLink()) fail('io', '本地皮肤目录不是普通目录') }
  private async names(directory: string, limit: number): Promise<string[]> { const result: string[] = [], handle = await fs.opendir(directory); try { for await (const entry of handle) { if (result.length >= limit) fail('limit', '本地皮肤目录条目超过预算'); result.push(entry.name) } } finally { await handle.close().catch(() => {}) } return result }
  private async captureChain(directory: string, check: () => void = () => {}): Promise<Chain> {
    let current = path.parse(directory).root; const chain: Chain = new Map()
    for (const part of ['', ...directory.slice(current.length).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part); check(); const stat = await fs.lstat(current, { bigint: true }); check()
      if (stat.isSymbolicLink()) { if (!(process.platform === 'darwin' && current !== directory && (current === '/tmp' && await fs.realpath(current) === '/private/tmp' || current === '/var' && await fs.realpath(current) === '/private/var'))) fail('io', '本地皮肤文件祖先含链接') }
      else if (!stat.isDirectory()) fail('io', '本地皮肤文件祖先不是普通目录')
      chain.set(current, node(stat))
    }
    return chain
  }
  private async checkChain(chain: Chain, check: () => void = () => {}): Promise<void> { if (!chain.size) fail('io', '本地皮肤目录观察无效'); for (const [file, expected] of chain) { check(); if (node(await fs.lstat(file, { bigint: true })) !== expected) fail('stale', '本地皮肤目录在操作期间变化'); check() } }
  private async readFile(file: string, maximum: number, chain: Chain, check: () => void): Promise<FileProof> {
    await this.checkChain(chain, check); const before = await fs.lstat(file, { bigint: true }); check()
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(maximum)) fail('io', '本地皮肤文件不是受限普通文件')
    const expected = identity(before), handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      if (identity(await handle.stat({ bigint: true })) !== expected) fail('stale', '本地皮肤文件在打开时变化')
      const bytes = Buffer.alloc(Number(before.size)); let done = 0
      while (done < bytes.length) { check(); const read = await handle.read(bytes, done, Math.min(SKIN_LIBRARY_LIMITS.bufferBytes, bytes.length - done), done); check(); if (!read.bytesRead) fail('io', '本地皮肤文件读取不完整'); done += read.bytesRead }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, done); check()
      if (extra.bytesRead || identity(await handle.stat({ bigint: true })) !== expected || identity(await fs.lstat(file, { bigint: true })) !== expected) fail('stale', '本地皮肤文件读取期间变化')
      await this.checkChain(chain, check)
      return { identity: expected, node: node(before), hash: hash(bytes), bytes }
    } finally { await handle.close() }
  }
  private async writeNew(file: string, bytes: Buffer, check: Check): Promise<FileProof> {
    if (!bytes.length || bytes.length > Math.max(SKIN_LIBRARY_LIMITS.indexBytes, SKIN_IMAGE_LIMITS.fileBytes)) fail('limit', '本地皮肤写入超过预算')
    const parent = await this.captureChain(path.dirname(file), check); await this.checkChain(this.chain, check)
    const handle = await fs.open(file, 'wx', 0o600); let opened: BigIntStats
    try {
      opened = await handle.stat({ bigint: true }); let done = 0
      while (done < bytes.length) { check(); const length = Math.min(SKIN_LIBRARY_LIMITS.bufferBytes, bytes.length - done), count = this.hooks.write ? await this.hooks.write(handle, bytes, done, length, done, file) : (await handle.write(bytes, done, length, done)).bytesWritten
        if (!Number.isSafeInteger(count) || count < 1 || count > length) fail('io', '本地皮肤写入不完整'); done += count; check() }
      await handle.sync(); check()
    } finally { await handle.close() }
    const proof = await this.readFile(file, bytes.length, parent, check)
    if (proof.node !== node(opened!) || proof.identity.split(':').at(-1) !== '1' || proof.hash !== hash(bytes) || !proof.bytes.equals(bytes)) fail('stale', '本地皮肤磁盘读回不一致')
    await this.checkChain(this.chain, check)
    return proof
  }
  private async sameFile(file: string, expected: FileProof, chain: Chain, check: () => void): Promise<FileProof> { const fresh = await this.readFile(file, expected.bytes.length, chain, check); if (fresh.identity !== expected.identity || fresh.hash !== expected.hash) fail('stale', '本地皮肤文件身份或摘要变化'); return fresh }
  private async previewBudget(check: Check): Promise<void> {
    const base = path.join(this.directory, 'previews'), names = await this.names(base, SKIN_LIBRARY_LIMITS.previewDirectories)
    if (names.length >= SKIN_LIBRARY_LIMITS.previewDirectories) fail('limit', '本地皮肤准备目录已达有限预算，请保留资料后人工检查')
    let bytes = 0
    for (const name of names) { check(); if (!uuid.test(name)) fail('recovery-required', '本地皮肤准备目录含未知条目'); const dir = path.join(base, name), stat = await fs.lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('recovery-required', '本地皮肤准备目录含不安全条目'); for (const filename of await this.names(dir, 2)) { if (!['source.png', 'normalized.png'].includes(filename)) fail('recovery-required', '本地皮肤准备目录含未知文件'); const item = await fs.lstat(path.join(dir, filename)); if (!item.isFile() || item.isSymbolicLink() || item.size > SKIN_IMAGE_LIMITS.fileBytes) fail('recovery-required', '本地皮肤准备文件身份未知'); bytes += item.size } }
    if (bytes + SKIN_IMAGE_LIMITS.fileBytes + SKIN_IMAGE_LIMITS.normalizedBytes > SKIN_LIBRARY_LIMITS.previewBytes) fail('limit', '本地皮肤准备资料超过32MiB，当前没有历史清理功能')
  }
  private async removePrivate(file: string, proof: FileProof | undefined, chain: Chain): Promise<void> {
    if (!proof) return
    try { const fresh = await this.sameFile(file, proof, chain, () => {}); if (fresh.identity.split(':').at(-1) !== '1') return; await this.checkChain(chain); if (identity(await fs.lstat(file, { bigint: true })) === fresh.identity) await fs.unlink(file) } catch { /* Unknown files are retained. */ }
  }
  private async removeDirectory(directory: string, chain: Chain): Promise<void> { try { await this.checkChain(chain); await fs.rmdir(directory) } catch { /* Never recursively remove a directory. */ } }
  private async discardView(view = this.view): Promise<void> {
    if (!view) return
    if (this.view === view) this.view = undefined
    try { const chain = view.privateChain; await this.removePrivate(view.raw.file, view.raw.proof, chain); await this.removePrivate(view.normalized.file, view.normalized.proof, chain); await this.removeDirectory(view.directory, chain) } catch { /* No sweep of historical or changed preview files. */ }
  }
}
