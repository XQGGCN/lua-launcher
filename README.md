# Lua · 未央

一个面向 Windows、macOS 和 Linux 的独立 Minecraft Java 启动器。采用参考 PCL / HMCL 的实用、紧凑浅色桌面布局，把账户、版本、Java 与启动操作放在清晰的位置；集成 Modrinth 与 BBSMC 资源搜索，使用原创实现与独立品牌。

**当前版本：0.4.0 Alpha，纯在线账户版。** 在原版、Fabric、Forge / NeoForge、独立实例和资源安装的基础上，新增官方 Java 自动下载、校验与安装，保留手动路径及自动内存设置。启动游戏需要完成 Microsoft 登录、Minecraft Java 所有权和档案验证。Minecraft 服务接入目前仍返回 `403`，因此新用户暂时无法完成登录并启动游戏。BBSMC 接入为实验性，尚未达到 PCL / HMCL 的完整功能覆盖。

## 验证状态

截至 2026-10-21：

- **0.4.0 本地 201 项确定性测试通过**：新增 Java 下载与发现、全新目录接线、共享取消、原子提交、旧记录恢复和启动取消测试；原有测试继续覆盖认证与配置、账户并发、启动内核、Forge / NeoForge 安装器、自动内存、模组分类、整合包事务、文件选择及资源站隔离。Windows、Linux、macOS 的测试与安装包构建结果以对应提交的 [GitHub Actions](https://github.com/XQGGCN/lua-launcher/actions) 为准；本地通过不等于三平台 CI 已成功。模拟网络测试也不代表真实账户登录或游戏运行已经通过。
- **0.4.0 Java 实测**：macOS ARM64 的官方 Java 17.0.15、21.0.7、25.0.1 均完成真实下载、完整文件校验与 `java -version` 探测；重建管理器后关闭网络仍能复用。损坏运行时被识别并重新安装，旧目录与其他版本保留。
- **0.4.0 自动 Java 核心集成实测**：在隔离目录中强制关闭系统 Java 探测，完成 Minecraft 1.20.1 原版安装，并使用新托管 Java 17 完成 Forge 47.4.0 的 5 个 JVM 处理器及产物校验。没有登录账户或启动游戏。
- **0.3.0 加载器安装实测**：macOS ARM64、本机 Java 17 下，Minecraft 1.20.1 + Forge 47.4.0，以及 Minecraft 1.20.2 + NeoForge 20.2.93 均完成核心完整安装流程，安装器处理步骤（processors）执行成功，生成 JAR 校验通过。验证范围是安装流水线，没有验证这两个实例进入游戏、存档或联机。
- **0.3.0 分类实测**：Modrinth 与 BBSMC 的“性能优化”真实搜索各检查前 20 项结果，分类标签均与对应来源条件匹配。此结果验证分类查询，没有验证全部类别或结果中的模组组合。
- **历史 macOS ARM64 实测（0.2.1 及之前）**：Minecraft 1.20.1 原版，以及 1.20.1 + Fabric Loader 0.19.5，曾在当时的离线模式下完成游戏初始化。0.2.2 已移除此路径，这些结果不等于当前纯在线版启动验收通过。
- **历史 0.2 整合包实测**：在线安装及桌面本地导入 Fabulously Optimized 5.4.1（Minecraft 1.20.1 / Fabric 0.14.23），校验并安装 48 个模组；曾从桌面离线启动后进入主循环。此包仅作为验证样例，不随 Lua 分发；当前版本的正版启动仍待服务接入后验证。
- **0.2.1 BBSMC 实测**：匿名搜索与 Fabric API 兼容版本查询正常；当前网络的 CDN 下载返回 HTML 安全验证页，安装器正确拒绝，未安装不完整文件。BBSMC 完整下载与游戏运行尚未验证成功；本地模拟测试已覆盖可下载文件的安装事务。
- **Microsoft 实测**：账号本人授权后，Microsoft 与 Xbox / XSTS 步骤通过，但 Minecraft 登录接口返回 `403`。当前仍需解决 Lua 应用的 Minecraft 服务接入资格；没有保存不完整会话，也没有显示登录成功。
- **尚未验证**：Microsoft 真实账号完整登录，当前纯在线版本及新增 Forge / NeoForge 的完整游戏运行，Windows / Linux 实机游戏，以及其他系统架构和版本的兼容性。安装成功或历史游戏初始化通过不代表长期游玩、存档或联机已全面测试。

## 已实现

- 独立实例：各自的游戏目录、存档与模组，共享校验后的基础资源。
- Minecraft 正式版本列表，现代版本（1.20.1 起）的下载与 SHA-1 校验。
- Fabric / Forge / NeoForge 安装，选择对应的加载器版本；Forge / NeoForge 在本机 Java 下运行官方安装器中的处理步骤并校验产物。
- 选择 Minecraft 与加载器后直接下载；任务页展示进度、取消、重试与已完成文件复用。
- Modrinth / BBSMC 整合包在线搜索、版本选择和下载；本地 `.mrpack` 导入前预览名称、版本、加载器与文件大小。
- 整合包固定加载器版本、验证 SHA-1 与 SHA-512、应用客户端配置；取消或失败后可从任务页重试，完整安装成功才标记为可启动。
- Java 自动探测、官方运行时自动下载与安装、手动路径；切换自动模式会保留手动路径。设置页可提前下载 Java 17 / 21 / 25，任务页显示实际进度、取消与重试。
- 自动 / 手动内存与并发设置；启动前重新计算内存分配。
- 游戏启动、关闭、状态跟踪与实时日志。
- Microsoft 设备码认证、授权进度和倒计时、取消、许可与档案检查、刷新令牌安全存储；**已注册 Lua 自己的客户端 ID，Microsoft / Xbox 实测通过，Minecraft 服务接入仍被 `403` 阻塞**。
- 仅支持经过完整验证的 Microsoft 账户启动；没有离线入口、离线 IPC 或登录失败后的离线回退。旧版本的离线账户文件不会被加载。
- Modrinth / BBSMC 实时搜索；根据实例的游戏版本与加载器匹配模组，下载同一来源的必需依赖。
- 模组页提供 19 个功能分类，分类、关键字、游戏版本及加载器条件共同生效，自动映射各资源来源的分类值。

## 0.3.0 模组功能分类

0.3.0 的分类筛选包含性能优化、世界生成、冒险探索、科技、魔法等 **19 个 Modrinth 官方模组类别**。搜索请求使用原站分类条件：Modrinth 使用英文键，BBSMC 使用对应的中文分类值；分类会与关键字、游戏版本及加载器条件共同生效。

分类定义、来源映射和筛选界面均已实现，两站的“性能优化”真实查询已完成上述抽样验证。分类反映资源站的项目标签，不会自动分析某个模组的全部功能，也不表示结果一定适合所有实例。

## 自动内存

默认采用自动分配。主进程读取系统总内存，优先使用 `process.availableMemory()` 返回的当前可用内存，在运行时和平台支持的范围内考虑可回收内存及进程限制；无此 API 时回退到 `os.freemem()`。不同平台的统计口径可能不同，这些值是启动前的快照。

建议值结合游戏版本、是否使用模组加载器和所选 Java 的位数，并为操作系统、Java 非堆内存及其他程序保留余量。现代原版以 4 GB、模组环境以 6 GB 为起始建议，实际分配可能因内存压力下调；这不是 Mojang 最低配置，也不能代替大型整合包自己的要求。

手动模式会保留你填写的偏好值，但本次启动仍受当前安全上限约束，不会直接把全部内存交给 Java。低于最低 1 GB 堆预算时拒绝启动并提示释放内存；32 位 Java 的堆限制为 1 GB。界面的建议值会在启动时重新计算，不能保证游戏过程中不会发生内存不足。

## 本地运行

准备 Node.js 22.12+ 和 pnpm 11.25，然后：

```sh
pnpm install
pnpm desktop
```

Java 自动管理会读取每个游戏的官方 `javaVersion.majorVersion` 与 `component`，优先使用匹配的本机或托管 Java，缺失时下载 Mojang 运行时。以实际版本清单为准，例如 1.20.1 需要 17、1.20.5 需要 21、26.3 需要 25。可在设置中提前准备 17 / 21 / 25，或选择自己的 Java 可执行文件。

运行时保存在 `launcher/runtimes/`，不改系统 PATH 或 JAVA_HOME。下载验证清单和每个文件的大小及 SHA-1，完成权限准备、版本与架构探测后才提交。Linux ARM64 等官方未提供的组合会明确提示手动选择，不会偷偷换架构。下载页任务记录限当前进程；重启后复核并复用已安装运行时，尚不提供字节级续传。

```sh
pnpm dev       # 浏览器 UI 预览，不能启动 Java
pnpm check     # TypeScript
pnpm test      # 使用模拟服务的确定性测试
pnpm build     # 前端 + Electron
pnpm package   # 当前系统未打包目录
pnpm dist      # 当前系统安装包
```

浏览器预览与桌面版有明确区分。预览实例仅保存在浏览器中，不会被当作已安装游戏。

## Microsoft 登录

当前构建默认内置 Lua 自己注册的公开 Microsoft 应用 ID，已实测完成 Microsoft 授权与 Xbox 验证，但 Minecraft 登录返回 `403`，暂不能完成正版账号登录。普通玩家无需注册应用，服务接入由维护者处理。维护者或独立 fork 请参阅 [完整接入步骤](docs/MICROSOFT_LOGIN.md)，可通过 `LUA_MICROSOFT_CLIENT_ID` 覆盖构建配置。开发者也可在账户页高级设置保存自己的 **Client ID**；不要填写 Client Secret。

登录在 Microsoft 官方页面完成，Lua 不收集 Microsoft 密码。访问令牌仅在 Electron 主进程内存中处理；刷新信息通过系统安全存储加密后写入应用目录。系统密钥环不可用时拒绝持久化，不降级为明文。

启动时由主进程取得有效 Minecraft 凭据；同一进程可复用尚未到期的访问令牌，需要刷新时重新完成认证、许可与档案检查。重启后必须在线刷新，不能仅凭缓存的用户名启动。退出账户或服务明确报告授权、所有权或档案失效时，会清除对应会话并要求重新登录。网络失败不会生成临时身份。

从旧版本升级不会删除游戏实例或存档；旧 `offline-account.json` 不再读取。当前申请已于 2026-10-21 提交，状态为**等待审核、尚未获批**，修改账户规则不能代替 Minecraft 官方审核。

## 整合包

在“整合包”页面选择 Modrinth 或 BBSMC 并搜索项目、选择发布版本，或导入本地 `.mrpack`。当前支持 Minecraft 1.20.1 及之后的正式版和原版 / Fabric / Forge / NeoForge；具体加载器必须有对应游戏版本的官方发布，包中声明的加载器版本会固定使用。客户端标记为 optional 的文件会一并安装，server-only 文件跳过。

Quilt、旧游戏版本和 CurseForge 格式会给出明确的不兼容提示。`.zip` 只有包含 Modrinth 标准清单才可导入。每个包创建独立实例，配置覆盖不会写入其他实例；失败后保留包源，可在“下载任务”中重试。新增 Forge / NeoForge 的安装流程已做上述代表性版本实测，完整整合包和游戏运行矩阵仍待补齐。

## BBSMC 接入

[BBSMC](https://bbsmc.net) 提供可匿名读取的 `https://api.bbsmc.net/v2` 接口，搜索与项目版本字段兼容 Modrinth v2。Lua 独立调用公开 HTTP 接口，没有复制站点源码，也不是 BBSMC 官方客户端。官方实现见 [bbsmc/app](https://github.com/bbsmc/app)。

- 模组和整合包页面可切换来源；搜索、版本选择、依赖解析与安装记录分别使用所属来源，不会因项目 ID 相同而混用。
- BBSMC 直接安装仅接受其 `cdn.bbsmc.net` 上具有有效 SHA-1 / SHA-512 的 `.jar` 或 `.mrpack`，下载后校验文件；包内文件仍受路径、来源域名、大小和哈希限制。
- 网盘、外部站点链接、没有校验值的占位发布，以及不支持的格式显示“官网获取”。`401` / `403` 提示前往官网处理访问权限；不登录 BBSMC 账户、不绕过购买或资源访问限制。
- CDN 返回网页安全验证时也会拒绝安装，并提示前往官网；不能将搜索 API 可用等同于文件下载畅通。
- 当前接入为实验性，未承诺公开 API 的长期兼容或站点可用性。仅在用户搜索、选版本或安装时请求，不进行整站采集。接口限流或不可用时显示错误，由用户稍后重试。

## 获取构建

软件免费公开下载，源码采用 MIT 许可。打开 [GitHub Releases](https://github.com/XQGGCN/lua-launcher/releases)，在 Assets 获取已完成发布的平台安装包；各平台构建与发布状态以 [GitHub Actions](https://github.com/XQGGCN/lua-launcher/actions) 和 Release 实际附件为准。构建尚未代码签名或公证，仍属于 Alpha 测试版。

Lua 安装包不捆绑 Minecraft 游戏、模组或整合包；安装时从对应发布来源下载。Java 可按需从官方自动下载，也可自行安装；Minecraft Java 游戏许可需要由玩家持有。

## 数据与隐私

默认数据位于系统的 Lua 应用数据目录下 `launcher/`，实例存档在 `instances/<id>/game/`。不会自动扫描或修改其他启动器的游戏目录。没有分析统计、广告或账号遥测。

下载和搜索会连接 Mojang / Microsoft、Fabric、Forge / NeoForge，以及所选来源 Modrinth / BBSMC 的官方服务。资源信息与图标来自对应站点 API，版权归各项目作者；不随仓库重新分发这些素材。

## 兼容性与限制

- 跨平台架构及打包配置已提供；实际验证范围见上方“验证状态”，Windows / Linux 游戏运行仍待测试。
- 旧版 Minecraft、快照、Quilt、CurseForge 包、整合包导出、皮肤管理、自动更新尚未实现。
- Forge / NeoForge 只完成有限版本的真实安装验收，不能据此承诺所有加载器版本、模组组合或系统均可正常游玩。
- 模组更新、卸载和冲突分析尚未实现。Alpha 阶段建议新建测试实例。
- 安装包尚未做 Windows 代码签名或 macOS 公证。开发者需要自行配置签名后正式分发。
- Lua 与 Minecraft、Mojang、Microsoft、PCL、HMCL、Modrinth、BBSMC 均无官方关联。

## 开发

```text
src/                React UI 与受限的桌面 API 客户端
desktop/core.ts     安装、平台规则、Java、启动与资源来源
desktop/loader.ts   Forge / NeoForge 元数据、安装器与产物校验
desktop/memory.ts   系统内存采样、自动建议与启动堆限额
desktop/java-runtime.ts 官方 Java 下载、校验、发现与共享任务
desktop/launch-preparation.ts 凭据获取之前的启动取消与退出保护
desktop/auth.ts     Microsoft → Xbox → Minecraft 认证
desktop/modpack.ts  Modrinth 包格式、路径与归档校验
desktop/main.ts     Electron 生命周期、IPC 与系统安全存储
desktop/preload.ts  隔离的命令桥
src/mod-categories.ts 模组功能分类及资源来源映射
docs/RESEARCH.md    功能参照与源码许可研究
```

Electron 禁用 renderer Node 集成、启用 context isolation / sandbox、验证 IPC 来源并限定命令。下载仅允许指定官方域名，验证校验值并拒绝路径穿越。测试使用临时目录与模拟网络响应，不依赖个人账号。

原创代码采用 [MIT](LICENSE) 许可。依赖保留各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。贡献请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

每个小版本的变更见 [CHANGELOG](CHANGELOG.md)，详细开发日志见 [docs/devlog](docs/devlog)，独立审查见 [docs/reviews](docs/reviews)。完整需求与状态见 [功能矩阵](docs/FEATURE_MATRIX.md)，每个验证等级的边界见 [验收矩阵](docs/ACCEPTANCE_MATRIX.md)。
