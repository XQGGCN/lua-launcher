import { parse as parseToml } from 'smol-toml'
import type { ModDeclaration, ModDependencyDeclaration, ModMetadataDocument } from './mod-details-types'

export const MOD_METADATA_LIMITS = Object.freeze({
  documentBytes: 256 * 1024, totalBytes: 1024 * 1024, depth: 32, nodes: 20000,
  stringBytes: 4096, dependencies: 256, mods: 64, listItems: 256, dtoBytes: 1024 * 1024,
})
export const MOD_METADATA_PATHS = Object.freeze([
  'fabric.mod.json', 'quilt.mod.json', 'quilt.mod.json5',
  'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'META-INF/MANIFEST.MF',
] as const)
type MetadataFormat = ModMetadataDocument['format']
class MetadataFailure extends Error {
  constructor(readonly status: 'invalid' | 'unsupported', message: string) { super(message) }
}
function invalid(message = '声明格式无效，未返回该文档的模组标识'): never { throw new MetadataFailure('invalid', message) }
function limit(): never { throw new MetadataFailure('unsupported', '声明超过当前结构、数量或文字预算，未返回该文档的模组标识') }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))
const has = (value: Record<string, unknown>, key: string) => Object.hasOwn(value, key)
function text(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || required && !value.length) invalid()
  if (Buffer.byteLength(value as string) > MOD_METADATA_LIMITS.stringBytes) limit()
  return value as string
}
function semantic(value: unknown, required = false): string | undefined {
  const result = text(value, required)
  if (result !== undefined && /[\p{Cc}\p{Cf}]/u.test(result)) invalid('标识、版本或条件含控制/格式字符，未改写为另一个声明')
  return result
}
function array(value: unknown, maximum: number = MOD_METADATA_LIMITS.listItems): unknown[] {
  if (!Array.isArray(value)) invalid()
  if ((value as unknown[]).length > maximum) limit()
  return value as unknown[]
}
const strings = (value: unknown): string[] => value === undefined ? [] : array(value).map(item => text(item, true)!)
const semanticStrings = (value: unknown): string[] => value === undefined ? [] : array(value).map(item => semantic(item, true)!)
function licenses(value: unknown): string[] { return value === undefined ? [] : typeof value === 'string' ? [text(value, true)!] : strings(value) }
function id(value: unknown): string {
  const result = semantic(value, true)!
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(result)) invalid('声明的模组标识格式无效')
  return result
}
function row(mod: Partial<ModDeclaration> = {}): ModDeclaration {
  return { authors: [], licenses: [], provides: [], dependencies: [], nestedJars: [], warnings: [], ...mod }
}
function structure(value: unknown): void {
  let nodes = 0
  const pending: [unknown, number][] = [[value, 0]]
  while (pending.length) {
    const [item, depth] = pending.pop()!
    if (++nodes > MOD_METADATA_LIMITS.nodes || depth > MOD_METADATA_LIMITS.depth) limit()
    if (typeof item === 'string') { if (Buffer.byteLength(item) > MOD_METADATA_LIMITS.stringBytes) limit() }
    else if (typeof item === 'number') { if (!Number.isFinite(item)) invalid('声明含非有限数字') }
    else if (Array.isArray(item)) {
      if (item.length > MOD_METADATA_LIMITS.nodes) limit()
      for (const child of item) pending.push([child, depth + 1])
    } else if (item && typeof item === 'object') {
      if (!object(item)) invalid('声明含当前不能解释的日期或特殊对象')
      for (const [key, child] of Object.entries(item)) {
        if (key === '__proto__' || key === 'constructor') invalid('声明含歧义对象键')
        if (Buffer.byteLength(key) > MOD_METADATA_LIMITS.stringBytes) limit()
        pending.push([child, depth + 1])
      }
    }
  }
}
function decode(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MOD_METADATA_LIMITS.documentBytes) limit()
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return invalid('声明不是有效UTF-8文字') }
}

/** Reject decoded duplicate JSON keys instead of silently picking an identity. */
function strictJson(source: string): unknown {
  let at = 0, nodes = 0
  const whitespace = () => { while (at < source.length && /[\x20\t\r\n]/.test(source[at])) at++ }
  function string(): string {
    const start = at++
    while (at < source.length) {
      const c = source[at++]
      if (c === '\\') at++
      else if (c === '"') {
        let result: unknown
        try { result = JSON.parse(source.slice(start, at)) } catch { return invalid('JSON字符串无效') }
        if (typeof result !== 'string') invalid()
        if (Buffer.byteLength(result as string) > MOD_METADATA_LIMITS.stringBytes) limit()
        return result as string
      }
    }
    return invalid('JSON字符串未结束')
  }
  function value(depth: number): unknown {
    whitespace()
    if (depth > MOD_METADATA_LIMITS.depth || ++nodes > MOD_METADATA_LIMITS.nodes) limit()
    if (source[at] === '"') return string()
    if (source[at] === '{') {
      at++; const result: Record<string, unknown> = Object.create(null), seen = new Set<string>(); whitespace()
      if (source[at] === '}') { at++; return result }
      while (true) {
        whitespace(); if (source[at] !== '"') invalid('JSON对象键无效')
        const key = string(); if (seen.has(key) || key === '__proto__' || key === 'constructor') invalid('JSON含重复或歧义对象键'); seen.add(key)
        whitespace(); if (source[at++] !== ':') invalid('JSON对象缺少冒号')
        result[key] = value(depth + 1); whitespace()
        const end = source[at++]; if (end === '}') return result; if (end !== ',') invalid('JSON对象未结束')
      }
    }
    if (source[at] === '[') {
      at++; const result: unknown[] = []; whitespace()
      if (source[at] === ']') { at++; return result }
      while (true) {
        result.push(value(depth + 1)); whitespace()
        const end = source[at++]; if (end === ']') return result; if (end !== ',') invalid('JSON数组未结束')
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at))
    if (!match) return invalid('JSON值无效')
    at += match[0].length
    const result: unknown = JSON.parse(match[0]); if (typeof result === 'number' && !Number.isFinite(result)) invalid('JSON数字无效')
    return result
  }
  const result = value(0); whitespace(); if (at !== source.length) invalid('JSON含多余内容或不支持的BOM')
  return result
}
function dependencyVersion(value: unknown, semanticConditions = true): string {
  if (value === undefined) return '未声明'
  if (typeof value === 'string') return semantic(value, true)!
  const pending: unknown[] = semanticConditions ? [value] : []
  while (pending.length) {
    const next = pending.pop()
    if (typeof next === 'string') semantic(next, true)
    else if (Array.isArray(next)) pending.push(...next)
    else if (object(next)) for (const [key, child] of Object.entries(next)) { semantic(key, true); pending.push(child) }
  }
  const encoded = JSON.stringify(value)
  if (!encoded || Buffer.byteLength(encoded) > MOD_METADATA_LIMITS.stringBytes) limit()
  return encoded
}
function fabric(root: Record<string, unknown>, base: ModMetadataDocument): ModMetadataDocument {
  const schema = root.schemaVersion
  if (schema !== 1) return { ...base, status: 'unsupported', schemaVersion: schema === undefined ? '0（未声明）' : text(String(schema)), reason: '当前只投影Fabric schemaVersion 1，其他版本/数组根保持未支持' }
  const mod = row({ id: id(root.id), version: semantic(root.version, true), name: text(root.name), description: text(root.description),
    licenses: licenses(root.license), environment: semantic(root.environment), provides: semanticStrings(root.provides) })
  if (root.authors !== undefined) mod.authors = array(root.authors).map(author => typeof author === 'string' ? text(author, true)! : object(author) ? text(author.name, true)! : invalid())
  for (const kind of ['depends', 'recommends', 'suggests', 'conflicts', 'breaks']) {
    if (!has(root, kind)) continue
    const map = root[kind]; if (!object(map)) invalid('Fabric依赖声明需要对象')
    for (const [name, range] of Object.entries(map)) {
      if (typeof range !== 'string' && (!Array.isArray(range) || range.some(v => typeof v !== 'string'))) invalid('Fabric版本声明需要字符串或字符串数组')
      mod.dependencies.push({ id: semantic(name, true)!, kind, version: dependencyVersion(range), details: Array.isArray(range) ? 'Fabric原始OR数组，未求解' : 'Fabric原始约束，未求解' })
    }
  }
  if (root.jars !== undefined) mod.nestedJars = array(root.jars).map(item => object(item) ? semantic(item.file, true)! : invalid('Fabric嵌套JAR声明无效'))
  if (mod.nestedJars.length) mod.warnings.push('含嵌套JAR声明；未打开或递归识别其中的模组')
  if (root.languageAdapters !== undefined) mod.warnings.push('包含自定义语言适配器声明；没有执行或判断支持情况')
  return { ...base, status: 'read', schemaVersion: '1', loader: { id: 'fabric' }, mods: [mod] }
}
function quilt(root: Record<string, unknown>, base: ModMetadataDocument): ModMetadataDocument {
  if (root.schema_version !== 1) return { ...base, status: 'unsupported', schemaVersion: root.schema_version === undefined ? undefined : String(root.schema_version), reason: '当前只投影Quilt schema_version 1' }
  const loader = root.quilt_loader; if (!object(loader)) invalid('缺少Quilt loader声明')
  const info = loader as Record<string, unknown>, metadata = info.metadata === undefined ? {} : info.metadata
  if (!object(metadata)) invalid('Quilt metadata需要对象')
  semantic(info.group, true)
  const mod = row({ id: id(info.id), version: semantic(info.version, true), name: text(metadata.name), description: text(metadata.description), licenses: licenses(metadata.license) })
  if (metadata.contributors !== undefined) {
    if (!object(metadata.contributors)) invalid('Quilt贡献者声明需要对象')
    mod.authors = Object.entries(metadata.contributors).map(([name, role]) => `${text(name, true)} (${text(role, true)})`)
  }
  if (root.minecraft !== undefined) { if (!object(root.minecraft)) invalid(); mod.environment = semantic(root.minecraft.environment) }
  if (info.provides !== undefined) mod.provides = array(info.provides).map(item => typeof item === 'string' ? semantic(item, true)! : object(item) ?
    `${semantic(item.id, true)}${item.version === undefined ? '' : ` @ ${semantic(item.version, true)}`}` : invalid('Quilt provides声明无效'))
  if (info.jars !== undefined) mod.nestedJars = semanticStrings(info.jars)
  for (const kind of ['depends', 'breaks']) {
    if (info[kind] === undefined) continue
    for (const entry of array(info[kind])) {
      if (typeof entry === 'string') mod.dependencies.push({ id: semantic(entry, true)!, kind, version: '未声明', details: 'Quilt声明，未求解' })
      else if (Array.isArray(entry)) mod.dependencies.push({ id: '组合依赖（未求解）', kind, version: dependencyVersion(entry), details: 'Quilt数组组合；未展平为独立必需项' })
      else if (object(entry)) {
        mod.dependencies.push({ id: semantic(entry.id, true)!, kind: entry.optional === true ? `${kind} (optional)` : kind,
          version: dependencyVersion(entry.versions), environment: semantic(entry.environment), details: dependencyVersion(entry, false) })
      } else invalid('Quilt依赖声明无效')
    }
  }
  mod.warnings.push('Quilt版本/组合依赖未求解；Lua当前未提供Quilt实例加载器')
  if (info.plugins !== undefined || info.language_adapters !== undefined) mod.warnings.push('含自定义插件或语言适配器声明，支持情况未知且未执行')
  if (mod.nestedJars.length) mod.warnings.push('嵌套JAR只显示声明，未打开其中内容')
  return { ...base, status: 'read', schemaVersion: '1', loader: { id: 'quilt' }, mods: [mod] }
}
const manifestFields = new Set(['manifest-version', 'implementation-version', 'implementation-title', 'implementation-vendor', 'specification-version', 'specification-title', 'automatic-module-name', 'main-class', 'class-path', 'multi-release', 'fmlmodtype', 'fmlats'])
function manifest(bytes: Uint8Array, base: ModMetadataDocument): ModMetadataDocument {
  if (bytes.byteLength > MOD_METADATA_LIMITS.documentBytes) limit()
  const values = new Map<string, { name: string; chunks: Buffer[]; length: number }>()
  let current: { name: string; chunks: Buffer[]; length: number } | undefined, offset = 0
  while (offset < bytes.length) {
    const start = offset
    while (offset < bytes.length && bytes[offset] !== 10 && bytes[offset] !== 13) offset++
    if (offset === bytes.length) invalid('Manifest属性缺少结束换行')
    const line = Buffer.from(bytes.subarray(start, offset))
    if (bytes[offset++] === 13 && bytes[offset] === 10) offset++
    if (!line.length) break // Ignore named sections; never borrow their version.
    if (line.byteLength > 72) invalid('Manifest物理行超过72字节')
    if (line[0] === 32) {
      if (!current) invalid('Manifest续行缺少前置属性')
      current!.chunks.push(line.subarray(1)); current!.length += line.length - 1
      if (current!.length > MOD_METADATA_LIMITS.stringBytes) limit()
      continue
    }
    const separator = line.indexOf(': '), name = separator < 0 ? '' : line.subarray(0, separator).toString('ascii')
    if (separator < 0 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,69}$/.test(name) || line.subarray(0, separator).some(byte => byte > 127)) invalid('Manifest属性名或分隔格式无效')
    const key = name.toLowerCase(); if (values.has(key)) invalid('Manifest主节含重复属性，不能确定版本')
    current = { name, chunks: [line.subarray(separator + 2)], length: line.length - separator - 2 }; values.set(key, current)
    if (values.size > MOD_METADATA_LIMITS.listItems) limit()
  }
  // Reassemble raw continuation bytes before UTF-8 decoding: a legal physical
  // fold may split a multibyte codepoint in the middle.
  const output = [...values].filter(([key]) => manifestFields.has(key)).map(([, value]) => ({ name: value.name, value: text(decode(Buffer.concat(value.chunks)))! }))
  return { ...base, status: 'read', manifest: output, warnings: ['只读取Manifest主节；Main-Class、Class-Path和签名外观不证明模组身份或真实性，未解析/执行引用'] }
}
function toml(source: string, base: ModMetadataDocument, implementationVersion?: string): ModMetadataDocument {
  const parsed: unknown = parseToml(source, { maxDepth: MOD_METADATA_LIMITS.depth, unsafeKeyBehaviour: 'throw', useLegacyDate: true })
  structure(parsed); if (!object(parsed)) invalid('TOML根声明需要对象')
  const raw = parsed as Record<string, unknown>, language = semantic(raw.modLoader, true)!, loaderVersion = semantic(raw.loaderVersion), license = licenses(raw.license)
  const mods = array(raw.mods, MOD_METADATA_LIMITS.mods).map(value => {
    if (!object(value)) invalid('TOML模组表无效')
    const table = value as Record<string, unknown>, mod = row({ id: id(table.modId), name: text(table.displayName), description: text(table.description),
      version: semantic(table.version), authors: typeof table.authors === 'string' ? [text(table.authors)!] : strings(table.authors), licenses: license })
    if (mod.version === '${file.jarVersion}') {
      if (implementationVersion) mod.version = semantic(implementationVersion, true)
      else mod.warnings.push('file.jarVersion缺少唯一有效的Manifest主节Implementation-Version，保留未解析占位符')
    }
    if (mod.version?.includes('${')) mod.warnings.push('含未解析版本占位符；不作版本匹配')
    const dependencies = raw.dependencies
    if (dependencies !== undefined) {
      if (!object(dependencies)) invalid('TOML dependencies需要表')
      const list = dependencies[mod.id!]
      if (list !== undefined) for (const dependency of array(list)) {
        if (!object(dependency)) invalid('TOML依赖表无效')
        const mandatory = dependency.mandatory, declaredType = semantic(dependency.type)
        if (mandatory !== undefined && typeof mandatory !== 'boolean') invalid('mandatory需要布尔值')
        const kind = base.format === 'neoforge' ? declaredType ?? '未声明类型' : mandatory === true ? 'required' : mandatory === false ? 'optional' : '未声明mandatory'
        mod.dependencies.push({ id: semantic(dependency.modId, true)!, kind, version: semantic(dependency.versionRange) ?? '未声明',
          environment: semantic(dependency.side), details: dependency.ordering === undefined ? undefined : `ordering=${semantic(dependency.ordering, true)}` })
      }
    }
    mod.warnings.push('Maven版本范围及依赖仅显示原声明，未进行满足性求解')
    if (language !== 'javafml' && language !== 'lowcodefml') mod.warnings.push('自定义modLoader的执行和兼容规则未知')
    return mod
  })
  if (!mods.length) invalid('未找到TOML模组表')
  const ids = mods.map(mod => mod.id); if (new Set(ids).size !== ids.length) invalid('同一TOML文档含重复模组标识')
  return { ...base, status: 'read', loader: { id: language, version: loaderVersion }, mods,
    warnings: base.format === 'forge' ? ['mods.toml路径也可能用于历史NeoForge版本；不能仅凭路径断定Forge兼容'] : ['仅投影当前NeoForge文档字段；不推断旧版路径或加载器兼容'] }
}
const format = (path: string): MetadataFormat => path === 'fabric.mod.json' ? 'fabric' : path === 'quilt.mod.json' ? 'quilt' : path === 'quilt.mod.json5' ? 'quilt-json5' : path.endsWith('MANIFEST.MF') ? 'manifest' : path.endsWith('neoforge.mods.toml') ? 'neoforge' : 'forge'

/** Pure bounded declarations. No classes, nested JARs, URLs or entrypoints are executed. */
export function parseModMetadata(documents: ReadonlyMap<string, Uint8Array>): ModMetadataDocument[] {
  const paths = MOD_METADATA_PATHS.filter(path => documents.has(path))
  const unsupportedAll = (reason: string): ModMetadataDocument[] => paths.map(path => ({ path, format: format(path), status: 'unsupported', mods: [], warnings: [], reason }))
  if (paths.reduce((sum, path) => sum + documents.get(path)!.byteLength, 0) > MOD_METADATA_LIMITS.totalBytes) return unsupportedAll('元数据累计大小超过当前预算')
  const output = new Map<string, ModMetadataDocument>()
  const order = [...paths.filter(path => path.endsWith('MANIFEST.MF')), ...paths.filter(path => !path.endsWith('MANIFEST.MF'))]
  let implementationVersion: string | undefined
  for (const path of order) {
    const base: ModMetadataDocument = { path, format: format(path), status: 'invalid', mods: [], warnings: [] }
    try {
      if (base.format === 'quilt-json5') {
        output.set(path, { ...base, status: 'unsupported', reason: 'Quilt JSON5仅为开发环境格式，未作为正式运行时模组解析' }); continue
      }
      let result: ModMetadataDocument
      if (base.format === 'manifest') {
        result = manifest(documents.get(path)!, base)
        implementationVersion = result.manifest?.find(row => row.name.toLowerCase() === 'implementation-version')?.value
      } else if (base.format === 'forge' || base.format === 'neoforge') result = toml(decode(documents.get(path)!), base, implementationVersion)
      else {
        const root = strictJson(decode(documents.get(path)!)); structure(root)
        if (Array.isArray(root)) result = { ...base, status: 'unsupported', reason: '数组根元数据未支持，未当作单个模组声明' }
        else if (!object(root)) invalid('模组JSON根需要对象')
        else result = base.format === 'fabric' ? fabric(root, base) : quilt(root, base)
      }
      const dependencies = result!.mods.reduce((n, mod) => n + mod.dependencies.length, 0)
      if (dependencies > MOD_METADATA_LIMITS.dependencies || result!.mods.length > MOD_METADATA_LIMITS.mods) limit()
      output.set(path, result!)
    } catch (error) {
      output.set(path, { ...base, status: error instanceof MetadataFailure ? error.status : 'invalid',
        reason: error instanceof MetadataFailure ? error.message : '元数据语法无效或当前不能解释，未返回该文档的模组标识' })
    }
  }
  const result = paths.map(path => output.get(path)!)
  const totalMods = result.reduce((sum, doc) => sum + doc.mods.length, 0), totalDependencies = result.reduce((sum, doc) => sum + doc.mods.reduce((n, mod) => n + mod.dependencies.length, 0), 0)
  if (totalMods > MOD_METADATA_LIMITS.mods || totalDependencies > MOD_METADATA_LIMITS.dependencies || Buffer.byteLength(JSON.stringify(result)) > MOD_METADATA_LIMITS.dtoBytes) return unsupportedAll('元数据累计条数或结果体积超过当前预算')
  return result
}
