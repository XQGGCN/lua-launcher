import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { applyGameWindowSettings } from './game-window'

async function fixture(t: TestContext, original?: string | Buffer) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-window-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const game = path.join(root, 'game')
  const backups = path.join(root, 'backups', 'window')
  const file = path.join(game, 'options.txt')
  await fs.mkdir(game)
  if (original !== undefined) await fs.writeFile(file, original)
  const backupBytes = async () => Promise.all((await fs.readdir(backups).catch(() => []))
    .map(name => fs.readFile(path.join(backups, name))))
  const temporaryFiles = async () => (await fs.readdir(game)).filter(name => name.startsWith('.lua-options-'))
  return { root, game, backups, file, backupBytes, temporaryFiles }
}
function hookOpen(t: TestContext, callback: (file: Parameters<typeof fs.open>[0]) => Promise<void>) {
  const mutableFs = createRequire(import.meta.url)('node:fs/promises') as typeof fs
  const original = mutableFs.open
  const replacement = t.mock.method(mutableFs, 'open', async (...args: Parameters<typeof fs.open>) => {
    await callback(args[0])
    return original(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { replacement.mock.restore(); syncBuiltinESMExports() })
}

test('true/false overrides preserve other options and make unique exact-byte backups', async t => {
  const old = 'version:3700\nfullscreen:true\nmusic:0.35\n'
  const f = await fixture(t, old)
  await applyGameWindowSettings(f.game, false, { backupDirectory: f.backups })
  const first = 'version:3700\nfullscreen:false\nmusic:0.35\n'
  assert.equal(await fs.readFile(f.file, 'utf8'), first)
  assert.deepEqual(await f.backupBytes(), [Buffer.from(old)])
  await applyGameWindowSettings(f.game, true, { backupDirectory: f.backups })
  assert.equal(await fs.readFile(f.file, 'utf8'), old)
  const backups = await f.backupBytes()
  assert.equal(backups.length, 2)
  assert.ok(backups.some(value => value.equals(Buffer.from(old))))
  assert.ok(backups.some(value => value.equals(Buffer.from(first))))
  assert.deepEqual(await f.temporaryFiles(), [])
})

test('correct settings, including duplicate correct keys, cause no rename, backup or metadata write', async t => {
  const original = 'fullscreen:false\r\nunknown:保存 原文\r\nfullscreen:false'
  const f = await fixture(t, original)
  const before = await fs.stat(f.file)
  await applyGameWindowSettings(f.game, false, {
    backupDirectory: f.backups, rename: async () => { throw new Error('unchanged data must not commit') },
  })
  assert.equal(await fs.readFile(f.file, 'utf8'), original)
  const after = await fs.stat(f.file)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)
  await assert.rejects(fs.access(f.backups), { code: 'ENOENT' })
})

test('empty existing files receive a zero-byte backup; new options files do not invent a backup', async t => {
  const empty = await fixture(t, '')
  await applyGameWindowSettings(empty.game, false, { backupDirectory: empty.backups })
  assert.equal(await fs.readFile(empty.file, 'utf8'), 'fullscreen:false\n')
  assert.deepEqual(await empty.backupBytes(), [Buffer.alloc(0)])
  const fresh = await fixture(t)
  await applyGameWindowSettings(fresh.game, true, { backupDirectory: fresh.backups })
  assert.equal(await fs.readFile(fresh.file, 'utf8'), 'fullscreen:true\n')
  await assert.rejects(fs.access(fresh.backups), { code: 'ENOENT' })
})

test('all duplicate keys are updated while BOM, CRLF, unknown fields and missing final newline survive', async t => {
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(
    'fullscreen:true\r\nmod.option:中文:extra:value\r\nfullscreen:false\r\nFullscreen:true\r\n fullscreen:true\r\nlast:unchanged',
  )])
  const expected = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(
    'fullscreen:false\r\nmod.option:中文:extra:value\r\nfullscreen:false\r\nFullscreen:true\r\n fullscreen:true\r\nlast:unchanged',
  )])
  const f = await fixture(t, original)
  await applyGameWindowSettings(f.game, false, { backupDirectory: f.backups })
  assert.deepEqual(await fs.readFile(f.file), expected)
  assert.deepEqual(await f.backupBytes(), [original])
})

test('appending a missing key follows the existing newline style without rewriting old lines', async t => {
  for (const [original, expected] of [
    ['music:0.2\r\nfoo:bar\r\n', 'music:0.2\r\nfoo:bar\r\nfullscreen:true\r\n'],
    ['music:0.2\r\nfoo:bar', 'music:0.2\r\nfoo:bar\r\nfullscreen:true\r\n'],
    ['one:1\rtwo:2\r', 'one:1\rtwo:2\rfullscreen:true\r'],
    ['one:1\nmixed:2\r\nlast:3', 'one:1\nmixed:2\r\nlast:3\nfullscreen:true\n'],
  ]) {
    const f = await fixture(t, original)
    await applyGameWindowSettings(f.game, true, { backupDirectory: f.backups })
    assert.equal(await fs.readFile(f.file, 'utf8'), expected)
  }
})

test('malformed UTF-8, NUL and oversized files are rejected before any backup or write', async t => {
  for (const original of [Buffer.from([0xff, 0xfe, 0xc0, 0xaf]), Buffer.from('fullscreen:true\nbad:\0'), Buffer.alloc(1024 * 1024 + 1, 0x61)]) {
    const f = await fixture(t, original)
    await assert.rejects(applyGameWindowSettings(f.game, false, { backupDirectory: f.backups }), /UTF-8|空字符|1 MiB/)
    assert.deepEqual(await fs.readFile(f.file), original)
    assert.deepEqual(await f.backupBytes(), [])
    assert.deepEqual(await f.temporaryFiles(), [])
  }
})

test('options.txt symlinks and non-regular files are rejected without touching their targets', async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, 'outside')
  await fs.mkdir(outside)
  const target = path.join(outside, 'other-options.txt')
  await fs.writeFile(target, 'fullscreen:true\n')
  await fs.symlink(process.platform === 'win32' ? outside : target, f.file, process.platform === 'win32' ? 'junction' : 'file')
  await assert.rejects(applyGameWindowSettings(f.game, false, { backupDirectory: f.backups }), /普通文件|符号链接/)
  assert.equal(await fs.readFile(target, 'utf8'), 'fullscreen:true\n')
  assert.deepEqual(await f.backupBytes(), [])
  await fs.rm(f.file, { force: true })
  await fs.mkdir(f.file)
  await assert.rejects(applyGameWindowSettings(f.game, false, { backupDirectory: f.backups }), /普通文件/)
})

test('game and backup roots reject symlinks, symlink ancestors, relative paths and filesystem roots', async t => {
  const f = await fixture(t, 'fullscreen:true\n')
  const link = path.join(f.root, 'linked')
  await fs.symlink(f.game, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(applyGameWindowSettings(link, false, { backupDirectory: f.backups }), /符号链接/)
  await fs.mkdir(path.join(f.game, 'child'))
  await assert.rejects(applyGameWindowSettings(path.join(link, 'child'), false, { backupDirectory: f.backups }), /符号链接/)
  await assert.rejects(applyGameWindowSettings(f.game, false, { backupDirectory: path.join(link, 'backups') }), /符号链接/)
  await assert.rejects(applyGameWindowSettings('relative', false, { backupDirectory: f.backups }), /绝对路径/)
  await assert.rejects(applyGameWindowSettings(f.game, false, { backupDirectory: path.parse(f.game).root }), /文件系统根目录/)
  assert.equal(await fs.readFile(f.file, 'utf8'), 'fullscreen:true\n')
})

test('pre-aborted calls do not create files or backups', async t => {
  const f = await fixture(t, 'fullscreen:true\n')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(applyGameWindowSettings(f.game, false, { backupDirectory: f.backups, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(await fs.readFile(f.file, 'utf8'), 'fullscreen:true\n')
  await assert.rejects(fs.access(f.backups), { code: 'ENOENT' })
})

test('cancellation while staging waits for file closure, cleans temporary data and preserves the original', async t => {
  const f = await fixture(t, 'fullscreen:true\nunknown:original\n')
  const controller = new AbortController()
  hookOpen(t, async file => {
    if (path.basename(String(file)).startsWith('.lua-options-')) controller.abort()
  })
  await assert.rejects(applyGameWindowSettings(f.game, false, { backupDirectory: f.backups, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(await fs.readFile(f.file, 'utf8'), 'fullscreen:true\nunknown:original\n')
  assert.deepEqual(await f.backupBytes(), [Buffer.from('fullscreen:true\nunknown:original\n')])
  assert.deepEqual(await f.temporaryFiles(), [])
})

test('failed atomic replacement leaves the old file and its backup intact', async t => {
  const original = 'fullscreen:false\r\nunknown:keep\r\n'
  const f = await fixture(t, original)
  await assert.rejects(applyGameWindowSettings(f.game, true, {
    backupDirectory: f.backups,
    rename: async (temporary, destination) => {
      assert.equal(destination, f.file)
      assert.equal(await fs.readFile(temporary, 'utf8'), 'fullscreen:true\r\nunknown:keep\r\n')
      assert.deepEqual(await f.backupBytes(), [Buffer.from(original)])
      throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' })
    },
  }), { code: 'EIO' })
  assert.equal(await fs.readFile(f.file, 'utf8'), original)
  assert.deepEqual(await f.backupBytes(), [Buffer.from(original)])
  assert.deepEqual(await f.temporaryFiles(), [])
})

test('backup failure prevents replacement and leaves no temporary options file', async t => {
  const f = await fixture(t, 'fullscreen:true\n')
  hookOpen(t, async file => {
    if (path.basename(String(file)).startsWith('options.fullscreen-')) throw Object.assign(new Error('simulated backup failure'), { code: 'EACCES' })
  })
  await assert.rejects(applyGameWindowSettings(f.game, false, { backupDirectory: f.backups }), { code: 'EACCES' })
  assert.equal(await fs.readFile(f.file, 'utf8'), 'fullscreen:true\n')
  assert.deepEqual(await f.backupBytes(), [])
  assert.deepEqual(await f.temporaryFiles(), [])
})

test('an external edit detected before commit is retained instead of overwritten', async t => {
  const original = 'fullscreen:true\nunknown:original\n'
  const changed = 'fullscreen:true\nunknown:user-edited\n'
  const f = await fixture(t, original)
  let reads = 0
  hookOpen(t, async file => {
    if (String(file) === f.file && ++reads === 2) await fs.writeFile(f.file, changed)
  })
  await assert.rejects(applyGameWindowSettings(f.game, false, { backupDirectory: f.backups }), /发生变化|其他操作修改/)
  assert.equal(await fs.readFile(f.file, 'utf8'), changed)
  assert.deepEqual(await f.backupBytes(), [Buffer.from(original)])
  assert.deepEqual(await f.temporaryFiles(), [])
})

test('successful commit wins a late cancellation and preserves ordinary file permissions', async t => {
  const f = await fixture(t, 'fullscreen:true\n')
  if (process.platform !== 'win32') await fs.chmod(f.file, 0o640)
  const controller = new AbortController()
  await applyGameWindowSettings(f.game, false, {
    backupDirectory: f.backups, signal: controller.signal,
    rename: async (...args) => { await fs.rename(...args); controller.abort() },
  })
  assert.equal(controller.signal.aborted, true)
  assert.equal(await fs.readFile(f.file, 'utf8'), 'fullscreen:false\n')
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.file)).mode & 0o777, 0o640)
  assert.deepEqual(await f.temporaryFiles(), [])
})
