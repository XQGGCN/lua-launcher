import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Crosshair, Flame, Minus, Mountain, Orbit, Plus, UserRound } from 'lucide-react'
import { call, errorText, isDesktop, type MapDimension, type WorldMapInfo, type WorldSelection } from '../api'
import { ErrorBox, Spinner } from './ui'
import './WorldMap.css'

type Tile = { state: 'loading' } | { state: 'ready'; image: ImageBitmap } | { state: 'error' }
const dimensions: Array<{ id: MapDimension; label: string; icon: typeof Mountain }> = [
  { id: 'overworld', label: '主世界', icon: Mountain }, { id: 'nether', label: '下界', icon: Flame }, { id: 'end', label: '末地', icon: Orbit },
]
const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 4, 8]

/** Read-only top-down preview of a world's region files, rendered tile by tile in the main process. */
export default function WorldMap({ instanceId, selection, disabled }: { instanceId: string; selection: WorldSelection; disabled?: boolean }) {
  const [info, setInfo] = useState<WorldMapInfo>()
  const [error, setError] = useState('')
  const [dimension, setDimension] = useState<MapDimension>('overworld')
  const [zoom, setZoom] = useState(3)
  const [center, setCenter] = useState({ x: 0, z: 0 })
  const [hover, setHover] = useState<{ x: number; z: number }>()
  const [loadingCount, setLoadingCount] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const tiles = useRef(new Map<string, Tile>())
  const drag = useRef<{ x: number; y: number; cx: number; cz: number } | undefined>(undefined)
  const [, redraw] = useState(0)
  const scale = ZOOMS[zoom]
  const identity = `${instanceId}:${selection.itemId}`

  useEffect(() => {
    let live = true
    setInfo(undefined); setError(''); tiles.current.clear()
    if (!isDesktop) return
    call<WorldMapInfo>('worldMap', instanceId, selection).then(value => {
      if (!live) return
      setInfo(value); setCenter(value.spawn)
      const preferred = (['overworld', 'nether', 'end'] as const).find(id => value.dimensions[id].length) ?? 'overworld'
      setDimension(preferred)
    }).catch(error => { if (live) setError(errorText(error)) })
    return () => { live = false }
  }, [identity])

  const regions = info?.dimensions[dimension] ?? []
  const available = new Set(regions.map(region => `${region.x},${region.z}`))

  const requestTile = useCallback((x: number, z: number) => {
    const key = `${dimension}:${x},${z}`
    if (tiles.current.has(key)) return
    tiles.current.set(key, { state: 'loading' })
    setLoadingCount(count => count + 1)
    call<Uint8Array>('worldMapTile', instanceId, selection, dimension, x, z)
      .then(bytes => createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })))
      .then(image => { tiles.current.set(key, { state: 'ready', image }) })
      .catch(() => { tiles.current.set(key, { state: 'error' }) })
      .finally(() => { setLoadingCount(count => count - 1); redraw(value => value + 1) })
  }, [identity, dimension])

  // Draw visible tiles and request missing ones.
  useEffect(() => {
    const element = canvas.current, box = frame.current
    if (!element || !box || !info) return
    const ratio = window.devicePixelRatio || 1
    const width = box.clientWidth, height = box.clientHeight
    if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) { element.width = Math.round(width * ratio); element.height = Math.round(height * ratio) }
    const context = element.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.imageSmoothingEnabled = scale < 1
    const styles = getComputedStyle(box)
    context.fillStyle = styles.getPropertyValue('--map-void') || '#11142a'
    context.fillRect(0, 0, width, height)
    const left = center.x - width / 2 / scale, top = center.z - height / 2 / scale
    const minRx = Math.floor(left / 512), maxRx = Math.floor((left + width / scale) / 512)
    const minRz = Math.floor(top / 512), maxRz = Math.floor((top + height / scale) / 512)
    const wanted: Array<[number, number, number]> = []
    for (let rx = minRx; rx <= maxRx; rx++) for (let rz = minRz; rz <= maxRz; rz++) {
      if (!available.has(`${rx},${rz}`)) continue
      const tile = tiles.current.get(`${dimension}:${rx},${rz}`)
      const sx = (rx * 512 - left) * scale, sz = (rz * 512 - top) * scale
      if (tile?.state === 'ready') context.drawImage(tile.image, sx, sz, 512 * scale, 512 * scale)
      else {
        context.fillStyle = 'rgba(255,255,255,0.04)'; context.fillRect(sx + 1, sz + 1, 512 * scale - 2, 512 * scale - 2)
        if (!tile) wanted.push([rx, rz, Math.hypot(rx * 512 + 256 - center.x, rz * 512 + 256 - center.z)])
      }
    }
    wanted.sort((a, b) => a[2] - b[2]).slice(0, 6).forEach(([rx, rz]) => requestTile(rx, rz))
    const marker = (x: number, z: number, color: string, ring: string) => {
      const px = (x - left) * scale, pz = (z - top) * scale
      if (px < -10 || pz < -10 || px > width + 10 || pz > height + 10) return
      context.beginPath(); context.arc(px, pz, 6, 0, Math.PI * 2); context.fillStyle = color; context.fill()
      context.lineWidth = 2; context.strokeStyle = ring; context.stroke()
    }
    if (dimension === 'overworld') marker(info.spawn.x, info.spawn.z, '#f3c55b', '#1b2140')
    if (info.player && info.player.dimension === dimension) marker(info.player.x, info.player.z, '#8e9cff', '#ffffff')
  })

  const toWorld = (clientX: number, clientY: number) => {
    const box = frame.current!.getBoundingClientRect()
    return { x: Math.floor(center.x + (clientX - box.left - box.width / 2) / scale), z: Math.floor(center.z + (clientY - box.top - box.height / 2) / scale) }
  }
  function onPointerDown(event: ReactPointerEvent) {
    drag.current = { x: event.clientX, y: event.clientY, cx: center.x, cz: center.z }
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  }
  function onPointerMove(event: ReactPointerEvent) {
    setHover(toWorld(event.clientX, event.clientY))
    if (!drag.current) return
    setCenter({ x: drag.current.cx - (event.clientX - drag.current.x) / scale, z: drag.current.cz - (event.clientY - drag.current.y) / scale })
  }
  function zoomBy(step: number, anchor?: { clientX: number; clientY: number }) {
    const next = Math.max(0, Math.min(ZOOMS.length - 1, zoom + step))
    if (next === zoom) return
    if (anchor && frame.current) {
      const point = toWorld(anchor.clientX, anchor.clientY), ratio = ZOOMS[zoom] / ZOOMS[next]
      setCenter({ x: point.x - (point.x - center.x) * ratio, z: point.z - (point.z - center.z) * ratio })
    }
    setZoom(next)
  }
  useEffect(() => {
    const box = frame.current
    if (!box) return
    const onWheel = (event: WheelEvent) => { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1 : -1, event) }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  })

  if (!isDesktop) return null
  return <section className="world-map" aria-label="地图预览">
    <div className="world-map-head">
      <h3>地图预览</h3>
      <div className="segmented" role="group" aria-label="维度">{dimensions.map(item => <button type="button" key={item.id} className={dimension === item.id ? 'selected' : ''} aria-pressed={dimension === item.id} disabled={!info?.dimensions[item.id].length} onClick={() => { setDimension(item.id); setCenter(item.id === 'overworld' && info ? info.spawn : info?.player?.dimension === item.id ? info.player : { x: 0, z: 0 }) }}><item.icon size={14} />{item.label}</button>)}</div>
    </div>
    {error ? <ErrorBox message={error} /> : <div className={`world-map-frame ${drag.current ? 'dragging' : ''}`} ref={frame}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = undefined }} onPointerLeave={() => setHover(undefined)}
      onDoubleClick={event => zoomBy(1, event)} tabIndex={0} role="application" aria-label="世界地图，可拖动和缩放"
      onKeyDown={event => {
        const step = 64 / scale
        if (event.key === '+' || event.key === '=') zoomBy(1)
        else if (event.key === '-') zoomBy(-1)
        else if (event.key === 'ArrowLeft') setCenter(value => ({ ...value, x: value.x - step }))
        else if (event.key === 'ArrowRight') setCenter(value => ({ ...value, x: value.x + step }))
        else if (event.key === 'ArrowUp') setCenter(value => ({ ...value, z: value.z - step }))
        else if (event.key === 'ArrowDown') setCenter(value => ({ ...value, z: value.z + step }))
        else return
        event.preventDefault()
      }}>
      <canvas ref={canvas} />
      {!info && <div className="world-map-overlay"><Spinner />正在读取世界…</div>}
      {info && !regions.length && <div className="world-map-overlay">这个维度还没有生成区域</div>}
      <div className="world-map-controls">
        <button type="button" onClick={() => zoomBy(1)} aria-label="放大" disabled={zoom === ZOOMS.length - 1}><Plus size={16} /></button>
        <button type="button" onClick={() => zoomBy(-1)} aria-label="缩小" disabled={zoom === 0}><Minus size={16} /></button>
        {info && dimension === 'overworld' && <button type="button" onClick={() => setCenter(info.spawn)} aria-label="回到出生点" title="回到出生点"><Crosshair size={16} /></button>}
        {info?.player?.dimension === dimension && <button type="button" onClick={() => setCenter(info.player!)} aria-label="定位到玩家" title="定位到玩家"><UserRound size={16} /></button>}
      </div>
      <div className="world-map-status">{loadingCount > 0 && <><Spinner size={12} />渲染中 · </>}{hover ? `X ${hover.x}  Z ${hover.z}` : `${regions.length} 个区域`} · {scale >= 1 ? `${scale}×` : `1:${1 / scale}`}</div>
    </div>}
    <p className="world-map-legend">{dimension === 'overworld' && <><span className="dot spawn" />出生点</>}{info?.player?.dimension === dimension && <><span className="dot player" />玩家位置</>}<span>拖动平移，滚轮或双击缩放。只读取存档，不会修改世界。{disabled ? ' 游戏运行时地图可能不是最新。' : ''}</span></p>
  </section>
}
