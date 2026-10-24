import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, ArrowUpRight, Download, FolderOpen, Package, Search, Square } from 'lucide-react'
import { call, errorText, isDesktop, type Mod, type ModVersion, type Progress, type ResourceSource, type SearchResult } from '../api'
import { Dialog, EmptyState, ErrorBox, PageHeading, Spinner } from './ui'
import type { PackTask } from './DownloadsView'
import ResourceSourcePicker, { resourceProjectUrl, resourceSources } from './ResourceSourcePicker'
import ModpackPlan, { type CommitModpackPlan, type PreparedModpackPlan } from './ModpackPlan'
import { escapeWorldText } from './WorldDetails'
export type { PreparedModpackPlan, ModpackCommitOptions, ModpackCommitResult, CommitModpackPlan } from './ModpackPlan'

type Props = {
  source: ResourceSource
  setSource: (source: ResourceSource) => void
  tasks: PackTask[]
  progress: Record<string, Progress>
  /** Legacy callers may retain these props; this surface only commits prepared plans. */
  installOnline?: (versionId: string, name: string, source: ResourceSource) => Promise<void>
  importLocal?: (token: string, name: string) => Promise<void>
  commitPlan?: CommitModpackPlan
  cancel: (id: string) => Promise<void>
  showTasks: () => void
  openUrl: (url: string) => void
}
type Preparation = { operationId: string; source: 'local' | ResourceSource; label: string; stopped: boolean }
const count = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const safe = (value: string) => escapeWorldText(value)
function supportedGame(version: string) {
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(version)
  return match ? Number(match[1]) > 20 || (Number(match[1]) === 20 && Number(match[2] ?? 0) >= 1) : /^2[6-9]\.\d+(?:\.\d+)?$/.test(version)
}
function unsupported(version: ModVersion) {
  if (version.externalOnly) return version.externalReason || '此发布需要从官网获取，无法直接安装。'
  if (!version.loaders.some(loader => ['fabric', 'forge', 'neoforge', 'vanilla', 'minecraft'].includes(loader))) return `此发布使用 ${version.loaders.join(' / ') || '未知加载器'}，当前支持原版、Fabric、Forge 和 NeoForge 整合包。`
  if (!version.game_versions.some(supportedGame)) return '此发布的 Minecraft 版本暂不支持，请选择 1.20.1 及之后的正式版。'
  if (!version.files.some(file => file.filename.toLowerCase().endsWith('.mrpack'))) return '此发布不包含 .mrpack 文件，暂时无法安装。'
  return ''
}
function validPlan(value: PreparedModpackPlan, source: Preparation['source']) {
  return value.schema === 1 && typeof value.planId === 'string' && !!value.planId && value.source === source &&
    typeof value.preview?.name === 'string' && typeof value.preview.minecraftVersion === 'string' &&
    /^[a-f0-9]{128}$/i.test(value.archiveSha512) && typeof value.planDigest === 'string' && !!value.planDigest &&
    Array.isArray(value.defaultOptionalIds) && value.defaultOptionalIds.length <= 5000 && new Set(value.defaultOptionalIds).size === value.defaultOptionalIds.length &&
    value.defaultOptionalIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200) && Number.isFinite(Date.parse(value.expiresAt))
}

export default function ModpacksView(props: Props) {
  const { source, setSource } = props, sourceName = resourceSources[source].label
  const mounted = useRef(true), activePreparation = useRef<Preparation | undefined>(undefined)
  const [query, setQuery] = useState(''), [submitted, setSubmitted] = useState(''), [offset, setOffset] = useState(0)
  const [result, setResult] = useState<SearchResult | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [importError, setImportError] = useState(''), [preparation, setPreparation] = useState<Preparation>(), [stopping, setStopping] = useState(false)
  const [plan, setPlan] = useState<PreparedModpackPlan>(), [selected, setSelected] = useState<{ source: ResourceSource; pack: Mod }>()
  const active = props.tasks.find(task => task.status === 'active'), busy = Boolean(active || preparation)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; const current = activePreparation.current; if (current) { current.stopped = true; void call('cancelModpackPreparation', current.operationId).catch(() => {}) } }
  }, [])
  useEffect(() => {
    let current = true
    setLoading(true); setError(''); setResult(null)
    call<SearchResult>('searchModpacks', submitted, { source, offset }).then(value => { if (current) setResult(value) }).catch(failure => { if (current) setError(safe(errorText(failure))) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [source, submitted, offset, retry])
  const changeSource = (next: ResourceSource) => {
    if (next === source || activePreparation.current) return
    setSource(next); setOffset(0); setResult(null); setSelected(undefined); setError(''); setLoading(true)
  }
  const prepare = async (origin: Preparation['source'], pack?: Mod, versionId?: string) => {
    if (!isDesktop || activePreparation.current || active) return
    const operation: Preparation = { operationId: crypto.randomUUID(), source: origin, label: origin === 'local' ? '本地 .mrpack 文件' : `${pack?.title || '整合包'} · ${resourceSources[origin].label}`, stopped: false }
    activePreparation.current = operation; setPreparation(operation); setStopping(false); setImportError(''); setSelected(undefined); setPlan(undefined)
    try {
      const value = origin === 'local' ? await call<PreparedModpackPlan | null>('prepareModpackLocal', operation.operationId) :
        await call<PreparedModpackPlan>('prepareModpackOnline', origin, pack!.project_id, versionId!, operation.operationId)
      if (!mounted.current || activePreparation.current !== operation || operation.stopped || !value) return
      if (!validPlan(value, origin)) throw new Error('返回的整合包预览与本次来源不一致，请重新选择。')
      setPlan(value)
    } catch (failure) { if (mounted.current && activePreparation.current === operation && !operation.stopped) setImportError(safe(errorText(failure))) }
    finally { if (activePreparation.current === operation) { activePreparation.current = undefined; if (mounted.current) { setPreparation(undefined); setStopping(false) } } }
  }
  const stop = async () => {
    const current = activePreparation.current
    if (!current || current.stopped) return
    current.stopped = true; setStopping(true)
    try { await call('cancelModpackPreparation', current.operationId) }
    catch (failure) { if (mounted.current && activePreparation.current === current) setImportError(`停止请求未完成：${safe(errorText(failure))}`) }
    // Keep preparation and its controls reserved until the original promise settles.
  }
  return <>
    <PageHeading title="整合包" subtitle="先预览包内文件，再选择可选下载并创建独立实例。" action={<button className="button secondary" disabled={!isDesktop || busy} onClick={() => void prepare('local')}><FolderOpen size={16} />导入本地整合包</button>} />
    <ResourceSourcePicker source={source} change={changeSource} openUrl={props.openUrl} />
    <div className="inline-notice subtle"><Package size={17} /><span>可安装 Minecraft 1.20.1 及之后的原版、Fabric、Forge、NeoForge .mrpack 整合包，具体版本以加载器官方兼容元数据为准。暂不支持 CurseForge ZIP 或 Quilt。{source === 'bbsmc' && ' BBSMC 接入为实验性，仅符合以上条件的发布可安装。'}</span></div>
    {importError && <ErrorBox message={importError} />}
    {active && <div className="pack-active-banner"><Spinner size={16} /><span>正在安装：{active.name} · {active.source === 'local' ? '本地' : resourceSources[active.source].label}</span><button className="text-button" onClick={props.showTasks}>查看下载任务<ArrowRight size={15} /></button></div>}
    <form className="discover-search" onSubmit={event => { event.preventDefault(); setOffset(0); setSubmitted(query.trim()) }}><label className="search-field"><Search size={18} /><input aria-label={`搜索 ${sourceName} 整合包`} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索整合包名称或关键词" maxLength={200} /></label><button className="button primary">搜索<ArrowRight size={15} /></button></form>
    <div className="pack-results-heading"><span>{sourceName} 整合包</span>{result && !loading && !error && <span>{count(result.total_hits)} 个结果</span>}</div>
    {error ? <ErrorBox message={`${sourceName}：${error}`} retry={() => setRetry(value => value + 1)} /> : loading ? <div className="mod-grid" aria-label="正在加载整合包">{Array.from({ length: 6 }, (_, index) => <div className="mod-skeleton" key={index}><div /><span /><span /><span /></div>)}</div> : !result?.hits.length ? <EmptyState icon={<Package size={28} />} title="没有找到整合包">试试其他关键词，或导入本地 .mrpack 文件。</EmptyState> : <>
      <div className="mod-grid">{result.hits.map(pack => <article className="mod-card" key={`${source}-${pack.project_id}`}><div className="mod-heading">{pack.icon_url ? <img src={pack.icon_url} alt="" className="mod-icon" loading="lazy" referrerPolicy="no-referrer" /> : <span className="mod-icon fallback"><Package size={25} /></span>}<div><h3>{pack.title}</h3><p>by {pack.author}</p></div></div><p className="mod-description">{pack.description}</p><div className="mod-categories">{pack.categories.slice(0, 3).map(category => <span key={category}>{category}</span>)}</div><div className="mod-footer"><span><Download size={14} />{count(pack.downloads)}</span><div className="mod-actions"><button className="icon-button" aria-label={`在 ${sourceName} 查看 ${pack.title}`} onClick={() => props.openUrl(resourceProjectUrl(source, 'modpack', pack.slug))}><ArrowUpRight size={16} /></button><button className="button secondary small-button" disabled={busy} onClick={() => setSelected({ source, pack })}>选择版本</button></div></div></article>)}</div>
      <div className="pagination"><button className="button secondary" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - result.limit))}>上一页</button><span>第 {Math.floor(offset / result.limit) + 1} 页</span><button className="button secondary" disabled={offset + result.hits.length >= result.total_hits} onClick={() => setOffset(value => value + result.limit)}>下一页</button></div>
    </>}
    {selected && <OnlinePackDialog key={`${selected.source}-${selected.pack.project_id}`} source={selected.source} pack={selected.pack} close={() => setSelected(undefined)} busy={busy} prepare={(pack, versionId) => prepare(selected.source, pack, versionId)} openUrl={props.openUrl} />}
    {preparation && <Dialog title="正在准备整合包预览" close={() => void stop()}><div className="modpack-preparation"><p>{safe(preparation.label)}</p><div className="modpack-preparation-status" role="status"><Spinner size={17} />{stopping ? '正在停止，请等待实际文件与网络工作结束…' : preparation.source === 'local' ? '请选择整合包文件，随后检查归档与文件计划…' : '正在获取并检查所选归档，尚未创建实例…'}</div><p>这一步只准备整合包归档和文件预览；确认前不安装游戏、Java或模组文件。</p>{importError && <ErrorBox message={importError} />}<div className="modal-actions"><button type="button" className="button secondary" disabled={stopping} onClick={() => void stop()}>{stopping ? <Spinner size={15} /> : <Square size={14} />}{stopping ? '正在停止' : '停止预览准备'}</button></div></div></Dialog>}
    {plan && <ModpackPlan key={plan.planId} plan={plan} close={() => setPlan(undefined)} commitPlan={props.commitPlan} tasks={props.tasks} progress={props.progress} cancel={props.cancel} showTasks={props.showTasks} />}
  </>
}

function OnlinePackDialog({ source, pack, close, busy, prepare, openUrl }: { source: ResourceSource; pack: Mod; close: () => void; busy: boolean; prepare: (pack: Mod, versionId: string) => Promise<void>; openUrl: Props['openUrl'] }) {
  const sourceName = resourceSources[source].label
  const [versions, setVersions] = useState<ModVersion[]>([]), [versionId, setVersionId] = useState(''), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    setLoading(true); setError(''); setVersions([]); setVersionId('')
    call<ModVersion[]>('modpackVersions', pack.project_id, source).then(value => { if (current) { setVersions(value); setVersionId(value.find(version => !unsupported(version))?.id || value[0]?.id || '') } }).catch(failure => { if (current) setError(safe(errorText(failure))) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [source, pack.project_id, retry])
  const selected = versions.find(version => version.id === versionId), reason = selected ? unsupported(selected) : ''
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy && !loading && selected && !reason && isDesktop) void prepare(pack, selected.id) }
  return <Dialog title={`选择 ${safe(pack.title)} 的发布版本`} close={close}><form onSubmit={submit}>
    <p className="modal-description">来源：{sourceName}{source === 'bbsmc' ? '（实验性）' : ''}。下一步先下载整合包归档并预览文件，不立即创建实例。</p>
    <label className="field"><span>整合包版本 {loading && <Spinner size={14} />}</span><select value={versionId} disabled={loading || busy} onChange={event => { setVersionId(event.target.value); setError('') }}>{loading ? <option value="">正在读取发布版本…</option> : versions.length ? versions.map(version => <option value={version.id} key={version.id}>{version.name} · {version.game_versions.join(', ')} · {version.loaders.join(', ')}</option>) : <option value="">没有可用发布</option>}</select></label>
    {selected && <p className="form-hint">Minecraft {selected.game_versions.join(' / ')} · {selected.loaders.join(' / ')}。预览会从所选发布中核对唯一主归档；多个主文件不明确时会停止，不自动选第一项。</p>}
    {reason && <ErrorBox message={safe(reason)} />}{!isDesktop && <div className="inline-notice">文件预览与安装需要桌面版。此处可以查看发布声明。</div>}{error && <ErrorBox message={`${sourceName}：${error}`} retry={!versions.length ? () => setRetry(value => value + 1) : undefined} />}
    <div className="modal-actions"><button type="button" className="button secondary" onClick={close}>关闭</button>{(reason || error) && <button type="button" className="button secondary" onClick={() => openUrl(resourceProjectUrl(source, 'modpack', pack.slug))}>官网获取<ArrowUpRight size={16} /></button>}<button className="button primary" disabled={!isDesktop || busy || loading || !selected || Boolean(reason)}>预览文件与选择<ArrowRight size={16} /></button></div>
  </form></Dialog>
}
