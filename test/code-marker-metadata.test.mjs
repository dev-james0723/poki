import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';

const body = result => result.content.find(x => x.type === 'text')?.text ?? '';

test('metadata-only modification of native helper does not reject unchanged code', async t => {
  const f=await fixture(t);
  const baseline=await f.call('list_devices');
  assert.equal(baseline.isError, undefined, body(baseline));
  const path=join(f.dir,'build/poki-native'), st=await stat(path);
  await utimes(path, st.atime, new Date(st.mtimeMs+3000));
  const result=await f.call('list_devices');
  assert.equal(result.isError, undefined, body(result));
});

test('ctime-only change of an unchanged helper remains usable', async t => {
  const f=await fixture(t), path=join(f.dir,'build/poki-native');
  const before=await stat(path,{bigint:true});
  await chmod(path,Number(before.mode & 0o777n));
  const after=await stat(path,{bigint:true});
  if (after.ctimeNs === before.ctimeNs) return t.skip('filesystem did not update ctime for same-mode chmod');
  assert.equal(after.mtimeNs,before.mtimeNs);
  const result=await f.call('list_devices');
  assert.equal(result.isError,undefined,body(result));
});

test('atomic replacement with the same bytes and permissions remains usable', async t => {
  const f=await fixture(t), path=join(f.dir,'build/poki-native'), next=path+'.replacement';
  const before=await stat(path), bytes=await readFile(path);
  await writeFile(next,bytes,{mode:before.mode & 0o777});
  await rename(next,path);
  const result=await f.call('list_devices');
  assert.equal(result.isError,undefined,body(result));
});

test('a same-length native byte change is rejected even when mtime is restored', async t => {
  const f=await fixture(t);
  const path=join(f.dir,'build/poki-native'), st=await stat(path), bytes=await readFile(path);
  bytes[bytes.length-2]^=1;
  await writeFile(path,bytes); await utimes(path,st.atime,st.mtime);
  const result=await f.call('list_devices');
  assert.equal(result.isError,true);assert.match(body(result),/service is running old code/i);
});

test('a same-length JavaScript source change is rejected even when mtime is restored', async t => {
  const f=await fixture(t);
  const path=join(f.dir,'src/interaction.mjs'), st=await stat(path), bytes=await readFile(path);
  bytes[bytes.length-2]^=1;
  await writeFile(path,bytes); await utimes(path,st.atime,st.mtime);
  const result=await f.call('list_devices');
  assert.equal(result.isError,true);assert.match(body(result),/service is running old code/i);
});

test('security permission changes still require a restart even if bytes are unchanged', async t => {
  const f=await fixture(t);
  const path=join(f.dir,'build/poki-native'), st=await stat(path);
  await chmod(path,(st.mode & 0o777)^0o020);
  const result=await f.call('list_devices');
  assert.equal(result.isError,true);assert.match(body(result),/service is running old code/i);
});

test('a hard-link count change requires restart even if bytes are unchanged', async t => {
  const f=await fixture(t), path=join(f.dir,'build/poki-native');
  await link(path,join(f.dir,'build/extra-native-link'));
  const result=await f.call('list_devices');
  assert.equal(result.isError,true);assert.match(body(result),/service is running old code/i);
});

test('replacing the helper with a byte-identical external symlink requires restart', async t => {
  const f=await fixture(t), path=join(f.dir,'build/poki-native'), outside=await mkdtemp(join(tmpdir(),'poki-stale-external-'));
  t.after(()=>rm(outside,{recursive:true,force:true}));
  const external=join(outside,'external-native');
  const bytes=await readFile(path), mode=(await stat(path)).mode & 0o777;
  await writeFile(external,bytes,{mode}); await unlink(path); await symlink(external,path);
  const result=await f.call('list_devices');
  assert.equal(result.isError,true);assert.match(body(result),/service is running old code/i);
});

test('an unchanged startup symlink is allowed, including benign target timestamps', async t => {
  let external;
  const f=await fixture(t,{beforeStart:async dir=>{
    const path=join(dir,'build/poki-native');external=join(dir,'bin/real-native');
    const bytes=await readFile(path), mode=(await stat(path)).mode & 0o777;
    await writeFile(external,bytes,{mode});await unlink(path);await symlink(external,path);
  }});
  assert.equal((await f.call('list_devices')).isError,undefined);
  const before=await stat(external);await utimes(external,before.atime,new Date(before.mtimeMs+3000));
  const result=await f.call('list_devices');
  assert.equal(result.isError,undefined,body(result));
});

test('retargeting an existing symlink to identical content requires restart', async t => {
  let path, alternate;
  const f=await fixture(t,{beforeStart:async dir=>{
    path=join(dir,'build/poki-native');const first=join(dir,'bin/first-native');alternate=join(dir,'bin/second-native');
    const bytes=await readFile(path), mode=(await stat(path)).mode & 0o777;
    await writeFile(first,bytes,{mode});await writeFile(alternate,bytes,{mode});await unlink(path);await symlink(first,path);
  }});
  await unlink(path);await symlink(alternate,path);
  const result=await f.call('list_devices');
  assert.equal(result.isError,true);assert.match(body(result),/service is running old code/i);
});

test('changing a macOS ACL requires restart even if mode and bytes do not change', async t => {
  if (process.platform!=='darwin') return t.skip('macOS ACL regression');
  const f=await fixture(t), path=join(f.dir,'build/poki-native');
  const before=await stat(path);
  try { execFileSync('/bin/chmod',['+a','everyone allow write',path]); }
  catch { return t.skip('filesystem does not support macOS ACLs'); }
  assert.equal((await stat(path)).mode,before.mode);
  const result=await f.call('list_devices');
  assert.equal(result.isError,true);assert.match(body(result),/service is running old code/i);
});

test('changing a macOS extended attribute requires restart even if bytes do not change', async t => {
  if (process.platform!=='darwin') return t.skip('macOS xattr regression');
  const f=await fixture(t), path=join(f.dir,'build/poki-native');
  try { execFileSync('/usr/bin/xattr',['-w','com.example.poki-guard-test','value',path]); }
  catch { return t.skip('filesystem does not support extended attributes'); }
  const result=await f.call('list_devices');
  assert.equal(result.isError,true);assert.match(body(result),/service is running old code/i);
});

test('existing ACLs are allowed while unchanged but metadata relaxation fails closed', async t => {
  if (process.platform!=='darwin') return t.skip('macOS ACL regression');
  let supported=true;
  const f=await fixture(t,{beforeStart:async dir=>{
    try { execFileSync('/bin/chmod',['+a','everyone allow write',join(dir,'build/poki-native')]); }
    catch { supported=false; }
  }});
  if (!supported) return t.skip('filesystem does not support macOS ACLs');
  assert.equal((await f.call('list_devices')).isError,undefined);
  const path=join(f.dir,'build/poki-native'), before=await stat(path);
  await utimes(path,before.atime,new Date(before.mtimeMs+3000));
  const result=await f.call('list_devices');
  assert.equal(result.isError,true);assert.match(body(result),/service is running old code/i);
});

test('changing an existing macOS xattr to a same-length value requires restart', async t => {
  if (process.platform!=='darwin') return t.skip('macOS xattr regression');
  let supported=true;
  const f=await fixture(t,{beforeStart:async dir=>{
    try { execFileSync('/usr/bin/xattr',['-w','com.example.poki-guard-test','one',join(dir,'build/poki-native')]); }
    catch { supported=false; }
  }});
  if (!supported) return t.skip('filesystem does not support extended attributes');
  assert.equal((await f.call('list_devices')).isError,undefined);
  execFileSync('/usr/bin/xattr',['-w','com.example.poki-guard-test','two',join(f.dir,'build/poki-native')]);
  const result=await f.call('list_devices');
  assert.equal(result.isError,true);assert.match(body(result),/service is running old code/i);
});

test('adding or removing a JavaScript module requires restart', async t => {
  for (const change of ['add','remove']) await t.test(change,async t=>{
    const f=await fixture(t), path=join(f.dir,'src/marker-test-only.mjs');
    if (change==='add') await writeFile(path,'export const marker = true;\n');
    else await unlink(join(f.dir,'src/recording.mjs'));
    const result=await f.call('list_devices');
    assert.equal(result.isError,true);assert.match(body(result),/service is running old code/i);
  });
});
