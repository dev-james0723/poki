import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

const source = process.env.POKI_SOURCE_UNDER_TEST ?? fileURLToPath(new URL('../src/', import.meta.url));
const [{ createServer }, { Coordination }, { inputLockFromEnv }, { work }] = await Promise.all(
  ['tools.mjs', 'coordination.mjs', 'input-lock.mjs', 'work.mjs'].map(name => import(pathToFileURL(join(source, name))))
);

const cli = process.env.POKI_CLI_UNDER_TEST ?? fileURLToPath(new URL('../bin/call.mjs', import.meta.url));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Exercise the real CLI, stdio bridge and coordinator against a loopback-only
// endpoint. The dispatcher below cannot discover or operate a real device.
async function endpoint(t) {
  const state = await mkdtemp(join(tmpdir(), 'poki-cli-session-'));
  const token = randomBytes(32).toString('hex');
  const coordinator = new Coordination();
  coordinator.inputLock = inputLockFromEnv({ POKI_INPUT_LOCK: '1', POKI_MAX_CONCURRENT_READS: '2' });
  const sessions = new Map(), calls = new Map(), closed = [], children = [], active = new Set();
  const events = new EventEmitter();
  const changed = () => events.emit('change');
  const until = (predicate, description) => new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); events.off('change', check); error ? reject(error) : resolve(); };
    const check = () => { if (predicate()) finish(); };
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${description}`)), 10000);
    events.on('change', check);
    check();
  });
  const context = label => ({
    label,
    backgroundDevices: new Map(),
    async cleanup() { return {}; },
    async dispatch(_name, args) {
      const call = calls.get(args.device), signal = work.getStore().signal;
      call.started = true;
      changed();
      let aborted;
      try {
        await new Promise((resolve, reject) => {
          aborted = () => { call.aborted = true; changed(); reject(signal.reason); };
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
          else call.gate.promise.then(resolve);
        });
        return { content: [{ type: 'text', text: JSON.stringify({ device: args.device, session: label, completed: true }) }] };
      } finally {
        signal.removeEventListener('abort', aborted);
        call.finished = true;
        changed();
      }
    },
  });
  const server = http.createServer((req, res) => {
    void (async () => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const session = req.headers['x-poki-mcp-session'];
      assert.equal(typeof session, 'string');
      if (!sessions.has(session)) sessions.set(session, context(session));
      const ctx = sessions.get(session);
      if (req.url === '/session/close') {
        await coordinator.end(ctx, 'session_closed');
        sessions.delete(session);
        closed.push(session);
        changed();
        res.end('{}');
        return;
      }
      assert.equal(req.url, '/mcp');
      const mcp = createServer((name, args, extra) => {
        assert.equal(name, 'get_foreground_app');
        assert.ok(!calls.has(args.device), 'Each synthetic call has a distinct label');
        calls.set(args.device, { session, gate: deferred(), started: false, finished: false, aborted: false });
        const result = coordinator.call(ctx, name, args, extra?.signal, extra?.requestId);
        changed();
        return result;
      });
      active.add(mcp);
      res.once('close', () => { active.delete(mcp); void mcp.close(); });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    })().catch(error => {
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end(JSON.stringify({ error: error.message }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await writeFile(join(state, 'mcp.json'), JSON.stringify({ enabled: true, url: `http://127.0.0.1:${server.address().port}/mcp`, token }), { mode: 0o600 });
  t.after(async () => {
    for (const call of calls.values()) call.gate.resolve();
    for (const child of children) if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGTERM');
    await Promise.allSettled(children.map(child => child.done));
    await Promise.allSettled([...sessions.values()].map(ctx => coordinator.end(ctx, 'fixture_closed')));
    await Promise.allSettled([...active].map(mcp => mcp.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(state, { recursive: true, force: true });
  });
  const launch = (device, session) => {
    const env = { ...process.env, POKI_MCP_STATE_DIR: state, POKI_NO_UPDATE_CHECK: '1' };
    delete env.POKI_MCP_SESSION;
    if (session !== undefined) env.POKI_MCP_SESSION = session;
    const childProcess = spawn(process.execPath, [cli, 'get_foreground_app', JSON.stringify({ device })], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    childProcess.stdout.on('data', chunk => { stdout += chunk; });
    childProcess.stderr.on('data', chunk => { stderr += chunk; });
    const done = once(childProcess, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
    const child = { process: childProcess, done };
    children.push(child);
    return child;
  };
  return { calls, closed, until, launch };
}

test('independent CLI defaults overlap and closing one leaves its sibling running', { timeout: 30000 }, async t => {
  const f = await endpoint(t);
  const first = f.launch('synthetic-phone-a');
  await f.until(() => f.calls.get('synthetic-phone-a')?.started, 'first synthetic call');
  const second = f.launch('synthetic-phone-b');
  await f.until(() => f.calls.has('synthetic-phone-b'), 'second synthetic call');
  const a = f.calls.get('synthetic-phone-a'), b = f.calls.get('synthetic-phone-b');
  // A shared session queues B behind A. Let the old implementation reach its
  // close/cancel behavior as well, instead of failing only on header equality.
  await f.until(() => a.session === b.session || b.started, 'independent dispatch');
  const overlapped = b.started && !a.finished;
  a.gate.resolve();
  const firstResult = await first.done;
  await f.until(() => f.closed.includes(a.session), 'first CLI session cleanup');
  const siblingSurvivedClose = !b.finished && !b.aborted;
  b.gate.resolve();
  const secondResult = await second.done;
  assert.equal(firstResult.code, 0, firstResult.stderr || firstResult.stdout);
  assert.equal(secondResult.code, 0, `Closing the first CLI aborted its sibling: ${secondResult.stderr || secondResult.stdout}`);
  assert.equal(siblingSurvivedClose, true, 'The sibling must remain pending after the first CLI closes');
  assert.equal(overlapped, true, 'Different default sessions must dispatch concurrently');
  assert.notEqual(a.session, b.session, 'One-shot CLI calls need unique default sessions');
  assert.deepEqual(JSON.parse(secondResult.stdout.trim()), { device: 'synthetic-phone-b', session: b.session, completed: true });
});

test('CLI preserves an intentionally supplied POKI_MCP_SESSION', { timeout: 20000 }, async t => {
  const f = await endpoint(t), expected = 'explicit-cli-session';
  const child = f.launch('synthetic-phone-explicit', expected);
  await f.until(() => f.calls.get('synthetic-phone-explicit')?.started, 'explicit-session call');
  f.calls.get('synthetic-phone-explicit').gate.resolve();
  const result = await child.done;
  await f.until(() => f.closed.includes(expected), 'explicit session cleanup');
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { device: 'synthetic-phone-explicit', session: expected, completed: true });
});
