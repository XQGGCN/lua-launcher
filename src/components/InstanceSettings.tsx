import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, FolderOpen, RefreshCw, RotateCcw } from 'lucide-react'
import type { InstanceOptions, ResolvedInstanceOptions } from '../../desktop/instance-options'
import { errorText, loaderNames, type Instance, type JavaRuntime } from '../api'
import { ErrorBox, Spinner } from './ui'
import InstanceSettingsSearch, { useInstanceSettingsSearchTargets, type InstanceSettingsSearchControl } from './InstanceSettingsSearch'
import './InstanceSettings.css'

export type SettingsInstance = Pick<Instance, 'id' | 'name' | 'version' | 'loader' | 'status'> & { options?: InstanceOptions }
type OverrideMode = 'inherit' | 'custom'
export interface InstanceSettingsDraft {
  instanceId: string
  name: string
  javaMode: 'inherit' | 'auto' | 'manual'
  javaPath: string
  memoryMode: 'inherit' | 'auto' | 'manual'
  memoryValueMode: OverrideMode
  memoryMb: string
  jvmMode: OverrideMode
  jvmText: string
  widthMode: OverrideMode
  width: string
  heightMode: OverrideMode
  height: string
  fullscreen: 'inherit' | 'on' | 'off'
}
export interface InstanceSettingsProps {
  instance: SettingsInstance
  globalSettings: InstanceOptions
  runtimes: JavaRuntime[]
  draft: InstanceSettingsDraft
  onDraftChange: (draft: InstanceSettingsDraft) => void
  onSave: (name: string, options: InstanceOptions) => Promise<void>
  onCancel: () => void
  onPickJava?: () => Promise<string | null>
  onRefreshRuntimes?: () => Promise<void>
  resolved?: ResolvedInstanceOptions
  disabled?: boolean
  saving?: boolean
  saveError?: string
}

const defaults: Required<InstanceOptions> = {
  javaPath: '', manualJavaPath: '', memoryMode: 'auto', memoryMb: 4096,
  jvmArgs: [], windowWidth: 1280, windowHeight: 720, fullscreen: false,
}
const hasOwnValue = (options: InstanceOptions, key: keyof InstanceOptions) => options[key] !== undefined
const isAbsolute = (value: string) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
const javaDescription = (path: string) => path ? `指定路径：${path}` : '自动选择匹配的 Java，缺失时下载'
const memoryDescription = (mode: string, mb: number) => mode === 'auto' ? '自动分配，启动前重新计算' : `手动上限 ${mb} MB`
const sourceNames = { instance: '本实例设置', global: '全局设置', default: '启动器默认值' }

export function createInstanceSettingsDraft(instance: SettingsInstance, globalSettings: InstanceOptions = {}): InstanceSettingsDraft {
  const options = instance.options || {}
  return {
    instanceId: instance.id, name: instance.name,
    javaMode: options.javaPath === undefined ? 'inherit' : options.javaPath === '' ? 'auto' : 'manual',
    javaPath: options.javaPath || options.manualJavaPath || globalSettings.manualJavaPath || globalSettings.javaPath || '',
    memoryMode: options.memoryMode || 'inherit',
    memoryValueMode: options.memoryMb === undefined ? 'inherit' : 'custom',
    memoryMb: String(options.memoryMb ?? globalSettings.memoryMb ?? defaults.memoryMb),
    jvmMode: options.jvmArgs === undefined ? 'inherit' : 'custom',
    jvmText: (options.jvmArgs ?? globalSettings.jvmArgs ?? []).join('\n'),
    widthMode: options.windowWidth === undefined ? 'inherit' : 'custom',
    width: String(options.windowWidth ?? globalSettings.windowWidth ?? defaults.windowWidth),
    heightMode: options.windowHeight === undefined ? 'inherit' : 'custom',
    height: String(options.windowHeight ?? globalSettings.windowHeight ?? defaults.windowHeight),
    fullscreen: options.fullscreen === undefined ? 'inherit' : options.fullscreen ? 'on' : 'off',
  }
}

class DraftError extends Error {
  constructor(message: string, readonly field: keyof InstanceSettingsDraft) { super(message) }
}
function integer(value: string, min: number, max: number, label: string, field: keyof InstanceSettingsDraft) {
  const parsed = Number(value)
  if (!value.trim() || !Number.isInteger(parsed) || parsed < min || parsed > max) throw new DraftError(`${label}需要填写 ${min}–${max} 之间的整数。`, field)
  return parsed
}
/** Preserve each nonblank line as one argv item; never parse it as shell syntax. */
export function parseInstanceJvmArgs(text: string): string[] {
  const args = text.split(/\r\n|\n|\r/).filter(line => line.trim().length > 0)
  if (args.length > 64) throw new DraftError('JVM 参数最多 64 项，请减少参数后重试。', 'jvmText')
  if (args.reduce((total, arg) => total + arg.length, 0) > 8192) throw new DraftError('JVM 参数总长度不能超过 8192 个字符。', 'jvmText')
  if (args.some(arg => /[\u0000-\u001f\u007f]/.test(arg))) throw new DraftError('JVM 参数包含控制字符，请删除后重试。', 'jvmText')
  return args
}
export function instanceSettingsOptions(draft: InstanceSettingsDraft): InstanceOptions {
  const options: InstanceOptions = {}
  if (draft.javaMode !== 'inherit') {
    const path = draft.javaPath.trim()
    if (draft.javaMode === 'manual' && (!path || !isAbsolute(path) || path.includes('\0'))) throw new DraftError('请选择或填写 Java 可执行文件的绝对路径。', 'javaPath')
    options.javaPath = draft.javaMode === 'manual' ? path : ''
    if (path && isAbsolute(path) && !path.includes('\0')) options.manualJavaPath = path
  }
  if (draft.memoryMode !== 'inherit') options.memoryMode = draft.memoryMode
  if (draft.memoryValueMode === 'custom') options.memoryMb = integer(draft.memoryMb, 1024, 65536, '手动内存上限（MB）', 'memoryMb')
  if (draft.jvmMode === 'custom') options.jvmArgs = parseInstanceJvmArgs(draft.jvmText)
  if (draft.widthMode === 'custom') options.windowWidth = integer(draft.width, 640, 7680, '窗口宽度', 'width')
  if (draft.heightMode === 'custom') options.windowHeight = integer(draft.height, 360, 4320, '窗口高度', 'height')
  if (draft.fullscreen !== 'inherit') options.fullscreen = draft.fullscreen === 'on'
  return options
}
function fingerprint(draft: InstanceSettingsDraft) {
  return JSON.stringify({
    name: draft.name, javaMode: draft.javaMode,
    javaPath: draft.javaMode !== 'inherit' ? draft.javaPath : undefined,
    memoryMode: draft.memoryMode, memoryValueMode: draft.memoryValueMode,
    memoryMb: draft.memoryValueMode === 'custom' ? draft.memoryMb : undefined,
    jvmMode: draft.jvmMode, jvmText: draft.jvmMode === 'custom' ? draft.jvmText : undefined,
    widthMode: draft.widthMode, width: draft.widthMode === 'custom' ? draft.width : undefined,
    heightMode: draft.heightMode, height: draft.heightMode === 'custom' ? draft.height : undefined,
    fullscreen: draft.fullscreen,
  })
}

export default function InstanceSettings(props: InstanceSettingsProps) {
  const { instance, globalSettings, runtimes, draft, onDraftChange } = props
  const [busy, setBusy] = useState<'save' | 'pick' | 'detect' | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState<'save' | 'pick' | 'detect' | null>(null)
  const [saved, setSaved] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const advancedElement = useRef<HTMLDetailsElement>(null)
  const searchControl = useRef<InstanceSettingsSearchControl | null>(null)
  const search = useInstanceSettingsSearchTargets()
  const mounted = useRef(false)
  const operation = useRef(0)
  const busyRef = useRef<{ id: string; sequence: number } | null>(null)
  const currentId = useRef(instance.id)
  currentId.current = instance.id
  const id = useId()
  const baseline = createInstanceSettingsDraft(instance, globalSettings)
  const dirty = fingerprint(draft) !== fingerprint(baseline)
  const locked = Boolean(props.disabled || props.saving || instance.status === 'running' || instance.status === 'installing')
  const unavailable = draft.instanceId !== instance.id
  useLayoutEffect(() => {
    if (busy || locked || unavailable || error || props.saveError) searchControl.current?.invalidate()
  }, [busy, locked, unavailable, error, props.saveError])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++operation.current }
  }, [])
  useEffect(() => {
    ++operation.current; busyRef.current = null
    setBusy(null); setError(''); setRetry(null); setSaved(false)
  }, [instance.id])

  function update(patch: Partial<InstanceSettingsDraft>) {
    if (locked || busyRef.current?.id === instance.id || unavailable) return
    setError(''); setRetry(null); setSaved(false)
    onDraftChange({ ...draft, ...patch })
  }
  function inherited<K extends keyof InstanceOptions>(key: K): Required<InstanceOptions>[K] {
    return (globalSettings[key] ?? defaults[key]) as Required<InstanceOptions>[K]
  }
  function source(key: keyof InstanceOptions, overridden: boolean) {
    return overridden ? sourceNames.instance : hasOwnValue(globalSettings, key) ? sourceNames.global : sourceNames.default
  }
  function begin(kind: 'save' | 'pick' | 'detect') {
    if (locked || unavailable || busyRef.current?.id === instance.id) return null
    searchControl.current?.invalidate()
    const ticket = { id: instance.id, sequence: ++operation.current }
    busyRef.current = ticket; setBusy(kind); setError(''); setRetry(null); setSaved(false)
    return ticket
  }
  function current(ticket: { id: string; sequence: number }) {
    return mounted.current && currentId.current === ticket.id && operation.current === ticket.sequence
  }
  function finish(ticket: { id: string; sequence: number }) {
    if (!current(ticket)) return
    busyRef.current = null; setBusy(null)
  }
  async function save() {
    const ticket = begin('save')
    if (!ticket) return
    try {
      const name = draft.name.trim()
      if (!name || name.length > 64) throw new DraftError('实例名称需要填写 1–64 个字符。', 'name')
      const options = instanceSettingsOptions(draft)
      await props.onSave(name, options)
      if (current(ticket)) setSaved(true)
    } catch (error) {
      if (current(ticket)) {
        setError(errorText(error)); setRetry('save')
        if (error instanceof DraftError) {
          if (['jvmText', 'width', 'height'].includes(error.field)) setAdvanced(true)
          requestAnimationFrame(() => { if (current(ticket)) form.current?.querySelector<HTMLElement>(`[data-field="${(error as DraftError).field}"]`)?.focus() })
        }
      }
    } finally { finish(ticket) }
  }
  async function pick() {
    if (!props.onPickJava) return
    const ticket = begin('pick')
    if (!ticket) return
    try {
      const path = await props.onPickJava()
      if (path && current(ticket)) onDraftChange({ ...draft, javaMode: 'manual', javaPath: path })
    } catch (error) { if (current(ticket)) { setError(errorText(error)); setRetry('pick') } }
    finally { finish(ticket) }
  }
  async function detect() {
    if (!props.onRefreshRuntimes) return
    const ticket = begin('detect')
    if (!ticket) return
    try { await props.onRefreshRuntimes() }
    catch (error) { if (current(ticket)) { setError(errorText(error)); setRetry('detect') } }
    finally { finish(ticket) }
  }
  function restoreInheritance() {
    update({ javaMode: 'inherit', memoryMode: 'inherit', memoryValueMode: 'inherit', jvmMode: 'inherit', widthMode: 'inherit', heightMode: 'inherit', fullscreen: 'inherit' })
  }
  const javaPath = draft.javaMode === 'inherit' ? inherited('javaPath') : draft.javaMode === 'auto' ? '' : draft.javaPath
  const memoryMode = draft.memoryMode === 'inherit' ? inherited('memoryMode') : draft.memoryMode
  const memoryMb = draft.memoryValueMode === 'inherit' ? inherited('memoryMb') : Number(draft.memoryMb)
  const width = draft.widthMode === 'inherit' ? inherited('windowWidth') : draft.width
  const height = draft.heightMode === 'inherit' ? inherited('windowHeight') : draft.height
  const full = draft.fullscreen === 'inherit' ? globalSettings.fullscreen : draft.fullscreen === 'on'
  const displayError = error || props.saveError

  if (unavailable) return <div className="instance-settings"><p role="status">正在准备此实例的设置草稿…</p></div>
  return <div ref={root} className="instance-settings" data-instance-settings-owner={instance.id}>
    <header className="instance-settings-heading"><div><h2>实例设置</h2><p>{instance.name} · Minecraft {instance.version} · {loaderNames[instance.loader]}</p></div><button type="button" className="button secondary" disabled={Boolean(busy || props.saving)} onClick={props.onCancel}>关闭（保留草稿）</button></header>
    {locked && <div className="inline-notice">{props.saving ? '正在保存此实例设置，请稍候。切换页面不会中断保存。' : instance.status === 'running' ? '请先停止此实例的游戏，再修改运行设置。' : instance.status === 'installing' ? '正在安装此实例，完成或取消安装后可修改设置。' : '此实例正在准备启动或处理任务，完成后可修改设置。'}</div>}
    <InstanceSettingsSearch instanceId={instance.id} draftInstanceId={draft.instanceId} context={{ ownerMatches: !unavailable, locked, busy, hasPicker: Boolean(props.onPickJava), hasDetect: Boolean(props.onRefreshRuntimes) }} root={root} rows={search.rows} advanced={advanced} advancedElement={advancedElement} openAdvanced={() => setAdvanced(true)} control={searchControl} />
    <form ref={form} noValidate onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset disabled={locked || Boolean(busy)}>
        <section className="instance-settings-section" aria-labelledby={`${id}-basic`}>
          <h3 id={`${id}-basic`}>常用设置</h3>
          <label {...search.target('instance.name')} className="field"><span>实例名称</span><input data-field="name" value={draft.name} maxLength={64} onChange={event => update({ name: event.target.value })} /><small>只修改启动器中的显示名称，不移动游戏目录。</small></label>
          <div {...search.target('instance.java')} className="instance-option-heading"><label htmlFor={`${id}-java`}>Java 选择</label><select id={`${id}-java`} value={draft.javaMode} onChange={event => update({ javaMode: event.target.value as InstanceSettingsDraft['javaMode'] })}><option value="inherit">继承全局</option><option value="auto">本实例自动管理</option><option value="manual">本实例指定路径</option></select></div>
          {draft.javaMode === 'manual' && <div className="instance-option-controls"><label className="field"><span>Java 可执行文件</span><div className="input-with-button"><input data-field="javaPath" value={draft.javaPath} spellCheck={false} autoComplete="off" placeholder="java 或 java.exe 的绝对路径" onChange={event => update({ javaPath: event.target.value })} />{props.onPickJava && <button type="button" className="button secondary" onClick={() => void pick()}><FolderOpen size={15} />浏览</button>}</div></label><label className="field"><span>已检测的运行时</span><div className="input-with-button"><select aria-label="选择已检测 Java" value={runtimes.some(runtime => runtime.path === draft.javaPath) ? draft.javaPath : ''} onChange={event => { if (event.target.value) update({ javaPath: event.target.value }) }}><option value="">选择已检测的 Java</option>{runtimes.map(runtime => <option key={runtime.path} value={runtime.path}>Java {runtime.major} · {runtime.arch} · {runtime.path}</option>)}</select>{props.onRefreshRuntimes && <button type="button" className="button secondary" onClick={() => void detect()}><RefreshCw size={15} />检测</button>}</div></label></div>}
          <p className="instance-effective"><span>{source('javaPath', draft.javaMode !== 'inherit')}</span>{javaDescription(javaPath)}</p>
          <div {...search.target('instance.memory-mode')} className="instance-option-heading"><label htmlFor={`${id}-memory-mode`}>内存分配方式</label><select id={`${id}-memory-mode`} value={draft.memoryMode} onChange={event => update({ memoryMode: event.target.value as InstanceSettingsDraft['memoryMode'] })}><option value="inherit">继承全局</option><option value="auto">本实例自动分配</option><option value="manual">本实例手动上限</option></select></div>
          <p className="instance-effective"><span>{source('memoryMode', draft.memoryMode !== 'inherit')}</span>{memoryMode === 'auto' ? '自动分配，启动前重新计算' : '采用手动上限，数值见下方'}</p>
          <div {...search.target('instance.memory-limit')} className="instance-option-heading"><label htmlFor={`${id}-memory-value-mode`}>手动内存上限</label><select id={`${id}-memory-value-mode`} value={draft.memoryValueMode} onChange={event => update({ memoryValueMode: event.target.value as OverrideMode })}><option value="inherit">继承全局</option><option value="custom">本实例设置</option></select></div>
          {draft.memoryValueMode === 'custom' && <label className="field instance-number-field"><span>内存上限（MB）</span><input data-field="memoryMb" type="number" min={1024} max={65536} step={1} value={draft.memoryMb} onChange={event => update({ memoryMb: event.target.value })} /></label>}
          <p className="instance-effective"><span>{source('memoryMb', draft.memoryValueMode !== 'inherit')}</span>{Number.isFinite(memoryMb) && memoryMb > 0 ? `${memoryMb} MB` : '等待有效数值'}{memoryMode === 'auto' ? ' · 自动模式保留此值，暂不用于分配' : ' · 启动时仍受系统安全内存上限限制'}</p>
        </section>
        <details ref={advancedElement} className="instance-settings-advanced" open={advanced} onToggle={event => { if (!event.currentTarget.open) searchControl.current?.invalidate(); setAdvanced(event.currentTarget.open) }}>
          <summary>高级设置：JVM 参数与游戏窗口</summary>
          <section className="instance-settings-section" aria-labelledby={`${id}-jvm`}>
            <div {...search.target('instance.jvm')} className="instance-option-heading"><h3 id={`${id}-jvm`}>JVM 参数</h3><select aria-label="JVM 参数来源" value={draft.jvmMode} onChange={event => update({ jvmMode: event.target.value as OverrideMode })}><option value="inherit">继承全局</option><option value="custom">本实例替换</option></select></div>
            {draft.jvmMode === 'custom' ? <label className="field"><span>每行一个完整参数</span><textarea data-field="jvmText" rows={6} value={draft.jvmText} spellCheck={false} autoComplete="off" placeholder={'-Dfile.encoding=UTF-8\n-Dexample.label=含 空格的值'} onChange={event => update({ jvmText: event.target.value })} /><small>空行忽略，非空行的空格与引号原样传递。包含空格的值不需要外层引号；不会按 shell 拆分。需要独立值的参数，参数名和值各占一行。</small></label> : <p className="instance-effective"><span>{source('jvmArgs', false)}</span>{inherited('jvmArgs').length} 项参数</p>}
            <p className="form-hint">本实例参数整体替换全局参数，留空并保存表示不使用全局参数。内存、类路径和账户参数由启动器管理；不支持的参数会在保存时明确报错。</p>
          </section>
          <section className="instance-settings-section" aria-labelledby={`${id}-window`}>
            <h3 id={`${id}-window`}>游戏窗口</h3>
            <div className="instance-window-grid">
              <div><div {...search.target('instance.width')} className="instance-option-heading"><label htmlFor={`${id}-width-mode`}>窗口宽度</label><select id={`${id}-width-mode`} value={draft.widthMode} onChange={event => update({ widthMode: event.target.value as OverrideMode })}><option value="inherit">继承全局</option><option value="custom">本实例设置</option></select></div>{draft.widthMode === 'custom' && <label className="field"><span>宽度（像素）</span><input data-field="width" type="number" min={640} max={7680} step={1} value={draft.width} onChange={event => update({ width: event.target.value })} /></label>}<p className="instance-effective"><span>{source('windowWidth', draft.widthMode !== 'inherit')}</span>{width || '待填写'} 像素</p></div>
              <div><div {...search.target('instance.height')} className="instance-option-heading"><label htmlFor={`${id}-height-mode`}>窗口高度</label><select id={`${id}-height-mode`} value={draft.heightMode} onChange={event => update({ heightMode: event.target.value as OverrideMode })}><option value="inherit">继承全局</option><option value="custom">本实例设置</option></select></div>{draft.heightMode === 'custom' && <label className="field"><span>高度（像素）</span><input data-field="height" type="number" min={360} max={4320} step={1} value={draft.height} onChange={event => update({ height: event.target.value })} /></label>}<p className="instance-effective"><span>{source('windowHeight', draft.heightMode !== 'inherit')}</span>{height || '待填写'} 像素</p></div>
            </div>
            <div {...search.target('instance.fullscreen')} className="instance-option-heading"><label htmlFor={`${id}-full`}>全屏</label><select id={`${id}-full`} value={draft.fullscreen} onChange={event => update({ fullscreen: event.target.value as InstanceSettingsDraft['fullscreen'] })}><option value="inherit">继承全局</option><option value="on">本实例开启</option><option value="off">本实例关闭</option></select></div>
            <p className="instance-effective"><span>{source('fullscreen', draft.fullscreen !== 'inherit')}</span>{full === undefined ? '沿用游戏设置，不强制切换全屏状态' : full ? '以全屏模式启动' : '以窗口模式启动'}。{full && '窗口宽高保留，切回窗口模式时使用。'}</p>
            <p className="form-hint">这里只设置 Minecraft 游戏窗口；不会改变启动器窗口。修改后在下次启动时生效。</p>
          </section>
        </details>
        <div className="instance-reset-actions"><div {...search.target('instance.revert')}><button type="button" className="text-button" onClick={() => { onDraftChange(baseline); setError(''); setRetry(null); setSaved(false) }}><RotateCcw size={14} />撤销到已保存设置</button></div><div {...search.target('instance.inherit')}><button type="button" className="text-button" onClick={restoreInheritance}>全部恢复继承</button></div></div>
      </fieldset>
      {props.resolved && <details className="instance-saved-values"><summary>查看已保存的生效配置</summary><dl><dt>Java</dt><dd>{javaDescription(props.resolved.values.javaPath)} · {sourceNames[props.resolved.sources.javaPath]}</dd><dt>内存</dt><dd>{memoryDescription(props.resolved.values.memoryMode, props.resolved.values.memoryMb)} · 方式：{sourceNames[props.resolved.sources.memoryMode]}，上限：{sourceNames[props.resolved.sources.memoryMb]}</dd><dt>窗口</dt><dd>{props.resolved.values.windowWidth} × {props.resolved.values.windowHeight} · {props.resolved.sources.fullscreen === 'default' ? '全屏状态沿用游戏设置' : props.resolved.values.fullscreen ? '全屏' : '窗口'}</dd><dt>JVM 参数</dt><dd>{props.resolved.values.jvmArgs.length} 项 · {sourceNames[props.resolved.sources.jvmArgs]}</dd></dl></details>}
      {displayError && <ErrorBox message={displayError} retry={!locked && !busy ? retry === 'pick' ? () => void pick() : retry === 'detect' ? () => void detect() : () => void save() : undefined} />}
      <footer className="instance-settings-footer"><p role="status">{busy === 'save' || props.saving ? '正在保存实例设置…' : busy === 'pick' ? '正在选择 Java 文件…' : busy === 'detect' ? '正在检测 Java…' : dirty ? '有未保存更改。关闭或切页后草稿保留，保存后才会生效。' : saved ? '实例设置已保存。' : '当前设置已保存。'}{dirty && '上方显示的是草稿配置。'}</p><button type="submit" className="button primary" disabled={locked || Boolean(busy) || !dirty}>{busy === 'save' || props.saving ? <Spinner size={16} /> : <Check size={16} />}保存实例设置</button></footer>
    </form>
  </div>
}
