import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { parseModpack } from './modpack'
import { createModpackPlan, modpackPlanPage, applyOptionalSelection, MODPACK_PLAN_LIMITS } from './modpack-plan'

const hashes = (value: string) => ({ sha1: createHash('sha1').update(value).digest('hex'), sha512: createHash('sha512').update(value).digest('hex') })
function file(path: string, value: string, client?: string, server = 'required') {
  return { path, downloads: ['https://cdn.modrinth.com/original-inert-fixture?private-download-query=not-for-ui'], hashes: hashes(value), fileSize: Buffer.byteLength(value),
    ...(client === undefined ? {} : { env: { client, server } }) }
}
function archive(files: unknown[] = [], entries: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const zip = new AdmZip()
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', name: 'Original plan fixture', versionId: '1.0',
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' }, files, ...extra })))
  for (const [name, data] of Object.entries(entries)) zip.addFile(name, Buffer.from(data))
  return zip.toBuffer()
}
function mixedArchive() {
  return archive([file('mods/required.jar', 'REQ', 'required'), file('mods/implicit.jar', 'IMPLICIT'), file('mods/optional-a.jar', 'OPT-A', 'optional'),
    file('mods/optional-b.jar', 'OPT-BB', 'optional'), file('mods/server.jar', 'SERVER', 'unsupported'), file('config/shared.txt', 'OLD-INDEX', 'optional')],
  { 'overrides/config/shared.txt': 'SHARED', 'client-overrides/config/shared.txt': 'FINAL-CLIENT', 'overrides/options.txt': 'OPTIONS', 'server-overrides/server.properties': 'SERVER-ONLY' })
}

test('plan retains exact required/optional/server and shared/client override provenance', () => {
  const parsed = parseModpack(mixedArchive()), plan = createModpackPlan(parsed), page = modpackPlanPage(plan, { includeExcluded: true })
  assert.equal(page.total, 10); assert.equal(page.items.length, 10)
  assert.deepEqual(page.counts, { requiredFiles: 2, optionalFiles: 2, selectedOptionalFiles: 2, skippedOptionalFiles: 0, downloadFiles: 4,
    downloadBytes: 3 + 8 + 5 + 6, overrideFiles: 2, overrideBytes: 12 + 7, writeFiles: 6, writeBytes: 3 + 8 + 5 + 6 + 12 + 7, excludedFiles: 2, shadowedFiles: 2 })
  assert.equal(plan.summary.defaultOptionalIds.length, 2)
  const implicit = page.items.find(row => row.path === 'mods/implicit.jar')!
  assert.deepEqual(implicit.environment, { client: 'required', server: 'required', implicit: true }); assert.equal(implicit.role, 'required')
  const server = page.items.find(row => row.origin === 'server-overrides')!
  assert.equal(server.effective, false); assert.equal(server.sizeBasis, 'declared-archive'); assert.equal(server.sha512, undefined)
  assert.equal(page.items.find(row => row.origin === 'client-overrides')!.sizeBasis, 'verified-archive')
})
test('client override supersedes shared and optional index without a selectable shadowed checkbox', () => {
  const plan = createModpackPlan(parseModpack(mixedArchive())), rows = modpackPlanPage(plan, { query: 'config/shared.txt', includeExcluded: true }).items
  assert.equal(rows.length, 3)
  const index = rows.find(row => row.origin === 'indexed')!, shared = rows.find(row => row.origin === 'overrides')!, client = rows.find(row => row.origin === 'client-overrides')!
  assert.equal(index.selectable, false); assert.equal(shared.effective, false); assert.equal(client.effective, true)
  assert.equal(index.shadowedBy, shared.id); assert.equal(shared.shadowedBy, client.id)
  assert.deepEqual(client.shadows, [index.id, shared.id])
  assert.equal(index.shadowedByOrigin, 'overrides'); assert.equal(shared.shadowedByOrigin, 'client-overrides'); assert.deepEqual(client.shadowOrigins, ['indexed', 'overrides'])
  const installed = applyOptionalSelection(plan, [])
  assert.equal(installed.files.some(row => row.path === index.path), false)
  assert.equal(installed.overrides.find(row => row.path === index.path)!.data.toString(), 'FINAL-CLIENT')
})
test('all, none and one effective optional selection produce exact compatible install files and bytes', () => {
  const plan = createModpackPlan(parseModpack(mixedArchive())), ids = plan.summary.defaultOptionalIds
  assert.equal(applyOptionalSelection(plan, ids).files.length, 4)
  const none = applyOptionalSelection(plan, []); assert.deepEqual(none.files.map(row => row.path), ['mods/required.jar', 'mods/implicit.jar'])
  assert.equal(none.preview.fileCount, 4); assert.equal(none.preview.optionalFileCount, 0); assert.equal(none.preview.totalBytes, 3 + 8 + 12 + 7)
  const one = applyOptionalSelection(plan, [ids[1]])
  assert.deepEqual(one.files.map(row => row.path), ['mods/required.jar', 'mods/implicit.jar', 'mods/optional-b.jar'])
  assert.equal(one.preview.optionalFileCount, 1); assert.equal(one.preview.totalBytes, none.preview.totalBytes + 6)
  assert.equal(one.preview.minecraftVersion, '1.21.1'); assert.equal(one.preview.loaderVersion, '0.16.10')
})
test('summary defaults all optional but explicit empty page selection means none across every page', () => {
  const plan = createModpackPlan(parseModpack(mixedArchive()))
  assert.equal(modpackPlanPage(plan).counts.selectedOptionalFiles, 2)
  const page = modpackPlanPage(plan, { role: 'optional', selectedOptionalIds: [], limit: 1 })
  assert.equal(page.items.length, 1); assert.equal(page.items[0].selected, false); assert.equal(page.counts.selectedOptionalFiles, 0); assert.equal(page.counts.skippedOptionalFiles, 2)
})
test('IDs and digest are stable for identical bytes and differ for any different archive', () => {
  const bytes = mixedArchive(), first = createModpackPlan(parseModpack(bytes)), second = createModpackPlan(parseModpack(Buffer.from(bytes)))
  assert.deepEqual(first.summary, second.summary); assert.deepEqual(first.rows, second.rows)
  const different = createModpackPlan(parseModpack(archive([file('mods/optional-a.jar', 'OPT-A', 'optional')], {}, { versionId: 'different' })))
  assert.notEqual(different.summary.archiveSha512, first.summary.archiveSha512); assert.notEqual(different.summary.planDigest, first.summary.planDigest)
  assert.equal(first.rows.some(row => row.id === different.rows[0].id), false)
  for (const row of first.rows) assert.match(row.id, /^[a-f0-9]{64}$/)
})
test('unknown, duplicated, required, shadowed, excluded and foreign IDs all reject rather than silently changing selection', () => {
  const plan = createModpackPlan(parseModpack(mixedArchive())), id = plan.summary.defaultOptionalIds[0]
  const forbidden = plan.rows.filter(row => !row.selectable).map(row => row.id)
  for (const ids of [[id, id], ['unknown'], ...forbidden.map(value => [value])]) {
    assert.throws(() => applyOptionalSelection(plan, ids), /重复|不可选择/)
    assert.throws(() => modpackPlanPage(plan, { selectedOptionalIds: ids }))
  }
  assert.throws(() => applyOptionalSelection(plan, undefined as never), /有效的可选文件/)
  const foreign = createModpackPlan(parseModpack(archive([file('mods/a.jar', 'A', 'optional')]))).summary.defaultOptionalIds[0]
  assert.throws(() => applyOptionalSelection(plan, [foreign]))
})
test('unknown and incomplete env cannot be hidden by optional deselection; hashes and paths remain validated', () => {
  for (const env of [{ client: 'optional' }, { server: 'required' }, { client: 'unknown', server: 'required' }, { client: 'optional', server: 'required', futureSide: 'optional' }]) {
    const value = { ...file('mods/a.jar', 'A'), env }
    assert.throws(() => parseModpack(archive([value])), /环境/)
  }
  assert.throws(() => parseModpack(archive([file('../bad.jar', 'X', 'optional')])), /不安全/)
  assert.throws(() => parseModpack(archive([{ ...file('mods/a.jar', 'X', 'optional'), hashes: { sha1: 'x', sha512: 'y' } }])), /SHA-1/)
})
test('dedicated-server declarations are excluded independently of logical integrated-server play', () => {
  const plan = createModpackPlan(parseModpack(archive([file('mods/client.jar', 'C', 'optional', 'unsupported'), file('mods/server.jar', 'S', 'unsupported', 'required')],
    { 'server-overrides/server.properties': 'dedicated only' })))
  assert.equal(plan.summary.defaultOptionalIds.length, 1); assert.equal(plan.summary.counts.excludedFiles, 2)
  assert.deepEqual(applyOptionalSelection(plan, plan.summary.defaultOptionalIds).files.map(row => row.path), ['mods/client.jar'])
  assert.deepEqual(applyOptionalSelection(plan, []).files, [])
})
test('page limits, query length, offsets and unknown fields are bounded before returning rows', () => {
  const plan = createModpackPlan(parseModpack(mixedArchive()))
  for (const options of [{ limit: 101 }, { limit: 0 }, { limit: 1.5 }, { offset: -1 }, { offset: MODPACK_PLAN_LIMITS.rows + 1 }, { query: 'x'.repeat(201) }, { query: '\u202e' }, { includeExcluded: 'yes' }, { role: 'custom' }, { path: '/private' }]) {
    assert.throws(() => modpackPlanPage(plan, options as never))
  }
  assert.equal(modpackPlanPage(plan, { offset: 100 }).items.length, 0)
})
test('search and role filtering retain off-page selection and global counts', () => {
  const files = Array.from({ length: 112 }, (_, index) => file(`mods/optional-${String(index).padStart(3, '0')}.jar`, 'X', 'optional'))
  const plan = createModpackPlan(parseModpack(archive(files))), selectedIds = [plan.summary.defaultOptionalIds[0], plan.summary.defaultOptionalIds[111]]
  const page = modpackPlanPage(plan, { limit: 100, selectedOptionalIds: selectedIds })
  assert.equal(page.total, 112); assert.equal(page.nextOffset, 100); assert.equal(page.items.length, 100); assert.equal(page.counts.selectedOptionalFiles, 2)
  const last = modpackPlanPage(plan, { offset: 100, limit: 100, selectedOptionalIds: selectedIds })
  assert.equal(last.items.length, 12); assert.equal(last.items.at(-1)!.selected, true); assert.equal(last.nextOffset, undefined)
  const searched = modpackPlanPage(plan, { query: 'OPTIONAL-111', selectedOptionalIds: selectedIds, role: 'optional' })
  assert.equal(searched.total, 1); assert.equal(searched.counts.selectedOptionalFiles, 2)
  assert.equal(applyOptionalSelection(plan, selectedIds).files.length, 2)
})
test('default pages hide excluded and shadowed rows; explicit reveal preserves selected false and source roles', () => {
  const plan = createModpackPlan(parseModpack(mixedArchive()))
  assert.equal(modpackPlanPage(plan).total, 6)
  const revealed = modpackPlanPage(plan, { includeExcluded: true })
  assert.equal(revealed.total, 10); assert.ok(revealed.items.filter(row => !row.effective).every(row => !row.selected))
  assert.equal(modpackPlanPage(plan, { role: 'server-excluded' }).total, 0)
  assert.equal(modpackPlanPage(plan, { role: 'server-excluded', includeExcluded: true }).total, 2)
})
test('public summaries/pages never expose downloads, override payloads or private native paths', () => {
  const secret = 'ORIGINAL_CONFIG_CONTENT_NOT_FOR_PREVIEW', plan = createModpackPlan(parseModpack(archive([file('mods/a.jar', 'A', 'optional')], { 'overrides/config/private.txt': secret })))
  const text = JSON.stringify({ summary: plan.summary, page: modpackPlanPage(plan, { includeExcluded: true }) })
  assert.ok(!text.includes(secret)); assert.ok(!text.includes('private-download-query')); assert.ok(!text.includes('downloads')); assert.ok(!text.includes('data":'))
  assert.ok(plan.summary.counts.overrideBytes > 0); assert.equal(modpackPlanPage(plan).items.find(row => row.origin === 'overrides')!.hashBasis, 'archive-payload')
})
test('fabricated plans cannot apply arbitrary parsed bytes or obtain pages', () => {
  const plan = createModpackPlan(parseModpack(mixedArchive()))
  assert.throws(() => modpackPlanPage({ ...plan }), /规划无效/)
  assert.throws(() => applyOptionalSelection({ ...plan }, []), /规划无效/)
})
test('changed source archive or final override payload is rejected after preview', () => {
  const parsed = parseModpack(mixedArchive()), plan = createModpackPlan(parsed)
  parsed.archive[10] ^= 1
  assert.throws(() => applyOptionalSelection(plan, []), /归档.*变化/)
  const other = parseModpack(mixedArchive()), otherPlan = createModpackPlan(other)
  other.overrides[0].data[0] ^= 1
  assert.throws(() => applyOptionalSelection(otherPlan, []), /覆盖载荷.*变化/)
})
test('caller file-array/summary changes and applied-result edits do not change the private selection mapping', () => {
  const parsed = parseModpack(mixedArchive()), plan = createModpackPlan(parsed)
  parsed.files[0].downloads[0] = 'https://localhost/changed'; parsed.preview.name = 'changed'; parsed.provenance[0].path = 'mods/changed.jar'
  const installed = applyOptionalSelection(plan, [])
  assert.equal(installed.preview.name, 'Original plan fixture'); assert.ok(!installed.files[0].downloads[0].includes('localhost'))
  installed.files[0].path = 'mods/changed-result.jar'; installed.files[0].hashes.sha1 = 'changed'
  assert.equal(applyOptionalSelection(plan, []).files[0].path, 'mods/required.jar')
  assert.throws(() => { plan.summary.defaultOptionalIds.push('fake') })
})
test('max5000 optional IDs fit one bounded initial summary while pages stay limited to100 rows', () => {
  const files = Array.from({ length: 5000 }, (_, index) => file(`mods/original-${String(index).padStart(4, '0')}.jar`, 'X', 'optional'))
  const plan = createModpackPlan(parseModpack(archive(files))), page = modpackPlanPage(plan)
  assert.equal(plan.summary.defaultOptionalIds.length, 5000); assert.ok(Buffer.byteLength(JSON.stringify(plan.summary)) <= MODPACK_PLAN_LIMITS.summaryBytes)
  assert.equal(page.items.length, 100); assert.equal(page.total, 5000); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MODPACK_PLAN_LIMITS.pageBytes)
  assert.equal(applyOptionalSelection(plan, []).files.length, 0)
})
test('empty and unsupported packs remain previewable without expanding supported loader promises', () => {
  const empty = createModpackPlan(parseModpack(archive()))
  assert.deepEqual(empty.summary.defaultOptionalIds, []); assert.equal(modpackPlanPage(empty).total, 0); assert.equal(applyOptionalSelection(empty, []).preview.fileCount, 0)
  const unsupported = createModpackPlan(parseModpack(archive([], {}, { dependencies: { minecraft: '1.21.1', 'quilt-loader': '1' } })))
  assert.match(unsupported.summary.preview.unsupportedReason ?? '', /quilt-loader/)
})
test('Unicode-normalized search is presentation only and cannot permit conflicting output names', () => {
  const composed = 'config/caf\u00e9.txt', decomposed = 'config/cafe\u0301.txt'
  const plan = createModpackPlan(parseModpack(archive([file(composed, 'X', 'optional')])))
  assert.equal(modpackPlanPage(plan, { query: decomposed }).total, 1)
  assert.throws(() => parseModpack(archive([file(composed, 'X', 'optional'), file(decomposed, 'Y', 'optional')])), /冲突/)
})
