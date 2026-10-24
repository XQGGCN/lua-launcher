import type { ModJarDetails } from './mod-details-types'

export interface ModImportAssessment {
  eligible: boolean
  candidateIds: string[]
  reasons: string[]
  warnings: string[]
  indexedFiles: number
}
export interface LocalModImportPlan {
  instanceId: string
  gameVersion: string
  loader: string
  source: 'local'
  filename: string
  archiveBytes?: number
  sha512?: string
  details: ModJarDetails
  assessment: ModImportAssessment
  capabilityId?: string
  expiresAt: string
}
export interface LocalModImportResult {
  operationId: string
  instanceId: string
  filename: string
  archiveBytes: number
  sha512: string
  modIds: string[]
  installedAt: string
  warnings: string[]
}
/** Main-only source proof. Renderer may only submit an opaque capability. */
export interface LocalModImportSource {
  file: string
  filename: string
  archiveBytes: number
  sha512: string
  modIds: string[]
}
