import { AuthError, type AuthManager, type MinecraftCredentials, type PublicAccount } from './auth'

type AuthBackend = Pick<AuthManager, 'begin' | 'cancel' | 'logout' | 'account' | 'credentials' | 'sessionGeneration'>
interface AccountOptions {
  config: () => Promise<{ configured: boolean; clientId: string }>
  onAccount?: (account: PublicAccount | null) => void
}
interface LoginAttempt {
  generation: number
  started: boolean
  cancelled: boolean
}

/** Main-process coordinator for the single, Microsoft-authenticated account. */
export class AccountCoordinator {
  #generation = 0
  #login: LoginAttempt | null = null

  constructor(private readonly auth: AuthBackend, private readonly options: AccountOptions) {}

  get loginPending(): boolean { return this.#login !== null }
  /** Also changes during server-side revocation, before pending storage deletion completes. */
  get generation(): number { return this.#generation + this.auth.sessionGeneration }
  get acceptsAuthEvents(): boolean {
    return !this.#login || (!this.#login.cancelled && this.#login.generation === this.#generation)
  }

  async account(): Promise<PublicAccount | null> {
    for (;;) {
      const generation = this.generation
      const result = await this.auth.account()
      if (generation === this.generation) return result
    }
  }

  /** The result stays in the main process; never expose it through IPC. */
  async credentials(): Promise<MinecraftCredentials> {
    // Preflight has already reserved the next account generation, but begin()
    // may not have started yet. Do not hand out the previous account's token.
    if (this.#login) throw new AuthError('BUSY')
    const mutation = this.#generation
    const generation = this.generation
    try {
      const result = await this.auth.credentials()
      if (generation !== this.generation) throw new AuthError('CANCELLED')
      return result
    } catch (error) {
      // A superseded request cannot announce failure for a newly selected session.
      if (mutation !== this.#generation) throw new AuthError('CANCELLED')
      let current: PublicAccount | null | undefined
      try { current = await this.auth.account() } catch { /* Preserve the credential error. */ }
      if (mutation !== this.#generation) throw new AuthError('CANCELLED')
      if (current === null) this.#notify(null)
      throw error
    }
  }

  async login(): Promise<PublicAccount> {
    if (this.#login) throw new AuthError('BUSY')
    const attempt: LoginAttempt = { generation: ++this.#generation, started: false, cancelled: false }
    this.#login = attempt
    try {
      const config = await this.options.config()
      this.#check(attempt)
      if (!config.configured) throw new Error('尚未配置 Lua 的 Microsoft 应用，请先按接入说明配置客户端 ID')
      // No await between the guard and begin: cancellation can see the actual
      // AuthManager operation instead of cancelling one that has not started.
      attempt.started = true
      const result = await this.auth.begin(config.clientId)
      this.#check(attempt)
      this.#notify(result)
      return result
    } finally {
      if (this.#login === attempt) this.#login = null
    }
  }

  cancelLogin(): void {
    if (this.#login && !this.#login.started) this.#login.cancelled = true
    // After atomic commit, AuthManager lets an ordinary cancel finish successfully.
    this.auth.cancel()
  }

  async logout(): Promise<void> {
    const generation = ++this.#generation
    this.cancelLogin()
    try { await this.auth.logout() }
    finally {
      // Logout clears in-memory credentials even if secure-store deletion fails.
      if (generation === this.#generation) this.#notify(null)
    }
  }

  #check(attempt: LoginAttempt): void {
    if (attempt.cancelled || attempt.generation !== this.#generation) throw new AuthError('CANCELLED')
  }

  #notify(account: PublicAccount | null): void {
    try { this.options.onAccount?.(account) } catch { /* UI delivery cannot invalidate authentication. */ }
  }
}
