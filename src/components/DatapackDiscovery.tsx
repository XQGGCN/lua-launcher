import { useEffect, useId, useRef, useState, type MutableRefObject } from 'react'
import { ExternalLink, FileArchive, Search, X } from 'lucide-react'
import { call, errorText } from '../api'
import type { DatapackCatalogFile, DatapackCatalogHit, DatapackCatalogVersion, WorldDatapackSearch, WorldDatapackVersions } from '../../desktop/datapack-discovery-types'
import { ErrorBox, Spinner } from './ui'
import { escapeWorldText } from './WorldDetails'
import './DatapackDiscovery.css'

export interface DatapackDiscoveryProps {
  instanceId: string
  world: { itemId: string; name: string }
  revision: string
  gameVersion: string
  disabled?: boolean
  queryDraft: string
  setQueryDraft: (value: string) => void
  refreshWorld: () => void
  onActivityChange: (operationId: string, active: boolean) => void
}
type Operation = { id: string; kind: 'search' | 'versions'; query?: string; offset?: number; projectId?: string; cancelled?: boolean }
type SearchResult = { query: string; value: WorldDatapackSearch }
const dependencyLabels = { required: '必需依赖', optional: '可选依赖', incompatible: '不兼容关系', embedded: '已内嵌' } as const
const fileRoles = { main: '主文件候选', 'required-resource-pack': '必需资源包', 'optional-resource-pack': '可选资源包', other: '其他附带文件' } as const
function sizeLabel(bytes?: number) {
  if (bytes === undefined) return '大小未提供'
  if (bytes < 1024) return `${bytes.toLocaleString('zh-CN')} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}
function dateLabel(input: string) {
  const value = new Date(input)
  return Number.isFinite(value.getTime()) ? value.toLocaleDateString('zh-CN') : '日期未知'
}
function Warnings({ values }: { values: string[] }) {
  return values.length ? <ul className="datapack-discovery-warnings">{values.map((value, index) => <li key={index}>{escapeWorldText(value)}</li>)}</ul> : null
}
function FileMetadata({ file }: { file: DatapackCatalogFile }) {
  return <li><div><FileArchive size={15} aria-hidden="true" /><strong>{escapeWorldText(file.filename)}</strong></div><p>{fileRoles[file.role]} · {sizeLabel(file.size)}{file.primary && ' · 站点标记为主文件'}</p>
    {file.reason && <p className="datapack-discovery-warning">{escapeWorldText(file.reason)}</p>}
    {(file.sha512 || file.sha1) && <details><summary>站点声明的校验值</summary><dl>{file.sha512 && <><dt>SHA-512</dt><dd><code>{file.sha512}</code></dd></>}{file.sha1 && <><dt>SHA-1</dt><dd><code>{file.sha1}</code></dd></>}</dl><p>这里只展示站点声明，没有读取 ZIP 字节。</p></details>}
  </li>
}
function VersionMetadata({ version }: { version: DatapackCatalogVersion }) {
  return <div className="datapack-discovery-version-detail">
    <dl className="datapack-discovery-fields"><dt>发布版本</dt><dd>{escapeWorldText(version.versionNumber)} · {version.releaseType} · {dateLabel(version.datePublished)}</dd><dt>实例版本声明</dt><dd>{version.declaresCurrentGameVersion ? '站点声明包含当前实例版本' : '未声明包含当前实例版本'}</dd><dt>交付方式</dt><dd>{version.declaresDatapack ? '站点声明为数据包' : '未声明为数据包'}</dd><dt>游戏版本</dt><dd>{version.gameVersions.slice(0, 12).map(escapeWorldText).join('、')}{version.gameVersions.length > 12 && ` 等 ${version.gameVersions.length} 个声明版本`}</dd><dt>加载方式声明</dt><dd>{version.loaders.map(escapeWorldText).join('、') || '未提供'}</dd></dl>
    <p className={version.externalOnly ? 'datapack-discovery-warning' : 'datapack-discovery-note'}>{version.externalOnly ? '此发布需要前往作者页面确认文件或前置要求。' : version.mainFile ? `站点提供主 ZIP 声明：${escapeWorldText(version.mainFile.filename)}。文件尚未下载或检查。` : '未取得唯一主 ZIP 声明，请查看作者页面。'}</p>
    <Warnings values={[...version.reasons, ...version.warnings]} />
    <details className="datapack-discovery-file-details"><summary>发布文件（{version.files.length}）</summary><ul className="datapack-discovery-files">{version.files.map((file, index) => <FileMetadata key={`${file.filename}:${index}`} file={file} />)}</ul></details>
    <details className="datapack-discovery-dependencies"><summary>站点依赖声明（{version.dependencies.length}）</summary>{version.dependencies.length ? <ul>{version.dependencies.map((dependency, index) => <li key={index}><strong>{dependencyLabels[dependency.type]}</strong><span>{escapeWorldText(dependency.filename || dependency.projectId || dependency.versionId || '站点未提供依赖标识')}</span>{dependency.projectId && dependency.versionId && <small>项目 {dependency.projectId} · 版本 {dependency.versionId}</small>}</li>)}</ul> : <p>站点未列出依赖，不代表实际内容不需要其他条件；请查看作者说明。</p>}</details>
  </div>
}

/** Provider metadata belongs to one explicit world/revision, never an install capability. */
export default function DatapackDiscovery(props: DatapackDiscoveryProps) {
  const identity = JSON.stringify([props.instanceId, props.world.itemId, props.world.name, props.revision, props.gameVersion])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  return <DiscoveryContext key={identity} {...props} identity={identity} currentIdentity={currentIdentity} />
}
function DiscoveryContext({ instanceId, world, revision, gameVersion, disabled = false, queryDraft, setQueryDraft, refreshWorld, onActivityChange, identity, currentIdentity }: DatapackDiscoveryProps & { identity: string; currentIdentity: MutableRefObject<string> }) {
  const id = useId(), mounted = useRef(true), active = useRef<Operation | undefined>(undefined)
  const interaction = useRef(0)
  const disabledRef = useRef(disabled); disabledRef.current = disabled
  const [operation, setOperation] = useState<Operation>()
  const [stopping, setStopping] = useState(false)
  const [result, setResult] = useState<SearchResult>()
  const [selectedProject, setSelectedProject] = useState<DatapackCatalogHit>()
  const [versions, setVersions] = useState<WorldDatapackVersions>()
  const [versionId, setVersionId] = useState('')
  const [error, setError] = useState('')
  const current = () => mounted.current && currentIdentity.current === identity
  const valid = (op: Operation) => current() && active.current === op && !op.cancelled && !disabledRef.current
  const busy = Boolean(operation)
  const chosenVersion = versions?.versions.find(value => value.id === versionId)
  const matching = (value: WorldDatapackSearch | WorldDatapackVersions) => value.instanceId === instanceId && value.world.itemId === world.itemId && value.world.name === world.name && value.revision === revision && value.gameVersion === gameVersion
  function cancel(op: Operation) { return call<void>('cancelDatapackRead', instanceId, op.id) }
  function begin(kind: Operation['kind'], values: Partial<Operation> = {}) {
    const op: Operation = { ...values, id: crypto.randomUUID(), kind }
    interaction.current++
    active.current = op; setOperation(op); setStopping(false); setError(''); onActivityChange(op.id, true)
    return op
  }
  function finish(op: Operation) {
    onActivityChange(op.id, false)
    if (current() && active.current === op) { active.current = undefined; setOperation(undefined); setStopping(false) }
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const op = active.current
      if (op) { op.cancelled = true; active.current = undefined; void cancel(op).catch(() => {}); onActivityChange(op.id, false) }
    }
  }, [])
  useEffect(() => {
    if (!disabled || !active.current) return
    const op = active.current
    op.cancelled = true
    setStopping(true)
    void cancel(op).catch(() => {})
  }, [disabled])
  async function search(offset = 0, query = queryDraft.trim()) {
    if (disabled || active.current) return
    const op = begin('search', { query, offset })
    setSelectedProject(undefined); setVersions(undefined); setVersionId('')
    try {
      const value = await call<WorldDatapackSearch>('searchDatapacks', instanceId, revision, { query, offset }, op.id)
      if (!valid(op)) return
      if (!matching(value) || value.offset !== offset || value.limit < 1) throw new Error('站点结果与当前世界或搜索页不一致，请刷新后重试。')
      setResult({ query, value })
    } catch (failure) { if (valid(op)) setError(escapeWorldText(errorText(failure))) }
    finally { finish(op) }
  }
  async function showProject(project: DatapackCatalogHit) {
    if (disabled || active.current) return
    const op = begin('versions', { projectId: project.projectId })
    setSelectedProject(project); setVersions(undefined); setVersionId('')
    try {
      const value = await call<WorldDatapackVersions>('datapackProjectVersions', instanceId, revision, project.projectId, op.id)
      if (!valid(op)) return
      if (!matching(value) || value.project.projectId !== project.projectId) throw new Error('发布列表与当前项目或世界不一致，请刷新后重试。')
      setVersions(value)
    } catch (failure) { if (valid(op)) setError(escapeWorldText(errorText(failure))) }
    finally { finish(op) }
  }
  async function stop() {
    const op = active.current
    if (!op || stopping) return
    op.cancelled = true
    setStopping(true)
    try { await cancel(op) }
    catch (failure) { if (current() && active.current === op) { setStopping(false); setError(`未能发送停止请求：${escapeWorldText(errorText(failure))}`) } }
  }
  async function open(url: string) {
    const generation = interaction.current
    try { await call<void>('openExternal', url) }
    catch (failure) { if (current() && interaction.current === generation) setError(`未能打开站点：${escapeWorldText(errorText(failure))}`) }
  }
  const page = result?.value
  return <section className="datapack-discovery" aria-labelledby={`${id}-title`} aria-busy={busy}>
    <div className="datapack-discovery-heading"><div><h4 id={`${id}-title`}>从 Modrinth 查找数据包</h4><p>按实例游戏版本 {escapeWorldText(gameVersion)} 筛选站点声明，目标世界「{escapeWorldText(world.name)}」。</p></div><button type="button" className="text-button" disabled={busy} onClick={() => void open('https://bbsmc.net')}><ExternalLink size={14} aria-hidden="true" />BBSMC 站点</button></div>
    <p className="datapack-discovery-note">这里只浏览项目和发布声明，不下载、安装或写入世界。世界保存版本与 ZIP 内容仍需分别检查；BBSMC 数据包接口支持尚未核实。</p>
    <form className="datapack-discovery-search" onSubmit={event => { event.preventDefault(); void search() }}><label htmlFor={`${id}-query`}>搜索 Modrinth 数据包</label><div><Search size={16} aria-hidden="true" /><input id={`${id}-query`} type="search" placeholder="输入名称或关键词，也可留空浏览" value={queryDraft} maxLength={200} disabled={disabled || busy} onChange={event => setQueryDraft(event.target.value)} /><button type="submit" className="button secondary" disabled={disabled || busy}>搜索数据包</button></div></form>
    {error && <div className="datapack-discovery-error"><ErrorBox message={error} /><button type="button" className="text-button" disabled={busy || disabled} onClick={refreshWorld}>刷新世界列表后重试</button><span>搜索关键词会保留，刷新后请重新搜索。</span></div>}
    {operation && <div className="datapack-discovery-loading" role="status"><span><Spinner size={16} />{stopping ? '正在停止站点请求，请等待结束…' : operation.kind === 'search' ? '正在读取 Modrinth 搜索结果…' : '正在读取此项目的发布声明…'}</span><button type="button" className="text-button" disabled={stopping} onClick={() => void stop()}><X size={14} aria-hidden="true" />{stopping ? '正在停止' : '停止请求'}</button></div>}
    {!result && !busy && !error && <p className="datapack-discovery-empty">输入关键词后搜索，或留空浏览站点中声明支持此实例版本的数据包。</p>}
    {page && <>
      <p className="datapack-discovery-result-count" role="status">{result.query ? `“${escapeWorldText(result.query)}” · ` : ''}站点声明共 {page.totalHits.toLocaleString('zh-CN')} 项 · 本页展示 {page.hits.length} 项{page.omittedHits > 0 && `，省略 ${page.omittedHits} 项`}</p>
      {page.omittedHits > 0 && <p className="datapack-discovery-warning">本页部分结果未通过类型或元数据检查。翻页位置沿用站点原始分页，未把省略条目当作不存在。</p>}
      {!page.hits.length ? <div className="datapack-discovery-empty"><strong>{page.omittedHits ? '本页没有可展示的项目' : '没有找到匹配项目'}</strong><p>可尝试较短关键词、英文名称，或前往站点查看作者声明。当前按实例 {escapeWorldText(gameVersion)} 筛选。</p></div> : <div className="datapack-discovery-results" aria-label="Modrinth 数据包搜索结果">{page.hits.map(project => <button type="button" key={project.projectId} className={`datapack-discovery-project${selectedProject?.projectId === project.projectId ? ' selected' : ''}`} disabled={disabled || busy} aria-pressed={selectedProject?.projectId === project.projectId} aria-controls={`${id}-project`} onClick={() => void showProject(project)}><div><strong>{escapeWorldText(project.title)}</strong><small>{escapeWorldText(project.author)} · {project.downloads.toLocaleString('zh-CN')} 次站点下载</small></div><p>{escapeWorldText(project.description)}</p><span>{project.projectTypes.map(escapeWorldText).join(' / ')} · 查看发布声明</span></button>)}</div>}
      <div className="datapack-discovery-pagination"><button type="button" className="button secondary" disabled={disabled || busy || page.offset === 0} onClick={() => void search(Math.max(0, page.offset - page.limit), result.query)}>上一页站点结果</button><span>站点第 {Math.floor(page.offset / page.limit) + 1} 页</span><button type="button" className="button secondary" disabled={disabled || busy || page.offset + page.limit >= page.totalHits} onClick={() => void search(page.offset + page.limit, result.query)}>下一页站点结果</button></div>
    </>}
    <div id={`${id}-project`} className="datapack-discovery-project-detail" aria-live="polite">{selectedProject && <>
      <div className="datapack-discovery-project-heading"><h5>{escapeWorldText(versions?.project.title ?? selectedProject.title)}</h5><button type="button" className="text-button" onClick={() => void open(versions?.project.projectUrl ?? selectedProject.projectUrl)}><ExternalLink size={14} aria-hidden="true" />前往项目页面</button></div>
      <p className="datapack-discovery-note">{escapeWorldText(versions?.project.description ?? selectedProject.description)}</p>
      {versions && <>
        {versions.omittedVersions > 0 && <p className="datapack-discovery-warning">站点返回 {versions.upstreamVersionCount} 条发布记录，省略 {versions.omittedVersions} 条不符合当前上下文的记录。</p>}
        {versions.versions.length ? <><label className="datapack-discovery-version-label" htmlFor={`${id}-version`}>选择发布版本<select id={`${id}-version`} value={versionId} disabled={disabled || busy} onChange={event => setVersionId(event.target.value)}><option value="" disabled>选择一个版本查看文件与依赖声明</option>{versions.versions.map(version => <option value={version.id} key={version.id}>{version.name} · {version.versionNumber} · {dateLabel(version.datePublished)}</option>)}</select></label>{chosenVersion && <VersionMetadata version={chosenVersion} />}</> : <p className="datapack-discovery-empty">没有可展示的当前版本数据包发布。可前往作者页面查看其他交付方式与要求。</p>}
      </>}
    </>}</div>
  </section>
}
