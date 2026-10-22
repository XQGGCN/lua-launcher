/**
 * Helpers that let the modern launch pipeline run old releases, snapshots and historic
 * versions: legacy `minecraftArguments`, missing Java metadata, legacy asset layouts and
 * the macOS Apple-silicon case where old LWJGL builds only ship x86-64 natives.
 */
export type LegacyRule = { action: 'allow' | 'disallow'; os?: { name?: string; arch?: string; version?: string }; features?: Record<string, boolean> }
export type LegacyArgument = string | { rules: LegacyRule[]; value: string | string[] }
export interface LegacyLibrary { name: string; natives?: Record<string, string>; rules?: LegacyRule[] }
export interface LegacyVersionInput {
  arguments?: { game?: LegacyArgument[]; jvm?: LegacyArgument[] }
  minecraftArguments?: string
  javaVersion?: { majorVersion: number; component?: string }
  libraries?: LegacyLibrary[]
  type?: string
}

/** Any id Mojang publishes that is safe to use as a file name. */
export function isGameVersionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(value) && !value.includes('..')
}

export type VersionChannel = 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
export function isVersionChannel(value: unknown): value is VersionChannel {
  return value === 'release' || value === 'snapshot' || value === 'old_beta' || value === 'old_alpha'
}

/** JVM arguments the official launcher uses for versions that predate the `arguments` object. */
export const LEGACY_JVM_ARGUMENTS: LegacyArgument[] = [
  { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] },
  { rules: [{ action: 'allow', os: { name: 'windows' } }], value: '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump' },
  { rules: [{ action: 'allow', os: { name: 'windows', version: '^10\\.' } }], value: ['-Dos.name=Windows 10', '-Dos.version=10.0'] },
  '-Djava.library.path=${natives_directory}',
  '-Dminecraft.launcher.brand=${launcher_name}',
  '-Dminecraft.launcher.version=${launcher_version}',
  '-cp',
  '${classpath}',
]
const RESOLUTION: LegacyArgument = { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] }

/**
 * Returns `arguments` for any version manifest. Modern manifests are returned unchanged;
 * legacy `minecraftArguments` strings are split on whitespace (Mojang never quotes them).
 */
export function launchArguments(version: LegacyVersionInput): { game: LegacyArgument[]; jvm: LegacyArgument[] } {
  if (version.arguments?.game && version.arguments?.jvm) return { game: version.arguments.game, jvm: version.arguments.jvm }
  if (version.arguments?.game && !version.arguments.jvm) return { game: version.arguments.game, jvm: LEGACY_JVM_ARGUMENTS }
  if (typeof version.minecraftArguments !== 'string' || !version.minecraftArguments.trim() || version.minecraftArguments.length > 16_384) {
    throw new Error('该版本缺少可识别的启动参数')
  }
  const game: LegacyArgument[] = version.minecraftArguments.trim().split(/\s+/)
  if (!game.includes('--width')) game.push(RESOLUTION)
  return { game, jvm: LEGACY_JVM_ARGUMENTS }
}

/** Mojang retrofitted Java metadata to most versions; very old manifests fall back to Java 8. */
export function javaRequirementOf(version: LegacyVersionInput): { majorVersion: number; component: string } {
  const major = version.javaVersion?.majorVersion
  const component = version.javaVersion?.component
  if (Number.isInteger(major) && major! >= 8 && major! <= 99) {
    return { majorVersion: major!, component: typeof component === 'string' && /^[a-z0-9-]{1,80}$/.test(component) ? component : major === 8 ? 'jre-legacy' : 'java-runtime-gamma' }
  }
  return { majorVersion: 8, component: 'jre-legacy' }
}

/**
 * Old LWJGL builds (Minecraft before 1.19) have no Apple-silicon natives. On an arm64 Mac those
 * versions run under Rosetta 2 with an x86-64 Java, exactly like the official launcher does.
 */
export function needsRosetta(platform: NodeJS.Platform, arch: string, libraries: LegacyLibrary[] = []): boolean {
  if (platform !== 'darwin' || arch !== 'arm64') return false
  const names = libraries.map(library => library.name)
  if (names.some(name => /natives-macos-arm64|natives-osx-arm64/.test(name))) return false
  if (libraries.some(library => library.rules?.some(rule => rule.os?.name === 'osx' && rule.os.arch === 'arm64'))) return false
  return libraries.some(library => Boolean(library.natives?.osx) || /:natives-(?:macos|osx)$/.test(library.name) || /^org\.lwjgl/.test(library.name))
}

export interface AssetIndex { objects: Record<string, { hash: string; size: number }>; virtual?: boolean; map_to_resources?: boolean }
/** Where each asset must be copied for legacy layouts, relative to the given roots. */
export function legacyAssetCopies(index: AssetIndex): { mode: 'none' | 'virtual' | 'resources'; files: Array<{ name: string; hash: string }> } {
  const mode = index.map_to_resources ? 'resources' : index.virtual ? 'virtual' : 'none'
  if (mode === 'none') return { mode, files: [] }
  const files: Array<{ name: string; hash: string }> = []
  for (const [name, object] of Object.entries(index.objects)) {
    if (!name || name.length > 512 || name.includes('\\') || name.includes('\0') || name.startsWith('/') ||
        name.split('/').some(part => part === '..' || part === '.' || part === '')) throw new Error('资源索引包含不安全的路径')
    files.push({ name, hash: object.hash })
  }
  return { mode, files }
}

/** Ordering and label for the version picker. */
export const channelLabels: Record<VersionChannel, string> = { release: '正式版', snapshot: '快照', old_beta: '远古 Beta', old_alpha: '远古 Alpha' }
