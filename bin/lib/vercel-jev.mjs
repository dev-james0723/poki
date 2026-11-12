/**
 * Vercel AI Gateway transport for Poki's proposal-only Jev selector.
 *
 * Nothing in this module authorizes an iPhone action. No paid request is
 * made merely by importing this file or reading Keychain credentials.
 *
 * Official HTTP contract: POST https://ai-gateway.vercel.sh/v1/evaluate
 * model typesafe-ai/jev, state and keyed questions, 2026-11-07.
 */
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {userInfo} from 'node:os';
import {selectAction} from '../../src/decision-selector.mjs';

export const GATEWAY_ENDPOINT='https://ai-gateway.vercel.sh/v1/evaluate';
export const GATEWAY_MODEL='typesafe-ai/jev';
export const REVIEWED_JEV_MODELS=Object.freeze(['typesafe-ai/jev','typesafe-ai/jev-1.14.0']);
export const KEYCHAIN_SERVICE='poki-vercel-ai-gateway-key';
const SOURCE_FORMAT='https://api.typesafe.ai/v1/systemone';
const systemExec=promisify(execFileCallback);

export async function readGatewayKey({execFile=systemExec,username=userInfo().username}={}) {
  if(typeof username!=='string'||!username||!(/^[a-zA-Z0-9_.-]+$/).test(username))throw new Error('Invalid local Keychain account');
  try {
    // The credential is returned via stdout to this process only. It never
    // appears in a command argument, env var, report, tool output, or log.
    const result=await execFile('/usr/bin/security',['find-generic-password','-w','-a',username,'-s',KEYCHAIN_SERVICE],{encoding:'utf8',maxBuffer:32768,timeout:5000});
    const key=result.stdout?.trim();
    if(typeof key!=='string'||key.length<12||key.length>8192||key.includes('\n'))throw new Error('Credential not usable');
    return key;
  } catch {
    // Never relay stderr/stdout; Keychain tooling may quote account data.
    throw new Error('Vercel AI Gateway credential unavailable in macOS Keychain');
  }
}

export function prepareGatewayRequest(request,{model=GATEWAY_MODEL}={}) {
  if(!REVIEWED_JEV_MODELS.includes(model))throw new Error('Unreviewed decision model');
  if(!request||request.url!==SOURCE_FORMAT||typeof request.body!=='object'||!request.body)throw new Error('Unsupported decision request source');
  const {state,questions}=request.body;
  const q=questions?.next_action,criteria=q?.criteria;
  if(q?.type!=='choice'||typeof q.instructions!=='string'||typeof criteria!=='object'||!criteria||Array.isArray(criteria))throw new Error('Unsupported evaluation question');
  const keys=Object.keys(criteria);
  if(keys.length<2||keys.length>43||!keys.every(k=>typeof criteria[k]==='string'&&criteria[k].length>0&&criteria[k].length<=350))throw new Error('Invalid action catalog');
  if(!state||typeof state!=='object'||!Array.isArray(state.actions)||state.actions.length>40||typeof state.goal!=='string'||state.goal.length>600)throw new Error('Invalid decision state');
  const body={model,state,questions:{next_action:{type:'choice',instructions:q.instructions,criteria}},
    providerOptions:{gateway:{zeroDataRetention:true,disallowPromptTraining:true}}};
  if(Buffer.byteLength(JSON.stringify(body),'utf8')>24000)throw new Error('Decision input exceeds bounded payload');
  return body;
}

export function normalizeGatewayAnswer(data) {
  const selected=data?.answers?.next_action;
  const confidence=data?.providerMetadata?.typesafe?.confidence?.next_action ?? selected?.confidence;
  const answer={type:'choice',choice:typeof selected?.choice==='string'?selected.choice:null};
  // Choice probability and confidence are different metrics. Never fabricate
  // confidence from the selected option's probability distribution.
  if(Number.isFinite(confidence)&&confidence>=0&&confidence<=1)answer.confidence=confidence;
  return {answers:{next_action:answer}};
}

export function makeGatewayJevRequest({fetchImpl=fetch,getKey=readGatewayKey,onDecisionMetadata,model=GATEWAY_MODEL}={}) {
  if(typeof fetchImpl!=='function'||typeof getKey!=='function')throw new TypeError('Missing gateway transport');
  return async function requestVercelJev({url,body,signal}) {
    const prepared=prepareGatewayRequest({url,body},{model});
    const key=await getKey();
    if(signal?.aborted)throw signal.reason??new Error('Request cancelled');
    const response=await fetchImpl(GATEWAY_ENDPOINT,{
      method:'POST',
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
      body:JSON.stringify(prepared),
      signal,
      redirect:'error',
    });
    if(!response?.ok)throw new Error('Vercel AI Gateway HTTP '+String(response?.status??'unknown'));
    let result;
    try {result=await response.json();}
    catch {throw new Error('Vercel AI Gateway returned invalid JSON');}
    if(typeof onDecisionMetadata==='function') {
      const answer=result?.answers?.next_action;
      const choice=answer?.choice;
      const probabilities=answer?.probabilities;
      const rawConfidence=result?.providerMetadata?.typesafe?.confidence?.next_action ?? answer?.confidence;
      const rawProbability=typeof choice==='string'&&probabilities&&typeof probabilities==='object' ? probabilities[choice] : undefined;
      const metadata={
        model_choice:typeof choice==='string'&&/^(?:a[A-Za-z0-9_-]{1,39}|WAIT|REOBSERVE|STOP)$/.test(choice)?choice:null,
        confidence:Number.isFinite(rawConfidence)&&rawConfidence>=0&&rawConfidence<=1?rawConfidence:null,
        selected_probability:Number.isFinite(rawProbability)&&rawProbability>=0&&rawProbability<=1?rawProbability:null,
        confidence_present:Number.isFinite(rawConfidence),
      };
      try {onDecisionMetadata(metadata);} catch { /* Optional diagnostics must not replay or fail an accepted decision. */ }
    }
    return normalizeGatewayAnswer(result);
  };
}

/**
 * Uses an existing, explicit scope-bound owner authorization callback.
 * Real iPhone UI is PRIVATE by default and never sent. Each call makes at
 * most one paid evaluation; no retries or automatic input.
 */
export async function proposeWithVercelJev(input,options={}) {
  return selectAction(input,{
    provider:'jev',
    expectedDevice:options.expectedDevice,
    signal:options.signal,
    model:GATEWAY_MODEL,
    dataClass:options.dataClass??'private',
    authorize:options.authorize,
    request:options.request??makeGatewayJevRequest(options.transport),
    timeoutMs:options.timeoutMs??2500,
    maxAgeMs:options.maxAgeMs??3500,
    currentRevision:options.currentRevision,
    now:options.now,
  });
}
