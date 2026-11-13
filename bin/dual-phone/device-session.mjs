import {performance} from 'node:perf_hooks';

export const CALCULATOR = 'com.apple.calculator';

export class PhoneRunError extends Error {
  constructor(code) { super(code); this.name='PhoneRunError'; this.code=code; }
}
export function requireThat(ok,code) { if(!ok) throw new PhoneRunError(code); }
export function errorCode(error) { return error instanceof PhoneRunError ? error.code : 'transport_or_runtime_error'; }

function payload(result) {
  requireThat(result && !result.isError,'tool_error_inspect_before_resuming');
  if(result.structuredContent && typeof result.structuredContent==='object') return result.structuredContent;
  for(const item of result.content??[]) {
    if(item.type!=='text') continue;
    try { const value=JSON.parse(item.text); if(value && typeof value==='object') return value; } catch {}
  }
  throw new PhoneRunError('missing_structured_receipt');
}

function timingOnly(result) {
  const stages=result?._meta?.timing?.stages;
  if(!Array.isArray(stages)) return [];
  // Never persist arbitrary transport metadata or text from a phone.
  return stages.slice(0,30).flatMap(s=>
    typeof s.phase==='string' && /^[a-z_ -]{1,40}$/i.test(s.phase) && Number.isFinite(s.elapsed_ms)
      ? [{phase:s.phase,elapsed_ms:s.elapsed_ms}] : []);
}

export function validatePhone(phone) {
  // Device choices come only from the caller's explicit private configuration.
  // Listing devices later confirms this complete identity; it never selects one.
  requireThat(phone && typeof phone==='object' && !Array.isArray(phone) &&
    Object.keys(phone).every(k=>['id','name','kind','connection','model'].includes(k)) &&
    typeof phone.id==='string' && /^(?:[a-f\d]{8}-[a-f\d]{16}|[a-f\d]{40})$/i.test(phone.id) &&
    typeof phone.name==='string' && phone.name.trim().length>0 && phone.name.length<=200 &&
    !/[\u0000-\u001f\u007f]/.test(phone.name) &&
    phone.kind==='physical' && phone.connection==='RemotePairing','unreviewed_device_identity');
  requireThat(phone.model===undefined || (typeof phone.model==='string' && phone.model.length<=40 &&
    /^iPhone\d+,\d+$/.test(phone.model)), 'invalid_device_model');
  return {id:phone.id,name:phone.name,kind:phone.kind,connection:phone.connection,
    ...(phone.model?{model:phone.model}:{})};
}

export function validateDeviceConfig(config) {
  requireThat(config && typeof config==='object' && !Array.isArray(config) &&
    Object.keys(config).every(k=>['version','devices'].includes(k)) && config.version===1 &&
    Array.isArray(config.devices) && config.devices.length===2,'explicit_two_device_config_required');
  const phones=config.devices.map(validatePhone);
  requireThat(phones[0].id!==phones[1].id,'duplicate_phone');
  return phones;
}

/** One persistent MCP client, one verified physical device, one local FIFO.
 * This wrapper does not grant authority. The existing daemon must remain in ask-human mode.
 * No input is retried. An uncertain action fences future input but still permits inspection/cleanup.
 */
export class PinnedPhoneSession {
  #client; #phone; #tail=Promise.resolve(); #lease; #expires=0; #stopping=false;
  #stopPromise; #fenced=false; #ready=false; #deadline; #callTimeoutMs; #ttlSeconds; #acquireAttempted=false; #launchProof;
  constructor(client,phone,{callTimeoutMs=45000,maxSessionMs=300000,ttlSeconds=300,clock=()=>Date.now()}={}) {
    requireThat(client && typeof client.callTool==='function','invalid_client');
    requireThat(Number.isInteger(callTimeoutMs)&&callTimeoutMs>=100&&callTimeoutMs<=60000,'invalid_call_timeout');
    requireThat(Number.isInteger(maxSessionMs)&&maxSessionMs>=callTimeoutMs&&maxSessionMs<=600000,'invalid_session_budget');
    requireThat(Number.isInteger(ttlSeconds)&&ttlSeconds>=60&&ttlSeconds<=600,'invalid_lease_ttl');
    this.#client=client; this.#phone=Object.freeze(validatePhone(phone)); this.clock=clock;
    this.#deadline=clock()+maxSessionMs; this.#callTimeoutMs=callTimeoutMs; this.#ttlSeconds=ttlSeconds;
    this.report={device:this.phone,session_ready:false,calls:[],retries:0,cleanup:'not_started'};
  }
  get client() { return this.#client; }
  get phone() { return this.#phone; }
  get fenced() { return this.#fenced; }
  get ready() { return this.#ready && !this.#stopping; }
  #enqueue(fn) {
    const result=this.#tail.then(fn);
    this.#tail=result.catch(()=>{});
    return result;
  }
  async #call(name,args,{input=false,cleanup=false}={}) {
    if(!cleanup) requireThat(this.clock()<this.#deadline,'session_budget_exhausted');
    const startedMs=this.clock(),startedMono=performance.now();
    const log={tool:name,started_at:new Date(startedMs).toISOString(),input};
    this.report.calls.push(log);
    let timeout;
    const controller=new AbortController();
    try {
      const pending=Promise.resolve().then(()=>this.#client.callTool({name,arguments:args},
        {timeout:this.#callTimeoutMs,signal:controller.signal}));
      const timed=new Promise((_,reject)=>{
        timeout=setTimeout(()=>{controller.abort();reject(new PhoneRunError(input?'input_timeout_unknown':'call_timeout'));},this.#callTimeoutMs);
      });
      const result=await Promise.race([pending,timed]);
      log.timings=timingOnly(result);
      const stopReason=result?._meta?.stop_reason;
      if(['error','timeout','needs_human_action','cancelled','aborted','expired'].includes(stopReason))log.stop_reason=stopReason;
      const value=payload(result);
      requireThat(!value.stopped || cleanup,'operation_stopped');
      requireThat(value.outcome!=='unknown' && value.state!=='unknown','unknown_outcome');
      requireThat(!value.prompt && result?._meta?.stop_reason!=='needs_human_action','human_action_required');
      log.ok=true;
      return value;
    } catch(error) {
      log.ok=false; log.error=errorCode(error);
      if(['AbortError','TimeoutError'].includes(error?.name))log.failure_class=error.name;
      if(input) { this.#fenced=true; this.#launchProof=undefined; log.uncertain_input=true; }
      throw error instanceof PhoneRunError ? error : new PhoneRunError('transport_or_runtime_error');
    } finally {
      clearTimeout(timeout);
      log.finished_at=new Date(this.clock()).toISOString();
      log.elapsed_ms=Math.round((performance.now()-startedMono)*100)/100;
    }
  }
  #checkReceipt(lease) {
    requireThat(typeof lease.lease_id==='string' && lease.lease_id.length>0 && lease.lease_id.length<=200 &&
      lease.device===this.phone.id && lease.state==='active','lease_identity_mismatch');
    const expires=Date.parse(lease.expires_at);
    requireThat(Number.isFinite(expires)&&expires>this.clock(),'invalid_lease_expiry');
    return expires;
  }
  async initialize() {
    return this.#enqueue(async()=>{
      requireThat(!this.#ready&&!this.#lease&&!this.#stopping,'session_already_initialized');
      const status=await this.#call('poki_mcp_status',{});
      requireThat(!this.#stopping,'session_stopping');
      requireThat(status.approval_mode==='ask-human','approval_mode_must_remain_ask_human');
      const inventory=await this.#call('list_devices',{});
      requireThat(!this.#stopping,'session_stopping');
      const matches=(inventory.devices??[]).filter(d=>d.id===this.phone.id);
      requireThat(matches.length===1,'device_missing_or_ambiguous');
      const target=matches[0];
      requireThat(Object.entries(this.phone).every(([k,v])=>target[k]===v)&&!target.blocked,'device_identity_or_transport_mismatch');
      requireThat(!target.occupied,'device_owned_by_another_session');
      this.#acquireAttempted=true;
      const lease=await this.#call('acquire_device',{device:this.phone.id,ttl_seconds:this.#ttlSeconds});
      // Retain even a malformed lease receipt's id for no-blind-retry diagnostics; never
      // use or release it unless both identity and session receipt validate.
      this.#expires=this.#checkReceipt(lease); this.#lease=lease.lease_id;
      requireThat(!this.#stopping,'session_stopping');
      this.#ready=true; this.report.session_ready=true; this.report.cleanup='owned';
      return {device:this.phone.id,ready:true};
    });
  }
  async #renewIfNeeded() {
    if(this.#expires-this.clock()>this.#callTimeoutMs+5000) return;
    const lease=await this.#call('renew_device',{lease_id:this.#lease,ttl_seconds:this.#ttlSeconds});
    requireThat(lease.lease_id===this.#lease,'renewal_changed_lease');
    this.#expires=this.#checkReceipt(lease);
  }
  #work(fn,{input=false}={}) {
    return this.#enqueue(async()=>{
      requireThat(this.#ready&&!this.#stopping&&this.#lease,'session_not_available');
      if(input) requireThat(!this.#fenced,'input_fenced_after_uncertain_result');
      await this.#renewIfNeeded();
      requireThat(!this.#stopping,'session_stopping');
      return fn();
    });
  }
  async observe() {
    return this.#work(async()=>{
      try {
        const snapshot=await this.#call('snapshot_ui',{device:this.phone.id,max_elements:160,timeout_ms:6000,event_stream:false});
        requireThat(snapshot.observation?.device===this.phone.id&&snapshot.source==='accessibility'&&
          snapshot.observation?.input_freshness==='live_read'&&!snapshot.unavailable&&!snapshot.prompt&&
          Array.isArray(snapshot.elements),'unusable_or_wrong_device_observation');
        return snapshot;
      } catch(error) { this.#launchProof=undefined;throw error; }
    });
  }
  async foreground() {
    return this.#work(()=>this.#call('get_foreground_app',{device:this.phone.id}));
  }
  async launchCalculator() {
    return this.#work(async()=>{
      this.#launchProof=undefined;
      try {
        const result=await this.#call('launch_app',{device:this.phone.id,bundle_id:CALCULATOR,return_screen:false},{input:true});
        requireThat(result.bundle_id===CALCULATOR&&Number.isSafeInteger(result.pid)&&result.pid>0&&
          result.launched===true&&result.foreground_verified===true&&result.transport==='paired-device-app-service'&&
          !result.isError&&!result.error&&result.sent!==false&&result.outcome!=='unknown'&&result.state!=='unknown',
          'canonical_calculator_launch_not_verified');
        this.#launchProof=Object.freeze({device:this.phone.id,leaseId:this.#lease,bundle_id:result.bundle_id,pid:result.pid});
        return {dispatched:true,foreground_verified:true,result_verified:false};
      } catch(error) { this.#launchProof=undefined;this.#fenced=true;throw error; }
    },{input:true});
  }
  #calculatorProof(snapshot) {
    try {
      const proof=this.#launchProof,observed=snapshot?.observation,foreground=snapshot?.foreground;
      requireThat(proof&&this.#ready&&!this.#stopping&&!this.#fenced&&this.#lease===proof.leaseId&&
        proof.device===this.phone.id&&this.#expires>this.clock(),'calculator_launch_proof_unavailable');
      requireThat(observed?.device===this.phone.id&&observed.input_freshness==='live_read'&&
        snapshot.source==='accessibility'&&!snapshot.prompt&&!snapshot.unavailable&&snapshot.truncated!==true&&
        Number.isSafeInteger(foreground?.pid)&&foreground.pid===proof.pid&&
        (!foreground.bundle_id||foreground.bundle_id===CALCULATOR),'calculator_launch_proof_observation_mismatch');
      const at=Date.parse(observed.structure_completed_at);
      requireThat(Number.isFinite(at)&&at<=this.clock()+1000&&this.clock()-at<=8000,'calculator_observation_not_fresh');
      return proof;
    } catch(error) { this.#launchProof=undefined;throw error; }
  }
  calculatorGuard(snapshot) { return calculatorForeground(snapshot,this.#calculatorProof(snapshot)); }
  calculatorResult(snapshot,expected) { return verifyCalculatorResult(snapshot,expected,this.#calculatorProof(snapshot)); }
  async tapCalculatorLabel(label,expectedApp) {
    requireThat(typeof label==='string'&&label.length>0&&label.length<=120,'invalid_observed_label');
    requireThat(expectedApp===CALCULATOR || typeof expectedApp==='string'&&expectedApp.length>0&&expectedApp.length<=120,'invalid_foreground_guard');
    return this.#work(async()=>{
      // tap_text freshly resolves its exact visible target and rejects ambiguity.
      // Every device input names both physical identity and the verified foreground app.
      const result=await this.#call('tap_text',{device:this.phone.id,text:label,expected_app:expectedApp,verify:false},{input:true});
      if(result.sent!==true) { this.#fenced=true;this.#launchProof=undefined;throw new PhoneRunError('input_delivery_not_confirmed'); }
      return {dispatched:true,verified:false};
    },{input:true});
  }
  async inventory() { return this.#work(()=>this.#call('list_devices',{})); }
  /** Stops only this client's owned session. Never retries an uncertain cleanup call.
   * Queue cancellation prevents any local queued action from starting. A sent action may
   * already have effects; cancellation and close do not undo it.
   */
  stop(mode='release') {
    requireThat(mode==='release'||mode==='cancel','invalid_stop_mode');
    if(this.#stopPromise) return this.#stopPromise;
    this.#stopping=true;this.#launchProof=undefined;
    this.#stopPromise=(async()=>{
      // Settle local work first, including a lease acquisition whose reply arrives
      // after stop(). This method is only called outside enqueued operations.
      await this.#tail;
      if(!this.#lease&&!this.#acquireAttempted) { this.report.cleanup='no_lease_acquisition_attempted'; return {stopped:true,owned:false}; }
      const ownLease=this.#lease;
      try {
        // If acquisition's receipt was lost, do not invent/replay a lease id.
        // cancel_device without one cancels ONLY this client's accepted work.
        const tool=(!ownLease||mode==='cancel')?'cancel_device':'release_device';
        const value=await this.#call(tool,ownLease?{lease_id:ownLease}:{},{cleanup:true});
        requireThat(value.stopped===true&&(!value.device||value.device===this.phone.id)&&
          (!ownLease||value.lease_id===ownLease),'cleanup_receipt_mismatch');
        const native=value.cleanup?.native;
        requireThat(!Array.isArray(native)||native.every(x=>x.released===true||x.skipped_new_owner===true),'native_cleanup_unverified');
        this.#lease=undefined;this.#ready=false;this.report.cleanup=tool==='cancel_device'?'cancelled_own_session':'released_own_lease';
        return {stopped:true,owned:false,device:this.phone.id};
      } catch(error) {
        this.#fenced=true;this.report.cleanup='unknown_no_retry';throw error;
      } finally { await this.#tail; }
    })();
    return this.#stopPromise;
  }
}

export function calculatorForeground(snapshot,foregroundProof) {
  const f=snapshot.foreground;
  if(f?.bundle_id===CALCULATOR) return CALCULATOR;
  requireThat(!f?.bundle_id&&foregroundProof?.bundle_id===CALCULATOR&&
    Number.isInteger(f?.pid)&&f.pid>0&&f.pid===foregroundProof.pid&&
    typeof f.name==='string'&&f.name.length>0&&f.name.length<=120,'calculator_foreground_not_verified');
  // Native input() checks the raw AX bundle/name, not the app_for_pid-enriched
  // foreground result. Use the exact AX name only after canonical identity proof.
  return f.name;
}

export function verifyCalculatorResult(snapshot,expected,foregroundProof) {
  calculatorForeground(snapshot,foregroundProof);
  requireThat(snapshot.truncated!==true,'truncated_result_observation');
  requireThat(expected && ['label','value','text'].includes(expected.field) &&
    typeof expected.text==='string' && expected.text.length>0 && expected.text.length<=80 &&
    typeof expected.role==='string' && expected.role.length>0 && !/button|key/i.test(expected.role)&&
    typeof expected.objectId==='string'&&expected.objectId.length>0&&expected.objectId.length<=200, 'invalid_result_selector');
  const hits=snapshot.elements.filter(e=>e.object_id===expected.objectId&&(e.role??e.type)===expected.role&&String(e[expected.field]??'').normalize('NFKC')===expected.text.normalize('NFKC'));
  return hits.length===1;
}
