# Lua · 未央 — roadmap

Lua 0.1 is an alpha launcher, not a PCL / HMCL feature-complete replacement.

## 0.1 scope

- Modern Vanilla / Fabric, isolated instances and verified downloads.
- Java discovery and launch settings.
- Real launch lifecycle and logs.
- Modrinth search and compatible Fabric mod installation.
- Microsoft authentication implementation using a separately registered client.
- Original practical, compact, light desktop UI informed by PCL / HMCL.

## Verified alpha baseline — 2026-10-21

47 deterministic tests pass: 30 authentication tests and 17 core tests. Minecraft 1.20.1 Vanilla and 1.20.1 + Fabric Loader 0.19.5 complete game initialization on macOS ARM64 in explicit offline mode.

Real Microsoft account authentication and Windows / Linux gameplay are not yet verified. This baseline does not establish complete gameplay or compatibility across other versions and architectures.

## Before a stable release

1. Register and validate the project's own Microsoft application with the necessary upstream access.
2. Perform Windows x64, Linux x64 and macOS x64 game-start smoke tests; expand the macOS ARM64 baseline to additional versions, saved worlds and multiplayer.
3. Install and select the appropriate Java runtime automatically.
4. Add mod inventory, enable/disable/uninstall/update and conflict diagnostics.
5. Add instance import/export and Modrinth `.mrpack` validation.
6. Add signed builds, macOS notarization and verified updater delivery.
7. Improve interrupted-download resumption beyond whole-file cache reuse.

## Later

Forge / NeoForge / Quilt, older Minecraft versions, skins, richer crash analysis,
multiple accounts, language packs and launcher migration.

Priorities follow reproducible installation and game-start failures before adding cosmetic features.
