import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { LauncherCore, type Instance } from './core'
import { beginWorldRestoreTransaction } from './world-restore-transaction'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const selection = { name: 'Existing', itemId: `worlds:${hash('Existing')}` }
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-restore-recovery-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const id = randomUUID(), idB = randomUUID()
  const instances: Instance[] = [id, idB].map((value, index) => ({ id: value, name: `Fixture ${index}`, version: '1.20.1', loader: 'fabric', loaderVersion: '0.19.5', status: 'ready', createdAt: '2026-10-24T00:00:00.000Z', playtimeMs: 0 }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances, settings: { javaPath: '', memoryMode: 'auto', memoryMb: 4096, concurrentDownloads: 4 } }))
  const directory = path.join(root, 'instances', id), saves = path.join(directory, 'game', 'saves'), staging = path.join(directory, '.restore-staging')
  await fs.mkdir(path.join(saves, 'Existing'), { recursive: true })
  await fs.writeFile(path.join(saves, 'Existing', 'level.dat'), 'original inert source')
  const requests: string[] = []
  const makeCore = () => new LauncherCore(root, () => {}, {
    fetch: async url => { requests.push(String(url)); throw new Error('No network in recovery tests') },
    spawn: (() => { throw new Error('Never execute Java or game') }) as NonNullable<ConstructorParameters<typeof LauncherCore>[2]>['spawn'],
    javaRuntimeManager: { ensure: async () => { throw new Error('No Java preparation') }, discover: async () => [] },
  })
  const core = makeCore(); await core.init()
  return { root, id, idB, directory, saves, staging, requests, core, makeCore }
}

test('an interrupted restore is blocked before credentials, mutation and world reads, including restart', async t => {
  const f = await fixture(t)
  const transaction = await beginWorldRestoreTransaction(f.staging)
  await fs.writeFile(path.join(transaction.payload, 'level.dat'), 'partial inert content')
  const before = await fs.readFile(path.join(transaction.directory, 'intent.json'))
  await assert.rejects(f.core.assertInstanceUsable(f.id), /恢复资料/)
  assert.throws(() => f.core.assertLaunchAvailable(f.id))
  await assert.rejects(f.core.inventory(f.id, 'worlds'), /恢复资料/)
  await assert.rejects(f.core.worldMap(f.id, selection), /恢复资料/)
  await assert.rejects(f.core.worldDetails(f.id, selection), /未完成|刷新|恢复资料/)
  await assert.rejects(f.core.updateInstanceSettings(f.id, { name: 'changed', options: {} }), /恢复资料/)
  await assert.rejects(f.core.duplicateInstance(f.id, 'copy'), /恢复资料/)
  await assert.rejects(f.core.backupWorld(f.id, selection, { operationId: randomUUID(), closedExternalWorldConfirmed: true }), /恢复资料|人工检查/)
  await assert.rejects(f.core.install(f.id), /恢复资料/)
  assert.deepEqual(f.requests, [])
  assert.deepEqual(await fs.readFile(path.join(transaction.directory, 'intent.json')), before)
  assert.equal(await fs.readFile(path.join(f.saves, 'Existing', 'level.dat'), 'utf8'), 'original inert source')
  const reopened = f.makeCore(); await reopened.init()
  assert.equal(reopened.snapshot().instances.find(item => item.id === f.id)?.status, 'error')
  await assert.rejects(reopened.assertInstanceUsable(f.id), /恢复资料/)
  await reopened.assertInstanceUsable(f.idB)
})

test('a newly completed import can be launched and its historical journal stays valid after world edits', async t => {
  const f = await fixture(t)
  const zip = new AdmZip(); zip.addFile('Map/level.dat', Buffer.from('inert map bytes'))
  const file = path.join(f.root, 'map.zip'); zip.writeZip(file)
  const result = await f.core.importWorldZip(f.id, file, 'Imported')
  assert.equal(result.folderName, 'Imported')
  await f.core.assertInstanceUsable(f.id)
  f.core.assertLaunchAvailable(f.id)
  await fs.writeFile(path.join(f.saves, 'Imported', 'level.dat'), 'later normal play edits')
  const reopened = f.makeCore(); await reopened.init()
  await reopened.assertInstanceUsable(f.id)
  assert.equal(reopened.snapshot().instances.find(item => item.id === f.id)?.status, 'ready')
  assert.deepEqual(f.requests, [])
})

test('inventory waiting at recovery inspection cannot publish a partial world created by a later failed import', async t => {
  const f = await fixture(t), originalLstat = fs.lstat, originalOpen = fs.open
  let release!: () => void, entered!: () => void, once = true
  const gate = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
  fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
    if (once && String(args[0]) === f.staging) {
      once = false; entered(); await gate
      throw Object.assign(new Error('old absent snapshot'), { code: 'ENOENT' })
    }
    return originalLstat(...args)
  }) as typeof fs.lstat
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === path.join(f.saves, 'Partial', 'level.dat')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    return originalOpen(...args)
  }) as typeof fs.open
  syncBuiltinESMExports()
  t.after(() => { release(); fs.lstat = originalLstat; fs.open = originalOpen; syncBuiltinESMExports() })
  const rejected = assert.rejects(f.core.inventory(f.id, 'worlds'), /取消|变化|恢复资料/)
  await reached
  const zip = new AdmZip(); zip.addFile('level.dat', Buffer.from('inert partial map'))
  const file = path.join(f.root, 'partial.zip'); zip.writeZip(file)
  await assert.rejects(f.core.importWorldZip(f.id, file, 'Partial'), /未完成|恢复资料/)
  release()
  await rejected
  assert.ok((await fs.lstat(path.join(f.saves, 'Partial'))).isDirectory())
  await assert.rejects(f.core.inventory(f.id, 'worlds'), /恢复资料/)
  assert.equal(await fs.readFile(path.join(f.saves, 'Existing', 'level.dat'), 'utf8'), 'original inert source')
})
