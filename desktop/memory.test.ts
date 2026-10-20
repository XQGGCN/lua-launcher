import assert from 'node:assert/strict'
import test from 'node:test'
import {
  effectiveMemory, getMemoryInfo, MemoryAllocationError, recommendedMemory,
  type MemorySettings, type MemorySystem,
} from './memory'

const MIB = 1024 * 1024
const runtime = { gameVersion: '1.20.1', javaArch: 'x64' }
const system = (totalMb: number, freeMb: number, platform: NodeJS.Platform = 'linux'): MemorySystem => ({
  totalmem: () => totalMb * MIB,
  freemem: () => freeMb * MIB,
  platform: () => platform,
})

test('default automatic allocation keeps a manual preference intact and avoids assigning all RAM', () => {
  const settings = { memoryMb: 32768 }
  const result = effectiveMemory(settings, runtime, system(32768, 24576))
  assert.equal(result.mode, 'auto')
  assert.equal(result.effectiveMb, 4096)
  assert.equal(result.clamped, false)
  assert.equal(settings.memoryMb, 32768)
  assert.ok(result.effectiveMb < result.safeMaxMb)
})

test('workload defaults distinguish legacy, intermediate and modern releases without treating snapshots as old', () => {
  assert.equal(recommendedMemory({ gameVersion: '1.12.2' }), 2048)
  assert.equal(recommendedMemory({ gameVersion: '1.12.2', modded: true }), 4096)
  assert.equal(recommendedMemory({ gameVersion: '1.16.5' }), 3072)
  assert.equal(recommendedMemory({ gameVersion: '1.20.1', modded: true }), 6144)
  assert.equal(recommendedMemory({ gameVersion: '1.21-pre1' }), 4096)
  assert.equal(recommendedMemory({ gameVersion: '26w14a' }), 4096)
  assert.equal(recommendedMemory({ gameVersion: '26.1', modded: true }), 6144)
  assert.equal(recommendedMemory(), 4096)
})

test('automatic and manual allocation shrink under memory pressure and never change the stored preference', () => {
  const settings = { memoryMode: 'manual' as const, memoryMb: 8192 }
  const manual = effectiveMemory(settings, runtime, system(8192, 4096))
  const auto = effectiveMemory({ ...settings, memoryMode: 'auto' }, runtime, system(8192, 4096))
  assert.equal(manual.effectiveMb, 2304)
  assert.equal(auto.effectiveMb, manual.effectiveMb)
  assert.equal(manual.clamped, true)
  assert.equal(auto.clamped, true)
  assert.equal(manual.requestedMb, 8192)
  assert.equal(auto.requestedMb, 4096)
  assert.equal(settings.memoryMb, 8192)
})

test('a safe manual value is preserved exactly instead of being silently rounded', () => {
  const result = effectiveMemory({ memoryMode: 'manual', memoryMb: 3585 }, runtime, system(16384, 12000))
  assert.equal(result.effectiveMb, 3585)
  assert.equal(result.clamped, false)
})

test('free-memory pressure is re-read for every launch calculation', () => {
  let freeMb = 10000
  let reads = 0
  const source: MemorySystem = {
    totalmem: () => 16384 * MIB,
    freemem: () => { reads++; return freeMb * MIB },
  }
  assert.equal(effectiveMemory({ memoryMb: 8192 }, runtime, source).effectiveMb, 4096)
  freeMb = 4096
  assert.equal(effectiveMemory({ memoryMb: 8192 }, runtime, source).effectiveMb, 2304)
  freeMb = 1024
  assert.throws(() => effectiveMemory({ memoryMb: 8192 }, runtime, source), { code: 'INSUFFICIENT_MEMORY' })
  assert.equal(reads, 3)
})

test('low total RAM or current free RAM cannot be forced up to the minimum heap', () => {
  for (const source of [system(2048, 2048), system(16384, 2048), system(16384, 0)]) {
    const info = getMemoryInfo(runtime, source)
    assert.equal(info.canLaunch, false)
    assert.equal(info.recommendedMb, 0)
    assert.ok(info.safeMaxMb < info.minimumMb)
    for (const memoryMode of ['auto', 'manual'] as const) {
      assert.throws(() => effectiveMemory({ memoryMode, memoryMb: 1024 }, runtime, source), { code: 'INSUFFICIENT_MEMORY' })
    }
  }
})

test('the exact free-memory threshold permits a minimum heap but one byte less cannot round up', () => {
  const thresholdMb = 1024 + 512 + 512 + 1024 * 0.25
  assert.equal(getMemoryInfo(runtime, system(8192, thresholdMb)).safeMaxMb, 1024)
  const below: MemorySystem = { ...system(8192, thresholdMb), freemem: () => thresholdMb * MIB - 1 }
  assert.equal(getMemoryInfo(runtime, below).canLaunch, false)
})

test('the selected 32-bit Java runtime limits the heap even on a machine with ample RAM', () => {
  for (const javaArch of ['x86', 'ia32', 'i386', 'i686', 'ARM', ' arm32 ']) {
    const allocation = effectiveMemory({ memoryMode: 'manual', memoryMb: 8192 }, { ...runtime, javaArch }, system(32768, 24576))
    assert.equal(allocation.effectiveMb, 1024)
    assert.equal(allocation.safeMaxMb, 1024)
    assert.match(allocation.reason, /32 位 Java/)
  }
  for (const javaArch of ['x64', 'amd64', 'aarch64', 'arm64']) {
    assert.equal(effectiveMemory({ memoryMb: 8192 }, { ...runtime, javaArch }, system(32768, 24576)).effectiveMb, 4096)
  }
})

test('platform snapshots remain conservative and explicitly describe the free-versus-reclaimable distinction', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const info = getMemoryInfo(runtime, system(16384, 4096, platform))
    assert.equal(info.availableMb, 4096)
    assert.equal(info.availableBasis, 'free-memory-conservative')
    assert.equal(info.recommendedMb, 2304)
    assert.match(info.reason, /不含.*可回收缓存/)
  }
})

test('invalid or failing memory providers fail safely without inventing RAM or exposing native errors', () => {
  const invalidSources: MemorySystem[] = [
    { totalmem: () => NaN, freemem: () => 4096 * MIB },
    { totalmem: () => Infinity, freemem: () => 4096 * MIB },
    { totalmem: () => 0, freemem: () => 4096 * MIB },
    { totalmem: () => 8192 * MIB, freemem: () => -1 },
    { totalmem: () => 8192 * MIB, freemem: () => NaN },
    { totalmem: () => { throw new Error('private/native/path') } },
  ]
  for (const source of invalidSources) {
    assert.throws(() => getMemoryInfo(runtime, source), (error: unknown) => {
      assert.ok(error instanceof MemoryAllocationError)
      assert.equal(error.code, 'MEMORY_INFO_UNAVAILABLE')
      assert.ok(!error.message.includes('private/native/path'))
      return true
    })
  }
})

test('a contradictory free-memory snapshot is bounded by physical RAM', () => {
  const normal = getMemoryInfo(runtime, system(4096, 4096))
  const inconsistent = getMemoryInfo(runtime, system(4096, 64000))
  assert.equal(inconsistent.availableMb, normal.totalMb)
  assert.equal(inconsistent.safeMaxMb, normal.safeMaxMb)
  assert.equal(inconsistent.recommendedMb, normal.recommendedMb)
})

test('invalid manual preferences and unknown modes are rejected before applying any memory', () => {
  for (const memoryMb of [0, 512, 1023, 65537, 1024.5, NaN, Infinity]) {
    assert.throws(() => effectiveMemory({ memoryMode: 'manual', memoryMb }, runtime, system(32768, 24576)), { code: 'INVALID_MEMORY_SETTINGS' })
  }
  const invalid = { memoryMode: 'unlimited', memoryMb: 4096 } as unknown as MemorySettings
  assert.throws(() => effectiveMemory(invalid, runtime, system(32768, 24576)), { code: 'INVALID_MEMORY_SETTINGS' })
})

test('allocation bounds leave the documented native and OS headroom over small and large machines', () => {
  for (const totalMb of [1024, 2048, 4096, 8192, 16384, 32768, 131072]) {
    for (const ratio of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
      const source = system(totalMb, Math.floor(totalMb * ratio))
      const info = getMemoryInfo(runtime, source)
      assert.ok(info.safeMaxMb >= 0 && info.safeMaxMb <= 65536)
      if (!info.canLaunch) continue
      for (const memoryMode of ['auto', 'manual'] as const) {
        const result = effectiveMemory({ memoryMode, memoryMb: 65536 }, runtime, source)
        const estimatedProcessMb = result.effectiveMb * 1.25 + 512
        assert.ok(result.effectiveMb >= 1024)
        assert.ok(result.effectiveMb <= result.safeMaxMb)
        assert.ok(estimatedProcessMb + result.reservedMb <= result.totalMb)
        assert.ok(estimatedProcessMb + 512 <= result.availableMb)
      }
    }
  }
})

test('OS available memory takes priority and includes reclaimable pages without exceeding physical RAM', () => {
  const system = { totalmem: () => 16 * 1024 ** 3, freemem: () => 128 * 1024 ** 2, availablemem: () => 6 * 1024 ** 3 }
  const info = getMemoryInfo({ gameVersion: '1.20.1' }, system)
  assert.equal(info.availableBasis, 'os-available')
  assert.equal(info.availableMb, 6144)
  assert.equal(info.canLaunch, true)
  assert.equal(info.recommendedMb, 4096)
  assert.equal(getMemoryInfo({}, { ...system, availablemem: () => 32 * 1024 ** 3 }).availableMb, 16384)
})
