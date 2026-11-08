import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { Coordination } from '../src/coordination.mjs';
import { backupRemoteRecords, chooseEndpoint, parseRemotePairing, queryListeners } from '../src/remote-endpoint.mjs';
import { fixture, value } from './fixture.mjs';
import { root } from '../src/config.mjs';

const phoneA = 'aaaaaaa1-bbbbbbbbbbbbbbb1';
const phoneB = 'aaaaaaa2-bbbbbbbbbbbbbbb2';

function dnsName(host) {
  return Buffer.concat([...host.split('.').map(label => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])), Buffer.from([0])]);
}
function resource(host, type, data) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([dnsName(host), head, data]);
}
function advertisement(id, port) {
  const service = '_remotepairing._tcp.local';
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(port, 4);
  const txt = Buffer.from(`UniqueDeviceID=${id}`);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(2, 6);
  return Buffer.concat([
    header,
    resource(service, 33, Buffer.concat([srv, Buffer.from([0])])),
    resource(service, 16, Buffer.concat([Buffer.from([txt.length]), txt])),
  ]);
}

test('a saved port is not current when this device advertises another, and the other phone is left alone', async () => {
  const saved = { id: phoneA, host: '192.0.2.11', port: 49152 };
  const blind = chooseEndpoint(saved, { available: false, advertisements: [] });
  assert.equal(blind.ok, true);
  assert.equal(blind.port, 49152);
  assert.equal(blind.source, 'saved_unverified');
  assert.equal(blind.presumedCurrent, false);
  const found = chooseEndpoint(saved, { available: true, advertisements: [{ id: phoneA, host: '192.0.2.11', port: 51011 }, { id: phoneB, host: '192.0.2.22', port: 51022 }] });
  assert.equal(found.port, 51011);
  assert.equal(found.source, 'discovered');
  const other = chooseEndpoint({ id: phoneB, host: '192.0.2.22', port: 49152 }, { available: true, advertisements: [{ id: phoneA, host: '192.0.2.11', port: 51011 }] });
  assert.equal(other.ok, false);
  assert.equal(other.outcome, 'not_sent');
  assert.match(other.message, /49152 was not used/);
  const foreign = chooseEndpoint(saved, { available: true, advertisements: [], blocked: [phoneA] });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, 'remote_identity_mismatch');
});

test('unicast answers stay on the host that was asked and a foreign id is not reused', async () => {
  const configs = [{ id: phoneA, host: '192.0.2.11', port: 49152 }, { id: phoneB, host: '192.0.2.22', port: 49152 }];
  const asked = [];
  const observation = await queryListeners(configs, async (_packet, host) => {
    asked.push(host);
    if (host === '192.0.2.11') return [advertisement(phoneA, 51011)];
    if (host === '192.0.2.22') return [advertisement(phoneA, 51011)];
    return [advertisement(phoneB, 51022)];
  });
  assert.deepEqual(asked.filter(host => host !== '224.0.0.251'), ['192.0.2.11', '192.0.2.22']);
  assert.equal(parseRemotePairing(advertisement(phoneA, 51011))[0].port, 51011);
  const chosenA = chooseEndpoint(configs[0], observation);
  const chosenB = chooseEndpoint(configs[1], observation);
  assert.equal(chosenA.port, 51011);
  assert.equal(chosenB.ok, false);
  assert.equal(chosenB.code, 'remote_identity_mismatch');
  assert.ok(!observation.advertisements.some(ad => ad.id === phoneB && ad.port === 51011));
});

test('different device queues overlap and one device stays ordered', async () => {
  const coordinator = new Coordination();
  const order = [];
  const session = delayMs => ({
    async queueDeviceKey(_name, args) { return `device:${args.device}`; },
    async dispatch(name) {
      order.push(`start ${name}`);
      await delay(delayMs);
      order.push(`end ${name}`);
      return { content: [] };
    },
    async cleanup() { return {}; },
  });
  await Promise.all([
    coordinator.call(session(180), 'slow', { device: phoneA }),
    coordinator.call(session(20), 'fast', { device: phoneB }),
  ]);
  assert.ok(order.indexOf('end fast') < order.indexOf('end slow'));
  let started = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = { async queueDeviceKey() { return `device:${phoneA}`; }, async dispatch() { started += 1; await gate; return { content: [] }; }, async cleanup() { return {}; } };
  const second = { async queueDeviceKey() { return `device:${phoneA}`; }, async dispatch() { started += 1; return { content: [] }; }, async cleanup() { return {}; } };
  const waiting = coordinator.call(first, 'tap', { device: phoneA });
  await delay(40);
  const queued = coordinator.call(second, 'tap', { device: phoneA });
  await delay(40);
  assert.equal(started, 1);
  release();
  await waiting;
  await queued;
  assert.equal(started, 2);
});

test('remote record backup copies the previous registry and pairing without following links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poki-remote-backup-'));
  const deviceDir = join(dir, 'remote', phoneA);
  await mkdir(deviceDir, { recursive: true });
  const registry = JSON.stringify([{ id: phoneA, config_path: join(deviceDir, 'config.json') }]);
  const config = JSON.stringify({ id: phoneA, host: '192.0.2.11', port: 49152, pairing_file: join(deviceDir, 'pairing.plist') });
  const pairing = 'synthetic pairing record';
  await writeFile(join(dir, 'remote-devices.json'), registry);
  await writeFile(join(deviceDir, 'config.json'), config);
  await writeFile(join(deviceDir, 'pairing.plist'), pairing);
  const backup = await backupRemoteRecords(dir);
  assert.equal(await readFile(join(backup, 'remote-devices.json'), 'utf8'), registry);
  assert.equal(await readFile(join(backup, 'remote', phoneA, 'config.json'), 'utf8'), config);
  assert.equal(await readFile(join(backup, 'remote', phoneA, 'pairing.plist'), 'utf8'), pairing);
  await writeFile(join(deviceDir, 'config.json'), JSON.stringify({ id: phoneA, host: '192.0.2.11', port: 1 }));
  assert.equal(await readFile(join(backup, 'remote', phoneA, 'config.json'), 'utf8'), config);
  const empty = await mkdtemp(join(tmpdir(), 'poki-remote-empty-'));
  assert.equal(await backupRemoteRecords(empty), null);
});

test('prepare-remote backs up an existing record before writing the new port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poki-prepare-'));
  await mkdir(join(dir, 'bin'), { recursive: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'bin/prepare-remote.mjs'), await readFile(join(root, 'bin/prepare-remote.mjs')));
  await writeFile(join(dir, 'src/config.mjs'), await readFile(join(root, 'src/config.mjs')));
  await writeFile(join(dir, 'src/remote-endpoint.mjs'), await readFile(join(root, 'src/remote-endpoint.mjs')));
  const fake = `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.SETUP_CALLS, 'call\\n');
const a = process.argv.slice(2);
if (a.includes('pair')) writeFileSync(a.at(-1), 'synthetic pairing record');
else if (a.includes('verify')) console.log('the device recognizes this pairing record');
else if (a.includes('DeviceName')) console.log(JSON.stringify('Synthetic phone'));
else console.log(JSON.stringify([{ id: 'synthetic-phone', connection: 'USB' }]));
`;
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls');
  await writeFile(join(bin, 'python3'), fake, { mode: 0o755 });
  await writeFile(join(bin, 'idevice'), fake, { mode: 0o755 });
  const state = join(dir, 'state');
  const deviceDir = join(state, 'remote', 'synthetic-phone');
  await mkdir(deviceDir, { recursive: true });
  const previous = JSON.stringify({ id: 'synthetic-phone', host: '192.0.2.10', port: 49152, pairing_file: join(deviceDir, 'pairing.plist') });
  await writeFile(join(deviceDir, 'config.json'), previous);
  await writeFile(join(deviceDir, 'pairing.plist'), 'keep me');
  const result = spawnSync(process.execPath, [join(bin, 'prepare-remote.mjs'), 'synthetic-phone', '192.0.2.10', '60001'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, POKI_MCP_STATE_DIR: state, IDEVICE_TOOLS: join(bin, 'idevice'), SETUP_CALLS: log },
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(join(deviceDir, 'config.json'), 'utf8'));
  assert.equal(config.port, 60001);
  assert.match(result.stdout, /saved port is a record/i);
  const backups = await readdir(join(state, 'remote-backups'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(state, 'remote-backups', backups[0], 'remote/synthetic-phone/config.json'), 'utf8'), previous);
  assert.equal(await readFile(join(state, 'remote-backups', backups[0], 'remote/synthetic-phone/pairing.plist'), 'utf8'), 'keep me');
});

async function installRemote(dir, env, { ads, discovery = 'mdns', pin } = {}) {
  if (pin) env.POKI_MCP_PIN_REMOTE_UDID = pin;
  env.POKI_REMOTE_DISCOVERY = discovery;
  if (ads) {
    const file = join(dir, 'ads.json');
    env.POKI_REMOTE_ADVERTISEMENTS_FILE = file;
    await writeFile(file, JSON.stringify(ads));
  }
  await mkdir(join(dir, 'state'), { recursive: true });
  const registry = [];
  for (const [id, host] of [[phoneA, '192.0.2.11'], [phoneB, '192.0.2.22']]) {
    const folder = join(dir, 'state', 'remote', id);
    await mkdir(folder, { recursive: true });
    const config = { id, host, port: 49152, pairing_file: join(folder, 'pairing.plist') };
    await writeFile(join(folder, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    await writeFile(join(folder, 'pairing.plist'), `synthetic ${id}`, { mode: 0o600 });
    registry.push({ id, name: id, config_path: join(folder, 'config.json') });
  }
  await writeFile(join(dir, 'state', 'remote-devices.json'), JSON.stringify(registry));
}

async function sourceRecords(dir) {
  const runtime = join(dir, 'state', 'remote-runtime');
  const files = (await readdir(runtime)).filter(name => name.endsWith('.source'));
  const records = [];
  for (const name of files) records.push(JSON.parse(await readFile(join(runtime, name), 'utf8')));
  return records;
}

test('explicit ids stay on their own discovered listeners and a process pin cannot hide the other phone', async t => {
  const f = await fixture(t, { beforeStart: (dir, env) => installRemote(dir, env, {
    pin: phoneA,
    ads: [{ id: phoneA, host: '192.0.2.11', port: 51011 }, { id: phoneB, host: '192.0.2.22', port: 51022 }],
  }) });
  const listed = value(await f.call('list_devices'));
  assert.ok(listed.devices.some(device => device.id === phoneA));
  assert.ok(listed.devices.some(device => device.id === phoneB));
  const other = await f.connect();
  assert.ok(!(await f.call('select_device', { device: phoneA })).isError);
  assert.ok(!(await other.callTool({ name: 'select_device', arguments: { device: phoneB } })).isError);
  const shotA = await f.call('take_screenshot');
  const shotB = await other.callTool({ name: 'take_screenshot', arguments: {} });
  assert.ok(!shotA.isError, JSON.stringify(shotA));
  assert.ok(!shotB.isError, JSON.stringify(shotB));
  const shots = (await f.events()).filter(event => event.op === 'screenshot');
  assert.deepEqual(shots.map(event => event.remoteId).sort(), [phoneA, phoneB]);
  assert.deepEqual(shots.map(event => event.port).sort(), [51011, 51022]);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'state/remote', phoneA, 'config.json'), 'utf8')).port, 49152);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'state/remote', phoneB, 'config.json'), 'utf8')).port, 49152);
  const sources = await sourceRecords(f.dir);
  assert.ok(sources.every(record => record.source === 'discovered' && record.presumed_current === true && record.saved_port === 49152));
});

test('two sessions use both phones without waiting for each other', async t => {
  const f = await fixture(t, { beforeStart: (dir, env) => installRemote(dir, env, {
    ads: [{ id: phoneA, host: '192.0.2.11', port: 51011 }, { id: phoneB, host: '192.0.2.22', port: 51022 }],
  }) });
  await f.set({ remoteDelay: { [phoneA]: 800 } });
  const other = await f.connect();
  const started = performance.now();
  const slow = f.call('take_screenshot', { device: phoneA });
  const fast = other.callTool({ name: 'take_screenshot', arguments: { device: phoneB } });
  const done = await fast;
  const elapsed = performance.now() - started;
  assert.ok(!done.isError, JSON.stringify(done));
  assert.ok(elapsed < 500, `phone B waited ${elapsed}ms for phone A`);
  assert.ok(!(await slow).isError);
  const shots = (await f.events()).filter(event => event.op === 'screenshot');
  assert.equal(shots.filter(event => event.remoteId === phoneA).length, 1);
  assert.equal(shots.filter(event => event.remoteId === phoneB).length, 1);
});

test('a missing advertisement does not dial the saved port or the other phone, and a dropped request is not replayed', async t => {
  const f = await fixture(t, { beforeStart: (dir, env) => installRemote(dir, env, {
    ads: [{ id: phoneA, host: '192.0.2.11', port: 51011 }],
  }) });
  const missed = await f.call('tap', { device: phoneB, x: 10, y: 10 });
  const body = value(missed);
  assert.equal(missed.isError, true);
  assert.equal(body.outcome, 'not_sent');
  assert.equal(body.sent, false);
  assert.match(body.error, /49152 was not used/);
  assert.equal((await f.events()).filter(event => event.remoteId === phoneB).length, 0);
  const kept = await f.call('take_screenshot', { device: phoneA });
  assert.ok(!kept.isError, JSON.stringify(kept));
  await f.set({ remoteDrop: { [phoneA]: 'tap' } });
  const dropped = await f.call('tap', { device: phoneA, x: 12, y: 12 });
  const unknown = value(dropped);
  assert.equal(dropped.isError, true);
  assert.equal(unknown.outcome, 'unknown');
  assert.match(unknown.instruction, /Inspect the screen before retrying/);
  const taps = (await f.events()).filter(event => event.op === 'tap' && event.remoteId === phoneA);
  assert.equal(taps.length, 1);
  const again = await f.call('take_screenshot', { device: phoneB });
  assert.equal(again.isError, true);
  assert.match(again.content.map(item => item.text ?? '').join('\n'), /49152 was not used/);
});

test('with discovery unavailable the saved port is dialed and still not marked current', async t => {
  const f = await fixture(t, { beforeStart: (dir, env) => installRemote(dir, env, { discovery: 'off' }) });
  const shot = await f.call('take_screenshot', { device: phoneA });
  assert.ok(!shot.isError, JSON.stringify(shot));
  const shots = (await f.events()).filter(event => event.op === 'screenshot');
  assert.equal(shots.length, 1);
  assert.equal(shots[0].remoteId, phoneA);
  assert.equal(shots[0].port, 49152);
  const [source] = await sourceRecords(f.dir);
  assert.equal(source.source, 'saved_unverified');
  assert.equal(source.presumed_current, false);
  assert.equal(source.saved_port, 49152);
  const other = await f.call('take_screenshot', { device: phoneB });
  assert.ok(!other.isError, JSON.stringify(other));
  assert.equal((await f.events()).filter(event => event.op === 'screenshot' && event.remoteId === phoneB && event.port === 49152).length, 1);
});

test('a changed advertisement replaces only that device helper', async t => {
  const f = await fixture(t, { beforeStart: (dir, env) => installRemote(dir, env, {
    ads: [{ id: phoneA, host: '192.0.2.11', port: 51011 }, { id: phoneB, host: '192.0.2.22', port: 51022 }],
  }) });
  assert.ok(!(await f.call('take_screenshot', { device: phoneA })).isError);
  assert.ok(!(await f.call('take_screenshot', { device: phoneB })).isError);
  await writeFile(f.env.POKI_REMOTE_ADVERTISEMENTS_FILE, JSON.stringify([
    { id: phoneA, host: '192.0.2.11', port: 51099 },
    { id: phoneB, host: '192.0.2.22', port: 51022 },
  ]));
  assert.ok(!(await f.call('take_screenshot', { device: phoneA })).isError);
  assert.ok(!(await f.call('take_screenshot', { device: phoneB })).isError);
  const shots = (await f.events()).filter(event => event.op === 'screenshot');
  assert.deepEqual(shots.filter(event => event.remoteId === phoneA).map(event => event.port), [51011, 51099]);
  assert.deepEqual(shots.filter(event => event.remoteId === phoneB).map(event => event.port), [51022, 51022]);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'state/remote', phoneA, 'config.json'), 'utf8')).port, 49152);
});
