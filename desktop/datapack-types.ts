/** Data-pack preview DTOs. No absolute paths, source file handles or world proofs. */
export type DatapackInspectionStatus = 'checked' | 'unsupported' | 'invalid'
export interface DatapackMetadata {
  description: string
  formatSummary: string
  packFormat?: number
  supportedFormats?: [number, number]
  minFormat?: [number, number]
  /** null minor means any minor in this major. */
  maxFormat?: [number, number | null]
  features: string[]
  overlays: string[]
  warnings: string[]
}
export interface DatapackCompatibility {
  status: 'declared-compatible' | 'declared-incompatible' | 'unknown' | 'unsupported'
  message: string
  version?: string
  expectedFormat?: string
}
export interface DatapackPreview {
  name: string
  kind: 'zip' | 'directory'
  status: DatapackInspectionStatus
  reason?: string
  archiveBytes?: number
  sha512?: string
  fileCount?: number
  metadata?: DatapackMetadata
  warnings: string[]
}
export interface DatapackInventoryItem {
  itemId: string
  name: string
  kind: 'zip' | 'directory'
  sizeBytes?: number
  modifiedAt: string
  /** Only directory root metadata. ZIP payloads are inspected on explicit request. */
  metadata?: DatapackMetadata
  warnings: string[]
  activation: 'unknown'
}
export interface DatapackInventory {
  observedAt: string
  items: DatapackInventoryItem[]
  warnings: string[]
  truncated: boolean
  directoryPresent: boolean
}
export type DatapackInventoryData = DatapackInventory
export interface WorldDatapackInventory extends DatapackInventory {
  instanceId: string
  world: { itemId: string; name: string }
  revision: string
}
export interface WorldDatapackPreview extends DatapackPreview {
  instanceId: string
  world: { itemId: string; name: string }
  revision: string
  previewId: string
  instanceCompatibility: DatapackCompatibility
  worldCompatibility: DatapackCompatibility
}
