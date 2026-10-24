import type { WorldSelection } from './world-types'
import type { WorldBackupProgress, WorldBackupResult } from './world-backup-types'

/** Main-only source capability. Never accept this object from IPC. */
export interface DatapackInstallSource { file: string; filename: string; sha512: string; archiveBytes: number }

/** Renderer-safe completion proof. The source path and transaction controls stay in main. */
export interface DatapackInstallResult {
  operationId: string
  instanceId: string
  world: WorldSelection
  filename: string
  sha512: string
  archiveBytes: number
  backup: WorldBackupResult
  installedAt: string
  warnings: string[]
}
export interface DatapackInstallProgress {
  phase: 'prepare' | 'backup' | 'verify' | 'commit'
  bytesDone: number
  totalBytes?: number
  backupProgress?: WorldBackupProgress
}
export interface DatapackInstallRecovery { blocked: boolean; warnings: string[] }
