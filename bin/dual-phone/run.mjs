#!/usr/bin/env node
import {readFile,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {connectPair} from './connect.mjs';
import {runDualPhone,validatePlan} from './harness.mjs';
import {requireThat,errorCode} from './device-session.mjs';

const args=process.argv.slice(2);
const flags=new Set(['--repo','--state','--plan','--report','--mode','--observations-out']);
const config={};
for(let i=0;i<args.length;i+=2) {
  requireThat(flags.has(args[i])&&typeof args[i+1]==='string'&&!args[i+1].startsWith('--')&&!config[args[i]],'invalid_arguments');
  config[args[i]]=args[i+1];
}
for(const key of ['--repo','--state','--plan','--report','--mode']) requireThat(config[key],`missing_${key.slice(2)}`);
requireThat(['inspect','launch','exercise'].includes(config['--mode']),'invalid_mode');
requireThat(!config['--observations-out'] || config['--mode']!=='exercise','observation_export_only_in_staged_inspection');
const plan=validatePlan(JSON.parse(await readFile(resolve(config['--plan']),'utf8')),{exercise:config['--mode']==='exercise'});
const reportFile=await open(resolve(config['--report']),'wx',0o600);
let observationsFile,clients=[],report;
try {
  if(config['--observations-out']) observationsFile=await open(resolve(config['--observations-out']),'wx',0o600);
  clients=await connectPair({repo:resolve(config['--repo']),stateDirectory:resolve(config['--state'])});
  const observations=[];
  report=await runDualPhone(clients,plan,{mode:config['--mode'],
    ...(observationsFile?{onObservation:(lane,snapshot)=>{observations.push({lane,snapshot});}}:{})});
  if(observationsFile) await observationsFile.writeFile(JSON.stringify({private_device_ui:true,observations},null,2)+'\n');
} catch(error) {
  report={version:1,status:'BLOCKED',error:errorCode(error),retries:0,private_ui_logged:false};
} finally {
  await Promise.allSettled(clients.map(c=>c.close()));
  await reportFile.writeFile(JSON.stringify(report??{status:'UNVERIFIED'},null,2)+'\n');
  await reportFile.close();
  await observationsFile?.close();
}
console.log(JSON.stringify(report));
if(!['STAGE_PASS','FUNCTIONAL_PASS'].includes(report?.status)) process.exitCode=2;
