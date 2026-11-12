import test from 'node:test';
import assert from 'node:assert/strict';
import {readGatewayKey, makeGatewayJevRequest, prepareGatewayRequest, normalizeGatewayAnswer, proposeWithVercelJev as proposeForDevice, GATEWAY_ENDPOINT} from '../bin/lib/vercel-jev.mjs';
const proposeWithVercelJev=(input,options={})=>proposeForDevice(input,{expectedDevice:'fixture-phone',...options});
test('gateway choices preserve caller cancellation before any external attempt',async()=>{
  const controller=new AbortController();controller.abort(new Error('cancelled'));
  let calls=0;
  const result=await proposeWithVercelJev(sample(),{signal:controller.signal,expectedDevice:sample().snapshot.observation.device,
    dataClass:'controlled_test',authorize:permission,request:async()=>{calls++;return{answers:{next_action:{type:'choice',choice:'a1',confidence:1}}};}});
  assert.equal(calls,0);assert.equal(result.action_id,'STOP');
});

const sample = () => ({
  goal:'Choose the main Bangkok airport',
  expectedApp:'Trip.com',
  snapshot:{source:'accessibility',observation:{id:'synthetic-obs',device:'fixture-phone',revision:4,structure_completed_at:new Date().toISOString()},foreground:{name:'Trip.com'},
    elements:[{role:'Button',object_id:'bkk',label:'BKK Suvarnabhumi',enabled:true},{role:'Button',object_id:'dmk',label:'DMK Don Mueang',enabled:true}]},
  actions:[{id:'a1',object_id:'bkk',kind:'tap_text',label:'BKK Suvarnabhumi'},{id:'a2',object_id:'dmk',kind:'tap_text',label:'DMK Don Mueang'}]
});
const permission = async p => ({allowed:true,provider:p.provider,snapshot_id:p.snapshotId,expires_at:Date.now()+1000});
const typeSafePayload = () => ({url:'https://api.typesafe.ai/v1/systemone',body:{model:'jev-latest',state:{goal:'choose airport',app:'Trip.com',observation_id:'synthetic-obs',actions:[]},
 questions:{next_action:{type:'choice',instructions:'Choose from supplied buttons',criteria:{a1:'BKK',a2:'DMK',REOBSERVE:'unclear'}}}}});

test('read key only from Keychain via execFile, never a shell or environment variable', async () => {
  let invocation;
  const key = await readGatewayKey({execFile:async (exe,args,opts) => {invocation={exe,args,opts};return {stdout:'key-TEST-ONLY\n'};},username:'sample-user'});
  assert.equal(key,'key-TEST-ONLY');
  assert.equal(invocation.exe,'/usr/bin/security');
  assert.deepEqual(invocation.args,['find-generic-password','-w','-a','sample-user','-s','poki-vercel-ai-gateway-key']);
  assert.equal(invocation.opts.shell,undefined);
  assert.ok(!JSON.stringify(invocation).includes('key-TEST-ONLY'));
});

test('routes only to fixed Vercel evaluation endpoint with approved model and named choice criteria', () => {
  const request=prepareGatewayRequest(typeSafePayload());
  assert.equal(GATEWAY_ENDPOINT,'https://ai-gateway.vercel.sh/v1/evaluate');
  assert.equal(request.model,'typesafe-ai/jev');
  assert.equal(request.questions.next_action.type,'choice');
  assert.equal(request.questions.next_action.criteria.a1,'BKK');
  assert.ok(!JSON.stringify(request).includes('api.typesafe.ai'));
});

test('never obeys a URL or model supplied by untrusted request', () => {
  assert.throws(() => prepareGatewayRequest({...typeSafePayload(),url:'https://example.org/collect'}));
  const data=typeSafePayload();data.body.questions.next_action.criteria.a1='BKK';data.body.model='unknown-model';
  const request=prepareGatewayRequest(data);assert.equal(request.model,'typesafe-ai/jev');
});

test('normalizes native gateway confidence without substituting choice probabilities', () => {
  const a=normalizeGatewayAnswer({answers:{next_action:{type:'choice',choice:'a1',probabilities:{a1:0.99,a2:0.01}}},providerMetadata:{typesafe:{confidence:{next_action:0.9}}}});
  assert.deepEqual(a,{answers:{next_action:{type:'choice',choice:'a1',confidence:0.9}}});
  const b=normalizeGatewayAnswer({answers:{next_action:{type:'choice',choice:'a1',probabilities:{a1:0.99}}}});
  assert.equal(b.answers.next_action.confidence,undefined);
});

test('POST uses bearer key, fixed URL, never prints credentials; response is proposal only',async()=>{
  const trace=[];const fakeFetch=async(url,options)=>{trace.push({url,options});return {ok:true,status:200,json:async()=>({answers:{next_action:{type:'choice',choice:'a1'}},providerMetadata:{typesafe:{confidence:{next_action:0.96}}}})}};
  const request=makeGatewayJevRequest({fetchImpl:fakeFetch,getKey:async()=> 'secret-test-only'});
  const result=await proposeWithVercelJev(sample(),{request,authorize:permission,dataClass:'controlled_test',timeoutMs:1000,maxAgeMs:3000});
  assert.equal(result.action_id,'a1');assert.equal(result.execution_authorized,false);
  assert.equal(trace.length,1);
  assert.equal(trace[0].url,GATEWAY_ENDPOINT);
  assert.equal(trace[0].options.headers.Authorization,'Bearer secret-test-only');
  assert.equal(JSON.parse(trace[0].options.body).model,'typesafe-ai/jev');
  assert.ok(!JSON.stringify(result).includes('secret-test-only'));
});

test('private data never obtains Keychain credential or contacts Gateway',async()=>{
  let keys=0,requests=0;const request=makeGatewayJevRequest({getKey:async()=>{keys++;return 'not-used'},fetchImpl:async()=>{requests++}});
  const result=await proposeWithVercelJev(sample(),{request,authorize:permission,dataClass:'private'});
  assert.equal(result.action_id,'STOP');assert.equal(keys,0);assert.equal(requests,0);
});

test('no owner authorization blocks model calls even when the key is stored',async()=>{
  let calls=0;const request=makeGatewayJevRequest({getKey:async()=>{calls++;return 'not-used'}});
  const result=await proposeWithVercelJev(sample(),{request,dataClass:'controlled_test'});
  assert.equal(result.action_id,'STOP');assert.equal(calls,0);
});

test('HTTP non-200 never includes server response or key and never retries',async()=>{
  let calls=0;const request=makeGatewayJevRequest({getKey:async()=> 'secret-test-only',fetchImpl:async()=>{calls++;return {ok:false,status:401,text:async()=> 'secret-test-only accidentally reflected'}}});
  await assert.rejects(request(typeSafePayload()),e=> e.message==='Vercel AI Gateway HTTP 401');
  assert.equal(calls,1);
});

test('timeout/cancel propagates to underlying fetch and does not retry',async()=>{
  let calls=0,controller=new AbortController(),signal;
  const request=makeGatewayJevRequest({getKey:async()=> 'key',fetchImpl:async(_,opts)=>{calls++;signal=opts.signal;throw Object.assign(new Error('aborted'),{name:'AbortError'});}});
  await assert.rejects(request({...typeSafePayload(),signal:controller.signal}));assert.equal(calls,1);assert.equal(signal,controller.signal);
});

test('abstains on missing confidence instead of treating a provider choice as authority',async()=>{
  const request=makeGatewayJevRequest({getKey:async()=> 'key',fetchImpl:async()=>({ok:true,status:200,json:async()=>({answers:{next_action:{type:'choice',choice:'a1',probabilities:{a1:0.99}}}})})});
  const r=await proposeWithVercelJev(sample(),{request,authorize:permission,dataClass:'controlled_test',maxAgeMs:3000});
  assert.equal(r.action_id,'REOBSERVE');assert.equal(r.execution_authorized,false);
});

test('decision diagnostics expose only safe numeric confidence and option probability',async()=>{
  const observed=[];
  const request=makeGatewayJevRequest({getKey:async()=> 'private-test-only',onDecisionMetadata:meta=>observed.push(meta),fetchImpl:async()=>({ok:true,status:200,json:async()=>({answers:{next_action:{type:'choice',choice:'a2',probabilities:{a1:0.21,a2:0.79}}},providerMetadata:{typesafe:{confidence:{next_action:0.72}}}})})});
  await request(typeSafePayload());
  assert.equal(observed.length,1);
  assert.equal(observed[0].model_choice,'a2');
  assert.equal(observed[0].confidence,0.72);
  assert.equal(observed[0].selected_probability,0.79);
  assert.ok(!JSON.stringify(observed).includes('private-test-only'));
});

test('Gateway Jev decisions request zero data retention and training opt-out',()=>{
  const request=prepareGatewayRequest(typeSafePayload());
  assert.equal(request.providerOptions?.gateway?.zeroDataRetention,true);
  assert.equal(request.providerOptions?.gateway?.disallowPromptTraining,true);
});

test('explicit versioned Jev 1.14 is allowed, arbitrary model slugs are refused',()=>{
  assert.equal(prepareGatewayRequest(typeSafePayload(),{model:'typesafe-ai/jev-1.14.0'}).model,'typesafe-ai/jev-1.14.0');
  assert.throws(()=>prepareGatewayRequest(typeSafePayload(),{model:'unreviewed/model'}),/model/i);
});
