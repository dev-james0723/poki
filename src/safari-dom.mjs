import {spawn, execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {safariDefinitions} from './safari-dom-schema.mjs';
import {checkWork, deadline, pause, phase, remainingMs, signal, work} from './work.mjs';
import {promptWarning} from './interaction.mjs';

const E = 'element-6066-11e4-a52e-4f735466cecf';
const SAFARI = 'com.apple.mobilesafari';
const REF_MS = 30000;
const MAX_REPLY = 512 * 1024;
const SETUP = 'Safari DOM needs macOS SafariDriver, an unlocked trusted physical iPhone discoverable by this Mac, and Remote Automation enabled in Safari on both devices. Poki does not enable it or change device settings automatically.';
const schemas = new Map(safariDefinitions.map(([name, , schema]) => [name, schema]));
export const safariTools = new Set(schemas.keys());
const controllers = new WeakMap();
const exec = promisify(execFile);
const notSentErrors = new Set(['invalid argument', 'invalid session id', 'no such element',
  'no such window', 'stale element reference', 'element click intercepted', 'element not interactable']);

class DriverError extends Error {
  constructor(message, code, outcome, cause) {
    super(message, {cause}); this.name = 'SafariDriverError'; this.code = code; this.outcome = outcome;
  }
}

export function safariCapabilities(target) {
  if (target.kind !== 'physical' || !/^[a-f0-9-]{20,64}$/i.test(target.id ?? ''))
    throw new Error('Safari DOM requires an exact physical iPhone UDID; simulators and aliases are not driver identities.');
  return {browserName: 'Safari', platformName: 'iOS', 'safari:deviceUDID': target.id,
    'safari:useSimulator': false, pageLoadStrategy: 'eager'};
}

// A closed loopback transport. No tool argument can choose a WebDriver server,
// execute arbitrary JS, enable diagnostics or reach an owner's existing session.
export function createWebDriverClient(base, fetchImpl = fetch) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('SafariDriver transport must be an owned loopback HTTP origin.');
  return {
    async request(method, path, body, {mutation = false, timeout_ms = 8000} = {}) {
      checkWork();
      if (!/^\/(?:status|session(?:\/[A-Za-z0-9_.~%-]+)*(?:\/[A-Za-z0-9_.~%-]+)*)$/.test(path))
        throw new Error('Invalid internal SafariDriver route.');
      const local = AbortSignal.timeout(remainingMs(timeout_ms));
      const combined = signal() ? AbortSignal.any([signal(), local]) : local;
      try {
        const response = await fetchImpl(new URL(path, origin), {
          method, signal: combined, redirect: 'error',
          headers: {'content-type': 'application/json'},
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
        const reader = response.body?.getReader();
        const chunks = []; let size = 0;
        if (!reader) throw new Error('Missing SafariDriver response.');
        try {
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_REPLY) { await reader.cancel(); throw new Error('SafariDriver response exceeded its bound.'); }
            chunks.push(Buffer.from(value));
          }
        } finally {reader.releaseLock();}
        let parsed;
        try {parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));}
        catch {throw new Error('Malformed SafariDriver response.');}
        if (!Object.hasOwn(parsed, 'value')) throw new Error('SafariDriver response has no W3C value.');
        if (!response.ok || parsed.value?.error) {
          const code = typeof parsed.value?.error === 'string' ? parsed.value.error.slice(0, 100) : 'driver error';
          const detail = path === '/session' && typeof parsed.value?.message === 'string'
            ? ': ' + parsed.value.message.slice(0, 600) : '';
          throw new DriverError('SafariDriver ' + code + detail, code,
            mutation && !notSentErrors.has(code) ? 'unknown' : 'not_sent');
        }
        return parsed.value;
      } catch (error) {
        if (error instanceof DriverError) throw error;
        if (!mutation && combined.aborted) throw combined.reason;
        const refused = error?.cause?.code === 'ECONNREFUSED';
        throw new DriverError(combined.aborted ? 'SafariDriver request stopped before its result was known.'
          : 'SafariDriver connection did not return a complete result.',
        combined.aborted ? 'request stopped' : 'connection failed',
        mutation && !refused ? 'unknown' : 'not_sent', error);
      }
    },
  };
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startSafariDriver() {
  if (process.platform !== 'darwin') throw new Error(SETUP);
  let binary;
  for (const candidate of ['/usr/bin/safaridriver', '/System/Cryptexes/App/usr/bin/safaridriver']) {
    try {await access(candidate, constants.X_OK); binary = candidate; break;} catch {}
  }
  if (!binary) throw new Error('SafariDriver executable is unavailable. ' + SETUP);
  const port = await reservePort();
  checkWork();
  const child = spawn(binary, ['--port', String(port)], {stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '', closed = false, spawnError;
  const exited = new Promise(resolve => {
    child.once('error', error => {spawnError = error; closed = true; resolve();});
    child.once('close', () => {closed = true; resolve();});
  });
  child.stderr.on('data', bytes => {stderr = (stderr + bytes.toString('utf8')).slice(-2048);});
  let stopping;
  const stop = () => stopping ??= (async () => {
    if (!closed) child.kill('SIGTERM');
    let timer;
    await Promise.race([exited, new Promise(resolve => {timer = setTimeout(resolve, 1000);})]);
    clearTimeout(timer);
    if (!closed) child.kill('SIGKILL');
    await exited;
    return {stopped: true};
  })();
  const client = createWebDriverClient('http://127.0.0.1:' + port);
  try {
    const until = performance.now() + Math.min(5000, remainingMs(5000));
    while (performance.now() < until) {
      checkWork();
      if (closed) throw new Error('SafariDriver exited before readiness' + (spawnError ? ': ' + spawnError.code : '') +
        (stderr ? ': ' + stderr.replace(/[\r\n]+/g, ' ').slice(0, 500) : '') + '. ' + SETUP);
      // Port reservation alone has a race. Confirm the listener belongs to this
      // exact child and is loopback before sending even a session-creation request.
      let listing = '';
      try {
        listing = (await exec('/usr/sbin/lsof',
          ['-nP', '-a', '-p', String(child.pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fpn'],
          {encoding: 'utf8', timeout: 500, maxBuffer: 4096})).stdout;
      } catch {}
      const addresses = listing.split('\n').filter(line => line.startsWith('n'));
      if (listing.split('\n').includes('p' + child.pid) && addresses.length &&
          addresses.every(line => /^n(?:127\.0\.0\.1|\[?::1\]?):\d+$/.test(line))) {
        await client.request('GET', '/status', undefined, {timeout_ms: 1000});
        if (closed) throw new Error('Owned SafariDriver exited during readiness. ' + SETUP);
        return {client, stop};
      }
      await pause(80);
    }
    throw new Error('Could not verify an owned loopback SafariDriver listener. ' + SETUP);
  } catch (error) {await stop(); throw error;}
}

// These functions run as fixed WebDriver scripts. Caller strings are arguments,
// never interpolated source. DOM elements are returned as W3C element references.
function domHelpers() {
  const clip = (text, max = 1600) => String(text ?? '').slice(0, max);
  const visible = element => {
    if (!element?.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
      Number(style.opacity) !== 0 && box.width > 0 && box.height > 0 &&
      box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight;
  };
  const selectorFor = element => {
    if (element.id) {
      const selected = '#' + CSS.escape(element.id);
      if (document.querySelectorAll(selected).length === 1) return selected;
    }
    const parts = [];
    for (let current = element; current?.nodeType === 1 && parts.length < 8; current = current.parentElement) {
      const tag = current.localName;
      let nth = 1;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling)
        if (sibling.localName === tag) nth++;
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      const selected = parts.join(' > ');
      if (document.querySelectorAll(selected).length === 1) return clip(selected, 500);
    }
    return null;
  };
  const describe = element => {
    const box = element.getBoundingClientRect(), tag = element.localName;
    const type = tag === 'input' ? element.type : tag === 'button' ? element.type : '';
    const secure = type === 'password';
    const enabled = !element.disabled && !element.matches(':disabled') &&
      element.getAttribute('aria-disabled') !== 'true';
    const text = element.innerText ?? element.textContent ?? '';
    const value = !secure && type !== 'file' && ['input', 'textarea', 'select'].includes(tag)
      ? String(element.value ?? '') : undefined;
    return {
      element, tag, type, secure, enabled, visible: visible(element),
      editable: enabled && !element.readOnly && (tag === 'textarea' ||
        tag === 'input' && ['text', 'search', 'email', 'url', 'tel', 'number'].includes(type)),
      role: clip(element.getAttribute('role') || ({a:'link',button:'button',textarea:'textbox',
        input:'textbox',select:'combobox'}[tag] ?? tag), 80),
      label: clip(element.getAttribute('aria-label') || [...(element.labels ?? [])].map(n => n.innerText).join(' ') ||
        element.getAttribute('placeholder') || text, 500),
      text: clip(text), text_truncated: text.length > 1600,
      ...(value === undefined ? {} : {value: clip(value, 10000), value_truncated: value.length > 10000}),
      selector: selectorFor(element), href: tag === 'a' ? clip(element.href, 4096) : undefined,
      target: tag === 'a' ? clip(element.target, 80) : undefined,
      download: tag === 'a' && element.hasAttribute('download'),
      bounds: {x: box.x, y: box.y, width: box.width, height: box.height},
    };
  };
  const meta = () => ({url: location.href, origin: location.origin, title: clip(document.title, 500),
    document: document.documentElement, ready_state: document.readyState});
  const fingerprint = node => JSON.stringify([node.tag,node.type,node.role,node.label,node.text,
    node.value,node.secure,node.editable,node.href,node.target,node.download]);
  const guard = (element, expected) => {
    if (location.origin !== expected.origin || location.href !== expected.url ||
        document.documentElement !== expected.root) return 'document_or_origin_changed';
    if (!element?.isConnected) return 'element_detached';
    const node = describe(element);
    if (!node.visible || !node.enabled) return 'element_not_interactable';
    if (fingerprint(node) !== expected.fingerprint) return 'element_changed';
    return null;
  };
  return {clip, visible, describe, meta, fingerprint, guard};
}
function observeDOM(options, h) {
  const selected = document.querySelectorAll(options.selector ||
    'a,button,input,textarea,select,[role],h1,h2,h3,p,li,td,th');
  const nodes = []; let total = 0;
  const bound = Math.min(selected.length, 5000);
  for (let i = 0; i < bound; i++) {
    if (!h.visible(selected[i])) continue;
    total++;
    if (nodes.length < options.max_nodes) nodes.push(h.describe(selected[i]));
  }
  const rawText = options.selector ? '' : (document.body?.innerText ?? '');
  return {...h.meta(), nodes, total, complete: selected.length <= 5000,
    truncated: total > nodes.length || selected.length > 5000,
    text: h.clip(rawText, options.max_text_chars), text_truncated: rawText.length > options.max_text_chars,
    scope: 'top_level_visible_dom', excluded: ['frames', 'shadow_roots', 'owner_tabs']};
}
function inspectDOM(element, expected, h) {
  const refused = h.guard(element, expected);
  return {...h.meta(), node: refused ? null : h.describe(element), ...(refused ? {refused} : {})};
}
function fillDOM(element, expected, text, h) {
  const refused = h.guard(element, expected);
  if (refused) return {refused};
  const before = h.describe(element);
  if (!before.editable || before.secure || before.value_truncated ||
      before.tag !== 'textarea' && /[\r\n]/.test(text)) return {refused: 'field_not_editable'};
  const prototype = before.tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) return {refused: 'native_value_setter_unavailable'};
  setter.call(element, text);
  element.dispatchEvent(new Event('input', {bubbles: true}));
  element.dispatchEvent(new Event('change', {bubbles: true}));
  const node = h.describe(element);
  return {...h.meta(), node, value: node.value, text_verified: node.value === text &&
    !node.value_truncated && location.origin === expected.origin &&
    location.href === expected.url && document.documentElement === expected.root};
}
const helpers = '(' + domHelpers.toString() + ')()';
export const safariDOMScripts = Object.freeze({
  observe: '/* poki-dom:observe */ return (' + observeDOM.toString() + ')(arguments[0], ' + helpers + ');',
  inspect: '/* poki-dom:inspect */ return (' + inspectDOM.toString() + ')(arguments[0], arguments[1], ' + helpers + ');',
  fill: '/* poki-dom:fill */ return (' + fillDOM.toString() + ')(arguments[0], arguments[1], arguments[2], ' + helpers + ');',
});
const fingerprint = node => JSON.stringify([node.tag,node.type,node.role,node.label,node.text,
  node.value,node.secure,node.editable,node.href,node.target,node.download]);
const elementId = value => typeof value?.[E] === 'string' && value[E].length <= 512 ? value[E] : null;
const encoded = value => encodeURIComponent(value);
const originOf = value => {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Safari DOM encountered an unsupported URL.');
  return url.origin;
};

async function nativeGate(ctx, expected) {
  // The existing native path is also the availability/privacy/prompt gate.
  // A different DOM transport must not make a paused/unreadable phone writable.
  const seen = await ctx.structure(0, {forInput: true});
  if (!seen?.liveRead || !seen.rootVerified || !seen.foreground ||
      promptWarning(seen.elements ?? []))
    throw new Error('Safari DOM requires a fresh readable phone state without a blocking native prompt.');
  if (expected && seen.foreground.bundle_id !== expected)
    throw new Error('Safari is not the verified foreground app. No DOM input was dispatched.');
}

export class SafariController {
  constructor(ctx, {createDriver = startSafariDriver, gate = expected => nativeGate(ctx, expected),
    now = Date.now} = {}) {
    this.ctx = ctx; this.createDriver = createDriver; this.gate = gate; this.now = now;
    this.sessions = new Map();
  }
  async owner(args) {
    checkWork();
    const lease = this.ctx.coordinator.require(this.ctx, args.lease_id);
    const target = await this.ctx.target();
    if (lease.device !== target.id) throw new Error('Safari session device does not match the active device lease.');
    if (args.device !== target.id)
      throw new Error('Safari tools require the exact device UDID returned by acquire_device; aliases are not accepted.');
    safariCapabilities(target);
    return target;
  }
  active(args, target) {
    const session = this.sessions.get(args.session_id);
    if (!session || session.device !== target.id || session.lease_id !== args.lease_id || session.closing)
      throw new Error('No owned Safari session matches this device and lease.');
    return session;
  }
  async call(name, original) {
    if (!work.getStore()?.timings || !work.getStore()?.signal)
      return work.run({...work.getStore(), signal: signal() ?? new AbortController().signal,
        timings: work.getStore()?.timings ?? []}, () => this.call(name, original));
    const schema = schemas.get(name);
    if (!schema) throw new Error('Unknown Safari DOM tool.');
    const args = schema.parse(original);
    const target = await this.owner(args);
    if (name === 'safari_open') return deadline(args.timeout_ms, () => this.open(target, args));
    const session = this.active(args, target);
    if (name === 'safari_close') return this.closeOne(session);
    if (!session.allowed.has(args.expected_origin)) throw new Error('Expected origin is outside this Safari session scope.');
    if (name === 'safari_act' && session.fenced)
      throw new Error('Safari writes are fenced after an unknown outcome. Inspect the state and explicitly close this session; do not replay the action.');
    if (name === 'safari_wait_for') return this.wait(session, args, true);
    return deadline(name === 'safari_act' ? args.timeout_ms : 10000, async () => {
      await this.gate(SAFARI);
      return name === 'safari_act' ? this.act(session, target, args) : this.observe(session, args);
    });
  }
  async open(target, args) {
    if ([...this.sessions.values()].some(session => session.device === target.id))
      throw new Error('This caller already owns a Safari session on this device. Close it explicitly before opening another.');
    const allowed = new Set(args.allowed_origins ?? [originOf(args.url)]);
    if (!allowed.has(originOf(args.url))) throw new Error('Opening URL is outside allowed_origins.');
    await this.gate();
    this.ctx.coordinator.require(this.ctx, args.lease_id);
    const driver = await phase('safari_driver_start', () => this.createDriver());
    const session = {id: randomUUID(), device: target.id, lease_id: args.lease_id, driver,
      allowed, refs: new Map(), fenced: false, wd: null};
    this.sessions.set(session.id, session);
    this.ctx.ownBackground(target.id, 'safari');
    let navigationStarted = false;
    try {
      const created = await driver.client.request('POST', '/session',
        {capabilities: {alwaysMatch: safariCapabilities(target)}}, {mutation: true, timeout_ms: 12000});
      if (typeof created?.sessionId !== 'string' || !created.sessionId || created.sessionId.length > 200)
        throw new Error('SafariDriver returned an invalid session identity.');
      session.wd = created.sessionId;
      const caps = created.capabilities;
      if (String(caps?.browserName).toLowerCase() !== 'safari' ||
          String(caps?.platformName).toLowerCase() !== 'ios' ||
          String(caps?.['safari:deviceUDID']).toLowerCase() !== target.id.toLowerCase() ||
          caps?.['safari:useSimulator'] !== false)
        throw new Error('SafariDriver identity did not echo the exact physical iPhone UDID; refusing navigation.');
      await this.request(session, 'POST', '/timeouts', {implicit: 0, script: 5000, pageLoad: 15000});
      this.ctx.coordinator.require(this.ctx, args.lease_id);
      this.ctx.changed(target);
      navigationStarted = true;
      await this.request(session, 'POST', '/url', {url: args.url}, {mutation: true, timeout_ms: 15000});
      const observation = await this.observe(session, {
        ...args, expected_origin: null, max_nodes: 30, max_text_chars: 2000,
      });
      return {...this.receipt(session), ready: true, origin: observation.origin, observation,
        readiness: 'live_isolated_session_verified', prerequisites: SETUP};
    } catch (error) {
      const cleanup = await this.closeOne(session);
      if (navigationStarted || error?.outcome === 'unknown')
        return {...this.receipt(session), ready: false, outcome: 'unknown', retry_allowed: false,
          session_closed: cleanup.closed, cleanup, error: error.message, prerequisites: SETUP};
      throw new Error(error.message + ' ' + SETUP);
    }
  }
  receipt(session) {
    return {backend: 'safaridriver_w3c', device: session.device, session_id: session.id,
      isolated_session: true, owner_tabs: 'unsupported', owner_cookies_reused: false};
  }
  request(session, method, path, body, options) {
    if (!session.wd) throw new Error('Safari session is not established.');
    return phase('safari_webdriver', () => session.driver.client.request(method,
      '/session/' + encoded(session.wd) + path, body, options));
  }
  checkSnapshot(session, snapshot, expectedOrigin) {
    if (!snapshot || typeof snapshot.url !== 'string' || !elementId(snapshot.document))
      throw new Error('Safari returned an incomplete document identity.');
    const origin = originOf(snapshot.url);
    if (origin !== snapshot.origin || !session.allowed.has(origin) ||
        expectedOrigin && origin !== expectedOrigin)
      throw new Error('Safari origin changed or is outside the expected origin scope.');
    return origin;
  }
  publish(session, snapshot, expectedOrigin) {
    const origin = this.checkSnapshot(session, snapshot, expectedOrigin);
    if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length > 100)
      throw new Error('Safari returned invalid bounded DOM nodes.');
    session.refs.clear();
    const at = this.now(), revision = this.ctx.coordinator.revision(session.device);
    const nodes = snapshot.nodes.map(raw => {
      const {element, value, ...safe} = raw;
      const node = {...safe, ...(!raw.secure && value !== undefined ? {value} : {})};
      if (elementId(element) && raw.visible && raw.enabled && !raw.value_truncated) {
        const ref = randomUUID();
        session.refs.set(ref, {element, fingerprint: fingerprint(raw), at, revision,
          root: snapshot.document, url: snapshot.url, origin});
        node.ref = ref;
      }
      return node;
    });
    return {...this.receipt(session), source: 'live_dom', captured_at: new Date(at).toISOString(),
      revision, origin, url: snapshot.url, title: snapshot.title, ready_state: snapshot.ready_state,
      document_scope: 'top_level_document', complete: snapshot.complete === true,
      truncated: snapshot.truncated === true, total: snapshot.total, nodes,
      text: snapshot.text ?? '', text_truncated: snapshot.text_truncated === true,
      excluded: ['frames', 'shadow_roots', 'owner_tabs'], refs_expire_after_ms: REF_MS};
  }
  async observe(session, args) {
    this.ctx.coordinator.require(this.ctx, args.lease_id);
    const snapshot = await this.request(session, 'POST', '/execute/sync', {
      script: safariDOMScripts.observe,
      args: [{selector: args.selector, max_nodes: args.max_nodes ?? 50, max_text_chars: args.max_text_chars ?? 6000}],
    });
    checkWork();
    this.ctx.coordinator.require(this.ctx, args.lease_id);
    return this.publish(session, snapshot, args.expected_origin);
  }
  matches(observation, condition) {
    const nodes = observation.nodes;
    if (condition.state === 'absent') return observation.complete && !observation.truncated &&
      observation.ready_state === 'complete' && observation.total === 0;
    if (condition.state === 'present') return nodes.length > 0;
    if (condition.state === 'unique') return observation.complete && !observation.truncated && observation.total === 1;
    if (condition.state === 'enabled') return nodes.some(node => node.enabled);
    if (condition.state === 'text') return nodes.some(node => !node.text_truncated && node.text === condition.text);
    if (condition.state === 'value') return observation.complete && !observation.truncated &&
      observation.total === 1 && !nodes[0]?.secure && !nodes[0]?.value_truncated && nodes[0]?.value === condition.text;
    return false;
  }
  async wait(session, args, checkNative = false) {
    const started = performance.now(); let attempts = 0, last;
    const outer = signal();
    try {
      return await deadline(args.timeout_ms, async () => {
        if (checkNative) await this.gate(SAFARI);
        for (;;) {
          checkWork();
          attempts++;
          last = await this.observe(session, {...args, selector: args.condition.selector,
            max_nodes: 50, max_text_chars: 0});
          if (this.matches(last, args.condition))
            return {matched: true, attempts, elapsed_ms: Math.round(performance.now() - started),
              stop_reason: 'matched', observation: last};
          await pause(Math.min(args.poll_ms ?? 200, remainingMs(args.poll_ms ?? 200)));
        }
      });
    } catch (error) {
      if (outer?.aborted) throw outer.reason;
      if (error.name !== 'TimeoutError') throw error;
      return {matched: false, attempts, elapsed_ms: Math.round(performance.now() - started),
        stop_reason: 'timeout', ...(last ? {last_observation: last} : {})};
    }
  }
  async act(session, target, args) {
    const ref = session.refs.get(args.action.ref);
    if (!ref || this.now() - ref.at > REF_MS || this.now() < ref.at ||
        ref.revision !== this.ctx.coordinator.revision(target.id))
      throw new Error('DOM ref is stale, expired or from a different device revision. Observe again before acting.');
    if (ref.origin !== args.expected_origin) throw new Error('DOM ref origin differs from expected_origin.');
    const expected = {origin: ref.origin, url: ref.url, root: ref.root, fingerprint: ref.fingerprint};
    const before = await this.request(session, 'POST', '/execute/sync',
      {script: safariDOMScripts.inspect, args: [ref.element, expected]});
    this.checkSnapshot(session, before, args.expected_origin);
    if (elementId(before.document) !== elementId(ref.root) || before.url !== ref.url ||
        before.refused || !before.node || fingerprint(before.node) !== ref.fingerprint)
      throw new Error('DOM document or element changed after observation. Observe again; no input was sent.');
    const node = before.node;
    if (!node.visible || !node.enabled || node.secure || node.value_truncated)
      throw new Error('DOM element is hidden, disabled, secure or incomplete; no input was sent.');
    if (args.action.kind === 'fill' && (!node.editable || node.tag !== 'textarea' && /[\r\n]/.test(args.action.text)))
      throw new Error('DOM field is not editable or would require a line break in a single-line field; no input was sent.');
    if (args.action.kind === 'click' && node.tag === 'a' &&
        (!node.href || !session.allowed.has(originOf(node.href)) || node.download ||
          node.target && node.target !== '_self'))
      throw new Error('Link leaves the allowed origin or opens a download/new context; no click was sent.');
    this.ctx.coordinator.require(this.ctx, args.lease_id);
    if (ref.revision !== this.ctx.coordinator.revision(target.id))
      throw new Error('Device revision changed before DOM input.');
    checkWork();
    this.ctx.changed(target);
    session.refs.clear(); session.fenced = true;
    let actionAcknowledged = false;
    try {
      return await deadline(args.timeout_ms, async () => {
        if (args.action.kind === 'fill') {
          const result = await this.request(session, 'POST', '/execute/sync', {
            script: safariDOMScripts.fill, args: [ref.element, expected, args.action.text],
          }, {mutation: true});
          if (result?.refused) {
            session.fenced = false;
            return {...this.receipt(session), outcome: 'not_sent', dispatched: false,
              reason: String(result.refused).slice(0, 100), retry_allowed: false};
          }
          actionAcknowledged = true;
          this.checkSnapshot(session, result, args.expected_origin);
          if (!result.text_verified || result.value !== args.action.text ||
              elementId(result.document) !== elementId(ref.root) || result.url !== ref.url)
            throw new Error('Live DOM field value was not verified after dispatch.');
          session.fenced = false;
          return {...this.receipt(session), outcome: 'verified', dispatched: true,
            text_verified: true, method: 'dom_setter', trusted_input_events: false,
            submitted: false, submit_requested: false, application_success: false,
            site_event_handlers_may_run: true, evidence_scope: 'live_field_value_only',
            captured_at: new Date(this.now()).toISOString()};
        }
        await this.request(session, 'POST', '/element/' + encoded(elementId(ref.element)) + '/click',
          {}, {mutation: true});
        actionAcknowledged = true;
        const proof = await this.wait(session, {...args, condition: args.action.expect,
          timeout_ms: remainingMs(args.timeout_ms), poll_ms: 200});
        if (!proof.matched) return {...this.receipt(session), outcome: 'unknown',
          dispatched: true, condition_verified: false, retry_allowed: false, stop_reason: proof.stop_reason};
        session.fenced = false;
        return {...this.receipt(session), outcome: 'verified', dispatched: true,
          condition_verified: true, evidence_scope: 'requested_dom_condition', observation: proof.observation};
      });
    } catch (error) {
      if (!actionAcknowledged && error instanceof DriverError && error.outcome === 'not_sent') {
        session.fenced = false;
        return {...this.receipt(session), outcome: 'not_sent', dispatched: false,
          retry_allowed: false, error: error.message};
      }
      return {...this.receipt(session), outcome: 'unknown', retry_allowed: false,
        ...(actionAcknowledged ? {dispatched: true} : {}),
        condition_verified: false, error: error.message,
        stop_reason: error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError'
          ? 'timeout' : signal()?.aborted ? 'cancelled' : 'unverified'};
    }
  }
  closeOne(session) {
    return session.closing ??= work.run(undefined, async () => {
      let deleted = false, stopped = false;
      try {
        if (session.wd) {await this.request(session, 'DELETE', '', undefined, {timeout_ms: 1200}); deleted = true;}
      } catch {}
      try {await session.driver.stop(); stopped = true;} catch {}
      session.refs.clear();
      if (stopped) {
        this.sessions.delete(session.id);
        this.ctx.unownBackground(session.device, 'safari');
      }
      return {...this.receipt(session), closed: stopped && deleted, webdriver_session_deleted: deleted,
        driver_stopped: stopped, session_termination: deleted ? 'confirmed' : 'unknown',
        restoration_verified: false, prior_actions_undone: false};
    });
  }
  async close(onlyDevices) {
    const receipts = [];
    for (const session of [...this.sessions.values()]) {
      if (!onlyDevices || onlyDevices.has(session.device)) receipts.push(await this.closeOne(session));
    }
    return receipts;
  }
}

export function safariTool(ctx, name, args) {
  let controller = controllers.get(ctx);
  if (!controller) {controller = new SafariController(ctx); controllers.set(ctx, controller);}
  return controller.call(name, args);
}
export async function closeSafari(ctx, onlyDevices) {
  return controllers.get(ctx)?.close(onlyDevices) ?? [];
}
