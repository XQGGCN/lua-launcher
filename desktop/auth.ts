import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Main-process module only. Never expose credentials(), tokens, or provider
// responses through IPC. The renderer receives PublicAccount and DeviceCode only.
//
// OAuth protocol:
// https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code
// Xbox token background:
// https://learn.microsoft.com/en-us/gaming/gdk/docs/services/fundamentals/s2s-auth-calls/service-authentication/live-xbox-live-authentication
// Minecraft endpoints are an integration boundary, not a documented entitlement
// to API access. The application's own registration must be accepted by upstream.

export interface PublicAccount {
  username: string
  uuid: string
  mode: 'microsoft'
}

export interface DeviceCode {
  userCode: string
  verificationUri: string
  /** Milliseconds since the Unix epoch. The private device_code is never sent. */
  expiresAt: number
}

/** Sensitive. For constructing a game process in the main process only. */
export interface MinecraftCredentials extends PublicAccount {
  accessToken: string
  clientId: string
  /** Optional Xbox ID supplied by XSTS. Kept in memory and never sent to the UI. */
  xuid?: string
}

export type AuthStage =
  | 'requesting-code' | 'waiting-authorization' | 'xbox' | 'minecraft'
  | 'checking-ownership' | 'saving' | 'complete'

export interface AuthStatus {
  stage: AuthStage
  message: string
}

export interface AuthOptions {
  /** Pass Electron safeStorage.encryptString; throw if secure storage is unavailable. */
  seal: (plaintext: string) => Buffer | Promise<Buffer>
  /** Pass Electron safeStorage.decryptString; never substitute plaintext storage. */
  unseal: (encrypted: Buffer) => string | Promise<string>
  onDeviceCode: (code: DeviceCode) => void | Promise<void>
  /** Informational only. Observer errors must never invalidate a saved login. */
  onStatus?: (status: AuthStatus) => void | Promise<void>
  /** Injectable transports and time make protocol tests independent of real accounts. */
  fetch?: typeof globalThis.fetch
  now?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  /** Atomic file replacement; injectable to test cancellation during commit. */
  replaceFile?: (source: string, destination: string) => Promise<void>
}

export type AuthErrorCode =
  | 'INVALID_CLIENT_ID'
  | 'CLIENT_CONFIGURATION'
  | 'AUTHORIZATION_DECLINED'
  | 'DEVICE_CODE_EXPIRED'
  | 'SESSION_EXPIRED'
  | 'NO_XBOX_PROFILE'
  | 'XBOX_ACCOUNT_RESTRICTED'
  | 'NO_MINECRAFT_OWNERSHIP'
  | 'MINECRAFT_PROFILE_MISSING'
  | 'SERVICE_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'STORAGE_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'CANCELLED'
  | 'BUSY'
  | 'UNKNOWN_AUTH_ERROR'

const messages: Record<AuthErrorCode, string> = {
  INVALID_CLIENT_ID: '请填写你自己的 Microsoft 应用客户端 ID（UUID），并启用个人账户与公共客户端登录。',
  CLIENT_CONFIGURATION: '此应用暂未获准完成登录。请检查 Microsoft 应用注册、公共客户端配置及 Minecraft API 接入权限。',
  AUTHORIZATION_DECLINED: '你拒绝了 Microsoft 授权。可以重新发起登录。',
  DEVICE_CODE_EXPIRED: '登录代码已过期，请重新发起登录。',
  SESSION_EXPIRED: 'Microsoft 登录已失效，请重新登录。',
  NO_XBOX_PROFILE: '此 Microsoft 账户尚未建立 Xbox 档案，请先在 Xbox 官网完成设置。',
  XBOX_ACCOUNT_RESTRICTED: 'Xbox 暂不允许此账户登录。请在 Xbox 官网检查年龄验证、家庭组与地区设置。',
  NO_MINECRAFT_OWNERSHIP: '此账户未返回有效的 Minecraft Java 版游戏许可，请检查购买或订阅状态。',
  MINECRAFT_PROFILE_MISSING: '此账户尚未设置 Minecraft Java 版档案，请先到 Minecraft 官网完成设置。',
  SERVICE_UNAVAILABLE: '登录服务暂时不可用，请稍后重试。',
  RATE_LIMITED: '登录请求过于频繁，请稍后重试。',
  NETWORK_ERROR: '无法连接登录服务，请检查网络后重试。',
  TIMEOUT: '登录服务响应超时，请稍后重试。',
  INVALID_RESPONSE: '登录服务返回了无法识别的数据，请稍后重试。',
  STORAGE_UNAVAILABLE: '无法安全读取或保存登录信息。请检查系统钥匙串或凭据存储后重试。',
  AUTH_REQUIRED: '请先登录 Microsoft 账户。',
  CANCELLED: '已取消登录。',
  BUSY: '登录正在进行，请完成或取消当前登录。',
  UNKNOWN_AUTH_ERROR: '登录未完成，请重试。',
}

/** Contains only a stable code and a locally authored message, never provider data. */
export class AuthError extends Error {
  readonly code: AuthErrorCode

  constructor(code: AuthErrorCode) {
    super(messages[code])
    this.name = 'AuthError'
    this.code = code
  }
}

/** Defense in depth for main-process diagnostics. Do not log raw HTTP payloads. */
export function redactAuthSecrets(text: string, secrets: readonly string[] = []): string {
  let safe = text
  for (const secret of secrets) {
    if (secret) {
      safe = safe.split(secret).join('[REDACTED]')
      safe = safe.split(encodeURIComponent(secret)).join('[REDACTED]')
    }
  }
  return safe
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bXBL3\.0\s+x=[^\s"']+/gi, 'XBL3.0 [REDACTED]')
    .replace(
      /(["']?(?:access_token|accessToken|refresh_token|refreshToken|device_code|identityToken|RpsTicket|client_secret|authorization|token)["']?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;&}\]]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
}

type JsonObject = Record<string, unknown>
type Stage = 'oauth' | 'refresh' | 'xbox' | 'xsts' | 'minecraft' | 'entitlements' | 'profile'

interface StoredSession {
  clientId: string
  refreshToken: string
  account: PublicAccount
}

interface AccessSession {
  accessToken: string
  expiresAt: number
  xuid?: string
}

interface Operation {
  controller: AbortController
  kind: 'login' | 'refresh'
  phase: 'preparing' | 'committing' | 'committed'
}

const MICROSOFT_BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
const SCOPES = 'XboxLive.signin offline_access'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REQUEST_TIMEOUT_MS = 30_000
const INVALIDATES_SESSION = new Set<AuthErrorCode>([
  'SESSION_EXPIRED', 'NO_MINECRAFT_OWNERSHIP', 'MINECRAFT_PROFILE_MISSING',
  'NO_XBOX_PROFILE', 'XBOX_ACCOUNT_RESTRICTED',
])
const statusMessages: Record<AuthStage, string> = {
  'requesting-code': '正在获取 Microsoft 登录代码…',
  'waiting-authorization': '请在 Microsoft 官方页面输入代码并完成授权。',
  xbox: '正在验证 Xbox 账户…',
  minecraft: '正在连接 Minecraft 登录服务…',
  'checking-ownership': '正在检查 Java 版许可与游戏档案…',
  saving: '正在安全保存登录信息…',
  complete: 'Microsoft 登录已完成。',
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthError('INVALID_RESPONSE')
  }
  return value as JsonObject
}

function token(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 32_768 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new AuthError('INVALID_RESPONSE')
  }
  return value
}

function seconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 172_800) {
    throw new AuthError('INVALID_RESPONSE')
  }
  return value
}

export function validateClientId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!UUID.test(id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id)) {
    throw new AuthError('INVALID_CLIENT_ID')
  }
  return id.toLowerCase()
}

function publicAccount(value: unknown): PublicAccount {
  const profile = object(value)
  if (
    typeof profile.username !== 'string' || !/^[a-zA-Z0-9_]{1,16}$/.test(profile.username) ||
    typeof profile.uuid !== 'string' || !/^[0-9a-f]{32}$/i.test(profile.uuid) ||
    profile.mode !== 'microsoft'
  ) throw new AuthError('INVALID_RESPONSE')
  // Always whitelist fields, including when reading a stored account.
  return { username: profile.username, uuid: profile.uuid.toLowerCase(), mode: 'microsoft' }
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AuthError('CANCELLED')
}

function failure(stage: Stage, status: number, data: JsonObject): AuthError {
  if (status === 429) return new AuthError('RATE_LIMITED')
  if (status >= 500) return new AuthError('SERVICE_UNAVAILABLE')
  if (stage === 'oauth' || stage === 'refresh') {
    switch (data.error) {
      case 'authorization_declined':
      case 'access_denied':
        return new AuthError('AUTHORIZATION_DECLINED')
      case 'expired_token':
      case 'expired_device_code':
      case 'bad_verification_code':
        return new AuthError('DEVICE_CODE_EXPIRED')
      case 'invalid_grant':
      case 'interaction_required':
      case 'consent_required':
        return new AuthError(stage === 'refresh' ? 'SESSION_EXPIRED' : 'DEVICE_CODE_EXPIRED')
      case 'invalid_client':
      case 'unauthorized_client':
      case 'invalid_scope':
      case 'invalid_request':
      case 'unsupported_grant_type':
        return new AuthError('CLIENT_CONFIGURATION')
      case 'server_error':
      case 'temporarily_unavailable':
        return new AuthError('SERVICE_UNAVAILABLE')
    }
  }
  if (stage === 'xsts' || stage === 'xbox') {
    if (Number(data.XErr) === 2148916233) return new AuthError('NO_XBOX_PROFILE')
    if ([2148916227, 2148916235, 2148916236, 2148916237, 2148916238].includes(Number(data.XErr))) {
      return new AuthError('XBOX_ACCOUNT_RESTRICTED')
    }
  }
  if (stage === 'profile' && status === 404) return new AuthError('MINECRAFT_PROFILE_MISSING')
  if (stage === 'minecraft' && status === 403) return new AuthError('CLIENT_CONFIGURATION')
  if (status === 401) return new AuthError('SESSION_EXPIRED')
  if (status === 403) return new AuthError('CLIENT_CONFIGURATION')
  return new AuthError('UNKNOWN_AUTH_ERROR')
}

function sanitizedError(error: unknown, signal?: AbortSignal): AuthError {
  if (signal?.aborted) return new AuthError('CANCELLED')
  return error instanceof AuthError ? error : new AuthError('UNKNOWN_AUTH_ERROR')
}

export class AuthManager {
  readonly #rootDir: string
  readonly #file: string
  readonly #options: AuthOptions
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly #replaceFile: (source: string, destination: string) => Promise<void>
  #session: StoredSession | null = null
  #access: AccessSession | null = null
  #loaded = false
  #loadGeneration = 0
  #loading: Promise<void> | null = null
  #active: Operation | null = null
  #refreshing: Promise<MinecraftCredentials> | null = null
  #storageQueue: Promise<void> = Promise.resolve()

  constructor(rootDir: string, options: AuthOptions) {
    this.#rootDir = rootDir
    this.#file = join(rootDir, 'microsoft-session.json')
    this.#options = options
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }) })
    this.#replaceFile = options.replaceFile ?? rename
  }

  async account(): Promise<PublicAccount | null> {
    await this.#load()
    return this.#session ? publicAccount(this.#session.account) : null
  }

  /** Changes synchronously when credentials are revoked, before secure-store deletion. */
  get sessionGeneration(): number { return this.#loadGeneration }

  async begin(clientId: string): Promise<PublicAccount> {
    const validClientId = validateClientId(clientId)
    const operation = this.#start('login')
    const signal = operation.controller.signal
    try {
      await this.#load()
      checkCancelled(signal)
      this.#notify('requesting-code', signal)
      const { status, data } = await this.#postForm(`${MICROSOFT_BASE}/devicecode`, {
        client_id: validClientId, scope: SCOPES,
      }, signal)
      if (status !== 200) throw failure('oauth', status, data)

      const deviceCode = token(data.device_code)
      const expiresAt = this.#now() + seconds(data.expires_in) * 1000
      let interval = typeof data.interval === 'number' ? Math.max(1, seconds(data.interval)) * 1000 : 5000
      if (typeof data.user_code !== 'string' || !/^[a-zA-Z0-9-]{4,64}$/.test(data.user_code)) {
        throw new AuthError('INVALID_RESPONSE')
      }
      const uri = new URL(typeof data.verification_uri === 'string' ? data.verification_uri : '')
      if (
        uri.protocol !== 'https:' || uri.username || uri.password || uri.search || uri.hash ||
        !['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com', 'login.live.com'].includes(uri.hostname)
      ) throw new AuthError('INVALID_RESPONSE')
      await this.#options.onDeviceCode({
        userCode: data.user_code, verificationUri: uri.href, expiresAt,
      })
      this.#notify('waiting-authorization', signal)

      let oauth: JsonObject | undefined
      while (this.#now() < expiresAt) {
        checkCancelled(signal)
        await this.#sleep(Math.min(interval, expiresAt - this.#now()), signal)
        checkCancelled(signal)
        if (this.#now() >= expiresAt) break
        const response = await this.#postForm(`${MICROSOFT_BASE}/token`, {
          client_id: validClientId,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
        }, signal)
        if (response.status === 200) {
          oauth = response.data
          break
        }
        if (response.data.error === 'authorization_pending') continue
        if (response.data.error === 'slow_down') { interval += 5000; continue }
        throw failure('oauth', response.status, response.data)
      }
      if (!oauth) throw new AuthError('DEVICE_CODE_EXPIRED')
      const refreshToken = token(oauth.refresh_token)
      const result = await this.#minecraft(token(oauth.access_token), signal)
      const session = { clientId: validClientId, refreshToken, account: result.account }
      await this.#save(session, result.access, operation)
      checkCancelled(signal)
      this.#notify('complete', signal)
      return publicAccount(result.account)
    } catch (error) {
      throw sanitizedError(error, signal)
    } finally {
      if (this.#active === operation) this.#active = null
    }
  }

  /** Never attach this method to IPC; call it immediately before spawning Java. */
  async credentials(): Promise<MinecraftCredentials> {
    await this.#load()
    if (this.#active?.kind === 'login') throw new AuthError('BUSY')
    if (this.#active?.kind === 'refresh' && this.#refreshing) return this.#refreshing
    const session = this.#session
    if (!session) throw new AuthError('AUTH_REQUIRED')
    if (this.#access && this.#access.expiresAt > this.#now() + 60_000) {
      return this.#credentials(session, this.#access)
    }
    const operation = this.#start('refresh')
    const work = this.#refresh(session, operation)
    this.#refreshing = work
    try {
      return await work
    } finally {
      if (this.#refreshing === work) this.#refreshing = null
      if (this.#active === operation) this.#active = null
    }
  }

  /** Cancels preparation. Once atomic replacement starts, the operation completes. */
  cancel(): void {
    if (this.#active?.phase === 'preparing') {
      this.#active.controller.abort()
      this.#active = null
    }
  }

  async logout(): Promise<void> {
    // Logout supersedes even a commit already in progress. Its queued deletion
    // runs after that commit, and the aborted operation cannot republish state.
    this.#active?.controller.abort()
    this.#active = null
    this.#loadGeneration += 1
    this.#loaded = true
    this.#session = null
    this.#access = null
    try {
      await this.#queueStorage(async () => { await rm(this.#file, { force: true }) })
    } catch {
      throw new AuthError('STORAGE_UNAVAILABLE')
    }
  }

  #start(kind: Operation['kind']): Operation {
    this.cancel()
    if (this.#active) throw new AuthError('BUSY')
    const operation: Operation = { controller: new AbortController(), kind, phase: 'preparing' }
    this.#active = operation
    return operation
  }

  async #refresh(session: StoredSession, operation: Operation): Promise<MinecraftCredentials> {
    const signal = operation.controller.signal
    try {
      const { status, data } = await this.#postForm(`${MICROSOFT_BASE}/token`, {
        client_id: session.clientId,
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        scope: SCOPES,
      }, signal)
      if (status !== 200) throw failure('refresh', status, data)
      const refreshToken = data.refresh_token === undefined ? session.refreshToken : token(data.refresh_token)
      const result = await this.#minecraft(token(data.access_token), signal)
      if (result.account.uuid !== session.account.uuid) throw new AuthError('INVALID_RESPONSE')
      const nextSession = { clientId: session.clientId, refreshToken, account: result.account }
      await this.#save(nextSession, result.access, operation)
      checkCancelled(signal)
      this.#notify('complete', signal)
      return this.#credentials(nextSession, result.access)
    } catch (error) {
      const failure = sanitizedError(error, signal)
      if (INVALIDATES_SESSION.has(failure.code) && this.#session === session && this.#active === operation) {
        // Retain the original server error: logout aborts this operation while synchronously
        // clearing both access and session state, then durably removes the encrypted record.
        await this.logout()
      }
      throw failure
    }
  }

  async #minecraft(microsoftToken: string, signal: AbortSignal): Promise<{ account: PublicAccount, access: AccessSession }> {
    this.#notify('xbox', signal)
    const xbox = await this.#postJson('https://user.auth.xboxlive.com/user/authenticate', {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${microsoftToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }, 'xbox', signal)
    const xsts = await this.#postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [token(xbox.Token)] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    }, 'xsts', signal)
    const claims = object(xsts.DisplayClaims)
    if (!Array.isArray(claims.xui) || claims.xui.length === 0) throw new AuthError('INVALID_RESPONSE')
    const identity = object(claims.xui[0])
    const hash = token(identity.uhs)
    // Relying parties do not all return xid. Do not substitute the unrelated
    // user hash, invent an ID, or decode an access token as proof of identity.
    const xuid = typeof identity.xid === 'string' && /^[1-9][0-9]{0,19}$/.test(identity.xid)
      ? identity.xid : undefined
    this.#notify('minecraft', signal)
    const minecraft = await this.#postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
      identityToken: `XBL3.0 x=${hash};${token(xsts.Token)}`,
    }, 'minecraft', signal)
    const accessToken = token(minecraft.access_token)
    const expiresAt = this.#now() + seconds(minecraft.expires_in) * 1000
    this.#notify('checking-ownership', signal)
    const entitlements = await this.#getAuthorized(
      'https://api.minecraftservices.com/entitlements/mcstore', accessToken, 'entitlements', signal,
    )
    if (!Array.isArray(entitlements.items)) throw new AuthError('INVALID_RESPONSE')
    const ownsJava = entitlements.items.some(item =>
      item !== null && typeof item === 'object' &&
      ['game_minecraft', 'product_minecraft'].includes(String((item as JsonObject).name)),
    )
    if (!ownsJava) throw new AuthError('NO_MINECRAFT_OWNERSHIP')
    const profile = await this.#getAuthorized(
      'https://api.minecraftservices.com/minecraft/profile', accessToken, 'profile', signal,
    )
    const account = publicAccount({ username: profile.name, uuid: profile.id, mode: 'microsoft' })
    checkCancelled(signal)
    return { account, access: { accessToken, expiresAt, ...(xuid ? { xuid } : {}) } }
  }

  #credentials(session: StoredSession, access: AccessSession): MinecraftCredentials {
    return {
      ...publicAccount(session.account), accessToken: access.accessToken,
      clientId: session.clientId, ...(access.xuid ? { xuid: access.xuid } : {}),
    }
  }

  #notify(stage: AuthStage, signal: AbortSignal): void {
    checkCancelled(signal)
    try {
      // Events contain only locally authored strings. Delivery is best effort;
      // a closed renderer must not turn a committed login into a false failure.
      const result = this.#options.onStatus?.({ stage, message: statusMessages[stage] })
      if (result) void Promise.resolve(result).catch(() => {})
    } catch {
      // An observer is not part of the authentication or storage transaction.
    }
  }

  async #postForm(url: string, values: Record<string, string>, signal: AbortSignal) {
    return this.#request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(values).toString(),
    }, signal)
  }

  async #postJson(url: string, value: JsonObject, stage: Stage, signal: AbortSignal) {
    const { status, data } = await this.#request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(value),
    }, signal)
    if (status !== 200) throw failure(stage, status, data)
    return data
  }

  async #getAuthorized(url: string, accessToken: string, stage: Stage, signal: AbortSignal) {
    const { status, data } = await this.#request(url, {
      method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }, signal)
    if (status !== 200) throw failure(stage, status, data)
    return data
  }

  async #request(url: string, init: RequestInit, signal: AbortSignal): Promise<{ status: number, data: JsonObject }> {
    checkCancelled(signal)
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    try {
      // Prevent credentials in a POST body or Authorization header following redirects.
      const response = await this.#fetch(url, {
        ...init, redirect: 'error', signal: AbortSignal.any([signal, timeout]),
      })
      checkCancelled(signal)
      let data: JsonObject
      try {
        data = object(await response.json())
      } catch {
        if (response.ok) throw new AuthError('INVALID_RESPONSE')
        data = {}
      }
      checkCancelled(signal)
      return { status: response.status, data }
    } catch (error) {
      if (signal.aborted) throw new AuthError('CANCELLED')
      if (timeout.aborted) throw new AuthError('TIMEOUT')
      if (error instanceof AuthError) throw error
      // Fetch errors can embed request details: never return their message/cause.
      throw new AuthError('NETWORK_ERROR')
    }
  }

  async #load(): Promise<void> {
    if (this.#loaded) return
    if (this.#loading) return this.#loading
    const generation = this.#loadGeneration
    const work = (async () => {
      try {
        let raw: string
        try {
          raw = await readFile(this.#file, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            if (generation === this.#loadGeneration) this.#loaded = true
            return
          }
          throw error
        }
        if (raw.length > 131_072) throw new Error('oversized')
        const envelope = object(JSON.parse(raw))
        if (
          envelope.version !== 1 || typeof envelope.encrypted !== 'string' ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.encrypted)
        ) throw new Error('invalid envelope')
        const encrypted = Buffer.from(envelope.encrypted, 'base64')
        const plaintext = await this.#options.unseal(encrypted)
        const stored = object(JSON.parse(plaintext))
        const session: StoredSession = {
          clientId: validateClientId(typeof stored.clientId === 'string' ? stored.clientId : ''),
          refreshToken: token(stored.refreshToken),
          account: publicAccount(stored.account),
        }
        if (generation === this.#loadGeneration) {
          this.#session = session
          this.#loaded = true
        }
      } catch {
        if (generation === this.#loadGeneration) throw new AuthError('STORAGE_UNAVAILABLE')
      }
    })()
    this.#loading = work
    try {
      await work
    } finally {
      if (this.#loading === work) this.#loading = null
    }
  }

  #queueStorage(work: () => Promise<void>): Promise<void> {
    const next = this.#storageQueue.then(work)
    this.#storageQueue = next.catch(() => {})
    return next
  }

  async #save(session: StoredSession, access: AccessSession, operation: Operation): Promise<void> {
    const signal = operation.controller.signal
    try {
      this.#notify('saving', signal)
      checkCancelled(signal)
      const encrypted = await this.#options.seal(JSON.stringify(session))
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('invalid encryption')
      checkCancelled(signal)
      await this.#queueStorage(async () => {
        const temporary = `${this.#file}.${randomUUID()}.tmp`
        let replaced = false
        try {
          checkCancelled(signal)
          await mkdir(this.#rootDir, { recursive: true, mode: 0o700 })
          await writeFile(temporary, JSON.stringify({
            version: 1, encrypted: encrypted.toString('base64'),
          }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
          checkCancelled(signal)
          // This is the cancellation boundary: rename cannot be safely aborted.
          // Ordinary cancel must not report failure after credentials are saved.
          operation.phase = 'committing'
          await this.#replaceFile(temporary, this.#file)
          replaced = true
          operation.phase = 'committed'
          checkCancelled(signal) // Only logout can abort after commit has started.
          this.#session = session
          this.#access = access
        } finally {
          if (!replaced) await rm(temporary, { force: true }).catch(() => {})
        }
      })
    } catch (error) {
      if (signal.aborted) throw new AuthError('CANCELLED')
      if (error instanceof AuthError) throw error
      throw new AuthError('STORAGE_UNAVAILABLE')
    }
  }
}
