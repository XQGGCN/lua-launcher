import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { LauncherCore, type CoreEvent, type Instance } from './core'
import type { WorldSelection } from './world-types'

type Options = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const selection = (name = 'Export Fixture'): WorldSelection => ({ name, itemId: `worlds:${digest(name)}` })

async function fixture(t: TestContext, options: Options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-world-zip-'))
  const instances: Instance[] = Array.from({ length: 2 }, (_, index) => ({ id: randomUUID(), name: `Fixture ${index}`,
    version: '1.20.1', loader: 'fabric', loaderVersion: '0.19.5', status: 'ready',
    createdAt: '2026-10-21T00:00:00.000Z', playtimeMs: 0 }))
  await fs.writeFile(path.join(root, 'launcher.json'), JSON.stringify({ schema: 1, instances,
    settings: { memoryMode: 'auto', memoryMb: 4096, javaPath: '', concurrentDownloads: 4 } }))
  for (const instance of instances) {
    const world = path.join(root, 'instances', instance.id, 'game', 'saves', selection().name)
    await fs.mkdir(path.join(world, 'region'), { recursive: true })
    await fs.writeFile(path.join(world, 'level.dat'), `fixture ${instance.id}`)
    await fs.writeFile(path.join(world, 'region', 'r.0.0.mca'), Buffer.alloc(200_003, 9))
  }
  const events: CoreEvent[] = [], requests: string[] = []
  const core = new LauncherCore(root, event => { events.push(event) }, {
    fetch: async input => { requests.push(String(input)); throw new Error('No network in world zip tests') },
    spawn: (() => { throw new Error('Never execute Java or a game in this suite') }) as Options['spawn'],
    javaRuntimeManager: { ensure: async () => { throw new Error('No Java preparation') }, discover: async () => [] },
    ...options,
  })
  await core.init()
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  const id = (index = 0) => instances[index].id
  const backup = (index = 0) => core.backupWorld(id(index), selection(), { operationId: randomUUID(), closedExternalWorldConfirmed: true })
  return { root, core, events, requests, id, backup }
}

test('core exports a completed backup to a verified ZIP, lists it per instance and never exposes paths', async t => {
  const f = await fixture(t)
  const completed = await f.backup()
  const before = await fs.readFile(path.join(f.root, 'launcher.json'))
  f.events.length = 0
  const operationId = randomUUID()
  const result = await f.core.exportWorldBackup(f.id(), completed.backupId, operationId)
  assert.equal(result.backupId, completed.backupId); assert.equal(result.worldFolderName, selection().name)
  const file = await f.core.worldExportPath(f.id(), result.exportId)
  assert.ok(file.startsWith(path.join(f.root, 'world-exports', f.id())))
  assert.deepEqual(new AdmZip(file).readFile('world/region/r.0.0.mca'), Buffer.alloc(200_003, 9))
  const listed = await f.core.worldExports(f.id())
  assert.deepEqual(listed.items.map(item => item.exportId), [result.exportId])
  assert.deepEqual((await f.core.worldExports(f.id(1))).items, [])
  await assert.rejects(f.core.worldExportPath(f.id(1), result.exportId))
  assert.equal((await f.core.verifyWorldExport(f.id(), result.exportId)).archiveSha256, result.archiveSha256)
  const tasks = f.core.worldExportTasks()
  assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'complete'); assert.equal(tasks[0].id, operationId)
  assert.ok(f.events.length > 0 && f.events.every(event => event.type === 'worldExportTask'))
  assert.equal(JSON.stringify({ result, listed, tasks }).includes(f.root), false)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'launcher.json')), before)
  assert.deepEqual(f.requests, [])
  await assert.rejects(f.core.exportWorldBackup(f.id(), completed.backupId, operationId), /已提交/)
})

test('core rejects invalid identifiers, a backup of another instance, and concurrent exports; cancel is honoured', async t => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(t, {
    worldZipExporter: async (_root, instanceId, backupId, options) => {
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) return reject(new DOMException('cancelled', 'AbortError'))
        options.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))
        void gate.then(resolve)
      })
      throw new Error(`unexpected completion ${instanceId} ${backupId}`)
    },
  })
  const completed = await f.backup()
  await assert.rejects(f.core.exportWorldBackup(f.id(), 'not-a-uuid', randomUUID()), /备份标识无效/)
  await assert.rejects(f.core.exportWorldBackup(f.id(), completed.backupId, 'x'), /任务标识无效/)
  await assert.rejects(f.core.exportWorldBackup('missing', completed.backupId, randomUUID()))
  const operationId = randomUUID()
  const running = f.core.exportWorldBackup(f.id(), completed.backupId, operationId)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.core.exportWorldBackup(f.id(1), completed.backupId, randomUUID()), /已有 ZIP 导出/)
  f.core.cancelWorldExport(f.id(1), operationId) // wrong instance: ignored
  f.core.cancelWorldExport(f.id(), operationId)
  await assert.rejects(running, /已取消/)
  assert.equal(f.core.worldExportTasks().find(task => task.id === operationId)?.status, 'cancelled')
  release()
})

test('real exporter refuses a backup id that belongs to a different instance', async t => {
  const f = await fixture(t)
  const completed = await f.backup(0)
  await assert.rejects(f.core.exportWorldBackup(f.id(1), completed.backupId, randomUUID()), /备份不完整或记录无效/)
  assert.deepEqual((await f.core.worldExports(f.id(1))).items, [])
})
