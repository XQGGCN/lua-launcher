import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { inspectModJarForImport, isModJarImportInspection, MOD_JAR_LIMITS } from './mod-jar'
import type { LocalModImportResult, LocalModImportSource } from './mod-import-types'

export interface LocalModImportProgress { phase: 'copy' | 'verify' | 'commit'; bytesDone: number; totalBytes: number }
export interface LocalModImportOptions {
  instanceId: string
  operationId: string
  signal?: AbortSignal
  onProgress?: (progress: LocalModImportProgress) => void
  /** Required main-owned current source/config/index policy proof. Never supplied over IPC. */
  verifyPolicy: () => Promise<void>
  inspect?: typeof inspectModJarForImport
  /** Test seams, never renderer arguments. */
  hooks?: {
    write?: (handle: fs.FileHandle, bytes: Buffer, offset: number, length: number, position: number) => Promise<number>
    link?: typeof fs.link
    afterIntent?: () => Promise<void>
    beforePublish?: () => Promise<void>
  }
}
export type LocalModImportErrorCode = 'INVALID_INPUT' | 'BUSY' | 'UNSAFE_PATH' | 'SOURCE_CHANGED' | 'DESTINATION_CHANGED' |
  'NAME_COLLISION' | 'INVALID_ARCHIVE' | 'INSUFFICIENT_SPACE' | 'IO_ERROR' | 'LIMIT_EXCEEDED' | 'RECOVERY_REQUIRED'
const messages: Record<LocalModImportErrorCode, string> = {
  INVALID_INPUT: '本地模组导入参数无效，请重新选择并检查文件', BUSY: '此实例已有本地模组导入未结束',
  UNSAFE_PATH: '模组源、目标或祖先包含不支持的路径、链接或特殊文件', SOURCE_CHANGED: '模组源文件已变化，请重新选择并检查',
  DESTINATION_CHANGED: '实例或模组目录在导入期间发生变化，请关闭游戏后刷新重试', NAME_COLLISION: '目标JAR、禁用伙伴或大小写、Unicode等价名称已存在，未覆盖任何文件',
  INVALID_ARCHIVE: '完整JAR载荷检查未通过，未导入文件', INSUFFICIENT_SPACE: '模组导入暂存所需磁盘空间不足',
  IO_ERROR: '模组导入未完成，已创建的准备资料会保留', LIMIT_EXCEEDED: '模组导入超过当前数量、大小或耗时预算',
  RECOVERY_REQUIRED: '本地模组导入结果需要人工检查；请保留 .mod-import-staging 与目标文件，不会自动删除或覆盖，核对后重启',
}
export class LocalModImportError extends Error {
  constructor(public readonly code: LocalModImportErrorCode) { super(messages[code]); this.name = 'LocalModImportError' }
}
function fail(code: LocalModImportErrorCode): never { throw new LocalModImportError(code) }
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code
const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const modId = /^[a-z][a-z0-9_-]{1,63}$/
const fold = (value: string) => value.normalize('NFC').toLowerCase()
const sameNode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
const sameFile = (a: BigIntStats, b: BigIntStats) => sameNode(a,b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const LOCAL_MOD_IMPORT_LIMITS = Object.freeze({ controlBytes: 64 * 1024, operations: 500, directoryEntries: 5000,
  recoveryBytes: 16 * 1024 ** 2, recoveryMs: 5000, operationMs: 15 * 60 * 1000, modIds: 128 })
const active = new Set<string>()
type Chain = Map<string, BigIntStats>
type Budget = { check(): void }
interface Preparing { schema: 1; origin: 'local'; operationId: string; instanceId: string; filename: string; sha512: string; archiveBytes: number; modIds: string[]; createdAt: string }
interface Intent extends Preparing { gameDev: string; gameIno: string }
interface Complete { schema: 1; operationId: string; intentSha256: string; installedAt: string }
interface Finalized { schema: 1; operationId: string; completeSha256: string; verifiedSha512: string; verifiedAt: string }
function plain(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value,key)!)
}
function safeName(value: unknown): value is string {
  return typeof value === 'string' && !!value && !['.','..'].includes(value) && Buffer.byteLength(value) <= 255 &&
    !/[<>:"/\\|?*\p{Cc}\p{Cf}\ud800-\udfff\ufffd]/u.test(value) && !/[ .]$/.test(value) && !/^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value)
}
function safeJar(value: unknown): value is string { return safeName(value) && /\.jar$/i.test(value) }
function validIds(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.length <= LOCAL_MOD_IMPORT_LIMITS.modIds &&
  value.every(id => typeof id === 'string' && modId.test(id)) && new Set(value).size === value.length }
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false
  try { return new Date(value).toISOString() === value } catch { return false }
}
function validPreparing(value: unknown, operationId: string): value is Preparing {
  return plain(value,['schema','origin','operationId','instanceId','filename','sha512','archiveBytes','modIds','createdAt']) && value.schema === 1 && value.origin === 'local' &&
    value.operationId === operationId && uuid.test(operationId) && typeof value.instanceId === 'string' && identifier.test(value.instanceId) && safeJar(value.filename) &&
    typeof value.sha512 === 'string' && /^[a-f0-9]{128}$/.test(value.sha512) && Number.isSafeInteger(value.archiveBytes) && Number(value.archiveBytes) >= 22 &&
    Number(value.archiveBytes) <= MOD_JAR_LIMITS.archiveBytes && validIds(value.modIds) && timestamp(value.createdAt)
}
function validIntent(value: unknown, preparing: Preparing): value is Intent {
  return plain(value,[...Object.keys(preparing),'gameDev','gameIno']) && Object.keys(preparing).every(key => JSON.stringify(value[key]) === JSON.stringify(preparing[key as keyof Preparing])) &&
    typeof value.gameDev === 'string' && /^\d{1,30}$/.test(value.gameDev) && typeof value.gameIno === 'string' && /^\d{1,30}$/.test(value.gameIno)
}
function absolute(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 32768 || /[\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_INPUT')
  const resolved = path.resolve(value); if (resolved === path.parse(resolved).root) fail('INVALID_INPUT'); return resolved
}
function budgetFor(signal?: AbortSignal, duration = LOCAL_MOD_IMPORT_LIMITS.operationMs): Budget {
  const until = performance.now()+duration
  return { check() { signal?.throwIfAborted(); if (performance.now()>until) fail('LIMIT_EXCEEDED') } }
}
const committedBudget: Budget = { check() {} }
async function chain(directory: string, budget: Budget, allowMissing = false): Promise<Chain> {
  let current = path.parse(directory).root; const result: Chain = new Map()
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current,part); budget.check(); let stat: BigIntStats
    try { stat = await fs.lstat(current,{bigint:true}) } catch (error) { if (allowMissing && errno(error)==='ENOENT') return result; throw error }
    budget.check()
    if (stat.isSymbolicLink()) {
      const alias = process.platform==='darwin' && current!==directory && ((current==='/tmp' && await fs.realpath(current)==='/private/tmp') || (current==='/var' && await fs.realpath(current)==='/private/var'))
      if (!alias) fail('UNSAFE_PATH')
    } else if (!stat.isDirectory()) fail('UNSAFE_PATH')
    result.set(current,stat)
  }
  return result
}
async function verifyChain(expected: Chain, budget: Budget): Promise<void> {
  const last = [...expected.keys()].at(-1); if (!last) fail('UNSAFE_PATH')
  const current = await chain(last!,budget)
  for (const [name,stat] of expected) if (!current.has(name) || !sameNode(stat,current.get(name)!)) fail('DESTINATION_CHANGED')
}
async function names(directory: string, max: number, budget: Budget): Promise<string[]> {
  const result: string[] = [], handle = await fs.opendir(directory)
  try { while (true) { budget.check(); const entry = await handle.read(); budget.check(); if (!entry) break; if (result.length>=max) fail('LIMIT_EXCEEDED'); result.push(entry.name) } }
  finally { await handle.close() }
  return result.sort()
}
async function maybeStat(file: string): Promise<BigIntStats | undefined> { try { return await fs.lstat(file,{bigint:true}) } catch(error) { if(errno(error)==='ENOENT') return undefined; throw error } }
async function exactChild(directory: string, selected: string, budget: Budget): Promise<boolean> {
  const matches = (await names(directory,LOCAL_MOD_IMPORT_LIMITS.directoryEntries,budget)).filter(name => fold(name)===fold(selected))
  if (matches.length>1 || matches.length===1 && matches[0]!==selected) fail('NAME_COLLISION')
  return matches.length===1
}
async function writeAll(handle: fs.FileHandle, bytes: Buffer, position: number, budget: Budget, writer?: NonNullable<LocalModImportOptions['hooks']>['write']): Promise<void> {
  for (let done=0; done<bytes.length;) {
    budget.check(); const count = writer ? await writer(handle,bytes,done,bytes.length-done,position+done) : (await handle.write(bytes,done,bytes.length-done,position+done)).bytesWritten
    if (!Number.isSafeInteger(count) || count<=0 || count>bytes.length-done) fail('IO_ERROR'); done+=count
  }
}
async function writeControl(file: string, bytes: Buffer, budget: Budget): Promise<BigIntStats> {
  if (bytes.length>LOCAL_MOD_IMPORT_LIMITS.controlBytes) fail('LIMIT_EXCEEDED')
  const handle = await fs.open(file,'wx',0o600)
  try { await writeAll(handle,bytes,0,budget); await handle.sync(); budget.check(); return await handle.stat({bigint:true}) } finally { await handle.close() }
}
async function readControl(file: string, budget: Budget): Promise<{bytes:Buffer;info:BigIntStats}> {
  await chain(path.dirname(file),budget); const handle = await fs.open(file,flags)
  try {
    budget.check(); const before = await handle.stat({bigint:true})
    if (!before.isFile() || before.size<0n || before.size>BigInt(LOCAL_MOD_IMPORT_LIMITS.controlBytes) || before.nlink<1n || before.nlink>2n) fail('RECOVERY_REQUIRED')
    const bytes=Buffer.alloc(Number(before.size)); let done=0
    while(done<bytes.length) {budget.check();const value=await handle.read(bytes,done,bytes.length-done,done);if(!value.bytesRead)fail('RECOVERY_REQUIRED');done+=value.bytesRead}
    const after=await handle.stat({bigint:true}), atPath=await fs.lstat(file,{bigint:true}); if(!sameFile(before,after)||!sameFile(after,atPath))fail('RECOVERY_REQUIRED')
    return {bytes,info:after}
  } finally {await handle.close()}
}
const json = (bytes:Buffer):unknown => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
const jsonBytes = (value:unknown) => Buffer.from(JSON.stringify(value)+'\n')
async function hashFile(file:string,maximum:number,budget:Budget,expected?:BigIntStats) {
  const ancestors=await chain(path.dirname(file),budget), pathBefore=await fs.lstat(file,{bigint:true})
  if(!pathBefore.isFile()||pathBefore.isSymbolicLink())fail('UNSAFE_PATH')
  const handle=await fs.open(file,flags)
  try {
    const before=await handle.stat({bigint:true});if(!sameFile(pathBefore,before)||!before.isFile()||before.size<0n||before.size>BigInt(maximum)||expected&&!sameFile(before,expected))fail('SOURCE_CHANGED')
    const hash=createHash('sha512'),buffer=Buffer.alloc(1024**2);let done=0
    while(done<Number(before.size)){budget.check();const value=await handle.read(buffer,0,Math.min(buffer.length,Number(before.size)-done),done);if(!value.bytesRead)fail('SOURCE_CHANGED');hash.update(buffer.subarray(0,value.bytesRead));done+=value.bytesRead}
    budget.check();const after=await handle.stat({bigint:true}),atPath=await fs.lstat(file,{bigint:true});if(!sameFile(before,after)||!sameFile(after,atPath))fail('SOURCE_CHANGED');await verifyChain(ancestors,budget)
    return {digest:hash.digest('hex'),info:after}
  }finally{await handle.close()}
}
interface ModsSnapshot { info?:BigIntStats; entries:Map<string,BigIntStats> }
async function snapshotMods(game:string,budget:Budget):Promise<ModsSnapshot>{
  await exactChild(game,'mods',budget);const directory=path.join(game,'mods'), info=await maybeStat(directory), entries=new Map<string,BigIntStats>()
  if(!info)return {entries};if(!info.isDirectory()||info.isSymbolicLink())fail('UNSAFE_PATH')
  const keys=new Set<string>()
  for(const name of await names(directory,LOCAL_MOD_IMPORT_LIMITS.directoryEntries,budget)){
    budget.check();if(!safeName(name)||keys.has(fold(name)))fail('NAME_COLLISION');keys.add(fold(name));const child=await fs.lstat(path.join(directory,name),{bigint:true});if(child.isSymbolicLink()||!child.isFile()&&!child.isDirectory())fail('UNSAFE_PATH');entries.set(name,child)
  }
  if(!sameFile(info,await fs.lstat(directory,{bigint:true})))fail('DESTINATION_CHANGED');return{info,entries}
}
async function verifyMods(game:string,expected:ModsSnapshot,budget:Budget):Promise<void>{
  const current=await snapshotMods(game,budget)
  if(!expected.info?!!current.info:!current.info||!sameFile(expected.info,current.info))fail('DESTINATION_CHANGED')
  if(current.entries.size!==expected.entries.size)fail('DESTINATION_CHANGED')
  for(const[name,stat]of expected.entries)if(!current.entries.has(name)||!sameFile(stat,current.entries.get(name)!))fail('DESTINATION_CHANGED')
}
function assertNoTarget(entries:Map<string,BigIntStats>,filename:string):void{
  const targets=new Set([fold(filename),fold(filename+'.disabled')]);if([...entries.keys()].some(name=>targets.has(fold(name))))fail('NAME_COLLISION')
}

/** Historical controls only: later normal edits/deletion of finalized JARs never become a permanent lock. */
export async function inspectLocalModImportRecovery(instanceDirectory:string,options:{signal?:AbortSignal}={}):Promise<{blocked:boolean;warnings:string[]}>{
  const warnings:string[]=[]
  try{
    const instance=absolute(instanceDirectory),budget=budgetFor(options.signal,LOCAL_MOD_IMPORT_LIMITS.recoveryMs),base=await chain(instance,budget,true)
    if(!base.has(instance))return{blocked:false,warnings}
    await exactChild(instance,'.mod-import-staging',budget);const staging=path.join(instance,'.mod-import-staging');if(!await maybeStat(staging))return{blocked:false,warnings}
    const stagingChain=await chain(staging,budget),operations=await names(staging,LOCAL_MOD_IMPORT_LIMITS.operations,budget);let bytes=0,preparations=0
    const read=async(file:string)=>{const result=await readControl(file,budget);bytes+=result.bytes.length;if(bytes>LOCAL_MOD_IMPORT_LIMITS.recoveryBytes)fail('LIMIT_EXCEEDED');return result}
    for(const operationId of operations){
      budget.check();if(!uuid.test(operationId))fail('RECOVERY_REQUIRED');const container=path.join(staging,operationId),containerChain=await chain(container,budget),children=await names(container,8,budget)
      if(!children.length){preparations++;continue}
      if(children.some(name=>!['PREPARING.json','payload.jar','INTENT.json','COMPLETE.json','.complete.pending','FINALIZED.json'].includes(name)))fail('RECOVERY_REQUIRED')
      const preparedRead=await read(path.join(container,'PREPARING.json')),prepared=json(preparedRead.bytes);if(!validPreparing(prepared,operationId))fail('RECOVERY_REQUIRED')
      if(children.includes('payload.jar')){const stat=await fs.lstat(path.join(container,'payload.jar'),{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||!children.includes('COMPLETE.json')&&stat.size>BigInt(MOD_JAR_LIMITS.archiveBytes))fail('RECOVERY_REQUIRED')}
      if(!children.includes('INTENT.json')){if(children.some(name=>['COMPLETE.json','.complete.pending','FINALIZED.json'].includes(name)))fail('RECOVERY_REQUIRED');preparations++;await verifyChain(containerChain,budget);continue}
      const intentRead=await read(path.join(container,'INTENT.json')),intent=json(intentRead.bytes);if(!validIntent(intent,prepared)||!children.includes('COMPLETE.json')||!children.includes('FINALIZED.json'))fail('RECOVERY_REQUIRED')
      const completeRead=await read(path.join(container,'COMPLETE.json')),complete=json(completeRead.bytes)
      if(!plain(complete,['schema','operationId','intentSha256','installedAt'])||complete.schema!==1||complete.operationId!==operationId||complete.intentSha256!==sha256(intentRead.bytes)||!timestamp(complete.installedAt)||complete.installedAt<prepared.createdAt)fail('RECOVERY_REQUIRED')
      if(children.includes('.complete.pending')){const pending=await read(path.join(container,'.complete.pending'));if(!pending.bytes.equals(completeRead.bytes)||!sameFile(pending.info,completeRead.info)||completeRead.info.nlink!==2n)fail('RECOVERY_REQUIRED')}else if(completeRead.info.nlink!==1n)fail('RECOVERY_REQUIRED')
      const finalRead=await read(path.join(container,'FINALIZED.json')),final=json(finalRead.bytes)
      if(!plain(final,['schema','operationId','completeSha256','verifiedSha512','verifiedAt'])||final.schema!==1||final.operationId!==operationId||final.completeSha256!==sha256(completeRead.bytes)||final.verifiedSha512!==prepared.sha512||!timestamp(final.verifiedAt)||final.verifiedAt<complete.installedAt||finalRead.info.nlink!==1n)fail('RECOVERY_REQUIRED')
      await verifyChain(containerChain,budget)
      for(const[name,info]of [['PREPARING.json',preparedRead.info],['INTENT.json',intentRead.info],['COMPLETE.json',completeRead.info],['FINALIZED.json',finalRead.info]]as const)if(!sameFile(info,await fs.lstat(path.join(container,name),{bigint:true})))fail('RECOVERY_REQUIRED')
    }
    await verifyChain(stagingChain,budget);if(preparations)warnings.push(`保留了 ${preparations} 项尚未进入模组目录写入的准备资料；未自动清理。`)
    return{blocked:false,warnings}
  }catch(error){if(options.signal?.aborted)throw error;return{blocked:true,warnings:[messages.RECOVERY_REQUIRED]}}
}

/** Add exactly one locally sourced JAR. No existing mod, registry or user source is rewritten. */
export async function importLocalModJar(instanceDirectory:string,source:LocalModImportSource,options:LocalModImportOptions):Promise<LocalModImportResult>{
  let instance='',reserved=false,intentAttempted=false
  const warnings=['本地源文件、导入暂存与完成凭据保留，占用额外空间；本版不会自动清理。','文件归位不保证模组代码安全、签名或游戏实际加载；未自动下载依赖或修改其他模组。']
  try{
    if(!plain(source,['file','filename','archiveBytes','sha512','modIds'])||!safeJar(source.filename)||!Number.isSafeInteger(source.archiveBytes)||source.archiveBytes<22||source.archiveBytes>MOD_JAR_LIMITS.archiveBytes||typeof source.sha512!=='string'||!/^[a-f0-9]{128}$/.test(source.sha512)||!validIds(source.modIds)||!options||typeof options.verifyPolicy!=='function'||typeof options.instanceId!=='string'||!identifier.test(options.instanceId)||!uuid.test(options.operationId))fail('INVALID_INPUT')
    instance=absolute(instanceDirectory);const sourceFile=absolute(source.file),budget=budgetFor(options.signal);budget.check()
    if(active.has(instance))fail('BUSY');active.add(instance);reserved=true
    const recovery=await inspectLocalModImportRecovery(instance,{signal:options.signal});if(recovery.blocked)fail('RECOVERY_REQUIRED')
    const game=path.join(instance,'game'),gameChain=await chain(game,budget),initial=await snapshotMods(game,budget);assertNoTarget(initial.entries,source.filename)
    const original=await hashFile(sourceFile,MOD_JAR_LIMITS.archiveBytes,budget);if(original.digest!==source.sha512||Number(original.info.size)!==source.archiveBytes)fail('SOURCE_CHANGED')
    await options.verifyPolicy();budget.check();await verifyChain(gameChain,budget);await verifyMods(game,initial,budget)
    const instanceChain=await chain(instance,budget),staging=path.join(instance,'.mod-import-staging');await exactChild(instance,'.mod-import-staging',budget)
    if(!await maybeStat(staging)){await verifyChain(instanceChain,budget);await fs.mkdir(staging,{mode:0o700})}
    const stagingChain=await chain(staging,budget),container=path.join(staging,options.operationId);await fs.mkdir(container,{mode:0o700});const containerChain=await chain(container,budget)
    const preparing:Preparing={schema:1,origin:'local',operationId:options.operationId,instanceId:options.instanceId,filename:source.filename,archiveBytes:source.archiveBytes,sha512:source.sha512,modIds:[...source.modIds],createdAt:new Date().toISOString()}
    const preparingBytes=jsonBytes(preparing),preparingInfo=await writeControl(path.join(container,'PREPARING.json'),preparingBytes,budget)
    const available=await fs.statfs(container,{bigint:true});budget.check();if(available.bavail*available.bsize<BigInt(source.archiveBytes+16*1024**2))fail('INSUFFICIENT_SPACE')
    const sourceChain=await chain(path.dirname(sourceFile),budget),input=await fs.open(sourceFile,flags),payload=path.join(container,'payload.jar');let output:fs.FileHandle|undefined,payloadInfo:BigIntStats|undefined
    const progress=(phase:LocalModImportProgress['phase'],bytesDone:number)=>{try{const result:unknown=options.onProgress?.({phase,bytesDone,totalBytes:source.archiveBytes});if(result&&typeof(result as PromiseLike<unknown>).then==='function')void Promise.resolve(result).catch(()=>{})}catch{/* Observers cannot decide the filesystem result. */}}
    try{
      output=await fs.open(payload,'wx',0o600);if(!sameFile(original.info,await input.stat({bigint:true})))fail('SOURCE_CHANGED')
      const buffer=Buffer.alloc(1024**2),hash=createHash('sha512');let done=0;progress('copy',0)
      while(done<source.archiveBytes){budget.check();const{bytesRead}=await input.read(buffer,0,Math.min(buffer.length,source.archiveBytes-done),done);if(!bytesRead)fail('SOURCE_CHANGED');const chunk=buffer.subarray(0,bytesRead);hash.update(chunk);await writeAll(output,chunk,done,budget,options.hooks?.write);done+=bytesRead;progress('copy',done)}
      await output.sync();budget.check();if(hash.digest('hex')!==source.sha512||!sameFile(original.info,await input.stat({bigint:true}))||!sameFile(original.info,await fs.lstat(sourceFile,{bigint:true})))fail('SOURCE_CHANGED')
      payloadInfo=await output.stat({bigint:true});if(Number(payloadInfo.size)!==source.archiveBytes)fail('SOURCE_CHANGED')
    }finally{await Promise.allSettled([input.close(),...(output?[output.close()]:[])])}
    await verifyChain(sourceChain,budget);await verifyChain(containerChain,budget);const staged=await hashFile(payload,MOD_JAR_LIMITS.archiveBytes,budget,payloadInfo!)
    if(staged.digest!==source.sha512)fail('SOURCE_CHANGED');progress('verify',0)
    const inspected=await(options.inspect??inspectModJarForImport)(payload,{signal:options.signal});budget.check()
    if(!isModJarImportInspection(inspected)||!inspected.fullPayloadChecked||inspected.details.status!=='metadata-read'||inspected.details.archiveBytes!==source.archiveBytes||inspected.details.sha512!==source.sha512||inspected.details.documents.some(document=>document.status!=='read'))fail('INVALID_ARCHIVE')
    const actualIds=inspected.details.documents.flatMap(document=>document.format==='manifest'?[]:document.mods.map(mod=>mod.id))
    if(!validIds(actualIds)||actualIds.slice().sort().join('\0')!==source.modIds.slice().sort().join('\0'))fail('INVALID_ARCHIVE')
    await options.verifyPolicy();budget.check()
    if((await hashFile(sourceFile,MOD_JAR_LIMITS.archiveBytes,budget,original.info)).digest!==source.sha512||(await hashFile(payload,MOD_JAR_LIMITS.archiveBytes,budget,staged.info)).digest!==source.sha512)fail('SOURCE_CHANGED')
    await verifyChain(stagingChain,budget);await verifyChain(containerChain,budget);await verifyChain(gameChain,budget);await verifyMods(game,initial,budget);assertNoTarget(initial.entries,source.filename)
    const prepareRead=await readControl(path.join(container,'PREPARING.json'),budget);if(!sameFile(preparingInfo,prepareRead.info)||!prepareRead.bytes.equals(preparingBytes))fail('DESTINATION_CHANGED')
    const gameInfo=gameChain.get(game)!,intent:Intent={...preparing,gameDev:String(gameInfo.dev),gameIno:String(gameInfo.ino)},intentBytes=jsonBytes(intent)
    intentAttempted=true;const intentInfo=await writeControl(path.join(container,'INTENT.json'),intentBytes,budget)
    const verifyControls=async()=>{const prepared=await readControl(path.join(container,'PREPARING.json'),committedBudget),actual=await readControl(path.join(container,'INTENT.json'),committedBudget);if(!sameFile(preparingInfo,prepared.info)||!prepared.bytes.equals(preparingBytes)||!sameFile(intentInfo,actual.info)||!actual.bytes.equals(intentBytes))fail('RECOVERY_REQUIRED')}
    await options.hooks?.afterIntent?.();budget.check();await options.hooks?.beforePublish?.();budget.check();await options.verifyPolicy();budget.check()
    await verifyChain(gameChain,budget);await verifyChain(containerChain,budget);await verifyMods(game,initial,budget);assertNoTarget(initial.entries,source.filename);await verifyControls()
    const destination=path.join(game,'mods');if(!initial.info)await fs.mkdir(destination,{mode:0o700})
    const destinationChain=await chain(destination,budget);if(initial.info&&!sameNode(initial.info,destinationChain.get(destination)!))fail('DESTINATION_CHANGED')
    const publication=initial.info?initial:await snapshotMods(game,budget);if(!initial.info&&publication.entries.size)fail('DESTINATION_CHANGED')
    assertNoTarget(publication.entries,source.filename);await verifyMods(game,publication,budget)
    const preNames=await names(container,4,budget);if(preNames.join(',')!==['INTENT.json','PREPARING.json','payload.jar'].sort().join(','))fail('RECOVERY_REQUIRED')
    const beforePublish=await hashFile(payload,MOD_JAR_LIMITS.archiveBytes,budget,staged.info);if(beforePublish.digest!==source.sha512)fail('SOURCE_CHANGED')
    await verifyChain(gameChain,budget);await verifyChain(destinationChain,budget);await verifyChain(containerChain,budget);await verifyMods(game,publication,budget);assertNoTarget((await snapshotMods(game,budget)).entries,source.filename);await verifyControls();budget.check()
    progress('commit',source.archiveBytes)
    const target=path.join(destination,source.filename),link=options.hooks?.link??fs.link;let publicationError:unknown
    try{await link(payload,target)}catch(error){publicationError=error}
    const targetRead=await hashFile(target,MOD_JAR_LIMITS.archiveBytes,committedBudget),linkedPayload=await fs.lstat(payload,{bigint:true})
    if(!sameNode(staged.info,targetRead.info)||!sameFile(linkedPayload,targetRead.info)||targetRead.info.nlink!==2n||targetRead.digest!==source.sha512)fail('RECOVERY_REQUIRED')
    await verifyChain(gameChain,committedBudget);await verifyChain(destinationChain,committedBudget);await verifyChain(containerChain,committedBudget);await verifyControls()
    if(publicationError)warnings.push('目标发布响应异常；已按文件身份与独立读回确认归位成功。')
    const installedAt=new Date(Math.max(Date.now(),Date.parse(preparing.createdAt))).toISOString(),complete:Complete={schema:1,operationId:options.operationId,intentSha256:sha256(intentBytes),installedAt},completeBytes=jsonBytes(complete)
    const pending=path.join(container,'.complete.pending'),completeFile=path.join(container,'COMPLETE.json'),completeInfo=await writeControl(pending,completeBytes,committedBudget);let completionError:unknown
    try{await link(pending,completeFile)}catch(error){completionError=error}
    const completed=await readControl(completeFile,committedBudget),pendingRead=await readControl(pending,committedBudget)
    if(!sameNode(completeInfo,completed.info)||!sameFile(completed.info,pendingRead.info)||completed.info.nlink!==2n||!completed.bytes.equals(completeBytes)||!pendingRead.bytes.equals(completeBytes))fail('RECOVERY_REQUIRED')
    await verifyControls();const finalTarget=await hashFile(target,MOD_JAR_LIMITS.archiveBytes,committedBudget),finalPayload=await fs.lstat(payload,{bigint:true})
    if(!sameNode(staged.info,finalTarget.info)||!sameFile(finalPayload,finalTarget.info)||finalTarget.info.nlink!==2n||finalTarget.digest!==source.sha512)fail('RECOVERY_REQUIRED')
    await verifyChain(gameChain,committedBudget);await verifyChain(destinationChain,committedBudget);await verifyChain(containerChain,committedBudget)
    const finalized:Finalized={schema:1,operationId:options.operationId,completeSha256:sha256(completeBytes),verifiedSha512:source.sha512,verifiedAt:new Date(Math.max(Date.now(),Date.parse(installedAt))).toISOString()},finalizedBytes=jsonBytes(finalized),finalizedFile=path.join(container,'FINALIZED.json'),finalizedInfo=await writeControl(finalizedFile,finalizedBytes,committedBudget)
    const finalProof=await readControl(finalizedFile,committedBudget);if(!sameFile(finalizedInfo,finalProof.info)||finalProof.info.nlink!==1n||!finalProof.bytes.equals(finalizedBytes))fail('RECOVERY_REQUIRED')
    await verifyControls();const finalNames=await names(container,7,committedBudget);if(finalNames.join(',')!==['.complete.pending','COMPLETE.json','FINALIZED.json','INTENT.json','PREPARING.json','payload.jar'].sort().join(','))fail('RECOVERY_REQUIRED')
    if(completionError)warnings.push('完成凭据响应异常；已按字节和身份确认完成。')
    for(const directory of[destination,container]){let handle:fs.FileHandle|undefined;try{handle=await fs.open(directory,flags);await handle.sync()}catch{warnings.push('目录同步未确认，不保证设备断电耐久性。')}finally{try{await handle?.close()}catch{/* A finalized historical result remains complete. */}}}
    return{operationId:options.operationId,instanceId:options.instanceId,filename:source.filename,archiveBytes:source.archiveBytes,sha512:source.sha512,modIds:[...source.modIds],installedAt,warnings}
  }catch(error){
    if(intentAttempted)throw new LocalModImportError('RECOVERY_REQUIRED')
    if(options?.signal?.aborted)throw new DOMException('本地模组导入已取消；尚未进入模组目录写入的准备资料会保留','AbortError')
    if(error instanceof LocalModImportError)throw error
    if(['ENOSPC','EDQUOT'].includes(errno(error)??''))throw new LocalModImportError('INSUFFICIENT_SPACE')
    if(errno(error)==='EEXIST')throw new LocalModImportError('NAME_COLLISION')
    throw new LocalModImportError('IO_ERROR')
  }finally{if(reserved)active.delete(instance)}
}
