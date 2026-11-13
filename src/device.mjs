import {snapshotUI,viewportFromAX,axSignature} from './ax-snapshot.mjs';
import {queryUI,waitForUI} from './ui-query.mjs';
import {safariTools,safariTool,closeSafari} from './safari-dom.mjs';
import {appActionTools} from './app-actions-schema.mjs';
import {appActionTool} from './app-actions.mjs';
import {urlApprovalDetail} from './approval-details.mjs';
import { remoteDevices, nativeRequest } from './remote.mjs';
import { execute, checkWork, deadline, pause, phase, stopped, stoppingReason, work, timingCount, timingsSince } from './work.mjs';
import { Coordination, managementTools } from './coordination.mjs';
import { runBatch, finalNativeText } from './batch.mjs';
import { runCode } from './run-code.mjs';
import {compileWorkflow,executeTapSequence,executeAppAction,chooseAction} from './workflow-v2.mjs';
import { flagOn } from './element-flags.mjs';
import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { join, extname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { root, stateDir, idevice, noUsbDevice } from './config.mjs';
import { definitions } from './tools.mjs';
import { platformTool, inventorySimulators, simulatorModels, readSettings, closePlatform } from './platform.mjs';
import { interaction, promptWarning, readScreen, describeScreen, screenChanged, whatMoved, justReadMs, confirmAfterMs, launchWithinMs, launchPollMs } from './interaction.mjs';
import { askHuman } from './human.mjs';
import { simulatorRequest } from './simulator.mjs';
import { prepareRecordingInput, resumeRecordings } from './recording.mjs';
import { updateNotice } from './update-check.mjs';
import * as cua from './cua.mjs';
import { leavesUnnamedBand, textOutside } from './ocr-supplement.mjs';
import { version, buildInfo, requireCurrentCode } from './build-info.mjs';

export const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const capabilityResult = value => ({...text(value),...(value?.isError ? {isError:true,_meta:{stop_reason:value.stop_reason ?? (value.outcome==='unknown'?'unknown':'error')}} : {})});
const usedSimulators = new Set();
const approvedTools = new Set(['install_app', 'uninstall_app', 'build_and_run', 'open_url', 'safari_open', 'download_app_container', 'get_clipboard', 'set_clipboard']);
const platformTools = new Set(['start_simulator', 'shut_down_simulator', 'start_recording', 'stop_recording', 'set_appearance', 'set_accessibility', 'list_apps', 'launch_app', 'terminate_app', 'install_app', 'uninstall_app', 'open_settings', 'open_url', 'build_and_run', 'set_location', 'clear_location', 'get_clipboard', 'set_clipboard', 'list_crashes', 'get_crash', 'download_app_container']);

// A simulator reads its screen in about 0.2 s, so five seconds covers the two reads that call a screen
// still. A phone over a network tunnel can take two seconds or more per read, so its budget follows
// the reads it has just measured, up to a cap.
const springBoardId = 'com.apple.springboard', springBoardExecutable = /(?:^|\/)SpringBoard(?:\.app\/SpringBoard)?$/;
const settleMs = 600, readbackMs = 5000, maxReadbackMs = 12000;
const reportsScreen = new Set(['tap', 'double_tap', 'long_press', 'tap_text', 'swipe', 'drag', 'scroll', 'pinch', 'touch_path', 'draw_strokes', 'type_text', 'fill', 'press_key', 'press_button', 'go_back', 'handle_alert', 'system_gesture']);
// These exist to act on a control, so the reply says when nothing was seen to change after one.
const touchesControl = new Set(['tap', 'double_tap', 'long_press', 'tap_text', 'go_back', 'handle_alert']);
// Touches aimed by coordinates. A run of them in a batch (selecting photos, paging a carousel) is
// written for one screen, so the steps between them are not held back to read it.
const geometricTouches = new Set(['tap', 'double_tap', 'long_press', 'swipe', 'drag', 'scroll', 'pinch']);
const unchangedAdvice = 'The touch was sent, and no change was observed after it: accessibility reports the same elements, text, values, state (selected, enabled, focused) and positions. That is not proof it failed: its effect may be one accessibility does not report, such as a redrawn image or canvas, or may not have appeared yet. Nothing else was done. If a change was expected, check that the target is not covered or still loading before sending it again.';
const onScreen = ({ width, height }) => element => {
  const box = element.frame ?? element;
  return box.x < width && box.y < height && box.x + box.width > 0 && box.y + box.height > 0;
};

// "unknown" means the screen could not be compared, never that nothing happened. screen_change_verified and
// screen_changed are the earlier two-field form, kept for clients that read them.
export function screenChange(before, after) {
  if (before === undefined || after === undefined) return { screen_change: 'unknown', screen_change_verified: false };
  const changed = after !== before;
  return { screen_change: changed ? 'changed' : 'unchanged', screen_change_verified: true, screen_changed: changed };
}

// AX root/window frames offer an orientation check without an extra screenshot.
// Accept only near-screen-sized roots; app content and floating windows are not
// reliable evidence of screen geometry. Missing/ambiguous roots fail closed.
function axRootOrientation(elements, viewport) {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return null;
  const near = (actual, expected) => Number.isFinite(actual) &&
    Math.abs(actual - expected) <= Math.max(8, expected * 0.25);
  let same = false, rotated = false;
  for (const element of elements) {
    if (!/^(?:XCUIElementType)?(?:Application|Window)$/i.test(element.role ?? element.type ?? '')) continue;
    const frame = element.frame ?? element;
    if (!frame || frame.x < -8 || frame.y < -8) continue;
    const match = near(frame.width, viewport.width) && near(frame.height, viewport.height);
    const swapped = near(frame.width, viewport.height) && near(frame.height, viewport.width);
    if (match && !swapped) same = true;
    if (swapped && !match) rotated = true;
  }
  return same === rotated ? null : rotated ? 'rotated' : 'same';
}

export function hidPoint(x, y, width, height) {
  if (![x,y,width,height].every(Number.isFinite) || width < 2 || height < 2 || x < 0 || y < 0 || x >= width || y >= height) throw new Error(`Coordinates must be inside the screen (${width} × ${height} points).`);
  return [Math.round(x / (width - 1) * 65535), Math.round(y / (height - 1) * 65535)];
}

const names = (device, query) => device.id === query || device.name.toLocaleLowerCase() === query.toLocaleLowerCase();

export class Devices {
  selected; requested; frame; size; seen; structureViewport; batchViewportVerified = false; elements = []; elementsAt = 0; lastInputAt = -Infinity; lastInputCompletedAt; inBatch = false;
  scales = new Map(); readCosts = new Map(); physicalNames = new Map(); backgroundDevices = new Map(); nextRef = 0;
  nativeTargets = new Map();
  constructor(coordinator = new Coordination()) { this.coordinator = coordinator; this.coordinator.nativeOwners ??= new Map(); this.coordinator.axCooldown ??= new Map(); }
  ownNativeResources(target) {
    if (target.kind !== 'physical') return;
    this.nativeTargets.set(target.id,target); this.coordinator.nativeOwners.set(target.id,this);
  }
  async run(file, args, timeout = 45000, input) {
    const result = await execute(file, args, { timeout, input });
    return { stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd() };
  }
  async cleanup(onlyDevices) {
    const safari = await closeSafari(this, onlyDevices);
    const result = await closePlatform(this, onlyDevices);
    if (safari.length) result.safari = safari;
    const native = [];
    for (const [id,target] of [...this.nativeTargets]) {
      if (onlyDevices && !onlyDevices.has(id)) continue;
      this.nativeTargets.delete(id);
      if (this.coordinator.nativeOwners.get(id) !== this) { native.push({device:id,skipped_new_owner:true}); continue; }
      this.coordinator.nativeOwners.delete(id);
      try {
        const receipt = await work.run({signal:AbortSignal.timeout(2500),timings:[]},()=>nativeRequest(target,{op:'release_input'}));
        native.push({device:id,released:receipt.released===true});
      } catch (error) { native.push({device:id,released:false,error:error.message}); }
    }
    result.native = native;
    if (onlyDevices) for (const id of onlyDevices) this.backgroundDevices.delete(id);
    else this.backgroundDevices.clear();
    if (!onlyDevices || onlyDevices.has(this.frame?.device) || onlyDevices.has(this.structureViewport?.device)) { this.frame = undefined; this.elements = []; this.structureViewport = undefined; }
    return result;
  }
  close() { return this.coordinator.end(this, 'session_closed'); }
  async call(name, args = {}, requestSignal, requestId) {
    if (managementTools.has(name)) {
      const parsed = definitions.find(d => d[0] === name)[2].parse(args);
      if (name === 'renew_device') return text(this.coordinator.renew(this, parsed.lease_id, parsed.ttl_seconds ?? 120));
      if (name !== 'acquire_device') {
        if (name === 'release_device' || parsed.lease_id) this.coordinator.require(this, parsed.lease_id);
        return text(await this.coordinator.end(this, name === 'release_device' ? 'released' : 'cancelled'));
      }
      return this.coordinator.call(this, name, parsed, requestSignal, requestId);
    }
    return this.coordinator.call(this, name, args, requestSignal, requestId);
  }
  ownBackground(id, type) { if (!this.backgroundDevices.has(id)) this.backgroundDevices.set(id, new Set()); this.backgroundDevices.get(id).add(type); }
  unownBackground(id, type) { const owned = this.backgroundDevices.get(id); owned?.delete(type); if (!owned?.size) this.backgroundDevices.delete(id); }
  access(target) { this.coordinator.access(this, target); }
  changed(target) { this.axSize = undefined; this.coordinator.changed(target.id); this.elements = []; this.elementsAt = 0; this.frame = undefined; this.seen = undefined; this.structureViewport = undefined; }
  async inventory(all = false) {
    // A temporary acceptance controller can be pinned to one existing RemotePairing
    // identity. Do not even enumerate unrelated USB devices or simulators in this
    // mode; missing or mismatched remote identity fails closed with zero targets.
    if (Object.hasOwn(process.env, 'POKI_MCP_PIN_REMOTE_UDID')) {
      const pin = process.env.POKI_MCP_PIN_REMOTE_UDID;
      if (!/^[0-9A-Fa-f-]{20,64}$/.test(pin)) throw new Error('Invalid pinned RemotePairing device ID.');
      return (await remoteDevices()).filter(device => device.id === pin);
    }
    const { stdout } = await this.run('python3', [join(root, 'native/devices.py')], 8000);
    const physical = new Map();
    for (const device of JSON.parse(stdout)) {
      if (!device.id || (physical.has(device.id) && device.connection !== 'USB')) continue;
      physical.set(device.id, { ...device, kind: 'physical', name: this.physicalNames.get(device.id) ?? device.id });
    }
    for (const remote of await remoteDevices()) physical.set(remote.id, remote);
    const simulators = await inventorySimulators().catch(() => []);
    return [...physical.values(), ...simulators.filter(d => all || d.state === 'Booted' || usedSimulators.has(d.id))];
  }
  async describeDevices(all) {
    const devices = await this.inventory(all);
    return Promise.all(devices.map(async device => {
      const occupancy = this.coordinator.status(device.id, this);
      if (device.kind === 'simulator' || occupancy.occupied && !occupancy.owned_by_session) return { ...device, ...occupancy, selected: device.id === this.selected };
      try {
        this.access(device);
        if (device.remote) {
          const info = await nativeRequest(device, { op: 'device_info' });
          return { ...device, remote: undefined, name: info.properties.DeviceName ?? device.name, model: info.properties.ProductType, osVersion: info.properties.ProductVersion, selected: device.id === this.selected, ...occupancy, readiness: 'remote services connected' };
        }
        const values = await Promise.all(['DeviceName','ProductType','ProductVersion'].map(async key => {
          const response = await this.run(idevice, ['--udid',device.id,'lockdown','get',key],8000);
          if (!response.stdout) throw new Error(response.stderr || `No ${key} response`);
          return JSON.parse(response.stdout);
        }));
        this.physicalNames.set(device.id,values[0]);
        return { ...device,name:values[0],model:values[1],osVersion:values[2],selected:device.id===this.selected,...occupancy,readiness:'paired device discovered; developer-service availability is checked when used' };
      } catch(error) {
        return { ...device,remote:undefined,selected:device.id===this.selected,blocked:error.message,action:device.remote ? 'Keep the iPhone unlocked and check its configured address. For Bonjour, keep both devices on the same LAN; for Tailscale, keep both connected and return the iPhone to Wi-Fi to establish a new session.' : 'Keep the device connected and unlocked, trust this Mac, and enable Developer Mode / UI Automation.' };
      }
    }));
  }
  async target(boot = true) {
    return phase('target_resolution',async()=>{
    checkWork();
    if (this.resolved) { this.access(this.resolved); return this.resolved; }
    // An exact saved RemotePairing identity is already resolved. Unrelated USB
    // discovery or simctl must not hold every remote operation behind its timeout.
    const query = this.requested ?? this.selected ?? (process.env.POKI_MCP_DEVICE || undefined);
    const remote = await this.remoteById(query);
    const list = remote ? [remote] : await this.inventory(true);
    let matches = query ? list.filter(d => names(d, query)) : list.filter(d => d.kind === 'physical' || d.state === 'Booted');
    if (query && !matches.length) {
      for (const d of list.filter(d => d.kind === 'physical')) {
        const occupancy = this.coordinator.status(d.id, this);
        if (occupancy.occupied && !occupancy.owned_by_session) continue;
        this.access(d);
        const value = await this.run(idevice, ['--udid', d.id, 'lockdown', 'get', 'DeviceName']);
        try { d.name = JSON.parse(value.stdout); this.physicalNames.set(d.id, d.name); } catch { continue; }
      }
      matches = list.filter(d => d.name.toLocaleLowerCase() === query.toLocaleLowerCase());
    }
    if (!matches.length) throw new Error(query ? 'Device is not connected or the selected device disconnected. Use list_devices and select_device.' : 'No device is connected. Connect and trust an iPhone, or start a simulator.');
    if (matches.length !== 1) throw new Error(`Multiple devices match. Use select_device or specify device: ${matches.map(d => `${d.name} (${d.id})`).join(', ')}.`);
    const target = matches[0];
    this.access(target); this.resolved = target;
    if (!this.selected) this.selected = target.id;
    if (target.kind === 'simulator') {
      usedSimulators.add(target.id);
      if (boot && target.state !== 'Booted') {
        const selected = this.selected;
        await platformTool(this, 'start_simulator', { simulator: target.id });
        this.selected = selected;
        target.state = 'Booted';
      }
    }
    return target;
    });
  }
  // The id a device argument names, matched as target() matches it but without asking a phone for its name.
  async remoteById(query) {
    if (!query) return undefined;
    if (Object.hasOwn(process.env, 'POKI_MCP_PIN_REMOTE_UDID')) {
      const pin = process.env.POKI_MCP_PIN_REMOTE_UDID;
      if (!/^[0-9A-Fa-f-]{20,64}$/.test(pin)) throw new Error('Invalid pinned RemotePairing device ID.');
      if (query !== pin) return undefined;
    }
    const matches = (await remoteDevices()).filter(device => device.id === query);
    if (matches.length > 1) throw new Error('Multiple remote configurations match this device ID. Resolve the duplicate configuration before use.');
    return matches[0];
  }
  async resolveDevice(query) {
    const remote = await this.remoteById(query);
    if (remote) return remote.id;
    const matches = (await this.inventory(true).catch(() => [])).filter(d => names(d, query));
    return matches.length === 1 ? matches[0].id : undefined;
  }
  async device() { return (await this.target()).id; }
  async native(args, expected, timeout = 45000) {
    const target = await this.target();
    if (target.kind !== 'physical') throw new Error('This native command requires a physical device.');
    if (target.remote) throw new Error('This operation is unavailable over RemotePairing. Remove this device from remote-devices.json and reconnect over USB or local Wi-Fi.');
    const result = await this.run(idevice, ['--udid', target.id, ...args], timeout);
    if (expected && !expected.test(result.stdout + '\n' + result.stderr)) throw new Error(`Device service did not confirm the action: ${(result.stderr || result.stdout).slice(-3000)}`);
    return result;
  }
  async bridge(request) {
    const target = await this.target();
    if (target.kind === 'simulator') return simulatorRequest(target.id, request);
    const command = request.op === 'ax' ? { op: 'ax_tree', include_offscreen: request.include_offscreen ?? false, ...(request.timeout_ms === undefined ? {} : {timeout_ms: request.timeout_ms}), ...(request.event_stream ? {event_stream:true} : {}) } : request;
    const result = await nativeRequest(target, command);
    if (request.op === 'ax') return { ...result, foreground: result.foreground_app, elements: result.elements?.map(e => ({ ...e, type: e.type ?? e.role })) };
    return result;
  }
  async scale(target) {
    if (this.scales.has(target.id)) return this.scales.get(target.id);
    let scale;
    if (target.remote) {
      scale = (await nativeRequest(target, { op: 'device_info' })).scale;
    } else if (target.kind === 'physical') {
      const result = await this.native(['lockdown', '--domain', 'com.apple.mobile.iTunes', 'get', 'ScreenScaleFactor']);
      scale = Number(result.stdout);
    } else {
      const info = await this.bridge({ op: 'info' });
      scale = info.scale;
    }
    if (!Number.isFinite(scale) || scale <= 0 || scale > 5) throw new Error('Could not read the screen scale. Refusing to guess touch coordinates.');
    this.scales.set(target.id, scale); return scale;
  }
  capture() { return phase('screen_capture', () => this.captureFrame()); }
  async captureFrame() {
    checkWork();
    const started = new Date().toISOString();
    const target = await this.target();
    const cache = join(stateDir, 'frames');
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const path = join(cache, `${randomUUID()}.png`);
    try {
      // Unmasked, the area around the Dynamic Island differs between frames of a still screen, which would expire refs.
      if (target.kind === 'simulator') await this.run('xcrun', ['simctl', 'io', target.id, 'screenshot', '--type=png', '--mask=black', path]);
      else if (target.remote) await nativeRequest(target, { op: 'screenshot', path });
      else await this.native(['screenshot', path], /Screenshot saved to:/);
      const original = await readFile(path), meta = await sharp(original).metadata();
      const scale = await this.scale(target);
      const width = Math.round(meta.width / scale), height = Math.round(meta.height / scale);
      const data = await sharp(original).resize(width, height).png().toBuffer();
      this.coordinator.observeFrame(target.id, data);
      if (this.frame?.revision !== this.coordinator.revision(target.id) || this.frame?.device !== target.id || this.frame?.width !== width || this.frame?.height !== height || !this.frame.data.equals(data)) { this.elements=[]; this.elementsAt=0; }
      checkWork();
      this.frame = { id: randomUUID(), device: target.id, revision: this.coordinator.revision(target.id), width, height, scale, data, original, at: Date.now(), capture_started_at: started, capture_completed_at: new Date().toISOString() };
      this.structureViewport = undefined;
      this.size = { device: target.id, width, height };
      return this.frame;
    } finally { await unlink(path).catch(() => {}); }
  }
  async viewport() {
    const target = await this.target();
    if (this.frame && this.frame.revision !== this.coordinator.revision(target.id)) { this.frame = undefined; this.elements = []; }
    if (!this.frame || this.frame.device !== target.id) {
      // An AX-only post-action read can reuse a freshly measured viewport;
      // it never masquerades as a captured frame. Known input or capture
      // invalidates this binding; old refs still expire after 30 seconds.
      const bound = this.structureViewport;
      if (bound?.rootVerified === true && bound.device === target.id &&
          bound.revision === this.coordinator.revision(target.id) &&
          this.size?.device === target.id && this.size.width === bound.width && this.size.height === bound.height &&
          this.elements.length && Date.now() - this.elementsAt <= 30000) return this.size;
      return this.capture();
    }
    return this.frame;
  }
  async ocr(frame) {
    checkWork();
    return frame.ocr ??= phase('ocr', () => this.readOCR(frame));
  }
  async readOCR(frame) {
    if (this.ocrUnavailable) throw new Error(this.ocrUnavailable);
    const file = join(stateDir, 'frames', `${randomUUID()}-ocr.png`);
    const binary = join(root, 'build/ocr');
    try {
      await writeFile(file, frame.data, { mode: 0o600 });
      const { stdout } = await this.run(binary, [file]);
      return JSON.parse(stdout).map(e => ({ ...e, label: e.text, type: 'StaticText', frame: { x:e.x,y:e.y,width:e.width,height:e.height } }));
    } catch (error) {
      // A caller's deadline is not a broken recognizer; it must not be remembered as one.
      if (stopped(error)) throw error;
      // The recognizer is a host binary (Vision on macOS, tesseract on Linux). Only the binary being
      // absent is permanent: a run that failed once - a frame it could not decode, a crashed Vision
      // process - must not switch recognition off for the rest of the daemon's life.
      const absent = error.code === 'ENOENT' || error.code === 'EACCES' || /\b(ENOENT|EACCES)\b/.test(error.message ?? '');
      const message = absent
        ? `Screen text recognition is unavailable on this host: ${binary} is missing or not executable. Only the accessibility tree can be read here.`
        : `Screen text recognition failed on this frame: ${error.message}`;
      if (absent) this.ocrUnavailable = message;
      throw new Error(message);
    } finally { await unlink(file).catch(() => {}); }
  }
  async recognize(args = {}, existingFrame) {
    checkWork();
    const frame = existingFrame ?? await this.capture();
    let elements, source, foreground, nativeError;
    if (args.source !== 'ocr') {
      try {
        const tree = await phase('accessibility', () => this.bridge({ op: 'ax', include_offscreen: args.include_offscreen ?? false }));
        if (!Array.isArray(tree.elements) || !tree.elements.length) throw new Error('No accessibility elements returned');
        elements = tree.elements; source = 'accessibility'; foreground = tree.foreground;
      } catch (error) { if (stopped(error)) throw error; nativeError = error.message; if (args.source === 'accessibility' || args.source === 'ax') throw error; }
    }
    if (!elements) {
      elements = await this.ocr(frame);
      source = 'ocr';
    } else if (args.source !== 'accessibility' && args.source !== 'ax' && leavesUnnamedBand(elements.filter(onScreen(frame)), frame)) {
      // Without the recognizer the accessibility answer stands.
      try { elements = [...elements, ...textOutside(await this.ocr(frame), elements, frame)]; }
      catch (error) { if (stopped(error)) throw error; }
    }
    if (!args.include_offscreen) elements = elements.filter(onScreen(frame));
    const count = elements.length;
    this.elements = elements.slice(0, args.max_elements ?? 400).map(e => ({ ...e, ref:`e${++this.nextRef}` }));
    this.elementsAt = Date.now();
    frame.structure_completed_at = new Date().toISOString();
    frame.source = source;
    const observation = this.observation(frame);
    return { observation, source, width: frame.width, height: frame.height, units: 'points', foreground, elements: this.elements, total: count, truncated: count > this.elements.length, ...(source === 'ocr' && nativeError ? { fallback_reason: nativeError } : {}) };
  }
  // One accessibility read and no screenshot, so polling costs one native request per attempt.
  async structure(maxAge = 0, {forInput=false} = {}) {
    const target = await this.target();
    if (maxAge > 0 && this.seen?.device === target.id &&
        this.seen.liveRead === true &&
        this.seen.revision === this.coordinator.revision(target.id) &&
        (!forInput || this.seen.rootVerified === true && !promptWarning(this.seen.elements)) &&
        performance.now() - this.seen.at <= maxAge) return this.seen;
    const started = performance.now(), observedAt = new Date().toISOString(), timings = timingCount();
    const tree = await phase('accessibility', () => this.bridge({ op: 'ax', include_offscreen: false }));
    this.readCosts.set(target.id, performance.now() - started);
    const served = timingsSince(timings).findLast(entry => typeof entry.ax === 'string')?.ax;
    if (tree.foreground?.pid) this.lastForeground = { device: target.id, pid: tree.foreground.pid };
    if (tree.foreground && !tree.foreground.bundle_id && this.springBoard?.device === target.id && tree.foreground.pid === this.springBoard.pid)
      tree.foreground = { ...tree.foreground, bundle_id: springBoardId, name: 'SpringBoard' };
    const rawElements = tree.elements ?? [];
    const previousSize = this.size?.device === target.id ? this.size : undefined;
    // Rotation may occur externally between inputs. A verified AX root is
    // checked before filtering or converting any coordinates.
    if (axRootOrientation(rawElements, previousSize) === 'rotated') {
      this.structureViewport = undefined; this.elements = []; this.elementsAt = 0; this.frame = undefined;
      await this.capture();
    }
    const nativeViewport = viewportFromAX(tree);
    if (nativeViewport) { this.size = { device: target.id, ...nativeViewport }; this.axSize = { ...this.size, revision: this.coordinator.revision(target.id), at: performance.now() }; }
    const viewport = this.size?.device === target.id ? this.size : await this.capture();
    const rootVerified = axRootOrientation(rawElements, viewport) === 'same';
    if (!rootVerified) this.structureViewport = undefined;
    const elements = rawElements.filter(onScreen(viewport));
    // Preserve upstream foreground-based identity, including PID-only roots.
    const signature = axSignature(elements, tree.foreground);
    return this.seen = {
      device: target.id, revision: this.coordinator.revision(target.id), foreground: tree.foreground,
      elements, signature, rootVerified, liveRead:true, at: performance.now(), startedAt: started, observedAt,
      structure_started_at: observedAt, structure_completed_at: new Date().toISOString(),
      ...(served ? { served } : {}),
    };
  }
  // A simulator's size only changes when it rotates. A physical device maps touches through its
  // current orientation, so it keeps taking a fresh frame.
  async screenSize() {
    const target = await this.target();
    if (this.axSize?.device === target.id && this.axSize.revision === this.coordinator.revision(target.id) && performance.now() - this.axSize.at < 500) return this.axSize;
    if (target.kind === 'simulator' && this.size?.device === target.id) return this.size;
    // A batch may retain only a viewport that was captured or validated
    // during THIS batch, not one inherited from a previous AX-only action.
    if (this.inBatch && this.batchViewportVerified && this.size?.device === target.id) return this.size;
    const result = await this.viewport();
    if (this.inBatch) this.batchViewportVerified = true;
    return result;
  }
  bindSemanticViewport() {
    const seen=this.seen, age=seen?performance.now()-seen.at:Infinity;
    if(!seen?.liveRead || !seen.rootVerified || age<0 || age>200 ||
       seen.device!==this.resolved?.id || seen.revision!==this.coordinator.revision(seen.device) ||
       promptWarning(seen.elements))return;
    const viewport=viewportFromAX({elements:seen.elements});
    if(viewport)this.axSize={device:seen.device,...viewport,revision:seen.revision,at:seen.at};
  }
  // Reading the result back saves the caller a round trip to look. The action has already happened,
  // so a failed read only loses the report; a stop request still surfaces as a stop.
  readCost() { return this.readCosts.get(this.resolved?.id) ?? 0; }
  // Within a batch, a read is as fresh as the time another would take to arrive.
  reuseMs() { return Math.max(justReadMs, this.readCost()); }
  // A batch compares a touch with the screen before it only when that can hold back a later step:
  // with stop_on_error off nothing is held back, and a next step aimed by coordinates is written
  // for the same screen. The batch still ends with one read of the screen.
  checksStep() {
    if (!this.inBatch) return true;
    const { next, nextIsFinal, stopOnError } = this.batchStep ?? {};
    return !(nextIsFinal && next?.tool === 'snapshot_ui') &&
      stopOnError !== false && !geometricTouches.has(next?.tool);
  }
  observationBudget(target) {
    const cost = this.readCosts.get(target.id);
    if (target.kind === 'simulator' || cost === undefined) return readbackMs;
    return Math.min(maxReadbackMs, Math.max(readbackMs, 3 * cost + settleMs));
  }
  // How long an "unchanged" waits for a lagging screen before it is believed (see confirmUnchanged).
  confirmation() { return this.expectsForeground ? { intervalMs: launchPollMs, withinMs: launchWithinMs } : { intervalMs: confirmAfterMs, withinMs: confirmAfterMs }; }
  confirmationBudget(before) { return before === undefined ? 0 : this.confirmation().withinMs + this.readCost() + 100; }
  async readback(before, options = {}) {
    try {
      const target = await this.target();
      const fastRemote = target.remote && options.once === true;
      const preferOcr = fastRemote && (this.coordinator.axCooldown.get(target.id) ?? 0) > performance.now();
      const readOptions = fastRemote ? { ...options, axBudgetMs: Math.min(options.axBudgetMs ?? 3500, 3500), preferOcr } : options;
      const confirmation = this.confirmation();
      const { signature, screen, structuredObservation } = await deadline(
        fastRemote ? 11500 : this.observationBudget(target) + this.confirmationBudget(before) + (options.structured ? 3000 : 0),
        () => readScreen(this, { ...readOptions, before, confirmation }));
      if (fastRemote && screen.ax_timeout === true) this.coordinator.axCooldown.set(target.id, performance.now() + 20000);
      else if (fastRemote && screen.source === 'accessibility') this.coordinator.axCooldown.delete(target.id);
      const reusable = structuredObservation && this.lastInputCompletedAt;
      const receiptId = reusable ? randomUUID() : undefined;
      return { screen, ...screenChange(before, signature),
        ...(reusable ? { receipt_id: receiptId, input_completed_at: this.lastInputCompletedAt,
          post_action_observation: { version: 1, action_receipt_id: receiptId, ...structuredObservation } } : {}) };
    } catch (error) {
      try { checkWork(); } catch (stop) { return { stopped: true, stop_reason: stoppingReason(stop) }; }
      // Input clears the last read, so one left now was taken after the action: report it rather than nothing.
      const seen = this.seen && this.seen.device === this.resolved?.id && this.seen.elements.length ? this.seen : undefined;
      if (!seen) return { ...screenChange(), screen: { unavailable: error.message } };
      // One read that differs settles a change; a matching one needed a second read to confirm it.
      return { ...screenChange(before, before !== undefined && seen.signature !== before ? seen.signature : undefined), screen: { ...describeScreen(seen), ...(seen.startedAt < this.lastInputAt ? { stale: true } : {}), partial: true, reason: `${error.message}: the screen may still have been changing; this is the last complete read.` } };
    }
  }
  // The action does not depend on this read, so a slow read only costs the comparison.
  async readBefore(maxAge) {
    try {
      const target = await this.target();
      // This pre-read is optional evidence for post-input comparison, not a
      // license to keep a tap waiting behind a 25-second RemotePairing AX call.
      return await deadline(target.remote ? 4000 : readbackMs, () => this.structure(maxAge));
    } catch { checkWork(); }
  }
  // A batch step reports only whether its touch changed the screen; the batch ends with the screen itself.
  async changedSince(before) {
    try {
      const changed = await deadline(this.observationBudget(await this.target()) + this.confirmationBudget(before), () => screenChanged(this, before, this.confirmation()));
      return changed === undefined ? screenChange() : { screen_change: changed ? 'changed' : 'unchanged', screen_change_verified: true, screen_changed: changed };
    } catch {
      try { checkWork(); } catch (stop) { return { stopped: true, stop_reason: stoppingReason(stop) }; }
      return screenChange();
    }
  }
  // Lets the app react to the last input, so a read shows the new page rather than the old one.
  async settle() {
    const remaining = this.lastInputAt + settleMs - performance.now();
    if (remaining > 0) await pause(remaining);
  }
  observation(frame = this.frame) {
    return { id: frame.id, device: frame.device, width: frame.width, height: frame.height, units: 'points', capture_started_at: frame.capture_started_at, capture_completed_at: frame.capture_completed_at, structure_completed_at: frame.structure_completed_at, structure_source: frame.source ?? null, atomic: false, revision: frame.revision };
  }
  observationFromStructure(seen, frame) {
    const size = this.size;
    const revision = this.coordinator.revision(seen.device);
    // The first post-input screenshot may advance the revision because it
    // differs from the old pre-input picture. This is not a second input.
    if (!size || size.device !== seen.device ||
        (frame ? frame.revision !== revision || (frame.revision !== seen.revision && frame.revision !== seen.revision + 1)
          : seen.revision !== revision)) return null;
    return { id: randomUUID(), device: seen.device, revision,
      width: size.width, height: size.height, units: 'points', atomic: false,
      structure_source: 'accessibility',
      structure_started_at: seen.structure_started_at, structure_completed_at: seen.structure_completed_at,
      ...(frame ? { capture_started_at: frame.capture_started_at,
        capture_completed_at: frame.capture_completed_at } : {}),
    };
  }
  async input(request, { beforeDispatch } = {}) {
    const target = await this.target();
    if (this.expectedApp) {
      const seen = await this.structure(500);
      if (![seen.foreground?.bundle_id,seen.foreground?.name].includes(this.expectedApp)) {
        return {isError:true,outcome:'not_sent',sent:false,stop_reason:'error',error:'Foreground changed or is unreadable. Nothing was dispatched.'};
      }
    }
    this.ownNativeResources(target);
    const frame = 'x' in request || 'x1' in request || request.op === 'pinch' || request.op === 'draw_strokes' ? await this.screenSize() : undefined;
    const command = { ...request };
    if ('x' in command) {
      const p = hidPoint(command.x, command.y, frame.width, frame.height);
      if (target.kind === 'physical') { command.x = p[0]; command.y = p[1]; }
    }
    if ('x1' in command) {
      const a = hidPoint(command.x1, command.y1, frame.width, frame.height), b = hidPoint(command.x2, command.y2, frame.width, frame.height);
      if (target.kind === 'physical') [command.x1,command.y1,command.x2,command.y2] = [...a,...b];
    }
    if (command.op === 'draw_strokes') command.strokes = command.strokes.map(points => points.map(({ x, y, time_ms }) => {
      const p = hidPoint(x, y, frame.width, frame.height);
      return target.kind === 'physical' ? { x: p[0], y: p[1], time_ms } : { x, y, time_ms };
    }));
    if (command.op === 'pinch' && target.kind === 'physical') {
      command.start_distance *= 65535 / (frame.width - 1); command.end_distance *= 65535 / (frame.width - 1);
    }
    await phase('recording_recovery', () => prepareRecordingInput(this, target));
    if (beforeDispatch) {
      const guard=await phase('sequence_guard',beforeDispatch);
      if(guard?.sent===false)return guard;
    }
    // The last screen read before the first input of a call is the one its effect is measured against.
    if (this.seen?.device === target.id) this.beforeInput ??= this.seen;
    this.changed(target);
    let result;
    try { result = await phase('input', () => this.bridge(command)); }
    catch (error) { result = { outcome: 'unknown', error: error.message, stopped: Boolean(stopped(error)), stop_reason: stopped(error) ? stoppingReason(error) : 'unknown', instruction: 'Input may have been delivered. Inspect the screen before retrying.', isError: true }; }
    if (result.reason === 'display_service_missing') result = { ...result, instruction: `No input was sent. This iPhone does not provide com.apple.coredevice.displayservice, which touch and text input need. Screenshots and accessibility work without it, so they do not show whether input is available. Run node bin/prepare-device.mjs ${target.id} from the Poki checkout to install a developer disk image that provides it. See docs/physical-iphone.md#touch-and-text-input-fail.` };
    this.lastInputAt = performance.now();
    this.lastInputCompletedAt = new Date().toISOString();
    if (target.kind === 'physical') {
      try { await phase('recording_recovery', () => resumeRecordings(this, target)); }
      catch (error) { result = { ...result, recording: { resumed: false, error: error.message }, stopped: Boolean(stopped(error)), ...(stopped(error) ? { stop_reason: stoppingReason(error) } : {}) }; }
    }
    return result;
  }
  async dispatch(name, original = {}) {
    const def = definitions.find(d => d[0] === name);
    if (!def) throw new Error(`Unknown tool: ${name}`);
    const args = def[2].parse(original);
    if(args.native_text_result && (!['fill','type_text'].includes(name) || args.submit!==false || !args.expected_app || args.return_observation || args.post_action_ocr || this.inBatch&&this.batchStep?.next))throw Error('native_text_result requires non-submitting text with expected_app and no whole-screen observation; it must be final within a batch. Nothing was dispatched.');
    // Invalidate a previous call's AX-only viewport BEFORE dispatching any
    // tool. In particular CUA look/do and batch_commands bypass the default
    // input branch; without this they could reuse portrait size after rotation.
    // The default input branch may renew it only after its own fresh AX read.
    const previousViewport = this.structureViewport;
    this.structureViewport = undefined; this.axSize = undefined;
    const previous = this.requested, previousResolved = this.resolved, previousExpectedApp = this.expectedApp;
    this.expectedApp = args.expected_app ?? previousExpectedApp;
    // Steps of one batch share a lookup, which runs a Python process and simctl each time.
    const sharesTarget = this.inBatch && args.device === undefined;
    if (!sharesTarget) this.resolved = undefined;
    this.requested = args.device ?? previous;
    try {
      checkWork();
      if (name !== 'poki_mcp_status' && name !== 'stop_recording') await phase('code_freshness',requireCurrentCode);
      if (safariTools.has(name)) {
        const lease = this.coordinator.require(this,args.lease_id);
        const target = await this.target();
        if (target.id !== args.device || lease.device !== target.id) throw new Error('Safari requires the exact leased device ID.');
      }
      if (approvedTools.has(name)) await this.target();
      // Says on the result who let it run, so an agent can tell a gated call from an ordinary one.
      const approval = !approvedTools.has(name) ? undefined : process.env.POKI_MCP_APPROVAL_MODE === 'allow' ? { mode: 'operator-preapproved', approved_by: 'operator' } : { mode: 'ask-human', approved_by: 'human' };
      if (approval?.mode === 'ask-human') {
        const detail = args.path ?? args.project_path ?? args.bundle_id ?? (args.url ? urlApprovalDetail(args.url) : undefined) ?? (name === 'set_clipboard' ? `${Buffer.byteLength(args.text)} 字节的文本` : '');
        const action = { install_app: '安装应用', uninstall_app: '卸载应用', build_and_run: '构建并运行应用', open_url: '打开链接', safari_open: '开启 Safari 自动化会话', download_app_container: '下载应用数据', get_clipboard: '读取剪贴板', set_clipboard: '写入剪贴板' }[name];
        const result = await askHuman(`是否允许${action}？\n设备：${args.device ?? this.selected ?? '当前选中的设备'}\n${detail}`, 120);
        if (!result.completed) return { isError: true, ...text({ ...result, executed: false }), _meta: { stop_reason: result.status === 'timeout' ? 'timeout' : 'cancelled' } };
      }
      if (platformTools.has(name)) {
        const { _meta, ...result } = { ...await platformTool(this, name, args), ...(approval ? { approval } : {}) };
        if (name === 'start_simulator') usedSimulators.add(this.selected);
        return { ...text(result), ...(result.isError ? { isError: true } : {}), ...(_meta || result.stop_reason ? { _meta: { ..._meta, ...(result.stop_reason ? { stop_reason: result.stop_reason } : {}) } } : {}) };
      }
      if (safariTools.has(name)) return capabilityResult(await safariTool(this,name,args));
      if (appActionTools.has(name)) {
        if (['run_shortcut','get_app_action_status'].includes(name) && !this.coordinator.appActionJournalReady) throw new Error('Shortcut callback journal is unavailable. Check the local service setup.');
        return capabilityResult(await appActionTool(this,name,args,this.coordinator.appActions));
      }
      switch (name) {
        case 'query_ui': return capabilityResult(await queryUI(this,args));
        case 'wait_for_ui': return capabilityResult(await waitForUI(this,args));
        case 'acquire_device': return text(await this.coordinator.acquire(this, await this.target(false), args.ttl_seconds ?? 120));
        case 'poki_mcp_status': return text({ update: await updateNotice(), implementation: `Poki MCP ${version}`, ...await buildInfo(), jev_policy: process.env.POKI_JEV_DISABLED === '1' ? 'disabled' : 'opt-in', registered_device_tools: 53, observation_tools: 5, phone_capability_tools: 12, phone_capabilities: {native_query:{collection:'full_native_ax',coverage:'reported_per_observation'},shortcut_callbacks:{...this.coordinator.appActions?.readiness(),journal_ready:this.coordinator.appActionJournalReady===true},safari_dom:{backend:'safaridriver',session:'isolated',owner_tabs:'unsupported',readiness:'checked_on_open'}}, management_tools: 4, transport_tools: 2, total_tools: definitions.length, devices: (await this.inventory()).length, selected: this.selected ?? null, approval_mode: process.env.POKI_MCP_APPROVAL_MODE === 'allow' ? 'operator-preapproved' : 'ask-human', approval_covers: [...approvedTools], approval_scope: 'Only the tools in approval_covers ask for approval. Taps, typing and other input inside apps, including a delete confirmed with a tap, are not gated.' });
        case 'list_devices': {
          const devices = await this.describeDevices(args.include_all_simulators);
          return text({ devices, ...(devices.some(d => d.kind === 'physical') ? {} : { notice: noUsbDevice }), ...(args.include_all_simulators ? { simulator_models: await simulatorModels() } : {}) });
        }
        case 'disconnect_device':
        case 'reconnect_device': {
          const target = await this.target();
          if (!target.remote) throw new Error('This device is not configured for RemotePairing.');
          this.changed(target);
          return text(await nativeRequest(target, { op: name === 'disconnect_device' ? 'disconnect' : 'reconnect' }));
        }
        case 'select_device': {
          this.requested = args.device;
          const target = await this.target(); this.selected = target.id; this.frame = undefined; this.elements = [];
          return text({ selected: target.id, name: target.name });
        }
        case 'get_device_info': {
          const target = await this.target(), frame = await this.capture();
          const info = { ...target, screen: { width: frame.width, height: frame.height, scale: frame.scale, units: 'points' } };
          if (target.remote) { Object.assign(info, (await nativeRequest(target, { op: 'device_info' })).properties); delete info.remote; }
          else if (target.kind === 'physical') for (const key of ['DeviceName', 'ProductType', 'ProductVersion']) {
            const result = await this.native(['lockdown', 'get', key]); info[key] = JSON.parse(result.stdout);
          }
          if (target.kind === 'physical') { info.name=info.DeviceName; info.model=info.ProductType; info.osVersion=info.ProductVersion; this.physicalNames.set(target.id,info.name); }
          info.engine=target.kind==='simulator'?'CoreSimulator':'CoreDevice'; info.mirror_status='screen capture available';
          if (args.include_settings && target.remote) throw new Error('Device settings inspection is unavailable over RemotePairing. Remove this device from remote-devices.json and reconnect over USB or local Wi-Fi.');
          if (args.include_settings) info.settings = await readSettings(target);
          return text(info);
        }
        case 'take_screenshot': {
          const frame = await this.capture();
          const width = Math.round(args.max_width ?? frame.width);
          const jpeg = await sharp(frame.data).resize({ width }).jpeg({ quality: 90 }).toBuffer();
          let prompt;
          try { prompt = { status:'checked', source:'ocr', warning:promptWarning(await this.ocr(frame)) }; }
          catch (error) { if (stopped(error)) throw error; prompt = { status:'unavailable', instruction:'Inspect the screenshot for system prompts before continuing.' }; }
          return { content: [...text({ observation: this.observation(frame) }).content, { type: 'text', text: `Screen: ${frame.width} × ${frame.height} points. Image width: ${width} pixels. Coordinates for tools are screen points. Source: lossless device capture. Captured through the developer screenshot service; not saved to the device's Photos library.\nPrompt check: ${JSON.stringify(prompt)}` }, { type:'image',data:jpeg.toString('base64'),mimeType:'image/jpeg' }] };
        }
        case 'save_screenshot': {
          let path = args.path ?? join(homedir(), 'Pictures', 'Poki MCP');
          if (path.startsWith('~/')) path = join(homedir(),path.slice(2));
          if (!isAbsolute(path)) throw new Error('Screenshot path must be absolute.');
          const isDirectory = await stat(path).then(s=>s.isDirectory()).catch(()=>!extname(path));
          if (isDirectory) { const target=await this.target(); await mkdir(path,{recursive:true,mode:0o700}); path=join(path,`${target.name.replace(/[^\p{L}\p{N}._-]/gu,'_')}-${Date.now()}-${randomUUID().slice(0,8)}.png`); }
          const extension = extname(path).toLowerCase();
          if (!['.png','.jpg','.jpeg'].includes(extension)) throw new Error('Use a .png, .jpg or .jpeg path.');
          const frame = await this.capture();
          const data = extension === '.png' ? frame.original : await sharp(frame.original).jpeg({quality:95}).toBuffer();
          await writeFile(path,data,{flag:args.overwrite?'w':'wx',mode:0o600}); return text({path,bytes:data.length});
        }
        case 'observe_fast': return text((await this.readback(undefined,{ once:true })).screen);
        case 'snapshot_ui': return text(await snapshotUI(this,args));
        case 'list_elements': return text(await this.recognize(args));
        case 'observe_device': {
          const result = await this.recognize(args), frame = this.frame;
          let prompt;
          try { prompt = { status: 'checked', source: 'ocr', warning: promptWarning(await this.ocr(frame)) }; }
          catch (error) { if (stopped(error)) throw error; prompt = { status: 'unavailable', instruction: args.include_image === false
            ? 'Prompt check unavailable. Take a screenshot and inspect it before continuing.'
            : 'Inspect the image for system prompts before continuing.' }; }
          // Capturing and prompt checking are unchanged; only the optional
          // response image attachment is skipped.
          return { content: [...text({ ...result, prompt }).content,
            ...(args.include_image === false ? [] : [{ type: 'image', data: frame.data.toString('base64'), mimeType: 'image/png' }])] };
        }
        case 'get_foreground_app': {
          const tree = await this.bridge({ op:'ax', include_offscreen:false });
          if (!tree.foreground?.bundle_id && !tree.foreground?.pid) throw new Error('The accessibility service did not identify a foreground app.');
          // Some accessibility roots carry only a pid; AppService names the app running as it.
          if (!tree.foreground.bundle_id && (await this.target()).kind === 'physical') {
            try {
              const app = await this.bridge({ op: 'app_for_pid', pid: tree.foreground.pid });
              if (app.bundle_id) return text({ ...tree.foreground, bundle_id: app.bundle_id, name: tree.foreground.name ?? app.name, bundle_id_source: 'app_service' });
              // SpringBoard is not an installed app, so AppService knows it only by its executable.
              if (springBoardExecutable.test(app.executable ?? '')) {
                this.springBoard = { device: (await this.target()).id, pid: tree.foreground.pid };
                return text({ ...tree.foreground, bundle_id: springBoardId, name: 'SpringBoard', bundle_id_source: 'executable' });
              }
            } catch (error) { if (stopped(error)) throw error; }
          }
          return text(tree.foreground);
        }
        case 'rotate': {
          const target = await this.target(); this.changed(target);
          this.size = undefined;
          if (target.kind === 'simulator') { const result = await this.bridge({op:'rotate',orientation:args.orientation}); this.frame=undefined; this.elements=[]; return text(result); }
          const expected = {portrait:'Portrait',portrait_upside_down:'PortraitUpsideDown',landscape_left:'LandscapeLeft',landscape_right:'LandscapeRight'}[args.orientation];
          for(let i=0;i<4;i++) {
            const result = await this.native(['rotate','left']);
            const orientation = result.stdout.match(/non_flat_orientation:\s*(\w+)/)?.[1];
            if (!orientation) throw new Error(result.stderr || 'No orientation response');
            if (orientation === expected) { this.frame=undefined; this.elements=[]; return text({orientation:args.orientation,device_report:result.stdout}); }
            if (/locked:\s*true/.test(result.stdout)) throw new Error('Device rotation is locked.');
          }
          throw new Error('The requested orientation was not reported by the device.');
        }
        // Without await, the finally below restores the device state while the first step is still looking up its device.
        case 'batch_commands': {
          this.batchViewportVerified = false;
          try { return await runBatch(this, args); }
          finally { this.batchViewportVerified = false; }
        }
        case 'look': return await cua.look(this, args);
        case 'do': return await cua.act(this, args);
        case 'run_code': return await runCode(this, args);
        case 'run_workflow': return await runCode(this, compileWorkflow(args));
        case 'choose_action': return text(await chooseAction(this,args));
        case 'tap_sequence':
        case 'run_app_action': {
          const result=await (name==='tap_sequence'?executeTapSequence(this,args):executeAppAction(this,args));
          if(result.content)return result;
          return {...text(result),...(result.isError?{isError:true,_meta:{stop_reason:result.stop_reason??(result.outcome==='unknown'?'unknown':'error')}}:{})};
        }
        default: {
          const verify = args.verify !== false;
          // A batch step that asks for verification (verify: true) is compared even when checksStep would skip it.
          const looks = verify && reportsScreen.has(name) && !this.inBatch, touches = verify && touchesControl.has(name) && (args.verify === true || this.checksStep());
          this.beforeInput = undefined; this.expectsForeground = false;
          // The AX-only binding is valid only when this same call has just
          // performed a fresh root-verified AX read. Unverified or first-step
          // batch gestures fall back to image capture for coordinate sizing.
          const locatesTarget = ['tap_text', 'fill', 'handle_alert'].includes(name);
          const skipSpeculativeRead = locatesTarget && (await this.target()).remote;
          const before = (looks || touches) && !skipSpeculativeRead
            ? await this.readBefore(previousViewport ? 0 : this.inBatch ? this.reuseMs() : 0)
            : undefined;
          if (previousViewport && before?.rootVerified === true &&
              before.device === previousViewport.device &&
              before.revision === this.coordinator.revision(before.device) &&
              this.size?.device === before.device &&
              this.size.width === previousViewport.width && this.size.height === previousViewport.height &&
              this.elements.length && Date.now() - this.elementsAt <= 30000) {
            this.structureViewport = { ...previousViewport, revision: before.revision };
          }
          let result = await interaction(this,name,args);
          if(result===undefined) throw new Error(`No implementation for ${name}`);
          const delivered = result.sent === true && !result.isError && !result.stopped;
          // A target that had to be waited for is compared with the screen it was found on, not the one before the wait.
          const sentTo = this.beforeInput ?? before, signature = sentTo?.elements.length ? sentTo.signature : undefined;
          const nativeText=!this.inBatch&&args.native_text_result ? await finalNativeText(this,{tool:name,arguments:args},text(result)) : undefined;
          if(nativeText)result={...result,native_text_result:nativeText};
          else if (looks && delivered) result = { ...result, ...await this.readback(signature, { structured: args.return_observation === true, structuredVisual: args.post_action_ocr === true }) };
          else if (touches && delivered && signature !== undefined) result = { ...result, ...await this.changedSince(signature) };
          // Which list the scroll moved, from the reads on either side of it.
          if (name === 'scroll' && looks && delivered && sentTo?.elements.length && this.seen?.elements.length && this.seen.startedAt > this.lastInputAt) result = { ...result, moved: whatMoved(sentTo.elements, this.seen.elements) };
          // The input layers answer screen_change_verified false before anything is read, which means not looked at, not unchanged.
          if (result.screen_change === undefined && result.screen_change_verified === false && !this.inBatch) result = { ...result, screen_change: 'unknown' };
          if (!verify) result = { ...result, verified: false };
          const unchanged = touches && result.screen_change === 'unchanged' && !result.stopped;
          if (unchanged) result = { ...result, instruction: unchangedAdvice };
          // The input layers always answer false here. Only a touch is compared inside a batch; the batch ends with the screen.
          if (this.inBatch && result.screen_change_verified === false) { const { screen_change_verified, ...rest } = result; result = rest; }
          // The user's answer is the result: a confirmed dialog is a success, and an unanswered one an ordinary failure for stop_on_error to decide.
          if (name === 'request_human_action') return { ...(result.completed ? {} : { isError: true, _meta: { stop_reason: 'error' } }), ...text(result) };
          if (result.stopped || result.isError) return { isError: true, ...text(result), _meta: { stop_reason: result.stop_reason ?? (result.stopped ? 'cancelled' : 'unknown') } };
          if (name === 'wait_for') return { content: [...text(result).content, { type: 'image', data: this.frame.data.toString('base64'), mimeType: 'image/png' }] };
          return { ...text(result), ...(unchanged || result.screen_change ? { _meta: { ...(unchanged ? { stop_reason: 'no_change' } : {}), ...(result.screen_change ? { verdict: result.screen_change } : {}) } } : {}) };
        }
      }
    } finally { this.expectedApp=previousExpectedApp; this.requested=previous; if (!sharesTarget) this.resolved=previousResolved; }
  }
}
