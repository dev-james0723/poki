import {CALLBACK_PATH,MAX_CALLBACK_URL_BYTES,parseAppActionCallbackURL} from './app-action-callback-protocol.mjs';
import {relayShortcutCallback} from './shortcut-callback-relay.mjs';

export const CALLBACK_QUEUE_NAME='shortcut-callbacks-v1';
export const CALLBACK_ROUTE_PATHS=new Set([CALLBACK_PATH,'/bridge/callback/poll','/bridge/callback/complete']);
export const MAX_CALLBACK_JOB_BYTES=MAX_CALLBACK_URL_BYTES+1024;
export const CALLBACK_STATUSES=new Set([200,400,403,404,409,410,413,429,503,504]);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const headers={'content-type':'application/json','cache-control':'no-store','referrer-policy':'no-referrer',
  'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'"};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
const fail=(status=400)=>Object.assign(new Error('Callback request rejected'),{httpStatus:status});
const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key));
const bodyless=request=>!request.body&&!request.headers.has('transfer-encoding')&&
  (!request.headers.has('content-length')||request.headers.get('content-length')==='0');

// Stream bounds apply even without Content-Length, and slow request bodies expire.
export async function readCallbackJSON(message,limit=MAX_CALLBACK_JOB_BYTES,timeoutMs=2000) {
  const length=message.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw fail(Number(length)>limit?413:400);
  if(message.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw fail();
  if(!message.body)throw fail();
  const reader=message.body.getReader();
  let timer,finished=false;
  const read=async()=>{
    const chunks=[];let size=0,count=0;
    while(true){
      const item=await reader.read();
      if(item.done)break;
      if(++count>1024)throw fail();
      size+=item.value.byteLength;if(size>limit)throw fail(413);
      chunks.push(item.value);
    }
    finished=true;
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail();}
  };
  try{return await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(408)),timeoutMs);})]);}
  finally{clearTimeout(timer);if(!finished)void reader.cancel().catch(()=>{});}
}
export function validCallbackPayload(payload) {
  if(!keys(payload,['method','params'])||payload.method!=='app-actions/callback'||
    !Object.hasOwn(payload,'method')||!Object.hasOwn(payload,'params')||
    !keys(payload.params,['path'])||!Object.hasOwn(payload.params,'path'))return false;
  const path=payload.params.path;
  if(typeof path!=='string'||!path.startsWith(CALLBACK_PATH+'?'))return false;
  try{parseAppActionCallbackURL(path);return true;}catch{return false;}
}
export function validCallbackJob(job,now=Date.now()) {
  return keys(job,['id','payload','expires_at'])&&typeof job.id==='string'&&uuid.test(job.id)&&
    Number.isSafeInteger(job.expires_at)&&job.expires_at>now&&job.expires_at<=now+30000&&
    validCallbackPayload(job.payload);
}
function validCompletion(value) {
  return keys(value,['id','result'])&&typeof value.id==='string'&&uuid.test(value.id)&&
    keys(value.result,['status'])&&Object.hasOwn(value.result,'status')&&CALLBACK_STATUSES.has(value.result.status);
}
function tokenMatch(header,secret) {
  if(typeof secret!=='string'||secret.length<48||secret.length>512||header.length>1024)return false;
  const expected='Bearer '+secret;let different=header.length^expected.length;
  for(let i=0;i<Math.max(header.length,expected.length);i++)different|=(header.charCodeAt(i)||0)^(expected.charCodeAt(i)||0);
  return different===0;
}
async function queueFetch(hub,path,options={},timeoutMs=20000) {
  const controller=new AbortController();let timer;
  try{return await Promise.race([
    Promise.resolve().then(()=>hub.fetch('https://callback.internal/callback/'+path,{...options,signal:controller.signal})),
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail(503));},Math.max(1,Math.min(timeoutMs,20000)));}),
  ]);}finally{clearTimeout(timer);}
}

// The gateway supplies only its existing outbound-bridge secret and a DIFFERENT
// named Durable Object. No OAuth scope, MCP permission or phone ID enters here.
export async function routeShortcutCallback(request,{bridgeToken,hub,exchangeTimeoutMs=20000}={}) {
  const url=new URL(request.url),path=url.pathname;
  if(!CALLBACK_ROUTE_PATHS.has(path))return null;
  if(url.protocol!=='https:')return json({error:'callback_rejected'},400);
  if(path===CALLBACK_PATH){
    if(request.method!=='GET')return json({received:false,error:'method_not_allowed'},405);
    if(!bodyless(request))return json({received:false,error:'callback_rejected'},400);
    if(typeof bridgeToken!=='string'||bridgeToken.length<48||bridgeToken.length>512)return json({received:false,error:'callback_unavailable'},503);
    return relayShortcutCallback(request,async payload=>{
      const response=await queueFetch(hub,'enqueue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)},exchangeTimeoutMs);
      if(response.status!==200){void response.body?.cancel().catch(()=>{});return {status:CALLBACK_STATUSES.has(response.status)?response.status:503};}
      const result=await readCallbackJSON(response,128);
      return keys(result,['status'])&&CALLBACK_STATUSES.has(result.status)?{status:result.status}:{status:503};
    });
  }
  if(!tokenMatch(request.headers.get('authorization')??'',bridgeToken))return json({error:'unauthorized'},401);
  try{
    if(path==='/bridge/callback/poll'){
      if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      if(!bodyless(request)||url.search)return json({error:'callback_rejected'},400);
      const response=await queueFetch(hub,'poll',{},exchangeTimeoutMs);
      if(response.status!==200){void response.body?.cancel().catch(()=>{});return json({error:'callback_unavailable'},CALLBACK_STATUSES.has(response.status)?response.status:503);}
      const value=await readCallbackJSON(response);
      if(!keys(value,['job'])||!Object.hasOwn(value,'job')||value.job!==null&&!validCallbackJob(value.job))throw fail(503);
      return json(value);
    }
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    if(url.search)throw fail();
    const complete=await readCallbackJSON(request,256);
    if(!validCompletion(complete))throw fail();
    const response=await queueFetch(hub,'complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(complete)},exchangeTimeoutMs);
    void response.body?.cancel().catch(()=>{});
    return response.status===200?json({accepted:true}):json({error:'callback_rejected'},CALLBACK_STATUSES.has(response.status)?response.status:503);
  }catch(error){return json({error:'callback_unavailable'},[400,408,413].includes(error.httpStatus)?error.httpStatus:503);}
}

/** In-memory only: bounded callback jobs expire and are leased once, never
 * requeued. A Durable Object restart yields uncertainty, not replay or success. */
export class ShortcutCallbackQueue {
  constructor({maxJobs=16,maxPollers=2,jobTimeoutMs=15000,pollTimeoutMs=10000,now=Date.now}={}) {
    for(const [value,max] of [[maxJobs,16],[maxPollers,4],[jobTimeoutMs,30000],[pollTimeoutMs,12000]])
      if(!Number.isInteger(value)||value<1||value>max)throw Error('Invalid callback queue bound');
    Object.assign(this,{maxJobs,maxPollers,jobTimeoutMs,pollTimeoutMs,now});
    this.jobs=new Map();this.pending=[];this.pollers=[];
  }
  settle(id,status,httpStatus=200) {
    const entry=this.jobs.get(id);if(!entry)return;
    clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort);
    this.jobs.delete(id);this.pending=this.pending.filter(value=>value!==id);
    entry.resolve(json({status},httpStatus));
  }
  next() {
    while(this.pending.length){
      const id=this.pending.shift(),entry=this.jobs.get(id);if(!entry)continue;
      if(entry.job.expires_at<=this.now()){this.settle(id,504,504);continue;}
      entry.leased=true;return entry.job;
    }
    return null;
  }
  flush() {
    while(this.pending.length&&this.pollers.length){
      const job=this.next();if(!job)break;
      this.pollers.shift().deliver(json({job}));
    }
  }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    try{
      if(path==='/callback/enqueue'){
        if(request.method!=='POST')return json({error:'method_not_allowed'},405);
        const payload=await readCallbackJSON(request);
        if(!validCallbackPayload(payload))throw fail();
        if(this.jobs.size>=this.maxJobs)return json({error:'busy'},429);
        if(request.signal?.aborted)return json({error:'callback_unavailable'},503);
        return await new Promise(resolve=>{
          const id=crypto.randomUUID(),job={id,payload,expires_at:this.now()+this.jobTimeoutMs};
          const abort=()=>this.settle(id,503,503);
          const timer=setTimeout(()=>this.settle(id,504,504),this.jobTimeoutMs);
          this.jobs.set(id,{job,resolve,timer,leased:false,signal:request.signal,abort});
          request.signal?.addEventListener('abort',abort,{once:true});
          this.pending.push(id);this.flush();
        });
      }
      if(path==='/callback/poll'){
        if(request.method!=='GET')return json({error:'method_not_allowed'},405);
        if(!bodyless(request))throw fail();
        const job=this.next();if(job)return json({job});
        if(this.pollers.length>=this.maxPollers)return json({error:'busy'},429);
        if(request.signal?.aborted)return json({job:null});
        return await new Promise(resolve=>{
          let timer,done=false;
          const poller={deliver:response=>{
            if(done)return;done=true;clearTimeout(timer);
            request.signal?.removeEventListener('abort',abort);
            this.pollers=this.pollers.filter(value=>value!==poller);resolve(response);
          }};
          const abort=()=>poller.deliver(json({job:null}));
          timer=setTimeout(abort,this.pollTimeoutMs);
          request.signal?.addEventListener('abort',abort,{once:true});
          this.pollers.push(poller);this.flush();
        });
      }
      if(path==='/callback/complete'){
        if(request.method!=='POST')return json({error:'method_not_allowed'},405);
        const value=await readCallbackJSON(request,256);
        if(!validCompletion(value))throw fail();
        const entry=this.jobs.get(value.id);
        if(!entry)return json({error:'expired'},410);
        if(entry.job.expires_at<=this.now()){this.settle(value.id,504,504);return json({error:'expired'},410);}
        if(!entry.leased)return json({error:'not_leased'},409);
        this.settle(value.id,value.result.status);
        return json({accepted:true});
      }
      return json({error:'not_found'},404);
    }catch(error){return json({error:'callback_rejected'},[400,408,413].includes(error.httpStatus)?error.httpStatus:503);}
  }
}
