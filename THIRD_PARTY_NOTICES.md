# Third-party notices

Lua's original source is licensed under MIT. Third-party dependencies keep their respective licenses; their full license texts are distributed with the packages in `node_modules` and with applicable runtime distributions.

| Component | License | Source |
|---|---|---|
| React / React DOM | MIT | https://github.com/facebook/react |
| Electron | MIT; bundled Chromium and other components retain their notices | https://github.com/electron/electron |
| Lucide | ISC | https://github.com/lucide-icons/lucide |
| adm-zip | MIT | https://github.com/cthackers/adm-zip |
| Vite | MIT | https://github.com/vitejs/vite |
| TypeScript | Apache-2.0 | https://github.com/microsoft/TypeScript |
| esbuild | MIT | https://github.com/evanw/esbuild |
| electron-builder | MIT | https://github.com/electron-userland/electron-builder |
| tsx | MIT | https://github.com/privatenumber/tsx |

No source or packaged assets from PCL, HMCL or Modrinth App are included. Their names are comparative references, not endorsements. Modrinth API content belongs to individual creators. Minecraft game files, Fabric, Forge, NeoForge and user-selected mods are fetched separately at runtime, subject to their own licenses; they are not part of the Lua source distribution.

Minecraft is a trademark of Mojang / Microsoft. Lua is an independent project, not an official Minecraft product.

Forge and NeoForge installer metadata and processor JARs are downloaded on request from their official Maven repositories. Their binaries retain their own licenses and are not bundled with Lua. Lua implements the installer orchestration in original TypeScript. Official projects and support links: [Forge](https://minecraftforge.net/), [Forge support](https://www.patreon.com/LexManos), [NeoForge](https://neoforged.net/).

## Downloaded Java runtimes

Lua 0.4.0 downloads selected Mojang-distributed OpenJDK runtime files on demand from official metadata. These runtimes are not bundled in the Lua application or relicensed under MIT. Runtime `legal/` license and notice files remain in the installed runtime. Consult those files for the exact build’s GPLv2 with Classpath Exception and any component-specific notices.
