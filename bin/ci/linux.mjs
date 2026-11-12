#!/usr/bin/env node
// Provider-neutral checks. Pages integration supplies source identity, not a fake pass.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,writeFile,realpath,lstat} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PLAN,RUST_VERSION,ACTIONLINT_VERSION,EXCLUSIONS,need,expectedCommit,testSummary,checksPassed,publicHtml} from './policy.mjs';

const small=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex');
const stamp=()=>new Date().toISOString();
function argumentsOf(args){
  const result={};
  for(let i=0;i<args.length;i+=2){need(['--repo','--output','--repository','--expected-commit'].includes(args[i])&&args[i+1]&&!args[i+1].startsWith('--')&&!result[args[i]],'invalid_ci_arguments');result[args[i]]=args[i+1];}
  return result;
}
function childEnvironment(logDirectory){
  const env={};
  for(const name of ['PATH','HOME','TMPDIR','TEMP','TMP','LANG','LC_ALL','TERM','CARGO_HOME','RUSTUP_HOME','CARGO_TARGET_DIR','NPM_CONFIG_CACHE','npm_config_cache','PKG_CONFIG_PATH','LIBRARY_PATH','LD_LIBRARY_PATH','C_INCLUDE_PATH','SSL_CERT_FILE','SSL_CERT_DIR'])
    if(process.env[name]!==undefined)env[name]=process.env[name];
  return {...env,CI:'1',NO_COLOR:'1',POKI_SETUP_FILE_SECRETS:'1',POKI_NO_UPDATE_CHECK:'1',POKI_MCP_STATE_DIR:join(logDirectory,'unused-phone-state'),SHARP_IGNORE_GLOBAL_LIBVIPS:'1'};
}
async function git(repo,args){return (await small('git',args,{cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024})).stdout.trim();}
async function cleanSource(repo,expected){
  const commit=await git(repo,['rev-parse','--verify','HEAD^{commit}']);need(commit===expected,'checkout_commit_mismatch');
  need(!(await git(repo,['status','--porcelain=v1','--untracked-files=all'])),'source_checkout_not_clean');return commit;
}
async function toolVersions(repo,env){
  const versions={node:process.version};
  for(const [name,command,args] of [
    ['npm','npm',['--version']],['cargo','cargo',[`+${RUST_VERSION}`,'--version']],['rustc','rustc',[`+${RUST_VERSION}`,'--version']],
    ['python','python3',['-I','--version']],['actionlint','actionlint',['--version']],['dbus','pkg-config',['--modversion','dbus-1']],['cmake','cmake',['--version']],
  ])versions[name]=(await small(command,args,{cwd:repo,env,encoding:'utf8',timeout:30000,maxBuffer:65536})).stdout.trim().split('\n')[0];
  need(versions.rustc.startsWith(`rustc ${RUST_VERSION} `)&&versions.cargo.startsWith(`cargo ${RUST_VERSION} `),'rust_version_mismatch');
  need(versions.actionlint.replace(/^v/,'')===ACTIONLINT_VERSION,'actionlint_version_mismatch');return versions;
}
async function executeStage(stage,repo,env,logs){
  const started=stamp(),command=stage.command.map(value=>value==='{compile_output}'?join(logs,'promotion.pyc'):value);
  const result=await new Promise(resolveResult=>{
    let stdout='',stderr='',bytes=0,timedOut=false,overflow=false,spawnError=false,escalation;
    const child=spawn(command[0]==='node'?process.execPath:command[0],command.slice(1),{cwd:repo,env,stdio:['ignore','pipe','pipe'],detached:true});
    const stop=()=>{if(child.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}escalation=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},3000);}};
    const timer=setTimeout(()=>{timedOut=true;stop();},stage.seconds*1000);
    for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>32*1024*1024){if(!overflow){overflow=true;stop();}return;}
      if(key==='stdout')stdout+=chunk;else stderr+=chunk;
      // Cargo metadata is large JSON; retain its diagnostic evidence without flooding the build log.
      if(!(stage.id.endsWith('-lockfile')&&key==='stdout'))process[key].write(chunk);
    });
    child.on('error',()=>{spawnError=true;});
    child.on('close',(code,signal)=>{clearTimeout(timer);clearTimeout(escalation);resolveResult({stdout,stderr,code,signal,timedOut,overflow,spawnError});});
  });
  const evidence={};
  for(const name of ['stdout','stderr']){const body=result[name];await writeFile(join(logs,`${stage.id}.${name}.log`),body,{flag:'wx',mode:0o600});evidence[name]={sha256:sha(body),bytes:Buffer.byteLength(body)};}
  const row={id:stage.id,kind:stage.kind,command:stage.command,status:'FAIL',started_at:started,finished_at:stamp(),exit_code:result.code,signal:result.signal,timed_out:result.timedOut,logs:evidence};
  if(result.code===0&&!result.signal&&!result.timedOut&&!result.overflow&&!result.spawnError){
    try{const summary=testSummary(stage.kind,result.stdout+'\n'+result.stderr);if(summary)row.test_summary=summary;row.status='PASS';}
    catch(error){row.error=error.code??'test_summary_unverified';}
  }else row.error=result.timedOut?'stage_timeout':result.overflow?'stage_log_limit':result.spawnError?'stage_could_not_start':'stage_exit_failed';
  return row;
}

async function main(){
  const options=argumentsOf(process.argv.slice(2));
  need(process.platform==='linux','linux_runner_required');need(Number(process.versions.node.split('.')[0])>=24,'node_24_or_newer_required');
  const repository=options['--repository'];need(typeof repository==='string'&&/^[\w.-]+\/[\w.-]+$/.test(repository),'explicit_repository_required');
  const expected=expectedCommit(process.env,options['--expected-commit']);
  const repo=await realpath(resolve(options['--repo']??process.cwd()));
  need(await realpath(await git(repo,['rev-parse','--show-toplevel']))===repo,'repository_root_required');
  need(await realpath(fileURLToPath(import.meta.url))===join(repo,'bin/ci/linux.mjs'),'run_committed_entrypoint_in_checkout');
  await cleanSource(repo,expected);
  const output=resolve(repo,options['--output']??'.ci-output'),inside=relative(repo,output);
  need(inside&&!inside.startsWith('..')&&!isAbsolute(inside),'output_must_be_inside_checkout');
  await git(repo,['check-ignore','-q','--',join(inside,'report.json')]);
  try{await lstat(output);need(false,'output_directory_already_exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(output,{recursive:true,mode:0o700});
  const logs=await mkdtemp(join(tmpdir(),'poki-ci-')),env=childEnvironment(logs);
  const report={schema_version:1,kind:'poki-linux-ci-reported-result',status:'FAIL',run_id:randomUUID(),repository,
    expected_commit:expected,observed_commit:expected,started_at:stamp(),coverage:'linux-pr-gates-and-dual-phone-unit-tests',
    exclusions:EXCLUSIONS,execution_provenance:'Verify the Pages build result and deployment source commit independently.',
    required_checks:PLAN.map(stage=>stage.id),checks:[],pipeline_hash:sha(JSON.stringify({rust:RUST_VERSION,actionlint:ACTIONLINT_VERSION,plan:PLAN,exclusions:EXCLUSIONS})),
    source_hashes:{},runner:{platform:process.platform,architecture:process.arch}};
  try{
    for(const path of ['bin/ci/linux.mjs','bin/ci/policy.mjs','bin/ci/bootstrap-ubuntu.sh','bin/ci/ubuntu-userspace.sh','bin/ci/relocate-dbus.py'])report.source_hashes[path]=sha(await readFile(join(repo,path)));
    report.runner.versions=await toolVersions(repo,env);
    for(const stage of PLAN){
      console.log(`CI_START ${stage.id}`);
      const row=await executeStage(stage,repo,env,logs);report.checks.push(row);console.log(`CI_END ${stage.id} ${row.status}`);
      if(row.status!=='PASS')break;
    }
    await cleanSource(repo,expected);
    report.source_clean_after=true;
    report.status=checksPassed(report.checks)?'PASS':'FAIL';
  }catch(error){report.error=/^[a-z_]+$/.test(error.code??'')?error.code:'prerequisite_or_source_check_failed';}
  for(const stage of PLAN.slice(report.checks.length))report.checks.push({id:stage.id,kind:stage.kind,command:stage.command,status:'NOT_RUN'});
  report.finished_at=stamp();
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o644});
  await writeFile(join(output,'index.html'),publicHtml(report),{flag:'wx',mode:0o644});
  console.log(JSON.stringify({status:report.status,commit:expected,report:join(inside,'report.json'),coverage:report.coverage,logs_sha256_only:true}));
  if(report.status!=='PASS')process.exitCode=1;
}

main().catch(error=>{console.error(JSON.stringify({status:'BLOCKED',error:/^[a-z_]+$/.test(error.code??'')?error.code:'ci_preflight_failed'}));process.exitCode=2;});
