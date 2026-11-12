import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {VisualAcceptanceRunner,readDeviceConfig} from './visual-run.mjs';
import {TEST_PHONES} from './test-phones.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const text=value=>({type:'text',text:JSON.stringify(value)});
async function fixture({tapResult,screenshotMetadata}={}) {
  const out=await mkdtemp(join(root,'.visual-test-')),calls=[],stops=[];
  const clients=[0,1].map(lane=>({async callTool({name,arguments:a}) {
    calls.push({lane,name,args:a});
    if(name==='take_screenshot')return {content:[text({...screenshotMetadata?.(lane,a),observation:{id:`obs-${calls.length}`,device:a.device,width:430,height:932,units:'points',capture_completed_at:new Date().toISOString()}}),
      {type:'image',mimeType:'image/jpeg',data:Buffer.from([255,216,255,217]).toString('base64')}]};
    if(name==='tap')return tapResult?tapResult(lane,a):{content:[text({sent:true,verified:false})]};
    throw new Error('unexpected visual tool');
  }}));
  const runner=new VisualAcceptanceRunner(clients,{devices:TEST_PHONES,outputDirectory:out,sessionFactory:(client,phone)=>({
    phone,closed:false,async initialize(){},async inventory(){assert.equal(this.closed,false);},
    async stop(mode){if(!this.closed)stops.push({device:phone.id,mode});this.closed=true;return {stopped:true,owned:false,device:phone.id};}
  })});
  await runner.initialize();
  return {runner,out,calls,stops,async cleanup(){await runner.close();await rm(out,{recursive:true});}};
}

test('visual point plans use own fresh captures, validate both before input, and cannot reuse a grounding',async()=>{
  const f=await fixture();try {
    const captured=await f.runner.handle({op:'capture',lanes:[0,1]});
    for(const result of captured.results)assert.equal((await stat(result.path)).mode&0o777,0o600);
    const plans=captured.results.map((r,lane)=>({lane,screenshotId:r.screenshot_id,points:[{x:100,y:400}]}));
    const invalid=structuredClone(plans);invalid[1].points[0].x=430;
    await assert.rejects(f.runner.handle({op:'calculator_taps',lanes:invalid}),/point_outside/);
    assert.equal(f.calls.filter(c=>c.name==='tap').length,0);
    const sent=await f.runner.handle({op:'calculator_taps',lanes:plans});
    assert.equal(sent.results.every(x=>x.sent===1),true);assert.equal(sent.automatic_visual_verification,false);
    for(const call of f.calls.filter(c=>c.name==='tap')) {assert.equal(call.args.verify,false);assert.ok(call.args.device);assert.equal('expected_app' in call.args,false);}
    await assert.rejects(f.runner.handle({op:'calculator_taps',lanes:plans}),/screenshot_missing/);
  } finally {await f.cleanup();}
});

test('uncertain A input stops only A, and B continues after A-only cancellation and a new screenshot',async()=>{
  const f=await fixture({tapResult:(lane)=>{if(lane===0)throw new Error('PRIVATE ERROR');return {content:[text({sent:true})]};}});
  try {
    const captured=await f.runner.handle({op:'capture',lanes:[0,1]});
    const sent=await f.runner.handle({op:'calculator_taps',lanes:captured.results.map((r,lane)=>({lane,screenshotId:r.screenshot_id,points:[{x:10,y:10},{x:20,y:20}]}))});
    assert.equal(sent.results[0].status,'STOPPED');assert.equal(sent.results[0].input_fenced,true);
    assert.equal(sent.results[1].sent,2);assert.equal(f.calls.filter(c=>c.name==='tap'&&c.lane===0).length,1);
    await f.runner.handle({op:'stop',lanes:[0],mode:'cancel'});
    const next=await f.runner.handle({op:'capture',lanes:[1]});
    const more=await f.runner.handle({op:'calculator_taps',lanes:[{lane:1,screenshotId:next.results[0].screenshot_id,points:[{x:30,y:30}]}]});
    assert.equal(more.results[0].sent,1);assert.equal(f.stops.length,1);
    assert.equal(JSON.stringify(f.runner.events).includes('PRIVATE ERROR'),false);
  } finally {await f.cleanup();}
});

test('stale, cross-phone, oversized plans and unsupported tools are refused before input',async()=>{
  const f=await fixture();try {
    const captures=await f.runner.handle({op:'capture',lanes:[0,1]});
    await assert.rejects(f.runner.handle({op:'calculator_taps',lanes:[{lane:0,screenshotId:captures.results[1].screenshot_id,points:[{x:1,y:1}]}]}));
    await assert.rejects(f.runner.handle({op:'calculator_taps',lanes:[{lane:0,screenshotId:captures.results[0].screenshot_id,points:Array(9).fill({x:1,y:1})}]}));
    f.runner.lanes[0].grounding.captured=Date.now()-91000;
    await assert.rejects(f.runner.handle({op:'calculator_taps',lanes:[{lane:0,screenshotId:captures.results[0].screenshot_id,points:[{x:1,y:1}]}]}));
    await assert.rejects(f.runner.handle({op:'launch_app',lanes:[0]}),/unknown_visual_command/);
    assert.equal(f.calls.some(c=>c.name==='tap'),false);
  } finally {await f.cleanup();}
});

test('nested sent flag alone never verifies raw tap delivery',async()=>{
  const f=await fixture({tapResult:()=>({content:[text({input:{sent:true}})]})});try {
    const capture=await f.runner.handle({op:'capture',lanes:[0]});
    const result=await f.runner.handle({op:'calculator_taps',lanes:[{lane:0,screenshotId:capture.results[0].screenshot_id,points:[{x:1,y:1}]}]});
    assert.equal(result.results[0].sent,0);assert.equal(result.results[0].input_fenced,true);
  } finally {await f.cleanup();}
});

test('a screenshot expiring while lease maintenance awaits is rejected before input',async()=>{
  const f=await fixture();try {
    const capture=await f.runner.handle({op:'capture',lanes:[0]});
    const grounding=f.runner.lanes[0].grounding;
    f.runner.sessions[0].inventory=async()=>{grounding.captured=Date.now()-91000;};
    const result=await f.runner.handle({op:'calculator_taps',lanes:[{lane:0,screenshotId:capture.results[0].screenshot_id,points:[{x:1,y:1}]}]});
    assert.equal(result.results[0].status,'STOPPED');
    assert.equal(result.results[0].error,'reviewed_screenshot_expired_before_input');
    assert.equal(f.calls.some(c=>c.name==='tap'),false);
  } finally {await f.cleanup();}
});

test('visual runner refuses missing or duplicate targets before creating any phone session',()=>{
  const clients=[{callTool(){}},{callTool(){}}];let made=0;
  for(const devices of [undefined,[],[TEST_PHONES[0],TEST_PHONES[0]]])
    assert.throws(()=>new VisualAcceptanceRunner(clients,{devices,outputDirectory:root,sessionFactory:()=>{made++;}}));
  assert.equal(made,0);
});

test('visual device file requires an absolute path and an explicit valid two-phone configuration',async()=>{
  const out=await mkdtemp(join(root,'.visual-config-test-'));
  try {
    await assert.rejects(readDeviceConfig('relative-devices.json'),/absolute_device_config/);
    const path=join(out,'devices.json');
    await writeFile(path,JSON.stringify({version:1,devices:TEST_PHONES}),{mode:0o600});
    assert.deepEqual(await readDeviceConfig(path),TEST_PHONES);
    await writeFile(path,JSON.stringify({version:1,devices:[TEST_PHONES[0],TEST_PHONES[0]]}));
    await assert.rejects(readDeviceConfig(path),/duplicate_phone/);
  } finally {await rm(out,{recursive:true});}
});

test('visual CLI without --devices fails before trying to load or connect a runtime',()=>{
  const result=spawnSync(process.execPath,[join(root,'visual-run.mjs'),'--repo','/nonexistent-runtime',
    '--state','/nonexistent-state','--out','/nonexistent-output'],{encoding:'utf8'});
  assert.equal(result.status,2);
  assert.equal(JSON.parse(result.stderr.trim()).error,'usage_repo_state_out_devices');
});

test('optional native runtime and execution receipts survive tap results, journals and captures without becoming input guards',async()=>{
  const metadata=(lane,a)=>({native_runtime:{pid:100+lane,build_id:'fixture-build',version:'1.0.0',features:['native_execution_v1'],device:a.device},
    native_execution:{schema_version:1,operation_id:`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${lane}`,pid:100+lane,clock:'CLOCK_MONOTONIC',
      scope:'execute_connected',started_ns:'10000000001',finished_ns:'10000000002',device:a.device}});
  const f=await fixture({screenshotMetadata:metadata,tapResult:(lane,a)=>({content:[text({sent:true,...metadata(lane,a)})]})});
  try {
    const captured=await f.runner.handle({op:'capture',lanes:[0,1]});
    for(const [lane,capture] of captured.results.entries())assert.deepEqual(capture.native_runtime,metadata(lane,{device:TEST_PHONES[lane].id}).native_runtime);
    const result=await f.runner.handle({op:'calculator_taps',lanes:captured.results.map((capture,lane)=>({lane,screenshotId:capture.screenshot_id,points:[{x:1,y:1}]}))});
    for(const [lane,value] of result.results.entries()) {
      assert.equal(value.sent,1);assert.equal(value.native_receipts.length,1);
      assert.deepEqual(value.native_receipts[0].native_execution,metadata(lane,{device:TEST_PHONES[lane].id}).native_execution);
    }
    for(const event of f.runner.events.filter(event=>event.kind==='call')) {
      assert.ok(event.native_runtime);assert.ok(event.native_execution);
      assert.equal(event.native_execution.device,event.device);
    }
  } finally {await f.cleanup();}
  const malformed=await fixture({tapResult:()=>({content:[text({sent:true,native_execution:{schema_version:99}})]})});
  try {
    const capture=await malformed.runner.handle({op:'capture',lanes:[0]});
    const result=await malformed.runner.handle({op:'calculator_taps',lanes:[{lane:0,screenshotId:capture.results[0].screenshot_id,points:[{x:1,y:1}]}]});
    assert.equal(result.results[0].sent,1);assert.equal(result.results[0].native_receipts[0].native_execution.schema_version,99);
  } finally {await malformed.cleanup();}
});
