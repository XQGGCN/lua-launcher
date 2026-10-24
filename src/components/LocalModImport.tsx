import { useEffect, useId, useRef, useState } from 'react'
import { Check, FileUp, Package, X } from 'lucide-react'
import type { LocalModImportPlan, LocalModImportResult } from '../../desktop/mod-import-types'
import { call, errorText, isDesktop, loaderNames, type Instance } from '../api'
import { escapeWorldText } from './WorldDetails'
import { ErrorBox, Spinner } from './ui'
import './LocalModImport.css'

interface Props {
  instance: Instance
  busy: boolean
  refreshRevision?: number
  onActivityChange: (operationId: string, instanceId: string, active: boolean) => void
  onImported: (result: LocalModImportResult) => void
}
type Operation = { id: string; instanceId: string; context: string; target: string; phase: 'prepare' | 'commit'; cancelled: boolean }
type Plan = { context: string; value: LocalModImportPlan }
type Receipt = { target: string; value: LocalModImportResult }
const safeText = (value: string) => escapeWorldText(value)
function sizeLabel(bytes?: number) {
  if (bytes === undefined) return '未知'
  if (bytes < 1024) return `${bytes.toLocaleString('zh-CN')} 字节`
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB（${bytes.toLocaleString('zh-CN')} 字节）`
}
function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '未知'
}
function Warnings({ values }: { values: string[] }) {
  return values.length ? <details className="local-mod-import-warnings"><summary>检查提示（{values.length}）</summary><ul>{values.map((value, index) => <li key={index}>{safeText(value)}</li>)}</ul></details> : null
}
function sameIds(first: string[], second: string[]) {
  const expected = [...second].sort()
  return first.length === second.length && [...first].sort().every((id, index) => id === expected[index])
}
function eligible(plan: LocalModImportPlan) {
  return plan.assessment.eligible && Boolean(plan.capabilityId) && plan.details.status === 'metadata-read' &&
    typeof plan.sha512 === 'string' && /^[a-f0-9]{128}$/i.test(plan.sha512) && plan.sha512 === plan.details.sha512 &&
    Number.isSafeInteger(plan.archiveBytes) && plan.archiveBytes! >= 22 && plan.archiveBytes === plan.details.archiveBytes &&
    plan.assessment.candidateIds.length > 0 && !plan.assessment.reasons.length
}

function Confirmation({ plan, instance, busy, importing, onImport, onDismiss }: {
  plan: LocalModImportPlan; instance: Instance; busy: boolean; importing: boolean; onImport: () => void; onDismiss: () => void
}) {
  const id = useId(), heading = useRef<HTMLHeadingElement>(null)
  const [closed, setClosed] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setClosed(false); setNow(Date.now())
    heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'nearest' })
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [plan])
  const expiry = Date.parse(plan.expiresAt), expired = !Number.isFinite(expiry) || expiry <= now, allowed = eligible(plan)
  const declared = plan.details.documents.flatMap(document => document.mods.map(mod => ({ format: document.format, mod })))
  return <section className="local-mod-import-confirmation" aria-labelledby={`${id}-title`}>
    <div className="local-mod-import-confirmation-heading"><h4 id={`${id}-title`} tabIndex={-1} ref={heading}><Package size={16} aria-hidden="true" />确认导入到此实例</h4><button type="button" className="text-button" disabled={busy} onClick={onDismiss}>收起导入确认</button></div>
    <dl className="local-mod-import-fields"><dt>目标实例</dt><dd>{safeText(instance.name)}</dd><dt>游戏与加载器</dt><dd>{safeText(plan.gameVersion)} · {loaderNames[instance.loader]}{instance.loaderVersion && ` ${safeText(instance.loaderVersion)}`}</dd><dt>来源</dt><dd>本地 JAR 文件</dd><dt>目标位置</dt><dd><code>game/mods/{safeText(plan.filename)}</code><small>仅新增这一个文件，不覆盖同名文件，不恢复已有的禁用模组。</small></dd><dt>文件大小</dt><dd>{sizeLabel(plan.archiveBytes)}</dd><dt>候选 Mod ID</dt><dd>{plan.assessment.candidateIds.length ? plan.assessment.candidateIds.map(value => <code key={value}>{safeText(value)}</code>) : '未取得可用标识'}</dd><dt>已检查的现有文件</dt><dd>{plan.assessment.indexedFiles.toLocaleString('zh-CN')} 个<small>只表示此次有限索引；无法解释或未完整读取的条件不会当作满足。</small></dd></dl>
    {plan.sha512 && <details className="local-mod-import-digest"><summary>已检查文件的 SHA-512</summary><code>{plan.sha512}</code><p>文件摘要不等于可信来源、签名或模组代码安全证明。</p></details>}
    {!!declared.length && <details className="local-mod-import-declarations"><summary>候选声明（{declared.length}）</summary><ul>{declared.map(({ format, mod }, index) => <li key={index}><strong>{safeText(mod.name || mod.id || '未命名声明')}</strong><span>{safeText(mod.id || 'ID 未知')} · {safeText(mod.version || '版本未知')} · {format}</span>{mod.environment && <small>运行环境声明：{safeText(mod.environment)}</small>}</li>)}</ul><p>这里展示声明，不运行 JAR，不自动下载依赖，也不保证实际游戏加载成功。</p></details>}
    {!!plan.assessment.reasons.length && <ul className="local-mod-import-reasons">{plan.assessment.reasons.map((reason, index) => <li key={index}>{safeText(reason)}</li>)}</ul>}
    <Warnings values={[...new Set([...plan.assessment.warnings, ...plan.details.warnings])]} />
    <p className="local-mod-import-note">导入准备资料与完成凭据会保留并占用额外空间，当前没有自动清理或恢复向导。原文件及其他已安装模组不会被改写；不会自动安装前置或切换其他文件的启用状态。</p>
    {!allowed ? <p className="local-mod-import-blocked" role="status">当前文件或实例未满足导入条件。请查看原因，不能强制绕过未知条件。</p> : <>
      <label className="local-mod-import-checkbox"><input type="checkbox" checked={closed} disabled={busy || expired} onChange={event => setClosed(event.target.checked)} /><span>我已关闭所有使用此实例的游戏和服务端，并确认将此文件导入上方实例。</span></label>
      <div className="local-mod-import-confirmation-actions"><button type="button" className="button primary" disabled={busy || expired || !closed} onClick={onImport}>{importing ? '正在导入…' : '确认导入到此实例'}</button><span role="status">{importing ? '请等待文件操作结束；停止请求也需要等待实际任务结算。' : expired ? '这次确认已过期，请重新选择文件并检查。' : `确认有效至 ${new Date(expiry).toLocaleTimeString('zh-CN', { hour12: false })}`}</span></div>
    </>}
  </section>
}

/** Confirmation and completion belong to one explicit instance; view IDs never authorize import. */
export default function LocalModImport({ instance, busy, refreshRevision = 0, onActivityChange, onImported }: Props) {
  const id = useId(), mounted = useRef(true), active = useRef<Operation | undefined>(undefined)
  const target = JSON.stringify([instance.id, instance.name, instance.version, instance.loader, instance.loaderVersion])
  const reason = !isDesktop ? '本地模组导入需要桌面版。' : instance.loader === 'vanilla' ? '请先选择已安装 Fabric、Forge 或 NeoForge 的实例。原版实例不能导入启用模组。' : instance.status !== 'ready' ? '请先完成或修复此实例的安装，并关闭游戏后再导入。' : busy ? '请等待此实例的文件操作或读取结束后再导入。' : ''
  const context = JSON.stringify([target, refreshRevision, reason])
  const currentContext = useRef(context), currentTarget = useRef(target)
  currentContext.current = context; currentTarget.current = target
  const activity = useRef(onActivityChange), imported = useRef(onImported)
  activity.current = onActivityChange; imported.current = onImported
  const [operation, setOperation] = useState<Operation>()
  const [stopping, setStopping] = useState(false)
  const [plan, setPlan] = useState<Plan>()
  const [receipt, setReceipt] = useState<Receipt>()
  const [error, setError] = useState<{ context: string; message: string }>()
  const pending = Boolean(operation), currentPlan = plan?.context === context ? plan.value : undefined
  const result = receipt?.target === target ? receipt.value : undefined
  const valid = (op: Operation) => mounted.current && active.current === op && currentContext.current === op.context && (op.phase === 'commit' || !op.cancelled)
  const cancel = (op: Operation) => call<void>('cancelLocalModImport', op.instanceId, op.id)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; const op = active.current; if (op) { op.cancelled = true; void cancel(op).catch(() => {}) } }
  }, [])
  useEffect(() => {
    setPlan(undefined); setError(undefined)
    const op = active.current
    if (op && op.context !== context) { op.cancelled = true; setStopping(true); void cancel(op).catch(() => {}) }
  }, [context])
  function begin(phase: Operation['phase']) {
    const op: Operation = { id: crypto.randomUUID(), instanceId: instance.id, context, target, phase, cancelled: false }
    active.current = op; setOperation(op); setStopping(false); setError(undefined)
    activity.current(op.id, op.instanceId, true)
    return op
  }
  function finish(op: Operation) {
    activity.current(op.id, op.instanceId, false)
    if (active.current === op) { active.current = undefined; if (mounted.current) { setOperation(undefined); setStopping(false) } }
  }
  async function prepare() {
    if (reason || active.current) return
    const op = begin('prepare'); setPlan(undefined); setReceipt(undefined)
    try {
      const value = await call<LocalModImportPlan | null>('prepareLocalModImport', op.instanceId, op.id)
      if (!valid(op) || !value) return
      if (value.instanceId !== op.instanceId || value.gameVersion !== instance.version || value.loader !== instance.loader || value.source !== 'local' ||
          !value.filename || value.filename !== value.details.name || !/\.jar$/i.test(value.filename) || !Number.isFinite(Date.parse(value.expiresAt)) ||
          value.assessment.eligible && !eligible(value)) throw new Error('导入检查与当前实例或文件不一致，请重新选择并检查。')
      setPlan({ context: op.context, value })
    } catch (failure) { if (valid(op)) setError({ context: op.context, message: safeText(errorText(failure)) }) }
    finally { finish(op) }
  }
  async function commit() {
    const value = currentPlan
    if (reason || active.current || !value || !eligible(value) || !value.capabilityId || Date.parse(value.expiresAt) <= Date.now()) return
    const op = begin('commit'); let completed: LocalModImportResult | undefined
    try {
      const result = await call<LocalModImportResult>('commitLocalModImport', op.instanceId, value.capabilityId, { closedExternalGameConfirmed: true, operationId: op.id })
      // A real completed commit wins over a stop request acknowledged late.
      if (!valid(op)) return
      if (result.operationId !== op.id || result.instanceId !== op.instanceId || result.filename !== value.filename || result.archiveBytes !== value.archiveBytes || result.sha512 !== value.sha512 ||
          !sameIds(result.modIds, value.assessment.candidateIds) || !Number.isFinite(Date.parse(result.installedAt))) throw new Error('导入回执与确认的实例或文件不一致，请保留资料并重新查看状态。')
      setReceipt({ target: op.target, value: result }); setPlan(undefined); completed = result
    } catch (failure) { if (valid(op)) { setPlan(undefined); setError({ context: op.context, message: safeText(errorText(failure)) }) } }
    finally { finish(op); if (completed && mounted.current && currentTarget.current === op.target) imported.current(completed) }
  }
  async function stop() {
    const op = active.current
    if (!op || stopping) return
    op.cancelled = true; setStopping(true)
    try { await cancel(op) }
    catch (failure) { if (mounted.current && currentContext.current === op.context && active.current === op) { setStopping(false); setError({ context: op.context, message: `未能发送停止请求：${safeText(errorText(failure))}` }) } }
  }
  return <section className="local-mod-import" aria-labelledby={`${id}-title`} aria-busy={pending}>
    <div className="local-mod-import-heading"><div><h3 id={`${id}-title`}>导入本地模组</h3><p>目标实例「{safeText(instance.name)}」 · {loaderNames[instance.loader]} · {safeText(instance.version)}</p></div><button type="button" className="button secondary" disabled={Boolean(reason) || pending} onClick={() => void prepare()}><FileUp size={15} aria-hidden="true" />选择本地模组 JAR</button></div>
    {reason && <p className="local-mod-import-note">{reason}</p>}
    {error?.context === context && <ErrorBox message={error.message} />}
    {pending && <div className="local-mod-import-loading" role="status"><span><Spinner size={16} />{operation?.context !== context ? '正在结束先前实例的任务，请等待文件工作结算…' : stopping ? '正在停止，请等待实际文件操作结束…' : operation.phase === 'prepare' ? '正在选择、检查 JAR，并核对现有模组与支持的依赖条件…' : '正在重新核对并导入文件，请等待完成…'}</span><button type="button" className="text-button" disabled={stopping} onClick={() => void stop()}><X size={14} aria-hidden="true" />{stopping ? '正在停止' : '停止导入任务'}</button></div>}
    {currentPlan && <Confirmation key={`${currentPlan.capabilityId || 'blocked'}:${currentPlan.filename}:${currentPlan.expiresAt}`} plan={currentPlan} instance={instance} busy={pending} importing={operation?.phase === 'commit'} onImport={() => void commit()} onDismiss={() => setPlan(undefined)} />}
    {result && <div className="local-mod-import-result" role="status"><Check size={17} aria-hidden="true" /><div><strong>已导入「{safeText(result.filename)}」到实例「{safeText(instance.name)}」</strong><p>位置：<code>game/mods/{safeText(result.filename)}</code> · {dateLabel(result.installedAt)}</p><p>本地声明标识：{result.modIds.map(safeText).join('、')}。来源登记为本地文件；不代表模组已运行或全部组合已验证。</p><details><summary>导入文件的 SHA-512</summary><code>{result.sha512}</code></details><Warnings values={result.warnings} /></div></div>}
    <p className="local-mod-import-footnote">选择文件后先检查，再确认实例和目标文件。已有同名、禁用伙伴、重复标识或未解释的必要条件会阻止导入，不会覆盖、替换或自动启用其他模组。</p>
  </section>
}
