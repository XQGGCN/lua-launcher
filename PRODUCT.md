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

## Validation snapshot — 2026-10-21

47 deterministic tests pass: 30 authentication tests and 17 core tests. On macOS ARM64, Minecraft 1.20.1 Vanilla and 1.20.1 with Fabric Loader 0.19.5 have completed game initialization in explicit offline mode.

Real Microsoft account authentication and Windows / Linux gameplay remain unverified. Initialization success does not establish complete gameplay, saved-world or multiplayer compatibility. See [README.md](README.md#验证状态) for the public validation statement.
