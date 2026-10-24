# 模组文件元数据的读取范围

0.12.0 只从明确选中的 JAR 中读取固定位置的声明文件，并投影有界文字。它不会加载类、调用入口、打开嵌套 JAR、运行 Java，或访问声明中的图标、网址、更新接口与依赖仓库。整份外层文件的 SHA-512 只标识这次看到的字节，不是签名、代码安全、所有载荷 CRC 或游戏加载证明。

| 声明位置 | 当前读取内容与边界 |
| --- | --- |
| `fabric.mod.json` | [Fabric schemaVersion 1](https://wiki.fabricmc.net/documentation:fabric_mod_json_spec)的 ID、版本、名称、说明、作者、许可、环境、别名及依赖/嵌套路径声明。旧版、未知 schema 和数组根明确不支持，不伪造当前 ID。 |
| `quilt.mod.json` | [Quilt schema_version 1](https://github.com/QuiltMC/rfcs/blob/main/specification/0002-quilt.mod.json.md)中已实现结构的 loader/metadata、依赖、别名和嵌套声明。受支持的字符串/数组及带 `id` 对象保留原条件文字，不求解；不能解释的 `any/all` 等组合对象会返回失败或未知诊断，不生成可用 ID，不宣称全部组合均被保留。当前 Lua 没有 Quilt 实例加载器。 |
| `quilt.mod.json5` | [官方 Quilt 0.27 说明](https://quiltmc.org/en/changelog/quilt-loader/0.27.0/)将其限定为开发环境，正式运行不支持。本版识别路径并解释限制，不剥注释后冒充正式模组。 |
| `META-INF/mods.toml` | 用真实 TOML 解析器读取 [Forge 声明](https://docs.minecraftforge.net/en/latest/gettingstarted/modfiles/)的语言 loader、范围、许可、多份 `[[mods]]` 和对应依赖表；同路径也曾用于历史 NeoForge，不能仅凭路径断定能在 Forge 运行。 |
| `META-INF/neoforge.mods.toml` | 读取[当前 NeoForge 文档](https://docs.neoforged.net/docs/gettingstarted/modfiles/)中的多模组声明、依赖 `type/versionRange/ordering/side`。未知语言 loader 保留声明但不判断支持；未投影字段不当作已解释或已返回。不将旧版本路径或 Forge 兼容当作已核实。 |
| `META-INF/MANIFEST.MF` | 按 [JAR 规范](https://docs.oracle.com/en/java/javase/21/docs/specs/jar/jar.html)只处理主节、物理行边界及续行，先拼接续行字节再解码 UTF-8；重复属性忽略不了歧义时返回无效。后续命名节中的版本不用于替换。 |

Forge/NeoForge 的 `${file.jarVersion}` 只在主 Manifest 具有唯一有效 `Implementation-Version` 时替换；其他占位符保留并提示未解析。`Main-Class`、`Class-Path`、`FMLModType`、多版本属性和签名外观均只是原文声明，不会解析引用、执行或验证真实性。

Fabric 的条件字符串与 OR 数组、已实现结构中的 Quilt 条件、Forge/NeoForge 的 Maven 范围分别展示，没有套用同一种 npm SemVer 规则。未实现的组合结构不能当作已解析条件。本版没有建立完整的当前依赖可用性索引，也不声称依赖已满足。多份 loader 文档分别显示，不合并成一个虚构的统一 ID。

解析上限为单文档 256 KiB、累计 1 MiB、结构深度 32、20,000 节点、单文字 4,096 UTF-8 字节，累计最多 64 个模组和 256 个依赖条目、结果 1 MiB。JSON 拒绝解码后重复键；TOML 拒绝重复/危险键并使用受限深度选项。标识、版本、条件和 loader 字段中的控制/格式字符会使声明无效，不能先删掉字符制造另一个有效标识；自由显示文字保留给界面的转义层。声明无效或超限时不返回该文档的可信 ID。

TOML 使用精确锁定的 [`smol-toml` 1.9.1](https://github.com/squirrelchat/smol-toml/releases/tag/v1.9.1)，BSD-3-Clause，要求 Node >=18，适用于本项目 Node >=22.12 的运行目标。2026-10-24 通过真实 npm 注册表和该版本官方源码核对版本、许可、运行时及完整性；安装时跳过生命周期脚本，锁文件保存注册表完整性值。调用时显式启用 `maxDepth: 32` 与 `unsafeKeyBehaviour: 'throw'`，之后再检查节点/字段预算。输入字节与深度限制并不等于同步解析可被硬实时中断，整体等待采用合作式预算。

原始声明、作者及许可文字属于文件提供者，本版不将它们当作认证或来源关联。历史站点下载登记仍是历史记录；用户手动换过文件之后，不能仅凭相同文件名认定当前字节属于某个项目版本。真实安装、当前 mod ID/禁用伙伴冲突与依赖判断将分开实施，预览视图 ID 不能授权导入。
