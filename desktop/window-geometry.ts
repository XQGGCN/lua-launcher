import type { WindowRect } from './window-preferences-types'

export const WINDOW_GEOMETRY_LIMITS = Object.freeze({ coordinate: 1_000_000, workAreas: 64,
  width: 1240, height: 840, minWidth: 880, minHeight: 640, titleHeight: 32, dragWidth: 160 })
export interface WindowPlacement { bounds: WindowRect | undefined; minWidth: number; minHeight: number; corrected: boolean }
const equal = (a: WindowRect, b: WindowRect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
export function isWindowRect(value: unknown): value is WindowRect {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const v = value as Record<string, unknown>, keys = Reflect.ownKeys(v)
  if (keys.length !== 4 || keys.some(key => typeof key !== 'string' || !['x', 'y', 'width', 'height'].includes(key) || !('value' in Object.getOwnPropertyDescriptor(v, key)!))) return false
  return ['x', 'y', 'width', 'height'].every(key => typeof v[key] === 'number' && Number.isSafeInteger(v[key]) && Math.abs(v[key] as number) <= WINDOW_GEOMETRY_LIMITS.coordinate) && (v.width as number) > 0 && (v.height as number) > 0
}
function intersection(a: WindowRect, b: WindowRect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
}
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))
function reachable(rect: WindowRect, areas: WindowRect[]): boolean {
  const titleHeight = Math.min(WINDOW_GEOMETRY_LIMITS.titleHeight, rect.height), endInset = Math.min(8, rect.width / 4),
    point = (x: number) => areas.some(area => x >= area.x && x < area.x + area.width && rect.y >= area.y && rect.y + titleHeight <= area.y + area.height)
  if (!point(rect.x + endInset) || !point(rect.x + rect.width - endInset)) return false
  return areas.some(area => rect.y >= area.y && rect.y + titleHeight <= area.y + area.height &&
    Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x) >= Math.min(WINDOW_GEOMETRY_LIMITS.dragWidth, rect.width))
}
function covered(rect: WindowRect, areas: WindowRect[]): boolean {
  const right = rect.x + rect.width, bottom = rect.y + rect.height,
    cuts = [...new Set([rect.x, right, ...areas.flatMap(area => [clamp(area.x, rect.x, right), clamp(area.x + area.width, rect.x, right)])])].sort((a, b) => a - b)
  for (let i = 0; i < cuts.length - 1; i++) {
    const left = cuts[i], end = cuts[i + 1]
    if (left === end) continue
    const intervals = areas.filter(area => area.x <= left && area.x + area.width >= end).map(area => [Math.max(rect.y, area.y), Math.min(bottom, area.y + area.height)])
      .filter(([start, stop]) => stop > start).sort((a, b) => a[0] - b[0])
    let cursor = rect.y
    for (const [start, stop] of intervals) { if (start > cursor) return false; cursor = Math.max(cursor, stop) }
    if (cursor < bottom) return false
  }
  return true
}

/** Pure Electron DIP geometry. It neither reads display IDs nor moves a real window. */
export function resolveWindowPlacement(saved: WindowRect | undefined, workAreas: WindowRect[], primary?: WindowRect): WindowPlacement {
  const areas = Array.isArray(workAreas) ? workAreas.slice(0, WINDOW_GEOMETRY_LIMITS.workAreas).filter(isWindowRect).map(area => ({ ...area })) : []
  const preferred = isWindowRect(primary) ? { ...primary } : undefined
  if (!areas.length && preferred) areas.push(preferred)
  if (!areas.length) return { bounds: undefined, minWidth: WINDOW_GEOMETRY_LIMITS.minWidth, minHeight: WINDOW_GEOMETRY_LIMITS.minHeight, corrected: saved !== undefined }
  const candidate = isWindowRect(saved) ? { ...saved } : undefined
  let selected = preferred ?? areas[0], overlap = 0
  if (candidate) for (const area of areas) {
    const amount = intersection(candidate, area)
    if (amount > overlap || amount > 0 && amount === overlap && preferred && equal(area, preferred)) { selected = area; overlap = amount }
  }
  const minWidth = Math.min(WINDOW_GEOMETRY_LIMITS.minWidth, selected.width), minHeight = Math.min(WINDOW_GEOMETRY_LIMITS.minHeight, selected.height),
    width = clamp(candidate?.width ?? WINDOW_GEOMETRY_LIMITS.width, minWidth, selected.width), height = clamp(candidate?.height ?? WINDOW_GEOMETRY_LIMITS.height, minHeight, selected.height)
  if (candidate && width === candidate.width && height === candidate.height && reachable(candidate, areas) && covered(candidate, areas)) return { bounds: candidate, minWidth, minHeight, corrected: false }
  const x = candidate && overlap > 0 ? candidate.x : selected.x + Math.floor((selected.width - width) / 2),
    y = candidate && overlap > 0 ? candidate.y : selected.y + Math.floor((selected.height - height) / 2), bounds = {
      x: clamp(clamp(x, selected.x, selected.x + selected.width - width), -WINDOW_GEOMETRY_LIMITS.coordinate, WINDOW_GEOMETRY_LIMITS.coordinate),
      y: clamp(clamp(y, selected.y, selected.y + selected.height - height), -WINDOW_GEOMETRY_LIMITS.coordinate, WINDOW_GEOMETRY_LIMITS.coordinate), width, height }
  return { bounds, minWidth, minHeight, corrected: saved !== undefined && (!candidate || !equal(candidate, bounds)) }
}
