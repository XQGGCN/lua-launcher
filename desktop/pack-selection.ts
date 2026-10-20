import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_SELECTIONS = 8
const LIFETIME_MS = 60 * 60 * 1000

/** Renderer receives opaque handles, never permission to read an arbitrary path. */
export class PackSelections<T> {
  private readonly entries = new Map<string, { file: string; expires: number; inUse: number }>()
  private directory = ''

  constructor(
    private readonly root: string,
    private readonly inspect: (file: string) => Promise<T>,
    private readonly now: () => number = Date.now,
  ) {}

  async init() {
    const base = path.join(this.root, 'import-cache')
    await fs.mkdir(base, { recursive: true, mode: 0o700 })
    for (const name of await fs.readdir(base)) {
      if (!/^session-[a-zA-Z0-9]{6}$/.test(name)) continue
      const candidate = path.join(base, name)
      const stat = await fs.lstat(candidate)
      if (stat.isDirectory() && this.now() - stat.mtimeMs > 24 * LIFETIME_MS) {
        await fs.rm(candidate, { recursive: true, force: true })
      }
    }
    this.directory = await fs.mkdtemp(path.join(base, 'session-'))
  }

  async choose(file: string): Promise<{ token: string; preview: T }> {
    if (!this.directory) throw new Error('整合包选择器尚未准备就绪')
    await this.prune()
    if (this.entries.size >= MAX_SELECTIONS) {
      const oldest = [...this.entries].find(([, entry]) => !entry.inUse)
      if (!oldest) throw new Error('正在导入的整合包过多，请等待当前任务完成')
      await fs.rm(oldest[1].file, { force: true })
      this.entries.delete(oldest[0])
    }
    const token = randomUUID()
    const copy = path.join(this.directory, `${token}.mrpack`)
    // Open once and inspect the opened handle; file replacement cannot redirect the copy.
    const input = await fs.open(file, 'r')
    try {
      const stat = await input.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARCHIVE_BYTES) {
        throw new Error('请选择不超过 256 MB 的整合包文件')
      }
      let bytes = 0
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length
          done(bytes > MAX_ARCHIVE_BYTES ? new Error('整合包文件超过 256 MB') : null, chunk)
        },
      })
      const output = await fs.open(copy, 'wx', 0o600)
      try {
        await pipeline(input.createReadStream(), limit, output.createWriteStream())
      } finally {
        await output.close()
      }
      const preview = await this.inspect(copy)
      this.entries.set(token, { file: copy, expires: this.now() + LIFETIME_MS, inUse: 0 })
      return { token, preview }
    } catch (error) {
      await fs.rm(copy, { force: true })
      throw error
    } finally {
      await input.close()
    }
  }

  async use<R>(token: string, work: (file: string) => Promise<R>): Promise<R> {
    const entry = this.entries.get(token)
    if (!entry || entry.expires <= this.now()) {
      await this.prune()
      throw new Error('整合包选择已过期，请重新选择文件')
    }
    if (entry.inUse) throw new Error('这个整合包正在导入，请等待当前任务完成')
    entry.inUse++
    try {
      return await work(entry.file)
    } finally {
      entry.inUse--
      await this.prune()
    }
  }

  private async prune() {
    for (const [token, entry] of this.entries) {
      if (!entry.inUse && entry.expires <= this.now()) {
        await fs.rm(entry.file, { force: true })
        this.entries.delete(token)
      }
    }
  }

  async close() {
    if ([...this.entries.values()].some(entry => entry.inUse)) return
    if (this.directory) await fs.rm(this.directory, { recursive: true, force: true })
    this.entries.clear()
  }
}
