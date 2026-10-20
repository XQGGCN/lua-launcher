# Lua · 未央 — roadmap

Lua 0.3.0 is an online-account-only public alpha. PCL / HMCL feature parity remains a long-term direction, not a completion claim.

## Current scope

- Modern Vanilla / Fabric / Forge / NeoForge installation, isolated instances and verified downloads.
- Java discovery and automatic / manual memory settings, with availability sampled again before launch and OS/native-memory headroom retained.
- Real launch lifecycle and logs.
- Modrinth / BBSMC search and compatible mod installation, with game-version/loader filtering, source-isolated dependencies and installation records.
- 19 official Modrinth mod categories, BBSMC Chinese facet mapping, and the category-filter UI.
- Microsoft authentication implementation using a separately registered client.
- Gameplay requires a fully authenticated Microsoft account with verified Minecraft Java entitlement and profile. No offline identity, launch path, or authentication-failure fallback is provided.
- One-step game installation, pinned loader versions, task progress, cancellation and retry. Forge / NeoForge run the official installer's processors with a locally installed Java runtime and verify generated outputs.
- Online Modrinth packs and local `.mrpack` import with preview, verified files, client overrides and transactional commits.
- Persisted Microsoft app configuration and device authorization progress, expiry and cancellation.
- Original practical, compact, light desktop UI informed by PCL / HMCL.
- Experimental BBSMC public API integration; unsupported or external-only releases link to the official project page.

## 0.3.0 validation scope — 2026-10-21

All 156 deterministic tests passed locally. They cover authentication, app configuration, the launcher core, Forge / NeoForge installation, memory policy, category mapping, modpack parsing and transactional installation, and file-selection isolation. Platform test and installer-build results are recorded in the matching [GitHub Actions](https://github.com/XQGGCN/lua-launcher/actions) run. No three-platform CI success is inferred from this local result.

Full core installation succeeded on macOS ARM64 with Java 17 for Minecraft 1.20.1 / Forge 47.4.0 and Minecraft 1.20.2 / NeoForge 20.2.93. Their installer processors completed, generated JARs passed verification, and the manifests contain 88 and 103 classpath entries respectively. Neither result establishes successful gameplay; the new combinations have not been validated in the game itself.

Real optimization-category searches were checked on both Modrinth and BBSMC. The first 20 results per source had category tags matching the requested source-specific facet. The UI and mapping are implemented; validation of every category and every mod combination is not claimed.

The memory policy prefers `process.availableMemory()` and falls back to `os.freemem()`. It accounts for reclaimable memory and process constraints to the extent the runtime/platform reports them, preserves OS and Java native headroom, caps manual requests as well as automatic recommendations, and recalculates before launch. These are estimates, not reserved memory or a guarantee against later memory pressure.

Real Microsoft device authorization and Xbox / XSTS authentication have passed with Lua's own application. Minecraft's login endpoint returns HTTP 403; the service-access request was submitted on 2026-10-21 and is awaiting approval. Complete account login and current online-only gameplay remain blocked. Windows / Linux gameplay is not yet verified.

Historical builds through 0.2.1 completed game initialization for Minecraft 1.20.1 Vanilla and 1.20.1 + Fabric Loader 0.19.5 on macOS ARM64 using their former offline mode. That path was removed in 0.2.2, so this is not a successful gameplay validation of the current build.

Historical version 0.2 also verified online installation and desktop local import of Fabulously Optimized 5.4.1 (Minecraft 1.20.1 / pinned Fabric 0.14.23, 48 mod JARs), followed by a desktop launch into the game main loop on macOS ARM64 using its former offline mode. The pack is a test case and is not bundled or redistributed with Lua. The opt-in core smoke script now checks installation only; gameplay must be tested through the desktop's authenticated account flow.

## Before a stable release

1. Resolve Minecraft service access for the project's registered Microsoft application and finish end-to-end account validation.
2. Validate authenticated Vanilla / Fabric / Forge / NeoForge gameplay, beginning with the installed macOS ARM64 combinations; add Windows x64, Linux x64 and macOS x64 tests, saved worlds and multiplayer.
3. Install and select the appropriate Java runtime automatically.
4. Add mod inventory, enable/disable/uninstall/update and conflict diagnostics.
5. Expand Forge / NeoForge version and modpack coverage; add instance export and further pack formats / loaders.
6. Add signed builds, macOS notarization and verified updater delivery.
7. Improve interrupted-download resumption beyond whole-file cache reuse.

## Later

Quilt, older Minecraft versions, skins, richer crash analysis,
multiple accounts, language packs and launcher migration.

Priorities follow reproducible installation and game-start failures before adding cosmetic features.
