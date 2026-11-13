#!/usr/bin/env node
/** Offline native handler timing analysis. Never connects to or controls a phone.
 * Only a trusted, unmerged journal from one connectPair run on one local daemon
 * host/boot has a comparable CLOCK_MONOTONIC clock. This is not touch evidence.
 */
import {readFile,stat} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {validateDeviceConfig,requireThat,errorCode} from './device-session.mjs';

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const DECIMAL=/^(?:0|[1-9]\d{0,19})$/;
const MAX_U64=18446744073709551615n;
const ASSUMPTION='trusted_single_run_same_local_daemon_host_and_boot';
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);

/** Retain optional native receipts without changing whether ordinary UI calls work.
 * Conflicting or oversized metadata is marked unusable for proof, never retried.
 */
export function nativeReceipts(result) {
  const sources=[result,result?.structuredContent];
  for(const content of result?.content??[])if(content?.type==='text') {
    try {sources.push(JSON.parse(content.text));} catch {}
  }
  const retained={};
  for(const source of sources.filter(record))for(const key of ['native_runtime','native_execution'])if(own(source,key)) {
    try {
      const encoded=JSON.stringify(source[key]);
      if(typeof encoded!=='string'||Buffer.byteLength(encoded)>16384)
        return {native_receipt_error:'native_receipt_oversized_or_unserializable'};
      const value=JSON.parse(encoded);
      if(own(retained,key)&&!isDeepStrictEqual(retained[key],value))
        return {native_receipt_error:'conflicting_native_receipts'};
      retained[key]=value;
    } catch {return {native_receipt_error:'native_receipt_oversized_or_unserializable'};}
  }
  return retained;
}

function exactBinding(value,expected) {
  return record(value)&&['lane','device','client_session_id','connection_group','source'].every(key=>value[key]===expected[key]);
}

function interval(call,{expectedBuildId,seenOperations}) {
  requireThat(!call.native_receipt_error,'native_receipt_unusable');
  const runtime=call.native_runtime,execution=call.native_execution;
  requireThat(record(runtime)&&record(execution),'native_timing_missing');
  requireThat(runtime.build_id===expectedBuildId,'native_build_mismatch');
  requireThat(runtime.device===call.device&&execution.device===call.device,'native_device_mismatch');
  requireThat(Number.isSafeInteger(runtime.pid)&&runtime.pid>0&&execution.pid===runtime.pid,'native_pid_mismatch');
  requireThat(typeof runtime.version==='string'&&runtime.version.length>0&&runtime.version.length<=100&&
    Array.isArray(runtime.features)&&runtime.features.length<=100&&runtime.features.every(x=>typeof x==='string'&&x.length<=100)&&
    runtime.features.includes('native_execution_v1'),'native_runtime_feature_missing');
  requireThat(execution.schema_version===1&&execution.clock==='CLOCK_MONOTONIC'&&execution.scope==='execute_connected',
    'native_clock_or_scope_mismatch');
  requireThat(typeof execution.operation_id==='string'&&UUID.test(execution.operation_id)&&
    !seenOperations.has(execution.operation_id.toLowerCase()),'native_operation_id_invalid_or_repeated');
  seenOperations.add(execution.operation_id.toLowerCase());
  requireThat(typeof execution.started_ns==='string'&&DECIMAL.test(execution.started_ns)&&
    typeof execution.finished_ns==='string'&&DECIMAL.test(execution.finished_ns),'native_interval_not_decimal');
  const start=BigInt(execution.started_ns),finish=BigInt(execution.finished_ns);
  requireThat(start>0n&&finish>=start&&finish<=MAX_U64,'native_interval_order_invalid');
  return {lane:call.lane,device:call.device,client_session_id:call.client_session_id,pid:runtime.pid,
    operation_id:execution.operation_id,started_ns:execution.started_ns,finished_ns:execution.finished_ns,start,finish};
}

/** Missing/invalid proof fails closed; UI operation compatibility is independent. */
export function analyzeNativeIntervals(events,{devices,expectedBuildId,runId}={}) {
  const phones=validateDeviceConfig({version:1,devices});
  requireThat(typeof expectedBuildId==='string'&&/^[a-z\d._+-]{1,200}$/i.test(expectedBuildId)&&
    !/unversioned/i.test(expectedBuildId),'versioned_expected_build_required');
  requireThat(typeof runId==='string'&&UUID.test(runId),'exact_run_uuid_required');
  requireThat(Array.isArray(events)&&events.length>0&&events.length<=4096&&
    events.every(event=>record(event)&&event.run_id===runId),'single_exact_run_journal_required');
  const readies=events.filter(event=>event.kind==='ready');
  requireThat(readies.length===1&&readies[0].status==='READY'&&
    readies[0].native_clock_comparison_assumption===ASSUMPTION,'trusted_local_run_binding_required');
  const ready=readies[0],bindings=ready.session_bindings;
  requireThat(Array.isArray(bindings)&&bindings.length===2,'two_session_bindings_required');
  for(const [lane,binding] of bindings.entries()) {
    requireThat(record(binding)&&binding.lane===lane&&binding.device===phones[lane].id&&binding.source==='connectPair'&&
      typeof binding.connection_group==='string'&&UUID.test(binding.connection_group)&&
      typeof binding.client_session_id==='string'&&binding.client_session_id.startsWith(`dual-phone-${lane}-`)&&
      UUID.test(binding.client_session_id.slice(`dual-phone-${lane}-`.length)),'exact_device_session_binding_required');
    const preflights=events.filter(event=>event.kind==='preflight'&&event.lane===lane);
    requireThat(preflights.length===1&&preflights[0].status==='PASS'&&exactBinding(preflights[0],binding)&&
      events.indexOf(preflights[0])<events.indexOf(ready),'verified_session_preflight_required');
  }
  requireThat(bindings[0].connection_group===bindings[1].connection_group&&
    bindings[0].client_session_id!==bindings[1].client_session_id,'distinct_sessions_same_local_daemon_required');
  const calls=events.filter(event=>event.kind==='call'&&event.tool==='tap'&&event.input===true);
  requireThat(calls.length>0,'native_tap_intervals_missing');
  const seenOperations=new Set(),intervals=calls.map(call=>{
    requireThat(Number.isInteger(call.lane)&&call.lane>=0&&call.lane<2&&exactBinding(call,bindings[call.lane])&&
      events.indexOf(call)>events.indexOf(ready),'call_device_session_mismatch');
    requireThat(call.ok===true&&call.sent===true,'unsuccessful_input_cannot_prove_overlap');
    return interval(call,{expectedBuildId,seenOperations});
  });
  requireThat(intervals.some(x=>x.lane===0)&&intervals.some(x=>x.lane===1),'both_phone_tap_intervals_required');
  const overlaps=[];
  for(const a of intervals.filter(x=>x.lane===0))for(const b of intervals.filter(x=>x.lane===1)) {
    requireThat(a.device!==b.device&&a.client_session_id!==b.client_session_id&&a.operation_id!==b.operation_id,
      'overlap_requires_distinct_device_session_operation');
    // Each current native helper is bound to one paired-device session. Reusing
    // a PID for different lanes would contradict that runtime identity contract.
    requireThat(a.pid!==b.pid,'native_process_device_conflict');
    const start=a.start>b.start?a.start:b.start,finish=a.finish<b.finish?a.finish:b.finish;
    if(finish>start)overlaps.push({devices:[a.device,b.device],client_session_ids:[a.client_session_id,b.client_session_id],
      operation_ids:[a.operation_id,b.operation_id],pids:[a.pid,b.pid],started_ns:start.toString(),finished_ns:finish.toString(),
      overlap_ns:(finish-start).toString(),overlap_ms:Number(finish-start)/1000000});
  }
  let maximum=0n;for(const overlap of overlaps)if(BigInt(overlap.overlap_ns)>maximum)maximum=BigInt(overlap.overlap_ns);
  return {version:1,run_id:runId,status:overlaps.length?'NATIVE_HANDLER_OVERLAP_OBSERVED':'NO_NATIVE_HANDLER_OVERLAP_OBSERVED',
    expected_build_id:expectedBuildId,clock:'CLOCK_MONOTONIC',scope:'execute_connected',operation_kind:'successful_raw_tap',
    clock_comparison_assumption:ASSUMPTION,physical_touch_overlap:'NOT_MEASURED',
    interval_count:intervals.length,intervals:intervals.map(({start,finish,...value})=>value),
    overlapping_pair_count:overlaps.length,maximum_overlap_ns:maximum.toString(),maximum_overlap_ms:Number(maximum)/1000000,overlaps};
}

export async function readNativeJournal(path) {
  requireThat(typeof path==='string'&&isAbsolute(path),'absolute_private_journal_required');
  const info=await stat(path);
  requireThat(info.isFile()&&info.size>0&&info.size<=16777216,'native_journal_size_invalid');
  const source=await readFile(path,'utf8');
  requireThat(Buffer.byteLength(source)<=16777216,'native_journal_size_invalid');
  const lines=source.split(/\r?\n/).filter(line=>line.trim().length);
  requireThat(lines.length<=4096,'native_journal_record_limit');
  return lines.map(line=>JSON.parse(line));
}

async function main() {
  const args=process.argv.slice(2),config={};
  for(let i=0;i<args.length;i+=2) {
    requireThat(['--journal','--devices','--expected-build','--run-id'].includes(args[i])&&args[i+1]&&
      !args[i+1].startsWith('--')&&!own(config,args[i]),'usage_journal_devices_expected_build_run_id');
    config[args[i]]=args[i+1];
  }
  requireThat(['--journal','--devices','--expected-build','--run-id'].every(key=>config[key]),
    'usage_journal_devices_expected_build_run_id');
  requireThat(isAbsolute(config['--devices']),'absolute_device_config_required');
  const deviceSource=await readFile(config['--devices'],'utf8');
  requireThat(Buffer.byteLength(deviceSource)<=16384,'device_config_too_large');
  const devices=validateDeviceConfig(JSON.parse(deviceSource));
  const events=await readNativeJournal(config['--journal']);
  console.log(JSON.stringify(analyzeNativeIntervals(events,{devices,expectedBuildId:config['--expected-build'],runId:config['--run-id']})));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(JSON.stringify({status:'NATIVE_TIMING_UNVERIFIED',error:errorCode(error),physical_touch_overlap:'NOT_MEASURED'}));process.exitCode=2;});
