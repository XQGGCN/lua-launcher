import assert from 'node:assert/strict'
import test from 'node:test'
import { parseModMetadata, MOD_METADATA_LIMITS } from './mod-metadata'

const bytes = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
const fabric = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, id: 'original_mod', version: '1.0-custom', ...extra })
const quilt = (extra: Record<string, unknown> = {}) => ({ schema_version: 1, quilt_loader: { group: 'original.example', id: 'original_quilt', version: '1.2.0', ...extra } })
function read(path: string, value: unknown) { return parseModMetadata(new Map([[path, bytes(value)]]))[0] }
const forge = (extra = '') => `modLoader="javafml"\nloaderVersion="[52,)"\nlicense="Original Test License"\n[[mods]]\nmodId="original_forge"\nversion="1.0"\ndisplayName="Original Forge"\n${extra}`
const manifest = (text: string) => read('META-INF/MANIFEST.MF', text)

test('Fabric schema1 projects bounded display identity, authors, licenses and explicit environment only', () => {
  const result = read('fabric.mod.json', fabric({ name: 'Original', description: 'Original description', authors: ['A', { name: 'B', contact: { homepage: 'https://invalid.example/' } }], license: ['MIT', 'BSD-3-Clause'], environment: 'client', contact: { homepage: 'https://invalid.example/' } }))
  assert.equal(result.status, 'read'); assert.equal(result.format, 'fabric'); assert.deepEqual(result.loader, { id: 'fabric' })
  assert.equal(result.mods[0].version, '1.0-custom'); assert.deepEqual(result.mods[0].authors, ['A', 'B'])
  assert.equal(result.mods[0].environment, 'client'); assert.deepEqual(result.mods[0].licenses, ['MIT', 'BSD-3-Clause'])
  assert.ok(!JSON.stringify(result).includes('https://')); assert.equal(read('fabric.mod.json', fabric()).mods[0].environment, undefined)
})
test('Fabric dependency AND strings and OR arrays remain original declarations, not solved ranges', () => {
  const result = read('fabric.mod.json', fabric({ depends: { minecraft: '>=1.20 <1.22', java: ['>=17', '21'] }, recommends: { original_lib: '*' }, conflicts: { wrong_mod: '*' }, breaks: { old_mod: '<2' } }))
  assert.equal(result.mods[0].dependencies.length, 5)
  assert.equal(result.mods[0].dependencies[0].version, '>=1.20 <1.22')
  assert.equal(result.mods[0].dependencies[1].version, '[">=17","21"]')
  assert.match(result.mods[0].dependencies[1].details!, /OR/)
  assert.deepEqual(result.mods[0].dependencies.map(row => row.kind), ['depends', 'depends', 'recommends', 'conflicts', 'breaks'])
})
test('Fabric provides and nested JAR declarations display without inspecting nested bytes or classes', () => {
  const result = read('fabric.mod.json', fabric({ provides: ['original_alias'], jars: [{ file: 'META-INF/jars/original.jar' }], languageAdapters: { custom: 'original.DoesNotRun' }, entrypoints: { main: ['original.DoesNotRun'] } }))
  assert.deepEqual(result.mods[0].provides, ['original_alias']); assert.deepEqual(result.mods[0].nestedJars, ['META-INF/jars/original.jar'])
  assert.equal(result.mods[0].warnings.length, 2); assert.ok(!JSON.stringify(result).includes('DoesNotRun'))
})
test('unsupported Fabric schema/array root never creates a fake current mod identity', () => {
  for (const value of [{ id: 'original_mod', version: '1' }, fabric({ schemaVersion: 5 }), [fabric()]]) {
    const result = read('fabric.mod.json', value); assert.equal(result.status, 'unsupported'); assert.deepEqual(result.mods, [])
  }
})
test('missing or malformed mandatory Fabric identity/version and invalid recognized fields return invalid', () => {
  for (const value of [fabric({ id: 'BAD' }), fabric({ id: 'x' }), fabric({ version: 4 }), fabric({ authors: [2] }), fabric({ jars: ['wrong'] }), fabric({ depends: { minecraft: 42 } })]) {
    const result = read('fabric.mod.json', value); assert.equal(result.status, 'invalid'); assert.deepEqual(result.mods, [])
  }
})
test('decoded duplicate JSON identity keys are rejected, including escaped keys', () => {
  for (const value of ['{"schemaVersion":1,"id":"original_a","id":"original_b","version":"1"}', '{"schemaVersion":1,"id":"original_a","\\u0069d":"original_b","version":"1"}']) {
    const result = read('fabric.mod.json', value); assert.equal(result.status, 'invalid'); assert.deepEqual(result.mods, [])
  }
})
test('JSON invalid encoding, comments, trailing data, BOM and nonfinite numbers do not leak parser source', () => {
  const inputs = [Buffer.from([0xff, 0xfe]), Buffer.from('\ufeff'+JSON.stringify(fabric())), bytes('{/* private raw input */}'), bytes(JSON.stringify(fabric())+' true'), bytes('{"schemaVersion":1,"id":"original_mod","version":"1","custom":1e400}')]
  for (const input of inputs) {
    const result = parseModMetadata(new Map([['fabric.mod.json', input]]))[0]; assert.equal(result.status, 'invalid'); assert.deepEqual(result.mods, []); assert.ok(!JSON.stringify(result).includes('private raw input'))
  }
})
test('JSON unsafe object keys cannot modify prototypes', () => {
  const result = read('fabric.mod.json', '{"schemaVersion":1,"id":"original_mod","version":"1","__proto__":{"polluted":true}}')
  assert.equal(result.status, 'invalid'); assert.equal(({} as { polluted?: unknown }).polluted, undefined)
})
test('Quilt schema1 preserves optional/unless and any/all declarations rather than flattening them', () => {
  const result = read('quilt.mod.json', quilt({ metadata: { name: 'Original Quilt', contributors: { A: 'Developer' }, license: 'MIT' },
    depends: [{ id: 'original_dep', versions: { any: ['1', { all: ['>=2', '<3'] }] }, optional: true, unless: 'other_dep', environment: 'client' }, ['either_a', 'either_b']],
    provides: ['original_alias', { id: 'version_alias', version: '2.0' }], jars: ['nested/original.jar'] }))
  assert.equal(result.status, 'read'); assert.equal(result.mods[0].dependencies.length, 2)
  assert.match(result.mods[0].dependencies[0].kind, /optional/); assert.match(result.mods[0].dependencies[0].details!, /unless/)
  assert.match(result.mods[0].dependencies[1].id, /组合/); assert.equal(result.mods[0].dependencies[1].version, '["either_a","either_b"]')
  assert.deepEqual(result.mods[0].authors, ['A (Developer)']); assert.deepEqual(result.mods[0].provides, ['original_alias', 'version_alias @ 2.0'])
  assert.ok(result.mods[0].warnings.some(value => value.includes('Quilt')))
})
test('Quilt Minecraft environment and loader plugins are declarations without creating Quilt instance support', () => {
  const source = { ...quilt({ plugins: ['original.Plugin'] }), minecraft: { environment: 'server' } }
  const result = read('quilt.mod.json', source); assert.equal(result.mods[0].environment, 'server'); assert.ok(result.mods[0].warnings.some(s => s.includes('插件')))
  assert.equal(read('quilt.mod.json', { schema_version: 9, quilt_loader: {} }).status, 'unsupported')
  assert.equal(read('quilt.mod.json', { schema_version: 1, quilt_loader: [] }).status, 'invalid')
})
test('Quilt JSON5 is explicitly development-only unsupported even if its text is JSON-compatible', () => {
  const result = read('quilt.mod.json5', quilt()); assert.equal(result.status, 'unsupported'); assert.deepEqual(result.mods, []); assert.match(result.reason!, /开发/)
})
test('Forge real TOML handles multiline strings, quoted table names and several contained mods', () => {
  const result = read('META-INF/mods.toml', `modLoader='javafml'\nloaderVersion='[52,)'\nlicense='MIT'\n[[mods]]\nmodId='original_one'\nversion='1'\nauthors='A, B'\ndescription='''Original\nmultiline description'''\n[[mods]]\nmodId='original_two'\nversion='2'\n[[dependencies."original_one"]]\nmodId='minecraft'\nmandatory=true\nversionRange='[1.21,1.22)'\nordering='NONE'\nside='BOTH'\n`)
  assert.equal(result.status, 'read'); assert.equal(result.mods.length, 2); assert.equal(result.mods[0].description, 'Original\nmultiline description')
  assert.deepEqual(result.mods[0].authors, ['A, B']); assert.equal(result.mods[0].dependencies[0].kind, 'required')
  assert.equal(result.mods[0].dependencies[0].version, '[1.21,1.22)'); assert.equal(result.mods[0].dependencies[0].environment, 'BOTH')
  assert.equal(result.mods[1].dependencies.length, 0); assert.match(result.warnings[0], /历史NeoForge/)
})
test('NeoForge dependency types remain required/optional/incompatible/discouraged declaration strings', () => {
  const deps = ['required','optional','incompatible','discouraged'].map((kind,i) => `[[dependencies.original_forge]]\nmodId='dependency_${i}'\ntype='${kind}'\nversionRange='[1,)'\nside='CLIENT'\n`).join('')
  const result = read('META-INF/neoforge.mods.toml', forge(deps)); assert.equal(result.status, 'read')
  assert.deepEqual(result.mods[0].dependencies.map(d => d.kind), ['required','optional','incompatible','discouraged'])
  assert.equal(result.mods[0].dependencies[0].environment, 'CLIENT')
})
test('custom TOML language loader and absent dependency mandatory stay unassessed', () => {
  const result = read('META-INF/mods.toml', forge('[[dependencies.original_forge]]\nmodId="original_dep"\n').replace('"javafml"','"custom-loader"'))
  assert.equal(result.status, 'read'); assert.equal(result.loader?.id, 'custom-loader'); assert.equal(result.mods[0].dependencies[0].kind, '未声明mandatory')
  assert.ok(result.mods[0].warnings.some(s => s.includes('自定义')))
})
test('TOML duplicate keys, duplicate mod IDs, malformed values and unsafe properties are rejected', () => {
  const inputs = [forge('modId="another_mod"\n'), forge('[[mods]]\nmodId="original_forge"\nversion="2"\n'), forge('wrong=\n'), forge('__proto__={ polluted=true }\n'), forge('constructor="bad"\n')]
  for (const input of inputs) { const result = read('META-INF/mods.toml', input); assert.equal(result.status, 'invalid'); assert.deepEqual(result.mods, []) }
  assert.equal(({} as { polluted?: unknown }).polluted, undefined)
})
test('TOML NaN and temporal special objects remain invalid rather than disappearing silently', () => {
  for (const value of ['nan','inf','1979-05-27T07:32:00Z']) { const result = read('META-INF/mods.toml', forge(`custom=${value}\n`)); assert.equal(result.status, 'invalid'); assert.deepEqual(result.mods, []) }
})
test('TOML inline and dotted structure depth is bounded independently of the upstream default', () => {
  for (const custom of [`x=${'['.repeat(40)}0${']'.repeat(40)}`, `${Array(40).fill('part').join('.')}=1`]) {
    const result = read('META-INF/mods.toml', forge(custom+'\n')); assert.notEqual(result.status, 'read'); assert.deepEqual(result.mods, [])
  }
})
test('Manifest main section honors CR/LF/CRLF folds and never reads named section version', () => {
  for (const newline of ['\n','\r','\r\n']) {
    const result = manifest(`Manifest-Version: 1.0${newline}Implementation-Version: 1.0-${newline} original${newline}${newline}Name: Other${newline}Implementation-Version: foreign${newline}${newline}`)
    assert.equal(result.status, 'read'); assert.equal(result.manifest?.find(row => row.name === 'Implementation-Version')?.value, '1.0-original')
    assert.ok(!JSON.stringify(result).includes('foreign'))
  }
})
test('Manifest folds raw UTF8 bytes before decoding a split multibyte character', () => {
  const prefix = Buffer.from('Implementation-Title: '), utf8 = Buffer.from('原始模组')
  const raw = Buffer.concat([prefix,utf8.subarray(0,1),Buffer.from('\r\n '),utf8.subarray(1),Buffer.from('\r\n\r\n')])
  const result = parseModMetadata(new Map([['META-INF/MANIFEST.MF',raw]]))[0]
  assert.equal(result.status,'read'); assert.equal(result.manifest?.[0].value, '原始模组')
})
test('Manifest duplicate case-insensitive fields, bad continuation/physical lines and missing terminators are invalid', () => {
  for (const input of ['Implementation-Version: 1\nimplementation-version: 2\n\n',' orphan\n\n',`Implementation-Title: ${'a'.repeat(80)}\n\n`,'Implementation-Version: 1','Bad Header: value\n\n']) {
    const result=manifest(input);assert.equal(result.status,'invalid');assert.equal(result.manifest,undefined)
  }
})
test('Manifest display fields cannot establish a mod or verify signatures and executable references are text only', () => {
  const result=manifest('Manifest-Version: 1.0\nMain-Class: original.NotExecuted\nClass-Path: https://invalid.example/remote.jar\nFMLModType: LIBRARY\n\n')
  assert.equal(result.status,'read');assert.deepEqual(result.mods,[]);assert.ok(result.warnings.length)
  assert.ok(result.manifest?.some(row=>row.name==='Main-Class'))
})
test('file.jarVersion uses only a uniquely parsed manifest main-section value', () => {
  const result=parseModMetadata(new Map([['META-INF/mods.toml',bytes(forge().replace('version="1.0"','version="${file.jarVersion}"'))],['META-INF/MANIFEST.MF',bytes('Manifest-Version: 1.0\nImplementation-Version: 3.2\n\n')]]))
  assert.equal(result[0].mods[0].version,'3.2')
  const noMain=parseModMetadata(new Map([['META-INF/mods.toml',bytes(forge().replace('version="1.0"','version="${file.jarVersion}"'))],['META-INF/MANIFEST.MF',bytes('Manifest-Version: 1.0\n\nName: Other\nImplementation-Version: foreign\n\n')]]))
  assert.equal(noMain[0].mods[0].version,'${file.jarVersion}');assert.ok(noMain[0].mods[0].warnings.length)
})
test('invalid manifest and unknown placeholders never substitute a guessed version', () => {
  for(const value of ['${file.jarVersion}','${otherVersion}']) {
    const result=parseModMetadata(new Map([['META-INF/mods.toml',bytes(forge().replace('version="1.0"',`version="${value}"`))],['META-INF/MANIFEST.MF',bytes('Implementation-Version: 1\nImplementation-Version: 2\n\n')]]))
    assert.equal(result[0].mods[0].version,value);assert.equal(result[1].status,'invalid')
  }
})
test('separate loader documents preserve their identities rather than inventing a merged canonical mod', () => {
  const result=parseModMetadata(new Map([['fabric.mod.json',bytes(fabric())],['META-INF/mods.toml',bytes(forge())]]))
  assert.equal(result.length,2);assert.equal(result[0].mods[0].id,'original_mod');assert.equal(result[1].mods[0].id,'original_forge')
})
test('only fixed exact paths are read, not alternate casing/versioned names/arbitrary path input', () => {
  const result=parseModMetadata(new Map([['private/secret/fabric.mod.json',bytes(fabric())],['Fabric.mod.json',bytes(fabric())],['META-INF/versions/17/fabric.mod.json',bytes(fabric())]]));assert.deepEqual(result,[])
})
test('byte, depth, node and display text budgets return diagnostics with no stale identity', () => {
  const inputs=[Buffer.alloc(MOD_METADATA_LIMITS.documentBytes+1,32),bytes(fabric({custom:JSON.parse('['.repeat(40)+'0'+']'.repeat(40))})),bytes(fabric({custom:Array(20001).fill(0)})),bytes(fabric({description:'中'.repeat(1500)}))]
  for(const input of inputs){const result=parseModMetadata(new Map([['fabric.mod.json',input]]))[0];assert.equal(result.status,'unsupported');assert.deepEqual(result.mods,[])}
})
test('dependency count is bounded per document and cumulatively across recognized documents', () => {
  const dependencies=Object.fromEntries(Array.from({length:257},(_,i)=>[`original_${i}`,'*']))
  assert.equal(read('fabric.mod.json',fabric({depends:dependencies})).status,'unsupported')
  const each=Object.fromEntries(Object.entries(dependencies).slice(0,129))
  const q=quilt({depends:Object.keys(each).map(id=>({id,versions:'*'}))})
  const result=parseModMetadata(new Map([['fabric.mod.json',bytes(fabric({depends:each}))],['quilt.mod.json',bytes(q)]]))
  assert.ok(result.every(doc=>doc.status==='unsupported'&&doc.mods.length===0))
})
test('contained mod and aggregate source budgets cannot return partial authoritative identities', () => {
  const many='modLoader="javafml"\n'+Array.from({length:64},(_,i)=>`[[mods]]\nmodId="original_${i}"\nversion="1"\n`).join('')
  const result=parseModMetadata(new Map([['fabric.mod.json',bytes(fabric())],['META-INF/mods.toml',bytes(many)]]));assert.ok(result.every(doc=>doc.status==='unsupported'&&doc.mods.length===0))
  const big=new Map(['fabric.mod.json','quilt.mod.json','quilt.mod.json5','META-INF/mods.toml','META-INF/neoforge.mods.toml'].map(path=>[path,Buffer.alloc(230000,32)]))
  assert.ok(parseModMetadata(big).every(doc=>doc.status==='unsupported'&&doc.mods.length===0))
})
test('free display text preserves original controls for the UI escape layer, without silently rewriting content', () => {
  const result=read('fabric.mod.json',fabric({name:'Original\u0000\u202e Name',description:'Original\nsecond line'}))
  assert.equal(result.mods[0].name,'Original\u0000\u202e Name');assert.equal(result.mods[0].description,'Original\nsecond line')
})
test('semantic mod IDs never become another valid identity through control or bidi removal', () => {
  for(const bad of ['bad\u0000id','ab\u202ecd']) {
    for(const [path,value] of [['fabric.mod.json',fabric({id:bad})],['quilt.mod.json',quilt({id:bad})],['META-INF/mods.toml',forge().replace('original_forge',bad.replace('\u0000','\\u0000').replace('\u202e','\\u202e'))]] as const) {
      const result=read(path,value);assert.equal(result.status,'invalid');assert.deepEqual(result.mods,[])
    }
  }
})
test('semantic versions, dependency/provides IDs and language loaders reject controls rather than changing rules', () => {
  const values=[fabric({version:'1\u00002'}),fabric({provides:['other\u0000mod']}),fabric({depends:{['bad\u202eid']:'*'}}),fabric({depends:{minecraft:'>=1\u202e.20'}}),quilt({provides:[{id:'bad\u0000id'}]}),quilt({depends:[{id:'bad\u0000id',versions:'*'}]})]
  for(const value of values){const result=read('schemaVersion' in value?'fabric.mod.json':'quilt.mod.json',value);assert.equal(result.status,'invalid');assert.deepEqual(result.mods,[])}
  for(const value of [forge().replace('javafml','java\\u0000fml'),forge('[[dependencies.original_forge]]\nmodId="bad\\u0000id"\nversionRange="[1,)"\n'),forge('[[dependencies.original_forge]]\nmodId="original_dep"\nversionRange="[1,\\u202e)"\n')])assert.equal(read('META-INF/mods.toml',value).status,'invalid')
})
