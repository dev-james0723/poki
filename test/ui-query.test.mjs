import test from 'node:test';
import assert from 'node:assert/strict';
import {queryUI as runQuery,waitForUI as runWait} from '../src/ui-query.mjs';
import {uiQueryDefinitions} from '../src/ui-query-schema.mjs';
import {work,signal} from '../src/work.mjs';

// Match the dispatcher work context that owns cancellation and timing spans.
const inWork=operation=>work.getStore()?operation():work.run({signal:new AbortController().signal,timings:[]},operation);
const queryUI=(...args)=>inWork(()=>runQuery(...args));
const waitForUI=(...args)=>inWork(()=>runWait(...args));

const appId='test.poki.fixture';
const root={role:'Application',label:'Fixture',frame:{x:0,y:0,width:430,height:932}};
const field={role:'TextField',label:'Draft',object_id:'o-field',value:'你好 👋',frame:{x:20,y:100,width:300,height:50}};
const button={role:'Button',label:'Continue',object_id:'o-button',frame:{x:20,y:200,width:100,height:44}};
const tree=(elements=[field],extra={})=>({elements:[root,...elements],foreground:{bundle_id:appId,pid:7},complete:true,...extra});
const condition=(state='present',extra={})=>({query:{object_ids:['o-field']},state,...extra});
const args=(state='present',extra={})=>({expected_app:appId,condition:condition(state,extra)});
function fixture(reads=[tree()]){
  let revision=3,index=0,targetCalls=0,device='fixture-phone';
  const calls=[],seen={sentinel:'input-cache'},size={sentinel:'size'},axSize={sentinel:'ax-size'};
  const ctx={seen,size,axSize,coordinator:{revision:()=>revision},
    target:async()=>{targetCalls++;return {id:device};},
    bridge:async request=>{
      calls.push(request);
      const next=reads[Math.min(index++,reads.length-1)];
      return typeof next==='function'?next():structuredClone(next);
    }};
  return {ctx,calls,seen,size,axSize,get targetCalls(){return targetCalls;},
    revision:()=>{revision++;},device:value=>{device=value;}};
}

test('query_ui returns exact field proof without screenshots, refs or input-cache changes',async()=>{
  const f=fixture();const r=await queryUI(f.ctx,args('field_equals',{field:'value',equals:'你好 👋'}));
  assert.equal(r.matched,true);assert.equal(r.stop_reason,'matched');
  assert.equal(r.verification,'fresh_native_accessibility');assert.equal(r.image_captured,false);
  assert.equal(r.observation.device,'fixture-phone');assert.equal(r.foreground.bundle_id,appId);
  assert.equal(r.scope.native_tree_read,'complete');assert.equal(r.scope.complete,true);
  assert.equal(r.elements.length,1);assert.equal(r.elements[0].ref,undefined);
  assert.equal(r.attempts,1);assert.ok(r.elapsed_ms>=0);
  assert.deepEqual(f.calls.map(c=>c.op),['ax']);assert.equal(f.calls[0].event_stream,false);
  assert.equal(f.ctx.seen,f.seen);assert.equal(f.ctx.size,f.size);assert.equal(f.ctx.axSize,f.axSize);
});

test('field equality preserves Unicode, whitespace and case exactly',async()=>{
  for(const [actual,expected] of [['e\u0301','é'],['draft ','draft'],['Draft','draft']]){
    const f=fixture([tree([{...field,value:actual}])]);
    const r=await queryUI(f.ctx,args('field_equals',{field:'value',equals:expected}));
    assert.equal(r.matched,false);assert.equal(r.stop_reason,'condition_not_met');
  }
});

test('duplicate target does not satisfy unique or exact field conditions',async()=>{
  for(const state of ['unique','field_equals']){
    const f=fixture([tree([field,{...field,object_id:'o-second'}])]);
    const r=await queryUI(f.ctx,{expected_app:appId,condition:{query:{labels:['Draft']},state,...(state==='field_equals'?{field:'value',equals:field.value}:{})}});
    assert.equal(r.matched,false);assert.equal(r.match_count,2);
  }
});

test('bounds are checked on the unique live target with bounded tolerance',async()=>{
  const expected_bounds={x:20.4,y:100,width:300,height:50};
  const f=fixture();
  assert.equal((await queryUI(f.ctx,args('bounds_match',{expected_bounds,tolerance:0.5}))).matched,true);
  assert.equal((await queryUI(f.ctx,args('bounds_match',{expected_bounds,tolerance:0.1}))).matched,false);
});

test('invalid selectors, equality fields and bounds reject before device work',async()=>{
  const candidates=[
    {...args(),condition:{state:'present',query:{}}},
    args('field_equals',{field:'label',equals:'Draft'}),
    args('bounds_match',{expected_bounds:{x:20,y:100,width:-1,height:50},tolerance:0}),
    args('bounds_match',{expected_bounds:field.frame,tolerance:11}),
    {...args(),timeout_ms:99},
    {...args(),condition:{...condition(),unknown:true}}
  ];
  for(const input of candidates){
    const f=fixture();await assert.rejects(queryUI(f.ctx,input));
    assert.equal(f.calls.length,0);assert.equal(f.targetCalls,0);
  }
  const f=fixture();await assert.rejects(waitForUI(f.ctx,{...args(),poll_ms:99}));
  assert.equal(f.calls.length,0);assert.equal(f.targetCalls,0);
});

test('absence requires complete, nonempty, root-verified native source',async()=>{
  for(const incomplete of [
    tree([],{complete:false}),tree([],{complete:undefined}),tree([],{truncated:true}),tree([],{elements:[]}),
    tree([],{elements:[button]}),tree([],{elements:[{...root,frame:{x:1,y:0,width:430,height:932}}]})
  ]){
    const f=fixture([incomplete]);const r=await queryUI(f.ctx,args('absent'));
    assert.equal(r.matched,false);assert.equal(r.isError,true);
    assert.ok(['incomplete_source','source_unavailable'].includes(r.stop_reason),JSON.stringify(r));
  }
  const r=await queryUI(fixture([tree([])]).ctx,args('absent'));
  assert.equal(r.matched,true);assert.equal(r.scope.visible_screen,true);
});

test('offscreen or explicitly hidden target cannot prove presence',async()=>{
  for(const hidden of [{...field,frame:{x:20,y:1500,width:300,height:50}},{...field,visible:false}]){
    const r=await queryUI(fixture([tree([hidden])]).ctx,args());
    assert.equal(r.matched,false);assert.equal(r.match_count,0);
  }
});

test('wrong foreground, event data and old source cannot prove a condition',async()=>{
  const cases=[
    [tree([field],{foreground:{bundle_id:'other.app',pid:9}}),'wrong_app'],
    [tree([field],{observation_source:'accessibility_event',source_age_ms:0}),'stale_observation'],
    [tree([field],{source_age_ms:10}),'stale_observation']
  ];
  for(const [source,reason] of cases){
    const r=await queryUI(fixture([source]).ctx,args());
    assert.equal(r.matched,false);assert.equal(r.isError,true);assert.equal(r.stop_reason,reason);
  }
});

test('full-tree prompt detection runs before projecting target rows',async()=>{
  const f=fixture([tree([field,{role:'StaticText',label:'Enter iPhone Passcode',frame:{x:10,y:10,width:300,height:40}}])]);
  const r=await queryUI(f.ctx,args());
  assert.equal(r.matched,false);assert.equal(r.stop_reason,'prompt');assert.equal(r.prompt.kind,'passcode');
});

test('revision or target changes during observation cannot verify the result',async()=>{
  const revision=fixture();revision.ctx.bridge=async()=>{revision.revision();return tree();};
  const r=await queryUI(revision.ctx,args());
  assert.equal(r.matched,false);assert.equal(r.stop_reason,'stale_observation');
  const changed=fixture();changed.ctx.bridge=async()=>{changed.device('other-phone');return tree();};
  const d=await queryUI(changed.ctx,args());
  assert.equal(d.matched,false);assert.equal(d.stop_reason,'device_changed');
});

test('wait_for_ui uses bounded fresh AX polling and returns matching observation',async()=>{
  const f=fixture([tree([]),tree()]);
  const r=await waitForUI(f.ctx,{...args(),timeout_ms:1000,poll_ms:100});
  assert.equal(r.matched,true);assert.equal(r.attempts,2);assert.equal(r.elements[0].object_id,field.object_id);
  assert.deepEqual(f.calls.map(c=>c.op),['ax','ax']);
  assert.ok(f.calls.every(c=>c.timeout_ms<=1000&&c.event_stream===false));
});

test('wait stops on a prompt instead of polling through it',async()=>{
  const f=fixture([tree([{role:'StaticText',label:'Enter iPhone Passcode',frame:{x:10,y:10,width:300,height:40}}]),tree()]);
  const r=await waitForUI(f.ctx,{...args(),timeout_ms:500,poll_ms:100});
  assert.equal(r.stop_reason,'prompt');assert.equal(f.calls.length,1);
});

test('wait timeout and cancellation cannot report successful proof or send input',async()=>{
  const f=fixture([tree([])]);const started=performance.now();
  const r=await waitForUI(f.ctx,{...args(),timeout_ms:150,poll_ms:100});
  assert.equal(r.matched,false);assert.equal(r.stop_reason,'timeout');assert.equal(r.isError,true);
  assert.ok(performance.now()-started<1500);assert.ok(f.calls.every(c=>c.op==='ax'));
  const controller=new AbortController();let pending;
  const aborted=fixture([()=>new Promise((resolve,reject)=>{
    pending=setTimeout(()=>resolve(tree()),2000);
    const pendingSignal=signal();
    pendingSignal.addEventListener('abort',()=>{clearTimeout(pending);reject(pendingSignal.reason);},{once:true});
  })]);
  const promise=work.run({signal:controller.signal,timings:[]},()=>waitForUI(aborted.ctx,{...args(),timeout_ms:1000,poll_ms:100}));
  setTimeout(()=>controller.abort(new DOMException('Cancelled by test','AbortError')),20);
  const cancelled=await promise;
  assert.equal(cancelled.matched,false);assert.equal(cancelled.stop_reason,'cancelled');assert.equal(cancelled.isError,true);
  assert.equal(aborted.calls.length,1);assert.equal(aborted.ctx.seen,aborted.seen);
});

test('concurrent device queries keep identities and results isolated',async()=>{
  const a=fixture([tree()]),b=fixture([tree([{...field,value:'other'}])]);b.device('second-phone');
  const [one,two]=await Promise.all([queryUI(a.ctx,args('field_equals',{field:'value',equals:field.value})),queryUI(b.ctx,args('field_equals',{field:'value',equals:field.value}))]);
  assert.equal(one.matched,true);assert.equal(two.matched,false);
  assert.equal(one.observation.device,'fixture-phone');assert.equal(two.observation.device,'second-phone');
});

test('definitions export discoverable strict read-only contracts',()=>{
  assert.deepEqual(uiQueryDefinitions.map(d=>d[0]),['query_ui','wait_for_ui']);
  for(const [name,description,schema,readOnly] of uiQueryDefinitions){
    assert.equal(readOnly,true);assert.ok(description.includes('complete'));
    assert.equal(schema.safeParse(args()).success,true);
    assert.equal(schema.safeParse({...args(),unexpected:'value'}).success,false,name);
  }
});

test('positive observed-element proofs remain useful when global AX coverage is unknown',async()=>{
  const unknown=tree([field],{complete:undefined});
  const present=await queryUI(fixture([unknown]).ctx,args());
  assert.equal(present.matched,true);assert.equal(present.scope.complete,false);
  assert.equal(present.verification_scope,'observed_visible_element');
  const value=await queryUI(fixture([unknown]).ctx,args('field_equals',{field:'value',equals:field.value}));
  assert.equal(value.matched,true);assert.equal(value.verification_scope,'exact_object');
  const labelsOnly=await queryUI(fixture([unknown]).ctx,{expected_app:appId,condition:{query:{labels:['Draft']},state:'field_equals',field:'value',equals:field.value}});
  assert.equal(labelsOnly.matched,false);assert.equal(labelsOnly.stop_reason,'incomplete_source');
});

test('unknown coverage never proves absence even for an exact object id',async()=>{
  const r=await queryUI(fixture([tree([],{complete:undefined})]).ctx,args('absent'));
  assert.equal(r.matched,false);assert.equal(r.stop_reason,'incomplete_source');
});
