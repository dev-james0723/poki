import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {runInNewContext} from 'node:vm';
import {SafariController, createWebDriverClient, safariCapabilities, safariDOMScripts} from '../src/safari-dom.mjs';
import {safariDefinitions} from '../src/safari-dom-schema.mjs';
import {work} from '../src/work.mjs';

const UDID = '00008000-0000000000000001';
const OTHER = '00008000-0000000000000002';
const ORIGIN = 'https://research.example';
const E = 'element-6066-11e4-a52e-4f735466cecf';
const args = {device: UDID, lease_id: 'lease-test'};
const node = (id, extra = {}) => ({
  element: {[E]: id}, tag: 'input', type: 'text', role: 'textbox',
  text: '', label: 'Destination', value: '', selector: '#destination',
  visible: true, enabled: true, editable: true, secure: false,
  bounds: {x: 20, y: 40, width: 180, height: 36}, ...extra,
});

async function fixture(t) {
  const state = {
    url: ORIGIN + '/search', document: 'document-1', nodes: [node('field')],
    calls: [], stops: 0, live: true, foreground: 'com.apple.mobilesafari',
    returnedUdid: UDID, useSimulator: false, revision: 0, now: 1000,
    loseMutation: false, actionError: null, queryDelay: 0, failAfterClick: false, clicked: false,
    partial: false, failValue: false, mutationDelay: 0,
  };
  const snapshot = () => ({
    url: state.url, origin: new URL(state.url).origin, title: 'Research fixture',
    document: {[E]: state.document}, ready_state: 'complete',
    complete: !state.partial, truncated: state.partial, total: state.nodes.length,
    nodes: state.nodes.map(n => ({...n})), text: 'Research fixture',
  });
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    state.calls.push({method: req.method, path: req.url, input});
    const send = (value, status = 200) => {
      if (res.destroyed) return;
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(JSON.stringify({value}));
    };
    if (req.method === 'POST' && req.url === '/session') {
      return send({sessionId: 'wd-session', capabilities: {
        browserName: 'Safari', platformName: 'iOS',
        'safari:deviceUDID': state.returnedUdid,
        'safari:useSimulator': state.useSimulator,
      }});
    }
    if (req.method === 'DELETE') return send(null);
    if (req.url.endsWith('/timeouts')) return send(null);
    if (req.url.endsWith('/url')) {
      if (req.method === 'POST') state.url = input.url;
      return send(req.method === 'GET' ? state.url : null);
    }
    if (req.url.endsWith('/execute/sync')) {
      const script = input.script;
      if (state.clicked && state.failAfterClick) return send({error: 'invalid session id', message: 'read lost'}, 404);
      if (script.includes('poki-dom:fill')) {
        if (state.loseMutation) { req.socket.destroy(); return; }
        const field = state.nodes.find(n => n.element[E] === input.args[0][E]);
        if (!field || field.secure || !field.editable || !field.enabled) return send({refused: 'field_not_editable'});
        field.value = state.failValue ? 'site changed this value' : input.args[2];
        if (state.mutationDelay) await new Promise(resolve => setTimeout(resolve, state.mutationDelay));
        return send({...snapshot(), node: {...field}, value: field.value, text_verified: field.value === input.args[2]});
      }
      if (script.includes('poki-dom:inspect')) {
        const field = state.nodes.find(n => n.element[E] === input.args[0][E]);
        return send({...snapshot(), node: field ? {...field} : null});
      }
      if (state.queryDelay) await new Promise(resolve => setTimeout(resolve, state.queryDelay));
      const result = snapshot();
      const query = input.args[0];
      if (query?.selector) {
        result.nodes = result.nodes.filter(n => n.selector === query.selector);
        result.total = result.nodes.length;
      }
      return send(result);
    }
    if (/\/element\/[^/]+\/click$/.test(req.url)) {
      if (state.loseMutation) { req.socket.destroy(); return; }
      if (state.actionError) return send({error: state.actionError, message: 'refused'}, 400);
      state.clicked = true;
      state.nodes = [node('result', {tag: 'div', type: '', role: 'status',
        label: 'Results', text: 'Two destinations', selector: '#results', editable: false})];
      return send(null);
    }
    send({error: 'unknown command', message: 'fixture route missing'}, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const base = 'http://127.0.0.1:' + server.address().port;
  const background = new Map();
  const ctx = {
    async target() {return {id: state.target ?? UDID, kind: state.kind ?? 'physical'};},
    coordinator: {
      require(owner, id) {
        if (!state.live || id !== args.lease_id) throw new Error('No active lease');
        return {lease_id: args.lease_id, device: UDID, owner};
      },
      revision() {return state.revision;},
    },
    changed() {state.revision++;},
    ownBackground(id, kind) {background.set(id, kind);},
    unownBackground(id) {background.delete(id);},
  };
  const controller = new SafariController(ctx, {
    now: () => state.now,
    gate: async expected => {
      if (expected && state.foreground !== expected) throw new Error('Safari is not the foreground app');
    },
    createDriver: async () => ({
      client: createWebDriverClient(base),
      stop: async () => {state.stops++;},
    }),
  });
  t.after(() => controller.close());
  const open = () => controller.call('safari_open', {...args, url: ORIGIN + '/search'});
  const bound = session => ({...args, session_id: session.session_id, expected_origin: ORIGIN});
  const observe = session => controller.call('safari_observe', bound(session));
  return {state, controller, ctx, background, open, bound, observe};
}

test('schemas expose six strict bounded tools and refuse arbitrary evaluation', () => {
  assert.deepEqual(safariDefinitions.map(d => d[0]), [
    'safari_open', 'safari_observe', 'safari_query', 'safari_wait_for', 'safari_act', 'safari_close',
  ]);
  for (const [, , schema] of safariDefinitions) assert.equal(schema.safeParse({script: 'arbitrary()'}).success, false);
  const open = safariDefinitions[0][2];
  assert.equal(open.safeParse({...args, url: 'file:///etc/passwd'}).success, false);
  assert.equal(open.safeParse({...args, url: ORIGIN, attach_owner_tabs: true}).success, false);
  const wait = safariDefinitions.find(d => d[0] === 'safari_wait_for')[2];
  assert.equal(wait.safeParse({...args, session_id: 's', expected_origin: ORIGIN,
    condition: {state: 'present', selector: '#r'}, timeout_ms: 60001}).success, false);
});

test('physical session is exact UDID, isolated, and registered as owned background work', async t => {
  const f = await fixture(t);
  assert.deepEqual(safariCapabilities({id: UDID, kind: 'physical'}), {
    browserName: 'Safari', platformName: 'iOS', 'safari:deviceUDID': UDID,
    'safari:useSimulator': false, pageLoadStrategy: 'eager',
  });
  const session = await f.open();
  assert.equal(session.isolated_session, true);
  assert.equal(session.owner_tabs, 'unsupported');
  assert.equal(session.device, UDID);
  assert.equal(session.ready, true);
  assert.ok(f.background.has(UDID));
  assert.equal(f.state.calls[0].input.capabilities.alwaysMatch['safari:deviceUDID'], UDID);
  assert.equal(f.state.calls.some(c => c.path.endsWith('/actions')), false);
});

test('missing lease, wrong physical target, and simulators are rejected before driver creation', async t => {
  const f = await fixture(t);
  f.state.live = false;
  await assert.rejects(f.open(), /lease/i);
  f.state.live = true; f.state.target = OTHER;
  await assert.rejects(f.open(), /device|lease/i);
  f.state.target = UDID; f.state.kind = 'simulator';
  await assert.rejects(f.open(), /physical/i);
  assert.equal(f.state.calls.length, 0);
});

test('unexpected or absent echoed identity closes only the new session before navigation', async t => {
  const f = await fixture(t);
  f.state.returnedUdid = OTHER;
  await assert.rejects(f.open(), /identity|UDID/i);
  assert.equal(f.state.calls.some(c => c.path.endsWith('/url')), false);
  assert.equal(f.state.calls.filter(c => c.method === 'DELETE').length, 1);
  assert.equal(f.state.stops, 1);
});

test('a DOM ref cannot cross device revision, origin, document, or its time limit', async t => {
  const f = await fixture(t), session = await f.open();
  const act = ref => f.controller.call('safari_act', {...f.bound(session),
    action: {kind: 'fill', ref, text: 'Osaka'}});
  let seen = await f.observe(session);
  f.state.revision++;
  await assert.rejects(act(seen.nodes[0].ref), /stale|revision/i);
  seen = await f.observe(session);
  f.state.now += 31000;
  await assert.rejects(act(seen.nodes[0].ref), /stale|expired/i);
  seen = await f.observe(session);
  f.state.document = 'document-2';
  await assert.rejects(act(seen.nodes[0].ref), /document|stale/i);
  seen = await f.observe(session);
  f.state.url = 'https://unexpected.example/';
  await assert.rejects(act(seen.nodes[0].ref), /origin/i);
  assert.equal(f.state.calls.filter(c => typeof c.input.script === 'string' && c.input.script.includes('poki-dom:fill')).length, 0);
});

test('foreground, active lease and secure-field refusals send no input', async t => {
  const f = await fixture(t), session = await f.open(), seen = await f.observe(session);
  const fill = () => f.controller.call('safari_act', {...f.bound(session),
    action: {kind: 'fill', ref: seen.nodes[0].ref, text: 'Kyoto'}});
  f.state.foreground = 'com.apple.mobilemail';
  await assert.rejects(fill(), /foreground/i);
  f.state.foreground = 'com.apple.mobilesafari'; f.state.live = false;
  await assert.rejects(fill(), /lease/i);
  f.state.live = true; f.state.nodes[0].secure = true;
  await assert.rejects(fill(), /secure|editable|changed/i);
  assert.equal(f.state.calls.filter(c => typeof c.input.script === 'string' && c.input.script.includes('poki-dom:fill')).length, 0);
});

test('draft fill verifies the live value and labels synthetic DOM input without claiming save', async t => {
  const f = await fixture(t), session = await f.open(), seen = await f.observe(session);
  const result = await f.controller.call('safari_act', {...f.bound(session),
    action: {kind: 'fill', ref: seen.nodes[0].ref, text: '大阪 😀'}});
  assert.equal(result.text_verified, true);
  assert.equal(result.method, 'dom_setter');
  assert.equal(result.trusted_input_events, false);
  assert.equal(result.submitted, false);
  assert.equal(result.application_success, false);
  assert.equal(f.state.nodes[0].value, '大阪 😀');
});

test('click is complete only after a positive DOM condition is observed', async t => {
  const f = await fixture(t); f.state.nodes = [node('go', {
    tag: 'button', type: 'button', role: 'button', text: 'Search', label: 'Search', editable: false,
  })];
  const session = await f.open(), seen = await f.observe(session);
  const result = await f.controller.call('safari_act', {...f.bound(session), action: {
    kind: 'click', ref: seen.nodes[0].ref,
    expect: {state: 'text', selector: '#results', text: 'Two destinations'},
  }});
  assert.equal(result.dispatched, true);
  assert.equal(result.condition_verified, true);
  assert.equal(result.outcome, 'verified');
  assert.equal(f.state.calls.filter(c => c.path.endsWith('/click')).length, 1);
});

test('ambiguous mutations fence later writes and are never automatically replayed', async t => {
  const f = await fixture(t), session = await f.open(), seen = await f.observe(session);
  f.state.loseMutation = true;
  const fill = () => f.controller.call('safari_act', {...f.bound(session),
    action: {kind: 'fill', ref: seen.nodes[0].ref, text: 'Sapporo'}});
  const lost = await fill();
  assert.equal(lost.outcome, 'unknown');
  assert.equal(lost.retry_allowed, false);
  await assert.rejects(fill(), /unknown|fenced/i);
  assert.equal(f.state.calls.filter(c => typeof c.input.script === 'string' && c.input.script.includes('poki-dom:fill')).length, 1);
});

test('wait observes complete absence, remains bounded and reacts to caller cancellation', async t => {
  const f = await fixture(t), session = await f.open();
  const wait = extra => f.controller.call('safari_wait_for', {...f.bound(session),
    condition: {state: 'absent', selector: '#loading'}, timeout_ms: 200, poll_ms: 50, ...extra});
  assert.equal((await wait()).matched, true);
  f.state.queryDelay = 1000;
  const timed = await wait();
  assert.equal(timed.matched, false);
  assert.equal(timed.stop_reason, 'timeout');
  const cancel = new AbortController();
  const running = work.run({signal: cancel.signal, timings: []},
    () => wait({timeout_ms: 3000}));
  setTimeout(() => cancel.abort(new DOMException('Stopped', 'AbortError')), 20);
  await assert.rejects(running, /Stopped|abort/i);
});

test('close accepts only the owning session and cleanup respects the selected device set', async t => {
  const f = await fixture(t), session = await f.open();
  await assert.rejects(f.controller.call('safari_close', {...args, session_id: 'foreign'}), /session/i);
  assert.deepEqual(await f.controller.close(new Set([OTHER])), []);
  assert.equal(f.state.stops, 0);
  const closed = await f.controller.call('safari_close', {...args, session_id: session.session_id});
  assert.equal(closed.closed, true);
  assert.equal(f.state.stops, 1);
  assert.equal(f.background.has(UDID), false);
  assert.equal(f.state.calls.filter(c => c.method === 'DELETE').length, 1);
});

test('a driver read failure after a successful click cannot erase its dispatch evidence', async t => {
  const f = await fixture(t); f.state.failAfterClick = true;
  f.state.nodes = [node('go', {tag: 'button', type: 'button', role: 'button', editable: false})];
  const session = await f.open(), seen = await f.observe(session);
  const action = {...f.bound(session), action: {kind: 'click', ref: seen.nodes[0].ref,
    expect: {state: 'present', selector: '#results'}}};
  const result = await f.controller.call('safari_act', action);
  assert.equal(result.outcome, 'unknown');
  assert.notEqual(result.dispatched, false);
  await assert.rejects(f.controller.call('safari_act', action), /fenced|unknown/i);
  assert.equal(f.state.calls.filter(c => c.path.endsWith('/click')).length, 1);
});

test('missing echoed UDID or a simulator echo never navigates or switches to a default phone', async t => {
  const f = await fixture(t);
  f.state.returnedUdid = undefined;
  await assert.rejects(f.open(), /identity|UDID/);
  f.state.returnedUdid = UDID; f.state.useSimulator = true;
  await assert.rejects(f.open(), /identity|UDID/);
  assert.equal(f.state.calls.filter(c => c.path.endsWith('/url')).length, 0);
  assert.equal(f.state.stops, 2);
});

test('incomplete scans cannot prove absence and unverified field effects fence writes', async t => {
  const f = await fixture(t), session = await f.open();
  f.state.partial = true;
  const wait = await f.controller.call('safari_wait_for', {...f.bound(session),
    condition: {state: 'absent', selector: '#loading'}, timeout_ms: 100, poll_ms: 50});
  assert.equal(wait.matched, false);
  assert.equal(wait.stop_reason, 'timeout');
  f.state.partial = false;
  const seen = await f.observe(session);
  f.state.failValue = true;
  const action = {...f.bound(session), action: {kind: 'fill', ref: seen.nodes[0].ref, text: 'Tokyo'}};
  const failed = await f.controller.call('safari_act', action);
  assert.equal(failed.outcome, 'unknown');
  assert.equal(failed.retry_allowed, false);
  await assert.rejects(f.controller.call('safari_act', action), /unknown|fenced/);
});

test('transport rejects non-loopback origins and bounds malformed/oversized responses', async () => {
  assert.throws(() => createWebDriverClient('https://remote.example'), /loopback/);
  assert.throws(() => createWebDriverClient('http://127.0.0.1:9000/path'), /loopback/);
  const huge = createWebDriverClient('http://127.0.0.1:9000',
    async () => new Response('x'.repeat(600000)));
  await assert.rejects(huge.request('GET', '/status'), /complete result/);
  const malformed = createWebDriverClient('http://127.0.0.1:9000',
    async () => new Response('not JSON'));
  await assert.rejects(malformed.request('POST', '/session', {}, {mutation: true}),
    error => error.outcome === 'unknown');
});

function scriptFixture() {
  const events = [];
  class Input {
    constructor(id, type = 'text', hidden = false) {
      this.id = id; this.type = type; this.localName = 'input'; this.nodeType = 1;
      this.isConnected = true; this.labels = []; this.innerText = ''; this._value = '';
      this.hiddenForTest = hidden; this.disabled = false; this.readOnly = false;
    }
    get value() {return this._value;}
    set value(value) {this._value = String(value);}
    closest() {return null;}
    matches() {return this.disabled;}
    getAttribute(name) {return name === 'aria-label' ? this.id : null;}
    hasAttribute() {return false;}
    getBoundingClientRect() {
      return {x: 10, y: 20, left: 10, top: 20, right: 210, bottom: 60,
        width: this.hiddenForTest ? 0 : 200, height: 40};
    }
    dispatchEvent(event) {events.push(event); return true;}
  }
  const field = new Input('destination'), password = new Input('password', 'password');
  password.value = 'must-not-leak';
  const hidden = new Input('hidden', 'text', true); hidden.value = 'hidden-value';
  const elements = [field, password, hidden], root = {};
  const context = {
    document: {
      documentElement: root, readyState: 'complete', title: 'Fixture',
      body: {innerText: 'Public research'},
      querySelectorAll(selector) {
        if (selector.startsWith('#')) return elements.filter(element => '#' + element.id === selector);
        return elements;
      },
    },
    location: {href: ORIGIN + '/search', origin: ORIGIN},
    innerWidth: 400, innerHeight: 800, CSS: {escape: value => value},
    getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: '1'}),
    HTMLInputElement: Input, HTMLTextAreaElement: Input,
    Event: class {constructor(type, options) {this.type = type; this.bubbles = options.bubbles; this.isTrusted = false;}},
  };
  const execute = (script, input) => runInNewContext('(function(){' + script + '}).apply(null, __args)',
    {...context, __args: input});
  const expected = node => ({
    root, url: context.location.href, origin: ORIGIN,
    fingerprint: JSON.stringify([node.tag,node.type,node.role,node.label,node.text,
      node.value,node.secure,node.editable,node.href,node.target,node.download]),
  });
  return {execute, field, password, events, context, expected};
}

test('the actual fixed browser scripts omit secret/hidden values and bound query projections', () => {
  const f = scriptFixture();
  const snapshot = f.execute(safariDOMScripts.observe, [{max_nodes: 10, max_text_chars: 6}]);
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.nodes[0].value, '');
  assert.equal(Object.hasOwn(snapshot.nodes[1], 'value'), false);
  assert.equal(snapshot.text, 'Public');
  assert.equal(snapshot.text_truncated, true);
  assert.doesNotMatch(JSON.stringify(snapshot.nodes.map(({element, ...node}) => node)), /must-not-leak|hidden-value/);
  const projected = f.execute(safariDOMScripts.observe, [{max_nodes: 1, max_text_chars: 0}]);
  assert.equal(projected.total, 2);
  assert.equal(projected.truncated, true);
  const absent = f.execute(safariDOMScripts.observe, [{selector: '#missing', max_nodes: 1, max_text_chars: 0}]);
  assert.equal(absent.total, 0);
  assert.equal(absent.complete, true);
});

test('the actual fixed fill script treats caller text as data and emits no keyboard/submit event', () => {
  const f = scriptFixture();
  const seen = f.execute(safariDOMScripts.observe, [{selector: '#destination', max_nodes: 1, max_text_chars: 0}]);
  const expected = f.expected(seen.nodes[0]);
  const text = '大阪 😀 "; throw new Error("must stay data")';
  const filled = f.execute(safariDOMScripts.fill, [f.field, expected, text]);
  assert.equal(filled.text_verified, true);
  assert.equal(f.field.value, text);
  assert.deepEqual(f.events.map(event => event.type), ['input', 'change']);
  assert.equal(f.events.every(event => event.isTrusted === false), true);
  const fresh = f.execute(safariDOMScripts.observe, [{selector: '#destination', max_nodes: 1, max_text_chars: 0}]);
  const refused = f.execute(safariDOMScripts.fill, [f.field, f.expected(fresh.nodes[0]), 'line\nbreak']);
  assert.equal(refused.refused, 'field_not_editable');
  assert.equal(f.field.value, text);
  f.context.location.origin = 'https://changed.example';
  const redirected = f.execute(safariDOMScripts.fill, [f.field, expected, 'wrong page']);
  assert.equal(redirected.refused, 'document_or_origin_changed');
  assert.equal(f.field.value, text);
});

test('explicit device arguments and foreign session IDs cannot reuse an owned session', async t => {
  const f = await fixture(t), session = await f.open();
  await assert.rejects(f.controller.call('safari_observe', {...f.bound(session), device: OTHER}), /exact device|UDID/);
  const foreign = await fixture(t);
  await assert.rejects(foreign.controller.call('safari_observe', f.bound(session)), /owned Safari session/);
  assert.equal(foreign.state.calls.length, 0);
});

for (const mode of ['timeout', 'cancel']) test('a ' + mode + ' after field mutation remains unknown without replay', async t => {
  const f = await fixture(t), session = await f.open(), seen = await f.observe(session);
  f.state.mutationDelay = 250;
  const cancel = new AbortController();
  const action = {...f.bound(session), timeout_ms: mode === 'timeout' ? 100 : 2000,
    action: {kind: 'fill', ref: seen.nodes[0].ref, text: 'Already reached the field'}};
  const pending = work.run({signal: cancel.signal, timings: []},
    () => f.controller.call('safari_act', action));
  if (mode === 'cancel') setTimeout(() => cancel.abort(new DOMException('Stopped', 'AbortError')), 25);
  const result = await pending;
  assert.equal(f.state.nodes[0].value, action.action.text);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.retry_allowed, false);
  assert.equal(result.stop_reason, mode === 'cancel' ? 'cancelled' : 'timeout');
  await assert.rejects(f.controller.call('safari_act', action), /unknown|fenced/);
  assert.equal(f.state.calls.filter(c => typeof c.input.script === 'string' &&
    c.input.script.includes('poki-dom:fill')).length, 1);
});

test('a known intercepted click is not sent and does not trigger an automatic retry', async t => {
  const f = await fixture(t);
  f.state.nodes = [node('go', {tag: 'button', type: 'button', role: 'button', editable: false})];
  const session = await f.open(), seen = await f.observe(session);
  f.state.actionError = 'element click intercepted';
  const result = await f.controller.call('safari_act', {...f.bound(session),
    action: {kind: 'click', ref: seen.nodes[0].ref, expect: {state: 'present', selector: '#results'}}});
  assert.equal(result.outcome, 'not_sent');
  assert.equal(result.dispatched, false);
  assert.equal(f.state.calls.filter(c => c.path.endsWith('/click')).length, 1);
});
