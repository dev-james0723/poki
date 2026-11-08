#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, chmod, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { root, stateDir, idevice } from '../src/config.mjs';
import { backupRemoteRecords } from '../src/remote-endpoint.mjs';
const exec = promisify(execFile);
const [id, host, portText = '49152'] = process.argv.slice(2);
const port = Number(portText);
if (!id || !/^[a-zA-Z0-9-]+$/.test(id) || !isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Usage: node bin/prepare-remote.mjs DEVICE_ID TAILSCALE_IP [PORT]. Connect the trusted iPhone by USB and Wi-Fi first.');
}
const devices = JSON.parse((await exec('python3', [join(root, 'native/devices.py')])).stdout);
if (!devices.some(d => d.id === id && d.connection === 'USB')) throw new Error('The selected iPhone must be connected over USB for initial pairing.');
const directory = join(stateDir, 'remote', id);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const pairing = join(directory, 'pairing.plist');
try { await stat(pairing); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  try { await exec(idevice, ['--udid', id, 'remotepairing_lockdown', 'pair', 'poki-mcp', pairing], { timeout: 45000 }); }
  catch { throw new Error('USB RemotePairing did not complete. Keep the trusted iPhone connected and unlocked.'); }
  // The upstream CLI can return exit 0 on failure. Require its actual output artifact.
  await stat(pairing);
}
await chmod(pairing, 0o600);
const verification = await exec(idevice, ['--udid', id, 'remotepairing_lockdown', 'verify', pairing, 'poki-mcp'], { timeout: 30000 });
if (!verification.stdout.includes('the device recognizes this pairing record')) throw new Error('The iPhone did not verify the saved pairing record. Keep it trusted, unlocked, and connected over USB. Rename remote/DEVICE_ID/pairing.plist in this installation\'s private state directory, then run prepare-remote again. See docs/remote-iphone.md.');
const configPath = join(directory, 'config.json');
// Keep the previous registry, config, and pairing file. The saved port is a record
// from this setup, not proof that the phone is still listening there.
await backupRemoteRecords(stateDir);
await writeFile(configPath, JSON.stringify({ id, host, port, pairing_file: pairing }), { mode: 0o600 });
await chmod(configPath, 0o600);
let configs = [];
const registry = join(stateDir, 'remote-devices.json');
try { configs = JSON.parse(await readFile(registry, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const name = JSON.parse((await exec(idevice, ['--udid', id, 'lockdown', 'get', 'DeviceName'], { timeout: 15000 })).stdout);
configs = configs.filter(d => d.id !== id);
configs.push({ id, name, config_path: configPath });
const temporary = registry + '.tmp';
await writeFile(temporary, JSON.stringify(configs), { mode: 0o600 });
await rename(temporary, registry);
console.log(JSON.stringify({ paired: true, device: id, next: 'Start Poki and call list_devices while Wi-Fi is connected. Keep the daemon running when switching to cellular. The saved port is a record; a current RemotePairing advertisement for this device replaces it, and one phone\'s advertisement is never applied to the other.' }));
