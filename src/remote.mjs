import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, lstat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root, stateDir } from './config.mjs';
import { checkWork, signal, phase, remainingMs } from './work.mjs';
import { chooseEndpoint, observeListeners, RemoteListenerError } from './remote-endpoint.mjs';

const starting = new Map();
const localHelpers = new Map();
const remoteHelpers = new Map();
const readOnly = new Set(['ax_tree', 'screenshot', 'device_info', 'display_info', 'list_apps']);
let closing = false;

async function stopLocalHelper({ child, exited }) {
  if (!child || child.killed || child.exitCode !== null) return;
  try { child.kill('SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; return; }
  const escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
  try { await exited; }
  finally { clearTimeout(escalation); }
}

// A config without host and port is handed to the helper unchanged. Existing
// fixture helpers do not dial a listener. A real record is copied into a
// runtime file so the saved port, including 49152, is not rewritten and is not
// dialed when a current advertisement names a different port for this device only.
async function materializeRemote(target) {
  let saved;
  try { saved = JSON.parse(await readFile(target.remote, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
  if (!saved || typeof saved !== 'object' || typeof saved.host !== 'string' || !Number.isInteger(saved.port)) return null;
  if (typeof saved.id === 'string' && saved.id !== target.id) throw new RemoteListenerError('Remote configuration identity does not match the selected device.', 'remote_identity_mismatch');
  const record = { id: target.id, host: saved.host, port: saved.port };
  const choice = chooseEndpoint(record, await observeListeners([record]));
  if (!choice.ok) throw new RemoteListenerError(choice.message, choice.code, choice.outcome);
  const directory = join(stateDir, 'remote-runtime');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ id: target.id, host: choice.host, port: choice.port, ...(typeof saved.pairing_file === 'string' ? { pairing_file: saved.pairing_file } : {}) });
  const file = join(directory, createHash('sha256').update(`${target.id}\0${choice.host}\0${choice.port}`).digest('hex').slice(0, 24) + '.json');
  await writeFile(file, body, { mode: 0o600 });
  await writeFile(`${file}.source`, JSON.stringify({ source: choice.source, presumed_current: choice.presumedCurrent === true, saved_port: saved.port }), { mode: 0o600 });
  return file;
}

export async function closeLocalHelpers() {
  closing = true;
  await Promise.allSettled([...localHelpers.values()].map(stopLocalHelper));
}

export async function remoteDevices() {
  let configs;
  try { configs = JSON.parse(await readFile(join(stateDir, 'remote-devices.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(configs)) throw new Error('remote-devices.json must contain an array.');
  return configs.map(config => {
    if (typeof config.id !== 'string' || typeof config.config_path !== 'string' || !config.config_path.startsWith('/')) throw new Error('Invalid remote device configuration.');
    return { id: config.id, name: config.name ?? config.id, kind: 'physical', connection: 'RemotePairing', remote: config.config_path };
  });
}

function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('error', reject);
    socket.once('connect', () => resolve(socket));
  });
}

async function socketFor(target) {
  // macOS Unix socket names are limited to 104 bytes, regardless of the state directory's length.
  if (!target.remote && closing) throw new Error('Local native helpers are shutting down.');
  const launch = { ...target };
  if (target.remote) {
    const runtime = await materializeRemote(target);
    if (runtime) launch.remote = runtime;
  }
  const directory = `/tmp/poki-${launch.remote ? 'remote' : 'native'}-${process.getuid()}`;
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Remote socket directory must be private and owned by this user.');
  const path = join(directory, createHash('sha256').update(launch.remote ?? JSON.stringify([root, stateDir, process.pid, launch.id])).digest('hex').slice(0, 24) + '.sock');
  try { return { socket: await connect(path), path }; }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  if (!starting.has(path)) {
    const started = (async () => {
      const previous = localHelpers.get(path);
      if (previous) await stopLocalHelper(previous);
      try {
        const stale = await lstat(path);
        if (!stale.isSocket() || stale.uid !== process.getuid()) throw new Error('Unexpected file at the remote socket path.');
        await unlink(path);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!launch.remote && closing) throw new Error('Local native helpers are shutting down.');
      const previousRemote = launch.remote ? remoteHelpers.get(launch.id) : undefined;
      if (previousRemote && previousRemote.path !== path) await stopLocalHelper(previousRemote);
      const args = launch.remote ? ['--remote-server', launch.remote, path] : ['--local-server', launch.id, path];
      const child = spawn(join(root, 'build/poki-native'), args, { detached: Boolean(launch.remote), stdio: [launch.remote ? 'ignore' : 'pipe', 'pipe', process.env.POKI_MCP_NATIVE_TRACE ? 'inherit' : 'ignore'] });
      if (process.env.POKI_MCP_NATIVE_TRACE) console.error(JSON.stringify({ event: 'native_helper_started', pid: child.pid, transport: launch.remote ? 'remote' : 'local' }));
      if (launch.remote) {
        const exited = once(child, 'exit').catch(() => {}).then(() => { if (remoteHelpers.get(launch.id)?.child === child) remoteHelpers.delete(launch.id); });
        remoteHelpers.set(launch.id, { path, child, exited });
      }
      if (!launch.remote) {
        const exited = once(child, 'exit').catch(() => {}).then(async () => {
          await unlink(path).catch(() => {});
          if (localHelpers.get(path)?.child === child) localHelpers.delete(path);
        });
        localHelpers.set(path, { child, exited });
        child.stdin.on('error', () => {});
      }
      const lines = createInterface({ input: child.stdout });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Remote helper did not start.')); }, 5000);
          const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
          child.once('error', () => done(new Error('Cannot start remote helper. Run bin/setup.')));
          child.once('exit', () => done(new Error('Remote helper stopped before becoming ready.')));
          lines.once('line', line => { if (line === '{"ready":true}') done(); else done(new Error('Invalid remote helper greeting.')); });
        });
      } finally { lines.close(); child.stdout.destroy(); child.unref(); }
    })();
    starting.set(path, started);
    started.finally(() => starting.delete(path)).catch(() => {});
  }
  await starting.get(path);
  return { socket: await connect(path), path };
}

export async function nativeRequest(target, request) {
  checkWork();
  if (request.op === "ax_tree") request = { ...request, timeout_ms: remainingMs(Math.min(request.timeout_ms ?? 20000,20000)) };
  const callerSignal = signal();
  const { socket, path } = await phase('native_helper', () => socketFor(target));
  try { checkWork(); } catch (error) { socket.destroy(); throw error; }
  return phase('native_request', () => new Promise((resolve, reject) => {
    const lines = createInterface({ input: socket });
    let pid, outcome, abortReason;
    const abort = reason => {
      abortReason = reason;
      socket.destroy();
    };
    const onAbort = () => abort(callerSignal.reason);
    const timer = setTimeout(() => abort(new DOMException('Remote operation timed out; inspect before retrying input.', 'TimeoutError')), 120000);
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    lines.on('line', line => {
      if (abortReason) return;
      let value;
      try { value = JSON.parse(line); } catch { abort(new Error('Invalid remote helper response. Inspect before retrying input.')); return; }
      if (!pid) {
        if (!Number.isSafeInteger(value.pid) || value.pid <= 1) { abort(new Error('Invalid remote helper identity.')); return; }
        pid = value.pid;
        if (callerSignal?.aborted) { abort(callerSignal.reason); return; }
        socket.write(JSON.stringify(request) + '\n');
      } else { outcome = value; socket.end(); }
    });
    const helperName = target.remote ? 'Remote' : 'Native';
    socket.on('error', () => { abortReason ??= new Error(!target.remote && readOnly.has(request.op) ? 'Native helper connection closed during a read.' : `${helperName} helper connection closed. Input may have been delivered; inspect before retrying.`); });
    socket.once('close', async () => {
      clearTimeout(timer); lines.close();
      callerSignal?.removeEventListener('abort', onAbort);
      // A local helper finishes an abandoned read before serving anyone else, so end it as a one-shot read would end.
      const helper = !target.remote && pid && !outcome && abortReason && readOnly.has(request.op) && localHelpers.get(path);
      if (helper && helper.child.pid === pid) await stopLocalHelper(helper);
      if (abortReason) reject(abortReason);
      else if (!outcome) reject(new Error(`${helperName} helper closed without confirming the action. Inspect before retrying input.`));
      else if (outcome.transport_error) reject(new Error(outcome.error ?? 'Remote operation failed.'));
      else resolve(outcome);
    });
  }));
}
