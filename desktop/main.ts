import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as fs from 'node:fs/promises'
import { LauncherCore, offlineUuid, type CoreEvent, type LaunchAccount, type LauncherSettings } from './core'
import { AuthManager } from './auth'

app.setName('Lua')
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()

let window: BrowserWindow | null = null
let core: LauncherCore
let auth: AuthManager
type PublicAccount = { username: string; uuid: string; mode: 'offline' | 'microsoft' }
let offline: PublicAccount | null = null
const logs = new Map<string, Extract<CoreEvent, { type: 'log' }>[]>()
const devURL = process.env.LUA_DEV_URL
const root = process.env.LUA_DATA_DIR || path.join(app.getPath('userData'), 'launcher')
const offlineFile = path.join(root, 'offline-account.json')
const entryFile = path.join(__dirname, '../dist/index.html')

function send(event: unknown) {
  if (window && !window.isDestroyed()) window.webContents.send('launcher:event', event)
}
function event(event: CoreEvent) {
  if (event.type === 'log') {
    const history = logs.get(event.instanceId) ?? []
    history.push(event)
    if (history.length > 1000) history.splice(0, history.length - 1000)
    logs.set(event.instanceId, history)
  }
  send(event)
}
function text(value: unknown, max = 1024): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('输入参数无效')
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('输入参数无效')
  return value as Record<string, unknown>
}
async function account(): Promise<PublicAccount | null> { return offline ?? await auth.account() }
async function announceAccount() { send({ type: 'account', account: await account() }) }
function openExternal(input: unknown) {
  const url = new URL(text(input, 2048))
  const hosts = new Set(['modrinth.com', 'github.com', 'www.minecraft.net', 'minecraft.net',
    'microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com', 'login.live.com', 'learn.microsoft.com'])
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname)) {
    throw new Error('不支持的外部链接')
  }
  return shell.openExternal(url.href)
}
async function credentials(): Promise<LaunchAccount> {
  if (offline) return { ...offline, mode: 'offline', accessToken: '0' }
  if (!await auth.account()) throw new Error('请先在账户页面登录，或明确选择离线账户')
  return auth.credentials()
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1240, height: 840, minWidth: 880, minHeight: 640,
    backgroundColor: '#f4f6f8', title: 'Lua · 未央',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = devURL ? new URL(url).origin === new URL(devURL).origin : url === pathToFileURL(entryFile).href
    if (!allowed) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.on('closed', () => { window = null })
  if (devURL) {
    if (new URL(devURL).origin !== 'http://127.0.0.1:5173') throw new Error('无效的开发服务地址')
    await window.loadURL(devURL)
  } else await window.loadFile(entryFile)
}

if (hasLock) app.whenReady().then(async () => {
  core = new LauncherCore(root, event)
  await core.init()
  auth = new AuthManager(root, {
    seal: (plain: string) => {
      if (!safeStorage.isEncryptionAvailable() ||
          (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
        throw new Error('系统安全存储不可用，无法保存微软账户。请启用系统密钥环后重试。')
      }
      return safeStorage.encryptString(plain)
    },
    unseal: (cipher: Buffer) => safeStorage.decryptString(cipher),
    onDeviceCode: (code) => send({ type: 'deviceCode', ...code }),
  })
  try {
    const saved = JSON.parse(await fs.readFile(offlineFile, 'utf8'))
    if (typeof saved.username === 'string' && /^[a-zA-Z0-9_]{3,16}$/.test(saved.username)) {
      offline = { mode: 'offline', username: saved.username, uuid: offlineUuid(saved.username) }
    }
  } catch { /* First run or invalid offline settings: show account setup. */ }
  ipcMain.handle('launcher:call', async (ipcEvent, method: unknown, ...args: unknown[]) => {
    const sender = ipcEvent.senderFrame
    const trusted = !!sender && (devURL
      ? new URL(sender.url).origin === new URL(devURL).origin
      : sender.url === pathToFileURL(entryFile).href)
    if (!window || ipcEvent.sender.id !== window.webContents.id || !trusted || sender !== ipcEvent.sender.mainFrame) {
      throw new Error('不受信任的调用来源')
    }
    switch (method) {
      case 'snapshot': return core.snapshot()
      case 'versions': return core.versions()
      case 'createInstance': {
        const input = object(args[0])
        const loader = text(input.loader)
        if (loader !== 'vanilla' && loader !== 'fabric') throw new Error('首版支持原版与 Fabric')
        return core.createInstance({ name: text(input.name, 80), version: text(input.version, 80), loader })
      }
      case 'install': return core.install(text(args[0], 80))
      case 'cancelInstall': return core.cancelInstall(text(args[0], 80))
      case 'launch': return core.launch(text(args[0], 80), await credentials())
      case 'stop': return core.stop(text(args[0], 80))
      case 'updateSettings': {
        const input = object(args[0])
        const current = core.snapshot().settings
        return core.updateSettings({
          memoryMb: input.memoryMb === undefined ? current.memoryMb : Number(input.memoryMb),
          javaPath: input.javaPath === undefined ? current.javaPath : text(input.javaPath, 2048),
          concurrentDownloads: input.concurrentDownloads === undefined ? current.concurrentDownloads : Number(input.concurrentDownloads),
        } as LauncherSettings)
      }
      case 'detectJava': return core.detectJava()
      case 'searchMods': {
        const options = args[1] === undefined ? {} : object(args[1])
        return core.searchMods(text(args[0], 200), {
          loader: options.loader === undefined ? undefined : text(options.loader, 30),
          gameVersion: options.gameVersion === undefined ? undefined : text(options.gameVersion, 50),
          offset: options.offset === undefined ? undefined : Number(options.offset),
        })
      }
      case 'modVersions': return core.modVersions(text(args[0], 80), text(args[1], 80))
      case 'installMod': return core.installMod(text(args[0], 80), text(args[1], 80))
      case 'openInstance': {
        const result = await shell.openPath(core.getInstancePath(text(args[0], 80)))
        if (result) throw new Error(result)
        return
      }
      case 'openExternal': return openExternal(args[0])
      case 'logs': return logs.get(text(args[0], 80)) ?? []
      case 'account': return account()
      case 'login': {
        const result = await auth.begin(text(args[0], 100))
        offline = null
        await fs.rm(offlineFile, { force: true })
        await announceAccount()
        return result
      }
      case 'cancelLogin': return auth.cancel()
      case 'setOffline': {
        const username = text(args[0], 16)
        if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) throw new Error('名称需为 3–16 位英文字母、数字或下划线')
        auth.cancel()
        offline = { mode: 'offline', username, uuid: offlineUuid(username) }
        await fs.writeFile(offlineFile, JSON.stringify(offline), { mode: 0o600 })
        await announceAccount()
        return offline
      }
      case 'logout':
        auth.cancel()
        await auth.logout()
        offline = null
        await fs.rm(offlineFile, { force: true })
        await announceAccount()
        return
      default: throw new Error('不支持的操作')
    }
  })
  await createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
}).catch(error => {
  console.error('Lua could not start:', error instanceof Error ? error.message : 'unknown error')
  app.quit()
})

app.on('second-instance', () => { window?.show(); window?.focus() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { auth?.cancel() })
