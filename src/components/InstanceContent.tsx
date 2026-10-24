import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { AlertTriangle, ArrowLeft, FileUp, File, FileArchive, Folder, FolderOpen, Layers3, Map, Monitor, Package, RefreshCw, Search, Settings2 } from 'lucide-react'
import type { InventoryItem, InventoryKind, ResourceInventory } from '../../desktop/resource-inventory'
import { call, errorText, isDesktop, loaderNames, type Instance, type ModTogglePreview, type ModToggleSelection, type ModToggleResult, type WorldDetails as WorldDetailsData, type WorldSeed, type WorldSelection, type WorldBackupTask, type WorldBackupList, type WorldBackupResult, type WorldZipList, type WorldZipResult, type WorldZipTask } from '../api'
import ModToggleActions from './ModToggleActions'
import ModDetails from './ModDetails'
import WorldDetails, { escapeWorldText } from './WorldDetails'
import WorldDatapacks from './WorldDatapacks'
import WorldBackupActions from './WorldBackupActions'
import WorldMap from './WorldMap'
import { WorldImportDialog } from './WorldRestore'
import { EmptyState, ErrorBox, Spinner } from './ui'
import './InstanceContent.css'

export interface InstanceContentProps {
  instances: Instance[]
  selectedId: string
  onSelect: (id: string) => void
  onOpenSettings: (instance: Instance) => void
  onOpenFolder: (id: string) => Promise<void>
  onBack: () => void
  initialKind?: InventoryKind
  refreshRevision?: number
  fileBusy?: boolean
  onPrepareMod?: (instanceId: string, selection: ModToggleSelection, enabled: boolean) => Promise<ModTogglePreview>
  onCommitMod?: (instanceId: string, token: string) => Promise<ModToggleResult>
  backupTasks?: WorldBackupTask[]
  onBackupWorld?: (instanceId: string, selection: WorldSelection) => Promise<WorldBackupResult>
  onCancelWorldBackup?: (task: WorldBackupTask) => Promise<void>
  exportTasks?: WorldZipTask[]
  onExportWorldBackup?: (instanceId: string, backupId: string) => Promise<WorldZipResult>
  onCancelWorldExport?: (task: WorldZipTask) => Promise<void>
}
export type InstanceInventory = ResourceInventory & { instanceId: string }
type SortOrder = 'name-asc' | 'name-desc' | 'modified-desc' | 'modified-asc'
const tabs: { kind: InventoryKind; label: string; folder: string; icon: typeof Package }[] = [
  { kind: 'mods', label: '模组', folder: 'mods', icon: Package },
  { kind: 'resourcepacks', label: '资源包', folder: 'resourcepacks', icon: FileArchive },
  { kind: 'shaderpacks', label: '光影包', folder: 'shaderpacks', icon: Layers3 },
  { kind: 'worlds', label: '世界 / 地图', folder: 'saves', icon: Map },
]
const pageSize = 100
const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const sourceNames = { modrinth: 'Modrinth', bbsmc: 'BBSMC' }

export function inventorySize(item: Pick<InventoryItem, 'entryType' | 'sizeBytes'>) {
  if (item.entryType === 'directory' || item.sizeBytes === undefined) return '未统计'
  if (item.sizeBytes < 1024) return `${item.sizeBytes} 字节`
  if (item.sizeBytes < 1024 ** 2) return `${(item.sizeBytes / 1024).toFixed(1)} KiB`
  if (item.sizeBytes < 1024 ** 3) return `${(item.sizeBytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(item.sizeBytes / 1024 ** 3).toFixed(2)} GiB`
}
function timeLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false })
}
function typeLabel(item: InventoryItem) {
  if (item.entryType === 'directory') return '目录'
  return item.formatHint ? `${item.formatHint.toUpperCase()} 后缀文件` : '文件'
}
export function filterInventory(items: InventoryItem[], query: string, order: SortOrder): InventoryItem[] {
  const needle = query.trim().toLocaleLowerCase('zh-CN')
  return items.filter(item => !needle || item.name.toLocaleLowerCase('zh-CN').includes(needle)).sort((first, second) => {
    const byName = names.compare(first.name, second.name) || first.id.localeCompare(second.id)
    if (order === 'name-asc') return byName
    if (order === 'name-desc') return -byName
    const byTime = Date.parse(first.modifiedAt) - Date.parse(second.modifiedAt)
    return (order === 'modified-desc' ? -byTime : byTime) || byName
  })
}

export function InventoryDetails({ item, kind, id }: { item?: InventoryItem; kind: InventoryKind; id: string }) {
  return <section id={id} className="inventory-details" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>条目信息</h3>
    {!item ? <p className="inventory-detail-hint">选择列表中的名称，查看文件信息。</p> : <>
      <dl>
        <dt>名称</dt><dd>{kind === 'worlds' ? escapeWorldText(item.name) : item.name}</dd>
        <dt>相对路径</dt><dd><code>{kind === 'worlds' ? escapeWorldText(item.relativePath) : item.relativePath}</code><small>相对于此实例的 game 目录</small></dd>
        <dt>条目类型</dt><dd>{typeLabel(item)}</dd>
        <dt>{kind === 'worlds' && item.entryType === 'directory' ? '目录修改时间' : '修改时间'}</dt><dd><time dateTime={item.modifiedAt}>{timeLabel(item.modifiedAt)}</time></dd>
        <dt>大小</dt><dd>{inventorySize(item)}{item.entryType === 'directory' && <small>只列出这一层，不统计目录内文件大小</small>}</dd>
        {kind !== 'worlds' && <><dt>加载状态</dt><dd>{item.activation === 'disabled-suffix' ? '禁用后缀（.disabled）' : '未检查'}<small>仅记录文件名，不判断游戏是否加载或是否兼容</small></dd>
        <dt>曾登记来源</dt><dd>{item.recordedSource ? <>{sourceNames[item.recordedSource.source]}<small>项目 ID：{item.recordedSource.projectId}<br />版本 ID：{item.recordedSource.versionId}</small></> : '无关联登记'}<small>历史下载登记不证明当前文件内容、完整性或兼容性</small></dd></>}
        {item.recordedDownload && <><dt>下载登记</dt><dd><time dateTime={item.recordedDownload.installedAt}>{timeLabel(item.recordedDownload.installedAt)}</time><small>登记时大小：{item.recordedDownload.size} 字节</small></dd><dt>登记 SHA-512</dt><dd><code>{item.recordedDownload.sha512}</code><small>这是下载时的校验值；本次清单未重新计算当前文件哈希</small></dd></>}
      </dl>
      {kind === 'worlds' && <p className="inventory-detail-hint">目录时间来自文件系统，和世界记录的最后游玩时间分别展示。选择普通世界目录后可在下方只读查看元数据。</p>}
    </>}
  </section>
}

export default function InstanceContent({ instances, selectedId, onSelect, onOpenSettings, onOpenFolder, onBack, initialKind = 'mods', refreshRevision = 0, fileBusy = false, onPrepareMod, onCommitMod, backupTasks = [], onBackupWorld, onCancelWorldBackup, exportTasks = [], onExportWorldBackup, onCancelWorldExport }: InstanceContentProps) {
  const [kind, setKind] = useState<InventoryKind>(initialKind)
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState<SortOrder>('name-asc')
  const [page, setPage] = useState(0)
  const [selectedItemId, setSelectedItemId] = useState('')
  const [result, setResult] = useState<{ key: string; value: InstanceInventory }>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ key: string; message: string }>()
  const [retry, setRetry] = useState(0)
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState('')
  const [fileResult, setFileResult] = useState<{ instanceId: string; result: ModToggleResult }>()
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState('')
  const [modDetailsOperations, setModDetailsOperations] = useState<Record<string, string>>({})
  const afterRename = useRef<{ instanceId: string; itemId: string; name: string } | undefined>(undefined)
  const filters = useRef({ query, order })
  filters.current = { query, order }
  const request = useRef(0)
  const folderRequest = useRef(0)
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()
  const instance = instances.find(item => item.id === selectedId)
  const installing = instance?.status === 'installing'
  const key = `${instance?.id || 'none'}:${kind}:${installing ? 'blocked' : 'readable'}`
  const currentInstanceId = useRef(selectedId)
  currentInstanceId.current = selectedId
  const currentKey = useRef(key)
  currentKey.current = key
  const tab = tabs.find(item => item.kind === kind)!
  const inventory = result?.key === key ? result.value : undefined
  const message = error?.key === key ? error.message : ''
  const filtered = filterInventory(inventory?.items || [], query, order)
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const visibleItems = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  const selectedItem = filtered.find(item => item.id === selectedItemId)
  const modDetailsBusy = Boolean(instance && Object.values(modDetailsOperations).includes(instance.id))

  useEffect(() => {
    const ticket = ++request.current
    setResult(undefined); setError(undefined)
    const follow = afterRename.current?.instanceId === instance?.id && kind === 'mods' ? afterRename.current : undefined
    setSelectedItemId(follow?.itemId || ''); setPage(0)
    if (!isDesktop || !instance || installing) { setLoading(false); return }
    setLoading(true)
    void call<InstanceInventory>('inventory', instance.id, kind).then(value => {
      if (ticket !== request.current || currentKey.current !== key) return
      if (value.instanceId !== instance.id || value.kind !== kind) throw new Error('清单与当前实例不一致，请刷新后重试。')
      setResult({ key, value })
      const pending = afterRename.current
      if (pending?.instanceId === instance.id && kind === 'mods') {
        const index = filterInventory(value.items, filters.current.query, filters.current.order).findIndex(item => item.id === pending.itemId)
        setSelectedItemId(pending.itemId)
        if (index >= 0) setPage(Math.floor(index / pageSize))
        afterRename.current = undefined
      }
    }).catch(error => {
      if (ticket === request.current && currentKey.current === key) setError({ key, message: errorText(error) })
    }).finally(() => { if (ticket === request.current && currentKey.current === key) setLoading(false) })
    return () => { if (ticket === request.current) ++request.current }
  }, [selectedId, instance?.id, kind, installing, retry, refreshRevision])
  useEffect(() => {
    ++folderRequest.current; setFolderBusy(false); setFolderError(''); setQuery('')
    afterRename.current = undefined; setFileResult(undefined)
    return () => { ++folderRequest.current }
  }, [selectedId])

  function selectTab(next: InventoryKind) {
    if (next === kind) return
    ++request.current; setKind(next); setQuery(''); setPage(0); setSelectedItemId(''); afterRename.current = undefined
  }
  function renamed(result: ModToggleResult) {
    if (!instance || kind !== 'mods' || currentInstanceId.current !== instance.id) return
    afterRename.current = { instanceId: instance.id, itemId: result.newItemId, name: result.toName }
    if (!result.toName.toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN'))) setQuery('')
    setFileResult({ instanceId: instance.id, result })
    setSelectedItemId(result.newItemId)
    setRetry(value => value + 1)
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined
    if (next === undefined) return
    event.preventDefault(); selectTab(tabs[next].kind); tabButtons.current[next]?.focus()
  }
  function refresh() {
    if (loading || installing || modDetailsBusy || !isDesktop || !instance) return
    ++request.current; setRetry(value => value + 1)
  }
  async function openFolder() {
    if (!instance || !isDesktop || folderBusy) return
    const ticket = ++folderRequest.current
    const targetId = instance.id
    setFolderBusy(true); setFolderError('')
    try { await onOpenFolder(instance.id) }
    catch (error) { if (ticket === folderRequest.current && currentInstanceId.current === targetId) setFolderError(errorText(error)) }
    finally { if (ticket === folderRequest.current && currentInstanceId.current === targetId) setFolderBusy(false) }
  }

  return <div className="instance-content">
    <header className="inventory-heading"><div><h2>实例内容</h2><p>查看实例文件与文件夹、读取模组声明，或修改单个模组的启用后缀。</p></div><button type="button" className="button secondary" onClick={onBack}><ArrowLeft size={15} />返回启动页</button></header>
    <div className="inventory-instance-bar"><label htmlFor={`${id}-instance`}>游戏实例</label><select id={`${id}-instance`} value={instance?.id || ''} onChange={event => { ++request.current; setSelectedItemId(''); onSelect(event.target.value) }}><option value="" disabled>{instances.length ? '选择实例' : '尚无游戏实例'}</option>{instances.map(item => <option key={item.id} value={item.id}>{item.name} · {item.version} · {loaderNames[item.loader]}</option>)}</select><button type="button" className="button secondary" disabled={!instance} onClick={() => instance && onOpenSettings(instance)}><Settings2 size={15} />实例设置</button><button type="button" className="button secondary" disabled={!instance || !isDesktop || folderBusy} onClick={() => void openFolder()}>{folderBusy ? <Spinner size={15} /> : <FolderOpen size={15} />}打开实例文件夹</button></div>
    {folderError && <ErrorBox message={folderError} retry={() => void openFolder()} />}
    {!isDesktop && <div className="inline-notice inventory-notice"><Monitor size={17} /><span>浏览器预览无法访问本机磁盘，不会生成示例文件清单。你可以选择已有预览实例，或返回启动页创建预览实例；真实清单需要桌面版。</span></div>}
    {installing && <div className="inline-notice inventory-notice"><Spinner size={17} /><span>此实例正在安装，暂时不能扫描内容。安装完成或取消后会重新读取目录。</span></div>}
    {instance?.status === 'running' && <div className="inline-notice inventory-notice"><AlertTriangle size={17} /><span>游戏正在运行，可以只读查看；文件可能随游戏变化，清单仅代表本次读取时的状态。</span></div>}
    {instance?.error && <ErrorBox message={instance.error} />}
    {fileResult && fileResult.instanceId === instance?.id && <div className="inline-notice inventory-notice" role="status"><span>已将 {fileResult.result.fromName} 改为 {fileResult.result.toName}。下次启动时才可能生效，尚未检查加载、依赖或兼容性。{fileResult.result.warnings.map((warning, index) => <small key={index}>{warning}</small>)}</span></div>}
    <div className="inventory-tabs" role="tablist" aria-label="实例内容类型">{tabs.map((item, index) => <button type="button" key={item.kind} ref={node => { tabButtons.current[index] = node }} id={`${id}-tab-${item.kind}`} role="tab" aria-selected={kind === item.kind} aria-controls={`${id}-panel`} tabIndex={kind === item.kind ? 0 : -1} onKeyDown={event => tabKey(event, index)} onClick={() => selectTab(item.kind)}><item.icon size={16} />{item.label}</button>)}</div>
    <section id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${kind}`} tabIndex={0}>
      <div className="inventory-toolbar"><label className="inventory-search"><Search size={15} /><input aria-label={`在已读取${tab.label}中按文件名搜索`} placeholder="按文件名搜索已读取条目" value={query} disabled={!inventory || installing} onChange={event => { setQuery(event.target.value); setPage(0); setSelectedItemId('') }} /></label><label className="inventory-sort"><span className="sr-only">清单排序</span><select value={order} onChange={event => { setOrder(event.target.value as SortOrder); setPage(0); setSelectedItemId('') }}><option value="name-asc">文件名：升序</option><option value="name-desc">文件名：降序</option><option value="modified-desc">修改时间：从新到旧</option><option value="modified-asc">修改时间：从旧到新</option></select></label><button type="button" className="button secondary" disabled={!instance || !isDesktop || installing || loading || modDetailsBusy} onClick={refresh}>{loading ? <Spinner size={15} /> : <RefreshCw size={15} />}刷新</button>{kind === 'worlds' && <button type="button" className="button primary" disabled={!instance || !isDesktop || installing || instance.status === 'running'} onClick={() => setImporting(true)}><FileUp size={15} />导入世界 / 地图</button>}</div>
      {kind === 'worlds' && imported && <div className="inline-notice inventory-notice" role="status"><span>已导入为新世界「{escapeWorldText(imported)}」，可以直接在游戏的单人游戏列表里打开。</span></div>}
      {importing && instance && <WorldImportDialog instanceId={instance.id} instanceName={instance.name} close={() => setImporting(false)} done={name => { setImporting(false); setImported(name); refresh(); setRetry(value => value + 1) }} />}
      <div className="inventory-meta"><span>目录：<code>game/{tab.folder}/</code> · 仅此目录一层</span>{inventory && <span>读取时间：<time dateTime={inventory.observedAt}>{timeLabel(inventory.observedAt)}</time></span>}</div>
      {inventory?.truncated && <div className="inline-notice inventory-notice"><AlertTriangle size={17} /><span>本次扫描未完成，当前不是目录的完整清单。搜索和排序只作用于已经读取的 {inventory.items.length} 个条目，原因见下方扫描提示。</span></div>}
      {!!inventory?.warnings.length && <details className="inventory-warnings"><summary>扫描提示（{inventory.warnings.length}）</summary><ul>{inventory.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}><span>{kind === 'worlds' ? escapeWorldText(warning.message) : warning.message}</span>{warning.relativePath && <code>{kind === 'worlds' ? escapeWorldText(warning.relativePath) : warning.relativePath}</code>}</li>)}</ul></details>}
      {message ? <ErrorBox message={message} retry={!installing && isDesktop ? refresh : undefined} /> : !instance ? <EmptyState icon={<Folder size={28} />} title={instances.length ? '请选择一个实例' : '还没有游戏实例'}>从上方选择实例，或返回启动页添加游戏。</EmptyState> : !isDesktop ? <div className="inventory-placeholder"><Monitor size={25} /><h3>桌面版可读取实例内容</h3><p>此预览没有本机文件访问权限，因此不显示文件数量或示例条目。</p></div> : installing ? <div className="inventory-placeholder"><Package size={25} /><h3>安装完成后查看</h3><p>当前不会扫描或展示旧的目录清单。</p></div> : loading || !inventory ? <div className="loading-state" role="status"><Spinner />正在读取 {tab.folder} 目录…</div> : !filtered.length ? <div className="inventory-placeholder"><Folder size={25} /><h3>{query ? '没有匹配的文件名' : inventory.truncated || inventory.warnings.length ? '本次未取得可展示条目' : '此目录暂无条目'}</h3><p>{query ? '搜索仅检查这次已读取的条目，可以修改或清除关键词。' : inventory.truncated || inventory.warnings.length ? '请检查扫描提示，不能据此判断实际目录为空。' : '目录尚未创建或其中没有可展示的文件与文件夹。'}</p>{query && <button type="button" className="text-button" onClick={() => { setQuery(''); setPage(0) }}>清除搜索</button>}</div> : <>
        <p className="inventory-result-count" role="status">{query ? `${filtered.length} 个匹配条目 / 已读取 ${inventory.items.length} 个` : `已读取 ${inventory.items.length} 个条目`}{inventory.truncated && ' · 非完整清单'}</p>
        <div className="inventory-table-wrap"><table className="inventory-table"><thead><tr><th scope="col">文件名</th><th scope="col">类型 / 后缀</th><th scope="col">大小</th><th scope="col">修改时间</th><th scope="col">曾登记来源</th></tr></thead><tbody>{visibleItems.map(item => <tr key={item.id} className={selectedItemId === item.id ? 'selected' : undefined}><td><button type="button" className="inventory-file-button" aria-pressed={selectedItemId === item.id} aria-controls={`${id}-details`} onClick={() => setSelectedItemId(item.id)}>{item.entryType === 'directory' ? <Folder size={17} /> : <File size={17} />}<span>{kind === 'worlds' ? escapeWorldText(item.name) : item.name}</span></button></td><td>{typeLabel(item)}{item.activation === 'disabled-suffix' && <small>禁用后缀</small>}</td><td className="inventory-size">{inventorySize(item)}</td><td><time dateTime={item.modifiedAt}>{timeLabel(item.modifiedAt)}</time></td><td>{item.recordedSource ? sourceNames[item.recordedSource.source] : '无关联登记'}</td></tr>)}</tbody></table></div>
        {pageCount > 1 && <div className="inventory-pagination"><button type="button" className="button secondary" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setSelectedItemId('') }}>上一页</button><span>已读取清单第 {currentPage + 1} / {pageCount} 页 · 每页最多 {pageSize} 条</span><button type="button" className="button secondary" disabled={currentPage + 1 >= pageCount} onClick={() => { setPage(currentPage + 1); setSelectedItemId('') }}>下一页</button></div>}
        <InventoryDetails item={selectedItem} kind={kind} id={`${id}-details`} />
        {kind === 'worlds' && instance && selectedItem?.entryType === 'directory' && <WorldMap key={`${instance.id}:${selectedItem.id}`} instanceId={instance.id} selection={{ itemId: selectedItem.id, name: selectedItem.name }} disabled={instance.status === 'running'} />}
        {kind === 'worlds' && instance && selectedItem?.entryType === 'directory' && <WorldDetails instance={instance} item={selectedItem} busy={fileBusy || loading || installing} refreshRevision={refreshRevision}
          read={(selection, source) => call<WorldDetailsData>('worldDetails', instance.id, selection, { source })}
          reveal={revision => call<WorldSeed>('worldDetailsWithSeed', instance.id, revision)} />}
        {kind === 'worlds' && instance && selectedItem?.entryType === 'directory' && <WorldDatapacks instance={instance} item={selectedItem} busy={fileBusy || loading || installing} refreshRevision={refreshRevision} />}
        {kind === 'worlds' && instance && selectedItem?.entryType === 'directory' && onBackupWorld && onCancelWorldBackup && <WorldBackupActions instance={instance} item={selectedItem} busy={fileBusy || loading || installing} tasks={backupTasks}
          list={() => call<WorldBackupList>('worldBackups', instance.id)}
          create={() => onBackupWorld(instance.id, { itemId: selectedItem.id, name: selectedItem.name })}
          cancel={onCancelWorldBackup}
          open={backupId => call<void>('openWorldBackup', instance.id, backupId)}
          exportTasks={exportTasks}
          listExports={() => call<WorldZipList>('worldExports', instance.id)}
          exportZip={onExportWorldBackup ? backupId => onExportWorldBackup(instance.id, backupId) : undefined}
          cancelExport={onCancelWorldExport}
          openExport={exportId => call<void>('openWorldExport', instance.id, exportId)}
          instances={instances} restored={() => { setRetry(value => value + 1) }} />}
        {kind === 'mods' && instance && selectedItem && onPrepareMod && onCommitMod && <ModToggleActions instance={instance} item={selectedItem} busy={fileBusy || loading || installing || modDetailsBusy} prepare={(selection, enabled) => onPrepareMod(instance.id, selection, enabled)} commit={token => onCommitMod(instance.id, token)} completed={renamed} />}
      </>}
      {kind === 'mods' && instance && <ModDetails instance={instance} item={selectedItem} busy={fileBusy || loading || installing} readBusy={modDetailsBusy} refreshRevision={refreshRevision + retry}
        onActivityChange={(operationId, instanceId, active) => setModDetailsOperations(previous => {
          const next = { ...previous }
          if (active) next[operationId] = instanceId
          else delete next[operationId]
          return next
        })} />}
      <p className="inventory-footer-note">{kind === 'worlds' ? '世界信息、地图和数据包预览只读文件，不会修改或升级世界；备份、恢复和导入另需明确操作。' : <>{kind === 'mods' ? '声明读取只读文件；启停操作仅改变一个文件的名称，不自动联动依赖。禁用后下载来源登记不迁移，恢复原名后可重新显示历史来源。' : '不解压资源或推断兼容、启用和实际加载状态。'}“曾登记来源”不代表当前内容已通过哈希验证。</>}</p>
    </section>
  </div>
}
