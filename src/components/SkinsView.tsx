import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Check, Download, ImagePlus, Plus, RefreshCw, Search, Shirt, Square, Trash2 } from 'lucide-react'
import type { SkinDiagnostics, SkinExportResult, SkinItem, SkinLibraryPage, SkinMetadata, SkinModel, SkinPreview, SkinReadResult, SkinRemoveResult } from '../../desktop/skin-library-types'
import { skinPreviewLayout } from '../skin-layout'
import { call, errorText, isDesktop } from '../api'
import { Dialog, ErrorBox, PageHeading, Spinner } from './ui'
import { escapeWorldText } from './WorldDetails'
import './SkinsView.css'

type Panel = { kind: 'preview'; value: SkinPreview } | { kind: 'saved'; itemId: string }
type Operation = { id: string; phase: 'prepare' | 'save' | 'update' | 'remove' | 'export'; context: string; stopped: boolean }
type Background = 'checker' | 'light' | 'dark'
const safe = (value: string) => escapeWorldText(value)
const modelName = (model: SkinModel) => model === 'slim' ? '纤细 Slim' : '经典 Classic'
const pageSize = 24
const operationNames: Record<Operation['phase'], string> = { prepare: '选择并检查 PNG', save: '保存本地收藏', update: '保存收藏信息', remove: '移出本地收藏', export: '导出 PNG 副本' }
const panelKey = (panel?: Panel) => !panel ? '' : panel.kind === 'preview' ? `preview:${panel.value.viewId}` : `saved:${panel.itemId}`
function validTexture(value: string) { return typeof value === 'string' && value.length <= 128 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) }
function validDiagnostics(value: SkinDiagnostics) { return !!value && Array.isArray(value.warnings) && value.warnings.every(warning => typeof warning === 'string') && !!value.alpha && [value.alpha.transparentPixels, value.alpha.partialAlphaPixels].every(count => Number.isSafeInteger(count) && count >= 0 && count <= 4096) }
function validItem(item: SkinItem) { return !!item && typeof item.id === 'string' && typeof item.revision === 'string' && !!item.revision && typeof item.name === 'string' && item.width === 64 && [32, 64].includes(item.height) && ['classic', 'slim'].includes(item.model) && (item.height !== 32 || item.model === 'classic') && item.layout === (item.height === 32 ? 'legacy' : 'modern') && Array.isArray(item.tags) && item.tags.every(tag => typeof tag === 'string') }
function validRead(value: SkinReadResult, itemId: string) { return !!value && validItem(value.item) && value.item.id === itemId && value.revision === value.item.revision && validTexture(value.textureDataURL) && validDiagnostics(value.diagnostics) }
function metadata(name: string, tagsText: string, model: SkinModel | undefined): SkinMetadata {
  const title = name.normalize('NFC').trim(), tags = tagsText.split(/[,，\n]/).map(value => value.normalize('NFC').trim()).filter(Boolean)
  if (!title || [...title].length > 64) throw new Error('请填写1–64个字符的收藏名称。')
  if (!model) throw new Error('请先明确选择经典 Classic 或纤细 Slim 模型。')
  if (tags.length > 8 || tags.some(value => [...value].length > 24)) throw new Error('最多填写8个标签，每个不超过24个字符，用逗号分隔。')
  if (new Set(tags.map(value => value.toLocaleLowerCase('en-US'))).size !== tags.length) throw new Error('标签存在重复，请合并后保存。')
  return { name: title, tags, model }
}

function SkinCanvas({ texture, height, model, view, outerLayer, zoom }: { texture: string; height: 32 | 64; model: SkinModel; view: 'front' | 'back'; outerLayer: boolean; zoom: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    const target = canvas.current, context = target?.getContext('2d')
    if (!target || !context) { setError('当前环境无法绘制像素预览。'); return }
    target.width = 16 * zoom; target.height = 32 * zoom; context.clearRect(0, 0, target.width, target.height); context.imageSmoothingEnabled = false; setError('')
    if (!validTexture(texture)) { setError('受管图片预览无效，请重新读取。'); return }
    const image = new window.Image()
    image.onload = () => {
      if (!current) return
      try {
        if (image.naturalWidth !== 64 || image.naturalHeight !== height) throw new Error('图片尺寸与这次预览不一致。')
        const layout = skinPreviewLayout({ height, model, view, outerLayer })
        context.clearRect(0, 0, target.width, target.height)
        for (const rect of layout.rects) {
          context.save()
          if (rect.flipX) { context.translate((rect.dx + rect.dw) * zoom, rect.dy * zoom); context.scale(-1, 1); context.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.dw * zoom, rect.dh * zoom) }
          else context.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx * zoom, rect.dy * zoom, rect.dw * zoom, rect.dh * zoom)
          context.restore()
        }
      } catch (failure) { setError(safe(errorText(failure))) }
    }
    image.onerror = () => { if (current) setError('图片暂时无法显示，请重新读取。') }
    image.src = texture
    return () => { current = false; image.onload = null; image.onerror = null }
  }, [texture, height, model, view, outerLayer, zoom])
  return <figure className="skin-figure"><canvas ref={canvas} width={16 * zoom} height={32 * zoom} role="img" aria-label={`${view === 'front' ? '正面' : '背面'}2D皮肤预览，${modelName(model)}${outerLayer ? '，显示外层' : '，隐藏外层'}`} /><figcaption>{view === 'front' ? '正面' : '背面'}</figcaption>{error && <p className="skin-canvas-error" role="status">{error}</p>}</figure>
}

function SkinViewer({ texture, height, model, explicitModel, diagnostics }: { texture: string; height: 32 | 64; model: SkinModel; explicitModel: boolean; diagnostics: SkinDiagnostics }) {
  const id = useId()
  const [outer, setOuter] = useState(true), [background, setBackground] = useState<Background>('checker'), [zoom, setZoom] = useState(6), [view, setView] = useState<'both' | 'front' | 'back'>('both')
  return <section className="skin-viewer" aria-labelledby={`${id}-title`}><div className="skin-viewer-heading"><h3 id={`${id}-title`}>2D像素预览</h3><span>{height === 32 ? '64 × 32 旧布局' : '64 × 64 现代布局'}</span></div>
    <div className="skin-viewer-controls"><label><span>视角</span><select value={view} onChange={event => setView(event.target.value as typeof view)} aria-label="皮肤预览视角"><option value="both">正面与背面</option><option value="front">只看正面</option><option value="back">只看背面</option></select></label><label><span>背景</span><select value={background} onChange={event => setBackground(event.target.value as Background)} aria-label="皮肤预览背景"><option value="checker">透明棋盘</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label><span>缩放</span><select value={zoom} onChange={event => setZoom(Number(event.target.value))} aria-label="皮肤像素缩放">{[2, 4, 6, 8, 10, 12].map(value => <option key={value} value={value}>{value} 倍</option>)}</select></label><label className="skin-outer-toggle"><input type="checkbox" checked={outer} onChange={event => setOuter(event.target.checked)} />显示外层</label></div>
    <div className={`skin-preview-scroll skin-preview-background-${background}`}><div className="skin-preview-views">{view !== 'back' && <SkinCanvas texture={texture} height={height} model={model} view="front" outerLayer={outer} zoom={zoom} />}{view !== 'front' && <SkinCanvas texture={texture} height={height} model={model} view="back" outerLayer={outer} zoom={zoom} />}</div></div>
    <p className="skin-preview-note">{!explicitModel && '当前暂按经典模型预览，请在下方选择保存模型。'}{height === 32 ? '旧布局仅支持经典模型；左右肢体按旧布局镜像，外层只显示帽子。' : '经典手臂宽4像素，纤细手臂宽3像素；模型只影响本地预览和收藏信息。'} 这是正交像素拼接，实际游戏的透明处理与显示可能不同。</p>
    {(diagnostics.warnings.length > 0 || diagnostics.alpha.transparentPixels > 0 || diagnostics.alpha.partialAlphaPixels > 0) && <details className="skin-diagnostics"><summary>图片检查提示</summary><p>图片像素：全透明 {diagnostics.alpha.transparentPixels.toLocaleString('zh-CN')} 个，半透明 {diagnostics.alpha.partialAlphaPixels.toLocaleString('zh-CN')} 个。透明统计只作诊断，不表示游戏会保留这些透明效果。</p>{diagnostics.warnings.length > 0 && <ul>{diagnostics.warnings.map((warning, index) => <li key={index}>{safe(warning)}</li>)}</ul>}</details>}
  </section>
}

function SkinEditor({ preview, saved, busy, used = false, save, update, remove, exportImage }: { preview?: SkinPreview; saved?: SkinReadResult; busy: boolean; used?: boolean; save: (value: SkinMetadata) => Promise<void>; update: (value: SkinMetadata) => Promise<void>; remove: () => void; exportImage: () => void }) {
  const id = useId(), initial = saved?.item
  const [name, setName] = useState(initial?.name ?? (preview?.filename.replace(/\.png$/i, '').slice(0, 64) || '我的皮肤'))
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? ''), [model, setModel] = useState<SkinModel | undefined>(initial?.model), [error, setError] = useState(''), [now, setNow] = useState(Date.now())
  const height = saved?.item.height ?? preview!.height, texture = saved?.textureDataURL ?? preview!.textureDataURL, diagnostics = saved?.diagnostics ?? preview!.diagnostics
  const expiry = preview ? Date.parse(preview.expiresAt) : undefined, expired = expiry !== undefined && (!Number.isFinite(expiry) || expiry <= now)
  const changed = !initial || name.trim() !== initial.name || tags.split(/[,，\n]/).map(value => value.trim()).filter(Boolean).join('\u0000') !== initial.tags.join('\u0000') || model !== initial.model
  useEffect(() => { if (!preview) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [preview])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || expired || used) return; setError('')
    try { const value = metadata(name, tags, model); if (height === 32 && value.model !== 'classic') throw new Error('64 × 32旧布局当前仅支持经典模型。'); await (saved ? update(value) : save(value)) }
    catch (failure) { setError(safe(errorText(failure))) }
  }
  return <div className="skin-editor"><div className="skin-selection-heading"><h2>{saved ? safe(saved.item.name) : '新图片 · 尚未收藏'}</h2><span>{saved ? '本地收藏' : safe(preview!.filename)}</span></div>
    <SkinViewer texture={texture} height={height} model={height === 32 ? 'classic' : model ?? 'classic'} explicitModel={Boolean(model)} diagnostics={diagnostics} />
    <form className="skin-metadata-form" onSubmit={event => void submit(event)}><label className="field"><span>收藏名称</span><input aria-label="皮肤收藏名称" value={name} maxLength={64} disabled={busy || expired} onChange={event => setName(event.target.value)} required /></label><label className="field"><span>标签</span><input aria-label="皮肤收藏标签" value={tags} maxLength={220} disabled={busy || expired} onChange={event => setTags(event.target.value)} placeholder="例如：日常, 冒险" aria-describedby={`${id}-tag-hint`} /><small id={`${id}-tag-hint`}>用逗号分隔，最多8个标签，每个24个字符。</small></label>
      <fieldset className="skin-model-options" disabled={busy || expired}><legend>保存的模型</legend><label><input type="radio" name={`${id}-model`} value="classic" checked={model === 'classic'} onChange={() => setModel('classic')} />经典 Classic <small>4像素手臂</small></label><label className={height === 32 ? 'skin-model-unavailable' : ''}><input type="radio" name={`${id}-model`} value="slim" checked={model === 'slim'} onChange={() => setModel('slim')} disabled={height === 32} />纤细 Slim <small>{height === 32 ? '旧布局不支持' : '3像素手臂'}</small></label></fieldset>
      {expired && !used && <ErrorBox message="这次图片准备已过期，请重新选择 PNG 后再保存。" />}{used && <p className="form-hint">这次保存确认已使用；如需再次保存，请重新选择 PNG 并检查。</p>}{error && <ErrorBox message={error} />}
      <div className="skin-editor-actions"><button type="submit" className="button primary" disabled={!isDesktop || busy || expired || used || !model || !changed}>{saved ? <Check size={15} /> : <Plus size={15} />}{saved ? '保存收藏信息' : '加入本地收藏'}</button>{saved && <><button type="button" className="button secondary" disabled={busy} onClick={exportImage}><Download size={15} />导出 PNG</button><button type="button" className="text-button skin-remove-button" disabled={busy} onClick={remove}><Trash2 size={14} />移出收藏</button></>}</div>
      <p className="skin-local-note">这里的收藏、模型和预览不会更改账户皮肤或其他玩家看到的外观。导出的是检查后的PNG副本，不保留原图附加信息。</p>
    </form>
  </div>
}

export default function SkinsView() {
  const mounted = useRef(true), generation = useRef(0), active = useRef<Operation | undefined>(undefined), reads = useRef(new Map<string, Promise<unknown>>()), readTail = useRef<Promise<unknown>>(Promise.resolve())
  const [query, setQuery] = useState(''), [submitted, setSubmitted] = useState(''), [tag, setTag] = useState(''), [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0)
  const [listing, setListing] = useState<{ key: string; value: SkinLibraryPage }>(), [listError, setListError] = useState<{ key: string; message: string }>()
  const [panel, setPanel] = useState<Panel>(), [readVersion, setReadVersion] = useState(0), [details, setDetails] = useState<{ key: string; value: SkinReadResult }>(), [detailError, setDetailError] = useState<{ key: string; message: string }>()
  const [spentViewId, setSpentViewId] = useState<string>(), [operation, setOperation] = useState<Operation>(), [stopping, setStopping] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [removeConfirm, setRemoveConfirm] = useState<SkinReadResult>()
  const previewHeading = useRef<HTMLDivElement>(null), context = panelKey(panel), currentContext = useRef(context); currentContext.current = context
  const listKey = JSON.stringify([submitted, tag, offset, refresh]), currentListKey = useRef(listKey); currentListKey.current = listKey
  const readKey = panel?.kind === 'saved' ? `${panel.itemId}:${readVersion}` : '', currentReadKey = useRef(readKey); currentReadKey.current = readKey
  const data = listing?.key === listKey ? listing.value : undefined, listFailure = listError?.key === listKey ? listError.message : '', loading = isDesktop && !data && !listFailure
  const selected = details?.key === readKey && readKey ? details.value : undefined, detailFailure = detailError?.key === readKey ? detailError.message : '', busy = Boolean(operation)
  const allTags = [...new Set([...(data?.tags ?? []), ...(tag ? [tag] : [])])]
  function read<T>(method: string, args: unknown[], operationId: string, current: () => boolean): Promise<T | undefined> {
    const promise = readTail.current.catch(() => {}).then(async () => {
      if (!mounted.current || active.current || !current()) return undefined
      return call<T>(method, ...args)
    })
    readTail.current = promise.catch(() => {})
    reads.current.set(operationId, promise)
    void promise.finally(() => reads.current.delete(operationId)).catch(() => {})
    return promise
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++generation.current; const pending = active.current; if (pending) { pending.stopped = true; void call('cancelSkinOperation', pending.id).catch(() => {}) }; for (const operationId of reads.current.keys()) void call('cancelSkinOperation', operationId).catch(() => {}) }
  }, [])
  useEffect(() => {
    if (!isDesktop || busy) return
    let current = true
    const operationId = crypto.randomUUID(), isCurrent = () => current && currentListKey.current === listKey
    void read<SkinLibraryPage>('skinLibrary', [{ query: submitted, offset, limit: pageSize, ...(tag ? { tag } : {}), operationId }], operationId, isCurrent).then(value => {
      if (!value || !mounted.current || !isCurrent()) return
      if (!Array.isArray(value.items) || value.items.length > pageSize || value.offset !== offset || value.limit !== pageSize || !Array.isArray(value.tags)) throw new Error('收藏列表与当前查询不一致，请刷新后重试。')
      if (!value.items.length && offset > 0) { setOffset(value.total ? Math.floor((value.total - 1) / pageSize) * pageSize : 0); return }
      setListing({ key: listKey, value })
    }).catch(failure => { if (mounted.current && isCurrent()) setListError({ key: listKey, message: safe(errorText(failure)) }) })
    return () => { current = false; void call('cancelSkinOperation', operationId).catch(() => {}) }
  }, [listKey, busy, submitted, tag, offset])
  useEffect(() => {
    if (!isDesktop || panel?.kind !== 'saved' || busy) return
    let current = true
    const itemId = panel.itemId, operationId = crypto.randomUUID(), isCurrent = () => current && currentReadKey.current === readKey
    void read<SkinReadResult>('skinDetails', [itemId, { operationId }], operationId, isCurrent).then(value => {
      if (!value || !mounted.current || !isCurrent()) return
      if (!validRead(value, itemId)) throw new Error('收藏图片与当前条目不一致，请重新读取。')
      setDetails({ key: readKey, value }); previewHeading.current?.scrollIntoView({ block: 'nearest' })
    }).catch(failure => { if (mounted.current && isCurrent()) setDetailError({ key: readKey, message: safe(errorText(failure)) }) })
    return () => { current = false; void call('cancelSkinOperation', operationId).catch(() => {}) }
  }, [readKey, busy])
  async function run<T>(phase: Operation['phase'], worker: (operationId: string) => Promise<T>, success: (result: T) => void) {
    if (!isDesktop || active.current) return
    const op: Operation = { id: crypto.randomUUID(), phase, context, stopped: false }, ticket = ++generation.current
    active.current = op; setOperation(op); setStopping(false); setError(''); setNotice('')
    try {
      const waiting = [...reads.current.entries()]
      await Promise.allSettled(waiting.map(([operationId]) => call('cancelSkinOperation', operationId)))
      await Promise.allSettled(waiting.map(([, promise]) => promise))
      if (op.stopped) return
      const result = await worker(op.id)
      if (!mounted.current || active.current !== op || generation.current !== ticket || currentContext.current !== op.context || phase === 'prepare' && op.stopped) return
      success(result)
    } catch (failure) {
      if (mounted.current && active.current === op && currentContext.current === op.context && (!op.stopped || phase !== 'prepare')) {
        const message = safe(errorText(failure)); setError(message); return message
      }
    }
    finally { if (active.current === op) { active.current = undefined; if (mounted.current) { setOperation(undefined); setStopping(false) } } }
  }
  const prepare = () => run<SkinPreview | null>('prepare', operationId => call('prepareSkin', operationId), value => {
    if (!value) return
    if (value.width !== 64 || ![32, 64].includes(value.height) || !value.viewId || !validTexture(value.textureDataURL) || !Number.isFinite(Date.parse(value.expiresAt)) || value.layout !== (value.height === 32 ? 'legacy' : 'modern') || !validDiagnostics(value.diagnostics)) throw new Error('图片准备结果不完整，请重新选择 PNG。')
    setPanel({ kind: 'preview', value }); setSpentViewId(undefined); setRemoveConfirm(undefined)
  })
  const save = async (value: SkinMetadata) => {
    if (panel?.kind !== 'preview') return
    const prepared = panel.value; setSpentViewId(prepared.viewId)
    const failure = await run<SkinItem>('save', operationId => call('saveSkin', prepared.viewId, { ...value, operationId }), item => {
      if (!validItem(item) || item.width !== prepared.width || item.height !== prepared.height || item.model !== value.model) throw new Error('收藏回执与这次图片不一致，请刷新库后查看。')
      setPanel({ kind: 'saved', itemId: item.id }); setReadVersion(version => version + 1); setRefresh(version => version + 1); setNotice(`已加入本地收藏「${safe(item.name)}」。`)
    })
    if (failure) throw new Error(failure)
  }
  const update = async (value: SkinMetadata) => {
    if (!selected) return
    const observed = selected
    const failure = await run<SkinItem>('update', operationId => call('updateSkin', observed.item.id, observed.revision, { ...value, operationId }), item => {
      if (!validItem(item) || item.id !== observed.item.id || item.model !== value.model) throw new Error('收藏信息回执不一致，请重新读取。')
      setReadVersion(version => version + 1); setRefresh(version => version + 1); setNotice(`已保存「${safe(item.name)}」的收藏信息。`)
    })
    if (failure) throw new Error(failure)
  }
  const remove = async () => {
    if (!removeConfirm) return
    const observed = removeConfirm
    await run<SkinRemoveResult>('remove', operationId => call('removeSkin', observed.item.id, observed.revision, operationId), result => {
      if (!result.removed || result.itemId !== observed.item.id) throw new Error('移出收藏的回执不一致，请刷新库后查看。')
      setPanel(undefined); setRemoveConfirm(undefined); setRefresh(version => version + 1); setNotice(`已将「${safe(observed.item.name)}」移出收藏；受管图片副本保留。`)
    })
  }
  const exportImage = async () => {
    if (!selected) return
    const observed = selected
    await run<SkinExportResult>('export', operationId => call('exportSkin', observed.item.id, observed.revision, operationId), result => {
      if (result.itemId !== observed.item.id || typeof result.exported !== 'boolean') throw new Error('导出回执不一致，请检查所选位置。')
      setNotice(result.exported ? `已导出「${safe(observed.item.name)}」的检查后PNG副本。` : '已取消导出。')
    })
  }
  const stop = async () => {
    const pending = active.current
    if (!pending || pending.stopped) return
    pending.stopped = true; setStopping(true)
    try { await call('cancelSkinOperation', pending.id) }
    catch (failure) { if (mounted.current && active.current === pending) setError(`停止请求未完成：${safe(errorText(failure))}`) }
  }
  const chooseItem = (itemId: string) => { if (busy) return; ++generation.current; setPanel({ kind: 'saved', itemId }); setNotice(''); setError(''); setRemoveConfirm(undefined) }
  return <section className="skins-view"><PageHeading title="本地皮肤" subtitle="收藏自己的 PNG 并预览模型；本地选择不会更改账户皮肤。" action={<button type="button" className="button secondary" disabled={!isDesktop || busy} onClick={() => void prepare()}><ImagePlus size={16} />选择 PNG</button>} />
    {!isDesktop && <p className="skin-browser-note">本地皮肤库需要桌面版。这里不会生成虚构的收藏记录。</p>}
    {error && <ErrorBox message={error} />}{notice && <p className="skin-result" role="status"><Check size={16} />{notice}</p>}
    {operation && <div className="skin-operation" role="status"><span><Spinner size={16} />{stopping ? '正在停止，请等待文件或原生窗口返回后结算…' : `正在${operationNames[operation.phase]}，请稍候…`}</span><button type="button" className="text-button" disabled={stopping} onClick={() => void stop()}>{stopping ? <Spinner size={14} /> : <Square size={13} />}{stopping ? '正在停止' : '停止操作'}</button></div>}
    <form className="skin-library-toolbar" onSubmit={event => { event.preventDefault(); if (busy) return; setSubmitted(query.trim()); setOffset(0); setRefresh(value => value + 1) }}><label className="search-field"><Search size={17} /><input aria-label="搜索皮肤收藏名称或标签" maxLength={200} placeholder="搜索名称或标签" value={query} disabled={!isDesktop || busy} onChange={event => setQuery(event.target.value)} /></label><button type="submit" className="button secondary" disabled={!isDesktop || busy}>搜索</button><label className="skin-tag-filter"><span>标签</span><select aria-label="筛选皮肤标签" value={tag} disabled={!isDesktop || busy} onChange={event => { setTag(event.target.value); setOffset(0) }}><option value="">全部标签</option>{allTags.map(value => <option key={value} value={value}>{safe(value)}</option>)}</select></label><button type="button" className="text-button" disabled={!isDesktop || busy} onClick={() => { setRefresh(value => value + 1); setReadVersion(value => value + 1); setError('') }}><RefreshCw size={14} />刷新</button></form>
    <div className="skin-workspace"><section className="skin-collection" aria-label="本地皮肤收藏"><div className="skin-collection-heading"><h2>收藏列表</h2><span>{data ? `${data.total.toLocaleString('zh-CN')} 项` : loading ? '读取中' : '本地图库'}</span></div>
      {listFailure ? <ErrorBox message={listFailure} retry={() => setRefresh(value => value + 1)} /> : loading ? <div className="skin-list-placeholder" role="status"><Spinner />正在读取本地收藏…</div> : !data?.items.length ? <div className="skin-list-placeholder"><Shirt size={27} /><h3>{submitted || tag ? '没有匹配的收藏' : '还没有本地收藏'}</h3><p>{submitted || tag ? '更换名称关键词或标签筛选。' : '选择一张64 × 64或64 × 32 PNG，先预览再保存。'}</p></div> : <ul className="skin-library-list">{data.items.map(item => <li key={item.id}><button type="button" className={panel?.kind === 'saved' && panel.itemId === item.id ? 'selected' : ''} aria-pressed={panel?.kind === 'saved' && panel.itemId === item.id} disabled={busy} onClick={() => chooseItem(item.id)}><Shirt size={23} aria-hidden="true" /><span><strong>{safe(item.name)}</strong><small>{modelName(item.model)} · 64 × {item.height}</small>{item.tags.length > 0 && <span className="skin-list-tags">{item.tags.map(value => <em key={value}>{safe(value)}</em>)}</span>}</span></button></li>)}</ul>}
      {data && <nav className="skin-library-pagination" aria-label="本地皮肤收藏分页"><button type="button" className="button secondary small-button" disabled={busy || offset === 0} onClick={() => setOffset(value => Math.max(0, value - pageSize))}>上一页</button><span>第 {Math.floor(offset / pageSize) + 1} 页</span><button type="button" className="button secondary small-button" disabled={busy || offset + data.items.length >= data.total} onClick={() => setOffset(value => value + pageSize)}>下一页</button></nav>}
      <p className="skin-library-footnote">列表只读取收藏信息，选择条目后才读取该图片；不会批量读取图库或联网获取皮肤。</p>
    </section><section className="skin-preview-panel" aria-label="所选本地皮肤"><div ref={previewHeading} />
      {panel?.kind === 'preview' ? <SkinEditor key={panel.value.viewId} preview={panel.value} busy={busy} used={spentViewId === panel.value.viewId} save={save} update={update} remove={() => {}} exportImage={() => {}} /> : panel?.kind === 'saved' ? detailFailure ? <ErrorBox message={detailFailure} retry={() => setReadVersion(value => value + 1)} /> : selected ? <SkinEditor key={`${selected.item.id}:${selected.revision}`} saved={selected} busy={busy} save={save} update={update} remove={() => setRemoveConfirm(selected)} exportImage={() => void exportImage()} /> : <div className="skin-list-placeholder" role="status"><Spinner />正在读取所选收藏…</div> : <div className="skin-preview-empty"><Shirt size={34} /><h2>选择一张皮肤</h2><p>查看本地收藏，或先选择 PNG 检查。这里提供正反面2D预览，不会上传或更改当前账户头像。</p><button type="button" className="button secondary" disabled={!isDesktop || busy} onClick={() => void prepare()}><ImagePlus size={16} />选择 PNG</button></div>}
    </section></div>
    {removeConfirm && <Dialog title="移出本地收藏" close={() => { if (!busy) setRemoveConfirm(undefined) }}><p className="modal-description">将「{safe(removeConfirm.item.name)}」从本地收藏列表移出。源PNG与受管图片副本保留，仍会占用磁盘空间；此操作不会重置账户皮肤。</p>{error && <ErrorBox message={error} />}{busy && <div className="skin-operation" role="status"><span><Spinner size={15} />{stopping ? '正在停止，请等待实际操作结算…' : '正在移出收藏，请等待…'}</span><button type="button" className="text-button" disabled={stopping} onClick={() => void stop()}>{stopping ? '正在停止' : '停止操作'}</button></div>}<div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setRemoveConfirm(undefined)}>保留收藏</button><button type="button" className="button secondary" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />确认移出收藏</button></div></Dialog>}
  </section>
}
