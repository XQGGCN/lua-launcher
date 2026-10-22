/** Renderer-safe types for exporting a completed world directory backup as a ZIP archive. */
export interface WorldZipProgress {
  phase: 'validate-backup' | 'export' | 'verify-archive' | 'commit'
  filesDone: number
  filesTotal?: number
  bytesDone: number
  bytesTotal?: number
}
export interface WorldZipSummary {
  exportId: string
  instanceId: string
  backupId: string
  worldFolderName: string
  fileName: string
  format: 'lua-world-zip'
  schema: 1
  archiveBytes: number
  archiveSha256: string
  fileCount: number
  directoryCount: number
  totalBytes: number
  completedAt: string
  verifiedAtCompletion: true
}
export interface WorldZipResult extends WorldZipSummary { warnings: string[] }
export interface WorldZipList {
  items: WorldZipSummary[]
  incompleteCount: number
  warnings: string[]
  truncated: boolean
}
export interface WorldZipTask {
  id: string
  instanceId: string
  backupId: string
  worldFolderName: string
  startedAt: string
  finishedAt?: string
  status: 'active' | 'cancelling' | 'complete' | 'cancelled' | 'error'
  progress: WorldZipProgress
  error?: string
  result?: WorldZipResult
}
