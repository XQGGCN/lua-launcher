import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountCoordinator, type OfflineAccount, type SelectedAccount } from './accounts'
import { AuthError, type AuthManager, type PublicAccount } from './auth'

const MICROSOFT: PublicAccount = { username: 'OnlinePlayer', uuid: 'a'.repeat(32), mode: 'microsoft' }
const OFFLINE: OfflineAccount = { username: 'LocalPlayer', uuid: 'b'.repeat(32), mode: 'offline' }
const PREVIOUS: OfflineAccount = { username: 'Previous', uuid: 'c'.repeat(32), mode: 'offline' }
const CONFIG = { configured: true, clientId: '11111111-2222-4333-8444-555555555555' }
const CREDENTIALS = { ...MICROSOFT, clientId: CONFIG.clientId, accessToken: 'fictitious-access-token' }

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function fixture(initial: OfflineAccount | null = null) {
  let remote: PublicAccount | null = null
  let disk = initial
  let calls = 0
  const events: Array<SelectedAccount | null> = []
  const writes: Array<OfflineAccount | null> = []
  const auth: Pick<AuthManager, 'begin' | 'cancel' | 'logout' | 'account' | 'credentials'> = {
    begin: async () => { calls++; remote = MICROSOFT; return MICROSOFT },
    cancel: () => {},
    logout: async () => { remote = null },
    account: async () => remote,
    credentials: async () => {
      if (!remote) throw new AuthError('AUTH_REQUIRED')
      return CREDENTIALS
    },
  }
  const options = {
    initialOffline: initial,
    config: async () => CONFIG,
    persistOffline: async (account: OfflineAccount | null) => { disk = account; writes.push(account) },
    onAccount: (account: SelectedAccount | null) => { events.push(account) },
  }
  return {
    auth, options, events, writes,
    get calls() { return calls },
    get disk() { return disk },
    get remote() { return remote },
  }
}

for (const action of ['cancel', 'logout', 'offline'] as const) {
  test(`${action} during config loading prevents a later begin and persisted Microsoft login`, async () => {
    const config = deferred<typeof CONFIG>()
    const f = fixture()
    const accounts = new AccountCoordinator(f.auth, { ...f.options, config: () => config.promise })
    const login = accounts.login()
    const rejected = assert.rejects(login, { code: 'CANCELLED' })
    assert.equal(accounts.loginPending, true)
    if (action === 'cancel') accounts.cancelLogin()
    if (action === 'logout') await accounts.logout()
    if (action === 'offline') await accounts.setOffline(OFFLINE)
    config.resolve(CONFIG)
    await rejected
    assert.equal(f.calls, 0)
    assert.equal(f.remote, null)
    assert.deepEqual(await accounts.account(), action === 'offline' ? OFFLINE : null)
    assert.deepEqual(f.disk, action === 'offline' ? OFFLINE : null)
    assert.equal(accounts.loginPending, false)
  })
}

test('only one login can pass config preflight at a time, and failure releases the guard', async () => {
  const config = deferred<typeof CONFIG>()
  const f = fixture()
  const accounts = new AccountCoordinator(f.auth, { ...f.options, config: () => config.promise })
  const first = accounts.login()
  const rejected = assert.rejects(first, /尚未配置/)
  await assert.rejects(accounts.login(), { code: 'BUSY' })
  config.resolve({ configured: false, clientId: '' })
  await rejected
  assert.equal(f.calls, 0)
  assert.equal(accounts.loginPending, false)
})

test('a slow older logout cannot remove or announce over a newer offline selection', async () => {
  const release = deferred()
  const f = fixture(PREVIOUS)
  f.auth.logout = async () => { await release.promise }
  const accounts = new AccountCoordinator(f.auth, f.options)
  const loggingOut = accounts.logout()
  await accounts.setOffline(OFFLINE)
  assert.deepEqual(f.disk, OFFLINE)
  release.resolve()
  await loggingOut
  assert.deepEqual(await accounts.account(), OFFLINE)
  assert.deepEqual(f.disk, OFFLINE)
  assert.deepEqual(f.writes, [OFFLINE])
  assert.deepEqual(f.events, [OFFLINE])
})

test('a newer offline write waits for an in-flight login deletion and remains the final selection', async () => {
  const deleting = deferred()
  const release = deferred()
  const f = fixture(PREVIOUS)
  const accounts = new AccountCoordinator(f.auth, {
    ...f.options,
    persistOffline: async value => {
      if (value === null) { deleting.resolve(); await release.promise }
      await f.options.persistOffline(value)
    },
  })
  const login = accounts.login()
  const rejected = assert.rejects(login, { code: 'CANCELLED' })
  await deleting.promise
  const offline = accounts.setOffline(OFFLINE)
  assert.deepEqual(f.disk, PREVIOUS, 'neither write is published before persistence')
  release.resolve()
  await Promise.all([rejected, offline])
  assert.deepEqual(f.writes, [null, OFFLINE])
  assert.deepEqual(await accounts.account(), OFFLINE)
  assert.deepEqual(f.disk, OFFLINE)
  assert.deepEqual(f.events, [OFFLINE], 'the superseded Microsoft selection is not announced')
})

test('a newer logout is serialized after an in-flight offline write', async () => {
  const writing = deferred()
  const release = deferred()
  const f = fixture(PREVIOUS)
  const accounts = new AccountCoordinator(f.auth, {
    ...f.options,
    persistOffline: async value => {
      if (value) { writing.resolve(); await release.promise }
      await f.options.persistOffline(value)
    },
  })
  const offline = accounts.setOffline(OFFLINE)
  const rejected = assert.rejects(offline, { code: 'CANCELLED' })
  await writing.promise
  const logout = accounts.logout()
  release.resolve()
  await Promise.all([rejected, logout])
  assert.deepEqual(f.writes, [OFFLINE, null])
  assert.equal(f.disk, null)
  assert.equal(await accounts.account(), null)
  assert.deepEqual(f.events, [null])
})

test('failed persistence leaves the previous selected account and disk unchanged', async () => {
  const f = fixture(PREVIOUS)
  const accounts = new AccountCoordinator(f.auth, {
    ...f.options, persistOffline: async () => { throw new Error('disk failed') },
  })
  await assert.rejects(accounts.setOffline(OFFLINE), /disk failed/)
  assert.deepEqual(await accounts.account(), PREVIOUS)
  assert.deepEqual(f.disk, PREVIOUS)
  assert.deepEqual(f.events, [])
})

test('cancel after authentication commits does not turn a successful account switch into failure', async () => {
  const deleting = deferred()
  const release = deferred()
  const f = fixture(PREVIOUS)
  const accounts = new AccountCoordinator(f.auth, {
    ...f.options,
    persistOffline: async value => {
      deleting.resolve()
      await release.promise
      await f.options.persistOffline(value)
    },
  })
  const login = accounts.login()
  await deleting.promise
  accounts.cancelLogin()
  release.resolve()
  assert.deepEqual(await login, MICROSOFT)
  assert.deepEqual(await accounts.account(), MICROSOFT)
  assert.equal(f.disk, null)
})

test('credentials resolved after logout are rejected before they can launch a game', async () => {
  const requested = deferred()
  const release = deferred()
  const f = fixture()
  f.auth.credentials = async () => { requested.resolve(); await release.promise; return CREDENTIALS }
  const accounts = new AccountCoordinator(f.auth, f.options)
  const pending = accounts.credentials()
  const rejected = assert.rejects(pending, { code: 'CANCELLED' })
  await requested.promise
  await accounts.logout()
  release.resolve()
  await rejected
})

test('observer failure cannot invalidate a persisted account choice', async () => {
  const f = fixture()
  const accounts = new AccountCoordinator(f.auth, {
    ...f.options, onAccount: () => { throw new Error('window closed') },
  })
  assert.deepEqual(await accounts.setOffline(OFFLINE), OFFLINE)
  assert.deepEqual(f.disk, OFFLINE)
  assert.deepEqual(await accounts.account(), OFFLINE)
})
