import type { ParsedModpack } from './modpack'
import { createModpackPlan, applyOptionalSelection } from './modpack-plan'
export interface PackSelectionRecord { schema: 1; archiveSha512: string; planDigest: string; selectedOptionalIds: string[] }
/** Missing records retain legacy-all. Present but unknown/damaged records never fall back. */
export function applySavedPackSelection(pack: ParsedModpack, value: unknown): ParsedModpack {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== ['schema','archiveSha512','planDigest','selectedOptionalIds'].sort().join(',')) throw new Error('保存的整合包选择记录无效，请重新预览')
  const record = value as PackSelectionRecord, plan = createModpackPlan(pack)
  if (record.schema !== 1 || record.archiveSha512 !== plan.summary.archiveSha512 || record.planDigest !== plan.summary.planDigest) throw new Error('保存的整合包选择版本或规划摘要不匹配，请重新预览')
  return applyOptionalSelection(plan, record.selectedOptionalIds)
}
