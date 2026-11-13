import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,value} from './fixture.mjs';

const app={role:'Application',label:'Fixture',frame:{x:0,y:0,width:100,height:200}};
const button=label=>({role:'Button',object_id:label,label,enabled:true,frame:{x:10,y:40,width:40,height:20}});
const state=extra=>({bundleId:'local.fixture',appName:'Fixture',appRoot:'Fixture',label:'First',...extra});
const plan=extra=>({device:'fixture-phone',expected_app:'Fixture',start:{all:['First']},steps:[{kind:'tap',label:'First'}],finish:{all:['Done']},...extra});
const result=r=>value(r).result;

test('all four additive workflow tools are discoverable through native MCP',async t=>{
  const f=await fixture(t,{toolsProfile:'all'});
  const names=(await f.a.listTools()).tools.map(x=>x.name);
  for(const name of ['run_workflow','tap_sequence','run_app_action','choose_action'])assert.ok(names.includes(name));
  assert.equal(value(await f.call('poki_mcp_status')).total_tools,names.length);
});
test('invalid scoped query is rejected before any earlier batch input runs',async t=>{
  const f=await fixture(t);await f.set(state({afterInput:{label:'Done'}}));
  const r=await f.call('batch_commands',{commands:[
    {tool:'tap_text',arguments:{text:'First',expected_app:'Fixture',verify:false}},
    {tool:'snapshot_ui',arguments:{query:{}}},
  ]});
  assert.equal(r.isError,true);
  assert.equal((await f.events()).filter(e=>e.op==='tap').length,0,'All query refinements must be validated before dispatching batch input');
});
test('a complete native workflow executes one known tap and independently checks its result',async t=>{
  const f=await fixture(t);await f.set(state({afterInput:{label:'Done'}}));
  const r=await f.call('run_workflow',plan());
  assert.ok(!r.isError,JSON.stringify(r));assert.equal(result(r).postcondition_verified,true);
  assert.equal(result(r).completed_steps,1);
  assert.equal((await f.events()).filter(e=>e.op==='tap').length,1);
});
test('a native workflow with a missing start condition dispatches no input',async t=>{
  const f=await fixture(t);await f.set(state({label:'Other'}));
  const r=await f.call('run_workflow',plan());assert.equal(r.isError,true);
  assert.equal((await f.events()).filter(e=>e.op==='tap'||e.op==='type_text').length,0);
});
test('a failed final condition is an error, never a successful workflow receipt',async t=>{
  const f=await fixture(t);await f.set(state());
  const r=await f.call('run_workflow',plan());assert.equal(r.isError,true);
  assert.match(value(r).script_error,/final result/);
  assert.equal((await f.events()).filter(e=>e.op==='tap').length,1);
});
test('a normalized absence condition cannot disappear from a scoped workflow checkpoint',async t=>{
  const f=await fixture(t);
  await f.set(state({afterInput:{elements:[app,button('Done'),{role:'StaticText',label:'Loading',frame:{x:10,y:100,width:70,height:20}}]}}));
  const r=await f.call('run_workflow',plan({finish:{all:['Done'],none:['loading']}}));
  assert.equal(r.isError,true,'The workflow must not claim completion while Loading is still visible');
  assert.match(value(r).script_error,/final result/);
});
test('a scoped final snapshot cannot replace a whole-screen batch readback',async t=>{
  const f=await fixture(t);
  await f.set(state({afterInput:{elements:[app,button('Done'),{role:'StaticText',label:'Loading',frame:{x:10,y:100,width:70,height:20}}]}}));
  const r=await f.call('batch_commands',{commands:[
    {tool:'tap_text',arguments:{text:'First',expected_app:'Fixture',verify:false}},
    {tool:'snapshot_ui',arguments:{query:{labels:['Done']}}},
  ]});
  assert.ok(!r.isError,JSON.stringify(r));
  const parts=r.content.filter(c=>c.type==='text').flatMap(c=>{try{return [JSON.parse(c.text)];}catch{return [];}});
  assert.ok(parts.some(p=>p.scope?.returned==='query_matches'&&p.elements.length===1));
  const summary=parts.at(-1);
  assert.ok(summary.screen.text.some(text=>text.includes('Loading')),'The final whole-screen report must retain text outside the query');
  assert.equal(summary.screen.observation_id,undefined,'The projection must not be reused as the whole-screen checkpoint');
});
test('native workflow conditions skip unnecessary actions locally',async t=>{
  const f=await fixture(t);await f.set(state());
  const r=await f.call('run_workflow',plan({steps:[{kind:'tap',label:'Other',when:{all:['Other']}}],finish:{all:['First']}}));
  assert.ok(!r.isError,JSON.stringify(r));assert.equal(result(r).skipped_steps,1);
  assert.equal((await f.events()).filter(e=>e.op==='tap').length,0);
});
test('a local choice is revalidated by the real native semantic tap path',async t=>{
  const f=await fixture(t);await f.set(state({elements:[app,button('First'),{...button('Second'),frame:{x:55,y:40,width:40,height:20}}],afterInput:{elements:[app,button('Done')]}}));
  const r=await f.call('run_workflow',plan({steps:[{kind:'choose',goal:'Choose Second',labels:['First','Second'],exact_label:'Second'}]}));
  assert.ok(!r.isError,JSON.stringify(r));assert.equal(result(r).postcondition_verified,true);
  const events=await f.events();assert.equal(events.filter(e=>e.op==='tap').length,1);assert.equal(events.filter(e=>e.dialog).length,0);
});
test('unknown delivery stops a native workflow once, before later actions',async t=>{
  const f=await fixture(t);await f.set(state({inputReply:{isError:true,outcome:'unknown',stop_reason:'unknown',sent:false}}));
  const r=await f.call('run_workflow',plan({steps:[{kind:'tap',label:'First'},{kind:'tap',label:'First'}]}));
  assert.equal(r.isError,true);assert.equal((await f.events()).filter(e=>e.op==='tap').length,1);
});
test('numeric sequence is one native dispatch and refuses an old helper without input',async t=>{
  const f=await fixture(t);const elements=[app,...['1','2'].map((label,i)=>({role:'Key',object_id:label,label,enabled:true,frame:{x:10+i*30,y:80,width:20,height:20}}))];
  await f.set(state({elements}));
  const args={device:'fixture-phone',expected_app:'Fixture',labels:['1','2'],fixed_layout:true};
  const refused=await f.call('tap_sequence',args);assert.equal(refused.isError,true);
  assert.equal((await f.events()).filter(e=>e.op==='tap_sequence').length,0);
  await f.set(state({elements,nativeFeatures:['native_tap_sequence']}));
  const sent=await f.call('tap_sequence',args);assert.ok(!sent.isError,JSON.stringify(sent));
  assert.equal((await f.events()).filter(e=>e.op==='tap_sequence').length,1);
  assert.equal(value(sent).verified,false);
});
test('run_workflow cannot recursively escape the existing worker call budget',async t=>{
  const f=await fixture(t);
  const r=await f.call('run_code',{code:'return await tools.run_workflow(input)',input:plan()});
  assert.equal(r.isError,true);assert.match(JSON.stringify(r),/Nested batches/);
});
test('workflow fill verifies a draft and never sends Return',async t=>{
  const f=await fixture(t);
  await f.set(state({phone:{keyboard:true,rows:[{id:'field1',placeholder:'Name',value:'',up:70,down:130,editing:true}]}}));
  const r=await f.call('run_workflow',plan({steps:[{kind:'fill',field:'Name',text:'Poki draft'}],finish:{all:['Poki draft']}}));
  assert.ok(!r.isError,JSON.stringify(r));assert.equal(result(r).postcondition_verified,true);
  const inputs=(await f.events()).filter(e=>e.op==='type_text');
  assert.equal(inputs.length,1);assert.equal(inputs[0].request.submit,false);
});
