import test from 'node:test';
import assert from 'node:assert/strict';
import {routeShortcutCallback,ShortcutCallbackQueue,CALLBACK_QUEUE_NAME} from '../src/shortcut-callback-router.mjs';

const token='s'.repeat(64);
const path='/app-actions/callback?id='+'a'.repeat(64)+'&outcome=success&token='+'b'.repeat(64)+'&result=private-output';
const payload={method:'app-actions/callback',params:{path}};
const external=(suffix,options={})=>new Request('https://callback.example'+suffix,options);
const internal=(suffix,body)=>new Request('https://callback.internal/callback/'+suffix,body===undefined?{}:{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const authenticated=(suffix,options={})=>external(suffix,{...options,headers:{authorization:'Bearer '+token,...options.headers}});

test('public callback uses the isolated result queue and never reflects result data',async()=>{
  let seen;
  const hub={fetch:async(url,options)=>{seen={url,options,body:JSON.parse(options.body)};return Response.json({status:200});}};
  const response=await routeShortcutCallback(external(path),{bridgeToken:token,hub});
  assert.equal(CALLBACK_QUEUE_NAME,'shortcut-callbacks-v1');
  assert.equal(response.status,200);
  assert.equal(new URL(seen.url).pathname,'/callback/enqueue');
  assert.deepEqual(seen.body,payload);
  assert.equal(seen.options.headers.authorization,undefined);
  assert.doesNotMatch(await response.text(),/private-output|bbbb/);
  assert.equal(response.headers.get('cache-control'),'no-store');
});
test('malformed and body-bearing callbacks do not reach any queue',async()=>{
  let calls=0;
  const options={bridgeToken:token,hub:{fetch:async()=>{calls++;return Response.json({status:200});}}};
  for(const request of [
    external(path,{headers:{'content-length':'1'}}),
    external(path,{headers:{'transfer-encoding':'chunked'}}),
    external(path+'&__proto__=x'),external(path+'&token=duplicate'),
    external(path.replace('success','other')),external(path+'&result='+'x'.repeat(33000)),
  ])assert.equal((await routeShortcutCallback(request,options)).status,400);
  assert.equal((await routeShortcutCallback(external(path,{method:'POST'}),options)).status,405);
  assert.equal(await routeShortcutCallback(external('/mcp'),options),null);
  assert.equal(calls,0);
});
test('callback bridge endpoints require the existing bearer token and exact methods',async()=>{
  const seen=[];
  const hub={fetch:async(url,options)=>{seen.push({url,options});return Response.json({job:null});}};
  for(const suffix of ['/bridge/callback/poll','/bridge/callback/complete']){
    assert.equal((await routeShortcutCallback(external(suffix),{bridgeToken:token,hub})).status,401);
    assert.equal((await routeShortcutCallback(authenticated(suffix),{bridgeToken:'wrong',hub})).status,401);
  }
  assert.equal((await routeShortcutCallback(authenticated('/bridge/callback/poll',{method:'POST'}),{bridgeToken:token,hub})).status,405);
  assert.equal((await routeShortcutCallback(authenticated('/bridge/callback/poll'),{bridgeToken:token,hub})).status,200);
  assert.equal(seen.length,1);assert.equal(new URL(seen[0].url).pathname,'/callback/poll');
});
test('complete accepts only a small id and allowlisted status, not output or tool data',async()=>{
  let calls=0;
  const options={bridgeToken:token,hub:{fetch:async()=>{calls++;return Response.json({accepted:true});}}};
  const id='a'.repeat(8)+'-aaaa-4aaa-8aaa-'+'a'.repeat(12);
  const post=body=>authenticated('/bridge/callback/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  for(const body of [{id,result:{status:500}},{id,result:{status:200,token:'private'}},{id,result:{status:200},command:'run'},{id:'x'.repeat(300),result:{status:200}}]){
    assert.equal((await routeShortcutCallback(post(body),options)).status,body.id.length>100?413:400);
  }
  assert.equal(calls,0);
  assert.equal((await routeShortcutCallback(post({id,result:{status:200}}),options)).status,200);
  assert.equal(calls,1);
});
test('callback queue leases one job once and accepts exactly one bounded completion',async()=>{
  const queue=new ShortcutCallbackQueue({jobTimeoutMs:1000,pollTimeoutMs:5});
  const waiting=queue.fetch(internal('enqueue',payload));
  const job=(await (await queue.fetch(internal('poll'))).json()).job;
  assert.deepEqual(job.payload,payload);assert.ok(job.expires_at>Date.now());
  assert.deepEqual(await (await queue.fetch(internal('poll'))).json(),{job:null});
  assert.equal((await queue.fetch(internal('complete',{id:job.id,result:{status:403}}))).status,200);
  assert.deepEqual(await (await waiting).json(),{status:403});
  assert.equal((await queue.fetch(internal('complete',{id:job.id,result:{status:200}}))).status,410);
});
test('separate queue bounds outstanding jobs, pollers, malformed input and lifetime',async()=>{
  const queue=new ShortcutCallbackQueue({maxJobs:1,maxPollers:1,jobTimeoutMs:30,pollTimeoutMs:10});
  const waiting=queue.fetch(internal('enqueue',payload));
  const job=(await (await queue.fetch(internal('poll'))).json()).job;
  assert.equal((await queue.fetch(internal('enqueue',payload))).status,429);
  assert.equal((await waiting).status,504);
  assert.equal((await queue.fetch(internal('complete',{id:job.id,result:{status:200}}))).status,410);
  const poll=queue.fetch(internal('poll'));
  assert.equal((await queue.fetch(internal('poll'))).status,429);
  assert.deepEqual(await (await poll).json(),{job:null});
  assert.equal((await queue.fetch(internal('enqueue',{method:'tools/call',params:{name:'open_url'}}))).status,400);
});
test('router bounds a stalled queue and never returns its private diagnostics',async()=>{
  const result=await routeShortcutCallback(external(path),{bridgeToken:token,
    hub:{fetch:()=>new Promise(()=>{})},exchangeTimeoutMs:10});
  assert.equal(result.status,503);
  assert.doesNotMatch(await result.text(),/private-output|bbbb/);
});
