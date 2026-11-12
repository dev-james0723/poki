export const RUST_VERSION='1.99.1';
export const ACTIONLINT_VERSION='1.7.7';
export const EXCLUSIONS=Object.freeze([
  'Windows compilation and windows-auth execution',
  'macOS native bridge compilation and execution',
  'Xcode, Swift, iOS Simulator, signing and installer builds',
  'Physical phones and native handler overlap acceptance',
  'Full root npm test suite',
  'Cloudflare phone relay deployment and relay test suite',
]);

export const PLAN=Object.freeze([
  {id:'desktop-lockfile',kind:'validation',command:['cargo',`+${RUST_VERSION}`,'metadata','--locked','--format-version','1','--manifest-path','desktop/Cargo.toml'],seconds:600},
  {id:'launcher-dependency',kind:'setup',command:['bash','native/launcher/fetch-idevice.sh'],seconds:600},
  {id:'launcher-lockfile',kind:'validation',command:['cargo',`+${RUST_VERSION}`,'metadata','--locked','--format-version','1','--manifest-path','native/launcher/Cargo.toml'],seconds:600},
  {id:'desktop-core',kind:'rust-tests',command:['cargo',`+${RUST_VERSION}`,'test','--locked','-p','poki-setup-core','-p','poki-setup-cli','--manifest-path','desktop/Cargo.toml'],seconds:1200},
  {id:'workflows',kind:'validation',command:['actionlint','-color','-shellcheck='],seconds:300},
  {id:'release-shell',kind:'validation',command:['bash','-n','.github/scripts/publish-rolling.sh'],seconds:60},
  {id:'release-python',kind:'validation',command:['python3','-I','-c','import py_compile,sys; py_compile.compile(sys.argv[1],cfile=sys.argv[2],doraise=True)','.github/scripts/promotion.py','{compile_output}'],seconds:60},
  {id:'release-json',kind:'validation',command:['python3','-I','-c','import json; json.load(open(".github/channels.json"))'],seconds:60},
  {id:'node-dependencies',kind:'setup',command:['npm','ci','--ignore-scripts','--include=optional','--no-audit','--no-fund'],seconds:600},
  {id:'node-native-dependency',kind:'validation',command:['node','--input-type=module','-e','import sharp from "sharp"; await import("@modelcontextprotocol/client"); await import("@modelcontextprotocol/node"); const b=await sharp({create:{width:1,height:1,channels:4,background:"white"}}).png().toBuffer(); if(b.length<8)throw Error("sharp probe failed"); console.log("SDK and synthetic sharp PNG probe passed");'],seconds:60},
  {id:'cli-session',kind:'node-tests',command:['node','--test','--test-reporter=tap','test/cli-session.test.mjs'],seconds:120},
  {id:'dual-phone-unit',kind:'node-tests',command:['node','--test','--test-reporter=tap','bin/dual-phone/session.test.mjs','bin/dual-phone/visual.test.mjs','bin/dual-phone/native-overlap.test.mjs'],seconds:120},
  {id:'native-build-receipt-unit',kind:'python-tests',command:['python3','-I','-B','test/native-build-receipt.test.py','-v'],seconds:120},
  {id:'ci-entrypoint-unit',kind:'node-tests',command:['node','--test','--test-reporter=tap','test/ci-linux.test.mjs','bin/ci/ubuntu-userspace.test.mjs'],seconds:120},
]);

export function need(condition,code){if(!condition)throw Object.assign(new Error(code),{code});}
export function expectedCommit(env,explicit){
  const pages=env.CF_PAGES_COMMIT_SHA;
  const onPages=env.CF_PAGES==='1'||Boolean(env.CF_PAGES_URL)||pages!==undefined;
  need(!onPages||/^[a-f0-9]{40}$/.test(pages??''),'pages_commit_required');
  const expected=pages||explicit||env.POKI_CI_EXPECTED_SHA;
  need(/^[a-f0-9]{40}$/.test(expected??''),'full_expected_commit_required');
  for(const pin of [explicit,env.POKI_CI_EXPECTED_SHA])if(pin!==undefined)need(pin===expected,'expected_commit_conflict');
  return expected;
}

export function testSummary(kind,text){
  if(kind==='node-tests'){
    const fields={};
    for(const key of ['tests','pass','fail','cancelled','skipped','todo']){
      const values=[...text.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`,'gm'))];
      need(values.length===1,'node_summary_missing_or_ambiguous');fields[key]=Number(values[0][1]);
    }
    need(fields.tests>0&&fields.pass===fields.tests&&fields.fail===0&&fields.cancelled===0&&fields.skipped===0&&fields.todo===0,'node_tests_not_all_passed');
    return fields;
  }
  if(kind==='rust-tests'){
    const rows=[...text.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/gm)];
    need(rows.length>0,'rust_summary_missing');
    const sum={passed:0,failed:0,ignored:0,measured:0,filtered:0};
    for(const row of rows){need(row[1]==='ok','rust_tests_failed');for(const [i,key] of Object.keys(sum).entries())sum[key]+=Number(row[i+2]);}
    need(sum.passed>0&&sum.failed===0&&sum.filtered===0,'rust_tests_empty_failed_or_filtered');return sum;
  }
  if(kind==='python-tests'){
    const rows=[...text.matchAll(/^Ran (\d+) tests? in [\d.]+s\s*$/gm)];
    need(rows.length===1&&Number(rows[0][1])>0&&/^OK\s*$/m.test(text)&&!/^FAILED/m.test(text),'python_tests_not_all_passed');
    return {tests:Number(rows[0][1]),passed:Number(rows[0][1]),failed:0};
  }
  return undefined;
}

export function checksPassed(checks){
  return Array.isArray(checks)&&checks.length===PLAN.length&&PLAN.every((stage,i)=>{
    const result=checks[i];
    const summary=result?.test_summary;
    const testsValid=stage.kind==='node-tests'?summary?.tests>0&&summary.pass===summary.tests&&['fail','cancelled','skipped','todo'].every(key=>summary[key]===0)
      :stage.kind==='rust-tests'?summary?.passed>0&&summary.failed===0&&summary.filtered===0&&summary.ignored>=0
      :stage.kind==='python-tests'?summary?.tests>0&&summary.passed===summary.tests&&summary.failed===0:true;
    return result?.id===stage.id&&result.kind===stage.kind&&JSON.stringify(result.command)===JSON.stringify(stage.command)&&
      result.status==='PASS'&&result.exit_code===0&&!result.signal&&!result.timed_out&&
      testsValid;
  });
}

export function publicHtml(report){
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Poki Linux CI report</title>'+
    '<style>body{max-width:75rem;margin:3rem auto;padding:0 1.5rem;font:16px/1.6 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f6;padding:1.25rem;border-radius:.5rem}code{overflow-wrap:anywhere}</style>'+
    `<h1>Poki Linux CI: ${escape(report.status)}</h1><p>Repository: <code>${escape(report.repository)}</code><br>Commit: <code>${escape(report.observed_commit)}</code></p>`+
    '<p>This report describes the listed Linux checks. Windows, macOS builds and physical phones are outside its coverage. Verify the exact deployment commit and build result in Cloudflare before relying on this page.</p>'+
    '<p><a href="report.json">Machine-readable report</a></p><pre>'+escape(JSON.stringify(report,null,2))+'</pre></html>\n';
}
