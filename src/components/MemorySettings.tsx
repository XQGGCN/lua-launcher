import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { call, errorText, isDesktop, type MemoryInfo, type Settings } from '../api'
import { ErrorBox, Spinner } from './ui'

const gigabytes = (value: number) => `${(value / 1024).toFixed(1)} GB`

export default function MemorySettings({ settings, change, instanceId, instanceName }: {
  settings: Settings
  change: (settings: Settings) => void
  instanceId?: string
  instanceName?: string
}) {
  const [info, setInfo] = useState<MemoryInfo | null>(null)
  const [loading, setLoading] = useState(isDesktop)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!isDesktop) return
    let current = true
    setLoading(true); setError(''); setInfo(null)
    void call<MemoryInfo>('memoryInfo', instanceId)
      .then(result => { if (current) setInfo(result) })
      .catch(error => { if (current) setError(errorText(error)) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [instanceId, retry])
  const automatic = settings.memoryMode !== 'manual'
  const rangeMax = Math.min(65536, Math.max(16384, settings.memoryMb, Math.ceil((info?.totalMb || 0) / 512) * 512))
  return <div className="memory-settings">
    <div className="setting-row"><div><h3>内存分配</h3><p>自动模式会在每次启动前，根据游戏和本机内存重新计算。</p></div><select aria-label="内存分配方式" value={automatic ? 'auto' : 'manual'} onChange={event => change({ ...settings, memoryMode: event.target.value as Settings['memoryMode'] })}><option value="auto">自动分配（推荐）</option><option value="manual">手动设置</option></select></div>
    <div className="memory-allocation"><div><strong>{automatic ? '当前建议' : '手动分配上限'}</strong><p>{automatic ? instanceName ? `根据当前实例：${instanceName}` : '根据默认游戏配置估算' : '切换到自动模式后，手动数值仍会保留。'}</p></div><div className="memory-value">{automatic ? loading ? <Spinner size={19} /> : info?.canLaunch ? (info.recommendedMb / 1024).toFixed(1) : '—' : (settings.memoryMb / 1024).toFixed(1)}{(!automatic || (!loading && info?.canLaunch)) && <span>GB</span>}</div></div>
    {!automatic && <div className="range-control"><input aria-label="手动分配内存 MB" type="range" min="1024" max={rangeMax} step="512" value={settings.memoryMb} onChange={event => change({ ...settings, memoryMb: Number(event.target.value) })} /><div><span>1 GB</span><span>{gigabytes(rangeMax / 2)}</span><span>{gigabytes(rangeMax)}</span></div></div>}
    {!isDesktop ? <p className="form-hint">浏览器预览无法读取本机内存。桌面版会在启动前计算实际分配量。</p> : <>
      <div className="memory-details-heading"><span>{loading ? '正在读取系统内存…' : '系统内存快照'}</span><button type="button" className="text-button" disabled={loading} onClick={() => setRetry(value => value + 1)}><RefreshCw size={13} />刷新</button></div>
      {info && <><dl className="memory-metrics"><div><dt>物理内存</dt><dd>{gigabytes(info.totalMb)}</dd></div><div><dt>当前可用（估计）</dt><dd>{gigabytes(info.availableMb)}</dd></div><div><dt>系统预留</dt><dd>{gigabytes(info.reservedMb)}</dd></div><div><dt>安全分配上限</dt><dd>{gigabytes(info.safeMaxMb)}</dd></div></dl>
        {!info.canLaunch ? <div className="inline-notice memory-notice">当前内存不足以安全启动游戏，请关闭其他程序后刷新。至少需要 {gigabytes(info.minimumMb)} 的游戏内存。</div> : !automatic && settings.memoryMb > info.safeMaxMb && <div className="inline-notice memory-notice">手动值高于当前安全上限。启动时会按当时的安全上限限制实际分配量。</div>}
        <p className="form-hint">{info.reason}</p>
      </>}
      {error && <ErrorBox message={`无法读取内存建议：${error}`} retry={() => setRetry(value => value + 1)} />}
    </>}
  </div>
}
