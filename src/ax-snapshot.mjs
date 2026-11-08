import {randomUUID} from 'node:crypto';
import {deadline,phase,checkWork} from './work.mjs';
import {promptWarning} from './interaction.mjs';

// Only an explicit full-screen native Application frame establishes a viewport.
// Never estimate it from the furthest child: lists can include offscreen rows.
export function viewportFromAX(tree) {
  const roots=(tree.elements??[]).filter(e=>(e.type??e.role)==='Application');
  if(roots.length!==1)return null;
  const f=roots[0].frame;
  if(!f||f.x!==0||f.y!==0||![f.width,f.height].every(Number.isFinite)||f.width<2||f.height<2||f.width>16384||f.height>16384)return null;
  return {width:f.width,height:f.height,orientation:tree.orientation??null};
}
export function axSignature(elements) {
  return JSON.stringify(elements.map(e=>{const f=e.frame??e;return [e.type??e.role,e.label,e.text,e.value,e.focused,Boolean(e.selected),Boolean(e.enabled??true),f.x,f.y,f.width,f.height];}));
}
const onscreen=(e,v)=>{const f=e.frame??e;return Number.isFinite(f.x)&&Number.isFinite(f.y)&&f.x<v.width&&f.y<v.height&&f.x+f.width>0&&f.y+f.height>0;};

export async function snapshotUI(ctx,args={}) {
  return deadline(args.timeout_ms??6000,async()=>{
    const started=new Date().toISOString();
    const target=await ctx.target();
    if(args.event_stream)ctx.ownNativeResources(target);
    const tree=await phase('accessibility',()=>ctx.bridge({op:'ax',include_offscreen:args.include_offscreen??false,timeout_ms:args.timeout_ms??6000,event_stream:args.event_stream??false}));
    checkWork();
    if(!Array.isArray(tree.elements)||!tree.elements.length)throw new Error('No native accessibility elements; no screenshot/OCR fallback was performed.');
    const viewport=viewportFromAX(tree);
    const elements=args.include_offscreen||!viewport?tree.elements:tree.elements.filter(e=>onscreen(e,viewport));
    const fromEvent=tree.observation_source==='accessibility_event';
    const sourceAge=Math.max(0,tree.source_age_ms??0);
    const finished=new Date(Date.now()-sourceAge).toISOString();
    const revision=ctx.coordinator.revision(target.id);
    if(viewport&&!fromEvent){ctx.size={device:target.id,...viewport};ctx.axSize={...ctx.size,revision,at:performance.now()-sourceAge};}
    if(!args.include_offscreen&&!fromEvent)ctx.seen={device:target.id,foreground:tree.foreground,elements,signature:axSignature(elements),at:performance.now()-sourceAge};
    // Structure-only observations intentionally do not mint screenshot-bound tap refs.
    return {observation:{id:randomUUID(),device:target.id,revision,source:'accessibility',input_freshness:fromEvent?'requires_live_read':'live_read',request_started_at:started,structure_started_at:fromEvent?null:started,structure_completed_at:finished,capture_started_at:null,capture_completed_at:null,atomic:false},source:'accessibility',image_captured:false,native_runtime:tree.native_runtime??null,event_source:tree.observation_source??'accessibility_live',source_age_ms:sourceAge,foreground:tree.foreground??null,width:viewport?.width??null,height:viewport?.height??null,units:'points',geometry_source:viewport?'native_application_frame':null,elements:elements.slice(0,args.max_elements??160).map(({ref,...e})=>e),total:elements.length,truncated:elements.length>(args.max_elements??160),prompt:promptWarning(elements)??null};
  });
}
