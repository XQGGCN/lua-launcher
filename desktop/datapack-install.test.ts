import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { crc32 } from './world-zip'
import { createWorldDirectoryBackup } from './world-backup'
import { installWorldDatapack, inspectDatapackInstallRecovery, DatapackInstallError, type DatapackInstallOptions } from './datapack-install'
import type { DatapackInstallSource } from './datapack-install-types'

function pack(description = 'Original inert fixture', extraBytes = 0): Buffer {
  const entries = [
    { name: 'pack.mcmeta', data: Buffer.from(JSON.stringify({ pack: { pack_format: 48, description } })) },
    { name: 'data/original/function/example.mcfunction', data: Buffer.from('say original fixture') },
    ...(extraBytes ? [{ name: 'data/original/large.bin', data: Buffer.alloc(extraBytes, 41) }] : []),
  ]
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0
  for (const { name: rawName, data } of entries) {
    const name = Buffer.from(rawName), hash = crc32(data), header = Buffer.alloc(30), cd = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt32LE(hash, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26)
    cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt32LE(hash, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0x81a40000, 38); cd.writeUInt32LE(offset, 42)
    local.push(header, name, data); central.push(cd, name); offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('hex')
const code = (wanted: string) => (error: unknown) => error instanceof DatapackInstallError && error.code === wanted
async function fixture(t: test.TestContext, bytes = pack()) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lua-datapack-install-')))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const instance = path.join(directory, 'instance'), world = path.join(instance, 'game', 'saves', 'Original')
  await fs.mkdir(world, { recursive: true }); await fs.writeFile(path.join(world, 'level.dat'), 'original inert level, not NBT')
  await fs.mkdir(path.join(world, 'empty')); await fs.writeFile(path.join(world, 'session.lock'), Buffer.from([1, 2, 3]))
  const file = path.join(directory, 'Original.zip'); await fs.writeFile(file, bytes)
  const selection = { itemId: 'worlds:' + createHash('sha256').update('Original').digest('hex'), name: 'Original' }
  const source: DatapackInstallSource = { file, filename: 'Original.zip', sha512: sha512(bytes), archiveBytes: bytes.length }
  const options: DatapackInstallOptions = { backupRoot: path.join(directory, 'backups'), instanceId: 'instance-a', operationId: randomUUID() }
  return { directory, instance, world, file, selection, source, options, bytes,
    install: (override: Partial<DatapackInstallOptions> = {}) => installWorldDatapack(instance, selection, source, { ...options, ...override }),
    recovery: () => inspectDatapackInstallRecovery(instance),
    stage: path.join(instance, '.datapack-staging', options.operationId), target: path.join(world, 'datapacks', source.filename) }
}
async function fingerprint(file: string) {
  const stat = await fs.lstat(file, { bigint: true })
  return { hash: sha512(await fs.readFile(file)), ino: stat.ino, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs, mode: stat.mode }
}
async function absent(file: string) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }) }

test('fresh full backup precedes one ZIP publication and original bytes/identity stay unchanged', async t => {
  const f = await fixture(t), original = await fingerprint(f.file), level = await fingerprint(path.join(f.world, 'level.dat')), lock = await fingerprint(path.join(f.world, 'session.lock'))
  const progress: string[] = [], result = await f.install({ onProgress: value => progress.push(value.phase) })
  assert.deepEqual(await fs.readFile(f.target), f.bytes); assert.equal(result.filename, 'Original.zip'); assert.equal(result.sha512, f.source.sha512)
  assert.equal(result.backup.fileCount, 2); assert.equal(result.backup.directoryCount, 1); assert.equal(result.backup.worldFolderName, 'Original')
  assert.equal(progress[0], 'prepare'); assert.ok(progress.indexOf('backup') > 0); assert.equal(progress.at(-1), 'commit')
  const backup = path.join(f.options.backupRoot, f.options.instanceId, result.backup.backupId, 'world')
  assert.equal(await fs.readFile(path.join(backup, 'level.dat'), 'utf8'), 'original inert level, not NBT'); await absent(path.join(backup, 'datapacks'))
  assert.deepEqual(await fingerprint(f.file), original); assert.deepEqual(await fingerprint(path.join(f.world, 'level.dat')), level); assert.deepEqual(await fingerprint(path.join(f.world, 'session.lock')), lock)
  assert.equal((await f.recovery()).blocked, false); assert.ok(!JSON.stringify(result).includes(f.directory))
})
test('existing pack files and their bytes, timestamps and identities are preserved', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.world, 'datapacks')); const old = path.join(f.world, 'datapacks', 'Keep.zip'); await fs.writeFile(old, pack('Keep'))
  const before = await fingerprint(old), result = await f.install()
  assert.deepEqual(await fingerprint(old), before); assert.deepEqual((await fs.readdir(path.dirname(f.target))).sort(), ['Keep.zip', 'Original.zip'])
  const backup = path.join(f.options.backupRoot, f.options.instanceId, result.backup.backupId, 'world/datapacks/Keep.zip'); assert.deepEqual(await fs.readFile(backup), await fs.readFile(old))
})
test('wrong expected hash or size rejects before staging and does not create datapacks', async t => {
  const f = await fixture(t); f.source.sha512 = 'f'.repeat(128)
  await assert.rejects(f.install(), code('SOURCE_CHANGED')); await absent(path.join(f.instance, '.datapack-staging')); await absent(path.dirname(f.target)); assert.equal((await f.recovery()).blocked, false)
})
test('structurally invalid ZIP never reaches backup or INTENT and preparation is nonblocking', async t => {
  const f = await fixture(t, Buffer.alloc(80, 3)); let backedUp = false
  await assert.rejects(f.install({ backupCreator: async () => { backedUp = true; throw new Error('must not run') } }), code('INVALID_ARCHIVE'))
  assert.equal(backedUp, false); await absent(path.dirname(f.target)); await absent(path.join(f.stage, 'INTENT.json')); assert.equal((await f.recovery()).blocked, false)
  assert.deepEqual(await fs.readFile(path.join(f.stage, 'payload.zip')), f.bytes)
})
test('unsafe source/destination names and malformed selection are refused', async t => {
  const f = await fixture(t)
  for (const filename of ['../x.zip', 'CON.zip', 'evil\u202e.zip', 'name.zip ', 'not-a-zip.jar']) {
    await assert.rejects(installWorldDatapack(f.instance, f.selection, { ...f.source, filename }, f.options), code('INVALID_INPUT'))
  }
  await assert.rejects(installWorldDatapack(f.instance, { ...f.selection, itemId: 'worlds:fake' }, f.source, f.options), code('INVALID_INPUT')); await absent(path.dirname(f.target))
})
test('source symbolic links and linked ancestors are refused without modifying external files', async t => {
  const f = await fixture(t); if (process.platform === 'win32') return
  const linked = path.join(f.directory, 'link.zip'); await fs.symlink(f.file, linked)
  await assert.rejects(installWorldDatapack(f.instance, f.selection, { ...f.source, file: linked }, f.options)); await absent(path.dirname(f.target)); assert.deepEqual(await fs.readFile(f.file), f.bytes)
  const parent = path.join(f.directory, 'linked'); await fs.symlink(f.directory, parent)
  await assert.rejects(installWorldDatapack(f.instance, f.selection, { ...f.source, file: path.join(parent, 'Original.zip') }, f.options), code('UNSAFE_PATH'))
})
test('same-case and case-folded destination conflicts never overwrite an existing archive', async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.target)); const old = path.join(path.dirname(f.target), 'ORIGINAL.ZIP'); await fs.writeFile(old, 'foreign archive')
  const before = await fingerprint(old); await assert.rejects(f.install(), code('NAME_COLLISION')); assert.deepEqual(await fingerprint(old), before); assert.equal((await f.recovery()).blocked, false)
})
test('NFC-equivalent target names and differently cased datapacks directories are rejected', async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.target)); f.source.filename = 'caf\u00e9.zip'; const other = path.join(path.dirname(f.target), 'cafe\u0301.zip'); await fs.writeFile(other, 'foreign')
  await assert.rejects(f.install(), code('NAME_COLLISION')); assert.equal(await fs.readFile(other, 'utf8'), 'foreign')
  const g = await fixture(t); await fs.mkdir(path.join(g.world, 'DataPacks')); await assert.rejects(g.install(), code('NAME_COLLISION')); assert.deepEqual(await fs.readdir(path.join(g.world, 'DataPacks')), [])
})
test('linked datapacks or staging roots never receive a write', async t => {
  const f = await fixture(t); if (process.platform === 'win32') return
  const external = path.join(f.directory, 'external'); await fs.mkdir(external); await fs.symlink(external, path.dirname(f.target))
  await assert.rejects(f.install(), code('UNSAFE_PATH')); assert.deepEqual(await fs.readdir(external), [])
  const g = await fixture(t); await fs.symlink(external, path.join(g.instance, '.datapack-staging')); await assert.rejects(g.install(), code('RECOVERY_REQUIRED')); assert.deepEqual(await fs.readdir(external), [])
})
test('actual short writes loop to completion and independent payload/target readback matches', async t => {
  const f = await fixture(t); let calls = 0
  await f.install({ hooks: { write: async (handle, bytes, offset, length, position) => { calls++; return (await handle.write(bytes, offset, Math.min(7, length), position)).bytesWritten } } })
  assert.ok(calls > 20); assert.deepEqual(await fs.readFile(f.target), f.bytes); assert.equal((await f.recovery()).blocked, false)
})
test('zero-length or disk-full writes retain preparation without writing the world', async t => {
  const f = await fixture(t); await assert.rejects(f.install({ hooks: { write: async () => 0 } }), code('IO_ERROR')); await absent(path.dirname(f.target)); assert.equal((await f.recovery()).blocked, false)
  const g = await fixture(t); await assert.rejects(g.install({ hooks: { write: async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }) } } }), code('INSUFFICIENT_SPACE')); await absent(path.dirname(g.target)); assert.equal((await g.recovery()).blocked, false)
})
test('source content mutation during actual copy is detected and never reaches backup', async t => {
  const f = await fixture(t, pack('Large', 2 * 1024 ** 2)); let edited = false
  await assert.rejects(f.install({ hooks: { write: async (handle, bytes, offset, length, position) => {
    const count = (await handle.write(bytes, offset, length, position)).bytesWritten
    if (!edited) { edited = true; await fs.writeFile(f.file, Buffer.alloc(f.bytes.length, 7)) }
    return count
  } } }), code('SOURCE_CHANGED'))
  await absent(path.dirname(f.target)); await absent(f.options.backupRoot); assert.equal((await f.recovery()).blocked, false)
})
test('exact cancellation during copy keeps partial bytes but no INTENT or world mutation', async t => {
  const f = await fixture(t, pack('Large', 2 * 1024 ** 2)), controller = new AbortController()
  await assert.rejects(f.install({ signal: controller.signal, onProgress: value => { if (value.phase === 'prepare' && value.bytesDone > 0) controller.abort() } }), { name: 'AbortError' })
  await absent(path.dirname(f.target)); await absent(path.join(f.stage, 'INTENT.json')); assert.ok((await fs.stat(path.join(f.stage, 'payload.zip'))).size > 0); assert.equal((await f.recovery()).blocked, false)
})
test('backup failure and actual backup-copy cancellation prevent installation and retain evidence', async t => {
  const f = await fixture(t)
  await assert.rejects(f.install({ backupCreator: async () => { throw new Error('backup failed') } }), code('BACKUP_FAILED')); await absent(path.dirname(f.target)); assert.equal((await f.recovery()).blocked, false)
  const g = await fixture(t), controller = new AbortController()
  await assert.rejects(g.install({ signal: controller.signal, onProgress: value => { if (value.phase === 'backup' && value.backupProgress?.phase === 'copy' && value.bytesDone > 0) controller.abort() } }), { name: 'AbortError' })
  await absent(path.dirname(g.target)); await absent(path.join(g.stage, 'INTENT.json')); assert.equal((await g.recovery()).blocked, false)
  assert.equal((await fs.readdir(path.join(g.options.backupRoot, g.options.instanceId))).length, 1)
})
test('Core preview authorization and revision check failures happen before world mutation', async t => {
  const f = await fixture(t); await assert.rejects(f.install({ authorizePreview: preview => { assert.equal(preview.status, 'checked'); throw new Error('format mismatch') } }), code('IO_ERROR')); await absent(path.dirname(f.target)); await absent(f.options.backupRoot)
  const g = await fixture(t); let calls = 0
  await assert.rejects(g.install({ verifyWorld: async () => { if (++calls === 2) throw new Error('saved world changed') } }), code('IO_ERROR')); await absent(path.dirname(g.target)); assert.equal((await g.recovery()).blocked, false)
})
test('foreign target created at publication is kept and transaction becomes recovery-required', async t => {
  const f = await fixture(t)
  await assert.rejects(f.install({ hooks: { beforePublish: async () => { await fs.writeFile(f.target, 'foreign bytes', { flag: 'wx' }) } } }), code('RECOVERY_REQUIRED'))
  assert.equal(await fs.readFile(f.target, 'utf8'), 'foreign bytes'); assert.equal((await f.recovery()).blocked, true); await absent(path.join(f.stage, 'COMPLETE.json'))
})
test('late unrelated datapack changes are preserved and prevent installing against an obsolete backup', async t => {
  const f = await fixture(t)
  await assert.rejects(f.install({ hooks: { beforePublish: async () => { await fs.writeFile(path.join(path.dirname(f.target), 'Other.zip'), 'late external bytes') } } }), code('RECOVERY_REQUIRED'))
  await absent(f.target); assert.equal(await fs.readFile(path.join(path.dirname(f.target), 'Other.zip'), 'utf8'), 'late external bytes'); assert.equal((await f.recovery()).blocked, true)
})
test('world replacement after INTENT does not receive a new datapacks folder', async t => {
  const f = await fixture(t), moved = path.join(f.directory, 'moved-original')
  await assert.rejects(f.install({ hooks: { afterIntent: async () => { await fs.rename(f.world, moved); await fs.mkdir(f.world) } } }), code('RECOVERY_REQUIRED'))
  assert.deepEqual(await fs.readdir(f.world), []); assert.equal(await fs.readFile(path.join(moved, 'level.dat'), 'utf8'), 'original inert level, not NBT'); assert.equal((await f.recovery()).blocked, true)
})
test('foreign datapacks directory created after INTENT is preserved and not adopted', async t => {
  const f = await fixture(t)
  await assert.rejects(f.install({ hooks: { afterIntent: async () => { await fs.mkdir(path.dirname(f.target)); await fs.writeFile(path.join(path.dirname(f.target), 'foreign'), 'external') } } }), code('RECOVERY_REQUIRED'))
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), ['foreign']); assert.equal((await f.recovery()).blocked, true)
})
test('cancellation after INTENT remains recovery-required instead of claiming a clean cancellation', async t => {
  const f = await fixture(t), controller = new AbortController()
  await assert.rejects(f.install({ signal: controller.signal, hooks: { afterIntent: async () => controller.abort() } }), code('RECOVERY_REQUIRED'))
  await absent(path.dirname(f.target)); assert.equal((await f.recovery()).blocked, true)
})
test('unsupported link semantics fail closed without a rename-overwrite fallback', async t => {
  const f = await fixture(t)
  await assert.rejects(f.install({ hooks: { link: async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }) } } }), code('RECOVERY_REQUIRED'))
  await absent(f.target); assert.equal((await f.recovery()).blocked, true); assert.deepEqual(await fs.readFile(path.join(f.stage, 'payload.zip')), f.bytes)
})
test('lost link acknowledgements and late cancellation are accepted only after both proofs are read back', async t => {
  const f = await fixture(t), controller = new AbortController(); let calls = 0
  const result = await f.install({ signal: controller.signal, hooks: { link: async (from, to) => { calls++; await fs.link(from, to); controller.abort(); throw Object.assign(new Error('lost ack'), { code: 'EIO' }) } } })
  assert.equal(calls, 2); assert.equal(result.sha512, f.source.sha512); assert.ok(result.warnings.some(value => value.includes('响应异常'))); assert.deepEqual(await fs.readFile(f.target), f.bytes); assert.equal((await f.recovery()).blocked, false)
})
test('failed completion proof retains the already published ZIP and blocks restart', async t => {
  const f = await fixture(t)
  await assert.rejects(f.install({ hooks: { link: async (from, to) => { if (String(to).endsWith('COMPLETE.json')) throw new Error('completion failed'); await fs.link(from, to) } } }), code('RECOVERY_REQUIRED'))
  assert.deepEqual(await fs.readFile(f.target), f.bytes); assert.equal((await f.recovery()).blocked, true); await absent(path.join(f.stage, 'COMPLETE.json'))
})
test('target changes during completion acknowledgement cannot produce a finalized success or unlock restart', async t => {
  const f = await fixture(t)
  await assert.rejects(f.install({ hooks: { link: async (from, to) => { await fs.link(from, to); if (path.basename(String(to)) === 'COMPLETE.json') await fs.writeFile(f.target, 'external modification during acknowledgement') } } }), code('RECOVERY_REQUIRED'))
  assert.equal(await fs.readFile(f.target, 'utf8'), 'external modification during acknowledgement'); await absent(path.join(f.stage, 'FINALIZED.json')); assert.equal((await f.recovery()).blocked, true)
})
test('historical completion tolerates later target edits, growth, deletion and world move', async t => {
  const f = await fixture(t); await f.install(); await fs.writeFile(f.target, 'user-modified later'); assert.equal((await f.recovery()).blocked, false)
  const handle = await fs.open(f.target, 'r+'); await handle.truncate(DATAPACK_BYTES_OVER_LIMIT); await handle.close(); assert.equal((await f.recovery()).blocked, false)
  await fs.unlink(f.target); assert.equal((await f.recovery()).blocked, false); await fs.rename(f.world, path.join(f.directory, 'moved')); assert.equal((await f.recovery()).blocked, false)
})
const DATAPACK_BYTES_OVER_LIMIT = 512 * 1024 ** 2 + 1
test('unknown and malformed recovery records fail closed without deleting evidence', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.instance, '.datapack-staging')); const foreign = path.join(f.instance, '.datapack-staging', 'foreign-file'); await fs.writeFile(foreign, 'external control')
  const before = await fingerprint(foreign); assert.equal((await f.recovery()).blocked, true); assert.deepEqual(await fingerprint(foreign), before)
  const g = await fixture(t); await fs.mkdir(g.stage, { recursive: true }); await fs.writeFile(path.join(g.stage, 'PREPARING.json'), '{')
  assert.equal((await g.recovery()).blocked, true); assert.equal(await fs.readFile(path.join(g.stage, 'PREPARING.json'), 'utf8'), '{')
})
test('empty crash-before-preparing containers are recognized as pre-mutation only', async t => {
  const f = await fixture(t); await fs.mkdir(f.stage, { recursive: true }); assert.equal((await f.recovery()).blocked, false); assert.deepEqual(await fs.readdir(f.stage), [])
})
test('missing instance directories have no journal and existing unsafe ancestors remain blocked', async t => {
  const f = await fixture(t), absentInstance = path.join(f.directory, 'never-installed', 'instance')
  assert.equal((await inspectDatapackInstallRecovery(absentInstance)).blocked, false); await absent(path.join(f.directory, 'never-installed'))
  if (process.platform !== 'win32') {
    const alias = path.join(f.directory, 'alias'); await fs.symlink(f.directory, alias)
    assert.equal((await inspectDatapackInstallRecovery(path.join(alias, 'never-installed'))).blocked, true)
  }
})
test('edited completion controls revoke history without removing user data', async t => {
  const f = await fixture(t); await f.install(); await fs.writeFile(path.join(f.stage, 'INTENT.json'), '{}')
  assert.equal((await f.recovery()).blocked, true); assert.deepEqual(await fs.readFile(f.target), f.bytes)
})
test('low-level instance reservation remains held until the actual awaited callback settles', async t => {
  const f = await fixture(t); let release!: () => void, reached!: () => void; const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { reached = resolve })
  const first = f.install({ verifyWorld: async () => { reached(); await gate } }); await entered
  await assert.rejects(f.install({ operationId: randomUUID() }), code('BUSY')); release(); await first; assert.equal((await f.recovery()).blocked, false)
})
test('mismatched backup provenance never reaches INTENT even if a backup creator returned', async t => {
  const f = await fixture(t)
  await assert.rejects(f.install({ backupCreator: async (...args) => ({ ...await createWorldDirectoryBackup(...args), instanceId: 'wrong-instance' }) }), code('BACKUP_FAILED'))
  await absent(path.dirname(f.target)); await absent(path.join(f.stage, 'INTENT.json')); assert.equal((await f.recovery()).blocked, false)
})
test('an unrelated historical backup is not accepted as this operation fresh backup', async t => {
  const f = await fixture(t), old = await createWorldDirectoryBackup(f.instance, f.selection, { backupRoot: f.options.backupRoot, instanceId: f.options.instanceId, operationId: randomUUID() })
  await assert.rejects(f.install({ backupCreator: async () => old }), code('BACKUP_FAILED')); await absent(path.dirname(f.target)); await absent(path.join(f.stage, 'INTENT.json')); assert.equal((await f.recovery()).blocked, false)
})
test('payload or intent tampering at commit is retained and never publishes unchecked bytes', async t => {
  const f = await fixture(t)
  await assert.rejects(f.install({ hooks: { beforePublish: async () => { await fs.writeFile(path.join(f.stage, 'payload.zip'), 'changed') } } }), code('RECOVERY_REQUIRED')); await absent(f.target); assert.equal((await f.recovery()).blocked, true)
  const g = await fixture(t)
  await assert.rejects(g.install({ hooks: { beforePublish: async () => { await fs.writeFile(path.join(g.stage, 'INTENT.json'), '{}') } } }), code('RECOVERY_REQUIRED')); await absent(g.target); assert.equal((await g.recovery()).blocked, true)
  const h = await fixture(t)
  await assert.rejects(h.install({ hooks: { afterIntent: async () => { await fs.writeFile(path.join(h.stage, 'PREPARING.json'), '{}') } } }), code('RECOVERY_REQUIRED')); await absent(h.target); assert.equal((await h.recovery()).blocked, true)
})
test('progress observer errors cannot decide a completed transaction outcome', async t => {
  const f = await fixture(t); await f.install({ onProgress: () => { throw new Error('observer') } }); assert.equal((await f.recovery()).blocked, false); assert.deepEqual(await fs.readFile(f.target), f.bytes)
})
