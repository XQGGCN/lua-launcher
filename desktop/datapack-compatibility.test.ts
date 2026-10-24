import assert from 'node:assert/strict'
import test from 'node:test'
import { datapackCompatibility } from './datapack-compatibility'
import type { DatapackMetadata } from './datapack-types'

const metadata = (patch: Partial<DatapackMetadata> = {}): DatapackMetadata => ({
  description: 'Original inert metadata', formatSummary: '48', features: [], overlays: [], warnings: [], packFormat: 48, ...patch,
})
test('only exact primary-sourced game versions receive a declared format assessment', () => {
  assert.equal(datapackCompatibility(metadata(), '1.21').status, 'declared-compatible')
  for (const version of ['1.21.1', '1.21.0', '24w18a', '48', '__proto__', 'toString', undefined]) {
    assert.equal(datapackCompatibility(metadata(), version).status, 'unknown')
  }
  assert.equal(datapackCompatibility(metadata(), '1.20.2').status, 'declared-incompatible')
})
test('legacy ranges must contain pack_format; new fields do not supply an old-version declaration', () => {
  assert.equal(datapackCompatibility(metadata({ packFormat: 18, supportedFormats: [18, 48] }), '1.20.2').status, 'declared-compatible')
  assert.equal(datapackCompatibility(metadata({ packFormat: 18, supportedFormats: [20, 48] }), '1.21').status, 'unknown')
  assert.equal(datapackCompatibility(metadata({ packFormat: undefined, minFormat: [18, 0], maxFormat: [88, null] }), '1.20.2').status, 'declared-incompatible')
})
test('new major/minor lower and upper endpoints use distinct scalar semantics', () => {
  const modern = metadata({ packFormat: undefined, minFormat: [88, 0], maxFormat: [88, null] })
  assert.equal(datapackCompatibility(modern, '1.21.9').status, 'declared-compatible')
  assert.equal(datapackCompatibility({ ...modern, minFormat: [88, 1] }, '1.21.9').status, 'declared-incompatible')
  assert.equal(datapackCompatibility({ ...modern, minFormat: [89, 0] }, '1.21.9').status, 'unknown')
  assert.equal(datapackCompatibility(metadata(), '1.21.9').status, 'declared-incompatible')
})
test('cross-generation and removed-field constraints cannot produce a false compatible result', () => {
  const modern = metadata({ minFormat: [80, 0], maxFormat: [88, null], packFormat: 48 })
  assert.equal(datapackCompatibility(modern, '1.21.9').status, 'unknown')
  assert.equal(datapackCompatibility({ ...modern, supportedFormats: [48, 88] }, '1.21.9').status, 'declared-compatible')
  assert.equal(datapackCompatibility({ ...modern, minFormat: [88, 0], supportedFormats: [48, 88] }, '1.21.9').status, 'unknown')
})
test('unsupported inspection or unresolved features overlays and extensions stay unknown', () => {
  for (const patch of [{ features: ['minecraft:bundle'] }, { overlays: ['future'] }, { warnings: ['unknown extension'] }]) {
    assert.equal(datapackCompatibility(metadata(patch), '1.21').status, 'unknown')
  }
  assert.equal(datapackCompatibility(metadata(), '1.21', 'unsupported').status, 'unknown')
  assert.equal(datapackCompatibility(undefined, '1.21').status, 'unknown')
})
