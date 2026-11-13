import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AppActionStore, runShortcut, handleAppActionCallback} from '../src/app-actions.mjs';
import {openVerifiedLink, listAppLinks} from '../src/app-links.mjs';

const origin = 'https://callback.example.test';
const action = {shortcut:'Poki Test', input:'hello', operation_key:'operation-one', timeout_ms:100};
async function fixture(t, options={}) {
  const directory = await mkdtemp(join(tmpdir(),'poki-app-actions-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store = new AppActionStore({stateDir:directory,callbackBaseURL:origin,...options});
  await store.initialize();
  return {store,directory};
}
function callback(url, extra={}) {
  const u = new URL(url);
  return {...Object.fromEntries(u.searchParams),...extra};
}
function context(dispatch) {
  return {target:async()=>({kind:'physical',id:'phone-one'}),
    coordinator:{revision:()=>2}, dispatch};
}
test('same operation is never dispatched twice; a conflicting request refuses', async t=>{
  const {store}=await fixture(t);
  let calls=0;
  const ctx=context(async(name,args)=>{
    calls++; assert.equal(name,'open_url'); assert.equal(args.device,'phone-one');
    const url=new URL(args.url);
    assert.equal(url.protocol,'shortcuts:');
    assert.equal(url.host,'x-callback-url'); assert.equal(url.pathname,'/run-shortcut');
    assert.equal(url.searchParams.get('name'),'Poki Test');
    assert.equal(url.searchParams.get('text'),'hello');
    await store.acceptCallback(callback(url.searchParams.get('x-success'),{result:'done'}));
    return {content:[{type:'text',text:JSON.stringify({accepted:true})}]};
  });
  const first=await runShortcut(ctx,action,store);
  assert.equal(first.state,'success'); assert.equal(first.result,'done');
  assert.equal(first.shortcut_completed,true); assert.equal(first.postcondition.status,'not_requested');
  const again=await runShortcut(ctx,action,store);
  assert.equal(again.action_id,first.action_id); assert.equal(again.replayed,false); assert.equal(calls,1);
  await assert.rejects(()=>runShortcut(ctx,{...action,input:'different'},store),{code:'APP_ACTION_KEY_CONFLICT'});
  assert.equal(calls,1);
});
test('device binding and missing/invalid callback origins send no URL',async t=>{
  for(const callbackBaseURL of [undefined,'http://example.test','https://localhost','https://127.0.0.1','https://127.2.3.4','https://localhost.','https://0.0.0.0','https://example.test/path','https://u:p@example.test']) {
    const {store}=await fixture(t,{callbackBaseURL});
    let calls=0;
    const answer=await runShortcut(context(async()=>{calls++;}),action,store);
    assert.equal(answer.state,'not_sent'); assert.equal(answer.isError,true); assert.equal(calls,0);
  }
  const {store}=await fixture(t);
  await store.prepare('phone-one',action);
  await assert.rejects(()=>store.prepare('phone-two',action),{code:'APP_ACTION_KEY_CONFLICT'});
  await assert.rejects(()=>store.status(action.operation_key,'phone-two'),{code:'APP_ACTION_DEVICE_MISMATCH'});
});
test('cancel and error are distinct, duplicate callbacks are idempotent and conflicting callbacks cannot overwrite',async t=>{
  const {store}=await fixture(t);
  for(const outcome of ['cancelled','error']) {
    const p=await store.prepare('phone-one',{...action,operation_key:'operation-'+outcome});
    await store.markDispatched(p.receipt.action_id);
    const data=callback(p.callbacks[outcome],outcome==='error'?{errorMessage:'Shortcut failed'}:{});
    assert.equal((await store.acceptCallback(data)).state,outcome);
    assert.equal((await store.acceptCallback(data)).state,outcome);
    await assert.rejects(()=>store.acceptCallback(callback(p.callbacks.success,{result:'late success'})),{code:'APP_ACTION_CALLBACK_CONFLICT'});
    assert.equal((await store.status('operation-'+outcome,'phone-one')).state,outcome);
  }
});
test('tokens are unguessable status-scoped, absent from receipts and never stored raw',async t=>{
  const {store,directory}=await fixture(t);
  const p=await store.prepare('phone-one',action);
  const success=callback(p.callbacks.success);
  assert.match(success.token,/^[a-f0-9]{64}$/);
  const all=Object.values(p.callbacks).map(url=>callback(url).token);
  assert.equal(new Set(all).size,3);
  assert.ok(all.every(token=>!JSON.stringify(p.receipt).includes(token)));
  const files=await readdir(join(directory,'app-actions'));
  const data=await readFile(join(directory,'app-actions',files[0]),'utf8');
  assert.ok(all.every(token=>!data.includes(token)));
  assert.equal((await stat(join(directory,'app-actions',files[0]))).mode&0o777,0o600);
  await store.markDispatched(p.receipt.action_id);
  await assert.rejects(()=>store.acceptCallback({...success,token:'0'.repeat(64)}),{code:'APP_ACTION_CALLBACK_UNAUTHORIZED'});
  await assert.rejects(()=>store.acceptCallback({...success,outcome:'cancelled'}),{code:'APP_ACTION_CALLBACK_UNAUTHORIZED'});
});
test('timeout and transport ambiguity remain unknown; late callback may settle without replay',async t=>{
  const {store}=await fixture(t);
  let calls=0,success;
  const ctx=context(async(_,args)=>{
    calls++;success=new URL(args.url).searchParams.get('x-success');
    return {isError:true,content:[{type:'text',text:JSON.stringify({outcome:'unknown'})}]};
  });
  const answer=await runShortcut(ctx,action,store);
  assert.equal(answer.state,'unknown');
  assert.equal((await runShortcut(ctx,action,store)).state,'unknown');
  assert.equal(calls,1);
  assert.equal((await store.acceptCallback(callback(success,{result:'late'}))).state,'success');
  const p=await store.prepare('phone-one',{...action,operation_key:'timed-out'});
  await store.markDispatched(p.receipt.action_id);
  const timeout=await store.wait(p.receipt.action_id,{timeoutMs:5});
  assert.equal(timeout.state,'unknown');assert.equal(timeout.reason,'callback_timeout');
});
test('restart keeps the dispatch barrier; a saved callback still correlates',async t=>{
  const {store,directory}=await fixture(t);
  const p=await store.prepare('phone-one',action);
  await store.markDispatched(p.receipt.action_id);
  const restarted=new AppActionStore({stateDir:directory,callbackBaseURL:origin});
  await restarted.initialize();
  assert.equal((await restarted.status(action.operation_key,'phone-one')).state,'unknown');
  let calls=0;
  await runShortcut(context(async()=>{calls++;}),action,restarted);
  assert.equal(calls,0);
  assert.equal((await restarted.acceptCallback(callback(p.callbacks.success,{result:'after restart'}))).state,'success');
});
test('callback receiver rejects wrong paths/methods/fields/oversized output and receives a valid result',async t=>{
  const {store}=await fixture(t);
  const p=await store.prepare('phone-one',action);await store.markDispatched(p.receipt.action_id);
  const reply=()=>({code:0,headers:null,body:'',writeHead(code,headers){this.code=code;this.headers=headers;},end(body=''){this.body=body;}});
  const valid=new URL(p.callbacks.success);valid.searchParams.set('result','received');
  const res=reply();
  assert.equal(await handleAppActionCallback({method:'GET',url:valid.pathname+valid.search},res,store),true);
  assert.equal(res.code,200);assert.equal(res.headers['Cache-Control'],'no-store');
  assert.equal(await handleAppActionCallback({method:'GET',url:'/mcp'},reply(),store),false);
  const post=reply();await handleAppActionCallback({method:'POST',url:'/app-actions/callback'},post,store);assert.equal(post.code,405);
  for(const extra of ['&extra=1','&__proto__=x','&constructor=x','&token=duplicate','&result='+encodeURIComponent('x'.repeat(12000))]) {
    const bad=reply();await handleAppActionCallback({method:'GET',url:valid.pathname+valid.search+extra},bad,store);assert.ok(bad.code>=400);
  }
});
test('known not-sent refusal does not become success or retry; caller abort after dispatch remains unknown',async t=>{
  const {store}=await fixture(t);
  const denied=await runShortcut(context(async()=>({isError:true,content:[{type:'text',text:JSON.stringify({executed:false,status:'cancelled'})}]})),action,store);
  assert.equal(denied.state,'not_sent');
  const p=await store.prepare('phone-one',{...action,operation_key:'aborted'});await store.markDispatched(p.receipt.action_id);
  const controller=new AbortController();controller.abort();
  assert.equal((await store.wait(p.receipt.action_id,{timeoutMs:100,signal:controller.signal})).state,'unknown');
});
test('capacity refuses new operations without evicting replay barriers',async t=>{
  const {store}=await fixture(t,{maxRecords:1});
  await store.prepare('phone-one',action);
  await assert.rejects(()=>store.prepare('phone-one',{...action,operation_key:'second'}),{code:'APP_ACTION_CAPACITY'});
  assert.equal((await store.prepare('phone-one',action)).created,false);
});
test('verified links expose only owned fixed destinations and require current route proof',async()=>{
  const links=listAppLinks();
  assert.deepEqual(links.links.map(x=>x.id),['poki.chat','poki.setup','poki.activity']);
  assert.ok(links.links.every(x=>x.physical_verification==='not_yet_verified'));
  let calls=0;
  const ctx=context(async(_,args)=>{calls++;assert.equal(args.url,'poki://chat');return {content:[]};});
  await assert.rejects(()=>openVerifiedLink(ctx,{link_id:'unknown'}));
  assert.equal(calls,0);
  const at=new Date().toISOString();
  const s={source:'accessibility',truncated:false,prompt:null,prompt_scope:'full_native_tree',foreground:{name:'Poki'},
    root_verified:true,source_complete:true,geometry_source:'native_application_frame',width:390,height:844,
    event_source:'accessibility_live',source_age_ms:0,total:1,
    observation:{id:'fresh',device:'phone-one',revision:2,input_freshness:'live_read',structure_started_at:at,structure_completed_at:at},
    elements:[{identifier:'poki.route.chat',frame:{x:0,y:0,width:390,height:800}}]};
  const result=await openVerifiedLink(ctx,{link_id:'poki.chat',timeout_ms:100},{observe:async()=>s});
  assert.equal(result.destination_verified,true);assert.equal(result.physical_verification,'verified');
  const wrong=await openVerifiedLink(ctx,{link_id:'poki.chat',timeout_ms:100},{observe:async()=>({...s,foreground:{name:'Other'}})});
  assert.equal(wrong.destination_verified,false);assert.equal(wrong.isError,true);
});

test('concurrent identical requests share one dispatch barrier',async t=>{
  const {store}=await fixture(t);
  let calls=0;
  const ctx=context(async(_,args)=>{
    calls++;
    await new Promise(resolve=>setTimeout(resolve,10));
    await store.acceptCallback(callback(new URL(args.url).searchParams.get('x-success'),{result:'ok'}));
    return {content:[]};
  });
  const [a,b]=await Promise.all([runShortcut(ctx,action,store),runShortcut(ctx,action,store)]);
  assert.equal(calls,1);assert.equal(a.action_id,b.action_id);
  assert.equal((await store.status(action.operation_key,'phone-one')).state,'success');
});
test('callback success remains separate from requested live app-state proof',async t=>{
  const {store}=await fixture(t);
  const ctx=context(async(_,args)=>{
    await store.acceptCallback(callback(new URL(args.url).searchParams.get('x-success'),{result:'Shortcut completed'}));
    return {content:[]};
  });
  const answer=await runShortcut(ctx,{...action,expected_app:'Notes',expect:{all:['Saved']}},store,{
    observe:async()=>({source:'accessibility',foreground:{name:'Safari'},truncated:false,prompt:null,
      observation:{device:'phone-one',revision:2,input_freshness:'live_read',structure_completed_at:new Date().toISOString()},
      elements:[{label:'Saved'}]})
  });
  assert.equal(answer.state,'success');assert.equal(answer.shortcut_completed,true);
  assert.equal(answer.postcondition.status,'not_verified');assert.equal(answer.isError,true);
  assert.equal((await store.status(action.operation_key,'phone-one')).postcondition.status,'not_verified');
});
test('restart before dispatch preserves a not-sent receipt instead of launching implicitly',async t=>{
  const {store,directory}=await fixture(t);
  await store.prepare('phone-one',action);
  const restarted=new AppActionStore({stateDir:directory,callbackBaseURL:origin});await restarted.initialize();
  let calls=0;
  const answer=await runShortcut(context(async()=>{calls++;}),action,restarted);
  assert.equal(answer.state,'not_sent');assert.equal(calls,0);
});
test('callback HTTP receiver refuses a request body and never reflects sensitive values',async t=>{
  const {store}=await fixture(t);
  const p=await store.prepare('phone-one',action);await store.markDispatched(p.receipt.action_id);
  const url=new URL(p.callbacks.success);url.searchParams.set('result','private-output');
  const res={code:0,body:'',writeHead(code){this.code=code;},end(body){this.body=body;}};
  await handleAppActionCallback({method:'GET',url:url.pathname+url.search,headers:{'content-length':'1'}},res,store);
  assert.equal(res.code,400);
  await handleAppActionCallback({method:'GET',url:url.pathname+url.search,headers:{}},res,store);
  assert.equal(res.code,200);
  assert.ok(!res.body.includes('private-output'));assert.ok(!res.body.includes(callback(p.callbacks.success).token));
});

test('postconditions never infer absence from incomplete or unverified AX coverage',async t=>{
  const {store}=await fixture(t);
  const ctx=context(async(_,args)=>{
    await store.acceptCallback(callback(new URL(args.url).searchParams.get('x-success'),{result:'done'}));
    return {content:[]};
  });
  const full=()=>{
    const at=new Date().toISOString();
    return {source:'accessibility',root_verified:true,source_complete:true,geometry_source:'native_application_frame',
      width:390,height:844,prompt_scope:'full_native_tree',prompt:null,truncated:false,
      event_source:'accessibility_live',source_age_ms:0,foreground:{name:'Notes'},total:1,
      observation:{id:'proof',device:'phone-one',revision:2,input_freshness:'live_read',structure_started_at:at,structure_completed_at:at},
      elements:[{label:'Saved',frame:{x:10,y:10,width:50,height:20}}]};
  };
  const variants=[
    {source_complete:undefined},{source_complete:false},{root_verified:false},
    {geometry_source:null},{prompt_scope:undefined},{prompt:{kind:'permission'}},
    {event_source:'accessibility_event'},{source_age_ms:20},{truncated:true},
    {width:0},{scope:{returned:'query_matches'}},
  ];
  for(const [index,extra] of variants.entries()){
    const answer=await runShortcut(ctx,{...action,operation_key:'incomplete-'+index,expected_app:'Notes',
      expect:{all:['Saved'],none:['Loading']}},store,{observe:async()=>({...full(),...extra})});
    assert.equal(answer.state,'success');
    assert.equal(answer.postcondition.status,'not_verified',JSON.stringify(extra));
  }
  const valid=await runShortcut(ctx,{...action,operation_key:'complete-proof',expected_app:'Notes',
    expect:{all:['Saved'],none:['Loading']}},store,{observe:async()=>full()});
  assert.equal(valid.postcondition.status,'verified');
});
test('route proof requires explicit native coverage and an onscreen marker frame',async()=>{
  const ctx=context(async()=>({content:[]}));
  const full=()=>{
    const at=new Date().toISOString();
    return {source:'accessibility',root_verified:true,source_complete:true,geometry_source:'native_application_frame',
      width:390,height:844,prompt_scope:'full_native_tree',prompt:null,truncated:false,
      event_source:'accessibility_live',source_age_ms:0,foreground:{name:'Poki'},total:1,
      observation:{id:'proof',device:'phone-one',revision:2,input_freshness:'live_read',structure_started_at:at,structure_completed_at:at},
      elements:[{identifier:'poki.route.chat',frame:{x:0,y:0,width:390,height:800}}]};
  };
  for(const extra of [
    {source_complete:undefined},{root_verified:false},{prompt_scope:undefined},
    {elements:[{identifier:'poki.route.chat'}]},
    {elements:[{identifier:'poki.route.chat',visible:false,frame:{x:0,y:0,width:390,height:800}}]},
    {elements:[{identifier:'poki.route.chat',frame:{x:0,y:900,width:390,height:800}}]},
  ]){
    const answer=await openVerifiedLink(ctx,{link_id:'poki.chat',timeout_ms:100},{observe:async()=>({...full(),...extra})});
    assert.equal(answer.destination_verified,false,JSON.stringify(extra));
  }
});
