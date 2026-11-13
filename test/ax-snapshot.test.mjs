import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,value} from './fixture.mjs';

const app={role:'Application',label:'Fixture',frame:{x:0,y:0,width:430,height:932}};
const button={role:'Button',label:'Open',object_id:'button1',frame:{x:10,y:100,width:100,height:40}};
const screenshots=events=>events.filter(e=>e.op==='screenshot'||e.args?.includes('screenshot')||e.tool==='ocr');

test('snapshot_ui reads native AX without screenshot or OCR, even when capture is unavailable',async t=>{
 const f=await fixture(t);await f.set({screenshotUnavailable:true,elements:[app,button]});
 const r=await f.call('snapshot_ui',{device:'fixture-phone'});assert.ok(!r.isError,JSON.stringify(r));const d=value(r);
 assert.equal(d.source,'accessibility');assert.equal(d.image_captured,false);assert.equal(d.width,430);assert.equal(d.height,932);assert.equal(d.total,2);assert.equal(d.observation.capture_started_at,null);assert.equal(screenshots(await f.events()).length,0);
});
test('snapshot_ui never invents missing viewport dimensions and does not export image-bound refs',async t=>{
 const f=await fixture(t);await f.set({elements:[button]});const r=await f.call('snapshot_ui',{});assert.ok(!r.isError,JSON.stringify(r));const d=value(r);
 assert.equal(d.width,null);assert.equal(d.height,null);assert.ok(d.elements.every(e=>e.ref===undefined));assert.equal(screenshots(await f.events()).length,0);
});
test('snapshot_ui always returns a fresh identity and structure',async t=>{
 const f=await fixture(t);await f.set({elements:[app,button]});const a=await f.call('snapshot_ui',{});assert.ok(!a.isError,JSON.stringify(a));
 await f.set({elements:[app,{...button,label:'Changed'}]});const b=await f.call('snapshot_ui',{});assert.ok(!b.isError,JSON.stringify(b));
 assert.notEqual(value(a).observation.id,value(b).observation.id);assert.ok(value(b).elements.some(e=>e.label==='Changed'));assert.equal(screenshots(await f.events()).length,0);
});
test('snapshot_ui marks truncation and filters offscreen against an actual root viewport',async t=>{
 const f=await fixture(t);await f.set({elements:[app,button,{...button,label:'Hidden',frame:{x:5,y:2000,width:20,height:20}}]});
 const r=await f.call('snapshot_ui',{max_elements:1});assert.ok(!r.isError,JSON.stringify(r));assert.equal(value(r).total,2);assert.equal(value(r).truncated,true);
});
test('snapshot_ui fails closed without falling back to OCR when AX is unavailable',async t=>{
 const f=await fixture(t);await f.set({axUnavailable:true});const r=await f.call('snapshot_ui',{});assert.equal(r.isError,true);assert.equal(screenshots(await f.events()).length,0);assert.match(r.content[0].text,/accessibility|observation|native|command/i);
});
test('snapshot_ui has a bounded deadline and does not dispatch input',async t=>{
 const f=await fixture(t);await f.set({block:'ax_tree'});const start=performance.now();const r=await f.call('snapshot_ui',{timeout_ms:300});
 assert.equal(r.isError,true);assert.match(r.content[0].text,/deadline|timed out|abort/i);assert.ok(performance.now()-start<2500);assert.equal((await f.events()).filter(e=>e.op==='tap'||e.op==='type_text').length,0);
});
test('snapshot_ui is discoverable and explicitly read-only',async t=>{
 const f=await fixture(t);const tools=(await f.a.listTools()).tools;const found=tools.find(t=>t.name==='snapshot_ui');assert.ok(found);assert.equal(found.annotations.readOnlyHint,true);
});

test('status counts both image observation and the new AX-only observation',async t=>{const f=await fixture(t);const d=value(await f.call('poki_mcp_status',{}));assert.equal(d.observation_tools,5);assert.equal(d.phone_capability_tools,12);assert.equal(d.total_tools,81);});
