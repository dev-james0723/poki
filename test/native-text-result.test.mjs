import test from 'node:test';
import assert from 'node:assert/strict';
import {runBatch} from '../src/batch.mjs';
import {work} from '../src/work.mjs';
const receipt=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
const command=()=>({tool:'type_text',arguments:{device:'phone',expected_app:'Notes',text:'測試🙂',submit:false,native_text_result:true}});
const proof=()=>({sent:true,text_verified:true,submit_sent:false,characters:3,verification_source:'accessibility',field:{object_id:'field',role:'TextField',name:'Note'},native_runtime:{pid:1,device:'phone',build_id:'fixture',features:['native_paste_timings']},clipboard_restored:false,clipboard_restore_status:'unavailable'});
function fixture(data=proof(),isError=false){
 let reads=0,calls=0;
 const ctx={target:async()=>({id:'phone',kind:'physical'}),dispatch:async()=>{calls++;return {...receipt(data),...(isError?{isError:true}:{})};},readback:async()=>{reads++;return{screen:{source:'accessibility',text:['fallback']}};}};
 return {ctx,reads:()=>reads,calls:()=>calls};
}
const run=(f,commands=[command()],extra={})=>work.run({signal:new AbortController().signal,timings:[]},()=>runBatch(f.ctx,{commands,...extra}));
test('a final non-submitting input can return its exact native AX text proof without another screen read',async()=>{
 const f=fixture(),r=await run(f),s=JSON.parse(r.content.at(-1).text);
 assert.ok(!r.isError);assert.equal(f.reads(),0);assert.equal(f.calls(),1);
 assert.equal(s.native_text_result.text_verified,true);assert.equal(s.native_text_result.characters,3);
 assert.equal(s.native_text_result.scope,'text_input');assert.equal(s.screen,undefined);
 assert.equal(s.native_text_result.clipboard_restored,false);
});
for(const [name,edit] of [
 ['unverified text',p=>p.text_verified=false],['wrong length',p=>p.characters=2],
 ['submitted input',p=>p.submit_sent=true],['other device',p=>p.native_runtime.device='other'],
 ['old helper',p=>p.native_runtime.features=[]],['missing field identity',p=>delete p.field.object_id],
 ['secure field',p=>p.field.role='SecureTextField'],['non-native proof',p=>p.verification_source='ocr'],
 ['unknown delivery',p=>p.outcome='unknown'],['stopped input',p=>p.stopped=true],
 ['malformed helper metadata',p=>p.native_runtime.features={}],['unversioned helper',p=>p.native_runtime.build_id='unversioned'],
])test(`a ${name} retains normal screen readback`,async()=>{
 const p=proof();edit(p);const f=fixture(p),r=await run(f);assert.equal(f.reads(),1);assert.equal(JSON.parse(r.content.at(-1).text).native_text_result,undefined);
});
test('an error receipt cannot become a successful text-only result',async()=>{
 const f=fixture(proof(),true),r=await run(f);assert.equal(r.isError,true);assert.equal(f.reads(),1);assert.equal(JSON.parse(r.content.at(-1).text).native_text_result,undefined);
});
for(const [name,commands] of [
 ['dependent step',[command(),{tool:'wait',arguments:{seconds:0}}]],
 ['submit',[{...command(),arguments:{...command().arguments,submit:true}}]],
 ['missing foreground',[{...command(),arguments:{...command().arguments,expected_app:undefined}}]],
 ['coordinate tap',[{tool:'tap',arguments:{x:1,y:1,native_text_result:true}}]],
 ['requested screen observation',[{...command(),arguments:{...command().arguments,return_observation:true}}]],
])test(`text-only mode refuses a ${name} before any input, including stop_on_error=false`,async()=>{
 const f=fixture(),r=await run(f,commands,{stop_on_error:false});assert.equal(r.isError,true);assert.equal(f.calls(),0);
});
