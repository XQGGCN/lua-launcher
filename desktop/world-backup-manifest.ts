import { createHash } from 'node:crypto'
import type { WorldBackupSummary } from './world-backup-types'

export const BACKUP_LIMITS = Object.freeze({
  totalBytes: 100 * 1024 ** 3, fileBytes: 32 * 1024 ** 3, entries: 100_000,
  directoryEntries: 20_000, depth: 64, pathBytes: 1024, manifestBytes: 64 * 1024 ** 2,
  controlBytes: 64 * 1024, bufferBytes: 1024 ** 2, backups: 500,
  durationMs: 6 * 60 * 60 * 1000, listDurationMs: 5000, listMetadataBytes: 128 * 1024 ** 2,
})
export const BACKUP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SHA256 = /^[0-9a-f]{64}$/
export const backupNameKey = (value: string) => value.normalize('NFC').toLowerCase()
export const worldItemId = (name: string) => `worlds:${createHash('sha256').update(name).digest('hex')}`
export function backupSafeName(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value && value !== '.' && value !== '..' &&
    Buffer.byteLength(value) <= 255 && !/[ .]$/.test(value) &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff\ufffd]/u.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value))
}
export const backupIdentifier = (value: unknown): value is string => typeof value === 'string' && IDENTIFIER.test(value)
export function backupRelativePath(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= BACKUP_LIMITS.pathBytes &&
    value.split('/').length <= BACKUP_LIMITS.depth && value.split('/').every(backupSafeName)
}
export type BackupEntry = { path: string; type: 'directory'; sourceMtimeNs: string; sourceMode: number } |
  { path: string; type: 'file'; sourceMtimeNs: string; sourceMode: number; sizeBytes: number; sha256: string }
export interface BackupManifest extends Omit<WorldBackupSummary, 'verifiedAtCompletion'> {
  schema: 1
  verification: { algorithm: 'sha256'; destinationReadback: true; sourceSecondPass: true }
  entries: BackupEntry[]
}
export interface BackupIntent {
  schema: 1; backupId: string; instanceId: string; operationId: string
  worldItemId: string; worldFolderName: string; createdAt: string
}
export interface BackupReceipt { schema: 1; backupId: string; manifestSha256: string; completedAt: string }

function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key =>
        typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) {
    throw new Error('备份记录字段无效')
  }
}
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}
function count(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
}
function parse(bytes: Uint8Array, max: number): unknown {
  if (bytes.byteLength > max) throw new Error('备份记录超出大小上限')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
export function parseBackupManifest(bytes: Uint8Array): BackupManifest {
  const value = parse(bytes, BACKUP_LIMITS.manifestBytes)
  object(value, ['schema', 'backupId', 'instanceId', 'worldItemId', 'worldFolderName', 'format', 'createdAt',
    'completedAt', 'fileCount', 'directoryCount', 'totalBytes', 'verification', 'entries'])
  if (value.schema !== 1 || value.format !== 'directory' || typeof value.backupId !== 'string' || !BACKUP_UUID.test(value.backupId) ||
      !backupIdentifier(value.instanceId) || !backupSafeName(value.worldFolderName) || value.worldItemId !== worldItemId(value.worldFolderName) ||
      !date(value.createdAt) || !date(value.completedAt) || value.completedAt < value.createdAt ||
      !count(value.fileCount, BACKUP_LIMITS.entries) || !count(value.directoryCount, BACKUP_LIMITS.entries) ||
      !count(value.totalBytes, BACKUP_LIMITS.totalBytes) || !Array.isArray(value.entries) || value.entries.length > BACKUP_LIMITS.entries) {
    throw new Error('备份清单无效')
  }
  object(value.verification, ['algorithm', 'destinationReadback', 'sourceSecondPass'])
  if (value.verification.algorithm !== 'sha256' || value.verification.destinationReadback !== true || value.verification.sourceSecondPass !== true) {
    throw new Error('备份验证记录无效')
  }
  const names = new Map<string, string>(), byPath = new Map<string, 'directory' | 'file'>(), children = new Map<string, number>()
  let files = 0, directories = 0, total = 0
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object') throw new Error('备份条目无效')
    object(entry, entry.type === 'file' ? ['path', 'type', 'sourceMtimeNs', 'sourceMode', 'sizeBytes', 'sha256'] :
      ['path', 'type', 'sourceMtimeNs', 'sourceMode'])
    if (!backupRelativePath(entry.path) || (entry.type !== 'file' && entry.type !== 'directory') ||
        typeof entry.sourceMtimeNs !== 'string' || !/^-?\d{1,30}$/.test(entry.sourceMtimeNs) || !count(entry.sourceMode, 0xffffffff)) {
      throw new Error('备份条目路径或类型无效')
    }
    const key = backupNameKey(entry.path)
    if (names.has(key)) throw new Error('备份条目名称冲突')
    names.set(key, entry.path); byPath.set(entry.path, entry.type)
    const parent = entry.path.split('/').slice(0, -1).join('/')
    children.set(parent, (children.get(parent) ?? 0) + 1)
    if (children.get(parent)! > BACKUP_LIMITS.directoryEntries) throw new Error('备份目录条目超限')
    if (entry.type === 'file') {
      if (!count(entry.sizeBytes, BACKUP_LIMITS.fileBytes) || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) throw new Error('备份文件校验无效')
      files++; total += entry.sizeBytes
      if (total > BACKUP_LIMITS.totalBytes) throw new Error('备份字节总量超限')
    } else directories++
  }
  for (const entry of value.entries) {
    const parts = entry.path.split('/')
    for (let i = 1; i < parts.length; i++) if (byPath.get(parts.slice(0, i).join('/')) !== 'directory') {
      throw new Error('备份条目的父目录缺失或不是目录')
    }
  }
  if (files !== value.fileCount || directories !== value.directoryCount || total !== value.totalBytes) throw new Error('备份汇总不一致')
  return value as unknown as BackupManifest
}
export function parseBackupIntent(bytes: Uint8Array): BackupIntent {
  const value = parse(bytes, BACKUP_LIMITS.controlBytes)
  object(value, ['schema', 'backupId', 'instanceId', 'operationId', 'worldItemId', 'worldFolderName', 'createdAt'])
  if (value.schema !== 1 || typeof value.backupId !== 'string' || !BACKUP_UUID.test(value.backupId) || !backupIdentifier(value.instanceId) ||
      !backupIdentifier(value.operationId) || !backupSafeName(value.worldFolderName) || value.worldItemId !== worldItemId(value.worldFolderName) ||
      !date(value.createdAt)) throw new Error('备份意图记录无效')
  return value as unknown as BackupIntent
}
export function parseBackupReceipt(bytes: Uint8Array): BackupReceipt {
  const value = parse(bytes, BACKUP_LIMITS.controlBytes)
  object(value, ['schema', 'backupId', 'manifestSha256', 'completedAt'])
  if (value.schema !== 1 || typeof value.backupId !== 'string' || !BACKUP_UUID.test(value.backupId) ||
      typeof value.manifestSha256 !== 'string' || !SHA256.test(value.manifestSha256) || !date(value.completedAt)) throw new Error('备份完成凭据无效')
  return value as unknown as BackupReceipt
}
export function backupSummary(manifest: BackupManifest): WorldBackupSummary {
  const { backupId, instanceId, worldItemId, worldFolderName, format, createdAt, completedAt, fileCount, directoryCount, totalBytes } = manifest
  return { backupId, instanceId, worldItemId, worldFolderName, format, createdAt, completedAt, fileCount, directoryCount, totalBytes, verifiedAtCompletion: true }
}
