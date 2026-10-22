# 隐私政策 / Privacy policy

更新：2026-10-22 · 适用于 Lua · 未央（Lua Launcher）0.10.0 及之后的版本。

Lua 是在你电脑上运行的开源启动器，**没有任何统计、遥测或广告**，也没有属于 Lua 的服务器。它只在完成你要求的操作时，直接连接下面这些服务：

| 服务 | 用途 | 会发送什么 |
| --- | --- | --- |
| Microsoft / Xbox / Minecraft 服务（login.microsoftonline.com、user.auth.xboxlive.com、api.minecraftservices.com 等） | 登录正版账户、验证游戏所有权、读取游戏档案和皮肤 | 你在微软官方页面完成授权后得到的令牌 |
| Mojang 下载服务（piston-meta / piston-data / libraries / resources 等） | 下载游戏、运行库、资源文件和 Java | 普通的文件下载请求 |
| BMCLAPI 镜像（bmclapi2.bangbang93.com，第三方社区服务） | 在你选择或自动回退时代替 Mojang / Fabric / Forge 官方源下载 | 普通的文件下载请求；可在「设置 → 下载源」改为只用官方服务器 |
| Fabric、Forge、NeoForge 官方仓库 | 安装模组加载器 | 普通的文件下载请求 |
| Modrinth、BBSMC | 搜索和下载模组、资源包、光影和整合包 | 搜索关键词、筛选条件 |
| GitHub（api.github.com、github.com） | 检查和下载启动器更新 | 当前版本号（在 User-Agent 中）；可在「设置 → 自动检查更新」关闭 |

这些服务会像任何网站一样看到你的 IP 地址，并按各自的隐私政策处理。

**保存在你电脑上的数据**：实例、存档、备份、设置和运行日志都只保存在启动器的数据目录中。账户的刷新令牌由系统安全存储（macOS 钥匙串、Windows DPAPI、Linux 密钥环）加密保存，访问令牌只在内存中。退出账户会删除保存的会话。

**不会做的事**：不上传存档、日志、崩溃报告或任何文件；不收集设备信息；不出售或共享数据。崩溃分析只在本机读取日志。

卸载：在 Windows「设置 → 应用」中卸载 Lua，或删除 macOS / Linux 上的应用文件。数据目录不会被自动删除，需要时可以手动删除。

有问题请在 [GitHub Issues](https://github.com/XQGGCN/lua-launcher/issues) 提出。
