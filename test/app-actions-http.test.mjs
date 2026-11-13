import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,value} from './fixture.mjs';
import {AppActionStore} from '../src/app-actions.mjs';

test('daemon callback settles an exact journal capability without granting MCP authority',async t=>{
 let callbacks;
 const operation_key='http-integration-once';
 const f=await fixture(t,{beforeStart:async dir=>{
  const store=new AppActionStore({stateDir:join(dir,'state'),callbackBaseURL:'https://callbacks.example'});
  const prepared=await store.prepare('fixture-phone',{device:'fixture-phone',shortcut:'HTTP fixture',operation_key,input:'private fixture'});
  await store.markDispatched(prepared.receipt.action_id);
  callbacks=prepared.callbacks;
 }});
 const endpoint=JSON.parse(await readFile(join(f.dir,'state/mcp.json'),'utf8'));
 const local=raw=>{const u=new URL(raw);return new URL(u.pathname+u.search,endpoint.url);};
 const before=value(await f.call('get_app_action_status',{device:'fixture-phone',operation_key}));
 assert.equal(before.state,'unknown');
 assert.equal((await fetch(endpoint.url,{method:'POST',body:'{}',headers:{'content-type':'application/json'}})).status,401);
 const wrong=local(callbacks.success);wrong.searchParams.set('token','0'.repeat(64));
 assert.equal((await fetch(wrong)).status,403);
 const duplicateField=local(callbacks.success);duplicateField.searchParams.append('id','a'.repeat(64));
 assert.equal((await fetch(duplicateField)).status,400);
 const success=local(callbacks.success);success.searchParams.set('result','完成 🙂');
 const received=await fetch(success);
 assert.equal(received.status,200);
 const ack=await received.text();
 assert.equal(JSON.parse(ack).received,true);
 assert.doesNotMatch(ack,/完成|private fixture|token/);
 assert.equal(received.headers.get('cache-control'),'no-store');
 assert.equal((await fetch(success)).status,200);
 success.searchParams.set('result','different');
 assert.equal((await fetch(success)).status,409);
 const after=value(await f.call('get_app_action_status',{device:'fixture-phone',operation_key}));
 assert.equal(after.state,'success');assert.equal(after.result,'完成 🙂');
 assert.equal(after.replayed,false);
 assert.equal((await f.events()).filter(e=>['open_url','tap','type_text','launch_app'].includes(e.op)).length,0);
});

test('callback HTTP routing rejects unsupported methods and keeps host/origin validation',async t=>{
 const f=await fixture(t);
 const endpoint=JSON.parse(await readFile(join(f.dir,'state/mcp.json'),'utf8'));
 const url=new URL('/app-actions/callback?id='+ 'a'.repeat(64)+'&outcome=success&token='+ 'b'.repeat(64),endpoint.url);
 assert.equal((await fetch(url,{method:'POST',body:'ignored'})).status,405);
 assert.equal((await fetch(url,{headers:{origin:'https://untrusted.example'}})).status,403);
 assert.equal((await fetch(url)).status,404);
 assert.equal((await fetch(new URL('/request/cancel',endpoint.url),{method:'POST'})).status,401);
});

test('sanitized callback endpoint exposes only routing metadata and is removed on owned shutdown',async t=>{
 const f=await fixture(t);
 const endpoint=JSON.parse(await readFile(join(f.dir,'state/mcp.json'),'utf8'));
 const path=join(f.dir,'state/app-actions-callback.json');
 const callback=JSON.parse(await readFile(path,'utf8'));
 assert.deepEqual(callback,{url:endpoint.url,enabled:true,pid:endpoint.pid});
 assert.equal((await stat(path)).mode&0o777,0o600);
 assert.ok(!JSON.stringify(callback).includes(endpoint.token));
 await f.a.close();await f.daemon.stop();
 await assert.rejects(readFile(path,'utf8'),{code:'ENOENT'});
});

test('sanitized callback endpoint cleanup preserves a replacement owner',async t=>{
 const f=await fixture(t);
 const path=join(f.dir,'state/app-actions-callback.json');
 const callback=JSON.parse(await readFile(path,'utf8'));
 const replacement={...callback,pid:callback.pid+1};
 await writeFile(path,JSON.stringify(replacement),{mode:0o600});
 await f.a.close();await f.daemon.stop();
 assert.deepEqual(JSON.parse(await readFile(path,'utf8')),replacement);
});
