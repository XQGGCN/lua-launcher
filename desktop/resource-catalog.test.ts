import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RESOURCE_ZIP_BYTES, assertResourceSelection, normalizeResourceSearch, parseResourceProject,
  prepareResourceVersion, resourceFilename, resourceSearchParameters, resourceVersionsParameters,
  validateResourceSelection, type ResourceContext, type ResourceInstallInput, type ResourceKind,
} from './resource-catalog'

// Public API-shaped data only. These bytes are fictitious metadata, never a download fixture.
const sha512 = 'a'.repeat(128)
const sha1 = 'b'.repeat(40)
function context(overrides: Partial<ResourceContext> = {}): ResourceContext {
  return { source: 'modrinth', kind: 'resourcepack', projectId: 'projectA', gameVersion: '1.20.1', ...overrides }
}
function file(overrides: Record<string, unknown> = {}) {
  return { filename: '资源包 32x.zip', url: 'https://cdn.modrinth.com/data/projectA/versions/versionA/pack.zip',
    size: 1234, primary: true, file_type: null, hashes: { sha512, sha1 }, ...overrides }
}
function version(overrides: Record<string, unknown> = {}) {
  return { id: 'versionA', project_id: 'projectA', name: 'Pack version A',
    game_versions: ['1.20.1'], loaders: ['minecraft'], dependencies: [], files: [file()], ...overrides }
}
function selection(overrides: Partial<ResourceInstallInput> = {}): ResourceInstallInput {
  return { kind: 'resourcepack', source: 'modrinth', projectId: 'projectA', versionId: 'versionA',
    filename: '资源包 32x.zip', sha512, ...overrides }
}
function searchHit(overrides: Record<string, unknown> = {}) {
  return { project_id: 'projectA', slug: 'example-pack', project_type: 'resourcepack',
    title: 'Example pack', description: 'Local test metadata', author: 'Example author',
    downloads: 42, categories: ['minecraft', '16x'],
    icon_url: 'https://cdn.modrinth.com/data/projectA/icon.png', ...overrides }
}
function search(overrides: Record<string, unknown> = {}) {
  return { hits: [searchHit()], total_hits: 1, offset: 0, limit: 20, ...overrides }
}
function assertExternal(raw: unknown, ctx = context()) {
  const result = prepareResourceVersion(raw, ctx)
  assert.equal(result.info.externalOnly, true)
  assert.equal(result.artifact, undefined)
  assert.ok(result.info.externalReason && result.info.externalReason.length > 0)
  assert.equal(result.info.filename, undefined)
  assert.equal(result.info.sha512, undefined)
  return result.info
}

test('search facets separate resource kind, Minecraft version and shader engines without using Fabric/Forge', () => {
  const packs = resourceSearchParameters('中文 & textures', { kind: 'resourcepack', gameVersion: '1.20.1', offset: 20 })
  assert.equal(packs.get('query'), '中文 & textures')
  assert.deepEqual(JSON.parse(packs.get('facets')!), [['project_type:resourcepack'], ['versions:1.20.1']])
  assert.equal(packs.get('offset'), '20')
  assert.equal(packs.get('limit'), '20')
  assert.equal(packs.get('index'), 'relevance')
  const shaders = resourceSearchParameters('', { kind: 'shader', gameVersion: '1.20.1' })
  assert.deepEqual(JSON.parse(shaders.get('facets')!),
    [['project_type:shader'], ['categories:iris', 'categories:optifine'], ['versions:1.20.1']])
  assert.equal(shaders.get('index'), 'downloads')
  assert.equal(shaders.get('offset'), '0')
  assert.ok(!shaders.toString().includes('fabric') && !shaders.toString().includes('forge'))
})

test('version queries request minecraft for resource packs and only Iris/OptiFine for shaders', () => {
  for (const [kind, expected] of [['resourcepack', ['minecraft']], ['shader', ['iris', 'optifine']]] as const) {
    const params = resourceVersionsParameters(kind, '1.20.1')
    assert.deepEqual(JSON.parse(params.get('loaders')!), expected)
    assert.deepEqual(JSON.parse(params.get('game_versions')!), ['1.20.1'])
    assert.equal(params.get('include_changelog'), 'false')
  }
})

test('request builders reject unsupported kinds, query controls, invalid offsets and version injection', () => {
  for (const kind of ['mod', 'datapack', 'world', '__proto__', '', null]) {
    assert.throws(() => resourceSearchParameters('', { kind: kind as ResourceKind }))
    assert.throws(() => resourceVersionsParameters(kind as ResourceKind, '1.20.1'))
  }
  for (const query of ['x'.repeat(201), 'line\nbreak', '\0', 2]) {
    assert.throws(() => resourceSearchParameters(query as string, { kind: 'resourcepack' }))
  }
  for (const offset of [-1, 0.5, 100001, Infinity, NaN]) {
    assert.throws(() => resourceSearchParameters('', { kind: 'resourcepack', offset }))
  }
  for (const gameVersion of ['../1.20.1', '1.20.1&loaders=forge', '1.20.1\n', 'x'.repeat(81)]) {
    assert.throws(() => resourceVersionsParameters('resourcepack', gameVersion))
    assert.throws(() => resourceSearchParameters('', { kind: 'resourcepack', gameVersion }))
  }
})

test('project metadata confirms both stable project identity and requested kind', () => {
  const raw = { id: 'projectA', title: 'Example', description: 'Description', project_type: 'resourcepack' }
  assert.deepEqual(parseResourceProject(raw, context()), {
    id: 'projectA', title: 'Example', description: 'Description', kind: 'resourcepack',
    projectUrl: 'https://modrinth.com/resourcepack/projectA',
  })
  assert.equal(parseResourceProject({ ...raw, project_type: 'shader' }, context({ kind: 'shader', source: 'bbsmc' })).projectUrl,
    'https://bbsmc.net/shader/projectA')
  for (const value of [{ ...raw, id: 'otherProject' }, { ...raw, project_type: 'mod' },
    { ...raw, project_type: 'datapack' }, { ...raw, project_type: 'world' }, { ...raw, project_type: undefined }]) {
    assert.throws(() => parseResourceProject(value, context()), /项目|类型/)
  }
  assert.throws(() => parseResourceProject(raw, context({ projectId: '../outside' })))
  assert.throws(() => parseResourceProject(raw, context({ source: 'other' as ResourceContext['source'] })))
})

test('valid metadata yields a detached artifact with required SHA-512 and optional normalized SHA-1', () => {
  const raw = version({ files: [file({ hashes: { sha512: sha512.toUpperCase(), sha1: sha1.toUpperCase() } })] })
  const before = structuredClone(raw)
  const result = prepareResourceVersion(raw, context())
  assert.equal(result.info.externalOnly, false)
  assert.equal(result.info.externalReason, undefined)
  assert.deepEqual(result.artifact, { ...selection(), url: file().url, size: 1234, sha1 })
  assert.deepEqual(raw, before)
  result.info.gameVersions.push('changed')
  result.info.loaders[0] = 'changed'
  assert.deepEqual(raw.game_versions, ['1.20.1'])
  assert.deepEqual(raw.loaders, ['minecraft'])
  const noSha1 = prepareResourceVersion(version({ files: [file({ hashes: { sha512 } })] }), context())
  assert.equal(noSha1.artifact!.sha512, sha512)
  assert.equal(Object.hasOwn(noSha1.artifact!, 'sha1'), false)
})

test('resource compatibility is checked against the selected instance and supported engine family', () => {
  assertExternal(version({ game_versions: ['1.21.1'] }))
  for (const loaders of [[], ['fabric'], ['forge'], ['datapack'], ['vanilla'], ['iris']]) {
    assertExternal(version({ loaders }))
  }
  for (const loaders of [['iris'], ['optifine'], ['iris', 'optifine']]) {
    assert.equal(prepareResourceVersion(version({ loaders }), context({ kind: 'shader' })).info.externalOnly, false)
  }
  for (const loaders of [[], ['canvas'], ['vanilla'], ['fabric'], ['forge'], ['minecraft'], ['canvas', 'vanilla']]) {
    assertExternal(version({ loaders }), context({ kind: 'shader' }))
  }
})

test('version identity, lists and dependency structures are rejected rather than treated as compatible defaults', () => {
  for (const changes of [
    { id: '../bad' }, { project_id: 'otherProject' }, { game_versions: undefined }, { game_versions: '1.20.1' },
    { game_versions: ['1.20.1', null] }, { loaders: 'minecraft' }, { loaders: [1] },
    { dependencies: undefined }, { dependencies: {} }, { dependencies: [null] },
    { dependencies: [{ dependency_type: 'future-type' }] },
    { dependencies: [{ dependency_type: ['required'] }] },
    { dependencies: [{ dependency_type: ['incompatible'] }] },
    { dependencies: [{ dependency_type: 'optional', project_id: '../project' }] },
    { dependencies: [{ dependency_type: 'optional', version_id: 123 }] },
    { dependencies: [{ dependency_type: 'optional', file_name: 'bad\nname' }] },
    { disk_only: 'false' }, { files: undefined }, { files: {} }, { files: [null] },
    { files: [file({ primary: 'true' })] }, { files: [file({ file_type: 1 })] },
  ]) {
    assert.throws(() => prepareResourceVersion(version(changes), context()), JSON.stringify(changes))
  }
})

test('required and incompatible dependencies are external-only while optional/embedded remain descriptive', () => {
  for (const dependency_type of ['required', 'incompatible']) {
    const info = assertExternal(version({ dependencies: [{ dependency_type, project_id: 'dependencyA', version_id: null, file_name: null }] }))
    assert.deepEqual(info.dependencies, [{ type: dependency_type, projectId: 'dependencyA' }])
  }
  const result = prepareResourceVersion(version({ dependencies: [
    { dependency_type: 'optional', project_id: 'optionalProject', version_id: null, file_name: null },
    { dependency_type: 'embedded', project_id: null, version_id: 'embeddedVersion', file_name: 'embedded.zip' },
  ] }), context())
  assert.equal(result.info.externalOnly, false)
  assert.deepEqual(result.info.dependencies, [
    { type: 'optional', projectId: 'optionalProject' },
    { type: 'embedded', versionId: 'embeddedVersion', filename: 'embedded.zip' },
  ])
})

test('disk-only BBS metadata stays external even if a superficially usable file is included', () => {
  const ctx = context({ source: 'bbsmc' })
  assertExternal(version({ disk_only: true, files: [{ filename: '', hashes: {}, size: 0, primary: false,
    url: 'https://www.curseforge.com/minecraft/texture-packs/example/download/123', file_type: null }] }), ctx)
  assertExternal(version({ disk_only: true, files: [file({ url: 'https://cdn.bbsmc.net/data/projectA/pack.zip' })] }), ctx)
  assert.equal(prepareResourceVersion(version({ disk_only: false,
    files: [file({ url: 'https://cdn.bbsmc.net/data/projectA/pack.zip' })] }), ctx).info.externalOnly, false)
})

test('SHA-512 is mandatory and every supplied hash must have the exact hexadecimal shape', () => {
  for (const hashes of [undefined, null, [], {}, { sha1 }, { sha512: 'a'.repeat(127) }, { sha512: 'a'.repeat(129) },
    { sha512: 'g'.repeat(128) }, { sha512: 123 }, { sha512: ` ${sha512}` }, { sha512, sha1: null },
    { sha512, sha1: 'b'.repeat(39) }, { sha512, sha1: 'z'.repeat(40) }, { sha512, sha1: 123 }]) {
    assertExternal(version({ files: [file({ hashes })] }))
  }
})

test('sizes must be positive safe integers within the explicit ZIP cap', () => {
  for (const size of [undefined, null, '1234', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, RESOURCE_ZIP_BYTES + 1]) {
    assertExternal(version({ files: [file({ size })] }))
  }
  for (const size of [1, RESOURCE_ZIP_BYTES]) {
    assert.equal(prepareResourceVersion(version({ files: [file({ size })] }), context()).artifact!.size, size)
  }
})

test('each provider accepts only its own exact HTTPS CDN URL and normalizes benign URL casing', () => {
  for (const url of [
    'http://cdn.modrinth.com/pack.zip', 'https://cdn.modrinth.com.evil.test/pack.zip',
    'https://cdn.modrinth.com./pack.zip', 'https://user:pass@cdn.modrinth.com/pack.zip',
    'https://cdn.modrinth.com:444/pack.zip', 'https://cdn.modrinth.com/pack.zip#fragment',
    'https://api.modrinth.com/pack.zip', 'https://cdn.bbsmc.net/pack.zip',
    'https://127.0.0.1/pack.zip', 'file:///tmp/pack.zip', '/relative.zip', 'not a url',
  ]) assertExternal(version({ files: [file({ url })] }))
  assertExternal(version({ files: [file()] }), context({ source: 'bbsmc' }))
  const normalized = prepareResourceVersion(version({ files: [file({ url: 'https://CDN.MODRINTH.COM:443/pack.zip' })] }), context())
  assert.equal(normalized.artifact!.url, 'https://cdn.modrinth.com/pack.zip')
})

test('safe multilingual ZIP basenames survive verbatim while traversal, device and Unicode-control names fail', () => {
  for (const name of ['Pack.zip', '资源包 32x.zip', 'FreshAnimations_1.20+.ZIP', 'emoji-🌙.zip', 'a'.repeat(251) + '.zip']) {
    assert.equal(resourceFilename(name), name)
  }
  for (const name of ['', '.', '..', '../pack.zip', '/pack.zip', 'folder/pack.zip', 'folder\\pack.zip',
    'C:pack.zip', 'pack:stream.zip', 'CON.zip', 'nul.ZIP', 'COM1.zip', 'LPT².zip', 'clock$.zip',
    'pack.zip ', 'pack.zip.', 'pack\n.zip', 'pack\0.zip', 'pack\u202e.zip', 'pack\u2066.zip',
    'unpaired-\ud800.zip', 'replacement-\ufffd.zip', 'a'.repeat(252) + '.zip', '汉'.repeat(84) + '.zip',
    'script.jar', 'pack.zip.exe', 'pack?.zip']) {
    assert.throws(() => resourceFilename(name), name)
    assertExternal(version({ files: [file({ filename: name })] }))
  }
})

test('a unique primary main ZIP is selected independently of file ordering', () => {
  const main = file({ filename: 'selected.zip' })
  const alternative = file({ filename: 'alternative.zip', primary: false })
  const auxiliary = file({ filename: 'required-resources.zip', primary: false, file_type: 'required-resource-pack' })
  for (const files of [[alternative, main, auxiliary], [auxiliary, alternative, main]]) {
    assert.equal(prepareResourceVersion(version({ files }), context()).artifact!.filename, 'selected.zip')
  }
})

test('auxiliary or non-ZIP primary files cannot silently fall back to another ZIP', () => {
  for (const file_type of ['required-resource-pack', 'optional-resource-pack', 'sources-jar', 'unknown', 'future-aux']) {
    assertExternal(version({ files: [file({ file_type }), file({ filename: 'fallback.zip', primary: false })] }))
  }
  assertExternal(version({ files: [file({ filename: 'primary.jar' }), file({ filename: 'fallback.zip', primary: false })] }))
})

test('without a primary only one main ZIP is eligible; empty and ambiguous choices stay external', () => {
  const main = file({ filename: 'single.zip', primary: false })
  const auxiliary = file({ filename: 'extra.zip', primary: false, file_type: 'optional-resource-pack' })
  assert.equal(prepareResourceVersion(version({ files: [auxiliary, main] }), context()).artifact!.filename, 'single.zip')
  assertExternal(version({ files: [] }))
  assertExternal(version({ files: [auxiliary] }))
  assertExternal(version({ files: [main, file({ filename: 'other.zip', primary: false })] }))
  assertExternal(version({ files: [file(), file({ filename: 'another-primary.zip' })] }))
})

test('selection validation accepts only fixed identity fields and canonical hash casing', () => {
  assert.deepEqual(validateResourceSelection(selection({ sha512: sha512.toUpperCase() })), selection())
  for (const raw of [null, [], 'input', { ...selection(), url: file().url }, { ...selection(), destination: '/tmp/other' },
    { ...selection(), kind: 'datapack' }, { ...selection(), source: '__proto__' },
    { ...selection(), projectId: '../outside' }, { ...selection(), versionId: '' },
    { ...selection(), filename: '../pack.zip' }, { ...selection(), sha512: 'bad' }]) {
    assert.throws(() => validateResourceSelection(raw))
  }
})

test('fresh metadata must match every selected identity field, filename and hash before installation', () => {
  const artifact = prepareResourceVersion(version(), context()).artifact!
  assert.doesNotThrow(() => assertResourceSelection(validateResourceSelection(selection()), artifact))
  for (const changed of [
    { kind: 'shader' as const }, { source: 'bbsmc' as const }, { projectId: 'projectB' },
    { versionId: 'versionB' }, { filename: 'different.zip' }, { sha512: 'c'.repeat(128) },
  ]) assert.throws(() => assertResourceSelection(selection(changed), artifact), /变化|重新/)
})

test('search results preserve legitimate provider slugs and sanitize unrelated image hosts', () => {
  for (const slug of ['example-pack', 'resource.pack+32x', "artist's-pack", 'pack_name']) {
    const result = normalizeResourceSearch(search({ hits: [searchHit({ slug })] }), 'resourcepack', 'modrinth')
    assert.equal(result.hits[0].slug, slug)
    assert.equal(result.hits[0].icon_url, searchHit().icon_url)
  }
  for (const icon_url of ['https://example.com/track.png', 'http://cdn.modrinth.com/icon.png',
    'https://user@cdn.modrinth.com/icon.png', 'data:image/svg+xml,<svg/>']) {
    assert.equal(normalizeResourceSearch(search({ hits: [searchHit({ icon_url })] }), 'resourcepack', 'modrinth').hits[0].icon_url, null)
  }
  assert.equal(normalizeResourceSearch(search({ hits: [searchHit({ icon_url: 'https://cdn.bbsmc.net/icon.png' })] }),
    'resourcepack', 'bbsmc').hits[0].icon_url, 'https://cdn.bbsmc.net/icon.png')
})

test('search normalization rejects missing or malformed types, duplicate IDs and malformed counts instead of inventing hits', () => {
  for (const raw of [
    null, [], {}, search({ hits: {} }), search({ hits: [searchHit(), searchHit()] }),
    search({ hits: [searchHit({ project_type: undefined })] }), search({ hits: [searchHit({ project_type: ['shader'] })] }),
    search({ hits: [searchHit({ project_types: 'shader' })] }),
    search({ hits: [searchHit({ project_id: '../outside' })] }), search({ hits: [searchHit({ downloads: -1 })] }),
    search({ hits: [searchHit({ downloads: NaN })] }), search({ hits: [searchHit({ categories: 'minecraft' })] }),
    search({ total_hits: -1 }), search({ offset: 0.5 }), search({ limit: 0 }), search({ limit: 101 }),
  ]) assert.throws(() => normalizeResourceSearch(raw, 'resourcepack', 'modrinth'))
  assert.deepEqual(normalizeResourceSearch(search({ hits: [], total_hits: 0 }), 'resourcepack', 'modrinth').hits, [])
})

test('BBS shader search filters a mismatched resource-pack hit without relabelling it or changing upstream pagination', () => {
  // Minimal fields reproducing the official API's 2026-10-21 mixed first page:
  // RBkrnJx3 is a resourcepack despite being returned for shader + optifine facets.
  const good = searchHit({ project_id: 'G1gv6McS', project_type: 'shader', categories: ['iris', 'optifine'] })
  const other = searchHit({ project_id: 'RBkrnJx3', project_type: 'resourcepack', categories: ['minecraft', 'optifine'] })
  const raw = search({ hits: [good, other], total_hits: 495, offset: 0, limit: 20 })
  const before = structuredClone(raw)
  const result = normalizeResourceSearch(raw, 'shader', 'bbsmc')
  assert.deepEqual(result.hits.map(hit => hit.project_id), ['G1gv6McS'])
  assert.equal(result.hits[0].project_type, 'shader')
  assert.equal(result.total_hits, 495)
  assert.equal(result.offset, 0)
  assert.equal(result.limit, 20)
  assert.equal(result.omittedHits, 1)
  assert.deepEqual(raw, before)
  const emptyPage = normalizeResourceSearch(search({ hits: [other], total_hits: 495, offset: 20, limit: 20 }), 'shader', 'bbsmc')
  assert.deepEqual(emptyPage.hits, [])
  assert.equal(emptyPage.omittedHits, 1)
  assert.equal(emptyPage.offset + emptyPage.limit, 40)
  assert.throws(() => parseResourceProject({ id: 'RBkrnJx3', title: 'Other resource', description: '', project_type: 'resourcepack' },
    { source: 'bbsmc', kind: 'shader', projectId: 'RBkrnJx3' }), /类型不匹配/)
  assert.throws(() => normalizeResourceSearch(search({ hits: [good, good] }), 'shader', 'bbsmc'), /重复/)
})

test('public descriptions accept bounded newlines and tabs while identity fields and unsafe controls stay strict', () => {
  const description = '第一行\r\nSecond line\n\tTabbed explanation'
  for (const source of ['modrinth', 'bbsmc'] as const) {
    assert.equal(normalizeResourceSearch(search({ hits: [searchHit({ description })] }), 'resourcepack', source).hits[0].description, description)
    assert.equal(parseResourceProject({ id: 'projectA', title: 'Project', description, project_type: 'resourcepack' }, context({ source })).description, description)
    for (const invalid of ['bad\u0000text', 'bad\u000btext', 'bad\u001btext', 'bad\u007ftext', 'a'.repeat(4001)]) {
      assert.throws(() => normalizeResourceSearch(search({ hits: [searchHit({ description: invalid })] }), 'resourcepack', source))
    }
    assert.throws(() => normalizeResourceSearch(search({ hits: [searchHit({ title: 'Bad\ntitle' })] }), 'resourcepack', source))
    assert.throws(() => validateResourceSelection(selection({ projectId: 'bad\nid' })))
  }
})

test('metadata objects with accessors or foreign prototypes fail without invoking getters', () => {
  let calls = 0
  const accessor = Object.defineProperty({}, 'project_id', { get: () => { calls++; return 'projectA' }, enumerable: true })
  assert.throws(() => prepareResourceVersion(accessor, context()))
  assert.throws(() => validateResourceSelection(accessor))
  assert.throws(() => parseResourceProject(Object.assign(Object.create({ injected: true }), { id: 'projectA' }), context()))
  assert.equal(calls, 0)
})
