import { ArrowUpRight } from 'lucide-react'
import type { ResourceSource } from '../api'

export const resourceSources: Record<ResourceSource, { label: string; website: string }> = {
  modrinth: { label: 'Modrinth', website: 'https://modrinth.com' },
  bbsmc: { label: 'BBSMC', website: 'https://bbsmc.net' },
}

export function resourceProjectUrl(source: ResourceSource, kind: 'mod' | 'modpack', slug: string) {
  return `${resourceSources[source].website}/${kind}/${encodeURIComponent(slug)}`
}

export default function ResourceSourcePicker({ source, change, openUrl }: {
  source: ResourceSource
  change: (source: ResourceSource) => void
  openUrl: (url: string) => void
}) {
  return <div className="resource-source-toolbar">
    <div className="resource-source-options"><span className="resource-source-label">资源来源</span><div className="segmented" role="group" aria-label="资源来源">
      {(['modrinth', 'bbsmc'] as const).map(item => <button type="button" key={item} className={source === item ? 'selected' : ''} aria-pressed={source === item} onClick={() => change(item)}>{resourceSources[item].label}{item === 'bbsmc' && <span className="experimental-tag">实验性</span>}</button>)}
    </div></div>
    <button type="button" className="text-button" onClick={() => openUrl(resourceSources[source].website)}>打开 {resourceSources[source].label} 官网<ArrowUpRight size={15} /></button>
  </div>
}
