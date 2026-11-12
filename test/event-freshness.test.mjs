import test from 'node:test';import assert from 'node:assert/strict';
import {snapshotUI} from '../src/ax-snapshot.mjs';import {work} from '../src/work.mjs';
const tree={foreground:{name:'Trip.com',pid:1},elements:[{role:'Application',label:'Trip.com',frame:{x:0,y:0,width:430,height:932}},{role:'Button',label:'Open',frame:{x:1,y:1,width:20,height:20}}]};
function context(event){return {target:async()=>({id:'phone',kind:'physical'}),ownNativeResources(){},coordinator:{revision:()=>2},bridge:async()=>({...tree,...(event?{observation_source:'accessibility_event',source_age_ms:20}:{})})};}
const observe=ctx=>work.run({signal:new AbortController().signal,timings:[]},()=>snapshotUI(ctx,{event_stream:true}));
test('an AX event receipt is not an authoritative live input or geometry cache',async()=>{const ctx=context(true),r=await observe(ctx);assert.equal(ctx.seen,undefined);assert.equal(ctx.axSize,undefined);assert.equal(ctx.size,undefined);assert.equal(r.observation.input_freshness,'requires_live_read');});
test('a fresh direct AX read may seed the bounded local cache',async()=>{const ctx=context(false),r=await observe(ctx);assert.equal(ctx.seen.foreground.name,'Trip.com');assert.equal(ctx.axSize.width,430);assert.equal(r.observation.input_freshness,'live_read');});

test('default AX budget admits the observed five-second healthy read tail',async()=>{let requested;const ctx=context(false);ctx.bridge=async args=>{requested=args;return tree;};await work.run({signal:new AbortController().signal,timings:[]},()=>snapshotUI(ctx,{}));assert.equal(requested.timeout_ms,6000);});
test('event observation does not claim a current-request start before an older received event',async()=>{const r=await observe(context(true));assert.equal(r.observation.structure_started_at,null);assert.ok(r.observation.request_started_at);});

test('AX diagnostics retain only bounded numeric phase counters',async()=>{
 const ctx=context(false);
 ctx.bridge=async()=>({...tree,native_ax:{attempts:1,total_ms:1400,answer_ms:900,cleanup_ms:100,connect_ms:-1,subscribe_ms:Infinity,private_text:'do not export',clipboard:'do not export'}});
 const r=await observe(ctx);
 assert.deepEqual(r.native_ax,{attempts:1,total_ms:1400,answer_ms:900,cleanup_ms:100});
 assert.equal(ctx.seen.liveRead,true);
});
