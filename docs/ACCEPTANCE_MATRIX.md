# 验收矩阵

更新：2026-10-21。发布基线为 0.3.0，0.4.0 本地实现、独立审查、最终构建及未签名 macOS ARM64 DMG/ZIP 完成；0.5.0 实例设置已在本地实现并完成浏览器验证。两版尚未发布，当前提交三平台 CI 与 0.5 原生验收待完成。L1 静态/类型、L2 确定性测试、L3 真实网络与文件、L4 真实桌面、L5 真实账户/游戏/联机分别记录；低一级结果不能代替高一级。

W=Windows x64，M=macOS ARM64，L=Linux x64。新架构单独列证据，官方有 Java 包不等于 Lua 安装包或游戏已支持。每次结果关联版本/commit、平台、命令/步骤和证据路径；私有日志与截图留在被忽略目录，不保存令牌。

## 0.3.0 已发布基线

| 条目 | 等级 / 平台 | 结果与边界 | 证据 |
| --- | --- | --- | --- |
| 确定性测试、生产构建与安装包 | L1/L2，W/M/L | 156 项测试及三平台工作流通过，不是三平台游玩实测 | [CI 39469214253](https://github.com/XQGGCN/lua-launcher/actions/runs/39469214253)，[Release](https://github.com/XQGGCN/lua-launcher/releases/tag/v0.3.0) |
| Forge 47.4.0 / MC 1.20.1 | L3，M/Java17 | 处理器及生成 JAR 校验通过，88 个 classpath 条目；未启动游戏 | [README 验证状态](../README.md#验证状态)，本地 loader-smoke 报告 |
| NeoForge 20.2.93 / MC 1.20.2 | L3，M/Java17 | 处理器及生成 JAR 校验通过，103 个 classpath 条目；未启动游戏 | 同上 |
| 两站性能优化分类 | L3 | 每站前 20 个结果标签符合查询；不覆盖全部类别/模组组合 | [研究记录](RESEARCH.md) |
| 官网与资源 | L3/L4 | 首页、CSS、SVG、截图 HTTP 200；原图一致，CDN 有图片压缩；页面已验收 | [官网](https://lua-launcher.onrender.com)，本地 website-verification-v030 记录 |
| 完整 Microsoft 登录与游戏 | L5 | 未通过，API 待审；批准前不继续真实流程 | [已知问题](KNOWN_ISSUES.md) |

上述结果不自动继承到 0.4.0/0.5.0，不复用旧 CI 作为新提交通过证据。

## 0.4.0 本地结果及剩余验收

集成者报告本地测试 201/201、最终 `pnpm check` 和 `pnpm build` 通过，未签名 macOS ARM64 DMG/ZIP 已生成。独立审查者另执行 8 项定向回归通过，并读取真实 smoke 报告、查看桌面任务截图。后两项只说明证据已复核，不表示独立重复了全部下载或桌面操作。命令、修复和证据来源见[审查记录](reviews/0.4.0.md)。

| ID | 场景与通过条件 | 等级 / 平台 | 当前状态 | 证据或计划位置 |
| --- | --- | --- | --- | --- |
| AC-JAVA-01 | 官方 index 及 macARM17/21/25 manifest 的 HTTP、size/SHA-1、条目、链接及许可 | L3，M | 本轮元数据已复核 | Mojang 官方 index，2026-10-21 研究记录 |
| AC-JAVA-02 | 无本机 Java 时精确组件/major/arch；文件 hash/size/执行权限，probe 成功才提交 | L2，W/M/L | 本地模块测试通过、源码独立复核；W/L 当前 CI 待验 | `desktop/java-runtime.test.ts` |
| AC-JAVA-03 | 拒绝越界、反斜线、设备名、大小写碰撞、非法祖先和链接逃逸；目录外无写入 | L2，W/M/L | 本地测试及独立源码审查通过；三平台 CI 待验 | runtime 路径 fixture |
| AC-JAVA-04 | 断流、HTML、截断、hash 错误、超大文件、非法跳转均不发布完成安装 | L2，W/M/L | 本地网络/边界 fixture 通过；三平台 CI 待验，不穷举真实断网条件 | runtime 网络 fixture |
| AC-JAVA-05 | 双订阅者去重；取消一者另一继续；全取消等待 worker/probe 退出后清理 | L2，W/M/L | 本地测试及独立源码审查通过；三平台 CI 待验 | deferred 流/probe 竞态测试 |
| AC-JAVA-06 | 提交前可取消，成功原子提交不误报取消；上层 UI 与实际文件一致 | L2，W/M/L | 两项提交竞态独立回归通过；上层不再将成功提交改报取消 | REVIEW-040-02、`java-runtime.test.ts` |
| AC-JAVA-07 | 重启 discover 校验 receipt、manifest、目录树、hash、probe；坏缓存不复用；旧目录不覆盖 | L2，W/M/L | 本地测试通过、源码独立复核；真实损坏修复见 AC-JAVA-09 | runtime 重建 manager 与修复测试 |
| AC-JAVA-08 | probe 路径正确；错误版本/架构/权限、超时/取消结束进程再清理；清除 Java 注入参数 | L2/L3，M；W/L CI | 本地测试及 macOS 真 probe 通过；Windows/Linux 实际 probe 待验 | probe 测试及真实 smoke |
| AC-JAVA-09 | 新目录真实下载 macARM17/21/25，完整校验、`-version`、无网复用和损坏修复 | L3，M | 实现者下载/probe 通过；独立读取报告确认 17/21/25 无网复用及 17 损坏修复，未运行游戏 | `.local/java-runtime-smoke/report.json`、`repair-report.json` |
| AC-JAVA-10 | 手动错误路径/major/arch报错且不自动替换；切自动保留手动值；匹配本机/托管可复用 | L2/L4，W/M/L | 本地 Core 测试通过；集成者 macOS 草稿切页/撤销实测通过；W/L 桌面待验 | `desktop/core-java.test.ts`、本轮桌面记录 |
| AC-JAVA-11 | 四加载器及本地/在线 `.mrpack` 统一准备；处理器前满足需求 | L2，代表样本L3/M | 统一入口已接线，本地相关测试通过；强制无本机 Java 的原版 1.20.1/Forge 47.4.0 实装通过；本轮 Fabric/Neo/包的真实自动准备组合未补齐 | Core/loader 测试、`.local/java-core-smoke/report.json` |
| AC-JAVA-12 | 旧 schema1 缺 component 可从可信官方元数据恢复；不下载错误 major、不放宽旧游戏范围 | L2，W/M/L | 本地 fixture 通过，源码独立复核；三平台 CI 待验 | `desktop/core-java.test.ts` |
| AC-UI-01 | 准备17/21/25、进度、取消、重试、失败/空状态；切页恢复，过期响应不覆盖新状态 | L2/L4，M；W/L实机另记 | 本地后台测试通过；macOS 17/21 真实准备、任务与列表通过；快照/草稿/过期错误修复已独立源码复核。全部错误操作及 W/L 桌面待补 | `.local/java-ui-v040-tasks.png`、UI-040-01–03 |
| AC-UI-02 | form 重试不提交、Dialog 标题/焦点、Tab/Esc/Enter、窄窗/200%缩放/长路径 | L4，M；W/L另记 | 相关源码修正已有；完整逐项桌面验收尚未补齐，不以单张截图证明全部通过 | 本轮 UI 步骤和截图 |
| AC-AUTH-01 | 凭据等待及 Java 准备期间取消、退出、换账户；禁止晚到 spawn，renderer 无 credential | L2，W/M/L | 本地相关测试通过；凭据阶段三项及迟到 Java 一项由独立审查者重跑通过；不涉及真实账户 | `launch-preparation.test.ts`、Core/auth/accounts 测试及 main/preload 审查 |
| AC-AUTH-02 | 自有应用完整授权、所有权/profile、刷新、重启、退出及撤销 | L5 | 外部阻塞，批准前不执行 | 接入说明，批准后独立记录 |
| AC-GAME-01 | 四加载器/代表包进入主菜单、临时世界保存再载入；受控联机另记 | L5，W/M/L | 外部阻塞，未验证 | 批准后每平台真实验收 |
| AC-RELEASE-01 | check/test/build及当前commit三平台CI；新测试确实纳入入口 | L1/L2，W/M/L | 本地 201/201 通过，入口已核对；最终 check/build 与本地 macOS ARM64 打包通过；当前提交三平台 CI 待验 | `package.json`、[开发日志](devlog/0.4.0.md)、本轮新 CI |
| AC-RELEASE-02 | 产物架构、版本、配置、打开；下载名称/大小/hash、非draft与全部asset | L3/L4，W/M/L | 0.4 本地未签名 macOS ARM64 DMG/ZIP 已生成；远端资产、三平台及完整包后实机验收待补 | 新Release/资产清单、实机记录 |
| AC-WEB-01 | 发布成功后更新现有站；service/commit/live、资源200、截图和说明一致 | L3/L4 | 待0.4发布后执行 | website、部署及HTTP/hash记录 |

## 0.5.0 本地结果及剩余验收

开发基准为本地 0.4.0 提交 `b3130280c338a7a8e4b9d26ec6eb6c92439e6ee7`，分支 `codex/instance-settings-v0.5.0`。晚修新增旧 `java` 迁移回归后，最终 245 项全量测试与生产构建通过；重新生成的未签名 macOS ARM64 DMG/ZIP 已核对 0.5.0 版本、ARM64 架构和 SHA-256。浏览器 UI 证据与原生 L4 分开记录。

| ID | 场景与通过条件 | 等级 / 平台 | 当前状态 | 证据或计划位置 |
| --- | --- | --- | --- | --- |
| AC-INSTANCE-01 | 名称只改显示；Java/内存/JVM/窗口按字段继承，空 argv 与 false 明确覆盖 | L1/L2；浏览器预览 | 配置/API smoke 和最终相关测试通过；实例保存及来源显示已有浏览器证据 | `instance-options.test.ts`、`core-instance-options.test.ts`；[开发日志](devlog/0.5.0.md) |
| AC-INSTANCE-02 | A/B 草稿分别保留，关闭/跨页可返回；保存锁按 ID，错误可重试；本机记住当前选择 | 浏览器交互；原生 L4 待验 | 切页草稿及保存后刷新通过；源码具备锁和迟到结果保护，全部原生竞态操作未穷举 | `.local/instance-ui-v050.png`；`src/App.tsx`、`InstanceSettings.tsx` |
| AC-INSTANCE-03 | 候选配置提交成功才生效；rename 失败保留旧值；运行/安装互斥 | L2 | 独立延迟 rename/EIO 注入通过；最终全量回归通过 | REVIEW-050-01；Core 实例测试 |
| AC-INSTANCE-04 | argv 保留空格/引号/Unicode/路径边界；拒绝堆、classpath、身份、入口等受管覆盖 | L2；浏览器预览 | 相关 fixture、API smoke、浏览器非法堆参数拒绝通过；真实游戏未执行 | 参数策略测试；`.local/instance-ui-v050.png` |
| AC-INSTANCE-05 | 6144 MB、1600×720、false 全屏与含空格属性保存后有效；首页摘要正确；全局 reset 清除旧覆盖 | L2；浏览器预览 | 浏览器保存/刷新摘要通过；全局 GC/含空格属性、1920 宽及全屏保存→恢复默认→保存/刷新实测通过，实例内存覆盖保持；实际游戏窗口待验 | `game-window.test.ts`；本轮浏览器记录 |
| AC-INSTANCE-06 | 首次安装状态保存失败释放锁；Windows 混合大小写 Java 注入变量从四入口清理 | L2，模拟故障/平台 | 首次 save 故障独立复核通过；游戏启动及处理器/probe 的环境变量定向回归独立通过，不作为 Windows 实机证据 | REVIEW-050-02/03；Core/loader/runtime 回归 |
| AC-INSTANCE-07 | 最终测试/build、当前提交三平台 CI、0.5 原生设置操作及安装包 | L1/L2；L3/L4 待验 | 最终 245/245、build 和未签名 macOS ARM64 DMG/ZIP 通过，包版本/架构/hash 已核对；0.5 原生因 Mac 锁屏未验，远端授权阻塞 CI/Release | `.local/tests-v050.log`、`.local/build-v050.log`、`.local/local-packages-v050.json`；当前提交新 CI 待恢复 |

0.5 没有新增真实账户或游戏验收，不改变 AC-AUTH-02 / AC-GAME-01 的外部阻塞状态。复制、导出、归档、删除、完整资源库存与旧版未实现，不能因基础设置页存在而标记全部实例管理完成。公开下载与官网仍指向已发布 0.3.0。

## 未来功能与发布门槛

新包格式至少一个允许使用的真实样本和故障 fixture；导入、备份、恢复验证目标与字节清单；NBT/图片/归档有资源限制；主题与导入配置不能执行任意代码；新联网能力明确来源、授权、隐私边界。

真实用户数据保护在副本上测试，不用唯一重要存档。独立审查覆盖代码、首次使用者、高级用户与相关安全边界；P0/P1 阻止发布，残余风险写清影响与临时方案。CI 不能替代缺失的实机、签名、公证或官方批准。
