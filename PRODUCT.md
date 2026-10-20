# Lua · 未央 — product scope

## Product direction

- Independent open-source Minecraft Java desktop launcher targeting Windows, macOS and Linux.
- Prioritize installation and launching. PCL and HMCL are feature references.
- Practical, compact, light desktop UI: concise navigation, aligned version rows, account and Java summaries, and a persistent launch action.
- Brand: Lua · 未央. Use independent names, artwork and interface assets.
- Source distribution through GitHub; an optional website can provide downloads and documentation.

## Implementation scope

Electron, React and TypeScript. Original UI and launcher integration; no copied PCL, HMCL or Modrinth implementation or brand assets.
First release is an alpha: modern Vanilla and Fabric, isolated instances, Java selection, progress, logs, account flow and Modrinth discovery. Broader feature parity is a roadmap, not a current claim.
Version 0.2.2 supports only authenticated Microsoft accounts for gameplay, with Minecraft Java entitlement and profile verification. Offline identities and their launch path have been removed.

## Validation snapshot — 2026-10-21

Current test coverage and results are recorded in [GitHub Actions](https://github.com/XQGGCN/lua-launcher/actions). Historical versions through 0.2.1 completed game initialization on macOS ARM64 for Minecraft 1.20.1 Vanilla and Fabric Loader 0.19.5 using their former offline mode. This does not establish successful authenticated gameplay in 0.2.2.

Microsoft device authorization and Xbox/XSTS authentication have passed, but the Minecraft login endpoint returns HTTP 403. Complete account login and Windows / Linux gameplay remain unverified. Initialization success does not establish complete gameplay, saved-world or multiplayer compatibility. See [README.md](README.md#验证状态) for the public validation statement.
