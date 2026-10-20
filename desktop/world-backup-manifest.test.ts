import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { BACKUP_LIMITS, backupSummary, parseBackupIntent, parseBackupManifest, parseBackupReceipt, worldItemId,
  type BackupManifest } from './world-backup-manifest'

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))
function fixture(): BackupManifest {
  return { schema: 1, backupId: randomUUID(), instanceId: 'instance-a', worldItemId: worldItemId('Demo'), worldFolderName: 'Demo',
    format: 'directory', createdAt: '2026-10-21T00:00:00.000Z', completedAt: '2026-10-21T00:01:00.000Z',
    fileCount: 1, directoryCount: 1, totalBytes: 3,
    verification: { algorithm: 'sha256', destinationReadback: true, sourceSecondPass: true },
    entries: [{ path: 'empty', type: 'directory', sourceMode: 0o40700, sourceMtimeNs: '1000000000' },
      { path: 'a.dat', type: 'file', sourceMode: 0o100600, sourceMtimeNs: '1000000000', sizeBytes: 3, sha256: 'a'.repeat(64) }] }
}

test('manifest validates all totals and exposes only the renderer-safe historical summary', () => {
  const value = fixture(), parsed = parseBackupManifest(bytes(value))
  assert.deepEqual(parsed, value)
  const summary = backupSummary(parsed)
  assert.equal(summary.format, 'directory'); assert.equal(summary.verifiedAtCompletion, true)
  assert.equal(Object.hasOwn(summary, 'entries'), false)
  assert.equal(Object.hasOwn(summary, 'verification'), false)
})

test('all metadata and entry objects have strict keys and types', () => {
  for (const change of [
    { schema: 2 }, { format: 'zip' }, { instanceId: '../instance' }, { backupId: '../backup' }, { worldItemId: 'spoof' },
    { worldFolderName: 'CON' }, { fileCount: 1.2 }, { totalBytes: '3' }, { createdAt: 'yesterday' },
    { completedAt: '2026-10-20T00:00:00.000Z' }, { extra: true },
    { verification: { algorithm: 'sha1', destinationReadback: true, sourceSecondPass: true } },
    { verification: { algorithm: 'sha256', destinationReadback: false, sourceSecondPass: true } },
  ]) assert.throws(() => parseBackupManifest(bytes({ ...fixture(), ...change })))
  for (const change of [{ extra: true }, { sourceMtimeNs: 'Infinity' }, { sourceMode: -1 }, { sizeBytes: -1 },
    { sha256: 'A'.repeat(64) }, { type: 'symlink' }]) {
    const value = fixture(); Object.assign(value.entries[1], change)
    assert.throws(() => parseBackupManifest(bytes(value)))
  }
})

test('relative paths reject traversal, absolute roots, device/ADS names and unsafe Unicode', () => {
  for (const name of ['', '.', '..', '/a', '../a', 'a/../b', 'a\\b', 'C:/x', 'a:b', 'NUL.txt', 'tail.', 'a//b', '\u202ex', '\ud800']) {
    const value = fixture(); value.entries[1].path = name
    assert.throws(() => parseBackupManifest(bytes(value)), name)
  }
})

test('path prefix tree requires exact parents, forbids files-as-directories and case/NFC collisions', () => {
  for (const [parent, child] of [['empty', 'missing/a'], ['empty', 'Empty/a'], ['a.dat/b', 'a.dat']]) {
    const value = fixture(); value.entries[0].path = parent; value.entries[1].path = child
    assert.throws(() => parseBackupManifest(bytes(value)))
  }
  for (const names of [['A.dat', 'a.dat'], ['Café', 'Cafe\u0301'], ['x', 'x']]) {
    const value = fixture(); value.entries[0].path = names[0]; value.entries[1].path = names[1]
    assert.throws(() => parseBackupManifest(bytes(value)))
  }
})

test('manifest totals cannot undercount files, directories or bytes and an empty tree is valid', () => {
  for (const change of [{ fileCount: 0 }, { directoryCount: 0 }, { totalBytes: 2 }, { totalBytes: 4 }]) {
    assert.throws(() => parseBackupManifest(bytes({ ...fixture(), ...change })))
  }
  const empty = { ...fixture(), entries: [], fileCount: 0, directoryCount: 0, totalBytes: 0 }
  assert.equal(parseBackupManifest(bytes(empty)).totalBytes, 0)
})

test('limits reject oversized paths, files, payload JSON and invalid UTF-8', () => {
  const path = fixture(); path.entries[1].path = 'x'.repeat(256)
  assert.throws(() => parseBackupManifest(bytes(path)))
  const file = fixture(); (file.entries[1] as { sizeBytes: number }).sizeBytes = BACKUP_LIMITS.fileBytes + 1
  assert.throws(() => parseBackupManifest(bytes(file)))
  assert.throws(() => parseBackupManifest(Buffer.alloc(BACKUP_LIMITS.manifestBytes + 1)))
  assert.throws(() => parseBackupManifest(Buffer.from([0xff])))
  assert.throws(() => parseBackupManifest(Buffer.from('{"__proto__":{"polluted":true}}')))
  assert.equal(({} as { polluted?: boolean }).polluted, undefined)
})

test('intent requires a safe matching world identity and receipt requires exact SHA256/time/schema', () => {
  const manifest = fixture()
  const intent = { schema: 1, backupId: manifest.backupId, instanceId: manifest.instanceId, operationId: randomUUID(),
    worldItemId: manifest.worldItemId, worldFolderName: manifest.worldFolderName, createdAt: manifest.createdAt }
  assert.deepEqual(parseBackupIntent(bytes(intent)), intent)
  for (const change of [{ worldItemId: 'bad' }, { operationId: 'a/b' }, { extra: true }, { schema: 2 }]) {
    assert.throws(() => parseBackupIntent(bytes({ ...intent, ...change })))
  }
  const receipt = { schema: 1, backupId: manifest.backupId, manifestSha256: 'f'.repeat(64), completedAt: manifest.completedAt }
  assert.deepEqual(parseBackupReceipt(bytes(receipt)), receipt)
  for (const change of [{ manifestSha256: 'f'.repeat(63) }, { completedAt: '2026-02-30T00:00:00.000Z' }, { extra: true }]) {
    assert.throws(() => parseBackupReceipt(bytes({ ...receipt, ...change })))
  }
})
