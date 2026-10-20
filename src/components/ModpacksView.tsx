import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, ArrowUpRight, Download, FolderOpen, Package, Search, Square } from 'lucide-react'
import { call, errorText, isDesktop, loaderNames, type ChosenModpack, type Mod, type ModVersion, type Progress, type ResourceSource, type SearchResult } from '../api'
import { bytes, Dialog, EmptyState, ErrorBox, PageHeading, percent, Spinner } from './ui'
import type { PackTask } from './DownloadsView'
import ResourceSourcePicker, { resourceProjectUrl, resourceSources } from './ResourceSourcePicker'

type Props = {
  source: ResourceSource
  setSource: (source: ResourceSource) => void
  tasks: PackTask[]
  progress: Record<string, Progress>
  installOnline: (versionId: string, name: string, source: ResourceSource) => Promise<void>
  importLocal: (token: string, name: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  showTasks: () => void
  openUrl: (url: string) => void
}
const count = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
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

export default function ModpacksView(props: Props) {
  const { source, setSource } = props
  const sourceName = resourceSources[source].label
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [importError, setImportError] = useState('')
  const [retry, setRetry] = useState(0)
  const [choosing, setChoosing] = useState(false)
  const [chosen, setChosen] = useState<ChosenModpack | null>(null)
  const [selected, setSelected] = useState<Mod | null>(null)
  const active = props.tasks.find(task => task.status === 'active')
  useEffect(() => {
    let current = true
    setLoading(true); setError(''); setResult(null)
    call<SearchResult>('searchModpacks', submitted, { source, offset }).then(result => { if (current) setResult(result) }).catch(error => { if (current) setError(errorText(error)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [source, submitted, offset, retry])
  const changeSource = (next: ResourceSource) => {
    if (next === source) return
    setSource(next); setOffset(0); setResult(null); setSelected(null); setError(''); setLoading(true)
  }
  const choose = async () => {
    setChoosing(true); setImportError('')
    try { const result = await call<ChosenModpack | null>('chooseModpack'); if (result) setChosen(result) }
    catch (error) { setImportError(errorText(error)) }
    finally { setChoosing(false) }
  }
  return <>
    <PageHeading title="整合包" subtitle="从资源站安装整合包，或导入本地 .mrpack 文件。" action={<button className="button secondary" disabled={!isDesktop || choosing || Boolean(active)} onClick={() => void choose()}>{choosing ? <Spinner size={16} /> : <FolderOpen size={16} />}导入本地整合包</button>} />
    <ResourceSourcePicker source={source} change={changeSource} openUrl={props.openUrl} />
    <div className="inline-notice subtle"><Package size={17} /><span>可安装 Minecraft 1.20.1 及之后的原版、Fabric、Forge、NeoForge .mrpack 整合包，具体版本以加载器官方兼容元数据为准。暂不支持 CurseForge ZIP 或 Quilt。{source === 'bbsmc' && ' BBSMC 接入为实验性，仅符合以上条件的发布可安装。'}</span></div>
    {importError && <ErrorBox message={importError} retry={() => void choose()} />}
    {active && <div className="pack-active-banner"><Spinner size={16} /><span>正在安装：{active.name} · {active.source === 'local' ? '本地' : resourceSources[active.source].label}</span><button className="text-button" onClick={props.showTasks}>查看下载任务<ArrowRight size={15} /></button></div>}
    <form className="discover-search" onSubmit={event => { event.preventDefault(); setOffset(0); setSubmitted(query.trim()) }}><label className="search-field"><Search size={18} /><input aria-label={`搜索 ${sourceName} 整合包`} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索整合包名称或关键词" /></label><button className="button primary">搜索<ArrowRight size={15} /></button></form>
    <div className="pack-results-heading"><span>{sourceName} 整合包</span>{result && !loading && !error && <span>{count(result.total_hits)} 个结果</span>}</div>
    {error ? <ErrorBox message={`${sourceName}：${error}`} retry={() => setRetry(value => value + 1)} /> : loading ? <div className="mod-grid" aria-label="正在加载整合包">{Array.from({ length: 6 }, (_, index) => <div className="mod-skeleton" key={index}><div /><span /><span /><span /></div>)}</div> : !result?.hits.length ? <EmptyState icon={<Package size={28} />} title="没有找到整合包">试试其他关键词，或导入本地 .mrpack 文件。</EmptyState> : <>
      <div className="mod-grid">{result.hits.map(pack => <article className="mod-card" key={`${source}-${pack.project_id}`}><div className="mod-heading">{pack.icon_url ? <img src={pack.icon_url} alt="" className="mod-icon" loading="lazy" referrerPolicy="no-referrer" /> : <span className="mod-icon fallback"><Package size={25} /></span>}<div><h3>{pack.title}</h3><p>by {pack.author}</p></div></div><p className="mod-description">{pack.description}</p><div className="mod-categories">{pack.categories.slice(0, 3).map(category => <span key={category}>{category}</span>)}</div><div className="mod-footer"><span><Download size={14} />{count(pack.downloads)}</span><div className="mod-actions"><button className="icon-button" aria-label={`在 ${sourceName} 查看 ${pack.title}`} onClick={() => props.openUrl(resourceProjectUrl(source, 'modpack', pack.slug))}><ArrowUpRight size={16} /></button><button className="button secondary small-button" disabled={Boolean(active)} onClick={() => setSelected(pack)}>选择版本</button></div></div></article>)}</div>
      <div className="pagination"><button className="button secondary" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - result.limit))}>上一页</button><span>第 {Math.floor(offset / result.limit) + 1} 页</span><button className="button secondary" disabled={offset + result.hits.length >= result.total_hits} onClick={() => setOffset(value => value + result.limit)}>下一页</button></div>
    </>}
    {chosen && <LocalPackDialog chosen={chosen} close={() => setChosen(null)} {...props} />}
    {selected && <OnlinePackDialog key={`${source}-${selected.project_id}`} pack={selected} close={() => setSelected(null)} {...props} />}
  </>
}

function PackTaskProgress({ task, progress, cancel, showTasks }: { task: PackTask; progress: Record<string, Progress>; cancel: Props['cancel']; showTasks: () => void }) {
  const current = progress[task.instanceId || task.id]
  const [error, setError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  return <div className="pack-install-progress">
    <div className="download-meta"><span>{current?.phase || (task.instanceId ? '正在安装游戏与整合包文件…' : '正在获取整合包…')}</span><span>{percent(current)}%</span></div>
    <progress value={current?.total ? percent(current) : undefined} max="100" aria-label="整合包安装进度" />
    <div className="pack-progress-actions"><button type="button" className="text-button" onClick={showTasks}>查看全部任务<ArrowRight size={15} /></button><button type="button" className="button secondary" disabled={cancelling || (!task.instanceId && !task.id.startsWith('modpack-'))} onClick={() => { setCancelling(true); cancel(task.instanceId || task.id).catch(error => setError(errorText(error))).finally(() => setCancelling(false)) }}>{cancelling ? <Spinner size={14} /> : <Square size={13} />}取消安装</button></div>
    <p className="form-hint pack-background-hint">关闭此窗口后，安装会继续，可在下载任务中查看进度。</p>
    {error && <ErrorBox message={error} />}
  </div>
}
function LocalPackDialog({ chosen, close, ...props }: Props & { chosen: ChosenModpack; close: () => void }) {
  const { preview, token } = chosen
  const [name, setName] = useState(preview.name.slice(0, 60))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const task = props.tasks.find(task => task.id === `localpack-${token}`)
  const active = saving || task?.status === 'active'
  const hasFailedInstance = Boolean(task && ['error', 'cancelled'].includes(task.status) && task.instanceId)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (hasFailedInstance) { props.showTasks(); close(); return }
    if (active || preview.unsupportedReason || !isDesktop) return
    setSaving(true); setError('')
    try { await props.importLocal(token, name.trim() || preview.name); close() }
    catch (error) { setError(errorText(error)) }
    finally { setSaving(false) }
  }
  return <Dialog title="导入整合包" close={close}>
    <p className="modal-description">确认整合包信息后，将新建独立实例并下载所需文件。</p>
    <div className="pack-preview"><h3>{preview.name}</h3>{preview.summary && <p>{preview.summary}</p>}<dl><dt>整合包版本</dt><dd>{preview.versionId}</dd><dt>Minecraft</dt><dd>{preview.minecraftVersion}</dd><dt>加载器</dt><dd>{loaderNames[preview.loader]}{preview.loaderVersion ? ` ${preview.loaderVersion}` : ''}</dd><dt>待下载文件</dt><dd>{preview.fileCount} 个 · {bytes(preview.totalBytes)}</dd></dl></div>
    {Boolean(preview.optionalFileCount) && <p className="form-hint">包含 {preview.optionalFileCount} 个可选客户端文件，将一并安装。</p>}
    <form onSubmit={event => void submit(event)}><label className="field"><span>实例名称</span><input value={name} onChange={event => setName(event.target.value)} maxLength={60} required disabled={active} /></label>
      {preview.unsupportedReason && <ErrorBox message={preview.unsupportedReason} />}
      {error && <ErrorBox message={error} />}
      {active && task ? <PackTaskProgress task={task} progress={props.progress} cancel={props.cancel} showTasks={() => { close(); props.showTasks() }} /> : <div className="modal-actions"><button type="button" className="button secondary" onClick={close}>关闭</button><button className="button primary" disabled={active || Boolean(preview.unsupportedReason) || !isDesktop}>{active ? <Spinner size={16} /> : <Download size={16} />}{hasFailedInstance ? '前往任务重试' : '确认并安装'}</button></div>}
    </form>
  </Dialog>
}
function OnlinePackDialog({ source, pack, close, ...props }: Props & { source: ResourceSource; pack: Mod; close: () => void }) {
  const sourceName = resourceSources[source].label
  const [versions, setVersions] = useState<ModVersion[]>([])
  const [versionId, setVersionId] = useState('')
  const [name, setName] = useState(pack.title.slice(0, 60))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const taskId = source === 'bbsmc' ? `modpack-bbsmc-${versionId}` : `modpack-${versionId}`
  const task = props.tasks.find(task => task.id === taskId && task.source === source)
  const active = saving || task?.status === 'active'
  const hasFailedInstance = Boolean(task && ['error', 'cancelled'].includes(task.status) && task.instanceId)
  useEffect(() => {
    let current = true
    setLoading(true); setError(''); setVersions([]); setVersionId('')
    call<ModVersion[]>('modpackVersions', pack.project_id, source).then(versions => { if (current) { setVersions(versions); setVersionId(versions.find(version => !unsupported(version))?.id || versions[0]?.id || '') } }).catch(error => { if (current) setError(errorText(error)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [source, pack.project_id, retry])
  const selected = versions.find(version => version.id === versionId)
  const reason = selected ? unsupported(selected) : ''
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (hasFailedInstance) { props.showTasks(); close(); return }
    if (active || loading || !selected || reason || !isDesktop) return
    setSaving(true); setError('')
    try { await props.installOnline(versionId, name.trim() || pack.title, source); close() }
    catch (error) { setError(errorText(error)) }
    finally { setSaving(false) }
  }
  return <Dialog title={`安装 ${pack.title}`} close={close}><form onSubmit={event => void submit(event)}>
    <p className="modal-description">来源：{sourceName}{source === 'bbsmc' ? '（实验性）' : ''}。选择发布版本，启动器会检查整合包格式与游戏版本兼容性。</p>
    <label className="field"><span>整合包版本 {loading && <Spinner size={14} />}</span><select value={versionId} disabled={loading || active} onChange={event => { setVersionId(event.target.value); setError('') }}>{loading ? <option value="">正在读取发布版本…</option> : versions.length ? versions.map(version => <option value={version.id} key={version.id}>{version.name} · {version.game_versions.join(', ')} · {version.loaders.join(', ')}</option>) : <option value="">没有可用发布</option>}</select></label>
    {selected && <p className="form-hint">Minecraft {selected.game_versions.join(' / ')} · {selected.loaders.join(' / ')} · 整合包文件 {bytes((selected.files.find(file => file.primary) || selected.files[0])?.size || 0)}，安装时还需下载游戏与模组。</p>}
    <label className="field"><span>实例名称</span><input value={name} onChange={event => setName(event.target.value)} maxLength={60} required disabled={active} /></label>
    {reason && <ErrorBox message={reason} />}
    {!isDesktop && <div className="inline-notice">整合包安装需要桌面版。此处可以查看版本和兼容性。</div>}
    {error && <ErrorBox message={`${sourceName}：${error}`} retry={!versions.length ? () => setRetry(value => value + 1) : undefined} />}
    {active && task ? <PackTaskProgress task={task} progress={props.progress} cancel={props.cancel} showTasks={() => { close(); props.showTasks() }} /> : <div className="modal-actions"><button type="button" className="button secondary" onClick={close}>关闭</button>{(reason || error) && <button type="button" className="button secondary" onClick={() => props.openUrl(resourceProjectUrl(source, 'modpack', pack.slug))}>官网获取<ArrowUpRight size={16} /></button>}<button className="button primary" disabled={!isDesktop || active || loading || !versionId || Boolean(reason)}>{active ? <Spinner size={16} /> : <Download size={16} />}{hasFailedInstance ? '前往任务重试' : '下载并安装'}</button></div>}
  </form></Dialog>
}
