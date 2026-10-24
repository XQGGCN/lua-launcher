import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
const pngLicense = await readFile(new URL('../node_modules/pngjs/LICENSE', import.meta.url), 'utf8')
// Public application identifier registered for Lua Launcher, not a credential.
const defaultMicrosoftClientId = '8e83a566-71f8-4164-9040-5cf61bb12740'
await build({
  entryPoints: ['desktop/main.ts', 'desktop/preload.ts'],
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  banner: { js: `/*! pngjs 7.0.0\n${pngLicense}\n*/` },
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  define: {
    __LUA_MICROSOFT_CLIENT_ID__: JSON.stringify(process.env.LUA_MICROSOFT_CLIENT_ID || defaultMicrosoftClientId),
  },
})
