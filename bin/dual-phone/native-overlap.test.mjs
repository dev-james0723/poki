import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {analyzeNativeIntervals,nativeReceipts,readNativeJournal} from './analyze-native-overlap.mjs';
import {TEST_PHONES} from './test-phones.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const runId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const group='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const build='fixture-build-0123456789abcdef';
const uuid=i=>`cccccccc-cccc-4ccc-8ccc-${i.toString(16).padStart(12,'0')}`;
const bindings=TEST_PHONES.map((phone,lane)=>({lane,device:phone.id,source:'connectPair',connection_group:group,
  client_session_id:`dual-phone-${lane}-${uuid(lane+1)}`}));
const options={devices:TEST_PHONES,expectedBuildId:build,runId};
function header() {
  return [...bindings.map(binding=>({run_id:runId,kind:'preflight',...binding,status:'PASS'})),
    {run_id:runId,kind:'ready',status:'READY',session_bindings:structuredClone(bindings),
      native_clock_comparison_assumption:'trusted_single_run_same_local_daemon_host_and_boot'}];
}
function tap(lane,index,start,finish) {
  return {run_id:runId,kind:'call',...bindings[lane],tool:'tap',input:true,ok:true,sent:true,
    native_runtime:{pid:1000+lane,build_id:build,version:'1.0.0',features:['native_execution_v1'],device:TEST_PHONES[lane].id},
    native_execution:{schema_version:1,operation_id:uuid(index+10),pid:1000+lane,clock:'CLOCK_MONOTONIC',scope:'execute_connected',
      started_ns:String(start),finished_ns:String(finish),device:TEST_PHONES[lane].id}};
}
function overlapping() {
  return [...header(),tap(0,0,9007199254740993000n,9007199254740993100n),tap(1,1,9007199254740993050n,9007199254740993200n)];
}

test('native handler overlap uses exact nanosecond arithmetic and retains the physical-touch limit',()=>{
  const report=analyzeNativeIntervals(overlapping(),options);
  assert.equal(report.status,'NATIVE_HANDLER_OVERLAP_OBSERVED');
  assert.equal(report.maximum_overlap_ns,'50');assert.equal(report.overlapping_pair_count,1);
  assert.equal(report.overlaps[0].started_ns,'9007199254740993050');
  assert.equal(report.physical_touch_overlap,'NOT_MEASURED');
  assert.equal(report.clock_comparison_assumption,'trusted_single_run_same_local_daemon_host_and_boot');
  assert.deepEqual(report.overlaps[0].pids,[1000,1001]);
});

test('same-phone intervals and merely touching distinct-phone intervals do not prove cross-phone overlap',()=>{
  const events=[...header(),tap(0,0,100,300),tap(0,1,200,400),tap(1,2,400,500)];
  const report=analyzeNativeIntervals(events,options);
  assert.equal(report.status,'NO_NATIVE_HANDLER_OVERLAP_OBSERVED');
  assert.equal(report.maximum_overlap_ns,'0');assert.equal(report.overlaps.length,0);
  assert.throws(()=>analyzeNativeIntervals(overlapping(),{...options,devices:[TEST_PHONES[0],TEST_PHONES[0]]}),/duplicate_phone/);
});

test('stale, mixed and unversioned native builds cannot become timing proof',()=>{
  assert.throws(()=>analyzeNativeIntervals(overlapping(),{...options,expectedBuildId:'older-build'}),/native_build_mismatch/);
  for(const expectedBuildId of ['', 'unversioned', 'UNVERSIONED-local'])
    assert.throws(()=>analyzeNativeIntervals(overlapping(),{...options,expectedBuildId}),/versioned_expected_build_required/);
  const events=overlapping();events.at(-1).native_runtime.build_id='stale-build';
  assert.throws(()=>analyzeNativeIntervals(events,options),/native_build_mismatch/);
});

test('run, device and actual routing-session identities all fail closed before interval comparison',()=>{
  const mutations=[
    events=>{events.at(-1).run_id=uuid(80);},
    events=>{events.at(-1).client_session_id=bindings[0].client_session_id;},
    events=>{events.at(-1).device=TEST_PHONES[0].id;},
    events=>{events.at(-1).native_runtime.device=TEST_PHONES[0].id;},
    events=>{events.at(-1).native_execution.device=TEST_PHONES[0].id;},
    events=>{events.at(-1).native_execution.pid=1000;},
    events=>{events.at(-1).native_execution.pid=1000;events.at(-1).native_runtime.pid=1000;},
    events=>{events[2].session_bindings[1].connection_group=uuid(81);},
    events=>{events[0].status='BLOCKED';},
    events=>{events[2].session_bindings[0].source='unknown';},
    events=>{delete events[2].native_clock_comparison_assumption;},
    events=>{events.splice(2,1);}
  ];
  for(const mutate of mutations){const events=overlapping();mutate(events);assert.throws(()=>analyzeNativeIntervals(events,options));}
});

test('malformed clocks, intervals, UUIDs, unsuccessful calls and missing receipts are never counted as zero or overlap',()=>{
  const mutations=[
    call=>{call.native_execution.operation_id='not-a-uuid';},
    call=>{call.native_execution.operation_id=uuid(10);},
    call=>{call.native_execution.clock='CLOCK_REALTIME';},
    call=>{call.native_execution.scope='client_request';},
    call=>{call.native_execution.schema_version=2;},
    call=>{call.native_execution.started_ns='9007199254740993300';},
    call=>{call.native_execution.started_ns='-1';},
    call=>{call.native_execution.started_ns='1.0';},
    call=>{call.native_execution.finished_ns='18446744073709551616';},
    call=>{call.native_runtime.features=[];},
    call=>{call.ok=false;},
    call=>{call.sent=false;},
    call=>{delete call.native_execution;},
    call=>{call.native_receipt_error='conflicting_native_receipts';}
  ];
  for(const mutate of mutations){const events=overlapping();mutate(events.at(-1));assert.throws(()=>analyzeNativeIntervals(events,options));}
});

test('native receipt extraction preserves optional metadata but marks conflicting wrappers unusable',()=>{
  const call=tap(0,0,100,200),metadata={native_runtime:call.native_runtime,native_execution:call.native_execution};
  const content=[{type:'text',text:JSON.stringify({sent:true,...metadata})}];
  assert.deepEqual(nativeReceipts({content,structuredContent:metadata}),metadata);
  assert.deepEqual(nativeReceipts({content:[{type:'text',text:'{"sent":true}'}]}),{});
  const conflict=structuredClone(metadata);conflict.native_runtime.pid++;
  assert.equal(nativeReceipts({content,structuredContent:conflict}).native_receipt_error,'conflicting_native_receipts');
  assert.equal(nativeReceipts({native_runtime:{unexpected:'x'.repeat(17000)}}).native_receipt_error,'native_receipt_oversized_or_unserializable');
});

test('standalone analyzer reads one private JSONL and rejects merged runs without connecting to a runtime',async()=>{
  const directory=await mkdtemp(join(root,'.native-proof-test-'));
  try {
    const journal=join(directory,'run.jsonl'),devices=join(directory,'devices.json');
    await writeFile(journal,overlapping().map(event=>JSON.stringify(event)).join('\n')+'\n',{mode:0o600});
    await writeFile(devices,JSON.stringify({version:1,devices:TEST_PHONES}),{mode:0o600});
    assert.equal((await readNativeJournal(journal)).length,5);
    await assert.rejects(readNativeJournal('relative.jsonl'),/absolute_private_journal/);
    const args=[join(root,'analyze-native-overlap.mjs'),'--journal',journal,'--devices',devices,'--expected-build',build,'--run-id',runId];
    const result=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).maximum_overlap_ns,'50');
    const merged=overlapping();merged.at(-1).run_id=uuid(90);
    await writeFile(journal,merged.map(event=>JSON.stringify(event)).join('\n')+'\n');
    const rejected=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(rejected.status,2);assert.equal(JSON.parse(rejected.stderr).status,'NATIVE_TIMING_UNVERIFIED');
  } finally {await rm(directory,{recursive:true});}
});
