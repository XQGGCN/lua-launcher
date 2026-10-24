import { useEffect, useId, useRef, useState } from 'react'
import { FileArchive, ShieldCheck } from 'lucide-react'
import type { WorldDatapackInstallPlan } from '../../desktop/datapack-install-plan-types'
import { escapeWorldText } from './WorldDetails'
import './DatapackInstallConfirmation.css'

interface Props {
  plan: WorldDatapackInstallPlan
  instanceName: string
  busy: boolean
  installing: boolean
  onInstall: () => void
  onDismiss: () => void
}

/** Explicit review belongs to one opaque capability and is never carried to a new plan. */
export default function DatapackInstallConfirmation({ plan, instanceName, busy, installing, onInstall, onDismiss }: Props) {
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [closed, setClosed] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setClosed(false); setNow(Date.now())
    heading.current?.focus({ preventScroll: true })
    heading.current?.scrollIntoView({ block: 'nearest' })
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [plan.capabilityId, plan.previewId])
  const expiry = Date.parse(plan.expiresAt)
  const expired = !Number.isFinite(expiry) || expiry <= now
  const allowed = plan.canInstall && Boolean(plan.capabilityId) && plan.status === 'checked' &&
    plan.instanceCompatibility.status === 'declared-compatible' && plan.worldCompatibility.status === 'declared-compatible'
  const bytes = plan.archiveBytes
  return <section className="datapack-install-confirmation" aria-labelledby={`${id}-title`}>
    <div className="datapack-install-heading"><h4 ref={heading} tabIndex={-1} id={`${id}-title`}><FileArchive size={16} aria-hidden="true" />确认安装到此世界</h4><button type="button" className="text-button" disabled={busy} onClick={onDismiss}>收起安装确认</button></div>
    <dl className="datapack-install-fields"><dt>目标实例</dt><dd>{escapeWorldText(instanceName)}</dd><dt>目标世界</dt><dd>{escapeWorldText(plan.world.name)}</dd><dt>来源</dt><dd>{plan.source === 'modrinth' ? 'Modrinth 下载的 ZIP' : '本地 ZIP'}</dd><dt>目标文件</dt><dd><strong>{escapeWorldText(plan.filename)}</strong><small>放入此世界的 datapacks 目录；已有同名文件不会被覆盖。</small></dd><dt>文件大小</dt><dd>{bytes === undefined ? '未知' : `${(bytes / 1024 ** 2).toFixed(2)} MiB（${bytes.toLocaleString('zh-CN')} 字节）`}</dd><dt>格式声明</dt><dd>{escapeWorldText(plan.metadata?.formatSummary ?? '未取得可用声明')}<small>实例 {escapeWorldText(plan.instanceCompatibility.version ?? '未知')}：{escapeWorldText(plan.instanceCompatibility.message)}<br />世界保存版本 {escapeWorldText(plan.worldCompatibility.version ?? '未知')}：{escapeWorldText(plan.worldCompatibility.message)}</small></dd></dl>
    {plan.status !== 'checked' && <p className="datapack-install-blocked">{plan.status === 'invalid' ? 'ZIP 未通过检查。' : '检查器无法完整检查此 ZIP。'}{plan.reason && ` ${escapeWorldText(plan.reason)}`}</p>}
    {plan.sha512 && <details className="datapack-install-digest"><summary>已检查 ZIP 的 SHA-512</summary><code>{plan.sha512}</code></details>}
    {!!plan.reasons.length && <ul className="datapack-install-blockers">{plan.reasons.map((reason, index) => <li key={index}>{escapeWorldText(reason)}</li>)}</ul>}
    {!!plan.warnings.length && <details className="datapack-install-warnings"><summary>文件检查提示（{plan.warnings.length}）</summary><ul>{plan.warnings.map((warning, index) => <li key={index}>{escapeWorldText(warning)}</li>)}</ul></details>}
    <p className="datapack-install-backup"><ShieldCheck size={16} aria-hidden="true" /><span>确认后先创建此世界的完整新备份，再放入 ZIP。请预留完整备份和暂存文件的空间；成功或失败的暂存资料均会保留，暂不自动清理。</span></p>
    <p className="datapack-install-note">Lua 不修改 <code>level.dat</code> 或执行 <code>/reload</code>。Minecraft 下次载入世界时可能应用此数据包；格式声明匹配不保证内容或依赖能正常运行。</p>
    {!allowed ? <p className="datapack-install-blocked" role="status">当前文件或目标版本未满足安装条件，请查看原因或重新选择文件。</p> : <>
      <label className="datapack-install-checkbox"><input type="checkbox" checked={closed} disabled={busy || expired} onChange={event => setClosed(event.target.checked)} /><span>我已关闭所有正在使用「{escapeWorldText(plan.world.name)}」的游戏和服务端，确认安装到上方实例及世界。</span></label>
      <div className="datapack-install-actions"><button type="button" className="button primary" disabled={busy || expired || !closed} onClick={onInstall}>{installing ? '正在备份并安装…' : '备份世界并安装'}</button><span role="status">{installing ? '请等待当前任务结束；停止请求也需要等待文件操作结算。' : expired ? '此次确认已过期，请重新选择并检查文件。' : `确认有效至 ${new Date(expiry).toLocaleTimeString('zh-CN', { hour12: false })}`}</span></div>
    </>}
  </section>
}
