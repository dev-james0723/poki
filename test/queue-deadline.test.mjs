import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordination } from '../src/coordination.mjs';
import { snapshotUI } from '../src/ax-snapshot.mjs';
import { setTimeout as wait } from 'node:timers/promises';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const payload={elements:[{type:'Application',frame:{x:0,y:0,width:100,height:200}}]};

test('snapshot deadline includes queued time, but never frees an active unrelated operation',async()=>{
 const c=new Coordination(), gate=deferred(), entered=deferred(); let reads=0, laterInput=0, snapResult;
 const busy={cleanup:async()=>({}),dispatch:async()=>{entered.resolve();await gate.promise;return {content:[]};}};
 const reader={coordinator:c,cleanup:async()=>({}),target:async()=>({id:'other-phone'}),bridge:async()=>{reads++;return payload;},dispatch:async(_n,args)=>({content:[{type:'text',text:JSON.stringify(await snapshotUI(reader,args))}]})};
 const input={cleanup:async()=>({}),dispatch:async()=>{laterInput++;return {content:[]};}};
 const first=c.call(busy,'wait',{});await entered.promise;
 const snap=c.call(reader,'snapshot_ui',{timeout_ms:120}).then(x=>{snapResult=x;},e=>{snapResult=e;});
 const last=c.call(input,'tap',{});
 try { await wait(300);assert.ok(snapResult,'snapshot did not report its timeout while queued');assert.equal(reads,0);assert.equal(laterInput,0); }
 finally {gate.resolve();await Promise.allSettled([first,snap,last]);}
 assert.equal(reads,0,'timed-out queued read ran later');assert.equal(laterInput,1);
});

test('already cancelled requests never dispatch even when queue is busy',async()=>{
 const c=new Coordination(), gate=deferred(), entered=deferred();let calls=0;
 const owner={cleanup:async()=>({}),dispatch:async()=>{entered.resolve();await gate.promise;return {content:[]};}};
 const other={cleanup:async()=>({}),dispatch:async()=>{calls++;return {content:[]};}};
 const first=c.call(owner,'wait',{});await entered.promise;
 const cancel=new AbortController();cancel.abort(new DOMException('cancelled','AbortError'));
 let observed;const promise=c.call(other,'snapshot_ui',{timeout_ms:100},cancel.signal).catch(e=>{observed=e;});
 try {await wait(40);assert.equal(observed?.name,'AbortError');assert.equal(calls,0);}
 finally {gate.resolve();await Promise.allSettled([first,promise]);}
 assert.equal(calls,0);
});

test('a timed-out started read retains queue ownership until actual completion',async()=>{
 const c=new Coordination(),gate=deferred(),entered=deferred();let cleanup=0,input=0;
 const background=new Set(['recording','location']), nativeOwners=new Set();
 const reader={coordinator:c,cleanup:async()=>{cleanup++;background.clear();nativeOwners.clear();return {};},ownNativeResources:target=>nativeOwners.add(target.id),target:async()=>({id:'phone'}),bridge:async()=>{entered.resolve();await gate.promise;return payload;},dispatch:async(_n,args)=>({content:[{type:'text',text:JSON.stringify(await snapshotUI(reader,args))}]})};
 const other={cleanup:async()=>({}),dispatch:async()=>{input++;return {content:[]};}};
 let outcome;const reading=c.call(reader,'snapshot_ui',{timeout_ms:100,event_stream:true}).then(x=>{outcome=x;},e=>{outcome=e;});await entered.promise;
 const later=c.call(other,'tap',{});
 try {await wait(200);assert.equal(input,0);assert.equal(outcome,undefined,'must not claim termination before native operation stops');}
 finally {gate.resolve();await Promise.allSettled([reading,later]);}
 assert.equal(input,1);assert.equal(cleanup,0);assert.deepEqual([...background],['recording','location']);assert.ok(nativeOwners.has('phone'));assert.equal(outcome?.isError,true);
 assert.match(outcome.content[0].text,/deadline/i);
 await c.end(reader,'session_closed');assert.equal(cleanup,1);assert.equal(nativeOwners.size,0);
});

test('explicit request cancellation keeps prior session cleanup semantics',async()=>{
 const c=new Coordination(),entered=deferred();let cleaned=0;
 const controller=new AbortController();
 const reader={cleanup:async()=>{cleaned++;return {};},dispatch:async()=>{
   entered.resolve();await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));
   throw controller.signal.reason;
 }};
 const result=c.call(reader,'snapshot_ui',{timeout_ms:1000},controller.signal);
 await entered.promise;controller.abort(new DOMException('cancelled','AbortError'));await result;
 assert.equal(cleaned,1);
});

test('official input-lock scheduling preserves the local snapshot deadline while queued in one session',async()=>{
 const {inputLockFromEnv}=await import('../src/input-lock.mjs');
 const c=new Coordination();c.inputLock=inputLockFromEnv({POKI_INPUT_LOCK:'1',POKI_MAX_CONCURRENT_READS:'2'});
 const gate=deferred(),entered=deferred();let reads=0;
 const ctx={cleanup:async()=>({}),dispatch:async(name)=>{if(name==='wait'){entered.resolve();await gate.promise;}else reads++;return {content:[]};}};
 const first=c.call(ctx,'wait',{});await entered.promise;
 let outcome;const snapshot=c.call(ctx,'snapshot_ui',{timeout_ms:100}).catch(e=>{outcome=e;});
 try {await wait(180);assert.equal(outcome?.name,'TimeoutError');assert.equal(reads,0);}
 finally {gate.resolve();await Promise.allSettled([first,snapshot]);await ctx.queue;}
 assert.equal(reads,0);assert.equal(c.inputLock.reads,0);assert.equal(c.inputLock.holders.size,0);
});
