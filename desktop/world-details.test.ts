import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import test, { type TestContext } from 'node:test'
import { gzipSync } from 'node:zlib'
import { readWorldDetails, WORLD_READ_LIMITS } from './world-details'
import type { WorldSelection } from './world-types'

// Synthetic original fixtures. No real player/world data or Java execution.
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64BE(n); return b }
function utf(value: string): Buffer {
  const data: number[] = []
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c > 0 && c < 128) data.push(c)
    else if (c < 2048) data.push(0xc0 | c >> 6, 0x80 | c & 63)
    else data.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63)
  }
  const prefix = Buffer.alloc(2); prefix.writeUInt16BE(data.length)
  return Buffer.concat([prefix, Buffer.from(data)])
}
const tag = (type: number, name: string, payload: Buffer) => Buffer.concat([Buffer.from([type]), utf(name), payload])
const byteTag = (name: string, value: number) => tag(1, name, Buffer.from([value & 255]))
const intTag = (name: string, value: number) => tag(3, name, i32(value))
const longTag = (name: string, value: bigint) => tag(4, name, i64(value))
const stringTag = (name: string, value: string) => tag(8, name, utf(value))
const compound = (name: string, values: Buffer[]) => tag(10, name, Buffer.concat([...values, Buffer.from([0])]))
const encoded = (fields: Buffer[]) => compound('', [compound('Data', fields)])
const selection = (name = 'Test world'): WorldSelection => ({ name, itemId: `worlds:${createHash('sha256').update(name).digest('hex')}` })
function complete(overrides: Partial<Record<string, Buffer | null>> = {}): Buffer[] {
  const fields: Record<string, Buffer> = {
    LevelName: stringTag('LevelName', '合成测试世界😀'),
    Version: compound('Version', [stringTag('Name', '1.20.1'), intTag('Id', 3465), byteTag('Snapshot', 0)]),
    DataVersion: intTag('DataVersion', 3465), GameType: intTag('GameType', 1), Difficulty: byteTag('Difficulty', 2),
    hardcore: byteTag('hardcore', 0), allowCommands: byteTag('allowCommands', 1),
    Time: longTag('Time', 9223372036854775807n), DayTime: longTag('DayTime', -9223372036854775808n),
    LastPlayed: longTag('LastPlayed', 1234567890000n),
    WorldGenSettings: compound('WorldGenSettings', [longTag('seed', -9007199254740997n)]),
  }
  for (const [name, value] of Object.entries(overrides)) { if (value === null) delete fields[name]; else fields[name] = value! }
  return Object.values(fields)
}
async function fixture(t: TestContext, fields = complete(), name = 'Test world') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-world-read-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const saves = path.join(root, 'game', 'saves'), world = path.join(saves, name), file = path.join(world, 'level.dat')
  await fs.mkdir(world, { recursive: true })
  await fs.writeFile(file, gzipSync(encoded(fields)))
  return { root, saves, world, file, selection: selection(name), read: (options = {}) => readWorldDetails(root, selection(name), options) }
}
const mutableFs = createRequire(import.meta.url)('node:fs/promises') as typeof fs
function hook<K extends keyof typeof fs>(t: TestContext, name: K, fn: typeof fs[K]) {
  const mock = t.mock.method(mutableFs, name, fn as never); syncBuiltinESMExports()
  const restore = () => { mock.mock.restore(); syncBuiltinESMExports() }; t.after(restore); return restore
}
const ioError = (code = 'EIO') => Object.assign(new Error('injected private error, must not reach DTO'), { code })
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'

test('projects actual typed metadata, precise longs and NBT LastPlayed; default DTO has no seed', async t => {
  const f = await fixture(t)
  const result = await f.read()
  assert.equal(result.details.status, 'ok')
  assert.deepEqual(result.details.metadata, {
    levelName: '合成测试世界😀', savedVersionName: '1.20.1', dataVersion: 3465, versionId: 3465,
    snapshot: false, allowCommands: true, gameMode: { raw: 1, label: '创造' },
    difficulty: { raw: 2, label: '普通' }, hardcore: false,
    timeTicks: '9223372036854775807', dayTimeTicks: '-9223372036854775808',
    lastPlayed: { epochMs: '1234567890000', iso: '2009-02-13T23:31:30.000Z' },
  })
  assert.equal(result.details.seedAvailable, true)
  assert.equal(Object.hasOwn(result, 'seed'), false)
  assert.equal(Object.hasOwn(result.details, 'seed'), false)
  assert.ok(result.revisionKey?.match(/^[a-f0-9]{64}$/))
  assert.notEqual(result.details.file?.modifiedAt, result.details.metadata.lastPlayed?.iso)
  assert.ok(!JSON.stringify(result).includes('-9007199254740997'))
})

test('seed is explicit top-level-only, zero and signed extremes retain precision', async t => {
  const f = await fixture(t)
  for (const value of [0n, -9223372036854775808n, 9223372036854775807n]) {
    await fs.writeFile(f.file, gzipSync(encoded(complete({ WorldGenSettings: compound('WorldGenSettings', [longTag('seed', value)]) }))))
    const result = await f.read({ includeSeed: true })
    assert.equal(result.seed, value.toString())
    assert.equal(Object.hasOwn(result.details, 'seed'), false)
  }
})

test('revision is stable for unchanged reads and changes with bytes, file identity or world directory identity', async t => {
  const f = await fixture(t)
  const first = await f.read(), second = await f.read({ includeSeed: true })
  assert.equal(second.revisionKey, first.revisionKey)
  const bytes = await fs.readFile(f.file)
  await fs.rename(f.file, f.file + '.previous'); await fs.writeFile(f.file, bytes)
  const replaced = await f.read()
  assert.notEqual(replaced.revisionKey, first.revisionKey)
  await fs.rename(f.world, f.world + '-previous'); await fs.mkdir(f.world)
  await fs.link(path.join(f.world + '-previous', 'level.dat'), f.file)
  const moved = await f.read()
  assert.notEqual(moved.revisionKey, replaced.revisionKey)
  await fs.writeFile(f.file, gzipSync(encoded(complete({ LevelName: stringTag('LevelName', 'new') }))))
  assert.notEqual((await f.read()).revisionKey, moved.revisionKey)
})

test('old data is an explicitly selected independent file, with no fallback or merged values', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.world, 'level.dat_old'), gzipSync(encoded([stringTag('LevelName', 'old only')])))
  const current = await f.read(), old = await f.read({ source: 'level.dat_old' })
  assert.equal(old.details.source, 'level.dat_old'); assert.equal(old.details.status, 'partial')
  assert.deepEqual(old.details.metadata, { levelName: 'old only' })
  assert.notEqual(old.revisionKey, current.revisionKey)
  await fs.rm(f.file)
  assert.equal((await f.read()).details.reasonCode, 'missing')
  assert.equal((await f.read({ source: 'level.dat_old' })).details.metadata.levelName, 'old only')
})

test('missing and mistyped fields stay unknown and do not become false, zero or instance defaults', async t => {
  const f = await fixture(t, [stringTag('LevelName', 'partial'), intTag('hardcore', 1), byteTag('GameType', 0), stringTag('Version', 'wrong')])
  const { details } = await f.read()
  assert.equal(details.status, 'partial')
  assert.deepEqual(details.metadata, { levelName: 'partial' })
  assert.ok(details.fieldWarnings.some(x => x.field === 'hardcore' && x.code === 'type-mismatch'))
  assert.ok(details.fieldWarnings.some(x => x.field === 'gameMode' && x.code === 'type-mismatch'))
  assert.ok(details.fieldWarnings.some(x => x.field === 'savedVersionName' && x.code === 'type-mismatch'))
  assert.ok(details.fieldWarnings.some(x => x.field === 'timeTicks' && x.code === 'missing'))
  assert.equal(details.seedAvailable, false)
})

test('unknown enums preserve raw values while invalid boolean bytes are omitted', async t => {
  const f = await fixture(t, complete({ GameType: intTag('GameType', 100), Difficulty: byteTag('Difficulty', -1),
    hardcore: byteTag('hardcore', 2), allowCommands: byteTag('allowCommands', -1) }))
  const { details } = await f.read()
  assert.equal(details.status, 'partial')
  assert.deepEqual(details.metadata.gameMode, { raw: 100 }); assert.deepEqual(details.metadata.difficulty, { raw: -1 })
  assert.equal(Object.hasOwn(details.metadata, 'hardcore'), false)
  assert.equal(Object.hasOwn(details.metadata, 'allowCommands'), false)
})

test('LastPlayed out of Date range remains exact without inventing an ISO timestamp', async t => {
  const f = await fixture(t, complete({ LastPlayed: longTag('LastPlayed', 9223372036854775807n) }))
  const { details } = await f.read()
  assert.deepEqual(details.metadata.lastPlayed, { epochMs: '9223372036854775807' })
  assert.ok(details.fieldWarnings.some(x => x.field === 'lastPlayed' && x.code === 'invalid-value'))
})

test('26.1 nested difficulty/hardcore are read while external seed/clock files are never opened', async t => {
  const f = await fixture(t, complete({ Difficulty: null, hardcore: null, WorldGenSettings: null, DayTime: null,
    difficulty_settings: compound('difficulty_settings', [stringTag('difficulty', 'hard'), byteTag('hardcore', 1)]) }))
  const originalOpen = fs.open, opened: string[] = []
  hook(t, 'open', async (file, flags, mode) => { opened.push(String(file)); return originalOpen(file, flags, mode) })
  const result = await f.read({ includeSeed: true })
  assert.equal(result.details.status, 'partial')
  assert.deepEqual(result.details.metadata.difficulty, { raw: 'hard', label: '困难' })
  assert.equal(result.details.metadata.hardcore, true)
  assert.equal(result.details.seedAvailable, false); assert.equal(Object.hasOwn(result, 'seed'), false)
  assert.deepEqual(opened, [f.file])
})

test('matching old/new layout fields are accepted; conflicting layouts are omitted with warnings', async t => {
  const f = await fixture(t, complete({ difficulty_settings: compound('difficulty_settings', [stringTag('difficulty', 'normal'), byteTag('hardcore', 0)]) }))
  assert.equal((await f.read()).details.status, 'ok')
  await fs.writeFile(f.file, gzipSync(encoded(complete({ difficulty_settings: compound('difficulty_settings', [stringTag('difficulty', 'easy'), byteTag('hardcore', 1)]) }))))
  const { details } = await f.read()
  assert.equal(Object.hasOwn(details.metadata, 'difficulty'), false)
  assert.equal(Object.hasOwn(details.metadata, 'hardcore'), false)
  for (const field of ['difficulty', 'hardcore']) assert.ok(details.fieldWarnings.some(x => x.field === field && x.code === 'invalid-value'))
})

test('unknown modern difficulty stays raw, wrong old types are not silently replaced by modern values', async t => {
  const f = await fixture(t, complete({ Difficulty: null, hardcore: null,
    difficulty_settings: compound('difficulty_settings', [stringTag('difficulty', 'custom'), byteTag('hardcore', 2)]) }))
  const first = (await f.read()).details
  assert.deepEqual(first.metadata.difficulty, { raw: 'custom' }); assert.equal(Object.hasOwn(first.metadata, 'hardcore'), false)
  await fs.writeFile(f.file, gzipSync(encoded(complete({ Difficulty: stringTag('Difficulty', 'normal'),
    difficulty_settings: compound('difficulty_settings', [stringTag('difficulty', 'normal')]) }))))
  const second = (await f.read()).details
  assert.equal(Object.hasOwn(second.metadata, 'difficulty'), false)
  assert.ok(second.fieldWarnings.some(x => x.field === 'difficulty' && x.code === 'type-mismatch'))
})

test('syntactically valid but unknown root layout is unsupported, not a fabricated world', async t => {
  const f = await fixture(t)
  for (const data of [compound('', [stringTag('Elsewhere', 'unknown')]), compound('', [stringTag('Data', 'not compound')])]) {
    await fs.writeFile(f.file, gzipSync(data))
    const result = await f.read({ includeSeed: true })
    assert.equal(result.details.reasonCode, 'unsupported-layout')
    assert.deepEqual(result.details.metadata, {}); assert.equal(result.revisionKey, undefined); assert.equal(Object.hasOwn(result, 'seed'), false)
  }
})

test('large display names are truncated explicitly; ignored Player fields do not enter DTO', async t => {
  const f = await fixture(t, complete({ LevelName: stringTag('LevelName', 'a'.repeat(5000)),
    Player: compound('Player', [stringTag('private', 'DO_NOT_RETURN_PLAYER')]) }))
  const result = await f.read()
  assert.equal(result.details.metadata.levelName?.length, 4096)
  assert.ok(result.details.fieldWarnings.some(x => x.field === 'levelName' && x.code === 'truncated'))
  assert.ok(!JSON.stringify(result).includes('DO_NOT_RETURN_PLAYER'))
})

test('gzip is mandatory and malformed/truncated/CRC-corrupt streams never publish fields', async t => {
  const f = await fixture(t), good = await fs.readFile(f.file)
  const crc = Buffer.from(good); crc[crc.length - 8] ^= 0xff
  for (const [bytes, reason] of [[Buffer.from('not gzip'), 'unsupported-compression'],
    [encoded(complete()), 'unsupported-compression'], [good.subarray(0, good.length - 3), 'invalid-gzip'],
    [crc, 'invalid-gzip'], [Buffer.concat([good, Buffer.from('junk')]), 'invalid-gzip']] as const) {
    await fs.writeFile(f.file, bytes)
    const result = await f.read({ includeSeed: true })
    assert.equal(result.details.reasonCode, reason); assert.deepEqual(result.details.metadata, {})
    assert.equal(result.revisionKey, undefined); assert.equal(Object.hasOwn(result, 'seed'), false)
  }
})

test('concatenated gzip members share one NBT root and reject a hidden second root', async t => {
  const f = await fixture(t), data = encoded(complete()), split = Math.floor(data.length / 2)
  await fs.writeFile(f.file, Buffer.concat([gzipSync(data.subarray(0, split)), gzipSync(data.subarray(split))]))
  assert.equal((await f.read()).details.status, 'ok')
  await fs.writeFile(f.file, Buffer.concat([gzipSync(data), gzipSync(data)]))
  assert.equal((await f.read()).details.reasonCode, 'invalid-nbt')
})

test('compressed and expanded byte ceilings stop oversized files and gzip bombs', async t => {
  const f = await fixture(t)
  await fs.truncate(f.file, WORLD_READ_LIMITS.compressedBytes + 1)
  assert.equal((await f.read()).details.reasonCode, 'limit-exceeded')
  const halfBomb = gzipSync(Buffer.alloc(WORLD_READ_LIMITS.expandedBytes / 2 + 1))
  await fs.writeFile(f.file, Buffer.concat([halfBomb, halfBomb]))
  assert.equal((await f.read()).details.reasonCode, 'limit-exceeded')
})

test('invalid late NBT data discards earlier names and seeds', async t => {
  const f = await fixture(t)
  await fs.writeFile(f.file, gzipSync(encoded([...complete(), tag(13, 'bad', Buffer.alloc(0))])))
  const result = await f.read({ includeSeed: true })
  assert.equal(result.details.reasonCode, 'invalid-nbt'); assert.deepEqual(result.details.metadata, {})
  assert.equal(result.details.seedAvailable, false); assert.equal(result.revisionKey, undefined); assert.equal(Object.hasOwn(result, 'seed'), false)
})

test('selection rejects traversal, separators, ADS, devices, spoof IDs and extra path fields before IO', async t => {
  const f = await fixture(t)
  const forbidden = () => { throw new Error('invalid input must not touch FS') }
  const restore = hook(t, 'lstat', forbidden as never)
  for (const name of ['../world', '/world', 'a\\b', 'a/b', 'a:b', 'CON', 'NUL.txt', 'tail.', 'tail ', '..', '\u202eevil', '\ud800']) {
    await assert.rejects(readWorldDetails(f.root, selection(name)), TypeError)
  }
  await assert.rejects(readWorldDetails(f.root, { ...f.selection, itemId: 'worlds:fake' }), TypeError)
  await assert.rejects(readWorldDetails(f.root, { ...f.selection, path: f.file } as WorldSelection), TypeError)
  await assert.rejects(readWorldDetails(f.root, f.selection, { source: '../other' as 'level.dat' }), TypeError)
  await assert.rejects(readWorldDetails(f.root, f.selection, { includeSeed: 'yes' as unknown as boolean }), TypeError)
  await assert.rejects(readWorldDetails('relative', f.selection), TypeError)
  await assert.rejects(readWorldDetails(path.parse(f.root).root, f.selection), TypeError)
  restore()
})

test('missing root/saves/world/file yields missing without creating directories', async t => {
  const f = await fixture(t)
  await fs.rm(f.file); assert.equal((await f.read()).details.reasonCode, 'missing')
  await fs.rm(f.world, { recursive: true }); assert.equal((await f.read()).details.reasonCode, 'missing')
  await fs.rm(f.saves, { recursive: true }); assert.equal((await f.read()).details.reasonCode, 'missing')
  await fs.rm(f.root, { recursive: true }); assert.equal((await f.read()).details.reasonCode, 'missing')
  await assert.rejects(fs.access(f.root), { code: 'ENOENT' })
})

test('file/directory symlinks and junction ancestors are rejected', async t => {
  const f = await fixture(t), original = f.file + '.real'
  await fs.rename(f.file, original); await fs.symlink(original, f.file, 'file')
  assert.equal((await f.read()).details.reasonCode, 'unsafe-path')
  await fs.unlink(f.file); await fs.rename(original, f.file)
  await fs.rename(f.world, f.world + '.real'); await fs.symlink(f.world + '.real', f.world, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await f.read()).details.reasonCode, 'unsafe-path')
  await fs.unlink(f.world); await fs.rename(f.world + '.real', f.world)
  const alias = f.root + '.alias'; t.after(() => fs.unlink(alias).catch(() => {}))
  await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await readWorldDetails(alias, f.selection)).details.reasonCode, 'unsafe-path')
})

test('nonregular source files and non-directory ancestors are rejected', async t => {
  const f = await fixture(t)
  await fs.rm(f.file); await fs.mkdir(f.file)
  assert.equal((await f.read()).details.reasonCode, 'unsafe-path')
  await fs.rm(f.world, { recursive: true }); await fs.writeFile(f.world, 'not a directory')
  assert.equal((await f.read()).details.reasonCode, 'unsafe-path')
})

test('case and NFC aliases cannot use a different spelling than the inventory selection', async t => {
  const f = await fixture(t, complete(), 'MixedCase')
  // Filesystem case sensitivity is a volume property, not an OS guarantee.
  assert.ok(['missing', 'name-collision'].includes((await readWorldDetails(f.root, selection('mixedcase'))).details.reasonCode!))
  const unicode = await fixture(t, complete(), 'Café')
  const actual = (await fs.readdir(unicode.saves))[0]
  const alternate = actual.normalize('NFD') === actual ? actual.normalize('NFC') : actual.normalize('NFD')
  const result = await readWorldDetails(unicode.root, selection(alternate))
  assert.ok(['missing', 'name-collision'].includes(result.details.reasonCode!))
})

test('ambiguous case/NFC names and excessive saves entries are bounded even on case-insensitive hosts', async t => {
  const f = await fixture(t), original = fs.opendir
  let names = [f.selection.name, f.selection.name.toUpperCase()]
  hook(t, 'opendir', (async (directory: Parameters<typeof fs.opendir>[0]) => {
    if (String(directory) !== f.saves) return original(directory)
    let index = 0
    return { read: async () => index < names.length ? { name: names[index++] } : null, close: async () => {} } as never
  }) as typeof fs.opendir)
  assert.equal((await f.read()).details.reasonCode, 'name-collision')
  names = Array.from({ length: WORLD_READ_LIMITS.directoryEntries + 1 }, (_, i) => i === 0 ? f.selection.name : `world${i}`)
  assert.equal((await f.read()).details.reasonCode, 'limit-exceeded')
})

test('IO failures are safe unavailable responses without leaking error messages or absolute paths', async t => {
  const f = await fixture(t), original = fs.open
  const restore = hook(t, 'open', async (file, flags, mode) => {
    if (String(file) === f.file) throw ioError('EACCES')
    return original(file, flags, mode)
  })
  const result = await f.read()
  assert.equal(result.details.reasonCode, 'unreadable')
  assert.ok(!JSON.stringify(result).includes('private error')); assert.ok(!JSON.stringify(result).includes(f.root))
  restore()
})

test('file replacement between lstat and open is detected via descriptor identity', async t => {
  const f = await fixture(t), original = fs.open
  hook(t, 'open', async (file, flags, mode) => {
    if (String(file) === f.file) {
      await fs.rename(f.file, f.file + '.previous'); await fs.writeFile(f.file, gzipSync(encoded(complete())))
    }
    return original(file, flags, mode)
  })
  const result = await f.read({ includeSeed: true })
  assert.equal(result.details.reasonCode, 'changed'); assert.equal(result.revisionKey, undefined); assert.equal(Object.hasOwn(result, 'seed'), false)
})

test('same-inode writes during read, short reads and read faults close the descriptor and discard data', async t => {
  for (const mode of ['edit', 'short', 'fault'] as const) {
    const f = await fixture(t), original = fs.open
    let closed = 0
    const restore = hook(t, 'open', async (file, flags, permissions) => {
      const handle = await original(file, flags, permissions)
      if (String(file) === f.file) {
        const read = handle.read.bind(handle), close = handle.close.bind(handle)
        handle.close = async () => { closed++; return close() }
        handle.read = (async (...args: Parameters<typeof read>) => {
          if (mode === 'fault') throw ioError()
          if (mode === 'short') return { bytesRead: 0, buffer: args[0] }
          const value = await read(...args)
          const info = await fs.stat(f.file); await fs.utimes(f.file, info.atime, new Date(info.mtimeMs + 2000))
          return value
        }) as typeof handle.read
      }
      return handle
    })
    const result = await f.read({ includeSeed: true })
    assert.equal(result.details.reasonCode, mode === 'fault' ? 'unreadable' : 'changed')
    assert.equal(closed, 1); assert.equal(result.revisionKey, undefined); assert.equal(Object.hasOwn(result, 'seed'), false)
    restore()
  }
})

test('world directory replacement after opening is rejected even if the same file inode survives', {
  skip: process.platform === 'win32' && 'Windows cannot rename a directory while a file inside it is open',
}, async t => {
  const f = await fixture(t), original = fs.open
  hook(t, 'open', async (file, flags, permissions) => {
    const handle = await original(file, flags, permissions)
    if (String(file) === f.file) {
      await fs.rename(f.world, f.world + '.previous'); await fs.mkdir(f.world)
      await fs.link(path.join(f.world + '.previous', 'level.dat'), f.file)
    }
    return handle
  })
  assert.equal((await f.read()).details.reasonCode, 'changed')
})

test('changes introduced during parsing are caught by the final path and descriptor check', async t => {
  const f = await fixture(t), original = fs.lstat
  let fileStats = 0
  hook(t, 'lstat', (async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === f.file && ++fileStats === 3) {
      const info = await fs.stat(f.file); await fs.utimes(f.file, info.atime, new Date(info.mtimeMs + 2000))
    }
    return original(...args)
  }) as typeof fs.lstat)
  const result = await f.read({ includeSeed: true })
  assert.equal(result.details.reasonCode, 'changed'); assert.deepEqual(result.details.metadata, {})
  assert.equal(Object.hasOwn(result, 'seed'), false)
})

test('already-cancelled and mid-read cancellation reject without a result or leaked descriptor', async t => {
  const f = await fixture(t), before = new AbortController(); before.abort()
  await assert.rejects(f.read({ signal: before.signal }), isAbort)
  const original = fs.open, controller = new AbortController()
  let closed = 0
  hook(t, 'open', async (file, flags, mode) => {
    const handle = await original(file, flags, mode)
    if (String(file) === f.file) {
      const read = handle.read.bind(handle), close = handle.close.bind(handle)
      handle.read = (async (...args: Parameters<typeof read>) => { const result = await read(...args); controller.abort(); return result }) as typeof handle.read
      handle.close = async () => { closed++; return close() }
    }
    return handle
  })
  await assert.rejects(f.read({ signal: controller.signal }), isAbort); assert.equal(closed, 1)
})

test('reading is zero-write and only opens the chosen fixed source file', async t => {
  const f = await fixture(t), original = fs.open
  await fs.writeFile(path.join(f.world, 'session.lock'), 'untouched')
  const before = await fs.stat(f.file), originalBytes = await fs.readFile(f.file)
  const restores: (() => void)[] = []
  const forbidden = () => { throw new Error('world reads must never write') }
  for (const method of ['mkdir', 'writeFile', 'rename', 'link', 'unlink', 'rmdir', 'rm', 'utimes', 'truncate', 'chmod'] as const) {
    restores.push(hook(t, method, forbidden as never))
  }
  restores.push(hook(t, 'open', async (file, flags, mode) => {
    assert.equal(String(file), f.file)
    assert.equal(flags, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    return original(file, flags, mode)
  }))
  const result = await f.read()
  assert.equal(result.details.status, 'ok')
  for (const restore of restores.reverse()) restore()
  const after = await fs.stat(f.file)
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs)
  assert.deepEqual(await fs.readFile(f.file), originalBytes)
  assert.equal(await fs.readFile(path.join(f.world, 'session.lock'), 'utf8'), 'untouched')
})

test('a consumed wall-time budget returns limit-exceeded and closes its open descriptor', async t => {
  const f = await fixture(t), original = fs.open, now = performance.now()
  let expired = false, closed = 0
  const clock = t.mock.method(performance, 'now', () => now + (expired ? WORLD_READ_LIMITS.durationMs + 1 : 0))
  t.after(() => clock.mock.restore())
  hook(t, 'open', async (file, flags, mode) => {
    const handle = await original(file, flags, mode)
    if (String(file) === f.file) {
      const read = handle.read.bind(handle), close = handle.close.bind(handle)
      handle.read = (async (...args: Parameters<typeof read>) => { const result = await read(...args); expired = true; return result }) as typeof handle.read
      handle.close = async () => { closed++; return close() }
    }
    return handle
  })
  const result = await f.read({ includeSeed: true })
  assert.equal(result.details.reasonCode, 'limit-exceeded'); assert.equal(closed, 1)
  assert.equal(result.revisionKey, undefined); assert.equal(Object.hasOwn(result, 'seed'), false)
  clock.mock.restore()
})

test('cancellation during streamed gunzip destroys the stream and closes the source descriptor', async t => {
  const f = await fixture(t), original = fs.open, controller = new AbortController()
  const mutableZlib = createRequire(import.meta.url)('node:zlib') as typeof import('node:zlib')
  const originalGunzip = mutableZlib.createGunzip
  let stream: ReturnType<typeof originalGunzip> | undefined, closed = 0
  const mock = t.mock.method(mutableZlib, 'createGunzip', (...args: Parameters<typeof originalGunzip>) => {
    stream = originalGunzip(...args)
    stream.once('data', () => controller.abort())
    return stream
  })
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  hook(t, 'open', async (file, flags, mode) => {
    const handle = await original(file, flags, mode)
    if (String(file) === f.file) {
      const close = handle.close.bind(handle); handle.close = async () => { closed++; return close() }
    }
    return handle
  })
  await assert.rejects(f.read({ signal: controller.signal }), isAbort)
  assert.equal(stream?.destroyed, true); assert.equal(closed, 1)
})
