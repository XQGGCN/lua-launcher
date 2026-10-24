# 数据包版本格式证据

2026-10-24新增的准确版本适配只来自对应版本的官方资料，不从相邻版本、`DataVersion`、实例名称或资源包格式推断。

| 准确游戏版本 | 已核数据包格式 | 字段处理 |
| --- | --- | --- |
| 1.20.1 | 15 | 只确认单个`pack_format`；带`supported_formats`范围的旧版安装仍保留未知 |
| 1.21.1 | 48 | 保留既有`pack_format`和`supported_formats`范围检查；未知特性/覆盖层/扩展仍未知 |

本轮真实获取[Mojang官方版本清单](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)，再核对清单声明的两个版本清单SHA-1，核对版本清单声明的客户端JAR大小和SHA-1，最后只读提取其中小于64KiB的`version.json`。提取结果分别为`id/name=1.20.1, pack_version.data=15`和`id/name=1.21.1, pack_version.data=48`。不使用`pack_version.resource`。

| 版本 | 官方版本清单及SHA-1 | 官方客户端JAR SHA-1 | 提取的version.json SHA-256 |
| --- | --- | --- | --- |
| 1.20.1 | [38d412af3b247e485c7f7e50ac25febc4e79ab1d](https://piston-meta.mojang.com/v1/packages/38d412af3b247e485c7f7e50ac25febc4e79ab1d/1.20.1.json) | [0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838](https://piston-data.mojang.com/v1/objects/0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838/client.jar) | `a86e0d9d5ce09e2c92b7bab808e3604fd88cc9098f15de9d07b7b96b374e0137` |
| 1.21.1 | [1757c8b1fbfc6b638504e1f6cceb05893f7389d5](https://piston-meta.mojang.com/v1/packages/1757c8b1fbfc6b638504e1f6cceb05893f7389d5/1.21.1.json) | [30c73b1c5da787909b2f73340419fdf13b9def88](https://piston-data.mojang.com/v1/objects/30c73b1c5da787909b2f73340419fdf13b9def88/client.jar) | `1dfc39c0408d868c95741e492dc19fca28d67268e4585b2c35430a9ee20c7299` |

[官方1.20.2发布说明](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-20-2)记录新增`supported_formats`。因此不能用该范围使旧版`pack_format`不匹配的文件通过1.20.1检查；本版对1.20.1带该字段保守返回未知。1.21.1采用既有范围代际，但格式数字本身由该准确版本官方JAR验证，不因1.21也是48而假设相同。

JAR共23,028,853和26,836,906字节，隔离检查后已删除；没有运行Java或游戏，没有读取用户世界，没有将游戏二进制或第三方数据包打入Lua源码/应用。完整本地下载校验及提取记录保存在忽略目录`.local/datapack-format-research-v0112.json`。这只是格式声明的匹配依据，不证明内容语义、模组环境、依赖或实际世界加载兼容；其他未准确核实的版本与快照保持未知。
