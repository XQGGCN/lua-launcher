import assert from 'node:assert/strict'
import type { Dir, Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import test, { type TestContext } from 'node:test'
import { INVENTORY_LIMITS, scanResourceInventory, type InventoryKind } from './resource-inventory'

const mutableFs = createRequire(import.meta.url)('node:fs/promises') as typeof fs
const folders = { mods: 'mods', resourcepacks: 'resourcepacks', shaderpacks: 'shaderpacks', worlds: 'saves' } as const
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-inventory-'))
  const game = path.join(root, 'game')
  await fs.mkdir(game)
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const registry = path.join(root, 'managed-mods.json')
  return { root, game, registry }
}
function hookFs<K extends keyof typeof fs>(t: TestContext, name: K, implementation: (typeof fs)[K]): () => void {
  const mocked = t.mock.method(mutableFs, name, implementation as never)
  syncBuiltinESMExports()
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports() }
  t.after(restore)
  return restore
}
function fakeDirectory(names: string[]) {
  let position = 0
  let closes = 0
  return {
    directory: {
      async read() { return position < names.length ? { name: names[position++] } as Dirent : null },
      async close() { closes++ },
    } as unknown as Dir,
    get reads() { return position },
    get closes() { return closes },
  }
}

for (const kind of Object.keys(folders) as InventoryKind[]) {
  test(`${kind} inventories only its fixed directory, with file sizes and no recursive directory inspection`, async t => {
    const f = await fixture(t)
    const directory = path.join(f.game, folders[kind])
    await fs.mkdir(path.join(directory, 'Folder Pack', 'nested'), { recursive: true })
    await fs.writeFile(path.join(directory, 'Folder Pack', 'nested', 'never-read.dat'), 'do not read archive/NBT contents')
    await fs.writeFile(path.join(directory, 'Zeta.jar.disabled'), 'not a valid archive')
    await fs.writeFile(path.join(directory, 'Alpha.zip'), '12345')
    const result = await scanResourceInventory(f.game, kind)
    assert.equal(result.kind, kind)
    assert.ok(Number.isFinite(Date.parse(result.observedAt)))
    assert.deepEqual(result.items.map(item => item.name), ['Alpha.zip', 'Folder Pack', 'Zeta.jar.disabled'])
    assert.deepEqual(result.items.map(item => item.relativePath), [
      `${folders[kind]}/Alpha.zip`, `${folders[kind]}/Folder Pack`, `${folders[kind]}/Zeta.jar.disabled`,
    ])
    assert.equal(result.items[0].sizeBytes, 5)
    assert.equal(result.items[0].formatHint, 'zip')
    assert.equal(result.items[0].activation, 'unknown')
    assert.equal(result.items[1].entryType, 'directory')
    assert.equal(Object.hasOwn(result.items[1], 'sizeBytes'), false)
    assert.equal(result.items[1].formatHint, undefined)
    assert.equal(result.items[2].formatHint, 'jar')
    assert.equal(result.items[2].activation, 'disabled-suffix')
    assert.equal(result.truncated, false)
    assert.deepEqual(result.warnings, [])
  })
}

test('missing resource or game directories return empty without creating anything', async t => {
  const f = await fixture(t)
  assert.deepEqual((await scanResourceInventory(f.game, 'mods')).items, [])
  const absentGame = path.join(f.root, 'does-not-exist', 'game')
  assert.deepEqual((await scanResourceInventory(absentGame, 'worlds')).items, [])
  assert.deepEqual(await fs.readdir(f.game), [])
  await assert.rejects(fs.access(path.dirname(absentGame)), { code: 'ENOENT' })
})

test('IDs and ordering depend on original filenames rather than metadata or directory enumeration order', async t => {
  const f = await fixture(t)
  const directory = path.join(f.game, 'mods')
  await fs.mkdir(directory)
  for (const name of ['Z.jar', 'b.jar', 'A.jar']) await fs.writeFile(path.join(directory, name), 'first')
  const first = await scanResourceInventory(f.game, 'mods')
  await fs.writeFile(path.join(directory, 'A.jar'), 'changed bytes with a different size')
  const second = await scanResourceInventory(f.game, 'mods')
  assert.deepEqual(first.items.map(item => item.name), ['A.jar', 'b.jar', 'Z.jar'])
  assert.deepEqual(first.items.map(item => item.id), second.items.map(item => item.id))
  assert.equal(new Set(first.items.map(item => item.id)).size, 3)
  assert.notEqual(first.items[0].sizeBytes, second.items[0].sizeBytes)
})

test('source attribution is historical only, supports legacy IDs without rewriting registry, and does not infer renamed disabled files', async t => {
  const f = await fixture(t)
  const directory = path.join(f.game, 'mods')
  await fs.mkdir(directory)
  for (const name of ['first.jar', 'second.jar', 'third.jar.disabled', 'manual.jar']) {
    await fs.writeFile(path.join(directory, name), 'arbitrary local contents, not verified as a downloaded resource')
  }
  const registry = JSON.stringify({
    oldProject: { versionId: 'oldVersion', filename: 'first.jar' },
    'modrinth:oldProject': { versionId: 'oldVersion', filename: 'first.jar' },
    'bbsmc:second': { versionId: 'bbsVersion', filename: 'second.jar' },
    'modrinth:third': { versionId: 'thirdVersion', filename: 'third.jar' },
  })
  await fs.writeFile(f.registry, registry)
  const result = await scanResourceInventory(f.game, 'mods', { managedModsFile: f.registry })
  const byName = new Map(result.items.map(item => [item.name, item]))
  assert.deepEqual(byName.get('first.jar')!.recordedSource, { source: 'modrinth', projectId: 'oldProject', versionId: 'oldVersion' })
  assert.deepEqual(byName.get('second.jar')!.recordedSource, { source: 'bbsmc', projectId: 'second', versionId: 'bbsVersion' })
  assert.equal(byName.get('third.jar.disabled')!.recordedSource, undefined)
  assert.equal(byName.get('third.jar.disabled')!.activation, 'disabled-suffix')
  assert.equal(byName.get('manual.jar')!.recordedSource, undefined)
  assert.equal(byName.get('first.jar')!.activation, 'unknown')
  assert.equal(await fs.readFile(f.registry, 'utf8'), registry)
  assert.deepEqual(result.warnings, [])
})

test('malformed, oversized or ill-shaped source registries never suppress inventory or claim sources', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.game, 'mods'))
  await fs.writeFile(path.join(f.game, 'mods', 'test.jar'), 'fixture')
  const invalid: Array<string | Buffer> = [
    '{', '[]', 'null', Buffer.from([0xff]), Buffer.alloc(INVENTORY_LIMITS.registryBytes + 1, 0x20),
    JSON.stringify({ 'other:project': { versionId: 'v', filename: 'test.jar' } }),
    JSON.stringify({ 'modrinth:project': { versionId: 1, filename: 'test.jar' } }),
    JSON.stringify({ 'modrinth:project': { versionId: 'v', filename: '../test.jar' } }),
    JSON.stringify({ 'modrinth:project': { versionId: 'v', filename: 'test.jar', extra: true } }),
    JSON.stringify({ project: { versionId: 'old', filename: 'test.jar' }, 'modrinth:project': { versionId: 'new', filename: 'test.jar' } }),
  ]
  for (const contents of invalid) {
    await fs.writeFile(f.registry, contents)
    const result = await scanResourceInventory(f.game, 'mods', { managedModsFile: f.registry })
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].recordedSource, undefined)
    assert.ok(result.warnings.some(warning => warning.code === 'registry-invalid'))
  }
})

test('multiple registry claims, including case/NFC collisions, are warned and never attached to files', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.game, 'mods'))
  await fs.writeFile(path.join(f.game, 'mods', 'shared.jar'), 'fixture')
  await fs.writeFile(path.join(f.game, 'mods', 'case-only.jar'), 'fixture')
  await fs.writeFile(f.registry, JSON.stringify({
    'modrinth:first': { versionId: 'v1', filename: 'shared.jar' },
    'bbsmc:second': { versionId: 'v2', filename: 'SHARED.jar' },
    'modrinth:unicode1': { versionId: 'v1', filename: '\u00e9.jar' },
    'bbsmc:unicode2': { versionId: 'v2', filename: 'e\u0301.jar' },
    'modrinth:caseOnly': { versionId: 'v', filename: 'CASE-ONLY.jar' },
  }))
  const result = await scanResourceInventory(f.game, 'mods', { managedModsFile: f.registry })
  assert.ok(result.items.every(item => item.recordedSource === undefined))
  assert.equal(result.warnings.filter(warning => warning.code === 'registry-conflict').length, 3)
})

test('case/NFC-colliding directory entries remain distinct but cannot be attributed on any platform', async t => {
  const f = await fixture(t)
  const directory = path.join(f.game, 'mods')
  await fs.mkdir(directory)
  const sample = path.join(f.root, 'sample')
  await fs.writeFile(sample, 'fixture')
  const info = await fs.lstat(sample)
  const names = ['a.jar', 'A.jar', '\u00e9.jar', 'e\u0301.jar']
  const fake = fakeDirectory(names)
  const originalStat = mutableFs.lstat
  const restoreStat = hookFs(t, 'lstat', (async (file: Parameters<typeof fs.lstat>[0], ...args: unknown[]) =>
    path.dirname(String(file)) === directory ? info : originalStat(file, ...args as [])) as typeof fs.lstat)
  const restoreDir = hookFs(t, 'opendir', (async () => fake.directory) as typeof fs.opendir)
  await fs.writeFile(f.registry, JSON.stringify({ project: { versionId: 'v', filename: 'a.jar' } }))
  try {
    const result = await scanResourceInventory(f.game, 'mods', { managedModsFile: f.registry })
    assert.equal(result.items.length, 4)
    assert.equal(new Set(result.items.map(item => item.id)).size, 4)
    assert.equal(result.warnings.filter(warning => warning.code === 'name-collision').length, 2)
    assert.ok(result.items.every(item => item.recordedSource === undefined))
    assert.equal(fake.closes, 1)
  } finally { restoreStat(); restoreDir() }
})

test('root symlinks, symlink ancestors, invalid paths and unexpected root errors reject clearly', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.game, 'mods'))
  const link = path.join(f.root, 'linked')
  await fs.symlink(f.game, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(scanResourceInventory(link, 'mods'), /符号链接|junction/)
  await fs.mkdir(path.join(f.game, 'nested', 'mods'), { recursive: true })
  await assert.rejects(scanResourceInventory(path.join(link, 'nested'), 'mods'), /符号链接|junction/)
  await assert.rejects(scanResourceInventory('relative', 'mods'), /绝对路径/)
  await assert.rejects(scanResourceInventory(path.parse(f.game).root, 'mods'), /根目录/)
  await assert.rejects(scanResourceInventory(f.game, '../outside' as InventoryKind), /类型/)
  const originalStat = mutableFs.lstat
  const restore = hookFs(t, 'lstat', (async (file: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
    if (String(file) === f.game) throw Object.assign(new Error('permission denied fixture'), { code: 'EACCES' })
    return originalStat(file, ...args as [])
  }) as typeof fs.lstat)
  try { await assert.rejects(scanResourceInventory(f.game, 'mods'), { code: 'EACCES' }) } finally { restore() }
})

test('resource-directory links reject and individual linked entries are skipped without reading targets', async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.txt'), 'untouched')
  await fs.symlink(outside, path.join(f.game, 'shaderpacks'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(scanResourceInventory(f.game, 'shaderpacks'), /符号链接|junction/)
  await fs.mkdir(path.join(f.game, 'mods'))
  await fs.symlink(outside, path.join(f.game, 'mods', 'linked.jar'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await scanResourceInventory(f.game, 'mods')
  assert.deepEqual(result.items, [])
  assert.equal(result.warnings[0].code, 'symbolic-link')
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'untouched')
})

test('unsafe filenames are skipped before accessing paths, including Windows device names on Unix', async t => {
  const f = await fixture(t)
  const directory = path.join(f.game, 'mods')
  await fs.mkdir(directory)
  const names = ['..', '../outside.jar', 'C:drive.jar', 'a\\b.jar', 'NUL.jar', 'COM1', 'LPT².txt', 'trailing.', 'trailing ', 'control\n.jar', 'bad\u202e.jar', '\ud800.jar', 'x'.repeat(256)]
  const fake = fakeDirectory(names)
  const originalStat = mutableFs.lstat
  const restoreStat = hookFs(t, 'lstat', (async (file: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
    assert.ok(!names.filter(name => name !== '..').some(name => String(file) === path.join(directory, name)),
      'unsafe names must not be used in a filesystem lookup')
    return originalStat(file, ...args as [])
  }) as typeof fs.lstat)
  const restoreDir = hookFs(t, 'opendir', (async () => fake.directory) as typeof fs.opendir)
  try {
    const result = await scanResourceInventory(f.game, 'mods')
    assert.deepEqual(result.items, [])
    assert.equal(result.warnings.length, names.length)
    assert.ok(result.warnings.every(warning => warning.code === 'unsafe-name' && warning.relativePath === undefined))
  } finally { restoreStat(); restoreDir() }
})

test('vanished, unreadable and non-regular entries leave usable partial results with warnings', async t => {
  const f = await fixture(t)
  const directory = path.join(f.game, 'mods')
  await fs.mkdir(directory)
  for (const name of ['good.jar', 'gone.jar', 'denied.jar', 'socket', 'invalid-size.jar']) await fs.writeFile(path.join(directory, name), 'fixture')
  const originalStat = mutableFs.lstat
  const restore = hookFs(t, 'lstat', (async (file: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
    const name = path.basename(String(file))
    if (name === 'gone.jar' || name === 'denied.jar') throw Object.assign(new Error('entry unavailable'), { code: name === 'gone.jar' ? 'ENOENT' : 'EACCES' })
    const info = await originalStat(file, ...args as [])
    if (name === 'socket') return Object.assign(info, { isFile: () => false, isDirectory: () => false })
    if (name === 'invalid-size.jar') return Object.assign(info, { size: Number.MAX_SAFE_INTEGER + 1 })
    return info
  }) as typeof fs.lstat)
  try {
    const result = await scanResourceInventory(f.game, 'mods')
    assert.deepEqual(result.items.map(item => item.name), ['good.jar'])
    assert.equal(result.warnings.filter(warning => warning.code === 'entry-unavailable').length, 3)
    assert.equal(result.warnings.filter(warning => warning.code === 'unsupported-entry').length, 1)
  } finally { restore() }
})

test('cancellation is checked before I/O and during enumeration, and closes the directory handle', async t => {
  const f = await fixture(t)
  const early = new AbortController()
  early.abort()
  const restoreEarly = hookFs(t, 'lstat', (async () => { throw new Error('pre-aborted scan must not access disk') }) as typeof fs.lstat)
  try { await assert.rejects(scanResourceInventory(f.game, 'mods', { signal: early.signal }), { name: 'AbortError' }) }
  finally { restoreEarly() }
  await fs.mkdir(path.join(f.game, 'mods'))
  const controller = new AbortController()
  const fake = fakeDirectory(['first.jar', 'later.jar'])
  const originalRead = fake.directory.read.bind(fake.directory)
  fake.directory.read = (async () => { controller.abort(); return originalRead() }) as Dir['read']
  const restoreDir = hookFs(t, 'opendir', (async () => fake.directory) as typeof fs.opendir)
  try {
    await assert.rejects(scanResourceInventory(f.game, 'mods', { signal: controller.signal }), { name: 'AbortError' })
    assert.equal(fake.reads, 1)
    assert.equal(fake.closes, 1)
  } finally { restoreDir() }
})

test('entry count is bounded even for enormous directories and no recursive or eager read occurs', async t => {
  const f = await fixture(t)
  const directory = path.join(f.game, 'mods')
  await fs.mkdir(directory)
  const sample = path.join(f.root, 'sample')
  await fs.writeFile(sample, 'fixture')
  const info = await fs.lstat(sample)
  let reads = 0, stats = 0, closes = 0
  const fake = {
    async read() { return { name: `entry-${reads++}.jar` } as Dirent },
    async close() { closes++ },
  } as unknown as Dir
  const originalStat = mutableFs.lstat
  const restoreStat = hookFs(t, 'lstat', (async (file: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
    if (path.dirname(String(file)) === directory) { stats++; return info }
    return originalStat(file, ...args as [])
  }) as typeof fs.lstat)
  const restoreDir = hookFs(t, 'opendir', (async () => fake) as typeof fs.opendir)
  try {
    const result = await scanResourceInventory(f.game, 'mods')
    assert.equal(result.items.length, INVENTORY_LIMITS.entries)
    assert.equal(stats, INVENTORY_LIMITS.entries)
    assert.equal(reads, INVENTORY_LIMITS.entries + 1)
    assert.equal(closes, 1)
    assert.equal(result.truncated, true)
    assert.ok(result.warnings.some(warning => warning.code === 'entry-limit'))
  } finally { restoreStat(); restoreDir() }
})

test('elapsed-time budget stops between metadata operations and returns partial results', async t => {
  const f = await fixture(t)
  const directory = path.join(f.game, 'mods')
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, 'first.jar'), 'fixture')
  await fs.writeFile(path.join(directory, 'second.jar'), 'fixture')
  let now = 0, entries = 0
  const clock = t.mock.method(performance, 'now', () => now)
  const fake = fakeDirectory(['first.jar', 'second.jar'])
  const originalStat = mutableFs.lstat
  const restoreStat = hookFs(t, 'lstat', (async (file: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
    const info = await originalStat(file, ...args as [])
    if (path.dirname(String(file)) === directory && ++entries === 2) now = INVENTORY_LIMITS.durationMs
    return info
  }) as typeof fs.lstat)
  const restoreDir = hookFs(t, 'opendir', (async () => fake.directory) as typeof fs.opendir)
  try {
    const result = await scanResourceInventory(f.game, 'mods')
    assert.deepEqual(result.items.map(item => item.name), ['first.jar'])
    assert.equal(result.truncated, true)
    assert.equal(result.warnings[0].code, 'time-limit')
    assert.equal(fake.closes, 1)
  } finally { restoreStat(); restoreDir(); clock.mock.restore() }
})

test('a directory read permission error returns partial warnings without claiming historical sources', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.game, 'mods'))
  await fs.writeFile(path.join(f.game, 'mods', 'first.jar'), 'fixture')
  await fs.writeFile(f.registry, JSON.stringify({ project: { versionId: 'v', filename: 'first.jar' } }))
  let reads = 0, closes = 0
  const fake = {
    async read() {
      if (!reads++) return { name: 'first.jar' } as Dirent
      throw Object.assign(new Error('directory permission changed'), { code: 'EACCES' })
    },
    async close() { closes++ },
  } as unknown as Dir
  const restore = hookFs(t, 'opendir', (async () => fake) as typeof fs.opendir)
  try {
    const result = await scanResourceInventory(f.game, 'mods', { managedModsFile: f.registry })
    assert.deepEqual(result.items.map(item => item.name), ['first.jar'])
    assert.equal(result.items[0].recordedSource, undefined)
    assert.equal(result.truncated, true)
    assert.ok(result.warnings.some(warning => warning.code === 'directory-unavailable'))
    assert.equal(closes, 1)
  } finally { restore() }
})

test('a resource directory replaced while opening is rejected before listing replacement contents', async t => {
  const f = await fixture(t)
  const directory = path.join(f.game, 'mods')
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, 'old.jar'), 'old')
  const originalOpen = mutableFs.opendir
  let reads = 0, closes = 0
  const restore = hookFs(t, 'opendir', (async (...args: Parameters<typeof fs.opendir>) => {
    const opened = await originalOpen(...args)
    await fs.rename(directory, path.join(f.game, 'old-mods'))
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, 'replacement.jar'), 'replacement')
    return {
      async read() { reads++; return opened.read() },
      async close() { closes++; await opened.close() },
    } as unknown as Dir
  }) as typeof fs.opendir)
  try {
    await assert.rejects(scanResourceInventory(f.game, 'mods'), /被替换/)
    assert.equal(reads, 0)
    assert.equal(closes, 1)
    assert.equal(await fs.readFile(path.join(directory, 'replacement.jar'), 'utf8'), 'replacement')
  } finally { restore() }
})

test('source-registry links or link ancestors are refused while missing registries remain harmless', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.game, 'mods'))
  await fs.writeFile(path.join(f.game, 'mods', 'mod.jar'), 'fixture')
  const absent = await scanResourceInventory(f.game, 'mods', { managedModsFile: f.registry })
  assert.deepEqual(absent.warnings, [])
  const outside = path.join(f.root, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'registry.json'), JSON.stringify({ project: { versionId: 'v', filename: 'mod.jar' } }))
  const link = path.join(f.root, 'linked')
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await scanResourceInventory(f.game, 'mods', { managedModsFile: path.join(link, 'registry.json') })
  assert.equal(result.items[0].recordedSource, undefined)
  assert.ok(result.warnings.some(warning => warning.code === 'registry-invalid'))
  await fs.symlink(process.platform === 'win32' ? outside : path.join(outside, 'registry.json'), f.registry, process.platform === 'win32' ? 'junction' : 'file')
  const direct = await scanResourceInventory(f.game, 'mods', { managedModsFile: f.registry })
  assert.equal(direct.items[0].recordedSource, undefined)
  assert.ok(direct.warnings.some(warning => warning.code === 'registry-invalid'))
})

test('scans perform zero writes and open only the optional bounded registry, never archives or worlds', async t => {
  const f = await fixture(t)
  for (const folder of Object.values(folders)) {
    await fs.mkdir(path.join(f.game, folder, 'Folder', 'nested'), { recursive: true })
    await fs.writeFile(path.join(f.game, folder, 'resource.jar'), 'not a real archive')
  }
  await fs.writeFile(f.registry, JSON.stringify({ project: { versionId: 'v', filename: 'resource.jar' } }))
  const before = await fs.readFile(f.registry)
  const restores: Array<() => void> = []
  for (const name of ['mkdir', 'writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'copyFile', 'chmod'] as const) {
    restores.push(hookFs(t, name, (async () => { throw new Error(`inventory must never call ${name}`) }) as (typeof fs)[typeof name]))
  }
  const opened: string[] = []
  const originalOpen = mutableFs.open
  const originalReadFile = mutableFs.readFile
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('inventory must never access the network') })
  restores.push(() => network.mock.restore())
  restores.push(hookFs(t, 'readFile', (async (...args: Parameters<typeof fs.readFile>) => {
    assert.equal(String(args[0]), f.registry, 'archives and worlds must not be read through readFile either')
    return originalReadFile(...args)
  }) as typeof fs.readFile))
  restores.push(hookFs(t, 'open', (async (...args: Parameters<typeof fs.open>) => {
    assert.equal(String(args[0]), f.registry, 'resource bytes must never be opened')
    assert.equal(Number(args[1]) & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT), 0)
    opened.push(String(args[0]))
    return originalOpen(...args)
  }) as typeof fs.open))
  try {
    for (const kind of Object.keys(folders) as InventoryKind[]) {
      const result = await scanResourceInventory(f.game, kind, { managedModsFile: f.registry })
      assert.equal(result.items.length, 2)
    }
    assert.deepEqual(opened, [f.registry], 'only the mods scan may consult its source registry')
    assert.deepEqual(await fs.readFile(f.registry), before)
  } finally { for (const restore of restores.reverse()) restore() }
})
