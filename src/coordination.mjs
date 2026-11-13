import { randomUUID } from 'node:crypto';
import { work, checkWork, stoppingReason } from './work.mjs';
import { inputLockFromEnv, deviceKey } from './input-lock.mjs';
import { definitions } from './tools.mjs';

const readOnlyTools = new Set(definitions.filter(d => d[3]).map(d => d[0]));

export const managementTools = new Set(['acquire_device', 'renew_device', 'release_device', 'cancel_device']);

export class Coordination {
  leases = new Map(); operations = new Set(); revisions = new Map(); scenes = new Map(); queue = Promise.resolve();
  // Undefined unless POKI_INPUT_LOCK=1; then each session has its own queue (see input-lock.mjs).
  inputLock = inputLockFromEnv();
  revision(id) { return this.revisions.get(id) ?? 0; }
  changed(id) { this.revisions.set(id, this.revision(id) + 1); }
  observeFrame(id, data) { const previous = this.scenes.get(id); if (previous && !previous.equals(data)) this.changed(id); this.scenes.set(id, data); }
  owned(ctx) { return [...this.leases.values()].find(lease => lease.owner === ctx); }
  status(id, ctx) {
    const lease = this.leases.get(id);
    return lease ? { occupied: true, owned_by_session: lease.owner === ctx, state: lease.state, expires_at: lease.expires_at } : { occupied: false };
  }
  access(ctx, target) {
    checkWork();
    const lease = this.leases.get(target.id), own = this.owned(ctx);
    if (own && own.device !== target.id) throw new Error('This session holds another device. Release it before switching devices.');
    if (lease && (lease.owner !== ctx || lease.state !== 'active' || performance.now() >= lease.until)) throw new Error('Device is occupied or being released.');
    const operation = work.getStore()?.operation;
    if (operation) operation.devices.add(target.id);
  }
  async acquire(ctx, target, ttl) {
    this.access(ctx, target);
    if (this.owned(ctx)) throw new Error('This session already has a device lease. Use renew_device.');
    if ([...this.operations].some(op => op.owner !== ctx && op.devices.has(target.id))) throw new Error('Device has an active operation. Retry after it completes.');
    // A previous compatibility recording/location is owned work too.
    for (const owner of ctx.peers?.() ?? []) if (owner !== ctx && owner.backgroundDevices.has(target.id)) throw new Error('Device has background work in another session. Its owner must stop or cancel it first.');
    const lease = { lease_id: randomUUID(), device: target.id, owner: ctx, state: 'active' };
    this.leases.set(target.id, lease); this.extend(lease, ttl);
    ctx.selected = target.id;
    return this.receipt(lease);
  }
  extend(lease, ttl) {
    clearTimeout(lease.timer); lease.until = performance.now() + ttl * 1000; lease.expires_at = new Date(Date.now() + ttl * 1000).toISOString();
    lease.timer = setTimeout(() => { void this.end(lease.owner, 'expired'); }, ttl * 1000); lease.timer.unref();
  }
  receipt(lease) { return { lease_id: lease.lease_id, device: lease.device, state: lease.state, expires_at: lease.expires_at }; }
  require(ctx, id) {
    const lease = this.owned(ctx);
    if (!lease || lease.lease_id !== id || lease.state !== 'active' || performance.now() >= lease.until) throw new Error('No active lease matching this session and lease_id.');
    return lease;
  }
  renew(ctx, id, ttl) { const lease = this.require(ctx, id); this.extend(lease, ttl); return this.receipt(lease); }
  async end(ctx, reason) {
    if (ctx.ending) return ctx.ending;
    const lease = this.owned(ctx);
    if (lease) { lease.state = 'releasing'; clearTimeout(lease.timer); }
    const operations = [...this.operations].filter(op => op.owner === ctx);
    for (const op of operations) op.controller.abort(Object.assign(new DOMException(`Session work ${reason}; dispatched input is not undone`, 'AbortError'), { stopReason: reason }));
    ctx.ending = (async () => {
      await Promise.allSettled(operations.map(op => op.done));
      const cleanup = await ctx.cleanup();
      if (lease) this.leases.delete(lease.device);
      return { stopped: true, reason, cancelled_operations: operations.length, scope: 'all previously accepted work in this MCP session', ...(lease ? { device: lease.device, lease_id: lease.lease_id } : {}), cleanup };
    })();
    try { return await ctx.ending; } finally { ctx.ending = undefined; }
  }
  call(ctx, name, args, requestSignal, requestId) {
    if (ctx.ending) return Promise.reject(new Error('Session cleanup is in progress.'));
    const controller = new AbortController();
    const op = { owner: ctx, controller, requestId, devices: new Set(), timings: [] };
    this.operations.add(op);
    const queued = performance.now();
    // Count snapshot queue time against its deadline without releasing the
    // queue until started work actually stops.
    const requestedMs = name === 'snapshot_ui' ? (args.timeout_ms ?? 6000) : undefined;
    const boundedMs = Number.isInteger(requestedMs) && requestedMs >= 100 && requestedMs <= 20000 ? requestedMs : undefined;
    const expires = boundedMs === undefined ? undefined : queued + boundedMs;
    const timeoutController = new AbortController();
    const combined = AbortSignal.any([controller.signal, timeoutController.signal, ...(requestSignal ? [requestSignal] : [])]);
    const timer = boundedMs === undefined ? undefined : setTimeout(() => timeoutController.abort(new DOMException('Observation deadline exceeded', 'TimeoutError')), boundedMs);
    let started = false, abortQueued;
    const cancelledBeforeStart = new Promise((_, reject) => {
      abortQueued = () => { if (!started) reject(combined.reason); };
      if (combined.aborted) abortQueued(); else combined.addEventListener('abort', abortQueued, { once: true });
    });
    let release;
    const turn = this.inputLock ? this.lockedTurn(ctx, name, args, combined, op.timings).then(r => { release = r; }) : this.queue;
    const execution = turn.then(() => work.run({ operation: op, signal: combined, timings: op.timings, deadline: expires }, async () => {
      started = true; combined.removeEventListener('abort', abortQueued);
      checkWork();
      op.timings.push({ id: 0, phase: 'queue', parent: null, elapsed_ms: Math.round((performance.now() - queued) * 100) / 100 });
      let result;
      const dispatchStarted = performance.now();
      try {
        try { result = await ctx.dispatch(name, args); }
        catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }], _meta: { stop_reason: error.name === 'TimeoutError' || combined.aborted ? stoppingReason(error) : 'error' } }; }
        result._meta = { ...result._meta, timing: { relation: 'nested phases include their children; do not sum parents and children', stages: op.timings } };
        // MCP hosts may discard _meta. Keep content-free timing in the known
        // operation envelope as well, never in a user's returned script value.
        if (['batch_commands','run_code','run_workflow'].includes(name)) {
          const last = result.content?.at(-1);
          const elapsed = phase => op.timings.find(t => t.phase === phase)?.elapsed_ms ?? 0;
          const phases = {};
          for (const stage of op.timings) if (['code_freshness','target_resolution','accessibility','native_helper','native_request','native_identity','native_response','native_close','external_process','batch_readback','screen_capture','ocr','input','recording_recovery'].includes(stage.phase)) {
            const entry = phases[stage.phase] ??= {count:0,total_ms:0};
            entry.count++;entry.total_ms=Math.round((entry.total_ms+(stage.elapsed_ms??0))*100)/100;
          }
          const timing = {service_ms:Math.round(performance.now()-queued),
            dispatch_ms:Math.round(performance.now()-dispatchStarted),queue_ms:elapsed('queue'),
            admission:{session_queue_ms:elapsed('session_queue'),device_resolution_ms:elapsed('device_resolution'),lock_wait_ms:elapsed('lock_wait')},
            phase_relation:'Nested phases include their children; do not sum parent and child totals.',phases};
          let summary;
          if (last?.type === 'text') try {summary=JSON.parse(last.text);} catch {}
          if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
            summary.timing={...summary.timing,...timing};
            result.content=[...result.content.slice(0,-1),{...last,text:JSON.stringify(summary,null,2)}];
          } else {
            // Keep the original error verbatim. This is a diagnostic, never
            // evidence that an earlier input was or was not delivered.
            result.content=[...(result.content??[]),{type:'text',text:JSON.stringify({diagnostic_only:true,stop_reason:result._meta?.stop_reason??null,timing})}];
          }
        }
        return result;
      } finally {
        // A snapshot's own read deadline previously did not cancel unrelated
        // session recordings or locations. Preserve explicit cancellation's
        // cleanup, even when it follows the observation deadline.
        if (controller.signal.aborted || requestSignal?.aborted) {
          const cleanup = await work.run(undefined, () => ctx.cleanup(op.devices));
          if (result) result._meta = { ...result._meta, cleanup };
        }
      }
    }));
    const settled = execution.finally(() => release?.());
    op.done = Promise.race([settled, cancelledBeforeStart]).finally(() => { clearTimeout(timer); combined.removeEventListener('abort', abortQueued); this.operations.delete(op); });
    if (this.inputLock) ctx.queue = settled.catch(() => {});
    else this.queue = execution.catch(() => {});
    return op.done;
  }
  // With the input lock on: wait for this session's earlier calls, then for a read slot or the
  // device's input lock. Resolves to the release function.
  async lockedTurn(ctx, name, args, signal, timings = []) {
    let started = performance.now();
    const record = phase => { timings.push({phase,elapsed_ms:Math.round((performance.now()-started)*100)/100}); started=performance.now(); };
    await (ctx.queue ?? Promise.resolve());
    record('session_queue');
    const commands = name === 'batch_commands' && Array.isArray(args?.commands) ? args.commands : undefined;
    const isRead = step => readOnlyTools.has(String(step?.tool).replace(/^mcp__poki-mcp__/,''));
    if (readOnlyTools.has(name) || (commands?.length && commands.every(isRead))) {
      const release = await this.inputLock.readSlot(signal);record('lock_wait');return release;
    }
    // Read-only steps cannot widen an exact-device input lock to every phone.
    // Unknown tools and unresolved inputs retain the conservative global lock.
    const inputArgs = commands ? {...args,commands:commands.filter(step=>!isRead(step))} : args;
    const key = await deviceKey(ctx, inputArgs);record('device_resolution');
    const release = await this.inputLock.acquire(key, { session: ctx.label, tool: name }, signal);
    record('lock_wait');return release;
  }
}
