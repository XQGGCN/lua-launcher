import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { PackSelections } from './pack-selection'

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
