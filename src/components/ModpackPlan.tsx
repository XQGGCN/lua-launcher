import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Download, LockKeyhole, Search, Square } from 'lucide-react'
import type { PackPlanPage, PackPlanRole, PackPlanRow, PackPlanSummary } from '../../desktop/modpack-plan-types'
import { call, errorText, isDesktop, loaderNames, type Progress, type ResourceSource } from '../api'
import type { PackTask } from './DownloadsView'
import { resourceSources } from './ResourceSourcePicker'
import { bytes, Dialog, ErrorBox, percent, Spinner } from './ui'
import { escapeWorldText } from './WorldDetails'
import './ModpackPlan.css'

export type PreparedModpackPlan = PackPlanSummary & { planId: string; source: 'local' | ResourceSource; expiresAt: string }
export interface ModpackCommitOptions { name: string; selectedOptionalIds: string[]; operationId: string }
export interface ModpackCommitResult { operationId: string; instanceId: string }
export type CommitModpackPlan = (planId: string, options: ModpackCommitOptions, plan: PreparedModpackPlan) => Promise<ModpackCommitResult>
interface Props {
  plan: PreparedModpackPlan
  close: () => void
  commitPlan?: CommitModpackPlan
  tasks: PackTask[]
  progress: Record<string, Progress>
  cancel: (id: string) => Promise<void>
  showTasks: () => void
}
const roles: { id: PackPlanRole | 'all'; label: string }[] = [
  { id: 'all', label: '全部文件' }, { id: 'required', label: '必需下载' }, { id: 'optional', label: '可选下载' },
  { id: 'overrides', label: '共享覆盖' }, { id: 'client-overrides', label: '客户端覆盖' }, { id: 'server-excluded', label: '服务端排除' },
]
const roleNames: Record<PackPlanRole, string> = { required: '必需下载', optional: '可选下载', overrides: '共享覆盖', 'client-overrides': '客户端覆盖', 'server-excluded': '服务端排除' }
const originNames: Record<PackPlanRow['origin'], string> = { indexed: '索引下载', overrides: '共享 overrides', 'client-overrides': '客户端 client-overrides', 'server-overrides': '服务端 server-overrides' }
const sideNames = { required: '必需', optional: '可选', unsupported: '不支持' }
const safe = (value: string) => escapeWorldText(value)
const pageSize = 100
const number = (value: number) => value.toLocaleString('zh-CN')
function size(value: number) { return value < 1024 ? `${number(value)} 字节` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : bytes(value) }
function RowDetails({ row }: { row: PackPlanRow }) {
  return <details className="modpack-plan-row-details"><summary>来源与声明</summary><dl>
    <dt>来源层</dt><dd>{originNames[row.origin]}</dd>
    <dt>文件大小依据</dt><dd>{row.sizeBasis === 'declared-download' ? '索引声明的下载大小' : row.sizeBasis === 'verified-archive' ? '当前包内载荷的展开大小' : '归档声明大小'}</dd>
    {row.environment && <><dt>运行环境声明</dt><dd>{row.environment.implicit ? '索引未声明环境，沿用客户端必需处理' : `客户端：${sideNames[row.environment.client]}；专用服务端：${sideNames[row.environment.server]}`}</dd></>}
    {row.shadowedByOrigin && <><dt>后层采用来源</dt><dd>{originNames[row.shadowedByOrigin]}</dd></>}
    {!!row.shadowOrigins.length && <><dt>同路径先前来源</dt><dd>{row.shadowOrigins.map((value, index) => <span key={index}>{index > 0 && ' → '}{originNames[value]}</span>)} → 当前来源</dd></>}
    {(row.sha1 || row.sha512) && <><dt>摘要依据</dt><dd>{row.hashBasis === 'archive-payload' ? '当前包内真实载荷' : '整合包索引声明'}，不代表文件代码可信。</dd>{row.sha1 && <><dt>SHA-1</dt><dd><code>{row.sha1}</code></dd></>}{row.sha512 && <><dt>SHA-512</dt><dd><code>{row.sha512}</code></dd></>}</>}
  </dl></details>
}

/** Selection spans the entire prepared archive, independently of the current page. */
export default function ModpackPlan({ plan, close, commitPlan, tasks, progress, cancel, showTasks }: Props) {
  const id = useId(), mounted = useRef(true), request = useRef(0), operation = useRef<string | undefined>(undefined)
  const allOptional = useMemo(() => [...plan.defaultOptionalIds], [plan])
  const [selected, setSelected] = useState<string[]>(() => [...plan.defaultOptionalIds])
  const [name, setName] = useState(plan.preview.name.slice(0, 60))
  const [query, setQuery] = useState(''), [submitted, setSubmitted] = useState(''), [role, setRole] = useState<PackPlanRole | 'all'>('all')
  const [includeExcluded, setIncludeExcluded] = useState(false), [offset, setOffset] = useState(0), [retry, setRetry] = useState(0)
  const [loadedPage, setLoadedPage] = useState<{ context: string; value: PackPlanPage }>(), [pageLoading, setLoading] = useState(true), [error, setError] = useState('')
  const [saving, setSaving] = useState(false), [cancelling, setCancelling] = useState(false), [now, setNow] = useState(Date.now())
  const selectionKey = JSON.stringify(selected), pageContext = JSON.stringify([plan.planId, offset, submitted, includeExcluded, role, selected])
  const latestPageContext = useRef(pageContext); latestPageContext.current = pageContext
  const page = loadedPage?.context === pageContext ? loadedPage.value : undefined, loading = pageLoading || !page && !error
  const expiry = Date.parse(plan.expiresAt), expired = !Number.isFinite(expiry) || expiry <= now
  const task = tasks.find(value => value.id === operation.current)
  const otherActive = tasks.some(value => value.status === 'active' && value.id !== operation.current)
  const currentProgress = task ? progress[task.instanceId || task.id] : undefined
  const sourceName = plan.source === 'local' ? '本地文件' : resourceSources[plan.source].label
  const currentCounts = page?.counts
  useEffect(() => { mounted.current = true; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => { mounted.current = false; ++request.current; window.clearInterval(timer) } }, [])
  useEffect(() => {
    const generation = ++request.current
    setLoading(true); setLoadedPage(undefined); setError('')
    call<PackPlanPage>('modpackPlanPage', plan.planId, { offset, limit: pageSize, query: submitted, includeExcluded, role, selectedOptionalIds: selected }).then(value => {
      if (!mounted.current || generation !== request.current || latestPageContext.current !== pageContext) return
      if (value.schema !== 1 || value.archiveSha512 !== plan.archiveSha512 || value.planDigest !== plan.planDigest || value.offset !== offset || value.limit !== pageSize || value.items.length > pageSize) throw new Error('文件预览与本次整合包计划不一致，请关闭后重新预览。')
      setLoadedPage({ context: pageContext, value })
    }).catch(failure => { if (mounted.current && generation === request.current && latestPageContext.current === pageContext) setError(safe(errorText(failure))) })
      .finally(() => { if (mounted.current && generation === request.current && latestPageContext.current === pageContext) setLoading(false) })
    return () => { if (generation === request.current) ++request.current }
  }, [plan.planId, plan.archiveSha512, plan.planDigest, offset, submitted, includeExcluded, role, selectionKey, retry])
  function toggle(row: PackPlanRow, checked: boolean) {
    if (!row.selectable || !row.effective || row.role !== 'optional' || saving || expired || !allOptional.includes(row.id)) return
    setSelected(values => checked ? allOptional.filter(value => value === row.id || values.includes(value)) : values.filter(value => value !== row.id))
  }
  async function commit(event: FormEvent) {
    event.preventDefault()
    if (!commitPlan || saving || loading || error || expired || !page || plan.preview.unsupportedReason || otherActive || !isDesktop || operation.current) return
    const operationId = crypto.randomUUID(); operation.current = operationId; setSaving(true); setError('')
    try {
      const result = await commitPlan(plan.planId, { name: name.trim() || plan.preview.name.slice(0, 60), selectedOptionalIds: [...selected], operationId }, plan)
      if (result.operationId !== operationId || !result.instanceId) throw new Error('安装结果与这次操作不一致，请到下载任务查看，勿重复创建实例。')
      if (mounted.current) close()
    } catch (failure) { if (mounted.current) setError(safe(errorText(failure))) }
    finally { if (mounted.current) setSaving(false) }
  }
  async function stopInstall() {
    if (!task || cancelling) return
    setCancelling(true)
    try { await cancel(task.instanceId || task.id) }
    catch (failure) { if (mounted.current) setError(safe(errorText(failure))) }
    finally { if (mounted.current) setCancelling(false) }
  }
  const blocked = Boolean(plan.preview.unsupportedReason) || expired || otherActive || !commitPlan || Boolean(operation.current && !saving)
  return <Dialog title="整合包文件与安装选项" close={close} wide><section className="modpack-plan" aria-label="整合包安装计划">
    <header className="modpack-plan-heading"><h3>{safe(plan.preview.name)}</h3><p>{sourceName} · {safe(plan.preview.versionId)} · Minecraft {safe(plan.preview.minecraftVersion)} · {loaderNames[plan.preview.loader]}{plan.preview.loaderVersion && ` ${safe(plan.preview.loaderVersion)}`}</p>{plan.preview.summary && <p>{safe(plan.preview.summary)}</p>}</header>
    <p className="modpack-plan-purpose">将创建独立新实例。先查看文件，再决定可选下载；必需文件和包内覆盖文件保持安装。</p>
    <dl className="modpack-plan-summary" aria-live="polite"><div><dt>将写入</dt><dd>{loading ? '正在计算…' : `${number(currentCounts?.writeFiles ?? 0)} 个文件 · ${size(currentCounts?.writeBytes ?? 0)}`}</dd></div><div><dt>需要下载</dt><dd>{loading ? '正在计算…' : `${number(currentCounts?.downloadFiles ?? 0)} 个 · ${size(currentCounts?.downloadBytes ?? 0)}`}</dd></div><div><dt>包内覆盖</dt><dd>{number(plan.counts.overrideFiles)} 个 · {size(plan.counts.overrideBytes)}</dd></div><div><dt>可选下载</dt><dd>已选 {number(selected.length)} / {number(allOptional.length)}</dd></div></dl>
    <div className="modpack-plan-tools"><form className="modpack-plan-search" onSubmit={event => { event.preventDefault(); setSubmitted(query.trim()); setOffset(0) }}><label className="search-field compact"><Search size={16} aria-hidden="true" /><input aria-label="搜索整合包内文件路径" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文件路径" disabled={saving} /></label><button type="submit" className="button secondary" disabled={saving}>查找</button></form><label className="modpack-plan-filter"><span>文件角色</span><select aria-label="整合包文件角色" value={role} disabled={saving} onChange={event => { const next = event.target.value as PackPlanRole | 'all'; setRole(next); setOffset(0); if (next === 'server-excluded') setIncludeExcluded(true) }}>{roles.map(value => <option value={value.id} key={value.id}>{value.label}</option>)}</select></label></div>
    <div className="modpack-plan-selection-tools"><div><button type="button" className="text-button" disabled={saving || expired || selected.length === allOptional.length} onClick={() => setSelected([...allOptional])}>全选可选文件</button><button type="button" className="text-button" disabled={saving || expired || !selected.length} onClick={() => setSelected([])}>清空可选文件</button><span>作用于整个包，跨页保留选择。</span></div><label><input type="checkbox" checked={includeExcluded} disabled={saving} onChange={event => { setIncludeExcluded(event.target.checked); setOffset(0); if (!event.target.checked && role === 'server-excluded') setRole('all') }} />显示服务端排除和被覆盖来源</label></div>
    {loading ? <div className="modpack-plan-loading" role="status"><Spinner size={16} />正在读取文件预览…</div> : page && !page.items.length ? <p className="modpack-plan-empty">当前筛选没有文件。请调整路径关键词或文件角色。</p> : page && <div className="modpack-plan-table-scroll"><table className="modpack-plan-table"><caption className="sr-only">本次整合包的文件写入与选择</caption><thead><tr><th scope="col">安装</th><th scope="col">相对游戏目录的路径</th><th scope="col">角色 / 来源</th><th scope="col">大小</th></tr></thead><tbody>{page.items.map(row => <tr key={row.id} className={!row.effective ? 'modpack-plan-excluded' : ''}><td><label className="modpack-plan-row-check"><input type="checkbox" aria-label={`${row.selectable ? '选择可选文件' : row.effective ? '固定安装文件' : '不写入文件'} ${safe(row.path)}`} checked={row.effective && (row.selectable ? selected.includes(row.id) : row.selected)} disabled={!row.selectable || !row.effective || saving || expired} onChange={event => toggle(row, event.target.checked)} />{!row.selectable && row.effective && <LockKeyhole size={13} aria-hidden="true" />}</label></td><td><code className="modpack-plan-path">{safe(row.path)}</code><RowDetails row={row} /></td><td><span>{roleNames[row.role]}</span><small>{row.shadowedBy ? '被后层覆盖，不写入' : !row.effective ? '不安装到客户端' : originNames[row.origin]}</small></td><td className="modpack-plan-size">{size(row.bytes)}</td></tr>)}</tbody></table></div>}
    {page && <nav className="modpack-plan-pagination" aria-label="整合包文件分页"><span>{number(page.total)} 条来源记录 · 每页最多 {pageSize} 条{page.total > 0 && ` · 第 ${Math.floor(page.offset / pageSize) + 1} 页`}</span><div><button type="button" className="button secondary small-button" disabled={saving || loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - pageSize))}>上一页</button><button type="button" className="button secondary small-button" disabled={saving || loading || page.nextOffset === undefined} onClick={() => setOffset(page.nextOffset!)}>下一页</button></div></nav>}
    <p className="modpack-plan-note">“可选”是包作者的环境声明，不保证取消后仍能运行或入服。这里不自动求解模组依赖；文件大小不包含另外准备的游戏、Java和加载器。</p>
    <details className="modpack-plan-archive"><summary>已检查的整合包归档摘要</summary><code>{plan.archiveSha512}</code><p>SHA-512用于绑定这一次归档，不是作者签名或内容代码安全证明。</p></details>
    {plan.preview.unsupportedReason && <ErrorBox message={safe(plan.preview.unsupportedReason)} />}{expired && <ErrorBox message="这次整合包预览已过期，请关闭并重新选择文件或发布版本。" />}{otherActive && <p className="form-hint">已有其他整合包正在安装，请等待完成后再确认。</p>}{!commitPlan && <p className="form-hint">安装入口尚未就绪，请稍后重新打开。</p>}{error && <ErrorBox message={error} retry={!saving && !operation.current && !expired ? () => setRetry(value => value + 1) : undefined} />}{operation.current && !saving && <p className="form-hint">这次安装确认已使用，请到下载任务查看结果或重试已有实例。<button type="button" className="text-button" onClick={() => { close(); showTasks() }}>查看下载任务<ArrowRight size={14} /></button></p>}
    <form className="modpack-plan-confirm" onSubmit={event => void commit(event)}><label className="field"><span>新实例名称</span><input value={name} maxLength={60} required disabled={saving || expired} onChange={event => setName(event.target.value)} aria-describedby={`${id}-install-note`} /></label><p id={`${id}-install-note`} className="form-hint">确认后才创建实例并开始安装。安装失败或取消后的重试会沿用已确认的可选文件选择。</p>
      {saving ? <div className="modpack-plan-progress" role="status"><div className="download-meta"><span>{currentProgress?.phase || '正在确认并安装整合包，请等待…'}</span><span>{currentProgress?.total ? `${percent(currentProgress)}%` : '准备中'}</span></div><progress value={currentProgress?.total ? percent(currentProgress) : undefined} max={100} aria-label="整合包安装进度" /><div className="modpack-plan-progress-actions"><button type="button" className="text-button" onClick={() => { close(); showTasks() }}>查看下载任务<ArrowRight size={15} /></button>{task?.status === 'active' && <button type="button" className="button secondary" disabled={cancelling} onClick={() => void stopInstall()}>{cancelling ? <Spinner size={14} /> : <Square size={13} />}取消安装</button>}</div><p className="form-hint">关闭窗口后安装继续；可在下载任务查看结果。</p></div> : <div className="modal-actions"><button type="button" className="button secondary" onClick={close}>关闭</button><button type="submit" className="button primary" disabled={blocked || loading || Boolean(error) || !page || !isDesktop}><Download size={16} />确认选择并安装</button></div>}
    </form>
  </section></Dialog>
}
