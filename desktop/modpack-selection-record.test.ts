import assert from 'node:assert/strict'
import test from 'node:test'
import AdmZip from 'adm-zip'
import {createHash} from 'node:crypto'
import {parseModpack} from './modpack'
import {createModpackPlan} from './modpack-plan'
import {applySavedPackSelection} from './modpack-selection-record'
function fixture(){const z=new AdmZip(),body='original';z.addFile('modrinth.index.json',Buffer.from(JSON.stringify({formatVersion:1,game:'minecraft',name:'Original',versionId:'1',dependencies:{minecraft:'1.20.1'},files:[{path:'mods/optional.txt',downloads:['https://cdn.modrinth.com/original'],fileSize:body.length,hashes:{sha1:createHash('sha1').update(body).digest('hex'),sha512:createHash('sha512').update(body).digest('hex')},env:{client:'optional',server:'unsupported'}}]})));const pack=parseModpack(z.toBuffer()),p=createModpackPlan(pack);return{pack,p,record:{schema:1,archiveSha512:p.summary.archiveSha512,planDigest:p.summary.planDigest,selectedOptionalIds:[]}}}
test('explicit empty saved selection removes optional while original parsed plan is unchanged',()=>{const f=fixture();assert.equal(applySavedPackSelection(f.pack,f.record).files.length,0);assert.equal(f.pack.files.length,1)})
test('unknown schema/digest/hash/keys and foreign IDs never degrade to legacy all',()=>{const f=fixture();for(const value of [undefined,null,[],{...f.record,schema:2},{...f.record,planDigest:'bad'},{...f.record,archiveSha512:'bad'},{...f.record,extra:true},{...f.record,selectedOptionalIds:['bad']}])assert.throws(()=>applySavedPackSelection(f.pack,value))})
