import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InstanceOptionsError, resolveInstanceOptions, validateInstanceOptions,
  type InstanceOptions,
} from './instance-options'

test('all defaults have an explicit source and returned collections are independent', () => {
  const first = resolveInstanceOptions()
  assert.deepEqual(first.values, {
    javaPath: '', manualJavaPath: '', memoryMode: 'auto', memoryMb: 4096,
    jvmArgs: [], windowWidth: 1280, windowHeight: 720, fullscreen: false,
  })
  assert.deepEqual(Object.keys(first.sources).sort(), Object.keys(first.values).sort())
  assert.ok(Object.values(first.sources).every(value => value === 'default'))
  first.values.jvmArgs.push('-Dexample=changed')
  first.values.memoryMb = 8192
  assert.deepEqual(resolveInstanceOptions().values.jvmArgs, [])
  assert.equal(resolveInstanceOptions().values.memoryMb, 4096)
})

test('undefined inherits per field while empty paths, empty argv and false are explicit overrides', () => {
  const global: InstanceOptions = {
    javaPath: '/global/java', manualJavaPath: '/remembered/java', memoryMode: 'manual', memoryMb: 8192,
    jvmArgs: ['-XX:+UseG1GC'], windowWidth: 1920, windowHeight: 1080, fullscreen: true,
  }
  const instance: InstanceOptions = {
    javaPath: '', memoryMode: 'auto', memoryMb: undefined, jvmArgs: [], windowHeight: 720, fullscreen: false,
  }
  const resolved = resolveInstanceOptions(global, instance)
  assert.deepEqual(resolved.values, {
    javaPath: '', manualJavaPath: '/remembered/java', memoryMode: 'auto', memoryMb: 8192,
    jvmArgs: [], windowWidth: 1920, windowHeight: 720, fullscreen: false,
  })
  assert.deepEqual(resolved.sources, {
    javaPath: 'instance', manualJavaPath: 'global', memoryMode: 'instance', memoryMb: 'global',
    jvmArgs: 'instance', windowWidth: 'global', windowHeight: 'instance', fullscreen: 'instance',
  })
  assert.deepEqual(validateInstanceOptions({ javaPath: undefined, memoryMb: undefined }), {})
  assert.equal(Object.hasOwn(instance, 'memoryMb'), true, 'validation must not mutate its input')
})

test('argv arrays replace rather than append, and global/instance/returned values cannot mutate one another', () => {
  const global: InstanceOptions = { jvmArgs: ['-XX:+UseG1GC'], memoryMb: 6144 }
  const instance: InstanceOptions = { jvmArgs: ['-XX:+UseZGC'] }
  const validated = validateInstanceOptions(instance)
  const result = resolveInstanceOptions(global, validated)
  assert.deepEqual(result.values.jvmArgs, ['-XX:+UseZGC'])
  result.values.jvmArgs.push('-Dafter=result')
  validated.jvmArgs!.push('-Dafter=validated')
  assert.deepEqual(instance.jvmArgs, ['-XX:+UseZGC'])
  assert.deepEqual(global.jvmArgs, ['-XX:+UseG1GC'])
})

test('unknown keys, exotic objects and accessors are rejected without executing getters', () => {
  let reads = 0
  const accessor = Object.defineProperty({}, 'memoryMb', { get() { reads++; return 4096 } })
  for (const input of [
    null, undefined, [], 'auto', 1, new Date(), Object.create({ memoryMb: 8192 }), accessor,
    { memory: 4096 }, { memoryMb: 4096, unknown: undefined }, { [Symbol('hidden')]: true },
    JSON.parse('{"__proto__":{"javaPath":"/other/java"}}'),
  ]) assert.throws(() => validateInstanceOptions(input), InstanceOptionsError)
  assert.equal(reads, 0)
  assert.deepEqual(validateInstanceOptions(Object.assign(Object.create(null), { memoryMb: 4096 })), { memoryMb: 4096 })
})

test('Java paths accept absolute POSIX, Windows drive and UNC paths without rewriting them', () => {
  for (const value of ['', '/usr/lib/jvm/java/bin/java', '/Users/玩家/Java 21/bin/java', 'C:\\Program Files\\Java\\bin\\java.exe', 'D:/Java/bin/java.exe', '\\\\server\\runtime share\\bin\\java.exe']) {
    assert.deepEqual(validateInstanceOptions({ javaPath: value, manualJavaPath: value }), { javaPath: value, manualJavaPath: value })
  }
  for (const value of ['java', '~/java', '$JAVA_HOME/bin/java', 'C:relative\\java.exe', '\\bin\\java.exe', '\\\\?\\C:\\java.exe', '\\\\.\\pipe\\java', '//?/C:/java.exe', 'file:///usr/bin/java', '/java\n-version', '/java\0', '/'.repeat(4097), 3, null]) {
    assert.throws(() => validateInstanceOptions({ javaPath: value }), InstanceOptionsError)
    assert.throws(() => validateInstanceOptions({ manualJavaPath: value }), InstanceOptionsError)
  }
})

test('numeric, boolean and enum settings enforce their exact ranges and types', () => {
  assert.deepEqual(validateInstanceOptions({ memoryMb: 1024, windowWidth: 640, windowHeight: 360, fullscreen: false, memoryMode: 'auto' }), {
    memoryMb: 1024, windowWidth: 640, windowHeight: 360, fullscreen: false, memoryMode: 'auto',
  })
  assert.deepEqual(validateInstanceOptions({ memoryMb: 65536, windowWidth: 7680, windowHeight: 4320, fullscreen: true, memoryMode: 'manual' }), {
    memoryMb: 65536, windowWidth: 7680, windowHeight: 4320, fullscreen: true, memoryMode: 'manual',
  })
  for (const [field, invalid] of [
    ['memoryMb', [0, 1023, 65537, '4096', 4096.5, Infinity, NaN, null]],
    ['windowWidth', [639, 7681, 1000.5, '1280', null]],
    ['windowHeight', [359, 4321, 720.5, '720', null]],
    ['fullscreen', ['false', 0, 1, null]],
    ['memoryMode', ['automatic', 'AUTO', true, null]],
  ] as const) for (const value of invalid) {
    assert.throws(() => validateInstanceOptions({ [field]: value }), error => error instanceof InstanceOptionsError && error.field === field)
  }
})

test('useful GC, diagnostics, properties and stack tuning preserve every original argv boundary', () => {
  const args = [
    '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:G1NewSizePercent=20',
    '-XX:G1ReservePercent=20', '-XX:G1HeapRegionSize=8m', '-XX:ReservedCodeCacheSize=256M',
    '-XX:ActiveProcessorCount=4', '-XX:+UseStringDeduplication', '-XX:-OmitStackTraceInFastThrow',
    '-XX:+HeapDumpOnOutOfMemoryError', '-XX:HeapDumpPath=C:\\Crash Reports\\java.hprof',
    '-XX:ErrorFile=logs/hs_err_pid%p.log', '-Xss1m', '-Xlog:gc*:file=logs/gc log.txt:time,level',
    '-Dfile.encoding=UTF-8', '-Duser.language=zh', '-Dexample.message=hello -Xmx32G --accessToken=literal',
    '-Dexample.path=C:\\Program Files\\Java', '-Dexample.literal=$(never-run)',
    '-Dempty', '-ea:com.example...', '-Xcheck:jni', '--show-version', '--enable-preview',
  ]
  const validated = validateInstanceOptions({ jvmArgs: args })
  assert.deepEqual(validated.jvmArgs, args)
  assert.notEqual(validated.jvmArgs, args)
})

test('module flags support both equals and two-argv forms without consuming unrelated options', () => {
  const args = [
    '--add-opens=java.base/java.lang=ALL-UNNAMED',
    '--add-exports', 'java.base/sun.security.util=ALL-UNNAMED,example.module',
    '--add-reads=example.module=java.base,ALL-UNNAMED',
    '--add-modules', 'java.sql,ALL-SYSTEM',
    '--limit-modules=java.base,java.logging',
    '--enable-native-access', 'ALL-UNNAMED',
    '-Dafter.module=still-an-option',
  ]
  assert.deepEqual(validateInstanceOptions({ jvmArgs: args }).jvmArgs, args)
  for (const invalid of [
    ['--add-opens'], ['--add-opens', '-Dmissing=value'], ['--add-opens='],
    ['--add-opens', 'java.base/java.lang'], ['--add-opens', '"java.base/java.lang=ALL-UNNAMED"'],
    ['--add-opens', 'java.base/java.lang=ALL-UNNAMED', 'MainClass'],
    ['--add-modules', 'java.base,,java.sql'], ['--add-reads=java.base='],
    ['--limit-modules=ALL-SYSTEM'], ['--enable-native-access', '@flags.txt'],
    ['--add-opens=java.base/java.lang=ALL-UNNAMED -cp /other'],
  ]) assert.throws(() => validateInstanceOptions({ jvmArgs: invalid }), InstanceOptionsError)
})

test('entry points, class paths, auth arguments, parameter files and executable hooks cannot be supplied', () => {
  for (const args of [
    ['MainClass'], ['-jar', '/tmp/other.jar'], ['-cp', '/tmp/other.jar'], ['--class-path=/tmp/other.jar'],
    ['-classpath', 'other'], ['--module', 'other/Main'], ['-m', 'other/Main'], ['-p', 'other'],
    ['--module-path=other'], ['--patch-module', 'java.base=other'], ['--upgrade-module-path=other'],
    ['--source=21', 'Other.java'], ['@args.txt'], ['@@args.txt'], ['--', 'MainClass'],
    ['--accessToken', 'private-secret'], ['--username=Other'], ['--uuid=abc'],
    ['-javaagent:other.jar'], ['-agentlib:jdwp=transport=dt_socket,server=y,address=*:5005'],
    ['-agentpath:/tmp/native.so'], ['-Xrunjdwp:server=y'], ['-Xbootclasspath/a:/tmp/other.jar'],
    ['-XX:Flags=/tmp/flags'], ['-XX:VMOptionsFile=/tmp/options'],
    ['-XX:OnError=echo should-not-run'], ['-XX:OnOutOfMemoryError=command'],
    ['-XX:SharedArchiveFile=other.jsa'], ['--version'], ['--dry-run'], ['--list-modules'], ['-Xlog:help'],
  ]) assert.throws(() => validateInstanceOptions({ jvmArgs: args }), InstanceOptionsError)
})

test('all heap-cap spellings remain owned by Lua rather than last-argument-wins overrides', () => {
  for (const value of [
    '-Xmx8G', '-Xmx', '-Xms2g', '-Xmn1g', '-XX:MaxHeapSize=8g', '-XX:InitialHeapSize=2g',
    '-XX:MinHeapSize=1g', '-XX:SoftMaxHeapSize=8g', '-XX:MaxRAM=64g', '-XX:MaxRAMPercentage=95',
    '-XX:InitialRAMPercentage=50', '-XX:MinRAMPercentage=30', '-XX:MaxRAMFraction=1', '-XX:+AggressiveHeap',
    '-XX:ErgoHeapSizeLimit=64g',
  ]) assert.throws(() => validateInstanceOptions({ jvmArgs: [value] }), InstanceOptionsError)
})

test('properties that replace authentication, native library or bootstrap configuration are rejected', () => {
  for (const property of [
    'java.class.path', 'java.library.path', 'java.home', 'java.system.class.loader', 'sun.java.command',
    'sun.boot.class.path', 'jdk.module.path', 'jdk.module.main', 'minecraft.api.auth.host',
    'minecraft.api.services.host', 'minecraft.launcher.brand', 'authlibinjector.side', 'auth.session',
    'auth_access_token', 'accessToken', 'jna.library.path', 'jna.boot.library.path', 'org.lwjgl.librarypath',
    'org.lwjgl.system.SharedLibraryExtractPath', 'org.lwjgl.glfw.libname', 'libraryDirectory',
    'legacyClassPath', 'ignoreList', 'mergeModules', 'fabric.addMods', 'fabric.gameJarPath', 'user.dir',
  ]) {
    assert.throws(() => validateInstanceOptions({ jvmArgs: [`-D${property}=private-secret-value`] }), error => {
      assert.ok(error instanceof InstanceOptionsError)
      assert.equal(error.message.includes('private-secret-value'), false)
      assert.equal(error.argumentIndex, 0)
      return true
    })
  }
})

test('unrecognized or malformed options fail clearly rather than being silently split or ignored', () => {
  for (const args of [
    ['-XX:UnknownFutureFlag=1'], ['-XX:+UnknownCollector'], ['-XX:MaxGCPauseMillis=fast'],
    ['-XX:G1NewSizePercent=101'], ['-XX:G1HeapRegionSize=-1g'], ['-XX:G1HeapRegionSize=999999999999999999g'],
    ['-XX:ErrorFile='], ['-Xss'], ['-Xss0'], ['-Xss', '1m'], ['-XX:+UseG1GC -Dfoo=bar'],
    [' -XX:+UseG1GC'], ['"-XX:+UseG1GC"'], ['-Dfoo bar=value'], ['-D=missing'], ['-Dfoo=ok\n--accessToken=secret'],
    [''], ['   '], ['-Dfoo=\0'], [1], [undefined],
  ]) assert.throws(() => validateInstanceOptions({ jvmArgs: args }), InstanceOptionsError)
  assert.throws(() => validateInstanceOptions({ jvmArgs: '-XX:+UseG1GC' }), /字符串数组/)
})

test('argv count and total length are bounded independently and inherited input is validated too', () => {
  const sixtyFour = Array.from({ length: 64 }, (_, i) => `-Dexample${i}=value`)
  assert.equal(validateInstanceOptions({ jvmArgs: sixtyFour }).jvmArgs?.length, 64)
  assert.throws(() => validateInstanceOptions({ jvmArgs: [...sixtyFour, '-Dextra=value'] }), /64/)
  assert.equal(validateInstanceOptions({ jvmArgs: [`-Dfoo=${'x'.repeat(8192 - 6)}`] }).jvmArgs![0].length, 8192)
  assert.throws(() => validateInstanceOptions({ jvmArgs: [`-Dfoo=${'x'.repeat(8193 - 6)}`] }), /8192/)
  assert.throws(() => validateInstanceOptions({ jvmArgs: ['-Dfoo=' + 'x'.repeat(5000), '-Dbar=' + 'y'.repeat(5000)] }), /8192/)
  assert.throws(() => resolveInstanceOptions({ jvmArgs: ['-Xmx8g'] }, { jvmArgs: [] }), InstanceOptionsError)
  assert.throws(() => resolveInstanceOptions({}, { memoryMb: null } as unknown as InstanceOptions), InstanceOptionsError)
})
