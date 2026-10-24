import { createHash } from 'node:crypto'
import { constants, type BigIntStats, type Dir } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parse as parseToml } from 'smol-toml'
import { inspectModJarForImport, isModJarImportInspection, type ModJarImportInspection } from './mod-jar'
import type { ModImportAssessment } from './mod-import-types'

/** Deliberately bounded admission, not a dependency solver or a safety verdict. */
export const MOD_IMPORT_POLICY_LIMITS = Object.freeze({ files: 256, directoryEntries: 1024, archiveBytes: 512 * 1024 ** 2,
  registryBytes: 1024 ** 2, registryEntries: 1024, durationMs: 60000, reasons: 32, ids: 128 })
export interface ModImportContext {
  gameVersion: string
  loader: 'fabric' | 'forge' | 'neoforge' | 'vanilla'
  loaderVersion?: string
  /** Observed actual runtime version, never the game's requested Java major. */
  javaVersion?: string
  languageLoaderVersion?: string
}
type ObjectValue = Record<string, unknown>
type Predicate = (version: string) => boolean
type Dependency = { id: string; predicate: Predicate; required: boolean; conflict: boolean; raw: string }
type Declaration = { id: string; version: string; aliases: string[]; dependencies: Dependency[] }
type Proof = { filename: string; identity: string; sha512: string; disabled: boolean; mods: Declaration[] }
const fold = (s: string) => s.normalize('NFC').toLowerCase()
const ownObject = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
const identity = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs, s.nlink].map(String).join(':')
const nodeIdentity = (s: BigIntStats) => [s.dev, s.ino, s.mode].map(String).join(':')
const idPattern = /^[a-z][a-z0-9_-]{1,63}$/
const numericPattern = /^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,7}$/
class PolicyFailure extends Error {}
const block = (message: string): never => { throw new PolicyFailure(message) }
function fields(v: unknown, keys: readonly string[], label: string): asserts v is ObjectValue {
  if (!ownObject(v) || Object.keys(v).some(key => !keys.includes(key))) block(label + '含尚不能解释的字段或结构')
}
function text(v: unknown, label: string): string {
  if (typeof v !== 'string' || !v || v.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(v)) block(label + '无效')
  return v as string
}
function modId(v: unknown): string { const result = text(v, '模组标识'); if (!idPattern.test(result)) block('模组标识不受支持'); return result }
function numeric(v: unknown): string { const result = text(v, '版本'); if (!numericPattern.test(result)) block('仅支持不含预发布、构建或占位符的有限数字发布版本'); return result }
function compare(a: string, b: string): number {
  const left = numeric(a).split('.').map(BigInt), right = numeric(b).split('.').map(BigInt)
  for (let i = 0; i < Math.max(left.length, right.length); i++) { const d = (left[i] ?? 0n) - (right[i] ?? 0n); if (d) return d < 0n ? -1 : 1 }
  return 0
}
/** Fabric: whitespace AND, array OR; only numeric exact/comparators and '*'. */
export function fabricNumericRequirement(value: unknown): Predicate {
  const alternatives = Array.isArray(value) ? value : [value]
  if (!alternatives.length || alternatives.length > 256) block('Fabric 版本条件为空或过多')
  const conditions = alternatives.map(raw => {
    const source = text(raw, 'Fabric 版本条件')
    if (source === '*') return (() => true) as Predicate
    const parts = source.split(/ +/)
    if (parts.length > 32 || parts.some(p => !p)) block('Fabric 版本条件超限或无效')
    const checks = parts.map(part => {
      const match = /^(>=|<=|>|<|=)?(.+)$/.exec(part)!, version = numeric(match[2]), operator = match[1] ?? '='
      return (actual: string) => { const n = compare(actual, version); return operator === '=' ? n === 0 : operator === '>=' ? n >= 0 : operator === '<=' ? n <= 0 : operator === '>' ? n > 0 : n < 0 }
    })
    return (actual: string) => checks.every(check => check(actual))
  })
  return actual => { numeric(actual); return conditions.some(check => check(actual)) }
}
/** Maven: empty any, [numeric] exact, one bounded/unbounded numeric interval. Bare versions are soft, not exact. */
export function mavenNumericRequirement(value: unknown): Predicate {
  if (value === '') return actual => { numeric(actual); return true }
  const source = text(value, 'Maven 版本条件')
  const exact = /^\[([^,\[\]()]+)\]$/.exec(source)
  if (exact) { const version = numeric(exact[1]); return actual => compare(actual, version) === 0 }
  const range = /^([\[(])([^,\[\]()]*)?,([^,\[\]()]*)?([\])])$/.exec(source)
  if (!range) block('Maven 仅支持数字精确区间或单个数字上下界区间；软版本、并集和限定词尚不支持')
  const low = range![2] ? numeric(range![2]) : undefined, high = range![3] ? numeric(range![3]) : undefined
  if ((!low && range![1] !== '(') || (!high && range![4] !== ')') || (!low && !high) || low && high && compare(low, high) > 0) block('Maven 数字区间边界无效')
  return actual => { numeric(actual); return (!low || (range![1] === '[' ? compare(actual, low) >= 0 : compare(actual, low) > 0)) && (!high || (range![4] === ']' ? compare(actual, high) <= 0 : compare(actual, high) < 0)) }
}
function list(v: unknown, label: string): unknown[] { if (!Array.isArray(v) || v.length > 256) block(label + '超限或不是数组'); return v as unknown[] }
function rootJSON(bytes: Uint8Array): ObjectValue {
  // inspectModJarForImport already ran strict duplicate-key/prototype/size/depth validation.
  const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  if (!ownObject(result)) block('Fabric 根声明不是对象')
  return result as ObjectValue
}
function requireContext(dependencies: Dependency[], context: ModImportContext): void {
  const builtins = new Map<string, string>([['minecraft', numeric(context.gameVersion)]])
  if (context.loader === 'fabric') builtins.set('fabricloader', numeric(context.loaderVersion))
  if (context.loader === 'forge') builtins.set('forge', numeric(context.loaderVersion))
  if (context.javaVersion !== undefined) builtins.set('java', numeric(context.javaVersion))
  for (const dep of dependencies) if (['minecraft', 'fabricloader', 'forge', 'java'].includes(dep.id)) {
    const actual = builtins.get(dep.id)
    if (dep.required && (!actual || !dep.predicate(actual))) block('必需环境条件未满足或实际版本未知：' + dep.id)
    if (dep.conflict && dep.id === 'java' && !actual) block('实际 Java 版本未知，无法排除声明的 Java 冲突')
    if (dep.conflict && actual && dep.predicate(actual)) block('与当前环境冲突：' + dep.id)
  }
}
function fabric(inspection: ModJarImportInspection, context: ModImportContext, active: boolean): Declaration[] {
  const raw = rootJSON(inspection.metadata.get('fabric.mod.json')!)
  fields(raw, ['schemaVersion', 'id', 'version', 'name', 'description', 'authors', 'contributors', 'contact', 'license', 'icon', 'environment',
    'entrypoints', 'mixins', 'accessWidener', 'provides', 'depends', 'recommends', 'suggests', 'conflicts', 'breaks', 'jars', 'languageAdapters', 'custom'], 'Fabric 根声明')
  if (raw.schemaVersion !== 1 || active && context.loader !== 'fabric') block('只支持 Fabric 1 声明与明确的 Fabric 实例')
  if (raw.environment !== undefined && !['*', 'client', 'server'].includes(String(raw.environment)) || active && raw.environment === 'server') block('服务端或未知 Fabric 环境不能导入客户端实例')
  if (raw.custom !== undefined || raw.languageAdapters !== undefined || raw.jars !== undefined && list(raw.jars, '嵌套 JAR').length) block('自定义声明、语言适配器或嵌套 JAR 尚不能证明兼容')
  if (active && raw.accessWidener !== undefined && !inspection.archivePaths.includes(text(raw.accessWidener, '访问扩展路径'))) block('访问扩展路径不存在或不是受支持的明确文件')
  if (active && raw.mixins !== undefined) for (const mixin of list(raw.mixins, 'Mixin 配置')) {
    let config: unknown = mixin, environment: unknown
    if (typeof mixin !== 'string') { fields(mixin, ['config', 'environment'], 'Mixin 配置'); config = mixin.config; environment = mixin.environment }
    if (environment !== undefined && !['*', 'client', 'server'].includes(String(environment))) block('Mixin 环境尚不能解释')
    if (!inspection.archivePaths.includes(text(config, 'Mixin 配置路径'))) block('Mixin 配置路径不存在或不是受支持的明确文件')
  }
  if (raw.entrypoints !== undefined) {
    if (!ownObject(raw.entrypoints)) block('Fabric 入口结构未知')
    for (const [key, entries] of Object.entries(raw.entrypoints as ObjectValue)) {
      if (!(active ? ['main', 'client'] : ['main', 'client', 'server']).includes(key)) block('Fabric 自定义或服务端入口尚不支持')
      for (const entry of list(entries, '入口')) if (typeof entry !== 'string') { fields(entry, ['adapter', 'value'], 'Fabric 入口'); if (entry.adapter !== undefined && entry.adapter !== 'default') block('自定义入口适配器尚不支持'); text(entry.value, '入口') }
    }
  }
  const id = modId(raw.id), version = active ? numeric(raw.version) : text(raw.version, '模组版本'), aliases = raw.provides === undefined ? [] : list(raw.provides, '别名').map(modId), dependencies: Dependency[] = []
  for (const key of ['depends', 'recommends', 'suggests', 'conflicts', 'breaks']) if (active && raw[key] !== undefined) {
    if (!ownObject(raw[key])) block('Fabric 依赖不是对象')
    for (const [dependencyId, requirement] of Object.entries(raw[key] as ObjectValue)) dependencies.push({ id: modId(dependencyId),
      predicate: fabricNumericRequirement(requirement), required: key === 'depends', conflict: key === 'breaks' || key === 'conflicts', raw: JSON.stringify(requirement) })
  }
  if (active) requireContext(dependencies, context)
  return [{ id, version, aliases, dependencies }]
}
function forge(inspection: ModJarImportInspection, context: ModImportContext, active: boolean): Declaration[] {
  const raw = parseToml(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(inspection.metadata.get('META-INF/mods.toml')!), { maxDepth: 32, unsafeKeyBehaviour: 'throw', useLegacyDate: true }) as ObjectValue
  fields(raw, ['modLoader', 'loaderVersion', 'license', 'issueTrackerURL', 'showAsResourcePack', 'showAsDataPack', 'mods', 'dependencies', 'services', 'properties', 'clientSideOnly'], 'Forge 根声明')
  if (active && context.loader !== 'forge' || raw.modLoader !== 'javafml') block('本版只支持明确 Forge 实例的 javafml 语言加载器')
  for (const flag of ['showAsResourcePack', 'showAsDataPack', 'clientSideOnly']) if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') block('Forge 加载选项必须是明确布尔值')
  if (raw.services !== undefined || raw.properties !== undefined || raw.clientSideOnly !== undefined && raw.clientSideOnly !== false) block('Forge 服务、属性替换或额外客户端约束尚不支持')
  // Official Forge docs define javafml's language version as the major Forge version.
  if (active) {
    const loader = numeric(context.loaderVersion), language = loader.split('.')[0]
    if (context.languageLoaderVersion !== undefined && compare(numeric(context.languageLoaderVersion), language)) block('Forge 语言版本与当前 Forge 主版本不一致')
    if (!mavenNumericRequirement(raw.loaderVersion)(language)) block('Forge 语言加载器版本不兼容')
  }
  const doc = inspection.details.documents.find(d => d.format === 'forge')!
  const mods = list(raw.mods, 'Forge 模组').map((value, index): Declaration => {
    fields(value, ['modId', 'version', 'displayName', 'description', 'authors', 'credits', 'license', 'logoFile', 'logoBlur', 'displayURL', 'updateJSONURL', 'displayTest', 'namespace', 'features', 'modproperties'], 'Forge 模组')
    const id = modId(value.modId)
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(id)) block('Forge 模组标识无效')
    if (value.namespace !== undefined && value.namespace !== id || value.modproperties !== undefined || value.displayTest !== undefined && value.displayTest !== 'MATCH_VERSION') block('Forge 命名空间、属性或自定义版本匹配尚不支持')
    if (value.features !== undefined) {
      fields(value.features, ['java_version'], 'Forge 特性')
      if (active && value.features.java_version !== undefined && (!context.javaVersion || !mavenNumericRequirement(value.features.java_version)(numeric(context.javaVersion)))) block('Forge Java 特性要求未满足或实际 Java 版本未知')
    }
    const rawVersion = value.version === '${file.jarVersion}' ? doc.mods[index]?.version : value.version
    const version = active ? numeric(rawVersion) : text(rawVersion, '模组版本')
    return { id, version, aliases: [], dependencies: [] }
  })
  if (!mods.length) block('Forge 没有可导入的模组声明')
  if (active && raw.dependencies !== undefined) {
    if (!ownObject(raw.dependencies)) block('Forge 依赖表无效')
    for (const [ownerId, entries] of Object.entries(raw.dependencies as ObjectValue)) {
      const owner = mods.find(mod => mod.id === ownerId); if (!owner) block('Forge 存在不属于当前声明的依赖表')
      for (const item of list(entries, 'Forge 依赖')) {
        fields(item, ['modId', 'mandatory', 'versionRange', 'ordering', 'side', 'referralUrl'], 'Forge 依赖')
        if (typeof item.mandatory !== 'boolean' || item.ordering !== undefined && item.ordering !== 'NONE' || item.side !== undefined && !['BOTH', 'CLIENT', 'SERVER'].includes(String(item.side))) block('Forge 依赖强制性、排序或环境尚不能解释')
        const dep: Dependency = { id: modId(item.modId), predicate: mavenNumericRequirement(item.versionRange ?? ''), required: item.mandatory as boolean, conflict: false, raw: String(item.versionRange ?? '') }
        if (item.side !== 'SERVER') owner!.dependencies.push(dep)
      }
    }
  }
  for (const mod of mods) requireContext(mod.dependencies, context)
  return mods
}
function declarations(inspection: ModJarImportInspection, context: ModImportContext, active = true): Declaration[] {
  if (!isModJarImportInspection(inspection) || !inspection.fullPayloadChecked || !inspection.sourceIdentity || inspection.details.status !== 'metadata-read' || !/^[a-f0-9]{128}$/.test(inspection.details.sha512 ?? '')) block('尚未完成全部受支持 JAR 载荷与声明校验')
  const formats = [...inspection.metadata.keys()].filter(name => name !== 'META-INF/MANIFEST.MF')
  if (formats.length !== 1 || !['fabric.mod.json', 'META-INF/mods.toml'].includes(formats[0])) block('混合、Quilt、NeoForge 或未知声明尚不能启用导入')
  if (inspection.archivePaths.some(name => /\.jar$/i.test(name) || /^META-INF\/(?:jarjar|services)\//i.test(name))) block('嵌套 JAR、JarJar 或服务提供者需要额外加载语义，尚不能导入')
  const result = formats[0] === 'fabric.mod.json' ? fabric(inspection, context, active) : forge(inspection, context, active)
  const ids = result.flatMap(mod => [mod.id, ...mod.aliases])
  if (ids.length > MOD_IMPORT_POLICY_LIMITS.ids || new Set(ids).size !== ids.length || ids.some(id => ['minecraft', 'java', 'fabricloader', 'forge', 'neoforge'].includes(id))) block('声明标识、别名重复或冒用了内置环境标识')
  return result
}
function safeName(value: string): boolean { return !!value && value !== '.' && value !== '..' && Buffer.byteLength(value) <= 255 && !/[<>:"/\\|?*\p{Cc}\p{Cf}\ud800-\udfff\ufffd]/u.test(value) && !/[ .]$/.test(value) && !/^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value) }
async function ancestors(directory: string, check: () => void): Promise<Map<string, string>> {
  let current = path.parse(directory).root; const proof = new Map<string, string>()
  for (const part of directory.slice(current.length).split(path.sep)) {
    check(); current = path.join(current, part); const info = await fs.lstat(current, { bigint: true }); check()
    if (info.isSymbolicLink()) {
      const alias = process.platform === 'darwin' && current !== directory && (current === '/tmp' && await fs.realpath(current) === '/private/tmp' || current === '/var' && await fs.realpath(current) === '/private/var')
      if (!alias) block('实例目录祖先含链接')
    } else if (!info.isDirectory()) block('实例路径不是普通目录')
    proof.set(current, nodeIdentity(info))
  }
  return proof
}
async function snapshot(directory: string, check: () => void): Promise<string[][] | undefined> {
  let handle: Dir
  try { handle = await fs.opendir(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const rows: string[][] = [], seen = new Set<string>()
  try {
    for await (const entry of handle) {
      check(); if (rows.length >= MOD_IMPORT_POLICY_LIMITS.directoryEntries) block('当前模组目录超过完整索引条目预算')
      if (!safeName(entry.name) || seen.has(fold(entry.name))) block('当前模组目录有不安全或大小写 Unicode 冲突名称')
      seen.add(fold(entry.name)); const info = await fs.lstat(path.join(directory, entry.name), { bigint: true }); check()
      if (!info.isFile() || info.isSymbolicLink()) block('当前模组目录含目录、链接或特殊项，不能证明完整索引')
      rows.push([entry.name, identity(info), String(info.size)])
    }
  } finally { await handle.close().catch(() => {}) }
  return rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
}
/** The registry has exactly two object levels and string leaves. Detect duplicate
 * decoded keys before JSON.parse could discard a historical filename. */
function registryJSON(source: string): ObjectValue {
  let at = 0, nodes = 0
  const whitespace = () => { while (at < source.length && /[\x20\t\r\n]/.test(source[at])) at++ }
  const string = (): string => {
    whitespace(); if (source[at] !== '"') block('历史模组记录需要字符串字段')
    const start = at++
    while (at < source.length) {
      const c = source[at++]; if (c === '\\') at++
      else if (c === '"') { const result: unknown = JSON.parse(source.slice(start, at)); if (typeof result !== 'string' || result.length > 4096) block('历史模组记录文字无效'); return result as string }
    }
    return block('历史模组记录字符串未结束')
  }
  const object = (depth: number): ObjectValue => {
    whitespace(); if (depth > 1 || source[at++] !== '{') block('历史模组记录结构无效')
    const result: ObjectValue = Object.create(null), seen = new Set<string>(); whitespace()
    if (source[at] === '}') { at++; return result }
    while (at < source.length) {
      if (++nodes > MOD_IMPORT_POLICY_LIMITS.registryEntries * 3) block('历史模组记录节点超限')
      const key = string(); if (seen.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) block('历史模组记录含重复或歧义键')
      seen.add(key); whitespace(); if (source[at++] !== ':') block('历史模组记录字段无效')
      result[key] = depth === 0 ? object(1) : string(); whitespace()
      const end = source[at++]; if (end === '}') return result; if (end !== ',') block('历史模组记录对象无效')
    }
    return block('历史模组记录对象未结束')
  }
  const result = object(0); whitespace(); if (at !== source.length) block('历史模组记录含尾随内容'); return result
}
async function registry(instance: string, check: () => void): Promise<{ hash: string; identity: string; names: string[] }> {
  const file = path.join(instance, 'managed-mods.json'); check()
  const before = await fs.lstat(file, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
  if (!before) return { hash: 'absent', identity: 'absent', names: [] }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MOD_IMPORT_POLICY_LIMITS.registryBytes)) block('历史模组记录不是受限普通文件')
  const fd = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    if (identity(await fd.stat({ bigint: true })) !== identity(before)) block('历史模组记录已变化')
    const bytes = Buffer.alloc(Number(before.size)); let done = 0
    while (done < bytes.length) { check(); const r = await fd.read(bytes, done, bytes.length - done, done); if (!r.bytesRead) block('历史模组记录读取不完整'); done += r.bytesRead }
    check()
    if (identity(await fd.stat({ bigint: true })) !== identity(before) || identity(await fs.lstat(file, { bigint: true })) !== identity(before)) block('历史模组记录读取期间变化')
    const raw: unknown = registryJSON(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!ownObject(raw) || Object.keys(raw).length > MOD_IMPORT_POLICY_LIMITS.registryEntries) block('历史模组记录无效或超过完整索引预算')
    const names: string[] = [], projects = new Map<string, string>()
    for (const [key, item] of Object.entries(raw as ObjectValue)) {
      if (!/^(?:(?:modrinth|bbsmc):)?[A-Za-z0-9_-]{1,128}$/.test(key)) block('历史模组来源标识无效')
      fields(item, ['filename', 'versionId'], '历史模组记录')
      if (typeof item.filename !== 'string' || !safeName(item.filename) || !/\.jar$/i.test(item.filename) || typeof item.versionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.versionId)) block('历史模组记录字段无效')
      const project = key.includes(':') ? key : 'modrinth:' + key, value = JSON.stringify(item)
      if (projects.has(project) && projects.get(project) !== value) block('历史新旧来源记录冲突')
      projects.set(project, value); names.push(item.filename as string)
    }
    return { hash: createHash('sha512').update(bytes).digest('hex'), identity: identity(before), names }
  } finally { await fd.close() }
}
/** Main only. Recompute and compare its private fingerprint immediately before mutation. */
export async function assessLocalModImport(instanceDirectory: string, inspection: ModJarImportInspection, context: ModImportContext,
  options: { signal?: AbortSignal } = {}): Promise<{ assessment: ModImportAssessment; fingerprint: string }> {
  const assessment: ModImportAssessment = { eligible: false, candidateIds: [], reasons: [], warnings: ['仅证明当前有限兼容条件；不等于模组代码安全、签名或实际游戏加载验证'], indexedFiles: 0 }
  const timeout = new AbortController(), deadline = performance.now() + MOD_IMPORT_POLICY_LIMITS.durationMs,
    timer = setTimeout(() => timeout.abort(new PolicyFailure('当前模组完整索引超过60秒预算')), MOD_IMPORT_POLICY_LIMITS.durationMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
  const check = () => { signal.throwIfAborted(); if (performance.now() > deadline) block('当前模组完整索引超过60秒预算') }
  let fingerprint = ''
  try {
    check()
    if (typeof instanceDirectory !== 'string' || !path.isAbsolute(instanceDirectory) || /[\p{Cc}\p{Cf}]/u.test(instanceDirectory) || path.resolve(instanceDirectory) === path.parse(instanceDirectory).root) block('实例路径无效')
    if (!context || !['fabric', 'forge'].includes(context.loader)) block('本版仅支持 Fabric 或 Forge 实例的有限启用导入')
    numeric(context.gameVersion); numeric(context.loaderVersion)
    if (context.javaVersion !== undefined) numeric(context.javaVersion)
    if (inspection?.details?.disabledSuffix || !/\.jar$/i.test(inspection?.details?.name ?? '') || !safeName(inspection.details.name)) block('候选必须是明确启用的普通 .jar，不能隐式恢复 .disabled 文件')
    const candidate = declarations(inspection, context); assessment.candidateIds = candidate.map(mod => mod.id)
    const instance = path.resolve(instanceDirectory), game = path.join(instance, 'game'), mods = path.join(game, 'mods')
    const chain = await ancestors(game, check)
    const modsBefore = await fs.lstat(mods, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (modsBefore && (!modsBefore.isDirectory() || modsBefore.isSymbolicLink())) block('mods 不是普通目录')
    const modsIdentity = modsBefore ? nodeIdentity(modsBefore) : undefined
    const before = await snapshot(mods, check), registryBefore = await registry(instance, check)
    if (Boolean(modsBefore) !== Boolean(before)) block('mods 目录在索引开始时发生变化')
    const jarRows = (before ?? []).filter(row => /\.jar(?:\.disabled)?$/i.test(row[0]))
    if (jarRows.length > MOD_IMPORT_POLICY_LIMITS.files || jarRows.reduce((sum, row) => sum + BigInt(row[2]), 0n) > BigInt(MOD_IMPORT_POLICY_LIMITS.archiveBytes)) block('当前模组完整索引超过256文件或累计512MiB预算')
    const names = new Set((before ?? []).map(row => fold(row[0])))
    if (names.has(fold(inspection.details.name)) || names.has(fold(inspection.details.name + '.disabled'))) block('候选文件名或禁用伙伴已存在；不会覆盖或静默启用')
    // Historical filenames are not ownership proof. Preserve their observation,
    // and never infer that an old project record authorizes replacing any byte.
    if (registryBefore.names.some(name => fold(name) === fold(inspection.details.name))) block('候选文件名已有站点历史记录，需先明确处理历史文件')
    const proofs: Proof[] = []
    for (const [filename, expectedIdentity] of jarRows) {
      check(); const observed = await inspectModJarForImport(path.join(mods, filename), { signal }); check()
      if (observed.sourceIdentity !== expectedIdentity) block('当前模组文件在索引期间发生变化')
      const indexed = declarations(observed, context, !observed.details.disabledSuffix)
      proofs.push({ filename, identity: observed.sourceIdentity, sha512: observed.details.sha512!, disabled: observed.details.disabledSuffix, mods: indexed }); assessment.indexedFiles++
    }
    const all = new Map<string, { mod: Declaration; enabled: boolean; alias: boolean }>()
    for (const proof of proofs) for (const mod of proof.mods) for (const key of [mod.id, ...mod.aliases]) {
      check()
      if (all.has(key)) block('现有启用或禁用模组标识/别名重复，当前索引有歧义：' + key)
      all.set(key, { mod, enabled: !proof.disabled, alias: key !== mod.id })
    }
    for (const mod of candidate) for (const key of [mod.id, ...mod.aliases]) {
      check()
      if (all.has(key)) block('候选标识或别名已有启用或禁用副本：' + key)
      all.set(key, { mod, enabled: true, alias: key !== mod.id })
    }
    for (const mod of [...proofs.filter(proof => !proof.disabled).flatMap(proof => proof.mods), ...candidate]) for (const dep of mod.dependencies) {
      check()
      if (['minecraft', 'java', 'fabricloader', 'forge'].includes(dep.id)) continue
      const current = all.get(dep.id), present = current?.enabled
      if (dep.required && (!present || current!.alias || !dep.predicate(current!.mod.version))) block('必需依赖缺失、禁用、别名版本未知或不兼容：' + mod.id + ' → ' + dep.id)
      if (dep.conflict && present && (current!.alias || dep.predicate(current!.mod.version))) block('当前模组声明冲突：' + mod.id + ' → ' + dep.id)
    }
    check()
    for (const [directory, expected] of chain) if (nodeIdentity(await fs.lstat(directory, { bigint: true })) !== expected) block('实例祖先在完整索引期间发生变化')
    if (modsIdentity && nodeIdentity(await fs.lstat(mods, { bigint: true })) !== modsIdentity) block('mods 目录身份发生变化')
    if (JSON.stringify(await snapshot(mods, check)) !== JSON.stringify(before)) block('当前模组集合在完整索引期间发生变化')
    const registryAfter = await registry(instance, check)
    if (registryAfter.hash !== registryBefore.hash || registryAfter.identity !== registryBefore.identity) block('历史模组记录在完整索引期间发生变化')
    fingerprint = createHash('sha512').update(JSON.stringify({ schema: 1, context, candidate: { sha512: inspection.details.sha512, identity: inspection.sourceIdentity, name: inspection.details.name }, chain: [...chain], modsIdentity, before, registry: registryBefore, proofs: proofs.map(({ mods: _mods, ...rest }) => rest) })).digest('hex')
    assessment.eligible = true
  } catch (error) {
    if (options.signal?.aborted) options.signal.throwIfAborted()
    assessment.reasons.push(error instanceof PolicyFailure ? error.message : timeout.signal.aborted ? '当前模组完整索引超过60秒预算' : '当前声明、目录或历史记录不能形成完整兼容证明；请修复后重新预览')
  } finally { clearTimeout(timer) }
  return { assessment, fingerprint }
}
