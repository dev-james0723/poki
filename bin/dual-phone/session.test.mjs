import test from 'node:test';
import assert from 'node:assert/strict';
import {PinnedPhoneSession,validatePhone,validateDeviceConfig,CALCULATOR,calculatorForeground,verifyCalculatorResult} from './device-session.mjs';
import {runDualPhone} from './harness.mjs';
import {TEST_PHONES as phones} from './test-phones.mjs';

const response=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

function fixture({hooks={},approval='ask-human',inventoryTransform=x=>x,controlRole='Button',axBundle=true}={}) {
  const owners=new Map(),calls=[];
  const clients=phones.map((phone,index)=>({
    index,phone,lease:null,value:'0',equals:0,
    async callTool(request,options) {
      const {name,arguments:a}=request;
      calls.push({index,name,args:structuredClone(a)});
      if(hooks[name]) { const result=await hooks[name](this,a,options);if(result!==undefined)return result; }
      if(name==='poki_mcp_status') return response({approval_mode:approval});
      if(name==='list_devices') return response({devices:inventoryTransform(phones.map(p=>({...p,occupied:owners.has(p.id),owned_by_session:owners.get(p.id)===this})))});
      if(name==='acquire_device') {
        assert.equal(a.device,phone.id);assert.equal(owners.has(phone.id),false);
        owners.set(phone.id,this);this.lease='lease-'+index;
        return response({lease_id:this.lease,device:phone.id,state:'active',expires_at:new Date(Date.now()+a.ttl_seconds*1000).toISOString()});
      }
      if(name==='renew_device') {
        assert.equal(a.lease_id,this.lease);assert.equal(owners.get(phone.id),this);
        return response({lease_id:this.lease,device:phone.id,state:'active',expires_at:new Date(Date.now()+a.ttl_seconds*1000).toISOString()});
      }
      if(name==='release_device'||name==='cancel_device') {
        if(a.lease_id)assert.equal(a.lease_id,this.lease);
        const old=this.lease;
        if(owners.get(phone.id)===this)owners.delete(phone.id);
        this.lease=null;
        return response({stopped:true,device:phone.id,lease_id:old,cleanup:{native:[{released:true}]}});
      }
      assert.equal(a.device,phone.id,'every phone tool is explicitly pinned');
      assert.equal(owners.get(phone.id),this,'phone work has its own lease');
      if(name==='launch_app') { assert.equal(a.bundle_id,CALCULATOR);return response({launched:true,bundle_id:CALCULATOR,
        pid:100+index,foreground_verified:true,transport:'paired-device-app-service'}); }
      if(name==='get_foreground_app') return response({bundle_id:CALCULATOR,name:'Calculator',pid:100+index});
      if(name==='tap_text') {
        assert.equal(a.expected_app,axBundle?CALCULATOR:'Calculator');
        if(a.text==='='||a.text==='Equals')this.value=index===0?'15':(++this.equals===1?'17':'18');
        return response({sent:true,private_text:'PRIVATE PHONE CONTENT'});
      }
      if(name==='snapshot_ui') return response({
        source:'accessibility',truncated:false,prompt:null,
        observation:{id:'obs-'+calls.length,device:phone.id,input_freshness:'live_read',structure_completed_at:new Date().toISOString()},
        foreground:{bundle_id:axBundle?CALCULATOR:null,name:'Calculator',pid:100+index},
        elements:[...['AC','1','5','7','8','9','+','=','All Clear','Add','Equals'].map(label=>({role:controlRole,label,enabled:true})),
          {role:'StaticText',object_id:'current-display',value:this.value},
          {role:'StaticText',object_id:'private-history',value:'PRIVATE PHONE CONTENT'}]
      });
      throw new Error('unexpected tool '+name);
    }
  }));
  return {clients,owners,calls};
}

function plan() { return {version:1,lanes:phones.map((device,i)=>({device,calculation:{labels:['AC',i===0?'7':'9','+','8','='],
  result:{field:'value',text:i===0?'15':'17',role:'StaticText',objectId:'current-display'}}})),
  isolation:{stopLane:0,continueLane:1,mode:'cancel',calculation:{labels:['+','1','='],result:{field:'value',text:'18',role:'StaticText',objectId:'current-display'}}}}; }

test('two device sessions route every phone call explicitly and cancellation does not touch sibling',async()=>{
  const f=fixture();const report=await runDualPhone(f.clients,plan(),{mode:'exercise'});
  assert.equal(report.status,'FUNCTIONAL_PASS');assert.equal(report.isolation.status,'PASS');
  const cancel=f.calls.findIndex(x=>x.index===0&&x.name==='cancel_device');
  assert.ok(cancel>0);assert.ok(f.calls.slice(cancel+1).some(x=>x.index===1&&x.name==='tap_text'));
  assert.equal(f.calls.slice(cancel+1).some(x=>x.index===0&&x.name==='tap_text'),false);
  assert.equal(f.owners.size,0);assert.equal(JSON.stringify(report).includes('PRIVATE PHONE CONTENT'),false);
  assert.equal(report.native_dispatch_overlap,'NOT_MEASURED');
});

test('real Calculator Key roles, null AX bundle, and observed All Clear/Add/Equals labels work',async()=>{
  const f=fixture({controlRole:'Key',axBundle:false});const livePlan=plan();
  const labels={'AC':'All Clear','+':'Add','=':'Equals'};
  for(const lane of livePlan.lanes)lane.calculation.labels=lane.calculation.labels.map(label=>labels[label]??label);
  livePlan.isolation.calculation.labels=livePlan.isolation.calculation.labels.map(label=>labels[label]??label);
  const report=await runDualPhone(f.clients,livePlan,{mode:'exercise'});
  assert.equal(report.status,'FUNCTIONAL_PASS');assert.equal(report.isolation.status,'PASS');
  assert.equal(f.calls.some(c=>c.name==='get_foreground_app'),false,'verified launch proof avoids redundant lookup');
});

test('retained launch proof rejects wrong PID/device, conflicting bundle, prompt, truncation, and stale AX',async()=>{
  for(const alter of [
    s=>{s.foreground.pid=999;},s=>{s.observation.device=phones[1].id;},s=>{s.foreground.bundle_id='com.wispr.flow';},
    s=>{s.prompt={kind:'permission'};},s=>{s.truncated=true;},s=>{s.observation.input_freshness='requires_live_read';},
    s=>{s.observation.structure_completed_at=new Date(Date.now()-15000).toISOString();},
  ]) {
    const f=fixture({axBundle:false});const session=new PinnedPhoneSession(f.clients[0],phones[0]);
    await session.initialize();await session.launchCalculator();const snapshot=await session.observe();
    assert.equal(session.calculatorGuard(snapshot),'Calculator');
    const changed=structuredClone(snapshot);alter(changed);assert.throws(()=>session.calculatorGuard(changed));
    assert.throws(()=>session.calculatorGuard(snapshot),/proof_unavailable/,'mismatch invalidates retained proof');
    assert.equal(f.calls.filter(c=>c.name==='launch_app').length,1,'never relaunch automatically');
    await session.stop();
  }
});

test('launch proof requires complete canonical successful receipt and is invalid after stop or uncertain input',async()=>{
  for(const bad of [
    {bundle_id:'com.wispr.flow'}, {pid:0}, {pid:1.5}, {pid:Number.MAX_SAFE_INTEGER+1},
    {launched:false}, {foreground_verified:false}, {transport:'unknown'}, {isError:true}, {error:'refused'}, {outcome:'unknown'},
  ]) {
    const f=fixture({hooks:{launch_app:async()=>response({bundle_id:CALCULATOR,pid:100,launched:true,
      foreground_verified:true,transport:'paired-device-app-service',...bad})}});
    const s=new PinnedPhoneSession(f.clients[0],phones[0]);await s.initialize();await assert.rejects(s.launchCalculator());
    assert.equal(s.fenced,true);await s.stop('cancel');
  }
  const f=fixture({hooks:{tap_text:async()=>{throw new Error('lost input receipt');}}});
  const s=new PinnedPhoneSession(f.clients[0],phones[0]);await s.initialize();await s.launchCalculator();const snapshot=await s.observe();
  assert.equal(s.calculatorGuard(snapshot),CALCULATOR);await assert.rejects(s.tapCalculatorLabel('7',CALCULATOR));
  assert.throws(()=>s.calculatorGuard(snapshot),/proof_unavailable/);await s.stop('cancel');
  assert.throws(()=>s.calculatorGuard(snapshot),/proof_unavailable/);
});

test('global device discovery settles before another session acquires; actual phone phases remain parallel',async()=>{
  const activeDiscovery=new Set(),bothLaunching=deferred();let launches=0,foreignDiscoveryAcquisitions=0;
  const f=fixture({hooks:{
    list_devices:async(client)=>{
      activeDiscovery.add(client.index);
      try { if(client.index===0)await new Promise(resolve=>setTimeout(resolve,20)); }
      finally { activeDiscovery.delete(client.index); }
    },
    acquire_device:async(client)=>{
      if([...activeDiscovery].some(index=>index!==client.index)) {
        foreignDiscoveryAcquisitions++;throw new Error('foreign discovery still touches this phone');
      }
    },
    launch_app:async()=>{if(++launches===2)bothLaunching.resolve();await bothLaunching.promise;}
  }});
  const report=await runDualPhone(f.clients,plan(),{mode:'launch',sessionOptions:{callTimeoutMs:200,maxSessionMs:1000}});
  assert.equal(report.status,'STAGE_PASS');assert.equal(foreignDiscoveryAcquisitions,0);
  assert.equal(launches,2);assert.equal(report.preflights.length,2);
  assert.equal(report.preflights.every(x=>x.status==='PASS'),true);
});

test('per-device preflight failure is sanitized and prevents all phone input',async()=>{
  const f=fixture({hooks:{acquire_device:async(client)=>{
    if(client.index===1)throw new Error('PRIVATE DIAGNOSTIC PAYLOAD');
  }}});
  const report=await runDualPhone(f.clients,plan(),{mode:'launch'});
  assert.equal(report.status,'BLOCKED');assert.equal(report.preflights[0].status,'PASS');
  assert.equal(report.preflights[1].device,phones[1].id);assert.equal(report.preflights[1].status,'BLOCKED');
  assert.equal(report.preflights[1].error,'transport_or_runtime_error');
  assert.equal(JSON.stringify(report).includes('PRIVATE DIAGNOSTIC PAYLOAD'),false);
  assert.equal(f.calls.some(c=>['launch_app','tap_text'].includes(c.name)),false);
});

test('wrong identity, wrong transport and changed approval mode block before lease/input',async()=>{
  for(const config of [
    {approval:'allow'},
    {inventoryTransform:xs=>xs.map(x=>({...x,id:'33333333-3333333333333333'}))},
    {inventoryTransform:xs=>[xs[0],xs[0],xs[1]]},
    {inventoryTransform:xs=>xs.map(x=>({...x,connection:'USB'}))},
    {inventoryTransform:xs=>xs.map(x=>({...x,name:'unexpected phone'}))},
  ]) {
    const f=fixture(config);const s=new PinnedPhoneSession(f.clients[0],phones[0]);
    await assert.rejects(s.initialize());await s.stop();
    assert.equal(f.calls.some(c=>['acquire_device','tap_text','launch_app'].includes(c.name)),false);
  }
});

test('private device configuration is explicit, bounded and distinct with no default phone',()=>{
  assert.deepEqual(validateDeviceConfig({version:1,devices:phones}),phones);
  assert.deepEqual(validatePhone({...phones[0],model:'iPhone99,1'}),{...phones[0],model:'iPhone99,1'});
  for(const value of [undefined,{}, {version:1}, {version:2,devices:phones},
    {version:1,devices:[phones[0]]}, {version:1,devices:[phones[0],phones[0]]},
    {version:1,devices:phones,select_first:true}])assert.throws(()=>validateDeviceConfig(value));
  for(const change of [{id:''},{id:'first available'},{id:'<EXACT_DEVICE_ID>'},{name:''},{name:'  '},
    {name:'Phone\nA'},{kind:'simulator'},{connection:'USB'},{model:'unknown'}, {unexpected:true}])
    assert.throws(()=>validatePhone({...phones[0],...change}));
  assert.throws(()=>new PinnedPhoneSession({callTool(){}},undefined),/unreviewed_device_identity/);
});

test('an optional exact model is verified against inventory before lease or input',async()=>{
  const f=fixture({inventoryTransform:xs=>xs.map(x=>({...x,model:'iPhone98,2'}))});
  const session=new PinnedPhoneSession(f.clients[0],{...phones[0],model:'iPhone99,1'});
  await assert.rejects(session.initialize(),/device_identity_or_transport_mismatch/);
  await session.stop();
  assert.equal(f.calls.some(c=>['acquire_device','tap_text','launch_app'].includes(c.name)),false);
});

test('blocked A input does not block B session and uncertain A input is never retried',async()=>{
  const blocked=deferred(),entered=deferred();
  const f=fixture({hooks:{tap_text:async(client)=>{
    if(client.index===0){entered.resolve();await blocked.promise;throw new Error('lost delivery receipt');}
  }}});
  const a=new PinnedPhoneSession(f.clients[0],phones[0]);const b=new PinnedPhoneSession(f.clients[1],phones[1]);
  await Promise.all([a.initialize(),b.initialize()]);
  const aInput=a.tapCalculatorLabel('7',CALCULATOR);await entered.promise;
  const queued=a.tapCalculatorLabel('8',CALCULATOR);
  await b.tapCalculatorLabel('9',CALCULATOR);
  assert.equal(f.calls.filter(c=>c.index===1&&c.name==='tap_text').length,1);
  blocked.resolve();await assert.rejects(aInput);await assert.rejects(queued,/input_fenced/);
  assert.equal(f.calls.filter(c=>c.index===0&&c.name==='tap_text').length,1);
  await a.stop('cancel');assert.equal(f.owners.get(phones[1].id),f.clients[1]);await b.stop();
});

test('stop waits for delayed acquisition and cleans only that newly acquired own lease',async()=>{
  const entered=deferred(),gate=deferred();
  const f=fixture({hooks:{acquire_device:async()=>{entered.resolve();await gate.promise;}}});
  const s=new PinnedPhoneSession(f.clients[0],phones[0]);
  const init=s.initialize();await entered.promise;
  const stop=s.stop();gate.resolve();
  await assert.rejects(init,/session_stopping/);await stop;
  assert.equal(s.ready,false);assert.equal(f.owners.size,0);
  assert.equal(f.calls.filter(c=>c.name==='acquire_device').length,1);
  assert.equal(f.calls.filter(c=>c.name==='release_device').length,1);
});

test('lost acquisition receipt is reconciled only by own-session cancel, never re-acquire',async()=>{
  const f=fixture({hooks:{acquire_device:async(client)=>{f.owners.set(client.phone.id,client);client.lease='lost-lease';throw new Error('reply lost');}}});
  const s=new PinnedPhoneSession(f.clients[0],phones[0]);await assert.rejects(s.initialize());await s.stop();
  assert.equal(f.owners.size,0);assert.equal(f.calls.filter(c=>c.name==='acquire_device').length,1);
  const cancel=f.calls.find(c=>c.name==='cancel_device');assert.deepEqual(cancel.args,{});
  assert.equal(s.report.cleanup,'cancelled_own_session');
});

test('duplicate client or device cannot masquerade as dual-phone acceptance',async()=>{
  const f=fixture();await assert.rejects(runDualPhone([f.clients[0],f.clients[0]],plan(),{mode:'exercise'}),/distinct_persistent/);
  const duplicate=plan();duplicate.lanes[1].device=phones[0];
  await assert.rejects(runDualPhone(f.clients,duplicate,{mode:'exercise'}),/duplicate_phone/);
  assert.equal(f.calls.length,0);
});

test('result verification rejects private-app name fallback, history text, and truncated snapshots',()=>{
  const s={foreground:{name:'Wispr Flow',pid:99},elements:[],truncated:false};
  assert.throws(()=>calculatorForeground(s,{bundle_id:'com.wispr.flow',pid:99}),/foreground_not_verified/);
  assert.equal(calculatorForeground({foreground:{name:'Calculator',pid:104}},
    {bundle_id:CALCULATOR,pid:104}),'Calculator');
  assert.throws(()=>calculatorForeground({foreground:{name:'Calculator',pid:104}},
    {bundle_id:CALCULATOR,pid:105}),/foreground_not_verified/);
  const current={foreground:{bundle_id:CALCULATOR},elements:[{role:'StaticText',object_id:'history',value:'15'}],truncated:false};
  const selector={role:'StaticText',objectId:'current-display',field:'value',text:'15'};
  assert.equal(verifyCalculatorResult(current,selector),false);
  assert.throws(()=>verifyCalculatorResult({...current,truncated:true},selector),/truncated/);
});

test('input timeout fences queued input and duplicate cleanup never repeats management call',async()=>{
  const f=fixture({hooks:{tap_text:async()=>new Promise(()=>{})}});
  const s=new PinnedPhoneSession(f.clients[0],phones[0],{callTimeoutMs:100});await s.initialize();
  await assert.rejects(s.tapCalculatorLabel('7',CALCULATOR),/input_timeout_unknown/);
  await assert.rejects(s.tapCalculatorLabel('8',CALCULATOR),/input_fenced/);
  await Promise.all([s.stop('cancel'),s.stop('release')]);
  assert.equal(f.calls.filter(c=>c.name==='tap_text').length,1);
  assert.equal(f.calls.filter(c=>c.name==='cancel_device').length,1);
});
