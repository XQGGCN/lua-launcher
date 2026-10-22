/** Turns a crashed game's recent output and crash report into a plain-language explanation. */
export interface CrashAnalysis {
  title: string
  hints: string[]
  /** File name of the newest crash report under game/crash-reports, if one was written. */
  report?: string
  /** The crash report's own one-line description. */
  description?: string
}

interface Rule { test: RegExp; title: string; hint: string }
const rules: Rule[] = [
  { test: /java\.lang\.OutOfMemoryError|GC overhead limit exceeded/, title: '游戏内存不足', hint: '在实例设置里把内存调高（大型整合包建议 6–8 GB），或关闭其他占用内存的程序。' },
  { test: /Could not reserve enough space for (?:the )?object heap|Invalid maximum heap size|Initial heap size set to a larger value/, title: 'Java 无法分配设置的内存', hint: '分配的内存超过了 Java 或系统允许的上限。请改为「自动分配」，或确认使用的是 64 位 Java。' },
  { test: /UnsupportedClassVersionError|has been compiled by a more recent version of the Java Runtime/, title: 'Java 版本不匹配', hint: '某个模组或游戏需要更新的 Java。请把实例的 Java 设为「自动」，Lua 会准备正确的版本。' },
  { test: /Incompatible mods? found|Mod resolution encountered an incompatible mod set|Missing or unsupported mandatory dependencies|requires (?:any version of |version )?\S+ (?:of|which is missing)|depends on .* which is missing/i, title: '模组缺少前置或互不兼容', hint: '日志里列出了缺少的前置模组或冲突的模组。安装缺少的前置，或删除 / 禁用冲突的模组后再启动。' },
  { test: /DuplicateModsFoundException|Duplicate mods? found|Found duplicate mods/i, title: '有重复的模组', hint: '同一个模组装了两个版本。到「实例内容 → 模组」中禁用或删除其中一个。' },
  { test: /Mixin apply (?:for mod \S+ )?failed|MixinApplyError|InvalidInjectionException|MixinTransformerError/, title: '模组之间发生冲突（Mixin）', hint: '通常是两个模组修改了同一处代码，或模组版本与游戏版本不符。逐个禁用最近添加的模组排查。' },
  { test: /NoClassDefFoundError|ClassNotFoundException|NoSuchMethodError|NoSuchFieldError/, title: '模组与游戏或加载器版本不匹配', hint: '某个模组是为其他 Minecraft / 加载器版本编写的。检查最近安装的模组是否对应当前游戏版本。' },
  { test: /GLFW error 65542|WGL: The driver does not appear to support OpenGL|Pixel format not accelerated|No OpenGL context|GL_VERSION|LWJGLException/, title: '显卡驱动不支持或未正确安装', hint: '请更新显卡驱动。笔记本电脑请让 Java 使用独立显卡；远程桌面或虚拟机里可能无法运行。' },
  { test: /EXCEPTION_ACCESS_VIOLATION|SIGSEGV|A fatal error has been detected by the Java Runtime Environment/, title: 'Java 运行时崩溃', hint: '多见于显卡驱动、光影模组或过旧的 Java。更新显卡驱动，暂时关闭光影后再试。' },
  { test: /Failed to (?:load|find) (?:library|native)|UnsatisfiedLinkError|no lwjgl in java\.library\.path/, title: '原生库加载失败', hint: '游戏运行库可能缺失或架构不对。在下载任务里重新安装这个实例即可修复。' },
  { test: /Bad CPU type in executable|incompatible architecture/, title: 'Java 架构与系统不符', hint: 'Apple 芯片运行旧版本需要 Rosetta 2：在终端执行 softwareupdate --install-rosetta 后重试。' },
  { test: /Failed to authenticate|Invalid session|Not authenticated|Bad login/i, title: '账户验证失败', hint: '请在「账户」里退出后重新登录 Microsoft 账户。' },
  { test: /java\.net\.(?:UnknownHostException|ConnectException)/, title: '网络连接失败', hint: '游戏或模组需要联网验证，请检查网络或代理设置。' },
  { test: /Exception in server tick loop|Encountered an unexpected exception/, title: '世界运行时出错', hint: '可能由模组或损坏的存档引起。先备份世界，再禁用最近添加的模组排查。' },
]

export function analyzeCrash(output: string[], crashReport?: { name: string; text: string }): CrashAnalysis {
  const haystack = `${output.join('\n')}\n${crashReport?.text ?? ''}`
  const matched = rules.filter(rule => rule.test.test(haystack))
  const description = crashReport ? /^Description:\s*(.+)$/m.exec(crashReport.text)?.[1]?.trim().slice(0, 200) : undefined
  const hints = matched.slice(0, 3).map(rule => rule.hint)
  if (!hints.length) hints.push('打开「运行日志」查看最后几行错误，或把崩溃报告发给模组作者。最近添加的模组通常是首要排查对象。')
  return {
    title: matched[0]?.title ?? (description ? `游戏崩溃：${description}` : '游戏意外退出'),
    hints,
    ...(crashReport ? { report: crashReport.name } : {}),
    ...(description ? { description } : {}),
  }
}
