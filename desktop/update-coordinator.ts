import { randomUUID } from 'node:crypto'
import type { UpdateInfo } from './updater'

/** The renderer confirms this exact main-process selection, never an arbitrary URL. */
export interface SelectedUpdate extends UpdateInfo { selectionId: string }
export type UpdateResult = 'opened-page' | 'opened-installer' | 'installing' | 'restarting'
const busy = () => new Error('有操作正在进行，请等待完成后再更新启动器')
// Only in-memory status queries belong here. account/authConfig read from disk.
const statusQueries = new Set(['snapshot', 'logs', 'authState', 'runtimeTasks', 'worldBackupTasks', 'worldExportTasks'])

/**
 * Every desktop dispatch enters here before its first await. This covers early
 * credential, picker, metadata and filesystem waits that aren't Core tasks yet.
 * Only explicitly synchronous status queries bypass this gate in main.ts.
 */
export class UpdateActivityGate {
  private operations = 0
  private updating = false
  private closed = false

  async dispatch<T>(method: unknown, work: () => Promise<T> | T): Promise<T> {
    return typeof method === 'string' && statusQueries.has(method) ? work() : this.operation(work)
  }

  async operation<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.closed || this.updating) throw busy()
    this.operations++
    try { return await work() } finally { this.operations-- }
  }

  reserve(reserveCore: () => () => void): () => void {
    if (this.closed || this.updating || this.operations) throw busy()
    const releaseCore = reserveCore()
    this.updating = true
    let released = false
    return () => {
      if (released) return
      released = true
      try { releaseCore() } finally { this.updating = false }
    }
  }

  get isUpdating(): boolean { return this.updating }
  close(): void { this.closed = true }
}

interface CoordinatorOptions {
  activity: UpdateActivityGate
  reserveCore: () => () => void
  check: () => Promise<UpdateInfo | null>
  download: (update: SelectedUpdate, signal: AbortSignal) => Promise<string>
  openPage: (url: string) => Promise<void>
  openInstaller: (file: string) => Promise<void>
  startInstaller: (file: string) => Promise<void>
  replaceAppImage: (file: string, update: SelectedUpdate, signal: AbortSignal) => Promise<void>
  /** Schedule exit/relaunch after a successful handoff; the lease stays held. */
  handoff: (action: 'installer' | 'appimage') => void
  selectionId?: () => string
}

/** No filesystem, Electron or installer side effects outside the injected ports. */
export class UpdateCoordinator {
  private selected: SelectedUpdate | null = null
  private checkGeneration = 0
  private active?: { controller: AbortController; handoff: boolean }
  private closed = false
  constructor(private readonly options: CoordinatorOptions) {}

  async check(): Promise<SelectedUpdate | null> {
    return this.options.activity.operation(async () => {
      if (this.closed) throw busy()
      const generation = ++this.checkGeneration
      const result = await this.options.check()
      if (this.closed || generation !== this.checkGeneration) throw new Error('更新检查已被较新的请求取代，请查看当前结果')
      this.selected = result ? { ...structuredClone(result), selectionId: (this.options.selectionId ?? randomUUID)() } : null
      return structuredClone(this.selected)
    })
  }

  async install(selectionId: string): Promise<UpdateResult> {
    if (this.closed) throw busy()
    if (!this.selected || this.selected.selectionId !== selectionId) throw new Error('更新信息已变化，请重新检查并确认更新')
    // Clone before the first await. Later checks cannot change this version/action.
    const selected = structuredClone(this.selected)
    const release = this.options.activity.reserve(this.options.reserveCore)
    const active = { controller: new AbortController(), handoff: false }
    this.active = active
    try {
      if (!selected.asset || selected.action === 'page') {
        await this.options.openPage(selected.page)
        return 'opened-page'
      }
      const file = await this.options.download(selected, active.controller.signal)
      active.controller.signal.throwIfAborted()
      if (selected.action === 'installer') {
        // Wait for the child process spawn event; never quit on a rejected spawn.
        await this.options.startInstaller(file)
        active.handoff = true
        this.options.handoff('installer')
        return 'installing'
      }
      if (selected.action === 'appimage') {
        await this.options.replaceAppImage(file, selected, active.controller.signal)
        // A proved replacement wins late cancellation; don't call throwIfAborted here.
        active.handoff = true
        this.options.handoff('appimage')
        return 'restarting'
      }
      await this.options.openInstaller(file)
      return 'opened-installer'
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'RECOVERY_REQUIRED') active.handoff = true
      throw error
    } finally {
      if (!active.handoff) {
        if (this.active === active) this.active = undefined
        release()
      }
    }
  }

  cancel(): void {
    if (this.active && !this.active.handoff) this.active.controller.abort(new DOMException('更新下载已取消', 'AbortError'))
  }

  close(): void {
    this.closed = true
    this.checkGeneration++
    this.cancel()
    this.options.activity.close()
  }
}
