import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

export interface GameWindowWriteOptions {
  backupDirectory: string
  signal?: AbortSignal
  /** Filesystem fault injection for tests; never accept this through renderer IPC. */
  rename?: typeof fs.rename
}

const MAX_OPTIONS_BYTES = 1024 * 1024
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
type FileSnapshot = { bytes: Buffer; mode: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number }

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('游戏窗口设置已取消', 'AbortError')
}
function absoluteDirectory(value: string): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value) || !path.isAbsolute(value)) {
    throw new Error('游戏与备份目录必须是有效的绝对路径')
  }
  const directory = path.resolve(value)
  if (directory === path.parse(directory).root) throw new Error('不能将文件系统根目录用作游戏或备份目录')
  return directory
}
async function safeDirectory(directory: string, create: boolean, allowMissing = false): Promise<void> {
  const root = path.parse(directory).root
  let current = root
  for (const segment of directory.slice(root.length).split(path.sep)) {
    current = path.join(current, segment)
    let stat
    try { stat = await fs.lstat(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) { if (allowMissing) return; throw error }
      await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      stat = await fs.lstat(current)
    }
    if (stat.isSymbolicLink()) {
      // macOS's /var and /tmp are system aliases used by os.tmpdir(). No user
      // symlink/junction, including the selected root itself, is followed.
      const alias = process.platform === 'darwin' && current !== directory &&
        ((current === '/var' && await fs.realpath(current) === '/private/var') ||
         (current === '/tmp' && await fs.realpath(current) === '/private/tmp'))
      if (alias) continue
      throw new Error('游戏与备份目录及其祖先不能是符号链接')
    }
    if (!stat.isDirectory()) throw new Error('游戏与备份路径必须是普通目录')
  }
}
async function snapshot(file: string): Promise<FileSnapshot | undefined> {
  let stat
  try { stat = await fs.lstat(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('options.txt 必须是普通文件，不能是符号链接')
  if (stat.size > MAX_OPTIONS_BYTES) throw new Error('options.txt 超过 1 MiB 安全读取上限')
  const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('options.txt 在读取期间发生变化，请重试')
    // Read at most limit + 1 even if another process grows the file after lstat.
    const buffer = Buffer.alloc(MAX_OPTIONS_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > MAX_OPTIONS_BYTES) throw new Error('options.txt 超过 1 MiB 安全读取上限')
    const after = await handle.stat()
    if (after.size !== offset || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('options.txt 在读取期间发生变化，请重试')
    }
    return { bytes: Buffer.from(buffer.subarray(0, offset)), mode: after.mode & 0o777, dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs }
  } finally { await handle.close() }
}
function changedBytes(original: Buffer, fullscreen: boolean): Buffer {
  const bom = original.subarray(0, 3).equals(UTF8_BOM)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? original.subarray(3) : original) } catch {
    throw new Error('options.txt 不是有效的 UTF-8，未修改原文件')
  }
  if (text.includes('\0')) throw new Error('options.txt 包含无效的空字符，未修改原文件')
  const desired = `fullscreen:${fullscreen ? 'true' : 'false'}`
  const segments = text.split(/(\r\n|\n|\r)/)
  let found = false
  for (let i = 0; i < segments.length; i += 2) {
    if (segments[i].startsWith('fullscreen:')) {
      found = true
      segments[i] = desired
    }
  }
  let result = segments.join('')
  if (!found) {
    const newline = /\r\n|\n|\r/.exec(text)?.[0] ?? '\n'
    result = `${text}${text && !/[\r\n]$/.test(text) ? newline : ''}${desired}${newline}`
  }
  return Buffer.concat([bom ? UTF8_BOM : Buffer.alloc(0), Buffer.from(result, 'utf8')])
}
async function writeNew(file: string, bytes: Buffer, mode: number): Promise<void> {
  let created = false
  let completed = false
  try {
    const handle = await fs.open(file, 'wx', mode)
    created = true
    try {
      await handle.writeFile(bytes)
      await handle.chmod(mode)
      await handle.sync()
      completed = true
    } finally { await handle.close() }
  } finally {
    if (created && !completed) await fs.rm(file, { force: true })
  }
}
function sameFile(before: FileSnapshot | undefined, current: FileSnapshot | undefined): boolean {
  if (!before || !current) return before === current
  return before.dev === current.dev && before.ino === current.ino && before.mode === current.mode &&
    before.mtimeMs === current.mtimeMs && before.ctimeMs === current.ctimeMs && before.bytes.equals(current.bytes)
}

/**
 * Apply only an explicit fullscreen override. The caller owns instance locking and
 * chooses both directories; this is not a renderer-accessible arbitrary-path API.
 */
export async function applyGameWindowSettings(gameDirectory: string, fullscreen: boolean, options: GameWindowWriteOptions): Promise<void> {
  if (typeof fullscreen !== 'boolean') throw new Error('全屏设置必须是布尔值')
  const directory = absoluteDirectory(gameDirectory)
  const backups = absoluteDirectory(options.backupDirectory)
  check(options.signal)
  await safeDirectory(directory, false)
  await safeDirectory(backups, false, true)
  const file = path.join(directory, 'options.txt')
  const original = await snapshot(file)
  check(options.signal)
  const updated = changedBytes(original?.bytes ?? Buffer.alloc(0), fullscreen)
  if (original?.bytes.equals(updated)) return
  if (updated.length > MAX_OPTIONS_BYTES) throw new Error('修改后的 options.txt 超过 1 MiB，未修改原文件')
  check(options.signal)
  if (original) {
    await safeDirectory(backups, true)
    check(options.signal)
    const backup = path.join(backups, `options.fullscreen-${Date.now()}-${randomUUID()}.bak`)
    await writeNew(backup, original.bytes, 0o600)
  }
  check(options.signal)
  const temporary = path.join(directory, `.lua-options-${randomUUID()}.tmp`)
  let temporaryOwned = false
  let committed = false
  try {
    await writeNew(temporary, updated, original?.mode ?? 0o644)
    temporaryOwned = true
    check(options.signal)
    await safeDirectory(directory, false)
    if (!sameFile(original, await snapshot(file))) throw new Error('options.txt 已被其他操作修改，请重试；本次未覆盖其内容')
    check(options.signal)
    // Once the atomic rename is invoked, a successful commit wins late cancellation.
    await (options.rename ?? fs.rename)(temporary, file)
    committed = true
  } finally {
    if (temporaryOwned && !committed) await fs.rm(temporary, { force: true })
  }
}
