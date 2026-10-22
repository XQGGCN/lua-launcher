import { useEffect, useId, useRef, useState, type MutableRefObject } from 'react'
import { Archive, FileArchive, FolderOpen, RefreshCw, ShieldCheck, Square } from 'lucide-react'
import type { WorldBackupList, WorldBackupProgress, WorldBackupResult, WorldBackupSummary, WorldBackupTask } from '../../desktop/world-backup-types'
import type { WorldZipList, WorldZipProgress, WorldZipResult, WorldZipSummary, WorldZipTask } from '../../desktop/world-zip-types'
import { errorText, isDesktop, type Instance, type InventoryItem } from '../api'
import { escapeWorldText } from './WorldDetails'
import { ErrorBox, Spinner } from './ui'
import './WorldBackupActions.css'

export interface WorldBackupActionsProps {
  instance: Instance
  item: InventoryItem
  busy: boolean
  tasks: WorldBackupTask[]
  list: () => Promise<WorldBackupList>
  create: () => Promise<WorldBackupResult>
  cancel: (task: WorldBackupTask) => Promise<void>
  open: (backupId: string) => Promise<void>
  exportTasks?: WorldZipTask[]
  listExports?: () => Promise<WorldZipList>
  exportZip?: (backupId: string) => Promise<WorldZipResult>
  cancelExport?: (task: WorldZipTask) => Promise<void>
  openExport?: (exportId: string) => Promise<void>
}
export interface WorldBackupTaskListProps {
  tasks: WorldBackupTask[]
  cancel: (task: WorldBackupTask) => Promise<void>
  open: (task: WorldBackupTask) => Promise<void>
}

export const worldBackupIsActive = (task: WorldBackupTask) => task.status === 'active' || task.status === 'cancelling'
export function worldBackupBlockedReason(instance: Instance, item: InventoryItem, busy: boolean, desktop: boolean): string {
  if (!desktop) return '浏览器预览无法创建或读取本机备份，请使用桌面版。'
  if (item.entryType !== 'directory' || !item.name || /[/\\]/.test(item.name) || ['.', '..'].includes(item.name) || item.relativePath !== `saves/${item.name}` || !item.id.startsWith('worlds:')) return '请选择 saves 目录内的一个普通世界文件夹。'
  if (instance.status === 'running') return '请先关闭此实例的游戏，再创建备份。'
  if (instance.status === 'installing' || busy) return '此实例正在启动、安装或修改文件，请等待操作结束后再备份。'
  return ''
}
export function backupBytes(value: number): string {
  if (value < 1024) return `${value.toLocaleString('zh-CN')} 字节`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(2)} GiB`
}
export function worldBackupProgressPercent(progress: WorldBackupProgress): number | undefined {
  if (progress.phase === 'scan' || progress.phase === 'commit') return undefined
  const total = progress.bytesTotal && progress.bytesTotal > 0 ? progress.bytesTotal : progress.filesTotal
  const done = progress.bytesTotal && progress.bytesTotal > 0 ? progress.bytesDone : progress.filesDone
  return total && total > 0 && Number.isFinite(total) && Number.isFinite(done) ? Math.max(0, Math.min(100, done / total * 100)) : undefined
}
const exportPhaseNames: Record<WorldZipProgress['phase'], string> = {
  'validate-backup': '检查备份', export: '压缩打包', 'verify-archive': '回读校验 ZIP', commit: '完成导出',
}
export function worldZipProgressPercent(progress: WorldZipProgress): number | undefined {
  if (progress.phase === 'export' && progress.bytesTotal) return Math.min(100, progress.bytesDone / progress.bytesTotal * 100)
  if (progress.phase === 'verify-archive' && progress.filesTotal) return Math.min(100, progress.filesDone / progress.filesTotal * 100)
  return undefined
}
const phaseNames: Record<WorldBackupProgress['phase'], string> = {
  scan: '扫描世界目录', copy: '复制文件', 'verify-destination': '读回校验备份文件', 'verify-source': '再次校验源世界', commit: '写入完成凭据',
}
function timeLabel(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间无法识别'
}
function sameWorld(value: Pick<WorldBackupSummary, 'instanceId' | 'worldItemId' | 'worldFolderName'>, instance: Instance, item: InventoryItem) {
  return value.instanceId === instance.id && value.worldItemId === item.id && value.worldFolderName === item.name
}

export default function WorldBackupActions(props: WorldBackupActionsProps) {
  const identity = JSON.stringify([props.instance.id, props.item.id, props.item.name, props.item.relativePath, props.item.entryType, props.item.modifiedAt])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  return <WorldBackupContext key={identity} {...props} identity={identity} currentIdentity={currentIdentity} />
}

function WorldBackupContext({ instance, item, busy, tasks, list, create, cancel, open, exportTasks = [], listExports, exportZip, cancelExport, openExport, identity, currentIdentity }: WorldBackupActionsProps & { identity: string; currentIdentity: MutableRefObject<string> }) {
  const id = useId()
  const callbacks = useRef({ list, create, cancel, open, listExports, exportZip, cancelExport, openExport })
  callbacks.current = { list, create, cancel, open, listExports, exportZip, cancelExport, openExport }
  const [exports, setExports] = useState<WorldZipList>()
  const mounted = useRef(true)
  const listRequest = useRef(0)
  const createRequest = useRef(0)
  const createLock = useRef(false)
  const [confirmed, setConfirmed] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [created, setCreated] = useState<WorldBackupResult>()
  const [listing, setListing] = useState(false)
  const [listed, setListed] = useState<WorldBackupList>()
  const [listError, setListError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const localTasks = tasks.filter(task => sameWorld(task, instance, item))
  const completionKey = JSON.stringify(localTasks.filter(task => !worldBackupIsActive(task)).map(task => [task.id, task.status, task.result?.backupId]))
  const exportKey = JSON.stringify(exportTasks.filter(task => task.status === 'complete').map(task => task.id))
  useEffect(() => {
    let live = true
    if (!callbacks.current.listExports || !isDesktop) return
    void callbacks.current.listExports().then(value => { if (live) setExports(value) }).catch(() => { if (live) setExports(undefined) })
    return () => { live = false }
  }, [identity, exportKey, refresh])
  const reason = worldBackupBlockedReason(instance, item, busy, isDesktop)
  const selectionReason = worldBackupBlockedReason({ ...instance, status: 'ready' }, item, false, isDesktop)
  const activeTask = tasks.find(worldBackupIsActive)
  const createReason = reason || (activeTask ? sameWorld(activeTask, instance, item) ? '此世界已有备份正在进行，请等待完成或取消。' : '已有其他世界备份正在进行，请等待完成或取消。' : '')
  const latestCreateReason = useRef(createReason)
  latestCreateReason.current = createReason
  const current = () => mounted.current && currentIdentity.current === identity

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++listRequest.current; ++createRequest.current }
  }, [])
  useEffect(() => { if (createReason) setConfirmed(false) }, [createReason])
  useEffect(() => {
    const ticket = ++listRequest.current
    setListError(''); setListed(undefined)
    if (selectionReason) { setListing(false); return }
    setListing(true)
    void callbacks.current.list().then(value => {
      if (current() && ticket === listRequest.current) setListed(value)
    }).catch(error => { if (current() && ticket === listRequest.current) setListError(escapeWorldText(errorText(error))) })
      .finally(() => { if (current() && ticket === listRequest.current) setListing(false) })
    return () => { if (ticket === listRequest.current) ++listRequest.current }
  }, [identity, selectionReason, completionKey, refresh])

  function refreshList() {
    if (selectionReason || listing) return
    ++listRequest.current; setRefresh(value => value + 1)
  }
  async function beginBackup() {
    if (!confirmed || latestCreateReason.current || createLock.current) return
    const ticket = ++createRequest.current
    createLock.current = true; setConfirmed(false); setCreating(true); setCreateError(''); setCreated(undefined)
    try {
      const result = await callbacks.current.create()
      if (!current() || ticket !== createRequest.current) return
      if (!sameWorld(result, instance, item) || result.format !== 'directory' || result.verifiedAtCompletion !== true) throw new Error('返回的备份结果与当前世界不一致，请刷新备份列表核对。')
      setCreated(result); setRefresh(value => value + 1)
    } catch (error) {
      if (current() && ticket === createRequest.current) { setCreateError(escapeWorldText(errorText(error))); setRefresh(value => value + 1) }
    } finally {
      if (current() && ticket === createRequest.current) { createLock.current = false; setCreating(false) }
    }
  }
  const completed = (listed?.items || []).filter(value => sameWorld(value, instance, item))
    .sort((first, second) => second.completedAt.localeCompare(first.completedAt) || second.backupId.localeCompare(first.backupId))

  return <section className="world-backup-actions" aria-labelledby={`${id}-title`}>
    <div className="world-backup-heading"><h3 id={`${id}-title`}>备份世界</h3><span className="world-backup-local"><ShieldCheck size={13} />仅保存在本机</span></div>
    <p className="world-backup-note">把「{escapeWorldText(item.name)}」完整复制一份到启动器的备份目录，逐个文件校验。备份完成后可以导出为 ZIP，方便转移或分享。</p>
    <label className="world-backup-confirm" htmlFor={`${id}-closed`}><input id={`${id}-closed`} type="checkbox" checked={confirmed} disabled={Boolean(createReason) || creating} onChange={event => setConfirmed(event.target.checked)} /><span>我已关闭正在使用这个世界的游戏和服务器<small>Lua 无法检测其他启动器或命令行打开的游戏，备份中途世界被改动会导致备份失败。</small></span></label>
    <div className="world-backup-start"><button type="button" className="button primary" disabled={!confirmed || Boolean(createReason) || creating} onClick={() => void beginBackup()}>{creating ? <Spinner size={15} /> : <Archive size={15} />}{creating ? '正在备份…' : '开始备份'}</button></div>
    {createReason && <p className="world-backup-notice" role="status">{createReason}</p>}
    {createError && <ErrorBox message={createError} />}
    {created && <div className="world-backup-result" role="status"><p>备份完成：{created.fileCount.toLocaleString('zh-CN')} 个文件，{backupBytes(created.totalBytes)}，已逐个文件校验。</p>{created.warnings.length > 0 && <ul>{created.warnings.map((warning, index) => <li key={index}>{escapeWorldText(warning)}</li>)}</ul>}</div>}
    {localTasks.length > 0 && <div className="world-backup-current"><h4>此世界的备份任务</h4><WorldBackupTaskList tasks={localTasks} cancel={task => callbacks.current.cancel(task)} open={task => task.result ? callbacks.current.open(task.result.backupId) : Promise.reject(new Error('尚未取得完成备份的编号'))} /></div>}
    <div className="world-backup-list-heading"><h4>已完成的备份</h4><button type="button" className="text-button" disabled={Boolean(selectionReason) || listing} onClick={refreshList}>{listing ? <Spinner size={14} /> : <RefreshCw size={14} />}刷新列表</button></div>
    {selectionReason ? <p className="world-backup-note">桌面版可读取本机备份记录；此处不生成示例备份。</p> : listError ? <ErrorBox message={listError} retry={refreshList} /> : listing || !listed ? <p className="world-backup-loading" role="status"><Spinner size={15} />正在读取本地备份记录…</p> : <>
      {listed.truncated && <p className="world-backup-notice">本次列表未完整读取，仅展示已取得的记录；不能据此判断全部备份数量。</p>}
      {listed.incompleteCount > 0 && <p className="world-backup-notice">此实例共发现 {listed.incompleteCount.toLocaleString('zh-CN')} 份未完成资料（包含其他世界）。它们会保留并继续占用空间，不是已完成备份；当前不提供自动清理。</p>}
      {listed.warnings.length > 0 && <details className="world-backup-warnings"><summary>备份列表提示（{listed.warnings.length}）</summary><ul>{listed.warnings.map((warning, index) => <li key={index}>{escapeWorldText(warning)}</li>)}</ul></details>}
      {completed.length ? <ul className="world-backup-history">{completed.map(value => <WorldBackupHistoryRow key={`${instance.id}:${value.backupId}`} backup={value} open={backupId => callbacks.current.open(backupId)}
        exports={(exports?.items || []).filter(item => item.backupId === value.backupId)}
        exportTask={exportTasks.filter(task => task.backupId === value.backupId && task.instanceId === instance.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]}
        exportBusy={exportTasks.some(task => task.status === 'active' || task.status === 'cancelling')}
        exportZip={callbacks.current.exportZip ? () => callbacks.current.exportZip!(value.backupId) : undefined}
        cancelExport={task => callbacks.current.cancelExport ? callbacks.current.cancelExport(task) : Promise.resolve()}
        openExport={exportId => callbacks.current.openExport ? callbacks.current.openExport(exportId) : Promise.resolve()} />)}</ul> : <p className="world-backup-empty">{listed.truncated || listed.warnings.length ? '没有读到这个世界的备份记录，请查看上方提示。' : '这个世界还没有备份。'}</p>}
    </>}
    <p className="world-backup-footnote">备份不会修改原世界。失败或取消时留下的未完成文件夹会保留在备份目录中，可手动删除。</p>
  </section>
}

interface HistoryRowProps {
  backup: WorldBackupSummary
  open: (backupId: string) => Promise<void>
  exports: WorldZipSummary[]
  exportTask?: WorldZipTask
  exportBusy: boolean
  exportZip?: () => Promise<WorldZipResult>
  cancelExport: (task: WorldZipTask) => Promise<void>
  openExport: (exportId: string) => Promise<void>
}
function WorldBackupHistoryRow({ backup, open, exports, exportTask, exportBusy, exportZip, cancelExport, openExport }: HistoryRowProps) {
  const [exportError, setExportError] = useState('')
  const [starting, setStarting] = useState(false)
  async function startExport() {
    if (!exportZip || starting) return
    setStarting(true); setExportError('')
    try { await exportZip() }
    catch (error) { if (mounted.current) setExportError(escapeWorldText(errorText(error))) }
    finally { if (mounted.current) setStarting(false) }
  }
  async function reveal(exportId: string) {
    setExportError('')
    try { await openExport(exportId) } catch (error) { if (mounted.current) setExportError(escapeWorldText(errorText(error))) }
  }
  const running = exportTask && (exportTask.status === 'active' || exportTask.status === 'cancelling')
  const latest = useRef({ backup, open })
  latest.current = { backup, open }
  const mounted = useRef(true)
  const lock = useRef(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function openFolder() {
    if (!isDesktop || lock.current) return
    const id = backup.backupId
    lock.current = true; setOpening(true); setError('')
    try { await latest.current.open(id) }
    catch (error) { if (mounted.current && latest.current.backup.backupId === id) setError(escapeWorldText(errorText(error))) }
    finally { if (mounted.current && latest.current.backup.backupId === id) { lock.current = false; setOpening(false) } }
  }
  return <li><div className="world-backup-history-heading"><time dateTime={backup.completedAt}>{timeLabel(backup.completedAt)}</time><div className="world-backup-row-actions">
      <button type="button" className="button secondary" disabled={!isDesktop || opening} onClick={() => void openFolder()}>{opening ? <Spinner size={14} /> : <FolderOpen size={14} />}打开文件夹</button>
      {exportZip && <button type="button" className="button secondary" disabled={!isDesktop || starting || Boolean(running) || exportBusy} onClick={() => void startExport()}>{starting || running ? <Spinner size={14} /> : <FileArchive size={14} />}导出 ZIP</button>}
    </div></div>
    <p>{backup.fileCount.toLocaleString('zh-CN')} 个文件 · {backup.directoryCount.toLocaleString('zh-CN')} 个文件夹 · {backupBytes(backup.totalBytes)} · 完成时已校验</p>
    {running && exportTask && <div className="world-export-progress"><div><span>{exportTask.status === 'cancelling' ? '正在取消导出…' : exportPhaseNames[exportTask.progress.phase]}</span><button type="button" className="text-button" disabled={exportTask.status === 'cancelling'} onClick={() => void cancelExport(exportTask).catch(error => setExportError(escapeWorldText(errorText(error))))}><Square size={12} />取消</button></div><progress value={worldZipProgressPercent(exportTask.progress)} max="100" aria-label="ZIP 导出进度" /></div>}
    {exportTask?.status === 'error' && !exportError && <ErrorBox message={escapeWorldText(exportTask.error || 'ZIP 导出失败')} />}
    {exports.length > 0 && <ul className="world-export-list">{exports.map(item => <li key={item.exportId}><FileArchive size={15} /><span><strong>{escapeWorldText(item.fileName)}</strong><small>{backupBytes(item.archiveBytes)} · 导出并校验于 {timeLabel(item.completedAt)}</small></span><button type="button" className="text-button" onClick={() => void reveal(item.exportId)}><FolderOpen size={13} />在文件夹中显示</button></li>)}</ul>}
    {error && <ErrorBox message={error} retry={() => void openFolder()} />}
    {exportError && <ErrorBox message={exportError} />}
  </li>
}

export function WorldBackupTaskList({ tasks, cancel, open }: WorldBackupTaskListProps) {
  const ordered = [...tasks].sort((first, second) => Number(worldBackupIsActive(second)) - Number(worldBackupIsActive(first)) || second.startedAt.localeCompare(first.startedAt) || second.id.localeCompare(first.id))
  return <div className="world-backup-task-list">{ordered.map(task => <WorldBackupTaskRow key={`${task.instanceId}:${task.worldItemId}:${task.id}`} task={task} cancel={cancel} open={open} />)}</div>
}

function WorldBackupTaskRow({ task, cancel, open }: { task: WorldBackupTask } & Omit<WorldBackupTaskListProps, 'tasks'>) {
  const latest = useRef({ task, cancel, open })
  latest.current = { task, cancel, open }
  const mounted = useRef(true)
  const cancelLock = useRef(false)
  const openLock = useRef(false)
  const [cancelling, setCancelling] = useState(false)
  const [opening, setOpening] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const [openError, setOpenError] = useState('')
  const active = worldBackupIsActive(task)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function requestCancel() {
    if (!isDesktop || cancelLock.current || latest.current.task.status !== 'active') return
    const target = latest.current.task
    cancelLock.current = true; setCancelling(true); setCancelError('')
    try { await latest.current.cancel(target) }
    catch (error) { if (mounted.current && latest.current.task.id === target.id && latest.current.task.status === 'active') setCancelError(escapeWorldText(errorText(error))) }
    finally { if (mounted.current && latest.current.task.id === target.id) { cancelLock.current = false; setCancelling(false) } }
  }
  async function openFolder() {
    if (!isDesktop || openLock.current || latest.current.task.status !== 'complete' || !latest.current.task.result) return
    const target = latest.current.task
    openLock.current = true; setOpening(true); setOpenError('')
    try { await latest.current.open(target) }
    catch (error) { if (mounted.current && latest.current.task.id === target.id) setOpenError(escapeWorldText(errorText(error))) }
    finally { if (mounted.current && latest.current.task.id === target.id) { openLock.current = false; setOpening(false) } }
  }
  const progress = task.progress
  const status = task.status === 'active' ? phaseNames[progress.phase] : task.status === 'cancelling' ? '正在取消' : task.status === 'complete' ? '备份已完成' : task.status === 'cancelled' ? '已取消' : '备份失败'
  return <article className="world-backup-task">
    <div className="world-backup-task-heading"><h4>{escapeWorldText(task.worldFolderName)}</h4><span>{status}</span></div>
    <p className="world-backup-task-target">本地目录备份 · 实例 ID：<code>{escapeWorldText(task.instanceId)}</code></p>
    {active && <><p className="world-backup-phase">{phaseNames[progress.phase]}{task.status === 'cancelling' && ' · 取消请求处理中，等待任务最终结果'}</p><progress value={worldBackupProgressPercent(progress)} max="100" aria-label={`${escapeWorldText(task.worldFolderName)}：${phaseNames[progress.phase]}进度`} /><div className="world-backup-task-progress"><span>文件 {progress.filesDone.toLocaleString('zh-CN')}{progress.filesTotal === undefined ? '' : ` / ${progress.filesTotal.toLocaleString('zh-CN')}`} · {backupBytes(progress.bytesDone)}{progress.bytesTotal === undefined ? '' : ` / ${backupBytes(progress.bytesTotal)}`}</span><button type="button" className="button secondary" disabled={!isDesktop || cancelling || task.status === 'cancelling'} onClick={() => void requestCancel()}>{cancelling || task.status === 'cancelling' ? <Spinner size={14} /> : <Square size={13} />}{cancelling ? '正在请求取消…' : task.status === 'cancelling' ? '等待取消结果' : '取消备份'}</button></div><p className="world-backup-note">{progress.phase === 'scan' ? '正在实际扫描，总量尚未确定。' : '计数和进度只属于当前阶段，各轮校验分别计数。'}完成提交后收到的取消请求不会撤销备份。</p></>}
    {task.status === 'error' && <ErrorBox message={escapeWorldText(task.error || '备份失败，请回到世界详情核对原因，再重新确认并开始新任务。')} />}
    {(task.status === 'error' || task.status === 'cancelled') && <p className="world-backup-note">若已生成未完成资料，将全部保留并继续占用空间。可返回此世界详情，重新确认后创建新备份；不会自动续传。</p>}
    {task.status === 'active' && cancelError && <ErrorBox message={cancelError} retry={() => void requestCancel()} />}
    {task.status === 'complete' && (task.result ? <div className="world-backup-task-complete"><p>{task.result.fileCount.toLocaleString('zh-CN')} 个文件 · {backupBytes(task.result.totalBytes)} · 完成时已逐文件校验<small>目录格式；当前没有再次校验备份内容</small></p><button type="button" className="button secondary" disabled={!isDesktop || opening} onClick={() => void openFolder()}>{opening ? <Spinner size={14} /> : <FolderOpen size={14} />}打开备份目录</button></div> : <p className="world-backup-note">任务报告已完成，尚未取得完成摘要；可在世界详情刷新备份列表。</p>)}
    {task.result?.warnings.length ? <ul className="world-backup-task-warnings">{task.result.warnings.map((warning, index) => <li key={index}>{escapeWorldText(warning)}</li>)}</ul> : null}
    {openError && <ErrorBox message={openError} retry={() => void openFolder()} />}
  </article>
}
