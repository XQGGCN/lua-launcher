/**
 * Opt-in installation test. Downloads and verifies official Minecraft files in .local/smoke.
 * Run: node --import tsx desktop/core/smoke.ts
 * Does not launch Java or read a user's game directories or account.
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
const core = new LauncherCore(directory, event => {
  if (event.type === 'log') {
    const line = `[${event.level}] ${event.message}`
    lines.push(line)
    console.log(line)
  } else if (event.type === 'progress' && Date.now() - lastProgress > 5000) {
    console.log(`${event.phase} ${event.completed}/${event.total} ${(event.bytesDownloaded / 1024 / 1024).toFixed(1)} MiB`)
    lastProgress = Date.now()
  }
})
try {
  await core.init()
  const instance = core.snapshot().instances.find(i => i.name === instanceName)
    ?? await core.createInstance({ name: instanceName, version: '1.20.1', loader })
  // Re-run installation even when ready so existing cached files are verified.
  await core.install(instance.id)
  if (core.snapshot().instances.find(item => item.id === instance.id)?.status !== 'ready') {
    throw new Error('Minecraft installation did not reach ready state')
  }
  const installed = JSON.parse(await fs.readFile(path.join(core.instanceDirectory(instance.id), 'installed.json'), 'utf8'))
  if (installed.schema !== 1 || !installed.mainClass || !Array.isArray(installed.classpath) || installed.classpath.length === 0) {
    throw new Error('Minecraft installation manifest is incomplete')
  }
  await fs.writeFile(path.join(directory, logName), lines.join('\n'))
  console.log(`SMOKE: PASS — verified ${instance.version} ${loader} installation with ${installed.classpath.length} classpath entries.`)
} catch (error) {
  console.error(error)
  await fs.writeFile(path.join(directory, logName), lines.join('\n'))
  process.exitCode = 1
}
