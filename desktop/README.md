# Lua · 未央

一个面向 Windows、macOS 和 Linux 的独立 Minecraft Java 启动器。采用参考 PCL / HMCL 的实用、紧凑浅色桌面布局，把账户、版本、Java 与启动操作放在清晰的位置；集成 Modrinth 模组搜索，使用原创实现与独立品牌。

**当前状态：0.2.0 Alpha。** 支持现代原版与 Fabric 下载、隔离实例、真实启动及 Modrinth 整合包安装；尚未达到 PCL / HMCL 的完整功能覆盖。

## 验证状态

截至 2026-10-21：

- **95 项确定性测试通过**，覆盖认证与配置、账户切换竞态、启动内核、整合包解析和事务安装、文件选择隔离。测试使用模拟网络，不代表真实 Microsoft 登录已经验证。最新结果可见 [GitHub Actions](https://github.com/XQGGCN/lua-launcher/actions)。
- **macOS ARM64 实测**：Minecraft 1.20.1 原版，以及 1.20.1 + Fabric Loader 0.19.5，均在显式离线模式下完成游戏初始化。
- **0.2 整合包实测**：在线安装及桌面本地导入 Fabulously Optimized 5.4.1（Minecraft 1.20.1 / Fabric 0.14.23），校验并安装 48 个模组；从桌面启动后完成游戏初始化、进入主循环。此包仅作为验证样例，不随 Lua 分发。
- **尚未验证**：Microsoft 真实账号完整登录、Windows / Linux 实际游戏运行，以及其他系统架构和游戏版本的完整兼容性。游戏初始化通过不代表长期游玩、存档或联机已全面测试。

## 已实现

- 独立实例：各自的游戏目录、存档与模组，共享校验后的基础资源。
- Minecraft 正式版本列表，现代版本（1.20.1 起）的下载与 SHA-1 校验。
- Fabric Loader 安装，平台和架构对应的运行库解析。
- 选择 Minecraft / Fabric 版本后直接下载；任务页展示进度、取消、重试与已完成文件复用。
- Modrinth 整合包在线搜索、版本选择和下载；本地 `.mrpack` 导入前预览名称、版本、加载器与文件大小。
- 整合包固定加载器版本、验证 SHA-1 与 SHA-512、应用客户端配置；取消或失败后可从任务页重试，完整安装成功才标记为可启动。
- Java 自动探测、手动路径、内存与并发设置。
- 游戏启动、关闭、状态跟踪与实时日志。
- Microsoft 设备码认证、授权进度和倒计时、取消、许可与档案检查、刷新令牌安全存储；**维护者仍需配置 Lua 自己的应用客户端 ID 与相应 API 接入资格，真实账号流程尚待验证**。
- 显式离线账户；不将离线身份显示为 Microsoft 登录，不提供正版服务器认证。
- Modrinth 实时搜索；核心支持匹配 Fabric 版本、下载模组及必需依赖。

## 本地运行

准备 Node.js 22.12+ 和 pnpm 11.25，然后：

```sh
pnpm install
pnpm desktop
```

Java 需要与游戏要求一致。1.20.1 使用 Java 17；较新版本通常需要 Java 21 或更高，以游戏官方元数据为准。首版不会自动下载 Java。

```sh
pnpm dev       # 浏览器 UI 预览，不能启动 Java
pnpm check     # TypeScript
pnpm test      # 离线确定性测试
pnpm build     # 前端 + Electron
pnpm package   # 当前系统未打包目录
pnpm dist      # 当前系统安装包
```

浏览器预览与桌面版有明确区分。预览实例仅保存在浏览器中，不会被当作已安装游戏。

## Microsoft 登录

当前 Alpha 尚未内置可用的 Microsoft 应用 ID。维护者请按 [完整接入步骤](docs/MICROSOFT_LOGIN.md) 注册公共客户端应用、确认所需 Xbox / Minecraft 接口访问资格，并在构建时配置 `LUA_MICROSOFT_CLIENT_ID`。发行版配置完成后，普通玩家只需授权登录。开发者也可在账户页高级设置保存自己的 **Client ID**；不要填写 Client Secret。

登录在 Microsoft 官方页面完成，Lua 不收集 Microsoft 密码。访问令牌仅在 Electron 主进程内存中处理；刷新信息通过系统安全存储加密后写入应用目录。系统密钥环不可用时拒绝持久化，不降级为明文。

## 整合包

在“整合包”页面搜索 Modrinth 项目并选择发布版本，或导入本地 `.mrpack`。首版支持 Minecraft 1.20.1 及之后的正式版、原版 / Fabric；包要求的 Fabric 版本会固定使用。客户端标记为 optional 的文件会一并安装，server-only 文件跳过。

Forge / NeoForge / Quilt、旧游戏版本和 CurseForge 格式会给出明确的不兼容提示。`.zip` 只有包含 Modrinth 标准清单才可导入。每个包创建独立实例，配置覆盖不会写入其他实例；失败后保留包源，可在“下载任务”中重试。

## 获取构建

[GitHub Actions](https://github.com/XQGGCN/lua-launcher/actions) 为 Windows、Linux、macOS 分别构建安装包。打开成功的工作流，在 Artifacts 下载对应系统文件；GitHub 可能要求登录。构建尚未代码签名或公证，仍属于测试版。

## 数据与隐私

默认数据位于系统的 Lua 应用数据目录下 `launcher/`，实例存档在 `instances/<id>/game/`。不会自动扫描或修改其他启动器的游戏目录。没有分析统计、广告或账号遥测。

下载和搜索会连接 Mojang / Microsoft、Fabric、Modrinth 的官方服务。模组信息与图标来自 Modrinth API，版权归各项目作者；不随仓库重新分发这些素材。

## 兼容性与限制

- 跨平台架构及打包配置已提供；实际验证范围见上方“验证状态”，Windows / Linux 游戏运行仍待测试。
- 旧版 Minecraft、快照、Forge / NeoForge / Quilt、CurseForge 包、整合包导出、自动 Java 安装、皮肤管理、自动更新尚未实现。
- 模组更新、卸载和冲突分析尚未实现。Alpha 阶段建议新建测试实例。
- 安装包尚未做 Windows 代码签名或 macOS 公证。开发者需要自行配置签名后正式分发。
- Lua 与 Minecraft、Mojang、Microsoft、PCL、HMCL、Modrinth 均无官方关联。

## 开发

```text
src/                React UI 与受限的桌面 API 客户端
desktop/core.ts     安装、平台规则、Java、启动与 Modrinth
desktop/auth.ts     Microsoft → Xbox → Minecraft 认证
desktop/modpack.ts  Modrinth 包格式、路径与归档校验
desktop/main.ts     Electron 生命周期、IPC 与系统安全存储
desktop/preload.ts  隔离的命令桥
docs/RESEARCH.md    功能参照与源码许可研究
```

Electron 禁用 renderer Node 集成、启用 context isolation / sandbox、验证 IPC 来源并限定命令。下载仅允许指定官方域名，验证校验值并拒绝路径穿越。测试使用临时目录与模拟网络响应，不依赖个人账号。

原创代码采用 [MIT](LICENSE) 许可。依赖保留各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。贡献请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。
