import type { WindowPreferencesSnapshot, WindowTitleBarStyle, WindowZoomStatus, ZoomPercent } from './window-preferences-types'

export const ZOOM_PRESETS: readonly ZoomPercent[] = Object.freeze([90, 100, 110, 125])
export function zoomPercent(value: unknown): ZoomPercent {
  if (typeof value !== 'number' || !ZOOM_PRESETS.includes(value as ZoomPercent)) throw new Error('请选择受支持的界面缩放比例')
  return value as ZoomPercent
}
/** Nondefault presets are released only for the native macOS surface tested here. */
export function supportedZoom(platform: string, chrome: WindowTitleBarStyle): ZoomPercent[] {
  return platform === 'darwin' && chrome === 'native' ? [...ZOOM_PRESETS] : [100]
}
export function initialZoom(preferences: WindowPreferencesSnapshot['preferences'], platform: string, chrome: WindowTitleBarStyle): ZoomPercent {
  const requested = preferences.zoomPercent ?? 100
  return supportedZoom(platform, chrome).includes(requested) ? requested : 100
}
export function shortcutZoom(input: { type: string; key: string; code?: string; control?: boolean; meta?: boolean; alt?: boolean; isComposing?: boolean; isAutoRepeat?: boolean }, platform: string): 'in' | 'out' | 'reset' | undefined {
  if (input.type !== 'keyDown' || input.isComposing || input.alt || !(platform === 'darwin' ? input.meta : input.control)) return
  if (['+', '=', 'Add'].includes(input.key) || input.code === 'NumpadAdd') return 'in'
  if (['-', '_', 'Subtract'].includes(input.key) || input.code === 'NumpadSubtract') return 'out'
  if (input.key === '0' || input.code === 'Numpad0') return 'reset'
}
interface ZoomPort { isDestroyed(): boolean; getZoomFactor(): number; setZoomFactor(factor: number): void; setZoomMode(mode: 'isolated'): void }
interface Options {
  platform: string; chrome: WindowTitleBarStyle
  port: ZoomPort
  store: { snapshot(): WindowPreferencesSnapshot; updatePreferences(patch: { zoomPercent: ZoomPercent }): Promise<WindowPreferencesSnapshot> }
  changed: () => void
}
/** One webContents generation, synchronous browser apply/readback, serialized durable selection. */
export class WindowZoomController {
  private stopped = false
  private busy = false
  private correcting = false
  private issue?: string
  private liveOverride?: ZoomPercent
  private pendingReconcile = false
  constructor(private readonly options: Options) {}
  private actual(): ZoomPercent | null {
    try {
      if (this.stopped || this.options.port.isDestroyed()) return null
      const factor = this.options.port.getZoomFactor()
      return ZOOM_PRESETS.find(percent => Math.abs(factor - percent / 100) < 0.000001) ?? null
    } catch { return null }
  }
  private desired(): ZoomPercent {
    if (this.liveOverride !== undefined) return this.liveOverride
    return initialZoom(this.options.store.snapshot().preferences, this.options.platform, this.options.chrome)
  }
  status(): WindowZoomStatus {
    const requestedPercent = this.options.store.snapshot().preferences.zoomPercent ?? 100
    const supportedPercents = supportedZoom(this.options.platform, this.options.chrome)
    return { requestedPercent, effectivePercent: this.actual(), supportedPercents, busy: this.busy,
      ...(this.issue ? { issue: this.issue } : {}),
      ...(!supportedPercents.includes(requestedPercent) ? { reason: this.options.chrome === 'integrated'
        ? '融合标题栏当前保持100%；已保存比例将在受支持的原生窗口中应用。'
        : '此平台的其他缩放比例尚未完成原生验证，当前保持100%。' } : {}) }
  }
  private publish() { if (!this.stopped && !this.options.port.isDestroyed()) this.options.changed() }
  private apply(percent: ZoomPercent): boolean {
    if (this.stopped || this.options.port.isDestroyed()) return false
    try {
      this.options.port.setZoomMode('isolated')
      this.options.port.setZoomFactor(percent / 100)
      if (this.actual() !== percent) throw new Error('unconfirmed')
      return true
    } catch {
      this.issue = '界面缩放未能确认，请尝试恢复100%'
      return false
    }
  }
  start(): void { this.reconcile() }
  reconcile(): void {
    if (this.stopped || this.options.port.isDestroyed()) return
    if (this.busy) { this.pendingReconcile = true; return }
    if (this.correcting) return
    this.correcting = true
    try {
      const desired = this.desired()
      if (this.actual() !== desired) this.apply(desired)
      else this.options.port.setZoomMode('isolated')
    } catch { this.issue = '界面缩放未能确认，请尝试恢复100%' }
    finally { this.correcting = false; this.publish() }
  }
  async setPercent(input: unknown): Promise<void> {
    const percent = zoomPercent(input)
    if (!supportedZoom(this.options.platform, this.options.chrome).includes(percent)) throw new Error('当前平台或生效标题栏只支持100%界面缩放')
    if (this.stopped || this.options.port.isDestroyed()) throw new Error('启动器窗口已关闭')
    if (this.busy) throw new Error('请等待当前缩放操作完成')
    this.busy = true; this.issue = undefined; this.publish()
    try {
      const saved = await this.options.store.updatePreferences({ zoomPercent: percent })
      if (this.stopped || this.options.port.isDestroyed()) throw new Error('启动器窗口已关闭；已保存的比例将在后续窗口中使用')
      if (saved.issue || (saved.preferences.zoomPercent ?? 100) !== percent) { this.issue = saved.issue ?? '界面缩放偏好未保存'; return }
      this.liveOverride = undefined
      this.apply(percent)
    } catch (error) {
      if (this.stopped || this.options.port.isDestroyed()) throw error
      this.issue = '界面缩放偏好未能保存，请稍后重试'
    } finally { this.busy = false; this.finish() }
  }
  /** Live recovery is available even when an unknown config cannot be overwritten. */
  async restore(): Promise<void> {
    if (this.stopped || this.options.port.isDestroyed()) throw new Error('启动器窗口已关闭')
    if (this.busy) throw new Error('请等待当前缩放操作完成')
    this.busy = true; this.issue = undefined; this.liveOverride = 100
    this.apply(100); this.publish()
    try {
      const saved = await this.options.store.updatePreferences({ zoomPercent: 100 })
      if (this.stopped || this.options.port.isDestroyed()) return
      if (saved.issue || (saved.preferences.zoomPercent ?? 100) !== 100) this.issue = saved.issue ?? '当前已恢复100%，但偏好未保存'
      else this.liveOverride = undefined
    } catch { this.issue = '界面缩放偏好未能保存；当前比例请以实际显示为准'
    } finally { this.busy = false; this.finish() }
  }
  private finish() {
    if (this.pendingReconcile) { this.pendingReconcile = false; this.reconcile() }
    else this.publish()
  }
  async step(action: 'in' | 'out' | 'reset'): Promise<void> {
    if (action === 'reset') return this.restore()
    const values = supportedZoom(this.options.platform, this.options.chrome)
    const at = values.indexOf(this.actual() ?? this.desired())
    const next = values[Math.min(values.length - 1, Math.max(0, at + (action === 'in' ? 1 : -1)))]
    if (next === this.actual()) return
    await this.setPercent(next)
  }
  stop() { this.stopped = true }
}
