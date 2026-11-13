import test from 'node:test';
import assert from 'node:assert/strict';
import {Devices} from '../src/device.mjs';
import {interaction} from '../src/interaction.mjs';
import {work} from '../src/work.mjs';

function fixture(edit=()=>{}) {
 const d=new Devices();
 const elements=[{role:'Application',label:'Fixture',frame:{x:0,y:0,width:430,height:932}},{role:'Button',label:'Open',frame:{x:10,y:100,width:100,height:40}}];
 let calls=0;
 d.target=async()=>({id:'fixture-phone',kind:'physical'});
 d.coordinator={revision:()=>3};
 d.seen={device:'fixture-phone',revision:3,liveRead:true,rootVerified:true,at:performance.now(),startedAt:performance.now(),elements,foreground:{name:'Fixture'}};
 edit(d.seen);
 d.bridge=async()=>{calls++;return {foreground:{name:'Fixture'},elements};};
 return {d,calls:()=>calls};
}
test('a just-completed complete live AX result is reusable without another subscription',async()=>{
 const f=fixture();const seen=f.d.seen;
 assert.equal(await f.d.structure(200,{forInput:true}),seen);assert.equal(f.calls(),0);
});
for(const [name,edit] of [
 ['another scene revision',s=>s.revision=2],
 ['an event hint',s=>s.liveRead=false],
 ['unverified viewport',s=>s.rootVerified=false],
 ['expired receipt',s=>s.at-=201],
 ['other device',s=>s.device='other'],
 ['a system prompt',s=>s.elements.push({role:'StaticText',label:'Allow Paste'})],
]) test(`a recent cache from ${name} requires a fresh native subscription`,async()=>{
 const f=fixture(edit);const previous=f.d.seen;
 assert.notEqual(await f.d.structure(200,{forInput:true}),previous);assert.equal(f.calls(),1);
});

test('a fast semantic tap can consume the immediate live result but dispatches only once',async()=>{
 const f=fixture();let requestedAge,sent=0;
 const ctx={target:async()=>({id:'fixture-phone'}),lastInputAt:-Infinity,
  structure:async(age,options)=>{requestedAge=age;return f.d.structure(age,options);},
  input:async()=>{sent++;return {sent:true};},
 };
 await work.run({signal:new AbortController().signal,timings:[]},()=>interaction(ctx,'tap_text',{text:'Open',verify:false}));
 assert.equal(requestedAge,200);assert.equal(f.calls(),0);assert.equal(sent,1);
});

test('a bounded readback can report a rootless live tree without granting input geometry',async()=>{
 const f=fixture(s=>s.rootVerified=false);const seen=f.d.seen;
 assert.equal(await f.d.structure(200),seen);assert.equal(f.calls(),0);
 f.d.resolved={id:'fixture-phone'};f.d.bindSemanticViewport();assert.equal(f.d.axSize,undefined);
});

test('semantic rebinding retains original receipt age and never renews stale or changed geometry',()=>{
 const f=fixture();f.d.resolved={id:'fixture-phone'};
 f.d.bindSemanticViewport();assert.equal(f.d.axSize.width,430);assert.equal(f.d.axSize.at,f.d.seen.at);
 for(const change of [s=>s.at-=201,s=>s.revision--,s=>s.rootVerified=false,s=>s.liveRead=false,s=>s.device='other']){
  const g=fixture(change);g.d.resolved={id:'fixture-phone'};g.d.bindSemanticViewport();assert.equal(g.d.axSize,undefined);
 }
});
