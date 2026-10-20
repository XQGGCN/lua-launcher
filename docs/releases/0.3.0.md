# Lua 0.3.0 Alpha · 未央

这是开发预览版，可用于体验界面、下载游戏、管理实例与安装模组。

**目前仍不能完成正版登录并启动游戏。** Lua 自有应用的 Minecraft API 接入申请已提交，尚未获批；实测 Microsoft 和 Xbox / XSTS 验证通过，但 Minecraft 登录接口仍返回 `403`。本版本只保留 Microsoft 在线账户，没有离线入口或登录失败后的离线回退。下载安装包、赞助项目或重新登录不会解除这项上游限制。

## 本次更新

- 新增 Forge 与 NeoForge 版本选择、固定版本安装，以及对应 `.mrpack` 整合包支持；保留原版与 Fabric。游戏范围为 Minecraft 1.20.1 及之后的正式版本，具体加载器版本以官方列表和安装结果为准。
- 加载器使用官方 Maven 安装器和依赖，验证文件哈希，在实例独立目录执行客户端安装处理器；失败或取消不会将半成品标记为可启动。
- 新增自动内存分配，并保留手动设置。启动时根据当前可用内存限制实际分配；内存不足时显示明确提示。
- 模组页面新增功能分类筛选，可搭配 Modrinth / BBSMC 来源、加载器和游戏版本寻找资源。
- 模组安装按 Fabric、Forge、NeoForge 分别检查兼容性，同一来源的必需依赖一并校验安装；不同加载器的模组不会直接混装。

## 验证范围

- macOS ARM64 / Java 17 已完成真实官方安装处理器验证：Minecraft 1.20.1 + Forge 47.4.0、Minecraft 1.20.2 + NeoForge 20.2.93，生成文件通过校验。
- 自动测试覆盖版本绑定、启动参数与类路径、下载校验、取消、回滚、账户并发和内存分配。模拟进程测试不代表实际游戏运行成功。
- Windows、macOS、Linux 安装包由同一提交的构建与测试任务生成。当前纯在线版的完整游戏启动，以及 Windows / Linux 的实际游玩仍待验证。

## 下载与限制

- Windows 下载 `.exe`；macOS 下载 `.dmg` 或 `.zip`；Linux 下载 `.AppImage`。请选择与系统和文件名标注的架构匹配的版本。
- 安装包尚未进行 Windows 代码签名或 macOS 公证，系统可能显示来源或开发者未验证的提示。
- BBSMC 接入仍为实验性：搜索和版本查询已实测，当前测试网络的 CDN 下载会返回安全验证网页，Lua 会拒绝将其当作模组安装。需要登录、购买、网盘或外部链接的资源须前往官网获取，不绕过站点验证或访问限制。
- 需要自行安装匹配的 Java；暂不支持自动安装 Java、Quilt、旧版 Minecraft、快照、CurseForge 格式整合包或自动更新。
- 本项目是独立启动器，与 Minecraft、Mojang、Microsoft、Forge、NeoForge、Modrinth、BBSMC 均无官方关联，不随安装包分发游戏客户端或第三方模组。

源码与问题反馈：[XQGGCN/lua-launcher](https://github.com/XQGGCN/lua-launcher)。Forge 与 NeoForge 来自各自官方项目；也欢迎支持 [Forge](https://files.minecraftforge.net/) 与 [NeoForged](https://neoforged.net/)。
