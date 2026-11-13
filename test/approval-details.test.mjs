import test from 'node:test';
import assert from 'node:assert/strict';
import {urlApprovalDetail} from '../src/approval-details.mjs';
const make=()=>{
 const u=new URL('shortcuts://x-callback-url/run-shortcut');
 u.searchParams.set('name','Poki 測試');u.searchParams.set('input','text');u.searchParams.set('text','private-input');
 for(const [key,outcome]of [['x-success','success'],['x-cancel','cancelled'],['x-error','error']]){
  const c=new URL('https://callbacks.example/app-actions/callback');
  for(const[k,v]of Object.entries({id:'a'.repeat(64),outcome,token:'b'.repeat(64)}))c.searchParams.set(k,v);
  u.searchParams.set(key,c.toString());
 }
 return u;
};
test('Shortcut approval retains task/destination while excluding input and callback credentials',()=>{
 const detail=urlApprovalDetail(make().toString());
 assert.match(detail,/Poki 測試/);assert.match(detail,/callbacks.example/);
 assert.doesNotMatch(detail,/private-input|bbbb|aaaa|x-success|token=/);
});
test('unrecognized callback behavior remains fully visible for owner review',()=>{
 const u=make();u.searchParams.set('x-success','custom-app://execute?payload=review-this');
 assert.equal(urlApprovalDetail(u.toString()),u.toString());
});
test('ordinary URL approvals preserve their destination and parameters',()=>{
 const u='https://example.com/search?q=known';
 assert.equal(urlApprovalDetail(u),u);
});

test('no-input Shortcut approvals still hide callback credentials',()=>{
 const u=make();u.searchParams.delete('input');u.searchParams.delete('text');
 const detail=urlApprovalDetail(u.toString());
 assert.match(detail,/Poki 測試/);assert.match(detail,/no text input/);
 assert.doesNotMatch(detail,/bbbb|aaaa|x-success|token=/);
});
