import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Check, ChevronDown,
  CircleHelp, Download, FolderOpen, Gamepad2, Layers3, Monitor, Moon,
  Play, Plus, RefreshCw, Search, Settings2,
  Square, Terminal, UserRound, X, Package, Cpu, HardDrive,
} from 'lucide-react'
import { call, errorText, isDesktop, loaderNames, onEvent, type Account, type AuthState, type Instance, type JavaRuntime, type JavaRequirement, type JavaRuntimeTask, type Mod, type ModVersion, type Progress, type ResourceSource, type SearchResult, type Settings, type Snapshot, type Version } from './api'

import AccountView from './components/AccountView'
import DownloadsView, { type DownloadInput, type PackTask } from './components/DownloadsView'
import ModpacksView from './components/ModpacksView'
import MemorySettings from './components/MemorySettings'
import JavaSettings from './components/JavaSettings'
import InstanceSettings, { createInstanceSettingsDraft, parseInstanceJvmArgs, type InstanceSettingsDraft } from './components/InstanceSettings'
import InstanceContent from './components/InstanceContent'
import type { InstanceOptions, ResolvedInstanceOptions } from './api'
import './App.css'
import { Dialog, EmptyState, ErrorBox, PageHeading, Spinner } from './components/ui'
import ResourceSourcePicker, { resourceProjectUrl, resourceSources } from './components/ResourceSourcePicker'
import ModCategoryPicker from './components/ModCategoryPicker'
import { categoryLabel, type ModCategory } from './mod-categories'
import { APP_VERSION } from './version'

type View = 'library' | 'discover' | 'downloads' | 'modpacks' | 'settings' | 'account' | 'logs' | 'instance-settings' | 'instance-content'
const navigation = [
  { id: 'library' as const, label: '启动游戏', icon: Play },
  { id: 'downloads' as const, label: '游戏下载', icon: ArrowDownToLine },
  { id: 'discover' as const, label: '模组下载', icon: Package },
  { id: 'modpacks' as const, label: '整合包', icon: Layers3 },
]
const statusLabels: Record<Instance['status'], string> = { 'not-installed': '等待安装', installing: '正在安装', ready: '准备就绪', running: '游戏运行中', error: '需要处理' }
const count = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const percent = (progress?: Progress) => progress && progress.total > 0 ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : 0
const selectedInstancePreference = `lua-selected-instance-${isDesktop ? 'desktop' : 'preview'}`
function readSelectedInstance() {
  try { return localStorage.getItem(selectedInstancePreference) || '' } catch { return '' }
}

function Logo({ small = false }: { small?: boolean }) {
  return <span className={`logo-mark ${small ? 'small' : ''}`} aria-hidden="true"><Moon size={small ? 16 : 29} strokeWidth={1.7} /></span>
}
export default function App() {
  const [view, setView] = useState<View>('library')
  const [settingsOpened, setSettingsOpened] = useState(false)
  const [resourceSource, setResourceSource] = useState<ResourceSource>('modrinth')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [account, setAccount] = useState<Account | null>(null)
  const accountRequest = useRef(0)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [downloadTab, setDownloadTab] = useState<'game' | 'tasks'>('game')
  const [taskErrors, setTaskErrors] = useState<Record<string, string>>({})
  const [packTasks, setPackTasks] = useState<PackTask[]>([])
  const [javaTasks, setJavaTasks] = useState<JavaRuntimeTask[]>([])
  const packOperationActive = useRef(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [authState, setAuthState] = useState<AuthState>({ active: false, status: null, deviceCode: null })
  const [authError, setAuthError] = useState('')
  const authOperation = useRef(0)
  const authStateRevision = useRef(0)
  const [gameQuery, setGameQuery] = useState('')
  const [gameFilter, setGameFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(readSelectedInstance)
  const [editingInstanceId, setEditingInstanceId] = useState('')
  const [instanceDrafts, setInstanceDrafts] = useState<Record<string, InstanceSettingsDraft>>({})
  const [instanceSaving, setInstanceSaving] = useState<Record<string, boolean>>({})
  const [instanceSaveErrors, setInstanceSaveErrors] = useState<Record<string, string>>({})
  const instanceSaveLocks = useRef(new Set<string>())
  const [instanceRuntimes, setInstanceRuntimes] = useState<JavaRuntime[]>([])
  const runtimeRequest = useRef(0)
  const [effectiveOptions, setEffectiveOptions] = useState<{ key: string; value?: ResolvedInstanceOptions; error?: string }>()
  const [effectiveRetry, setEffectiveRetry] = useState(0)
  const applySnapshot = useCallback((next: Snapshot) => {
    setSnapshot(next)
    setPackTasks(tasks => tasks.map(task => {
      if (task.status !== 'active' || task.instanceId) return task
      const created = next.instances.find(instance => instance.modpack?.source === task.source && !task.existingIds.includes(instance.id) && instance.name === task.name)
      return created ? { ...task, instanceId: created.id } : task
    }))
  }, [])
  const refresh = useCallback(async () => {
    const request = ++accountRequest.current
    setError('')
    try {
      applySnapshot(await call<Snapshot>('snapshot'))
      const nextAccount = await call<Account | null>('account')
      if (request === accountRequest.current) setAccount(nextAccount?.mode === 'microsoft' ? nextAccount : null)
    } catch (error) { setError(errorText(error)) }
  }, [applySnapshot])
  useEffect(() => {
    void refresh()
    if (isDesktop) void call<JavaRuntimeTask[]>('runtimeTasks').then(tasks => {
      // Snapshot rows missing from the renderer are restored, while events that
      // arrived during this request remain authoritative for their own task ID.
      setJavaTasks(current => [...new Map([...tasks, ...current].map(task => [task.id, task])).values()].slice(-30))
    }).catch(error => setError(errorText(error)))
    const revision = authStateRevision.current
    void call<AuthState>('authState').then(state => {
      if (revision === authStateRevision.current) setAuthState(state)
    }).catch(error => { if (revision === authStateRevision.current) setAuthError(errorText(error)) })
    return onEvent(event => {
      if (event.type === 'state') applySnapshot(event.snapshot)
      if (event.type === 'javaTask') {
        setJavaTasks(current => [...current.filter(task => task.id !== event.task.id), event.task].slice(-30))
      }
      if (event.type === 'account') {
        ++accountRequest.current
        setAccount(event.account?.mode === 'microsoft' ? event.account : null)
      }
      if (event.type === 'progress') setProgress(current => ({ ...current, [event.instanceId]: event }))
      if (event.type === 'deviceCode') {
        ++authStateRevision.current
        setAuthState(current => ({ ...current, active: true, deviceCode: event }))
      }
      if (event.type === 'authStatus') {
        ++authStateRevision.current
        setAuthState(current => ({ ...current, status: { stage: event.stage, message: event.message } }))
      }
      if (event.type === 'authState') {
        ++authStateRevision.current
        setAuthState(event.state)
      }
    })
  }, [refresh, applySnapshot])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 6500); return () => clearTimeout(timer) }, [toast])
  const run = async (key: string, method: string, ...args: unknown[]) => {
    if (method === 'launch' && instanceSaveLocks.current.has(key)) { setToast('实例设置正在保存，请稍候再启动。'); return }
    setBusy(current => ({ ...current, [key]: true }))
    if (method === 'launch') setProgress(current => ({ ...current, [key]: { type: 'progress', instanceId: key, phase: '正在验证账户并准备启动', completed: 0, total: 0, bytesDownloaded: 0 } }))
    try { await call(method, ...args); await refresh() } catch (error) { setToast(errorText(error)) }
    finally { setBusy(current => ({ ...current, [key]: false })) }
  }
  const instances = snapshot?.instances || []
  const selectedInstance = instances.find(instance => instance.id === selectedId) || instances[0]
  useEffect(() => {
    if (!snapshot) return
    if (!snapshot.instances.some(instance => instance.id === selectedId)) {
      const fallback = snapshot.instances[0]?.id || ''
      if (fallback !== selectedId) { setSelectedId(fallback); return }
    }
    try {
      if (selectedId) localStorage.setItem(selectedInstancePreference, selectedId)
      else localStorage.removeItem(selectedInstancePreference)
    } catch { /* UI preference only; a restricted browser remains usable. */ }
  }, [snapshot, selectedId])
  const editingInstance = instances.find(instance => instance.id === editingInstanceId)
  const effectiveInstance = view === 'instance-settings' ? editingInstance : selectedInstance
  const effectiveKey = effectiveInstance && snapshot ? JSON.stringify([effectiveInstance.id, effectiveInstance.options, snapshot.settings]) : ''
  useEffect(() => {
    let active = true
    if (!effectiveInstance || !effectiveKey) { setEffectiveOptions(undefined); return }
    void call<ResolvedInstanceOptions>('instanceOptions', effectiveInstance.id)
      .then(value => { if (active) setEffectiveOptions({ key: effectiveKey, value }) })
      .catch(error => { if (active) setEffectiveOptions({ key: effectiveKey, error: errorText(error) }) })
    return () => { active = false }
  }, [effectiveKey, effectiveRetry])
  useEffect(() => () => { ++runtimeRequest.current }, [])
  const resolved = effectiveOptions?.key === effectiveKey ? effectiveOptions.value : undefined
  const effectiveError = effectiveOptions?.key === effectiveKey ? effectiveOptions.error : undefined
  const downloads = instances.filter(instance => instance.status === 'installing' || busy[instance.id])
  const downloadCount = downloads.length + packTasks.filter(task => task.status === 'active' && !task.instanceId).length
    + javaTasks.filter(task => ['queued', 'active', 'cancelling'].includes(task.status)).length
  const filtered = instances.filter(instance => instance.name.toLowerCase().includes(gameQuery.toLowerCase()) && (gameFilter === 'all' || instance.loader === gameFilter))
  const openUrl = (url: string) => { void call('openExternal', url).catch(error => setToast(errorText(error))) }
  const changeView = (next: View) => { if (next === 'settings') setSettingsOpened(true); setView(next); document.querySelector('main')?.scrollTo(0, 0) }
  function openInstanceSettings(instance: Instance) {
    if (!snapshot) return
    setSelectedId(instance.id); setEditingInstanceId(instance.id)
    setInstanceDrafts(current => current[instance.id] ? current : { ...current, [instance.id]: createInstanceSettingsDraft(instance, snapshot.settings) })
    changeView('instance-settings')
  }
  async function detectInstanceJava() {
    const request = ++runtimeRequest.current
    try {
      const next = await call<JavaRuntime[]>('detectJava')
      if (request === runtimeRequest.current) setInstanceRuntimes(next)
    } catch (error) { if (request === runtimeRequest.current) throw error }
  }
  async function saveInstanceSettings(id: string, name: string, options: InstanceOptions) {
    if (instanceSaveLocks.current.has(id)) throw new Error('此实例设置正在保存，请稍候。')
    instanceSaveLocks.current.add(id)
    setInstanceSaving(current => ({ ...current, [id]: true }))
    setInstanceSaveErrors(current => ({ ...current, [id]: '' }))
    try {
      const next = await call<Snapshot>('updateInstanceSettings', id, { name, options })
      const saved = next.instances.find(item => item.id === id)
      if (!saved) throw new Error('保存完成后未找到此实例，请刷新列表后重试。')
      // Only this instance belongs to this operation. Do not replace another
      // instance's more recent snapshot or its unsaved draft with this response.
      setSnapshot(current => current ? { ...current, instances: current.instances.map(item => item.id === id ? { ...item, name: saved.name, options: saved.options } : item) } : next)
      setInstanceDrafts(current => ({ ...current, [id]: createInstanceSettingsDraft(saved, next.settings) }))
      setEffectiveRetry(value => value + 1)
      setToast(isDesktop ? `${saved.name} 的实例设置已保存。` : '预览实例设置已保存在此浏览器。')
    } catch (error) {
      setInstanceSaveErrors(current => ({ ...current, [id]: errorText(error) }))
      throw error
    } finally {
      instanceSaveLocks.current.delete(id)
      setInstanceSaving(current => ({ ...current, [id]: false }))
    }
  }
  const showDownloadForm = () => { setDownloadTab('game'); changeView('downloads') }
  const showTasks = () => { setDownloadTab('tasks'); changeView('downloads') }
  async function installInstance(id: string) {
    if (instanceSaveLocks.current.has(id)) throw new Error('实例设置正在保存，请稍候再安装。')
    setTaskErrors(errors => { const next = { ...errors }; delete next[id]; return next })
    setBusy(current => ({ ...current, [id]: true }))
    try { applySnapshot(await call<Snapshot>('install', id)); setToast('游戏安装完成。登录验证后可启动。') }
    catch (error) {
      const message = errorText(error)
      if (message !== '安装已取消') setTaskErrors(current => ({ ...current, [id]: message }))
      setToast(message); await refresh()
      if (message !== '安装已取消') throw error
    } finally { setBusy(current => ({ ...current, [id]: false })) }
  }
  async function downloadGame(input: DownloadInput) {
    const instance = await call<Instance>('createInstance', input)
    setSelectedId(instance.id); await refresh(); showTasks()
    if (isDesktop) await installInstance(instance.id)
    else setToast('预览实例已创建。真实安装需使用桌面版。')
  }
  async function cancelDownload(id: string) {
    setBusy(current => ({ ...current, [`cancel-${id}`]: true }))
    try {
      const instance = instances.find(item => item.id === id)
      await call(instance && instance.status !== 'installing' && busy[id] ? 'cancelLaunch' : 'cancelInstall', id)
      await refresh()
    }
    finally { setBusy(current => ({ ...current, [`cancel-${id}`]: false })) }
  }
  async function installPack(method: 'installModpack' | 'importModpack', sourceId: string, name: string, resourceSource: ResourceSource = 'modrinth') {
    if (packOperationActive.current) throw new Error('已有整合包正在安装，请完成或取消当前任务后再试。')
    packOperationActive.current = true
    const source = method === 'importModpack' ? 'local' : resourceSource
    const id = source === 'local' ? `localpack-${sourceId}` : source === 'bbsmc' ? `modpack-bbsmc-${sourceId}` : `modpack-${sourceId}`
    const task: PackTask = { id, name, source, status: 'active', startedAt: Date.now(), existingIds: instances.map(instance => instance.id) }
    setPackTasks(tasks => [...tasks.filter(item => item.id !== id), task])
    try {
      const next = await call<Snapshot>(method, sourceId, { name, ...(method === 'installModpack' ? { source: resourceSource } : {}) })
      applySnapshot(next)
      const installed = next.instances.find(instance => instance.modpack?.source === task.source && !task.existingIds.includes(instance.id) && instance.name === name)
      if (installed) setSelectedId(installed.id)
      setPackTasks(tasks => tasks.map(item => item.id === id ? { ...item, status: 'complete', instanceId: installed?.id || item.instanceId } : item))
      setToast(`${name} 已安装完成。`)
    } catch (error) {
      const message = errorText(error)
      await refresh()
      setPackTasks(tasks => tasks.map(item => item.id === id ? { ...item, status: message.includes('已取消') ? 'cancelled' : 'error', error: message } : item))
      throw error
    } finally { packOperationActive.current = false }
  }
  async function beginLogin() {
    if (authState.active) return
    const operation = ++authOperation.current
    ++authStateRevision.current
    setAuthError('')
    setAuthState({ active: true, status: { stage: 'starting', message: '正在连接 Microsoft…' }, deviceCode: null })
    try { await call('login') }
    catch (error) { if (operation === authOperation.current) setAuthError(errorText(error)) }
    finally {
      if (operation === authOperation.current) {
        setAuthState(current => ({ ...current, active: false, deviceCode: null }))
        await refresh()
      }
    }
  }
  async function cancelLogin() {
    await call('cancelLogin')
  }


  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#library" onClick={event => { event.preventDefault(); changeView('library') }} aria-label="Lua 未央，返回我的游戏"><Logo /><span>Lua<small>未央 · 启动器</small></span><span className="alpha">α</span></a>
      <div className="sidebar-section-label">游戏</div>
      <nav aria-label="主导航">{navigation.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => changeView(item.id)} aria-current={view === item.id ? 'page' : undefined}><item.icon size={19} /><span>{item.label}</span>{item.id === 'downloads' && downloadCount > 0 && <span className="nav-count">{downloadCount}</span>}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="sidebar-note"><span className="online-dot" /><span>{isDesktop ? `Lua Launcher ${APP_VERSION}` : '浏览器预览'}</span></div>
        <button className={`nav-item ${view === 'logs' ? 'active' : ''}`} onClick={() => changeView('logs')}><Terminal size={18} /><span>运行日志</span></button>
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => changeView('settings')}><Settings2 size={18} /><span>启动器设置</span></button>
        <button className={`profile-button ${view === 'account' ? 'selected' : ''}`} onClick={() => changeView('account')}><span className="avatar"><UserRound size={20} /></span><span><strong>{account?.username || '添加 Microsoft 账户'}</strong><small>{account ? 'Microsoft 账户' : '尚未登录'}</small></span><ChevronDown size={15} /></button>
      </div>
    </aside>
    <main className={`main-panel view-${view}`}>
      <div className="topbar"><div className="breadcrumb">Lua 未央 <span>/</span> <strong>{({ library: '启动游戏', discover: '模组下载', downloads: '游戏下载', modpacks: '整合包', settings: '启动器设置', account: '游戏账户', logs: '运行日志', 'instance-settings': '实例设置', 'instance-content': '实例内容' })[view]}</strong></div><div className="topbar-right"><span className="version-tag">ALPHA {APP_VERSION}</span><button className="icon-button mobile-logs-button" aria-label="查看运行日志" onClick={() => changeView('logs')}><Terminal size={18} /></button><button className="icon-button" aria-label="管理游戏账户" onClick={() => changeView('account')}><UserRound size={18} /></button><button className="icon-button" aria-label="了解项目与开源许可" onClick={() => setToast('Lua 未央 · 独立开源 Minecraft Java 启动器。当前为 Alpha，支持原版、Fabric、Forge 与 NeoForge。Minecraft 是 Mojang 的商标，本项目与 Mojang、Microsoft 无关联。')}><CircleHelp size={18} /></button></div></div>
      <div className="page-content">
        {!isDesktop && <div className="preview-notice"><Monitor size={15} /><span>当前为浏览器预览。可探索模组、创建预览实例；安装和启动需使用桌面版。</span><span className="preview-label">PREVIEW</span></div>}
        {error && <ErrorBox message={error} retry={() => void refresh()} />}
        {view === 'library' && <>
          <PageHeading title="启动游戏" subtitle="选择一个游戏版本，或下载新的版本。" />
          <div className="launch-summary">
            <button className="summary-item" onClick={() => changeView('account')}><UserRound size={22} /><span><small>游戏账户</small><strong>{account?.username || '尚未登录'}</strong><em>{account ? 'Microsoft 账户' : '添加 Microsoft 账户'}</em></span><ChevronDown size={15} /></button>
            <div className="summary-item"><Layers3 size={22} /><span><small>当前版本</small><strong>{selectedInstance?.name || '未选择游戏版本'}</strong><em>{selectedInstance ? `${selectedInstance.version} · ${loaderNames[selectedInstance.loader]}` : '在下方列表选择版本'}</em></span></div>
            <button type="button" className="summary-item" onClick={() => selectedInstance ? openInstanceSettings(selectedInstance) : changeView('settings')}><Cpu size={22} /><span><small>{selectedInstance ? '此实例运行环境' : '运行环境'}</small><strong>{selectedInstance ? resolved ? resolved.values.javaPath ? '指定 Java 路径' : '自动选择 Java' : effectiveError ? '查看实例运行设置' : '正在读取实例配置…' : '配置全局运行环境'}</strong><em>{selectedInstance && resolved ? resolved.values.memoryMode === 'manual' ? `手动内存 ${(resolved.values.memoryMb / 1024).toFixed(1)} GB · 实例设置` : '内存自动分配 · 实例设置' : selectedInstance ? 'Java、内存、JVM 与游戏窗口' : '未选择游戏实例'}</em></span><Settings2 size={15} /></button>
          </div>
          <section className="library-section">
            <div className="section-heading"><h2>版本列表 <span className="heading-count">{instances.length}</span></h2><button className="button primary" onClick={showDownloadForm}><Plus size={16} />添加游戏版本</button></div>
            <div className="library-toolbar"><div className="segmented" aria-label="按加载器筛选">{[{ id: 'all', label: '全部' }, { id: 'vanilla', label: '原版' }, { id: 'fabric', label: 'Fabric' }, { id: 'forge', label: 'Forge' }, { id: 'neoforge', label: 'NeoForge' }].map(filter => <button key={filter.id} className={gameFilter === filter.id ? 'selected' : ''} onClick={() => setGameFilter(filter.id)} aria-pressed={gameFilter === filter.id}>{filter.label}</button>)}</div><label className="search-field compact"><Search size={16} /><input value={gameQuery} onChange={event => setGameQuery(event.target.value)} placeholder="搜索版本名称" aria-label="搜索游戏版本" /></label></div>
            <div className="version-table">
              <div className="version-table-heading"><span>名称</span><span>游戏版本 / 加载器</span><span>状态</span><span>操作</span></div>
              {!snapshot && !error ? <div className="loading-state"><Spinner />正在读取游戏列表…</div> : filtered.length === 0 ? <div className="library-empty"><Package size={37} strokeWidth={1.2} /><h3>{instances.length ? '没有匹配的游戏版本' : '还没有安装游戏'}</h3><p>{instances.length ? '请修改搜索关键词或清除筛选。' : '点击“添加游戏版本”，选择 Minecraft 版本和加载器。'}</p>{instances.length > 0 && <button className="text-button" onClick={() => { setGameFilter('all'); setGameQuery('') }}>清除筛选</button>}</div> : filtered.map(instance => <div key={instance.id} className={`version-row ${selectedInstance?.id === instance.id ? 'selected' : ''}`}>
                <button className="version-name" onClick={() => setSelectedId(instance.id)} aria-pressed={selectedInstance?.id === instance.id}><span className="version-symbol">{instance.loader === 'vanilla' ? <Gamepad2 size={23} /> : <Layers3 size={23} />}</span><span><strong>{instance.name}</strong><small>{!isDesktop ? '预览实例' : instance.lastPlayed ? `上次启动 ${new Date(instance.lastPlayed).toLocaleDateString('zh-CN')}` : '尚未启动'}</small></span></button>
                <button className="version-meta" onClick={() => setSelectedId(instance.id)}><strong>{instance.version}</strong><small>{loaderNames[instance.loader]}{instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}</small></button>
                <div className={`instance-status status-${instance.status}`}><span>{statusLabels[instance.status]}{instance.status === 'installing' && ` ${percent(progress[instance.id])}%`}</span>{instance.status === 'installing' && <progress value={percent(progress[instance.id])} max="100" aria-label={`${instance.name} 安装进度`} />}</div>
                <div className="version-actions"><button type="button" className="icon-button" title="实例内容" aria-label={`查看 ${instance.name} 的资源`} onClick={() => { setSelectedId(instance.id); changeView('instance-content') }}><Package size={17} /></button><button type="button" className="icon-button" title="实例设置" aria-label={`设置 ${instance.name}`} onClick={() => openInstanceSettings(instance)}><Settings2 size={17} /></button><button className="icon-button" aria-label={`打开 ${instance.name} 的文件夹`} title="打开游戏文件夹" onClick={() => void run(`folder-${instance.id}`, 'openInstance', instance.id)} disabled={!isDesktop}><FolderOpen size={17} /></button><button className="icon-button" title="查看日志" aria-label={`查看 ${instance.name} 的日志`} onClick={() => { setSelectedId(instance.id); changeView('logs') }}><Terminal size={17} /></button></div>
                {instance.error && <p className="version-error">{instance.error}</p>}
              </div>)}
            </div>
            <p className="library-note">每个实例使用独立的游戏目录，存档与模组相互隔离。当前选择仅保存在{isDesktop ? '本机' : '此浏览器'}，不跨设备同步。</p>
          </section>
          <div className="launch-bar"><div className="launch-selection"><Gamepad2 size={25} /><div><strong>{selectedInstance?.name || '未选择游戏版本'}</strong><span>{selectedInstance ? `Minecraft ${selectedInstance.version} · ${loaderNames[selectedInstance.loader]}` : '请先添加游戏版本'}</span></div></div><div className="launch-controls">{selectedInstance && <><button type="button" className="button secondary" onClick={() => changeView('instance-content')}><Package size={16} />内容</button><button className="button secondary" onClick={() => changeView('logs')}><Terminal size={16} />日志</button></>}<button className="button primary launch-button" disabled={Boolean(selectedInstance && (busy[selectedInstance.id] || instanceSaving[selectedInstance.id] || selectedInstance.status === 'installing' || !isDesktop))} onClick={() => { if (!selectedInstance) showDownloadForm(); else if (selectedInstance.status === 'running' || selectedInstance.status === 'ready') void run(selectedInstance.id, selectedInstance.status === 'running' ? 'stop' : 'launch', selectedInstance.id); else { showTasks(); void installInstance(selectedInstance.id).catch(() => {}) } }}>{selectedInstance && (busy[selectedInstance.id] || selectedInstance.status === 'installing') ? <Spinner size={20} /> : selectedInstance?.status === 'running' ? <Square size={19} /> : selectedInstance?.status === 'ready' ? <Play size={20} /> : <Download size={20} />}{!selectedInstance ? '下载游戏' : !isDesktop ? '桌面版可启动' : selectedInstance.status === 'running' ? '结束游戏' : selectedInstance.status === 'ready' ? '启动游戏' : selectedInstance.status === 'installing' ? '安装中…' : selectedInstance.status === 'error' ? '重新安装' : '安装游戏'}</button></div></div>
        </>}
        {view === 'instance-settings' && snapshot && (editingInstance && instanceDrafts[editingInstance.id] ? <>
          <div className="instance-switcher"><label htmlFor="instance-settings-target">游戏实例</label><select id="instance-settings-target" value={editingInstance.id} onChange={event => { const next = instances.find(item => item.id === event.target.value); if (next) openInstanceSettings(next) }}>{instances.map(item => <option key={item.id} value={item.id}>{item.name} · {item.version}</option>)}</select></div>
          {effectiveError && <ErrorBox message={`生效配置读取失败：${effectiveError}`} retry={() => setEffectiveRetry(value => value + 1)} />}
          <InstanceSettings key={editingInstance.id} instance={editingInstance} globalSettings={snapshot.settings} draft={instanceDrafts[editingInstance.id]} runtimes={instanceRuntimes} resolved={resolved} disabled={busy[editingInstance.id]} saving={instanceSaving[editingInstance.id]} saveError={instanceSaveErrors[editingInstance.id]} onDraftChange={draft => {
            if (instanceSaveLocks.current.has(draft.instanceId)) return
            setInstanceDrafts(current => ({ ...current, [draft.instanceId]: draft }))
            setInstanceSaveErrors(current => ({ ...current, [draft.instanceId]: '' }))
          }} onSave={(name, options) => saveInstanceSettings(editingInstance.id, name, options)} onCancel={() => changeView('library')} onPickJava={isDesktop ? () => call<string | null>('chooseJava') : undefined} onRefreshRuntimes={isDesktop ? detectInstanceJava : undefined} />
        </> : <EmptyState icon={<Settings2 size={26} />} title="没有可设置的实例" action={<button type="button" className="button secondary" onClick={() => changeView('library')}>返回版本列表</button>}>请先添加一个游戏版本。</EmptyState>)}
        {view === 'instance-content' && <InstanceContent instances={instances} selectedId={selectedInstance?.id || ''} onSelect={setSelectedId} onOpenSettings={openInstanceSettings} onOpenFolder={id => call<void>('openInstance', id)} onBack={() => changeView('library')} />}
        {view === 'discover' && <Discover source={resourceSource} setSource={setResourceSource} openUrl={openUrl} instances={instances} installed={async name => { await refresh(); setToast(`${name} 已安装，必需依赖已一并处理。`) }} />}
        {view === 'downloads' && <DownloadsView tab={downloadTab} setTab={setDownloadTab} instances={instances} progress={progress} busy={busy} taskErrors={taskErrors} packTasks={packTasks} javaTasks={javaTasks} cancelJava={async id => { await call('cancelJavaInstall', id) }} retryJava={async major => { await call('installJava', major) }} download={downloadGame} install={installInstance} cancel={cancelDownload} showGame={id => { setSelectedId(id); changeView('library') }} showLogs={id => { setSelectedId(id); changeView('logs') }} showPacks={source => { if (source && source !== 'local') setResourceSource(source); changeView('modpacks') }} />}
        {view === 'modpacks' && <ModpacksView source={resourceSource} setSource={setResourceSource} tasks={packTasks} progress={progress} installOnline={(versionId, name, source) => installPack('installModpack', versionId, name, source)} importLocal={(token, name) => installPack('importModpack', token, name)} cancel={cancelDownload} showTasks={showTasks} openUrl={openUrl} />}
        {settingsOpened && snapshot && <div hidden={view !== 'settings'}><SettingsView instance={selectedInstance} settings={snapshot.settings} rootDir={snapshot.rootDir} javaTasks={javaTasks} save={async settings => {
          const next = await call<Snapshot>('updateSettings', settings)
          // This response owns global settings only. Instance state may have
          // advanced through an event while this request was in flight.
          setSnapshot(current => current ? { ...current, settings: next.settings } : next)
          setToast(isDesktop ? '设置已保存。' : '预览设置已保存在此浏览器。')
        }} /></div>}
        {view === 'account' && <AccountView account={account} refresh={refresh} auth={authState} authError={authError} login={beginLogin} cancelLogin={cancelLogin} openUrl={openUrl} />}
        {view === 'logs' && <LogsView instances={instances} initialId={selectedInstance?.id} />}
      </div>
    </main>
    {toast && <div className="toast" role="status"><span>{toast}</span><button className="icon-button" aria-label="关闭通知" onClick={() => setToast('')}><X size={16} /></button></div>}
  </div>
}

function Discover({ source, setSource, openUrl, instances, installed }: { source: ResourceSource; setSource: (source: ResourceSource) => void; openUrl: (url: string) => void; instances: Instance[]; installed: (name: string) => Promise<void> }) {
  const sourceName = resourceSources[source].label
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [loader, setLoader] = useState('')
  const [category, setCategory] = useState<ModCategory | ''>('')
  const [gameVersion, setGameVersion] = useState('')
  const [gameVersions, setGameVersions] = useState<Version[]>([])
  const [versionsLoading, setVersionsLoading] = useState(true)
  const [versionsError, setVersionsError] = useState('')
  const [versionsRetry, setVersionsRetry] = useState(0)
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [installingMod, setInstallingMod] = useState<Mod | null>(null)
  const searchRequest = useRef(0)
  useEffect(() => {
    let current = true
    setVersionsLoading(true); setVersionsError('')
    void call<Version[]>('versions')
      .then(versions => { if (current) setGameVersions(versions) })
      .catch(error => { if (current) setVersionsError(errorText(error)) })
      .finally(() => { if (current) setVersionsLoading(false) })
    return () => { current = false }
  }, [versionsRetry])
  useEffect(() => {
    const request = ++searchRequest.current
    setLoading(true); setError(''); setResult(null)
    call<SearchResult>('searchMods', submitted, { source, category: category || undefined, gameVersion: gameVersion || undefined, loader: loader || undefined, offset }).then(result => { if (request === searchRequest.current) setResult(result) }).catch(error => { if (request === searchRequest.current) setError(errorText(error)) }).finally(() => { if (request === searchRequest.current) setLoading(false) })
    return () => { if (request === searchRequest.current) ++searchRequest.current }
  }, [source, category, gameVersion, submitted, loader, offset, retry])
  const invalidateResults = () => {
    ++searchRequest.current
    setResult(null); setInstallingMod(null); setError(''); setLoading(true)
  }
  const changeSource = (next: ResourceSource) => {
    if (next === source) return
    invalidateResults(); setSource(next); setOffset(0)
  }
  const changeCategory = (next: ModCategory | '') => {
    if (next === category) return
    invalidateResults(); setCategory(next); setOffset(0)
  }
  const clearFilters = () => {
    invalidateResults(); setCategory(''); setGameVersion(''); setLoader(''); setQuery(''); setSubmitted(''); setOffset(0); setRetry(value => value + 1)
  }
  const hasFilters = Boolean(category || gameVersion || loader || submitted)
  return <><PageHeading title="模组下载" subtitle="按用途查找模组，再选择游戏版本与加载器。" />
    <ResourceSourcePicker source={source} change={changeSource} openUrl={openUrl} />
    <ModCategoryPicker value={category} change={changeCategory} />
    <form className="discover-search" onSubmit={event => { event.preventDefault(); invalidateResults(); setOffset(0); setSubmitted(query.trim()); setRetry(value => value + 1) }}><label className="search-field"><Search size={19} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="在所选分类中搜索名称、功能或作者…" aria-label={`搜索 ${sourceName} 模组`} /></label><button className="button primary">搜索<ArrowRight size={16} /></button></form>
    <div className="mod-compatibility-filters"><label><span>加载器</span><select value={loader} onChange={event => { invalidateResults(); setOffset(0); setLoader(event.target.value) }} aria-label="筛选模组加载器"><option value="">全部加载器</option><option value="fabric">Fabric</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option></select></label><label><span>Minecraft 版本 {versionsLoading && <Spinner size={12} />}</span><select value={gameVersion} disabled={versionsLoading} onChange={event => { invalidateResults(); setOffset(0); setGameVersion(event.target.value) }} aria-label="筛选模组游戏版本"><option value="">{versionsLoading ? '正在读取版本…' : '全部游戏版本'}</option>{gameVersions.map(version => <option key={version.id} value={version.id}>{version.id}</option>)}</select></label>{hasFilters && <button type="button" className="text-button" onClick={clearFilters}>清除筛选</button>}</div>
    {versionsError && <ErrorBox message={`游戏版本列表读取失败：${versionsError}`} retry={() => setVersionsRetry(value => value + 1)} />}
    <div className="inline-notice subtle"><Layers3 size={16} /><span>根据实例加载器匹配模组并处理必需依赖。其他项目可前往 {sourceName} 查看。{source === 'bbsmc' && ' BBSMC 接入为实验性，下载可用性取决于项目发布文件。'}</span></div>
    <div className="mod-results-heading"><h2>{category ? categoryLabel(category) : '全部模组'}</h2><span className="result-count" role="status">{loading ? '正在查询…' : result && !error ? `${sourceName} · ${count(result.total_hits)} 个结果` : sourceName}</span></div>
    {error ? <ErrorBox message={`${sourceName}：${error}`} retry={() => { invalidateResults(); setRetry(value => value + 1) }} /> : loading ? <div className="mod-grid" aria-label="正在加载模组">{Array.from({ length: 6 }, (_, index) => <div className="mod-skeleton" key={index}><div /><span /><span /><span /></div>)}</div> : !result?.hits.length ? <EmptyState icon={<Search size={27} />} title="当前条件下没有找到模组" action={hasFilters && <button type="button" className="button secondary" onClick={clearFilters}>清除筛选</button>}>试试其他分类、加载器或游戏版本，也可以缩短搜索关键词。</EmptyState> : <><div className="mod-grid">{result.hits.map(mod => <article className="mod-card" key={`${source}-${mod.project_id}`}><div className="mod-heading">{mod.icon_url ? <img src={mod.icon_url} alt="" className="mod-icon" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none' }} /> : <span className="mod-icon fallback"><Package size={25} /></span>}<div><h3>{mod.title}</h3><p>作者：{mod.author}</p></div></div><p className="mod-description">{mod.description}</p><div className="mod-categories">{mod.categories.slice(0, 3).map(item => <span key={item}>{categoryLabel(item)}</span>)}</div><div className="mod-footer"><span><Download size={14} />{count(mod.downloads)}</span><div className="mod-actions"><button className="icon-button" aria-label={`在 ${sourceName} 查看 ${mod.title}`} onClick={() => openUrl(resourceProjectUrl(source, 'mod', mod.slug))}><ArrowUpRight size={16} /></button><button className="button secondary small-button" onClick={() => setInstallingMod(mod)}><Plus size={13} />安装</button></div></div></article>)}</div><div className="pagination"><button className="button secondary" disabled={offset === 0} onClick={() => { invalidateResults(); setOffset(value => Math.max(0, value - result.limit)) }}>上一页</button><span>第 {Math.floor(offset / result.limit) + 1} 页</span><button className="button secondary" disabled={offset + result.hits.length >= result.total_hits} onClick={() => { invalidateResults(); setOffset(value => value + result.limit) }}>下一页</button></div></>}
    {installingMod && <InstallModDialog key={`${source}-${installingMod.project_id}`} source={source} mod={installingMod} instances={instances} close={() => setInstallingMod(null)} installed={async () => { await installed(installingMod.title); setInstallingMod(null) }} openUrl={openUrl} />}
  </>
}

function InstallModDialog({ source, mod, instances, close, installed, openUrl }: { source: ResourceSource; mod: Mod; instances: Instance[]; close: () => void; installed: () => Promise<void>; openUrl: (url: string) => void }) {
  const sourceName = resourceSources[source].label
  const available = instances.filter(instance => instance.loader !== 'vanilla' && instance.status === 'ready')
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
    call<ModVersion[]>('modVersions', mod.project_id, instanceId, source).then(versions => { if (active) { setVersions(versions); setVersionId((versions.find(version => !version.externalOnly) || versions[0])?.id || '') } }).catch(error => { if (active) setError(errorText(error)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [source, instanceId, mod.project_id, retry])
  const selectedVersion = versions.find(version => version.id === versionId)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving || loading || !selectedVersion || selectedVersion.externalOnly) return
    setSaving(true); setError('')
    try { await call('installMod', instanceId, versionId, source); await installed() }
    catch (error) { setError(errorText(error)); setSaving(false) }
  }
  return <Dialog title={`安装 ${mod.title}`} close={saving ? () => {} : close}>
    <p className="modal-description">来源：{sourceName}{source === 'bbsmc' ? '（实验性）' : ''}。选择一个已安装加载器的实例，启动器会匹配该加载器的兼容版本并安装必需依赖。</p>
    {!isDesktop ? <div className="inline-notice"><Monitor size={17} />模组安装需要桌面版。你可以先在 {sourceName} 查看项目与兼容版本。</div> : !available.length ? <div className="inline-notice"><Layers3 size={17} />还没有可安装模组的实例。请先安装 Fabric、Forge 或 NeoForge 实例，关闭游戏后再回来。</div> : <form onSubmit={event => void submit(event)}>
      <label className="field"><span>安装到</span><select value={instanceId} disabled={saving} onChange={event => setInstanceId(event.target.value)}>{available.map(instance => <option key={instance.id} value={instance.id}>{instance.name} · {instance.version} · {loaderNames[instance.loader]}</option>)}</select></label>
      <label className="field"><span>兼容模组版本 {loading && <Spinner size={14} />}</span><select value={versionId} disabled={loading || saving || !versions.length} onChange={event => setVersionId(event.target.value)}>{loading ? <option value="">正在查找兼容版本…</option> : versions.length ? versions.map(version => <option key={version.id} value={version.id}>{version.name}</option>) : <option value="">此 Minecraft 版本暂无兼容发布</option>}</select></label>
      {selectedVersion?.externalOnly && <div className="inline-notice"><span>{selectedVersion.externalReason || '此发布需要从官网获取，无法直接安装。'}</span></div>}
      {error && <ErrorBox message={`${sourceName}：${error}`} retry={!saving ? () => setRetry(value => value + 1) : undefined} />}
      <p className="form-hint">安装文件将经过完整性校验。部分模组需要在游戏内设置后才能生效。</p>
      <div className="modal-actions"><button type="button" className="button secondary" disabled={saving} onClick={close}>取消</button>{(selectedVersion?.externalOnly || Boolean(error)) && <button type="button" className="button secondary" onClick={() => openUrl(resourceProjectUrl(source, 'mod', mod.slug))}>官网获取<ArrowUpRight size={16} /></button>}<button className="button primary" disabled={!versionId || loading || saving || selectedVersion?.externalOnly}>{saving ? <Spinner size={16} /> : <Download size={16} />}{saving ? '正在安装与处理依赖…' : '安装模组'}</button></div>
    </form>}
    {(!isDesktop || !available.length) && <div className="modal-actions"><button className="button secondary" onClick={close}>关闭</button><button className="button primary" onClick={() => openUrl(resourceProjectUrl(source, 'mod', mod.slug))}>查看项目<ArrowUpRight size={16} /></button></div>}
  </Dialog>
}

type AdvancedSettingsDraft = {
  jvmMode: 'default' | 'custom'; jvmText: string
  widthMode: 'default' | 'custom'; width: string
  heightMode: 'default' | 'custom'; height: string
  fullscreen: 'default' | 'on' | 'off'
}
function advancedSettingsDraft(settings: Settings): AdvancedSettingsDraft {
  return {
    jvmMode: settings.jvmArgs === undefined ? 'default' : 'custom', jvmText: (settings.jvmArgs || []).join('\n'),
    widthMode: settings.windowWidth === undefined ? 'default' : 'custom', width: String(settings.windowWidth ?? 1280),
    heightMode: settings.windowHeight === undefined ? 'default' : 'custom', height: String(settings.windowHeight ?? 720),
    fullscreen: settings.fullscreen === undefined ? 'default' : settings.fullscreen ? 'on' : 'off',
  }
}
function globalWindowSize(text: string, min: number, max: number, label: string) {
  const value = Number(text)
  if (!text.trim() || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label}需要填写 ${min}–${max} 之间的整数。`)
  return value
}
function SettingsView({ settings, rootDir, save, instance, javaTasks }: { settings: Settings; rootDir: string; save: (settings: Settings) => Promise<void>; instance?: Instance; javaTasks: JavaRuntimeTask[] }) {
  const initialDraft = () => ({ ...settings, memoryMode: settings.memoryMode || 'auto', manualJavaPath: settings.manualJavaPath || settings.javaPath || '' })
  const [draft, setDraft] = useState(initialDraft)
  const [advancedDraft, setAdvancedDraft] = useState(() => advancedSettingsDraft(settings))
  const [runtimes, setRuntimes] = useState<JavaRuntime[]>([])
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState('')
  const detectRevision = useRef(0)
  const [requirement, setRequirement] = useState<JavaRequirement>()
  const [requirementLoading, setRequirementLoading] = useState(false)
  const [requirementError, setRequirementError] = useState('')
  const [requirementRetry, setRequirementRetry] = useState(0)
  const [resetKey, setResetKey] = useState(0)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const mounted = useRef(true)
  const [error, setError] = useState('')
  const signature = (normal: typeof draft, advanced: AdvancedSettingsDraft) => JSON.stringify([normal, advanced])
  const [savedDraft, setSavedDraft] = useState(() => signature(initialDraft(), advancedSettingsDraft(settings)))
  const dirty = signature(draft, advancedDraft) !== savedDraft
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  function changeAdvanced(patch: Partial<AdvancedSettingsDraft>) {
    if (!savingRef.current) { setAdvancedDraft(current => ({ ...current, ...patch })); setError('') }
  }
  async function submit() {
    if (savingRef.current) return
    savingRef.current = true; setSaving(true); setError('')
    try {
      // Undefined must remain an own property: IPC uses it to clear saved
      // optional overrides rather than retaining the previous value.
      const pending: Settings = { ...draft,
        jvmArgs: advancedDraft.jvmMode === 'custom' ? parseInstanceJvmArgs(advancedDraft.jvmText) : undefined,
        windowWidth: advancedDraft.widthMode === 'custom' ? globalWindowSize(advancedDraft.width, 640, 7680, '窗口宽度') : undefined,
        windowHeight: advancedDraft.heightMode === 'custom' ? globalWindowSize(advancedDraft.height, 360, 4320, '窗口高度') : undefined,
        fullscreen: advancedDraft.fullscreen === 'default' ? undefined : advancedDraft.fullscreen === 'on',
      }
      await save(pending)
      if (mounted.current) setSavedDraft(signature(draft, advancedDraft))
    } catch (error) { if (mounted.current) setError(errorText(error)) }
    finally { savingRef.current = false; if (mounted.current) setSaving(false) }
  }
  const terminalTasks = javaTasks.filter(task => task.status === 'complete').map(task => task.id).join(',')
  async function detect() {
    const revision = ++detectRevision.current
    setDetecting(true); setDetectError('')
    try {
      const next = await call<JavaRuntime[]>('detectJava')
      if (revision === detectRevision.current) setRuntimes(next)
    } catch (error) {
      if (revision !== detectRevision.current) return
      setDetectError(errorText(error))
      throw error
    } finally { if (revision === detectRevision.current) setDetecting(false) }
  }
  useEffect(() => {
    if (isDesktop) void detect().catch(() => {})
    return () => { ++detectRevision.current }
  }, [terminalTasks])
  useEffect(() => {
    let current = true
    setRequirement(undefined); setRequirementError('')
    if (!isDesktop || !instance) { setRequirementLoading(false); return }
    setRequirementLoading(true)
    void call<JavaRequirement>('runtimeRequirement', instance.id)
      .then(next => { if (current) setRequirement(next) })
      .catch(error => { if (current) setRequirementError(errorText(error)) })
      .finally(() => { if (current) setRequirementLoading(false) })
    return () => { current = false }
  }, [instance?.id, requirementRetry])
  return <><PageHeading title="启动器设置" subtitle="配置全局 Java、内存、JVM 参数、游戏窗口和下载选项。实例设置可单独覆盖。" /><form className="settings-form" noValidate onSubmit={event => { event.preventDefault(); void submit() }}>
    <fieldset className="settings-fieldset" disabled={saving}>
    <section className="settings-card"><div className="settings-card-heading"><Cpu size={20} /><div><h2>全局游戏运行</h2><p>更改后将在下一次安装或启动游戏时生效；实例已覆盖的项目保持实例设置。</p></div></div><MemorySettings settings={draft} change={next => { if (!savingRef.current) setDraft({ ...next, manualJavaPath: next.manualJavaPath || '' }) }} instanceId={instance?.id} instanceName={instance?.name} /><JavaSettings javaPath={draft.javaPath} manualJavaPath={draft.manualJavaPath} onChangeJavaPath={(javaPath, manualJavaPath) => { if (!savingRef.current) setDraft(current => ({ ...current, javaPath, manualJavaPath })) }} desktop={isDesktop} resetKey={resetKey} requirement={requirement} requirementLoading={requirementLoading} requirementError={requirementError} onRetryRequirement={() => setRequirementRetry(value => value + 1)} runtimes={runtimes} detecting={detecting} detectError={detectError} onDetect={detect} tasks={javaTasks} onInstall={async major => { await call('installJava', major) }} onCancelTask={async id => { await call('cancelJavaInstall', id) }} onPickJava={() => call<string | null>('chooseJava')} onRefresh={detect} /></section>
    <section className="settings-card global-advanced-settings"><div className="settings-card-heading"><Settings2 size={20} /><div><h2>JVM 与游戏窗口</h2><p>适用于未单独覆盖的实例。所有参数在保存后生效。</p></div></div>
      <div className="setting-row"><div><h3>自定义 JVM 参数</h3><p>每行一个完整参数，整体替换；空格、引号和反斜线原样保留。</p></div><select aria-label="全局 JVM 参数来源" value={advancedDraft.jvmMode} onChange={event => changeAdvanced({ jvmMode: event.target.value as AdvancedSettingsDraft['jvmMode'] })}><option value="default">启动器默认</option><option value="custom">自定义参数</option></select></div>
      {advancedDraft.jvmMode === 'custom' && <label className="field"><span>全局 JVM 参数（每行一个）</span><textarea rows={6} spellCheck={false} autoComplete="off" value={advancedDraft.jvmText} placeholder={'-Dfile.encoding=UTF-8\n-Dexample.label=含 空格的值'} onChange={event => changeAdvanced({ jvmText: event.target.value })} /><small>不会按 shell 拆分，包含空格的值不需要外层引号。参数名与独立值各占一行；空行忽略。留空表示不添加自定义参数。</small></label>}
      <p className="form-hint">内存、类路径及账户参数由启动器管理。不支持的参数会在保存时报错；本实例自定义参数不会和全局参数拼接。</p>
      <div className="global-window-fields">
        <div><label className="field"><span>全局窗口宽度</span><select value={advancedDraft.widthMode} onChange={event => changeAdvanced({ widthMode: event.target.value as AdvancedSettingsDraft['widthMode'] })}><option value="default">启动器默认（1280 像素）</option><option value="custom">自定义宽度</option></select></label>{advancedDraft.widthMode === 'custom' && <label className="field"><span>宽度（像素）</span><input type="number" min={640} max={7680} step={1} value={advancedDraft.width} onChange={event => changeAdvanced({ width: event.target.value })} /></label>}</div>
        <div><label className="field"><span>全局窗口高度</span><select value={advancedDraft.heightMode} onChange={event => changeAdvanced({ heightMode: event.target.value as AdvancedSettingsDraft['heightMode'] })}><option value="default">启动器默认（720 像素）</option><option value="custom">自定义高度</option></select></label>{advancedDraft.heightMode === 'custom' && <label className="field"><span>高度（像素）</span><input type="number" min={360} max={4320} step={1} value={advancedDraft.height} onChange={event => changeAdvanced({ height: event.target.value })} /></label>}</div>
      </div>
      <div className="setting-row"><div><h3>全屏状态</h3><p>沿用游戏设置时不强制改变状态；强制开启或关闭会在下次启动时应用。</p></div><select aria-label="全局全屏状态" value={advancedDraft.fullscreen} onChange={event => changeAdvanced({ fullscreen: event.target.value as AdvancedSettingsDraft['fullscreen'] })}><option value="default">沿用游戏设置</option><option value="on">强制全屏</option><option value="off">强制窗口</option></select></div>
      <p className="form-hint">宽高只影响 Minecraft 游戏窗口。全屏时保留宽高，回到窗口模式后使用。</p>
      <button type="button" className="text-button" onClick={() => changeAdvanced({ jvmMode: 'default', widthMode: 'default', heightMode: 'default', fullscreen: 'default' })}>将 JVM 与窗口设置恢复默认</button>
    </section>
    <section className="settings-card"><div className="settings-card-heading"><Download size={20} /><div><h2>下载与存储</h2><p>游戏与依赖文件统一保存在启动器数据目录。</p></div></div><div className="setting-row"><div><h3>并行下载数</h3><p>网络不稳定时，可以减少同时下载的文件数。</p></div><select aria-label="并行下载数" value={draft.concurrentDownloads} onChange={event => setDraft({ ...draft, concurrentDownloads: Number(event.target.value) })}>{[2, 4, 6, 8, 12].map(value => <option key={value} value={value}>{value} 个文件</option>)}</select></div><div className="data-directory"><HardDrive size={18} /><div><strong>数据目录</strong><code>{rootDir}</code></div></div></section>
    <section className="settings-card about-card"><Logo /><div><h3>Lua 未央 <span className="version-tag">{APP_VERSION} ALPHA</span></h3><p>独立开源的 Minecraft Java 启动器。</p><small>Minecraft 是 Mojang 的商标。本项目与 Mojang、Microsoft 无关联。</small></div></section>
    </fieldset>
    {error && <ErrorBox message={error} retry={!saving ? () => void submit() : undefined} />}<div className="settings-save"><span className="form-hint" role="status">{saving ? '正在保存设置…' : dirty ? '有尚未保存的设置，切页后草稿保留' : '设置已保存'}</span><button type="button" className="button secondary" disabled={saving} onClick={() => { const next = initialDraft(); const advanced = advancedSettingsDraft(settings); setDraft(next); setAdvancedDraft(advanced); setSavedDraft(signature(next, advanced)); setResetKey(value => value + 1); setError('') }}>撤销更改</button><button className="button primary" disabled={saving || !dirty}>{saving ? <Spinner size={16} /> : <Check size={16} />}保存设置</button></div>
  </form></>
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
