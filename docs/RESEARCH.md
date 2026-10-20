# 启动器研究与实施边界

核验日期：2026-10-20（Asia/Tokyo）。本报告阅读项目官方说明、许可证和文档，没有复制 PCL 或 HMCL 的实现代码。下列优先级为本项目建议，不能视为已经完成的功能。

## 项目现状补记 — 2026-10-21

项目品牌为 **Lua · 未央**。当前采用参考 PCL / HMCL 的实用、紧凑浅色桌面布局，以账户、版本列表、Java 设置和启动操作为中心，保持独立实现与原创品牌资产。

当前为 0.2.2 Alpha 纯在线账户版，最新测试与功能状态见 [README](../README.md)。此前版本在 macOS ARM64 上曾用离线模式完成 Minecraft 1.20.1 原版及 Fabric 的游戏初始化；0.2.2 已移除该路径，历史结果不能作为当前正版启动验收。Microsoft / Xbox / XSTS 已实测通过，但 Minecraft 登录接口返回 `403`；真实账户完整登录、Windows / Linux 游戏运行，以及其他版本和架构的完整兼容性尚未验证。以下研究建议与路线图不应被解读为全部功能已完成。

## 结论

可逐步实现与 PCL、HMCL 相近的核心工作流；“完整还原”涉及多年积累的版本兼容、加载器、账户、整合包和错误诊断，不能以一个漂亮界面作为完成标准。推荐原创名称、原创 UI、独立的 TypeScript 领域模型及可替换启动内核。

## 官方项目基线

| 项目 | 官方可确认的能力 | 对本项目的启发 |
| --- | --- | --- |
| PCL | 仓库包含 UI、动画、下载和 Minecraft 启动模块，随发布同步而非实时同步 | 关注安装反馈、下载状态、启动失败后的解释 |
| HMCL | 跨平台；模组管理、游戏配置、多个加载器安装、整合包制作、外观定制 | 以隔离实例组织账户、Java、版本和内容 |

来源：[PCL 官方仓库](https://github.com/Meloong-Git/PCL)、[HMCL 官方仓库](https://github.com/HMCL-dev/HMCL)。HMCL 官方文档还说明实例列表、游戏和社区内容下载、Java 管理、全局设置等实际入口：[界面功能介绍](https://docs.hmcl.net/launcher/gui-features.html)、[文档入口](https://docs.hmcl.net/)。

## 许可证与品牌

- **PCL 不适合作为可自由改名的开源底座。** 当前 `LICENCE` 明确保留未授予权利，合理使用指南本身不是法律协议。大量参考或修改的指南条件包括：标明第三方修改，使用带区分后缀的 PCL 名称，关于页首位署名及赞助链接，公开源码并继续采用指南，实现规定的购买/赞助提示，以及 Windows 下对赞助解锁功能和主色的约束。少量参考也要求署名且避免品牌混淆。[官方 LICENCE](https://github.com/Meloong-Git/PCL/blob/main/LICENCE)
- **HMCL 可以作为 GPL 路线的候选。** 官方 README 声明 GPLv3，并要求修改版的名称或版本能够区分原版，以及保留软件中的版权声明。[官方许可说明](https://github.com/HMCL-dev/HMCL#license) 分发其衍生作品还需遵守 GPL 的完整许可、修改说明及相应源码提供义务，不能只给自己的改动套 MIT。[完整 LICENSE](https://github.com/HMCL-dev/HMCL/blob/main/LICENSE)
- **本项目建议采用独立实现路线。** 不搬运二者的源码、Logo、图标和页面素材；“对标”只表达产品方向。独立原创代码可以选择 MIT；新增依赖需逐项检查并保留其许可通知。若未来引入 HMCL 代码，应重新评估整项目许可。
- **Minecraft 名称用于描述用途。** 自有名称与 Logo 应成为主体；README、应用关于页与官网明确非 Mojang/Microsoft 官方产品。不要在 GitHub Release 或 Render 打包分发游戏文件。[Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines)

## 建议功能顺序与验收

| 阶段 | 功能 | 最低验收 |
| --- | --- | --- |
| P0：本地产品骨架 | 原创界面、实例创建/选择/持久化、Java 路径和内存设置、清晰空状态 | 重启保留配置；删除操作边界清楚；浏览器预览不伪装成真实启动 |
| P0：原版启动闭环 | 获取官方版本清单、安装一个原版实例、资源校验、Java 检测、启动与退出日志 | 真正下载并启动代表性版本；网络错误与缺 Java 可理解；取消下载不会留下可启动的半成品 |
| P1：账户与模组 | 自有 Microsoft 客户端配置、授权与刷新、游戏拥有权/档案检查；Fabric；Modrinth 搜索与兼容过滤 | 用测试账户走完整授权；令牌不进入渲染层或日志；模组与实例版本/加载器相匹配 |
| P1：整合包和常用加载器 | `.mrpack` 导入、依赖安装、Forge/NeoForge、启停模组、下载重试 | 哈希验证、路径穿越防护、失败清理、多个实例互不污染 |
| P2：成熟度 | Java 自动下载、整合包导出、更新回滚、崩溃分类、迁移导入、辅助功能、多语言 | Windows/macOS/Linux 实机矩阵；签名发布；升级后仍能启动已有实例 |

一期界面应只显示真实可用的操作；尚未接入的能力显式标记，不展示虚构的下载量、速度、在线人数或成功状态。

## Electron + React + TypeScript 的实施建议

1. React 渲染层仅负责交互。通过带类型的 preload 暴露实例、安装任务和启动命令；主进程负责文件、网络、Java 进程和令牌。
2. 启用 `contextIsolation` 和 sandbox，关闭渲染层 Node 集成；校验 IPC 调用方与参数，限制外部链接及导航，采用 CSP。远程模组介绍不能获得本地文件或命令执行能力。[Electron 官方安全文档](https://www.electronjs.org/docs/latest/tutorial/security)
3. 下载、安装和启动分离为可替换服务；以可观察任务状态驱动进度条，安装完成后才原子写入实例可用状态。
4. 可评估 `@xmcl/core` 与 `@xmcl/installer`，其官方独立仓库标示 MIT，面向 Node/Electron；但该仓库 **2026-05-06 已归档**，应固定版本、保留许可、封装适配层，并先确认上游迁移/维护状态。[官方仓库](https://github.com/Voxelum/minecraft-launcher-core-node)、[官方 API 文档](https://xmcl.app/en/core/)
5. Microsoft 桌面认证需要本项目自己的应用注册与重定向配置；不使用其他启动器的客户端标识冒充其应用。Microsoft 提供 Electron/MSAL 路线，但这不等于 Minecraft/Xbox 端到端接入已经完成。[Microsoft 桌面应用配置](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration)
6. 官网可作为独立静态站点部署在 Render，展示产品、下载和文档；安装包放 GitHub Releases。普通启动器功能无需先购买服务器。

## 尚未验证

- PCL `LICENCE` 引用的石墨《分发有限许可》正文在本次浏览工具中不可访问；本报告没有将社区转载当作官方许可替代品。
- 本次查看的是官方主分支页面，不是永久固定的提交快照；发布前需再次记录实际引用版本和许可。
- 未运行 PCL/HMCL 二进制，也未逐版本对照两者全部功能。
- 未验证 XMCL 包目前发布版本、归档后的维护迁移，以及与本项目 Electron/Node 版本的运行兼容性。
- Microsoft/Xbox/Minecraft 的应用接入资格、完整登录链路，以及 CurseForge 等第三方服务接入规则仍需在实现阶段单独核验。
- 跨平台签名、公证、自动更新、完整加载器矩阵和实际游戏启动不能从 UI 构建成功推导为已通过。
