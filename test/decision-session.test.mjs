import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseAction} from '../src/workflow-v2.mjs';
import {work} from '../src/work.mjs';

const scope={apps:['Clock','Settings'],max_calls:3,ttl_seconds:60,purpose:'Observed navigation benchmark'};
const args={expected_app:'Clock',goal:'Measure elapsed time with laps',labels:['Timers','Stopwatch'],use_model:true};
test('operator disables Jev before observation, approval or model access',async t=>{
 const previous=process.env.POKI_JEV_DISABLED;
 t.after(()=>{if(previous===undefined)delete process.env.POKI_JEV_DISABLED;else process.env.POKI_JEV_DISABLED=previous;});
 process.env.POKI_JEV_DISABLED='1';
 const f=fixture();
 const result=await chooseAction(f.ctx,{...args,model_session:scope},f.hooks);
 assert.equal(result.reason,'jev_disabled_by_operator');
 assert.equal(result.model_calls,0);
 assert.deepEqual(f.counts(),{approvals:0,requests:0,reads:0});
 const local=await chooseAction(f.ctx,{...args,exact_label:'Stopwatch'},f.hooks);
 assert.equal(local.source,'local');assert.equal(local.label,'Stopwatch');
 const invalid=await chooseAction(f.ctx,{...args,exact_label:'Not present'},f.hooks);
 assert.equal(invalid.reason,'jev_disabled_by_operator');
 assert.equal(f.counts().requests,0);assert.equal(f.counts().approvals,0);
});
test('disabling Jev revokes an existing model session without another paid request',async t=>{
 const previous=process.env.POKI_JEV_DISABLED;
 t.after(()=>{if(previous===undefined)delete process.env.POKI_JEV_DISABLED;else process.env.POKI_JEV_DISABLED=previous;});
 delete process.env.POKI_JEV_DISABLED;
 const f=fixture();await chooseAction(f.ctx,{...args,model_session:scope},f.hooks);
 process.env.POKI_JEV_DISABLED='1';
 assert.equal((await chooseAction(f.ctx,{...args,use_session:true},f.hooks)).reason,'jev_disabled_by_operator');
 delete process.env.POKI_JEV_DISABLED;
 assert.equal((await chooseAction(f.ctx,{...args,use_session:true},f.hooks)).reason,'model_session_missing');
 assert.equal(f.counts().requests,1);assert.equal(f.counts().approvals,1);
});
function fixture(){
 let approvals=0,requests=0,reads=0,now=Date.now();
 const lease={lease_id:'lease-a',device:'phone',state:'active'};
 const ctx={target:async()=>({id:'phone',kind:'physical'}),coordinator:{revision:()=>1,owned:()=>lease,require:(_ctx,id)=>{if(id!==lease.lease_id||lease.state!=='active')throw Error('lease unavailable');return lease;}}};
 const hooks={now:()=>now,observe:async()=>{reads++;return {source:'accessibility',observation:{id:'observed-'+reads,device:'phone',revision:1,input_freshness:'live_read',structure_completed_at:new Date().toISOString()},foreground:{name:'Clock'},elements:['Timers','Stopwatch'].map((label,i)=>({role:'Button',object_id:'button-'+i,label,enabled:true})),truncated:false,prompt:null};},approve:async()=>{approvals++;return {completed:true};},propose:async(input,options)=>{const grant=await options.authorize();assert.equal(grant.allowed,true);assert.equal(grant.snapshot_id,input.snapshot.observation.id);requests++;return {action_id:'a1',source:'jev',execution_authorized:false,model_calls:1};}};
 return {ctx,lease,hooks,counts:()=>({approvals,requests,reads}),advance:ms=>now+=ms};
}
test('one real scoped consent is reusable only within its exact device lease, expiry and call budget',async()=>{
 const f=fixture();
 const first=await chooseAction(f.ctx,{...args,model_session:scope},f.hooks);
 assert.equal(first.source,'jev');assert.equal(first.model_session.remaining_calls,2);
 for(const remaining of [1,0]){const r=await chooseAction(f.ctx,{...args,use_session:true},f.hooks);assert.equal(r.label,'Stopwatch');assert.equal(r.model_session.remaining_calls,remaining);assert.equal(r.execution_authorized,false);}
 const fourth=await chooseAction(f.ctx,{...args,use_session:true},f.hooks);
 assert.equal(fourth.action_id,'STOP');assert.equal(fourth.reason,'model_session_exhausted');assert.deepEqual(f.counts(),{approvals:1,requests:3,reads:5});
});
for(const [name,change,reason] of [
 ['expired',f=>f.advance(60001),'model_session_expired'],
 ['replacement lease',f=>f.lease.lease_id='lease-b','model_session_lease_changed'],
 ['releasing lease',f=>f.lease.state='releasing','model_session_lease_unavailable'],
])test(`${name} makes no new model call and does not silently ask for a broader grant`,async()=>{
 const f=fixture();await chooseAction(f.ctx,{...args,model_session:scope},f.hooks);change(f);
 const r=await chooseAction(f.ctx,{...args,use_session:true},f.hooks);assert.equal(r.reason,reason);assert.equal(f.counts().requests,1);assert.equal(f.counts().approvals,1);
});
test('a different MCP context cannot use another context consent',async()=>{
 const a=fixture();await chooseAction(a.ctx,{...args,model_session:scope},a.hooks);
 const b=fixture();const r=await chooseAction(b.ctx,{...args,use_session:true},b.hooks);assert.equal(r.reason,'model_session_missing');assert.equal(b.counts().requests,0);assert.equal(b.counts().approvals,0);
});
test('denied consent and absent lease create no capability and make no API request',async()=>{
 const f=fixture();f.hooks.approve=async()=>({completed:false});
 const r=await chooseAction(f.ctx,{...args,model_session:scope},f.hooks);assert.equal(r.reason,'external_decision_not_approved');
 assert.equal((await chooseAction(f.ctx,{...args,use_session:true},f.hooks)).reason,'model_session_missing');assert.equal(f.counts().requests,0);
 const g=fixture();g.ctx.coordinator.owned=()=>undefined;assert.equal((await chooseAction(g.ctx,{...args,model_session:scope},g.hooks)).reason,'model_session_lease_unavailable');assert.equal(g.counts().approvals,0);
});
test('a scoped Jev test cannot take an exact-label local shortcut',async()=>{
 const f=fixture();const r=await chooseAction(f.ctx,{...args,exact_label:'Stopwatch',model_session:scope},f.hooks);assert.equal(r.reason,'model_session_requires_model_only');assert.equal(f.counts().requests,0);assert.equal(f.counts().approvals,0);
});
test('decision and observation timings are separate content-free counters',async()=>{
 const f=fixture();const r=await chooseAction(f.ctx,{...args,exact_label:'Stopwatch',use_model:false},f.hooks);
 assert.equal(r.model_calls,0);for(const k of ['decision_ms','observation_ms','approval_ms'])assert.ok(Number.isFinite(r.decision_timing[k])&&r.decision_timing[k]>=0);
 assert.equal(r.decision_timing.approval_ms,0);assert.equal(f.counts().requests,0);
});
test('real AX navigation labels with trailing whitespace match the normalized reviewed candidates',async()=>{
 const f=fixture(),original=f.hooks.observe;
 f.hooks.observe=async(...params)=>({...await original(...params),foreground:{name:'Trip.com'},elements:['住宿 ','機票 '].map((label,i)=>({role:'Button',object_id:'trip-'+i,label,enabled:true}))});
 const r=await chooseAction(f.ctx,{expected_app:'Trip.com',goal:'Open accommodation search',labels:['住宿','機票'],exact_label:'住宿'},f.hooks);
 assert.equal(r.label,'住宿');assert.equal(r.model_calls,0);assert.equal(f.counts().requests,0);
});
test('normalization never turns two matching AX buttons into a unique candidate',async()=>{
 const f=fixture(),original=f.hooks.observe;
 f.hooks.observe=async(...params)=>({...await original(...params),foreground:{name:'Trip.com'},elements:['住宿','住宿 ','機票'].map((label,i)=>({role:'Button',object_id:'trip-'+i,label,enabled:true}))});
 const r=await chooseAction(f.ctx,{expected_app:'Trip.com',goal:'Open accommodation search',labels:['住宿','機票'],exact_label:'住宿'},f.hooks);
 assert.equal(r.reason,'candidate_state_not_confirmed');assert.equal(f.counts().requests,0);
});
test('request cancellation revokes reusable consent without retrying a model attempt',async()=>{
 const f=fixture(),controller=new AbortController();const original=f.hooks.propose;
 f.hooks.propose=async(...params)=>{const r=await original(...params);controller.abort();return r;};
 await work.run({signal:controller.signal,timings:[]},()=>chooseAction(f.ctx,{...args,model_session:scope},f.hooks));
 assert.equal(f.counts().requests,1);
 const r=await chooseAction(f.ctx,{...args,use_session:true},f.hooks);assert.equal(r.reason,'model_session_missing');assert.equal(f.counts().requests,1);
});
test('app scope cannot silently expand',async()=>{
 const f=fixture();await chooseAction(f.ctx,{...args,model_session:{...scope,apps:['Clock']}},f.hooks);
 const original=f.hooks.observe;f.hooks.observe=async(...params)=>({...await original(...params),foreground:{name:'Settings'}});
 const r=await chooseAction(f.ctx,{...args,expected_app:'Settings',use_session:true},f.hooks);assert.equal(r.reason,'model_session_app_not_approved');assert.equal(f.counts().requests,1);assert.equal(f.counts().approvals,1);
});
test('a failed paid attempt still consumes its slot and never receives an automatic retry',async()=>{
 const f=fixture();f.hooks.propose=async(_input,options)=>{await options.authorize();throw Error('gateway unavailable');};
 await assert.rejects(chooseAction(f.ctx,{...args,model_session:{...scope,max_calls:1}},f.hooks),/gateway unavailable/);
 const r=await chooseAction(f.ctx,{...args,use_session:true},f.hooks);
 assert.equal(r.reason,'model_session_exhausted');assert.equal(f.counts().approvals,1);
});
for(const scopeChange of [{max_calls:121},{ttl_seconds:3601},{apps:['Clock','Clock']},{apps:[]}])test('invalid consent scope is rejected before observing or asking',async()=>{
 const f=fixture();await assert.rejects(chooseAction(f.ctx,{...args,model_session:{...scope,...scopeChange}},f.hooks));assert.deepEqual(f.counts(),{approvals:0,requests:0,reads:0});
});
