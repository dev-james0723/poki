import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdir,readdir,readFile,open,rename,chmod,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {runShortcutSchema,appActionStatusSchema,listAppLinksSchema} from './app-actions-schema.mjs';
import {CALLBACK_PATH,parseAppActionCallbackURL,validateAppActionCallback} from './app-action-callback-protocol.mjs';
import {snapshotUI} from './ax-snapshot.mjs';
import {checkWork,remaining,signal as currentSignal} from './work.mjs';
import {listAppLinks,openVerifiedLink} from './app-links.mjs';
import {freshActionObservation,actionElementOnscreen} from './app-action-observation.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const terminal=new Set(['success','cancelled','error','not_sent']);
const states=new Set(['prepared','dispatched','success','cancelled','error','unknown','not_sent']);
const fault=(code,message)=>Object.assign(new Error(message),{code});
const nowISO=now=>new Date(now).toISOString();
const bodyOf=response=>{
  if (response?.structuredContent) return response.structuredContent;
  try { return JSON.parse(response?.content?.find(item=>item.type==='text')?.text??'{}'); } catch { return {}; }
};
const argsDigest=(device,args)=>digest(JSON.stringify([device,args.shortcut,args.input??null,args.expected_app??null,args.expect??null]));
function callbackOrigin(value) {
  let url;
  try { url=new URL(value); } catch { throw fault('APP_ACTION_CALLBACK_UNCONFIGURED','Configure a phone-reachable HTTPS callback origin first.'); }
  const hostname=url.hostname.replace(/\.$/,'');
  if (url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/' ||
      ['localhost','0.0.0.0','[::1]','[::]'].includes(hostname) || /^127\./.test(hostname) ||
      /^\[::ffff:7f[0-9a-f]{2}:/.test(hostname) || hostname.endsWith('.localhost'))
    throw fault('APP_ACTION_CALLBACK_UNCONFIGURED','The callback base must be an explicit phone-reachable HTTPS origin without credentials, path or query.');
  return url.origin;
}
function receipt(record) {
  return {action_id:record.id,operation_key:record.operation_key,device:record.device,
    shortcut:record.shortcut,state:record.state,outcome:record.state,replayed:false,
    shortcut_completed:record.state==='success',callback_received:Boolean(record.callback_received_at),
    dispatch_attempted:Boolean(record.dispatched_at),created_at:record.created_at,updated_at:record.updated_at,
    ...(record.dispatched_at?{dispatched_at:record.dispatched_at}:{}),
    ...(record.callback_received_at?{callback_received_at:record.callback_received_at}:{}),
    ...(record.result!==undefined?{result:record.result}:{}),
    ...(record.error_message!==undefined?{error_message:record.error_message}:{}),
    ...(record.reason?{reason:record.reason}:{}),
    ...(['unknown','cancelled','error','not_sent'].includes(record.state)?{isError:true}:{}),
    retry:'never_automatically_replay',postcondition:record.postcondition_requested?
      {status:'not_verified',reason:'fresh_independent_observation_required'}:{status:'not_requested'}};
}

/** One instance belongs to one daemon. A bounded private journal retains replay
 * barriers; capacity refuses new operations instead of evicting old identities. */
export class AppActionStore {
  #records=new Map();
  #events=new EventEmitter();
  #ready;
  #tail=Promise.resolve();
  constructor({stateDir,callbackBaseURL=process.env.POKI_SHORTCUT_CALLBACK_BASE_URL,now=Date.now,maxRecords=512,callbackTtlMs=86400000}={}) {
    if(typeof stateDir!=='string'||!stateDir)throw fault('APP_ACTION_STATE_REQUIRED','A private state directory is required.');
    if(!Number.isInteger(maxRecords)||maxRecords<1||maxRecords>4096)throw new Error('Invalid app-action journal capacity');
    this.directory=join(stateDir,'app-actions');this.callbackBaseURL=callbackBaseURL;
    this.now=now;this.maxRecords=maxRecords;this.callbackTtlMs=callbackTtlMs;
  }
  readiness() {
    try {callbackOrigin(this.callbackBaseURL);return {configured:true,phone_reachability:'requires_live_verification'};}
    catch {return {configured:false,reason:'callback_origin_not_configured',phone_reachability:'not_verified'};}
  }
  initialize() {
    this.#ready??=(async()=>{
      await mkdir(this.directory,{recursive:true,mode:0o700});
      if((await lstat(this.directory)).isSymbolicLink())throw fault('APP_ACTION_JOURNAL_INVALID','App action journal cannot be a symlink.');
      await chmod(this.directory,0o700);
      const names=(await readdir(this.directory)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
      if(names.length>this.maxRecords)throw fault('APP_ACTION_CAPACITY','Existing journal exceeds configured capacity; preserve it and review retention.');
      for(const name of names) {
        const path=join(this.directory,name),info=await lstat(path);
        if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw fault('APP_ACTION_JOURNAL_INVALID','Invalid app action journal record.');
        const r=JSON.parse(await readFile(path,'utf8'));
        if(r.version!==1||digest(r.operation_key??'')!==r.id||name!==r.id+'.json'||!states.has(r.state)||
          typeof r.device!=='string'||!/^[a-f0-9]{64}$/.test(r.args_digest??'')||
          !['success','cancelled','error'].every(s=>/^[a-f0-9]{64}$/.test(r.callback_hashes?.[s]??'')))
          throw fault('APP_ACTION_JOURNAL_INVALID','Invalid app action journal record.');
        this.#records.set(r.id,r);
        if(r.state==='prepared') {r.state='not_sent';r.reason='host_restarted_before_dispatch';await this.#save(r);}
        if(r.state==='dispatched') {r.state='unknown';r.reason='host_restarted_after_dispatch';await this.#save(r);}
        await chmod(path,0o600);
      }
    })();
    return this.#ready;
  }
  async #serial(fn) {
    await this.initialize();
    const next=this.#tail.then(fn);this.#tail=next.catch(()=>{});
    return next;
  }
  async #save(record) {
    record.updated_at=nowISO(this.now());
    const temporary=join(this.directory,record.id+'.'+randomBytes(8).toString('hex')+'.tmp');
    const file=await open(temporary,'wx',0o600);
    try {await file.writeFile(JSON.stringify(record));await file.sync();}finally{await file.close();}
    await rename(temporary,join(this.directory,record.id+'.json'));
    const directory=await open(this.directory,'r');
    try {await directory.sync();}finally{await directory.close();}
    this.#records.set(record.id,record);
    this.#events.emit(record.id,receipt(record));
  }
  async prepare(device,original) {
    const args=runShortcutSchema.parse(original);
    return this.#serial(async()=>{
      const id=digest(args.operation_key),binding=argsDigest(device,args),previous=this.#records.get(id);
      if(previous) {
        if(previous.device!==device||previous.args_digest!==binding)throw fault('APP_ACTION_KEY_CONFLICT','This operation key is already bound to different arguments or another phone.');
        return {created:false,receipt:receipt(previous)};
      }
      const origin=callbackOrigin(this.callbackBaseURL);
      if(this.#records.size>=this.maxRecords)throw fault('APP_ACTION_CAPACITY','App action journal is full. Preserve replay barriers; review retention before new actions.');
      const callbacks={},hashes={};
      for(const outcome of ['success','cancelled','error']) {
        const token=randomBytes(32).toString('hex');hashes[outcome]=digest(token);
        const url=new URL(CALLBACK_PATH,origin);
        for(const [key,value] of Object.entries({id,outcome,token}))url.searchParams.set(key,value);
        callbacks[outcome]=url.toString();
      }
      const record={version:1,id,operation_key:args.operation_key,device,shortcut:args.shortcut,args_digest:binding,
        state:'prepared',postcondition_requested:Boolean(args.expect),created_at:nowISO(this.now()),callback_expires_at:this.now()+this.callbackTtlMs,
        callback_hashes:hashes};
      await this.#save(record);
      return {created:true,receipt:receipt(record),callbacks};
    });
  }
  async status(operationKey,device) {
    return this.#serial(async()=>{
      const record=this.#records.get(digest(operationKey));
      if(!record)return {operation_key:operationKey,device,state:'not_found',isError:true,replayed:false};
      if(record.device!==device)throw fault('APP_ACTION_DEVICE_MISMATCH','The operation belongs to another phone.');
      return receipt(record);
    });
  }
  async #change(id,state,reason) {
    return this.#serial(async()=>{
      const record=this.#records.get(id);
      if(!record)throw fault('APP_ACTION_NOT_FOUND','Unknown app action.');
      if(terminal.has(record.state))return receipt(record);
      if(state==='dispatched'&&record.state!=='prepared')throw fault('APP_ACTION_ALREADY_DISPATCHED','This operation cannot be dispatched again.');
      const next={...record,state,...(reason?{reason}:{})};
      if(state==='dispatched')next.dispatched_at=nowISO(this.now());
      await this.#save(next);return receipt(next);
    });
  }
  markDispatched(id) {return this.#change(id,'dispatched');}
  markUnknown(id,reason='execution_unconfirmed') {return this.#change(id,'unknown',reason);}
  markNotSent(id,reason='dispatch_refused') {return this.#change(id,'not_sent',reason);}
  async acceptCallback(original) {
    const fields=validateAppActionCallback(original);
    return this.#serial(async()=>{
      const record=this.#records.get(fields.id);
      if(!record)throw fault('APP_ACTION_NOT_FOUND','Unknown app action.');
      const expected=Buffer.from(record.callback_hashes[fields.outcome],'hex'),actual=Buffer.from(digest(fields.token),'hex');
      if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw fault('APP_ACTION_CALLBACK_UNAUTHORIZED','Callback token was not accepted.');
      if(this.now()>record.callback_expires_at)throw fault('APP_ACTION_CALLBACK_EXPIRED','Callback receipt has expired; inspect the action without replaying.');
      const value=fields.outcome==='success'?{result:fields.result??''}:fields.outcome==='error'?{error_message:fields.errorMessage??''}:{};
      const resultDigest=digest(JSON.stringify([fields.outcome,value]));
      if(terminal.has(record.state)) {
        if(record.callback_digest===resultDigest)return receipt(record);
        throw fault('APP_ACTION_CALLBACK_CONFLICT','A terminal receipt cannot be replaced.');
      }
      if(record.state==='prepared')throw fault('APP_ACTION_CALLBACK_INVALID','No dispatch intent exists for this callback.');
      const next={...record,...value,state:fields.outcome,callback_received_at:nowISO(this.now()),callback_digest:resultDigest};
      delete next.reason;
      await this.#save(next);return receipt(next);
    });
  }
  async wait(id,{timeoutMs=10000,signal}={}) {
    await this.initialize();
    const present=this.#records.get(id);
    if(!present)throw fault('APP_ACTION_NOT_FOUND','Unknown app action.');
    if(terminal.has(present.state)||present.state==='unknown')return receipt(present);
    if(signal?.aborted)return this.markUnknown(id,'caller_cancelled_after_dispatch');
    return new Promise((resolve,reject)=>{
      let done=false,timer;
      const finish=value=>{if(done)return;done=true;clearTimeout(timer);this.#events.off(id,onChange);signal?.removeEventListener('abort',onAbort);resolve(value);};
      const fail=error=>{if(done)return;done=true;clearTimeout(timer);this.#events.off(id,onChange);signal?.removeEventListener('abort',onAbort);reject(error);};
      const onChange=value=>{if(terminal.has(value.state)||value.state==='unknown')finish(value);};
      const onAbort=()=>{void this.markUnknown(id,'caller_cancelled_after_dispatch').then(finish,fail);};
      this.#events.on(id,onChange);signal?.addEventListener('abort',onAbort,{once:true});
      timer=setTimeout(()=>{void this.markUnknown(id,'callback_timeout').then(finish,fail);},Math.max(0,timeoutMs));
      onChange(receipt(this.#records.get(id)));
      if(signal?.aborted)onAbort();
    });
  }
}

/** The existing open_url dispatcher remains the only phone action here. */
export async function runShortcut(ctx,original,store,{observe=snapshotUI,requestSignal=currentSignal()}={}) {
  const args=runShortcutSchema.parse(original),target=await ctx.target();
  if(target.kind!=='physical')return {state:'not_sent',isError:true,reason:'physical_device_required'};
  let prepared;
  try {prepared=await store.prepare(target.id,args);}
  catch(error) {
    if(error.code==='APP_ACTION_CALLBACK_UNCONFIGURED')return {state:'not_sent',outcome:'not_sent',isError:true,
      reason:'callback_origin_not_configured',replayed:false,dispatch_attempted:false};
    throw error;
  }
  if(!prepared.created)return prepared.receipt;
  const id=prepared.receipt.action_id;
  for(const owner of [ctx,...(ctx.peers?.()??[])])if(owner.backgroundDevices?.get(target.id)?.has('recording'))
    return store.markNotSent(id,'active_recording_requires_owner_coordination');
  try {checkWork();requestSignal?.throwIfAborted();}
  catch {return store.markNotSent(id,'cancelled_before_dispatch');}
  const url=new URL('shortcuts://x-callback-url/run-shortcut');
  url.searchParams.set('name',args.shortcut);
  if(args.input!==undefined){url.searchParams.set('input','text');url.searchParams.set('text',args.input);}
  url.searchParams.set('x-success',prepared.callbacks.success);
  url.searchParams.set('x-cancel',prepared.callbacks.cancelled);
  url.searchParams.set('x-error',prepared.callbacks.error);
  await store.markDispatched(id);
  let response;
  try {response=await ctx.dispatch('open_url',{device:target.id,url:url.toString()});}
  catch {return store.markUnknown(id,'open_url_outcome_unknown');}
  if(response?.isError) {
    const body=bodyOf(response);
    if(body.executed===false || body.sent===false&&body.outcome==='not_sent')return store.markNotSent(id,'open_url_not_sent');
    return store.markUnknown(id,'open_url_outcome_unknown');
  }
  const result=await store.wait(id,{timeoutMs:Math.min(args.timeout_ms,Math.max(0,remaining())),signal:requestSignal});
  if(result.state!=='success'||!args.expect)return result;
  try {
    const snapshot=await observe(ctx,{device:target.id,event_stream:false,max_elements:400});
    const fresh=freshActionObservation(snapshot,ctx,target,args.expected_app);
    const normal=value=>value.normalize('NFKC').toLocaleLowerCase().trim();
    const facts=new Set((snapshot.elements??[]).filter(e=>actionElementOnscreen(e,snapshot)).flatMap(e=>[e.label,e.text,e.value,e.identifier,e.placeholder]).filter(v=>typeof v==='string').map(normal));
    const matched=fresh&&args.expect.all.every(v=>facts.has(normal(v)))&&(!args.expect.any.length||args.expect.any.some(v=>facts.has(normal(v))))&&args.expect.none.every(v=>!facts.has(normal(v)));
    return {...result,...(!matched?{isError:true}:{}),postcondition:{status:matched?'verified':'not_verified',
      ...(matched?{observation_id:snapshot.observation.id,device:target.id}:{}),independent_of_callback:true}};
  } catch {return {...result,isError:true,postcondition:{status:'not_verified',reason:'observation_unavailable',independent_of_callback:true}};}
}

/** A result-only endpoint. Root admits the trusted host/relay; this handler checks
 * the operation-specific token. It cannot call MCP or dispatch any phone input. */
export async function handleAppActionCallback(req,res,store) {
  let pathname;
  try {pathname=new URL(req.url,'https://callback.invalid').pathname;}catch{return false;}
  if(pathname!==CALLBACK_PATH)return false;
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'","X-Content-Type-Options":'nosniff'};
  const respond=(status,payload)=>{res.writeHead(status,headers);res.end(JSON.stringify(payload));};
  if(req.method!=='GET'){respond(405,{received:false,error:'method_not_allowed'});return true;}
  if(req.headers?.['transfer-encoding'] || req.headers?.['content-length']!==undefined&&req.headers['content-length']!=='0') {
    respond(400,{received:false,error:'request_body_not_allowed'});return true;
  }
  try {
    const fields=parseAppActionCallbackURL(req.url);
    const received=await store.acceptCallback(fields);
    respond(200,{received:true,state:received.state});
  } catch(error) {
    const status=error.code==='APP_ACTION_CALLBACK_UNAUTHORIZED'?403:error.code==='APP_ACTION_NOT_FOUND'?404:
      error.code==='APP_ACTION_CALLBACK_CONFLICT'?409:error.code==='APP_ACTION_CALLBACK_EXPIRED'?410:
      error.code==='APP_ACTION_CALLBACK_INVALID'?400:503;
    respond(status,{received:false,error:status===503?'callback_store_unavailable':'callback_not_accepted'});
  }
  return true;
}

export async function appActionTool(ctx,name,args,store) {
  if(name==='run_shortcut')return runShortcut(ctx,args,store);
  if(name==='get_app_action_status') {
    const parsed=appActionStatusSchema.parse(args),target=await ctx.target();
    return store.status(parsed.operation_key,target.id);
  }
  if(name==='list_app_links'){listAppLinksSchema.parse(args);return listAppLinks();}
  if(name==='open_verified_link')return openVerifiedLink(ctx,args);
  throw new Error('Unknown app action tool');
}
