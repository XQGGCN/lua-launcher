import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { LauncherCore, offlineUuid, type CoreEvent, type LaunchAccount, type LauncherSettings } from './core'
import { AuthManager, type DeviceCode } from './auth'
import { AuthConfigStore } from './auth-config'
import { PackSelections } from './pack-selection'
import { AccountCoordinator, type OfflineAccount } from './accounts'

declare const __LUA_MICROSOFT_CLIENT_ID__: string

app.setName('Lua')
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()

let window: BrowserWindow | null = null
let core: LauncherCore
let auth: AuthManager
let authConfig: AuthConfigStore
let packSelections: PackSelections<Awaited<ReturnType<LauncherCore['inspectModpack']>>>
let choosingPack = false
let accounts: AccountCoordinator
let authState: {
  active: boolean
  status: { stage: string; message: string } | null
  deviceCode: DeviceCode | null
} = { active: false, status: null, deviceCode: null }
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
function resourceSource(value: unknown): 'modrinth' | 'bbsmc' {
  if (value === undefined || value === 'modrinth') return 'modrinth'
  if (value === 'bbsmc') return 'bbsmc'
  throw new Error('不支持的资源来源')
}
async function persistOffline(account: OfflineAccount | null): Promise<void> {
  if (!account) {
    await fs.rm(offlineFile, { force: true })
    return
  }
  const temporary = `${offlineFile}.${randomUUID()}.tmp`
  let replaced = false
  try {
    await fs.writeFile(temporary, JSON.stringify(account), { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, offlineFile)
    replaced = true
  } finally {
    if (!replaced) await fs.rm(temporary, { force: true }).catch(() => {})
  }
}
function announceAuth() { send({ type: 'authState', state: structuredClone(authState) }) }
function authStatus(stage: string, message: string) {
  authState.status = { stage, message }
  send({ type: 'authStatus', ...authState.status })
  announceAuth()
}
function openExternal(input: unknown) {
  const url = new URL(text(input, 2048))
  const hosts = new Set(['modrinth.com', 'bbsmc.net', 'github.com', 'www.minecraft.net', 'minecraft.net',
    'microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com', 'login.live.com', 'learn.microsoft.com'])
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname)) {
    throw new Error('不支持的外部链接')
  }
  return shell.openExternal(url.href)
}
async function credentials(): Promise<LaunchAccount> {
  return accounts.credentials()
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
  authConfig = new AuthConfigStore(root, process.env.LUA_MICROSOFT_CLIENT_ID || __LUA_MICROSOFT_CLIENT_ID__)
  packSelections = new PackSelections(root, file => core.inspectModpack(file))
  await packSelections.init()
  auth = new AuthManager(root, {
    seal: (plain: string) => {
      if (!safeStorage.isEncryptionAvailable() ||
          (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
        throw new Error('系统安全存储不可用，无法保存微软账户。请启用系统密钥环后重试。')
      }
      return safeStorage.encryptString(plain)
    },
    unseal: (cipher: Buffer) => safeStorage.decryptString(cipher),
    onDeviceCode: (code) => {
      if (!accounts.acceptsAuthEvents) return
      const generation = accounts.generation
      authState.deviceCode = code
      send({ type: 'deviceCode', ...code })
      announceAuth()
      // The URL has been validated by AuthManager and is checked again here.
      void openExternal(code.verificationUri).catch(() => {
        if (generation === accounts.generation && accounts.loginPending && accounts.acceptsAuthEvents) {
          authStatus('waiting-authorization', '请点击“打开 Microsoft 授权页”完成登录。')
        }
      })
    },
    onStatus: status => {
      if (!accounts.acceptsAuthEvents) return
      // Login becomes complete after the offline selection is also persisted.
      if (status.stage === 'complete' && accounts.loginPending) return
      authStatus(status.stage, status.message)
    },
  })
  let initialOffline: OfflineAccount | null = null
  try {
    const saved = JSON.parse(await fs.readFile(offlineFile, 'utf8'))
    if (typeof saved.username === 'string' && /^[a-zA-Z0-9_]{3,16}$/.test(saved.username)) {
      initialOffline = { mode: 'offline', username: saved.username, uuid: offlineUuid(saved.username) }
    }
  } catch { /* First run or invalid offline settings: show account setup. */ }
  accounts = new AccountCoordinator(auth, {
    initialOffline, config: () => authConfig.status(), persistOffline,
    onAccount: account => send({ type: 'account', account }),
  })
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
      case 'fabricVersions': return core.fabricVersions(text(args[0], 80))
      case 'createInstance': {
        const input = object(args[0])
        const loader = text(input.loader)
        if (loader !== 'vanilla' && loader !== 'fabric') throw new Error('首版支持原版与 Fabric')
        return core.createInstance({
          name: text(input.name, 80), version: text(input.version, 80), loader,
          loaderVersion: input.loaderVersion === undefined || input.loaderVersion === '' ? undefined : text(input.loaderVersion, 80),
        })
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
          source: resourceSource(options.source),
        })
      }
      case 'modVersions': return core.modVersions(text(args[0], 80), text(args[1], 80), resourceSource(args[2]))
      case 'installMod': return core.installMod(text(args[0], 80), text(args[1], 80), resourceSource(args[2]))
      case 'chooseModpack': {
        if (choosingPack) throw new Error('请先完成当前文件选择')
        choosingPack = true
        try {
          const selected = await dialog.showOpenDialog(window, {
            title: '选择 Minecraft 整合包',
            properties: ['openFile'],
            filters: [{ name: 'Modrinth 整合包', extensions: ['mrpack', 'zip'] }],
          })
          if (selected.canceled || !selected.filePaths[0]) return null
          return await packSelections.choose(selected.filePaths[0])
        } finally {
          choosingPack = false
        }
      }
      case 'importModpack': {
        const options = args[1] === undefined ? {} : object(args[1])
        const name = options.name === undefined ? undefined : text(options.name, 80)
        return packSelections.use(text(args[0], 80), file => core.importModpack(file, { name }))
      }
      case 'searchModpacks': {
        const options = args[1] === undefined ? {} : object(args[1])
        return core.searchModpacks(text(args[0], 200), {
          offset: options.offset === undefined ? undefined : Number(options.offset),
          source: resourceSource(options.source),
        })
      }
      case 'modpackVersions': return core.modpackVersions(text(args[0], 80), resourceSource(args[1]))
      case 'installModpack': {
        const options = args[1] === undefined ? {} : object(args[1])
        return core.installModpack(text(args[0], 80), {
          name: options.name === undefined ? undefined : text(options.name, 80),
          source: resourceSource(options.source),
        })
      }
      case 'openInstance': {
        const result = await shell.openPath(core.getInstancePath(text(args[0], 80)))
        if (result) throw new Error(result)
        return
      }
      case 'openExternal': return openExternal(args[0])
      case 'logs': return logs.get(text(args[0], 80)) ?? []
      case 'account': return accounts.account()
      case 'authConfig': return authConfig.status()
      case 'authState': return structuredClone(authState)
      case 'saveAuthConfig':
        if (accounts.loginPending) throw new Error('请先完成或取消当前登录')
        return authConfig.saveClientId(text(args[0], 100))
      case 'login': {
        if (accounts.loginPending) throw new Error('登录正在进行，请完成或取消当前登录')
        authState = { active: true, status: null, deviceCode: null }
        authStatus('requesting-code', '正在向 Microsoft 请求登录代码…')
        const pending = accounts.login()
        const generation = accounts.generation
        try {
          const result = await pending
          authStatus('complete', 'Microsoft 登录已完成。')
          return result
        } catch (error) {
          if (generation === accounts.generation) {
            const cancelled = error instanceof Error && 'code' in error && error.code === 'CANCELLED'
            authStatus(cancelled ? 'cancelled' : 'error', error instanceof Error ? error.message : '登录未完成，请重试')
          }
          throw error
        } finally {
          authState.active = false
          authState.deviceCode = null
          announceAuth()
        }
      }
      case 'cancelLogin':
        accounts.cancelLogin()
        return
      case 'setOffline': {
        const username = text(args[0], 16)
        if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) throw new Error('名称需为 3–16 位英文字母、数字或下划线')
        return accounts.setOffline({ mode: 'offline', username, uuid: offlineUuid(username) })
      }
      case 'logout':
        return accounts.logout()
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
app.on('before-quit', () => {
  accounts?.cancelLogin()
  void packSelections?.close().catch(() => {})
})
