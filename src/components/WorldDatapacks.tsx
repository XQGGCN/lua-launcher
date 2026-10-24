import { useEffect, useId, useRef, useState, type MutableRefObject } from 'react'
import { FileArchive, FileSearch, Folder, RefreshCw, Search, X } from 'lucide-react'
import type { DatapackCompatibility, DatapackInventoryItem, DatapackMetadata, WorldDatapackInventory, WorldDatapackPreview } from '../../desktop/datapack-types'
import { call, errorText, isDesktop, type Instance, type InventoryItem } from '../api'
import { ErrorBox, Spinner } from './ui'
import DatapackDiscovery from './DatapackDiscovery'
import { escapeWorldText, worldDetailsBlockedReason } from './WorldDetails'
import './WorldDatapacks.css'

interface WorldDatapacksProps {
  instance: Instance
  item: InventoryItem
  busy: boolean
  refreshRevision?: number
}
type Operation = { id: string; context: string; phase: 'inventory' | 'item' | 'picker'; name?: string }
type Preview = { context: string; value: WorldDatapackPreview; source: 'world' | 'local' }
const pageSize = 20

function sizeLabel(bytes?: number): string {
  if (bytes === undefined) return '未统计'
  if (bytes < 1024) return `${bytes.toLocaleString('zh-CN')} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}
function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '未知'
}
function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null
  return <details className="world-datapack-warnings"><summary>读取提示（{warnings.length}）</summary><ul>{warnings.map((warning, index) => <li key={index}>{escapeWorldText(warning)}</li>)}</ul></details>
}
function Metadata({ metadata }: { metadata: DatapackMetadata }) {
  return <>
    <dl className="world-datapack-fields"><dt>说明</dt><dd>{metadata.description ? escapeWorldText(metadata.description) : '未提供说明'}</dd><dt>声明的格式</dt><dd>{escapeWorldText(metadata.formatSummary)}</dd>
      {!!metadata.features.length && <><dt>声明的特性</dt><dd>{metadata.features.map(value => escapeWorldText(value)).join('、')}<small>未核对世界是否启用这些特性</small></dd></>}
      {!!metadata.overlays.length && <><dt>覆盖层记录</dt><dd>{metadata.overlays.map(value => escapeWorldText(value)).join('、')}<small>不表示覆盖层已加载或内容兼容</small></dd></>}
    </dl>
    <Warnings warnings={metadata.warnings} />
  </>
}
function Compatibility({ label, value }: { label: string; value: DatapackCompatibility }) {
  const text = value.status === 'declared-compatible' ? '声明范围匹配' : value.status === 'declared-incompatible' ? '声明范围不匹配' : value.status === 'unsupported' ? '当前检查器不支持判断' : '未知'
  return <div className={`world-datapack-compatibility ${value.status}`}><dt>{label}{value.version && <small>{escapeWorldText(value.version)}</small>}</dt><dd><strong>{text}</strong><span>{escapeWorldText(value.message)}</span></dd></div>
}

/** A selected world owns its results. Old promises cannot populate a replacement world. */
export default function WorldDatapacks(props: WorldDatapacksProps) {
  const identity = JSON.stringify([props.instance.id, props.item.id, props.item.name, props.item.relativePath, props.item.entryType, props.item.modifiedAt])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  return <WorldDatapacksContext key={identity} {...props} identity={identity} currentIdentity={currentIdentity} />
}

function WorldDatapacksContext({ instance, item, busy, refreshRevision = 0, identity, currentIdentity }: WorldDatapacksProps & { identity: string; currentIdentity: MutableRefObject<string> }) {
  const id = useId()
  const [retry, setRetry] = useState(0)
  const reason = worldDetailsBlockedReason(instance, item, busy, isDesktop).replace('世界详情', '数据包')
  const context = JSON.stringify([identity, refreshRevision, retry, reason])
  const currentContext = useRef(context)
  currentContext.current = context
  const mounted = useRef(true)
  const active = useRef<Operation | undefined>(undefined)
  const [operation, setOperation] = useState<Operation>()
  const [stopping, setStopping] = useState(false)
  const [result, setResult] = useState<{ context: string; value: WorldDatapackInventory }>()
  const [preview, setPreview] = useState<Preview>()
  const [error, setError] = useState<{ context: string; message: string }>()
  const [query, setQuery] = useState('')
  const [discoveryQuery, setDiscoveryQuery] = useState('')
  const discoveryOperations = useRef(new Set<string>())
  const [discoveryBusy, setDiscoveryBusy] = useState(false)
  const [page, setPage] = useState(0)
  const [selectedId, setSelectedId] = useState('')
  const inventory = result?.context === context ? result.value : undefined
  const detail = preview?.context === context && preview.value.revision === inventory?.revision ? preview : undefined
  const currentOperation = operation?.context === context ? operation : undefined
  const message = error?.context === context ? error.message : ''
  const working = Boolean(currentOperation) || discoveryBusy
  const revision = useRef(inventory?.revision)
  revision.current = inventory?.revision
  const current = (key: string) => mounted.current && currentIdentity.current === identity && currentContext.current === key
  const valid = (op: Operation) => current(op.context) && active.current === op
  const matchingWorld = (value: WorldDatapackInventory | WorldDatapackPreview) => value.instanceId === instance.id && value.world.itemId === item.id && value.world.name === item.name
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
  const filtered = (inventory?.items ?? []).filter(pack => pack.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const shownPage = Math.min(page, pageCount - 1)
  const items = filtered.slice(shownPage * pageSize, (shownPage + 1) * pageSize)
  const selectedItemWarnings = inventory?.items.find(pack => pack.itemId === selectedId)?.warnings ?? []

  function cancel(op: Operation) {
    // Cancellation selects one operation, so an old world's cleanup cannot cancel a new world.
    return call<void>('cancelDatapackRead', instance.id, op.id)
  }
  function begin(phase: Operation['phase'], name?: string): Operation {
    const op: Operation = { id: crypto.randomUUID(), context, phase, name }
    active.current = op
    setOperation(op); setStopping(false); setError(undefined)
    return op
  }
  function finish(op: Operation) {
    if (valid(op)) { setOperation(undefined); setStopping(false) }
    if (active.current === op) active.current = undefined
  }
  function refresh() {
    if (reason || active.current || discoveryOperations.current.size) return
    setPreview(undefined); setResult(undefined); setSelectedId(''); setError(undefined); setRetry(value => value + 1)
  }
  async function stop() {
    const op = active.current
    if (!op || !valid(op) || stopping) return
    setStopping(true)
    try { await cancel(op) }
    catch (failure) { if (valid(op)) { setStopping(false); setError({ context: op.context, message: `未能发送停止请求：${escapeWorldText(errorText(failure))}` }) } }
    // Keep the busy state until the original promise actually settles.
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    setResult(undefined); setPreview(undefined); setError(undefined); setSelectedId(''); setQuery(''); setPage(0)
    if (reason) { setOperation(undefined); setStopping(false); return }
    const op = begin('inventory')
    void call<WorldDatapackInventory>('worldDatapacks', instance.id, { itemId: item.id, name: item.name }, op.id).then(value => {
      if (!valid(op)) return
      if (!matchingWorld(value) || typeof value.revision !== 'string' || !value.revision) throw new Error('数据包清单与当前世界不一致，请刷新后重试。')
      setResult({ context: op.context, value })
    }).catch(failure => { if (valid(op)) setError({ context: op.context, message: escapeWorldText(errorText(failure)) }) }).finally(() => finish(op))
    return () => {
      const pending = active.current
      if (pending?.context === context) {
        active.current = undefined
        void cancel(pending).catch(() => {})
      }
    }
  }, [context])

  async function inspect(pack?: DatapackInventoryItem) {
    const selectedRevision = inventory?.revision
    if (reason || !selectedRevision || active.current || discoveryOperations.current.size) return
    const op = begin(pack ? 'item' : 'picker', pack?.name)
    setPreview(undefined); setSelectedId(pack?.itemId ?? '')
    try {
      const value = pack
        ? await call<WorldDatapackPreview>('inspectWorldDatapack', instance.id, selectedRevision, pack.itemId, op.id)
        : await call<WorldDatapackPreview | null>('chooseDatapackZip', instance.id, selectedRevision, op.id)
      if (!valid(op) || revision.current !== selectedRevision || !value) return
      if (!matchingWorld(value) || value.revision !== selectedRevision || (pack && (value.name !== pack.name || value.kind !== pack.kind))) throw new Error('预览结果与当前世界或文件不一致，请刷新后重试。')
      setPreview({ context: op.context, value, source: pack ? 'world' : 'local' })
    } catch (failure) { if (valid(op) && revision.current === selectedRevision) setError({ context: op.context, message: escapeWorldText(errorText(failure)) }) }
    finally { finish(op) }
  }

  return <section className="world-datapacks" aria-labelledby={`${id}-title`} aria-busy={working}>
    <div className="world-datapack-heading"><div><h3 id={`${id}-title`}>世界数据包</h3><p>实例「{escapeWorldText(instance.name)}」 · 世界「{escapeWorldText(item.name)}」</p></div><div className="world-datapack-actions"><button type="button" className="button secondary" disabled={Boolean(reason) || working || !inventory} onClick={() => void inspect()}><FileSearch size={15} aria-hidden="true" />预览本地 ZIP</button><button type="button" className="button secondary" disabled={Boolean(reason) || working} onClick={refresh}><RefreshCw size={15} aria-hidden="true" />刷新列表</button></div></div>
    <p className="world-datapack-note">这里只查看此世界的 <code>datapacks</code> 目录和数据包声明，不安装或更改启用状态。</p>
    {reason ? <p className="world-datapack-notice" role="status">{reason}</p> : <>
      {message && <ErrorBox message={message} retry={!working ? refresh : undefined} />}
      {currentOperation && <div className="world-datapack-loading" role="status"><span><Spinner size={16} />{stopping ? '正在停止读取，请等待文件操作结束…' : currentOperation.phase === 'inventory' ? '正在读取此世界的数据包列表…' : currentOperation.phase === 'picker' ? '正在选择或检查本地 ZIP…' : `正在检查「${escapeWorldText(currentOperation.name ?? '')}」…`}</span><button type="button" className="text-button" disabled={stopping} onClick={() => void stop()}><X size={14} aria-hidden="true" />{stopping ? '正在停止' : '停止读取'}</button></div>}
      {inventory && <>
        <DatapackDiscovery instanceId={instance.id} world={{ itemId: item.id, name: item.name }} revision={inventory.revision} gameVersion={instance.version}
          disabled={Boolean(reason) || Boolean(currentOperation)} queryDraft={discoveryQuery} setQueryDraft={setDiscoveryQuery} refreshWorld={refresh}
          onActivityChange={(operationId, enabled) => {
            if (enabled) discoveryOperations.current.add(operationId)
            else discoveryOperations.current.delete(operationId)
            if (mounted.current && currentIdentity.current === identity) setDiscoveryBusy(discoveryOperations.current.size > 0)
          }} />
        <h4 className="world-datapack-local-heading">此世界目录中的数据包</h4>
        <div className="world-datapack-toolbar"><label className="world-datapack-search"><Search size={15} aria-hidden="true" /><input aria-label="按数据包文件名搜索已读取列表" placeholder="搜索已读取的数据包文件名" value={query} disabled={working} onChange={event => { setQuery(event.target.value); setPage(0); setSelectedId(''); setPreview(undefined) }} /></label><span role="status">{query ? `${filtered.length} 个匹配 / ` : ''}已读取 {inventory.items.length} 项{inventory.truncated && ' · 非完整列表'}</span></div>
        {(inventory.truncated || inventory.warnings.length > 0) && <p className="world-datapack-notice">本次读取有提示，列表可能不完整，请展开查看。</p>}
        <Warnings warnings={inventory.warnings} />
        {!items.length ? <div className="world-datapack-empty"><Folder size={22} aria-hidden="true" /><div><strong>{query ? '没有匹配的数据包文件名' : inventory.truncated || inventory.warnings.length ? '本次没有取得可展示条目' : '此世界尚未发现数据包'}</strong><p>{query ? '搜索仅针对本次已读取的条目。' : !inventory.directoryPresent ? 'datapacks 目录尚未创建；Lua 没有创建或写入该目录。' : '仅查看此目录内的 ZIP 和文件夹，不递归读取其余游戏内容。'}</p></div></div> : <div className="world-datapack-list" aria-label="所选世界的数据包列表">{items.map(pack => <div className={`world-datapack-row${selectedId === pack.itemId ? ' selected' : ''}`} key={pack.itemId}><button type="button" disabled={working} aria-pressed={selectedId === pack.itemId} aria-controls={`${id}-preview`} onClick={() => void inspect(pack)}>{pack.kind === 'zip' ? <FileArchive size={17} aria-hidden="true" /> : <Folder size={17} aria-hidden="true" />}<span><strong>{escapeWorldText(pack.name)}</strong><small>{pack.kind === 'zip' ? 'ZIP' : '文件夹'} · {sizeLabel(pack.sizeBytes)} · 启用状态未知</small>{pack.warnings.length > 0 && <small className="world-datapack-item-warning">有 {pack.warnings.length} 条读取提示，查看详情了解原因</small>}</span><span className="world-datapack-read-label">查看</span></button><time dateTime={pack.modifiedAt}>{dateLabel(pack.modifiedAt)}</time></div>)}</div>}
        {pageCount > 1 && <div className="world-datapack-pagination"><button type="button" className="button secondary" disabled={working || shownPage === 0} onClick={() => { setPage(shownPage - 1); setSelectedId(''); setPreview(undefined) }}>上一页</button><span>第 {shownPage + 1} / {pageCount} 页</span><button type="button" className="button secondary" disabled={working || shownPage + 1 >= pageCount} onClick={() => { setPage(shownPage + 1); setSelectedId(''); setPreview(undefined) }}>下一页</button></div>}
        <p className="world-datapack-observed">列表读取时间：<time dateTime={inventory.observedAt}>{dateLabel(inventory.observedAt)}</time>。已在此世界目录中发现的条目，启用状态均未知。</p>
      </>}
      <div id={`${id}-preview`} className="world-datapack-preview" aria-live="polite">
        {detail && <>
          <div className="world-datapack-preview-heading"><h4>{detail.source === 'local' ? '本地 ZIP 预览' : '数据包详情'} · {escapeWorldText(detail.value.name)}</h4><span>{detail.source === 'local' ? '未写入世界' : '只读查看'}</span></div>
          {detail.value.status !== 'checked' ? <p className="world-datapack-notice">{detail.value.status === 'invalid' ? '此文件未通过检查。' : '当前检查器无法完成此文件的检查。'}{detail.value.reason && ` ${escapeWorldText(detail.value.reason)}`}</p> : <p className="world-datapack-note">{detail.value.kind === 'zip' ? '已完成此 ZIP 的文件检查；不表示游戏内容、依赖或实际加载已经验证。' : '只读取此文件夹根目录的声明文件，未递归检查全部内容。'}</p>}
          {detail.value.metadata && <Metadata metadata={detail.value.metadata} />}
          <dl className="world-datapack-compatibilities"><Compatibility label="实例游戏版本" value={detail.value.instanceCompatibility} /><Compatibility label="世界保存版本" value={detail.value.worldCompatibility} /></dl>
          {(detail.value.archiveBytes !== undefined || detail.value.fileCount !== undefined || detail.value.sha512) && <details className="world-datapack-file-info"><summary>文件检查信息</summary><dl className="world-datapack-fields">{detail.value.archiveBytes !== undefined && <><dt>ZIP 大小</dt><dd>{sizeLabel(detail.value.archiveBytes)}（{detail.value.archiveBytes.toLocaleString('zh-CN')} 字节）</dd></>}{detail.value.fileCount !== undefined && <><dt>检查文件数</dt><dd>{detail.value.fileCount.toLocaleString('zh-CN')}</dd></>}{detail.value.sha512 && <><dt>SHA-512</dt><dd><code>{detail.value.sha512}</code></dd></>}</dl></details>}
          <Warnings warnings={[...new Set([...(detail.source === 'world' ? selectedItemWarnings : []), ...detail.value.warnings])]} />
        </>}
      </div>
    </>}
    <p className="world-datapack-footnote">本页不会修改世界或执行 <code>/reload</code>。格式声明匹配也不保证兼容；将数据包放入世界后，游戏下次载入可能应用它。</p>
  </section>
}
