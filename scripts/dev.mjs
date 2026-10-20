import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import './build-desktop.mjs'
const server = await createServer()
await server.listen()
const child = spawn('electron', ['.'], {
  stdio: 'inherit',
  env: { ...process.env, LUA_DEV_URL: 'http://127.0.0.1:5173' },
  shell: process.platform === 'win32',
})
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0) })
