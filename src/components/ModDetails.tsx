import { useEffect, useId, useRef, useState } from 'react'
import { FileSearch, FileUp, Package, X } from 'lucide-react'
import type { InstanceModDetails, ModDeclaration, ModMetadataDocument } from '../../desktop/mod-details-types'
import { call, errorText, isDesktop, loaderNames, type Instance, type InventoryItem } from '../api'
import { escapeWorldText } from './WorldDetails'
import { ErrorBox, Spinner } from './ui'
import './ModDetails.css'

interface Props {
  instance: Instance
  item?: InventoryItem
  busy: boolean
  readBusy: boolean
  refreshRevision?: number
  onActivityChange: (operationId: string, instanceId: string, active: boolean) => void
}
type Operation = { id: string; instanceId: string; context: string; source: 'installed' | 'local'; cancelled: boolean }
const formats = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', manifest: 'JAR Manifest', 'quilt-json5': 'Quilt 开发用 JSON5' }
const documentStates = { read: '已读取声明', invalid: '声明无效', unsupported: '当前不支持解释' }
const kindNames: Record<string, string> = { depends: '依赖', required: '必需', recommends: '推荐', suggests: '建议', optional: '可选', conflicts: '冲突', breaks: '不兼容', incompatible: '不兼容', discouraged: '不建议搭配', embedded: '内嵌', mandatory: '必需' }
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
  return values.length ? <details className="mod-details-warnings"><summary>读取提示（{values.length}）</summary><ul>{values.map((value, i) => <li key={i}>{escapeWorldText(value)}</li>)}</ul></details> : null
}
function Declaration({ value }: { value: ModDeclaration }) {
  return <div className="mod-details-declaration">
    <dl className="mod-details-fields"><dt>声明名称</dt><dd>{value.name ? escapeWorldText(value.name) : '未提供'}</dd><dt>Mod ID</dt><dd>{value.id ? <code>{escapeWorldText(value.id)}</code> : '未取得可用标识'}</dd><dt>声明版本</dt><dd>{value.version ? escapeWorldText(value.version) : '未知'}</dd>
      {value.description && <><dt>说明</dt><dd>{escapeWorldText(value.description)}</dd></>}
      <dt>作者</dt><dd>{value.authors.length ? value.authors.map(escapeWorldText).join('、') : '未提供'}</dd><dt>许可声明</dt><dd>{value.licenses.length ? value.licenses.map(escapeWorldText).join('、') : '未提供'}</dd><dt>运行环境声明</dt><dd>{value.environment ? escapeWorldText(value.environment) : '未提供或未解释'}</dd>
    </dl>
    {!!value.provides.length && <details><summary>提供的标识（{value.provides.length}）</summary><ul>{value.provides.map((entry, i) => <li key={i}><code>{escapeWorldText(entry)}</code></li>)}</ul><p>声明别名不表示当前实例已经满足其他模组的依赖。</p></details>}
    <details className="mod-details-dependencies"><summary>依赖与冲突声明（{value.dependencies.length}）</summary>{value.dependencies.length ? <ul>{value.dependencies.map((entry, i) => <li key={i}><div><strong>{escapeWorldText(kindNames[entry.kind] ?? entry.kind)}</strong><code>{escapeWorldText(entry.id)}</code></div><dl><dt>版本条件</dt><dd>{entry.version ? escapeWorldText(entry.version) : '未提供或未解释'}</dd>{entry.environment && <><dt>运行侧声明</dt><dd>{escapeWorldText(entry.environment)}</dd></>}{entry.details && <><dt>其他条件</dt><dd>{escapeWorldText(entry.details)}</dd></>}</dl></li>)}</ul> : <p>未读取到依赖声明，不代表没有依赖。这里不扫描其他 JAR 或求解条件。</p>}</details>
    {!!value.nestedJars.length && <details><summary>内嵌 JAR 声明（{value.nestedJars.length}）</summary><ul>{value.nestedJars.map((entry, i) => <li key={i}><code>{escapeWorldText(entry)}</code></li>)}</ul><p>只展示声明，没有提取、读取或运行内嵌 JAR。</p></details>}
    <Warnings values={value.warnings} />
  </div>
}
function Document({ value, index }: { value: ModMetadataDocument; index: number }) {
  return <details className="mod-details-document" open={index === 0}>
    <summary><span><strong>{formats[value.format]}</strong><code>{escapeWorldText(value.path)}</code></span><span className={`mod-details-document-state ${value.status}`}>{documentStates[value.status]}</span></summary>
    <div className="mod-details-document-body">
      {(value.schemaVersion || value.loader) && <dl className="mod-details-fields">{value.schemaVersion && <><dt>声明格式版本</dt><dd>{escapeWorldText(value.schemaVersion)}</dd></>}{value.loader && <><dt>加载器声明</dt><dd>{escapeWorldText(value.loader.id)}{value.loader.version && <small>版本条件：{escapeWorldText(value.loader.version)}</small>}</dd></>}</dl>}
      {value.reason && <p className="mod-details-reason">{escapeWorldText(value.reason)}</p>}
      {value.mods.length > 1 && <p className="mod-details-note">此声明文件包含 {value.mods.length} 个模组，分别显示；不会合并成一个标识。</p>}
      {value.mods.map((mod, i) => <section className="mod-details-contained" key={i} aria-label={`声明模组 ${i + 1}`}>{value.mods.length > 1 && <h5>声明模组 {i + 1}</h5>}<Declaration value={mod} /></section>)}
      {!!value.manifest?.length && <><dl className="mod-details-fields">{value.manifest.map((entry, i) => <div className="mod-details-manifest-field" key={i}><dt>{escapeWorldText(entry.name)}</dt><dd>{escapeWorldText(entry.value)}</dd></div>)}</dl><p className="mod-details-note">这里只展示 Manifest 主节声明；Main-Class、Class-Path 或签名相关名称不会被执行、解析为外部文件或视为可信签名。</p></>}
      <Warnings values={value.warnings} />
    </div>
  </details>
}

/** One explicit read at a time. Views never grant a file-import capability. */
export default function ModDetails({ instance, item, busy, readBusy, refreshRevision = 0, onActivityChange }: Props) {
  const id = useId(), mounted = useRef(true), active = useRef<Operation | undefined>(undefined)
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const activity = useRef(onActivityChange); activity.current = onActivityChange
  const reason = !isDesktop ? '模组声明需要在桌面版中读取本机 JAR。' : instance.status === 'running' ? '请先关闭此实例的游戏，再读取 JAR 声明。' : busy || instance.status === 'installing' ? '请等待此实例的文件任务、扫描或设置保存结束。' : ''
  const context = JSON.stringify([instance.id, instance.version, instance.loader, instance.status, item?.id, item?.name, item?.relativePath, item?.entryType, item?.sizeBytes, item?.modifiedAt, refreshRevision, reason])
  const currentContext = useRef(context); currentContext.current = context
  const [operation, setOperation] = useState<Operation>()
  const [stopping, setStopping] = useState(false)
  const [result, setResult] = useState<{ context: string; value: InstanceModDetails }>()
  const [error, setError] = useState<{ context: string; message: string }>()
  const detail = result?.context === context ? result.value : undefined
  const pending = Boolean(operation)
  const selectedJar = item?.entryType === 'file' && item.relativePath === `mods/${item.name}` && /^.+\.jar(?:\.disabled)?$/i.test(item.name) && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes! >= 0 && Number.isFinite(Date.parse(item.modifiedAt))
  const valid = (op: Operation) => mounted.current && currentContext.current === op.context && active.current === op && !op.cancelled
  function cancel(op: Operation) { return call<void>('cancelModDetails', op.instanceId, op.id) }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; const op = active.current; if (op) { op.cancelled = true; void cancel(op).catch(() => {}) } }
  }, [])
  useEffect(() => {
    setResult(undefined); setError(undefined)
    const op = active.current
    if (op && op.context !== context) { op.cancelled = true; setStopping(true); void cancel(op).catch(() => {}) }
  }, [context])
  useEffect(() => {
    if (detail) { resultHeading.current?.focus({ preventScroll: true }); resultHeading.current?.scrollIntoView({ block: 'nearest' }) }
  }, [detail?.viewId])
  async function read(source: Operation['source']) {
    if (reason || active.current || readBusy || source === 'installed' && !selectedJar) return
    const op: Operation = { id: crypto.randomUUID(), instanceId: instance.id, context, source, cancelled: false }
    active.current = op; setOperation(op); setStopping(false); setError(undefined); setResult(undefined)
    activity.current(op.id, op.instanceId, true)
    try {
      const value = source === 'installed'
        ? await call<InstanceModDetails>('inspectInstanceMod', op.instanceId, { itemId: item!.id, name: item!.name, sizeBytes: item!.sizeBytes!, modifiedAt: item!.modifiedAt }, op.id)
        : await call<InstanceModDetails | null>('chooseLocalModJar', op.instanceId, op.id)
      if (!valid(op) || !value) return
      if (value.instanceId !== op.instanceId || value.source !== source || value.instanceGameVersion !== instance.version || value.instanceLoader !== instance.loader || !value.viewId ||
          source === 'installed' && (value.itemId !== item!.id || value.name !== item!.name || value.archiveBytes !== undefined && value.archiveBytes !== item!.sizeBytes)) throw new Error('读取结果与当前实例或所选文件不一致，请刷新清单后重试。')
      setResult({ context: op.context, value })
    } catch (failure) { if (valid(op)) setError({ context: op.context, message: escapeWorldText(errorText(failure)) }) }
    finally {
      activity.current(op.id, op.instanceId, false)
      if (active.current === op) { active.current = undefined; if (mounted.current) { setOperation(undefined); setStopping(false) } }
    }
  }
  async function stop() {
    const op = active.current
    if (!op || stopping) return
    op.cancelled = true; setStopping(true)
    try { await cancel(op) }
    catch (failure) { if (mounted.current && currentContext.current === op.context && active.current === op) { setStopping(false); setError({ context: op.context, message: `未能发送停止请求：${escapeWorldText(errorText(failure))}` }) } }
  }
  return <section className="mod-details" aria-labelledby={`${id}-title`} aria-busy={pending || readBusy}>
    <div className="mod-details-heading"><div><h3 id={`${id}-title`}>模组声明</h3><p>实例「{escapeWorldText(instance.name)}」 · {loaderNames[instance.loader]} · {escapeWorldText(instance.version)}</p></div><div className="mod-details-actions"><button type="button" className="button secondary" disabled={Boolean(reason) || pending || readBusy || !selectedJar} onClick={() => void read('installed')}><FileSearch size={15} aria-hidden="true" />读取所选 JAR 声明</button><button type="button" className="button secondary" disabled={Boolean(reason) || pending || readBusy} onClick={() => void read('local')}><FileUp size={15} aria-hidden="true" />只读预览本地 JAR</button></div></div>
    {reason ? <p className="mod-details-note">{reason}</p> : !selectedJar && !detail && !pending && <p className="mod-details-note">选择 mods 清单中的 .jar 或 .jar.disabled，再读取声明；也可以单独选择一个本地 JAR 预览，不会导入实例。</p>}
    {pending ? <div className="mod-details-loading" role="status"><span><Spinner size={16} />{operation?.context !== context ? '正在结束先前选择的读取，请等待文件工作结算…' : stopping ? '正在停止，请等待当前读取结束…' : operation.source === 'local' ? '正在选择并读取本地 JAR 声明…' : '正在读取所选 JAR 的声明与文件摘要…'}</span><button type="button" className="text-button" disabled={stopping} onClick={() => void stop()}><X size={14} aria-hidden="true" />{stopping ? '正在停止' : '停止读取'}</button></div> : readBusy && <p className="mod-details-note" role="status">此实例先前的模组读取尚未结束，请等待文件工作结算。</p>}
    {error?.context === context && <ErrorBox message={error.message} />}
    {detail && <div className="mod-details-result">
      <div className="mod-details-result-heading"><h4 ref={resultHeading} tabIndex={-1}><Package size={16} aria-hidden="true" />{escapeWorldText(detail.name)}</h4><span>{detail.source === 'local' ? '本地文件 · 尚未导入' : detail.disabledSuffix ? '实例文件 · 禁用后缀' : '实例文件 · 加载状态未核实'}</span></div>
      <p className={`mod-details-assessment ${detail.assessment.status}`}><strong>{detail.assessment.status === 'matches-declaration' ? '加载器声明相符' : detail.assessment.status === 'mismatch' ? '加载器声明不匹配' : '加载器关系未知'}</strong><span>{escapeWorldText(detail.assessment.message)}</span></p>
      {detail.status === 'metadata-read' ? <p className="mod-details-note">已读取受支持的声明，不表示 JAR 的全部类文件、代码、依赖、签名或游戏加载经过验证。</p> : <p className="mod-details-reason">{detail.status === 'no-metadata' ? '未发现受支持的模组声明；不能据此断定它不是模组。' : detail.status === 'unsupported' ? '此文件包含当前不支持的格式，未取得可解释的完整声明。' : '文件或声明检查未通过，不能把诊断当作有效模组信息。'}</p>}
      <dl className="mod-details-fields"><dt>读取时间</dt><dd><time dateTime={detail.observedAt}>{dateLabel(detail.observedAt)}</time></dd><dt>外层文件大小</dt><dd>{sizeLabel(detail.archiveBytes)}</dd><dt>文件名后缀</dt><dd>{detail.disabledSuffix ? '.jar.disabled，仅表示禁用后缀' : '.jar，仅表示文件后缀'}<small>不从文件名推断真实加载状态或项目来源。</small></dd></dl>
      {detail.sha512 && <details className="mod-details-digest"><summary>外层 JAR 文件 SHA-512</summary><code>{detail.sha512}</code><p>这是此时外层文件字节的摘要；只读取了选定声明项，没有验证或执行其余载荷，不等于来源认证或代码安全保证。</p></details>}
      <div className="mod-details-documents">{detail.documents.map((document, index) => <Document key={`${document.path}:${index}`} value={document} index={index} />)}</div>
      <Warnings values={detail.warnings} />
    </div>}
    <p className="mod-details-footnote">此入口只读声明，不导入、启停或运行 JAR，不下载依赖与图标。版本条件按原声明展示，不自动求解；历史下载登记与当前字节分别判断。</p>
  </section>
}
