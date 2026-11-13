/** Result callbacks prove Shortcut completion only. A destination claim additionally
 * needs a complete current native observation, with prompt checks before projection. */
export function freshActionObservation(snapshot,ctx,target,expectedApp,now=Date.now()) {
  const observation=snapshot?.observation;
  const start=Date.parse(observation?.structure_started_at),end=Date.parse(observation?.structure_completed_at);
  return snapshot?.source==='accessibility'&&snapshot.root_verified===true&&snapshot.source_complete===true&&
    snapshot.geometry_source==='native_application_frame'&&
    [snapshot.width,snapshot.height].every(value=>Number.isFinite(value)&&value>=2&&value<=16384)&&
    snapshot.prompt_scope==='full_native_tree'&&snapshot.prompt===null&&snapshot.truncated===false&&
    snapshot.scope?.returned!=='query_matches'&&
    ['accessibility_live','accessibility_live_fallback'].includes(snapshot.event_source)&&snapshot.source_age_ms===0&&
    observation?.input_freshness==='live_read'&&observation.device===target.id&&
    observation.revision===ctx.coordinator.revision(target.id)&&typeof observation.id==='string'&&observation.id.length>0&&
    Number.isFinite(start)&&Number.isFinite(end)&&start<=end&&end<=now&&now-end<=3500&&
    [snapshot.foreground?.name,snapshot.foreground?.bundle_id].includes(expectedApp)&&
    Array.isArray(snapshot.elements)&&snapshot.elements.length>0&&snapshot.total===snapshot.elements.length;
}
export function actionElementOnscreen(element,snapshot) {
  const frame=element.frame??element;
  return element.visible!==false&&[frame.x,frame.y,frame.width,frame.height].every(Number.isFinite)&&
    frame.width>0&&frame.height>0&&frame.x<snapshot.width&&frame.y<snapshot.height&&
    frame.x+frame.width>0&&frame.y+frame.height>0;
}
