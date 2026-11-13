import {PinnedPhoneSession,validatePhone,requireThat,errorCode} from './device-session.mjs';

export function validatePlan(plan,{exercise=true}={}) {
  requireThat(plan?.version===1&&Array.isArray(plan.lanes)&&plan.lanes.length===2,'two_lane_plan_required');
  const seen=new Set();
  for(const lane of plan.lanes) {
    validatePhone(lane.device);
    requireThat(!seen.has(lane.device.id),'duplicate_phone'); seen.add(lane.device.id);
    requireThat(lane.observedAppName===undefined || typeof lane.observedAppName==='string'&&lane.observedAppName.length>0&&lane.observedAppName.length<=120,'invalid_app_name');
    if(exercise) validateCalculation(lane.calculation);
  }
  if(exercise) {
    requireThat(plan.isolation?.stopLane===0&&plan.isolation?.continueLane===1,'isolation_must_stop_only_lane_zero');
    requireThat(['cancel','release'].includes(plan.isolation.mode),'invalid_isolation_mode');
    validateCalculation(plan.isolation.calculation);
  }
  return plan;
}

function validateCalculation(calculation) {
  requireThat(calculation && Array.isArray(calculation.labels)&&calculation.labels.length>0&&calculation.labels.length<=16&&
    calculation.labels.every(x=>typeof x==='string'&&x.length>0&&x.length<=120),'observed_button_labels_required');
  const result=calculation.result;
  requireThat(result&&['label','value','text'].includes(result.field)&&typeof result.text==='string'&&result.text.length>0&&result.text.length<=80&&
    typeof result.role==='string'&&result.role.length>0&&!/button|key/i.test(result.role)&&
    typeof result.objectId==='string'&&result.objectId.length>0&&result.objectId.length<=200,'current_display_result_selector_required');
}

function summarizedObservation(snapshot) {
  return {observation_id:snapshot.observation?.id,observed_device:snapshot.observation?.device,
    foreground_bundle:snapshot.foreground?.bundle_id??null,foreground_name:snapshot.foreground?.name??null,
    element_count:snapshot.elements.length,source:snapshot.source,
    structure_completed_at:snapshot.observation?.structure_completed_at??null};
}

async function calculation(session,lane,calculation,{launch=false}={}) {
  const started=new Date().toISOString();
  if(launch) await session.launchCalculator();
  const before=await session.observe();
  const app=session.calculatorGuard(before);
  requireThat(before.truncated!==true,'truncated_button_observation');
  // Root supplies labels from its real device inspection. Refuse all unobserved
  // targets before the first tap; the daemon then resolves each again at dispatch.
  for(const label of new Set(calculation.labels)) {
    const hits=before.elements.filter(e=>(e.label??e.text)===label&&/^(button|key)$/i.test(e.role??e.type??'')&&e.enabled!==false);
    requireThat(hits.length===1,'calculator_button_not_uniquely_observed');
  }
  for(const label of calculation.labels) await session.tapCalculatorLabel(label,app);
  const after=await session.observe();
  requireThat(session.calculatorResult(after,calculation.result),'calculator_result_not_verified');
  return {status:'PASS',started_at:started,finished_at:new Date().toISOString(),actions:calculation.labels.length,
    result_verified:true,...summarizedObservation(after)};
}

function requestOverlap(sessions) {
  let largest=0;
  for(const a of sessions[0].report.calls.filter(c=>c.input&&c.ok))
    for(const b of sessions[1].report.calls.filter(c=>c.input&&c.ok))
      largest=Math.max(largest,Math.min(Date.parse(a.finished_at),Date.parse(b.finished_at))-Math.max(Date.parse(a.started_at),Date.parse(b.started_at)));
  return {client_input_request_overlap_ms:largest,scope:'client_requests_only',native_dispatch_overlap:'NOT_MEASURED'};
}

/** clients MUST be separately connected to the same existing daemon/state.
 * mode inspect: identity + leases + AX reads. mode launch: additionally launches Calculator.
 * mode exercise: only reviewed Calculator labels and result checks, then A-only release/cancel.
 * onObservation is an explicit in-memory inspection callback, off by default; the report
 * never contains field values, button labels, screenshots, or full accessibility trees.
 */
export async function runDualPhone(clients,original,{mode='inspect',sessionOptions={},onObservation}={}) {
  requireThat(['inspect','launch','exercise'].includes(mode),'invalid_mode');
  const plan=validatePlan(structuredClone(original),{exercise:mode==='exercise'});
  requireThat(Array.isArray(clients)&&clients.length===2&&clients[0]!==clients[1],'distinct_persistent_clients_required');
  const sessions=clients.map((c,i)=>new PinnedPhoneSession(c,plan.lanes[i].device,sessionOptions));
  const report={version:1,mode,status:'BLOCKED',started_at:new Date().toISOString(),preflights:[],lanes:[],isolation:null,
    retries:0,private_ui_logged:false,mac_foreground:'NOT_MEASURED',native_dispatch_overlap:'NOT_MEASURED'};
  try {
    // Discovery describes all currently free phones and temporarily records those
    // targets in the daemon's accepted operation. Finish each discovery/acquisition
    // before the next client's discovery; real phone phases below remain parallel.
    for(const [i,session] of sessions.entries()) {
      try {
        await session.initialize();
        report.preflights.push({device:session.phone.id,status:'PASS'});
      } catch(error) {
        report.preflights.push({device:session.phone.id,status:'BLOCKED',error:errorCode(error)});
        for(const later of sessions.slice(i+1))report.preflights.push({device:later.phone.id,status:'NOT_ATTEMPTED',reason:'earlier_preflight_failed'});
        requireThat(false,'one_or_more_device_preflights_failed');
      }
    }
    const phases=await Promise.allSettled(sessions.map(async(session,i)=>{
      if(mode==='exercise') return calculation(session,plan.lanes[i],plan.lanes[i].calculation,{launch:true});
      if(mode==='launch') await session.launchCalculator();
      const snapshot=await session.observe();
      if(mode==='launch') session.calculatorGuard(snapshot);
      if(onObservation) await onObservation(i,snapshot);
      return {status:'PASS',...summarizedObservation(snapshot)};
    }));
    report.lanes=phases.map((r,i)=>({device:sessions[i].phone.id,...(r.status==='fulfilled'?r.value:{status:'BLOCKED',error:errorCode(r.reason)})}));
    requireThat(phases.every(x=>x.status==='fulfilled'),'one_or_more_device_phases_failed');
    if(mode==='exercise') {
      const stoppedAt=new Date().toISOString();
      await sessions[0].stop(plan.isolation.mode);
      const stoppedConfirmedAt=new Date().toISOString();
      const continued=await calculation(sessions[1],plan.lanes[1],plan.isolation.calculation);
      report.isolation={status:'PASS',mode:plan.isolation.mode,stopped_device:sessions[0].phone.id,
        continuing_device:sessions[1].phone.id,stop_requested_at:stoppedAt,stop_confirmed_at:stoppedConfirmedAt,
        continuing_result_verified_at:continued.finished_at,continuing_result_verified:true};
      report.status='FUNCTIONAL_PASS';
    } else report.status='STAGE_PASS';
  } catch(error) { report.error=errorCode(error); }
  finally {
    const cleanup=await Promise.allSettled(sessions.map(s=>s.stop(s.fenced?'cancel':'release')));
    if(cleanup.some(x=>x.status==='rejected')) { report.status='UNVERIFIED';report.cleanup_error='one_or_more_session_cleanup_outcomes_unknown'; }
    report.sessions=sessions.map(s=>s.report);
    report.concurrency=requestOverlap(sessions);
    report.ended_at=new Date().toISOString();
  }
  return report;
}
