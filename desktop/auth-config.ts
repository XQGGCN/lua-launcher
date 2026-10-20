import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AuthError, validateClientId } from './auth'

export interface AuthConfigStatus {
  /** A valid ID is configured; this does not imply Minecraft API approval. */
  configured: boolean
  clientId: string
  source: 'built-in' | 'custom' | 'none'
}

/**
 * Main-process configuration for the public OAuth application ID only.
 * This file never contains client secrets, account data, or authentication tokens.
 */
export class AuthConfigStore {
  readonly #rootDir: string
  readonly #file: string
  readonly #builtInClientId: string
  #queue: Promise<unknown> = Promise.resolve()

  constructor(rootDir: string, builtInClientId = '') {
    this.#rootDir = rootDir
    this.#file = join(rootDir, 'microsoft-config.json')
    this.#builtInClientId = builtInClientId.trim() ? validateClientId(builtInClientId) : ''
  }

  status(): Promise<AuthConfigStatus> {
    return this.#serial(async () => {
      try {
        let raw: string
        try {
          raw = await readFile(this.#file, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.#status('')
          throw error
        }
        if (raw.length > 4096) throw new Error('invalid config')
        const config: unknown = JSON.parse(raw)
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid config')
        const value = config as Record<string, unknown>
        if (
          value.version !== 1 || typeof value.clientId !== 'string' ||
          Object.keys(value).some(key => key !== 'version' && key !== 'clientId')
        ) throw new Error('invalid config')
        return this.#status(value.clientId ? validateClientId(value.clientId) : '')
      } catch {
        throw new AuthError('STORAGE_UNAVAILABLE')
      }
    })
  }

  /** Empty string removes the custom override and restores the build default. */
  async saveClientId(value: unknown): Promise<AuthConfigStatus> {
    if (typeof value !== 'string') throw new AuthError('INVALID_CLIENT_ID')
    const custom = value.trim() ? validateClientId(value) : ''
    return this.#serial(async () => {
      const temporary = `${this.#file}.${randomUUID()}.tmp`
      let replaced = false
      try {
        await mkdir(this.#rootDir, { recursive: true, mode: 0o700 })
        await writeFile(temporary, JSON.stringify({ version: 1, clientId: custom }), {
          encoding: 'utf8', mode: 0o600, flag: 'wx',
        })
        await rename(temporary, this.#file)
        replaced = true
        return this.#status(custom)
      } catch {
        throw new AuthError('STORAGE_UNAVAILABLE')
      } finally {
        if (!replaced) await rm(temporary, { force: true }).catch(() => {})
      }
    })
  }

  #status(custom: string): AuthConfigStatus {
    if (custom) return { configured: true, clientId: custom, source: 'custom' }
    if (this.#builtInClientId) return { configured: true, clientId: this.#builtInClientId, source: 'built-in' }
    return { configured: false, clientId: '', source: 'none' }
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work)
    this.#queue = next.catch(() => {})
    return next
  }
}
