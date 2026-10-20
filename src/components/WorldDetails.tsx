import { useEffect, useId, useRef, useState, type MutableRefObject } from 'react'
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react'
import type { WorldDetails as WorldDetailsDto, WorldMetadata, WorldReason, WorldSeed, WorldSelection, WorldSource } from '../../desktop/world-types'
import { errorText, isDesktop, type Instance, type InventoryItem } from '../api'
import { ErrorBox, Spinner } from './ui'
import './WorldDetails.css'

export interface WorldDetailsProps {
  instance: Instance
  item: InventoryItem
  busy: boolean
  refreshRevision?: number
  read: (selection: WorldSelection, source: WorldSource) => Promise<WorldDetailsDto>
  reveal: (revision: string) => Promise<WorldSeed>
}

/** NBT text stays text; invisible controls must not change how nearby UI reads. */
export function escapeWorldText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function worldDetailsBlockedReason(instance: Instance, item: InventoryItem, busy: boolean, desktop: boolean): string {
  if (!desktop) return '浏览器预览无法读取本机世界数据，请使用桌面版。'
  if (item.entryType !== 'directory' || !item.name || /[/\\]/.test(item.name) || ['.', '..'].includes(item.name) || item.relativePath !== `saves/${item.name}` || !item.id.startsWith('worlds:')) return '请选择 saves 目录内的一个世界文件夹；普通文件不能作为世界读取。'
  if (instance.status === 'running') return '请先关闭此实例的游戏，再读取世界详情。'
  if (instance.status === 'installing' || busy) return '此实例正在启动、安装或修改文件，请等待操作结束后读取。'
  return ''
}

export function worldSeedIsDecimal(value: unknown): value is string {
  if (typeof value !== 'string' || !/^-?\d{1,19}$/.test(value)) return false
  const parsed = BigInt(value)
  return parsed >= -(2n ** 63n) && parsed <= 2n ** 63n - 1n
}

const reasonNames: Record<WorldReason, string> = {
  missing: '未找到所选文件。可以重新读取，或明确选择另一个来源。',
  'unsafe-path': '此目录或文件不符合安全读取条件，未读取世界数据。',
  'name-collision': '目录名称存在大小写或 Unicode 冲突，无法唯一确定世界。',
  changed: '世界文件在读取期间发生变化，请关闭相关程序后重新读取。',
  'unsupported-compression': '暂不支持此文件的压缩格式。',
  'invalid-gzip': '文件压缩数据损坏或不完整，未展示其中的世界字段。',
  'invalid-nbt': '文件的 NBT 数据无效或不完整，未展示其中的世界字段。',
  'unsupported-layout': '未找到受支持的世界数据结构，不能解析此文件的世界字段。',
  'limit-exceeded': '文件超过当前读取预算，已停止解析；这不表示世界一定损坏。',
  unreadable: '无法读取所选文件，请检查文件是否存在及其访问权限。',
}
const fieldNames: Record<string, string> = {
  levelName: '世界名称', savedVersionName: '保存版本', dataVersion: 'DataVersion', versionId: '版本 ID',
  snapshot: '快照版本记录', gameMode: '游戏模式', difficulty: '难度', hardcore: '硬核模式',
  allowCommands: '允许命令', timeTicks: '世界时间', dayTimeTicks: '昼夜时间', lastPlayed: '最后游玩记录', seed: '世界种子',
}
const warningNames = { missing: '未记录', 'type-mismatch': '字段类型不符', 'invalid-value': '字段值无法识别', truncated: '显示内容已截断' }
const unknown = '未知（未取得有效记录）'
function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : `${escapeWorldText(value)}（无法显示为日期）`
}
function booleanLabel(value?: boolean) { return value === true ? '是' : value === false ? '否' : unknown }
function enumLabel(value?: { raw: number | string; label?: string }) {
  return value ? `${value.label ? escapeWorldText(value.label) : '未知值'}（原始值 ${escapeWorldText(String(value.raw))}）` : unknown
}

export function WorldMetadataFields({ metadata }: { metadata: WorldMetadata }) {
  return <dl className="world-details-fields">
    <dt>世界名称</dt><dd>{metadata.levelName === undefined ? unknown : metadata.levelName === '' ? '空名称（文件原始记录）' : escapeWorldText(metadata.levelName)}</dd>
    <dt>保存版本</dt><dd>{metadata.savedVersionName === undefined ? '未记录' : metadata.savedVersionName === '' ? '空版本名称（文件原始记录）' : escapeWorldText(metadata.savedVersionName)}<small>来自世界文件，不以实例版本推测兼容性</small></dd>
    <dt>DataVersion</dt><dd>{metadata.dataVersion ?? unknown}</dd>
    <dt>游戏模式</dt><dd>{enumLabel(metadata.gameMode)}</dd>
    <dt>难度</dt><dd>{enumLabel(metadata.difficulty)}</dd>
    <dt>硬核模式</dt><dd>{booleanLabel(metadata.hardcore)}</dd>
    <dt>允许命令</dt><dd>{booleanLabel(metadata.allowCommands)}<small>文件中的记录，不代表服务器当前权限</small></dd>
    <dt>最后游玩记录</dt><dd>{metadata.lastPlayed ? <>{metadata.lastPlayed.iso ? <time dateTime={metadata.lastPlayed.iso}>{dateLabel(metadata.lastPlayed.iso)}</time> : '无法显示为有效日期'}<small>NBT LastPlayed：<code>{escapeWorldText(metadata.lastPlayed.epochMs)}</code> 毫秒</small></> : unknown}</dd>
    <dt>世界时间（tick）</dt><dd><code>{metadata.timeTicks === undefined ? unknown : escapeWorldText(metadata.timeTicks)}</code></dd>
    <dt>昼夜时间（tick）</dt><dd><code>{metadata.dayTimeTicks === undefined ? unknown : escapeWorldText(metadata.dayTimeTicks)}</code><small>Time / DayTime 原始记录，不能当作玩家实际游玩时长</small></dd>
    <dt>版本 ID</dt><dd>{metadata.versionId ?? '未记录'}</dd>
    <dt>快照版本记录</dt><dd>{booleanLabel(metadata.snapshot)}</dd>
  </dl>
}

export default function WorldDetails(props: WorldDetailsProps) {
  const identity = JSON.stringify([props.instance.id, props.item.id, props.item.name, props.item.relativePath, props.item.entryType, props.item.modifiedAt])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  return <WorldDetailsContext key={identity} {...props} identity={identity} currentIdentity={currentIdentity} />
}

function WorldDetailsContext({ instance, item, busy, refreshRevision = 0, read, reveal, identity, currentIdentity }: WorldDetailsProps & { identity: string; currentIdentity: MutableRefObject<string> }) {
  const id = useId()
  const [source, setSource] = useState<WorldSource>('level.dat')
  const [retry, setRetry] = useState(0)
  const reason = worldDetailsBlockedReason(instance, item, busy, isDesktop)
  const context = JSON.stringify([identity, source, refreshRevision, retry, reason])
  const currentContext = useRef(context)
  currentContext.current = context
  const callbacks = useRef({ read, reveal })
  callbacks.current = { read, reveal }
  const mounted = useRef(true)
  const readRequest = useRef(0)
  const seedRequest = useRef(0)
  const seedLock = useRef(false)
  const copyLock = useRef(false)
  const [reading, setReading] = useState(false)
  const [result, setResult] = useState<{ context: string; value: WorldDetailsDto }>()
  const [error, setError] = useState('')
  const [revealing, setRevealing] = useState(false)
  const [seed, setSeed] = useState<{ context: string; revision: string; value: WorldSeed }>()
  const [seedError, setSeedError] = useState('')
  const [copyMessage, setCopyMessage] = useState('')
  const [copying, setCopying] = useState(false)
  const detail = result?.context === context ? result.value : undefined
  const shownSeed = seed?.context === context && seed.revision === detail?.revision ? seed.value : undefined
  const currentRevision = useRef(detail?.revision)
  currentRevision.current = detail?.revision
  const current = (key: string) => mounted.current && currentIdentity.current === identity && currentContext.current === key

  function hideSeed() {
    ++seedRequest.current; seedLock.current = false; copyLock.current = false
    setSeed(undefined); setRevealing(false); setSeedError(''); setCopyMessage(''); setCopying(false)
  }
  function reread() {
    if (reason || reading) return
    ++readRequest.current; hideSeed(); setResult(undefined); setError(''); setRetry(value => value + 1)
  }
  function switchSource(next: WorldSource) {
    if (next === source) return
    ++readRequest.current; hideSeed(); setResult(undefined); setError(''); setSource(next)
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++readRequest.current; ++seedRequest.current }
  }, [])
  useEffect(() => {
    const ticket = ++readRequest.current
    hideSeed(); setResult(undefined); setError('')
    if (reason) { setReading(false); return }
    setReading(true)
    void callbacks.current.read({ itemId: item.id, name: item.name }, source).then(value => {
      if (!current(context) || ticket !== readRequest.current) return
      if (value.instanceId !== instance.id || value.itemId !== item.id || value.folderName !== item.name || value.source !== source) throw new Error('返回的世界详情与当前选择不一致，请重新读取。')
      setResult({ context, value })
    }).catch(error => { if (current(context) && ticket === readRequest.current) setError(escapeWorldText(errorText(error))) })
      .finally(() => { if (current(context) && ticket === readRequest.current) setReading(false) })
    return () => { if (ticket === readRequest.current) ++readRequest.current }
  }, [context])

  async function revealSeed() {
    const revision = detail?.revision
    if (reason || reading || !detail?.seedAvailable || !revision || seedLock.current) return
    const key = context, ticket = ++seedRequest.current
    seedLock.current = true; setRevealing(true); setSeed(undefined); setSeedError(''); setCopyMessage('')
    const valid = () => current(key) && ticket === seedRequest.current && currentRevision.current === revision
    try {
      const value = await callbacks.current.reveal(revision)
      if (!valid()) return
      if (value.instanceId !== instance.id || value.itemId !== item.id || value.source !== source || value.revision !== revision || (value.available && !worldSeedIsDecimal(value.seed))) throw new Error('返回的种子信息与当前文件不一致，请重新读取世界详情。')
      setSeed({ context: key, revision, value })
    } catch (error) { if (valid()) setSeedError(escapeWorldText(errorText(error))) }
    finally { if (valid()) { seedLock.current = false; setRevealing(false) } }
  }
  async function copySeed() {
    if (!shownSeed?.available || !worldSeedIsDecimal(shownSeed.seed) || reason || copyLock.current) return
    const key = context, revision = shownSeed.revision, ticket = seedRequest.current, text = shownSeed.seed
    copyLock.current = true; setCopying(true); setCopyMessage('')
    const valid = () => current(key) && ticket === seedRequest.current && currentRevision.current === revision
    try {
      if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用，请手动选择并复制上方种子。')
      await navigator.clipboard.writeText(text)
      if (valid()) setCopyMessage('种子已复制。')
    } catch (error) { if (valid()) setCopyMessage(escapeWorldText(errorText(error))) }
    finally { if (valid()) { copyLock.current = false; setCopying(false) } }
  }

  return <section className="world-details" aria-labelledby={`${id}-title`}>
    <div className="world-details-heading"><h3 id={`${id}-title`}>世界详情</h3><button type="button" className="button secondary" disabled={Boolean(reason) || reading} onClick={reread}>{reading ? <Spinner size={15} /> : <RefreshCw size={15} />}重新读取</button></div>
    <div className="world-details-source" role="group" aria-label="世界数据来源"><button type="button" aria-pressed={source === 'level.dat'} onClick={() => switchSource('level.dat')}>主文件 · level.dat</button><button type="button" aria-pressed={source === 'level.dat_old'} onClick={() => switchSource('level.dat_old')}>旧副本 · level.dat_old</button></div>
    {source === 'level.dat_old' && <p className="world-details-notice">正在只读查看旧副本。不与主文件合并，不代表完整备份，也不会恢复或覆盖世界。</p>}
    <dl className="world-details-files"><dt>世界目录</dt><dd><code>{escapeWorldText(item.name)}</code></dd><dt>目录修改时间</dt><dd>{dateLabel(item.modifiedAt)}</dd><dt>世界总大小</dt><dd>未统计（不递归读取目录）</dd>
      {detail?.file && <><dt>{source} 文件大小</dt><dd>{detail.file.sizeBytes.toLocaleString('zh-CN')} 字节</dd><dt>{source} 修改时间</dt><dd>{dateLabel(detail.file.modifiedAt)}</dd></>}
      {detail && <><dt>本次读取时间</dt><dd>{dateLabel(detail.observedAt)}</dd></>}
    </dl>
    {reason ? <p className="world-details-notice" role="status">{reason}</p> : error ? <ErrorBox message={error} retry={reread} /> : reading || !detail ? <div className="world-details-loading" role="status"><Spinner size={16} />正在读取 {source}…</div> : <>
      {detail.status === 'unavailable' ? <ErrorBox message={detail.reasonCode ? reasonNames[detail.reasonCode] : '未取得可展示的世界字段，请重新读取。'} retry={reread} /> : <>
        {detail.status === 'partial' && <p className="world-details-notice">仅部分字段可读取；缺失或无法识别的内容标为未知，原因见读取提示。</p>}
        <WorldMetadataFields metadata={detail.metadata} />
        <div className="world-details-seed"><div className="world-details-seed-heading"><h4>世界种子</h4>{shownSeed || revealing ? <button type="button" className="text-button" onClick={hideSeed}><EyeOff size={15} />隐藏种子</button> : <button type="button" className="text-button" disabled={!detail.seedAvailable || !detail.revision} onClick={() => void revealSeed()}><Eye size={15} />查看种子</button>}</div>
          {revealing ? <p role="status"><Spinner size={15} />正在重新核对文件并读取种子…</p> : shownSeed?.available ? <div className="world-details-seed-value"><code>{shownSeed.seed}</code><button type="button" className="button secondary" disabled={copying} onClick={() => void copySeed()}><Copy size={14} />{copying ? '正在复制…' : '复制种子'}</button></div> : shownSeed ? <p>本次未取得有效种子，请重新读取世界详情。</p> : <p>{detail.seedAvailable ? detail.revision ? '种子默认隐藏。查看时会重新核对文件；查看后可能出现在截图中。' : '本次没有可用的读取凭据，请重新读取详情后查看种子。' : '所选文件没有可读取的受支持种子记录，不以其他字段或旧副本推测。'}</p>}
          {seedError && <ErrorBox message={seedError} retry={reread} />}{copyMessage && <p role="status">{copyMessage}</p>}
        </div>
      </>}
      {(detail.warnings.length > 0 || detail.fieldWarnings.length > 0) && <details className="world-details-warnings"><summary>读取提示（{detail.warnings.length + detail.fieldWarnings.length}）</summary><ul>{detail.warnings.map((warning, index) => <li key={`general-${index}`}>{escapeWorldText(warning)}</li>)}{detail.fieldWarnings.map((warning, index) => <li key={`field-${index}`}>{fieldNames[warning.field] || escapeWorldText(warning.field)}：{warningNames[warning.code]}</li>)}</ul></details>}
    </>}
    <p className="world-details-footnote">这是所选文件的只读快照，未检查区域文件、玩家数据、模组或数据包。字段可读不等于世界完整、兼容或可以安全启动。文本中的控制字符与双向文本标记会显示为可见转义。</p>
  </section>
}
