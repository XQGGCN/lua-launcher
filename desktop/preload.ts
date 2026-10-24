import { contextBridge, ipcRenderer } from 'electron'

// The renderer gets a narrow command bridge, never Node, filesystem or tokens.
const methods = new Set([
  'snapshot', 'versions', 'createInstance', 'install', 'cancelInstall', 'launch',
  'stop', 'updateSettings', 'detectJava', 'searchMods', 'modVersions', 'installMod',
  'openInstance', 'openExternal', 'account', 'login', 'cancelLogin', 'logout',
  'logs',
  'fabricVersions', 'loaderVersions', 'memoryInfo', 'chooseModpack', 'importModpack', 'searchModpacks',
  'modpackVersions', 'installModpack', 'authConfig', 'saveAuthConfig', 'authState',
  'managedJava', 'runtimeRequirement', 'runtimeTasks', 'installJava', 'cancelJavaInstall', 'chooseJava', 'cancelLaunch',
  'instanceOptions', 'updateInstanceSettings',
  'inventory',
  'inspectInstanceMod', 'chooseLocalModJar', 'cancelModDetails',
  'searchResources', 'resourceVersions', 'installResource', 'cancelResourceInstall',
  'prepareModToggle', 'setModEnabled',
  'worldDetails', 'worldDetailsWithSeed',
  'worldDatapacks', 'inspectWorldDatapack', 'chooseDatapackZip', 'cancelDatapackRead',
  'searchDatapacks', 'datapackProjectVersions',
  'prepareLocalDatapackInstall', 'prepareModrinthDatapackInstall', 'installDatapack', 'cancelDatapackInstall',
  'worldBackupTasks', 'worldBackups', 'backupWorld', 'cancelWorldBackup', 'openWorldBackup',
  'checkUpdate', 'installUpdate', 'deleteInstance', 'duplicateInstance', 'openCrashReports', 'minimizeWindow', 'setTitleBarTheme',
  'worldMap', 'worldMapTile', 'chooseWorldZip', 'importWorldZip', 'restoreWorldBackup', 'cancelWorldRestore',
  'worldExportTasks', 'worldExports', 'exportWorldBackup', 'cancelWorldExport', 'verifyWorldExport', 'openWorldExport',
])
contextBridge.exposeInMainWorld('launcher', {
  platform: process.platform,
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
