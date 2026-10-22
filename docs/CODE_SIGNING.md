# Windows 代码签名

更新：2026-10-22。

没有签名的安装程序在 Windows 上会显示「Windows 已保护你的电脑 / 未知发布者」。这只是信誉提示，点「更多信息 → 仍要运行」即可安装。签名可以显示发布者名称，并逐步积累 SmartScreen 信誉。

## 免费方案对比

| 方案 | 费用 | 证书上显示的发布者 | 需要做的事 | 适合 |
| --- | --- | --- | --- | --- |
| **SignPath Foundation 开源签名**（推荐先申请） | 免费 | SignPath Foundation（说明此程序由该开源仓库构建） | 在 [signpath.org/apply](https://signpath.org/apply) 申请；满足下方条件；CI 已预留接入 | GitHub Release 的 .exe 安装包 |
| **Microsoft Store 上架** | 个人开发者注册免费（需身份证件 + 自拍验证） | 由 Microsoft 签名 MSIX 包 | 在 Partner Center 注册应用，填 3 个仓库变量，CI 生成 .appx 后在 Partner Center 提交审核 | 从商店安装、自动更新；是否接受第三方 Minecraft 启动器以商店审核为准 |
| 自签名证书 | 免费 | 自己的名字 | — | **无效**：Windows 不信任，仍会警告 |
| Azure Artifact Signing / OV 证书 | 每月或每年付费 | 你的姓名或组织 | 身份验证 | 以后需要个人名义签名时 |

提示：自 2024 年起 EV 证书也不再自动获得 SmartScreen 信誉，任何新证书都需要一段时间积累下载量。

## 方案一：SignPath Foundation（免费）

### 申请条件（摘自 [SignPath Foundation 条款](https://signpath.org/terms)）

- [x] 全部代码使用 OSI 认可的开源许可证（Lua 使用 MIT），没有专有组件。
- [x] 项目在持续维护，并已经以要签名的形式发布过（GitHub Releases）。
- [x] 下载页说明了软件功能（官网与 README）。
- [x] 不包含恶意软件、不绕过安全措施；有卸载方式（NSIS 卸载程序）。
- [x] 有隐私政策：[docs/PRIVACY.md](PRIVACY.md)，并可在设置中关闭更新检查、改用官方下载源。
- [ ] 维护者在 GitHub 和 SignPath 都开启**双重验证（MFA）**。
- [ ] 在官网首页和下载页加上「代码签名政策 / Code signing policy」，内容见下方模板（获批后再发布）。
- [ ] 每个版本由审批人在 SignPath 手动批准签名请求。

### 获批后的配置

1. 在 SignPath 组织中添加预置的 **GitHub.com Trusted Build System**，并关联到项目。
2. 创建项目（slug 建议 `lua-launcher`）和签名策略（建议 `release-signing`）。Artifact Configuration 的根节点为 `<zip-file>`，其中签名 `*.exe`（PE 文件），并强制产品名称为 `Lua`、产品版本与 `package.json` 一致。
3. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加：
   - Secret `SIGNPATH_API_TOKEN`
   - Variable `SIGNPATH_ORGANIZATION_ID`
   - 可选 Variable `SIGNPATH_PROJECT_SLUG`、`SIGNPATH_SIGNING_POLICY_SLUG`（不填时为 `lua-launcher`、`release-signing`）
4. 之后每次 CI 在 Windows 上打包完成，都会把安装程序提交给 SignPath，等审批人批准后取回签名版并放进 Release。没有设置 Secret 时这些步骤会自动跳过。

### 代码签名政策模板（获批后放到官网首页和下载页）

> **代码签名政策 / Code signing policy**
>
> Windows 版本的免费代码签名由 [SignPath.io](https://about.signpath.io/) 提供，证书由 [SignPath Foundation](https://signpath.org/) 颁发。
>
> - 作者（Committers & reviewers）：[XQGGCN](https://github.com/XQGGCN)
> - 审批人（Approvers）：[XQGGCN](https://github.com/XQGGCN)
>
> 只有本仓库源码经 GitHub Actions 构建的安装程序才会被签名。隐私政策见 [docs/PRIVACY.md](https://github.com/XQGGCN/lua-launcher/blob/main/docs/PRIVACY.md)：本程序不会向 Lua 自己的服务器传输任何数据，只在你操作时连接列出的 Minecraft、模组站与 GitHub 服务。

## 方案二：Microsoft Store（免费注册，Microsoft 签名）

1. 用个人 Microsoft 账户在 [Partner Center](https://partner.microsoft.com/dashboard) 注册个人开发者（免费，需身份验证），预留应用名称。
2. 在应用的 **Product identity** 页面复制 `Package/Identity/Name`、`Package/Identity/Publisher`、`Publisher display name`。
3. 在 GitHub 仓库添加 Variables：`MSSTORE_IDENTITY_NAME`、`MSSTORE_PUBLISHER`、`MSSTORE_PUBLISHER_DISPLAY_NAME`。
4. 之后 CI 在 Windows 上会额外生成 `.appx`，作为构建产物 `msstore-appx` 保存 30 天；下载后在 Partner Center 提交。商店审核通过后由 Microsoft 签名分发。

依据：[Microsoft 宣布个人开发者免费注册](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)。
