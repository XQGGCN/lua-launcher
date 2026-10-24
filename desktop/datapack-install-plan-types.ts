import type { WorldDatapackPreview } from './datapack-types'

/** Confirmation DTO only. File paths and artifact URLs remain in main. */
export interface WorldDatapackInstallPlan extends WorldDatapackPreview {
  source: 'local' | 'modrinth'
  filename: string
  capabilityId?: string
  expiresAt: string
  canInstall: boolean
  reasons: string[]
}

export interface DatapackArtifactSelection {
  projectId: string
  versionId: string
  filename: string
  size: number
  sha512: string
  sha1?: string
}
