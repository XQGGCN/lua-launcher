import assert from 'node:assert/strict'
import test from 'node:test'
import { isWindowRect, resolveWindowPlacement } from './window-geometry'
import type { WindowRect } from './window-preferences-types'
const primary: WindowRect = { x: 0, y: 0, width: 1920, height: 1080 }
const left: WindowRect = { x: -1920, y: 0, width: 1920, height: 1080 }
const normal: WindowRect = { x: 200, y: 100, width: 1240, height: 840 }

test('default placement centers1240x840 in primary DIP work area without pretending saved correction', () => {
  assert.deepEqual(resolveWindowPlacement(undefined, [primary], primary), { bounds: { x: 340, y: 120, width: 1240, height: 840 }, minWidth: 880, minHeight: 640, corrected: false })
})
test('valid saved negative-x and negative-y monitor coordinates stay unchanged', () => {
  for (const [area, rect] of [[left, { ...normal, x: -1700 }], [{ x: 0, y: -1200, width: 1920, height: 1200 }, { ...normal, y: -1100 }]] as [WindowRect, WindowRect][]) {
    assert.deepEqual(resolveWindowPlacement(rect, [primary, area], primary).bounds, rect); assert.equal(resolveWindowPlacement(rect, [primary, area], primary).corrected, false)
  }
})
test('removed monitor and entirely offscreen saved rectangles fall back to primary, without scale multiplication', () => {
  const result = resolveWindowPlacement({ ...normal, x: -1700 }, [primary], primary)
  assert.deepEqual(result.bounds, { x: 340, y: 120, width: 1240, height: 840 }); assert.equal(result.corrected, true)
})
test('one-pixel intersection cannot count as reachable titlebar and is clamped fully into work area', () => {
  const result = resolveWindowPlacement({ ...normal, x: 1919 }, [primary], primary)
  assert.deepEqual(result.bounds, { ...normal, x: 680 }); assert.equal(result.corrected, true)
})
test('good跨屏 window is preserved when both caption ends and full outer frame remain reachable', () => {
  const right = { ...primary, x: 1920 }, saved = { ...normal, x: 1500 }
  assert.deepEqual(resolveWindowPlacement(saved, [primary, right], primary).bounds, saved)
  assert.equal(resolveWindowPlacement(saved, [primary, right], primary).corrected, false)
})
test('offscreen body and a gap between monitors are corrected despite a partly visible title band', () => {
  const bottom = resolveWindowPlacement({ ...normal, y: 900 }, [primary], primary)
  assert.equal(bottom.bounds?.y, 240); assert.equal(bottom.corrected, true)
  const gap = resolveWindowPlacement({ ...normal, x: 1500 }, [primary, { ...primary, x: 2200 }], primary)
  assert.equal(gap.corrected, true)
})
test('largest intersection chooses work area and equal-overlap tie deterministically prefers primary', () => {
  const a = { x: 0, y: 0, width: 1000, height: 1000 }, b = { x: 1000, y: 0, width: 1000, height: 1000 }
  const saved = { x: 500, y: 0, width: 1000, height: 1200 }
  assert.equal(resolveWindowPlacement(saved, [a, b], b).bounds?.x, 1000)
  assert.equal(resolveWindowPlacement({ ...saved, x: 750 }, [a, b], a).bounds?.x, 1000)
})
test('work area shrink/rotation resizes and adjusts minima to the actual display', () => {
  const area = { x: -800, y: 30, width: 800, height: 600 }, result = resolveWindowPlacement(normal, [area], area)
  assert.deepEqual(result, { bounds: { x: -800, y: 30, width: 800, height: 600 }, minWidth: 800, minHeight: 600, corrected: true })
})
test('tiny work area never has min880x640 conflicting with constructed dimensions', () => {
  const area = { x: 40, y: -80, width: 120, height: 30 }, result = resolveWindowPlacement(undefined, [area])
  assert.deepEqual(result.bounds, area); assert.equal(result.minWidth, 120); assert.equal(result.minHeight, 30)
})
test('smaller saved rectangles grow to normal minima and oversized ones shrink to selected display', () => {
  const small = resolveWindowPlacement({ x: 10, y: 10, width: 100, height: 100 }, [primary])
  assert.deepEqual(small.bounds, { x: 10, y: 10, width: 880, height: 640 })
  const huge = resolveWindowPlacement({ x: 10, y: 10, width: 1_000_000, height: 1_000_000 }, [primary])
  assert.deepEqual(huge.bounds, primary)
})
test('no display or only invalid areas leaves bounds to OS and finite default minima', () => {
  assert.deepEqual(resolveWindowPlacement(undefined, []), { bounds: undefined, minWidth: 880, minHeight: 640, corrected: false })
  assert.deepEqual(resolveWindowPlacement(normal, [{ ...primary, width: 0 }]), { bounds: undefined, minWidth: 880, minHeight: 640, corrected: true })
  assert.deepEqual(resolveWindowPlacement(undefined, [], primary).bounds, { x: 340, y: 120, width: 1240, height: 840 })
})
test('NaN, infinity, nonintegers, large/extra/prototype values and accessors are never trusted as rectangles', () => {
  let touched = false
  const bad = [null, [], { ...normal, x: NaN }, { ...normal, y: Infinity }, { ...normal, x: 1.5 }, { ...normal, width: -1 }, { ...normal, x: 1_000_001 }, { ...normal, extra: true }, Object.assign(Object.create({ foreign: true }), normal),
    { ...normal, get x() { touched = true; return 1 } }]
  for (const value of bad) { assert.equal(isWindowRect(value), false); const result = resolveWindowPlacement(value as WindowRect, [primary]); assert.ok(result.bounds); assert.equal(result.corrected, true) }
  assert.equal(touched, false)
})
test('resolved finite correction is idempotent and inputs are not mutated', () => {
  const saved = { x: 1919, y: -20, width: 1240, height: 840 }, before = structuredClone(saved), areaBefore = structuredClone(primary), first = resolveWindowPlacement(saved, [primary]), second = resolveWindowPlacement(first.bounds, [primary])
  assert.deepEqual(first.bounds, second.bounds); assert.equal(second.corrected, false); assert.deepEqual(saved, before); assert.deepEqual(primary, areaBefore)
})
test('DIP rectangles are the complete geometry input, with no display ID, scaleFactor or cursor dependency', () => {
  const original = resolveWindowPlacement(normal, [primary, left], primary)
  const recreated = resolveWindowPlacement({ ...normal }, [{ ...primary }, { ...left }], { ...primary })
  assert.deepEqual(recreated, original)
})
