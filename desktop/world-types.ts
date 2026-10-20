/** Renderer-safe world metadata; never includes an NBT tree or filesystem proof. */
export type WorldSource = 'level.dat' | 'level.dat_old'
export interface WorldSelection { itemId: string; name: string }
export type WorldReason = 'missing' | 'unsafe-path' | 'name-collision' | 'changed' | 'unsupported-compression' |
  'invalid-gzip' | 'invalid-nbt' | 'unsupported-layout' | 'limit-exceeded' | 'unreadable'
export interface WorldMetadata {
  levelName?: string
  savedVersionName?: string
  dataVersion?: number
  versionId?: number
  snapshot?: boolean
  gameMode?: { raw: number; label?: string }
  difficulty?: { raw: number | string; label?: string }
  hardcore?: boolean
  allowCommands?: boolean
  timeTicks?: string
  dayTimeTicks?: string
  lastPlayed?: { epochMs: string; iso?: string }
}
export interface WorldDetailsData {
  itemId: string
  folderName: string
  source: WorldSource
  observedAt: string
  status: 'ok' | 'partial' | 'unavailable'
  reasonCode?: WorldReason
  file?: { sizeBytes: number; modifiedAt: string }
  metadata: WorldMetadata
  fieldWarnings: { field: string; code: 'missing' | 'type-mismatch' | 'invalid-value' | 'truncated' }[]
  warnings: string[]
  seedAvailable: boolean
}
export interface WorldDetails extends WorldDetailsData { instanceId: string; revision?: string }
export interface WorldSeed {
  instanceId: string
  itemId: string
  source: WorldSource
  revision: string
  observedAt: string
  available: boolean
  seed?: string
}
