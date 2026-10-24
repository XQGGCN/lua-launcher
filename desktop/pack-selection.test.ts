import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import test, { type TestContext } from 'node:test'
import { PACK_SELECTION_LIMITS, PackSelections, type PackSelectionHooks } from './pack-selection'

test('selected archive is an immutable copy, addressed only by an opaque token', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-selection-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'source.mrpack')
  await fs.writeFile(file, 'original')
  const selection = new PackSelections(root, async copy => ({ name: await fs.readFile(copy, 'utf8') }))
  await selection.init()
  const chosen = await selection.choose(file)
  assert.deepEqual(chosen.preview, { name: 'original' })
  assert.equal('path' in chosen, false)
  await fs.writeFile(file, 'replaced')
  assert.equal(await selection.use(chosen.token, copy => fs.readFile(copy, 'utf8')), 'original')
  assert.equal(await selection.use(chosen.token, copy => fs.readFile(copy, 'utf8')), 'original')
  await assert.rejects(selection.use(file, copy => fs.readFile(copy)), /已过期/)
  await selection.close()
})

test('failed inspection removes private copy and does not grant a handle', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-selection-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'bad.mrpack')
  await fs.writeFile(file, 'not a zip')
  const selection = new PackSelections(root, async () => { throw new Error('清单损坏') })
  await selection.init()
  await assert.rejects(selection.choose(file), /清单损坏/)
  const [session] = await fs.readdir(path.join(root, 'import-cache'))
  assert.deepEqual(await fs.readdir(path.join(root, 'import-cache', session)), [])
})

test('expired selections are removed and cannot be imported', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-selection-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'source.mrpack')
  await fs.writeFile(file, 'archive')
  let now = 0
  const selection = new PackSelections(root, async () => ({}), () => now)
  await selection.init()
  const chosen = await selection.choose(file)
  now = 3_600_001
  await assert.rejects(selection.use(chosen.token, async () => true), /已过期/)
  await selection.close()
})

test('rejects directories and oversized archives before inspection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-selection-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let inspections = 0
  const selection = new PackSelections(root, async () => { inspections++; return {} })
  await selection.init()
  await assert.rejects(selection.choose(root))
  const file = path.join(root, 'huge.mrpack')
  const handle = await fs.open(file, 'w')
  await handle.truncate(256 * 1024 * 1024 + 1)
  await handle.close()
  await assert.rejects(selection.choose(file), /256 MB/)
  assert.equal(inspections, 0)
})

test('duplicate import is blocked and expiry cannot remove an active import', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-selection-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'source.mrpack')
  await fs.writeFile(file, 'archive')
  let now = 0
  const selection = new PackSelections(root, async () => ({}), () => now)
  await selection.init()
  const chosen = await selection.choose(file)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const running = selection.use(chosen.token, async copy => {
    await gate
    return fs.readFile(copy, 'utf8')
  })
  await assert.rejects(selection.use(chosen.token, async () => true), /正在导入/)
  now = 3_600_001
  await assert.rejects(selection.use(chosen.token, async () => true), /已过期/)
  release()
  assert.equal(await running, 'archive')
  await selection.close()
})

test('new selections evict abandoned previews without interrupting an active import', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-selection-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'source.mrpack')
  await fs.writeFile(file, 'archive')
  const selection = new PackSelections(root, async () => ({}))
  await selection.init()
  const active = await selection.choose(file)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const running = selection.use(active.token, async copy => {
    await gate
    return fs.readFile(copy, 'utf8')
  })
  const abandoned = await selection.choose(file)
  for (let i = 0; i < 7; i++) await selection.choose(file)
  await assert.rejects(selection.use(abandoned.token, async () => true), /已过期/)
  release()
  assert.equal(await running, 'archive')
  const [session] = await fs.readdir(path.join(root, 'import-cache'))
  assert.equal((await fs.readdir(path.join(root, 'import-cache', session))).length, 8)
  await selection.close()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(t: TestContext, hooks: PackSelectionHooks = {}, inspect?: (file: string) => Promise<unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-selection-proof-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'original.mrpack'), bytes = Buffer.from('an original inert archive fixture\n'.repeat(97))
  await fs.writeFile(source, bytes)
  const selection = new PackSelections(root, inspect ?? (async file => ({ bytes: (await fs.stat(file)).size })), Date.now, hooks)
  await selection.init()
  return { root, source, bytes, selection }
}
async function cacheFiles(root: string): Promise<string[]> {
  const base = path.join(root, 'import-cache'), files: string[] = []
  for (const session of await fs.readdir(base)) {
    const directory = path.join(base, session)
    if (!(await fs.lstat(directory)).isDirectory()) continue
    for (const name of await fs.readdir(directory)) files.push(path.join(directory, name))
  }
  return files
}
const hashes = (bytes: Uint8Array) => ({ bytes: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('hex') })
async function sourceProof(file: string) {
  const stat = await fs.lstat(file, { bigint: true })
  return { bytes: await fs.readFile(file), node: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].map(String) }
}

test('local and verified online registration bind the same exact archive hashes without exposing paths', async t => {
  const { root, source, bytes, selection } = await fixture(t)
  const baseline = await sourceProof(source), expected = hashes(bytes)
  const local = await selection.choose(source)
  const online = await selection.registerVerified(source, { archiveBytes: expected.bytes, sha1: expected.sha1, sha512: expected.sha512 })
  assert.deepEqual(local.archive, expected); assert.deepEqual(online.archive, expected)
  assert.deepEqual(Object.keys(local).sort(), ['archive', 'preview', 'token'])
  assert.notEqual(local.token, online.token)
  local.archive.sha512 = 'bad external mutation'
  assert.deepEqual(await selection.verify(local.token), expected)
  const seen = await selection.use(online.token, async (file, archive, signal) => {
    assert.equal(signal.aborted, false); assert.equal(file.startsWith(path.join(root, 'import-cache')), true)
    assert.deepEqual(await fs.readFile(file), bytes)
    archive.sha1 = 'bad callback mutation'
    return true
  })
  assert.equal(seen, true); assert.deepEqual(await selection.verify(online.token), expected)
  assert.deepEqual(await sourceProof(source), baseline)
  await selection.close()
  assert.equal((await fs.readdir(path.join(root, 'import-cache'))).length, 0)
})

test('verified registration rejects size, SHA1, SHA512 and malformed declarations before granting a token', async t => {
  let inspections = 0
  const { root, source, bytes, selection } = await fixture(t, {}, async () => { inspections++; return {} })
  const expected = hashes(bytes)
  for (const value of [
    { archiveBytes: expected.bytes + 1, sha1: expected.sha1, sha512: expected.sha512 },
    { archiveBytes: expected.bytes, sha1: '0'.repeat(40), sha512: expected.sha512 },
    { archiveBytes: expected.bytes, sha1: expected.sha1, sha512: '0'.repeat(128) },
    { archiveBytes: 0, sha1: expected.sha1, sha512: expected.sha512 },
    { archiveBytes: expected.bytes, sha1: 'invalid', sha512: expected.sha512 },
  ]) await assert.rejects(selection.registerVerified(source, value), /大小或双摘要/)
  assert.equal(inspections, 0); assert.deepEqual(await cacheFiles(root), [])
  assert.deepEqual(await fs.readFile(source), bytes)
  await selection.close()
})

test('short writes are completed and independent disk hashes match the entire original', async t => {
  let writes = 0
  const { source, bytes, selection } = await fixture(t, { write: async (handle, buffer, offset, length, position) => {
    writes++; return (await handle.write(buffer, offset, Math.min(length, 19), position)).bytesWritten
  } })
  const before = await sourceProof(source), result = await selection.choose(source)
  assert.ok(writes > 1); assert.deepEqual(result.archive, hashes(bytes))
  assert.deepEqual(await selection.use(result.token, file => fs.readFile(file)), bytes)
  assert.deepEqual(await sourceProof(source), before)
  await selection.close()
})

test('zero, oversized, NaN and fractional write acknowledgements do not grant a token', async t => {
  for (const returned of [0, Number.NaN, 0.5, PACK_SELECTION_LIMITS.bufferBytes + 1]) {
    const { source, bytes, selection } = await fixture(t, { write: async () => returned })
    await assert.rejects(selection.choose(source), /写入不完整/)
    assert.deepEqual(await fs.readFile(source), bytes)
    await selection.close()
  }
})

test('disk-full copy failure preserves source and cleans only acknowledged private bytes', async t => {
  let writes = 0
  const { root, source, bytes, selection } = await fixture(t, { write: async (handle, buffer, offset, length, position) => {
    if (writes++) throw Object.assign(new Error('original injected disk full'), { code: 'ENOSPC' })
    return (await handle.write(buffer, offset, Math.min(111, length), position)).bytesWritten
  } })
  const baseline = await sourceProof(source)
  await assert.rejects(selection.choose(source), /disk full/)
  assert.deepEqual(await sourceProof(source), baseline); assert.deepEqual(await fs.readFile(source), bytes)
  assert.deepEqual(await cacheFiles(root), [])
  await selection.close()
})

test('lost write acknowledgement retains the uncertain private file and never deletes source', async t => {
  const { root, source, bytes, selection } = await fixture(t, { write: async (handle, buffer, offset, length, position) => {
    await handle.write(buffer, offset, Math.min(101, length), position)
    throw new Error('injected write ACK lost')
  } })
  await assert.rejects(selection.choose(source), /ACK lost/)
  const files = await cacheFiles(root); assert.equal(files.length, 1)
  assert.equal((await fs.stat(files[0])).size, 101)
  await selection.close()
  assert.equal((await fs.stat(files[0])).size, 101); assert.deepEqual(await fs.readFile(source), bytes)
})

test('source replacement during copy cannot redirect the cache or grant a handle', async t => {
  let changed = false
  const { root, source, selection } = await fixture(t, { afterCopyChunk: async ({ source }) => {
    if (!changed) { changed = true; await fs.rename(source, source + '.saved'); await fs.writeFile(source, 'a new unrelated source') }
  } })
  const original = await fs.readFile(source)
  await assert.rejects(selection.choose(source), /变化/)
  assert.deepEqual(await fs.readFile(source + '.saved'), original)
  assert.equal(await fs.readFile(source, 'utf8'), 'a new unrelated source')
  assert.deepEqual(await cacheFiles(root), [])
  await selection.close()
})

test('same-size source modification during copy is rejected by identity and second hash proof', async t => {
  let changed = false
  const { source, bytes, selection } = await fixture(t, { afterCopyChunk: async ({ source }) => {
    if (!changed) { changed = true; await fs.writeFile(source, Buffer.alloc(bytes.length, 0x7a)) }
  } })
  await assert.rejects(selection.choose(source), /变化/)
  assert.deepEqual(await fs.readFile(source), Buffer.alloc(bytes.length, 0x7a))
  await selection.close()
})

test('source and source-ancestor static symlinks are rejected without reading or deleting targets', async t => {
  const { root, source, bytes, selection } = await fixture(t)
  const linked = path.join(root, 'linked.mrpack'), folder = path.join(root, 'real'), alias = path.join(root, 'alias')
  await fs.symlink(source, linked); await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'file.mrpack'), bytes); await fs.symlink(folder, alias)
  await assert.rejects(selection.choose(linked), /普通整合包文件|链接/)
  await assert.rejects(selection.choose(path.join(alias, 'file.mrpack')), /祖先含链接/)
  assert.deepEqual(await fs.readFile(source), bytes); assert.deepEqual(await fs.readFile(path.join(folder, 'file.mrpack')), bytes)
  await selection.close()
})

test('a source ancestor exchanged while copying is rejected and both foreign and original files remain', async t => {
  let switched = false
  const { root, bytes, selection } = await fixture(t, { afterCopyChunk: async ({ source }) => {
    if (!switched) {
      switched = true; const parent = path.dirname(source)
      await fs.rename(parent, parent + '-saved'); await fs.mkdir(parent); await fs.writeFile(source, bytes)
    }
  } })
  const folder = path.join(root, 'source-parent'); await fs.mkdir(folder)
  const file = path.join(folder, 'source.mrpack'); await fs.writeFile(file, bytes)
  await assert.rejects(selection.choose(file), /变化/)
  assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await fs.readFile(path.join(folder + '-saved', 'source.mrpack')), bytes)
  await selection.close()
})

test('source growth and truncation observed during copy are rejected', async t => {
  for (const mode of ['grow', 'truncate']) {
    let changed = false
    const { source, selection } = await fixture(t, { afterCopyChunk: async ({ source }) => {
      if (!changed) { changed = true; if (mode === 'grow') await fs.appendFile(source, 'extra'); else await fs.truncate(source, 1) }
    } })
    await assert.rejects(selection.choose(source), /变化|未完整/)
    assert.equal((await fs.stat(source)).size > 0, true)
    await selection.close()
  }
})

test('cancel during real copying grants no token and waits for the copy hook to settle', async t => {
  const entered = deferred(), release = deferred(), controller = new AbortController()
  const { root, source, bytes, selection } = await fixture(t, { afterCopyChunk: async () => { entered.resolve(); await release.promise } })
  let settled = false
  const running = selection.choose(source, { signal: controller.signal }).finally(() => { settled = true })
  const rejection = assert.rejects(running, error => (error as Error).name === 'AbortError')
  await entered.promise; controller.abort(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false); assert.equal((await cacheFiles(root)).length, 1)
  release.resolve(); await rejection
  assert.deepEqual(await cacheFiles(root), []); assert.deepEqual(await fs.readFile(source), bytes)
  await selection.close()
})

test('cancel during inspector waits actual inspection and cannot expose a late selection', async t => {
  const entered = deferred(), release = deferred(), controller = new AbortController()
  const { root, source, selection } = await fixture(t, {}, async () => { entered.resolve(); await release.promise; return {} })
  let settled = false
  const running = selection.choose(source, { signal: controller.signal }).finally(() => { settled = true })
  const rejection = assert.rejects(running, error => (error as Error).name === 'AbortError')
  await entered.promise; controller.abort(); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false)
  release.resolve(); await rejection
  assert.deepEqual(await cacheFiles(root), [])
  await selection.close()
})

test('a pre-aborted selection performs no inspection or private copy and releases the preparation slot', async t => {
  let reads = 0
  const { root, source, selection } = await fixture(t, {}, async () => { reads++; return {} })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(selection.choose(source, { signal: controller.signal }), error => (error as Error).name === 'AbortError')
  assert.equal(reads, 0); assert.deepEqual(await cacheFiles(root), [])
  assert.ok((await selection.choose(source)).token)
  await selection.close()
})

test('private copy tampering during inspection is rejected and uncertain modified bytes are retained', async t => {
  let cached = ''
  const { source, bytes, selection } = await fixture(t, {}, async copy => { cached = copy; await fs.writeFile(copy, Buffer.alloc(bytes.length, 0x78)); return {} })
  await assert.rejects(selection.choose(source), /身份或摘要变化/)
  assert.deepEqual(await fs.readFile(cached), Buffer.alloc(bytes.length, 0x78))
  await selection.close()
  assert.deepEqual(await fs.readFile(cached), Buffer.alloc(bytes.length, 0x78)); assert.deepEqual(await fs.readFile(source), bytes)
})

test('fresh use rejects same-size cache changes before invoking installation work', async t => {
  let cached = '', used = false
  const { source, bytes, selection } = await fixture(t, {}, async copy => { cached = copy; return {} })
  const chosen = await selection.choose(source); await fs.writeFile(cached, Buffer.alloc(bytes.length, 0x61))
  await assert.rejects(selection.use(chosen.token, async () => { used = true; return true }), /身份或摘要变化/)
  await assert.rejects(selection.verify(chosen.token), /已过期或私有副本变化/)
  assert.equal(used, false)
  await selection.close(); assert.deepEqual(await fs.readFile(cached), Buffer.alloc(bytes.length, 0x61))
})

test('cache replacement by a symlink is rejected and close never deletes the foreign target or link', async t => {
  let cached = ''
  const { root, source, selection } = await fixture(t, {}, async copy => { cached = copy; return {} })
  const chosen = await selection.choose(source), foreign = path.join(root, 'foreign.mrpack')
  await fs.writeFile(foreign, 'foreign private-looking content'); await fs.unlink(cached); await fs.symlink(foreign, cached)
  await assert.rejects(selection.verify(chosen.token), /普通整合包文件|链接/)
  await selection.close()
  assert.equal((await fs.lstat(cached)).isSymbolicLink(), true); assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign private-looking content')
})

test('same-byte cache inode replacement is rejected and the foreign replacement survives expiry cleanup', async t => {
  let cached = '', now = 0
  const { root, source, bytes, selection: initial } = await fixture(t)
  await initial.close()
  const selection = new PackSelections(root, async copy => { cached = copy; return {} }, () => now)
  await selection.init(); const chosen = await selection.choose(source)
  await fs.rename(cached, cached + '.saved'); await fs.writeFile(cached, bytes)
  now = PACK_SELECTION_LIMITS.lifetimeMs + 1
  await assert.rejects(selection.verify(chosen.token), /已过期/)
  assert.deepEqual(await fs.readFile(cached), bytes)
  await selection.close(); assert.deepEqual(await fs.readFile(cached), bytes)
})

test('cache ancestor exchange is rejected and close does not recursively delete either directory', async t => {
  let cached = ''
  const { source, bytes, selection } = await fixture(t, {}, async copy => { cached = copy; return {} })
  const chosen = await selection.choose(source), directory = path.dirname(cached), saved = directory + '-saved'
  await fs.rename(directory, saved); await fs.mkdir(directory); await fs.writeFile(cached, bytes)
  await assert.rejects(selection.verify(chosen.token), /祖先在操作期间变化/)
  await selection.close()
  assert.deepEqual(await fs.readFile(cached), bytes); assert.deepEqual(await fs.readFile(path.join(saved, path.basename(cached))), bytes)
})

test('close preserves extra private-directory entries and unknown hard links instead of recursive cleanup', async t => {
  let cached = ''
  const { root, source, bytes, selection } = await fixture(t, {}, async copy => { cached = copy; return {} })
  await selection.choose(source)
  const foreign = path.join(path.dirname(cached), 'foreign.txt'), alias = path.join(root, 'outside-cache.mrpack')
  await fs.writeFile(foreign, 'foreign'); await fs.link(cached, alias)
  await selection.close()
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign'); assert.deepEqual(await fs.readFile(alias), bytes); assert.deepEqual(await fs.readFile(cached), bytes)
})

test('close aborts preparing workers, waits actual inspection, and denies new work immediately', async t => {
  const entered = deferred(), release = deferred()
  const { root, source, selection } = await fixture(t, {}, async () => { entered.resolve(); await release.promise; return {} })
  const running = selection.choose(source), rejection = assert.rejects(running, error => (error as Error).name === 'AbortError')
  await entered.promise
  let closed = false; const close = selection.close().then(() => { closed = true })
  await assert.rejects(selection.choose(source), /已经关闭/)
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false)
  release.resolve(); await rejection; await close
  assert.equal(closed, true); assert.equal((await fs.readdir(path.join(root, 'import-cache'))).length, 0)
  await assert.rejects(selection.init(), /已经关闭/)
})

test('close waits an active private callback even when it does not react to the cancellation signal', async t => {
  const entered = deferred(), release = deferred()
  const { source, bytes, selection } = await fixture(t)
  const chosen = await selection.choose(source)
  let callbackSignal: AbortSignal | undefined
  const running = selection.use(chosen.token, async (copy, _archive, signal) => {
    callbackSignal = signal; entered.resolve(); await release.promise
    assert.deepEqual(await fs.readFile(copy), bytes); return 'actual worker settled'
  })
  await entered.promise
  let closed = false; const close = selection.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(callbackSignal?.aborted, true)
  release.resolve(); assert.equal(await running, 'actual worker settled'); await close; assert.equal(closed, true)
})

test('capacity counts concurrent pending preparations and does not silently delete an active copy', async t => {
  const entered = deferred(), release = deferred(); let reached = 0
  const { root, source, selection } = await fixture(t, {}, async () => { if (++reached === 8) entered.resolve(); await release.promise; return {} })
  const pending = Array.from({ length: 8 }, () => selection.choose(source))
  await entered.promise
  await assert.rejects(selection.choose(source), /正在准备的整合包过多/)
  assert.equal((await cacheFiles(root)).length, 8)
  release.resolve(); const chosen = await Promise.all(pending)
  assert.equal(new Set(chosen.map(value => value.token)).size, 8)
  await selection.close()
})

test('init never age-sweeps an unowned old session or follows an unsafe cache-root link', async t => {
  const { root, source, selection } = await fixture(t)
  await selection.close()
  const history = path.join(root, 'import-cache', 'session-ABC123'); await fs.mkdir(history); await fs.writeFile(path.join(history, 'keep.mrpack'), 'keep history')
  const old = new Date(0); await fs.utimes(history, old, old)
  const second = new PackSelections(root, async () => ({})); await second.init(); await second.close()
  assert.equal(await fs.readFile(path.join(history, 'keep.mrpack'), 'utf8'), 'keep history')
  const unsafeRoot = path.join(root, 'another-root'), foreign = path.join(root, 'unrelated')
  await fs.mkdir(unsafeRoot); await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'keep'), 'foreign')
  await fs.symlink(foreign, path.join(unsafeRoot, 'import-cache'))
  const unsafe = new PackSelections(unsafeRoot, async () => ({}))
  await assert.rejects(unsafe.init(), /祖先含链接/)
  await unsafe.close(); assert.equal(await fs.readFile(path.join(foreign, 'keep'), 'utf8'), 'foreign')
  assert.ok(await fs.stat(source))
})

test('path and empty-archive rejection do not create outside-root copies or grant selections', async t => {
  const { root, source, selection } = await fixture(t)
  await assert.rejects(selection.choose('relative.mrpack'), /路径无效/)
  await assert.rejects(selection.choose('/'), /路径无效/)
  const empty = path.join(root, 'empty.mrpack'); await fs.writeFile(empty, '')
  await assert.rejects(selection.choose(empty), /普通整合包文件/)
  assert.deepEqual(await cacheFiles(root), []); assert.ok(await fs.stat(source))
  await selection.close()
})

test('a real multi-chunk copy cancellation stops after a partial acknowledged payload and leaves source unchanged', async t => {
  const controller = new AbortController(), chunks: number[] = []
  const { root, source, selection } = await fixture(t, { afterCopyChunk: async ({ bytes }) => { chunks.push(bytes); controller.abort() } })
  const bytes = Buffer.alloc(PACK_SELECTION_LIMITS.bufferBytes * 3 + 71, 0x71)
  await fs.writeFile(source, bytes); const before = await sourceProof(source)
  await assert.rejects(selection.choose(source, { signal: controller.signal }), error => (error as Error).name === 'AbortError')
  assert.deepEqual(chunks, [PACK_SELECTION_LIMITS.bufferBytes])
  assert.deepEqual(await sourceProof(source), before); assert.deepEqual(await cacheFiles(root), [])
  await selection.close()
})

test('independent disk readback rejects copy bytes changed before inspection and retains uncertain data', async t => {
  let copied = '', reads = 0, changed = false
  const { source, bytes, selection } = await fixture(t, { afterCopyChunk: async ({ copy }) => {
    if (!changed) { changed = true; copied = copy; await fs.writeFile(copy, Buffer.alloc(bytes.length, 0x79)) }
  } }, async () => { reads++; return {} })
  await assert.rejects(selection.choose(source), /磁盘读回不符/)
  assert.equal(reads, 0); assert.deepEqual(await fs.readFile(source), bytes)
  await selection.close(); assert.deepEqual(await fs.readFile(copied), Buffer.alloc(bytes.length, 0x79))
})

test('cache file returned to private main callback cannot be selected again and accidentally evicted as source', async t => {
  let cached = ''
  const { source, bytes, selection } = await fixture(t, {}, async copy => { cached = copy; return {} })
  const chosen = await selection.choose(source)
  await assert.rejects(selection.choose(cached), /不能将当前私有缓存/)
  assert.deepEqual(await selection.use(chosen.token, file => fs.readFile(file)), bytes)
  await selection.close()
})

test('a fresh cancellation before use never enters the private work callback and does not invalidate the cache', async t => {
  const { source, bytes, selection } = await fixture(t), chosen = await selection.choose(source), controller = new AbortController()
  let used = false; controller.abort()
  await assert.rejects(selection.use(chosen.token, async () => { used = true; return true }, { signal: controller.signal }), error => (error as Error).name === 'AbortError')
  assert.equal(used, false); assert.deepEqual(await selection.verify(chosen.token), hashes(bytes))
  await selection.close()
})
