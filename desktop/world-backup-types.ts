export interface WorldBackupProgress {
  phase: 'scan' | 'copy' | 'verify-destination' | 'verify-source' | 'commit'
  filesDone: number
  filesTotal?: number
  bytesDone: number
  bytesTotal?: number
}
export interface WorldBackupSummary {
  backupId: string
  instanceId: string
  worldItemId: string
  worldFolderName: string
  format: 'directory'
  createdAt: string
  completedAt: string
  fileCount: number
  directoryCount: number
  totalBytes: number
  verifiedAtCompletion: true
}
export interface WorldBackupResult extends WorldBackupSummary { warnings: string[] }
export interface WorldBackupList {
  items: WorldBackupSummary[]
  incompleteCount: number
  warnings: string[]
  truncated: boolean
}
export interface WorldBackupTask {
  id: string
  instanceId: string
  worldItemId: string
  worldFolderName: string
  startedAt: string
  finishedAt?: string
  status: 'active' | 'cancelling' | 'complete' | 'cancelled' | 'error'
  progress: WorldBackupProgress
  error?: string
  result?: WorldBackupResult
}
