import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, value } from './fixture.mjs';

const added = ['query_ui','wait_for_ui','run_shortcut','get_app_action_status','list_app_links','open_verified_link','safari_open','safari_observe','safari_query','safari_wait_for','safari_act','safari_close'];
const app = {role:'Application',label:'Fixture',frame:{x:0,y:0,width:100,height:200}};
const field = {role:'TextField',object_id:'draft',label:'Draft',value:'廣東話 🙂',frame:{x:5,y:50,width:80,height:30}};
const state = {bundleId:'local.fixture',appName:'Fixture',appRoot:'Fixture',elements:[app,field],screenshotUnavailable:true};
const noInput = events => events.filter(e => ['tap','type_text','open_url','launch_app'].includes(e.op));

test('phone capability tools are discoverable in the default MCP profile with truthful read annotations', async t => {
  const f = await fixture(t);
  const tools = (await f.a.listTools()).tools;
  for (const name of added) assert.ok(tools.some(tool => tool.name === name), name + ' must be discoverable');
  for (const name of ['query_ui','wait_for_ui','get_app_action_status','list_app_links','safari_observe','safari_query','safari_wait_for']) {
    assert.equal(tools.find(tool=>tool.name===name).annotations.readOnlyHint,true,name);
  }
});

test('precise native query routes through MCP without capture, input or image attachment', async t => {
  const f = await fixture(t);
  await f.set(state);
  const result = await f.call('query_ui',{device:'fixture-phone',expected_app:'local.fixture',condition:{query:{object_ids:['draft']},state:'field_equals',field:'value',equals:'廣東話 🙂'}});
  assert.ok(!result.isError,JSON.stringify(result));
  assert.equal(value(result).matched,true);
  assert.ok(result.content.every(part=>part.type==='text'));
  const events = await f.events();
  assert.equal(events.filter(e=>e.op==='screenshot'||e.tool==='ocr').length,0);
  assert.equal(noInput(events).length,0);
});

test('invalid query predicates fail before native reads or prior batch input', async t => {
  const f = await fixture(t);
  await f.set(state);
  const result = await f.call('batch_commands',{commands:[
    {tool:'tap_text',arguments:{text:'Draft',expected_app:'local.fixture',verify:false}},
    {tool:'wait_for_ui',arguments:{expected_app:'local.fixture',condition:{query:{},state:'field_equals',equals:'x'}}},
  ]});
  assert.equal(result.isError,true);
  assert.equal(noInput(await f.events()).length,0);
});

test('shortcut callback mode without reachable configuration never opens a URL', async t => {
  const f = await fixture(t,{extraEnv:()=>({POKI_SHORTCUT_CALLBACK_BASE_URL:''})});
  await f.set(state);
  const result = await f.call('run_shortcut',{device:'fixture-phone',shortcut:'Poki Test',input:'hello',operation_key:'integration-no-origin',timeout_ms:500});
  assert.equal(result.isError,true);
  assert.equal(value(result).reason,'callback_origin_not_configured');
  assert.equal(value(result).dispatch_attempted,false);
  assert.equal(noInput(await f.events()).length,0);
});

test('Safari requires a matching explicit device lease before starting a session', async t => {
  const f = await fixture(t);
  const result = await f.call('safari_open',{device:'fixture-phone',lease_id:'unowned',url:'https://example.com',allowed_origins:['https://example.com']});
  assert.equal(result.isError,true);
  assert.match(JSON.stringify(result),/lease|session/i);
  assert.equal(noInput(await f.events()).length,0);
});
