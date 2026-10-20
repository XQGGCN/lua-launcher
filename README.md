# Lua · 未央

一个面向 Windows、macOS 和 Linux 的独立 Minecraft Java 启动器。采用参考 PCL / HMCL 的实用、紧凑浅色桌面布局，把账户、版本、Java 与启动操作放在清晰的位置；集成 Modrinth 模组搜索，使用原创实现与独立品牌。

**当前状态：0.1.0 Alpha。** 首版聚焦现代原版与 Fabric 的安装、隔离实例及真实启动；尚未达到 PCL / HMCL 的完整功能覆盖。

## 验证状态

截至 2026-10-21：

- **47 项确定性测试通过**：30 项认证测试、17 项启动内核测试。测试使用模拟网络，不代表真实 Microsoft 登录已经验证。
- **macOS ARM64 实测**：Minecraft 1.20.1 原版，以及 1.20.1 + Fabric Loader 0.19.5，均在显式离线模式下完成游戏初始化。
- **尚未验证**：Microsoft 真实账号完整登录、Windows / Linux 实际游戏运行，以及其他系统架构和游戏版本的完整兼容性。游戏初始化通过不代表长期游玩、存档或联机已全面测试。

## 已实现

- 独立实例：各自的游戏目录、存档与模组，共享校验后的基础资源。
- Minecraft 正式版本列表，现代版本（1.20.1 起）的下载与 SHA-1 校验。
- Fabric Loader 安装，平台和架构对应的运行库解析。
- 下载进度、取消、重试与已完成文件复用。
- Java 自动探测、手动路径、内存与并发设置。
- 游戏启动、关闭、状态跟踪与实时日志。
- Microsoft 设备码认证、许可与档案检查、刷新令牌安全存储；**需配置自己的应用客户端 ID 与相应 API 接入资格，真实账号流程尚待验证**。
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

当前 Alpha 使用自有 Microsoft 公共客户端应用注册。请按 [Microsoft 设备码文档](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code) 配置个人账户和公共客户端流，并确认应用获得所需 Xbox / Minecraft 接口访问资格。把 **client ID** 填入账户页；不要填写 client secret。

登录在 Microsoft 官方页面完成，Lua 不收集 Microsoft 密码。访问令牌仅在 Electron 主进程内存中处理；刷新信息通过系统安全存储加密后写入应用目录。系统密钥环不可用时拒绝持久化，不降级为明文。

## 数据与隐私

默认数据位于系统的 Lua 应用数据目录下 `launcher/`，实例存档在 `instances/<id>/game/`。不会自动扫描或修改其他启动器的游戏目录。没有分析统计、广告或账号遥测。

下载和搜索会连接 Mojang / Microsoft、Fabric、Modrinth 的官方服务。模组信息与图标来自 Modrinth API，版权归各项目作者；不随仓库重新分发这些素材。

## 兼容性与限制

- 跨平台架构及打包配置已提供；实际验证范围见上方“验证状态”，Windows / Linux 游戏运行仍待测试。
- 旧版 Minecraft、快照、Forge / NeoForge / Quilt、整合包导入导出、自动 Java 安装、皮肤管理、自动更新尚未实现。
- 模组更新、卸载和冲突分析尚未实现。Alpha 阶段建议新建测试实例。
- 安装包尚未做 Windows 代码签名或 macOS 公证。开发者需要自行配置签名后正式分发。
- Lua 与 Minecraft、Mojang、Microsoft、PCL、HMCL、Modrinth 均无官方关联。

## 开发

```text
src/                React UI 与受限的桌面 API 客户端
desktop/core.ts     安装、平台规则、Java、启动与 Modrinth
desktop/auth.ts     Microsoft → Xbox → Minecraft 认证
desktop/main.ts     Electron 生命周期、IPC 与系统安全存储
desktop/preload.ts  隔离的命令桥
docs/RESEARCH.md    功能参照与源码许可研究
```

Electron 禁用 renderer Node 集成、启用 context isolation / sandbox、验证 IPC 来源并限定命令。下载仅允许指定官方域名，验证校验值并拒绝路径穿越。测试使用临时目录与模拟网络响应，不依赖个人账号。

原创代码采用 [MIT](LICENSE) 许可。依赖保留各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。贡献请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。
