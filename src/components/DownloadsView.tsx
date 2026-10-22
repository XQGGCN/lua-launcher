import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { Blocks, CheckCircle2, Download, Gamepad2, Hammer, Layers3, Package, Play, Plus, RefreshCw, Search, Square, Terminal } from 'lucide-react'
import { call, errorText, isDesktop, loaderNames, type Loader, type LoaderVersion, type Instance, type Progress, type ResourceSource, type Version } from '../api'
import { bytes, EmptyState, ErrorBox, PageHeading, percent, Spinner } from './ui'
import { resourceSources } from './ResourceSourcePicker'
import { JavaTaskList, type JavaDownloadMajor, type JavaRuntimeTaskView } from './JavaSettings'
import { ResourceTaskList, type ResourceInstallTask } from './ResourcesView'
import type { ResourceKind, WorldBackupTask } from '../api'
import { WorldBackupTaskList, worldBackupIsActive } from './WorldBackupActions'

export type DownloadInput = { name: string; version: string; loader: Loader; loaderVersion?: string }
export type PackTask = {
  id: string
  name: string
  source: ResourceSource | 'local'
  status: 'active' | 'error' | 'complete' | 'cancelled'
  startedAt: number
  existingIds: string[]
  instanceId?: string
  error?: string
}
type Props = {
  tab: 'game' | 'tasks'
  setTab: (tab: 'game' | 'tasks') => void
  instances: Instance[]
  progress: Record<string, Progress>
  busy: Record<string, boolean>
  taskErrors: Record<string, string>
  packTasks: PackTask[]
  download: (input: DownloadInput) => Promise<void>
  install: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  showGame: (id: string) => void
  showLogs: (id: string) => void
  showPacks: (source?: ResourceSource | 'local') => void
  javaTasks?: JavaRuntimeTaskView[]
  cancelJava?: (id: string) => Promise<void>
  retryJava?: (major: JavaDownloadMajor) => Promise<void>
  backupTasks: WorldBackupTask[]
  cancelBackup: (task: WorldBackupTask) => Promise<void>
  openBackup: (task: WorldBackupTask) => Promise<void>
  resourceTasks: ResourceInstallTask[]
  cancelResource: (task: ResourceInstallTask) => Promise<void>
  showContent: (id: string, kind?: ResourceKind) => void
}

export default function DownloadsView(props: Props) {
  const { tab, setTab, instances, progress, busy, taskErrors, packTasks } = props
  const tabId = useId()
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState('')
  const javaTasks = props.javaTasks || []
  const javaCategory = (task: JavaRuntimeTaskView) => ['queued', 'active', 'cancelling'].includes(task.status) ? 'active' : task.status === 'cancelled' ? 'waiting' : task.status
  const visibleJavaTasks = javaTasks.filter(task => filter === 'all' || javaCategory(task) === filter)
  const resourceTasks = props.resourceTasks
  const visibleResourceTasks = resourceTasks.filter(task => filter === 'all' || (task.status === 'cancelled' ? 'waiting' : task.status) === filter)
  const backupTasks = props.backupTasks
  const visibleBackupTasks = backupTasks.filter(task => filter === 'all' || (worldBackupIsActive(task) ? 'active' : task.status === 'cancelled' ? 'waiting' : task.status) === filter)
  const standalonePacks = packTasks.filter(task => !task.instanceId)
  const active = instances.filter(item => item.status === 'installing' || busy[item.id]).length + standalonePacks.filter(task => task.status === 'active').length + javaTasks.filter(task => javaCategory(task) === 'active').length + resourceTasks.filter(task => task.status === 'active').length + backupTasks.filter(worldBackupIsActive).length
  const failed = instances.filter(item => item.status === 'error' || taskErrors[item.id]).length + standalonePacks.filter(task => task.status === 'error').length + javaTasks.filter(task => task.status === 'error').length + resourceTasks.filter(task => task.status === 'error').length + backupTasks.filter(task => task.status === 'error').length
  function category(instance: Instance) {
    if (instance.status === 'installing' || busy[instance.id]) return 'active'
    if (instance.status === 'error' || taskErrors[instance.id]) return 'error'
    if (instance.status === 'ready' || instance.status === 'running') return 'complete'
    return 'waiting'
  }
  const order: Record<string, number> = { active: 0, error: 1, waiting: 1, complete: 2 }
  const visibleTasks = [
    ...instances.map(instance => ({ kind: 'instance' as const, instance, state: category(instance), created: Date.parse(instance.createdAt) || 0 })),
    ...standalonePacks.map(task => ({ kind: 'pack' as const, task, state: task.status === 'cancelled' ? 'waiting' : task.status, created: task.startedAt })),
  ].filter(task => filter === 'all' || task.state === filter)
    .sort((a, b) => (order[a.state] - order[b.state]) || (b.created - a.created))
  const action = async (operation: () => Promise<void>) => { setError(''); try { await operation() } catch (error) { setError(errorText(error)) } }
  return <>
    <PageHeading title="下载游戏" subtitle="正式版、快照和远古版本都可以安装，每个实例有独立的存档和模组。" action={<button className="button secondary" onClick={() => props.showPacks()}><Package size={16} />安装整合包</button>} />
    <div className="page-tabs" role="tablist" aria-label="下载页面" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 'game' : event.key === 'End' ? 'tasks' : tab === 'game' ? 'tasks' : 'game'
      setTab(next)
      document.getElementById(`${tabId}-${next}-tab`)?.focus()
    }}>
      <button type="button" role="tab" id={`${tabId}-game-tab`} aria-controls={`${tabId}-game-panel`} aria-selected={tab === 'game'} tabIndex={tab === 'game' ? 0 : -1} className={tab === 'game' ? 'selected' : ''} onClick={() => setTab('game')}><Plus size={16} />下载游戏</button>
      <button type="button" role="tab" id={`${tabId}-tasks-tab`} aria-controls={`${tabId}-tasks-panel`} aria-selected={tab === 'tasks'} tabIndex={tab === 'tasks' ? 0 : -1} className={tab === 'tasks' ? 'selected' : ''} onClick={() => setTab('tasks')}><Download size={16} />任务{active > 0 && <span className="heading-count">{active}</span>}{failed > 0 && <span className="task-failure-dot" aria-label={`${failed} 个任务需要处理`} />}</button>
    </div>
    <section role="tabpanel" id={`${tabId}-game-panel`} aria-labelledby={`${tabId}-game-tab`} hidden={tab !== 'game'}>
      <GameDownloadForm download={props.download} />
    </section>
    <section role="tabpanel" id={`${tabId}-tasks-panel`} aria-labelledby={`${tabId}-tasks-tab`} hidden={tab !== 'tasks'}>
      <div className="task-toolbar"><div className="segmented" aria-label="筛选任务">{[{ id: 'all', label: '全部' }, { id: 'active', label: '进行中' }, { id: 'error', label: '失败' }, { id: 'complete', label: '已完成' }, { id: 'waiting', label: '待处理 / 已取消' }].map(item => <button key={item.id} aria-pressed={filter === item.id} className={filter === item.id ? 'selected' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div><button className="text-button" onClick={() => setTab('game')}><Plus size={15} />添加下载</button></div>
      {error && <ErrorBox message={error} />}
      {visibleJavaTasks.length > 0 && <JavaTaskList tasks={visibleJavaTasks} desktop={isDesktop} onCancel={props.cancelJava} onRetry={props.retryJava} busyMajors={javaTasks.filter(task => javaCategory(task) === 'active').map(task => task.major)} />}
      {visibleResourceTasks.length > 0 && <ResourceTaskList tasks={visibleResourceTasks} progress={progress} cancel={props.cancelResource} showContent={props.showContent} />}
      {visibleBackupTasks.length > 0 && <section aria-label="世界备份本地任务"><h2>世界备份 · 本地操作</h2><WorldBackupTaskList tasks={visibleBackupTasks} cancel={props.cancelBackup} open={props.openBackup} /></section>}
      {!visibleTasks.length && !visibleJavaTasks.length && !visibleResourceTasks.length && !visibleBackupTasks.length ? <EmptyState icon={<Download size={28} />} title={instances.length || packTasks.length || javaTasks.length || resourceTasks.length || backupTasks.length ? '此分类下没有任务' : '暂无下载任务'} action={<button className="button secondary" onClick={() => setTab('game')}><Plus size={16} />下载游戏</button>}>{instances.length || packTasks.length || javaTasks.length || resourceTasks.length || backupTasks.length ? '选择其他任务分类查看记录。' : '选择游戏版本和加载器，开始下载。'}</EmptyState> : visibleTasks.length > 0 && <div className="download-list">
        {visibleTasks.map(entry => {
          if (entry.kind === 'pack') {
            const task = entry.task
            return <article className="download-card" key={task.id}>
          <div className="download-heading"><span className="download-icon"><Package size={23} /></span><div><h3>{task.name}</h3><p>{task.source === 'local' ? '本地' : resourceSources[task.source].label} 整合包 · {task.status === 'active' ? '正在获取整合包文件' : task.status === 'error' ? '下载失败' : task.status === 'cancelled' ? '已取消下载' : '安装完成'}</p></div>{task.status === 'active' ? <button className="button secondary" disabled={!task.id.startsWith('modpack-')} onClick={() => void action(() => props.cancel(task.id))}>取消下载</button> : <button className="button secondary" onClick={() => props.showPacks(task.source)}>返回整合包</button>}</div>
          {task.status === 'active' && <><div className="download-meta"><span>{progress[task.id]?.phase || '正在准备整合包…'}</span><span>{progress[task.id]?.total ? `${percent(progress[task.id])}%` : '准备中'}</span></div><progress value={progress[task.id]?.total ? percent(progress[task.id]) : undefined} max="100" aria-label={`${task.name} 下载进度`} /></>}
          {task.error && <ErrorBox message={task.error} />}
            </article>
          }
          const instance = entry.instance
          const state = entry.state
          const current = progress[instance.id]
          return <article className={`download-card download-${state}`} key={instance.id}>
            <div className="download-heading"><span className="download-icon">{state === 'complete' ? <CheckCircle2 size={24} /> : <Package size={24} />}</span><div><h3>{instance.name}</h3><p>Minecraft {instance.version} · {loaderNames[instance.loader]}{instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}{!isDesktop && ' · 预览实例'}</p></div><div className="task-actions">
              {state === 'active' ? <button className="button secondary" disabled={busy[`cancel-${instance.id}`]} onClick={() => void action(() => props.cancel(instance.id))}><Square size={13} />取消</button> : state === 'complete' ? <button className="button secondary" onClick={() => props.showGame(instance.id)}><Play size={14} />前往启动</button> : <button className="button secondary" disabled={!isDesktop || busy[instance.id]} onClick={() => void action(() => props.install(instance.id))}>{state === 'error' ? <RefreshCw size={14} /> : <Download size={14} />}{state === 'error' ? '重试' : '开始安装'}</button>}
              <button className="icon-button" aria-label={`查看 ${instance.name} 的日志`} onClick={() => props.showLogs(instance.id)}><Terminal size={17} /></button>
            </div></div>
            {state === 'active' ? <><div className="download-meta"><span>{current?.phase || '准备下载游戏文件…'}</span><span>{current?.total ? `${percent(current)}%` : '准备中'}</span></div><progress value={current?.total ? percent(current) : undefined} max="100" aria-label={`${instance.name} 安装进度`} /><small>{current ? current.unit === 'bytes' ? current.total > 0 ? `${bytes(current.completed)} / ${bytes(current.total)}` : `已准备 ${bytes(current.completed)} · 总大小待确定` : `已下载 ${bytes(current.bytesDownloaded)}${current.total > 0 ? ` · ${current.completed} / ${current.total} 文件` : ' · 文件数量待确定'}` : '正在读取版本和依赖信息'}</small></> : <p className={`task-status task-status-${state}`}>{state === 'complete' ? '安装完成，可从启动页运行。' : state === 'error' ? '安装未完成。修复网络或查看日志后，可重新下载。' : '尚未下载游戏文件。'}</p>}
            {(instance.error || taskErrors[instance.id]) && <div className="task-error" role="alert">{taskErrors[instance.id] || instance.error}</div>}
          </article>
        })}
      </div>}
    </section>
  </>
}

type Channel = 'release' | 'snapshot' | 'old'
const channelNames: Record<Channel, string> = { release: '正式版', snapshot: '快照', old: '远古版本' }
const channelOf = (type: string): Channel => type === 'snapshot' ? 'snapshot' : type === 'release' ? 'release' : 'old'
/** Forge / NeoForge installers are supported for modern releases only (matches desktop/core isSupportedVersion). */
export function isModernRelease(version: string): boolean {
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(version)
  if (match) return Number(match[1]) > 20 || (Number(match[1]) === 20 && Number(match[2] ?? 0) >= 1)
  return /^2[6-9]\.\d+(?:\.\d+)?$/.test(version)
}
/** Fabric supports 1.14 and later, including snapshots. */
function fabricPossible(item: Version | undefined): boolean {
  if (!item) return false
  if (item.type === 'snapshot') return !item.releaseTime || item.releaseTime >= '2018-10-24'
  const match = /^1\.(\d+)/.exec(item.id)
  return item.type === 'release' && (!match || Number(match[1]) >= 14)
}
function loaderBlocked(loader: Loader, item: Version | undefined): string {
  if (loader === 'vanilla' || !item) return ''
  if (loader === 'fabric') return fabricPossible(item) ? '' : 'Fabric 支持 1.14 及之后的版本'
  return isModernRelease(item.id) ? '' : `${loaderNames[loader]} 支持 1.20.1 及之后的正式版`
}

function GameDownloadForm({ download }: { download: (input: DownloadInput) => Promise<void> }) {
  const [versions, setVersions] = useState<Version[]>([])
  const [version, setVersion] = useState('')
  const [channel, setChannel] = useState<Channel>('release')
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [loader, setLoader] = useState<Loader>('vanilla')
  const [loaderVersions, setLoaderVersions] = useState<LoaderVersion[]>([])
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loadedFor, setLoadedFor] = useState('')
  const [loaderLoading, setLoaderLoading] = useState(false)
  const [loaderError, setLoaderError] = useState('')
  const [loaderAttempt, setLoaderAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { const list = await call<Version[]>('versions'); setVersions(list); setVersion(list.find(item => item.type === 'release')?.id || list[0]?.id || '') }
    catch (error) { setError(errorText(error)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const selected = versions.find(item => item.id === version)
  const latestRelease = versions.find(item => item.type === 'release')?.id
  const latestSnapshot = versions.find(item => item.type === 'snapshot')?.id
  const shown = versions.filter(item => channelOf(item.type) === channel && (!query.trim() || item.id.toLowerCase().includes(query.trim().toLowerCase()))).slice(0, 400)
  const blocked = loaderBlocked(loader, selected)
  useEffect(() => { if (blocked) setLoader('vanilla') }, [blocked])
  useEffect(() => {
    let cancelled = false
    setLoaderVersions([]); setLoaderVersion(''); setLoadedFor(''); setLoaderError('')
    if (loader === 'vanilla' || !version || loaderBlocked(loader, versions.find(item => item.id === version))) { setLoaderLoading(false); return }
    setLoaderLoading(true)
    void call<LoaderVersion[]>('loaderVersions', version, loader)
      .then(list => {
        if (cancelled) return
        setLoaderVersions(list)
        setLoaderVersion((list.find(item => item.recommended) || list.find(item => item.stable) || list[0])?.version || '')
        setLoadedFor(`${loader}:${version}`)
      })
      .catch(error => { if (!cancelled) setLoaderError(errorText(error)) })
      .finally(() => { if (!cancelled) setLoaderLoading(false) })
    return () => { cancelled = true }
  }, [loader, version, loaderAttempt])
  const loaderReady = loader === 'vanilla' || (!loaderLoading && loadedFor === `${loader}:${version}` && Boolean(loaderVersion))
  const defaultName = `Minecraft ${version}${loader === 'vanilla' ? '' : ` ${loaderNames[loader]}`}`
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || loading || !version || !loaderReady) return
    setSaving(true); setError('')
    try { await download({ name: name.trim() || defaultName, version, loader, ...(loader !== 'vanilla' ? { loaderVersion } : {}) }) }
    catch (error) { setError(errorText(error)) }
    finally { setSaving(false) }
  }
  const date = (value: string) => { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('zh-CN') : '' }
  return <form className="game-download-form" onSubmit={event => void submit(event)}>
    <div className="download-layout-grid">
      <div className="version-browser">
        <div className="version-browser-head"><h2>选择版本</h2>{loading && <Spinner size={14} />}</div>
        <div className="segmented" role="group" aria-label="版本类型">{(Object.keys(channelNames) as Channel[]).map(item => <button type="button" key={item} className={channel === item ? 'selected' : ''} aria-pressed={channel === item} onClick={() => setChannel(item)}>{channelNames[item]}</button>)}</div>
        <label className="search-field compact"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索版本号，例如 1.12.2" aria-label="搜索 Minecraft 版本" /></label>
        <div className="version-pick-list" role="listbox" aria-label="Minecraft 版本">
          {loading ? <p className="version-pick-empty">正在获取官方版本列表…</p> : !shown.length ? <p className="version-pick-empty">没有符合条件的版本</p> : shown.map(item => <button type="button" role="option" aria-selected={item.id === version} key={item.id} className={item.id === version ? 'selected' : ''} onClick={() => setVersion(item.id)} disabled={saving}>
            <strong>{item.id}</strong>{item.id === latestRelease && <em>最新正式版</em>}{item.id === latestSnapshot && <em>最新快照</em>}<small>{date(item.releaseTime)}</small>
          </button>)}
        </div>
        {channel !== 'release' && <p className="form-hint">{channel === 'snapshot' ? '快照是开发中的测试版本，可能不稳定，建议使用单独的实例。' : '远古版本仅供怀旧，需要 Java 8；Apple 芯片的 Mac 会通过 Rosetta 2 运行。'}</p>}
      </div>
      <div className="download-options">
        <div className="form-section-heading"><h2>{version ? `Minecraft ${version}` : '新建游戏实例'}</h2><p>{selected ? `${channelNames[channelOf(selected.type)]}${selected.releaseTime ? ` · 发布于 ${date(selected.releaseTime)}` : ''}` : '从左侧选择一个版本。'}</p></div>
        <div className="field"><span>加载器</span><div className="loader-options">{([{ id: 'vanilla', name: '原版', description: '不安装模组加载器', icon: Gamepad2 }, { id: 'fabric', name: 'Fabric', description: '轻量，更新快', icon: Layers3 }, { id: 'forge', name: 'Forge', description: '老牌大型模组', icon: Hammer }, { id: 'neoforge', name: 'NeoForge', description: 'Forge 的新分支', icon: Blocks }] as const).map(item => { const reason = loaderBlocked(item.id, selected); return <button type="button" key={item.id} className={`loader-option ${loader === item.id ? 'selected' : ''}`} aria-pressed={loader === item.id} disabled={saving || Boolean(reason)} title={reason || undefined} onClick={() => setLoader(item.id)}><item.icon size={20} /><strong>{item.name}</strong><small>{reason || item.description}</small></button> })}</div></div>
        {loader !== 'vanilla' && <label className="field"><span>{loaderNames[loader]} 版本 {loaderLoading && <Spinner size={14} />}</span><select value={loaderVersion} onChange={event => setLoaderVersion(event.target.value)} disabled={loaderLoading || saving || !loaderVersions.length} required>{loaderLoading ? <option value="">正在读取兼容版本…</option> : loaderVersions.length ? loaderVersions.map(item => <option key={item.version} value={item.version}>{item.version} · {item.recommended ? '推荐版' : item.stable ? '稳定版' : '测试版'}</option>) : <option value="">{loaderError ? '版本读取失败' : '没有兼容的加载器版本'}</option>}</select></label>}
        {loader !== 'vanilla' && loaderError && <ErrorBox message={loaderError} retry={() => setLoaderAttempt(attempt => attempt + 1)} />}
        <label className="field"><span>实例名称</span><input value={name} maxLength={60} onChange={event => setName(event.target.value)} placeholder={version ? defaultName : '例如：原版生存'} disabled={saving} /></label>
        {error && <ErrorBox message={error} retry={!versions.length ? () => void load() : undefined} />}
        <div className="download-submit"><p>{isDesktop ? '游戏文件从官方来源下载，缺少的 Java 会自动准备。' : '浏览器预览只创建记录；安装和启动需要桌面版。'}</p><button className="button primary" disabled={loading || saving || !version || !loaderReady}>{saving ? <Spinner size={16} /> : <Download size={16} />}{saving ? '正在创建…' : isDesktop ? '下载并安装' : '创建预览实例'}</button></div>
      </div>
    </div>
  </form>
}
