import test from 'node:test';
import assert from 'node:assert/strict';
import { relayShortcutCallback } from '../src/shortcut-callback-relay.mjs';
import { forwardShortcutCallback } from '../src/shortcut-callback-forward.mjs';

const path = '/app-actions/callback?id='+'a'.repeat(64)+'&outcome=success&token='+'b'.repeat(64)+'&result=hello';
const request = suffix => new Request('https://callback.example'+suffix);

test('callback ingress forwards only validated result data and never a tool call',async()=>{
  let observed;
  const response=await relayShortcutCallback(request(path),async payload=>{observed=payload;return {status:200};});
  assert.equal(response.status,200);
  assert.equal(observed.method,'app-actions/callback');
  assert.equal(observed.params.path,path);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.doesNotMatch(await response.text(),/bbbb|hello/);
});
test('invalid callbacks never reach the relay queue',async()=>{
  let calls=0;
  const exchange=async()=>{calls++;return {status:200};};
  for(const suffix of [path+'&token='+'c'.repeat(64),path+'&command=run',path+'&__proto__=x',path.replace('success','other')]){
    assert.equal((await relayShortcutCallback(request(suffix),exchange)).status,400);
  }
  assert.equal((await relayShortcutCallback(new Request('https://callback.example'+path,{method:'POST'}),exchange)).status,405);
  assert.equal(calls,0);
});
test('relay failure remains unavailable and never acknowledges a result',async()=>{
  const response=await relayShortcutCallback(request(path),async()=>{throw Error('private details');});
  assert.equal(response.status,503);
  assert.doesNotMatch(await response.text(),/private details|bbbb/);
});
test('local forwarding is restricted to the configured loopback callback endpoint',async()=>{
  let url,options;
  const result=await forwardShortcutCallback({method:'app-actions/callback',params:{path}},{
    readEndpoint:async()=>({url:'http://127.0.0.1:47825/mcp',enabled:true}),
    fetch:async(u,o)=>{url=u;options=o;return new Response('{}',{status:200});},
  });
  assert.deepEqual(result,{status:200});
  assert.equal(String(url),'http://127.0.0.1:47825'+path);
  assert.equal(options.method,'GET');
  assert.equal(options.redirect,'error');
  assert.equal(options.headers.authorization,undefined);
});
test('malicious or unsupported forwarding cannot select an origin or execute a tool',async()=>{
  let fetched=0;
  const options={readEndpoint:async()=>({url:'http://127.0.0.1:47825/mcp',enabled:true}),fetch:async()=>{fetched++;return new Response('{}');}};
  for(const payload of [
    {method:'tools/call',params:{name:'open_url'}},
    {method:'app-actions/callback',params:{path:'https://other.example'+path}},
    {method:'app-actions/callback',params:{path:path+'&other=x'}},
  ]) assert.equal((await forwardShortcutCallback(payload,options)).status,400);
  assert.equal((await forwardShortcutCallback({method:'app-actions/callback',params:{path}},{...options,readEndpoint:async()=>({url:'https://other.example/mcp',enabled:true})})).status,503);
  assert.equal(fetched,0);
});
test('uncertain local transport never retries a callback or exposes error content',async()=>{
  let count=0;
  const result=await forwardShortcutCallback({method:'app-actions/callback',params:{path}},{
    readEndpoint:async()=>({url:'http://127.0.0.1:47825/mcp',enabled:true}),
    fetch:async()=>{count++;throw Error('secret token');},
  });
  assert.equal(result.status,503);assert.equal(count,1);
  assert.doesNotMatch(JSON.stringify(result),/secret/);
});
