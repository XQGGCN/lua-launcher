import { useEffect, useLayoutEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Copy, FileWarning, FolderOpen, Gamepad2, LayoutGrid, Layers3, List, MoreHorizontal, Package, Plus, Search, Settings2, Terminal, Trash2, X } from 'lucide-react'
import { loaderNames, type Instance, type Progress } from '../api'
import { libraryDate, type InstanceLibraryResult, type LibraryLoaderFilter, type LibraryPreferences } from '../instance-library'
import { ErrorBox, Spinner } from './ui'
import './InstanceLibrary.css'

export interface InstanceLibraryProps {
  instances: Instance[]
  result?: InstanceLibraryResult
  loading: boolean
  queryError: string
  preferences: LibraryPreferences
  preferenceIssue?: string
  query: string
  loaderFilter: LibraryLoaderFilter
  selected?: Instance
  progress: Record<string, Progress>
  working: (id: string) => boolean
  desktop: boolean
  menuFor: string
  onMenu: (id: string) => void
  onQuery: (value: string) => void
  onLoaderFilter: (value: LibraryLoaderFilter) => void
  onPreferences: (patch: Partial<LibraryPreferences>) => void
  onResetPreferences: () => void
  onClearFilters: () => void
  onLocate: (clearFilters: boolean) => void
  onPage: (page: number) => void
  onSelect: (id: string) => void
  onDoubleClick: (id: string) => void
  onAdd: () => void
  onContent: (id: string) => void
  onSettings: (id: string) => void
  onFolder: (id: string) => void
  onLogs: (id: string) => void
  onDuplicate: (id: string) => void
  onCrash: (id: string) => void
  onRemove: (id: string) => void
}
const statusLabels: Record<Instance['status'], string> = { 'not-installed': '等待安装', installing: '正在安装', ready: '准备就绪', running: '游戏运行中', error: '需要处理' }
function recordedDate(value: unknown, context: 'last' | 'created') {
  const date = libraryDate(value)
  if (date.kind === 'known') return <time dateTime={date.iso}>{context === 'last' ? '本机最近启动：' : '创建记录：'}{date.label}</time>
  return context === 'last' ? date.kind === 'absent' ? '暂无本机启动记录' : '启动记录未知' : '创建记录未知'
}
function installPercent(progress?: Progress) {
  return progress && Number.isFinite(progress.total) && progress.total > 0 && Number.isFinite(progress.completed)
    ? Math.max(0, Math.min(100, Math.round(progress.completed / progress.total * 100))) : undefined
}

export default function InstanceLibrary(props: InstanceLibraryProps) {
  const { instances, result, loading, preferences, selected, menuFor } = props
  const section = useRef<HTMLElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const locateButton = useRef<HTMLButtonElement>(null)
  const rowFocus = useRef<{ row: HTMLElement; target: HTMLElement } | null>(null)
  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const row = target.closest<HTMLElement>('.instance-library-item')
      if (row && section.current?.contains(row)) rowFocus.current = { row, target }
      // Removing a focused node may leave BODY active. Preserve that observation
      // until the layout check, but respect an intentional focus move elsewhere.
      else if (target !== document.body || rowFocus.current?.target.isConnected) rowFocus.current = null
    }
    document.addEventListener('focusin', rememberFocus)
    return () => document.removeEventListener('focusin', rememberFocus)
  }, [])
  useLayoutEffect(() => {
    const previous = rowFocus.current
    if (!previous || previous.row.isConnected || !section.current?.isConnected) return
    const active = document.activeElement
    rowFocus.current = null
    if (active && active !== document.body && active !== document.documentElement && active.isConnected) return
    // A background metadata change can move a row to another page. Restore a
    // useful focus target without following that row or changing the selection.
    ;(locateButton.current ?? searchInput.current ?? addButton.current)?.focus()
  }, [result, instances.length])
  const filtered = Boolean(props.query || props.loaderFilter !== 'all')
  const page = result?.page ?? 0
  return <section ref={section} className={`instance-library density-${preferences.density}`} aria-label="我的实例">
    <div className="section-heading"><h2>我的实例 <span className="heading-count">{instances.length}</span></h2><button ref={addButton} type="button" className="button secondary" onClick={props.onAdd}><Plus size={16} />添加实例</button></div>
    {instances.length > 0 && <>
      <div className="instance-library-toolbar">
        <div className="instance-library-search"><label htmlFor="instance-library-query">搜索实例</label><div><Search size={16} /><input ref={searchInput} id="instance-library-query" type="search" value={props.query} onChange={event => props.onQuery(event.target.value)} placeholder="名称、版本、加载器或整合包" aria-describedby="instance-library-search-help" />{props.query && <button type="button" className="icon-button" aria-label="清除实例搜索" title="清除实例搜索" onClick={() => props.onQuery('')}><X size={15} /></button>}</div></div>
        <label className="instance-library-control"><span>加载器</span><select value={props.loaderFilter} onChange={event => props.onLoaderFilter(event.target.value as LibraryLoaderFilter)}><option value="all">全部加载器</option>{Object.entries(loaderNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="instance-library-control"><span>视图</span><div className="segmented" role="group" aria-label="实例库视图"><button type="button" aria-pressed={preferences.layout === 'list'} className={preferences.layout === 'list' ? 'selected' : ''} onClick={() => props.onPreferences({ layout: 'list' })}><List size={15} />列表</button><button type="button" aria-pressed={preferences.layout === 'grid'} className={preferences.layout === 'grid' ? 'selected' : ''} onClick={() => props.onPreferences({ layout: 'grid' })}><LayoutGrid size={15} />网格</button></div></div>
        <label className="instance-library-control"><span>密度</span><select value={preferences.density} onChange={event => props.onPreferences({ density: event.target.value as LibraryPreferences['density'] })}><option value="standard">标准</option><option value="compact">紧凑</option></select></label>
        <label className="instance-library-control instance-library-sort"><span>排序</span><select value={preferences.sortBy} onChange={event => props.onPreferences({ sortBy: event.target.value as LibraryPreferences['sortBy'] })}><option value="name">名称</option><option value="version">版本名称</option><option value="lastPlayed">本机最近启动记录</option><option value="createdAt">创建记录</option></select></label>
        <label className="instance-library-control"><span>方向</span><select value={preferences.direction} onChange={event => props.onPreferences({ direction: event.target.value as LibraryPreferences['direction'] })}><option value="asc">升序</option><option value="desc">降序</option></select></label>
      </div>
      <div className="instance-library-toolbar-note"><p id="instance-library-search-help">只搜索实例名称、Minecraft版本、加载器名称/版本和整合包名称，最多200个字符。</p><div>{filtered && <button type="button" className="text-button" onClick={props.onClearFilters}>清除筛选</button>}<button type="button" className="text-button" onClick={props.onResetPreferences}>恢复默认显示</button></div></div>
      {props.preferenceIssue && <p className="instance-library-preference-issue" role="status">{props.preferenceIssue}</p>}
    </>}
    {props.queryError && <ErrorBox message={props.queryError} />}
    {result && instances.length > 0 && !props.queryError && <>
      <p className="instance-library-result-count" role="status">显示 {result.filteredTotal} / {result.total} 个实例{result.pageCount > 1 ? `，第 ${page + 1} / ${result.pageCount} 页` : ''}</p>
      {selected && result.selection.kind === 'filtered-out' && <div className="instance-library-selection-note"><span>当前选择「{selected.name}」不在筛选结果中，启动目标保持不变。</span><button ref={locateButton} type="button" className="text-button" onClick={() => props.onLocate(true)}>清除筛选并显示当前实例</button></div>}
      {selected && result.selection.kind === 'other-page' && <div className="instance-library-selection-note"><span>当前选择「{selected.name}」在第 {result.selection.page + 1} 页，启动目标保持不变。</span><button ref={locateButton} type="button" className="text-button" onClick={() => props.onLocate(false)}>定位当前实例</button></div>}
    </>}
    {loading ? <div className="loading-state"><Spinner />正在读取实例…</div> : !props.queryError && (!result?.items.length ? <div className="library-empty"><Gamepad2 size={34} strokeWidth={1.4} /><h3>{instances.length ? '没有符合条件的实例' : '还没有游戏实例'}</h3><p>{instances.length ? '换个关键词，或者清除筛选；当前启动目标不会改变。' : '选择 Minecraft 版本和加载器，几分钟就能装好。'}</p>{instances.length ? <button type="button" className="text-button" onClick={props.onClearFilters}>清除筛选</button> : <button type="button" className="button primary" onClick={props.onAdd}><Plus size={16} />添加第一个实例</button>}</div> : <ul className={`instance-library-items layout-${preferences.layout}`}>
      {result.items.map(instance => {
        const current = selected?.id === instance.id
        const working = props.working(instance.id)
        const percent = installPercent(props.progress[instance.id])
        const mutatingDisabled = !props.desktop || working || instance.status === 'running' || instance.status === 'installing'
        return <li key={instance.id} data-instance-id={instance.id} className={`instance-library-item${current ? ' selected' : ''}`} onDoubleClick={event => { if (!(event.target as HTMLElement).closest('.instance-library-actions')) props.onDoubleClick(instance.id) }}>
          <button type="button" className="instance-library-name" aria-label={`选择实例 ${instance.name}`} aria-pressed={current} title={`${instance.name} · 单击选择，双击启动`} onClick={() => props.onSelect(instance.id)}><span className={`instance-library-symbol loader-${instance.loader}`}>{instance.loader === 'vanilla' ? <Gamepad2 size={20} /> : <Layers3 size={20} />}</span><span><strong>{instance.name}</strong>{current && <span className="instance-library-current">当前选择</span>}<small>{recordedDate(instance.lastPlayed, 'last')}</small></span></button>
          <div className="instance-library-meta"><strong>Minecraft {instance.version || '版本未知'}</strong><span>{loaderNames[instance.loader] || '加载器未知'}{instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}</span><small>{recordedDate(instance.createdAt, 'created')}</small>{instance.modpack?.name && <small>整合包：{instance.modpack.name}</small>}</div>
          <div className={`instance-library-status status-${instance.status}`}><span>{statusLabels[instance.status] || '状态未知'}{instance.status === 'installing' && percent !== undefined ? ` ${percent}%` : ''}</span>{instance.status === 'installing' && <progress value={percent} max="100" aria-label={`${instance.name} 安装进度`} />}{working && instance.status !== 'installing' && <small><Spinner size={13} />有进行中的操作</small>}</div>
          <div className="instance-library-actions"><button type="button" className="icon-button" title="实例内容" aria-label={`查看 ${instance.name} 的内容`} onClick={() => props.onContent(instance.id)}><Package size={17} /></button><button type="button" className="icon-button" title="实例设置" aria-label={`设置 ${instance.name}`} onClick={() => props.onSettings(instance.id)}><Settings2 size={17} /></button><button type="button" className="icon-button" title="打开游戏文件夹" aria-label={`打开 ${instance.name} 的文件夹`} disabled={!props.desktop} onClick={() => props.onFolder(instance.id)}><FolderOpen size={17} /></button><div className="row-menu"><button type="button" className="icon-button" title="更多" aria-label={`${instance.name} 的更多操作`} aria-expanded={menuFor === instance.id} onClick={() => props.onMenu(menuFor === instance.id ? '' : instance.id)}><MoreHorizontal size={17} /></button>{menuFor === instance.id && <div className="menu-popover" role="menu"><button type="button" role="menuitem" onClick={() => props.onLogs(instance.id)}><Terminal size={15} />运行日志</button><button type="button" role="menuitem" disabled={mutatingDisabled} onClick={() => props.onDuplicate(instance.id)}><Copy size={15} />复制实例</button><button type="button" role="menuitem" disabled={!props.desktop} onClick={() => props.onCrash(instance.id)}><FileWarning size={15} />崩溃报告</button><button type="button" role="menuitem" className="danger" disabled={mutatingDisabled} onClick={() => props.onRemove(instance.id)}><Trash2 size={15} />删除实例</button></div>}</div></div>
          {typeof instance.error === 'string' && instance.error && <p className="instance-library-error">{instance.error}</p>}
        </li>
      })}
    </ul>)}
    {result && result.pageCount > 1 && !props.queryError && <nav className="instance-library-pagination" aria-label="实例库分页"><button type="button" className="button secondary" disabled={page === 0} onClick={() => props.onPage(page - 1)}><ChevronLeft size={16} />上一页</button><span>第 {page + 1} / {result.pageCount} 页 · 每页24个</span><button type="button" className="button secondary" disabled={page >= result.pageCount - 1} onClick={() => props.onPage(page + 1)}>下一页<ChevronRight size={16} /></button></nav>}
    {instances.length > 0 && <p className="library-note">最近启动与创建记录来自本机登记，不代表进入世界或云端游玩历史。每个实例有独立的存档和模组；双击仅在正版登录且实例就绪、空闲时启动。</p>}
  </section>
}
