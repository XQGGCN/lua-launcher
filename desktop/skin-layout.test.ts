import test from 'node:test'
import assert from 'node:assert/strict'
import { skinPreviewLayout, type SkinPreviewLayout, type SkinPreviewRect } from '../src/skin-layout'

function sourcePixels(height: 32 | 64) {
  const data = new Uint8Array(64 * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < 64; x++) data.set([x, y, x ^ y, 255], (y * 64 + x) * 4)
  return data
}
/** Tiny independent fixture rasterizer: applies the published rectangle DTO,
 * not the implementation's cube formulas or face selection logic. */
function draw(layout: SkinPreviewLayout, input: Uint8Array) {
  const out = new Uint8Array(layout.width * layout.height * 4)
  for (const r of layout.rects) for (let y = 0; y < r.sh; y++) for (let x = 0; x < r.sw; x++) {
    const source = ((r.sy + y) * 64 + r.sx + (r.flipX ? r.sw - 1 - x : x)) * 4, target = ((r.dy + y) * 16 + r.dx + x) * 4
    if (input[source + 3]) out.set(input.subarray(source, source + 4), target)
  }
  return out
}
const at = (pixels: Uint8Array, x: number, y: number) => [...pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)]
function rectValue(r: SkinPreviewRect) { return [r.part, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.flipX] }

test('modern classic front uses six exact independently enumerated face rectangles', () => {
  const layout = skinPreviewLayout({ height: 64, model: 'classic', view: 'front', outerLayer: false })
  assert.deepEqual({ width: layout.width, height: layout.height }, { width: 16, height: 32 })
  assert.deepEqual(layout.rects.map(rectValue), [
    ['head', 8, 8, 8, 8, 4, 0, false], ['body', 20, 20, 8, 12, 4, 8, false],
    ['rightArm', 44, 20, 4, 12, 0, 8, false], ['leftArm', 36, 52, 4, 12, 12, 8, false],
    ['rightLeg', 4, 20, 4, 12, 4, 20, false], ['leftLeg', 20, 52, 4, 12, 8, 20, false],
  ])
  const rendered = draw(layout, sourcePixels(64))
  assert.deepEqual(at(rendered, 4, 0), [8, 8, 0, 255]); assert.deepEqual(at(rendered, 15, 19), [39, 63, 39 ^ 63, 255])
  assert.deepEqual(at(rendered, 8, 20), [20, 52, 20 ^ 52, 255])
})
test('modern classic back uses exact back faces and swaps screen placement of character left/right', () => {
  const layout = skinPreviewLayout({ height: 64, model: 'classic', view: 'back', outerLayer: false })
  assert.deepEqual(layout.rects.map(rectValue), [
    ['head', 24, 8, 8, 8, 4, 0, false], ['body', 32, 20, 8, 12, 4, 8, false],
    ['rightArm', 52, 20, 4, 12, 12, 8, false], ['leftArm', 44, 52, 4, 12, 0, 8, false],
    ['rightLeg', 12, 20, 4, 12, 8, 20, false], ['leftLeg', 28, 52, 4, 12, 4, 20, false],
  ])
  const rendered = draw(layout, sourcePixels(64))
  assert.deepEqual(at(rendered, 0, 8), [44, 52, 44 ^ 52, 255]); assert.deepEqual(at(rendered, 12, 8), [52, 20, 52 ^ 20, 255])
})
test('Slim arms are three pixels, with distinct back UV offsets and transparent grid edges', () => {
  const front = skinPreviewLayout({ height: 64, model: 'slim', view: 'front', outerLayer: false })
  const back = skinPreviewLayout({ height: 64, model: 'slim', view: 'back', outerLayer: false })
  assert.deepEqual(front.rects.filter(r => r.part.endsWith('Arm')).map(rectValue), [
    ['rightArm', 44, 20, 3, 12, 1, 8, false], ['leftArm', 36, 52, 3, 12, 12, 8, false],
  ])
  assert.deepEqual(back.rects.filter(r => r.part.endsWith('Arm')).map(rectValue), [
    ['rightArm', 51, 20, 3, 12, 12, 8, false], ['leftArm', 43, 52, 3, 12, 1, 8, false],
  ])
  for (const layout of [front, back]) {
    const rendered = draw(layout, sourcePixels(64))
    for (let y = 8; y < 20; y++) { assert.deepEqual(at(rendered, 0, y), [0, 0, 0, 0]); assert.deepEqual(at(rendered, 15, y), [0, 0, 0, 0]) }
  }
})
test('modern outer faces are an ordered overlay at exact hat/body/arm/leg atlas rectangles', () => {
  const front = skinPreviewLayout({ height: 64, model: 'classic', view: 'front', outerLayer: true })
  assert.equal(front.rects.length, 12); assert.ok(front.rects.slice(0, 6).every(r => r.layer === 'base'))
  assert.deepEqual(front.rects.slice(6).map(rectValue), [
    ['head', 40, 8, 8, 8, 4, 0, false], ['body', 20, 36, 8, 12, 4, 8, false],
    ['rightArm', 44, 36, 4, 12, 0, 8, false], ['leftArm', 52, 52, 4, 12, 12, 8, false],
    ['rightLeg', 4, 36, 4, 12, 4, 20, false], ['leftLeg', 4, 52, 4, 12, 8, 20, false],
  ])
  const back = skinPreviewLayout({ height: 64, model: 'slim', view: 'back', outerLayer: true })
  assert.deepEqual(back.rects.slice(6).map(rectValue), [
    ['head', 56, 8, 8, 8, 4, 0, false], ['body', 32, 36, 8, 12, 4, 8, false],
    ['rightArm', 51, 36, 3, 12, 12, 8, false], ['leftArm', 59, 52, 3, 12, 1, 8, false],
    ['rightLeg', 12, 36, 4, 12, 8, 20, false], ['leftLeg', 12, 52, 4, 12, 4, 20, false],
  ])
})
test('legacy Classic mirrors only left arm/leg pixels and has only the existing hat outer layer', () => {
  for (const view of ['front', 'back'] as const) {
    const layout = skinPreviewLayout({ height: 32, model: 'classic', view, outerLayer: true })
    assert.equal(layout.rects.length, 7); assert.deepEqual(layout.rects.filter(r => r.flipX).map(r => r.part), ['leftArm', 'leftLeg'])
    assert.deepEqual(layout.rects.filter(r => r.layer === 'outer').map(r => r.part), ['head'])
    const rendered = draw({ ...layout, rects: layout.rects.filter(r => r.layer === 'base') }, sourcePixels(32))
    if (view === 'front') { assert.deepEqual(at(rendered, 12, 8), [47, 20, 47 ^ 20, 255]); assert.deepEqual(at(rendered, 8, 20), [7, 20, 7 ^ 20, 255]) }
    else { assert.deepEqual(at(rendered, 0, 8), [55, 20, 55 ^ 20, 255]); assert.deepEqual(at(rendered, 4, 20), [15, 20, 15 ^ 20, 255]) }
  }
})
test('every supported rectangle stays inside source and destination with matching pixel dimensions', () => {
  for (const height of [32, 64] as const) for (const model of ['classic', 'slim'] as const) for (const view of ['front', 'back'] as const) for (const outerLayer of [true, false]) {
    if (height === 32 && model === 'slim') continue
    const layout = skinPreviewLayout({ height, model, view, outerLayer })
    for (const r of layout.rects) {
      for (const n of [r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh]) assert.ok(Number.isSafeInteger(n) && n >= 0)
      assert.equal(r.sw, r.dw); assert.equal(r.sh, r.dh); assert.ok(r.sx + r.sw <= 64 && r.sy + r.sh <= height); assert.ok(r.dx + r.dw <= 16 && r.dy + r.dh <= 32)
    }
  }
})
test('transparent overlay pixels leave base visible in the independent preview fixture', () => {
  const input = sourcePixels(64), layout = skinPreviewLayout({ height: 64, model: 'classic', view: 'front', outerLayer: true })
  input[(8 * 64 + 40) * 4 + 3] = 0
  const rendered = draw(layout, input)
  assert.deepEqual(at(rendered, 4, 0), [8, 8, 0, 255]); assert.deepEqual(at(rendered, 5, 0), [41, 8, 41 ^ 8, 255])
})
test('legacy Slim, unknown options and malformed layouts fail without choosing a guessed model', () => {
  assert.throws(() => skinPreviewLayout({ height: 32, model: 'slim', view: 'front', outerLayer: true }), /仅支持经典/)
  for (const bad of [{ height: 65, model: 'classic', view: 'front', outerLayer: true }, { height: 64, model: 'unknown', view: 'front', outerLayer: true }, { height: 64, model: 'classic', view: 'side', outerLayer: true }, { height: 64, model: 'classic', view: 'front', outerLayer: 1 }, { height: 64, model: 'classic', view: 'front', outerLayer: true, url: 'https://invalid' }]) assert.throws(() => skinPreviewLayout(bad as never), /参数无效/)
})
test('pure layout returns independent rectangles and never changes source images or caller options', () => {
  const options = { height: 64, model: 'classic', view: 'front', outerLayer: false } as const, before = JSON.stringify(options)
  const first = skinPreviewLayout(options); first.rects[0].sx = 63
  assert.equal(skinPreviewLayout(options).rects[0].sx, 8); assert.equal(JSON.stringify(options), before)
})
