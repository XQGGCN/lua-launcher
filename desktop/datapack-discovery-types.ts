/** Public Modrinth metadata only. No archive bytes, private paths or install authorization. */
export interface DatapackCatalogHit {
  projectId: string
  slug: string
  title: string
  description: string
  author: string
  downloads: number
  projectTypes: string[]
  projectUrl: string
}
export interface DatapackCatalogSearch {
  hits: DatapackCatalogHit[]
  totalHits: number
  offset: number
  limit: number
  omittedHits: number
}
export interface DatapackCatalogProject {
  projectId: string
  slug: string
  title: string
  description: string
  projectTypes: string[]
  projectUrl: string
}
export interface DatapackCatalogFile {
  filename: string
  primary: boolean
  role: 'main' | 'required-resource-pack' | 'optional-resource-pack' | 'other'
  size?: number
  sha512?: string
  sha1?: string
  /** File metadata alone never proves a complete or game-compatible ZIP. */
  eligible: boolean
  reason?: string
}
export interface DatapackCatalogDependency {
  type: 'required' | 'optional' | 'incompatible' | 'embedded'
  projectId?: string
  versionId?: string
  filename?: string
}
export interface DatapackCatalogVersion {
  id: string
  projectId: string
  name: string
  versionNumber: string
  datePublished: string
  releaseType: 'release' | 'beta' | 'alpha'
  gameVersions: string[]
  loaders: string[]
  declaresCurrentGameVersion: boolean
  declaresDatapack: boolean
  files: DatapackCatalogFile[]
  dependencies: DatapackCatalogDependency[]
  mainFile?: DatapackCatalogFile
  externalOnly: boolean
  reasons: string[]
  warnings: string[]
}
export interface DatapackCatalogVersions {
  project: DatapackCatalogProject
  versions: DatapackCatalogVersion[]
  upstreamVersionCount: number
  omittedVersions: number
}
export interface WorldDatapackSearch extends DatapackCatalogSearch {
  instanceId: string
  world: { itemId: string; name: string }
  revision: string
  gameVersion: string
}
export interface WorldDatapackVersions extends DatapackCatalogVersions {
  instanceId: string
  world: { itemId: string; name: string }
  revision: string
  gameVersion: string
}
