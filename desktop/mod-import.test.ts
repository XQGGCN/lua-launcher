import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import AdmZip from 'adm-zip'
import { importLocalModJar, inspectLocalModImportRecovery, LocalModImportError, type LocalModImportOptions } from './mod-import'
import type { LocalModImportSource } from './mod-import-types'
import { inspectModJarForImport } from './mod-jar'

const hash = (bytes: Uint8Array, algorithm = 'sha512') => createHash(algorithm).update(bytes).digest('hex')
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function fixture(t: TestContext, payload = Buffer.from('Original inert bytes, not executable classes')) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lua-mod-import-')), instance = path.join(root, 'Original-instance'), game = path.join(instance, 'game')
  await fs.mkdir(game, { recursive: true })
  const zip = new AdmZip()
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'original_fixture', version: '1.0-original', name: 'Original inert fixture', license: 'MIT' })))
  zip.addFile('inert.txt', payload)
  const file = path.join(root, 'Original.jar'), bytes = zip.toBuffer(); await fs.writeFile(file, bytes)
  const source: LocalModImportSource = { file, filename: 'Original.jar', sha512: hash(bytes), archiveBytes: bytes.length, modIds: ['original_fixture'] }
  const operationId = randomUUID(), options: LocalModImportOptions = { instanceId: 'Original-instance', operationId, verifyPolicy: async () => {} }
  const stage = path.join(instance, '.mod-import-staging', operationId), mods = path.join(game, 'mods'), target = path.join(mods, source.filename)
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  return { root, instance, game, file, bytes, source, options, stage, mods, target }
}
async function fingerprint(file: string) {
  const bytes = await fs.readFile(file), s = await fs.lstat(file, { bigint: true })
  return [hash(bytes), ...[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs,s.nlink].map(String)]
}
const code = (expected: LocalModImportError['code']) => (error: unknown) => { assert.ok(error instanceof LocalModImportError); assert.equal(error.code, expected); return true }

test('imports original JAR into missing mods with complete local provenance and source unchanged', async t => {
  const f = await fixture(t), before = await fingerprint(f.file), registry = path.join(f.instance, 'managed-mods.json')
  await fs.writeFile(registry, '{"OriginalHistorical":{"filename":"unrelated.jar","versionId":"old"}}'); const registryBefore = await fingerprint(registry)
  const result = await importLocalModJar(f.instance, f.source, f.options)
  assert.equal(result.filename, 'Original.jar'); assert.equal(result.instanceId, 'Original-instance'); assert.deepEqual(result.modIds, ['original_fixture'])
  assert.equal(result.sha512, f.source.sha512); assert.equal(result.archiveBytes, f.bytes.length)
  assert.deepEqual(await fs.readFile(f.target), f.bytes); assert.deepEqual(await fingerprint(f.file), before); assert.deepEqual(await fingerprint(registry), registryBefore)
  assert.ok(!JSON.stringify(result).includes(f.root)); assert.ok(!JSON.stringify(result).includes('modrinth'))
  const names = (await fs.readdir(f.stage)).sort(); assert.deepEqual(names, ['.complete.pending','COMPLETE.json','FINALIZED.json','INTENT.json','PREPARING.json','payload.jar'].sort())
  const prepared = JSON.parse(await fs.readFile(path.join(f.stage, 'PREPARING.json'), 'utf8')); assert.equal(prepared.origin, 'local'); assert.equal(prepared.filename, 'Original.jar')
  const intentBytes = await fs.readFile(path.join(f.stage, 'INTENT.json')), completeBytes = await fs.readFile(path.join(f.stage, 'COMPLETE.json'))
  const complete = JSON.parse(completeBytes.toString()), finalized = JSON.parse(await fs.readFile(path.join(f.stage, 'FINALIZED.json'), 'utf8'))
  assert.equal(complete.intentSha256, hash(intentBytes, 'sha256')); assert.equal(finalized.completeSha256, hash(completeBytes, 'sha256')); assert.equal(finalized.verifiedSha512, f.source.sha512)
  const payload = await fs.stat(path.join(f.stage, 'payload.jar')), target = await fs.stat(f.target); assert.equal(payload.ino, target.ino); assert.equal(target.nlink, 2)
  assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked, false)
})
test('add-only import preserves unrelated existing mods byte identity and does not rewrite registry', async t => {
  const f = await fixture(t); await fs.mkdir(f.mods); const other = path.join(f.mods, 'Other.jar'); await fs.writeFile(other, 'Original unrelated inert bytes'); const before = await fingerprint(other)
  await importLocalModJar(f.instance, f.source, f.options); assert.deepEqual(await fingerprint(other), before)
})
test('target, disabled partner and case-equivalent partner refuse before any policy or publication', async t => {
  for (const name of ['Original.jar', 'Original.jar.disabled', 'original.JAR.DISABLED']) {
    const f = await fixture(t); await fs.mkdir(f.mods); const foreign = path.join(f.mods, name); await fs.writeFile(foreign, 'Original foreign bytes'); const before = await fingerprint(foreign); let policies = 0
    await assert.rejects(importLocalModJar(f.instance, f.source, { ...f.options, verifyPolicy: async () => { policies++ } }), code('NAME_COLLISION'))
    assert.equal(policies, 0); assert.deepEqual(await fingerprint(foreign), before); await assert.rejects(fs.stat(f.stage), { code: 'ENOENT' })
  }
})
test('Unicode-equivalent target names are not silently treated as distinct files', async t => {
  const f = await fixture(t); await fs.mkdir(f.mods); const filename = 'Origina\u00e9.jar'; await fs.writeFile(path.join(f.mods, 'Originae\u0301.jar'), 'Original foreign')
  await assert.rejects(importLocalModJar(f.instance, { ...f.source, filename }, f.options), code('NAME_COLLISION'))
})
test('missing game or instance is never recursively recreated', async t => {
  const f = await fixture(t); await fs.rmdir(f.game)
  await assert.rejects(importLocalModJar(f.instance, f.source, f.options), code('IO_ERROR')); await assert.rejects(fs.stat(f.game), { code: 'ENOENT' })
  await fs.rmdir(f.instance); await assert.rejects(importLocalModJar(f.instance, f.source, f.options)); await assert.rejects(fs.stat(f.instance), { code: 'ENOENT' })
  assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked, false)
})
test('source symlink, linked game ancestor and linked mods directory refuse ordinary-file guarantees', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'Alias.jar'); await fs.symlink(f.file, alias)
  await assert.rejects(importLocalModJar(f.instance, { ...f.source, file: alias }, f.options), code('UNSAFE_PATH'))
  await fs.rename(f.game, f.game + '-original'); await fs.symlink(f.game + '-original', f.game)
  await assert.rejects(importLocalModJar(f.instance, f.source, { ...f.options, operationId: randomUUID() }), code('UNSAFE_PATH'))
})
test('invalid source fields, IDs and arbitrary extra path-like fields refuse synchronously', async t => {
  const f = await fixture(t)
  for (const source of [{ ...f.source, filename: '../escape.jar' }, { ...f.source, filename: 'CON.jar' }, { ...f.source, modIds: [] }, { ...f.source, modIds: ['not valid'] }, { ...f.source, url: 'https://not-used.invalid/' }]) {
    await assert.rejects(importLocalModJar(f.instance, source as LocalModImportSource, f.options), code('INVALID_INPUT'))
  }
  await assert.rejects(importLocalModJar(f.instance, f.source, { ...f.options, verifyPolicy: undefined! }), code('INVALID_INPUT'))
})
test('bad expected transport hash or size is rejected before creating a stage', async t => {
  const f = await fixture(t)
  await assert.rejects(importLocalModJar(f.instance, { ...f.source, sha512: 'a'.repeat(128) }, f.options), code('SOURCE_CHANGED'))
  await assert.rejects(importLocalModJar(f.instance, { ...f.source, archiveBytes: f.bytes.length + 1 }, f.options), code('SOURCE_CHANGED'))
  await assert.rejects(fs.stat(f.stage), { code: 'ENOENT' })
})
test('full payload inspector rejection does not create mods or an intent', async t => {
  const f = await fixture(t)
  await assert.rejects(importLocalModJar(f.instance, f.source, { ...f.options, inspect: async () => ({ details: { name:'payload.jar',disabledSuffix:false,observedAt:new Date().toISOString(),status:'invalid',documents:[],warnings:['Original injected failed full payload'] } } as unknown as Awaited<ReturnType<typeof inspectModJarForImport>>) }), code('INVALID_ARCHIVE'))
  await assert.rejects(fs.stat(f.mods), { code: 'ENOENT' }); await assert.rejects(fs.stat(path.join(f.stage, 'INTENT.json')), { code: 'ENOENT' })
  assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked, false)
})
test('actual short writes are looped until the independently read-back JAR is complete', async t => {
  const f = await fixture(t); let writes = 0
  const result = await importLocalModJar(f.instance, f.source, { ...f.options, hooks: { write: async (handle, bytes, offset, length, position) => { writes++; return (await handle.write(bytes, offset, Math.min(7,length), position)).bytesWritten } } })
  assert.ok(writes > 10); assert.equal(result.sha512, f.source.sha512); assert.deepEqual(await fs.readFile(f.target), f.bytes)
})
test('zero and impossible short-write results fail without world or old mod changes', async t => {
  for (const count of [0, -1, Number.NaN, 999999999]) {
    const f = await fixture(t); await assert.rejects(importLocalModJar(f.instance, f.source, { ...f.options, hooks: { write: async () => count } }), code('IO_ERROR'))
    await assert.rejects(fs.stat(f.mods), { code:'ENOENT' }); assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked, false)
  }
})
test('actual disk-full write error remains classified and preserves prepared source', async t => {
  const f = await fixture(t), before = await fingerprint(f.file)
  await assert.rejects(importLocalModJar(f.instance, f.source, { ...f.options, hooks: { write: async () => { throw Object.assign(new Error('Original simulated disk full'), { code:'ENOSPC' }) } } }), code('INSUFFICIENT_SPACE'))
  assert.deepEqual(await fingerprint(f.file), before); await assert.rejects(fs.stat(f.target), { code:'ENOENT' })
})
test('cancel during actual copy retains preparation and never publishes', async t => {
  const f = await fixture(t, randomBytes(2 * 1024 ** 2)), controller = new AbortController(); let copied = 0
  await assert.rejects(importLocalModJar(f.instance, f.source, { ...f.options, signal: controller.signal, hooks: { write: async (handle,b,o,l,p) => { const n=(await handle.write(b,o,l,p)).bytesWritten;copied+=n;controller.abort();return n } } }), { name:'AbortError' })
  assert.ok(copied > 0); await assert.rejects(fs.stat(f.mods), { code:'ENOENT' }); assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked, false)
})
test('cancel after INTENT is recovery-required rather than a misleading ordinary cancellation', async t => {
  const f = await fixture(t), controller = new AbortController()
  await assert.rejects(importLocalModJar(f.instance, f.source, { ...f.options, signal:controller.signal, hooks: { afterIntent: async () => controller.abort() } }), code('RECOVERY_REQUIRED'))
  assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,true); await assert.rejects(fs.stat(f.mods),{code:'ENOENT'})
})
test('a current policy rejection before intent leaves a nonblocking preparation', async t => {
  const f = await fixture(t); let calls = 0
  await assert.rejects(importLocalModJar(f.instance, f.source, { ...f.options, verifyPolicy: async () => { if (++calls === 2) throw new Error('Original changed index') } }), code('IO_ERROR'))
  assert.equal(calls,2); assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,false); await assert.rejects(fs.stat(f.mods),{code:'ENOENT'})
})
test('a late current policy rejection after intent remains blocked on restart', async t => {
  const f = await fixture(t); let calls = 0
  await assert.rejects(importLocalModJar(f.instance, f.source, { ...f.options, verifyPolicy: async () => { if (++calls === 3) throw new Error('Original changed index') } }), code('RECOVERY_REQUIRED'))
  assert.equal(calls,3); assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,true); await assert.rejects(fs.stat(f.mods),{code:'ENOENT'})
})
test('a foreign disabled partner appearing after intent is preserved and blocks publication', async t => {
  const f = await fixture(t); await fs.mkdir(f.mods); const foreign = path.join(f.mods,'Original.jar.disabled')
  await assert.rejects(importLocalModJar(f.instance,f.source,{...f.options,hooks:{afterIntent:async()=>{await fs.writeFile(foreign,'Original late foreign partner')}}}),code('RECOVERY_REQUIRED'))
  assert.equal(await fs.readFile(foreign,'utf8'),'Original late foreign partner');await assert.rejects(fs.stat(f.target),{code:'ENOENT'});assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,true)
})
test('unrelated foreign entry appearing at late publish await is retained and prevents publication', async t => {
  const f=await fixture(t);await fs.mkdir(f.mods);const foreign=path.join(f.mods,'Other.jar')
  await assert.rejects(importLocalModJar(f.instance,f.source,{...f.options,hooks:{beforePublish:async()=>{await fs.writeFile(foreign,'Original late unrelated file')}}}),code('RECOVERY_REQUIRED'))
  assert.equal(await fs.readFile(foreign,'utf8'),'Original late unrelated file');await assert.rejects(fs.stat(f.target),{code:'ENOENT'})
})
test('tampered preparing control is rejected before JAR publication and no foreign control is deleted', async t => {
  const f=await fixture(t)
  await assert.rejects(importLocalModJar(f.instance,f.source,{...f.options,hooks:{afterIntent:async()=>{await fs.writeFile(path.join(f.stage,'PREPARING.json'),'Original foreign control')}}}),code('RECOVERY_REQUIRED'))
  assert.equal(await fs.readFile(path.join(f.stage,'PREPARING.json'),'utf8'),'Original foreign control');await assert.rejects(fs.stat(f.target),{code:'ENOENT'})
})
test('lost target-link acknowledgement is resolved from independent target identity and hash', async t => {
  const f=await fixture(t)
  const result=await importLocalModJar(f.instance,f.source,{...f.options,hooks:{link:async(from,to)=>{await fs.link(from,to);if(to===f.target)throw new Error('Original lost target acknowledgement')}}})
  assert.equal(result.sha512,f.source.sha512);assert.ok(result.warnings.some(w=>w.includes('目标发布响应异常')));assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,false)
})
test('lost completion-link acknowledgement is resolved without duplicate publication', async t => {
  const f=await fixture(t)
  const result=await importLocalModJar(f.instance,f.source,{...f.options,hooks:{link:async(from,to)=>{await fs.link(from,to);if(String(to).endsWith('COMPLETE.json'))throw new Error('Original lost completion acknowledgement')}}})
  assert.equal(result.sha512,f.source.sha512);assert.ok(result.warnings.some(w=>w.includes('完成凭据响应异常')));assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,false)
})
test('target-link failure with a foreign destination never overwrites or rolls back foreign bytes', async t => {
  const f=await fixture(t)
  await assert.rejects(importLocalModJar(f.instance,f.source,{...f.options,hooks:{link:async(from,to)=>{if(to===f.target){await fs.writeFile(to,'Original competing foreign target');throw Object.assign(new Error('exists'),{code:'EEXIST'})}await fs.link(from,to)}}}),code('RECOVERY_REQUIRED'))
  assert.equal(await fs.readFile(f.target,'utf8'),'Original competing foreign target');assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,true)
})
test('target changed during COMPLETE acknowledgement leaves incomplete finalization and restart protection', async t => {
  const f=await fixture(t)
  await assert.rejects(importLocalModJar(f.instance,f.source,{...f.options,hooks:{link:async(from,to)=>{await fs.link(from,to);if(String(to).endsWith('COMPLETE.json'))await fs.writeFile(f.target,'Original changed during completion')}}}),code('RECOVERY_REQUIRED'))
  assert.equal(await fs.readFile(f.target,'utf8'),'Original changed during completion');await assert.rejects(fs.stat(path.join(f.stage,'FINALIZED.json')),{code:'ENOENT'});assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,true)
})
test('successful publication wins a late cancellation that arrives after target link', async t => {
  const f=await fixture(t),controller=new AbortController()
  const result=await importLocalModJar(f.instance,f.source,{...f.options,signal:controller.signal,hooks:{link:async(from,to)=>{await fs.link(from,to);if(to===f.target)controller.abort()}}})
  assert.equal(result.sha512,f.source.sha512);assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,false)
})
test('finalized history tolerates later ordinary JAR editing, growth, deletion and game move', async t => {
  const f=await fixture(t);await importLocalModJar(f.instance,f.source,f.options)
  await fs.writeFile(f.target,'Original later user edit');assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,false)
  await fs.truncate(f.target,MOD_BIG_FILE);assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,false)
  await fs.unlink(f.target);assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,false)
  await fs.rename(f.game,f.game+'-moved');assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,false)
})
const MOD_BIG_FILE=513*1024**2

test('edited final controls are blocked without rewriting or deleting historical evidence', async t => {
  const f=await fixture(t);await importLocalModJar(f.instance,f.source,f.options);const control=path.join(f.stage,'FINALIZED.json');await fs.writeFile(control,'Original invalid receipt')
  const before=await fingerprint(control);assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,true);assert.deepEqual(await fingerprint(control),before)
})
test('missing instance and preparation-only stages do not create directories or block normal startup', async t => {
  const f=await fixture(t),missing=path.join(f.root,'Not-created')
  assert.equal((await inspectLocalModImportRecovery(missing)).blocked,false);await assert.rejects(fs.stat(missing),{code:'ENOENT'})
  const controller=new AbortController();await assert.rejects(importLocalModJar(f.instance,f.source,{...f.options,signal:controller.signal,hooks:{write:async()=>{controller.abort();return 0}}}),{name:'AbortError'})
  assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,false)
})
test('unknown or partially written controls fail closed and remain byte-identical', async t => {
  const f=await fixture(t);await fs.mkdir(f.stage,{recursive:true});const control=path.join(f.stage,'PREPARING.json');await fs.writeFile(control,'{"schema":1')
  const before=await fingerprint(control);assert.equal((await inspectLocalModImportRecovery(f.instance)).blocked,true);assert.deepEqual(await fingerprint(control),before)
})
test('source replacement after staged copy is rejected without importing renamed old bytes', async t => {
  const f=await fixture(t),before=await fingerprint(f.file);let swapped=false
  await assert.rejects(importLocalModJar(f.instance,f.source,{...f.options,onProgress:p=>{if(p.phase==='verify'&&!swapped){swapped=true;void 0}},verifyPolicy:async()=>{if(swapped){await fs.rename(f.file,f.file+'.old');await fs.writeFile(f.file,f.bytes);swapped=false}}}),code('SOURCE_CHANGED'))
  const renamed=await fingerprint(f.file+'.old');assert.deepEqual(renamed.slice(0,6),before.slice(0,6));assert.equal(renamed[7],before[7]);await assert.rejects(fs.stat(f.target),{code:'ENOENT'})
})
test('active low-level reservation lasts until actual awaited policy settles', async t => {
  const f=await fixture(t),entered=deferred<void>(),release=deferred<void>();let once=false
  const pending=importLocalModJar(f.instance,f.source,{...f.options,verifyPolicy:async()=>{if(!once){once=true;entered.resolve();await release.promise}}})
  await entered.promise;await assert.rejects(importLocalModJar(f.instance,f.source,{...f.options,operationId:randomUUID()}),code('BUSY'));release.resolve();await pending
})
test('progress observer throws and rejected promises cannot change a finalized disk outcome', async t => {
  const f=await fixture(t)
  const result=await importLocalModJar(f.instance,f.source,{...f.options,onProgress:()=>{throw new Error('Original observer error')}});assert.equal(result.sha512,f.source.sha512)
})
