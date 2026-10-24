import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { PNG } from 'pngjs'
import { SkinLibrary, SKIN_LIBRARY_LIMITS, type SkinLibraryHooks, type SkinLibraryOptions } from './skin-library'
import type { SkinMutationInput } from './skin-library-types'

const op = () => randomUUID()
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
function png(height: 32 | 64 = 64, seed = 3): Buffer {
  const data = Buffer.alloc(64 * height * 4)
  for (let i = 0; i < data.length; i += 4) { data[i] = (i / 4 + seed) % 256; data[i + 1] = (i / 16 + seed * 7) % 256; data[i + 2] = seed; data[i + 3] = 255 }
  return PNG.sync.write({ width: 64, height, data })
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function proof(file: string) { const s = await fs.lstat(file, { bigint: true }); return { bytes: await fs.readFile(file), identity: [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs, s.nlink].map(String).join(':') } }
async function fixture(t: TestContext, options: SkinLibraryOptions = {}, height: 32 | 64 = 64) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-skin-library-')), source = path.join(root, 'original.png'), bytes = png(height)
  await fs.writeFile(source, bytes)
  const library = new SkinLibrary(root, options); await library.init()
  t.after(async () => { await library.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, source, bytes, library, index: path.join(root, 'skins', 'library.json'), blobs: path.join(root, 'skins', 'blobs'), history: path.join(root, 'skins', 'history'), previews: path.join(root, 'skins', 'previews') }
}
const input = (name = '原创皮肤', model: 'classic' | 'slim' = 'classic'): SkinMutationInput => ({ name, tags: ['原创', '测试'], model, operationId: op() })
async function saved(library: SkinLibrary, source: string, name?: string, model: 'classic' | 'slim' = 'classic') { const preview = await library.prepare(op(), async () => source); assert.ok(preview); return library.save(preview.viewId, input(name, model)) }
async function previewFiles(directory: string) { const dirs = await fs.readdir(directory); return dirs.map(name => path.join(directory, name)) }

test('prepare/save/list/read/update/export/remove and restart preserve original source and normalized pixels', async t => {
  const f = await fixture(t), baseline = await proof(f.source), preview = await f.library.prepare(op(), async () => f.source)
  assert.ok(preview); assert.equal(preview.layout, 'modern'); assert.ok(preview.textureDataURL.startsWith('data:image/png;base64,')); assert.equal('source' in preview, false)
  assert.deepEqual((await f.library.list()).items, [])
  const item = await f.library.save(preview.viewId, input('我的/../皮肤', 'slim'))
  const page = await f.library.list({ query: '皮肤', tag: '原创', limit: 24, operationId: op() })
  assert.equal(page.total, 1); assert.equal(page.items[0].id, item.id); assert.equal('textureDataURL' in page.items[0], false); assert.equal('revision' in page.items[0], false)
  const read = await f.library.read(item.id, { operationId: op() }); assert.equal(read.revision, item.revision)
  const texture = Buffer.from(read.textureDataURL.split(',')[1], 'base64')
  assert.deepEqual(PNG.sync.read(texture).data, PNG.sync.read(f.bytes).data)
  const changed = await f.library.update(item.id, read.revision, { ...input('新名称'), tags: ['保存后'] })
  assert.equal(changed.name, '新名称'); assert.notEqual(changed.revision, read.revision)
  const destination = path.join(f.root, 'exported.png')
  assert.deepEqual(await f.library.export(item.id, changed.revision, op(), async () => destination), { itemId: item.id, exported: true })
  assert.deepEqual(await fs.readFile(destination), texture)
  await f.library.close()
  const restarted = new SkinLibrary(f.root); await restarted.init(); t.after(() => restarted.close())
  const after = await restarted.read(item.id); assert.equal(after.item.name, '新名称'); assert.equal(after.item.model, 'classic'); assert.deepEqual(after.item.tags, ['保存后']); assert.deepEqual(PNG.sync.read(Buffer.from(after.textureDataURL.split(',')[1], 'base64')).data, PNG.sync.read(texture).data)
  const blobNames = await fs.readdir(f.blobs)
  await restarted.remove(item.id, after.revision, op()); assert.equal((await restarted.list()).total, 0); assert.deepEqual(await fs.readdir(f.blobs), blobNames)
  assert.deepEqual(await proof(f.source), baseline)
})

test('same normalized image shares a content blob but keeps independent saved model semantics', async t => {
  const f = await fixture(t), classic = await saved(f.library, f.source, '经典', 'classic'), slim = await saved(f.library, f.source, '纤细', 'slim')
  assert.notEqual(classic.id, slim.id); assert.equal((await fs.readdir(f.blobs)).length, 1)
  assert.equal((await f.library.read(classic.id)).item.model, 'classic'); assert.equal((await f.library.read(slim.id)).item.model, 'slim')
})

test('legacy layout only admits classic model without altering the 64x32 image', async t => {
  const f = await fixture(t, {}, 32), preview = await f.library.prepare(op(), async () => f.source); assert.ok(preview)
  assert.equal(preview.height, 32); assert.equal(preview.layout, 'legacy')
  await assert.rejects(f.library.save(preview.viewId, input('旧布局', 'slim')), /旧布局仅支持/)
  const item = await f.library.save(preview.viewId, input('旧布局', 'classic'))
  await assert.rejects(f.library.update(item.id, item.revision, input('非法纤细', 'slim')), /旧布局仅支持/)
  assert.equal((await f.library.read(item.id)).item.height, 32)
})

test('save capability is one-use and expires independently of read-only item revisions', async t => {
  let now = 0; const f = await fixture(t, { now: () => now })
  const preview = await f.library.prepare(op(), async () => f.source); assert.ok(preview)
  now = SKIN_LIBRARY_LIMITS.capabilityMs + 1
  await assert.rejects(f.library.save(preview.viewId, input()), /已过期/)
  const fresh = await f.library.prepare(op(), async () => f.source); assert.ok(fresh)
  const item = await f.library.save(fresh.viewId, input())
  await assert.rejects(f.library.save(fresh.viewId, input()), /已过期/)
  now += SKIN_LIBRARY_LIMITS.capabilityMs * 3
  assert.equal((await f.library.read(item.id)).item.id, item.id)
})

test('source or cached PNG changes revoke saving without modifying the changed or original files', async t => {
  for (const which of ['source', 'raw', 'normalized']) {
    const f = await fixture(t), preview = await f.library.prepare(op(), async () => f.source); assert.ok(preview)
    const [directory] = await previewFiles(f.previews), file = which === 'source' ? f.source : path.join(directory, which === 'raw' ? 'source.png' : 'normalized.png'), replacement = png(64, 19)
    await fs.writeFile(file, replacement)
    await assert.rejects(f.library.save(preview.viewId, input()), /变化|受限普通文件/)
    assert.deepEqual(await fs.readFile(file), replacement); assert.equal((await f.library.list()).total, 0)
    if (which !== 'source') assert.deepEqual(await fs.readFile(f.source), f.bytes)
  }
})

test('source copied callback replacement, same-size mutation and source links never issue a save capability', async t => {
  for (const change of ['replace', 'modify']) {
    const f = await fixture(t, { hooks: { afterSourceCopied: async source => {
      if (change === 'replace') { await fs.rename(source, source + '.original'); await fs.writeFile(source, png(64, 8)) }
      else { const bytes = await fs.readFile(source); bytes[bytes.length - 1] ^= 1; await fs.writeFile(source, bytes) }
    } } })
    await assert.rejects(f.library.prepare(op(), async () => f.source), /变化/)
    assert.equal((await f.library.list()).total, 0)
    if (change === 'replace') assert.deepEqual(await fs.readFile(f.source + '.original'), f.bytes)
  }
  const f = await fixture(t), symlink = path.join(f.root, 'alias.png'); await fs.symlink(f.source, symlink)
  await assert.rejects(f.library.prepare(op(), async () => symlink), /受限普通文件/)
  assert.deepEqual(await fs.readFile(f.source), f.bytes)
})

test('source ancestor links and unsafe library roots are refused without following or deleting targets', async t => {
  const f = await fixture(t), real = path.join(f.root, 'real'), alias = path.join(f.root, 'alias')
  await fs.mkdir(real); await fs.writeFile(path.join(real, 'skin.png'), f.bytes); await fs.symlink(real, alias)
  await assert.rejects(f.library.prepare(op(), async () => path.join(alias, 'skin.png')), /祖先含链接/)
  const another = path.join(f.root, 'another'), foreign = path.join(f.root, 'foreign'); await fs.mkdir(another); await fs.mkdir(foreign); await fs.symlink(foreign, path.join(another, 'skins'))
  const unsafe = new SkinLibrary(another); await assert.rejects(unsafe.init(), /普通目录/); await unsafe.close(); assert.deepEqual(await fs.readdir(foreign), [])
})

test('bad PNG bytes, oversize input and unknown image format never become collections', async t => {
  const f = await fixture(t)
  for (const bytes of [Buffer.from('<svg>not a png</svg>'), Buffer.alloc(2 * 1024 ** 2 + 1)]) {
    await fs.writeFile(f.source, bytes); await assert.rejects(f.library.prepare(op(), async () => f.source)); assert.equal((await f.library.list()).total, 0)
  }
})

test('short writes are completed and disk-full/invalid acknowledgements never save an item', async t => {
  let writes = 0
  const good = await fixture(t, { hooks: { write: async (handle, bytes, offset, length, position) => { writes++; return (await handle.write(bytes, offset, Math.min(17, length), position)).bytesWritten } } })
  assert.ok((await saved(good.library, good.source)).id); assert.ok(writes > 10)
  for (const mode of ['zero', 'disk-full']) {
    const f = await fixture(t, { hooks: { write: async (handle, bytes, offset, length, position, file) => {
      if (file.endsWith('source.png')) { if (mode === 'zero') return 0; throw Object.assign(new Error('secret /native/path ENOSPC'), { code: 'ENOSPC' }) }
      return (await handle.write(bytes, offset, length, position)).bytesWritten
    } } })
    const before = await proof(f.source)
    await assert.rejects(f.library.prepare(op(), async () => f.source), error => !String((error as Error).message).includes('/native/path'))
    assert.equal((await f.library.list()).total, 0); assert.deepEqual(await proof(f.source), before)
  }
})

test('single reservation includes native picker wait and exact cancel waits actual callback settlement', async t => {
  const f = await fixture(t), entered = gate(), release = gate(), id = op()
  const running = f.library.prepare(id, async () => { entered.resolve(); await release.promise; return f.source })
  const rejected = assert.rejects(running, error => (error as Error).name === 'AbortError')
  await entered.promise; await assert.rejects(f.library.list(), /已有本地皮肤任务/)
  await f.library.cancel(op()); let settled = false
  const cancelled = f.library.cancel(id).then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false)
  release.resolve(); await rejected; await cancelled; assert.equal(settled, true); assert.equal((await f.library.list()).total, 0)
})

test('close rejects new operations and waits a noncooperative picker without creating late previews', async t => {
  const f = await fixture(t), entered = gate(), release = gate()
  const running = f.library.prepare(op(), async () => { entered.resolve(); await release.promise; return f.source })
  const rejected = assert.rejects(running, error => (error as Error).name === 'AbortError')
  await entered.promise; let closed = false; const closing = f.library.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); await assert.rejects(f.library.list(), /已经关闭/)
  release.resolve(); await rejected; await closing; assert.deepEqual(await fs.readdir(f.previews), [])
})

test('names never form paths, metadata limits and unknown/accessor fields are rejected', async t => {
  const f = await fixture(t), preview = await f.library.prepare(op(), async () => f.source); assert.ok(preview)
  for (const bad of [{ ...input(), name: 'x'.repeat(65) }, { ...input(), tags: ['A', 'a'] }, { ...input(), tags: Array(9).fill('tag') }, { ...input(), name: 'line\nnext' }, { ...input(), source: '/native/path' }]) await assert.rejects(() => f.library.save(preview.viewId, bad as SkinMutationInput))
  let touched = false
  await assert.rejects(() => f.library.save(preview.viewId, { ...input(), get path() { touched = true; return '/native/path' } } as SkinMutationInput)); assert.equal(touched, false)
  const item = await f.library.save(preview.viewId, input('../../still a display name'))
  assert.equal(item.name, '../../still a display name'); assert.equal((await fs.readdir(f.blobs)).every(name => /^[a-f0-9]{64}\.png$/.test(name)), true)
  await assert.rejects(f.library.list({ query: 'x'.repeat(201) })); await assert.rejects(f.library.list({ limit: 25 })); await assert.rejects(f.library.list({ offset: -1 })); await assert.rejects(f.library.read('../../bad'))
})

test('search/tag/pagination returns bounded metadata only and preserves entries across pages', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 27; i++) await saved(f.library, f.source, '皮肤 ' + i)
  const first = await f.library.list({ limit: 24 }), next = await f.library.list({ offset: 24, limit: 24 })
  assert.equal(first.total, 27); assert.equal(first.items.length, 24); assert.equal(next.items.length, 3)
  assert.equal(new Set([...first.items, ...next.items].map(item => item.id)).size, 27)
  assert.equal(JSON.stringify(first).includes('base64'), false); assert.equal(JSON.stringify(first).includes(f.root), false)
  assert.equal((await f.library.list({ query: '皮肤 26', tag: '测试' })).total, 1)
})

test('read-only revisions reject stale edits/removals and fresh blob replacements', async t => {
  const f = await fixture(t), item = await saved(f.library, f.source), current = await f.library.read(item.id)
  const renamed = await f.library.update(item.id, current.revision, input('renamed'))
  await assert.rejects(f.library.update(item.id, current.revision, input()), /已变化/)
  await assert.rejects(f.library.remove(item.id, current.revision, op()), /已变化/)
  const [filename] = await fs.readdir(f.blobs), blob = path.join(f.blobs, filename)
  await fs.writeFile(blob, png(64, 7))
  await assert.rejects(f.library.read(renamed.id), /变化|受限普通文件/)
  await assert.rejects(f.library.remove(renamed.id, renamed.revision, op()), /变化|受限普通文件/)
})

test('export is native-callback-only, graceful cancellation and no overwrite even if an existing path is chosen', async t => {
  const f = await fixture(t), item = await saved(f.library, f.source), file = path.join(f.root, 'existing.png')
  assert.deepEqual(await f.library.export(item.id, item.revision, op(), async () => null), { itemId: item.id, exported: false })
  await fs.writeFile(file, 'foreign file'); const before = await proof(file)
  await assert.rejects(f.library.export(item.id, item.revision, op(), async () => file))
  assert.deepEqual(await proof(file), before); assert.equal((await f.library.list()).total, 1)
})

test('export rechecks revision and current blob after native dialog wait before writing', async t => {
  const f = await fixture(t), item = await saved(f.library, f.source), [name] = await fs.readdir(f.blobs), file = path.join(f.root, 'never-written.png')
  await assert.rejects(f.library.export(item.id, item.revision, op(), async () => { await fs.writeFile(path.join(f.blobs, name), png(64, 21)); return file }), /变化|受限普通文件/)
  await assert.rejects(fs.stat(file), { code: 'ENOENT' })
})

test('export disk failure preserves partial output and never changes a source or library entry', async t => {
  let destination = ''
  const hooks: SkinLibraryHooks = { write: async (handle, bytes, offset, length, position, file) => {
    if (file === destination) { await handle.write(bytes, offset, Math.min(length, 31), position); throw new Error('simulated disk full /sensitive/path') }
    return (await handle.write(bytes, offset, length, position)).bytesWritten
  } }
  const f = await fixture(t, { hooks }), item = await saved(f.library, f.source), original = await proof(f.source)
  destination = path.join(f.root, 'partial.png')
  await assert.rejects(f.library.export(item.id, item.revision, op(), async () => destination), error => !(error as Error).message.includes('/sensitive/path'))
  assert.equal((await fs.stat(destination)).size, 31); assert.equal((await f.library.list()).total, 1); assert.deepEqual(await proof(f.source), original)
})

test('lost rename acknowledgement is resolved by exact new-index node and byte readback', async t => {
  const f = await fixture(t, { hooks: { renameIndex: async (from, to) => { await fs.rename(from, to); throw new Error('ACK lost') } } })
  const item = await saved(f.library, f.source); assert.equal((await f.library.read(item.id)).item.id, item.id)
  await f.library.close(); const again = new SkinLibrary(f.root); await again.init(); t.after(() => again.close()); assert.equal((await again.list()).total, 1)
})

test('CAS detects an index changed immediately before publication and never overwrites the foreign bytes', async t => {
  let changedIndex = ''
  const f = await fixture(t, { hooks: { beforeIndexPublish: async () => { await fs.writeFile(changedIndex, 'foreign modified index') } } }); changedIndex = f.index
  const preview = await f.library.prepare(op(), async () => f.source); assert.ok(preview)
  await assert.rejects(f.library.save(preview.viewId, input()), /人工检查/)
  assert.equal(await fs.readFile(f.index, 'utf8'), 'foreign modified index')
  await assert.rejects(f.library.list(), /人工检查/)
  await f.library.close(); const again = new SkinLibrary(f.root); await assert.rejects(again.init()); await again.close()
  assert.equal(await fs.readFile(f.index, 'utf8'), 'foreign modified index')
})

test('post-publication unknown result remains blocked after restart instead of returning fake success', async t => {
  let index = ''
  const f = await fixture(t, { hooks: { afterIndexPublish: async () => { await fs.writeFile(index, 'unknown third-party result') } } }); index = f.index
  const preview = await f.library.prepare(op(), async () => f.source); assert.ok(preview)
  await assert.rejects(f.library.save(preview.viewId, input()), /人工检查/)
  await f.library.close(); const again = new SkinLibrary(f.root); await assert.rejects(again.init()); await again.close()
  assert.equal(await fs.readFile(index, 'utf8'), 'unknown third-party result'); assert.ok((await fs.readdir(f.blobs)).length)
})

test('bad, duplicate-key and oversized indexes are never replaced by an empty gallery', async t => {
  for (const malformed of [Buffer.from('broken JSON'), Buffer.from('{"schema":1,"schema":1,"sequence":0,"commitId":"initial","records":[]}\n'), Buffer.alloc(SKIN_LIBRARY_LIMITS.indexBytes + 1)]) {
    const f = await fixture(t); await f.library.close(); await fs.writeFile(f.index, malformed)
    const again = new SkinLibrary(f.root); await assert.rejects(again.init()); await again.close(); assert.deepEqual(await fs.readFile(f.index), malformed)
  }
})

test('missing index with retained blob/history never initializes a new empty index', async t => {
  const f = await fixture(t); await saved(f.library, f.source); await f.library.close(); await fs.unlink(f.index)
  const again = new SkinLibrary(f.root); await assert.rejects(again.init(), /索引缺失/); await again.close(); await assert.rejects(fs.stat(f.index), { code: 'ENOENT' })
})

test('independent red regression: a linked historical previous snapshot is rejected without touching its target', async t => {
  const f = await fixture(t); await saved(f.library, f.source)
  const [previous] = (await fs.readdir(f.history)).filter(name => name.endsWith('.previous.json')), file = path.join(f.history, previous), foreign = path.join(f.root, 'foreign.json')
  await fs.writeFile(foreign, 'foreign backup-looking data'); await fs.unlink(file); await fs.symlink(foreign, file)
  await assert.rejects(f.library.list(), /历史备份不是受限普通文件/)
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign backup-looking data')
})

test('adjacent completed history digests form a checked chain, not a set of unrelated successful markers', async t => {
  const f = await fixture(t); const one = await saved(f.library, f.source); await f.library.update(one.id, one.revision, input('second'))
  const intents = (await fs.readdir(f.history)).filter(name => name.endsWith('.intent.json'))
  for (const filename of intents) {
    const file = path.join(f.history, filename), intent = JSON.parse(await fs.readFile(file, 'utf8'))
    if (intent.sequence !== 2) continue
    intent.previousSha256 = '0'.repeat(64); const bytes = encoded(intent); await fs.writeFile(file, bytes)
    await fs.writeFile(file.replace('.intent.json', '.complete.json'), encoded({ schema: 1, operationId: intent.operationId, intentSha256: sha(bytes), nextSha256: intent.nextSha256 }))
  }
  await assert.rejects(f.library.list(), /历史哈希链不一致/)
})

test('completed previous snapshots are historical write-time proof, not silently claimed current rehash validation', async t => {
  const f = await fixture(t); await saved(f.library, f.source)
  const [previous] = (await fs.readdir(f.history)).filter(name => name.endsWith('.previous.json'))
  await fs.writeFile(path.join(f.history, previous), 'changed historical bytes remain retained')
  assert.equal((await f.library.list()).total, 1)
})

test('500 original constructed historical records block addition even when all entries were removed', async t => {
  const f = await fixture(t); await saved(f.library, f.source)
  const index = JSON.parse(await fs.readFile(f.index, 'utf8')), original = index.records[0], operationId = index.commitId
  index.records = Array.from({ length: 500 }, (_value, i) => ({ ...original, id: op(), name: 'historical ' + i, removedAt: original.updatedAt }))
  const bytes = encoded(index), intentFile = path.join(f.history, operationId + '.intent.json'), intent = JSON.parse(await fs.readFile(intentFile, 'utf8')); intent.nextSha256 = sha(bytes)
  const intentBytes = encoded(intent); await fs.writeFile(intentFile, intentBytes); await fs.writeFile(path.join(f.history, operationId + '.complete.json'), encoded({ schema: 1, operationId, intentSha256: sha(intentBytes), nextSha256: sha(bytes) })); await fs.writeFile(f.index, bytes)
  assert.equal((await f.library.list()).total, 0)
  const preview = await f.library.prepare(op(), async () => f.source); assert.ok(preview)
  await assert.rejects(f.library.save(preview.viewId, input()), /历史收藏已达500项/)
})

test('changing preview ancestor never permits cleanup of an unrelated replacement directory', async t => {
  const f = await fixture(t), preview = await f.library.prepare(op(), async () => f.source); assert.ok(preview)
  const [directory] = await previewFiles(f.previews), savedDir = directory + '-preserved'
  await fs.rename(directory, savedDir); await fs.mkdir(directory)
  await f.library.close(); assert.deepEqual(await fs.readdir(directory), []); assert.ok((await fs.readdir(savedDir)).length)
})

test('static library-child replacement is rejected before creating anything in the foreign directory', async t => {
  const f = await fixture(t), foreign = path.join(f.root, 'foreign-preview')
  await fs.mkdir(foreign); await fs.rename(f.previews, f.previews + '-old'); await fs.symlink(foreign, f.previews)
  await assert.rejects(f.library.prepare(op(), async () => f.source), /目录在操作期间变化/)
  assert.deepEqual(await fs.readdir(foreign), [])
})

test('unrelated account/session/instance files and user PNG remain byte and identity unchanged', async t => {
  const f = await fixture(t), files = ['accounts.json', 'session.json', 'instances/world/level.dat']
  const before = new Map<string, Awaited<ReturnType<typeof proof>>>()
  for (const name of files) { const file = path.join(f.root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'original inert private sentinel ' + name); before.set(file, await proof(file)) }
  before.set(f.source, await proof(f.source))
  const item = await saved(f.library, f.source); await f.library.read(item.id); await f.library.remove(item.id, item.revision, op())
  for (const [file, expected] of before) assert.deepEqual(await proof(file), expected)
})

async function sparseHistory(f: Awaited<ReturnType<typeof fixture>>, freeBytes?: number) {
  const count = 128, ids = Array.from({ length: count }, op), index = { schema: 1, sequence: count, commitId: ids.at(-1)!, records: [] }, indexBytes = encoded(index)
  let previous = sha(encoded({ schema: 1, sequence: 0, commitId: 'initial', records: [] })), controlBytes = 0
  for (let at = 0; at < count; at++) {
    const operationId = ids[at], next = at === count - 1 ? sha(indexBytes) : sha(Buffer.from('original synthetic historical index ' + at)),
      intent = encoded({ schema: 1, operationId, sequence: at + 1, previousSha256: previous, nextSha256: next }),
      complete = encoded({ schema: 1, operationId, intentSha256: sha(intent), nextSha256: next })
    await fs.writeFile(path.join(f.history, operationId + '.intent.json'), intent); await fs.writeFile(path.join(f.history, operationId + '.complete.json'), complete)
    const handle = await fs.open(path.join(f.history, operationId + '.previous.json'), 'wx'); await handle.truncate(SKIN_LIBRARY_LIMITS.indexBytes); await handle.close()
    controlBytes += intent.length + complete.length; previous = next
  }
  if (freeBytes !== undefined) await fs.truncate(path.join(f.history, ids[0] + '.previous.json'), SKIN_LIBRARY_LIMITS.indexBytes - controlBytes - freeBytes)
  await fs.writeFile(f.index, indexBytes)
}

test('all retained history bytes count toward128MiB even though old snapshot payloads are not rehashed', async t => {
  const f = await fixture(t); await sparseHistory(f)
  await assert.rejects(f.library.list(), /历史超过128MiB/)
  assert.equal((await fs.readdir(f.history)).length, 384)
})

test('predicted history growth is rejected before any new history write or index publication', async t => {
  const f = await fixture(t); await sparseHistory(f, 100)
  assert.equal((await f.library.list()).total, 0)
  const before = await proof(f.index), history = (await fs.readdir(f.history)).sort(), preview = await f.library.prepare(op(), async () => f.source); assert.ok(preview)
  await assert.rejects(f.library.save(preview.viewId, input()), /将超过128MiB/)
  assert.deepEqual(await proof(f.index), before); assert.deepEqual((await fs.readdir(f.history)).sort(), history)
  assert.equal((await f.library.list()).total, 0)
})

test('late cancellation after proven index publication completes its finite receipt instead of claiming rollback', async t => {
  let library!: SkinLibrary, saveId = ''
  const f = await fixture(t, { hooks: { afterIndexPublish: async () => { void library.cancel(saveId) } } }); library = f.library
  const preview = await library.prepare(op(), async () => f.source); assert.ok(preview); saveId = op()
  const item = await library.save(preview.viewId, { ...input(), operationId: saveId })
  assert.equal((await library.read(item.id)).item.id, item.id)
})

test('independent red regression: NFC expansion cannot publish a name or tag the reader would reject', async t => {
  const f = await fixture(t), preview = await f.library.prepare(op(), async () => f.source); assert.ok(preview)
  const name = '\u0344'.repeat(64), tag = '\u0344'.repeat(24)
  assert.equal([...name.normalize('NFC')].length, 128)
  const before = await proof(f.index)
  await assert.rejects(f.library.save(preview.viewId, { ...input(), name }), /规范化后超限/)
  await assert.rejects(f.library.save(preview.viewId, { ...input(), tags: [tag] }), /规范化后超限/)
  assert.deepEqual(await proof(f.index), before)
  const item = await f.library.save(preview.viewId, input())
  const published = await proof(f.index)
  await assert.rejects(f.library.update(item.id, item.revision, { ...input(), name }), /规范化后超限/)
  await assert.rejects(f.library.update(item.id, item.revision, { ...input(), tags: [tag] }), /规范化后超限/)
  assert.deepEqual(await proof(f.index), published); assert.equal((await f.library.list()).total, 1)
})
