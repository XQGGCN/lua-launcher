/** Bounded untrusted declarations only; no native paths, raw trees or import capability. */
export interface ModDependencyDeclaration {
  id: string
  kind: string
  version: string
  environment?: string
  details?: string
}
export interface ModDeclaration {
  id?: string
  name?: string
  version?: string
  description?: string
  authors: string[]
  licenses: string[]
  environment?: string
  provides: string[]
  dependencies: ModDependencyDeclaration[]
  nestedJars: string[]
  warnings: string[]
}
export interface ModMetadataDocument {
  path: string
  format: 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'manifest' | 'quilt-json5'
  status: 'read' | 'invalid' | 'unsupported'
  schemaVersion?: string
  loader?: { id: string; version?: string }
  mods: ModDeclaration[]
  manifest?: { name: string; value: string }[]
  reason?: string
  warnings: string[]
}
export interface ModJarDetails {
  name: string
  disabledSuffix: boolean
  observedAt: string
  status: 'metadata-read' | 'no-metadata' | 'invalid' | 'unsupported'
  archiveBytes?: number
  /** Whole outer-file hash only. Classes and other payloads are not certified. */
  sha512?: string
  documents: ModMetadataDocument[]
  warnings: string[]
}
export interface InstalledModSelection {
  itemId: string
  name: string
  sizeBytes: number
  modifiedAt: string
}
export interface InstanceModDetails extends ModJarDetails {
  instanceId: string
  viewId: string
  source: 'installed' | 'local'
  itemId?: string
  instanceGameVersion: string
  instanceLoader: string
  assessment: { status: 'matches-declaration' | 'mismatch' | 'unknown'; message: string }
}
