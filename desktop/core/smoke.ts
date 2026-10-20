/**
 * Opt-in integration test. Downloads official Minecraft files into .local/smoke.
 * Run: node --import tsx desktop/core/smoke.ts
 * Uses an explicitly offline test identity; never reads a user's game directories or account.
 */
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { LauncherCore } from '../core'

const directory = path.resolve('.local/smoke')
const loader = process.argv.includes('--fabric') ? 'fabric' : 'vanilla'
const instanceName = loader === 'fabric' ? 'Lua Fabric Smoke' : 'Lua Smoke'
const logName = loader === 'fabric' ? 'smoke-fabric.log' : 'smoke.log'
await fs.mkdir(directory, { recursive: true })
const lines: string[] = []
let lastProgress = 0
let initialized = false
let unexpectedExit = false
let stopped = false
const core = new LauncherCore(directory, event => {
  if (event.type === 'log') {
    const line = `[${event.level}] ${event.message}`
    lines.push(line)
    console.log(line)
    if (/OpenAL initialized|Created: .*textures\/atlas|Sound engine started/.test(event.message)) initialized = true
    if (!stopped && /游戏已退出|游戏已关闭/.test(event.message)) unexpectedExit = true
  } else if (event.type === 'progress' && Date.now() - lastProgress > 5000) {
    console.log(`${event.phase} ${event.completed}/${event.total} ${(event.bytesDownloaded / 1024 / 1024).toFixed(1)} MiB`)
    lastProgress = Date.now()
  }
})
try {
  await core.init()
  console.log('Detected Java:', await core.detectJava())
  const instance = core.snapshot().instances.find(i => i.name === instanceName)
    ?? await core.createInstance({ name: instanceName, version: '1.20.1', loader })
  if (instance.status !== 'ready') await core.install(instance.id)
  await core.updateSettings({ memoryMb: 2048, javaPath: '' })
  console.log('Launching explicit offline smoke-test identity.')
  await core.launch(instance.id, { mode: 'offline', username: 'LuaSmoke', uuid: '', accessToken: '' })
  const started = Date.now()
  while (Date.now() - started < 90_000 && !unexpectedExit && !initialized) {
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (initialized) {
    console.log('SMOKE: renderer/audio resources initialized; retaining window for 15 seconds for visual inspection.')
    await new Promise(resolve => setTimeout(resolve, 15_000))
  }
  stopped = true
  core.stop(instance.id)
  await fs.writeFile(path.join(directory, logName), lines.join('\n'))
  if (unexpectedExit || !initialized) throw new Error('Minecraft did not reach the rendering/audio initialization checkpoint')
  console.log('SMOKE: PASS — official install and real Minecraft render/audio initialization.')
} catch (error) {
  console.error(error)
  await fs.writeFile(path.join(directory, logName), lines.join('\n'))
  process.exitCode = 1
}
