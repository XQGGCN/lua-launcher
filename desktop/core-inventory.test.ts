import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { LauncherCore, type CoreEvent } from './core'
import type { InventoryKind, InventoryScanOptions, ResourceInventory, scanResourceInventory } from './resource-inventory'

type CoreOptions = NonNullable<ConstructorParameters<typeof LauncherCore>[2]>
const kinds: InventoryKind[] = ['mods', 'resourcepacks', 'shaderpacks', 'worlds']

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}

function inventoryResult(kind: InventoryKind): ResourceInventory {
  return {
    kind, observedAt: '2026-10-21T00:00:00.000Z', truncated: false,
    items: [{ id: `${kind}:fixture`, name: 'fixture.jar', relativePath: `${kind}/fixture.jar`,
      entryType: 'file', sizeBytes: 12, modifiedAt: '2026-10-21T00:00:00.000Z', activation: 'unknown',
      recordedSource: { source: 'modrinth', projectId: 'project', versionId: 'version' } }],
    warnings: [{ code: 'entry-unavailable', message: 'Fixture warning', relativePath: `${kind}/gone.jar` }],
  }
}

function scannerGates() {
  const calls: Array<{ directory: string; kind: InventoryKind; options: InventoryScanOptions;
    result: ReturnType<typeof deferred<ResourceInventory>> }> = []
  const waiters: Array<{ count: number; resolve: () => void }> = []
  const scanner: typeof scanResourceInventory = async (directory, kind, options = {}) => {
    const result = deferred<ResourceInventory>()
    calls.push({ directory, kind, options, result })
    for (const waiter of waiters) if (calls.length >= waiter.count) waiter.resolve()
    return result.promise
  }
  const waitForCalls = (count: number) => calls.length >= count ? Promise.resolve() : new Promise<void>(resolve => waiters.push({ count, resolve }))
  return { scanner, calls, waitForCalls }
}

async function fixture(t: TestContext, overrides: CoreOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-core-inventory-'))
  const events: CoreEvent[] = []
  let networkCalls = 0
  const core = new LauncherCore(root, event => events.push(event), {
    fetch: async () => { networkCalls++; throw new Error('Inventory must not request the network') },
    ...overrides,
  })
  await core.init()
  // Creating fixture records uses an isolated catalogue, never a network request.
  core.versions = async () => [{ id: '1.20.1', type: 'release', releaseTime: '2023-06-12T00:00:00Z' }]
  const create = (name = 'Inventory fixture') => core.createInstance({ name, version: '1.20.1', loader: 'vanilla' })
  t.after(async () => { core.cancelPendingOperations(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, core, events, create, networkCalls: () => networkCalls }
}

/** Test-owned regular files only: captures bytes, mode and mtime, excluding read access time. */
async function treeFingerprint(root: string) {
  const entries: Array<{ file: string; type: string; mode: number; modified: number; hash?: string }> = []
  const visit = async (directory: string) => {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name)
      const info = await fs.lstat(file)
      assert.ok(info.isFile() || info.isDirectory())
      entries.push({ file: path.relative(root, file), type: info.isFile() ? 'file' : 'directory',
        mode: info.mode, modified: info.mtimeMs,
        ...(info.isFile() ? { hash: createHash('sha256').update(await fs.readFile(file)).digest('hex') } : {}) })
      if (info.isDirectory()) await visit(file)
    }
  }
  await visit(root)
  return entries
}

test('production scanner inventories four fixed instance folders and historical mod sources without writes, network or state events', async t => {
  const f = await fixture(t)
  const instance = await f.create()
  const game = f.core.getInstancePath(instance.id)
  const folderNames = { mods: 'mods', resourcepacks: 'resourcepacks', shaderpacks: 'shaderpacks', worlds: 'saves' }
  for (const folder of Object.values(folderNames)) await fs.mkdir(path.join(game, folder))
  await fs.writeFile(path.join(game, 'mods', 'first.jar'), 'first local file')
  await fs.writeFile(path.join(game, 'mods', 'second.jar'), 'second local file')
  await fs.writeFile(path.join(game, 'mods', 'manual.jar.disabled'), 'disabled local file')
  await fs.mkdir(path.join(game, 'mods', 'nested'))
  await fs.writeFile(path.join(game, 'mods', 'nested', 'not-recursive.jar'), 'nested contents')
  await fs.writeFile(path.join(game, 'resourcepacks', 'resources.zip'), 'local resource pack')
  await fs.writeFile(path.join(game, 'shaderpacks', 'shaders.zip'), 'local shader pack')
  await fs.mkdir(path.join(game, 'saves', 'My World'))
  await fs.writeFile(path.join(game, 'saves', 'My World', 'level.dat'), 'not parsed as NBT')
  await fs.mkdir(path.join(game, 'worlds'))
  await fs.writeFile(path.join(game, 'worlds', 'wrong-folder.txt'), 'must not be enumerated')
  await fs.writeFile(path.join(f.root, 'outside.jar'), 'must not be enumerated')
  const registry = path.join(f.core.instanceDirectory(instance.id), 'managed-mods.json')
  await fs.writeFile(registry, JSON.stringify({
    legacyProject: { versionId: 'legacyVersion', filename: 'first.jar' },
    'bbsmc:secondProject': { versionId: 'bbsVersion', filename: 'second.jar' },
  }, null, 2))
  const beforeTree = await treeFingerprint(f.root)
  const beforeState = f.core.snapshot()
  const beforeEvents = f.events.length
  const [mods, resourcepacks, shaderpacks, worlds] = await Promise.all(kinds.map(kind => f.core.inventory(instance.id, kind)))
  for (const result of [mods, resourcepacks, shaderpacks, worlds]) {
    assert.equal(result.instanceId, instance.id)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.warnings, [])
    assert.ok(Number.isFinite(Date.parse(result.observedAt)))
    assert.ok(result.items.every(item => !path.isAbsolute(item.relativePath) && !item.relativePath.includes('..')))
  }
  assert.deepEqual(mods.items.map(item => item.name), ['first.jar', 'manual.jar.disabled', 'nested', 'second.jar'])
  assert.deepEqual(mods.items.find(item => item.name === 'first.jar')!.recordedSource,
    { source: 'modrinth', projectId: 'legacyProject', versionId: 'legacyVersion' })
  assert.deepEqual(mods.items.find(item => item.name === 'second.jar')!.recordedSource,
    { source: 'bbsmc', projectId: 'secondProject', versionId: 'bbsVersion' })
  assert.equal(mods.items.find(item => item.name === 'manual.jar.disabled')!.activation, 'disabled-suffix')
  assert.deepEqual(resourcepacks.items.map(item => item.relativePath), ['resourcepacks/resources.zip'])
  assert.deepEqual(shaderpacks.items.map(item => item.relativePath), ['shaderpacks/shaders.zip'])
  assert.deepEqual(worlds.items.map(item => item.relativePath), ['saves/My World'])
  assert.equal(worlds.items[0].sizeBytes, undefined)
  assert.deepEqual(await treeFingerprint(f.root), beforeTree)
  assert.deepEqual(f.core.snapshot(), beforeState)
  assert.equal(f.events.length, beforeEvents)
  assert.equal(f.networkCalls(), 0)
})

test('missing resource folders return empty results without creating folders or modifying launcher state', async t => {
  const f = await fixture(t)
  const instance = await f.create()
  const before = await treeFingerprint(f.root)
  for (const kind of kinds) {
    const result = await f.core.inventory(instance.id, kind)
    assert.equal(result.kind, kind)
    assert.deepEqual(result.items, [])
    assert.deepEqual(result.warnings, [])
    assert.equal(result.truncated, false)
  }
  assert.deepEqual(await treeFingerprint(f.root), before)
  assert.equal(f.networkCalls(), 0)
})

test('invalid IDs and kinds are rejected before scanning; valid calls receive only core-owned paths', async t => {
  const calls: Array<{ directory: string; kind: InventoryKind; options: InventoryScanOptions }> = []
  const f = await fixture(t, { inventoryScanner: async (directory, kind, options = {}) => {
    calls.push({ directory, kind, options }); return inventoryResult(kind)
  } })
  const instance = await f.create()
  for (const id of ['', '../outside', '/tmp', '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(f.core.inventory(id, 'mods'), /实例不存在/)
  }
  for (const kind of ['', '../mods', 'saves', '__proto__', 'constructor', null, {}]) {
    await assert.rejects(f.core.inventory(instance.id, kind as InventoryKind), /资源类型/)
  }
  assert.equal(calls.length, 0)
  for (const kind of kinds) await f.core.inventory(instance.id, kind)
  assert.equal(calls.length, 4)
  for (const call of calls) {
    assert.equal(call.directory, path.join(f.root, 'instances', instance.id, 'game'))
    assert.ok(call.options.signal instanceof AbortSignal)
    assert.equal(call.options.managedModsFile, call.kind === 'mods'
      ? path.join(f.root, 'instances', instance.id, 'managed-mods.json') : undefined)
  }
  assert.equal(f.networkCalls(), 0)
})

test('same instance and kind share only the pending work and give each caller independent deep results', async t => {
  const gates = scannerGates()
  const f = await fixture(t, { inventoryScanner: gates.scanner })
  const instance = await f.create()
  const first = f.core.inventory(instance.id, 'mods')
  const second = f.core.inventory(instance.id, 'mods')
  assert.equal(gates.calls.length, 1)
  const original = inventoryResult('mods')
  gates.calls[0].result.resolve(original)
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  a.items[0].name = 'changed by caller'
  a.items[0].recordedSource!.versionId = 'changed'
  a.warnings[0].message = 'changed'
  assert.equal(b.items[0].name, 'fixture.jar')
  assert.equal(b.items[0].recordedSource!.versionId, 'version')
  assert.equal(b.warnings[0].message, 'Fixture warning')
  assert.equal(original.items[0].name, 'fixture.jar')
  const refreshed = f.core.inventory(instance.id, 'mods')
  assert.equal(gates.calls.length, 2)
  gates.calls[1].result.resolve(inventoryResult('mods'))
  assert.equal((await refreshed).items[0].name, 'fixture.jar')
})

test('a failed shared scan releases its key and allows a fresh retry', async t => {
  const gates = scannerGates()
  const f = await fixture(t, { inventoryScanner: gates.scanner })
  const instance = await f.create()
  const failed = [f.core.inventory(instance.id, 'mods'), f.core.inventory(instance.id, 'mods')]
    .map(result => assert.rejects(result, /isolated scan failure/))
  gates.calls[0].result.reject(new Error('isolated scan failure'))
  await Promise.all(failed)
  const retry = f.core.inventory(instance.id, 'mods')
  assert.equal(gates.calls.length, 2)
  gates.calls[1].result.resolve(inventoryResult('mods'))
  await retry
})

test('at most four unique scans run globally while an existing key remains shareable at capacity', async t => {
  const gates = scannerGates()
  const f = await fixture(t, { inventoryScanner: gates.scanner })
  const first = await f.create('First')
  const second = await f.create('Second')
  const pending = kinds.map(kind => f.core.inventory(first.id, kind))
  const duplicate = f.core.inventory(first.id, 'mods')
  await assert.rejects(f.core.inventory(second.id, 'mods'), /任务较多/)
  await gates.waitForCalls(4)
  assert.equal(gates.calls.length, 4)
  gates.calls[0].result.resolve(inventoryResult('mods'))
  await Promise.all([pending[0], duplicate])
  const fifth = f.core.inventory(second.id, 'mods')
  assert.equal(gates.calls.length, 5)
  for (let i = 1; i < gates.calls.length; i++) gates.calls[i].result.resolve(inventoryResult(gates.calls[i].kind))
  const results = await Promise.all([...pending, fifth])
  assert.equal(results[4].instanceId, second.id)
})

test('shutdown cancellation reaches every scanner and shared subscriber, then releases all scan slots', async t => {
  const signals: AbortSignal[] = []
  const allStarted = deferred()
  let respond = false
  const f = await fixture(t, { inventoryScanner: async (_directory, kind, options = {}) => {
    assert.ok(options.signal)
    signals.push(options.signal)
    if (signals.length === 4) allStarted.resolve()
    if (respond) return inventoryResult(kind)
    return new Promise<ResourceInventory>((_resolve, reject) => {
      options.signal!.throwIfAborted()
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    })
  } })
  const first = await f.create('First')
  const second = await f.create('Second')
  const pending = [...kinds.map(kind => f.core.inventory(first.id, kind)), f.core.inventory(first.id, 'mods')]
  const rejections = pending.map(result => assert.rejects(result, { name: 'AbortError' }))
  await allStarted.promise
  assert.equal(signals.length, 4)
  f.core.cancelPendingOperations()
  assert.ok(signals.every(signal => signal.aborted))
  await Promise.all(rejections)
  respond = true
  assert.equal((await f.core.inventory(second.id, 'mods')).instanceId, second.id)
  for (const kind of kinds) await f.core.inventory(first.id, kind)
  assert.equal(f.networkCalls(), 0)
})

test('a scanner that completes after shutdown cannot publish a successful late result', async t => {
  const gates = scannerGates()
  const f = await fixture(t, { inventoryScanner: gates.scanner })
  const instance = await f.create()
  const pending = assert.rejects(f.core.inventory(instance.id, 'mods'), { name: 'AbortError' })
  f.core.cancelPendingOperations()
  assert.equal(gates.calls[0].options.signal!.aborted, true)
  gates.calls[0].result.resolve(inventoryResult('mods'))
  await pending
  const retry = f.core.inventory(instance.id, 'mods')
  assert.equal(gates.calls.length, 2)
  assert.equal(gates.calls[1].options.signal!.aborted, false)
  gates.calls[1].result.resolve(inventoryResult('mods'))
  await retry
})

async function installGateFixture(t: TestContext, scanner: typeof scanResourceInventory) {
  const entered = deferred()
  const release = deferred()
  let hold = false
  const f = await fixture(t, { inventoryScanner: scanner, stateRename: async (source, target) => {
    if (hold) { hold = false; entered.resolve(); await release.promise }
    await fs.rename(source, target)
  } })
  const instance = await f.create()
  return { ...f, instance, entered, release, start: () => { hold = true; return f.core.install(instance.id) } }
}

test('an installing instance rejects inventory before calling the scanner and becomes scannable after cancellation', async t => {
  let calls = 0
  const f = await installGateFixture(t, async (_directory, kind) => { calls++; return inventoryResult(kind) })
  const installing = assert.rejects(f.start(), /安装已取消/)
  await f.entered.promise
  try {
    await assert.rejects(f.core.inventory(f.instance.id, 'mods'), /正在安装/)
    assert.equal(calls, 0)
  } finally { f.core.cancelInstall(f.instance.id); f.release.resolve() }
  await installing
  assert.equal((await f.core.inventory(f.instance.id, 'mods')).instanceId, f.instance.id)
  assert.equal(calls, 1)
  assert.equal(f.networkCalls(), 0)
})

test('a scan result is rejected if installation begins while it is reading the instance', async t => {
  const gates = scannerGates()
  const f = await installGateFixture(t, gates.scanner)
  const other = await f.create('Unrelated instance')
  const scanning = assert.rejects(f.core.inventory(f.instance.id, 'mods'), { name: 'AbortError' })
  const unrelated = f.core.inventory(other.id, 'mods')
  const installing = assert.rejects(f.start(), /安装已取消/)
  await f.entered.promise
  try {
    assert.equal(gates.calls[0].options.signal!.aborted, true)
    assert.equal(gates.calls[1].options.signal!.aborted, false)
    gates.calls[0].result.resolve(inventoryResult('mods'))
    gates.calls[1].result.resolve(inventoryResult('mods'))
    await scanning
    assert.equal((await unrelated).instanceId, other.id)
  } finally { f.core.cancelInstall(f.instance.id); f.release.resolve() }
  await installing
  const retry = f.core.inventory(f.instance.id, 'mods')
  assert.equal(gates.calls.length, 3)
  gates.calls[2].result.resolve(inventoryResult('mods'))
  await retry
  assert.equal(f.networkCalls(), 0)
})

test('a scan spanning an entire completed mod install cannot publish its stale pre-install listing', async t => {
  const gates = scannerGates()
  const contents = 'new mod bytes supplied only by this isolated test'
  const downloadUrl = 'https://cdn.modrinth.com/data/inventory/version/new.jar'
  const requests: string[] = []
  const f = await fixture(t, { inventoryScanner: gates.scanner, fetch: async input => {
    const url = String(input)
    requests.push(url)
    if (url === downloadUrl) return new Response(contents)
    assert.equal(url, 'https://api.modrinth.com/v2/version/newVersion')
    return new Response(JSON.stringify({
      id: 'newVersion', project_id: 'newProject', name: 'Isolated inventory fixture',
      loaders: ['fabric'], game_versions: ['1.20.1'], dependencies: [],
      files: [{ filename: 'new.jar', url: downloadUrl, primary: true, size: Buffer.byteLength(contents),
        hashes: { sha1: createHash('sha1').update(contents).digest('hex') } }],
    }))
  } })
  const instance = await f.create()
  // Seed a ready Fabric record; no Java, loader installer or game is executed.
  const stateFile = path.join(f.root, 'launcher.json')
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  state.instances[0].loader = 'fabric'
  state.instances[0].status = 'ready'
  await fs.writeFile(stateFile, JSON.stringify(state))
  await f.core.init()
  const pending = f.core.inventory(instance.id, 'mods')
  const rejected = assert.rejects(pending, (error: unknown) =>
    error instanceof Error && (error.name === 'AbortError' || /安装|扫描.*变化/.test(error.message)))
  await f.core.installMod(instance.id, 'newVersion')
  assert.equal(await fs.readFile(path.join(f.core.getInstancePath(instance.id), 'mods', 'new.jar'), 'utf8'), contents)
  assert.equal(requests.length, 2)
  gates.calls[0].result.resolve({ ...inventoryResult('mods'), items: [] })
  await rejected
  const fresh = f.core.inventory(instance.id, 'mods')
  assert.equal(gates.calls.length, 2)
  gates.calls[1].result.resolve(inventoryResult('mods'))
  await fresh
})
