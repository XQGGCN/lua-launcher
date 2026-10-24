import { AppWindow, RefreshCw } from 'lucide-react'
import { platform, type WindowPreferences as Preferences, type WindowPreferencesStatus, type ZoomPercent } from '../api'
import { ErrorBox, Spinner } from './ui'
import type { SettingsSearchTarget } from './SettingsSearch'
import './WindowPreferences.css'

export interface WindowPreferencesControl {
  status: WindowPreferencesStatus | null
  desktop: boolean
  busy: boolean
  error: string
  notice: string
  read: () => Promise<void>
  update: (patch: Partial<Preferences>) => Promise<void>
  resetPlacement: () => Promise<void>
  setZoom: (percent: ZoomPercent) => Promise<void>
  restoreZoom: () => Promise<void>
}

const titleBars = { integrated: '融合标题栏', native: '系统原生标题栏' }

export default function WindowPreferences({ status, desktop, busy, error, notice, read, update, resetPlacement, setZoom, restoreZoom, searchTarget }: WindowPreferencesControl & { searchTarget?: SettingsSearchTarget }) {
  const zoom = status?.zoom
  const selectedZoom = zoom?.effectivePercent != null && zoom.supportedPercents.includes(zoom.effectivePercent) ? zoom.effectivePercent : ''
  const working = busy || Boolean(zoom?.busy)
  const unavailable = !desktop || !status || working
  return <section className="settings-card window-preferences" aria-label="启动器窗口" aria-busy={working}>
    <div className="settings-card-heading"><AppWindow size={20} /><div><h2>启动器窗口</h2><p>单独保存这台电脑上的启动器外观和摆放方式，不影响游戏窗口。</p></div></div>
    {!desktop ? <p className="window-preferences-unavailable">浏览器预览不支持真实窗口设置，请在桌面版中调整。</p> : <>
      {!status && !error && <p className="window-preferences-progress" role="status"><Spinner size={16} />正在读取窗口偏好…</p>}
      {status && <div className="window-chrome-status" role="status"><span>当前窗口：<strong>{titleBars[status.effectiveTitleBarStyle]}</strong></span>{status.pendingTitleBarChange && <span className="window-chrome-pending">已保存的{titleBars[status.preferences.titleBarStyle]}将在下次打开启动器窗口时生效。</span>}</div>}
    </>}
    <div {...searchTarget?.('window.titlebar')} className="setting-row window-preference-row">
      <div><h3 id="window-titlebar-label">标题栏样式</h3><p id="window-titlebar-help">更改后在下次正常打开启动器窗口时生效，当前窗口保持原样。</p>{desktop && status && !status.supportsTitleBarStyle && <p>此平台目前仅使用系统原生标题栏。</p>}</div>
      <select aria-labelledby="window-titlebar-label" aria-describedby="window-titlebar-help" value={status ? status.supportsTitleBarStyle ? status.preferences.titleBarStyle : status.effectiveTitleBarStyle : ''} disabled={unavailable || !status?.supportsTitleBarStyle} onChange={event => void update({ titleBarStyle: event.target.value as Preferences['titleBarStyle'] })}>
        {!status && <option value="">{desktop ? '等待读取' : '桌面版可用'}</option>}
        <option value="integrated">融合标题栏</option><option value="native">系统原生标题栏</option>
      </select>
    </div>
    <label {...searchTarget?.('window.remember')} aria-label={status?.positionManagedByDesktop ? '记住最大化状态' : '记住窗口大小、位置与最大化状态'} className="setting-row toggle-row window-preference-row"><div><h3>{status?.positionManagedByDesktop ? '记住最大化状态' : '记住窗口大小、位置与最大化状态'}</h3><p>{status?.positionManagedByDesktop ? '下次打开时恢复最大化状态；普通窗口的大小和位置由桌面环境管理。' : '下次打开时恢复普通窗口大小和最大化状态，不恢复最小化或全屏。'}</p></div><input type="checkbox" className="switch" checked={status?.preferences.rememberBounds ?? false} disabled={unavailable} onChange={event => void update({ rememberBounds: event.target.checked })} /></label>
    {status?.positionManagedByDesktop && <p className="window-position-note">此环境由桌面环境管理窗口位置，Lua 不指定窗口坐标。</p>}
    <div {...searchTarget?.('window.reset')} className="setting-row toggle-row window-preference-row"><div><h3>恢复窗口摆放</h3><p>{status?.positionManagedByDesktop ? '恢复默认大小；窗口位置由桌面环境安排。' : '立即恢复默认大小，并将窗口移回可见区域。'}已保存的标题栏样式保持不变。</p></div><button type="button" className="button secondary" disabled={unavailable} onClick={() => void resetPlacement()}><RefreshCw size={16} />{status?.positionManagedByDesktop ? '恢复默认大小' : '恢复默认大小和位置'}</button></div>
    <div {...searchTarget?.('window.zoom')} className="setting-row toggle-row window-preference-row window-zoom-row">
      <div><h3 id="interface-zoom-label">界面缩放</h3><p id="interface-zoom-help">只调整启动器内容，不改变游戏窗口或系统显示比例。可用档位由当前窗口模式决定。</p>
        {desktop && zoom && <div className="window-zoom-status" id="interface-zoom-status" role="status"><span>当前比例：<strong>{zoom.effectivePercent === null ? '尚未确认' : `${zoom.effectivePercent}%`}</strong></span>{zoom.requestedPercent !== zoom.effectivePercent && <span>已保存偏好：{zoom.requestedPercent}%</span>}{zoom.reason && <span>{zoom.reason}</span>}</div>}
        {desktop && status && !zoom && <p>此桌面版本暂不提供界面缩放。</p>}
      </div>
      <div className="window-zoom-controls"><select aria-labelledby="interface-zoom-label" aria-describedby={`interface-zoom-help${zoom ? ' interface-zoom-status' : ''}`} value={selectedZoom} disabled={unavailable || !zoom || !zoom.supportedPercents.length} onChange={event => { const percent = Number(event.target.value) as ZoomPercent; if (zoom?.supportedPercents.includes(percent)) void setZoom(percent) }}>
        {selectedZoom === '' && <option value="" disabled>{desktop ? zoom ? zoom.effectivePercent === null ? '尚未确认' : `当前 ${zoom.effectivePercent}%（不可选）` : '暂不可用' : '桌面版可用'}</option>}
        {zoom?.supportedPercents.map(percent => <option key={percent} value={percent}>{percent}%{percent === 100 ? '（默认）' : ''}</option>)}
      </select><button type="button" className="button secondary" disabled={unavailable || !zoom} onClick={() => void restoreZoom()}><RefreshCw size={16} />恢复 100%</button>{desktop && zoom && <small>快捷键 <kbd>{platform === 'darwin' ? 'Command' : 'Ctrl'} + 0</kbd></small>}</div>
    </div>
    {zoom?.issue && <ErrorBox message={zoom.issue} />}
    {desktop && <div className="window-preferences-feedback" aria-live="polite">{working ? <span className="window-preferences-progress"><Spinner size={15} />正在处理窗口偏好…</span> : notice ? <span>{notice}</span> : <span>这些偏好单独保存，无需点击下方的“保存设置”。</span>}</div>}
    {status?.issue && <ErrorBox message={status.issue} />}
    {error && <ErrorBox message={error} retry={desktop && !working ? () => void read() : undefined} />}
  </section>
}
