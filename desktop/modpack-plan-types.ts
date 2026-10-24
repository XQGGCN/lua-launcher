import type { PackPreview } from './modpack'

export type PackPlanRole = 'required' | 'optional' | 'server-excluded' | 'overrides' | 'client-overrides'
export type PackPlanOrigin = 'indexed' | 'overrides' | 'client-overrides' | 'server-overrides'
export type PackPlanEnvironment = 'required' | 'optional' | 'unsupported'
export interface PackPlanCounts {
  requiredFiles: number
  optionalFiles: number
  selectedOptionalFiles: number
  skippedOptionalFiles: number
  downloadFiles: number
  downloadBytes: number
  overrideFiles: number
  overrideBytes: number
  writeFiles: number
  writeBytes: number
  excludedFiles: number
  shadowedFiles: number
}
/** Main adds planId/source/expiresAt. This bounded initial DTO contains the full
 * default optional ID set so pagination cannot lose off-page selections. */
export interface PackPlanSummary {
  schema: 1
  archiveSha512: string
  planDigest: string
  preview: PackPreview
  counts: PackPlanCounts
  defaultOptionalIds: string[]
}
export interface PackPlanRow {
  id: string
  path: string
  origin: PackPlanOrigin
  role: PackPlanRole
  bytes: number
  sizeBasis: 'declared-download' | 'verified-archive' | 'declared-archive'
  effective: boolean
  selectable: boolean
  selected: boolean
  environment?: { client: PackPlanEnvironment; server: PackPlanEnvironment; implicit: boolean }
  sha1?: string
  sha512?: string
  hashBasis?: 'index-declaration' | 'archive-payload'
  shadowedBy?: string
  shadowedByOrigin?: PackPlanOrigin
  shadows: string[]
  shadowOrigins: PackPlanOrigin[]
}
export interface PackPlanPage {
  schema: 1
  archiveSha512: string
  planDigest: string
  offset: number
  limit: number
  total: number
  nextOffset?: number
  counts: PackPlanCounts
  items: PackPlanRow[]
}
export interface PackPlanPageOptions {
  offset?: number
  limit?: number
  query?: string
  includeExcluded?: boolean
  role?: PackPlanRole | 'all'
  selectedOptionalIds?: readonly string[]
}
