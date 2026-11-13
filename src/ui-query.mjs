import {snapshotUI} from './ax-snapshot.mjs';
import {flagOn} from './element-flags.mjs';
import {uiQuerySchema,uiWaitSchema} from './ui-query-schema.mjs';
import {deadline,checkWork,pause,remainingMs,signal} from './work.mjs';
export {uiQueryDefinitions} from './ui-query-schema.mjs';

const returnedLimit=80;
const normalize=value=>value.normalize('NFKC').toLocaleLowerCase().trim();
const strings=element=>[element.label,element.text,element.value,element.identifier,element.placeholder]
  .filter(value=>typeof value==='string');
const boxOf=element=>element.frame??element;
const validBox=box=>box&&['x','y','width','height'].every(key=>Number.isFinite(box[key]))
  &&box.width>0&&box.height>0;
const visibleIn=(element,snapshot)=>{
  if(!flagOn(element.visible)||(element.role??element.type)==='Application')return false;
  const box=boxOf(element);
  return validBox(box)&&box.x<snapshot.width&&box.y<snapshot.height
    &&box.x+box.width>0&&box.y+box.height>0;
};

function select(elements,query){
  const labels=query.labels&&new Set(query.labels.map(normalize));
  return elements.filter(element=>
    (!query.roles||query.roles.includes(element.role??element.type))
    &&(!query.object_ids||query.object_ids.includes(element.object_id))
    &&(!labels||strings(element).some(value=>labels.has(normalize(value)))));
}

function conditionMatches(elements,condition){
  switch(condition.state){
    case 'present': return elements.length>0;
    case 'absent': return elements.length===0;
    case 'unique': return elements.length===1;
    case 'field_equals':
      // Never normalize field contents: this is the exact value requested.
      return elements.length===1&&typeof elements[0][condition.field]==='string'
        &&elements[0][condition.field]===condition.equals;
    case 'bounds_match': {
      if(elements.length!==1)return false;
      const actual=boxOf(elements[0]);
      return validBox(actual)&&['x','y','width','height'].every(key=>
        Math.abs(actual[key]-condition.expected_bounds[key])<=condition.tolerance);
    }
  }
  return false;
}

function stop(receipt,reason){
  return {...receipt,matched:false,verification:null,verification_scope:null,isError:true,stop_reason:reason};
}

async function readCondition(ctx,args,binding){
  checkWork();
  // Collect the full source exactly once. Projection is performed only after
  // geometry, source completeness, foreground, epoch and prompt checks.
  const snapshot=await snapshotUI(ctx,{
    include_offscreen:false,max_elements:Number.MAX_SAFE_INTEGER,
    timeout_ms:remainingMs(args.timeout_ms),event_stream:false,
  },{populateInputCache:false,preserveUnknownVisibility:true});
  checkWork();
  const current=await ctx.target();
  checkWork();
  const rootVerified=snapshot.truncated===false&&snapshot.root_verified===true
    &&snapshot.geometry_source==='native_application_frame';
  const graphComplete=snapshot.native_source_complete===true&&rootVerified;
  const uncertain=snapshot.unknown_visibility_elements;
  const uncertainMatches=Array.isArray(uncertain)?select(uncertain,args.condition.query).length:null;
  const complete=graphComplete&&snapshot.visibility_complete===true&&Array.isArray(uncertain)&&uncertain.length===0;
  const queryComplete=graphComplete&&uncertainMatches===0;
  const selected=select(snapshot.elements.filter(element=>visibleIn(element,snapshot)),args.condition.query);
  const receipt={
    matched:false,verification:null,source:snapshot.source,
    device:snapshot.observation.device,revision:snapshot.observation.revision,
    expected_app:args.expected_app,foreground:snapshot.foreground,
    observation:snapshot.observation,prompt:snapshot.prompt,prompt_scope:snapshot.prompt_scope,image_captured:false,
    scope:{native_tree_read:'complete',returned:'query_matches',visible_screen:true,
      complete,query_complete:queryComplete,source_total:snapshot.source_total??snapshot.total,
      unknown_visibility_total:snapshot.unknown_visibility_total??null,unknown_visibility_matches:uncertainMatches},
    condition:args.condition,match_count:selected.length,
    elements:selected.slice(0,returnedLimit),truncated:selected.length>returnedLimit,
    native_ax:snapshot.native_ax,native_completeness:snapshot.native_completeness,
    event_source:snapshot.event_source,source_age_ms:snapshot.source_age_ms,
  };
  if(current.id!==binding.device||snapshot.observation.device!==binding.device)return stop(receipt,'device_changed');
  if(snapshot.observation.revision!==binding.revision||ctx.coordinator.revision(binding.device)!==binding.revision)
    return stop(receipt,'stale_observation');
  if(snapshot.observation.input_freshness!=='live_read'||snapshot.source_age_ms!==0
    ||!['accessibility_live','accessibility_live_fallback'].includes(snapshot.event_source)
    ||!snapshot.observation.structure_started_at)return stop(receipt,'stale_observation');
  if(snapshot.foreground?.bundle_id!==args.expected_app)return stop(receipt,'wrong_app');
  if(snapshot.prompt)return stop(receipt,'prompt');
  if(!rootVerified)return stop(receipt,'incomplete_source');
  // An observed node proves presence even when unseen sibling coverage is unknown.
  // Exact object identity also avoids claiming uniqueness from a partial label search.
  const exactObject=args.condition.query.object_ids?.length===1;
  const needsCoverage=args.condition.state==='absent'
    ||(args.condition.state!=='present'&&!exactObject);
  if(args.condition.state!=='present'&&(uncertainMatches===null||uncertainMatches>0))return stop(receipt,'incomplete_source');
  if(needsCoverage&&!queryComplete)return stop(receipt,'incomplete_source');
  const matched=conditionMatches(selected,args.condition);
  const verificationScope=args.condition.state==='present'?'observed_visible_element'
    :exactObject&&args.condition.state!=='absent'?'exact_object'
      :complete?'complete_visible_source':'complete_query_scope';
  return {...receipt,matched,verification:matched?'fresh_native_accessibility':null,
    verification_scope:matched?verificationScope:null,
    stop_reason:matched?'matched':'condition_not_met'};
}

async function executeQuery(ctx,args,wait){
  const started=performance.now();
  let attempts=0,last,binding;
  const finish=receipt=>({...receipt,attempts,elapsed_ms:Math.round((performance.now()-started)*100)/100});
  try{
    return await deadline(args.timeout_ms,async()=>{
      checkWork();
      const target=await ctx.target();
      checkWork();
      binding={device:target.id,revision:ctx.coordinator.revision(target.id)};
      while(true){
        checkWork();
        attempts++;
        last=await readCondition(ctx,args,binding);
        checkWork();
        if(last.matched||last.isError||!wait)return finish(last);
        await pause(Math.min(args.poll_ms,remainingMs(args.poll_ms)));
      }
    });
  }catch(error){
    const reason=error?.name==='TimeoutError'?'timeout'
      :error?.name==='AbortError'||signal()?.aborted?'cancelled':'source_unavailable';
    return finish(stop(last??{
      source:'accessibility',device:binding?.device??null,revision:binding?.revision??null,
      expected_app:args.expected_app,observation:null,foreground:null,prompt:null,
      image_captured:false,elements:[],match_count:0,truncated:false,
      scope:{native_tree_read:'complete',returned:'query_matches',visible_screen:true,complete:false},
      condition:args.condition,
    },reason));
  }
}

export async function queryUI(ctx,args={}){
  // Parse before resolving a device or performing any native read.
  return executeQuery(ctx,uiQuerySchema.parse(args),false);
}
export async function waitForUI(ctx,args={}){
  return executeQuery(ctx,uiWaitSchema.parse(args),true);
}
