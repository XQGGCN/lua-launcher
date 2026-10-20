# Lua · 未央 — roadmap

Lua 0.2 is an alpha launcher, not a PCL / HMCL feature-complete replacement.

## Current scope

- Modern Vanilla / Fabric, isolated instances and verified downloads.
- Java discovery and launch settings.
- Real launch lifecycle and logs.
- Modrinth / BBSMC search and compatible Fabric mod installation, with source-isolated dependencies and installation records.
- Microsoft authentication implementation using a separately registered client.
- One-step game installation, pinned Fabric versions, task progress, cancellation and retry.
- Online Modrinth packs and local `.mrpack` import with preview, verified files, client overrides and transactional commits.
- Persisted Microsoft app configuration and device authorization progress, expiry and cancellation.
- Original practical, compact, light desktop UI informed by PCL / HMCL.
- Experimental BBSMC public API integration; unsupported or external-only releases link to the official project page.

## Verified alpha baseline — 2026-10-21

Deterministic tests cover authentication, app configuration, the launcher core, modpack parsing and transactional installation, and file-selection isolation. See GitHub Actions for the current test run. Minecraft 1.20.1 Vanilla and 1.20.1 + Fabric Loader 0.19.5 complete game initialization on macOS ARM64 in explicit offline mode.

Real Microsoft device authorization and Xbox / XSTS authentication have passed with Lua's own application. Minecraft's login endpoint returns HTTP 403, so complete account login remains blocked by service access. Windows / Linux gameplay is not yet verified. This baseline does not establish complete gameplay or compatibility across other versions and architectures.

Version 0.2 also verifies online installation and desktop local import of Fabulously Optimized 5.4.1 (Minecraft 1.20.1 / pinned Fabric 0.14.23, 48 mod JARs), followed by a desktop launch into the game main loop on macOS ARM64 in explicit offline mode. The pack is a test case and is not bundled or redistributed with Lua.

## Before a stable release

1. Resolve Minecraft service access for the project's registered Microsoft application and finish end-to-end account validation.
2. Perform Windows x64, Linux x64 and macOS x64 game-start smoke tests; expand the macOS ARM64 baseline to additional versions, saved worlds and multiplayer.
3. Install and select the appropriate Java runtime automatically.
4. Add mod inventory, enable/disable/uninstall/update and conflict diagnostics.
5. Add instance export and further pack formats / loaders.
6. Add signed builds, macOS notarization and verified updater delivery.
7. Improve interrupted-download resumption beyond whole-file cache reuse.

## Later

Forge / NeoForge / Quilt, older Minecraft versions, skins, richer crash analysis,
multiple accounts, language packs and launcher migration.

Priorities follow reproducible installation and game-start failures before adding cosmetic features.
