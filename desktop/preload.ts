import { contextBridge, ipcRenderer } from 'electron'

// The renderer gets a narrow command bridge, never Node, filesystem or tokens.
const methods = new Set([
  'snapshot', 'versions', 'createInstance', 'install', 'cancelInstall', 'launch',
  'stop', 'updateSettings', 'detectJava', 'searchMods', 'modVersions', 'installMod',
  'openInstance', 'openExternal', 'account', 'login', 'cancelLogin', 'logout',
  'logs',
  'fabricVersions', 'loaderVersions', 'memoryInfo', 'chooseModpack', 'importModpack', 'searchModpacks',
  'modpackVersions', 'installModpack', 'authConfig', 'saveAuthConfig', 'authState',
])
contextBridge.exposeInMainWorld('launcher', {
  call(method: string, ...args: unknown[]) {
    if (!methods.has(method)) return Promise.reject(new Error('不支持的操作'))
    return ipcRenderer.invoke('launcher:call', method, ...args)
  },
  onEvent(callback: (event: unknown) => void) {
    const listener = (_: unknown, event: unknown) => callback(event)
    ipcRenderer.on('launcher:event', listener)
    return () => ipcRenderer.removeListener('launcher:event', listener)
  },
})
