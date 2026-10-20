import { AuthError, type AuthManager, type MinecraftCredentials, type PublicAccount as MicrosoftAccount } from './auth'

export interface OfflineAccount {
  username: string
  uuid: string
  mode: 'offline'
}
export type SelectedAccount = OfflineAccount | MicrosoftAccount

type AuthBackend = Pick<AuthManager, 'begin' | 'cancel' | 'logout' | 'account' | 'credentials'>
interface AccountOptions {
  initialOffline?: OfflineAccount | null
  config: () => Promise<{ configured: boolean; clientId: string }>
  /** Persist the selection before publishing it; null removes the offline override. */
  persistOffline: (account: OfflineAccount | null) => Promise<void>
  onAccount?: (account: SelectedAccount | null) => void
}
interface LoginAttempt {
  generation: number
  started: boolean
  cancelled: boolean
}

/** Main-process coordinator. Network login never holds the short selection queue. */
export class AccountCoordinator {
  #offline: OfflineAccount | null
  #generation = 0
  #login: LoginAttempt | null = null
  #selectionQueue: Promise<void> = Promise.resolve()

  constructor(private readonly auth: AuthBackend, private readonly options: AccountOptions) {
    this.#offline = options.initialOffline ?? null
  }

  get loginPending(): boolean { return this.#login !== null }
  get generation(): number { return this.#generation }
  get acceptsAuthEvents(): boolean {
    return !this.#login || (!this.#login.cancelled && this.#login.generation === this.#generation)
  }

  async account(): Promise<SelectedAccount | null> {
    for (;;) {
      const generation = this.#generation
      await this.#selectionQueue
      const result = this.#offline ?? await this.auth.account()
      if (generation === this.#generation) return result
    }
  }

  /** The result stays in the main process; never expose it through IPC. */
  async credentials(): Promise<MinecraftCredentials | (OfflineAccount & { accessToken: string })> {
    const generation = this.#generation
    await this.#selectionQueue
    const result = this.#offline
      ? { ...this.#offline, accessToken: '0' }
      : await this.auth.credentials()
    if (generation !== this.#generation) throw new AuthError('CANCELLED')
    return result
  }

  async login(): Promise<MicrosoftAccount> {
    if (this.#login) throw new AuthError('BUSY')
    const attempt: LoginAttempt = { generation: ++this.#generation, started: false, cancelled: false }
    this.#login = attempt
    try {
      const config = await this.options.config()
      this.#check(attempt)
      if (!config.configured) throw new Error('尚未配置 Lua 的 Microsoft 应用，请先按接入说明配置客户端 ID')
      // No await between the guard and begin: cancel/logout can now see the
      // AuthManager operation, rather than cancelling a login that does not exist.
      attempt.started = true
      const result = await this.auth.begin(config.clientId)
      this.#check(attempt)
      await this.#select(attempt.generation, null)
      this.#check(attempt)
      return result
    } finally {
      if (this.#login === attempt) this.#login = null
    }
  }

  cancelLogin(): void {
    if (this.#login && !this.#login.started) this.#login.cancelled = true
    // Once AuthManager commits, ordinary cancel must still allow success.
    this.auth.cancel()
  }

  async setOffline(account: OfflineAccount): Promise<OfflineAccount> {
    const generation = ++this.#generation
    this.cancelLogin()
    await this.#select(generation, account)
    if (generation !== this.#generation) throw new AuthError('CANCELLED')
    return account
  }

  async logout(): Promise<void> {
    const generation = ++this.#generation
    this.cancelLogin()
    // Abort/revoke immediately. A slow secure-store deletion must not hold up a
    // newer offline selection; the generation guard rejects this later deletion.
    await this.auth.logout()
    await this.#select(generation, null)
  }

  #check(attempt: LoginAttempt): void {
    if (attempt.cancelled || attempt.generation !== this.#generation) throw new AuthError('CANCELLED')
  }

  async #select(generation: number, next: OfflineAccount | null): Promise<void> {
    const work = this.#selectionQueue.then(async () => {
      if (generation !== this.#generation) return
      await this.options.persistOffline(next)
      // A newer mutation cannot commit ahead of this one. Keep memory aligned
      // with the last successful disk write even if a later request now exists.
      this.#offline = next
    })
    this.#selectionQueue = work.catch(() => {})
    await work
    if (generation !== this.#generation) return
    const current = await this.account()
    if (generation !== this.#generation) return
    try { this.options.onAccount?.(current) } catch { /* UI delivery is not a storage transaction. */ }
  }
}
