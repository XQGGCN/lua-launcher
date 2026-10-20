import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { AuthError } from './auth'
import { AuthConfigStore } from './auth-config'

const BUILT_IN = '11111111-2222-4333-8444-555555555555'
const CUSTOM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lua-auth-config-test-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return { root, file: join(root, 'microsoft-config.json') }
}

test('missing configuration reports none and creates no file', async t => {
  const f = await fixture(t)
  assert.deepEqual(await new AuthConfigStore(f.root).status(), { configured: false, clientId: '', source: 'none' })
  assert.deepEqual(await readdir(f.root), [])
})

test('a validated build default reports built-in without requiring an end-user registration', async t => {
  const f = await fixture(t)
  assert.deepEqual(await new AuthConfigStore(f.root, ` ${BUILT_IN} `).status(), {
    configured: true, clientId: BUILT_IN, source: 'built-in',
  })
  assert.throws(() => new AuthConfigStore(f.root, 'client-secret'), { code: 'INVALID_CLIENT_ID' })
})

test('saving a custom app ID persists the canonical public value across restarts', async t => {
  const f = await fixture(t)
  const store = new AuthConfigStore(f.root, BUILT_IN)
  const expected = { configured: true, clientId: CUSTOM, source: 'custom' }
  assert.deepEqual(await store.saveClientId(` ${CUSTOM.toUpperCase()} `), expected)
  assert.deepEqual(await new AuthConfigStore(f.root, BUILT_IN).status(), expected)
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { version: 1, clientId: CUSTOM })
  assert.deepEqual(await readdir(f.root), ['microsoft-config.json'])
  if (process.platform !== 'win32') assert.equal((await stat(f.file)).mode & 0o777, 0o600)
})

test('clearing the custom value restores the build default or the unconfigured state', async t => {
  const f = await fixture(t)
  const store = new AuthConfigStore(f.root, BUILT_IN)
  await store.saveClientId(CUSTOM)
  assert.deepEqual(await store.saveClientId(' '), { configured: true, clientId: BUILT_IN, source: 'built-in' })
  assert.deepEqual(await new AuthConfigStore(f.root).status(), { configured: false, clientId: '', source: 'none' })
})

test('invalid IPC values or secrets cannot overwrite existing configuration', async t => {
  const f = await fixture(t)
  const store = new AuthConfigStore(f.root)
  await store.saveClientId(CUSTOM)
  for (const invalid of [undefined, null, 42, {}, 'a-private-secret', '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(store.saveClientId(invalid), { code: 'INVALID_CLIENT_ID' })
  }
  assert.deepEqual(await store.status(), { configured: true, clientId: CUSTOM, source: 'custom' })
})

test('concurrent writes and reads are serialized without partial JSON or stale state', async t => {
  const f = await fixture(t)
  const store = new AuthConfigStore(f.root)
  const first = store.saveClientId(CUSTOM)
  const second = store.saveClientId(BUILT_IN)
  const snapshot = store.status()
  await Promise.all([first, second])
  assert.deepEqual(await snapshot, { configured: true, clientId: BUILT_IN, source: 'custom' })
  assert.deepEqual(await new AuthConfigStore(f.root).status(), await snapshot)
  assert.deepEqual(await readdir(f.root), ['microsoft-config.json'])
})

test('corrupt files report a safe error and can be repaired with an explicit save', async t => {
  const f = await fixture(t)
  const store = new AuthConfigStore(f.root, BUILT_IN)
  for (const data of ['{secret', JSON.stringify({ version: 1, clientId: CUSTOM, client_secret: 'private-secret' })]) {
    await writeFile(f.file, data)
    await assert.rejects(store.status(), error => {
      assert.ok(error instanceof AuthError)
      assert.equal(error.code, 'STORAGE_UNAVAILABLE')
      assert.ok(!error.message.includes('private-secret'))
      assert.equal(error.cause, undefined)
      return true
    })
  }
  assert.deepEqual(await store.saveClientId(''), { configured: true, clientId: BUILT_IN, source: 'built-in' })
})

test('failed atomic replacement preserves the previous target and removes temporary files', async t => {
  const f = await fixture(t)
  // A directory at the target makes rename fail consistently on all supported OSes.
  await mkdir(f.file)
  await writeFile(join(f.file, 'sentinel'), 'preserve')
  await assert.rejects(new AuthConfigStore(f.root).saveClientId(CUSTOM), { code: 'STORAGE_UNAVAILABLE' })
  assert.equal(await readFile(join(f.file, 'sentinel'), 'utf8'), 'preserve')
  assert.deepEqual(await readdir(f.root), ['microsoft-config.json'])
})
