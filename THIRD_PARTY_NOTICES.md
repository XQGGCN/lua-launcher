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
| pngjs 7.0.0 | MIT | https://github.com/pngjs/pngjs |
| smol-toml 1.9.1 | BSD-3-Clause | https://github.com/squirrelchat/smol-toml |

No source or packaged assets from PCL, HMCL or Modrinth App are included. Their names are comparative references, not endorsements. Modrinth API content belongs to individual creators. Minecraft game files, Fabric, Forge, NeoForge and user-selected mods are fetched separately at runtime, subject to their own licenses; they are not part of the Lua source distribution.

User-selected resource packs and shader packs are also downloaded separately, unchanged, from Modrinth or BBSMC. They retain their creators' licenses and notices and are not relicensed under Lua's MIT license. Verification fixtures created by Lua do not include those third-party packs; real-download verification archives remain outside the source and application distributions.

Minecraft is a trademark of Mojang / Microsoft. Lua is an independent project, not an official Minecraft product.

Forge and NeoForge installer metadata and processor JARs are downloaded on request from their official Maven repositories. Their binaries retain their own licenses and are not bundled with Lua. Lua implements the installer orchestration in original TypeScript. Official projects and support links: [Forge](https://minecraftforge.net/), [Forge support](https://www.patreon.com/LexManos), [NeoForge](https://neoforged.net/).

## Downloaded Java runtimes

Lua 0.4.0 downloads selected Mojang-distributed OpenJDK runtime files on demand from official metadata. These runtimes are not bundled in the Lua application or relicensed under MIT. Runtime `legal/` license and notice files remain in the installed runtime. Consult those files for the exact build’s GPLv2 with Classpath Exception and any component-specific notices.

## smol-toml 1.9.1

The bounded mod-metadata reader uses this TOML parser. Its full notice is retained in the bundled parser and reproduced here.

```text
Copyright (c) Squirrel Chat et al., All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## pngjs 7.0.0

The bounded local skin reader uses the exact pinned PNG codec in the main process. No skin image or third-party texture is bundled. Its complete license is retained here and in the desktop bundle.

```text
pngjs original work Copyright (c) 2015 Luke Page & Original Contributors
pngjs derived work Copyright (c) 2012 Kuba Niegowski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
