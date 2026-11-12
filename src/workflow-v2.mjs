// All execution stays inside the existing native MCP dispatcher and run_code
// sandbox. There is no secondary phone client, service or scripting transport.
import {workflowSchema,sequenceSchema,appActionSchema,choiceSchema} from './workflow-v2-schema.mjs';
import {snapshotUI} from './ax-snapshot.mjs';
import {askHuman} from './human.mjs';
import {selectAction} from './decision-selector.mjs';
import {checkWork,phase,signal} from './work.mjs';
import {validateDecisionLease,installDecisionSession,requireDecisionSession,consumeDecisionSession,decisionSessionReceipt,revokeDecisionSession} from './decision-session.mjs';

const normal=s=>s.normalize('NFKC').toLocaleLowerCase().trim();
const facts=s=>new Set(s.elements.flatMap(e=>[e.label,e.text,e.value,e.identifier,e.placeholder]).filter(v=>typeof v==='string').map(normal));
function live(s,ctx,target,app) {
  const time=Date.parse(s?.observation?.structure_completed_at);
  return s?.source==='accessibility' && s.observation?.input_freshness==='live_read' &&
    s.observation.device===target.id && s.observation.revision===ctx.coordinator.revision(target.id) &&
    Number.isFinite(time) && time<=Date.now() && Date.now()-time<=3500 &&
    !s.truncated && !s.prompt && [s.foreground?.name,s.foreground?.bundle_id].includes(app);
}
function matches(s,g) {
  const seen=facts(s);
  return g.all.every(t=>seen.has(normal(t))) && (!g.any.length||g.any.some(t=>seen.has(normal(t)))) && g.none.every(t=>!seen.has(normal(t)));
}
const refused=reason=>({isError:true,sent:false,outcome:'not_sent',reason,execution_authorized:false});

// User strings are supplied as worker input. This fixed program never evaluates
// a selector, label, text field or model response as JavaScript.
const workflowCode=`
const normal=s=>s.normalize('NFKC').toLocaleLowerCase().trim();
const facts=s=>new Set(s.elements.flatMap(e=>[e.label,e.text,e.value,e.identifier,e.placeholder]).filter(v=>typeof v==='string').map(normal));
const matches=(s,g)=>{const f=facts(s);return g.all.every(t=>f.has(normal(t)))&&(!g.any.length||g.any.some(t=>f.has(normal(t))))&&g.none.every(t=>!f.has(normal(t)));};
const read=async(app,g)=>{
 const labels=[...new Set([...g.all,...g.any,...g.none])];
 const s=await tools.snapshot_ui({device:input.device,max_elements:400,query:{labels}});
 if(s.source!=='accessibility'||s.observation.input_freshness!=='live_read'||s.observation.device!==input.device||s.truncated||s.prompt||![s.foreground?.name,s.foreground?.bundle_id].includes(app))throw Error('Workflow observation is not a complete live result in the expected app');
 return s;
};
let state=await read(input.expected_app,input.start);
if(!matches(state,input.start))throw Error('Workflow start condition was not met; no input was sent');
let completed=0,skipped=0,currentApp=input.expected_app;
for(const step of input.steps){
 const app=step.expected_app??input.expected_app;
 if(step.when){state=await read(app,step.when);if(!matches(state,step.when)){skipped++;continue;}}
 if(step.kind==='tap')await tools.tap_text({device:input.device,text:step.label,expected_app:app,verify:false});
 if(step.kind==='fill')await tools.fill({device:input.device,field:step.field,text:step.text,expected_app:app,submit:false});
 if(step.kind==='scroll')await tools.scroll({device:input.device,direction:step.direction,expected_app:app,verify:false});
 if(step.kind==='sequence')await tools.tap_sequence({device:input.device,expected_app:app,labels:step.labels,fixed_layout:true,interval_ms:step.interval_ms});
 if(step.kind==='app_action')await tools.run_app_action({device:input.device,shortcut:step.shortcut,input:step.input,expected_app:app,expect:step.expect});
 if(step.kind==='choose'){
  const p=await tools.choose_action({device:input.device,expected_app:app,goal:step.goal,labels:step.labels,exact_label:step.exact_label,use_model:step.use_model});
  if(!step.labels.includes(p.label)||p.execution_authorized!==false)throw Error('No validated choice proposal; workflow stopped without guessing');
  await tools.tap_text({device:input.device,text:p.label,expected_app:app,verify:false});
 }
 completed++;currentApp=app;
 if(step.expect){state=await read(app,step.expect);if(!matches(state,step.expect))throw Error('Workflow checkpoint did not match; inspect before continuing');}
}
state=await read(currentApp,input.finish);
if(!matches(state,input.finish))throw Error('Workflow final result was not verified');
return {completed_steps:completed,skipped_steps:skipped,postcondition_verified:true,observation_id:state.observation.id,final_app:state.foreground};
`;

export function compileWorkflow(original) {
  const input=workflowSchema.parse(original);
  const maxCalls=2+input.steps.reduce((n,s)=>n+1+(s.kind==='choose'?1:0)+(s.when?1:0)+(s.expect?1:0),0);
  if(maxCalls>60)throw Error('Workflow exceeds the existing 60-call native sandbox limit');
  return {code:workflowCode,input,max_tool_calls:maxCalls,timeout_seconds:input.timeout_seconds};
}

export async function executeTapSequence(ctx,original,{observe=snapshotUI}={}) {
  const args=sequenceSchema.parse(original),target=await ctx.target();
  if(target.kind!=='physical')return refused('physical_device_required');
  for(const owner of [ctx,...(ctx.peers?.()??[])])if(owner.backgroundDevices?.get(target.id)?.has('recording'))return refused('active_recording_requires_owner_coordination');
  const s=await observe(ctx,{event_stream:false,max_elements:400});
  const bind=s=>{
  if(!live(s,ctx,target,args.expected_app))return refused('fresh_foreground_or_revision_not_confirmed');
  if([s.foreground?.name,s.foreground?.bundle_id].some(v=>v==='SpringBoard'||v==='com.apple.springboard') || s.elements.some(e=>/SecureTextField/i.test(e.role??e.type??'')))return refused('secure_or_system_keypad_not_supported');
  if(!s.native_runtime?.features?.includes('native_tap_sequence'))return refused('native_helper_update_required');
  if(!Number.isFinite(s.width)||!Number.isFinite(s.height)||s.width<2||s.height<2)return refused('native_geometry_not_confirmed');
  const points=[];
  for(const label of args.labels){
    // This first implementation deliberately covers numeric keypads. A visual
    // fixed-layout assertion is not a general classifier for dangerous buttons.
    if(!/^\d$/.test(label))return refused('only_observed_numeric_keys_supported');
    const found=s.elements.filter(e=>e.label===label && (e.role??e.type)==='Key' && e.enabled!==false);
    if(found.length!==1)return refused('key_missing_or_ambiguous');
    const f=found[0].frame;
    if(!f||![f.x,f.y,f.width,f.height].every(Number.isFinite)||f.width<=0||f.height<=0||f.x<0||f.y<0||f.x+f.width>s.width||f.y+f.height>s.height)return refused('key_geometry_not_confirmed');
    points.push({x:Math.round((f.x+f.width/2)/(s.width-1)*65535),y:Math.round((f.y+f.height/2)/(s.height-1)*65535)});
  }
  if(points.some(p=>p.x<0||p.x>65535||p.y<0||p.y>65535))return refused('key_center_outside_native_coordinate_range');
  return {points};
  };
  const binding=bind(s);if(binding.isError)return binding;
  checkWork();
  if(ctx.coordinator.revision(target.id)!==s.observation.revision)return refused('revision_changed');
  let observationId=s.observation.id;
  const result=await ctx.input({op:'tap_sequence',points:binding.points,interval_ms:args.interval_ms,duration_ms:50},{beforeDispatch:async()=>{
    const latest=await observe(ctx,{event_stream:false,max_elements:400}),confirmed=bind(latest);
    if(confirmed.isError)return confirmed;
    if(JSON.stringify(confirmed.points)!==JSON.stringify(binding.points))return refused('key_layout_changed_before_dispatch');
    observationId=latest.observation.id;
  }});
  return {...result,verified:false,observation_id:observationId};
}

export async function executeAppAction(ctx,original,{observe=snapshotUI}={}) {
  const args=appActionSchema.parse(original);
  const url=new URL('shortcuts://run-shortcut');url.searchParams.set('name',args.shortcut);
  if(args.input!==undefined){url.searchParams.set('input','text');url.searchParams.set('text',args.input);}
  // Never supply workflow_key, capture_key, or change approval mode. The normal
  // open_url gate remains the authority for launching this existing shortcut.
  const response=await ctx.dispatch('open_url',{device:args.device,url:url.toString()});
  if(response.isError)return {...response,postcondition_verified:false};
  const target=await ctx.target();
  const s=await observe(ctx,{device:args.device,event_stream:false,max_elements:400,query:{labels:[...new Set([...args.expect.all,...args.expect.any,...args.expect.none])]}});
  const readable=live(s,ctx,target,args.expected_app);
  const verified=readable&&matches(s,args.expect);
  return {shortcut:args.shortcut,postcondition_verified:Boolean(verified),...(verified?{observation_id:s.observation.id}:{isError:true,reason:'app_action_result_not_verified',stop_reason:'unknown'}),open_receipt:response};
}

async function externalProposal(input,options) {
  const {makeGatewayJevRequest}=await import('../bin/lib/vercel-jev.mjs');
  let requests=0,diagnostic;
  const request=makeGatewayJevRequest({model:'typesafe-ai/jev-1.14.0',onDecisionMetadata:value=>{diagnostic=value;},fetchImpl:(...args)=>{requests++;return fetch(...args);}});
  const answer=await selectAction(input,{...options,provider:'jev',model:'typesafe-ai/jev-1.14.0',request,timeoutMs:2500,dataClass:'device_ui_minimized'});
  return {...answer,model_calls:requests,...(diagnostic?{model_diagnostic:diagnostic}:{})};
}

export async function chooseAction(ctx,original,{observe=snapshotUI,approve=askHuman,propose=externalProposal,now=Date.now}={}) {
  const args=choiceSchema.parse(original),target=await ctx.target();
  const timing={decision_ms:0,observation_ms:0,approval_ms:0};
  const measured=async(name,fn)=>{const start=performance.now();try{return await fn();}finally{timing[name]+=performance.now()-start;}};
  const timings=()=>Object.fromEntries(Object.entries(timing).map(([k,v])=>[k,Math.round(v*100)/100]));
  const stop=reason=>({action_id:'STOP',reason,source:'local',execution_authorized:false,model_calls:0,decision_timing:timings()});
  const scoped=args.use_session||Boolean(args.model_session);
  if(scoped&&(!args.use_model||args.exact_label))return stop('model_session_requires_model_only');
  if(args.model_session){
    if(!args.model_session.apps.includes(args.expected_app))return stop('model_session_app_not_approved');
    try{validateDecisionLease(ctx,target.id);}catch(error){return stop(error.message);}
  }
  const read=()=>measured('observation_ms',()=>observe(ctx,{device:args.device,event_stream:false,max_elements:400,query:{labels:args.labels}}));
  const catalog=s=>{
    if(!live(s,ctx,target,args.expected_app))return null;
    const actions=[];
    for(const [i,label]of args.labels.entries()){
      const found=s.elements.filter(e=>typeof e.label==='string'&&normal(e.label)===normal(label)&&e.enabled!==false&&e.visible!==false&&['Button','Other','Link'].includes(e.role??e.type));
      if(found.length!==1||!found[0].object_id)return null;
      // Bind the raw native label and object identity; return the reviewed
      // normalized selector that tap_text already understands. Two normalized
      // matches remain ambiguous and never enter the model catalog.
      actions.push({id:'a'+i,label:found[0].label,reviewed_label:label,kind:'tap_text',object_id:found[0].object_id});
    }
    return {snapshot:s,expectedApp:args.expected_app,goal:args.goal,actions,exactLabel:actions.find(a=>args.exact_label&&normal(a.reviewed_label)===normal(args.exact_label))?.label??args.exact_label};
  };
  let input=catalog(await read());if(!input)return stop('candidate_state_not_confirmed');
  const options={expectedDevice:target.id,maxAgeMs:3500,currentRevision:()=>ctx.coordinator.revision(target.id),signal:signal()};
  let answer=await measured('decision_ms',()=>selectAction(input,options)),modelCalls=0,grant;
  if(answer.action_id==='REOBSERVE'&&args.use_model){
    if(args.model_session || !args.use_session){
      const scope=args.model_session;
      const question=scope
        ? `Allow up to ${scope.max_calls} potentially billable Jev proposals via Vercel AI Gateway in this device lease for ${scope.ttl_seconds} seconds?\nApps: ${scope.apps.join(' | ')}\nPurpose: ${scope.purpose}\nOnly each goal, app and selected candidate button labels are sent. No screenshots, full screen trees, field values or credentials. Proposals never authorize phone input. Lease change, expiry, exhausted budget or cancellation stop reuse. No automatic API retries.`
        : `Allow one potentially billable Jev decision via Vercel AI Gateway?\nOnly this goal, app and candidate button labels will be sent. No screenshot or other screen text.\nApp: ${args.expected_app}\nGoal: ${args.goal}\nLabels: ${args.labels.join(' | ')}`;
      const consent=await measured('approval_ms',()=>phase('decision_approval',()=>approve(question,120)));
      if(!consent.completed){revokeDecisionSession(ctx);return stop('external_decision_not_approved');}
      if(signal()?.aborted){revokeDecisionSession(ctx);return stop('decision_cancelled');}
      // Approval never refreshes an old screen. Re-read before installing or
      // consuming any authority for the one outbound proposal.
      input=catalog(await read());if(!input)return stop('state_changed_after_approval');
      if(scope){try{grant=installDecisionSession(ctx,target.id,scope,now());}catch(error){return stop(error.message);}}
    } else {
      try{grant=requireDecisionSession(ctx,target.id,args.expected_app,now());}catch(error){return stop(error.message);}
    }
    const authorize=async()=>{
      if(scoped)grant=consumeDecisionSession(ctx,target.id,args.expected_app,now());
      return {allowed:true,provider:'jev',snapshot_id:input.snapshot.observation.id,expires_at:Math.min(now()+3500,grant?.expires_at??Infinity)};
    };
    const requestSignal=signal(),revoke=()=>revokeDecisionSession(ctx);
    requestSignal?.addEventListener('abort',revoke,{once:true});
    try{answer=await measured('decision_ms',()=>phase('decision_model',()=>propose(input,{...options,authorize})));}
    finally{requestSignal?.removeEventListener('abort',revoke);if(requestSignal?.aborted){revoke();grant=undefined;}}
    modelCalls=answer.model_calls??1;
  }
  const selected=input.actions.find(a=>a.id===answer.action_id);
  return {...answer,execution_authorized:false,model_calls:modelCalls,decision_timing:timings(),...(grant?{model_session:decisionSessionReceipt(grant)}:{}),observation_id:input.snapshot.observation.id,
    ...(selected?{label:selected.reviewed_label}:{})};
}
