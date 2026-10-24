import { resolveWindowPlacement } from './window-geometry'
import type { WindowPreferencesSnapshot, WindowPreferencesStatus, WindowRect } from './window-preferences-types'

/** Closing has a finite wait; timeout preserves pending data, never proves a save. */
export function boundedWindowFlush(work: () => Promise<unknown>, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void Promise.resolve().then(work).then(() => { clearTimeout(timer); resolve(true) }, () => { clearTimeout(timer); resolve(false) })
  })
}

export interface WindowStorePort {
  snapshot(): WindowPreferencesSnapshot
  saveWindowState(state: { normalBounds?: WindowRect; maximized: boolean }): Promise<WindowPreferencesSnapshot>
  flush(): Promise<void>
}
export interface WindowPort {
  isDestroyed(): boolean; isMinimized(): boolean; isMaximized(): boolean; isFullScreen(): boolean; isVisible(): boolean
  getNormalBounds(): WindowRect
  setBounds(bounds: WindowRect): void; setMinimumSize(width: number, height: number): void
  setSize(width: number, height: number): void; unmaximize(): void
}
interface Options {
  store: WindowStorePort
  window: WindowPort
  platform: string
  effectiveTitleBarStyle: 'native' | 'integrated'
  positionManagedByDesktop: boolean
  displays: () => { workAreas: WindowRect[]; primary?: WindowRect }
  background: <T>(work: () => Promise<T>) => Promise<T>
  changed: (status: WindowPreferencesStatus) => void
  debounceMs?: number
}

/** One controller belongs to one window. Old callbacks never act on a successor. */
export class WindowController {
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private normalBounds?: WindowRect
  private maximized: boolean
  private revision = 0
  private persistedRevision = 0
  private saving?: Promise<void>
  private issue?: string
  private pendingNormal = false
  private remembering: boolean
  constructor(private readonly options: Options) {
    const state = options.store.snapshot().state
    this.remembering = options.store.snapshot().preferences.rememberBounds
    this.normalBounds = options.positionManagedByDesktop ? undefined : { ...(state.normalBounds ?? options.window.getNormalBounds()) }
    this.maximized = state.maximized
    if (!state.normalBounds && this.normalBounds) this.revision++
  }
  status(): WindowPreferencesStatus {
    const snapshot = this.options.store.snapshot()
    return {
      preferences: snapshot.preferences,
      effectiveTitleBarStyle: this.options.effectiveTitleBarStyle,
      pendingTitleBarChange: this.options.platform !== 'linux' && snapshot.preferences.titleBarStyle !== this.options.effectiveTitleBarStyle,
      supportsTitleBarStyle: this.options.platform === 'darwin' || this.options.platform === 'win32',
      positionManagedByDesktop: this.options.positionManagedByDesktop,
      ...((this.issue || snapshot.issue) ? { issue: this.issue || snapshot.issue } : {}),
    }
  }
  private publish() { if (!this.stopped) this.options.changed(this.status()) }
  capture(kind: 'normal' | 'maximize' | 'unmaximize' = 'normal') {
    const w = this.options.window
    if (this.stopped || w.isDestroyed() || w.isMinimized() || w.isFullScreen() || !w.isVisible()) return
    if (!this.options.store.snapshot().preferences.rememberBounds) return
    if (kind === 'maximize') this.maximized = true
    if (kind === 'unmaximize') this.maximized = false
    this.pendingNormal = true; this.revision++
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}) }, this.options.debounceMs ?? 250)
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.pendingNormal && !this.stopped) {
      this.pendingNormal = false
      const w = this.options.window
      if (!w.isDestroyed() && !w.isMinimized() && !w.isFullScreen() && w.isVisible()) {
        // Sample after resize settles, not each intermediate macOS zoom frame.
        // Only an explicit unmaximize event clears known maximized memory.
        if (w.isMaximized()) this.maximized = true
        if (this.options.positionManagedByDesktop) this.normalBounds = undefined
        else if (!this.maximized) this.normalBounds = { ...w.getNormalBounds() }
      }
    }
    if (this.saving) { await this.saving; if (this.revision === this.persistedRevision) return }
    if (this.stopped || this.revision === this.persistedRevision || !this.options.store.snapshot().preferences.rememberBounds) {
      await this.options.store.flush(); return
    }
    const revision = this.revision
    const state = { normalBounds: this.normalBounds ? { ...this.normalBounds } : undefined, maximized: this.maximized }
    this.saving = this.options.background(async () => {
      const result = await this.options.store.saveWindowState(state)
      this.issue = result.issue
      if (!result.issue) this.persistedRevision = revision
    }).catch(() => { this.issue = '窗口位置尚未保存，请稍后重试' }).finally(() => { this.saving = undefined; this.publish() })
    await this.saving
    // A move during the actual disk write must not be lost by an earlier snapshot.
    if (!this.issue && this.revision !== this.persistedRevision) await this.flush()
  }
  async preferencesChanged(): Promise<WindowPreferencesStatus> {
    this.issue = undefined
    const remember = this.options.store.snapshot().preferences.rememberBounds
    const w = this.options.window
    if (remember && !this.remembering && !w.isDestroyed() && !w.isMinimized() && !w.isFullScreen()) this.maximized = w.isMaximized()
    this.remembering = remember
    this.capture()
    await this.flush()
    this.publish(); return this.status()
  }
  reconcile() {
    const w = this.options.window
    if (this.stopped || w.isDestroyed() || this.options.positionManagedByDesktop || w.isMinimized() || w.isFullScreen()) return
    const { workAreas, primary } = this.options.displays()
    const result = resolveWindowPlacement(w.getNormalBounds(), workAreas, primary)
    w.setMinimumSize(result.minWidth, result.minHeight)
    // Keep a maximized window maximized; its next normal placement is checked on restore.
    if (!w.isMaximized() && result.corrected && result.bounds) w.setBounds(result.bounds)
    this.capture()
  }
  async resetPlacement(): Promise<WindowPreferencesStatus> {
    const w = this.options.window
    if (this.stopped || w.isDestroyed()) throw new Error('启动器窗口已关闭')
    if (w.isFullScreen()) throw new Error('请先退出启动器全屏，再恢复窗口大小')
    const { workAreas, primary } = this.options.displays()
    const result = resolveWindowPlacement(undefined, workAreas, primary)
    w.unmaximize(); w.setMinimumSize(result.minWidth, result.minHeight)
    if (this.options.positionManagedByDesktop || !result.bounds) w.setSize(result.bounds?.width ?? 1240, result.bounds?.height ?? 840)
    else w.setBounds(result.bounds)
    this.maximized = false
    this.normalBounds = this.options.positionManagedByDesktop ? undefined : w.getNormalBounds()
    this.revision++
    await this.flush(); this.publish(); return this.status()
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined }
}
