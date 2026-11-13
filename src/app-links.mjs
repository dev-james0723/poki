import {openVerifiedLinkSchema} from './app-actions-schema.mjs';
import {snapshotUI} from './ax-snapshot.mjs';
import {checkWork,pause,remaining} from './work.mjs';
import {freshActionObservation,actionElementOnscreen} from './app-action-observation.mjs';

const routes=Object.freeze([
  {id:'poki.chat',url:'poki://chat',title:'Poki chat',marker:'poki.route.chat'},
  {id:'poki.setup',url:'poki://setup',title:'Poki setup',marker:'poki.route.setup'},
  {id:'poki.activity',url:'poki://log',title:'Poki activity log',marker:'poki.route.activity'},
]);
export function listAppLinks() {
  return {registry_version:1,scope:'owned_poki_routes',links:routes.map(route=>({
    id:route.id,title:route.title,url:route.url,parameters:[],
    expected_app:'Poki',default_bundle_id:'nz.zheha.poki',
    route_evidence:{source:'accessibility_identifier',identifier:route.marker},
    physical_verification:'not_yet_verified',
    verification_note:'Use an individual open_verified_link receipt for current device proof; listing does not operate a phone.',
  }))};
}
function routeVerified(snapshot,ctx,target,app,marker) {
  return freshActionObservation(snapshot,ctx,target,app)&&
    snapshot.elements.some(element=>element.identifier===marker&&actionElementOnscreen(element,snapshot));
}
export async function openVerifiedLink(ctx,original,{observe=snapshotUI}={}) {
  const args=openVerifiedLinkSchema.parse(original),route=routes.find(value=>value.id===args.link_id);
  const target=await ctx.target();
  checkWork();
  for(const owner of [ctx,...(ctx.peers?.()??[])])if(owner.backgroundDevices?.get(target.id)?.has('recording'))
    return {isError:true,link_id:route.id,device:target.id,destination_verified:false,outcome:'not_sent',reason:'active_recording_requires_owner_coordination'};
  let response;
  try {response=await ctx.dispatch('open_url',{device:target.id,url:route.url});}
  catch {return {isError:true,link_id:route.id,device:target.id,destination_verified:false,outcome:'unknown',retry:'never_automatically_replay'};}
  if(response?.isError)return {isError:true,link_id:route.id,device:target.id,destination_verified:false,outcome:'unconfirmed',retry:'never_automatically_replay'};
  const started=performance.now(),end=started+Math.min(args.timeout_ms,remaining());
  let attempts=0;
  do {
    try {
      checkWork();attempts++;
      const snapshot=await observe(ctx,{device:target.id,event_stream:false,max_elements:400});
      if(routeVerified(snapshot,ctx,target,args.expected_app,route.marker))return {
        link_id:route.id,device:target.id,destination_verified:true,
        physical_verification:target.kind==='physical'?'verified':'not_applicable_simulator',
        observation_id:snapshot.observation.id,observed_at:snapshot.observation.structure_completed_at,
        source:'accessibility',route_identifier:route.marker,attempts,
        elapsed_ms:Math.round(performance.now()-started),
      };
      const left=end-performance.now();if(left<=0)break;
      await pause(Math.min(100,left));
    } catch {break;}
  } while(performance.now()<end);
  return {isError:true,link_id:route.id,device:target.id,destination_verified:false,
    physical_verification:'not_verified',reason:'fresh_destination_marker_not_observed',
    outcome:'navigation_unverified',retry:'never_automatically_replay',attempts};
}
