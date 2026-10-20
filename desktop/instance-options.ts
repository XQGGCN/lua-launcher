/** Pure policy only: this module never reads files, runs Java or parses a shell command. */
export interface InstanceOptions {
  javaPath?: string
  manualJavaPath?: string
  memoryMode?: 'auto' | 'manual'
  memoryMb?: number
  jvmArgs?: string[]
  windowWidth?: number
  windowHeight?: number
  fullscreen?: boolean
}
export type InstanceOptionSource = 'instance' | 'global' | 'default'
export interface ResolvedInstanceOptions {
  values: Required<InstanceOptions>
  sources: Record<keyof InstanceOptions, InstanceOptionSource>
}
export class InstanceOptionsError extends Error {
  constructor(readonly field: keyof InstanceOptions | 'options', message: string, readonly argumentIndex?: number) {
    super(message)
    this.name = 'InstanceOptionsError'
  }
}

const KEYS = ['javaPath', 'manualJavaPath', 'memoryMode', 'memoryMb', 'jvmArgs', 'windowWidth', 'windowHeight', 'fullscreen'] as const
const KEY_SET = new Set<string>(KEYS)
const CONTROL = /[\u0000-\u001f\u007f]/u
const DEFAULTS: Required<InstanceOptions> = {
  javaPath: '', manualJavaPath: '', memoryMode: 'auto', memoryMb: 4096,
  jvmArgs: [], windowWidth: 1280, windowHeight: 720, fullscreen: false,
}

// JVM option grammar: https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html
// This deliberately supports a documented subset, not all vendor/version-specific flags.
// Unknown flags need a policy addition; accepting arbitrary -XX/-X would also accept
// command execution hooks, alternate boot paths and memory caps maintained by Lua.
const SIMPLE_FLAGS = new Set([
  '-server', '-Xint', '-Xmixed', '-Xbatch', '-Xcomp', '-Xdiag', '-Xrs',
  '-Xcheck:jni', '-Xshare:auto', '-Xshare:off', '-Xshare:on',
  '-ea', '-enableassertions', '-da', '-disableassertions', '-esa', '-enablesystemassertions', '-dsa', '-disablesystemassertions',
  '-showversion', '--show-version', '--show-module-resolution', '--enable-preview',
  '--finalization=enabled', '--finalization=disabled',
  '-verbose:class', '-verbose:gc', '-verbose:jni', '-verbose:module',
  '-XshowSettings', '-XshowSettings:all', '-XshowSettings:locale', '-XshowSettings:properties', '-XshowSettings:vm', '-XshowSettings:system',
])
const BOOLEAN_XX = new Set([
  'UseG1GC', 'UseZGC', 'ZGenerational', 'UseParallelGC', 'UseSerialGC', 'UseShenandoahGC',
  'ParallelRefProcEnabled', 'DisableExplicitGC', 'ExplicitGCInvokesConcurrent', 'AlwaysPreTouch',
  'UseStringDeduplication', 'UseNUMA', 'UseLargePages', 'UseTransparentHugePages',
  'UseCompressedOops', 'UseCompressedClassPointers', 'UseCodeCacheFlushing', 'TieredCompilation',
  'UnlockExperimentalVMOptions', 'UnlockDiagnosticVMOptions', 'DisableAttachMechanism',
  'PerfDisableSharedMem', 'UsePerfData', 'OmitStackTraceInFastThrow', 'ShowCodeDetailsInExceptionMessages',
  'HeapDumpOnOutOfMemoryError', 'ExitOnOutOfMemoryError', 'CrashOnOutOfMemoryError',
  'PrintCommandLineFlags', 'PrintFlagsFinal',
])
const INTEGER_XX = new Set([
  'MaxGCPauseMillis', 'GCPauseIntervalMillis', 'GCTimeRatio', 'ParallelGCThreads', 'ConcGCThreads',
  'ActiveProcessorCount', 'CICompilerCount', 'TieredStopAtLevel', 'G1MixedGCCountTarget',
  'MaxTenuringThreshold', 'SurvivorRatio', 'NewRatio', 'G1ConcRefinementThreads',
])
const PERCENT_XX = new Set([
  'G1NewSizePercent', 'G1MaxNewSizePercent', 'G1ReservePercent', 'G1HeapWastePercent',
  'InitiatingHeapOccupancyPercent', 'G1MixedGCLiveThresholdPercent', 'G1RSetUpdatingPauseTimePercent',
  'TargetSurvivorRatio',
])
const SIZE_XX = new Set([
  'G1HeapRegionSize', 'ReservedCodeCacheSize', 'InitialCodeCacheSize', 'MaxMetaspaceSize',
  'MetaspaceSize', 'CompressedClassSpaceSize', 'MaxDirectMemorySize',
])
const FILE_XX = new Set(['HeapDumpPath', 'ErrorFile'])
const MODULE_FLAGS = new Set([
  '--add-opens', '--add-exports', '--add-reads', '--add-modules', '--limit-modules', '--enable-native-access',
])
const MODULE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/
const RESERVED_PROPERTIES = new Set([
  'java.class.path', 'java.library.path', 'java.home', 'java.ext.dirs', 'java.endorsed.dirs', 'java.system.class.loader',
  'sun.boot.class.path', 'sun.boot.library.path', 'sun.java.command', 'sun.java.launcher',
  'jna.library.path', 'jna.boot.library.path', 'user.dir', 'user.home',
  'librarydirectory', 'legacyclasspath', 'ignorelist', 'mergemodules',
  'fabric.addmods', 'fabric.gamejarpath', 'fabric.gamejarpath.client', 'fabric.gamejarpath.server', 'fabric.classpathgroups',
  'accesstoken', 'clienttoken', 'sessionid', 'auth_access_token', 'auth_player_name', 'auth_uuid', 'auth_xuid',
])
const RESERVED_PROPERTY_PREFIXES = [
  'jdk.module.', 'jdk.launcher.', 'minecraft.launcher.', 'minecraft.api.', 'authlib.', 'authlibinjector.',
  'auth.', 'authentication.', 'cpw.mods.bootstraplauncher.', 'securejarhandler.',
]
const RESERVED_FLAGS = /^(-X(?:mx|ms|mn|bootclasspath)|-XX:(?:[+-])?(?:MaxHeapSize|InitialHeapSize|MinHeapSize|SoftMaxHeapSize|MaxRAM|MinRAM|InitialRAM|AggressiveHeap|ErgoHeapSizeLimit|Flags|VMOptionsFile|OnError|OnOutOfMemoryError|SharedArchiveFile|SharedArchiveConfigFile|ArchiveClassesAtExit)(?:[=:]|$)|-javaagent(?::|$)|-agent(?:lib|path)(?::|$)|-Xrun|-Xdebug$|-Xnoagent$|-Xprof$|-XXaltjvm)/i
const ENTRY_FLAGS = new Set([
  '-cp', '-classpath', '--class-path', '-jar', '-m', '--module', '-p', '--module-path',
  '--upgrade-module-path', '--patch-module', '--source', '--disable-@files',
  '-version', '--version', '-Xinternalversion', '-help', '--help', '-h', '-?', '-X', '--help-extra',
  '--list-modules', '--describe-module', '-d', '--dry-run', '--validate-modules', '--',
])

function argumentError(index: number, message: string): never {
  // Do not echo arbitrary argument values into errors: they can contain private data.
  throw new InstanceOptionsError('jvmArgs', `第 ${index + 1} 个 JVM 参数：${message}`, index)
}
function pathValue(value: unknown, field: 'javaPath' | 'manualJavaPath'): string {
  if (typeof value !== 'string' || value.length > 4096 || CONTROL.test(value)) {
    throw new InstanceOptionsError(field, 'Java 路径必须是无控制字符的字符串，最长 4096 个字符')
  }
  if (value === '') return value
  // Accept native absolute paths from all supported platforms, without normalizing
  // user spelling, expanding ~/$variables or treating a command line as a path.
  const posix = value.startsWith('/')
  const drive = /^[A-Za-z]:[\\/]/.test(value)
  const unc = /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value)
  const device = /^(?:\\\\|\/\/)[?.][\\/]/.test(value)
  if (device || (!posix && !drive && !unc)) {
    throw new InstanceOptionsError(field, 'Java 路径须为绝对路径；空字符串表示自动选择。不要填写命令、相对路径或 Windows 设备路径')
  }
  return value
}
function numberValue(value: unknown, field: 'memoryMb' | 'windowWidth' | 'windowHeight', min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InstanceOptionsError(field, `${field === 'memoryMb' ? '内存 MiB' : field === 'windowWidth' ? '窗口宽度' : '窗口高度'}必须是 ${min}–${max} 之间的整数`)
  }
  return value
}
function moduleList(value: string, aliases: ReadonlySet<string> = new Set()): boolean {
  return value.length > 0 && value.split(',').every(item => MODULE_NAME.test(item) || aliases.has(item))
}
function moduleValue(flag: string, value: string, index: number): void {
  const unnamed = new Set(['ALL-UNNAMED'])
  let valid = false
  if (flag === '--add-opens' || flag === '--add-exports') {
    const match = /^([^/=]+)\/([^=]+)=(.+)$/.exec(value)
    valid = Boolean(match && MODULE_NAME.test(match[1]) && MODULE_NAME.test(match[2]) && moduleList(match[3], unnamed))
  } else if (flag === '--add-reads') {
    const match = /^([^=]+)=(.+)$/.exec(value)
    valid = Boolean(match && MODULE_NAME.test(match[1]) && moduleList(match[2], unnamed))
  } else if (flag === '--add-modules') {
    valid = moduleList(value, new Set(['ALL-DEFAULT', 'ALL-SYSTEM', 'ALL-MODULE-PATH']))
  } else if (flag === '--enable-native-access') valid = moduleList(value, unnamed)
  else valid = moduleList(value)
  if (!valid) argumentError(index, `${flag} 的值格式无效。可把标志和值分别作为两个参数，或使用 ${flag}=值；例如 --add-opens=java.base/java.lang=ALL-UNNAMED`)
}
function sizeValue(value: string): boolean {
  const match = /^(0|[1-9]\d{0,15})([kKmMgG]?)$/.exec(value)
  if (!match) return false
  const multiplier = match[2] ? 1024n ** BigInt('kmg'.indexOf(match[2].toLowerCase()) + 1) : 1n
  return BigInt(match[1]) * multiplier <= 9_223_372_036_854_775_807n
}
function validateArguments(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 64) throw new InstanceOptionsError('jvmArgs', 'JVM 参数必须是字符串数组，最多 64 项')
  let length = 0
  for (let i = 0; i < input.length; i++) {
    const arg: unknown = input[i]
    if (typeof arg !== 'string' || !arg.trim() || CONTROL.test(arg)) argumentError(i, '请填写一个非空、无控制字符的完整参数，不要提供 shell 命令')
    length += arg.length
    if (length > 8192) argumentError(i, 'JVM 参数总长度不能超过 8192 个字符')
    if (arg.startsWith('@')) argumentError(i, '不允许 @参数文件；请把每个参数直接列出，以便检查实际生效内容')
  }
  const args = input as string[]
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const equals = arg.indexOf('=')
    const flag = equals >= 0 ? arg.slice(0, equals) : arg
    if (RESERVED_FLAGS.test(arg) || ENTRY_FLAGS.has(flag)) {
      argumentError(i, '该参数会覆盖 Lua 管理的内存、启动入口、类路径或原生代码加载，或提前结束 Java。请使用对应的启动器设置')
    }
    if (MODULE_FLAGS.has(flag)) {
      const value = equals >= 0 ? arg.slice(equals + 1) : args[i + 1]
      if (value === undefined || value.startsWith('-')) argumentError(i, `${flag} 缺少值；请将值作为下一项，或使用 ${flag}=值`)
      moduleValue(flag, value, i)
      if (equals < 0) i++
      continue
    }
    if (SIMPLE_FLAGS.has(arg)) continue
    if (/^-(?:ea|enableassertions|da|disableassertions):(?:[A-Za-z_$][A-Za-z0-9_$.]*(?:\.\.\.)?|\.\.\.)$/.test(arg)) continue
    if (arg.startsWith('-D')) {
      const property = /^-D([A-Za-z_][A-Za-z0-9_.-]*)(?:=(.*))?$/u.exec(arg)
      if (!property) argumentError(i, '系统属性格式为 -D名称=值；含空格的值保留在同一个参数中，无须 shell 引号')
      const name = property[1].toLowerCase()
      if (RESERVED_PROPERTIES.has(name) || RESERVED_PROPERTY_PREFIXES.some(prefix => name.startsWith(prefix)) ||
          (name.startsWith('org.lwjgl.') && /(?:librarypath|libname|sharedlibraryextract)/.test(name))) {
        argumentError(i, '该系统属性属于 Lua 维护的认证、启动身份、类路径或原生库配置，不能在自定义参数中覆盖')
      }
      continue
    }
    if (/^-Xss/.test(arg)) {
      if (!sizeValue(arg.slice(4)) || /^0[kKmMgG]?$/.test(arg.slice(4))) argumentError(i, '线程栈大小格式为 -Xss1m；堆内存请使用内存设置')
      continue
    }
    if (arg.startsWith('-Xlog:')) {
      const value = arg.slice(6)
      if (!value || /^(?:help)(?::|$)/.test(value)) argumentError(i, '请提供有效日志配置，例如 -Xlog:gc；不支持会提前退出的 help')
      continue
    }
    const boolean = /^-XX:([+-])([A-Za-z][A-Za-z0-9]*)$/.exec(arg)
    if (boolean && BOOLEAN_XX.has(boolean[2])) continue
    const option = /^-XX:([A-Za-z][A-Za-z0-9]*)=(.*)$/u.exec(arg)
    if (option) {
      const [, name, value] = option
      if (INTEGER_XX.has(name) && /^\d{1,10}$/.test(value) && Number(value) <= 2_147_483_647) continue
      if (PERCENT_XX.has(name) && /^\d{1,3}$/.test(value) && Number(value) <= 100) continue
      if (SIZE_XX.has(name) && sizeValue(value)) continue
      if (FILE_XX.has(name) && value.trim()) continue
      if (INTEGER_XX.has(name) || PERCENT_XX.has(name) || SIZE_XX.has(name) || FILE_XX.has(name)) {
        argumentError(i, '该 -XX 参数的值无效；请使用整数、0–100 的百分数、带 k/m/g 后缀的大小或非空文件路径')
      }
    }
    argumentError(i, '暂不支持或无法可靠解析该选项。支持常用 GC 的 -XX 参数、-D属性、-Xss、-Xlog 和 --add-opens 等模块选项；每个数组元素必须是一个 argv，不能粘贴整条命令')
  }
  return [...args]
}

export function validateInstanceOptions(input: unknown): InstanceOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new InstanceOptionsError('options', '实例设置必须是普通对象')
  }
  const output: InstanceOptions = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !KEY_SET.has(key)) throw new InstanceOptionsError('options', '实例设置包含未知字段')
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!
    if (!('value' in descriptor)) throw new InstanceOptionsError('options', '实例设置不能包含 getter 或 setter')
    const value: unknown = descriptor.value
    if (value === undefined) continue
    switch (key) {
      case 'javaPath': case 'manualJavaPath': output[key] = pathValue(value, key); break
      case 'memoryMb': output.memoryMb = numberValue(value, key, 1024, 65536); break
      case 'windowWidth': output.windowWidth = numberValue(value, key, 640, 7680); break
      case 'windowHeight': output.windowHeight = numberValue(value, key, 360, 4320); break
      case 'memoryMode':
        if (value !== 'auto' && value !== 'manual') throw new InstanceOptionsError(key, '内存模式必须是 auto 或 manual')
        output.memoryMode = value; break
      case 'fullscreen':
        if (typeof value !== 'boolean') throw new InstanceOptionsError(key, '全屏设置必须是布尔值')
        output.fullscreen = value; break
      case 'jvmArgs': output.jvmArgs = validateArguments(value); break
    }
  }
  return output
}

export function resolveInstanceOptions(global: InstanceOptions = {}, instance?: InstanceOptions): ResolvedInstanceOptions {
  const globalValues = validateInstanceOptions(global)
  const instanceValues = instance === undefined ? {} : validateInstanceOptions(instance)
  const values: Required<InstanceOptions> = { ...DEFAULTS, jvmArgs: [] }
  const sources = Object.fromEntries(KEYS.map(key => [key, 'default'])) as ResolvedInstanceOptions['sources']
  for (const key of KEYS) {
    const source: InstanceOptionSource = instanceValues[key] !== undefined ? 'instance' : globalValues[key] !== undefined ? 'global' : 'default'
    const value = source === 'instance' ? instanceValues[key] : source === 'global' ? globalValues[key] : DEFAULTS[key]
    ;(values as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value
    sources[key] = source
  }
  return { values, sources }
}
