# Lua · 未央 0.10.0 Alpha

## 新功能

- **国内下载加速**：新增「设置 → 下载源」。可选「自动（官方优先，失败或超时自动换镜像）」「国内镜像优先」「只用官方服务器」，镜像使用社区提供的 BMCLAPI。时区为中国大陆时默认使用镜像。游戏本体、运行库、资源文件、Java 以及 Fabric / Forge / NeoForge 都会走所选下载源，所有文件下载后仍按官方校验值核对。
- **自动更新**：启动后检查 GitHub 上的新版本，有更新时左下角会提示，可查看更新说明。
  - Windows：一键下载安装程序并更新。
  - Linux：AppImage 直接替换并重启。
  - macOS：下载后打开安装包。
  - 安装包都会核对 GitHub 公布的 SHA-256。可以在设置中关闭自动检查，或手动「检查更新」。

## 其他

- 新增[隐私政策](https://github.com/XQGGCN/lua-launcher/blob/main/docs/PRIVACY.md)：Lua 没有统计和遥测，只在你操作时连接 Minecraft、模组站和 GitHub。
- 为 Windows 代码签名做好准备：CI 已预留 SignPath 开源免费签名和 Microsoft Store（MSIX）打包，配置后自动生效。详见 [代码签名说明](https://github.com/XQGGCN/lua-launcher/blob/main/docs/CODE_SIGNING.md)。

## 安装

在本页 Assets 下载：Windows（Lua-Setup-0.10.0.exe）、macOS（.dmg / .zip，Apple 芯片）、Linux（.AppImage）。从 0.10.0 开始，之后的版本可以在启动器内更新。安装包暂未签名，首次运行时 Windows 可能提示「未知发布者」，点「更多信息 → 仍要运行」即可。

Minecraft 是 Mojang 的商标，本项目与 Mojang、Microsoft 无关联。
