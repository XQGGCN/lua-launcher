import { useEffect, useId, useRef, useState, type MutableRefObject } from 'react'
import { ArrowRight, Check, Pause, RefreshCw, RotateCcw } from 'lucide-react'
import { errorText, isDesktop, type Instance, type InventoryItem } from '../api'
import { ErrorBox, Spinner } from './ui'
import './ModToggleActions.css'

export interface ModToggleSelection {
  itemId: string
  name: string
  sizeBytes: number
  modifiedAt: string
}
export interface ModTogglePlan {
  token: string
  fromName: string
  toName: string
  enabled: boolean
  expiresAt: number
}
export interface ModToggleResult {
  fromName: string
  toName: string
  enabled: boolean
  oldItemId: string
  newItemId: string
  warnings: string[]
}
export interface ModToggleActionsProps {
  instance: Instance
  item: InventoryItem
  busy: boolean
  prepare: (selection: ModToggleSelection, enabled: boolean) => Promise<ModTogglePlan>
  commit: (token: string) => Promise<ModToggleResult>
  completed: (result: ModToggleResult) => void
}

export function modToggleBlockedReason(instance: Instance, item: InventoryItem, desktop: boolean): string {
  if (!desktop) return '浏览器预览不能修改本机文件，请使用桌面版。'
  if (!['fabric', 'forge', 'neoforge'].includes(instance.loader)) return '此操作仅适用于 Fabric、Forge 或 NeoForge 实例中的模组文件。'
  if (instance.status === 'running') return '请先关闭游戏，再修改模组文件名。'
  if (instance.status !== 'ready') return '请先完成实例安装或修复，再修改模组文件名。'
  if (item.entryType !== 'file' || item.relativePath !== `mods/${item.name}`) return '只支持 mods 目录内的普通文件，不处理目录或其他位置。'
  if (!/^.+\.jar(?:\.disabled)?$/.test(item.name)) return '只支持后缀为小写 .jar 或 .jar.disabled 的文件，不处理其他后缀。'
  if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes! < 0 || !Number.isFinite(Date.parse(item.modifiedAt))) return '文件信息不完整，请刷新清单后重新选择。'
  return ''
}

export default function ModToggleActions(props: ModToggleActionsProps) {
  const identity = JSON.stringify([props.instance.id, props.item.id, props.item.name, props.item.relativePath, props.item.entryType, props.item.sizeBytes, props.item.modifiedAt])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  return <ModToggleContext key={identity} {...props} identity={identity} currentIdentity={currentIdentity} />
}

function ModToggleContext({ instance, item, busy, prepare, commit, completed, identity, currentIdentity }: ModToggleActionsProps & { identity: string; currentIdentity: MutableRefObject<string> }) {
  const id = useId()
  const [plan, setPlan] = useState<ModTogglePlan | null>(null)
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'committing'>('idle')
  const [error, setError] = useState('')
  const [result, setResult] = useState<ModToggleResult | null>(null)
  const [now, setNow] = useState(Date.now)
  const lock = useRef(false)
  const mounted = useRef(true)
  const request = useRef(0)
  const reason = modToggleBlockedReason(instance, item, isDesktop)
  const currentReason = useRef(reason)
  currentReason.current = reason
  const restoring = item.name.endsWith('.jar.disabled')
  const toName = restoring ? item.name.slice(0, -'.disabled'.length) : `${item.name}.disabled`
  const pending = phase !== 'idle'
  const expired = Boolean(plan && now >= plan.expiresAt)
  const blocked = Boolean(reason || busy || pending || result)
  const isCurrent = (ticket: number) => mounted.current && currentIdentity.current === identity && ticket === request.current

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++request.current }
  }, [])
  useEffect(() => {
    if (!plan || result) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [plan, result])
  useEffect(() => {
    if (reason && !pending) setPlan(null)
  }, [reason, pending])

  const readPlan = async () => {
    if (blocked || lock.current) return
    const ticket = ++request.current
    lock.current = true; setPhase('preparing'); setPlan(null); setError('')
    try {
      const next = await prepare({ itemId: item.id, name: item.name, sizeBytes: item.sizeBytes!, modifiedAt: item.modifiedAt }, restoring)
      if (!isCurrent(ticket)) return
      if (currentReason.current) { setError('实例状态已变化，请恢复可操作状态后重新读取。'); return }
      if (!next.token || next.fromName !== item.name || next.toName !== toName || next.enabled !== restoring || !Number.isFinite(next.expiresAt)) throw new Error('返回的确认信息与所选文件不一致，请刷新清单后重新选择。')
      if (Date.now() >= next.expiresAt) throw new Error('确认信息已过期，请重新读取文件信息。')
      setNow(Date.now()); setPlan(next)
    } catch (error) { if (isCurrent(ticket)) setError(errorText(error)) }
    finally { if (isCurrent(ticket)) { lock.current = false; setPhase('idle') } }
  }

  const confirm = async () => {
    if (blocked || !plan || lock.current) return
    if (Date.now() >= plan.expiresAt) { setNow(Date.now()); setError('确认信息已过期，请重新读取后再确认。'); return }
    const ticket = ++request.current
    const prepared = plan
    lock.current = true; setPhase('committing'); setError('')
    try {
      const next = await commit(prepared.token)
      if (!isCurrent(ticket)) return
      if (next.fromName !== prepared.fromName || next.toName !== prepared.toName || next.enabled !== prepared.enabled || next.oldItemId !== item.id || !next.newItemId || !Array.isArray(next.warnings)) {
        throw new Error('操作已返回，但结果与所选文件不一致。请刷新清单核对，不要直接重复修改。')
      }
      setPlan(null); setResult(next)
      try { completed(next) }
      catch { setError('文件名已修改，但界面刷新失败。请手动刷新清单核对。') }
    } catch (error) {
      if (isCurrent(ticket)) { setPlan(null); setError(errorText(error)) }
    } finally { if (isCurrent(ticket)) { lock.current = false; setPhase('idle') } }
  }

  return <section className="mod-toggle-actions" aria-labelledby={`${id}-title`}>
    <div className="mod-toggle-heading"><h3 id={`${id}-title`}>模组文件后缀</h3>{!plan && !result && <button type="button" className="button secondary" disabled={blocked} onClick={() => void readPlan()}>{phase === 'preparing' ? <Spinner size={15} /> : restoring ? <RotateCcw size={15} /> : <Pause size={15} />}{phase === 'preparing' ? '正在读取…' : restoring ? '恢复 .jar' : '禁用文件'}</button>}</div>
    <p className="mod-toggle-note">只修改文件名后缀，不删除文件、不解析模组或检查依赖；后缀不代表游戏实际加载状态。</p>
    {reason && <p className="mod-toggle-unavailable">{reason}</p>}
    {busy && !pending && !result && <p className="mod-toggle-unavailable" role="status">此实例有操作正在进行，请完成或取消后再试。</p>}
    {plan && !reason && <div className="mod-toggle-confirmation" aria-labelledby={`${id}-confirm`}>
      <h4 id={`${id}-confirm`}>确认文件名修改</h4>
      <p className="mod-toggle-target">实例：<strong>{instance.name}</strong> · <code>game/mods</code></p>
      <div className="mod-toggle-filenames"><code>{plan.fromName}</code><ArrowRight size={17} aria-hidden="true" /><code>{plan.toName}</code></div>
      <p className="mod-toggle-warning">{plan.enabled ? '恢复 .jar 后，加载器可能读取此文件；请自行核对依赖、版本和重复模组。' : '其他模组可能依赖此文件，修改后可能导致游戏无法启动；不会自动处理依赖。'}</p>
      <p className="mod-toggle-expiry">{expired ? '确认信息已过期，需要重新读取文件信息。' : <>请在 <time dateTime={new Date(plan.expiresAt).toISOString()}>{new Date(plan.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}</time> 前确认；文件发生变化时需重新读取。</>}</p>
      <div className="mod-toggle-buttons"><button type="button" className="button secondary" disabled={pending} onClick={() => { setPlan(null); setError('') }}>取消</button>{expired ? <button type="button" className="button primary" disabled={blocked} onClick={() => void readPlan()}><RefreshCw size={15} />重新读取并预览</button> : <button type="button" className="button primary" disabled={blocked} onClick={() => void confirm()}>{phase === 'committing' ? <Spinner size={15} /> : null}{phase === 'committing' ? '正在修改…' : '确认修改'}</button>}</div>
    </div>}
    {error && <ErrorBox message={error} />}
    {error && !plan && !result && <div className="mod-toggle-recovery"><p>先核对当前清单；文件已变化或操作结果不确定时，请刷新清单后重新选择。重试只重新读取，不会直接重复修改。</p><button type="button" className="text-button" disabled={blocked} onClick={() => void readPlan()}><RefreshCw size={14} />重新读取并预览</button></div>}
    {result && <div className="mod-toggle-success" role="status"><Check size={17} /><div><p>文件名已修改为 <code>{result.toName}</code>。</p><small>{result.enabled ? '已恢复 .jar 后缀，不代表已加载或兼容。' : '已追加 .disabled 后缀，未检查游戏实际加载状态。'}</small>{result.warnings.length > 0 && <ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</div></div>}
  </section>
}
