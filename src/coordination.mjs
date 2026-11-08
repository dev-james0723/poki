import { randomUUID } from 'node:crypto';
import { work, checkWork, stoppingReason } from './work.mjs';

export const managementTools = new Set(['acquire_device', 'renew_device', 'release_device', 'cancel_device']);

export class Coordination {
  leases = new Map(); operations = new Set(); revisions = new Map(); scenes = new Map();
  queues = new Map(); sessions = new WeakMap(); sessionCount = 0; identityGate = Promise.resolve();
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
  sessionKey(ctx) {
    const existing = this.sessions.get(ctx);
    if (existing) return existing;
    this.sessionCount += 1;
    const key = `session:${this.sessionCount}`;
    this.sessions.set(ctx, key);
    return key;
  }
  // Chain onto one queue. The tail is recorded before the work runs, so the
  // next caller on this key waits even if identification for a later call overlaps.
  chain(key, fn) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.queues.set(key, run.catch(() => {}));
    return run;
  }
  call(ctx, name, args, requestSignal, requestId) {
    if (ctx.ending) return Promise.reject(new Error('Session cleanup is in progress.'));
    const controller = new AbortController();
    const op = { owner: ctx, controller, requestId, devices: new Set(), timings: [] };
    this.operations.add(op);
    const combined = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
    const queued = performance.now();
    let started = false, abortQueued;
    const cancelledBeforeStart = new Promise((_, reject) => { abortQueued = () => { if (!started) reject(combined.reason); }; combined.addEventListener('abort', abortQueued, { once: true }); });
    const identified = this.identityGate.then(() => typeof ctx.queueDeviceKey === 'function' ? ctx.queueDeviceKey(name, args) : null);
    this.identityGate = identified.catch(() => {});
    const execution = identified.then(deviceKey => this.chain(this.sessionKey(ctx), () => {
      const run = () => work.run({ operation: op, signal: combined, timings: op.timings }, async () => {
        started = true; combined.removeEventListener('abort', abortQueued);
        checkWork();
        op.timings.push({ id: 0, phase: 'queue', parent: null, elapsed_ms: Math.round((performance.now() - queued) * 100) / 100 });
        let result;
        try {
          try { result = await ctx.dispatch(name, args); }
          catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }], _meta: { stop_reason: error.name === 'TimeoutError' || combined.aborted ? stoppingReason(error) : 'error' } }; }
          result._meta = { ...result._meta, timing: { relation: 'nested phases include their children; do not sum parents and children', stages: op.timings } };
          return result;
        } finally { if (combined.aborted) { const cleanup = await work.run(undefined, () => ctx.cleanup(op.devices)); if (result) result._meta = { ...result._meta, cleanup }; } }
      });
      return deviceKey ? this.chain(deviceKey, run) : run();
    }));
    execution.catch(() => {});
    op.done = Promise.race([execution, cancelledBeforeStart]).finally(() => { combined.removeEventListener('abort', abortQueued); this.operations.delete(op); });
    return op.done;
  }
}
