const JAVA_INJECTION_KEYS = new Set(['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH'])

/** Keep Java options explicit, including Windows' case-insensitive environment keys. */
export function javaProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !JAVA_INJECTION_KEYS.has(key.toUpperCase())))
}
