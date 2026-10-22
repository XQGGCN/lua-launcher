import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { createWorldDirectoryBackup } from './world-backup'
import { exportWorldBackupZip } from './world-zip'
import { availableWorldName, inspectWorldZip, restoreWorldFromBackup, restoreWorldFromZip, safeWorldFolderName } from './world-restore'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const selection = (name: string) => ({ name, itemId: `worlds:${hash(Buffer.from(name))}` })

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-world-restore-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const instance = path.join(root, 'instances', 'inst-a')
  const saves = path.join(instance, 'game', 'saves'), world = path.join(saves, 'Survival')
  await fs.mkdir(path.join(world, 'region'), { recursive: true })
  await fs.mkdir(path.join(world, 'empty'), { recursive: true })
  const files = new Map([['level.dat', Buffer.from('level bytes')], ['region/r.0.0.mca', Buffer.alloc(150_000, 3)], ['data/raids.dat', Buffer.from('raids')]])
  await fs.mkdir(path.join(world, 'data'), { recursive: true })
  for (const [name, bytes] of files) await fs.writeFile(path.join(world, ...name.split('/')), bytes)
  const backupRoot = path.join(root, 'backups')
  const backup = await createWorldDirectoryBackup(instance, selection('Survival'), { backupRoot, instanceId: 'inst-a', operationId: randomUUID() })
  const backupDirectory = path.join(backupRoot, 'inst-a', backup.backupId)
  const targetSaves = path.join(root, 'instances', 'inst-b', 'game', 'saves')
  const staging = path.join(root, 'instances', 'inst-b', '.restore-staging')
  return { root, saves, world, files, backupRoot, backup, backupDirectory, targetSaves, staging }
}
async function expectTree(directory: string, files: Map<string, Buffer>) {
  for (const [name, bytes] of files) assert.deepEqual(await fs.readFile(path.join(directory, ...name.split('/'))), bytes, name)
}

test('folder names are validated and never collide with existing worlds', async t => {
  const f = await fixture(t)
  assert.equal(safeWorldFolderName('我的世界'), true)
  for (const bad of ['', '..', 'a/b', 'CON', '.hidden', 'trailing.']) assert.equal(safeWorldFolderName(bad), false, bad)
  assert.equal(await availableWorldName(f.saves, 'Survival'), 'Survival (2)')
  assert.equal(await availableWorldName(f.saves, 'survival'), 'survival (2)')
  assert.equal(await availableWorldName(f.saves, 'New'), 'New')
})

test('a directory backup restores into another instance as a new verified world without touching the source', async t => {
  const f = await fixture(t)
  const result = await restoreWorldFromBackup(f.backupDirectory, { saves: f.targetSaves, staging: f.staging })
  assert.equal(result.folderName, 'Survival'); assert.equal(result.fileCount, 3); assert.equal(result.source, 'backup')
  await expectTree(path.join(f.targetSaves, 'Survival'), f.files)
  assert.ok((await fs.stat(path.join(f.targetSaves, 'Survival', 'empty'))).isDirectory())
  // Restoring again never overwrites.
  const again = await restoreWorldFromBackup(f.backupDirectory, { saves: f.targetSaves, staging: f.staging })
  assert.equal(again.folderName, 'Survival (2)')
  assert.deepEqual(await fs.readdir(f.staging), [])
  await expectTree(f.world, f.files)
})

test('a tampered backup file stops the restore and leaves no partial world', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.backupDirectory, 'world', 'level.dat'), 'level byteZ')
  await assert.rejects(restoreWorldFromBackup(f.backupDirectory, { saves: f.targetSaves, staging: f.staging }), /不一致/)
  assert.deepEqual(await fs.readdir(f.targetSaves).catch(() => []), [])
  assert.deepEqual(await fs.readdir(f.staging), [])
})

test('a Lua ZIP export restores with SHA-256 checks and reports its format', async t => {
  const f = await fixture(t)
  const exported = await exportWorldBackupZip(f.backupRoot, 'inst-a', f.backup.backupId, { exportRoot: path.join(f.root, 'exports'), operationId: randomUUID() })
  const zip = path.join(f.root, 'exports', 'inst-a', exported.exportId, exported.fileName)
  const inspection = await inspectWorldZip(zip)
  assert.equal(inspection.format, 'lua-zip'); assert.equal(inspection.suggestedName, 'Survival'); assert.equal(inspection.fileCount, 3)
  const result = await restoreWorldFromZip(zip, { saves: f.targetSaves, staging: f.staging, folderName: '从 ZIP 恢复' })
  assert.equal(result.folderName, '从 ZIP 恢复'); assert.equal(result.source, 'lua-zip')
  await expectTree(path.join(f.targetSaves, '从 ZIP 恢复'), f.files)
})

test('an ordinary downloaded map ZIP is imported from the folder that contains level.dat', async t => {
  const f = await fixture(t)
  const zip = new AdmZip()
  zip.addFile('README.txt', Buffer.from('map readme'))
  zip.addFile('__MACOSX/._junk', Buffer.from('x'))
  zip.addFile('Parkour Map/level.dat', Buffer.from('map level'))
  zip.addFile('Parkour Map/region/r.0.0.mca', Buffer.alloc(80_000, 7))
  zip.addFile('Parkour Map/data/', Buffer.alloc(0))
  const file = path.join(f.root, 'parkour.zip'); zip.writeZip(file)
  const inspection = await inspectWorldZip(file)
  assert.equal(inspection.format, 'zip'); assert.equal(inspection.suggestedName, 'Parkour Map'); assert.equal(inspection.fileCount, 2)
  const result = await restoreWorldFromZip(file, { saves: f.targetSaves, staging: f.staging })
  assert.equal(result.folderName, 'Parkour Map')
  await expectTree(path.join(f.targetSaves, 'Parkour Map'), new Map([['level.dat', Buffer.from('map level')], ['region/r.0.0.mca', Buffer.alloc(80_000, 7)]]))
  assert.ok((await fs.stat(path.join(f.targetSaves, 'Parkour Map', 'data'))).isDirectory())
  await assert.rejects(fs.access(path.join(f.targetSaves, 'Parkour Map', 'README.txt')))
})

test('ZIPs without a world, with traversal paths or with corrupted data are rejected', async t => {
  const f = await fixture(t)
  const noWorld = new AdmZip(); noWorld.addFile('hello.txt', Buffer.from('hi'))
  const a = path.join(f.root, 'a.zip'); noWorld.writeZip(a)
  await assert.rejects(inspectWorldZip(a), /level\.dat/)
  const evil = new AdmZip(); evil.addFile('level.dat', Buffer.from('x'))
  evil.addFile('placeholder.txt', Buffer.from('y'))
  const b = path.join(f.root, 'b.zip'); evil.writeZip(b)
  const bytes = await fs.readFile(b)
  // Rename "placeholder.txt" to "../../../evil.tx" (same length) in both headers.
  const patched = Buffer.from(bytes.toString('latin1').split('placeholder.txt').join('../../../evil.t'), 'latin1')
  await fs.writeFile(b, patched)
  await assert.rejects(restoreWorldFromZip(b, { saves: f.targetSaves, staging: f.staging }), /不安全/)
  const good = new AdmZip(); good.addFile('level.dat', Buffer.from('level data that will be corrupted'.repeat(50)))
  const c = path.join(f.root, 'c.zip'); good.writeZip(c)
  const raw = await fs.readFile(c); raw[60] ^= 0xff; await fs.writeFile(c, raw)
  await assert.rejects(restoreWorldFromZip(c, { saves: f.targetSaves, staging: f.staging }), /损坏|校验/)
  assert.deepEqual(await fs.readdir(f.targetSaves).catch(() => []), [])
})

test('cancellation stops a restore and removes the staging directory', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  await assert.rejects(restoreWorldFromBackup(f.backupDirectory, { saves: f.targetSaves, staging: f.staging, signal: controller.signal,
    onProgress: progress => { if (progress.filesDone === 1) controller.abort() } }), (error: Error) => error.name === 'AbortError')
  assert.deepEqual(await fs.readdir(f.staging), [])
  assert.deepEqual(await fs.readdir(f.targetSaves).catch(() => []), [])
})
