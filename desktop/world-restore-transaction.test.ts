import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { PathLike } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { beginWorldRestoreTransaction, inspectWorldRestoreRecovery, publishWorldRestore, WorldRestoreRecoveryError, type RestoreEntry } from './world-restore-transaction'

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lua-restore-txn-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const staging = path.join(root, 'staging'), saves = path.join(root, 'saves')
  await fs.mkdir(saves)
  const transaction = await beginWorldRestoreTransaction(staging)
  await fs.mkdir(path.join(transaction.payload, 'empty'))
  await fs.writeFile(path.join(transaction.payload, 'level.dat'), 'original inert level')
  const entries: RestoreEntry[] = [{ type: 'directory', path: 'empty' }, { type: 'file', path: 'level.dat', size: 20, sha256: hash('original inert level') }]
  return { root, staging, saves, transaction, entries }
}
function patch<K extends 'mkdir' | 'link' | 'statfs' | 'open'>(t: TestContext, method: K, replacement: typeof fs[K]) {
  const original = fs[method]
  ;(fs as unknown as Record<string, unknown>)[method] = replacement
  syncBuiltinESMExports()
  t.after(() => { (fs as unknown as Record<string, unknown>)[method] = original; syncBuiltinESMExports() })
}

test('exclusive reservation never replaces an empty directory created just before mkdir', async t => {
  const f = await fixture(t), original = fs.mkdir
  let otherInode: bigint | undefined
  patch(t, 'mkdir', (async (name: PathLike, options?: unknown) => {
    if (String(name) === path.join(f.saves, 'Restored') && otherInode === undefined) {
      await original(name)
      otherInode = (await fs.lstat(name, { bigint: true })).ino
    }
    return original(name, options as Parameters<typeof fs.mkdir>[1])
  }) as typeof fs.mkdir)
  const name = await publishWorldRestore(f.transaction, f.saves, 'Restored', f.entries)
  assert.equal(name, 'Restored (2)')
  assert.equal((await fs.lstat(path.join(f.saves, 'Restored'), { bigint: true })).ino, otherInode)
  assert.deepEqual(await fs.readdir(path.join(f.saves, 'Restored')), [])
  assert.equal(await fs.readFile(path.join(f.saves, name, 'level.dat'), 'utf8'), 'original inert level')
  assert.equal((await inspectWorldRestoreRecovery(f.staging, f.saves)).blocked, false)
})

test('completion is historical: subsequent play edits, move and deletion do not lock the instance', async t => {
  const f = await fixture(t)
  await publishWorldRestore(f.transaction, f.saves, 'Restored', f.entries)
  await fs.writeFile(path.join(f.saves, 'Restored', 'level.dat'), 'played changed data')
  assert.equal((await inspectWorldRestoreRecovery(f.staging, f.saves)).blocked, false)
  await fs.rename(path.join(f.saves, 'Restored'), path.join(f.root, 'moved'))
  assert.equal((await inspectWorldRestoreRecovery(f.staging, f.saves)).blocked, false)
})

test('incomplete, unknown and malformed journals fail closed without altering any evidence', async t => {
  const f = await fixture(t)
  assert.equal((await inspectWorldRestoreRecovery(f.staging, f.saves)).blocked, true)
  const intent = await fs.readFile(path.join(f.transaction.directory, 'intent.json'))
  await assert.rejects(beginWorldRestoreTransaction(f.staging), WorldRestoreRecoveryError)
  assert.deepEqual(await fs.readFile(path.join(f.transaction.directory, 'intent.json')), intent)
  await fs.writeFile(path.join(f.staging, 'unknown-file'), 'external bytes')
  assert.equal((await inspectWorldRestoreRecovery(f.staging, f.saves)).blocked, true)
  assert.equal(await fs.readFile(path.join(f.staging, 'unknown-file'), 'utf8'), 'external bytes')
})

test('a partial target write keeps the reserved world and journal and never marks complete', async t => {
  const f = await fixture(t), original = fs.open
  patch(t, 'open', (async (name: PathLike, ...args: unknown[]) => {
    if (String(name) === path.join(f.saves, 'Restored', 'level.dat')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    return original(name, ...(args as [Parameters<typeof fs.open>[1]]))
  }) as typeof fs.open)
  await assert.rejects(publishWorldRestore(f.transaction, f.saves, 'Restored', f.entries), /disk full/)
  assert.ok((await fs.lstat(path.join(f.saves, 'Restored', 'empty'))).isDirectory())
  await assert.rejects(fs.access(path.join(f.transaction.directory, 'COMPLETE.json')))
  const status = await inspectWorldRestoreRecovery(f.staging, f.saves)
  assert.equal(status.blocked, true); assert.deepEqual(status.blockedNames, ['Restored'])
})

test('source payload edits are rejected before target reservation and preserved for inspection', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.transaction.payload, 'level.dat'), 'tampered inert level')
  await assert.rejects(publishWorldRestore(f.transaction, f.saves, 'Restored', f.entries), WorldRestoreRecoveryError)
  assert.deepEqual(await fs.readdir(f.saves), [])
  assert.equal(await fs.readFile(path.join(f.transaction.payload, 'level.dat'), 'utf8'), 'tampered inert level')
})

test('cancellation during publication preserves the incomplete reservation and blocks restart', async t => {
  const f = await fixture(t), original = fs.mkdir, controller = new AbortController()
  patch(t, 'mkdir', (async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await original(...args)
    if (String(args[0]) === path.join(f.saves, 'Restored', 'empty')) controller.abort()
    return result
  }) as typeof fs.mkdir)
  await assert.rejects(publishWorldRestore(f.transaction, f.saves, 'Restored', f.entries, controller.signal), { name: 'AbortError' })
  assert.ok((await fs.lstat(path.join(f.saves, 'Restored'))).isDirectory())
  assert.equal((await inspectWorldRestoreRecovery(f.staging, f.saves)).blocked, true)
})

test('proven commit wins a lost link acknowledgement and late cancellation', async t => {
  const f = await fixture(t), original = fs.link, controller = new AbortController()
  patch(t, 'link', (async (...args: Parameters<typeof fs.link>) => {
    await original(...args)
    controller.abort()
    throw Object.assign(new Error('ack lost'), { code: 'EIO' })
  }) as typeof fs.link)
  assert.equal(await publishWorldRestore(f.transaction, f.saves, 'Restored', f.entries, controller.signal), 'Restored')
  assert.equal((await inspectWorldRestoreRecovery(f.staging, f.saves)).blocked, false)
})

test('an unprovable commit is recovery-required even if cancellation also arrives', async t => {
  const f = await fixture(t), controller = new AbortController()
  patch(t, 'link', (async () => { controller.abort(); throw Object.assign(new Error('link failed'), { code: 'EIO' }) }) as typeof fs.link)
  await assert.rejects(publishWorldRestore(f.transaction, f.saves, 'Restored', f.entries, controller.signal), WorldRestoreRecoveryError)
  assert.equal((await inspectWorldRestoreRecovery(f.staging, f.saves)).blocked, true)
})

test('extra disk copy is preflighted and ENOSPC never creates a visible target', async t => {
  const f = await fixture(t)
  patch(t, 'statfs', (async () => ({ bavail: 0, bsize: 4096 })) as unknown as typeof fs.statfs)
  await assert.rejects(publishWorldRestore(f.transaction, f.saves, 'Restored', f.entries), /空间不足/)
  assert.deepEqual(await fs.readdir(f.saves), [])
  assert.equal((await inspectWorldRestoreRecovery(f.staging, f.saves)).blocked, true)
})

test('edited completion controls revoke historical completion without deleting the restored world', async t => {
  const f = await fixture(t)
  await publishWorldRestore(f.transaction, f.saves, 'Restored', f.entries)
  await fs.writeFile(path.join(f.transaction.directory, 'target.json'), '{}')
  assert.equal((await inspectWorldRestoreRecovery(f.staging, f.saves)).blocked, true)
  assert.equal(await fs.readFile(path.join(f.saves, 'Restored', 'level.dat'), 'utf8'), 'original inert level')
})

test('a maximum-length preferred name remains usable when a collision needs a suffix', async t => {
  const f = await fixture(t), preferred = '界'.repeat(80)
  await fs.mkdir(path.join(f.saves, preferred))
  const result = await publishWorldRestore(f.transaction, f.saves, preferred, f.entries)
  assert.equal(result, `${'界'.repeat(76)} (2)`)
  assert.equal((await inspectWorldRestoreRecovery(f.staging, f.saves)).blocked, false)
})

test('static ancestor directory links are rejected before creating anything in an external saves root', async t => {
  const f = await fixture(t), external = path.join(f.root, 'external'), game = path.join(f.root, 'linked-game')
  await fs.mkdir(external)
  await fs.symlink(external, game, 'junction')
  await assert.rejects(publishWorldRestore(f.transaction, path.join(game, 'saves'), 'Imported', f.entries), WorldRestoreRecoveryError)
  assert.deepEqual(await fs.readdir(external), [])
  await assert.rejects(beginWorldRestoreTransaction(path.join(game, '.restore-staging')), WorldRestoreRecoveryError)
  assert.deepEqual(await fs.readdir(external), [])
})
