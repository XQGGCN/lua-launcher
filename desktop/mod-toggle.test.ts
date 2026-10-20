import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { Dir, Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  prepareModToggle, commitModToggle, inspectModToggleRecovery, assertNoDisabledModPartners,
  ModToggleRecoveryError, ModToggleBusyError, MOD_TOGGLE_LIMITS,
  type ModTogglePrepared, type ModToggleSelection,
} from './mod-toggle'

const bytes = Buffer.from('opaque local mod fixture; never execute or open as archive')
const id = (name: string) => 'mods:' + createHash('sha256').update(name).digest('hex')
const ioError = () => Object.assign(new Error('injected EIO'), { code: 'EIO' })
const isAbort = (value: unknown) => value instanceof Error && value.name === 'AbortError'
const mutableFs = createRequire(import.meta.url)('node:fs/promises') as typeof fs
function hook<K extends keyof typeof fs>(t: TestContext, name: K, fn: typeof fs[K]) {
  const mocked = t.mock.method(mutableFs, name, fn as never)
  syncBuiltinESMExports()
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports() }
  t.after(restore)
  return restore
}
async function fixture(t: TestContext, name = 'Example.jar') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-mod-toggle-'))
  const mods = path.join(root, 'game', 'mods')
  await fs.mkdir(mods, { recursive: true })
  const source = path.join(mods, name)
  await fs.writeFile(source, bytes, { mode: 0o640 })
  t.after(() => fs.rm(root, { force: true, recursive: true }))
  const selection = async (current = name): Promise<ModToggleSelection> => {
    const info = await fs.stat(path.join(mods, current))
    return { itemId: id(current), name: current, sizeBytes: info.size, modifiedAt: new Date(info.mtimeMs).toISOString() }
  }
  const prepared = async (enabled = false, current = name) => prepareModToggle(root, await selection(current), enabled)
  const markers = async () => (await fs.readdir(root)).filter(value => value.startsWith('.mod-toggle-'))
  return { root, mods, source, selection, prepared, markers }
}
async function journal(root: string, prepared: ModTogglePrepared) {
  const operationId = randomUUID()
  const stage = path.join(root, '.mod-toggle-' + operationId)
  await fs.mkdir(stage)
  const file = path.join(stage, 'intent.json')
  await fs.writeFile(file, JSON.stringify({ schema: 1, operationId, createdAt: new Date().toISOString(), prepared }))
  return { stage, file }
}

test('disable/restore changes only exact filename, retaining inode, bytes, permissions and historical registry', async t => {
  const f = await fixture(t)
  const registryFile = path.join(f.root, 'managed-mods.json')
  const registry = '{ "legacyModrinthId":{"versionId":"v1","filename":"Example.jar"} }\n'
  await fs.writeFile(registryFile, registry)
  const before = await fs.stat(f.source)
  const first = await commitModToggle(f.root, await f.prepared())
  assert.deepEqual(first, { fromName: 'Example.jar', toName: 'Example.jar.disabled', enabled: false,
    oldItemId: id('Example.jar'), newItemId: id('Example.jar.disabled'), warnings: [] })
  await assert.rejects(fs.access(f.source), { code: 'ENOENT' })
  const disabled = path.join(f.mods, first.toName)
  assert.deepEqual(await fs.readFile(disabled), bytes)
  assert.equal((await fs.stat(disabled)).ino, before.ino)
  if (process.platform !== 'win32') assert.equal((await fs.stat(disabled)).mode, before.mode)
  const second = await commitModToggle(f.root, await f.prepared(true, first.toName))
  assert.equal(second.enabled, true)
  assert.equal(second.toName, 'Example.jar')
  assert.deepEqual(await fs.readFile(f.source), bytes)
  assert.equal((await fs.stat(f.source)).ino, before.ino)
  assert.equal(await fs.readFile(registryFile, 'utf8'), registry)
  assert.deepEqual(await f.markers(), [])
})

test('preparation without recovery performs no writes and accepts unknown-source local files', async t => {
  const f = await fixture(t)
  const selected = await f.selection()
  const forbidden = () => { throw new Error('prepare must not write') }
  for (const method of ['mkdir', 'writeFile', 'rename', 'link', 'unlink', 'rmdir'] as const) hook(t, method, forbidden as never)
  const originalOpen = fs.open
  hook(t, 'open', async (file, flags, mode) => {
    assert.notEqual(String(file), f.source, 'preparation must not open/parse the mod')
    assert.ok(flags === 'r' || typeof flags === 'number', 'no writable opens')
    return originalOpen(file, flags, mode)
  })
  const proof = await prepareModToggle(f.root, selected, false)
  assert.equal(proof.sourceIdentity.size, String(bytes.length))
  assert.equal(proof.instanceDirectory, path.resolve(f.root))
  assert.deepEqual(await fs.readdir(f.mods), ['Example.jar'])
})

test('selection metadata is checked, and IDs cannot be used as paths or stale file revisions', async t => {
  const f = await fixture(t), selected = await f.selection()
  for (const bad of [
    { ...selected, itemId: '../other' }, { ...selected, sizeBytes: selected.sizeBytes + 1 },
    { ...selected, modifiedAt: '2000-01-01T00:00:00.000Z' },
    { ...selected, name: '../outside.jar', itemId: id('../outside.jar') },
    { ...selected, path: f.source },
  ]) await assert.rejects(prepareModToggle(f.root, bad, false))
  await assert.rejects(prepareModToggle(f.root, selected, 'no' as unknown as boolean))
  assert.deepEqual(await f.markers(), [])
  assert.deepEqual(await fs.readFile(f.source), bytes)
})

test('only canonical lower-case suffixes and safe derived target lengths are actionable', async t => {
  const f = await fixture(t), selected = await f.selection()
  for (const name of ['UPPER.JAR', 'mod.jar.DISABLED', 'mod.jar.disabled.disabled', 'mod.zip',
    'NUL.jar', 'a:ads.jar', 'a\\b.jar', 'a\u202eb.jar', 'a'.repeat(247) + '.jar']) {
    await assert.rejects(prepareModToggle(f.root, { ...selected, name, itemId: id(name) }, name.includes('disabled') || name.includes('DISABLED')))
  }
  await assert.rejects(prepareModToggle(f.root, selected, true), /后缀/)
  assert.deepEqual(await f.markers(), [])
})

test('existing active/disabled pair, even identical hardlinks, is never merged or overwritten', async t => {
  for (const mode of ['different', 'same-bytes', 'hardlink']) {
    const f = await fixture(t)
    const destination = f.source + '.disabled'
    if (mode === 'hardlink') await fs.link(f.source, destination)
    else await fs.writeFile(destination, mode === 'same-bytes' ? bytes : 'other')
    await assert.rejects(f.prepared(), /同时存在|冲突/)
    assert.deepEqual(await fs.readFile(f.source), bytes)
    assert.deepEqual(await fs.readdir(f.mods), ['Example.jar', 'Example.jar.disabled'])
    assert.deepEqual(await f.markers(), [])
  }
})

test('case and NFC collisions are refused on the source or disabled partner', async t => {
  for (const mode of ['case-source', 'case-target', 'nfc-target']) {
    const f = await fixture(t, mode === 'nfc-target' ? 'café.jar' : 'Example.jar')
    const selected = await f.selection()
    if (mode === 'case-source') {
      await fs.rename(f.source, path.join(f.mods, 'example.jar'))
      await assert.rejects(prepareModToggle(f.root, selected, false), /冲突|变化|消失/)
    } else {
      await fs.writeFile(path.join(f.mods, mode === 'case-target' ? 'example.JAR.DISABLED' : 'cafe\u0301.jar.disabled'), bytes)
      await assert.rejects(prepareModToggle(f.root, selected, false), /冲突|同时存在/)
    }
    assert.deepEqual(await f.markers(), [])
  }
})

test('prepared proofs bind exact instance and source identity; same-size replacements or edits are stale', async t => {
  for (const mode of ['replace', 'edit', 'other-instance', 'forged-target']) {
    const f = await fixture(t), proof = await f.prepared()
    if (mode === 'replace') {
      await fs.rename(f.source, path.join(f.mods, 'moved-away.jar'))
      await fs.writeFile(f.source, bytes)
    } else if (mode === 'edit') {
      await fs.writeFile(f.source, Buffer.alloc(bytes.length, 0x61))
      const now = new Date(Date.now() + 1000)
      await fs.utimes(f.source, now, now)
    }
    const root = mode === 'other-instance' ? (await fixture(t)).root : f.root
    const input = mode === 'forged-target' ? { ...proof, toName: '../target.jar' } : proof
    await assert.rejects(commitModToggle(root, input), /变化|不属于|不一致/)
    assert.deepEqual(await f.markers(), [])
    await assert.rejects(fs.access(f.source + '.disabled'), { code: 'ENOENT' })
  }
})

test('symlink/junction roots, ancestors, source and target cannot redirect operations', async t => {
  const f = await fixture(t), outside = await fixture(t)
  const alias = path.join(f.root, 'alias')
  await fs.symlink(outside.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspectModToggleRecovery(alias), /链接|junction/)
  const selected = await f.selection()
  await fs.unlink(f.source)
  await fs.symlink(outside.source, f.source, 'file')
  await assert.rejects(prepareModToggle(f.root, selected, false), /普通文件|链接/)
  await fs.unlink(f.source); await fs.writeFile(f.source, bytes)
  const proof = await f.prepared()
  await fs.symlink(outside.source, f.source + '.disabled', 'file')
  await assert.rejects(commitModToggle(f.root, proof), /冲突|同时存在/)
  assert.deepEqual(await fs.readFile(outside.source), bytes)
  assert.deepEqual(await f.markers(), [])
})

test('missing directories produce harmless recovery/partner checks without creating anything', async t => {
  const f = await fixture(t)
  const missing = path.join(f.root, 'missing', 'instance')
  assert.deepEqual(await inspectModToggleRecovery(missing), { blocked: false, warnings: [] })
  await assertNoDisabledModPartners(missing, ['one.jar', 'OTHER.JAR'])
  await assert.rejects(fs.access(path.join(f.root, 'missing')), { code: 'ENOENT' })
  const fresh = path.join(f.root, 'bare-instance')
  await fs.mkdir(fresh)
  assert.deepEqual(await inspectModToggleRecovery(fresh), { blocked: false, warnings: [] })
  await assertNoDisabledModPartners(fresh, ['one.jar'])
  assert.deepEqual(await fs.readdir(fresh), [])
})

test('read-only partner guard checks uppercase suffixes, NFC, historical filenames and dependencies', async t => {
  const f = await fixture(t)
  await assertNoDisabledModPartners(f.root, ['Example.jar', 'UPPER.JAR'])
  for (const [existing, plan] of [
    ['UPPER.JAR.DISABLED', ['UPPER.JAR']], ['cafe\u0301.jar.disabled', ['café.jar']],
    ['old-name.jar.disabled', ['new-name.jar', 'old-name.jar']],
    ['dependency.jar.disabled', ['requested.jar', 'dependency.jar']],
  ] as Array<[string, string[]]>) {
    const file = path.join(f.mods, existing)
    await fs.writeFile(file, bytes)
    await assert.rejects(assertNoDisabledModPartners(f.root, plan), /禁用副本/)
    assert.deepEqual(await fs.readFile(file), bytes)
    await fs.unlink(file)
  }
  await assert.rejects(assertNoDisabledModPartners(f.root, ['../outside.jar']), /文件名/)
  assert.deepEqual(await f.markers(), [])
})

test('directory enumeration limit closes the handle and refuses a partial conflict check', async t => {
  const f = await fixture(t), original = fs.opendir
  let reads = 0, closed = 0
  hook(t, 'opendir', async (directory, options) => {
    if (String(directory) !== f.mods) return original(directory, options)
    return { read: async () => ({ name: 'entry-' + reads++ } as Dirent), close: async () => { closed++ } } as unknown as Dir
  })
  await assert.rejects(assertNoDisabledModPartners(f.root, ['Example.jar']), /上限/)
  assert.equal(reads, MOD_TOGGLE_LIMITS.entries + 1)
  assert.equal(closed, 1)
  assert.deepEqual(await f.markers(), [])
})

test('cancellation before preparation, after mkdir and after link leaves the original name', async t => {
  const f = await fixture(t), proof = await f.prepared()
  const before = new AbortController(); before.abort()
  await assert.rejects(prepareModToggle(f.root, await f.selection(), false, { signal: before.signal }), isAbort)
  await assert.rejects(commitModToggle(f.root, proof, { signal: before.signal }), isAbort)
  const stageAbort = new AbortController(), originalMkdir = fs.mkdir
  const restore = hook(t, 'mkdir', (async (directory, options) => {
    const result = await originalMkdir(directory, options as never)
    if (path.basename(String(directory)).startsWith('.mod-toggle-')) stageAbort.abort()
    return result
  }) as typeof fs.mkdir)
  await assert.rejects(commitModToggle(f.root, proof, { signal: stageAbort.signal }), isAbort)
  restore()
  assert.deepEqual(await f.markers(), [])
  const linkedAbort = new AbortController()
  await assert.rejects(commitModToggle(f.root, proof, { signal: linkedAbort.signal, link: async (source, destination) => {
    await fs.link(source, destination); linkedAbort.abort()
  } }), isAbort)
  assert.deepEqual(await fs.readFile(f.source), bytes)
  await assert.rejects(fs.access(f.source + '.disabled'), { code: 'ENOENT' })
  assert.deepEqual(await f.markers(), [])
})

test('successful unlink is final: late cancellation cannot reverse the requested operation', async t => {
  const f = await fixture(t), controller = new AbortController()
  const result = await commitModToggle(f.root, await f.prepared(), { signal: controller.signal, unlink: async file => {
    await fs.unlink(file)
    controller.abort()
  } })
  assert.equal(result.enabled, false)
  await assert.rejects(fs.access(f.source), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(f.source + '.disabled'), bytes)
  assert.deepEqual(await f.markers(), [])
})

test('link failure and source unlink failure preserve source and allow a later fresh operation', async t => {
  for (const phase of ['link', 'unlink']) {
    const f = await fixture(t), proof = await f.prepared()
    await assert.rejects(commitModToggle(f.root, proof, {
      ...(phase === 'link' ? { link: async () => { throw ioError() } } : {}),
      unlink: async file => { if (String(file) === f.source) throw ioError(); await fs.unlink(file) },
    }), /injected EIO/)
    assert.deepEqual(await fs.readFile(f.source), bytes)
    await assert.rejects(fs.access(f.source + '.disabled'), { code: 'ENOENT' })
    assert.deepEqual(await f.markers(), [])
    await commitModToggle(f.root, await f.prepared())
  }
})

test('journal open failure cleans its own empty stage and never touches the mod', async t => {
  const f = await fixture(t), proof = await f.prepared(), original = fs.open
  hook(t, 'open', async (...args) => {
    if (String(args[0]).endsWith(path.sep + 'intent.json') && args[1] === 'wx') throw ioError()
    return original(...args)
  })
  await assert.rejects(commitModToggle(f.root, proof), /injected EIO/)
  assert.deepEqual(await fs.readFile(f.source), bytes)
  assert.deepEqual(await f.markers(), [])
})

test('foreign target creation during link is not overwritten or deleted and keeps recovery evidence', async t => {
  const f = await fixture(t)
  await assert.rejects(commitModToggle(f.root, await f.prepared(), { link: async (source, destination) => {
    await fs.writeFile(destination, 'foreign target')
    await fs.link(source, destination)
  } }), ModToggleRecoveryError)
  assert.equal(await fs.readFile(f.source + '.disabled', 'utf8'), 'foreign target')
  assert.deepEqual(await fs.readFile(f.source), bytes)
  assert.equal((await f.markers()).length, 1)
  assert.equal((await inspectModToggleRecovery(f.root)).blocked, true)
})

test('same-inode editing after link is retained at both names, never removed as rollback data', async t => {
  const f = await fixture(t)
  await assert.rejects(commitModToggle(f.root, await f.prepared(), { link: async (source, destination) => {
    await fs.link(source, destination)
    await fs.writeFile(destination, 'external user edit')
  } }), ModToggleRecoveryError)
  assert.equal(await fs.readFile(f.source, 'utf8'), 'external user edit')
  assert.equal(await fs.readFile(f.source + '.disabled', 'utf8'), 'external user edit')
  assert.equal((await f.markers()).length, 1)
})

test('different-inode source substitution after link is retained, and rollback cannot delete either file', async t => {
  const f = await fixture(t)
  await assert.rejects(commitModToggle(f.root, await f.prepared(), { link: async (source, destination) => {
    await fs.link(source, destination)
    await fs.unlink(source)
    await fs.writeFile(source, 'external replacement')
  } }), ModToggleRecoveryError)
  assert.equal(await fs.readFile(f.source, 'utf8'), 'external replacement')
  assert.deepEqual(await fs.readFile(f.source + '.disabled'), bytes)
  assert.equal((await inspectModToggleRecovery(f.root)).blocked, true)
})

test('rollback unlink failure retains both files and a valid journal', async t => {
  const f = await fixture(t), controller = new AbortController()
  await assert.rejects(commitModToggle(f.root, await f.prepared(), {
    signal: controller.signal,
    link: async (source, destination) => { await fs.link(source, destination); controller.abort() },
    unlink: async () => { throw ioError() },
  }), ModToggleRecoveryError)
  assert.deepEqual(await fs.readFile(f.source), bytes)
  assert.deepEqual(await fs.readFile(f.source + '.disabled'), bytes)
  const markers = await f.markers()
  assert.equal(markers.length, 1)
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, markers[0], 'intent.json'), 'utf8')).schema, 1)
})

test('tampered journal before unlink aborts, preserves the original file and retains outside edits', async t => {
  const f = await fixture(t)
  await assert.rejects(commitModToggle(f.root, await f.prepared(), { link: async (source, destination) => {
    await fs.link(source, destination)
    const marker = (await f.markers())[0]
    await fs.writeFile(path.join(f.root, marker, 'intent.json'), '{}')
  } }), ModToggleRecoveryError)
  assert.deepEqual(await fs.readFile(f.source), bytes)
  await assert.rejects(fs.access(f.source + '.disabled'), { code: 'ENOENT' })
  const markers = await f.markers()
  assert.equal(markers.length, 1)
  assert.equal(await fs.readFile(path.join(f.root, markers[0], 'intent.json'), 'utf8'), '{}')
})

test('cleanup failure after commit returns warning and restart safely recognizes destination-only completion', async t => {
  const f = await fixture(t), original = fs.unlink
  const restore = hook(t, 'unlink', async file => {
    if (path.basename(String(file)) === 'intent.json') throw ioError()
    await original(file)
  })
  const result = await commitModToggle(f.root, await f.prepared())
  assert.equal(result.warnings.length, 1)
  assert.equal((await f.markers()).length, 1)
  restore()
  const recovery = await inspectModToggleRecovery(f.root)
  assert.equal(recovery.blocked, false)
  assert.equal(recovery.warnings.length, 1)
  assert.deepEqual(await f.markers(), [])
  assert.deepEqual(await fs.readFile(f.source + '.disabled'), bytes)
})

test('restart can clean source-only and destination-only journals without changing any mod bytes', async t => {
  for (const mode of ['source', 'destination']) {
    const f = await fixture(t), proof = await f.prepared()
    await journal(f.root, proof)
    if (mode === 'destination') await fs.rename(f.source, f.source + '.disabled')
    const recovery = await inspectModToggleRecovery(f.root)
    assert.equal(recovery.blocked, false)
    assert.equal(recovery.warnings.length, 1)
    assert.deepEqual(await f.markers(), [])
    assert.deepEqual(await fs.readFile(mode === 'source' ? f.source : f.source + '.disabled'), bytes)
  }
})

test('restart keeps ambiguous dual/missing/edited/replaced files and does not erase evidence', async t => {
  for (const mode of ['dual', 'missing', 'edited', 'replacement', 'unexpected-stage-child']) {
    const f = await fixture(t), selected = await f.selection(), proof = await f.prepared(), marker = await journal(f.root, proof)
    if (mode === 'dual') await fs.link(f.source, f.source + '.disabled')
    if (mode === 'missing') await fs.unlink(f.source)
    if (mode === 'edited') await fs.writeFile(f.source, 'user change')
    if (mode === 'replacement') { await fs.rename(f.source, path.join(f.mods, 'keep.jar')); await fs.writeFile(f.source, bytes) }
    if (mode === 'unexpected-stage-child') await fs.writeFile(path.join(marker.stage, 'user-notes.txt'), 'preserve')
    const before = await fs.readdir(f.mods)
    assert.equal((await inspectModToggleRecovery(f.root)).blocked, true)
    assert.deepEqual(await fs.readdir(f.mods), before)
    await fs.access(marker.file)
    await assert.rejects(prepareModToggle(f.root, selected, false), ModToggleRecoveryError)
  }
})

test('post-commit journal edits are retained as a warning, without reversing the successful filename change', async t => {
  const f = await fixture(t)
  const result = await commitModToggle(f.root, await f.prepared(), { unlink: async file => {
    await fs.unlink(file)
    if (String(file) === f.source) {
      const marker = (await f.markers())[0]
      await fs.writeFile(path.join(f.root, marker, 'intent.json'), '{"external":"keep"}')
    }
  } })
  assert.equal(result.warnings.length, 1)
  await assert.rejects(fs.access(f.source), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(f.source + '.disabled'), bytes)
  const marker = (await f.markers())[0]
  assert.equal(await fs.readFile(path.join(f.root, marker, 'intent.json'), 'utf8'), '{"external":"keep"}')
  assert.equal((await inspectModToggleRecovery(f.root)).blocked, true)
})

test('malformed, oversized, foreign-instance and symlink journals block without following or deleting them', async t => {
  for (const mode of ['json', 'oversize', 'foreign', 'symlink', 'unsafe-name']) {
    const f = await fixture(t), proof = await f.prepared(), marker = await journal(f.root, proof)
    if (mode === 'json') await fs.writeFile(marker.file, Buffer.from([0xff]))
    if (mode === 'oversize') await fs.writeFile(marker.file, Buffer.alloc(MOD_TOGGLE_LIMITS.journalBytes + 1))
    if (mode === 'foreign') {
      const raw = JSON.parse(await fs.readFile(marker.file, 'utf8'))
      raw.prepared.instanceDirectory = path.join(f.root, 'other')
      await fs.writeFile(marker.file, JSON.stringify(raw))
    }
    if (mode === 'symlink') { await fs.unlink(marker.file); await fs.symlink(f.source, marker.file, 'file') }
    if (mode === 'unsafe-name') await fs.rename(marker.stage, path.join(f.root, '.mod-toggle-not-a-uuid'))
    assert.equal((await inspectModToggleRecovery(f.root)).blocked, true)
    assert.equal((await f.markers()).length, 1)
    assert.deepEqual(await fs.readFile(f.source), bytes)
  }
})

test('concurrent module operations report typed busy without treating the active journal as corruption', async t => {
  const f = await fixture(t), other = await fixture(t), proof = await f.prepared()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const running = commitModToggle(f.root, proof, { link: async (source, destination) => {
    entered(); await gate; await fs.link(source, destination)
  } })
  await started
  await assert.rejects(inspectModToggleRecovery(f.root), ModToggleBusyError)
  await assert.rejects(prepareModToggle(f.root, await f.selection(), false), ModToggleBusyError)
  await assertNoDisabledModPartners(other.root, ['Example.jar'])
  release()
  await running
  assert.deepEqual(await inspectModToggleRecovery(f.root), { blocked: false, warnings: [] })
})

test('an unsafe mods ancestor rejects even with no journal, while a linked recovery directory is retained', async t => {
  const f = await fixture(t), outside = await fixture(t)
  await fs.rename(f.mods, path.join(f.root, 'saved-mods'))
  await fs.symlink(outside.mods, f.mods, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspectModToggleRecovery(f.root), /链接|junction/)
  await assert.rejects(assertNoDisabledModPartners(f.root, ['Example.jar']), /链接|junction/)
  await fs.unlink(f.mods)
  await fs.rename(path.join(f.root, 'saved-mods'), f.mods)
  const linkedStage = path.join(f.root, '.mod-toggle-' + randomUUID())
  await fs.symlink(outside.root, linkedStage, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await inspectModToggleRecovery(f.root)).blocked, true)
  assert.equal((await fs.lstat(linkedStage)).isSymbolicLink(), true)
  assert.deepEqual(await fs.readFile(outside.source), bytes)
})

test('loss of unlink acknowledgement never copies back over a completed destination; restart recognizes the outcome', async t => {
  const f = await fixture(t)
  await assert.rejects(commitModToggle(f.root, await f.prepared(), { unlink: async file => {
    await fs.unlink(file)
    throw ioError()
  } }), ModToggleRecoveryError)
  await assert.rejects(fs.access(f.source), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(f.source + '.disabled'), bytes)
  assert.equal((await f.markers()).length, 1)
  assert.equal((await inspectModToggleRecovery(f.root)).blocked, false)
  assert.deepEqual(await f.markers(), [])
})

test('cancelling recovery leaves its evidence untouched; excess journals are bounded and not cleaned partially', async t => {
  const f = await fixture(t), proof = await f.prepared()
  const first = await journal(f.root, proof)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(inspectModToggleRecovery(f.root, { signal: controller.signal }), isAbort)
  await fs.access(first.file)
  for (let index = 0; index < MOD_TOGGLE_LIMITS.journals; index++) {
    await fs.mkdir(path.join(f.root, '.mod-toggle-' + randomUUID()))
  }
  const result = await inspectModToggleRecovery(f.root)
  assert.equal(result.blocked, true)
  assert.match(result.warnings[0], /上限/)
  assert.equal((await f.markers()).length, MOD_TOGGLE_LIMITS.journals + 1)
  assert.deepEqual(await fs.readFile(f.source), bytes)
})

test('unrecognized journal fields and a prepared proof for another filename cannot authorize cleanup', async t => {
  const f = await fixture(t), proof = await f.prepared(), marker = await journal(f.root, proof)
  const record = JSON.parse(await fs.readFile(marker.file, 'utf8'))
  record.prepared.toName = '../escape.jar.disabled'
  await fs.writeFile(marker.file, JSON.stringify(record))
  assert.equal((await inspectModToggleRecovery(f.root)).blocked, true)
  await fs.access(marker.file)
  record.prepared = proof
  record.unexpected = 'never accepted'
  await fs.writeFile(marker.file, JSON.stringify(record))
  assert.equal((await inspectModToggleRecovery(f.root)).blocked, true)
  await fs.access(marker.file)
  assert.deepEqual(await fs.readFile(f.source), bytes)
})
