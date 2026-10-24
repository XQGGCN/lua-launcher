import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { MODPACK_LIMITS, parseModpack, readModpack, validatePackPath, validatePackUrl } from './modpack'

const hashes = (value: string) => ({
  sha1: createHash('sha1').update(value).digest('hex'),
  sha512: createHash('sha512').update(value).digest('hex'),
})
function packFile(filePath = 'mods/example.jar', value = 'example', extra: Record<string, unknown> = {}) {
  return { path: filePath, downloads: ['https://cdn.modrinth.com/data/example.jar'], hashes: hashes(value), fileSize: Buffer.byteLength(value), ...extra }
}
function archive(index: Record<string, unknown> = {}, entries: Record<string, string | Buffer> = {}): Buffer {
  const zip = new AdmZip()
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1, game: 'minecraft', name: 'Pack Test', versionId: '1.0', summary: '',
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.10' }, files: [], ...index,
  })))
  for (const [name, value] of Object.entries(entries)) zip.addFile(name, typeof value === 'string' ? Buffer.from(value) : value)
  return zip.toBuffer()
}

test('client selection skips server-only files and applies client overrides last', () => {
  const result = parseModpack(archive({
    files: [
      packFile('mods/optional.jar', 'optional', { env: { client: 'optional', server: 'unsupported' } }),
      packFile('mods/server.jar', 'server', { env: { client: 'unsupported', server: 'required' } }),
      packFile('config/example.json', 'downloaded'),
    ],
  }, {
    'overrides/config/example.json': 'shared',
    'client-overrides/config/example.json': 'client',
    'overrides/options.txt': 'options',
    'server-overrides/config/example.json': 'server override',
    'server-overrides/server.properties': 'server-only configuration',
  }))
  assert.deepEqual(result.files.map(file => file.path), ['mods/optional.jar'])
  assert.deepEqual(result.overrides.map(file => [file.path, file.data.toString()]), [
    ['config/example.json', 'client'], ['options.txt', 'options'],
  ])
  assert.equal(result.preview.fileCount, 3)
  assert.equal(result.preview.totalBytes, 8 + 6 + 7)
  assert.equal(result.preview.optionalFileCount, 1)
  assert.equal(result.preview.loaderVersion, '0.16.10')
})

test('provenance retains excluded and shadowed roles without adding them to installation or claiming server payload verification', () => {
  const result = parseModpack(archive({ files: [
    packFile('config/example.json', 'indexed', { env: { client: 'optional', server: 'required' } }),
    packFile('mods/server.jar', 'server', { env: { client: 'unsupported', server: 'required' } }),
  ] }, { 'overrides/config/example.json': 'shared', 'client-overrides/config/example.json': 'client', 'server-overrides/server.properties': 'not inflated on client' }))
  const indexed = result.provenance.find(row => row.origin === 'indexed' && row.path === 'config/example.json')!
  const shared = result.provenance.find(row => row.origin === 'overrides')!, client = result.provenance.find(row => row.origin === 'client-overrides')!
  assert.equal(indexed.role, 'optional'); assert.equal(indexed.effective, false)
  assert.equal(result.provenance[indexed.shadowedBy!], shared); assert.equal(result.provenance[shared.shadowedBy!], client)
  assert.equal(client.effective, true); assert.equal(client.sha512, hashes('client').sha512); assert.equal(client.hashBasis, 'archive-payload')
  const server = result.provenance.find(row => row.origin === 'server-overrides')!
  assert.equal(server.role, 'server-excluded'); assert.equal(server.effective, false); assert.equal(server.sizeBasis, 'declared-archive'); assert.equal(server.hashBasis, undefined)
  assert.equal(server.sha512, undefined); assert.ok(!JSON.stringify(result.provenance).includes('not inflated on client'))
  assert.equal(result.files.length, 0); assert.equal(result.overrides.length, 1); assert.equal(result.preview.fileCount, 1)
})

test('unknown loaders and old Minecraft releases produce an unsupported preview', () => {
  for (const dependency of ['quilt-loader', 'future-loader']) {
    const pack = parseModpack(archive({ dependencies: { minecraft: '1.20.1', [dependency]: '1.0' } }))
    assert.match(pack.preview.unsupportedReason ?? '', new RegExp(dependency))
  }
  assert.match(parseModpack(archive({ dependencies: { minecraft: '1.19.4' } })).preview.unsupportedReason ?? '', /1.20.1/)
  assert.equal(parseModpack(archive({ dependencies: { minecraft: '26.1' } })).preview.loader, 'vanilla')
})

test('Forge and NeoForge packs retain exact pins and reject conflicting loaders', () => {
  for (const [loader, build] of [['forge', '47.4.0'], ['neoforge', '20.2.93']]) {
    const pack = parseModpack(archive({ dependencies: { minecraft: '1.20.2', [loader]: build } }))
    assert.equal(pack.preview.loader, loader)
    assert.equal(pack.preview.loaderVersion, build)
    assert.equal(pack.preview.unsupportedReason, undefined)
  }
  assert.throws(() => parseModpack(archive({
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.10', forge: '47.4.0' },
  })), /多个模组加载器/)
  assert.throws(() => parseModpack(archive({
    dependencies: { minecraft: '1.20.1', forge: '../47' },
  })), /版本格式无效/)
})

test('index and ZIP paths reject traversal, Windows aliases, case collisions, and file parents', () => {
  for (const value of ['../outside', '/absolute', 'C:/Windows', 'mods\\escape.jar', 'mods/../escape.jar',
    'config/CON', 'config/nul.txt', 'config/name.', 'config/name ', 'mods//file.jar']) {
    assert.throws(() => validatePackPath(value))
    assert.throws(() => parseModpack(archive({ files: [packFile(value)] })))
  }
  assert.throws(() => parseModpack(archive({ files: [packFile('mods/A.jar'), packFile('mods/a.jar')] })), /冲突/)
  assert.throws(() => parseModpack(archive({ files: [packFile('config'), packFile('config/options.txt')] })), /冲突/)
  assert.throws(() => parseModpack(archive({ files: [packFile('config/a.json')] }, { 'client-overrides/config/A.json': '{}' })), /冲突/)
  const zip = new AdmZip(archive())
  zip.addFile('unsafe-placeholder', Buffer.from('data')).entryName = 'server-overrides/../../outside'
  assert.throws(() => parseModpack(zip.toBuffer()), /不安全/)
})

test('untrusted archives reject symbolic links, encrypted entries, and incorrect CRC', () => {
  const symlink = new AdmZip(archive())
  symlink.addFile('overrides/config/link', Buffer.from('/etc')).attr = (0xa1ff << 16) >>> 0
  assert.throws(() => parseModpack(symlink.toBuffer()), /符号链接/)
  const encrypted = new AdmZip(archive())
  encrypted.getEntry('modrinth.index.json')!.header.flags |= 1
  assert.throws(() => parseModpack(encrypted.toBuffer()), /加密/)
  const corrupt = archive()
  const central = corrupt.indexOf(Buffer.from('504b0102', 'hex'))
  corrupt.writeUInt32LE(0, central + 16)
  corrupt.writeUInt32LE(0, 14)
  assert.throws(() => parseModpack(corrupt), /CRC/)
})

test('ZIP bomb and entry limits are checked before extraction', () => {
  const forged = archive()
  const central = forged.indexOf(Buffer.from('504b0102', 'hex'))
  forged.writeUInt32LE(MODPACK_LIMITS.entryBytes + 1, central + 24)
  assert.throws(() => parseModpack(forged), /超出限制/)
  assert.throws(() => parseModpack(archive({}, { 'overrides/huge-config.txt': Buffer.alloc(3 * 1024 * 1024) })), /压缩比/)
  assert.throws(() => parseModpack(archive({ files: Array.from({ length: MODPACK_LIMITS.files + 1 }, () => packFile()) })), /数量/)
  const manyEntries = archive()
  const end = manyEntries.length - 22
  manyEntries.writeUInt16LE(MODPACK_LIMITS.entries + 1, end + 8)
  manyEntries.writeUInt16LE(MODPACK_LIMITS.entries + 1, end + 10)
  assert.throws(() => parseModpack(manyEntries), /目录数量/)
  const zip64 = archive()
  zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16)
  assert.throws(() => parseModpack(zip64), /ZIP64/)
  const badDirectory = archive()
  badDirectory.writeUInt32LE(0, badDirectory.length - 22 + 16)
  assert.throws(() => parseModpack(badDirectory), /范围/)
})

test('pack downloads require both hashes and only explicit HTTPS source hosts', () => {
  for (const url of ['http://cdn.modrinth.com/a.jar', 'https://localhost/a.jar', 'https://cdn.modrinth.com.evil.test/a.jar',
    'https://user:password@github.com/a.jar', 'https://github.com:8443/a.jar', 'https://github.com/space here.jar']) {
    assert.throws(() => validatePackUrl(url))
  }
  assert.equal(validatePackUrl('https://raw.githubusercontent.com/owner/repo/main/mod.jar'),
    'https://raw.githubusercontent.com/owner/repo/main/mod.jar')
  assert.throws(() => parseModpack(archive({ files: [packFile('mods/a.jar', 'x', { hashes: { sha1: hashes('x').sha1 } })] })), /SHA-512/)
  assert.throws(() => parseModpack(archive({ files: [packFile('mods/a.jar', 'x', { fileSize: MODPACK_LIMITS.downloadedFileBytes + 1 })] })), /超出限制/)
})

test('invalid format and environment values fail before an installation plan is returned', () => {
  assert.throws(() => parseModpack(archive({ formatVersion: 2 })), /格式 1/)
  assert.throws(() => parseModpack(archive({ game: 'other' })), /Minecraft/)
  assert.throws(() => parseModpack(archive({ files: [packFile('mods/a.jar', 'x', { env: { client: 'sometimes', server: 'required' } })] })), /环境/)
  assert.throws(() => parseModpack(archive({ files: [packFile('mods/a.jar', 'x', { env: { client: 'optional', server: 'required', futureSide: 'optional' } })] })), /环境/)
  assert.throws(() => parseModpack(archive({ files: [packFile('mods/a.jar'), packFile('mods/a.jar')] })), /重复路径/)
})

test('local archive inspection reads a bounded regular file and returns immutable source bytes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-mrpack-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'test.mrpack')
  const contents = archive({}, { 'overrides/config/example.json': '{"enabled":true}' })
  await fs.writeFile(file, contents)
  const result = await readModpack(file)
  assert.equal(result.preview.name, 'Pack Test')
  assert.deepEqual(result.archive, contents)
  await assert.rejects(readModpack(directory), /普通/)
})
