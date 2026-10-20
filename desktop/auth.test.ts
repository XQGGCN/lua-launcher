import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  AuthError, AuthManager, redactAuthSecrets,
  type AuthErrorCode, type AuthOptions, type AuthStatus, type DeviceCode,
} from './auth'

// Deliberately fictitious application ID and credentials. No live accounts or
// Microsoft requests are used by this suite.
const CLIENT_ID = '11111111-2222-4333-8444-555555555555'
const ACCOUNT = { username: 'Test_Player', uuid: '0123456789abcdef0123456789abcdef', mode: 'microsoft' as const }
const SECRET = {
  device: 'private-device-code',
  microsoft: 'private-microsoft-access',
  refresh: 'private-microsoft-refresh',
  xbox: 'private-xbox-token',
  xsts: 'private-xsts-token',
  minecraft: 'private-minecraft-access',
}
type Step = {
  suffix: string
  status?: number
  body: unknown
  hold?: () => Promise<void>
}
type Call = { url: string, init: RequestInit }

function device(body: Record<string, unknown> = {}): Step {
  return {
    suffix: '/devicecode',
    body: {
      device_code: SECRET.device, user_code: 'ABCD-EFGH',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900, interval: 5, ...body,
    },
  }
}

function oauth(body: Record<string, unknown> = {}): Step {
  return {
    suffix: '/token',
    body: { access_token: SECRET.microsoft, refresh_token: SECRET.refresh, expires_in: 3600, ...body },
  }
}

function minecraft(): Step[] {
  return [
    { suffix: '/user/authenticate', body: { Token: SECRET.xbox } },
    { suffix: '/xsts/authorize', body: { Token: SECRET.xsts, DisplayClaims: { xui: [{ uhs: 'test-user-hash' }] } } },
    { suffix: '/authentication/login_with_xbox', body: { access_token: SECRET.minecraft, expires_in: 3600 } },
    { suffix: '/entitlements/mcstore', body: { items: [{ name: 'game_minecraft' }] } },
    { suffix: '/minecraft/profile', body: { name: ACCOUNT.username, id: ACCOUNT.uuid } },
  ]
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

async function fixture(t: TestContext, steps: Step[]) {
  const root = await mkdtemp(join(tmpdir(), 'lua-auth-test-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const key = randomBytes(32)
  const codes: DeviceCode[] = []
  const statuses: AuthStatus[] = []
  const calls: Call[] = []
  const sleeps: number[] = []
  let time = 1_700_000_000_000
  const queue = [...steps]
  const options: AuthOptions = {
    seal(plaintext) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    unseal(encrypted) {
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
      decipher.setAuthTag(encrypted.subarray(12, 28))
      return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8')
    },
    onDeviceCode(code) { codes.push(code) },
    onStatus(status) { statuses.push(status) },
    now: () => time,
    sleep: async (ms, signal) => {
      signal.throwIfAborted()
      sleeps.push(ms)
      time += ms
    },
    fetch: async (input, init = {}) => {
      const url = String(input)
      calls.push({ url, init })
      const next = queue.shift()
      assert.ok(next, `Unexpected request to ${url}`)
      assert.ok(url.endsWith(next.suffix), `Expected ${next.suffix}; received ${url}`)
      if (next.hold) await next.hold()
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200, headers: { 'Content-Type': 'application/json' },
      })
    },
  }
  return {
    root, options, codes, statuses, calls, sleeps, queue,
    manager: new AuthManager(root, options),
    advance: (ms: number) => { time += ms },
    file: join(root, 'microsoft-session.json'),
  }
}

function isAuthError(code: AuthErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof AuthError)
    assert.equal(error.code, code)
    for (const secret of Object.values(SECRET)) {
      assert.ok(!JSON.stringify(error).includes(secret))
      assert.ok(!error.stack?.includes(secret))
    }
    assert.equal(error.cause, undefined)
    return true
  }
}

test('a complete device flow exposes only profile and user-code fields, storing only encrypted session data', async t => {
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  const account = await f.manager.begin(CLIENT_ID)
  assert.deepEqual(account, ACCOUNT)
  assert.deepEqual(await f.manager.account(), ACCOUNT)
  assert.deepEqual(Object.keys(f.codes[0]).sort(), ['expiresAt', 'userCode', 'verificationUri'])
  assert.equal(f.codes[0].userCode, 'ABCD-EFGH')
  assert.ok(!JSON.stringify(f.codes).includes(SECRET.device))
  assert.deepEqual(f.sleeps, [5000])

  const initial = new URLSearchParams(String(f.calls[0].init.body))
  assert.equal(initial.get('client_id'), CLIENT_ID)
  assert.equal(initial.get('scope'), 'XboxLive.signin offline_access')
  const polling = new URLSearchParams(String(f.calls[1].init.body))
  assert.equal(polling.get('client_id'), CLIENT_ID)
  assert.equal(polling.get('device_code'), SECRET.device)
  assert.equal(polling.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
  assert.equal(JSON.parse(String(f.calls[2].init.body)).Properties.RpsTicket, `d=${SECRET.microsoft}`)
  assert.equal(JSON.parse(String(f.calls[4].init.body)).identityToken, `XBL3.0 x=test-user-hash;${SECRET.xsts}`)
  assert.equal(new Headers(f.calls[5].init.headers).get('Authorization'), `Bearer ${SECRET.minecraft}`)
  assert.ok(f.calls.every(call => call.init.redirect === 'error' && call.init.signal instanceof AbortSignal))

  const disk = await readFile(f.file, 'utf8')
  const envelope = JSON.parse(disk)
  assert.deepEqual(Object.keys(envelope).sort(), ['encrypted', 'version'])
  for (const secret of Object.values(SECRET)) assert.ok(!disk.includes(secret))
  assert.ok(!Buffer.from(envelope.encrypted, 'base64').toString('utf8').includes(SECRET.refresh))
  const saved = JSON.parse(await f.options.unseal(Buffer.from(envelope.encrypted, 'base64')))
  assert.deepEqual(Object.keys(saved).sort(), ['account', 'clientId', 'refreshToken'])
  assert.equal(saved.refreshToken, SECRET.refresh)
  assert.equal(saved.accessToken, undefined)
  assert.ok(!JSON.stringify(saved).includes(SECRET.minecraft))
  if (process.platform !== 'win32') assert.equal((await stat(f.file)).mode & 0o777, 0o600)

  assert.deepEqual(await f.manager.credentials(), { ...ACCOUNT, accessToken: SECRET.minecraft, clientId: CLIENT_ID })
  assert.equal(f.calls.length, 7, 'unexpired access token is reused only in memory')
  assert.equal(f.queue.length, 0)
})

test('a restarted manager refreshes with the stored app ID and rotates the encrypted refresh token', async t => {
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  await f.manager.begin(CLIENT_ID)
  f.queue.push(oauth({ refresh_token: 'rotated-refresh-secret' }), ...minecraft())
  const restarted = new AuthManager(f.root, f.options)
  assert.deepEqual(await restarted.account(), ACCOUNT)
  const [first, concurrent] = await Promise.all([restarted.credentials(), restarted.credentials()])
  assert.deepEqual(first, { ...ACCOUNT, accessToken: SECRET.minecraft, clientId: CLIENT_ID })
  assert.deepEqual(concurrent, first)
  const form = new URLSearchParams(String(f.calls[7].init.body))
  assert.equal(form.get('grant_type'), 'refresh_token')
  assert.equal(form.get('client_id'), CLIENT_ID)
  assert.equal(form.get('refresh_token'), SECRET.refresh)
  assert.equal(f.calls.length, 13, 'concurrent launch requests share a refresh')
  const envelope = JSON.parse(await readFile(f.file, 'utf8'))
  const saved = JSON.parse(await f.options.unseal(Buffer.from(envelope.encrypted, 'base64')))
  assert.equal(saved.refreshToken, 'rotated-refresh-secret')
  assert.equal(f.queue.length, 0)
})

test('expiry triggers a refresh and preserves the previous refresh token when the server omits a replacement', async t => {
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  await f.manager.begin(CLIENT_ID)
  f.advance(3_600_000)
  f.queue.push({ suffix: '/token', body: { access_token: SECRET.microsoft } }, ...minecraft())
  assert.equal((await f.manager.credentials()).accessToken, SECRET.minecraft)
  const envelope = JSON.parse(await readFile(f.file, 'utf8'))
  const saved = JSON.parse(await f.options.unseal(Buffer.from(envelope.encrypted, 'base64')))
  assert.equal(saved.refreshToken, SECRET.refresh)
})

test('pending and slow_down responses honor polling intervals', async t => {
  const f = await fixture(t, [
    device(),
    { suffix: '/token', status: 400, body: { error: 'authorization_pending' } },
    { suffix: '/token', status: 400, body: { error: 'slow_down' } },
    oauth(), ...minecraft(),
  ])
  await f.manager.begin(CLIENT_ID)
  assert.deepEqual(f.sleeps, [5000, 5000, 10_000])
})

test('polling stops at the device-code deadline', async t => {
  const f = await fixture(t, [
    device({ expires_in: 6 }),
    { suffix: '/token', status: 400, body: { error: 'authorization_pending' } },
  ])
  await assert.rejects(f.manager.begin(CLIENT_ID), isAuthError('DEVICE_CODE_EXPIRED'))
  assert.deepEqual(f.sleeps, [5000, 1000])
  assert.equal(f.calls.length, 2)
  assert.equal(await f.manager.account(), null)
})

test('invalid or missing client ID cannot start a network request', async t => {
  const f = await fixture(t, [])
  for (const id of ['', 'not-an-app', '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(f.manager.begin(id), isAuthError('INVALID_CLIENT_ID'))
  }
  assert.equal(f.calls.length, 0)
})

for (const [upstream, expected] of [
  ['authorization_declined', 'AUTHORIZATION_DECLINED'],
  ['expired_token', 'DEVICE_CODE_EXPIRED'],
  ['invalid_client', 'CLIENT_CONFIGURATION'],
  ['unauthorized_client', 'CLIENT_CONFIGURATION'],
] as const) {
  test(`OAuth ${upstream} is mapped without leaking provider error descriptions`, async t => {
    const f = await fixture(t, [
      device(),
      { suffix: '/token', status: 400, body: { error: upstream, error_description: Object.values(SECRET).join(' ') } },
    ])
    await assert.rejects(f.manager.begin(CLIENT_ID), isAuthError(expected))
    assert.equal(await f.manager.account(), null)
  })
}

for (const [xerr, expected] of [
  [2148916233, 'NO_XBOX_PROFILE'],
  [2148916238, 'XBOX_ACCOUNT_RESTRICTED'],
] as const) {
  test(`Xbox restriction ${xerr} gets an actionable local error`, async t => {
    const chain = minecraft()
    const f = await fixture(t, [
      device(), oauth(), chain[0],
      { suffix: '/xsts/authorize', status: 401, body: { XErr: xerr, Message: SECRET.xsts } },
    ])
    await assert.rejects(f.manager.begin(CLIENT_ID), isAuthError(expected))
    assert.equal(await f.manager.account(), null)
  })
}

test('Minecraft API permission failure does not impersonate a successful login', async t => {
  const chain = minecraft()
  const f = await fixture(t, [
    device(), oauth(), chain[0], chain[1],
    { suffix: '/authentication/login_with_xbox', status: 403, body: { errorMessage: SECRET.microsoft } },
  ])
  await assert.rejects(f.manager.begin(CLIENT_ID), isAuthError('CLIENT_CONFIGURATION'))
  assert.equal(await f.manager.account(), null)
})

test('an unrelated entitlement is not accepted as a Java game license', async t => {
  const chain = minecraft()
  const f = await fixture(t, [
    device(), oauth(), ...chain.slice(0, 3),
    { suffix: '/entitlements/mcstore', body: { items: [{ name: 'unrelated_product' }] } },
  ])
  await assert.rejects(f.manager.begin(CLIENT_ID), isAuthError('NO_MINECRAFT_OWNERSHIP'))
  assert.equal(await f.manager.account(), null)
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
})

test('a missing Java profile is distinguished from missing ownership', async t => {
  const chain = minecraft()
  const f = await fixture(t, [
    device(), oauth(), ...chain.slice(0, 4),
    { suffix: '/minecraft/profile', status: 404, body: { error: 'NOT_FOUND' } },
  ])
  await assert.rejects(f.manager.begin(CLIENT_ID), isAuthError('MINECRAFT_PROFILE_MISSING'))
})

test('revoked refresh credentials require sign-in and never silently return stale access', async t => {
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  await f.manager.begin(CLIENT_ID)
  f.advance(3_600_000)
  const generation = f.manager.sessionGeneration
  f.queue.push({ suffix: '/token', status: 400, body: { error: 'invalid_grant', error_description: SECRET.refresh } })
  await assert.rejects(f.manager.credentials(), isAuthError('SESSION_EXPIRED'))
  assert.notEqual(f.manager.sessionGeneration, generation)
  assert.equal(await f.manager.account(), null)
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
  assert.equal(await new AuthManager(f.root, f.options).account(), null)
  f.advance(-3_600_000)
  await assert.rejects(f.manager.credentials(), isAuthError('AUTH_REQUIRED'))
  assert.equal(f.calls.length, 8, 'revoked access cannot be reused even if the clock moves backward')
})

for (const code of ['NO_MINECRAFT_OWNERSHIP', 'MINECRAFT_PROFILE_MISSING', 'NO_XBOX_PROFILE', 'XBOX_ACCOUNT_RESTRICTED'] as const) {
  test(`refresh ${code} clears the saved and cached Microsoft session`, async t => {
    const f = await fixture(t, [device(), oauth(), ...minecraft()])
    await f.manager.begin(CLIENT_ID)
    f.advance(3_600_000)
    const chain = minecraft()
    if (code === 'NO_MINECRAFT_OWNERSHIP') {
      f.queue.push(oauth(), ...chain.slice(0, 3), { suffix: '/entitlements/mcstore', body: { items: [] } })
    } else if (code === 'MINECRAFT_PROFILE_MISSING') {
      f.queue.push(oauth(), ...chain.slice(0, 4), { suffix: '/minecraft/profile', status: 404, body: {} })
    } else {
      f.queue.push(oauth(), chain[0], {
        suffix: '/xsts/authorize', status: 401,
        body: { XErr: code === 'NO_XBOX_PROFILE' ? 2148916233 : 2148916238 },
      })
    }
    await assert.rejects(f.manager.credentials(), isAuthError(code))
    assert.equal(await f.manager.account(), null)
    await assert.rejects(f.manager.credentials(), isAuthError('AUTH_REQUIRED'))
    await assert.rejects(readFile(f.file), { code: 'ENOENT' })
    assert.equal(await new AuthManager(f.root, f.options).account(), null)
  })
}

for (const failure of ['network', 'service', 'configuration'] as const) {
  test(`a temporary ${failure} refresh failure preserves the account but never supplies expired access`, async t => {
    const f = await fixture(t, [device(), oauth(), ...minecraft()])
    await f.manager.begin(CLIENT_ID)
    f.advance(3_600_000)
    const generation = f.manager.sessionGeneration
    const disk = await readFile(f.file, 'utf8')
    f.queue.push(failure === 'network'
      ? { suffix: '/token', body: {}, hold: async () => { throw new Error(SECRET.refresh) } }
      : { suffix: '/token', status: failure === 'service' ? 503 : 400, body: { error: failure === 'service' ? 'temporarily_unavailable' : 'invalid_client' } })
    const code = failure === 'network' ? 'NETWORK_ERROR' : failure === 'service' ? 'SERVICE_UNAVAILABLE' : 'CLIENT_CONFIGURATION'
    await assert.rejects(f.manager.credentials(), isAuthError(code))
    assert.equal(f.manager.sessionGeneration, generation)
    assert.deepEqual(await f.manager.account(), ACCOUNT)
    assert.equal(await readFile(f.file, 'utf8'), disk)
    assert.deepEqual(await new AuthManager(f.root, f.options).account(), ACCOUNT)
    f.queue.push(oauth(), ...minecraft())
    assert.equal((await f.manager.credentials()).accessToken, SECRET.minecraft)
    assert.equal(f.queue.length, 0)
  })
}

test('a cancelled old refresh cannot revoke the session saved by a newer login', async t => {
  const started = deferred()
  const release = deferred()
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  await f.manager.begin(CLIENT_ID)
  f.advance(3_600_000)
  f.queue.push({
    suffix: '/token', status: 400, body: { error: 'invalid_grant' },
    hold: async () => { started.resolve(); await release.promise },
  })
  const pending = f.manager.credentials()
  const rejected = assert.rejects(pending, isAuthError('CANCELLED'))
  await started.promise
  f.queue.push(device(), oauth({ refresh_token: 'newly-verified-refresh-token' }), ...minecraft())
  await f.manager.begin(CLIENT_ID)
  const generation = f.manager.sessionGeneration
  release.resolve()
  await rejected
  assert.deepEqual(await f.manager.account(), ACCOUNT)
  assert.equal(f.manager.sessionGeneration, generation)
  const envelope = JSON.parse(await readFile(f.file, 'utf8'))
  const saved = JSON.parse(await f.options.unseal(Buffer.from(envelope.encrypted, 'base64')))
  assert.equal(saved.refreshToken, 'newly-verified-refresh-token')
  assert.equal((await f.manager.credentials()).accessToken, SECRET.minecraft)
})

test('cancel from the device-code callback prevents polling and persistence', async t => {
  const f = await fixture(t, [device()])
  const manager: AuthManager = new AuthManager(f.root, { ...f.options, onDeviceCode: (): void => manager.cancel() })
  await assert.rejects(manager.begin(CLIENT_ID), isAuthError('CANCELLED'))
  assert.equal(f.calls.length, 1)
  assert.equal(await manager.account(), null)
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
})

test('logout aborts an in-flight HTTP login and a late response cannot restore credentials', async t => {
  const started = deferred()
  const release = deferred()
  const step = oauth()
  step.hold = async () => { started.resolve(); await release.promise }
  const f = await fixture(t, [device(), step])
  const pending = f.manager.begin(CLIENT_ID)
  await started.promise
  await f.manager.logout()
  release.resolve()
  await assert.rejects(pending, isAuthError('CANCELLED'))
  assert.equal(await f.manager.account(), null)
  await assert.rejects(f.manager.credentials(), isAuthError('AUTH_REQUIRED'))
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
})

test('logout while encryption is pending cannot write a session back to disk', async t => {
  const started = deferred()
  const release = deferred()
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  const manager = new AuthManager(f.root, {
    ...f.options,
    seal: async plaintext => { started.resolve(); await release.promise; return f.options.seal(plaintext) },
  })
  const pending = manager.begin(CLIENT_ID)
  await started.promise
  await manager.logout()
  release.resolve()
  await assert.rejects(pending, isAuthError('CANCELLED'))
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
  assert.equal(await manager.account(), null)
})

test('cancel before commit retains the previous account in memory and after restart', async t => {
  const started = deferred()
  const release = deferred()
  let holdEncryption = false
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  const manager = new AuthManager(f.root, {
    ...f.options,
    seal: async plaintext => {
      if (holdEncryption) { started.resolve(); await release.promise }
      return f.options.seal(plaintext)
    },
  })
  await manager.begin(CLIENT_ID)
  const replacement = minecraft()
  replacement[4].body = { name: 'New_Player', id: ACCOUNT.uuid }
  f.queue.push(device(), oauth({ refresh_token: 'replacement-refresh-secret' }), ...replacement)
  holdEncryption = true
  const pending = manager.begin(CLIENT_ID)
  await started.promise
  manager.cancel()
  release.resolve()
  await assert.rejects(pending, isAuthError('CANCELLED'))
  assert.deepEqual(await manager.account(), ACCOUNT)
  assert.deepEqual(await new AuthManager(f.root, f.options).account(), ACCOUNT)
  const envelope = JSON.parse(await readFile(f.file, 'utf8'))
  const saved = JSON.parse(await f.options.unseal(Buffer.from(envelope.encrypted, 'base64')))
  assert.equal(saved.refreshToken, SECRET.refresh)
})

for (const kind of ['login', 'refresh'] as const) {
  test(`cancel after ${kind} file replacement completes successfully and keeps memory consistent with disk`, async t => {
    const committed = deferred()
    const release = deferred()
    let holdCommit = kind === 'login'
    const f = await fixture(t, [device(), oauth(), ...minecraft()])
    const manager = new AuthManager(f.root, {
      ...f.options,
      replaceFile: async (source, destination) => {
        await rename(source, destination)
        if (holdCommit) { committed.resolve(); await release.promise }
      },
    })
    if (kind === 'refresh') {
      await manager.begin(CLIENT_ID)
      f.advance(3_600_000)
      f.queue.push(oauth({ refresh_token: 'rotated-at-commit' }), ...minecraft())
      holdCommit = true
    }
    const pending = kind === 'login' ? manager.begin(CLIENT_ID) : manager.credentials()
    await committed.promise
    manager.cancel()
    // A replacement login must not interrupt an already committed operation.
    await assert.rejects(manager.begin(CLIENT_ID), isAuthError('BUSY'))
    release.resolve()
    assert.deepEqual(await pending, kind === 'login' ? ACCOUNT : { ...ACCOUNT, accessToken: SECRET.minecraft, clientId: CLIENT_ID })
    assert.deepEqual(await manager.account(), ACCOUNT)
    assert.deepEqual(await new AuthManager(f.root, f.options).account(), ACCOUNT)
    const envelope = JSON.parse(await readFile(f.file, 'utf8'))
    const saved = JSON.parse(await f.options.unseal(Buffer.from(envelope.encrypted, 'base64')))
    assert.equal(saved.refreshToken, kind === 'login' ? SECRET.refresh : 'rotated-at-commit')
  })

  test(`logout during ${kind} file replacement removes the commit and prevents late account restoration`, async t => {
    const committed = deferred()
    const release = deferred()
    let holdCommit = kind === 'login'
    const f = await fixture(t, [device(), oauth(), ...minecraft()])
    const manager = new AuthManager(f.root, {
      ...f.options,
      replaceFile: async (source, destination) => {
        await rename(source, destination)
        if (holdCommit) { committed.resolve(); await release.promise }
      },
    })
    if (kind === 'refresh') {
      await manager.begin(CLIENT_ID)
      f.advance(3_600_000)
      f.queue.push(oauth({ refresh_token: 'rotated-before-logout' }), ...minecraft())
      holdCommit = true
    }
    const pending = kind === 'login' ? manager.begin(CLIENT_ID) : manager.credentials()
    await committed.promise
    const loggingOut = manager.logout()
    assert.equal(await manager.account(), null)
    const cancelled = assert.rejects(pending, isAuthError('CANCELLED'))
    release.resolve()
    await Promise.all([cancelled, loggingOut])
    assert.equal(await manager.account(), null)
    await assert.rejects(manager.credentials(), isAuthError('AUTH_REQUIRED'))
    await assert.rejects(readFile(f.file), { code: 'ENOENT' })
    assert.equal(await new AuthManager(f.root, f.options).account(), null)
  })
}

test('logout removes persisted login and the cached access token', async t => {
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  await f.manager.begin(CLIENT_ID)
  await f.manager.logout()
  assert.equal(await f.manager.account(), null)
  await assert.rejects(f.manager.credentials(), isAuthError('AUTH_REQUIRED'))
  assert.equal(await new AuthManager(f.root, f.options).account(), null)
})

test('failed secure storage has no plaintext fallback and does not expose the encryption error', async t => {
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  const manager = new AuthManager(f.root, {
    ...f.options, seal: () => { throw new Error(`keychain failed ${SECRET.refresh}`) },
  })
  await assert.rejects(manager.begin(CLIENT_ID), isAuthError('STORAGE_UNAVAILABLE'))
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
  assert.equal(await manager.account(), null)
})

test('corrupted persisted data produces a safe storage error', async t => {
  const f = await fixture(t, [])
  await writeFile(f.file, `{${SECRET.refresh}`)
  await assert.rejects(f.manager.account(), isAuthError('STORAGE_UNAVAILABLE'))
})

test('untrusted verification URLs never reach the renderer', async t => {
  const f = await fixture(t, [device({ verification_uri: 'https://attacker.example/device' })])
  await assert.rejects(f.manager.begin(CLIENT_ID), isAuthError('INVALID_RESPONSE'))
  assert.equal(f.codes.length, 0)
})

test('fetch errors are replaced with a local error without message or cause secrets', async t => {
  const f = await fixture(t, [])
  const manager = new AuthManager(f.root, {
    ...f.options, fetch: async () => { throw new Error(`fetch rejected Bearer ${SECRET.microsoft}`) },
  })
  await assert.rejects(manager.begin(CLIENT_ID), isAuthError('NETWORK_ERROR'))
})

test('redaction removes known tokens, encoded tokens, auth headers, JSON and query secrets', () => {
  const encodedSecret = 'refresh+/secret='
  const input = [
    `--accessToken ${SECRET.minecraft}`,
    `Authorization: Bearer ${SECRET.microsoft}`,
    `{"refresh_token":"${SECRET.refresh}","device_code":"${SECRET.device}"}`,
    `identityToken=XBL3.0 x=test-user;${SECRET.xsts}`,
    `url?access_token=${SECRET.microsoft}&safe=1`,
    `encoded=${encodeURIComponent(encodedSecret)}`,
    'token=other-private-value',
  ].join('\n')
  const safe = redactAuthSecrets(input, [SECRET.minecraft, encodedSecret])
  for (const secret of [...Object.values(SECRET), encodedSecret, encodeURIComponent(encodedSecret), 'other-private-value']) {
    assert.ok(!safe.includes(secret), `Secret was not redacted: ${secret}`)
  }
  assert.ok(safe.includes('safe=1'))
})

test('login reports stages in order and publishes completion only after safe persistence', async t => {
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  const persisted: boolean[] = []
  const observed = deferred()
  const manager = new AuthManager(f.root, {
    ...f.options,
    onStatus: async status => {
      f.statuses.push(status)
      if (status.stage === 'complete') {
        persisted.push(Boolean(await readFile(f.file, 'utf8')))
        observed.resolve()
      }
    },
  })
  await manager.begin(CLIENT_ID)
  assert.deepEqual(f.statuses.map(status => status.stage), [
    'requesting-code', 'waiting-authorization', 'xbox', 'minecraft', 'checking-ownership', 'saving', 'complete',
  ])
  for (const status of f.statuses) assert.deepEqual(Object.keys(status).sort(), ['message', 'stage'])
  for (const secret of Object.values(SECRET)) assert.ok(!JSON.stringify(f.statuses).includes(secret))
  await observed.promise
  assert.deepEqual(persisted, [true])
})

test('failed ownership and failed storage never report complete', async t => {
  const chain = minecraft()
  const f = await fixture(t, [
    device(), oauth(), ...chain.slice(0, 3),
    { suffix: '/entitlements/mcstore', body: { items: [] } },
  ])
  await assert.rejects(f.manager.begin(CLIENT_ID), isAuthError('NO_MINECRAFT_OWNERSHIP'))
  assert.equal(f.statuses.at(-1)?.stage, 'checking-ownership')
  f.queue.push(device(), oauth(), ...minecraft())
  const manager = new AuthManager(f.root, {
    ...f.options, seal: () => { throw new Error(SECRET.refresh) },
  })
  await assert.rejects(manager.begin(CLIENT_ID), isAuthError('STORAGE_UNAVAILABLE'))
  assert.equal(f.statuses.at(-1)?.stage, 'saving')
  assert.ok(!f.statuses.some(status => status.stage === 'complete'))
})

test('cancelling from a status observer stops before network or storage commits', async t => {
  const f = await fixture(t, [])
  const manager = new AuthManager(f.root, {
    ...f.options, onStatus: status => {
      f.statuses.push(status)
      manager.cancel()
    },
  })
  await assert.rejects(manager.begin(CLIENT_ID), isAuthError('CANCELLED'))
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.statuses.map(status => status.stage), ['requesting-code'])
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
})

test('throwing or rejecting status observers cannot invalidate login or expose their errors', async t => {
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  const manager = new AuthManager(f.root, {
    ...f.options, onStatus: status => {
      if (status.stage === 'complete') return Promise.reject(new Error(SECRET.refresh))
      throw new Error(SECRET.microsoft)
    },
  })
  assert.deepEqual(await manager.begin(CLIENT_ID), ACCOUNT)
  assert.deepEqual(await new AuthManager(f.root, f.options).account(), ACCOUNT)
})

test('Xbox ID and client ID are supplied only to main-process credentials, never UI or disk', async t => {
  const chain = minecraft()
  const xuid = '2533274991020393'
  chain[1].body = { Token: SECRET.xsts, DisplayClaims: { xui: [{ uhs: 'test-user-hash', xid: xuid }] } }
  const f = await fixture(t, [device(), oauth(), ...chain])
  assert.deepEqual(await f.manager.begin(CLIENT_ID.toUpperCase()), ACCOUNT)
  assert.deepEqual(await f.manager.credentials(), { ...ACCOUNT, accessToken: SECRET.minecraft, clientId: CLIENT_ID, xuid })
  assert.ok(!JSON.stringify(await f.manager.account()).includes(xuid))
  assert.ok(!JSON.stringify(f.statuses).includes(xuid))
  const envelope = JSON.parse(await readFile(f.file, 'utf8'))
  assert.ok(!(await f.options.unseal(Buffer.from(envelope.encrypted, 'base64'))).includes(xuid))
})

test('absent or invalid Xbox IDs are omitted instead of replaced by a user hash', async t => {
  const chain = minecraft()
  chain[1].body = { Token: SECRET.xsts, DisplayClaims: { xui: [{ uhs: 'test-user-hash', xid: SECRET.xbox }] } }
  const f = await fixture(t, [device(), oauth(), ...chain])
  await f.manager.begin(CLIENT_ID)
  assert.equal((await f.manager.credentials()).xuid, undefined)
})

test('refresh reports its real stages without implying a new device-code authorization', async t => {
  const f = await fixture(t, [device(), oauth(), ...minecraft()])
  await f.manager.begin(CLIENT_ID)
  f.statuses.length = 0
  f.advance(3_600_000)
  f.queue.push(oauth(), ...minecraft())
  await f.manager.credentials()
  assert.deepEqual(f.statuses.map(status => status.stage), [
    'xbox', 'minecraft', 'checking-ownership', 'saving', 'complete',
  ])
})
