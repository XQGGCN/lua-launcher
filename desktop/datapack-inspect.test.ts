import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { crc32 } from './world-zip'
import { captureDatapackWorld, verifyDatapackWorld, inventoryDatapacks, inspectDatapackItem, inspectDatapackZip, parseDatapackMetadata, DATAPACK_LIMITS } from './datapack-inspect'

interface Entry { name: string; data: string | Buffer; deflate?: boolean; descriptor?: boolean; badCrc?: boolean; attributes?: number; compressedTail?: Buffer; size?: number }
function zip(entries: Entry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data), packed = entry.deflate ? deflateRawSync(data) : data
    const body = entry.compressedTail ? Buffer.concat([packed, entry.compressedTail]) : packed
    const crc = (crc32(data) + (entry.badCrc ? 1 : 0)) >>> 0, flags = 0x0800 | (entry.descriptor ? 8 : 0), method = entry.deflate ? 8 : 0
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8)
    if (!entry.descriptor) { header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(entry.size ?? data.length, 22) }
    header.writeUInt16LE(name.length, 26)
    const desc = entry.descriptor ? Buffer.alloc(16) : Buffer.alloc(0)
    if (entry.descriptor) { desc.writeUInt32LE(0x08074b50); desc.writeUInt32LE(crc, 4); desc.writeUInt32LE(body.length, 8); desc.writeUInt32LE(entry.size ?? data.length, 12) }
    local.push(header, name, body, desc)
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(entry.size ?? data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(entry.attributes ?? (entry.name.endsWith('/') ? 0x41ed0010 : 0x81a40000), 38); cd.writeUInt32LE(offset, 42)
    central.push(cd, name); offset += header.length + name.length + body.length + desc.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cd, end])
}
const meta = JSON.stringify({ pack: { pack_format: 48, description: { text: 'A', extra: [{ text: ' pack' }] } } })
const dataEntry: Entry = { name: 'data/original/function/test.mcfunction', data: 'say original inert fixture' }
const pack = (extra: Entry[] = []) => zip([{ name: 'pack.mcmeta', data: meta }, dataEntry, ...extra])
async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-datapack-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const instance = path.join(directory, 'instance'), world = path.join(instance, 'game/saves/Original')
  await fs.mkdir(world, { recursive: true })
  const selection = { itemId: 'worlds:' + createHash('sha256').update('Original').digest('hex'), name: 'Original' }
  return { directory, instance, world, selection }
}
async function inspect(t: test.TestContext, bytes: Buffer) {
  const f = await fixture(t), file = path.join(f.directory, 'original.zip'); await fs.writeFile(file, bytes)
  const before = await fs.stat(file, { bigint: true }), result = await inspectDatapackZip(file), after = await fs.stat(file, { bigint: true })
  assert.deepEqual([after.ino, after.size, after.mtimeNs, after.ctimeNs], [before.ino, before.size, before.mtimeNs, before.ctimeNs])
  assert.deepEqual(await fs.readFile(file), bytes)
  return result
}

test('absent datapacks returns an empty read-only inventory and later creation invalidates it', async t => {
  const f = await fixture(t), proof = await captureDatapackWorld(f.instance, f.selection)
  const before = await fs.readdir(f.world), inventory = await inventoryDatapacks(proof)
  assert.deepEqual(inventory.items, []); assert.equal(inventory.directoryPresent, false)
  assert.deepEqual(await fs.readdir(f.world), before)
  await fs.mkdir(path.join(f.world, 'datapacks'))
  await assert.rejects(verifyDatapackWorld(proof), /已变化/)
})
test('inventory lists ordinary ZIP/directory entries; directory preview reads metadata only', async t => {
  const f = await fixture(t), directory = path.join(f.world, 'datapacks')
  await fs.mkdir(path.join(directory, 'Folder'), { recursive: true }); await fs.writeFile(path.join(directory, 'Folder/pack.mcmeta'), meta)
  await fs.writeFile(path.join(directory, 'Stored.zip'), pack()); await fs.writeFile(path.join(directory, 'ignored.txt'), 'ignore')
  const proof = await captureDatapackWorld(f.instance, f.selection), result = await inventoryDatapacks(proof)
  assert.equal(result.items.length, 2); assert.ok(result.items.every(i => i.activation === 'unknown'))
  const folder = result.items.find(i => i.name === 'Folder')!
  assert.equal(folder.metadata?.description, 'A pack')
  const preview = await inspectDatapackItem(proof, folder.itemId)
  assert.equal(preview.status, 'checked'); assert.match(preview.warnings.join(''), /未递归/)
  const zipItem = result.items.find(i => i.name === 'Stored.zip')!
  assert.equal(zipItem.metadata, undefined)
  assert.equal((await inspectDatapackItem(proof, zipItem.itemId)).status, 'checked')
  assert.ok(!JSON.stringify(result).includes(f.directory))
})
test('changed world identity, selected entry and expired inventory item are rejected', async t => {
  const f = await fixture(t), directory = path.join(f.world, 'datapacks'); await fs.mkdir(directory)
  const file = path.join(directory, 'a.zip'); await fs.writeFile(file, pack())
  const proof = await captureDatapackWorld(f.instance, f.selection), inventory = await inventoryDatapacks(proof)
  await fs.writeFile(file, pack([{ name: 'data/original/function/second.mcfunction', data: 'other' }]))
  await assert.rejects(inspectDatapackItem(proof, inventory.items[0].itemId), /已变化/)
  await assert.rejects(inspectDatapackItem(proof, 'invented'), /已失效/)
  await fs.rename(f.world, f.world + '-old'); await fs.mkdir(f.world)
  await assert.rejects(verifyDatapackWorld(proof), /已变化/)
})
test('static world ancestor, metadata and ZIP links are refused without external writes', async t => {
  const f = await fixture(t), other = path.join(f.directory, 'external'); await fs.mkdir(other)
  if (process.platform === 'win32') return
  await fs.symlink(other, path.join(f.world, 'datapacks'))
  const proof = await captureDatapackWorld(f.instance, f.selection)
  await assert.rejects(inventoryDatapacks(proof), /普通目录/)
  await fs.unlink(path.join(f.world, 'datapacks')); await fs.rename(f.world, f.world + '-old'); await fs.symlink(other, f.world)
  await assert.rejects(captureDatapackWorld(f.instance, f.selection), /链接/)
  const original = path.join(f.directory, 'source.zip'); await fs.writeFile(original, pack()); const linked = path.join(f.directory, 'linked.zip'); await fs.symlink(original, linked)
  await assert.rejects(inspectDatapackZip(linked), /普通文件/)
  assert.deepEqual(await fs.readdir(other), [])
})
test('inventory omits case/NFC collisions and links and is bounded', async t => {
  const f = await fixture(t), directory = path.join(f.world, 'datapacks'); await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, 'a.zip'), pack())
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    await fs.writeFile(path.join(directory, 'A.zip'), pack())
    const p = await captureDatapackWorld(f.instance, f.selection), r = await inventoryDatapacks(p)
    assert.equal(r.items.length, 0); assert.match(r.warnings.join(''), /冲突/)
  } else {
    const p = await captureDatapackWorld(f.instance, f.selection), r = await inventoryDatapacks(p); assert.equal(r.items.length, 1)
  }
  if (process.platform !== 'win32') {
    await fs.symlink('a.zip', path.join(directory, 'link.zip'))
    const p = await captureDatapackWorld(f.instance, f.selection), r = await inventoryDatapacks(p)
    assert.ok(r.warnings.some(w => w.includes('链接')))
  }
})
test('metadata parses legacy, ranges, new-only and scalar/single-pair minor semantics', () => {
  assert.equal(parseDatapackMetadata(Buffer.from(meta)).packFormat, 48)
  assert.deepEqual(parseDatapackMetadata(Buffer.from('{"pack":{"description":"range","pack_format":18,"supported_formats":{"min_inclusive":18,"max_inclusive":48}}}')).supportedFormats, [18, 48])
  const n = parseDatapackMetadata(Buffer.from('{"pack":{"description":"new","min_format":[88],"max_format":88}}'))
  assert.deepEqual(n.minFormat, [88, 0]); assert.deepEqual(n.maxFormat, [88, null]); assert.equal(n.packFormat, undefined)
  const pair = parseDatapackMetadata(Buffer.from('{"pack":{"description":"pair","min_format":[88,1],"max_format":[89,2]}}'))
  assert.deepEqual(pair.maxFormat, [89, 2])
})
test('metadata rejects duplicate decoded keys, invalid UTF8, missing or invalid format and oversized descriptions', () => {
  for (const source of ['{"pack":{"description":"a","description":"b","pack_format":48}}','{"pack":{"description":"a","pack_format":48,"pack_fo\\u0072mat":48}}','{"pack":{"description":"x"}}','{"pack":{"description":"x","pack_format":-1}}','{"pack":{"description":"x","min_format":[88,2],"max_format":[88,1]}}']) assert.throws(() => parseDatapackMetadata(Buffer.from(source)))
  assert.throws(() => parseDatapackMetadata(Buffer.from([0xff])))
  assert.throws(() => parseDatapackMetadata(Buffer.alloc(DATAPACK_LIMITS.metadataBytes + 1)))
})
test('metadata retains feature/overlay warnings and never renders text commands as markup', () => {
  const value = parseDatapackMetadata(Buffer.from(JSON.stringify({ pack: { description: { text: '<b>raw</b>', clickEvent: { action: 'run_command', value: '/op fake' }, extra: [{ translate: 'key' }] }, pack_format: 48 }, features: { enabled: ['minecraft:bundle'] }, overlays: { entries: [{ directory: 'overlay', formats: [48, 49] }] } })))
  assert.equal(value.description, '<b>raw</b>'); assert.equal(value.features[0], 'minecraft:bundle'); assert.deepEqual(value.overlays, ['overlay']); assert.ok(value.warnings.length >= 3)
  assert.match(parseDatapackMetadata(Buffer.from('{"pack":{"description":{"unknown":"value"},"pack_format":48},"future_schema":{}}')).warnings.join(''), /扩展|未解释/)
  assert.ok(parseDatapackMetadata(Buffer.from('{"pack":{"description":{},"pack_format":48},"features":{"enabled":[],"future":true}}')).warnings.length > 0)
})
test('ordinary stored ZIP fully checks entries and independent whole archive SHA512', async t => {
  const bytes = pack(), result = await inspect(t, bytes)
  assert.equal(result.status, 'checked'); assert.equal(result.fileCount, 2); assert.equal(result.archiveBytes, bytes.length)
  assert.equal(result.sha512, createHash('sha512').update(bytes).digest('hex')); assert.equal(result.metadata?.description, 'A pack')
})
test('deflate and data descriptor ZIPs are supported and CRC failure is invalid', async t => {
  const result = await inspect(t, zip([{ name: 'pack.mcmeta', data: meta, deflate: true, descriptor: true }, { ...dataEntry, deflate: true, descriptor: true }]))
  assert.equal(result.status, 'checked')
  const broken = await inspect(t, zip([{ name: 'pack.mcmeta', data: meta }, { ...dataEntry, badCrc: true }]))
  assert.equal(broken.status, 'invalid'); assert.match(broken.reason!, /CRC/)
})
test('deflate trailing compressed bytes and false expanded size are rejected', async t => {
  const extra = await inspect(t, zip([{ name: 'pack.mcmeta', data: meta }, { ...dataEntry, deflate: true, compressedTail: Buffer.from('ignored') }]))
  assert.equal(extra.status, 'invalid'); assert.match(extra.reason!, /多余/)
  const size = await inspect(t, zip([{ name: 'pack.mcmeta', data: meta }, { ...dataEntry, size: 1 }]))
  assert.notEqual(size.status, 'checked')
})
test('ZIP traversal, duplicate metadata, file-directory aliases and symlink payloads are invalid', async t => {
  for (const entry of [ { name: '../outside', data: 'bad' }, { name: 'pack.mcmeta', data: meta }, { name: 'DATA/original/function/test.mcfunction', data: 'case' }, { name: 'data', data: 'file' }, { name: 'link', data: 'target', attributes: 0xa1ff0000 } ]) {
    const result = await inspect(t, pack([entry])); assert.equal(result.status, 'invalid', entry.name)
  }
})
test('resource-only or wrapped ZIPs are not accepted as data packs', async t => {
  const resource = await inspect(t, zip([{ name: 'pack.mcmeta', data: meta }, { name: 'assets/test/a.txt', data: 'resource' }]))
  assert.equal(resource.status, 'invalid'); assert.match(resource.reason!, /资源包/)
  const wrapped = await inspect(t, zip([{ name: 'wrapper/pack.mcmeta', data: meta }, { name: 'wrapper/data/test/function/a.mcfunction', data: 'inert' }]))
  assert.equal(wrapped.status, 'invalid'); assert.match(wrapped.reason!, /外层/)
})
test('ZIP64 is honestly unsupported, malformed EOCD and cancellation are rejected', async t => {
  const zip64 = pack(); zip64.writeUInt16LE(0xffff, zip64.length - 12)
  assert.equal((await inspect(t, zip64)).status, 'unsupported')
  assert.equal((await inspect(t, Buffer.from('not-a-zip'))).status, 'invalid')
  const f = await fixture(t), file = path.join(f.directory, 'cancel.zip'); await fs.writeFile(file, pack())
  const controller = new AbortController(); controller.abort()
  await assert.rejects(inspectDatapackZip(file, { signal: controller.signal }), e => e instanceof Error && e.name === 'AbortError')
})
test('ZIP entry and aggregate expansion budgets reject header-only exaggerated content', async t => {
  const result = await inspect(t, zip([{ name: 'pack.mcmeta', data: meta }, { ...dataEntry, size: DATAPACK_LIMITS.entryBytes + 1 }]))
  assert.equal(result.status, 'unsupported'); assert.match(result.reason!, /上限/)
})
test('ZIP implicit directory prefixes must have consistent case and Unicode spelling', async t => {
  const result = await inspect(t, pack([{ name: 'Data/other/function/file.mcfunction', data: 'other' }]))
  assert.equal(result.status, 'invalid'); assert.match(result.reason!, /前缀/)
})
test('malformed descriptor, overlapping payload offset and encrypted archives cannot pass', async t => {
  const descriptor = zip([{ name: 'pack.mcmeta', data: meta, deflate: true, descriptor: true }, dataEntry])
  const firstDescriptor = descriptor.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08])); descriptor[firstDescriptor + 4] ^= 1
  assert.equal((await inspect(t, descriptor)).status, 'invalid')
  const overlap = pack(), cd = overlap.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])), next = cd + 46 + Buffer.byteLength('pack.mcmeta')
  overlap.writeUInt32LE(0, next + 42)
  assert.equal((await inspect(t, overlap)).status, 'invalid')
  const encrypted = pack(), encryptedCd = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); encrypted.writeUInt16LE(0x0801, encryptedCd + 8)
  assert.equal((await inspect(t, encrypted)).status, 'unsupported')
})
test('directory root metadata symlinks are not interpreted', async t => {
  const f = await fixture(t), packDir = path.join(f.world, 'datapacks/Folder'); await fs.mkdir(packDir, { recursive: true })
  const external = path.join(f.directory, 'external-meta'); await fs.writeFile(external, meta)
  if (process.platform !== 'win32') {
    await fs.symlink(external, path.join(packDir, 'pack.mcmeta'))
    const proof = await captureDatapackWorld(f.instance, f.selection), listed = await inventoryDatapacks(proof)
    assert.equal(listed.items[0].metadata, undefined); assert.ok(listed.items[0].warnings.length)
  }
  assert.equal((await fs.readFile(external)).toString(), meta)
})
test('valid empty deflated directory records are accepted and their payload checked', async t => {
  const result = await inspect(t, pack([{ name: 'empty/', data: '', deflate: true }]))
  assert.equal(result.status, 'checked'); assert.equal(result.fileCount, 2)
})
test('large aggregate directory metadata returns an honest bounded DTO instead of retaining every description', async t => {
  const f = await fixture(t), directory = path.join(f.world, 'datapacks')
  const base = ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200), 'd'.repeat(180)].join('/')
  const metadata = JSON.stringify({ pack: { description: 'original budget fixture', pack_format: 48 }, overlays: { entries: Array.from({ length: 128 }, (_, i) => ({ directory: base + '/' + i, formats: 48 })) } })
  for (let i = 0; i < 12; i++) { const folder = path.join(directory, 'Pack' + i); await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'pack.mcmeta'), metadata) }
  const proof = await captureDatapackWorld(f.instance, f.selection), listed = await inventoryDatapacks(proof)
  assert.equal(listed.truncated, true); assert.ok(listed.items.length < 12)
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= DATAPACK_LIMITS.inventoryDtoBytes)
  assert.match(listed.warnings.join(''), /大小达到上限/)
})
test('metadata bytes are shared across the whole inventory rather than reset per directory', async t => {
  const f = await fixture(t), directory = path.join(f.world, 'datapacks')
  const metadata = JSON.stringify({ pack: { description: 'x'.repeat(120000), pack_format: 48 } })
  for (let i = 0; i < 40; i++) { const folder = path.join(directory, 'Pack' + String(i).padStart(2, '0')); await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'pack.mcmeta'), metadata) }
  const proof = await captureDatapackWorld(f.instance, f.selection), listed = await inventoryDatapacks(proof)
  assert.equal(listed.truncated, true); assert.equal(listed.items.length, 40)
  assert.ok(listed.items.filter(i => i.metadata).length < 40)
  assert.ok(listed.items.some(i => i.warnings.some(w => w.includes('上限'))))
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) < DATAPACK_LIMITS.inventoryDtoBytes)
})
test('warning output is capped and an incomplete name scan returns no actionable ambiguous items', async t => {
  const f = await fixture(t), directory = path.join(f.world, 'datapacks'); await fs.mkdir(directory)
  if (process.platform !== 'win32') {
    for (let i = 0; i < 100; i++) await fs.symlink('missing', path.join(directory, 'link' + i + '.zip'))
    const proof = await captureDatapackWorld(f.instance, f.selection), listed = await inventoryDatapacks(proof)
    assert.ok(listed.warnings.length <= DATAPACK_LIMITS.warningCount); assert.equal(listed.truncated, true)
  }
  for (let i = 0; i <= DATAPACK_LIMITS.inventoryEntries; i++) await fs.writeFile(path.join(directory, 'entry' + i + '.zip'), '')
  const proof = await captureDatapackWorld(f.instance, f.selection), listed = await inventoryDatapacks(proof)
  assert.equal(listed.truncated, true); assert.deepEqual(listed.items, []); assert.equal(proof.entries.size, 0)
})
test('BOM-prefixed ZIP names are not silently normalized into root metadata or data paths', async t => {
  const root = await inspect(t, zip([{ name: '\ufeffpack.mcmeta', data: meta }, dataEntry]))
  assert.equal(root.status, 'invalid')
  const data = await inspect(t, zip([{ name: 'pack.mcmeta', data: meta }, { name: '\ufeffdata/original/function/a.mcfunction', data: 'inert' }]))
  assert.equal(data.status, 'invalid')
  assert.equal(parseDatapackMetadata(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(meta)])).packFormat, 48)
})
