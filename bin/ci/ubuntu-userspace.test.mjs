// Linux SDK integration tests, required by the CI command manifest.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

test('private DBus SDK relocation resolves private headers/library without redirecting other pkg-config modules',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'poki-ci-sdk-test-'))),triplet='x86_64-linux-gnu';
  try{
    const lib=join(root,'usr/lib',triplet),pc=join(lib,'pkgconfig'),runtime=join(root,'lib',triplet);
    mkdirSync(pc,{recursive:true});mkdirSync(runtime,{recursive:true});
    writeFileSync(join(runtime,'libdbus-1.so.3'),'synthetic library');
    symlinkSync(`/lib/${triplet}/libdbus-1.so.3`,join(lib,'libdbus-1.so'));
    writeFileSync(join(pc,'dbus-1.pc'),`original_prefix=/usr\nprefix=\${original_prefix}\nexec_prefix=\${prefix}\nlibdir=/usr/lib/${triplet}\nincludedir=\${prefix}/include\nName: dbus\nDescription: Synthetic DBus SDK\nVersion: 1.0\nLibs: -L\${libdir} -ldbus-1\nCflags: -I\${includedir}/dbus-1.0 -I\${libdir}/dbus-1.0/include\n`);
    const other=join(root,'other');mkdirSync(other);
    writeFileSync(join(other,'unrelated.pc'),'prefix=/opt/system-sdk\nName: unrelated\nDescription: Outside the private SDK\nVersion: 1.0\nCflags: -I${prefix}/include\n');
    execFileSync('python3',['-I','-B',fileURLToPath(new URL('./relocate-dbus.py',import.meta.url)),root,triplet]);
    assert.equal(realpathSync(join(lib,'libdbus-1.so')),join(runtime,'libdbus-1.so.3'));
    const env={...process.env,PKG_CONFIG_PATH:`${pc}:${other}`,PKG_CONFIG_SYSROOT_DIR:''};
    const flags=execFileSync('pkg-config',['--cflags','--libs','dbus-1'],{env,encoding:'utf8'});
    assert.ok(flags.includes(`-I${root}/usr/include/dbus-1.0`));assert.ok(flags.includes(`-L${lib}`));
    assert.equal(execFileSync('pkg-config',['--cflags','unrelated'],{env,encoding:'utf8'}).trim(),'-I/opt/system-sdk/include');
    assert.equal(readFileSync(join(other,'unrelated.pc'),'utf8').includes(root),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('private DBus relocation rejects an absolute link whose package target was not downloaded',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'poki-ci-sdk-test-'))),triplet='x86_64-linux-gnu';
  try{
    const lib=join(root,'usr/lib',triplet),pc=join(lib,'pkgconfig');mkdirSync(pc,{recursive:true});
    writeFileSync(join(pc,'dbus-1.pc'),'prefix=/usr\n');
    symlinkSync('/lib/not-in-private-package.so',join(lib,'libdbus-1.so'));
    assert.throws(()=>execFileSync('python3',['-I','-B',fileURLToPath(new URL('./relocate-dbus.py',import.meta.url)),root,triplet],{stdio:'pipe'}));
  }finally{rmSync(root,{recursive:true,force:true});}
});
