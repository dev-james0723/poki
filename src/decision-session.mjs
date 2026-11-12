// In-memory, proposal-only consent. Never authorizes phone input or survives
// a lease replacement/service restart. Only chooseAction installs it after the
// existing real human approval and a new live observation.
const grants=new WeakMap();
export function revokeDecisionSession(ctx){grants.delete(ctx);}
function leaseFor(ctx,device){
 const lease=ctx.coordinator.owned?.(ctx);
 if(!lease||lease.device!==device||lease.state!=='active')throw Error('model_session_lease_unavailable');
 try{ctx.coordinator.require(ctx,lease.lease_id);}catch{throw Error('model_session_lease_unavailable');}
 return lease;
}
export function validateDecisionLease(ctx,device){return leaseFor(ctx,device);}
export function installDecisionSession(ctx,device,scope,now=Date.now()){
 const lease=leaseFor(ctx,device);
 const grant={device,lease_id:lease.lease_id,apps:new Set(scope.apps),remaining:scope.max_calls,expires_at:now+scope.ttl_seconds*1000};
 grants.set(ctx,grant);return grant;
}
export function requireDecisionSession(ctx,device,app,now=Date.now()){
 const grant=grants.get(ctx);if(!grant)throw Error('model_session_missing');
 const lease=leaseFor(ctx,device);
 if(grant.lease_id!==lease.lease_id||grant.device!==device)throw Error('model_session_lease_changed');
 if(now>=grant.expires_at)throw Error('model_session_expired');
 if(!grant.apps.has(app))throw Error('model_session_app_not_approved');
 if(grant.remaining<1)throw Error('model_session_exhausted');
 return grant;
}
export function consumeDecisionSession(ctx,device,app,now=Date.now()){
 const grant=requireDecisionSession(ctx,device,app,now);grant.remaining--;return grant;
}
export const decisionSessionReceipt=grant=>({remaining_calls:grant.remaining,expires_at:grant.expires_at,scope:'proposal_only',lease_bound:true});
