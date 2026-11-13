import test from 'node:test';
import assert from 'node:assert/strict';
import {compileWorkflow, executeAppAction, executeTapSequence, chooseAction} from '../src/workflow-v2.mjs';
import {snapshotUI} from '../src/ax-snapshot.mjs';
import {work} from '../src/work.mjs';

const inside=fn=>work.run({signal:new AbortController().signal,timings:[]},fn);
const root={role:'Application',label:'Calculator',frame:{x:0,y:0,width:100,height:200}};
const key=(label,x=10)=>({role:'Key',type:'Key',object_id:'key-'+label,label,enabled:true,frame:{x,y:80,width:20,height:30}});
const snap=()=>({source:'accessibility',image_captured:false,event_source:'accessibility_live',
  observation:{id:'s1',device:'phone',revision:2,input_freshness:'live_read',structure_completed_at:new Date().toISOString()},
  native_runtime:{features:['native_tap_sequence']},foreground:{name:'Calculator'},width:100,height:200,
  elements:[root,key('1'),key('2',40)],total:3,truncated:false,prompt:null});
const plan=()=>({device:'phone',expected_app:'Calculator',start:{all:['Change Mode']},
  steps:[{kind:'tap',label:'Change Mode'},{kind:'tap',label:'Scientific'}],finish:{all:['sin']}});

test('a known workflow compiles to one existing run_code call with bounded native calls',()=>{
  const p=plan(),r=compileWorkflow(p);
  assert.equal(r.input.device,'phone');assert.ok(r.max_tool_calls<=60);
  assert.match(r.code,/tools\.tap_text/);assert.match(r.code,/tools\.snapshot_ui/);
  assert.equal(r.input.steps.length,2);assert.equal(r.timeout_seconds,120);
});
test('workflow text is data, never interpolated executable code',()=>{
  const p=plan();p.steps=[{kind:'fill',field:'Name',text:'"; throw Error("injected"); //'}];
  const r=compileWorkflow(p);assert.ok(!r.code.includes('injected'));assert.equal(r.input.steps[0].text,p.steps[0].text);
});
for(const mutate of [p=>delete p.finish,p=>p.steps.push({kind:'fill',text:'x',submit:true}),p=>p.steps.push({kind:'shell',command:'echo no'}),p=>p.steps=Array(31).fill(p.steps[0])])
test('invalid or unbounded workflow is rejected before execution',()=>{const p=plan();mutate(p);assert.throws(()=>compileWorkflow(p));});

test('scoped AX output keeps full-tree prompt checks and discloses projection',async()=>{
  const ctx={target:async()=>({id:'phone'}),coordinator:{revision:()=>2},
    bridge:async()=>({foreground:{name:'Calculator'},elements:[root,key('1'),key('2'),{role:'Button',label:'購買',frame:{x:2,y:2,width:20,height:20}}]})};
  const r=await inside(()=>snapshotUI(ctx,{query:{labels:['1']}}));
  assert.deepEqual(r.elements.map(e=>e.label),['1']);assert.equal(r.source_total,4);
  assert.equal(r.scope.native_tree_read,'complete');assert.equal(r.scope.returned,'query_matches');
  assert.equal(r.prompt.kind,'purchase','A prompt outside the projected labels must remain visible');
  assert.equal(ctx.seen.elements.length,4,'Projection must not corrupt input caches');
});

test('one tap sequence prevalidates every label and dispatches one native request',async()=>{
  const calls=[];const ctx={target:async()=>({id:'phone',kind:'physical'}),coordinator:{revision:()=>2},input:async r=>{calls.push(r);return {sent:true,completed_taps:2};}};
  const r=await executeTapSequence(ctx,{expected_app:'Calculator',labels:['1','2'],fixed_layout:true},{observe:async()=>snap()});
  assert.equal(r.sent,true);assert.equal(calls.length,1);assert.equal(calls[0].op,'tap_sequence');
  assert.equal(calls[0].points.length,2);assert.equal(calls[0].points[0].x,Math.round(20/99*65535));
});
for(const [name,edit] of [
  ['missing label',s=>s.elements.pop()],['event-only state',s=>s.observation.input_freshness='requires_live_read'],
  ['wrong app',s=>s.foreground.name='Other'],['prompt',s=>s.prompt={kind:'purchase'}],
  ['old helper',s=>s.native_runtime.features=[]],['wrong device',s=>s.observation.device='other'],
  ['truncation',s=>s.truncated=true],['unverified geometry',s=>s.width=null],
]) test(`tap sequence sends nothing with ${name}`,async()=>{
  let sent=0;const s=snap();edit(s);
  const ctx={target:async()=>({id:'phone',kind:'physical'}),coordinator:{revision:()=>2},input:async()=>{sent++;}};
  const r=await executeTapSequence(ctx,{expected_app:'Calculator',labels:['1','2'],fixed_layout:true},{observe:async()=>s});
  assert.equal(r.sent,false);assert.equal(sent,0);
});
test('a native uncertain sequence is returned once without replay',async()=>{
  let sent=0;const ctx={target:async()=>({id:'phone',kind:'physical'}),coordinator:{revision:()=>2},input:async()=>{sent++;return {isError:true,outcome:'unknown',completed_taps:1};}};
  const r=await executeTapSequence(ctx,{expected_app:'Calculator',labels:['1','2'],fixed_layout:true},{observe:async()=>snap()});
  assert.equal(r.outcome,'unknown');assert.equal(sent,1);
});

test('an official Shortcut URL retains the existing open_url approval path and verifies the result',async()=>{
  const calls=[];const ctx={target:async()=>({id:'phone'}),coordinator:{revision:()=>2},dispatch:async(tool,args)=>{calls.push({tool,args});return {content:[{type:'text',text:JSON.stringify({opened:true})}]};}};
  const r=await executeAppAction(ctx,{device:'phone',shortcut:'Poki Probe',input:'hello & world',expected_app:'Calculator',expect:{all:['1']}},{observe:async()=>snap()});
  assert.equal(calls[0].tool,'open_url');assert.match(calls[0].args.url,/^shortcuts:\/\/run-shortcut\?/);
  assert.equal(new URL(calls[0].args.url).searchParams.get('text'),'hello & world');
  assert.equal(calls[0].args.workflow_key,undefined);assert.equal(r.postcondition_verified,true);
});
test('cancelled app-action approval never triggers a second open or a verification claim',async()=>{
  let reads=0;const ctx={dispatch:async()=>({isError:true,content:[{type:'text',text:'cancelled'}],_meta:{stop_reason:'cancelled'}})};
  const r=await executeAppAction(ctx,{shortcut:'Poki Probe',expected_app:'Calculator',expect:{all:['1']}},{observe:async()=>{reads++;return snap();}});
  assert.equal(r.isError,true);assert.equal(reads,0);assert.notEqual(r.postcondition_verified,true);
});

const choices=()=>{const s=snap();s.elements=[{role:'Button',object_id:'a',label:'Basic',enabled:true},{role:'Button',object_id:'b',label:'Scientific',enabled:true}];return s;};
test('an exact observed choice uses no model, no dialog and no network',async()=>{
  let external=0;const ctx={target:async()=>({id:'phone'}),coordinator:{revision:()=>2}};
  const r=await chooseAction(ctx,{expected_app:'Calculator',goal:'Choose Scientific',labels:['Basic','Scientific'],exact_label:'Scientific',use_model:true},
    {observe:async()=>choices(),approve:async()=>{external++;},propose:async()=>{external++;}});
  assert.equal(r.label,'Scientific');assert.equal(r.source,'local');assert.equal(external,0);assert.equal(r.execution_authorized,false);
});
test('ambiguous choice with model disabled stays local',async()=>{
  const ctx={target:async()=>({id:'phone'}),coordinator:{revision:()=>2}};
  const r=await chooseAction(ctx,{expected_app:'Calculator',goal:'Choose a mode',labels:['Basic','Scientific']},{observe:async()=>choices()});
  assert.equal(r.action_id,'REOBSERVE');assert.equal(r.model_calls,0);
});
test('external choice needs real approval and reobserves after approval; it returns only a proposal',async()=>{
  let reads=0,requests=0;const ctx={target:async()=>({id:'phone'}),coordinator:{revision:()=>2}};
  const r=await chooseAction(ctx,{expected_app:'Calculator',goal:'Choose a mode',labels:['Basic','Scientific'],use_model:true},
    {observe:async()=>{reads++;return choices();},approve:async()=>({completed:true}),propose:async(input)=>{requests++;assert.deepEqual(input.actions.map(a=>a.label),['Basic','Scientific']);return {action_id:'a1',source:'jev',execution_authorized:false};}});
  assert.equal(reads,2);assert.equal(requests,1);assert.equal(r.label,'Scientific');assert.equal(r.execution_authorized,false);
});
test('refused external approval makes zero model calls',async()=>{
  let requests=0;const ctx={target:async()=>({id:'phone'}),coordinator:{revision:()=>2}};
  const r=await chooseAction(ctx,{expected_app:'Calculator',goal:'Choose',labels:['Basic','Scientific'],use_model:true},
    {observe:async()=>choices(),approve:async()=>({completed:false}),propose:async()=>{requests++;}});
  assert.equal(requests,0);assert.equal(r.action_id,'STOP');
});
test('foreground changing during approval prevents any external request',async()=>{
  let reads=0,requests=0;const ctx={target:async()=>({id:'phone'}),coordinator:{revision:()=>2}};
  const r=await chooseAction(ctx,{expected_app:'Calculator',goal:'Choose',labels:['Basic','Scientific'],use_model:true},
    {observe:async()=>{const s=choices();if(reads++)s.foreground.name='Other';return s;},approve:async()=>({completed:true}),propose:async()=>{requests++;}});
  assert.equal(r.action_id,'STOP');assert.equal(requests,0);
});
test('a secure field refuses a numeric burst even when all numeric keys are present',async()=>{
  let sent=0;const s=snap();s.elements.push({role:'SecureTextField'});
  const ctx={target:async()=>({id:'phone',kind:'physical'}),coordinator:{revision:()=>2},input:async()=>{sent++;}};
  const r=await executeTapSequence(ctx,{expected_app:'Calculator',labels:['1','2'],fixed_layout:true},{observe:async()=>s});
  assert.equal(r.sent,false);assert.equal(sent,0);
});
test('numeric key geometry is revalidated immediately before the native dispatch',async()=>{
  let reads=0,sent=0;
  const ctx={target:async()=>({id:'phone',kind:'physical'}),coordinator:{revision:()=>2},input:async(_request,{beforeDispatch})=>{
    const guard=await beforeDispatch();if(guard)return guard;sent++;return {sent:true};
  }};
  const r=await executeTapSequence(ctx,{expected_app:'Calculator',labels:['1','2'],fixed_layout:true},{observe:async()=>{
    const s=snap();if(reads++)s.elements[1].frame.x+=3;return s;
  }});
  assert.equal(r.sent,false);assert.equal(r.reason,'key_layout_changed_before_dispatch');assert.equal(sent,0);assert.equal(reads,2);
});
test('a numeric burst leaves another recording owner untouched',async()=>{
  let reads=0;
  const ctx={target:async()=>({id:'phone',kind:'physical'}),peers:()=>[{backgroundDevices:new Map([['phone',new Set(['recording'])]])}]};
  const r=await executeTapSequence(ctx,{expected_app:'Calculator',labels:['1','2'],fixed_layout:true},{observe:async()=>{reads++;}});
  assert.equal(r.sent,false);assert.equal(reads,0);
});
