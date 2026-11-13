#!/usr/bin/env node
/** Bounded, interactive, screenshot-reviewed Calculator acceptance only.
 * No app launch, generic tool dispatch, automatic retry, or automatic UI verdict.
 * Exact point plans must be reviewed by the operator against this session's images.
 */
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {mkdir,lstat,open,readFile} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {connectPair,getClientSessionBinding} from './connect.mjs';
import {PinnedPhoneSession,validateDeviceConfig,PhoneRunError,requireThat,errorCode} from './device-session.mjs';
import {nativeReceipts} from './analyze-native-overlap.mjs';

const PHASE_MS=60000,GROUNDING_MS=90000,TOTAL_MS=600000;
const ownKeys=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).every(k=>keys.includes(k));
const objects=result=>(result?.content??[]).filter(x=>x.type==='text').flatMap(x=>{try{return [JSON.parse(x.text)];}catch{return [];}});
const phases=result=>(result?._meta?.timing?.stages??[]).slice(0,40).flatMap(s=>typeof s.phase==='string'&&/^[a-z_ -]{1,40}$/i.test(s.phase)&&Number.isFinite(s.elapsed_ms)
  ? [{phase:s.phase,elapsed_ms:s.elapsed_ms,...(Number.isInteger(s.id)?{id:s.id}:{}),...(Number.isInteger(s.parent)?{parent:s.parent}:{})}]:[]);

async function bounded(promise,ms,controller) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{controller?.abort();reject(new PhoneRunError('bounded_call_timeout'));},Math.max(1,ms));})]);}
  finally {clearTimeout(timer);}
}

export class VisualAcceptanceRunner {
  constructor(clients,{devices,outputDirectory,sessionFactory=(client,phone)=>new PinnedPhoneSession(client,phone,{maxSessionMs:TOTAL_MS,ttlSeconds:300})}={}) {
    requireThat(Array.isArray(clients)&&clients.length===2&&clients[0]!==clients[1],'two_distinct_clients_required');
    requireThat(typeof outputDirectory==='string'&&outputDirectory.startsWith('/'),'absolute_private_output_directory_required');
    const phones=validateDeviceConfig({version:1,devices});
    this.outputDirectory=resolve(outputDirectory);this.clients=clients;this.runId=randomUUID();this.started=performance.now();
    this.sessions=phones.map((phone,i)=>sessionFactory(clients[i],phone));
    this.lanes=this.sessions.map((s,i)=>({lane:i,device:s.phone.id,...getClientSessionBinding(clients[i]),closed:false,fenced:false,grounding:null}));
    this.events=[];this.journalTail=Promise.resolve();this.closed=false;this.commandCount=0;
  }
  async event(value) {
    const event={at:new Date().toISOString(),run_id:this.runId,...value};this.events.push(event);
    this.journalTail=this.journalTail.then(()=>this.journal?.write(JSON.stringify(event)+'\n'));
    await this.journalTail;return event;
  }
  async initialize() {
    await mkdir(this.outputDirectory,{recursive:true,mode:0o700});
    const info=await lstat(this.outputDirectory);
    requireThat(info.isDirectory()&&!info.isSymbolicLink()&&(info.mode&0o077)===0,'output_directory_must_be_private');
    this.journal=await open(join(this.outputDirectory,`visual-${this.runId}.jsonl`),'wx',0o600);
    try {
      for(const [i,session] of this.sessions.entries()) {
        await session.initialize();await this.event({kind:'preflight',...this.#identity(this.lanes[i]),status:'PASS'});
      }
      return this.event({kind:'ready',status:'READY',maximum_session_ms:TOTAL_MS,maximum_phase_ms:PHASE_MS,
        maximum_grounding_age_ms:GROUNDING_MS,automatic_visual_verification:false,runtime_app_guard:false,
        session_bindings:this.lanes.map(lane=>this.#identity(lane)),
        native_clock_comparison_assumption:'trusted_single_run_same_local_daemon_host_and_boot'});
    } catch(error) {await this.event({kind:'preflight_failed',error:errorCode(error)});await this.close();throw error;}
  }
  #lane(index) {
    requireThat(Number.isInteger(index)&&index>=0&&index<2,'invalid_lane');
    const lane=this.lanes[index];requireThat(!lane.closed,'lane_closed');return lane;
  }
  #identity(lane) {
    return {lane:lane.lane,device:lane.device,...(lane.client_session_id?{
      client_session_id:lane.client_session_id,connection_group:lane.connection_group,source:lane.source}:{})};
  }
  #budget() {requireThat(!this.closed&&performance.now()-this.started<TOTAL_MS,'visual_session_closed_or_expired');}
  async #lease(index,ms=45000) {
    // inventory() enters this helper's existing FIFO and renews only its own lease
    // when needed. It is read-only and does not use accessibility or foreground UI.
    await bounded(this.sessions[index].inventory(),ms);
    this.#budget();
  }
  async #call(index,name,args,{input=false,timeoutMs=45000,groundingId,pointIndex}={}) {
    const lane=this.#lane(index);this.#budget();
    if(input)requireThat(!lane.fenced,'visual_input_fenced');
    const controller=new AbortController(),start=performance.now();
    const record={kind:'call',...this.#identity(lane),tool:name,input,
      requested_at:new Date().toISOString(),...(groundingId?{grounding_id:groundingId}:{}),
      ...(pointIndex===undefined?{}:{point_index:pointIndex})};
    try {
      const result=await bounded(Promise.resolve().then(()=>this.clients[index].callTool({name,arguments:{device:lane.device,...args}},
        {timeout:timeoutMs,signal:controller.signal})),timeoutMs,controller);
      record.timings=phases(result);
      Object.assign(record,nativeReceipts(result));
      const values=objects(result);
      requireThat(!result?.isError&&!values.some(x=>x?.isError||x?.error||x?.stopped||x?.outcome==='unknown'||x?.state==='unknown'),'visual_tool_error_or_unknown');
      if(input) {
        // device.mjs returns interaction's top-level sent flag for raw tap.
        requireThat(values.some(x=>x?.sent===true)&&!values.some(x=>x?.sent===false),'visual_input_not_confirmed_sent');
        record.sent=true;record.effect_verified=false;
      }
      record.ok=true;return result;
    } catch(error) {
      record.ok=false;record.error=errorCode(error);
      if(input){lane.fenced=true;record.input_fenced=true;}
      lane.grounding=null;throw error;
    } finally {
      record.finished_at=new Date().toISOString();record.elapsed_ms=Math.round((performance.now()-start)*100)/100;
      await this.event(record);
    }
  }
  async capture(index) {
    const lane=this.#lane(index);lane.grounding=null;await this.#lease(index);
    const result=await this.#call(index,'take_screenshot',{});
    const observation=objects(result).map(x=>x?.observation).find(Boolean);
    requireThat(observation?.device===lane.device&&typeof observation.id==='string'&&
      observation.units==='points'&&Number.isFinite(observation.width)&&Number.isFinite(observation.height)&&
      observation.width>0&&observation.height>0&&observation.width<=16384&&observation.height<=16384,
      'screenshot_identity_or_dimensions_missing');
    const captured=Date.parse(observation.capture_completed_at);
    requireThat(Number.isFinite(captured)&&captured<=Date.now()+1000&&Date.now()-captured<=GROUNDING_MS,'screenshot_not_fresh');
    const images=(result.content??[]).filter(x=>x.type==='image');
    requireThat(images.length===1&&images[0].mimeType==='image/jpeg'&&typeof images[0].data==='string','single_jpeg_required');
    const data=Buffer.from(images[0].data,'base64');requireThat(data.length>3&&data.length<=25000000&&data[0]===0xff&&data[1]===0xd8,'invalid_jpeg_capture');
    const screenshotId=randomUUID(),path=join(this.outputDirectory,`lane-${index}-${screenshotId}.jpg`);
    const file=await open(path,'wx',0o600);try{await file.writeFile(data);}finally{await file.close();}
    const hash=createHash('sha256').update(data).digest('hex');
    lane.grounding={id:screenshotId,providerId:observation.id,device:lane.device,width:observation.width,height:observation.height,captured,sha256:hash};
    return this.event({kind:'capture',...this.#identity(lane),...nativeReceipts(result),screenshot_id:screenshotId,
      provider_observation_id:observation.id,path,sha256:hash,width_points:observation.width,height_points:observation.height,
      capture_completed_at:new Date(captured).toISOString(),requires_operator_visual_review:true});
  }
  #validateTaps(spec) {
    requireThat(ownKeys(spec,['lane','screenshotId','points']),'unexpected_point_plan_keys');
    const lane=this.#lane(spec.lane),grounding=lane.grounding;
    requireThat(!lane.fenced,'visual_input_fenced');
    requireThat(grounding&&spec.screenshotId===grounding.id&&grounding.device===lane.device&&Date.now()-grounding.captured<=GROUNDING_MS,'reviewed_screenshot_missing_stale_or_wrong_lane');
    requireThat(Array.isArray(spec.points)&&spec.points.length>=1&&spec.points.length<=8,'one_to_eight_reviewed_points_required');
    for(const point of spec.points)requireThat(ownKeys(point,['x','y'])&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&
      point.x>=0&&point.y>=0&&point.x<grounding.width&&point.y<grounding.height,'point_outside_reviewed_viewport');
    return {lane,spec,grounding};
  }
  async #tapSequence({lane,spec,grounding}) {
    const start=performance.now();lane.grounding=null; // one-shot; a new phase requires a new screenshot
    let sent=0;const receipts=[];
    try {
      for(const [i,point] of spec.points.entries()) {
        const remaining=()=>PHASE_MS-(performance.now()-start);
        requireThat(remaining()>0,'visual_phase_deadline');
        await this.#lease(lane.lane,Math.min(45000,remaining()));
        requireThat(remaining()>0,'visual_phase_deadline');
        requireThat(Date.now()-grounding.captured<=GROUNDING_MS,'reviewed_screenshot_expired_before_input');
        const result=await this.#call(lane.lane,'tap',{x:point.x,y:point.y,verify:false},
          {input:true,timeoutMs:Math.min(45000,remaining()),groundingId:grounding.id,pointIndex:i});
        const native=nativeReceipts(result);
        if(Object.keys(native).length)receipts.push({point_index:i,...native});
        sent++;
      }
      return {...this.#identity(lane),status:'SENT_REQUIRES_VISUAL_VERIFICATION',sent,grounding_id:grounding.id,sha256:grounding.sha256,
        ...(receipts.length?{native_receipts:receipts}:{})};
    } catch(error) {
      return {...this.#identity(lane),status:'STOPPED',sent,remaining_not_sent:spec.points.length-sent,error:errorCode(error),input_fenced:lane.fenced,
        ...(receipts.length?{native_receipts:receipts}:{})};
    }
  }
  async handle(command) {
    requireThat(ownKeys(command,['op','lanes','mode']),'unexpected_command_keys');
    requireThat(++this.commandCount<=30,'command_budget_exhausted');
    if(command.op==='close')return this.close();
    this.#budget();
    if(command.op==='capture') {
      requireThat(Array.isArray(command.lanes)&&command.lanes.length>=1&&command.lanes.length<=2&&new Set(command.lanes).size===command.lanes.length,'distinct_capture_lanes_required');
      command.lanes.forEach(i=>this.#lane(i));
      const results=await Promise.allSettled(command.lanes.map(i=>this.capture(i)));
      return {op:'capture',results:results.map((r,i)=>r.status==='fulfilled'?r.value:{lane:command.lanes[i],status:'BLOCKED',error:errorCode(r.reason)})};
    }
    if(command.op==='calculator_taps') {
      requireThat(Array.isArray(command.lanes)&&command.lanes.length>=1&&command.lanes.length<=2&&
        new Set(command.lanes.map(x=>x.lane)).size===command.lanes.length,'distinct_tap_lanes_required');
      const plans=command.lanes.map(x=>this.#validateTaps(x)); // validate ALL before either starts
      await this.event({kind:'reviewed_plan',lanes:plans.map(p=>({lane:p.lane.lane,device:p.lane.device,
        grounding_id:p.grounding.id,sha256:p.grounding.sha256,points:p.spec.points})),runtime_app_guard:false});
      return {op:'calculator_taps',results:await Promise.all(plans.map(p=>this.#tapSequence(p))),automatic_visual_verification:false};
    }
    if(command.op==='stop') {
      requireThat(Array.isArray(command.lanes)&&command.lanes.length===1&&command.lanes[0]===0,'isolation_stop_is_lane_zero_only');
      requireThat(['release','cancel'].includes(command.mode),'invalid_stop_mode');
      const lane=this.#lane(0);lane.closed=true;lane.grounding=null;
      const outcome=await this.sessions[0].stop(command.mode);
      return this.event({kind:'lane_stopped',...this.#identity(lane),mode:command.mode,outcome});
    }
    throw new PhoneRunError('unknown_visual_command');
  }
  async close() {
    if(this.closePromise)return this.closePromise;
    this.closed=true;this.lanes.forEach(l=>{l.closed=true;l.grounding=null;});
    this.closePromise=(async()=>{
      const outcomes=await Promise.allSettled(this.sessions.map((s,i)=>s.stop(this.lanes[i].fenced?'cancel':'release')));
      const result={kind:'closed',status:outcomes.every(x=>x.status==='fulfilled')?'OWN_SESSIONS_CLOSED':'CLEANUP_UNVERIFIED',
        automatic_visual_verification:false,native_dispatch_overlap:'NOT_MEASURED',
        cleanup:outcomes.map((r,i)=>({lane:i,...(r.status==='fulfilled'?r.value:{error:errorCode(r.reason)})}))};
      await this.event(result);await this.journalTail;await this.journal?.close();return result;
    })();
    return this.closePromise;
  }
}

export async function readDeviceConfig(path) {
  requireThat(typeof path==='string'&&isAbsolute(path),'absolute_device_config_required');
  const source=await readFile(path,'utf8');
  requireThat(Buffer.byteLength(source)<=16384,'device_config_too_large');
  return validateDeviceConfig(JSON.parse(source));
}

async function main() {
  const args=process.argv.slice(2),config={};
  for(let i=0;i<args.length;i+=2){
    requireThat(['--repo','--state','--out','--devices'].includes(args[i])&&args[i+1]&&!args[i+1].startsWith('--')&&!config[args[i]],'usage_repo_state_out_devices');
    if(args[i]==='--devices')requireThat(isAbsolute(args[i+1]),'absolute_device_config_required');
    config[args[i]]=resolve(args[i+1]);
  }
  requireThat(config['--repo']&&config['--state']&&config['--out']&&config['--devices'],'usage_repo_state_out_devices');
  const devices=await readDeviceConfig(config['--devices']);
  const clients=await connectPair({repo:config['--repo'],stateDirectory:config['--state']});
  const runner=new VisualAcceptanceRunner(clients,{devices,outputDirectory:config['--out']});
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});let timer;
  try {
    console.log(JSON.stringify(await runner.initialize()));
    timer=setTimeout(()=>lines.close(),TOTAL_MS);
    for await(const line of lines) {
      if(!line.trim())continue;
      try {
        requireThat(line.length<=16000,'command_too_large');
        const result=await runner.handle(JSON.parse(line));console.log(JSON.stringify(result));
        if(runner.closed)break;
      } catch(error) {console.log(JSON.stringify({status:'BLOCKED',error:errorCode(error),automatic_retry:false}));}
    }
  } finally {
    clearTimeout(timer);console.log(JSON.stringify(await runner.close()));
    await Promise.allSettled(clients.map(c=>c.close()));lines.close();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(JSON.stringify({status:'BLOCKED',error:errorCode(error)}));process.exitCode=2;});
