import test from 'node:test';
import assert from 'node:assert/strict';
import {Coordination} from '../src/coordination.mjs';
import {inputLockFromEnv} from '../src/input-lock.mjs';

const setup=()=>{const c=new Coordination();c.inputLock=inputLockFromEnv({POKI_INPUT_LOCK:'1',POKI_INPUT_LOCK_WAIT_MS:'1000'});return c;};
const session=()=>({label:'diagnostic',backgroundDevices:new Map(),resolveDevice:async id=>id,dispatch:async()=>({content:[{type:'text',text:'done'}]}),cleanup:async()=>({})});
async function independent(c,args){
  const release=await c.inputLock.acquire('other-phone',{session:'recording-owner',tool:'tap'});
  let timer;
  try {
    const result=await Promise.race([c.call(session(),'batch_commands',args),new Promise(resolve=>{timer=setTimeout(()=>resolve('blocked'),150);})]);
    assert.notEqual(result,'blocked','Independent work must not queue behind input on another phone');
  }finally{clearTimeout(timer);release();}
}
test('a read-only batch does not acquire a global input lock',async()=>{
  await independent(setup(),{commands:[{tool:'wait',arguments:{seconds:0}}]});
});
test('a wait inside an exact-device input batch cannot widen its lock to every phone',async()=>{
  await independent(setup(),{commands:[{tool:'tap',arguments:{device:'target-phone',x:1,y:1}},{tool:'wait',arguments:{seconds:0}}]});
});
test('an unresolved input batch still waits for all-device arbitration',async()=>{
  const c=setup(),release=await c.inputLock.acquire('other-phone',{session:'owner',tool:'tap'});
  let ran=false;const s=session();s.dispatch=async()=>{ran=true;return{content:[]};};
  const controller=new AbortController();
  const pending=c.call(s,'batch_commands',{commands:[{tool:'tap',arguments:{x:1,y:1}}]},controller.signal);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(ran,false);
  controller.abort(new Error('test cancellation'));await assert.rejects(pending,/test cancellation/);release();
});
test('the receipt identifies time spent waiting for the input lock',async()=>{
  const c=setup(),release=await c.inputLock.acquire('target-phone',{session:'owner',tool:'tap'});
  const s=session();s.dispatch=async()=>({content:[{type:'text',text:JSON.stringify({completed_steps:1,stop_reason:null})}]});
  const pending=c.call(s,'batch_commands',{commands:[{tool:'tap',arguments:{device:'target-phone',x:1,y:1}}]});
  await new Promise(resolve=>setTimeout(resolve,80));release();
  const summary=JSON.parse((await pending).content.at(-1).text);
  assert.ok(summary.timing.admission.lock_wait_ms>=40);
  assert.ok(summary.timing.queue_ms>=summary.timing.admission.lock_wait_ms);
  assert.ok(summary.timing.service_ms+2>=summary.timing.queue_ms);
  assert.ok(summary.timing.admission.device_resolution_ms<40);
});
test('an early batch failure retains timing in content when the host strips metadata',async()=>{
  const c=setup(),s=session();s.dispatch=async()=>{throw new Error('synthetic preflight failure');};
  const result=await c.call(s,'batch_commands',{commands:[{tool:'wait',arguments:{seconds:0}}]});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/synthetic preflight failure/);
  let summary;assert.doesNotThrow(()=>{summary=JSON.parse(result.content.at(-1).text);});
  assert.equal(summary.diagnostic_only,true);
  assert.ok(summary.timing.service_ms>=0);
  assert.equal(summary.timing.admission.device_resolution_ms,0);
});
