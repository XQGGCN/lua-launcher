# Microsoft 登录接入

适用于 Lua · 未央维护者。核对日期：2026-10-22。

> **2026-10-22 更新**：维护者确认 Minecraft API 接入申请已通过审核，0.8.0 起正版登录对外开放。
>
> **2026-10-22 15:00 实测通过**：macOS ARM64 上使用内置 Client ID，设备代码在手机端 microsoft.com/link 完成授权，Lua 依次通过 Xbox、XSTS、Minecraft `login_with_xbox`、Java 所有权与档案检查，界面显示正版档案。此前的 403 已不再出现。游戏实际启动与刷新令牌恢复仍按第 4 节继续验证。下文保留审核前的历史记录。

项目已为 `Lua Launcher` 注册仅面向个人 Microsoft 账户的公共客户端，并启用设备授权流。公开的 Application (client) ID 为 `8e83a566-71f8-4164-9040-5cf61bb12740`，构建默认提供该标识。

**真实验证结果：**已成功取得设备代码，由账号本人完成 Microsoft 授权，Xbox / XSTS 验证通过；Minecraft `authentication/login_with_xbox` 返回 `403`，显示 `CLIENT_CONFIGURATION`。因此当前阻塞在 Minecraft 服务接入，不能把 Microsoft 网页授权完成称为 Minecraft 登录成功。未到达游戏许可、档案或会话保存步骤。自动化测试使用虚构 ID 和本地模拟响应，不能替代真实验收。**没有 Client ID 的自定义构建仍应显示“未配置”。**

发行版应由维护者注册并维护一个属于 Lua 的应用，把公开的 Client ID 随构建提供。普通玩家使用发行版时只需用自己的 Microsoft 账户授权，不需要逐人注册应用。高级设置中的自定义 ID 供开发者或自行构建的分发者使用。

## 1. 注册属于自己的应用

### 如果一开始就报没有目录、无权限或 AADSTS50020

先看错误中的租户名称。`AADSTS50020` 表示当前账户不属于目标租户，不等于密码错误。如果直接进入 Entra 时指向 `Microsoft Services`，不要把“请添加为外部用户”理解为需要申请加入微软内部租户。

- 已有 Azure / Microsoft 365 开发目录：在右上角切换到自己有权管理的目录，例如 `Default Directory`，再进入应用注册。仍无权限时，由该目录管理员授予合适的应用注册权限。
- 尚无可用目录：从 [Azure 免费账号入口](https://azure.microsoft.com/free/) 选择免费注册，用自己的 Microsoft 账户完成开通，再使用账号对应的默认目录。注册资格、身份验证和地区可用性由微软决定；手机、银行卡及协议确认应由账号本人在微软页面处理。
- 不要先尝试额外创建租户。微软当前说明：免费或试用客户不能从 Entra 管理中心创建额外 Workforce 租户；没有目录的用户可以走免费账号开通入口。注册 Lua 应用不需要部署虚拟机或购买 P1/P2。
- 免费入口要求的验证无法完成时，本仓库没有已验证的免验证替代途径。可以使用自己已有的合格目录或向微软支持确认；不要购买来历不明的租户、借用其他启动器的应用 ID。

依据：[AADSTS50020 排查](https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/app-integration/error-code-AADSTS50020-user-account-identity-provider-does-not-exist)、[新建目录的当前限制](https://learn.microsoft.com/en-us/entra/fundamentals/create-new-tenant)、[Azure 免费账号说明](https://azure.microsoft.com/free/)。账户免费试用和目录使用规则可能变化，以实际门户提示为准。

### 应用配置

1. 打开 [Microsoft Entra 管理中心](https://entra.microsoft.com/)，选择自己有权管理的目录。当前官方快速入门列出的前提包括有效 Azure 订阅、租户和至少 Application Developer 权限；如果门户不允许注册，先由目录管理员解决权限或租户条件。
2. 进入 **Entra ID → App registrations → New registration**，使用能清楚识别发行方的应用名，例如 `Lua Launcher`。
3. Supported account types 选择 **Personal accounts only**；若项目另有组织账户需求，也可选择包含 **Personal Microsoft accounts** 的选项。Lua 当前使用 `/consumers`，实际登录对象是个人 Microsoft 账户，不是学校或公司目录账户。
4. 完成注册，在 Overview 复制 **Application (client) ID**。不要复制 Object ID、Directory (tenant) ID 或任何密钥。

上述门户步骤与前提来自 [Microsoft 应用注册说明](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)。

5. 在应用的 **Authentication → Advanced settings** 中，把 **Allow public client flows** 设为 **Yes** 并保存。Lua 当前实现的是 device code 流程，该流程不需要 redirect URI；不要因为应用使用 Electron，就给此流程添加一个未实现的回调服务器。
6. 不创建或填写 Client Secret。桌面程序是公共客户端，无法可靠隐藏应用密钥；Lua 只接受公开的 UUID 形式 Client ID。

公共客户端开关与 device code 无需回调地址的说明见 [Microsoft 桌面应用配置](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration)。

## 2. 确认 Minecraft 服务接入资格

Microsoft 应用注册、用户 OAuth 授权和 Minecraft 服务允许此应用访问，是需要分别验证的环节。能拿到设备代码，或 Microsoft 网页显示授权完成，都不能证明后续 Minecraft 登录成功。向 Microsoft Graph 添加 `User.Read` 等权限也不能替代 Minecraft 服务接入。

请由维护者打开 Minecraft 官方的 [Java Edition Game Service API Review or Application Process](https://help.minecraft.net/hc/en-us/articles/16254801392141)，按该页面当时提供的流程申请或核实自己的应用资格，并保留官方回复。应用资料应如实指向 [Lua 源码仓库](https://github.com/XQGGCN/lua-launcher) 和实际的登录行为；审核要求、处理时间和通过结果由官方决定。

**当前官方入口已核验：**在浏览器打开上述官方文档可以读到正文，文档说明新应用需要人工审核并加入允许列表，提供的申请入口是 [Minecraft API application review](https://aka.ms/mce-reviewappid)。这与 Azure 应用注册是独立环节；提交申请、处理时间和批准均不能由 Lua 保证。请以表单当时的字段和提示为准，不能把第三方文章里的其他开发者计划当作替代审批流程。

2026-10-21 实际表单 `AppID Review` 要求：

- 申请人确认已阅读并理解 EULA 和 Usage Guidelines。
- 提供可与 Azure 门户信息核对的联系邮箱、应用显示名称、Application ID、Tenant ID、项目网址及用途说明。
- 应用应在允许游玩前认证用户并验证游戏所有权；绕过或停用认证、所有权、许可检查或其他安全措施的应用不予批准，服务器配置不改变该要求。
- 应用名不能包含表单列出的官方品牌或其他保留名称；`Lua Launcher` 不使用这些名称。
- 表单说明按周审核；重复提交不会加快处理。

申请前必须核对代码的真实行为，不能把仅验证了 Microsoft 授权的实现描述为已经完成所有权验证。0.2.2 已改为纯在线账户版：移除离线名字入口、IPC 和启动内核分支，忽略旧离线账户文件，只有完成完整认证、所有权和档案验证的会话才能提供启动凭据。认证失败不会自动切换身份。旧版本的历史行为应保留说明，不能将旧版离线运行实测当作当前在线启动验收。

申请人已于 2026-10-21 提交，浏览器已显示 Mojang Studios 的成功回执；当前等待审核、尚未获批。纯在线实现也不保证审核通过；如后续实际功能发生变化，应同步更新项目说明并向官方确认适用要求。

如果 Minecraft 登录接口返回 `403`，Lua 会显示 `CLIENT_CONFIGURATION`，提示检查应用注册与服务接入资格。不要借用官方启动器、PCL、HMCL 或其他应用的 Client ID 来规避失败。

### 申请用途说明参考

以下文字描述 0.2.2 的实现，已用于准备申请表。最终联系邮箱、协议声明和提交由申请人本人完成；该说明不代表审批结果。

> Lua Launcher is an independent, open-source desktop launcher for Minecraft Java Edition on Windows, macOS, and Linux. It manages isolated game instances, downloads official game files, and installs supported Fabric mods and Modrinth-format modpacks.
>
> Version 0.2.2 requires Microsoft authentication through our own registered public client, followed by Xbox/XSTS authentication, Minecraft authentication, Java entitlement verification, and a valid Minecraft profile before providing launch credentials. It has no offline-account launch option or authentication-failure fallback. Earlier alpha versions offered offline identities; that functionality has been removed from the current code and build.
>
> Minecraft access tokens are held only in the main process and may be reused while valid. Refresh sessions are encrypted with the operating system's secure storage. Restarting the launcher or refreshing an expired access token requires online authentication and renewed entitlement/profile checks. Logout or an explicit authentication, ownership, or profile revocation clears the stored session.
>
> We request access to complete real-account integration testing and enable this authenticated launch flow. Microsoft device authorization and Xbox/XSTS authentication have succeeded, but Minecraft's login endpoint currently returns HTTP 403. We have not yet completed end-to-end Minecraft account validation or received API approval. Source code: https://github.com/XQGGCN/lua-launcher

## 3. 配置开发版与发行版

Client ID 是公开的应用标识，可以随桌面构建分发。它不是账户密码、Client Secret、OAuth token 或 GitHub token。不要把这些秘密填入 Client ID 设置或提交到仓库。

发行版构建使用环境变量 `LUA_MICROSOFT_CLIENT_ID`。例如，在 macOS/Linux 终端使用自己的实际 UUID：

```sh
LUA_MICROSOFT_CLIENT_ID='<自己的 Application (client) ID>' pnpm build
```

Windows PowerShell：

```powershell
$env:LUA_MICROSOFT_CLIENT_ID = '<自己的 Application (client) ID>'
pnpm build
```

开发运行可使用同名环境变量；修改后重新启动开发进程。编译进发行版的 ID 应来自维护者自己的注册，并在发布前完成第 4 节的实测。

仓库的 GitHub Actions 已接入同名 **Repository variable**：在仓库 **Settings → Secrets and variables → Actions → Variables** 中新增 `LUA_MICROSOFT_CLIENT_ID`，值填自己的公开 Client ID，再运行构建。该标识无需作为秘密保存；留空则使用 `scripts/build-desktop.mjs` 中 Lua 自己的公开默认 ID。独立分发的 fork 应注册自己的应用并替换该默认值或提供构建覆盖。

高级设置可以一次保存自定义 ID，重启后继续使用。配置顺序为：**已保存的 custom → 构建/开发时提供的 built-in → none**。保存空值会清除自定义覆盖并回退到内置值；如果没有内置值，恢复未配置状态。保存有效格式只表示配置存在，不能表示已审核或已登录。

更换应用 ID 不会替换已有会话的所属应用：已有 refresh token 必须继续配合它最初的 Client ID 使用。需要切换登录应用时，退出当前账户并重新登录。

## 4. 用真实账户验收

在每个计划发布的平台，使用拥有有效 Minecraft Java 版许可且已经设置 Java 档案的个人 Microsoft 账户执行：

1. 从未配置状态启动，确认不会伪装为登录就绪。提供有效 Client ID，重启，确认配置来源和值恢复。
2. 主动点击登录。出现当前会话的用户代码、Microsoft 官方验证页面和到期提示；只在该页面输入账户密码或验证码，Lua 不接收这些内容。
3. 在 Microsoft 页面确认应用名称确实属于自己的 Lua 注册，再完成授权。Lua 应依次显示获取代码、等待授权、Xbox 验证、Minecraft 验证、许可与档案检查、安全保存、完成。
4. 只有流程全部成功后才出现 Java 用户名和账户状态。接着实际启动一个游戏实例，核验进入游戏与需要身份认证的正常使用场景。未登录时不能启动；旧版本的离线账户文件不应恢复成可用身份。
5. 关闭并重开 Lua，确认账户能恢复。再次启动游戏验证 refresh token 换取新凭据，而非只显示缓存的用户名。
6. 验证拒绝授权、取消、代码到期、断网与服务失败不会显示“登录完成”。若有可用的无许可测试账户，应看到许可错误，不能自动降为离线身份。
7. 退出账户并重启，确认已保存会话删除、后续启动要求重新登录。若启动准备期间退出账户，Java 游戏进程不应继续启动。

当前实现按微软响应的 `interval` 轮询，处理等待与减速响应，遵守 `expires_in`，仅在用户主动请求后获取设备代码；协议依据是 [Microsoft device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)。真实使用还取决于账户资格、Xbox 档案/家庭设置、服务权限及网络。代码通过模拟测试不能代替这一轮实测。

## 常见结果

| Lua 错误码 | 检查方向 |
|---|---|
| `INVALID_CLIENT_ID` | 是否填入 Application (client) ID；格式应是非空 UUID |
| `CLIENT_CONFIGURATION` | 个人账户支持、公共客户端开关、应用注册和 Minecraft 服务资格 |
| `AUTHORIZATION_DECLINED` / `DEVICE_CODE_EXPIRED` | 重新主动发起登录，使用新代码 |
| `NO_XBOX_PROFILE` / `XBOX_ACCOUNT_RESTRICTED` | 在 Xbox 官方站点完成档案、年龄或家庭设置 |
| `NO_MINECRAFT_OWNERSHIP` / `MINECRAFT_PROFILE_MISSING` | 正确的购买/订阅账户及 Java 档案 |
| `SESSION_EXPIRED` | 已存授权失效，需要重新登录 |
| `STORAGE_UNAVAILABLE` | 系统安全凭据存储或本地配置文件问题；不会降级明文存储 |
| `NETWORK_ERROR` / `TIMEOUT` / `RATE_LIMITED` | 网络或临时服务问题，按提示稍后重试 |

报告问题时提供平台、Lua 版本、出错阶段和上表错误码即可。不要附密码、设备代码、token、会话文件或含完整启动参数的日志。

## 主进程接口与存储约定

- `AuthConfigStore(rootDir, builtInClientId = '')` 提供异步 `status()` 和 `saveClientId(value)`。返回 `{ configured, clientId, source: 'built-in' | 'custom' | 'none' }`；文件 `microsoft-config.json` 只保存公开的自定义 Client ID，写入使用临时文件与原子替换。
- `AuthManager` 的 `onStatus?: (status: { stage, message }) => void | Promise<void>` 是尽力投递的通知，阶段文案在本地生成。通知接收方异常不会把已经保存的登录误报为失败。刷新流程仅报告实际经过的 Xbox、Minecraft、许可、安全保存和完成阶段。
- `begin()`、`account()` 只返回 `{ username, uuid, mode: 'microsoft' }`。设备代码回调只包含用户代码、验证 URL、到期时间。完整凭据、服务响应、refresh token 和私有 device code 不得通过 IPC 暴露。
- `credentials()` 仅供主进程启动 Java，增加 `clientId`，以及 XSTS 实际返回且格式有效时的 `xuid`。XUID 只留内存；缺失时不以 user hash 冒充。Xbox 官方说明不同 relying party 未必返回全部 display claims，参见 [Xbox title service authentication](https://learn.microsoft.com/en-us/gaming/gdk/docs/services/fundamentals/s2s-auth-calls/s2s-calls/live-title-service-calls-xbox-live)。
- `microsoft-session.json` 保存由系统安全存储加密的刷新会话，访问令牌仅在内存。提交之前允许取消；开始原子替换后普通取消不把已保存会话报告成失败。退出登录仍会删除已经开始提交的会话。
- `AccountCoordinator` 仅协调 Microsoft 账户，不再接收离线身份或读取旧离线设置。启动取得凭据和创建 Java 游戏进程前均检查账户代次，避免退出或换号后继续使用旧凭据。
- 有效期内的 Minecraft 访问令牌可在同一进程内复用；重启或到期后需在线刷新，并重新检查游戏许可和档案。刷新明确返回授权失效、无许可或档案缺失时撤销已保存会话；临时网络错误只阻止本次启动，不伪造身份，也不把网络中断当作账户被撤销。

自动化验证命令：

```sh
node --import tsx --test desktop/auth.test.ts desktop/auth-config.test.ts
```

另运行 `pnpm test` 检查账户并发、启动和安装流程；当前各平台结果见 [GitHub Actions](https://github.com/XQGGCN/lua-launcher/actions)。设备授权和 Xbox / XSTS 已实测；Minecraft 登录仍被 `403` 阻塞，完整登录及应用审核不能标记为已验证。
