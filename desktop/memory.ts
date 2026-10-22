import { execFileSync } from 'node:child_process'
import { freemem, totalmem } from 'node:os'

/** All "Mb" fields use MiB, matching Java's -Xmx...M unit. */
export interface MemoryContext {
  gameVersion?: string
  /** This is a workload hint, not a measurement of a modpack's requirements. */
  modded?: boolean
  /** Pass the selected Java runtime's architecture, not the launcher's architecture. */
  javaArch?: string
}

export interface MemorySystem {
  totalmem?: () => number
  freemem?: () => number
  availablemem?: () => number
  platform?: () => NodeJS.Platform
  /** macOS only: returns `vm_stat` output. Injected in tests. */
  vmStat?: () => string
}

export interface MemoryInfo {
  totalMb: number
  /** OS-reported available memory, or a conservative free-memory fallback. */
  availableMb: number
  /** Physical RAM reserved for the OS; Java's native overhead is budgeted separately. */
  reservedMb: number
  safeMaxMb: number
  recommendedMb: number
  minimumMb: number
  canLaunch: boolean
  availableBasis: 'free-memory-conservative' | 'os-available'
  reason: string
}

export interface MemorySettings {
  memoryMode?: 'auto' | 'manual'
  /** Retained manual preference. Auto mode does not change it. */
  memoryMb: number
}

export interface MemoryAllocation extends MemoryInfo {
  mode: 'auto' | 'manual'
  requestedMb: number
  effectiveMb: number
  clamped: boolean
}

export type MemoryErrorCode = 'MEMORY_INFO_UNAVAILABLE' | 'INSUFFICIENT_MEMORY' | 'INVALID_MEMORY_SETTINGS'

export class MemoryAllocationError extends Error {
  constructor(readonly code: MemoryErrorCode) {
    super({
      MEMORY_INFO_UNAVAILABLE: '无法读取系统内存，暂不能计算启动内存。请重试。',
      INSUFFICIENT_MEMORY: '当前可用内存不足，无法在保留系统和 Java 运行余量后分配至少 1 GB。请关闭其他程序后重试。',
      INVALID_MEMORY_SETTINGS: '内存设置无效，请选择自动分配，或填写 1024 至 65536 MB 的手动值。',
    }[code])
    this.name = 'MemoryAllocationError'
  }
}

const MIB = 1024 * 1024
const MINIMUM_HEAP_MB = 1024
const MAXIMUM_HEAP_MB = 65536
const HEAP_STEP_MB = 256
const FREE_HEADROOM_MB = 512
const BASE_NATIVE_MB = 512
const NATIVE_RATIO = 0.25
const ARCH_32_BIT = new Set(['x86', 'ia32', 'i386', 'i486', 'i586', 'i686', 'arm', 'arm32', 'x32'])

/**
 * Product defaults rather than Mojang minimum requirements. Large modpacks may
 * need manual tuning. Unknown versions/snapshots use the modern baseline.
 */
export function recommendedMemory(context: MemoryContext = {}): number {
  const release = /^1\.(\d+)(?:\.\d+)?(?:-(?:pre|rc)\d+)?$/.exec(context.gameVersion ?? '')
  const minor = release ? Number(release[1]) : null
  if (minor !== null && minor <= 12) return context.modded ? 4096 : 2048
  if (minor !== null && minor <= 17) return context.modded ? 4096 : 3072
  return context.modded ? 6144 : 4096
}

/**
 * On macOS, Node's availableMemory()/freemem() only count completely free pages, which
 * macOS keeps deliberately small (often a few hundred MB on a 16 GB Mac). Inactive,
 * speculative and purgeable pages are reclaimed immediately on demand, so they count
 * as available here, matching what Activity Monitor reports as memory not under pressure.
 * Returns undefined when vm_stat is unavailable or its output is not recognised.
 */
export function parseVmStat(output: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1])
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return undefined
  const pages = (label: string) => {
    const match = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(output)
    return match ? Number(match[1]) : undefined
  }
  const free = pages('free')
  if (free === undefined) return undefined
  const total = [free, pages('inactive') ?? 0, pages('speculative') ?? 0, pages('purgeable') ?? 0]
    .reduce((sum, value) => sum + value, 0) * pageSize
  return Number.isSafeInteger(total) ? total : undefined
}

function darwinAvailable(system: MemorySystem): number | undefined {
  try {
    const output = system.vmStat ? system.vmStat() : execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000, windowsHide: true })
    return parseVmStat(output)
  } catch {
    return undefined
  }
}

function snapshot(system: MemorySystem): { totalMb: number; availableMb: number; basis: MemoryInfo['availableBasis'] } {
  try {
    const total = (system.totalmem ?? totalmem)()
    // Native availableMemory includes OS-reclaimable pages and process limits.
    // Keep freemem injection deterministic for existing platform-independent tests.
    let available = system.availablemem ?? (system.freemem ? undefined : process.availableMemory?.bind(process))
    if (!system.availablemem && (system.platform?.() ?? process.platform) === 'darwin' && (!system.freemem || system.vmStat)) {
      const reclaimable = darwinAvailable(system)
      if (reclaimable !== undefined) {
        const base = available ? available() : (system.freemem ?? freemem)()
        const value = Math.max(reclaimable, Number.isSafeInteger(base) ? base : 0)
        available = () => value
      }
    }
    const free = (available ?? system.freemem ?? freemem)()
    if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(free) || free < 0) {
      throw new Error('invalid memory snapshot')
    }
    return {
      totalMb: Math.floor(total / MIB),
      // The OS calls are not atomic. A contradictory snapshot must never inflate the cap.
      availableMb: Math.floor(Math.min(free, total) / MIB),
      basis: available ? 'os-available' : 'free-memory-conservative',
    }
  } catch {
    // Do not forward native errors or substitute an assumed amount of RAM.
    throw new MemoryAllocationError('MEMORY_INFO_UNAVAILABLE')
  }
}

/**
 * Read again just before spawning Java. process.availableMemory() incorporates
 * OS-reclaimable memory and process limits; os.freemem is the fallback.
 * https://nodejs.org/api/process.html#processavailablememory
 *
 * The cap is a conservative policy, not a reservation or an OOM guarantee.
 * Budget both physical RAM and the current free snapshot, allowing 512 MiB plus
 * 25% of the heap for JVM/native allocations and a further 512 MiB free buffer.
 * Never infer reclaimable memory by subtracting the launcher's RSS from totals.
 */
export function getMemoryInfo(context: MemoryContext = {}, system: MemorySystem = {}): MemoryInfo {
  const { totalMb, availableMb, basis } = snapshot(system)
  const reservedMb = Math.min(totalMb, Math.max(1536, Math.min(8192, Math.ceil(totalMb * 0.2))))
  const physicalBudget = (totalMb - reservedMb - BASE_NATIVE_MB) / (1 + NATIVE_RATIO)
  const freeBudget = (availableMb - FREE_HEADROOM_MB - BASE_NATIVE_MB) / (1 + NATIVE_RATIO)
  const java32 = ARCH_32_BIT.has((context.javaArch ?? process.arch).trim().toLowerCase())
  const architectureCap = java32 ? MINIMUM_HEAP_MB : MAXIMUM_HEAP_MB
  const safeMaxMb = Math.max(0, Math.floor(Math.min(physicalBudget, freeBudget, architectureCap) / HEAP_STEP_MB) * HEAP_STEP_MB)
  const canLaunch = safeMaxMb >= MINIMUM_HEAP_MB
  const targetMb = recommendedMemory(context)
  const recommendedMb = canLaunch ? Math.min(targetMb, safeMaxMb) : 0
  const sourceNote = basis === 'os-available'
    ? '按操作系统报告的可用内存估算，包含系统可回收的部分内存。'
    : '按当前空闲内存保守估算，不含可回收缓存。'
  const limitNote = !canLaunch
    ? '请先关闭其他程序释放内存。'
    : java32
      ? '32 位 Java 最多分配 1 GB，建议使用 64 位 Java。'
      : recommendedMb < targetMb
        ? '已降低建议值，为系统和 Java 非堆内存保留余量。'
        : '已为系统和 Java 非堆内存保留余量。'
  return {
    totalMb, availableMb, reservedMb, safeMaxMb, recommendedMb,
    minimumMb: MINIMUM_HEAP_MB, canLaunch, availableBasis: basis,
    reason: `${sourceNote}${limitNote}启动时会重新计算。`,
  }
}

/** A manual preference also cannot exceed the current policy cap. */
export function effectiveMemory(
  settings: MemorySettings,
  context: MemoryContext = {},
  system: MemorySystem = {},
): MemoryAllocation {
  const mode = settings.memoryMode ?? 'auto'
  if (
    (mode !== 'auto' && mode !== 'manual') ||
    (mode === 'manual' && (!Number.isInteger(settings.memoryMb) || settings.memoryMb < MINIMUM_HEAP_MB || settings.memoryMb > MAXIMUM_HEAP_MB))
  ) throw new MemoryAllocationError('INVALID_MEMORY_SETTINGS')
  const info = getMemoryInfo(context, system)
  if (!info.canLaunch) throw new MemoryAllocationError('INSUFFICIENT_MEMORY')
  const requestedMb = mode === 'manual' ? settings.memoryMb : recommendedMemory(context)
  const effectiveMb = Math.min(requestedMb, info.safeMaxMb)
  return { ...info, mode, requestedMb, effectiveMb, clamped: effectiveMb !== requestedMb }
}
