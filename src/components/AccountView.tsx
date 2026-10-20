import { useEffect, useState, type FormEvent } from 'react'
import { Check, ChevronDown, Clipboard, ExternalLink, LogIn, LogOut, Settings2, ShieldCheck, Square, UserRound } from 'lucide-react'
import { call, errorText, isDesktop, type Account, type AuthConfig, type AuthState } from '../api'
import { ErrorBox, PageHeading, Spinner } from './ui'

type Props = {
  account: Account | null
  auth: AuthState
  authError: string
  login: () => Promise<void>
  cancelLogin: () => Promise<void>
  refresh: () => Promise<void>
  openUrl: (url: string) => void
}

export default function AccountView({ account, auth, authError, login, cancelLogin, refresh, openUrl }: Props) {
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(true)
  const [clientId, setClientId] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [configSaved, setConfigSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    setConfigLoading(true)
    call<AuthConfig>('authConfig').then(config => { if (current) { setConfig(config); setClientId(config.source === 'custom' ? config.clientId : '') } }).catch(error => { if (current) setError(errorText(error)) }).finally(() => { if (current) setConfigLoading(false) })
    return () => { current = false }
  }, [retry])
  useEffect(() => {
    setCopied(false); setNow(Date.now())
    if (!auth.active || !auth.deviceCode) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [auth.active, auth.deviceCode?.userCode])
  const remaining = auth.deviceCode ? Math.max(0, Math.ceil((auth.deviceCode.expiresAt - now) / 1000)) : 0
  const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
  const perform = async (kind: string, operation: () => Promise<unknown>) => {
    setBusy(kind); setError('')
    try { await operation() }
    catch (error) { setError(errorText(error)) }
    finally { setBusy('') }
  }
  const saveConfig = async (event: FormEvent) => {
    event.preventDefault(); setConfigSaved(false)
    await perform('config', async () => {
      const saved = await call<AuthConfig>('saveAuthConfig', clientId.trim())
      setConfig(saved); setConfigSaved(true)
      setClientId(saved.source === 'custom' ? saved.clientId : '')
    })
  }
  return <>
    <PageHeading title="游戏账户" subtitle="使用 Microsoft 账户登录 Minecraft Java，或设置本地离线身份。" />
    {account && <div className="account-current"><span className="account-avatar"><UserRound size={28} /></span><div><h2>{account.username}</h2><p>{account.mode === 'microsoft' ? 'Microsoft · Minecraft Java' : '离线模式 · 无在线身份验证'}</p></div><button className="button secondary" disabled={Boolean(busy) || auth.active} onClick={() => void perform('logout', async () => { await call('logout'); await refresh() })}>{busy === 'logout' ? <Spinner size={16} /> : <LogOut size={16} />}退出账户</button></div>}
    <section className="account-card account-login-card">
      <div className="account-section-heading"><div className="account-card-icon"><div className="microsoft-mark"><i /><i /><i /><i /></div></div><div><h2>Microsoft 登录</h2><p>在 Microsoft 官方网页完成授权，无需在启动器输入密码。</p></div></div>
      <div className="security-note"><ShieldCheck size={16} /><span>登录后会验证 Minecraft Java 游戏所有权。</span></div>
      {configLoading ? <div className="auth-config-loading"><Spinner size={15} />正在读取登录配置…</div> : !config?.configured && <div className="auth-config-notice"><p>当前测试版尚未配置 Microsoft 登录应用。维护者完成接入后即可直接登录；自有应用可在高级设置填写。</p><button className="text-button" onClick={() => setAdvanced(true)}><Settings2 size={15} />查看高级设置</button></div>}
      {auth.active ? <div className="auth-progress-panel">
        <div className="auth-status" role="status"><Spinner size={16} /><span>{auth.status?.message || '正在连接 Microsoft…'}</span></div>
        {auth.deviceCode && <>
          <p className="auth-instruction">在 Microsoft 页面输入以下代码：</p>
          <div className="device-code">{auth.deviceCode.userCode}<button className="icon-button" aria-label="复制 Microsoft 授权代码" onClick={() => { navigator.clipboard.writeText(auth.deviceCode!.userCode).then(() => setCopied(true)).catch(() => setError('无法访问剪贴板，请手动复制授权代码。')) }}>{copied ? <Check size={19} /> : <Clipboard size={19} />}</button></div>
          <div className="auth-code-meta"><span>{copied ? '授权代码已复制' : '请勿向其他人分享此代码'}</span><time className={remaining === 0 ? 'expired' : ''}>{remaining > 0 ? `${countdown} 后过期` : '授权码已过期'}</time></div>
          <button className="button secondary" onClick={() => openUrl(auth.deviceCode!.verificationUri)}>打开 Microsoft 授权页<ExternalLink size={15} /></button>
        </>}
        <div className="auth-progress-footer"><span>可以切换页面，授权进度会保留。</span><button className="button secondary" disabled={busy === 'cancel'} onClick={() => void perform('cancel', cancelLogin)}>{busy === 'cancel' ? <Spinner size={14} /> : <Square size={13} />}取消登录</button></div>
      </div> : <div className="auth-login-actions"><button className="button primary" disabled={!isDesktop || configLoading || !config?.configured || Boolean(busy)} onClick={() => { setError(''); void login() }}><LogIn size={17} />使用 Microsoft 登录</button><span>{!isDesktop ? '账户授权需要在桌面版完成。' : config?.configured ? config.source === 'built-in' ? '使用启动器内置登录配置' : '使用已保存的登录配置' : '请先完成下方高级配置'}</span></div>}
      {(authError || (auth.status?.stage === 'error' ? auth.status.message : '')) && <ErrorBox message={authError || auth.status!.message} />}
      {!auth.active && auth.status?.stage === 'cancelled' && <p className="auth-cancelled" role="status">已取消登录，当前账户保持不变。</p>}
    </section>
    <details className="offline-section auth-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
      <summary><Settings2 size={17} /><span>高级：Microsoft 登录应用</span><ChevronDown size={16} /></summary>
      <p>仅在当前构建没有可用登录配置，或需要使用自有应用时修改。Client ID 是应用标识，不是账户密码。</p>
      <form onSubmit={event => void saveConfig(event)}>
        <label className="field"><span>Microsoft 应用 Client ID</span><input value={clientId} onChange={event => { setClientId(event.target.value); setConfigSaved(false) }} placeholder={config?.source === 'built-in' ? '留空使用内置配置' : '输入应用（客户端）ID'} maxLength={100} autoComplete="off" disabled={auth.active || Boolean(busy)} /><small>应用需支持个人 Microsoft 账户、设备代码登录，并具备所需 Minecraft API 访问权限。</small></label>
        <div className="auth-config-actions"><button className="button secondary" disabled={!isDesktop || auth.active || Boolean(busy)}>{busy === 'config' ? <Spinner size={16} /> : <Check size={16} />}保存配置</button><button type="button" className="text-button" onClick={() => openUrl('https://github.com/XQGGCN/lua-launcher/blob/main/docs/MICROSOFT_LOGIN.md')}>Microsoft 登录接入帮助<ExternalLink size={14} /></button>{configSaved && <span className="config-saved" role="status">{config?.configured ? '配置已保存，可尝试登录。' : '已清除自定义配置。'}</span>}</div>
      </form>
    </details>
    <details className="offline-section"><summary><UserRound size={17} /><span>离线模式</span><ChevronDown size={16} /></summary><p>用于离线环境下的本地游玩，不提供正版服务器认证。请使用自己拥有的游戏副本。</p><form onSubmit={event => { event.preventDefault(); void perform('offline', async () => { await call('setOffline', username.trim()); await refresh() }) }}><label className="field"><span>玩家名称</span><input value={username} onChange={event => setUsername(event.target.value)} placeholder="3–16 位字母、数字或下划线" pattern="[A-Za-z0-9_]{3,16}" minLength={3} maxLength={16} required disabled={Boolean(busy) || auth.active} /></label><button className="button secondary" disabled={Boolean(busy) || auth.active || !isDesktop}>{busy === 'offline' ? <Spinner size={16} /> : <UserRound size={16} />}使用离线身份</button></form></details>
    {error && <ErrorBox message={error} retry={!config ? () => setRetry(value => value + 1) : undefined} />}
  </>
}
