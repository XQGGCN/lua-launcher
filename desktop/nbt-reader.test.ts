import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { NBT_LIMITS, NbtReadError, nbtPathKey, readNbtProjection } from './nbt-reader'

// Original binary fixtures, not bytes from a user's world or a third-party parser.
const byte = (n: number) => Buffer.from([n & 255])
const short = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b }
const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
const long = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64BE(n); return b }
const float = (n: number) => { const b = Buffer.alloc(4); b.writeFloatBE(n); return b }
const double = (n: number) => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b }
function string(value: string) {
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit >= 1 && unit <= 127) bytes.push(unit)
    else if (unit <= 2047) bytes.push(0xc0 | unit >> 6, 0x80 | unit & 63)
    else bytes.push(0xe0 | unit >> 12, 0x80 | unit >> 6 & 63, 0x80 | unit & 63)
  }
  const length = Buffer.alloc(2); length.writeUInt16BE(bytes.length)
  return Buffer.concat([length, Buffer.from(bytes)])
}
const named = (type: number, name: string, value: Buffer) => Buffer.concat([byte(type), string(name), value])
const compound = (...values: Buffer[]) => Buffer.concat([...values, byte(0)])
const root = (...values: Buffer[]) => named(10, '', compound(...values))
const isError = (code = 'invalid-nbt') => (error: unknown) => error instanceof NbtReadError && error.code === code
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'
const at = (result: Awaited<ReturnType<typeof readNbtProjection>>, ...parts: string[]) => result.get(nbtPathKey(parts))

test('big-endian scalar projection preserves signed values and exact int64 boundaries', async () => {
  const values = [
    named(1, 'byte', byte(-128)), named(2, 'short', short(-32000)), named(3, 'int', int(-2147483648)),
    named(4, 'min', long(-9223372036854775808n)), named(4, 'max', long(9223372036854775807n)),
    named(5, 'float', float(1.25)), named(6, 'double', double(-Math.PI)),
  ]
  const result = await readNbtProjection(root(...values), ['byte', 'short', 'int', 'min', 'max', 'float', 'double'].map(x => [x]))
  assert.deepEqual([...result.values()].map(x => x.value), [-128, -32000, -2147483648, -9223372036854775808n, 9223372036854775807n, 1.25, -Math.PI])
})

test('canonical modified UTF-8 decodes NUL, Chinese, surrogate pairs and Java lone surrogate units', async () => {
  const value = 'A\0中文😀\ud800\udfff'
  const result = await readNbtProjection(root(named(8, 'name', string(value))), [['name']])
  assert.equal(at(result, 'name')?.value, value)
})

test('strict MUTF-8 rejects malformed, four-byte, raw NUL and noncanonical overlong forms everywhere', async () => {
  for (const payload of [
    [0], [0x80], [0xc0], [0xc0, 0x81], [0xc1, 0xbf], [0xc2, 0x41], [0xe0, 0x80, 0x80],
    [0xe1, 0x80], [0xe1, 0x41, 0x80], [0xf0, 0x9f, 0x98, 0x80], [0xff],
  ]) {
    const utf = Buffer.concat([short(payload.length), Buffer.from(payload)])
    await assert.rejects(readNbtProjection(root(named(8, 'ignored', utf)), []), isError())
    await assert.rejects(readNbtProjection(Buffer.concat([byte(10), utf, byte(0)]), []), isError())
    await assert.rejects(readNbtProjection(root(Buffer.concat([byte(1), utf, byte(1)])), []), isError())
  }
})

test('unknown arrays, lists and compounds are fully validated but never materialized', async () => {
  const result = await readNbtProjection(root(
    named(7, 'bytes', Buffer.concat([int(3), Buffer.from([1, 2, 3])])),
    named(11, 'ints', Buffer.concat([int(2), int(-2), int(4)])),
    named(12, 'longs', Buffer.concat([int(1), long(-8n)])),
    named(9, 'list', Buffer.concat([byte(10), int(2), compound(named(8, 'secret', string('private'))), compound()])),
    named(10, '__proto__', compound(named(8, 'polluted', string('no')))),
  ), [['bytes'], ['ints'], ['longs'], ['list']])
  assert.deepEqual([...result.values()], [{ type: 7 }, { type: 11 }, { type: 12 }, { type: 9 }])
  assert.equal(({} as { polluted?: string }).polluted, undefined)
})

test('exact compound path projection cannot be spoofed by dotted keys, lists or root names', async () => {
  const result = await readNbtProjection(named(10, 'Data', compound(
    named(8, 'Data.LevelName', string('spoof')),
    named(9, 'Data', Buffer.concat([byte(10), int(1), compound(named(8, 'LevelName', string('list spoof')))])),
    named(10, 'real', compound(named(8, 'LevelName', string('correct')))),
  )), [['Data', 'LevelName'], ['real', 'LevelName']])
  assert.equal(at(result, 'Data', 'LevelName'), undefined)
  assert.equal(at(result, 'real', 'LevelName')?.value, 'correct')
})

test('duplicate keys are rejected in projected and completely unknown subtrees', async () => {
  const duplicate = compound(named(1, 'x', byte(1)), named(8, 'x', string('two')))
  await assert.rejects(readNbtProjection(named(10, '', duplicate), [['x']]), isError())
  await assert.rejects(readNbtProjection(root(named(10, 'ignored', duplicate)), []), isError())
})

test('root framing, tag IDs, End-list rules and trailing bytes are unambiguous', async () => {
  for (const data of [
    named(1, '', byte(1)), Buffer.alloc(0), root(named(13, 'x', Buffer.alloc(0))),
    root(named(9, 'x', Buffer.concat([byte(0), int(1)]))),
    root(named(9, 'x', Buffer.concat([byte(13), int(0)]))),
    Buffer.concat([root(), byte(0)]), Buffer.concat([root(), root()]),
  ]) await assert.rejects(readNbtProjection(data, []), isError())
  assert.equal((await readNbtProjection(root(named(9, 'empty', Buffer.concat([byte(0), int(0)]))), [])).size, 0)
})

test('negative counts and huge counts are checked before allocation or multiplication', async () => {
  for (const type of [7, 9, 11, 12]) {
    const payload = (count: number) => type === 9 ? Buffer.concat([byte(1), int(count)]) : int(count)
    await assert.rejects(readNbtProjection(root(named(type, 'x', payload(-1))), []), isError())
    await assert.rejects(readNbtProjection(root(named(type, 'x', payload(2147483647))), []), isError('limit-exceeded'))
  }
})

test('every truncated prefix of a multi-type compound fails without partial projection', async () => {
  const bytes = root(named(8, 'value', string('known')), named(10, 'nested', compound(
    named(4, 'x', long(8n)), named(11, 'a', Buffer.concat([int(2), int(1), int(2)])),
  )))
  for (let length = 0; length < bytes.length; length++) {
    await assert.rejects(readNbtProjection(bytes.subarray(0, length), [['value']]), isError())
  }
})

test('depth limit counts root and unknown list/container nesting', async () => {
  let value = Buffer.alloc(0)
  for (let depth = 1; depth < NBT_LIMITS.depth; depth++) value = named(10, 'n', compound(value))
  await readNbtProjection(root(value), [])
  await assert.rejects(readNbtProjection(root(named(10, 'extra', compound(value))), []), isError('limit-exceeded'))
})

test('all work budgets cover ignored data and tests cannot raise production budgets', async () => {
  const cases: [Buffer, Parameters<typeof readNbtProjection>[2]][] = [
    [root(), { limits: { bytes: 3 } }],
    [root(named(1, 'a', byte(1)), named(1, 'b', byte(2))), { limits: { tags: 2 } }],
    [root(named(1, 'a', byte(1)), named(1, 'b', byte(2))), { limits: { compoundEntries: 1 } }],
    [root(named(9, 'x', Buffer.concat([byte(1), int(2), byte(1), byte(2)]))), { limits: { listEntries: 1 } }],
    [root(named(8, 'a', string('1234')), named(8, 'b', string('5678'))), { limits: { stringBytes: 8 } }],
    [root(named(12, 'x', Buffer.concat([int(1), long(0n)]))), { limits: { arrayBytes: 7 } }],
    [root(named(7, 'a', Buffer.concat([int(2), short(0)])), named(7, 'b', Buffer.concat([int(2), short(0)]))), { limits: { arrayBytes: 3 } }],
  ]
  for (const [input, options] of cases) await assert.rejects(readNbtProjection(input, [], options), isError('limit-exceeded'))
  await assert.rejects(readNbtProjection(root(), [], { limits: { tags: NBT_LIMITS.tags + 1 } }), TypeError)
  await assert.rejects(readNbtProjection(root(), [], { limits: { depth: 0 } }), TypeError)
})

test('display strings are bounded, do not split surrogate pairs, and their omitted suffix is still validated', async () => {
  const result = await readNbtProjection(root(named(8, 'x', string('abc😀z'))), [['x']], { limits: { projectedStringUnits: 4 } })
  assert.deepEqual(at(result, 'x'), { type: 8, value: 'abc', truncated: true })
  const invalidString = Buffer.concat([short(10), Buffer.from('123456789'), byte(0xff)])
  await assert.rejects(readNbtProjection(root(named(8, 'x', invalidString)), [['x']], { limits: { projectedStringUnits: 1 } }), isError())
})

test('cancellation before parsing and during large unknown subtrees yields AbortError', async () => {
  const before = new AbortController(); before.abort()
  await assert.rejects(readNbtProjection(root(), [], { signal: before.signal }), isAbort)
  const controller = new AbortController()
  const input = root(named(9, 'ignored', Buffer.concat([byte(1), int(90000), Buffer.alloc(90000)])))
  setImmediate(() => controller.abort())
  await assert.rejects(readNbtProjection(input, [], { signal: controller.signal }), isAbort)
})

test('large unknown strings yield to cancellation and deadlines are enforced', async () => {
  const controller = new AbortController()
  setImmediate(() => controller.abort())
  await assert.rejects(readNbtProjection(root(named(8, 'unknown', string('a'.repeat(60000)))), [], { signal: controller.signal }), isAbort)
  await assert.rejects(readNbtProjection(root(), [], { deadline: performance.now() - 1 }), isError('limit-exceeded'))
  await assert.rejects(readNbtProjection(root(), [], { deadline: Number.NaN }), TypeError)
})

test('projection requests are bounded and non-finite floats are not silently converted', async () => {
  await assert.rejects(readNbtProjection(root(), Array.from({ length: 65 }, () => ['x'])), TypeError)
  await assert.rejects(readNbtProjection(root(), [Array.from({ length: 17 }, () => 'x')]), TypeError)
  const result = await readNbtProjection(root(named(5, 'f', float(Infinity)), named(6, 'n', double(NaN))), [['f'], ['n']])
  assert.equal(at(result, 'f')?.value, Infinity)
  assert.ok(Number.isNaN(at(result, 'n')?.value))
})
