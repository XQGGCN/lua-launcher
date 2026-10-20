import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountCoordinator } from './accounts'
import { AuthError, type AuthErrorCode, type AuthManager, type PublicAccount } from './auth'

const MICROSOFT: PublicAccount = { username: 'OnlinePlayer', uuid: 'a'.repeat(32), mode: 'microsoft' }
const CONFIG = { configured: true, clientId: '11111111-2222-4333-8444-555555555555' }
const CREDENTIALS = { ...MICROSOFT, clientId: CONFIG.clientId, accessToken: 'fictitious-access-token' }

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function fixture(initial: PublicAccount | null = null) {
  let remote = initial
  let generation = 0
  let calls = 0
  const events: Array<PublicAccount | null> = []
  const auth: Pick<AuthManager, 'begin' | 'cancel' | 'logout' | 'account' | 'credentials' | 'sessionGeneration'> = {
    get sessionGeneration() { return generation },
    begin: async () => { calls++; remote = MICROSOFT; return MICROSOFT },
    cancel: () => {},
    logout: async () => { remote = null; generation++ },
    account: async () => remote,
    credentials: async () => {
      if (!remote) throw new AuthError('AUTH_REQUIRED')
      return CREDENTIALS
    },
  }
  const options = {
    config: async () => CONFIG,
    onAccount: (account: PublicAccount | null) => { events.push(account) },
  }
  return { auth, options, events, get calls() { return calls }, get remote() { return remote } }
}

for (const action of ['cancel', 'logout'] as const) {
  test(`${action} during config loading prevents a later begin`, async () => {
    const config = deferred<typeof CONFIG>()
    const f = fixture()
    const accounts = new AccountCoordinator(f.auth, { ...f.options, config: () => config.promise })
    const login = accounts.login()
    const rejected = assert.rejects(login, { code: 'CANCELLED' })
    assert.equal(accounts.loginPending, true)
    if (action === 'cancel') accounts.cancelLogin()
    else await accounts.logout()
    assert.equal(accounts.acceptsAuthEvents, false)
    config.resolve(CONFIG)
    await rejected
    assert.equal(f.calls, 0)
    assert.equal(await accounts.account(), null)
    assert.equal(accounts.loginPending, false)
    assert.equal(accounts.acceptsAuthEvents, true)
  })
}

test('only one login passes config preflight, and a failed preflight releases the guard', async () => {
  const config = deferred<typeof CONFIG>()
  const f = fixture()
  let nextConfig = config.promise
  const accounts = new AccountCoordinator(f.auth, { ...f.options, config: () => nextConfig })
  const first = accounts.login()
  const rejected = assert.rejects(first, /尚未配置/)
  await assert.rejects(accounts.login(), { code: 'BUSY' })
  config.resolve({ configured: false, clientId: '' })
  await rejected
  assert.equal(f.calls, 0)
  assert.equal(accounts.loginPending, false)
  nextConfig = Promise.resolve(CONFIG)
  assert.deepEqual(await accounts.login(), MICROSOFT)
  assert.equal(f.calls, 1)
})

test('successful login exposes the public Microsoft profile, keeping credentials in the separate method', async () => {
  const f = fixture()
  const accounts = new AccountCoordinator(f.auth, f.options)
  await assert.rejects(accounts.credentials(), { code: 'AUTH_REQUIRED' })
  assert.deepEqual(await accounts.login(), MICROSOFT)
  assert.deepEqual(await accounts.account(), MICROSOFT)
  assert.deepEqual(await accounts.credentials(), CREDENTIALS)
  assert.deepEqual(f.events, [null, MICROSOFT])
  assert.ok(!JSON.stringify(f.events).includes(CREDENTIALS.accessToken))
})

test('login preflight with a saved account blocks old credentials until the new login finishes', async () => {
  const config = deferred<typeof CONFIG>()
  const f = fixture(MICROSOFT)
  const replacement: PublicAccount = { username: 'NewPlayer', uuid: 'b'.repeat(32), mode: 'microsoft' }
  const replacementCredentials = { ...CREDENTIALS, ...replacement, accessToken: 'fictitious-replacement-token' }
  let credentialCalls = 0
  let authenticated = false
  f.auth.begin = async () => { authenticated = true; return replacement }
  f.auth.credentials = async () => {
    credentialCalls++
    return authenticated ? replacementCredentials : CREDENTIALS
  }
  const accounts = new AccountCoordinator(f.auth, { ...f.options, config: () => config.promise })
  const login = accounts.login()
  await assert.rejects(accounts.credentials(), { code: 'BUSY' })
  assert.equal(credentialCalls, 0, 'config preflight must not request the previous account token')
  config.resolve(CONFIG)
  assert.deepEqual(await login, replacement)
  assert.deepEqual(await accounts.credentials(), replacementCredentials)
  assert.equal(credentialCalls, 1)
})

test('logout after begin starts prevents its late completion from announcing a stale account', async () => {
  const started = deferred()
  const release = deferred()
  const f = fixture()
  const begin = f.auth.begin
  f.auth.begin = async clientId => { await begin(clientId); started.resolve(); await release.promise; return MICROSOFT }
  const accounts = new AccountCoordinator(f.auth, f.options)
  const pending = accounts.login()
  const rejected = assert.rejects(pending, { code: 'CANCELLED' })
  await started.promise
  await accounts.logout()
  release.resolve()
  await rejected
  assert.equal(await accounts.account(), null)
  assert.deepEqual(f.events, [null])
})

test('a slow previous logout cannot announce null after a newer successful login', async () => {
  const release = deferred()
  const f = fixture(MICROSOFT)
  const logout = f.auth.logout
  f.auth.logout = async () => { await logout(); await release.promise }
  const accounts = new AccountCoordinator(f.auth, f.options)
  const pending = accounts.logout()
  assert.deepEqual(await accounts.login(), MICROSOFT)
  release.resolve()
  await pending
  assert.deepEqual(await accounts.account(), MICROSOFT)
  assert.deepEqual(f.events, [MICROSOFT])
})

test('cancel after authentication commits preserves the successful login', async () => {
  const committed = deferred()
  const release = deferred()
  const f = fixture()
  const begin = f.auth.begin
  f.auth.begin = async clientId => {
    const account = await begin(clientId)
    committed.resolve()
    await release.promise
    return account
  }
  const accounts = new AccountCoordinator(f.auth, f.options)
  const login = accounts.login()
  await committed.promise
  accounts.cancelLogin()
  release.resolve()
  assert.deepEqual(await login, MICROSOFT)
  assert.deepEqual(await accounts.account(), MICROSOFT)
  assert.deepEqual(f.events, [MICROSOFT])
})

test('credentials resolved after logout cannot reach the game launch', async () => {
  const requested = deferred()
  const release = deferred()
  const f = fixture(MICROSOFT)
  f.auth.credentials = async () => { requested.resolve(); await release.promise; return CREDENTIALS }
  const accounts = new AccountCoordinator(f.auth, f.options)
  const pending = accounts.credentials()
  const rejected = assert.rejects(pending, { code: 'CANCELLED' })
  await requested.promise
  await accounts.logout()
  release.resolve()
  await rejected
  assert.deepEqual(f.events, [null])
})

test('an account read crossing logout retries instead of returning its old profile', async () => {
  const requested = deferred()
  const release = deferred()
  const f = fixture(MICROSOFT)
  const account = f.auth.account
  let first = true
  f.auth.account = async () => {
    const result = await account()
    if (first) { first = false; requested.resolve(); await release.promise }
    return result
  }
  const accounts = new AccountCoordinator(f.auth, f.options)
  const pending = accounts.account()
  await requested.promise
  await accounts.logout()
  release.resolve()
  assert.equal(await pending, null)
})

for (const code of ['SESSION_EXPIRED', 'NO_MINECRAFT_OWNERSHIP', 'MINECRAFT_PROFILE_MISSING'] as const) {
  test(`${code} clears the displayed account and immediately invalidates pending launch guards`, async () => {
    const revoked = deferred()
    const release = deferred()
    const f = fixture(MICROSOFT)
    f.auth.credentials = async () => { await f.auth.logout(); revoked.resolve(); await release.promise; throw new AuthError(code) }
    const accounts = new AccountCoordinator(f.auth, f.options)
    const generation = accounts.generation
    const pending = accounts.credentials()
    const rejected = assert.rejects(pending, { code })
    await revoked.promise
    assert.notEqual(accounts.generation, generation, 'revocation invalidates before deletion/error delivery finishes')
    assert.equal(await accounts.account(), null)
    release.resolve()
    await rejected
    assert.deepEqual(f.events, [null])
  })
}

for (const code of ['NETWORK_ERROR', 'CLIENT_CONFIGURATION'] satisfies AuthErrorCode[]) {
  test(`${code} propagates without deleting the saved account or manufacturing launch credentials`, async () => {
    const f = fixture(MICROSOFT)
    f.auth.credentials = async () => { throw new AuthError(code) }
    const accounts = new AccountCoordinator(f.auth, f.options)
    const generation = accounts.generation
    await assert.rejects(accounts.credentials(), { code })
    assert.deepEqual(await accounts.account(), MICROSOFT)
    assert.equal(accounts.generation, generation)
    assert.deepEqual(f.events, [])
  })
}

test('a late failed refresh cannot clear a newer login from the UI', async () => {
  const failed = deferred()
  const release = deferred()
  const f = fixture(MICROSOFT)
  f.auth.credentials = async () => { failed.resolve(); await release.promise; throw new AuthError('SESSION_EXPIRED') }
  const accounts = new AccountCoordinator(f.auth, f.options)
  const pending = accounts.credentials()
  const rejected = assert.rejects(pending, { code: 'CANCELLED' })
  await failed.promise
  await accounts.login()
  release.resolve()
  await rejected
  assert.deepEqual(f.events, [MICROSOFT])
})

test('observer failure cannot invalidate authenticated login or logout', async () => {
  const f = fixture()
  const accounts = new AccountCoordinator(f.auth, { ...f.options, onAccount: () => { throw new Error('window closed') } })
  assert.deepEqual(await accounts.login(), MICROSOFT)
  assert.deepEqual(await accounts.account(), MICROSOFT)
  await accounts.logout()
  assert.equal(await accounts.account(), null)
})

test('logout publishes cleared memory even if deleting the secure session fails', async () => {
  const f = fixture(MICROSOFT)
  const logout = f.auth.logout
  f.auth.logout = async () => { await logout(); throw new AuthError('STORAGE_UNAVAILABLE') }
  const accounts = new AccountCoordinator(f.auth, f.options)
  await assert.rejects(accounts.logout(), { code: 'STORAGE_UNAVAILABLE' })
  assert.equal(await accounts.account(), null)
  await assert.rejects(accounts.credentials(), { code: 'AUTH_REQUIRED' })
  assert.deepEqual(f.events, [null, null])
})
