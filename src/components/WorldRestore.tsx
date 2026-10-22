import { useEffect, useState, type FormEvent } from 'react'
import { ArchiveRestore, FileUp } from 'lucide-react'
import { call, errorText, loaderNames, type Instance, type WorldRestoreResult, type WorldZipInspection } from '../api'
import { Dialog, ErrorBox, Spinner } from './ui'
import { backupBytes } from './WorldBackupActions'

const validName = (value: string) => Boolean(value.trim()) && value.trim().length <= 80 && !value.trim().startsWith('.') &&
  !/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value) && !/[ .]$/.test(value.trim()) && !/^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)(?:\.|$)/i.test(value.trim())

/** Restore a completed backup as a new world, into this or another instance. */
export function WorldRestoreDialog({ backupId, sourceInstanceId, worldName, instances, close, done }: {
  backupId: string; sourceInstanceId: string; worldName: string; instances: Instance[]; close: () => void; done: (result: WorldRestoreResult, targetId: string) => void
}) {
  const targets = instances.filter(item => item.status !== 'installing')
  const [target, setTarget] = useState(sourceInstanceId)
  const [name, setName] = useState(`${worldName} (恢复)`)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const targetInstance = instances.find(item => item.id === target)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (working || !validName(name)) return
    setWorking(true); setError('')
    try { done(await call<WorldRestoreResult>('restoreWorldBackup', target, sourceInstanceId, backupId, name.trim()), target) }
    catch (error) { setError(errorText(error)); setWorking(false) }
  }
  return <Dialog title="恢复为新世界" close={working ? () => {} : close}>
    <p className="modal-description">把这个备份复制成一个新的世界，逐个文件校验后才出现在存档列表里。不会覆盖任何现有世界，原备份保持不变。</p>
    <form onSubmit={event => void submit(event)}>
      <label className="field"><span>恢复到实例</span><select value={target} disabled={working} onChange={event => setTarget(event.target.value)}>{targets.map(item => <option key={item.id} value={item.id}>{item.name} · {item.version} · {loaderNames[item.loader]}</option>)}</select>{targetInstance?.status === 'running' && <small>这个实例正在运行，请先关闭游戏。</small>}</label>
      <label className="field"><span>新世界名称</span><input value={name} maxLength={80} disabled={working} onChange={event => setName(event.target.value)} /><small>{validName(name) ? '如果已有同名世界，会自动加上编号。' : '名称不能为空，也不能包含 < > : " / \\ | ? * 等字符。'}</small></label>
      {error && <ErrorBox message={error} />}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={working} onClick={close}>取消</button><button className="button primary" disabled={working || !validName(name) || targetInstance?.status === 'running'}>{working ? <Spinner size={16} /> : <ArchiveRestore size={16} />}{working ? '正在恢复…' : '恢复'}</button></div>
    </form>
  </Dialog>
}

/** Pick a world / map ZIP on disk and import it as a new world in this instance. */
export function WorldImportDialog({ instanceId, instanceName, close, done }: { instanceId: string; instanceName: string; close: () => void; done: (folderName: string) => void }) {
  const [selection, setSelection] = useState<{ token: string; preview: WorldZipInspection }>()
  const [choosing, setChoosing] = useState(false)
  const [name, setName] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  async function choose() {
    setChoosing(true); setError('')
    try {
      const picked = await call<{ token: string; preview: WorldZipInspection } | null>('chooseWorldZip')
      if (picked) { setSelection(picked); setName(picked.preview.suggestedName) }
      else if (!selection) close()
    } catch (error) { setError(errorText(error)) }
    finally { setChoosing(false) }
  }
  useEffect(() => { void choose() }, [])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!selection || working || !validName(name)) return
    setWorking(true); setError('')
    try { done((await call<WorldRestoreResult>('importWorldZip', instanceId, selection.token, name.trim())).folderName) }
    catch (error) { setError(errorText(error)); setWorking(false) }
  }
  return <Dialog title="导入世界 / 地图" close={working ? () => {} : close}>
    <p className="modal-description">支持 Lua 导出的世界 ZIP，也支持网上下载的地图压缩包（会自动找到包含 level.dat 的文件夹）。导入到「{instanceName}」，不会覆盖现有世界。</p>
    {!selection ? <div className="world-import-pick">{choosing ? <><Spinner />正在等待选择文件…</> : <button type="button" className="button secondary" onClick={() => void choose()}><FileUp size={16} />选择 ZIP 文件</button>}</div> : <form onSubmit={event => void submit(event)}>
      <dl className="world-import-summary">
        <dt>文件</dt><dd>{selection.preview.fileName}</dd>
        <dt>类型</dt><dd>{selection.preview.format === 'lua-zip' ? 'Lua 世界备份（含逐文件校验）' : '普通地图 / 世界压缩包'}</dd>
        <dt>内容</dt><dd>{selection.preview.fileCount.toLocaleString('zh-CN')} 个文件 · 解压后 {backupBytes(selection.preview.totalBytes)}</dd>
      </dl>
      <label className="field"><span>世界名称</span><input value={name} maxLength={80} disabled={working} onChange={event => setName(event.target.value)} /><small>{validName(name) ? '如果已有同名世界，会自动加上编号。' : '名称不能为空，也不能包含特殊字符。'}</small></label>
      {error && <ErrorBox message={error} />}
      <div className="modal-actions"><button type="button" className="text-button" disabled={working || choosing} onClick={() => void choose()}>换一个文件</button><button type="button" className="button secondary" disabled={working} onClick={close}>取消</button><button className="button primary" disabled={working || !validName(name)}>{working ? <Spinner size={16} /> : <FileUp size={16} />}{working ? '正在导入…' : '导入'}</button></div>
    </form>}
    {!selection && error && <ErrorBox message={error} />}
  </Dialog>
}
