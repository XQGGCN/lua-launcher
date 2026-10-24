import { useEffect, useId, useRef, useState } from 'react'
import { Check, CheckCircle2, Cpu, Download, FolderOpen, RefreshCw, Search, Square } from 'lucide-react'
import { errorText, type JavaRuntime } from '../api'
import { bytes, ErrorBox, Spinner } from './ui'
import type { SettingsSearchTarget } from './SettingsSearch'

export type JavaDownloadMajor = 17 | 21 | 25
export interface JavaRuntimeView extends JavaRuntime {
  source?: string
  component?: string
}
export interface JavaRuntimeTaskView {
  id: string
  major: number
  status: 'queued' | 'active' | 'cancelling' | 'complete' | 'cancelled' | 'error'
  phase: string
  source?: string
  completedBytes?: number
  totalBytes?: number
  completedFiles?: number
  totalFiles?: number
  error?: string
  path?: string
}
export interface JavaSettingsProps {
  searchTarget?: SettingsSearchTarget
  javaPath: string
  manualJavaPath: string
  onChangeJavaPath: (path: string, manualPath: string) => void
  desktop: boolean
  resetKey?: number
  requirement?: { instanceName: string; major: number; component?: string }
  requirementLoading?: boolean
  requirementError?: string
  onRetryRequirement?: () => void
  runtimes: JavaRuntimeView[]
  detecting?: boolean
  detectError?: string
  onDetect: () => Promise<void>
  tasks: JavaRuntimeTaskView[]
  onInstall: (major: JavaDownloadMajor) => Promise<void>
  onCancelTask: (id: string) => Promise<void>
  onPickJava: () => Promise<string | null>
  onRefresh: () => Promise<void>
}

const isActive = (task: JavaRuntimeTaskView) => ['queued', 'active', 'cancelling'].includes(task.status)
const canDownload = (major: number): major is JavaDownloadMajor => [17, 21, 25].includes(major)
const absolutePath = (value: string) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
const sourceLabel = (source?: string) => source === 'mojang' ? 'Mojang 官方' : source || '本机检测'
const taskStatus: Record<JavaRuntimeTaskView['status'], string> = {
  queued: '等待准备', active: '正在准备', cancelling: '正在取消', complete: '准备完成', cancelled: '已取消', error: '准备失败',
}
type RetryAction = { kind: 'pick' | 'detect' | 'refresh' } | { kind: 'install'; major: JavaDownloadMajor }

export default function JavaSettings(props: JavaSettingsProps) {
  const { javaPath, manualJavaPath, desktop, requirement, runtimes, tasks } = props
  const [manualRequested, setManualRequested] = useState(Boolean(javaPath))
  const [picking, setPicking] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [pendingMajors, setPendingMajors] = useState<number[]>([])
  const [actionError, setActionError] = useState('')
  const [retryAction, setRetryAction] = useState<RetryAction | null>(null)
  const [selectedMajor, setSelectedMajor] = useState<JavaDownloadMajor>(17)
  const mounted = useRef(true)
  const pathInput = useRef<HTMLInputElement>(null)
  const manual = Boolean(javaPath) || manualRequested
  const pathId = useId()
  const requirementId = useId()

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  // Parent advances resetKey for an explicit discard/reset, not while the user types.
  useEffect(() => { setManualRequested(Boolean(javaPath)) }, [props.resetKey])
  useEffect(() => {
    pathInput.current?.setCustomValidity(manual && !absolutePath(javaPath.trim()) ? '请选择或填写 Java 可执行文件的绝对路径。' : '')
  }, [manual, javaPath])

  function choosePath(path: string) {
    setManualRequested(true)
    props.onChangeJavaPath(path, path)
  }
  function showError(error: unknown, retry?: RetryAction) {
    if (!mounted.current) return
    setActionError(errorText(error))
    setRetryAction(retry || null)
  }
  async function pickJava() {
    setPicking(true); setActionError(''); setRetryAction(null)
    try {
      const path = await props.onPickJava()
      if (path && mounted.current) choosePath(path)
    } catch (error) { showError(error, { kind: 'pick' }) }
    finally { if (mounted.current) setPicking(false) }
  }
  async function detectJava() {
    setActionError(''); setRetryAction(null)
    try { await props.onDetect() }
    catch (error) { showError(error, { kind: 'detect' }) }
  }
  async function refresh() {
    setRefreshing(true); setActionError(''); setRetryAction(null)
    try { await props.onRefresh() }
    catch (error) { showError(error, { kind: 'refresh' }) }
    finally { if (mounted.current) setRefreshing(false) }
  }
  async function install(major: JavaDownloadMajor) {
    if (!desktop || pendingMajors.includes(major) || tasks.some(task => task.major === major && isActive(task))) return
    setPendingMajors(current => [...current, major]); setActionError(''); setRetryAction(null)
    try { await props.onInstall(major) }
    catch (error) { showError(error, { kind: 'install', major }) }
    finally { if (mounted.current) setPendingMajors(current => current.filter(value => value !== major)) }
  }
  function retry() {
    if (!retryAction) return
    if (retryAction.kind === 'pick') void pickJava()
    if (retryAction.kind === 'detect') void detectJava()
    if (retryAction.kind === 'refresh') void refresh()
    if (retryAction.kind === 'install') void install(retryAction.major)
  }
  const downloadingSelected = pendingMajors.includes(selectedMajor) || tasks.some(task => task.major === selectedMajor && isActive(task))

  return <section className="java-settings" aria-labelledby={`${pathId}-heading`}>
    <div {...props.searchTarget?.('game.java')} className="setting-row">
      <div><h3 id={`${pathId}-heading`}>Java 运行环境</h3><p>自动匹配游戏所需版本，也可指定本机 Java。</p></div>
      <select aria-label="Java 选择方式" value={manual ? 'manual' : 'auto'} disabled={picking} onChange={event => {
        const nextManual = event.target.value === 'manual'
        setManualRequested(nextManual)
        const saved = manual ? javaPath : manualJavaPath
        props.onChangeJavaPath(nextManual ? saved : '', saved)
      }}><option value="auto">自动管理（推荐）</option><option value="manual">指定本机 Java</option></select>
    </div>
    {manual ? <div className="field java-path-field">
      <label htmlFor={pathId}>Java 可执行文件路径</label>
      <div className="input-with-button">
        <input id={pathId} ref={pathInput} value={javaPath} onChange={event => choosePath(event.target.value)} required disabled={picking} spellCheck={false} autoComplete="off" placeholder="选择 java 或 java.exe 的完整路径" aria-describedby={`${pathId}-hint`} />
        <button type="button" className="button secondary" disabled={!desktop || picking} onClick={() => void pickJava()}>{picking ? <Spinner size={15} /> : <FolderOpen size={15} />}浏览文件</button>
      </div>
      <small id={`${pathId}-hint`}>使用绝对路径。路径无效或版本、架构不匹配时会报错，不会自动改用另一 Java。</small>
    </div> : <p className="java-mode-hint">优先使用本机或 Lua 已管理的匹配版本；缺失时自动下载。不会修改系统 Java 设置。{manualJavaPath && <span>上次指定的路径已保留，切回手动模式可继续使用。</span>}</p>}
    <p className="form-hint java-save-hint">选择方式与路径将在点击页面底部“保存设置”后生效。</p>

    <div className="java-requirement" aria-labelledby={requirementId}>
      <strong id={requirementId}>当前实例所需 Java</strong>
      {!desktop ? <p>浏览器预览无法检查本机环境。请在桌面版读取游戏要求、检测或下载 Java。</p> : props.requirementLoading ? <p role="status"><Spinner size={14} />正在读取游戏版本清单…</p> : requirement ? <p><span>{requirement.instanceName}</span><b>Java {requirement.major}</b>{requirement.component && <small>{requirement.component}</small>}</p> : !props.requirementError ? <p>先在启动页选择一个游戏实例，所需版本将从该游戏的官方清单读取。</p> : null}
      {desktop && props.requirementError && <ErrorBox message={props.requirementError} retry={props.onRetryRequirement} />}
    </div>

    <div {...props.searchTarget?.('game.java-detect')} className="java-section-heading"><h4>本机可用 Java</h4><button type="button" className="text-button" disabled={!desktop || props.detecting} onClick={() => void detectJava()}>{props.detecting ? <Spinner size={14} /> : <Search size={14} />}重新检测</button></div>
    {props.detectError && <ErrorBox message={props.detectError} retry={desktop ? () => void detectJava() : undefined} />}
    {props.detecting ? <p className="java-list-message" role="status">正在检查系统与 Lua 管理的运行时…</p> : runtimes.length ? <div className="java-runtime-list">{runtimes.map(runtime => <button type="button" key={runtime.path} className={`runtime-item ${manual && javaPath === runtime.path ? 'selected' : ''}`} disabled={!desktop || picking} aria-pressed={manual && javaPath === runtime.path} onClick={() => choosePath(runtime.path)} aria-label={`指定 Java ${runtime.major}，${runtime.arch}，${runtime.path}`}>
      <Cpu size={18} /><span><strong>Java {runtime.major} · {runtime.version} · {runtime.arch}</strong><small>{sourceLabel(runtime.source)}{runtime.component ? ` · ${runtime.component}` : ''}</small><small className="java-runtime-path">{runtime.path}</small></span>{manual && javaPath === runtime.path && <Check size={17} />}
    </button>)}</div> : <p className="java-list-message">{desktop ? props.detectError ? '检测未完成，可重试或浏览 Java 可执行文件。' : '没有检测到可用 Java。可保持自动管理，或在下方提前下载。' : '运行时检测需要桌面版。'}</p>}

    <div className="java-section-heading"><h4>提前下载 Java</h4><button type="button" className="text-button" disabled={!desktop || refreshing} onClick={() => void refresh()}>{refreshing ? <Spinner size={14} /> : <RefreshCw size={14} />}刷新状态</button></div>
    <div {...props.searchTarget?.('game.java-download')} className="java-download-controls">
      <label htmlFor={`${pathId}-download`}>Java 版本</label><select id={`${pathId}-download`} value={selectedMajor} onChange={event => setSelectedMajor(Number(event.target.value) as JavaDownloadMajor)} disabled={!desktop}>{([17, 21, 25] as const).map(major => <option key={major} value={major}>Java {major}{requirement?.major === major ? ' · 当前实例需要' : ''}</option>)}</select>
      <button type="button" className="button secondary" disabled={!desktop || downloadingSelected} onClick={() => void install(selectedMajor)}>{downloadingSelected ? <Spinner size={15} /> : <Download size={15} />}{downloadingSelected ? '正在准备…' : '下载 Java'}</button>
    </div>
    <p className="form-hint">运行时保存在 Lua 数据目录，适用于当前系统和架构。可用版本以下载源为准；下载完成不会改动上方选择的 Java 路径。</p>
    {actionError && <ErrorBox message={actionError} retry={retryAction ? retry : undefined} />}
    {tasks.length > 0 && <JavaTaskList tasks={tasks} desktop={desktop} onCancel={props.onCancelTask} onRetry={props.onInstall} />}
  </section>
}

export function JavaTaskList({ tasks, desktop, onCancel, onRetry, busyMajors = [] }: {
  tasks: JavaRuntimeTaskView[]
  desktop: boolean
  onCancel?: (id: string) => Promise<void>
  onRetry?: (major: JavaDownloadMajor) => Promise<void>
  busyMajors?: number[]
}) {
  const tasksId = useId()
  const [cancelling, setCancelling] = useState<string[]>([])
  const [pendingMajors, setPendingMajors] = useState<number[]>([])
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    setCancelling(current => current.filter(id => tasks.some(task => task.id === id && isActive(task))))
  }, [tasks])
  async function cancelTask(id: string) {
    if (!desktop || !onCancel || cancelling.includes(id)) return
    setCancelling(current => [...current, id]); setError('')
    try { await onCancel(id) }
    catch (error) {
      if (mounted.current) {
        setCancelling(current => current.filter(value => value !== id))
        setError(errorText(error))
      }
    }
    // Do not report cancellation until the backend supplies a terminal status.
  }
  async function retry(major: JavaDownloadMajor) {
    if (!desktop || !onRetry || busyMajors.includes(major) || pendingMajors.includes(major) || tasks.some(task => task.major === major && isActive(task))) return
    setPendingMajors(current => [...current, major]); setError('')
    try { await onRetry(major) }
    catch (error) { if (mounted.current) setError(errorText(error)) }
    finally { if (mounted.current) setPendingMajors(current => current.filter(value => value !== major)) }
  }
  const activeTasks = tasks.filter(isActive).length
  const orderedTasks = [...tasks].sort((a, b) => Number(isActive(b)) - Number(isActive(a)))
  return <section className="java-task-list" aria-labelledby={tasksId}>
      <div className="java-section-heading"><h4 id={tasksId}>Java 准备任务</h4>{activeTasks > 0 && <span>{activeTasks} 个进行中</span>}</div>
      {orderedTasks.map(task => {
        const active = isActive(task)
        const cancelPending = task.status === 'cancelling' || cancelling.includes(task.id)
        const knownTotal = Number.isFinite(task.totalBytes) && (task.totalBytes || 0) > 0
        const downloaded = Math.max(0, task.completedBytes || 0)
        const percentage = knownTotal ? Math.min(100, Math.round(downloaded / task.totalBytes! * 100)) : undefined
        return <article className={`java-task java-task-${task.status}`} key={task.id}>
          <div className="java-task-heading"><div><strong>Java {task.major}</strong><span>{task.source ? `来源：${sourceLabel(task.source)}` : '来源尚未确认'}</span></div><span className="java-task-state" role="status">{task.status === 'complete' && <CheckCircle2 size={14} />}{cancelPending && active ? '正在取消…' : taskStatus[task.status]}</span></div>
          <p className="java-task-phase">{task.phase}</p>
          {active && <><progress value={percentage} max={100} aria-label={`Java ${task.major} 文件下载进度`} /><div className="java-task-metrics"><span>{knownTotal ? `${bytes(downloaded)} / ${bytes(task.totalBytes!)}${percentage !== undefined ? ` · ${percentage}%` : ''}` : downloaded > 0 ? `已下载 ${bytes(downloaded)} · 总大小待确定` : '总大小待确定'}{typeof task.totalFiles === 'number' && task.totalFiles > 0 && ` · ${task.completedFiles || 0} / ${task.totalFiles} 文件`}</span>{onCancel && <button type="button" className="text-button" disabled={!desktop || cancelPending} onClick={() => void cancelTask(task.id)}>{cancelPending ? <Spinner size={13} /> : <Square size={12} />}{cancelPending ? '取消中' : '取消'}</button>}</div></>}
          {task.path && task.status === 'complete' && <p className="java-runtime-path">{task.path}</p>}
          {task.error && <ErrorBox message={task.error} />}
          {(task.status === 'error' || task.status === 'cancelled') && canDownload(task.major) && onRetry && <button type="button" className="text-button java-task-retry" disabled={!desktop || busyMajors.includes(task.major) || pendingMajors.includes(task.major) || tasks.some(other => other.major === task.major && isActive(other))} onClick={() => { if (canDownload(task.major)) void retry(task.major) }}><RefreshCw size={13} />{task.status === 'error' ? '重试准备' : '重新准备'}</button>}
        </article>
      })}
      {error && <ErrorBox message={error} />}
      <p className="form-hint">{activeTasks > 0 && '切换页面后任务仍会继续。'}这里只显示本次打开启动器的任务记录；重启后保留已安装的 Java。</p>
  </section>
}
