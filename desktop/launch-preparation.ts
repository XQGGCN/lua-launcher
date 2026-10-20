/** Reserve a launch before credential refresh, which can finish much later. */
export class LaunchPreparations {
  private active = new Map<string, AbortController>()
  private closed = false

  async run<T>(id: string, prepare: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('启动器正在退出，无法准备新的游戏')
    if (this.active.has(id)) throw new Error('该实例正在准备启动')
    const controller = new AbortController()
    this.active.set(id, controller)
    try { return await prepare(controller.signal) }
    finally { if (this.active.get(id) === controller) this.active.delete(id) }
  }

  cancel(id: string): void {
    this.active.get(id)?.abort(new DOMException('启动准备已取消', 'AbortError'))
  }

  has(id: string): boolean { return this.active.has(id) }

  close(): void {
    this.closed = true
    for (const controller of this.active.values()) {
      controller.abort(new DOMException('启动器正在退出', 'AbortError'))
    }
  }
}
