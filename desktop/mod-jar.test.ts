import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { crc32 } from './world-zip'
import { inspectModJar, inspectInstalledMod, MOD_JAR_LIMITS, ModJarReadError } from './mod-jar'
import { scanResourceInventory } from './resource-inventory'

interface Entry {
  name: string; data: string | Buffer; deflate?: boolean; descriptor?: boolean; badCrc?: boolean
  attributes?: number; compressedTail?: Buffer; size?: number; flags?: number; method?: number; extra?: Buffer
}
function zip(entries: Entry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data), compressed = entry.deflate ? deflateRawSync(data) : data
    const body = Buffer.concat([compressed, entry.compressedTail ?? Buffer.alloc(0)]), crc = (crc32(data) + (entry.badCrc ? 1 : 0)) >>> 0
    const flags = entry.flags ?? (0x800 | (entry.descriptor ? 8 : 0)), method = entry.method ?? (entry.deflate ? 8 : 0), extra = entry.extra ?? Buffer.alloc(0)
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8)
    if (!entry.descriptor) { header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(entry.size ?? data.length, 22) }
    header.writeUInt16LE(name.length, 26); header.writeUInt16LE(extra.length, 28)
    const descriptor = entry.descriptor ? Buffer.alloc(16) : Buffer.alloc(0)
    if (entry.descriptor) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(body.length, 8); descriptor.writeUInt32LE(entry.size ?? data.length, 12) }
    local.push(header, name, extra, body, descriptor)
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(entry.size ?? data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(extra.length, 30)
    cd.writeUInt32LE(entry.attributes ?? (entry.name.endsWith('/') ? 0x41ed0010 : 0x81a40000), 38); cd.writeUInt32LE(offset, 42)
    central.push(cd, name, extra); offset += header.length + name.length + extra.length + body.length + descriptor.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cd, end])
}
const fabric = JSON.stringify({ schemaVersion: 1, id: 'original_fixture', version: '1.2.0', name: 'Original inert fixture', environment: '*', depends: { minecraft: '1.21.1' } })
const metadata: Entry = { name: 'fabric.mod.json', data: fabric }
const classEntry: Entry = { name: 'example/Original.class', data: 'Original inert bytes, not an executable class' }
const jar = (extra: Entry[] = []) => zip([metadata, classEntry, ...extra])
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-mod-jar-')), instance = path.join(root, 'instance'), directory = path.join(instance, 'game/mods')
  await fs.mkdir(directory, { recursive: true })
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  return { root, instance, directory }
}
async function fingerprint(file: string) {
  const s = await fs.lstat(file, { bigint: true })
  return [createHash('sha256').update(await fs.readFile(file)).digest('hex'), ...[s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String)]
}
async function read(t: TestContext, bytes: Buffer) {
  const f = await fixture(t), file = path.join(f.root, 'Original.jar'); await fs.writeFile(file, bytes)
  const before = await fingerprint(file), result = await inspectModJar(file)
  assert.deepEqual(await fingerprint(file), before); assert.ok(!JSON.stringify(result).includes(f.root))
  return result
}
async function selection(file: string) {
  const s = await fs.stat(file), name = path.basename(file)
  return { itemId: 'mods:' + createHash('sha256').update(name).digest('hex'), name, sizeBytes: s.size, modifiedAt: new Date(s.mtimeMs).toISOString() }
}
async function withReadHook<T>(file: string, action: () => Promise<void>, run: () => Promise<T>): Promise<T> {
  const probe = await fs.open(file, 'r'), prototype = Object.getPrototypeOf(probe) as { read: (...args: any[]) => Promise<any> }
  await probe.close()
  const original = prototype.read; let armed = true
  prototype.read = async function (...args) {
    const result = await original.apply(this, args)
    if (armed) { armed = false; await action() }
    return result
  }
  try { return await run() } finally { prototype.read = original }
}

test('stored and deflated selected metadata returns outer hash and preserves every source byte and identity', async t => {
  for (const deflate of [false, true]) {
    const bytes = zip([{ ...metadata, deflate }, classEntry]), result = await read(t, bytes)
    assert.equal(result.status, 'metadata-read'); assert.equal(result.disabledSuffix, false)
    assert.equal(result.sha512, createHash('sha512').update(bytes).digest('hex')); assert.equal(result.archiveBytes, bytes.length)
    assert.equal(result.documents[0].mods[0].id, 'original_fixture'); assert.match(result.warnings.join(''), /全部JAR载荷/)
  }
})
test('selected data descriptors and normal compressed empty JAR directories are supported', async t => {
  const result = await read(t, zip([{ name: 'META-INF/', data: '', deflate: true }, { ...metadata, deflate: true, descriptor: true }, classEntry]))
  assert.equal(result.status, 'metadata-read'); assert.equal(result.documents[0].path, 'fabric.mod.json')
})
test('manifest-only library remains no-metadata and never gains invented mod identity', async t => {
  const result = await read(t, zip([{ name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\r\nImplementation-Version: 2.0\r\n\r\n' }, classEntry]))
  assert.equal(result.status, 'no-metadata'); assert.equal(result.documents[0].format, 'manifest')
  assert.ok(result.documents.every(d => d.mods.length === 0)); assert.ok(result.sha512)
})
test('plain ZIP/JAR with no selected metadata is explicit no-metadata, including empty archive', async t => {
  for (const bytes of [zip([classEntry]), zip([])]) {
    const result = await read(t, bytes); assert.equal(result.status, 'no-metadata'); assert.deepEqual(result.documents, []); assert.ok(result.sha512)
  }
})
test('installed .jar.disabled is read as its own file and disabled label is suffix-only', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'Original.jar.disabled'); await fs.writeFile(file, jar())
  const before = await fingerprint(file), result = await inspectInstalledMod(f.instance, await selection(file))
  assert.equal(result.disabledSuffix, true); assert.equal(result.name, 'Original.jar.disabled'); assert.equal(result.status, 'metadata-read')
  assert.deepEqual(await fingerprint(file), before); assert.ok(!JSON.stringify(result).includes(f.root))
  await assert.rejects(inspectModJar(file), /本地普通/)
})
test('production inventory fractional-millisecond timestamp is accepted without Stats Date rounding mismatch', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'Original.jar'); await fs.writeFile(file, jar())
  await fs.utimes(file, 1700000000.0008, 1700000000.0008)
  const inventory = await scanResourceInventory(path.join(f.instance, 'game'), 'mods')
  assert.equal(inventory.items.length, 1)
  const row = inventory.items[0], stats = await fs.lstat(file)
  assert.equal(row.modifiedAt, new Date(stats.mtimeMs).toISOString())
  t.diagnostic(`Original timestamp evidence: numericMs=${stats.mtimeMs}; scanner=${row.modifiedAt}; StatsDate=${stats.mtime.toISOString()}`)
  const before = await fingerprint(file)
  const result = await inspectInstalledMod(f.instance, { itemId: row.id, name: row.name, sizeBytes: row.sizeBytes!, modifiedAt: row.modifiedAt })
  assert.equal(result.status, 'metadata-read'); assert.equal(result.documents[0].mods[0].id, 'original_fixture')
  assert.deepEqual(await fingerprint(file), before)
})
test('installed row rejects wrong item, stale size/mtime, unknown fields and unsafe name before parsing', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'Original.jar'); await fs.writeFile(file, jar()); const s = await selection(file)
  for (const bad of [{ ...s, itemId: 'invented' }, { ...s, sizeBytes: s.sizeBytes + 1 }, { ...s, modifiedAt: '2000-01-01T00:00:00.000Z' }, { ...s, path: file }, { ...s, name: '../Original.jar' }]) await assert.rejects(inspectInstalledMod(f.instance, bad))
  assert.deepEqual(await fs.readFile(file), jar())
})
test('a pre-observation same-byte inode replacement with identical row fields is a fresh observation, not an invented old proof', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'Original.jar'), bytes = jar(); await fs.writeFile(file, bytes); const s = await selection(file), info = await fs.stat(file)
  await fs.rename(file, file + '.old'); await fs.writeFile(file, bytes); await fs.utimes(file, info.atime, info.mtime)
  const actual = await selection(file); const result = await inspectInstalledMod(f.instance, actual)
  assert.equal(result.sha512, createHash('sha512').update(bytes).digest('hex')); assert.equal(result.status, 'metadata-read')
  assert.equal(actual.itemId, s.itemId); assert.equal(actual.sizeBytes, s.sizeBytes)
})
test('same-byte inode replacement while the FD is being read is rejected without publishing stale metadata', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'Original.jar'), bytes = jar(); await fs.writeFile(file, bytes)
  const s = await selection(file)
  await assert.rejects(withReadHook(file, async () => { await fs.rename(file, file + '.old'); await fs.writeFile(file, bytes) }, () => inspectInstalledMod(f.instance, s)), error => error instanceof ModJarReadError && error.code === 'changed')
  assert.deepEqual(await fs.readFile(file), bytes)
})
test('source content mutation during read is detected even if the requested size is retained', async t => {
  const f = await fixture(t), file = path.join(f.root, 'Original.jar'), bytes = jar(); await fs.writeFile(file, bytes)
  await assert.rejects(withReadHook(file, async () => { const changed = Buffer.from(bytes); changed[50] ^= 1; await fs.writeFile(file, changed) }, () => inspectModJar(file)))
})
test('ancestor replacement during read never returns metadata from a displaced source', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'Original.jar'), bytes = jar(); await fs.writeFile(file, bytes)
  await assert.rejects(withReadHook(file, async () => { await fs.rename(f.directory, f.directory + '-old'); await fs.mkdir(f.directory); await fs.writeFile(file, bytes) }, () => inspectModJar(file)), /变化/)
})
test('actual short file reads are looped to completion without truncation or partial outer hash', async t => {
  const f = await fixture(t), file = path.join(f.root, 'Original.jar'), bytes = jar(); await fs.writeFile(file, bytes)
  const probe = await fs.open(file, 'r'), prototype = Object.getPrototypeOf(probe) as { read: (...args: any[]) => Promise<any> }; await probe.close()
  const original = prototype.read
  prototype.read = function (...args) { args[2] = Math.min(args[2], 7); return original.apply(this, args) }
  try { assert.equal((await inspectModJar(file)).sha512, createHash('sha512').update(bytes).digest('hex')) } finally { prototype.read = original }
})
test('pre-abort and actual read-time cancellation throw AbortError and leave source unchanged', async t => {
  const f = await fixture(t), file = path.join(f.root, 'Original.jar'); await fs.writeFile(file, jar()); const before = await fingerprint(file)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(inspectModJar(file, { signal: controller.signal }), { name: 'AbortError' })
  const active = new AbortController()
  await assert.rejects(withReadHook(file, async () => active.abort(), () => inspectModJar(file, { signal: active.signal })), { name: 'AbortError' })
  assert.deepEqual(await fingerprint(file), before)
})
test('links and existing linked ancestors are refused without creating any source or destination', async t => {
  const f = await fixture(t), file = path.join(f.root, 'Original.jar'); await fs.writeFile(file, jar())
  if (process.platform === 'win32') { assert.equal((await inspectModJar(file)).status, 'metadata-read'); return }
  const link = path.join(f.root, 'Linked.jar'); await fs.symlink(file, link)
  await assert.rejects(inspectModJar(link), /普通模组文件/)
  await fs.rename(f.directory, f.directory + '-old'); await fs.symlink(f.root, f.directory)
  await assert.rejects(inspectInstalledMod(f.instance, await selection(file)), /链接/)
})
test('missing installed files and ordinary absent mods directory never get created by reading', async t => {
  const f = await fixture(t), s = { itemId: 'mods:' + createHash('sha256').update('Missing.jar').digest('hex'), name: 'Missing.jar', sizeBytes: 1, modifiedAt: new Date().toISOString() }
  await assert.rejects(inspectInstalledMod(f.instance, s), /不存在/)
  await fs.rm(f.directory, { recursive: true }); await assert.rejects(inspectInstalledMod(f.instance, s))
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' })
})
test('bad selected CRC is invalid with no hash or trusted declarations', async t => {
  const result = await read(t, zip([{ ...metadata, badCrc: true }, classEntry]))
  assert.equal(result.status, 'invalid'); assert.equal(result.sha512, undefined); assert.deepEqual(result.documents, []); assert.match(result.warnings.join(''), /CRC/)
})
test('nonmetadata class CRC/body is deliberately not certified or decompressed', async t => {
  const result = await read(t, zip([metadata, { ...classEntry, deflate: true, badCrc: true, compressedTail: Buffer.from('original trailing bytes') }]))
  assert.equal(result.status, 'metadata-read'); assert.ok(result.sha512); assert.match(result.warnings.join(''), /只校验选定声明/)
})
test('metadata actual size, bad deflate and trailing compressed bytes fail without a hash', async t => {
  for (const entry of [{ ...metadata, size: fabric.length + 1 }, { ...metadata, deflate: true, compressedTail: Buffer.from('junk') }, { ...metadata, method: 8 }]) {
    const result = await read(t, zip([entry])); assert.equal(result.status, 'invalid'); assert.equal(result.sha512, undefined)
  }
})
test('selected metadata per-entry and cumulative declared/actual limits are enforced', async t => {
  const one = await read(t, zip([{ name: 'fabric.mod.json', data: 'x'.repeat(MOD_JAR_LIMITS.metadataBytes + 1) }]))
  assert.equal(one.status, 'unsupported'); assert.equal(one.sha512, undefined)
  const names = ['fabric.mod.json','quilt.mod.json','quilt.mod.json5','META-INF/mods.toml','META-INF/neoforge.mods.toml','META-INF/MANIFEST.MF']
  const all = await read(t, zip(names.map(name => ({ name, data: 'x'.repeat(200 * 1024), deflate: true }))))
  assert.equal(all.status, 'unsupported'); assert.equal(all.sha512, undefined)
})
test('metadata decompression cannot exceed the declared small size to evade bounds', async t => {
  const result = await read(t, zip([{ name: 'fabric.mod.json', data: 'x'.repeat(MOD_JAR_LIMITS.metadataBytes + 1), deflate: true, size: 10 }]))
  assert.equal(result.status, 'unsupported'); assert.equal(result.sha512, undefined)
})
test('duplicate and case/NFC archive names and file-directory prefix conflicts fail', async t => {
  for (const extra of [metadata, { ...metadata, name: 'FABRIC.MOD.JSON' }, { name: 'example', data: 'file' }, { name: 'EXAMPLE/Other.class', data: 'other' }, { name: 'caf\u00e9.class', data: 'a' }, { name: 'cafe\u0301.class', data: 'b' }]) {
    const entries = extra.name === 'caf\u00e9.class' || extra.name === 'cafe\u0301.class' ? [metadata, { name: 'caf\u00e9.class', data: 'a' }, { name: 'cafe\u0301.class', data: 'b' }] : [metadata,classEntry,extra]
    const result = await read(t, zip(entries)); assert.equal(result.status, 'invalid'); assert.equal(result.sha512, undefined)
  }
})
test('unsafe entry names, BOM privileged names, links and unsupported file types never expose metadata', async t => {
  for (const entry of [{ name: '../escape.class', data: 'x' }, { name: '/absolute.class', data: 'x' }, { name: '\ufefffabric.mod.json', data: fabric }, { ...classEntry, attributes: 0xa1ff0000 }, { ...classEntry, attributes: 0x61ff0000 }]) {
    const result = await read(t, zip([metadata,entry])); assert.equal(result.status, 'invalid'); assert.equal(result.sha512, undefined)
  }
})
test('archive path depth and path byte budgets are enforced without extraction', async t => {
  for (const name of [Array.from({ length: 34 }, () => 'a').join('/') + '.class', Array.from({ length: 6 }, () => 'a'.repeat(200)).join('/')]) {
    assert.equal((await read(t, zip([metadata,{ name,data:'x' }]))).status, 'invalid')
  }
})
test('encryption, unknown flags/methods, ZIP64 extras and multivolume records are explicitly unsupported', async t => {
  const extra = Buffer.alloc(4); extra.writeUInt16LE(1)
  for (const entry of [{ ...metadata, flags: 0x801 }, { ...metadata, flags: 0x8000 }, { ...metadata, method: 99 }, { ...metadata, extra }]) {
    const result = await read(t, zip([entry])); assert.equal(result.status, 'unsupported'); assert.equal(result.sha512, undefined)
  }
  const bytes = jar(); bytes.writeUInt16LE(1, bytes.length - 18)
  assert.equal((await read(t, bytes)).status, 'unsupported')
})
test('ZIP64 sentinel and alternate Unicode path extra cannot silently rename privileged metadata', async t => {
  const bytes = jar(); bytes.writeUInt16LE(0xffff, bytes.length - 12)
  assert.equal((await read(t, bytes)).status, 'unsupported')
  const extra = Buffer.alloc(4); extra.writeUInt16LE(0x7075)
  assert.equal((await read(t, zip([{ ...metadata, extra }]))).status, 'unsupported')
})
test('truncation, trailing garbage, overlap and mismatching local names are invalid', async t => {
  const bytes = jar(), overlap = Buffer.from(bytes), mismatch = Buffer.from(bytes)
  const cd = bytes.readUInt32LE(bytes.length - 6), second = cd + 46 + Buffer.byteLength(metadata.name)
  overlap.writeUInt32LE(0, second + 42); mismatch[30] ^= 1
  for (const value of [bytes.subarray(0,bytes.length-1),Buffer.concat([bytes,Buffer.from('junk')]),overlap,mismatch]) {
    const result = await read(t, value); assert.equal(result.status, 'invalid'); assert.equal(result.sha512, undefined)
  }
})
test('descriptor corruption and central/local size disagreement are invalid', async t => {
  const bytes = zip([{ ...metadata, descriptor: true }]), descriptor = Buffer.from(bytes)
  const location = 30 + Buffer.byteLength(metadata.name) + Buffer.byteLength(fabric)
  descriptor.writeUInt32LE(1,location + 4)
  assert.equal((await read(t,descriptor)).status,'invalid')
  const local = jar();local.writeUInt32LE(123,22)
  assert.equal((await read(t,local)).status,'invalid')
})
test('archive byte and central entry-count limits return unsupported without reading giant payloads', async t => {
  const f=await fixture(t),file=path.join(f.root,'Sparse.jar');await fs.writeFile(file,Buffer.alloc(0));await fs.truncate(file,MOD_JAR_LIMITS.archiveBytes+1)
  const result=await inspectModJar(file);assert.equal(result.status,'unsupported');assert.equal(result.sha512,undefined)
  const entries=zip(Array.from({length:MOD_JAR_LIMITS.entries+1},(_,i)=>({name:`x/${i}.class`,data:''})))
  assert.equal((await read(t,entries)).status,'unsupported')
})
test('case-nonexact installed selection is rejected even on case-insensitive filesystems', async t => {
  const f=await fixture(t),file=path.join(f.directory,'Original.jar');await fs.writeFile(file,jar());const s=await selection(file),name='original.jar'
  await assert.rejects(inspectInstalledMod(f.instance,{...s,name,itemId:'mods:'+createHash('sha256').update(name).digest('hex')}))
})
