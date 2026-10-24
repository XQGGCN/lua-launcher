import { useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type RefCallback, type RefObject } from 'react'
import { ArrowDown, Search, X } from 'lucide-react'
import { INSTANCE_SETTINGS_SEARCH_INDEX, deriveInstanceSettingsResults, type InstanceSettingsTargetKey, type InstanceSettingsSearchContext } from '../instance-settings-search'
import { ErrorBox } from './ui'
import './InstanceSettingsSearch.css'

interface Binding {
  ref: RefCallback<HTMLElement>
  'data-instance-settings-target': InstanceSettingsTargetKey
  tabIndex: -1
  role: 'group'
  'aria-label': string
}
export function useInstanceSettingsSearchTargets() {
  const rows = useRef(new Map<InstanceSettingsTargetKey, HTMLElement>())
  const bindings = useMemo(() => new Map(INSTANCE_SETTINGS_SEARCH_INDEX.map(item => [item.targetKey, {
    ref: (row: HTMLElement | null) => { if (row) rows.current.set(item.targetKey, row); else rows.current.delete(item.targetKey) },
    'data-instance-settings-target': item.targetKey, tabIndex: -1 as const, role: 'group' as const, 'aria-label': item.label,
  }])), [])
  const target = (key: InstanceSettingsTargetKey): Binding => bindings.get(key)!
  return { rows, target }
}
export interface InstanceSettingsSearchControl { invalidate: () => void }
interface Props {
  instanceId: string
  draftInstanceId: string
  context: InstanceSettingsSearchContext
  root: RefObject<HTMLDivElement | null>
  rows: RefObject<Map<InstanceSettingsTargetKey, HTMLElement>>
  advanced: boolean
  advancedElement: RefObject<HTMLDetailsElement | null>
  openAdvanced: () => void
  control: RefObject<InstanceSettingsSearchControl | null>
}
interface Intent { owner: string; mount: symbol; query: string; ticket: number; key: InstanceSettingsTargetKey; advanced: boolean }

export default function InstanceSettingsSearch(props: Props) {
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const mounted = useRef(false)
  const mount = useRef(Symbol('instance-settings-search'))
  const ticket = useRef(0)
  const frame = useRef<number | null>(null)
  const pending = useRef<Intent | null>(null)
  const marked = useRef<HTMLElement | null>(null)
  const current = useRef(props); current.current = props
  const currentQuery = useRef(query); currentQuery.current = query
  const derived = useMemo(() => {
    try { return { result: deriveInstanceSettingsResults(query, props.context), error: '' } }
    catch (error) { return { result: undefined, error: error instanceof Error ? error.message : '搜索词无效，请缩短后重试。' } }
  }, [query, props.context.ownerMatches, props.context.locked, props.context.busy, props.context.hasPicker, props.context.hasDetect])
  const result = useRef(derived.result); result.current = derived.result
  function cancel() {
    ++ticket.current
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null; pending.current = null
    marked.current?.removeAttribute('data-instance-settings-located'); marked.current = null
  }
  function invalidate() { cancel(); setNotice('') }
  useImperativeHandle(props.control, () => ({ invalidate }), [])
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; cancel() } }, [])
  function valid(intent: Intent) {
    const now = current.current
    return mounted.current && intent.mount === mount.current && intent.ticket === ticket.current && intent.owner === now.instanceId && now.draftInstanceId === intent.owner && now.context.ownerMatches && currentQuery.current === intent.query
  }
  function locateInFrame(intent: Intent) {
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      if (!valid(intent)) return
      const now = current.current, item = result.current?.items.find(item => item.targetKey === intent.key)
      const root = now.root.current, row = now.rows.current.get(intent.key)
      if (!item || !root?.isConnected || !row?.isConnected || !root.contains(row) || root.dataset.instanceSettingsOwner !== intent.owner || row.closest('[hidden], [inert]') || !row.getClientRects().length) return
      if (intent.advanced && !now.advancedElement.current?.open) return
      if (document.querySelector('dialog[open], dialog.modal, [aria-modal="true"]')) { setNotice('请先关闭当前对话框，再定位设置。'); return }
      // The index key chooses a registered row; only fixed selectors inspect it.
      const control = item.kind === 'explicit-action' || now.context.locked || now.context.busy || item.availability === 'unavailable' ? null : row.querySelector<HTMLElement>('select:not(:disabled), input:not(:disabled)')
      const focus = control ?? row
      focus.focus({ preventScroll: true })
      if (document.activeElement !== focus) { setNotice('当前设置暂时无法聚焦，请稍后重新定位。'); return }
      row.setAttribute('data-instance-settings-located', 'true'); marked.current = row
      row.scrollIntoView({ block: 'center', behavior: 'instant' })
      setNotice(`已定位：${item.label}。${item.effectLabel}`)
    })
  }
  useLayoutEffect(() => {
    const intent = pending.current
    if (!intent) return
    pending.current = null
    if (valid(intent) && props.advanced && props.advancedElement.current?.open) locateInFrame(intent)
  }, [props.advanced])
  function locate(key: InstanceSettingsTargetKey) {
    invalidate()
    const now = current.current, item = result.current?.items.find(item => item.targetKey === key)
    if (!mounted.current || !item || !now.context.ownerMatches || now.instanceId !== now.draftInstanceId || !now.root.current?.isConnected || now.root.current.closest('[hidden], [inert]')) return
    if (document.querySelector('dialog[open], dialog.modal, [aria-modal="true"]')) { setNotice('请先关闭当前对话框，再定位设置。'); return }
    const intent: Intent = { owner: now.instanceId, mount: mount.current, query: currentQuery.current, ticket: ticket.current, key, advanced: item.advanced }
    if (item.advanced && !now.advancedElement.current?.open) { pending.current = intent; now.openAdvanced() }
    else locateInFrame(intent)
  }
  function changeQuery(value: string) { invalidate(); currentQuery.current = value; setQuery(value) }
  const items = derived.result?.items ?? []
  return <section className="instance-settings-search" aria-label="搜索当前实例设置" onKeyDown={event => {
    if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); changeQuery(''); input.current?.focus() }
  }}>
    <label htmlFor="instance-settings-query">搜索当前实例的设置</label>
    <div className="instance-settings-search-input"><Search size={17} aria-hidden="true" /><input ref={input} id="instance-settings-query" type="search" value={query} placeholder="例如：Java、内存、JVM、继承" aria-describedby="instance-settings-search-help" onChange={event => changeQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />{query && <button type="button" className="icon-button" aria-label="清除实例设置搜索" title="清除实例设置搜索" onClick={() => { changeQuery(''); input.current?.focus() }}><X size={16} /></button>}</div>
    <p id="instance-settings-search-help">搜索本页的10项设置与恢复操作。点击只定位，不修改或保存；高级结果可展开高级设置。</p>
    <p className="instance-settings-search-status" role="status" aria-live="polite">{notice || (derived.error ? '请修改搜索词后继续。' : derived.result?.query ? `找到 ${items.length} 项设置` : '搜索只限当前实例，不读取路径、参数内容或其他实例。')}</p>
    {derived.error && <ErrorBox message={derived.error} />}
    {!derived.error && derived.result?.query && (items.length ? <ul className="instance-settings-search-results">{items.map(item => <li key={item.targetKey}><button type="button" data-instance-settings-result={item.targetKey} onClick={() => locate(item.targetKey)}><span><strong>{item.label}</strong><small>{item.section} · {item.effectLabel}</small><small>{item.availabilityText}</small></span><span className="instance-settings-search-locate"><ArrowDown size={14} aria-hidden="true" />定位</span></button></li>)}</ul> : <p>没有匹配的已有设置。试试“Java”“内存”或“JVM”。</p>)}
  </section>
}
