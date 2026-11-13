import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,value} from './fixture.mjs';

const elements = [
  {role:'Application',label:'Trip.com',frame:{x:0,y:0,width:430,height:932}},
  {role:'Button',label:'Open',frame:{x:10,y:100,width:100,height:40}},
];

test('raw coordinate tap expected_app stops when user switches to Messages',async t=>{
  const f=await fixture(t);
  await f.set({launched:true,foregroundName:'Messages',elements,screenshotUnavailable:true});
  const r=await f.call('tap',{x:50,y:120,expected_app:'Trip.com',verify:false});
  assert.equal(r.isError,true);
  assert.equal(value(r).sent,false);
  assert.equal((await f.events()).filter(e=>e.op==='tap').length,0);
});

test('raw key-based text cannot be entered into the wrong app',async t=>{
  const f=await fixture(t);
  await f.set({launched:true,foregroundName:'Messages',elements,screenshotUnavailable:true});
  const r=await f.call('type_text',{text:'Bangkok',submit:false,expected_app:'Agoda'});
  assert.equal(r.isError,true);
  assert.equal(value(r).sent,false);
  assert.equal((await f.events()).filter(e=>e.op==='type_text').length,0);
});
