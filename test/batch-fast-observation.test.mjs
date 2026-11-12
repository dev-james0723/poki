import test from 'node:test';
import assert from 'node:assert/strict';
import {runBatch} from '../src/batch.mjs';
import {Devices} from '../src/device.mjs';
import {screenChanged} from '../src/interaction.mjs';
import {work} from '../src/work.mjs';
import {fixture as phoneFixture} from './fixture.mjs';

const inside = fn => work.run({signal:new AbortController().signal,timings:[]},fn);
const receipt = data => ({content:[{type:'text',text:JSON.stringify(data)}]});
const now = Date.now();
const snapshot = () => ({
  observation:{id:'live-final',device:'phone',revision:4,source:'accessibility',input_freshness:'live_read',structure_started_at:new Date(now+1).toISOString(),structure_completed_at:new Date(now+2).toISOString()},
  source:'accessibility',event_source:'accessibility_live',image_captured:false,
  foreground:{name:'Calculator'},elements:[{type:'StaticText',label:'15'}],total:1,truncated:false,prompt:null,
});
function fixture(data=snapshot(),failed=false) {
  let reads=0;
  const ctx={lastInputCompletedAt:new Date(now).toISOString(),
    coordinator:{revision:()=>4},target:async()=>({id:'phone'}),
    dispatch:async tool=>tool==='snapshot_ui'?{...receipt(data),...(failed?{isError:true}:{})}:receipt({sent:true}),
    readback:async()=>{reads++;return {screen:{text:['fallback'],source:'accessibility'}};},
  };
  return {ctx,reads:()=>reads};
}
const commands=[{tool:'tap',arguments:{x:10,y:20,verify:false}},{tool:'snapshot_ui',arguments:{}}];
test('batch timing distinguishes queue admission from execution without exposing screen data',async()=>{
  const f=fixture();
  const out=await work.run({signal:new AbortController().signal,timings:[{phase:'queue',elapsed_ms:12500}]},()=>runBatch(f.ctx,{commands:[{tool:'wait',arguments:{seconds:0}}]}));
  const timing=JSON.parse(out.content.at(-1).text).timing;
  assert.equal(timing.queue_ms,12500);
  assert.ok(timing.batch_ms>=0&&timing.batch_ms<1000);
  assert.equal(timing.readback_ms,0);
  assert.deepEqual(Object.keys(timing).sort(),['batch_ms','queue_ms','readback_ms','steps_ms']);
});
test('a complete trailing live snapshot is the batch readback, without a second screen read',async()=>{
  const f=fixture();
  const result=await inside(()=>runBatch(f.ctx,{commands}));
  const summary=JSON.parse(result.content.at(-1).text);
  assert.equal(f.reads(),0);
  assert.equal(summary.screen.foreground,'Calculator');
  assert.deepEqual(summary.screen.text,['StaticText: 15']);
  assert.equal(summary.screen.observation_id,'live-final');
  assert.equal(summary.screen.screen_stable,false);
  assert.equal(summary.verified,false);
});
for(const [name,edit] of [
  ['event hint',s=>{s.observation.input_freshness='requires_live_read';s.event_source='accessibility_event';}],
  ['truncated tree',s=>{s.truncated=true;s.total=2;}],
  ['scoped projection',s=>{s.scope={returned:'query_matches'};s.source_total=2;}],
  ['hidden source elements',s=>{s.source_total=2;}],
  ['other device',s=>{s.observation.device='other';}],
  ['changed revision',s=>{s.observation.revision=3;}],
  ['pre-input read',s=>{s.observation.structure_started_at=new Date(now-1).toISOString();}],
  ['unreadable foreground',s=>{s.foreground=null;}],
  ['incomplete receipt',s=>{delete s.observation.structure_completed_at;}],
]) test(`a trailing ${name} cannot replace the batch readback`,async()=>{
  const data=snapshot();edit(data);const f=fixture(data);
  await inside(()=>runBatch(f.ctx,{commands}));assert.equal(f.reads(),1);
});
test('a failed snapshot preserves its error and still attempts the normal final read',async()=>{
  const f=fixture(snapshot(),true);const out=await inside(()=>runBatch(f.ctx,{commands}));
  assert.equal(out.isError,true);assert.equal(f.reads(),1);
});
test('malformed snapshot JSON falls back without losing the successful input receipt',async()=>{
  const f=fixture(null);const result=await inside(()=>runBatch(f.ctx,{commands}));
  assert.equal(f.reads(),1);assert.ok(!result.isError);
});
test('the native MCP batch returns its explicit final AX checkpoint without another screenshot or readback',async t=>{
  const f=await phoneFixture(t);
  await f.set({appRoot:'Fixture',bundleId:'local.fixture',appName:'Fixture',label:'Go',afterInput:{label:'Done'}});
  const out=await f.call('batch_commands',{commands:[
    {tool:'tap_text',arguments:{text:'Go',expected_app:'Fixture',verify:false}},
    {tool:'snapshot_ui',arguments:{}},
  ]});
  assert.ok(!out.isError,JSON.stringify(out));
  const parts=out.content.filter(c=>c.type==='text').flatMap(c=>{try{return [JSON.parse(c.text)];}catch{return [];}});
  const observed=parts.find(p=>p.observation?.input_freshness==='live_read');
  const summary=parts.at(-1);
  assert.ok(observed.elements.some(e=>e.label==='Done'));
  assert.equal(summary.screen.observation_id,observed.observation.id);
  assert.equal(summary.screen.source,'accessibility');
  assert.equal((await f.events()).filter(e=>e.op==='screenshot'||e.args?.includes('screenshot')).length,0);
});
test('an AX checkpoint primes the same comparison signature as ordinary reads',async t=>{
  const f=await phoneFixture(t);
  await f.set({appRoot:'Fixture',bundleId:'local.fixture',appName:'Fixture',label:'First'});
  const out=await f.call('batch_commands',{commands:[
    {tool:'snapshot_ui',arguments:{}},
    {tool:'tap_text',arguments:{text:'First',expected_app:'Fixture'}},
    {tool:'tap_text',arguments:{text:'First',expected_app:'Fixture'}},
  ]});
  const summary=JSON.parse(out.content.at(-1).text);
  assert.equal(summary.stop_reason,'no_change');
  assert.equal(summary.completed_steps,2);
  assert.equal((await f.events()).filter(e=>e.op==='tap').length,1,'An unchanged tap must hold back the dependent action');
});
test('only a trailing snapshot removes the final tap comparison; semantic dependencies retain it',()=>{
  const d=new Devices();d.inBatch=true;
  d.batchStep={stopOnError:true};assert.equal(d.checksStep(),true);
  d.batchStep={next:{tool:'snapshot_ui'},nextIsFinal:true,stopOnError:true};assert.equal(d.checksStep(),false);
  d.batchStep={next:{tool:'snapshot_ui'},nextIsFinal:false,stopOnError:true};assert.equal(d.checksStep(),true);
  d.batchStep={next:{tool:'tap_text'},nextIsFinal:true,stopOnError:true};assert.equal(d.checksStep(),true);
});
test('a changed screen is detected before waiting for the settle floor',async()=>{
  const calls=[];const ctx={structure:async()=>{calls.push('read');return {elements:[{}],signature:'after'};},settle:async()=>{calls.push('settle');}};
  assert.equal(await inside(()=>screenChanged(ctx,'before',{})),true);
  assert.deepEqual(calls,['read']);
});
test('an unchanged early screen still waits and reads again before reporting a change',async()=>{
  const calls=[];let count=0;
  const ctx={structure:async()=>{calls.push('read');return {elements:[{}],signature:++count===1?'before':'after'};},settle:async()=>{calls.push('settle');}};
  assert.equal(await inside(()=>screenChanged(ctx,'before',{})),true);
  assert.deepEqual(calls,['read','settle','read']);
});
