import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,value} from './fixture.mjs';
const id='11111111-2222-3333-4444-555555555555';
async function remoteFixture(t,{extra={},duplicate=false}={}){
 return fixture(t,{extraEnv:()=>extra,beforeStart:async dir=>{
  await mkdir(join(dir,'state'),{recursive:true});
  const entry={id,name:'Remote',config_path:join(dir,'remote.json')};
  await writeFile(join(dir,'state/remote-devices.json'),JSON.stringify(duplicate?[entry,entry]:[entry]));
  await writeFile(join(dir,'bin/python3'),'#!/bin/sh\necho unexpected-local-discovery >&2\nprintf \'{"op":"unrelated_discovery"}\\n\' >> "$FIXTURE_LOG"\nexit 73\n',{mode:0o755});
 }});
}
for(const [name,extra] of [['ordinary',{}],['input lock',{POKI_INPUT_LOCK:'1'}],['pinned',{POKI_MCP_PIN_REMOTE_UDID:id}]])
 test(`an exact configured remote ID skips unrelated discovery (${name})`,async t=>{
  const f=await remoteFixture(t,{extra});const result=await f.call('select_device',{device:id});
  assert.ok(!result.isError,JSON.stringify(result));assert.equal(value(result).selected,id);
  assert.equal((await f.events()).filter(e=>e.op==='unrelated_discovery').length,0);
 });
test('duplicate remote IDs fail closed rather than choosing a configuration',async t=>{
 const f=await remoteFixture(t,{duplicate:true});const r=await f.call('select_device',{device:id});
 assert.equal(r.isError,true);assert.match(r.content[0].text,/duplicate/i);assert.deepEqual(await f.events(),[]);
});
test('an exact remote ID never bypasses a different pinned device',async t=>{
 const f=await remoteFixture(t,{extra:{POKI_MCP_PIN_REMOTE_UDID:'22222222-3333-4444-5555-666666666666'}});
 const r=await f.call('select_device',{device:id});assert.equal(r.isError,true);assert.deepEqual(await f.events(),[]);
});
