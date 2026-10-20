import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowUpRight, Check, Download, FolderOpen, Image, Package, Search, Square, Sun } from 'lucide-react'
import { call, errorText, isDesktop, type Instance, type Mod, type Progress, type ResourceInstallInput, type ResourceInstallReceipt, type ResourceKind, type ResourceSource, type ResourceVersion, type ResourceSearchResult } from '../api'
import ResourceSourcePicker, { resourceSources } from './ResourceSourcePicker'
import { bytes, Dialog, ErrorBox, PageHeading, percent, Spinner } from './ui'
import './ResourcesView.css'

export interface ResourceInstallTask {
  id: string
  instanceId: string
  instanceName: string
  title: string
  kind: ResourceKind
  source: ResourceSource
  versionId: string
  filename: string
  status: 'active' | 'complete' | 'cancelled' | 'error'
  error?: string
  result?: ResourceInstallReceipt
}
type Props = {
  source: ResourceSource
  setSource: (source: ResourceSource) => void
  instances: Instance[]
  tasks: ResourceInstallTask[]
  progress: Record<string, Progress>
  install: (instanceId: string, input: ResourceInstallInput) => Promise<void>
  cancel: (task: ResourceInstallTask) => Promise<void>
  showContent: (id: string, kind?: ResourceKind) => void
  openUrl: (url: string) => void
}
const kindNames: Record<ResourceKind, string> = { resourcepack: '资源包', shader: '光影包' }
const folders: Record<ResourceKind, string> = { resourcepack: 'game/resourcepacks', shader: 'game/shaderpacks' }
const statusNames: Record<Instance['status'], string> = { ready: '已安装', running: '运行中，请先关闭游戏', installing: '正在安装', 'not-installed': '尚未安装', error: '安装未完成' }
const dependencyNames: Record<string, string> = { required: '必需', optional: '可选', incompatible: '不兼容', embedded: '已内嵌' }
const kinds: ResourceKind[] = ['resourcepack', 'shader']
const projectUrl = (source: ResourceSource, kind: ResourceKind, project: Mod) => `${resourceSources[source].website}/${kind}/${encodeURIComponent(project.slug || project.project_id)}`
const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value)

export default function ResourcesView(props: Props) {
  const [kind, setKind] = useState<ResourceKind>('resourcepack')
  return <section className="resources-view">
    <PageHeading title="资源包与光影" subtitle="选择发布版本，将 ZIP 放入指定实例。安装后仍需在游戏中启用。" />
    <ResourceSourcePicker source={props.source} change={props.setSource} openUrl={props.openUrl} />
    <ResourceBrowser key={props.source} {...props} kind={kind} setKind={setKind} />
    {props.tasks.length > 0 && <section className="resource-session-tasks" aria-label="本次资源安装任务"><h2>本次安装任务</h2><ResourceTaskList tasks={props.tasks} progress={props.progress} cancel={props.cancel} showContent={props.showContent} /></section>}
  </section>
}

function ResourceBrowser(props: Props & { kind: ResourceKind; setKind: (kind: ResourceKind) => void }) {
  const { source, instances, kind, setKind } = props
  const id = useId()
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [filterId, setFilterId] = useState('')
  const [offset, setOffset] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; data: ResourceSearchResult } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [selected, setSelected] = useState<Mod | null>(null)
  const selectedFilter = instances.find(instance => instance.id === filterId && instance.status === 'ready')
  const gameVersion = selectedFilter?.version
  const key = JSON.stringify([source, kind, submitted, gameVersion, offset, attempt])
  const requestKey = useRef(key)
  const request = useRef(0)
  requestKey.current = key
  const data = result?.key === key ? result.data : null
  const error = failure?.key === key ? failure.message : ''
  const loading = !data && !error

  useEffect(() => {
    const ticket = ++request.current
    void call<ResourceSearchResult>('searchResources', submitted, { kind, source, gameVersion, offset })
      .then(data => { if (ticket === request.current && requestKey.current === key) setResult({ key, data }) })
      .catch(error => { if (ticket === request.current && requestKey.current === key) setFailure({ key, message: errorText(error) }) })
    return () => { ++request.current }
  }, [key, source, kind, submitted, gameVersion, offset])
  useEffect(() => {
    if (filterId && !selectedFilter) { setFilterId(''); setOffset(0) }
  }, [filterId, selectedFilter])

  const selectKind = (next: ResourceKind) => { setKind(next); setOffset(0); setSelected(null) }
  const tabKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? kinds.length - 1 : (kinds.indexOf(kind) + (event.key === 'ArrowRight' ? 1 : -1) + kinds.length) % kinds.length
    selectKind(kinds[index]); document.getElementById(`${id}-${kinds[index]}`)?.focus()
  }
  const submit = (event: FormEvent) => { event.preventDefault(); setOffset(0); setSubmitted(query.trim()); setAttempt(value => value + 1) }
  return <>
    <div className="resource-kind-tabs" role="tablist" aria-label="资源类型">{kinds.map(item => <button type="button" role="tab" key={item} id={`${id}-${item}`} aria-controls={`${id}-results`} aria-selected={kind === item} tabIndex={kind === item ? 0 : -1} onKeyDown={tabKeys} onClick={() => selectKind(item)}>{item === 'resourcepack' ? <Image size={16} /> : <Sun size={16} />}{kindNames[item]}</button>)}</div>
    <p className="resource-context-note">{kind === 'shader' ? '光影需要实例中已有 Iris 或 OptiFine。Lua 不检测或安装光影引擎；Canvas 或仅原版专用发布需前往官网处理。' : '资源包以原始 ZIP 保存，不解压、不修改游戏选项。发布方标注的版本匹配不代表所有内容组合都兼容。'}{source === 'bbsmc' && ' BBSMC 为实验性来源，部分发布需从官网获取。'}</p>
    {!isDesktop && <p className="resource-preview-note">浏览器预览可查询真实资源。安装和本机目录操作需要桌面版，不会生成已安装记录。</p>}
    <form className="resource-search-form" onSubmit={submit}>
      <label className="resource-search"><Search size={17} /><input aria-label={`搜索 ${resourceSources[source].label} ${kindNames[kind]}`} placeholder={`搜索${kindNames[kind]}名称或关键词`} maxLength={200} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <button type="submit" className="button primary">搜索</button>
      <label className="resource-version-filter"><span>按实例版本筛选</span><select value={selectedFilter ? filterId : ''} onChange={event => { setFilterId(event.target.value); setOffset(0); setSelected(null) }}><option value="">全部游戏版本</option>{instances.filter(instance => instance.status === 'ready').map(instance => <option key={instance.id} value={instance.id}>{instance.name} · {instance.version}</option>)}</select></label>
    </form>
    <div id={`${id}-results`} role="tabpanel" aria-labelledby={`${id}-${kind}`} tabIndex={0}>
      <div className="resource-result-heading"><span>{resourceSources[source].label} · {kindNames[kind]}{gameVersion ? ` · Minecraft ${gameVersion}` : ''}</span>{data && <span>{number(data.total_hits)} 个结果</span>}</div>
      {Boolean(data?.omittedHits) && <p className="resource-context-note">来源在本页混入了 {data!.omittedHits} 个其他类型的项目，已略过；结果总数与分页仍按来源索引计算。</p>}
      {error ? <ErrorBox message={`${resourceSources[source].label}：${error}`} retry={() => setAttempt(value => value + 1)} /> : loading ? <div className="resource-placeholder" role="status"><Spinner /><span>正在读取{kindNames[kind]}…</span></div> : !data?.hits.length ? <div className="resource-placeholder"><Package size={24} /><h3>{data?.omittedHits ? `本页没有可展示的${kindNames[kind]}` : `没有找到${kindNames[kind]}`}</h3><p>{data?.omittedHits ? '可翻到下一页，或更换关键词与游戏版本筛选。' : '试试其他关键词，或取消游戏版本筛选。'}</p></div> : <>
        <div className="resource-results">{data.hits.map(project => <article className="resource-result-row" key={project.project_id}>
          {project.icon_url ? <img className="resource-project-icon" src={project.icon_url} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Package size={28} className="resource-project-fallback" />}
          <div className="resource-project-copy"><h3>{project.title}</h3><p className="resource-author">{project.author} · {number(project.downloads)} 次下载</p><p>{project.description}</p></div>
          <div className="resource-project-actions"><button type="button" className="button secondary" onClick={() => setSelected(project)}>选择版本</button><button type="button" className="text-button" onClick={() => props.openUrl(projectUrl(source, kind, project))}>官网<ArrowUpRight size={14} /></button></div>
        </article>)}</div>
      </>}
      {data && <div className="resource-pagination"><button type="button" className="button secondary" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - data.limit))}>上一页</button><span>第 {Math.floor(offset / data.limit) + 1} 页</span><button type="button" className="button secondary" disabled={offset + data.limit >= data.total_hits} onClick={() => setOffset(value => value + data.limit)}>下一页</button></div>}
    </div>
    {selected && <ResourceInstallDialog key={`${source}:${kind}:${selected.project_id}`} {...props} kind={kind} project={selected} close={() => setSelected(null)} />}
  </>
}

function ResourceInstallDialog({ kind, project, close, ...props }: Props & { kind: ResourceKind; project: Mod; close: () => void }) {
  const [instanceId, setInstanceId] = useState('')
  const [versionId, setVersionId] = useState('')
  const [versions, setVersions] = useState<{ key: string; data: ResourceVersion[] } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [installError, setInstallError] = useState('')
  const [complete, setComplete] = useState(false)
  const sequence = useRef(0)
  const savingLock = useRef(false)
  const mounted = useRef(true)
  const target = props.instances.find(instance => instance.id === instanceId)
  const ready = target?.status === 'ready'
  const key = JSON.stringify([props.source, kind, project.project_id, instanceId, target?.version, ready, attempt])
  const requestKey = useRef(key)
  requestKey.current = key
  const currentVersions = versions?.key === key ? versions.data : []
  const selected = currentVersions.find(version => version.id === versionId)
  const loadError = failure?.key === key ? failure.message : ''
  const loading = Boolean(instanceId && ready && versions?.key !== key && !loadError)
  const active = props.tasks.find(task => task.instanceId === instanceId && task.status === 'active')
  const website = selected?.projectUrl || projectUrl(props.source, kind, project)
  const externalReason = selected?.externalOnly ? selected.externalReason || '此发布不能直接安装，请前往官网获取。' : ''
  const missingFile = selected && (!selected.filename || !selected.sha512)
  const canInstall = isDesktop && ready && Boolean(selected) && !loading && !externalReason && !missingFile && !saving && !active && !complete

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++sequence.current }
  }, [])
  useEffect(() => {
    const ticket = ++sequence.current
    if (!instanceId || !ready) return
    void call<ResourceVersion[]>('resourceVersions', project.project_id, instanceId, kind, props.source)
      .then(data => {
        if (ticket !== sequence.current || requestKey.current !== key) return
        setVersions({ key, data }); setVersionId((data.find(version => !version.externalOnly) || data[0])?.id || '')
      })
      .catch(error => { if (ticket === sequence.current && requestKey.current === key) setFailure({ key, message: errorText(error) }) })
    return () => { ++sequence.current }
  }, [key, instanceId, ready, props.source, kind, project.project_id])

  const startInstall = async () => {
    if (!canInstall || !selected?.filename || !selected.sha512 || savingLock.current) return
    savingLock.current = true; setSaving(true); setInstallError(''); setComplete(false)
    try {
      await props.install(instanceId, { kind, source: props.source, projectId: selected.projectId, versionId: selected.id, filename: selected.filename, sha512: selected.sha512 })
      if (mounted.current) setComplete(true)
    } catch (error) { if (mounted.current) setInstallError(errorText(error)) }
    finally { savingLock.current = false; if (mounted.current) setSaving(false) }
  }
  const changeInstance = (next: string) => { setInstanceId(next); setVersionId(''); setVersions(null); setFailure(null); setInstallError(''); setComplete(false) }
  return <Dialog title={`安装${kindNames[kind]}`} close={close}>
    <div className="resource-install-dialog">
      <p className="resource-dialog-project">{project.title}<small>{resourceSources[props.source].label}{props.source === 'bbsmc' ? ' · 实验性' : ''}</small></p>
      <label className="field"><span>目标实例</span><select value={instanceId} onChange={event => changeInstance(event.target.value)} disabled={saving}><option value="">请选择要安装到的实例</option>{props.instances.map(instance => { const busy = props.tasks.some(task => task.instanceId === instance.id && task.status === 'active'); return <option key={instance.id} value={instance.id} disabled={instance.status !== 'ready' || busy}>{instance.name} · {instance.version}{busy ? ' · 正在安装资源' : instance.status !== 'ready' ? ` · ${statusNames[instance.status]}` : ''}</option> })}</select><small>必须选择已安装且游戏已关闭的实例。浏览页筛选不会替你选择安装目标。</small></label>
      {!props.instances.some(instance => instance.status === 'ready') && <p className="resource-context-note">目前没有可安装的目标。请先完成实例安装，并关闭正在运行的游戏。</p>}
      {target && <p className="resource-target">目标：<strong>{target.name}</strong><code>{folders[kind]}</code></p>}
      {target && !ready && !saving && !active && <ErrorBox message={`目标实例${statusNames[target.status]}，目前不能安装。`} />}
      {instanceId && ready && <label className="field"><span>发布版本 {loading && <Spinner size={14} />}</span><select value={selected?.id || ''} disabled={loading || saving || Boolean(active) || !currentVersions.length} onChange={event => { setVersionId(event.target.value); setInstallError(''); setComplete(false) }}>{!currentVersions.length ? <option value="">{loading ? '正在读取兼容发布…' : loadError ? '版本读取失败' : '没有匹配的发布版本'}</option> : currentVersions.map(version => <option key={version.id} value={version.id}>{version.name}{version.externalOnly ? ' · 官网获取' : ''}</option>)}</select></label>}
      {loadError && <ErrorBox message={loadError} retry={() => setAttempt(value => value + 1)} />}
      {selected && <>
        <dl className="resource-file-details"><dt>游戏版本</dt><dd>{selected.gameVersions.join(' / ') || '来源未提供'}</dd><dt>{kind === 'shader' ? '光影引擎标注' : '加载器标注'}</dt><dd>{selected.loaders.join(' / ') || '来源未提供'}</dd><dt>文件</dt><dd>{selected.filename || '没有可直接安装的文件'}</dd><dt>大小</dt><dd>{selected.size === undefined ? '来源未提供' : bytes(selected.size)}</dd><dt>校验</dt><dd>{selected.sha512 ? <details className="resource-checksum"><summary>查看 SHA-512</summary><code>{selected.sha512}</code></details> : '未提供 SHA-512'}</dd></dl>
        <details className="resource-dependencies"><summary>发布方声明的依赖（{selected.dependencies.length}）</summary>{selected.dependencies.length ? <ul>{selected.dependencies.map((dependency, index) => <li key={index}><strong>{dependencyNames[dependency.type] || dependency.type}</strong><span>{dependency.filename || dependency.projectId || dependency.versionId || '未提供名称或 ID'}</span>{dependency.versionId && <small>版本 ID：{dependency.versionId}</small>}</li>)}</ul> : <p>此发布没有声明依赖；这不等于 Lua 已检查全部运行要求。</p>}<p>不会自动安装依赖。必需或不兼容依赖无法安全处理时，只提供官网入口。</p></details>
      </>}
      <p className="resource-context-note">{kind === 'shader' ? '仅支持供 Iris / OptiFine 使用的光影 ZIP；不会检测或安装引擎。' : '资源 ZIP 将原样保存。'}放入目录不等于已启用，请在游戏内选择。已有不同版本或同名冲突需手动处理，本次不会自动更新、覆盖或修改 options。</p>
      {!isDesktop && <p className="resource-preview-note">当前为浏览器预览，安装需使用桌面版。</p>}
      {externalReason && <ErrorBox message={externalReason} />}
      {missingFile && !externalReason && <ErrorBox message="此发布缺少可安装文件或 SHA-512 校验值，请前往官网获取。" />}
      {installError && <ErrorBox message={installError} retry={canInstall ? () => void startInstall() : undefined} />}
      {active && <ResourceTaskList tasks={[active]} progress={props.progress} cancel={props.cancel} showContent={props.showContent} />}
      {complete && <div className="resource-install-complete" role="status"><Check size={17} /><span>已放入目标目录，请在游戏内启用。</span><button type="button" className="text-button" onClick={() => { close(); props.showContent(instanceId, kind) }}>查看实例内容<FolderOpen size={14} /></button></div>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={() => props.openUrl(website)}>官网获取<ArrowUpRight size={14} /></button><button type="button" className="button secondary" onClick={close}>关闭</button><button type="button" className="button primary" disabled={!canInstall} onClick={() => void startInstall()}>{saving ? <Spinner size={16} /> : <Download size={16} />}{saving ? '正在安装…' : `安装到${kindNames[kind]}目录`}</button></div>
      {saving && <p className="resource-background-note">关闭窗口后任务会继续，可在下载任务中查看进度或取消。</p>}
    </div>
  </Dialog>
}

export function ResourceTaskList({ tasks, progress, cancel, showContent }: Pick<Props, 'tasks' | 'progress' | 'cancel' | 'showContent'>) {
  const ordered = tasks.map((task, index) => ({ task, index })).sort((a, b) => Number(b.task.status === 'active') - Number(a.task.status === 'active') || a.index - b.index)
  return <div className="resource-task-list">{ordered.map(({ task }) => <ResourceTaskRow key={task.id} task={task} current={task.status === 'active' ? progress[task.instanceId] : undefined} cancel={cancel} showContent={showContent} />)}</div>
}

function ResourceTaskRow({ task, current, cancel, showContent }: { task: ResourceInstallTask; current?: Progress; cancel: Props['cancel']; showContent: Props['showContent'] }) {
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const lock = useRef(false)
  const mounted = useRef(true)
  const latest = useRef(task)
  latest.current = task
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const requestCancel = async () => {
    if (lock.current || latest.current.status !== 'active') return
    lock.current = true; setCancelling(true); setCancelError('')
    try { await cancel(task) }
    catch (error) { if (mounted.current && latest.current.id === task.id && latest.current.status === 'active') setCancelError(errorText(error)) }
    finally { lock.current = false; if (mounted.current) setCancelling(false) }
  }
  const status = task.status === 'active' ? current?.phase || '正在准备资源…' : task.status === 'complete' ? task.result?.reused ? '文件已存在并通过校验' : '已放入目录，尚未替你启用' : task.status === 'cancelled' ? '已取消' : '安装失败'
  return <article className={`resource-task resource-task-${task.status}`}>
    <div className="resource-task-heading"><div><h3>{task.title}</h3><p>{task.instanceName} · {kindNames[task.kind]} · {resourceSources[task.source].label}</p></div><span>{status}</span></div>
    <p className="resource-task-filename">{task.filename}</p>
    {task.status === 'active' && <><progress value={current && current.total > 0 ? percent(current) : undefined} max="100" aria-label={`${task.title} 安装进度`} /><div className="resource-task-progress"><span>{current?.total ? current.unit === 'bytes' ? `${bytes(current.completed)} / ${bytes(current.total)}` : `${number(current.completed)} / ${number(current.total)} 项` : '等待下载进度'}</span><button type="button" className="button secondary" disabled={cancelling} onClick={() => void requestCancel()}>{cancelling ? <Spinner size={14} /> : <Square size={13} />}{cancelling ? '正在请求取消…' : '取消安装'}</button></div></>}
    {task.status === 'error' && <ErrorBox message={task.error || '安装失败，请返回资源页重新选择此发布重试。'} />}
    {['error', 'cancelled'].includes(task.status) && <p className="resource-task-note">可在资源页重新选择目标与发布版本重试。文件冲突请先查看实例内容并手动处理。</p>}
    {task.status === 'active' && cancelError && <ErrorBox message={cancelError} retry={() => void requestCancel()} />}
    {task.result?.warnings.length ? <ul className="resource-task-warnings">{task.result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
    {task.status === 'complete' && <div className="resource-task-complete"><code>{task.result ? `game/${task.result.folder}` : folders[task.kind]}</code><button type="button" className="text-button" onClick={() => showContent(task.instanceId, task.kind)}>查看实例内容<FolderOpen size={14} /></button></div>}
  </article>
}
