import { build } from 'esbuild'
await build({
  entryPoints: ['desktop/main.ts', 'desktop/preload.ts'],
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  define: {
    __LUA_MICROSOFT_CLIENT_ID__: JSON.stringify(process.env.LUA_MICROSOFT_CLIENT_ID || ''),
  },
})
