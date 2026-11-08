import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, value } from './fixture.mjs';

// A delayed-but-healthy RemotePairing AX reply must not be mistaken for a missing
// target. The fixture models the *remote* daemon protocol, not local USB behavior.
test('RemotePairing locates a label after six seconds and sends exactly one verified tap', async t => {
  const f = await fixture(t, { beforeStart: async dir => {
    await mkdir(join(dir, 'state'));
    await writeFile(join(dir, 'state/remote-devices.json'), JSON.stringify([
      { id: 'remote-phone', config_path: join(dir, 'remote.json') },
    ]));
    await writeFile(join(dir, 'build/poki-native'), `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { appendFileSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
const touched = process.env.FIXTURE_STATE + '.touched';
const log = req => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(req) + '\\n');
if (process.argv[2] !== '--remote-server') process.exit(1);
const server = createServer(socket => {
  socket.write(JSON.stringify({ pid: process.pid }) + '\\n');
  createInterface({input: socket}).once('line', async line => {
    const req = JSON.parse(line); log({op:req.op});
    let response;
    if (req.op === 'ax_tree') {
      await new Promise(done => setTimeout(done, 6200));
      response = {foreground_app:{name:'Fixture'},elements:[
        {role:'Button',label:existsSync(touched)?'Chat':'New chat',frame:{x:10,y:10,width:40,height:20}},
      ]};
    } else if (req.op === 'screenshot') {copyFileSync(process.env.FIXTURE_IMAGE, req.path);response={saved:true};}
    else if (req.op === 'device_info') response={scale:1,properties:{DeviceName:'Fixture remote'}};
    else if (req.op === 'tap') {writeFileSync(touched, 'sent');response={sent:true};}
    else response={isError:true,error:'Unexpected remote request: '+req.op};
    if (!socket.destroyed) socket.end(JSON.stringify(response)+'\\n');
  });
});
server.listen(process.argv[4], () => console.log(JSON.stringify({ready:true})));
`, {mode:0o755});
  }});
  const result = await f.call('tap_text', { device:'remote-phone', text:'New chat' });
  assert.ok(!result.isError, JSON.stringify(result));
  const receipt = value(result);
  assert.equal(receipt.sent, true);
  assert.equal(receipt.screen_change_verified, true);
  assert.equal(receipt.screen_changed, true);
  const events = await f.events();
  assert.equal(events.filter(e=>e.op==='tap').length, 1);
  assert.ok(events.filter(e=>e.op==='ax_tree').length >= 2);
});
