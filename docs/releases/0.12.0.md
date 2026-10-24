# Lua · 未央 0.12.0 Alpha

实例内容的“模组”页新增声明详情。选择一个`.jar`或`.jar.disabled`，可以查看模组名称、ID、版本、作者、许可、运行环境与依赖声明；也可以选择本地JAR只读预览，尚不导入。缺少mods目录时，本地预览仍可使用。

支持已实现的Fabric/Quilt JSON、Forge/NeoForge TOML多模组和Manifest主节声明。混合格式分别展示，未知范围不自动判断兼容；Quilt开发JSON5标为不支持，不新增Quilt加载器。外层文件SHA-512与历史下载登记分开，不表示其他载荷、签名、模组代码或实际加载已验证。

读取不会改名、启停、执行JAR或下载图标和依赖。停止操作等待实际读取结束，切换实例或刷新隔离旧结果。修复本轮发现的控制字符清理改写ID，以及生产清单小数毫秒时间被误判为文件变化的问题。TOML解析器准确锁定，完整许可随包保留。用法见源码`docs/MOD_DETAILS.md`。

本地850项完整测试、176项独立相关测试、构建和未签名macOS ARM64包核对通过。生产Electron IPC/只读文件系统使用原创JAR夹具验收，11项源/state基准不变，文件选择回调明确注入；未运行真实模组、Java或游戏。真实OS选择窗口、广泛版本/平台游玩及本提交CI/公开资产另验。

发行后可从Release Assets下载Windows x64 EXE、macOS ARM64 DMG/ZIP或Linux x64 AppImage；实际公开版本以已有Release为准，本地完成不代表已发布。安装包尚未代码签名或公证。

Minecraft是Mojang的商标，本项目与Mojang、Microsoft无关联。
