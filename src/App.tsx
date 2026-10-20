import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Check, ChevronDown,
  CircleHelp, Clipboard, Compass, Download, ExternalLink, FolderOpen,
  Gamepad2, Layers3, LoaderCircle, LogIn, LogOut, Monitor, Moon,
  Play, Plus, RefreshCw, Search, Settings2, ShieldCheck,
  Square, Terminal, UserRound, X, AlertCircle, Package, Cpu, HardDrive,
} from 'lucide-react'
import { call, errorText, isDesktop, onEvent, type Account, type DeviceCode, type Instance, type JavaRuntime, type Mod, type ModVersion, type Progress, type SearchResult, type Settings, type Snapshot, type Version } from './api'

type View = 'library' | 'discover' | 'downloads' | 'settings' | 'account' | 'logs'
const navigation = [
  { id: 'library' as const, label: '启动游戏', icon: Play },
  { id: 'downloads' as const, label: '下载管理', icon: ArrowDownToLine },
  { id: 'discover' as const, label: '模组下载', icon: Package },
]
const statusLabels: Record<Instance['status'], string> = { 'not-installed': '等待安装', installing: '正在安装', ready: '准备就绪', running: '游戏运行中', error: '需要处理' }
const bytes = (value: number) => value > 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`
const count = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const percent = (progress?: Progress) => progress && progress.total > 0 ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : 0

function Logo({ small = false }: { small?: boolean }) {
  return <span className={`logo-mark ${small ? 'small' : ''}`} aria-hidden="true"><Moon size={small ? 16 : 29} strokeWidth={1.7} /></span>
}
function Spinner({ size = 17 }: { size?: number }) { return <LoaderCircle size={size} className="spin" aria-hidden="true" /> }
function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p>{action}</div>
}
function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error-box" role="alert"><AlertCircle size={18} /><span>{message}</span>{retry && <button className="text-button" onClick={retry}>重试 <RefreshCw size={14} /></button>}</div>
}
function Dialog({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={event => { event.preventDefault(); close() }} onClick={event => { if (event.target === event.currentTarget) close() }}>
    <div className="modal-inner"><div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="关闭对话框"><X size={20} /></button></div>{children}</div>
  </dialog>
}

export default function App() {
  const [view, setView] = useState<View>('library')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [account, setAccount] = useState<Account | null>(null)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null)
  const [gameQuery, setGameQuery] = useState('')
  const [gameFilter, setGameFilter] = useState('all')
  const [selectedId, setSelectedId] = useState('')
  const refresh = useCallback(async () => { setError(''); try { setSnapshot(await call<Snapshot>('snapshot')); setAccount(await call<Account | null>('account')) } catch (error) { setError(errorText(error)) } }, [])
  useEffect(() => { void refresh(); return onEvent(event => {
    if (event.type === 'state') setSnapshot(event.snapshot)
    if (event.type === 'account') setAccount(event.account)
    if (event.type === 'progress') setProgress(current => ({ ...current, [event.instanceId]: event }))
    if (event.type === 'deviceCode') setDeviceCode(event)
  }) }, [refresh])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 6500); return () => clearTimeout(timer) }, [toast])
  const run = async (key: string, method: string, ...args: unknown[]) => {
    setBusy(current => ({ ...current, [key]: true }))
    try { await call(method, ...args); await refresh() } catch (error) { setToast(errorText(error)) }
    finally { setBusy(current => ({ ...current, [key]: false })) }
  }
  const instances = snapshot?.instances || []
  const selectedInstance = instances.find(instance => instance.id === selectedId) || instances[0]
  const downloads = instances.filter(instance => instance.status === 'installing')
  const filtered = instances.filter(instance => instance.name.toLowerCase().includes(gameQuery.toLowerCase()) && (gameFilter === 'all' || instance.loader === gameFilter))
  const openUrl = (url: string) => { void call('openExternal', url).catch(error => setToast(errorText(error))) }
  const changeView = (next: View) => { setView(next); document.querySelector('main')?.scrollTo(0, 0) }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#library" onClick={event => { event.preventDefault(); changeView('library') }} aria-label="Lua 未央，返回我的游戏"><Logo /><span>Lua<small>未央 · 启动器</small></span><span className="alpha">α</span></a>
      <div className="sidebar-section-label">游戏</div>
      <nav aria-label="主导航">{navigation.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => changeView(item.id)} aria-current={view === item.id ? 'page' : undefined}><item.icon size={19} /><span>{item.label}</span>{item.id === 'downloads' && downloads.length > 0 && <span className="nav-count">{downloads.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="sidebar-note"><span className="online-dot" /><span>{isDesktop ? 'Lua Launcher 0.1.0' : '浏览器预览'}</span></div>
        <button className={`nav-item ${view === 'logs' ? 'active' : ''}`} onClick={() => changeView('logs')}><Terminal size={18} /><span>运行日志</span></button>
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => changeView('settings')}><Settings2 size={18} /><span>启动器设置</span></button>
        <button className={`profile-button ${view === 'account' ? 'selected' : ''}`} onClick={() => changeView('account')}><span className="avatar"><UserRound size={20} /></span><span><strong>{account?.username || '添加游戏账户'}</strong><small>{account ? account.mode === 'microsoft' ? 'Microsoft 账户' : '离线模式' : '尚未登录'}</small></span><ChevronDown size={15} /></button>
      </div>
    </aside>
    <main className={`main-panel view-${view}`}>
      <div className="topbar"><div className="breadcrumb">Lua 未央 <span>/</span> <strong>{({ library: '启动游戏', discover: '模组下载', downloads: '下载管理', settings: '启动器设置', account: '游戏账户', logs: '运行日志' })[view]}</strong></div><div className="topbar-right"><span className="version-tag">ALPHA 0.1</span><button className="icon-button" aria-label="管理游戏账户" onClick={() => changeView('account')}><UserRound size={18} /></button><button className="icon-button" aria-label="了解项目与开源许可" onClick={() => setToast('Lua 未央 · 独立开源 Minecraft Java 启动器。当前为 Alpha，支持原版与 Fabric。Minecraft 是 Mojang 的商标，本项目与 Mojang、Microsoft 无关联。')}><CircleHelp size={18} /></button></div></div>
      <div className="page-content">
        {!isDesktop && <div className="preview-notice"><Monitor size={15} /><span>当前为浏览器预览。可探索模组、创建预览实例；安装和启动需使用桌面版。</span><span className="preview-label">PREVIEW</span></div>}
        {error && <ErrorBox message={error} retry={() => void refresh()} />}
        {view === 'library' && <>
          <PageHeading title="启动游戏" subtitle="选择一个游戏版本，或下载新的版本。" />
          <div className="launch-summary">
            <button className="summary-item" onClick={() => changeView('account')}><UserRound size={22} /><span><small>游戏账户</small><strong>{account?.username || '尚未登录'}</strong><em>{account ? account.mode === 'microsoft' ? 'Microsoft 账户' : '离线模式' : '添加 Microsoft 或离线账户'}</em></span><ChevronDown size={15} /></button>
            <div className="summary-item"><Layers3 size={22} /><span><small>当前版本</small><strong>{selectedInstance?.name || '未选择游戏版本'}</strong><em>{selectedInstance ? `${selectedInstance.version} · ${selectedInstance.loader === 'fabric' ? 'Fabric' : '原版'}` : '在下方列表选择版本'}</em></span></div>
            <button className="summary-item" onClick={() => changeView('settings')}><Cpu size={22} /><span><small>运行环境</small><strong>{snapshot?.settings.javaPath ? '指定 Java 路径' : '自动选择 Java'}</strong><em>{snapshot ? `游戏内存 ${(snapshot.settings.memoryMb / 1024).toFixed(1)} GB` : '正在读取设置…'}</em></span><Settings2 size={15} /></button>
          </div>
          <section className="library-section">
            <div className="section-heading"><h2>版本列表 <span className="heading-count">{instances.length}</span></h2><button className="button primary" onClick={() => setCreateOpen(true)}><Plus size={16} />添加游戏版本</button></div>
            <div className="library-toolbar"><div className="segmented" aria-label="按加载器筛选">{[{ id: 'all', label: '全部' }, { id: 'vanilla', label: '原版' }, { id: 'fabric', label: 'Fabric' }].map(filter => <button key={filter.id} className={gameFilter === filter.id ? 'selected' : ''} onClick={() => setGameFilter(filter.id)} aria-pressed={gameFilter === filter.id}>{filter.label}</button>)}</div><label className="search-field compact"><Search size={16} /><input value={gameQuery} onChange={event => setGameQuery(event.target.value)} placeholder="搜索版本名称" aria-label="搜索游戏版本" /></label></div>
            <div className="version-table">
              <div className="version-table-heading"><span>名称</span><span>游戏版本 / 加载器</span><span>状态</span><span>操作</span></div>
              {!snapshot && !error ? <div className="loading-state"><Spinner />正在读取游戏列表…</div> : filtered.length === 0 ? <div className="library-empty"><Package size={37} strokeWidth={1.2} /><h3>{instances.length ? '没有匹配的游戏版本' : '还没有安装游戏'}</h3><p>{instances.length ? '请修改搜索关键词或清除筛选。' : '点击“添加游戏版本”，选择 Minecraft 版本和加载器。'}</p>{instances.length > 0 && <button className="text-button" onClick={() => { setGameFilter('all'); setGameQuery('') }}>清除筛选</button>}</div> : filtered.map(instance => <div key={instance.id} className={`version-row ${selectedInstance?.id === instance.id ? 'selected' : ''}`}>
                <button className="version-name" onClick={() => setSelectedId(instance.id)} aria-pressed={selectedInstance?.id === instance.id}><span className="version-symbol">{instance.loader === 'fabric' ? <Layers3 size={23} /> : <Gamepad2 size={23} />}</span><span><strong>{instance.name}</strong><small>{!isDesktop ? '预览实例' : instance.lastPlayed ? `上次启动 ${new Date(instance.lastPlayed).toLocaleDateString('zh-CN')}` : '尚未启动'}</small></span></button>
                <button className="version-meta" onClick={() => setSelectedId(instance.id)}><strong>{instance.version}</strong><small>{instance.loader === 'fabric' ? 'Fabric' : 'Minecraft 原版'}</small></button>
                <div className={`instance-status status-${instance.status}`}><span>{statusLabels[instance.status]}{instance.status === 'installing' && ` ${percent(progress[instance.id])}%`}</span>{instance.status === 'installing' && <progress value={percent(progress[instance.id])} max="100" aria-label={`${instance.name} 安装进度`} />}</div>
                <div className="version-actions"><button className="icon-button" aria-label={`打开 ${instance.name} 的文件夹`} title="打开游戏文件夹" onClick={() => void run(`folder-${instance.id}`, 'openInstance', instance.id)} disabled={!isDesktop}><FolderOpen size={17} /></button><button className="icon-button" title="查看日志" aria-label={`查看 ${instance.name} 的日志`} onClick={() => { setSelectedId(instance.id); changeView('logs') }}><Terminal size={17} /></button></div>
                {instance.error && <p className="version-error">{instance.error}</p>}
              </div>)}
            </div>
            <p className="library-note">每个实例使用独立的游戏目录，存档与模组相互隔离。</p>
          </section>
          <div className="launch-bar"><div className="launch-selection"><Gamepad2 size={25} /><div><strong>{selectedInstance?.name || '未选择游戏版本'}</strong><span>{selectedInstance ? `Minecraft ${selectedInstance.version} · ${selectedInstance.loader === 'fabric' ? 'Fabric' : '原版'}` : '请先添加游戏版本'}</span></div></div><div className="launch-controls">{selectedInstance && <button className="button secondary" onClick={() => changeView('logs')}><Terminal size={16} />日志</button>}<button className="button primary launch-button" disabled={Boolean(selectedInstance && (busy[selectedInstance.id] || selectedInstance.status === 'installing' || !isDesktop))} onClick={() => selectedInstance ? void run(selectedInstance.id, selectedInstance.status === 'running' ? 'stop' : selectedInstance.status === 'ready' ? 'launch' : 'install', selectedInstance.id) : setCreateOpen(true)}>{selectedInstance && (busy[selectedInstance.id] || selectedInstance.status === 'installing') ? <Spinner size={20} /> : selectedInstance?.status === 'running' ? <Square size={19} /> : selectedInstance?.status === 'ready' ? <Play size={20} /> : <Download size={20} />}{!selectedInstance ? '下载游戏' : !isDesktop ? '桌面版可启动' : selectedInstance.status === 'running' ? '结束游戏' : selectedInstance.status === 'ready' ? '启动游戏' : selectedInstance.status === 'installing' ? '安装中…' : selectedInstance.status === 'error' ? '重新安装' : '安装游戏'}</button></div></div>
        </>}
        {view === 'discover' && <Discover openUrl={openUrl} instances={instances} installed={async name => { await refresh(); setToast(`${name} 已安装，必需依赖已一并处理。`) }} />}
        {view === 'downloads' && <><PageHeading title="下载任务" subtitle="查看游戏、依赖文件的下载与安装进度。" />{downloads.length === 0 ? <EmptyState icon={<Download size={28} />} title="暂无下载任务" action={<button className="button secondary" onClick={() => setCreateOpen(true)}><Plus size={16} />创建游戏实例</button>}>添加游戏版本并开始安装后，任务会显示在这里。</EmptyState> : <div className="download-list">{downloads.map(instance => <div className="download-card" key={instance.id}><div className="download-heading"><span className="download-icon"><Package size={24} /></span><div><h3>{instance.name}</h3><p>Minecraft {instance.version} · {instance.loader}</p></div><button className="button quiet" onClick={() => void run(`cancel-${instance.id}`, 'cancelInstall', instance.id)} disabled={busy[`cancel-${instance.id}`]}>取消</button></div><div className="download-meta"><span>{progress[instance.id]?.phase || '准备安装文件…'}</span><span>{percent(progress[instance.id])}%</span></div><progress value={percent(progress[instance.id])} max="100" aria-label={`${instance.name} 安装进度`} /><small>{progress[instance.id] ? `已下载 ${bytes(progress[instance.id].bytesDownloaded)} · ${progress[instance.id].completed} / ${progress[instance.id].total} 文件` : '正在获取版本信息'}</small></div>)}</div>}</>}
        {view === 'settings' && snapshot && <SettingsView settings={snapshot.settings} rootDir={snapshot.rootDir} save={async settings => { await call('updateSettings', settings); await refresh(); setToast(isDesktop ? '设置已保存。' : '预览设置已保存在此浏览器。') }} />}
        {view === 'account' && <AccountView account={account} refresh={refresh} deviceCode={deviceCode} setDeviceCode={setDeviceCode} openUrl={openUrl} />}
        {view === 'logs' && <LogsView instances={instances} initialId={selectedInstance?.id} />}
      </div>
    </main>
    {createOpen && <CreateDialog close={() => setCreateOpen(false)} created={async instance => { setSelectedId(instance.id); await refresh(); setCreateOpen(false); changeView('library'); setToast(isDesktop ? '实例已创建。点击“安装游戏”下载游戏文件。' : '预览实例已创建，真实安装请使用桌面版。') }} />}
    {toast && <div className="toast" role="status"><span>{toast}</span><button className="icon-button" aria-label="关闭通知" onClick={() => setToast('')}><X size={16} /></button></div>}
  </div>
}

function PageHeading({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>
}
function CreateDialog({ close, created }: { close: () => void; created: (instance: Instance) => Promise<void> }) {
  const [versions, setVersions] = useState<Version[]>([])
  const [version, setVersion] = useState('')
  const [name, setName] = useState('')
  const [loader, setLoader] = useState<'vanilla' | 'fabric'>('vanilla')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { const list = await call<Version[]>('versions'); setVersions(list); setVersion(list.find(item => item.type === 'release')?.id || '') }
    catch (error) { setError(errorText(error)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try { const instance = await call<Instance>('createInstance', { name: name.trim() || `Minecraft ${version}`, version, loader }); await created(instance) }
    catch (error) { setError(errorText(error)); setSaving(false) }
  }
  return <Dialog title="创建游戏实例" close={saving ? () => {} : close}><form onSubmit={event => void submit(event)}>
    <p className="modal-description">选择游戏版本与加载器。每个实例的存档和模组保存在独立目录。</p>
    {!isDesktop && <div className="inline-notice"><Monitor size={17} />当前只创建预览记录，桌面版才能下载与运行游戏。</div>}
    <label className="field"><span>实例名称</span><input autoFocus maxLength={60} value={name} onChange={event => setName(event.target.value)} placeholder="例如：原版生存、Fabric 1.21" /><small>留空则使用 Minecraft 版本号命名。</small></label>
    <div className="field"><span>游戏加载器</span><div className="loader-options">{([{ id: 'vanilla', name: '原版 Vanilla', description: '标准 Minecraft，无模组加载器', icon: Gamepad2 }, { id: 'fabric', name: 'Fabric', description: '支持 Fabric 模组', icon: Layers3 }] as const).map(item => <button type="button" key={item.id} className={`loader-option ${loader === item.id ? 'selected' : ''}`} aria-pressed={loader === item.id} onClick={() => setLoader(item.id)}><item.icon size={23} /><strong>{item.name}</strong><small>{item.description}</small>{loader === item.id && <Check size={16} className="choice-check" />}</button>)}</div></div>
    <label className="field"><span>Minecraft 版本 {loading && <Spinner size={14} />}</span><select value={version} onChange={event => setVersion(event.target.value)} disabled={loading || saving} required>{loading ? <option value="">正在获取官方版本列表…</option> : versions.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
    <p className="form-hint">首版支持 Minecraft 1.20.1 及之后的正式版，包含原版与 Fabric。版本列表来自 Mojang。</p>
    {error && <ErrorBox message={error} retry={!versions.length ? () => void load() : undefined} />}
    <div className="modal-actions"><button type="button" className="button secondary" onClick={close} disabled={saving}>取消</button><button className="button primary" disabled={loading || saving || !version}>{saving ? <Spinner size={16} /> : <Plus size={16} />}{saving ? '正在创建…' : '创建实例'}</button></div>
  </form></Dialog>
}

function Discover({ openUrl, instances, installed }: { openUrl: (url: string) => void; instances: Instance[]; installed: (name: string) => Promise<void> }) {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [loader, setLoader] = useState('')
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [installingMod, setInstallingMod] = useState<Mod | null>(null)
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    call<SearchResult>('searchMods', submitted, { loader: loader || undefined, offset }).then(result => { if (active) setResult(result) }).catch(error => { if (active) setError(errorText(error)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [submitted, loader, offset, retry])
  return <><PageHeading title="模组下载" subtitle="搜索 Modrinth 模组，安装到兼容的 Fabric 实例。" action={<span className="source-pill"><span className="online-dot" />由 Modrinth 提供</span>} />
    <form className="discover-search" onSubmit={event => { event.preventDefault(); setOffset(0); setSubmitted(query.trim()) }}><label className="search-field"><Search size={19} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模组、功能或作者…" aria-label="搜索 Modrinth 模组" /></label><button className="button primary">搜索<ArrowRight size={16} /></button></form>
    <div className="discover-toolbar"><div className="segmented">{[{ value: '', label: '所有模组' }, { value: 'fabric', label: 'Fabric' }, { value: 'forge', label: 'Forge' }, { value: 'neoforge', label: 'NeoForge' }].map(item => <button key={item.value} className={loader === item.value ? 'selected' : ''} onClick={() => { setOffset(0); setLoader(item.value) }} aria-pressed={loader === item.value}>{item.label}</button>)}</div>{result && !loading && !error && <span className="result-count">{count(result.total_hits)} 个结果</span>}</div>
    <div className="inline-notice subtle"><Layers3 size={16} />将兼容模组安装到 Fabric 实例，自动处理必需依赖。其他加载器的项目可前往 Modrinth 查看。</div>
    {error ? <ErrorBox message={error} retry={() => setRetry(value => value + 1)} /> : loading ? <div className="mod-grid" aria-label="正在加载模组">{Array.from({ length: 6 }, (_, index) => <div className="mod-skeleton" key={index}><div /><span /><span /><span /></div>)}</div> : !result?.hits.length ? <EmptyState icon={<Search size={27} />} title="暂时没有找到这个模组">试试更短的关键词，或切换加载器筛选。</EmptyState> : <><div className="mod-grid">{result.hits.map(mod => <article className="mod-card" key={mod.project_id}><div className="mod-heading">{mod.icon_url ? <img src={mod.icon_url} alt="" className="mod-icon" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none' }} /> : <span className="mod-icon fallback"><Package size={25} /></span>}<div><h3>{mod.title}</h3><p>by {mod.author}</p></div></div><p className="mod-description">{mod.description}</p><div className="mod-categories">{mod.categories.slice(0, 3).map(category => <span key={category}>{category}</span>)}</div><div className="mod-footer"><span><Download size={14} />{count(mod.downloads)}</span><div className="mod-actions"><button className="icon-button" aria-label={`在 Modrinth 查看 ${mod.title}`} onClick={() => openUrl(`https://modrinth.com/mod/${encodeURIComponent(mod.slug)}`)}><ArrowUpRight size={16} /></button><button className="button secondary small-button" onClick={() => setInstallingMod(mod)}><Plus size={13} />安装</button></div></div></article>)}</div><div className="pagination"><button className="button secondary" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - result.limit))}>上一页</button><span>第 {Math.floor(offset / result.limit) + 1} 页</span><button className="button secondary" disabled={offset + result.hits.length >= result.total_hits} onClick={() => setOffset(value => value + result.limit)}>下一页</button></div></>}
    {installingMod && <InstallModDialog mod={installingMod} instances={instances} close={() => setInstallingMod(null)} installed={async () => { await installed(installingMod.title); setInstallingMod(null) }} openUrl={openUrl} />}
  </>
}

function InstallModDialog({ mod, instances, close, installed, openUrl }: { mod: Mod; instances: Instance[]; close: () => void; installed: () => Promise<void>; openUrl: (url: string) => void }) {
  const available = instances.filter(instance => instance.loader === 'fabric' && instance.status === 'ready')
  const [instanceId, setInstanceId] = useState(available[0]?.id || '')
  const [versions, setVersions] = useState<ModVersion[]>([])
  const [versionId, setVersionId] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!instanceId || !isDesktop) return
    let active = true
    setLoading(true); setError(''); setVersions([]); setVersionId('')
    call<ModVersion[]>('modVersions', mod.project_id, instanceId).then(versions => { if (active) { setVersions(versions); setVersionId(versions[0]?.id || '') } }).catch(error => { if (active) setError(errorText(error)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [instanceId, mod.project_id, retry])
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try { await call('installMod', instanceId, versionId); await installed() }
    catch (error) { setError(errorText(error)); setSaving(false) }
  }
  return <Dialog title={`安装 ${mod.title}`} close={saving ? () => {} : close}>
    <p className="modal-description">选择一个已安装的 Fabric 实例，启动器会匹配兼容版本并安装必需依赖。</p>
    {!isDesktop ? <div className="inline-notice"><Monitor size={17} />模组安装需要桌面版。你可以先在 Modrinth 查看项目与兼容版本。</div> : !available.length ? <div className="inline-notice"><Layers3 size={17} />还没有可安装模组的实例。请先创建并安装一个 Fabric 实例，关闭游戏后再回来。</div> : <form onSubmit={event => void submit(event)}>
      <label className="field"><span>安装到</span><select value={instanceId} disabled={saving} onChange={event => setInstanceId(event.target.value)}>{available.map(instance => <option key={instance.id} value={instance.id}>{instance.name} · {instance.version}</option>)}</select></label>
      <label className="field"><span>兼容模组版本 {loading && <Spinner size={14} />}</span><select value={versionId} disabled={loading || saving || !versions.length} onChange={event => setVersionId(event.target.value)}>{loading ? <option value="">正在查找兼容版本…</option> : versions.length ? versions.map(version => <option key={version.id} value={version.id}>{version.name}</option>) : <option value="">此 Minecraft 版本暂无兼容发布</option>}</select></label>
      {error && <ErrorBox message={error} retry={!saving ? () => setRetry(value => value + 1) : undefined} />}
      <p className="form-hint">安装文件将经过完整性校验。部分模组需要在游戏内设置后才能生效。</p>
      <div className="modal-actions"><button type="button" className="button secondary" disabled={saving} onClick={close}>取消</button><button className="button primary" disabled={!versionId || loading || saving}>{saving ? <Spinner size={16} /> : <Download size={16} />}{saving ? '正在安装与处理依赖…' : '安装模组'}</button></div>
    </form>}
    {(!isDesktop || !available.length) && <div className="modal-actions"><button className="button secondary" onClick={close}>关闭</button><button className="button primary" onClick={() => openUrl(`https://modrinth.com/mod/${encodeURIComponent(mod.slug)}`)}>查看项目<ArrowUpRight size={16} /></button></div>}
  </Dialog>
}

function SettingsView({ settings, rootDir, save }: { settings: Settings; rootDir: string; save: (settings: Settings) => Promise<void> }) {
  const [draft, setDraft] = useState(settings)
  const [runtimes, setRuntimes] = useState<JavaRuntime[]>([])
  const [detecting, setDetecting] = useState(false)
  const [detected, setDetected] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function detect() {
    setDetecting(true); setError('')
    try { setRuntimes(await call<JavaRuntime[]>('detectJava')); setDetected(true) } catch (error) { setError(errorText(error)) } finally { setDetecting(false) }
  }
  return <><PageHeading title="启动器设置" subtitle="配置 Java、游戏内存和下载选项。" /><form className="settings-form" onSubmit={event => { event.preventDefault(); setSaving(true); setError(''); save(draft).catch(error => setError(errorText(error))).finally(() => setSaving(false)) }}>
    <section className="settings-card"><div className="settings-card-heading"><Cpu size={20} /><div><h2>游戏运行</h2><p>更改后将在下一次启动游戏时生效。</p></div></div><div className="setting-row"><div><h3>分配内存</h3><p>为游戏设置最大堆内存，建议留出系统所需空间。</p></div><div className="memory-value">{(draft.memoryMb / 1024).toFixed(1)}<span>GB</span></div></div><div className="range-control"><input aria-label="分配内存 MB" type="range" min="1024" max="16384" step="512" value={draft.memoryMb} onChange={event => setDraft({ ...draft, memoryMb: Number(event.target.value) })} /><div><span>1 GB</span><span>8 GB</span><span>16 GB</span></div></div><label className="field"><span>Java 可执行文件路径</span><div className="input-with-button"><input value={draft.javaPath} onChange={event => setDraft({ ...draft, javaPath: event.target.value })} placeholder="自动选择系统已安装的 Java" /><button className="button secondary" type="button" disabled={detecting || !isDesktop} onClick={() => void detect()}>{detecting ? <Spinner size={16} /> : <Search size={16} />}自动检测</button></div><small>留空时自动检测系统 Java。Minecraft 1.20.5 及之后版本通常需要 Java 21。</small></label>{detected && <div className="runtime-list">{runtimes.length === 0 ? <p className="form-hint">没有检测到 Java。请安装适合游戏版本的 Java，并填写可执行文件路径。</p> : runtimes.map(runtime => <button type="button" key={runtime.path} onClick={() => setDraft({ ...draft, javaPath: runtime.path })} className={`runtime-item ${draft.javaPath === runtime.path ? 'selected' : ''}`}><Cpu size={18} /><span><strong>Java {runtime.major} · {runtime.arch}</strong><small>{runtime.path}</small></span>{draft.javaPath === runtime.path && <Check size={16} />}</button>)}</div>}</section>
    <section className="settings-card"><div className="settings-card-heading"><Download size={20} /><div><h2>下载与存储</h2><p>游戏与依赖文件统一保存在启动器数据目录。</p></div></div><div className="setting-row"><div><h3>并行下载数</h3><p>网络不稳定时，可以减少同时下载的文件数。</p></div><select aria-label="并行下载数" value={draft.concurrentDownloads} onChange={event => setDraft({ ...draft, concurrentDownloads: Number(event.target.value) })}>{[2, 4, 6, 8, 12].map(value => <option key={value} value={value}>{value} 个文件</option>)}</select></div><div className="data-directory"><HardDrive size={18} /><div><strong>数据目录</strong><code>{rootDir}</code></div></div></section>
    <section className="settings-card about-card"><Logo /><div><h3>Lua 未央 <span className="version-tag">0.1.0 ALPHA</span></h3><p>独立开源的 Minecraft Java 启动器。</p><small>Minecraft 是 Mojang 的商标。本项目与 Mojang、Microsoft 无关联。</small></div></section>
    {error && <ErrorBox message={error} />}<div className="settings-save"><button type="button" className="button secondary" onClick={() => setDraft(settings)}>撤销更改</button><button className="button primary" disabled={saving}>{saving ? <Spinner size={16} /> : <Check size={16} />}保存设置</button></div>
  </form></>
}

function AccountView({ account, refresh, deviceCode, setDeviceCode, openUrl }: { account: Account | null; refresh: () => Promise<void>; deviceCode: DeviceCode | null; setDeviceCode: (code: DeviceCode | null) => void; openUrl: (url: string) => void }) {
  const [clientId, setClientId] = useState('')
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  async function login(event: FormEvent, offline: boolean) {
    event.preventDefault(); setBusy(offline ? 'offline' : 'microsoft'); setError('')
    try { await call(offline ? 'setOffline' : 'login', offline ? username.trim() : clientId.trim()); setDeviceCode(null); await refresh() }
    catch (error) { setError(errorText(error)); setDeviceCode(null) }
    finally { setBusy('') }
  }
  return <><PageHeading title="游戏账户" subtitle="管理 Microsoft 账户或本地离线身份。" />{account && <div className="account-current"><span className="account-avatar"><UserRound size={29} /></span><div><h2>{account.username}</h2><p>{account.mode === 'microsoft' ? 'Microsoft · Minecraft Java' : '离线模式 · 无在线身份验证'}</p></div><button className="button secondary" disabled={Boolean(busy)} onClick={() => { setBusy('logout'); call('logout').then(refresh).catch(error => setError(errorText(error))).finally(() => setBusy('')) }}><LogOut size={16} />退出账户</button></div>}
    <section className="account-card"><div className="account-card-icon"><div className="microsoft-mark"><i /><i /><i /><i /></div></div><h2>连接你的 Microsoft 账户</h2><p>通过 Microsoft 官方设备登录页面授权。<br />启动器不会收集你的 Microsoft 密码。</p><div className="security-note"><ShieldCheck size={16} /><span>登录后验证 Minecraft Java 游戏所有权</span></div><form onSubmit={event => void login(event, false)}><label className="field"><span>Microsoft 应用 Client ID</span><input value={clientId} onChange={event => setClientId(event.target.value)} placeholder="输入已获准访问 Minecraft 的应用 ID" required disabled={Boolean(busy)} /><small>Alpha 版需提供自己的 Microsoft 应用 ID，并启用设备代码登录及所需 Minecraft API 权限。</small></label><button className="button primary full" disabled={Boolean(busy) || !isDesktop}>{busy === 'microsoft' ? <Spinner size={17} /> : <LogIn size={17} />}{busy === 'microsoft' ? '等待浏览器授权…' : '使用 Microsoft 登录'}</button></form>{!isDesktop && <small className="form-hint">账户授权需要在桌面版完成。</small>}</section>
    <details className="offline-section"><summary><UserRound size={17} /><span>离线模式</span><ChevronDown size={16} /></summary><p>用于离线环境下的本地游玩，不提供正版服务器认证。请使用自己拥有的游戏副本。</p><form onSubmit={event => void login(event, true)}><label className="field"><span>玩家名称</span><input value={username} onChange={event => setUsername(event.target.value)} placeholder="3–16 位字母、数字或下划线" pattern="[A-Za-z0-9_]{3,16}" minLength={3} maxLength={16} required /></label><button className="button secondary" disabled={Boolean(busy) || !isDesktop}>{busy === 'offline' ? <Spinner size={16} /> : <UserRound size={16} />}使用离线身份</button></form></details>
    {error && <ErrorBox message={error} />}
    {deviceCode && <Dialog title="完成 Microsoft 授权" close={() => { void call('cancelLogin').catch(error => setError(errorText(error))); setDeviceCode(null) }}><p className="modal-description">打开 Microsoft 授权页面，输入以下代码。完成后，启动器会自动继续。</p><div className="device-code">{deviceCode.userCode}<button className="icon-button" aria-label="复制授权代码" onClick={() => { navigator.clipboard.writeText(deviceCode.userCode).then(() => setCopied(true)).catch(() => setError('无法访问剪贴板，请手动复制授权代码。')) }}>{copied ? <Check size={19} /> : <Clipboard size={19} />}</button></div><button className="button primary full" onClick={() => openUrl(deviceCode.verificationUri)}>打开 Microsoft 授权页<ExternalLink size={16} /></button><div className="device-wait"><Spinner size={16} />等待授权完成…</div><p className="form-hint">请不要分享此授权代码。关闭窗口将取消本次登录。</p></Dialog>}
  </>
}

function LogsView({ instances, initialId }: { instances: Instance[]; initialId?: string }) {
  const [selected, setSelected] = useState(initialId || instances.find(instance => instance.status === 'running')?.id || instances[0]?.id || '')
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!selected) { setLines([]); return }
    let active = true
    setLoading(true); setError('')
    call<unknown>('logs', selected).then(result => {
      if (!active) return
      const data = typeof result === 'string' ? result.split('\n') : Array.isArray(result) ? result.map(line => typeof line === 'string' ? line : line && typeof line.message === 'string' ? `[${line.level || 'info'}] ${line.message}` : JSON.stringify(line)) : []
      setLines(data)
    }).catch(error => { if (active) setError(errorText(error)) }).finally(() => { if (active) setLoading(false) })
    const unsubscribe = onEvent(event => { if (event.type === 'log' && event.instanceId === selected) setLines(lines => [...lines.slice(-1999), `[${event.level}] ${event.message}`]) })
    return () => { active = false; unsubscribe() }
  }, [selected, retry])
  return <><PageHeading title="运行日志" subtitle="查看安装过程、Java 输出与错误信息。" /><div className="logs-toolbar"><label className="field"><span className="sr-only">选择游戏实例</span><select value={selected} onChange={event => setSelected(event.target.value)}><option value="">选择游戏实例</option>{instances.map(instance => <option key={instance.id} value={instance.id}>{instance.name}</option>)}</select></label><button className="button secondary" disabled={!selected || loading} onClick={() => setRetry(value => value + 1)}><RefreshCw size={16} />刷新</button></div>{error && <ErrorBox message={error} />}<div className="log-console"><div className="console-header"><span><Terminal size={15} />GAME OUTPUT</span><span>{lines.length} 行</span></div>{loading ? <div className="loading-state"><Spinner />正在读取日志…</div> : lines.length ? <pre>{lines.join('\n')}</pre> : <EmptyState icon={<Terminal size={26} />} title={selected ? '还没有运行记录' : '选择一个游戏实例'}>{selected ? '安装或启动游戏后，运行输出会显示在这里。' : '这里会记录安装过程、Java 输出与错误信息。'}</EmptyState>}</div></>
}
