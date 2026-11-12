import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,value} from './fixture.mjs';

test('observe_fast is a discoverable read-only tool',async t=>{
 const f=await fixture(t);
 const t0=(await f.a.listTools()).tools.find(x=>x.name==='observe_fast');
 assert.ok(t0,'Missing observation tool');
 assert.equal(t0.annotations.readOnlyHint,true);
});

test('observe_fast uses a single AX read and does not require a screenshot',async t=>{
 const f=await fixture(t);
 await f.set({screenshotUnavailable:true,elements:[
   {role:'Application',label:'Trip.com',frame:{x:0,y:0,width:430,height:932}},
   {role:'Button',label:'機票',frame:{x:100,y:100,width:100,height:60}}
 ]});
 const r=await f.call('observe_fast',{device:'fixture-phone'});
 assert.ok(!r.isError,JSON.stringify(r));
 const d=value(r);
 assert.equal(d.source,'accessibility');
 assert.ok(d.text.some(x=>x.includes('機票')));
 const events=await f.events();
 assert.ok(!events.some(x=>x.op==='tap'||x.op==='type_text'||x.op==='screenshot'));
});

test('observe_fast falls back to OCR after AX failure without sending input',async t=>{
 const f=await fixture(t);
 await f.set({axUnavailable:true});
 const r=await f.call('observe_fast',{device:'fixture-phone'});
 assert.ok(!r.isError,JSON.stringify(r));
 const d=value(r);
 assert.equal(d.source,'ocr');
 assert.equal(d.screen_change_verified,undefined);
 const events=await f.events();
 assert.equal(events.filter(x=>x.op==='tap'||x.op==='type_text').length,0);
});
