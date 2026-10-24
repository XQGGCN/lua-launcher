/** Pure pixel rectangles for an orthographic local preview, not a game render.
 * Primary implementation references, checked 2026-10-24:
 * https://github.com/bs-community/skinview3d/blob/master/src/model.ts
 * https://github.com/bs-community/skinview-utils/blob/master/src/process.ts
 * Cube UV positions and legacy mirrored limbs were independently transcribed
 * as layout facts; no upstream rendering code/assets/dependency is included.
 * These are primary third-party implementation references, not Mojang API docs.
 */
export type SkinModel = 'classic' | 'slim'
export type SkinPart = 'head' | 'body' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg'
export interface SkinPreviewRect {
  part: SkinPart
  layer: 'base' | 'outer'
  sx: number; sy: number; sw: number; sh: number
  dx: number; dy: number; dw: number; dh: number
  flipX: boolean
}
export interface SkinPreviewLayout { width: 16; height: 32; rects: SkinPreviewRect[] }
export interface SkinPreviewOptions { height: 32 | 64; model: SkinModel; view: 'front' | 'back'; outerLayer: boolean }

/** Output always occupies a fixed16x32 grid. Slim arms leave one transparent
 * column at each edge; 2D outer faces overlay without3D inflation/lighting. */
export function skinPreviewLayout(options: SkinPreviewOptions): SkinPreviewLayout {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['height', 'model', 'view', 'outerLayer'].includes(key)) ||
    ![32, 64].includes(options.height) || !['classic', 'slim'].includes(options.model) || !['front', 'back'].includes(options.view) || typeof options.outerLayer !== 'boolean') throw new Error('皮肤预览布局参数无效')
  if (options.height === 32 && options.model === 'slim') throw new Error('旧64×32布局本版仅支持经典模型预览')
  const back = options.view === 'back', legacy = options.height === 32, armWidth = options.model === 'slim' ? 3 : 4
  const rects: SkinPreviewRect[] = []
  function face(part: SkinPart, layer: 'base' | 'outer', u: number, v: number, width: number, height: number, depth: number, dx: number, dy: number, flipX = false) {
    rects.push({ part, layer, sx: u + (back ? width + depth * 2 : depth), sy: v + depth, sw: width, sh: height,
      dx, dy, dw: width, dh: height, flipX })
  }
  const rightArmX = back ? 12 : 4 - armWidth, leftArmX = back ? 4 - armWidth : 12
  const rightLegX = back ? 8 : 4, leftLegX = back ? 4 : 8
  face('head', 'base', 0, 0, 8, 8, 8, 4, 0)
  face('body', 'base', 16, 16, 8, 12, 4, 4, 8)
  face('rightArm', 'base', 40, 16, armWidth, 12, 4, rightArmX, 8)
  face('leftArm', 'base', legacy ? 40 : 32, legacy ? 16 : 48, armWidth, 12, 4, leftArmX, 8, legacy)
  face('rightLeg', 'base', 0, 16, 4, 12, 4, rightLegX, 20)
  face('leftLeg', 'base', legacy ? 0 : 16, legacy ? 16 : 48, 4, 12, 4, leftLegX, 20, legacy)
  if (options.outerLayer) {
    face('head', 'outer', 32, 0, 8, 8, 8, 4, 0)
    if (!legacy) {
      face('body', 'outer', 16, 32, 8, 12, 4, 4, 8)
      face('rightArm', 'outer', 40, 32, armWidth, 12, 4, rightArmX, 8)
      face('leftArm', 'outer', 48, 48, armWidth, 12, 4, leftArmX, 8)
      face('rightLeg', 'outer', 0, 32, 4, 12, 4, rightLegX, 20)
      face('leftLeg', 'outer', 0, 48, 4, 12, 4, leftLegX, 20)
    }
  }
  return { width: 16, height: 32, rects }
}
