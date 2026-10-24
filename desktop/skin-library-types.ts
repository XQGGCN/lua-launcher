/** Bounded, account-independent local gallery DTOs. Native paths never cross this boundary. */
export type SkinModel = 'classic' | 'slim'
export type SkinLayout = 'modern' | 'legacy'
export interface SkinSummary {
  id: string
  name: string
  tags: string[]
  model: SkinModel
  width: 64
  height: 32 | 64
  layout: SkinLayout
  createdAt: string
  updatedAt: string
}
export interface SkinItem extends SkinSummary { revision: string }
export interface SkinDiagnostics {
  warnings: string[]
  alpha: { transparentPixels: number; partialAlphaPixels: number }
}
export interface SkinPreview {
  viewId: string
  expiresAt: string
  filename: string
  width: 64
  height: 32 | 64
  layout: SkinLayout
  textureDataURL: string
  diagnostics: SkinDiagnostics
}
export interface SkinReadResult {
  item: SkinItem
  revision: string
  textureDataURL: string
  diagnostics: SkinDiagnostics
}
/** List responses deliberately contain no image URLs or image bytes. Read the selected item separately. */
export interface SkinLibraryPage { items: SkinSummary[]; total: number; offset: number; limit: number; tags: string[] }
export interface SkinMetadata { name: string; tags: string[]; model: SkinModel }
export interface SkinMutationInput extends SkinMetadata { operationId: string }
export interface SkinListOptions { query?: string; offset?: number; limit?: number; tag?: string; operationId?: string }
export interface SkinReadOptions { operationId?: string }
export interface SkinRemoveResult { itemId: string; removed: true }
export interface SkinExportResult { itemId: string; exported: boolean }
