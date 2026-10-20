# Lua · 未央 — product scope

## Product direction

- Independent open-source Minecraft Java desktop launcher targeting Windows, macOS and Linux.
- Prioritize installation and launching. PCL and HMCL are feature references.
- Practical, compact, light desktop UI: concise navigation, aligned version rows, account and Java summaries, and a persistent launch action.
- Brand: Lua · 未央. Use independent names, artwork and interface assets.
- Source distribution through GitHub; an optional website can provide downloads and documentation.

## Implementation scope

Electron, React and TypeScript. Original UI and launcher integration; no copied PCL, HMCL or Modrinth implementation or brand assets.
The current local version is 0.5.0 Alpha: modern Vanilla, Fabric, Forge and NeoForge installation; isolated instances; verified automatic Mojang Java provisioning and manual selection; per-instance Java, memory, JVM and game-window overrides; task progress; logs; Microsoft account flow; and Modrinth / experimental BBSMC discovery and `.mrpack` installation. Public downloads remain 0.3.0 until the new commits pass their own CI and release checks. Broader feature parity remains a roadmap.

Version 0.3.0 implements 19 official Modrinth mod categories, corresponding BBSMC Chinese search facets, and the category-filter UI. Real optimization-category searches on both sources returned matching category tags for the first 20 results checked per source. Categories describe upstream project tags, not locally inferred mod behavior; this sample does not validate every category or mod combination.

Gameplay requires an authenticated Microsoft account with Minecraft Java entitlement and profile verification. Offline identities and their launch path were removed in 0.2.2 and remain unavailable.

Automatic memory is the default. It combines physical RAM, a fresh runtime/OS availability estimate, the game workload hint and the selected Java architecture. The runtime's `process.availableMemory()` is preferred, with `os.freemem()` as a fallback. Reclaimable-memory and process-limit accounting depends on the runtime and platform. Both automatic and manual allocations preserve OS and Java native headroom, are capped again before launch, and refuse an allocation below the minimum budget. The saved manual preference is retained when switching modes.

## Validation snapshot — 2026-10-21

All 156 deterministic tests passed locally for 0.3.0. Windows, Linux and macOS test/build results must be read from the matching [GitHub Actions](https://github.com/XQGGCN/lua-launcher/actions) run; local success is not a claim that all platform builds have passed. Public downloads use the [0.3.0 Release](https://github.com/XQGGCN/lua-launcher/releases/tag/v0.3.0) and its actual published assets.

On macOS ARM64 with local Java 17, full core installation completed for Minecraft 1.20.1 / Forge 47.4.0 and Minecraft 1.20.2 / NeoForge 20.2.93, including real installer processors and generated-JAR verification. The resulting manifests contain 88 and 103 classpath entries respectively. This validates those installation pipelines only; full game startup, saved worlds and multiplayer were not tested for either combination.

Historical versions through 0.2.1 completed game initialization on macOS ARM64 for Minecraft 1.20.1 Vanilla and Fabric Loader 0.19.5 using their former offline mode. This does not establish successful authenticated gameplay in the current build.

Microsoft device authorization and Xbox/XSTS authentication have passed, but the Minecraft login endpoint returns HTTP 403. The service-access application was submitted on 2026-10-21 and is awaiting approval. Complete account login and current online-only gameplay, including Windows / Linux gameplay, remain unverified. See [README.md](README.md#验证状态) for the public validation statement.

Version 0.4.0 adds shared, cancellable Mojang Java provisioning for exact manifest components, managed-runtime validation and atomic publication, retained manual-path preferences, and launcher-session task views. Local 201 deterministic tests and build passed. On macOS ARM64, Java 17/21/25 downloads/probes, offline cache reuse and repair passed; Vanilla 1.20.1 and Forge 47.4.0 installed with system Java detection deliberately disabled and only the new managed Java allowed for processors. No current game or authentication run was performed. See docs/devlog/0.4.0.md and docs/reviews/0.4.0.md for evidence and remaining limits.

Version 0.5.0 adds per-field inheritance, instance renaming without moving files, effective-setting sources, session drafts, local instance selection, and global JVM/window defaults. Settings publish only after their candidate file commits; explicit fullscreen overrides preserve an original options backup. Local 245 tests, build, browser-preview interaction and unsigned macOS ARM64 packaging passed. Native 0.5 UI, current-commit cross-platform CI and authenticated gameplay remain unverified; see docs/devlog/0.5.0.md and docs/reviews/0.5.0.md.
