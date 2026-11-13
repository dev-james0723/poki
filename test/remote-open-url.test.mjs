import test from 'node:test';
import assert from 'node:assert/strict';
import { platformTool } from '../src/platform.mjs';
import { fixture, value } from './fixture.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBatch } from '../src/batch.mjs';

const url = 'https://example.invalid/acceptance';
function context(handler) {
  const calls=[]; const target={id:'synthetic-phone',kind:'physical',remote:'/synthetic/remote.json'};
  return {calls,frame:'stale',elements:[{ref:'stale'}],target:async()=>target, changed:()=>{}, bridge:async request=>{calls.push(request);return handler(request)}};
}

test('remote open_url issues exactly one native request and never asserts navigation from acceptance alone',async()=>{
  const c=context(async()=>({accepted:true,outcome:'accepted',opened_verified:false,pid:42}));
  const r=await platformTool(c,'open_url',{url});
  assert.deepEqual(c.calls,[{op:'open_url',url}]);
  assert.equal(r.outcome,'accepted');
  assert.equal(r.opened_verified,false);
  assert.equal(r.stop_reason,'unverified');
});

test('native uncertainty is not retried or reported as opened',async()=>{
  const c=context(async()=>({isError:true,outcome:'unknown',retry:'unsafe'}));
  const r=await platformTool(c,'open_url',{url});
  assert.equal(c.calls.length,1);assert.equal(r.isError,true);assert.equal(r.outcome,'unknown');assert.equal(r.retry,'unsafe');
  assert.equal(r.stop_reason,'unknown');
  assert.equal(c.frame,undefined);assert.deepEqual(c.elements,[]);
});

test('a broken helper connection is unknown and is never retried',async()=>{
  const c=context(async()=>{throw new Error('synthetic transport closed')});
  const r=await platformTool(c,'open_url',{url});
  assert.equal(c.calls.length,1);assert.equal(r.outcome,'unknown');assert.equal(r.retry,'unsafe');
  assert.equal(r.stop_reason,'unknown');
  assert.equal(c.frame,undefined);assert.deepEqual(c.elements,[]);
});

test('malformed or contradictory native receipts fail closed',async()=>{
 for(const reply of [{outcome:'accepted'},{outcome:'accepted',accepted:true,pid:0,opened_verified:false},
   {outcome:'accepted',accepted:true,pid:42,opened_verified:false,isError:true},{}]) {
  const c=context(async()=>reply); const r=await platformTool(c,'open_url',{url});
  assert.equal(r.isError,true);assert.equal(r.outcome,'unknown');assert.equal(r.stop_reason,'unknown');assert.equal(r.retry,'unsafe');
 }
});

test('batch stops before later input on unknown or accepted but unverified URL',async()=>{
 for(const reply of [{outcome:'unknown',isError:true,retry:'unsafe'}, {outcome:'accepted',accepted:true,pid:42,opened_verified:false}]) {
  const c=context(async()=>reply);let next=0;
  c.dispatch=async(name,args)=>{if(name==='open_url'){let r=await platformTool(c,name,args);return {isError:r.isError,content:[{type:'text',text:JSON.stringify(r)}],_meta:{stop_reason:r.stop_reason}}}next++;return {content:[{type:'text',text:'{}'}]}};
  c.readback=async()=>({screen:{}});
  const result=await runBatch(c,{stop_on_error:false,commands:[{tool:'open_url',arguments:{url}},{tool:'tap',arguments:{x:1,y:1}}]});
  assert.equal(next,0);assert.equal(result.isError,true);
 }
});

test('invalid URL never reaches native transport',async()=>{
  const c=context(async()=>{throw new Error('should not send')});
  await assert.rejects(()=>platformTool(c,'open_url',{url:'missing scheme'}),/URL/);
  assert.equal(c.calls.length,0);
});

test('remote open_url still requires approval; cancellation dispatches no URL',async t=>{
  const f=await fixture(t,{beforeStart:async dir=>{
    await mkdir(join(dir,'state'));
    await writeFile(join(dir,'state/remote-devices.json'),JSON.stringify([{id:'remote-phone',config_path:join(dir,'remote.json')}]));
  }});
  const pending=f.call('open_url',{device:'remote-phone',url});
  await f.until(log=>log.includes('"dialog":true'));
  assert.equal(value(await f.call('cancel_device')).stopped,true);
  assert.equal((await pending).isError,true);
  assert.ok(!(await f.events()).some(e=>e.tool==='poki-native'),'no native request after denied/cancelled approval');
});
