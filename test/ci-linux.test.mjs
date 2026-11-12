import test from 'node:test';
import assert from 'node:assert/strict';
import {PLAN,RUST_VERSION,EXCLUSIONS,expectedCommit,testSummary,checksPassed,publicHtml} from '../bin/ci/policy.mjs';

const sha='1'.repeat(40),other='2'.repeat(40);
const nodeSummary=n=>`TAP version 13\n# tests ${n}\n# pass ${n}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
test('Pages source identity is mandatory and a temporary expected pin cannot override it',()=>{
  assert.equal(expectedCommit({CF_PAGES:'1',CF_PAGES_COMMIT_SHA:sha}),sha);
  assert.equal(expectedCommit({},sha),sha);
  assert.equal(expectedCommit({CF_PAGES_COMMIT_SHA:sha,POKI_CI_EXPECTED_SHA:sha}),sha);
  for(const env of [{CF_PAGES:'1'},{CF_PAGES_URL:'https://example.pages.dev'},
    {CF_PAGES_COMMIT_SHA:'main'},{CF_PAGES_COMMIT_SHA:sha,POKI_CI_EXPECTED_SHA:other}])assert.throws(()=>expectedCommit(env,sha));
  assert.throws(()=>expectedCommit({CF_PAGES_COMMIT_SHA:sha},other));
});
test('lockfiles precede Cargo tests and every metadata/test command is locked on the pinned compiler',()=>{
  const firstTest=PLAN.findIndex(stage=>stage.kind==='rust-tests');
  for(const id of ['desktop-lockfile','launcher-lockfile'])assert.ok(PLAN.findIndex(stage=>stage.id===id)<firstTest);
  for(const stage of PLAN.filter(stage=>stage.command[0]==='cargo')){
    assert.equal(stage.command[1],`+${RUST_VERSION}`);assert.ok(stage.command.includes('--locked'));
  }
  assert.equal(PLAN.find(stage=>stage.id==='desktop-core').command.includes('--no-default-features'),false);
});
test('Node receipts reject zero, skipped, cancelled, duplicate or missing summaries',()=>{
  assert.equal(testSummary('node-tests',nodeSummary(33)).tests,33);
  for(const text of [nodeSummary(0),nodeSummary(3).replace('# skipped 0','# skipped 1'),
    nodeSummary(3).replace('# cancelled 0','# cancelled 1'),nodeSummary(3)+nodeSummary(3),'PASS'])
    assert.throws(()=>testSummary('node-tests',text));
});
test('Rust receipts preserve ignored counts but reject failures, filtered tests and zero execution',()=>{
  const good='test result: ok. 12 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 1.00s\n';
  assert.deepEqual(testSummary('rust-tests',good),{passed:12,failed:0,ignored:2,measured:0,filtered:0});
  for(const text of [good.replace('12 passed','0 passed'),good.replace('0 filtered out','1 filtered out'),good.replace('0 failed','1 failed'),'PASS'])
    assert.throws(()=>testSummary('rust-tests',text));
});
test('Python receipts require completed nonzero unittest execution',()=>{
  assert.equal(testSummary('python-tests','Ran 7 tests in 0.1s\n\nOK\n').tests,7);
  for(const text of ['Ran 0 tests in 0.1s\nOK\n','Ran 7 tests in 0.1s\nFAILED (failures=1)\n','Ran 7 tests in 0.1s\nOK (skipped=1)\n','OK'])
    assert.throws(()=>testSummary('python-tests',text));
});
test('a green subset cannot stand in for the complete declared plan',()=>{
  const summary=kind=>kind==='node-tests'?testSummary(kind,nodeSummary(1)):kind==='rust-tests'?{passed:1,failed:0,ignored:0,filtered:0}:{tests:1,passed:1,failed:0};
  const rows=PLAN.map(stage=>({...stage,status:'PASS',exit_code:0,signal:null,timed_out:false,test_summary:summary(stage.kind)}));
  assert.equal(checksPassed(rows),true);
  for(const mutation of [r=>r.pop(),r=>{r[0].status='NOT_RUN';},r=>{r[0].exit_code=1;},r=>{r[0].command=['true'];},
    r=>{r[1].id=r[0].id;},r=>{r[3].test_summary={tests:0};},r=>{r[3].test_summary.failed=1;}]){
    const bad=structuredClone(rows);mutation(bad);assert.equal(checksPassed(bad),false);
  }
});
test('Linux coverage excludes platform builds and the plan selects explicit headless test files',()=>{
  assert.ok(EXCLUSIONS.some(value=>value.includes('Windows')));
  assert.ok(EXCLUSIONS.some(value=>value.includes('Physical phones')));
  assert.equal(PLAN.some(stage=>stage.command.join(' ')==='npm test'),false);
  assert.deepEqual(PLAN.find(stage=>stage.id==='cli-session').command.slice(-1),['test/cli-session.test.mjs']);
  assert.ok(PLAN.find(stage=>stage.id==='node-dependencies').command.includes('--include=optional'));
  assert.ok(PLAN.find(stage=>stage.id==='node-dependencies').command.includes('--ignore-scripts'));
  assert.ok(PLAN.find(stage=>stage.id==='native-build-receipt-unit').command.includes('-B'));
});
test('the public report escapes untrusted strings and states its verification limit',()=>{
  const html=publicHtml({status:'PASS',repository:'<script>alert(1)</script>',observed_commit:sha});
  assert.equal(html.includes('<script>'),false);assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Verify the exact deployment commit and build result in Cloudflare'));
});
