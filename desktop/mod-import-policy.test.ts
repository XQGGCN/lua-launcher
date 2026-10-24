import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { crc32 } from './world-zip'
import { inspectModJarForImport, inspectModJar, type ModJarImportInspection } from './mod-jar'
import { assessLocalModImport, fabricNumericRequirement, mavenNumericRequirement, MOD_IMPORT_POLICY_LIMITS, type ModImportContext } from './mod-import-policy'

type Entry = { name: string; data: string | Buffer; deflate?: boolean; badCrc?: boolean; size?: number }
function zip(entries: Entry[]): Buffer {
  let offset = 0; const local: Buffer[] = [], central: Buffer[] = []
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data), body = e.deflate ? deflateRawSync(data) : data, crc = (crc32(data) + (e.badCrc ? 1 : 0)) >>> 0
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(e.deflate ? 8 : 0, 8)
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(e.size ?? data.length, 22); h.writeUInt16LE(name.length, 26)
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(e.deflate ? 8 : 0, 10)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(e.size ?? data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42)
    local.push(h, name, body); central.push(c, name); offset += h.length + name.length + body.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cd, end])
}
const fabric = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, id: 'candidate', version: '1.2.0', environment: '*', depends: { minecraft: '1.21.1', fabricloader: '>=0.16.0' }, ...overrides })
const jar = (raw = fabric(), entries: Entry[] = []) => zip([{ name: 'fabric.mod.json', data: JSON.stringify(raw), deflate: true }, { name: 'Original.txt', data: 'Original inert bytes', deflate: true }, ...entries])
const context: ModImportContext = { gameVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.10' }
const forgeContext: ModImportContext = { gameVersion: '1.20.1', loader: 'forge', loaderVersion: '47.3.0' }
function forgeRaw(extra = '', dependency = '') { return `modLoader="javafml"\nloaderVersion="[47,48)"\nlicense="MIT"\n[[mods]]\nmodId="candidate"\nversion="1.2.0"\ndisplayName="Original inert fixture"\n${extra}\n[[dependencies.candidate]]\nmodId="minecraft"\nmandatory=true\nversionRange="[1.20.1]"\nordering="NONE"\nside="BOTH"\n${dependency}` }
const forgeJar = (raw = forgeRaw()) => zip([{ name: 'META-INF/mods.toml', data: raw, deflate: true }, { name: 'Original.txt', data: 'Inert' }])
async function fixture(t: TestContext, candidate = jar()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-import-policy-')), instance = path.join(root, 'instance'), mods = path.join(instance, 'game/mods'), file = path.join(root, 'Original.jar')
  await fs.mkdir(mods, { recursive: true }); await fs.writeFile(file, candidate)
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const inspect = () => inspectModJarForImport(file)
  const assess = async (c = context, proof?: ModJarImportInspection) => assessLocalModImport(instance, proof ?? await inspect(), c)
  return { root, instance, mods, file, inspect, assess }
}
async function fingerprint(file: string) { const s = await fs.lstat(file, { bigint: true }); return [createHash('sha512').update(await fs.readFile(file)).digest('hex'), ...[s.dev, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs].map(String)] }
function eligible(result: Awaited<ReturnType<typeof assessLocalModImport>>) { assert.equal(result.assessment.eligible, true, result.assessment.reasons.join('; ')); assert.match(result.fingerprint, /^[a-f0-9]{128}$/) }
function blocked(result: Awaited<ReturnType<typeof assessLocalModImport>>, message?: RegExp) { assert.equal(result.assessment.eligible, false); assert.equal(result.fingerprint, ''); if (message) assert.match(result.assessment.reasons.join('; '), message) }

test('Fabric finite exact, comparator AND and OR grammar uses numeric components, not npm semver', () => {
  assert.equal(fabricNumericRequirement('>=1.2 <2.0')('1.9.0'), true)
  assert.equal(fabricNumericRequirement('>=1.2 <2.0')('2'), false)
  assert.equal(fabricNumericRequirement(['1.2.0', '>=2 <3'])('2.5'), true)
  assert.equal(fabricNumericRequirement('1.2')('1.2.0'), true)
  assert.equal(fabricNumericRequirement('*')('2026.1'), true)
  for (const unsupported of ['^1.2', '~1.2', '1.2.x', '1.2-rc1', '1+build', '>=01.2', '1 || 2', ['*', '^1']]) assert.throws(() => fabricNumericRequirement(unsupported))
})
test('Maven numeric exact and single open/closed intervals retain hard requirement meaning', () => {
  assert.equal(mavenNumericRequirement('[1.2]')('1.2.0'), true)
  assert.equal(mavenNumericRequirement('[1.2,2)')('2'), false)
  assert.equal(mavenNumericRequirement('(,1.2]')('1.2'), true)
  assert.equal(mavenNumericRequirement('[1.2,)')('20'), true)
  assert.equal(mavenNumericRequirement('')('1'), true)
  for (const unsupported of ['1.2', '(,1],[2,)', '[1-rc,2)', '[2,1]', '[,1]', '[1,]', '(,)', '[01]']) assert.throws(() => mavenNumericRequirement(unsupported))
})
test('eligible Fabric full observation is stable, source is unchanged, no writes occur', async t => {
  const f = await fixture(t), before = await fingerprint(f.file), proof = await f.inspect()
  assert.equal(proof.fullPayloadChecked, true); assert.ok(proof.archivePaths.includes('Original.txt'))
  const first = await f.assess(context, proof), second = await f.assess(context, proof)
  eligible(first); assert.deepEqual(first, second); assert.deepEqual(first.assessment.candidateIds, ['candidate'])
  assert.deepEqual(await fingerprint(f.file), before); assert.deepEqual(await fs.readdir(f.mods), []); assert.deepEqual(await fs.readdir(f.instance), ['game'])
})
test('missing mods is eligible without mkdir; absent game or linked mods fails closed', async t => {
  const f = await fixture(t); await fs.rmdir(f.mods); eligible(await f.assess()); await assert.rejects(fs.stat(f.mods), { code: 'ENOENT' })
  await fs.rmdir(path.dirname(f.mods)); blocked(await f.assess())
  await fs.mkdir(path.dirname(f.mods));
  if (process.platform !== 'win32') { await fs.symlink(f.root, f.mods); blocked(await f.assess(), /普通目录/) }
})
test('readonly DTO and fabricated full wrapper never authorize import', async t => {
  const f = await fixture(t), proof = await f.inspect()
  blocked(await f.assess(context, { ...proof }), /全部受支持/)
  blocked(await f.assess(context, { details: await inspectModJar(f.file) } as ModJarImportInspection), /全部受支持/)
})
test('nonmetadata payload bad CRC and decoded size now block import while readonly view stays limited', async t => {
  for (const item of [{ name: 'Original.bin', data: 'Original bytes', deflate: true, badCrc: true }, { name: 'Original.bin', data: 'Original bytes', deflate: true, size: 4 }]) {
    const f = await fixture(t, jar(fabric(), [item])); assert.equal((await inspectModJar(f.file)).status, 'metadata-read')
    const full = await f.inspect(); assert.equal(full.fullPayloadChecked, false); assert.equal(full.details.sha512, undefined); blocked(await f.assess(context, full))
  }
})
test('enabled and disabled renamed IDs and provides aliases collide with candidate identity', async t => {
  for (const [filename, raw] of [['Renamed.jar', fabric()], ['Old.jar.disabled', fabric()], ['Alias.jar.disabled', fabric({ id: 'othermod', provides: ['candidate'] })]] as const) {
    const f = await fixture(t); await fs.writeFile(path.join(f.mods, filename), jar(raw)); blocked(await f.assess(), /副本/)
  }
})
test('candidate provided aliases collide with existing enabled or disabled real IDs', async t => {
  const f = await fixture(t, jar(fabric({ provides: ['othermod'] }))); await fs.writeFile(path.join(f.mods, 'Existing.jar.disabled'), jar(fabric({ id: 'othermod' })))
  blocked(await f.assess(), /副本/)
})
test('required dependencies require current enabled exact declaration, never disabled or historical records', async t => {
  const f = await fixture(t, jar(fabric({ depends: { minecraft: '1.21.1', othermod: '>=2.0 <3' } })))
  blocked(await f.assess(), /必需依赖/)
  const other = path.join(f.mods, 'Other.jar'); await fs.writeFile(other + '.disabled', jar(fabric({ id: 'othermod', version: '2.1' })))
  blocked(await f.assess(), /禁用/)
  await fs.rename(other + '.disabled', other); eligible(await f.assess())
  await fs.writeFile(other, jar(fabric({ id: 'othermod', version: '1.9' }))); blocked(await f.assess(), /不兼容/)
})
test('provides presence never invents a version for a hard alias requirement', async t => {
  const f = await fixture(t, jar(fabric({ depends: { aliasmod: '*' } })))
  await fs.writeFile(path.join(f.mods, 'Other.jar'), jar(fabric({ id: 'othermod', provides: ['aliasmod'] }))); blocked(await f.assess(), /别名版本未知/)
})
test('hard conflict and previously installed reverse requirement are both checked', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.mods, 'Other.jar'), jar(fabric({ id: 'othermod', breaks: { candidate: '*' } })))
  blocked(await f.assess(), /冲突/)
  await fs.writeFile(path.join(f.mods, 'Other.jar'), jar(fabric({ id: 'othermod', depends: { candidate: '>=2.0' } })))
  blocked(await f.assess(), /不兼容/)
  await fs.writeFile(path.join(f.mods, 'Other.jar'), jar(fabric({ id: 'othermod', depends: { candidate: '>=1.0 <2' } }))); eligible(await f.assess())
})
test('unknown Java, incompatible game and loader requirements block rather than expected runtime guesses', async t => {
  const f = await fixture(t, jar(fabric({ depends: { java: '>=21' } })))
  blocked(await f.assess(), /实际版本未知/); eligible(await f.assess({ ...context, javaVersion: '21.0.4' }))
  blocked(await f.assess({ ...context, javaVersion: '17' }))
  const other = await fixture(t); blocked(await other.assess({ ...context, gameVersion: '1.20.1' })); blocked(await other.assess({ ...context, loaderVersion: '0.15' }))
  const conflict = await fixture(t, jar(fabric({ breaks: { java: '>=21' } }))); blocked(await conflict.assess(), /Java 冲突/)
  eligible(await conflict.assess({ ...context, javaVersion: '17' })); blocked(await conflict.assess({ ...context, javaVersion: '21' }), /冲突/)
})
test('unknown grammar and raw loading fields dropped by display DTO cannot bypass admission', async t => {
  for (const raw of [fabric({ unknownHardConstraint: 'x' }), fabric({ custom: {} }), fabric({ depends: { minecraft: '^1.21.1' } }), fabric({ languageAdapters: {} }), fabric({ jars: [{ file: 'nested.jar' }] }), fabric({ environment: 'server' }), fabric({ entrypoints: { server: ['Original'] } }), fabric({ entrypoints: { main: [{ adapter: 'custom', value: 'Original' }] } }), fabric({ mixins: [{ config: 'Original.txt', unless: 'unknown' }] }), fabric({ mixins: ['Missing.json'] }), fabric({ accessWidener: 'Missing.aw' })]) {
    const f = await fixture(t, jar(raw)); blocked(await f.assess())
  }
})
test('unknown current index or unsupported library blocks absence claims', async t => {
  for (const bytes of [Buffer.from('not a jar'), zip([{ name: 'Original.txt', data: 'Only library' }])]) {
    const f = await fixture(t); await fs.writeFile(path.join(f.mods, 'Unknown.jar.disabled'), bytes); blocked(await f.assess())
  }
})
test('disabled known identities remain indexed without imposing active game, loader, Java or dependency requirements', async t => {
  const f = await fixture(t), old = path.join(f.mods, 'Old.jar.disabled')
  await fs.writeFile(old, jar(fabric({ id: 'oldmod', version: '1.0-beta', environment: 'server', depends: { minecraft: '1.20.1', java: '>=17', missingmod: '^2.0' }, breaks: { candidate: '*' } })))
  const result = await f.assess(); eligible(result); assert.equal(result.assessment.indexedFiles, 1)
  await fs.writeFile(old, jar(fabric({ id: 'oldmod', provides: ['candidate'], depends: { java: '>=17', minecraft: '1.20.1' } }))); blocked(await f.assess(), /副本/)
  await fs.writeFile(old, forgeJar(forgeRaw().replace('modId="candidate"', 'modId="oldforge"').replace('dependencies.candidate', 'dependencies.oldforge'))); eligible(await f.assess())
  await fs.rename(old, old.replace('.disabled', '')); blocked(await f.assess())
})
test('duplicate IDs across current enabled/disabled files make the whole index ambiguous', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.mods, 'Other1.jar'), jar(fabric({ id: 'othermod' }))); await fs.writeFile(path.join(f.mods, 'Other2.jar.disabled'), jar(fabric({ id: 'othermod' })))
  blocked(await f.assess(), /重复/)
})
test('candidate reserved and duplicate IDs/provides are rejected', async t => {
  for (const raw of [fabric({ id: 'minecraft' }), fabric({ provides: ['forge'] }), fabric({ provides: ['candidate'] }), fabric({ provides: ['aliasmod', 'aliasmod'] })]) { const f = await fixture(t, jar(raw)); blocked(await f.assess()) }
})
test('nested jars and undeclared service-provider plugins block fullchecked candidates', async t => {
  for (const name of ['META-INF/jarjar/metadata.json', 'nested/Other.jar', 'META-INF/services/example.Provider']) { const f = await fixture(t, jar(fabric(), [{ name, data: 'Original inert bytes' }])); blocked(await f.assess(), /嵌套|服务提供者/) }
})
test('disabled candidate does not silently become enabled; filename partners reject case/NFC collisions', async t => {
  const f = await fixture(t), disabled = f.file + '.disabled'; await fs.rename(f.file, disabled); blocked(await f.assess(context, await inspectModJarForImport(disabled)), /隐式恢复/)
  await fs.rename(disabled, f.file); await fs.writeFile(path.join(f.mods, 'original.JAR.disabled'), jar(fabric({ id: 'othermod' }))); blocked(await f.assess(), /伙伴/)
})
test('bounded complete index checks files and aggregate bytes before expensive archive reads', async t => {
  const f = await fixture(t)
  for (let i = 0; i <= MOD_IMPORT_POLICY_LIMITS.files; i++) await fs.writeFile(path.join(f.mods, `Original${i}.jar`), '')
  blocked(await f.assess(), /256文件/)
  await fs.rm(f.mods, { recursive: true }); await fs.mkdir(f.mods); const sparse = await fs.open(path.join(f.mods, 'Large.jar'), 'wx'); await sparse.truncate(MOD_IMPORT_POLICY_LIMITS.archiveBytes + 1); await sparse.close()
  blocked(await f.assess(), /512MiB/)
})
test('elapsed policy deadline is enforced even before the timer callback can run', async t => {
  const f = await fixture(t), inspected = await f.inspect(); let calls = 0
  const clock = t.mock.method(performance, 'now', () => ++calls === 1 ? 0 : MOD_IMPORT_POLICY_LIMITS.durationMs + 1)
  try { blocked(await f.assess(context, inspected), /60秒预算/) } finally { clock.mock.restore() }
  assert.deepEqual(await fs.readdir(f.mods), [])
})
test('unrecognized current folder and links cannot be silently omitted by index', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.mods, 'Folder')); blocked(await f.assess(), /不能证明完整索引/)
  await fs.rmdir(path.join(f.mods, 'Folder'))
  if (process.platform !== 'win32') { await fs.symlink(f.file, path.join(f.mods, 'Linked.jar')); blocked(await f.assess(), /不能证明完整索引/) }
})
test('historical registry is bounded, hashed, observed but never treated as current byte ownership', async t => {
  const f = await fixture(t), registry = path.join(f.instance, 'managed-mods.json'), first = await f.assess(); eligible(first)
  await fs.writeFile(registry, JSON.stringify({ project: { versionId: 'old', filename: 'Historical.jar' } })); const changed = await f.assess(); eligible(changed); assert.notEqual(changed.fingerprint, first.fingerprint)
  await fs.writeFile(registry, JSON.stringify({ project: { versionId: 'old', filename: 'Original.jar' } })); blocked(await f.assess(), /历史记录/)
})
test('invalid, duplicate decoded registry fields and incomplete history block policy', async t => {
  const f = await fixture(t), registry = path.join(f.instance, 'managed-mods.json')
  for (const raw of ['{', '{"p":{"filename":"Old.jar","filename":"Other.jar","versionId":"v"}}', '{"p":{"filename":"Old.jar","versionId":"v"},"\\u0070":{"filename":"Other.jar","versionId":"v"}}', '{"p":{"filename":"../Bad.jar","versionId":"v"}}', '{"p":{"filename":"Old.jar","versionId":"v","extra":true}}']) {
    await fs.writeFile(registry, raw); blocked(await f.assess())
  }
})
test('fresh collection fingerprints change with current bytes, names and identity even when compatible', async t => {
  const f = await fixture(t), file = path.join(f.mods, 'Other.jar'); await fs.writeFile(file, jar(fabric({ id: 'othermod' })))
  const first = await f.assess(); eligible(first)
  await fs.rename(file, file + '.disabled'); const second = await f.assess(); eligible(second); assert.notEqual(first.fingerprint, second.fingerprint)
  await fs.writeFile(file + '.disabled', jar(fabric({ id: 'othermod', version: '1.3' }))); const third = await f.assess(); eligible(third); assert.notEqual(second.fingerprint, third.fingerprint)
})
test('actual read-time collection changes and exact cancellation are detected with no mutation', async t => {
  const f = await fixture(t), other = path.join(f.mods, 'Other.jar'); await fs.writeFile(other, jar(fabric({ id: 'othermod' }))); const candidate = await f.inspect()
  const handle = await fs.open(other, 'r'), prototype = Object.getPrototypeOf(handle) as { read: (...args: any[]) => Promise<any> }; await handle.close(); const original = prototype.read; let armed = true
  prototype.read = async function (...args) { const result = await original.apply(this, args); if (armed) { armed = false; await fs.writeFile(path.join(f.mods, 'Late.txt'), 'Original late file') } return result }
  try { blocked(await f.assess(context, candidate), /集合/) } finally { prototype.read = original }
  const controller = new AbortController(); controller.abort(); await assert.rejects(assessLocalModImport(f.instance, candidate, context, { signal: controller.signal }), { name: 'AbortError' })
})
test('representative Forge javafml major language range and exact Minecraft interval are usable', async t => {
  const f = await fixture(t, forgeJar()); eligible(await f.assess(forgeContext)); blocked(await f.assess({ ...forgeContext, loaderVersion: '48.1' }), /语言加载器/)
  blocked(await f.assess({ ...forgeContext, languageLoaderVersion: '46' }), /主版本/)
})
test('Forge multiple declaration IDs plus Manifest jarVersion retain exact original identities', async t => {
  const raw = forgeRaw().replace('version="1.2.0"', 'version="${file.jarVersion}"') + '\n[[mods]]\nmodId="secondmod"\nversion="2.0"\n'
  const f = await fixture(t, zip([{ name: 'META-INF/mods.toml', data: raw }, { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\r\nImplementation-Version: 1.2.0\r\n\r\n' }]))
  const result = await f.assess(forgeContext); eligible(result); assert.deepEqual(result.assessment.candidateIds, ['candidate', 'secondmod'])
})
test('Forge hard requirements and Java features require actual values; Maven soft version is not exact', async t => {
  const feature = await fixture(t, forgeJar(forgeRaw('[mods.features]\njava_version="[17,)"')))
  blocked(await feature.assess(forgeContext), /实际 Java 版本未知/); eligible(await feature.assess({ ...forgeContext, javaVersion: '17.0.12' }))
  const soft = await fixture(t, forgeJar(forgeRaw().replace('[1.20.1]', '1.20.1'))); blocked(await soft.assess(forgeContext), /软版本/)
})
test('Forge unknown services, nested dependencies, load ordering and unsupported NeoForge never become compatible by display projection', async t => {
  for (const raw of [forgeRaw().replace('license="MIT"', 'license="MIT"\nservices=["Unknown"]'), forgeRaw().replace('ordering="NONE"', 'ordering="AFTER"'), forgeRaw().replace('mandatory=true', 'mandatory=true\nunless="unknown"'), forgeRaw().replace('modLoader="javafml"', 'modLoader="custom"')]) {
    const f = await fixture(t, forgeJar(raw)); blocked(await f.assess(forgeContext))
  }
  const f = await fixture(t, forgeJar()); blocked(await f.assess({ ...forgeContext, loader: 'neoforge' }))
})
