import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { createWorldDirectoryBackup, listWorldDirectoryBackups, worldBackupDirectory, WorldBackupError, BACKUP_LIMITS } from './world-backup'
import { parseBackupManifest } from './world-backup-manifest'
import type { WorldBackupOptions } from './world-backup'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const selection = (name: string) => ({ name, itemId: `worlds:${hash(Buffer.from(name))}` })
const ioError = (code = 'EIO') => Object.assign(new Error('private injected filesystem error'), { code })
const hasCode = (code: string) => (error: unknown) => error instanceof WorldBackupError && error.code === code
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'
const mutableFs = createRequire(import.meta.url)('node:fs/promises') as typeof fs
function hook<K extends keyof typeof fs>(t: TestContext, method: K, implementation: typeof fs[K]) {
  const mock = t.mock.method(mutableFs, method, implementation as never); syncBuiltinESMExports()
  const restore = () => { mock.mock.restore(); syncBuiltinESMExports() }; t.after(restore); return restore
}
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-world-backup-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const instanceId = 'instance-a', instance = path.join(root, 'instances', instanceId)
  const world = path.join(instance, 'game', 'saves', 'Demo'), backupRoot = path.join(root, 'backups')
  await fs.mkdir(path.join(world, 'empty'), { recursive: true })
  await fs.mkdir(path.join(world, 'dimensions', 'minecraft', 'overworld', 'region'), { recursive: true })
  await fs.mkdir(path.join(world, 'players', 'data'), { recursive: true })
  const original = new Map([
    ['level.dat', Buffer.from('not valid gzip; must be copied without parsing')],
    ['level.dat_old', Buffer.from('old independent bytes')], ['session.lock', Buffer.from([0, 255, 7, 16])],
    ['.hidden', Buffer.from('private')], ['manifest.json', Buffer.from('a world file, not a backup control')],
    ['dimensions/minecraft/overworld/region/r.0.0.mca', Buffer.from([1, 2, 0, 255, 128])],
    ['players/data/player.dat', Buffer.from('player and seed privacy is local')],
  ])
  for (const [name, bytes] of original) await fs.writeFile(path.join(world, ...name.split('/')), bytes)
  const options: WorldBackupOptions = { backupRoot, instanceId, operationId: randomUUID() }
  const create = (more: Partial<WorldBackupOptions> = {}) => createWorldDirectoryBackup(instance, selection('Demo'), { ...options, ...more })
  const containers = async () => (await fs.readdir(path.join(backupRoot, instanceId)).catch(() => []))
  const container = (id: string) => path.join(backupRoot, instanceId, id)
  return { root, instance, instanceId, world, backupRoot, original, options, create, containers, container }
}

test('full directory backup includes every file and empty directory, validates manifest and can reconstruct byte-identical files', async t => {
  const f = await fixture(t), before = await fs.stat(path.join(f.world, 'level.dat'))
  const result = await f.create()
  assert.equal(result.format, 'directory'); assert.equal(result.verifiedAtCompletion, true)
  assert.equal(result.fileCount, f.original.size)
  const directory = await worldBackupDirectory(f.backupRoot, f.instanceId, result.backupId)
  const manifest = parseBackupManifest(await fs.readFile(path.join(directory, 'manifest.json')))
  const reconstructed = path.join(f.root, 'independent-reconstruction'); await fs.mkdir(reconstructed)
  for (const entry of manifest.entries) {
    const from = path.join(directory, 'world', ...entry.path.split('/')), to = path.join(reconstructed, ...entry.path.split('/'))
    if (entry.type === 'directory') { await fs.mkdir(to); continue }
    const bytes = await fs.readFile(from)
    assert.equal(bytes.length, entry.sizeBytes); assert.equal(hash(bytes), entry.sha256)
    await fs.writeFile(to, bytes)
  }
  for (const [name, bytes] of f.original) {
    assert.deepEqual(await fs.readFile(path.join(f.world, ...name.split('/'))), bytes)
    assert.deepEqual(await fs.readFile(path.join(reconstructed, ...name.split('/'))), bytes)
  }
  assert.ok((await fs.stat(path.join(reconstructed, 'empty'))).isDirectory())
  const after = await fs.stat(path.join(f.world, 'level.dat'))
  assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs); assert.equal(after.ino, before.ino)
  const listed = await listWorldDirectoryBackups(f.backupRoot, f.instanceId)
  assert.equal(listed.items.length, 1); assert.equal(listed.incompleteCount, 0)
  assert.equal(listed.items[0].backupId, result.backupId)
  assert.ok(listed.warnings.some(value => value.includes('未重新校验')))
  assert.equal(JSON.stringify(result).includes(f.root), false)
})

test('committed backup wins over cancellation and a lost link acknowledgement when identity and bytes prove success', async t => {
  const f = await fixture(t), original = fs.link, controller = new AbortController()
  hook(t, 'link', async (from, to) => { await original(from, to); controller.abort(); throw ioError() })
  const result = await f.create({ signal: controller.signal })
  assert.equal(result.verifiedAtCompletion, true)
  assert.ok(result.warnings.some(value => value.includes('提交响应异常')))
})

test('uncertain publication after link acknowledgement loss is recovery-required even when cancelled', async t => {
  const f = await fixture(t), link = fs.link, open = fs.open, controller = new AbortController()
  let published = false
  hook(t, 'link', async (from, to) => { await link(from, to); published = true; controller.abort(); throw ioError() })
  hook(t, 'open', async (file, flags, mode) => {
    if (published && path.basename(String(file)) === 'COMPLETE.json') throw ioError('EACCES')
    return open(file, flags, mode)
  })
  await assert.rejects(f.create({ signal: controller.signal }), hasCode('RECOVERY_REQUIRED'))
  const retained = await f.containers(); assert.equal(retained.length, 1)
  assert.ok(await fs.stat(path.join(f.container(retained[0]), 'COMPLETE.json')))
})

test('uncertain publication after link acknowledgement loss cannot be reported as ordinary IO failure', async t => {
  const f = await fixture(t), link = fs.link, open = fs.open
  let published = false
  hook(t, 'link', async (from, to) => { await link(from, to); published = true; throw ioError() })
  hook(t, 'open', async (file, flags, mode) => {
    if (published && path.basename(String(file)) === 'COMPLETE.json') throw ioError('EACCES')
    return open(file, flags, mode)
  })
  await assert.rejects(f.create(), hasCode('RECOVERY_REQUIRED'))
})

test('invalid selections, IDs, roots and overlapping destinations are rejected without copying', async t => {
  const f = await fixture(t)
  for (const name of ['../other', 'CON', 'a/b', 'a\\b', 'a:b', 'tail.', '\ud800']) {
    await assert.rejects(createWorldDirectoryBackup(f.instance, selection(name), f.options), hasCode('INVALID_INPUT'))
  }
  await assert.rejects(f.create({ instanceId: '../other' }), hasCode('INVALID_INPUT'))
  await assert.rejects(f.create({ operationId: '../other' }), hasCode('INVALID_INPUT'))
  await assert.rejects(f.create({ backupRoot: 'relative' }), hasCode('INVALID_INPUT'))
  await assert.rejects(f.create({ backupRoot: path.join(f.world, 'backup') }), hasCode('UNSAFE_PATH'))
  await assert.rejects(f.create({ backupRoot: f.root }), hasCode('UNSAFE_PATH'))
  assert.deepEqual(await f.containers(), [])
})

test('missing backup listings do not create directories; nonexistent completion IDs cannot be opened', async t => {
  const f = await fixture(t)
  assert.deepEqual(await listWorldDirectoryBackups(f.backupRoot, f.instanceId), { items: [], incompleteCount: 0, warnings: [], truncated: false })
  await assert.rejects(fs.access(f.backupRoot), { code: 'ENOENT' })
  await assert.rejects(worldBackupDirectory(f.backupRoot, f.instanceId, '../other'), hasCode('INVALID_INPUT'))
  await assert.rejects(worldBackupDirectory(f.backupRoot, f.instanceId, randomUUID()), WorldBackupError)
})

test('file symlinks, directory junctions, hardlinks and unsafe backup ancestors are never followed or skipped', async t => {
  const f = await fixture(t), link = path.join(f.world, 'alias.dat'), source = path.join(f.world, 'level.dat')
  await fs.symlink(source, link, 'file')
  await assert.rejects(f.create(), hasCode('UNSUPPORTED_ENTRY')); await fs.unlink(link)
  await fs.link(source, link)
  await assert.rejects(f.create(), hasCode('UNSUPPORTED_ENTRY')); await fs.unlink(link)
  await fs.symlink(path.join(f.world, 'empty'), path.join(f.world, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.create(), hasCode('UNSUPPORTED_ENTRY')); await fs.unlink(path.join(f.world, 'linked-dir'))
  await fs.mkdir(path.join(f.root, 'elsewhere'))
  await fs.symlink(path.join(f.root, 'elsewhere'), f.backupRoot, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.create(), hasCode('UNSAFE_PATH'))
  assert.deepEqual(await fs.readdir(path.join(f.root, 'elsewhere')), [])
})

test('preflight rejects logical file sizes beyond the budget and insufficient destination space', async t => {
  const f = await fixture(t), original = fs.lstat
  const restore = hook(t, 'lstat', (async (...args: Parameters<typeof fs.lstat>) => {
    const info = await original(...args)
    if (String(args[0]) === path.join(f.world, 'level.dat')) return Object.assign(Object.create(info), { size: BigInt(BACKUP_LIMITS.fileBytes) + 1n })
    return info
  }) as typeof fs.lstat)
  await assert.rejects(f.create(), hasCode('LIMIT_EXCEEDED')); restore()
  hook(t, 'statfs', (async () => ({ bavail: 0n, bsize: 4096n })) as unknown as typeof fs.statfs)
  await assert.rejects(f.create(), hasCode('INSUFFICIENT_SPACE'))
  assert.deepEqual(await f.containers(), [])
})

test('depth and enumeration budgets fail the entire backup, not a partial successful snapshot', async t => {
  const f = await fixture(t)
  let directory = path.join(f.world, 'deep')
  for (let i = 0; i <= BACKUP_LIMITS.depth; i++) { await fs.mkdir(directory, { recursive: true }); directory = path.join(directory, 'd') }
  await assert.rejects(f.create(), hasCode('LIMIT_EXCEEDED'))
  await fs.rm(path.join(f.world, 'deep'), { recursive: true })
  const original = fs.opendir
  hook(t, 'opendir', (async (file: Parameters<typeof fs.opendir>[0]) => {
    if (String(file) !== f.world) return original(file)
    let count = 0
    return { read: async () => count++ <= BACKUP_LIMITS.directoryEntries ? { name: `entry${count}` } : null, close: async () => {} } as never
  }) as typeof fs.opendir)
  await assert.rejects(f.create(), hasCode('LIMIT_EXCEEDED'))
})

test('copy handles partial reads/writes with fixed buffers and closes every opened handle', async t => {
  const f = await fixture(t), original = fs.open
  let opens = 0, closes = 0, writes = 0
  hook(t, 'open', async (file, flags, mode) => {
    const handle = await original(file, flags, mode); opens++
    const close = handle.close.bind(handle); handle.close = async () => { closes++; return close() }
    if (String(file).startsWith(f.world + path.sep) || String(file).includes(`${path.sep}world${path.sep}`)) {
      const read = handle.read.bind(handle), write = handle.write.bind(handle)
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        assert.ok(buffer.length <= BACKUP_LIMITS.bufferBytes)
        return read(buffer, offset, Math.min(3, length), position)
      }) as typeof handle.read
      handle.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        writes++; return write(buffer, offset, Math.min(2, length), position)
      }) as typeof handle.write
    }
    return handle
  })
  const result = await f.create()
  assert.equal(result.fileCount, f.original.size); assert.ok(writes > 10); assert.equal(opens, closes)
})

test('wx destination files never overwrite an external entry and failure retains the container', async t => {
  const f = await fixture(t), original = fs.open
  let injected = false, foreign = ''
  hook(t, 'open', async (file, flags, mode) => {
    if (!injected && flags === 'wx' && String(file).includes(`${path.sep}world${path.sep}`)) {
      injected = true; foreign = String(file)
      const handle = await original(file, 'wx', 0o600); await handle.writeFile('external file'); await handle.close()
    }
    return original(file, flags, mode)
  })
  await assert.rejects(f.create(), error => hasCode('IO_ERROR')(error) && Boolean((error as WorldBackupError).retainedBackupId))
  assert.equal(await fs.readFile(foreign, 'utf8'), 'external file')
  assert.equal((await listWorldDirectoryBackups(f.backupRoot, f.instanceId)).incompleteCount, 1)
})

test('cancelled copying keeps all incomplete data and every previously completed backup', async t => {
  const f = await fixture(t), first = await f.create(), controller = new AbortController()
  const forbidden = () => { throw new Error('backup must not delete anything') }
  const restoreRm = hook(t, 'rm', forbidden as never), restoreUnlink = hook(t, 'unlink', forbidden as never)
  await assert.rejects(f.create({ signal: controller.signal, onProgress: p => { if (p.phase === 'copy') controller.abort() } }), isAbort)
  const listed = await listWorldDirectoryBackups(f.backupRoot, f.instanceId)
  assert.deepEqual(listed.items.map(item => item.backupId), [first.backupId]); assert.equal(listed.incompleteCount, 1)
  assert.equal((await f.containers()).length, 2)
  restoreRm(); restoreUnlink()
  const cancelledBefore = new AbortController(); cancelledBefore.abort()
  await assert.rejects(f.create({ signal: cancelledBefore.signal }), isAbort)
  assert.equal((await f.containers()).length, 2)
})

test('progress observer failures cannot cancel or corrupt a backup; only controller cancellation is AbortError', async t => {
  const f = await fixture(t)
  const result = await f.create({ onProgress: () => { throw new DOMException('observer only', 'AbortError') } })
  assert.ok(result.warnings.some(value => value.includes('进度通知失败')))
  const original = fs.open
  hook(t, 'open', async (file, flags, mode) => {
    if (String(file) === path.join(f.world, 'level.dat')) throw new DOMException('IO called AbortError', 'AbortError')
    return original(file, flags, mode)
  })
  await assert.rejects(f.create(), hasCode('IO_ERROR'))
})

test('source second-pass hashes detect changed read bytes even if filesystem metadata is unchanged', async t => {
  const f = await fixture(t), original = fs.open
  let phase = '', flipped = false
  hook(t, 'open', async (file, flags, mode) => {
    const handle = await original(file, flags, mode)
    if (String(file) === path.join(f.world, 'level.dat')) {
      const read = handle.read.bind(handle)
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position)
        if (phase === 'verify-source' && result.bytesRead && !flipped) { buffer[offset] ^= 0xff; flipped = true }
        return result
      }) as typeof handle.read
    }
    return handle
  })
  await assert.rejects(f.create({ onProgress: p => { phase = p.phase } }), hasCode('SOURCE_CHANGED'))
  assert.equal(flipped, true)
  assert.deepEqual(await fs.readFile(path.join(f.world, 'level.dat')), f.original.get('level.dat'))
  assert.equal((await listWorldDirectoryBackups(f.backupRoot, f.instanceId)).incompleteCount, 1)
})

test('new source entries during commit verification invalidate the whole tree', async t => {
  const f = await fixture(t)
  await assert.rejects(f.create({ onProgress: p => {
    if (p.phase === 'commit') writeFileSync(path.join(f.world, 'new-external.dat'), 'external change')
  } }), hasCode('SOURCE_CHANGED'))
  assert.equal((await listWorldDirectoryBackups(f.backupRoot, f.instanceId)).items.length, 0)
})

test('destination readback detects altered bytes rather than trusting the copy hash', async t => {
  const f = await fixture(t), original = fs.open
  let phase = '', flipped = false
  hook(t, 'open', async (file, flags, mode) => {
    const handle = await original(file, flags, mode)
    if (String(file).includes(`${path.sep}world${path.sep}`)) {
      const read = handle.read.bind(handle)
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position)
        if (phase === 'verify-destination' && result.bytesRead && !flipped) { buffer[offset] ^= 0xff; flipped = true }
        return result
      }) as typeof handle.read
    }
    return handle
  })
  await assert.rejects(f.create({ onProgress: p => { phase = p.phase } }), hasCode('DESTINATION_CHANGED'))
  assert.equal(flipped, true)
})

test('same-inode external control edits before commit are preserved and block publication', async t => {
  const f = await fixture(t), original = fs.open
  let intentPath = ''
  hook(t, 'open', async (file, flags, mode) => {
    if (path.basename(String(file)) === 'intent.json' && flags === 'wx') intentPath = String(file)
    return original(file, flags, mode)
  })
  await assert.rejects(f.create({ onProgress: p => {
    if (p.phase === 'commit') writeFileSync(intentPath, 'external control edit')
  } }), hasCode('DESTINATION_CHANGED'))
  assert.equal(await fs.readFile(intentPath, 'utf8'), 'external control edit')
  await assert.rejects(fs.access(path.join(path.dirname(intentPath), 'COMPLETE.json')), { code: 'ENOENT' })
})

test('ENOSPC at payload, manifest and completion publication preserves all source data and retained IDs', async t => {
  for (const stage of ['payload', 'manifest', 'commit'] as const) {
    const f = await fixture(t), original = fs.open
    const restore = stage === 'commit' ? hook(t, 'link', async () => { throw ioError('ENOSPC') }) :
      hook(t, 'open', async (file, flags, mode) => {
        if (flags === 'wx' && (stage === 'payload' ? String(file).includes(`${path.sep}world${path.sep}`) : path.basename(String(file)) === 'manifest.json')) throw ioError('ENOSPC')
        return original(file, flags, mode)
      })
    await assert.rejects(f.create(), error => hasCode('INSUFFICIENT_SPACE')(error) && Boolean((error as WorldBackupError).retainedBackupId))
    restore()
    assert.equal((await listWorldDirectoryBackups(f.backupRoot, f.instanceId)).incompleteCount, 1)
    for (const [name, bytes] of f.original) assert.deepEqual(await fs.readFile(path.join(f.world, ...name.split('/'))), bytes)
  }
})

test('publication failures never fall back to overwriting rename or copying into a visible complete marker', async t => {
  const f = await fixture(t)
  hook(t, 'link', async () => { throw ioError('EXDEV') })
  const restore = hook(t, 'rename', async () => { throw new Error('rename fallback forbidden') })
  await assert.rejects(f.create(), hasCode('IO_ERROR')); restore()
  const retained = (await f.containers())[0]
  await assert.rejects(fs.access(path.join(f.container(retained), 'COMPLETE.json')), { code: 'ENOENT' })
  assert.equal((await listWorldDirectoryBackups(f.backupRoot, f.instanceId)).incompleteCount, 1)
})

test('existing completion marker cannot be overwritten or accepted by matching bytes on another inode', async t => {
  const f = await fixture(t), original = fs.link
  hook(t, 'link', async (from, to) => { await fs.writeFile(to, await fs.readFile(from), { flag: 'wx' }); return original(from, to) })
  await assert.rejects(f.create(), hasCode('RECOVERY_REQUIRED'))
  assert.equal((await listWorldDirectoryBackups(f.backupRoot, f.instanceId)).incompleteCount, 1)
})

test('listing validates historical controls but deliberately does not rehash current payload bytes', async t => {
  const f = await fixture(t), result = await f.create(), original = fs.open
  await fs.writeFile(path.join(f.container(result.backupId), 'world', 'level.dat'), 'changed after completion')
  hook(t, 'open', async (file, flags, mode) => {
    assert.equal(String(file).includes(`${path.sep}world${path.sep}`), false, 'listing must not read GB payloads')
    return original(file, flags, mode)
  })
  const listed = await listWorldDirectoryBackups(f.backupRoot, f.instanceId)
  assert.equal(listed.items.length, 1); assert.ok(listed.warnings.some(value => value.includes('未重新校验')))
})

test('restart listing conservatively retains malformed receipts, extra children and linked control files', async t => {
  for (const mode of ['receipt', 'extra', 'link'] as const) {
    const f = await fixture(t), result = await f.create(), container = f.container(result.backupId)
    if (mode === 'receipt') await fs.writeFile(path.join(container, 'COMPLETE.json'), 'truncated')
    if (mode === 'extra') await fs.writeFile(path.join(container, 'external-data'), 'untouched')
    if (mode === 'link') {
      await fs.rename(path.join(container, 'manifest.json'), path.join(f.root, 'manifest-original'))
      await fs.symlink(path.join(f.root, 'manifest-original'), path.join(container, 'manifest.json'), 'file')
    }
    const listed = await listWorldDirectoryBackups(f.backupRoot, f.instanceId)
    assert.equal(listed.items.length, 0); assert.equal(listed.incompleteCount, 1)
    await assert.rejects(worldBackupDirectory(f.backupRoot, f.instanceId, result.backupId), WorldBackupError)
    assert.ok(await fs.stat(container))
  }
})

test('controls changed after their read are not returned as a verified completed container', async t => {
  const f = await fixture(t), result = await f.create(), original = fs.open
  const container = f.container(result.backupId)
  let edited = false
  hook(t, 'open', async (file, flags, mode) => {
    if (!edited && path.basename(String(file)) === 'COMPLETE.json') {
      edited = true; await fs.appendFile(path.join(container, 'manifest.json'), ' ')
    }
    return original(file, flags, mode)
  })
  const listed = await listWorldDirectoryBackups(f.backupRoot, f.instanceId)
  assert.equal(listed.items.length, 0); assert.equal(listed.incompleteCount, 1)
})

test('a synchronous module reservation rejects a second backup while the first waits on IO, then releases on failure', async t => {
  const f = await fixture(t), original = fs.statfs
  let started!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { started = resolve }), wait = new Promise<void>(resolve => { release = resolve })
  let first = true
  const restore = hook(t, 'statfs', (async (...args: Parameters<typeof fs.statfs>) => {
    if (first) { first = false; started(); await wait; throw ioError() }
    return original(...args)
  }) as typeof fs.statfs)
  const pending = f.create(); await ready
  await assert.rejects(f.create(), hasCode('BUSY')); release()
  await assert.rejects(pending, hasCode('IO_ERROR')); restore()
  assert.equal((await f.create()).verifiedAtCompletion, true)
})

test('async progress observer rejections are contained without an unhandled rejection', async t => {
  const f = await fixture(t)
  const result = await f.create({ onProgress: async () => { throw new Error('async observer failure') } })
  assert.equal(result.verifiedAtCompletion, true)
  assert.ok(result.warnings.some(value => value.includes('进度通知失败')))
})

test('same-inode source edits while copying are detected and every descriptor closes', async t => {
  const f = await fixture(t), original = fs.open, source = path.join(f.world, 'level.dat')
  let opened = 0, closed = 0, changed = false
  hook(t, 'open', async (file, flags, mode) => {
    const handle = await original(file, flags, mode); opened++
    const close = handle.close.bind(handle); handle.close = async () => { closed++; return close() }
    if (String(file) === source) {
      const read = handle.read.bind(handle)
      handle.read = (async (...args: Parameters<typeof read>) => {
        const result = await read(...args)
        if (!changed) { changed = true; await fs.writeFile(source, 'externally modified source') }
        return result
      }) as typeof handle.read
    }
    return handle
  })
  await assert.rejects(f.create(), hasCode('SOURCE_CHANGED'))
  assert.equal(opened, closed); assert.equal(await fs.readFile(source, 'utf8'), 'externally modified source')
})

test('zero-byte writes fail without spinning and release all descriptors', async t => {
  const f = await fixture(t), original = fs.open
  let opened = 0, closed = 0
  hook(t, 'open', async (file, flags, mode) => {
    const handle = await original(file, flags, mode); opened++
    const close = handle.close.bind(handle); handle.close = async () => { closed++; return close() }
    if (flags === 'wx' && String(file).includes(`${path.sep}world${path.sep}`)) {
      handle.write = (async (buffer: Buffer) => ({ bytesWritten: 0, buffer })) as typeof handle.write
    }
    return handle
  })
  await assert.rejects(f.create(), hasCode('IO_ERROR')); assert.equal(opened, closed)
  assert.equal((await listWorldDirectoryBackups(f.backupRoot, f.instanceId)).incompleteCount, 1)
})
