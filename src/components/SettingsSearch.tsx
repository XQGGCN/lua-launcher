import { useEffect, useMemo, useRef, useState, type RefCallback, type RefObject } from 'react'
import { ArrowDown, Search, X } from 'lucide-react'
import { SETTINGS_SEARCH_INDEX, deriveSettingsResults, type SettingsTargetKey } from '../settings-search'
import type { WindowPreferencesStatus } from '../api'
import { ErrorBox } from './ui'
import './SettingsSearch.css'

export interface SettingsSearchBinding {
  ref: RefCallback<HTMLElement>
  'data-settings-target': SettingsTargetKey
  tabIndex: -1
  role: 'group'
  'aria-label': string
}
export type SettingsSearchTarget = (key: SettingsTargetKey) => SettingsSearchBinding
export function useSettingsSearchTargets() {
  const rows = useRef(new Map<SettingsTargetKey, HTMLElement>())
  const bindings = useMemo(() => new Map(SETTINGS_SEARCH_INDEX.map(item => [item.targetKey, {
    ref: (node: HTMLElement | null) => { if (node) rows.current.set(item.targetKey, node); else rows.current.delete(item.targetKey) },
    'data-settings-target': item.targetKey, tabIndex: -1 as const, role: 'group' as const, 'aria-label': item.label,
  }])), [])
  const target: SettingsSearchTarget = key => bindings.get(key)!
  return { rows, target }
}
interface Props {
  visible: boolean
  root: RefObject<HTMLDivElement | null>
  rows: RefObject<Map<SettingsTargetKey, HTMLElement>>
  desktop: boolean
  windowStatus: WindowPreferencesStatus | null
  windowBusy: boolean
  gameSaving: boolean
  checkingUpdate: boolean
}
export default function SettingsSearch(props: Props) {
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const ticket = useRef(0)
  const frame = useRef<number | null>(null)
  const marked = useRef<HTMLElement | null>(null)
  const visible = useRef(props.visible); visible.current = props.visible
  const currentQuery = useRef(query); currentQuery.current = query
  const derived = useMemo(() => {
    try { return { result: deriveSettingsResults(query, { desktop: props.desktop, windowStatus: props.windowStatus, windowBusy: props.windowBusy, gameSaving: props.gameSaving, checkingUpdate: props.checkingUpdate }), error: '' } }
    catch (error) { return { result: undefined, error: error instanceof Error ? error.message : '搜索词无效，请缩短后重试。' } }
  }, [query, props.desktop, props.windowStatus, props.windowBusy, props.gameSaving, props.checkingUpdate])
  const currentResult = useRef(derived.result); currentResult.current = derived.result
  function cancelLocation() {
    ++ticket.current
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    marked.current?.removeAttribute('data-settings-located')
    marked.current = null
  }
  useEffect(() => {
    if (!props.visible) { cancelLocation(); setNotice('') }
    return () => cancelLocation()
  }, [props.visible])
  function changeQuery(value: string) { cancelLocation(); setNotice(''); currentQuery.current = value; setQuery(value) }
  function locate(key: SettingsTargetKey) {
    cancelLocation(); setNotice('')
    if (!visible.current) return
    const expectedQuery = currentQuery.current, expectedTicket = ticket.current
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      if (expectedTicket !== ticket.current || !visible.current || currentQuery.current !== expectedQuery) return
      const item = currentResult.current?.items.find(item => item.targetKey === key)
      const row = props.rows.current.get(key), root = props.root.current
      if (!item || !row?.isConnected || !root?.isConnected || !root.contains(row) || row.closest('[hidden], [inert]') || !row.getClientRects().length) return
      if (document.querySelector('dialog[open], dialog.modal, [aria-modal="true"]')) { setNotice('请先关闭当前对话框，再定位设置。'); return }
      // Fixed selectors only inspect the registered row, never query text or user values.
      const control = item.kind === 'explicit-action' || item.availability === 'unavailable' ? null : row.querySelector<HTMLElement>('select:not(:disabled), input:not(:disabled), button[aria-pressed="true"]:not(:disabled)')
      const focus = control ?? row
      focus.focus({ preventScroll: true })
      if (document.activeElement !== focus) { setNotice('当前设置暂时无法聚焦，请稍后重新定位。'); return }
      row.setAttribute('data-settings-located', 'true'); marked.current = row
      row.scrollIntoView({ block: 'center', behavior: 'instant' })
      setNotice(`已定位：${item.label}。${item.effectLabel}`)
    })
  }
  const items = derived.result?.items ?? []
  return <section className="settings-search" aria-label="搜索这页设置" onKeyDown={event => {
    if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); changeQuery(''); input.current?.focus() }
  }}>
    <label htmlFor="global-settings-query">搜索这页已有设置</label>
    <div className="settings-search-input"><Search size={17} aria-hidden="true" /><input ref={input} id="global-settings-query" type="search" value={query} placeholder="例如：Java、内存、镜像、窗口" aria-describedby="global-settings-search-help" onChange={event => changeQuery(event.target.value)} onKeyDown={event => {
      if (event.key === 'Enter') event.preventDefault()
    }} />{query && <button type="button" className="icon-button" aria-label="清除设置搜索" title="清除设置搜索" onClick={() => { changeQuery(''); input.current?.focus() }}><X size={16} /></button>}</div>
    <p id="global-settings-search-help">搜索本页的18项设置，不搜索实例、路径、账户或游戏文件。点击结果只定位，不改设置。</p>
    <p className="settings-search-status" role="status" aria-live="polite">{notice || (derived.error ? '请修改搜索词后继续。' : derived.result?.query ? `找到 ${items.length} 项设置` : '输入关键词后，选择要定位的设置。')}</p>
    {derived.error && <ErrorBox message={derived.error} />}
    {!derived.error && derived.result?.query && (items.length ? <ul className="settings-search-results">{items.map(item => <li key={item.targetKey}><button type="button" data-settings-result={item.targetKey} onClick={() => locate(item.targetKey)}><span><strong>{item.label}</strong><small>{item.section} · {item.effectLabel}</small><small>{item.availabilityText}</small></span><span className="settings-search-locate"><ArrowDown size={14} aria-hidden="true" />定位</span></button></li>)}</ul> : <p className="settings-search-empty">没有匹配的已有设置。试试“Java”“内存”或“下载源”。</p>)}
  </section>
}
