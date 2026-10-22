import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { createWorldDirectoryBackup } from './world-backup'
import { crc32, crc32Software, exportWorldBackupZip, listWorldBackupZips, readZipStrict, verifyWorldBackupZip,
  worldBackupZipPath, WorldZipError, ZipWriter } from './world-zip'
import type { WorldZipProgress } from './world-zip-types'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const selection = (name: string) => ({ name, itemId: `worlds:${hash(Buffer.from(name))}` })
const hasCode = (code: string) => (error: unknown) => error instanceof WorldZipError && error.code === code

async function fixture(t: TestContext, extra: Array<[string, Buffer]> = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-world-zip-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const instanceId = 'instance-a', instance = path.join(root, 'instances', instanceId)
  const world = path.join(instance, 'game', 'saves', '生存世界 Demo')
  const backupRoot = path.join(root, 'backups'), exportRoot = path.join(root, 'world-exports')
  await fs.mkdir(path.join(world, 'empty', 'nested-empty'), { recursive: true })
  await fs.mkdir(path.join(world, 'region'), { recursive: true })
  const files = new Map<string, Buffer>([
    ['level.dat', Buffer.from('not gzip; copied as bytes')],
    ['session.lock', Buffer.from([0, 255, 7, 16])],
    ['empty-file.txt', Buffer.alloc(0)],
    ['region/r.0.0.mca', Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31) % 251))],
    ['region/random.bin', Buffer.from(Array.from({ length: 70_000 }, () => Math.floor(Math.random() * 256)))],
    ['中文文件.json', Buffer.from('{"名字":"未央"}')],
    ...extra,
  ])
  for (const [name, bytes] of files) await fs.writeFile(path.join(world, ...name.split('/')), bytes)
  const backup = await createWorldDirectoryBackup(instance, selection('生存世界 Demo'), { backupRoot, instanceId, operationId: randomUUID() })
  const exportZip = (more: Partial<Parameters<typeof exportWorldBackupZip>[3]> = {}) =>
    exportWorldBackupZip(backupRoot, instanceId, backup.backupId, { exportRoot, operationId: randomUUID(), ...more })
  return { root, instanceId, backupRoot, exportRoot, backup, files, exportZip }
}

test('crc32 native and software implementations agree on known vectors', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(crc32Software(Buffer.from('123456789'), 0), 0xcbf43926)
  const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))
  assert.equal(crc32(data.subarray(1000), crc32(data.subarray(0, 1000))), crc32Software(data, 0))
})

test('exports a completed backup as a standard ZIP that an independent reader reconstructs byte for byte', async t => {
  const f = await fixture(t)
  const phases = new Set<string>()
  const result = await f.exportZip({ onProgress: (progress: WorldZipProgress) => phases.add(progress.phase) })
  assert.equal(result.format, 'lua-world-zip'); assert.equal(result.verifiedAtCompletion, true)
  assert.equal(result.fileCount, f.files.size); assert.equal(result.backupId, f.backup.backupId)
  assert.ok(result.fileName.endsWith('.zip')); assert.ok(result.fileName.startsWith('生存世界 Demo-'))
  for (const phase of ['validate-backup', 'verify-archive', 'commit']) assert.ok(phases.has(phase), phase)
  const file = await worldBackupZipPath(f.exportRoot, f.instanceId, result.exportId)
  assert.equal(path.basename(file), result.fileName)
  assert.equal(hash(await fs.readFile(file)), result.archiveSha256)
  // adm-zip is an unrelated implementation; it must see the same tree.
  const zip = new AdmZip(file)
  const names = zip.getEntries().map(entry => entry.entryName).sort()
  assert.ok(names.includes('world/empty/nested-empty/'))
  assert.ok(names.includes('lua-backup/manifest.json'))
  for (const [name, bytes] of f.files) assert.deepEqual(zip.readFile(`world/${name}`), bytes, name)
  const format = JSON.parse(zip.readAsText('lua-backup/format.json'))
  assert.equal(format.magic, 'LuaWorldZip'); assert.equal(format.sourceBackupId, f.backup.backupId)
  // Only the published archive and controls remain; no partial alias.
  const container = path.dirname(file)
  assert.deepEqual((await fs.readdir(container)).sort(), [result.fileName, 'intent.json', 'verification.json'].sort())
  const listed = await listWorldBackupZips(f.exportRoot, f.instanceId)
  assert.equal(listed.items.length, 1); assert.equal(listed.incompleteCount, 0)
  assert.equal(listed.items[0].exportId, result.exportId)
  assert.equal(JSON.stringify(listed).includes(f.root), false)
  assert.deepEqual(await verifyWorldBackupZip(f.exportRoot, f.instanceId, result.exportId), listed.items[0])
})

test('forced ZIP64 records are produced and read back by the strict reader', async t => {
  const f = await fixture(t)
  const result = await f.exportZip({ forceZip64: true })
  const file = await worldBackupZipPath(f.exportRoot, f.instanceId, result.exportId)
  const bytes = await fs.readFile(file)
  assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'zip64 end record')
  assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])), 'zip64 locator')
  const read = await readZipStrict(file)
  for (const [name, content] of f.files) assert.equal(read.entries.find(entry => entry.name === `world/${name}`)?.sha256, hash(content))
})

test('a backup whose payload changed after completion is refused and leaves no export behind', async t => {
  const f = await fixture(t)
  const backupDirectory = path.join(f.backupRoot, f.instanceId, f.backup.backupId)
  await fs.writeFile(path.join(backupDirectory, 'world', 'level.dat'), Buffer.from('not gzip; copied as byteZ'))
  await assert.rejects(f.exportZip(), hasCode('BACKUP_CHANGED'))
  const listed = await listWorldBackupZips(f.exportRoot, f.instanceId)
  assert.equal(listed.items.length, 0); assert.equal(listed.incompleteCount, 0)
  assert.deepEqual(await fs.readdir(path.join(f.exportRoot, f.instanceId)), [])
})

test('unknown or incomplete backups and invalid identifiers are rejected', async t => {
  const f = await fixture(t)
  await assert.rejects(exportWorldBackupZip(f.backupRoot, f.instanceId, randomUUID(), { exportRoot: f.exportRoot, operationId: randomUUID() }), hasCode('BACKUP_INVALID'))
  await assert.rejects(exportWorldBackupZip(f.backupRoot, '../escape', f.backup.backupId, { exportRoot: f.exportRoot, operationId: randomUUID() }), hasCode('INVALID_INPUT'))
  await assert.rejects(exportWorldBackupZip(f.backupRoot, f.instanceId, f.backup.backupId, { exportRoot: 'relative/path', operationId: randomUUID() }), hasCode('INVALID_INPUT'))
  await assert.rejects(worldBackupZipPath(f.exportRoot, f.instanceId, '../../etc'), hasCode('INVALID_INPUT'))
})

test('cancellation removes the partial archive and reports AbortError', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  await assert.rejects(f.exportZip({ signal: controller.signal, onProgress: progress => { if (progress.phase === 'export') controller.abort() } }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError')
  assert.deepEqual(await fs.readdir(path.join(f.exportRoot, f.instanceId)), [])
})

test('only one export runs at a time', async t => {
  const f = await fixture(t)
  const first = f.exportZip()
  await assert.rejects(f.exportZip(), hasCode('BUSY'))
  await first
})

test('strict reader rejects corrupted payloads, truncation and trailing data', async t => {
  const f = await fixture(t)
  const result = await f.exportZip()
  const file = await worldBackupZipPath(f.exportRoot, f.instanceId, result.exportId)
  const original = await fs.readFile(file)
  const copy = path.join(f.root, 'copy.zip')
  // Flip one byte inside the compressed region of the big region file.
  const marker = original.indexOf(Buffer.from('world/region/r.0.0.mca'))
  const corrupted = Buffer.from(original); corrupted[marker + 200] ^= 0xff
  await fs.writeFile(copy, corrupted)
  await assert.rejects(readZipStrict(copy), hasCode('ARCHIVE_INVALID'))
  await fs.writeFile(copy, original.subarray(0, original.length - 7))
  await assert.rejects(readZipStrict(copy), hasCode('ARCHIVE_INVALID'))
  await fs.writeFile(copy, Buffer.concat([original, Buffer.from('trailing')]))
  await assert.rejects(readZipStrict(copy), hasCode('ARCHIVE_INVALID'))
  // A published archive modified later fails explicit re-verification.
  await fs.writeFile(file, corrupted)
  await assert.rejects(verifyWorldBackupZip(f.exportRoot, f.instanceId, result.exportId), hasCode('ARCHIVE_INVALID'))
})

test('writer emits a valid empty-file entry and utf-8 names readable by adm-zip', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-zip-writer-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'a.zip'), handle = await fs.open(file, 'wx')
  try {
    const writer = new ZipWriter(handle)
    await writer.addDirectory('目录/', new Date(2026, 0, 2, 3, 4, 6))
    await writer.addBuffer('目录/空.txt', Buffer.alloc(0), new Date())
    await writer.addBuffer('目录/内容.txt', Buffer.from('你好，世界'.repeat(100)), new Date())
    await writer.finish()
  } finally { await handle.close() }
  const zip = new AdmZip(file)
  assert.equal(zip.readAsText('目录/内容.txt'), '你好，世界'.repeat(100))
  assert.equal(zip.readFile('目录/空.txt')?.length, 0)
  const read = await readZipStrict(file)
  assert.deepEqual(read.entries.map(entry => entry.name), ['目录/', '目录/空.txt', '目录/内容.txt'])
})
