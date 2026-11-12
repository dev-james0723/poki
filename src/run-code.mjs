import { Worker } from 'node:worker_threads';
import { deadline, checkWork, signal, stoppingReason, timingCount, timingsSince } from './work.mjs';
import { invalidStep, stepTool, stopsRun } from './batch.mjs';
import { normalizeCode } from './normalize.mjs';

const workerUrl = new URL('./run-code-worker.mjs', import.meta.url);
// A receipt with sent=false or an unknown outcome stops the script, and so does any stop_reason that
// stops a batch (stopsRun): cancellation, timeout, expiry. Everything else is an ordinary tool error
// the script can catch and work around.
// What the model should do next after each stop, worded as batch_commands words the same stop.
const stopAdvice = {
  not_sent: 'The action was not delivered, so the steps after it were not run. Check the screen before retrying it.',
  unknown: 'The action may have been delivered, so the steps after it were not run. Check the screen before sending it again.',
  timeout: 'The script did not finish within its time. The device call in progress, if any, was cancelled; check the screen before continuing.',
  cancelled: 'The script was cancelled. The device call in progress, if any, was cancelled; check the screen before continuing.',
  expired: 'The device lease expired, so the script stopped. Check the screen before continuing.',
};
const json = value => ({ type: 'text', text: JSON.stringify(value, null, 2) });
const cap = text => typeof text === 'string' && text.length > 2000 ? `${text.slice(0, 2000)}…` : text;

// Buffers every worker event so none is lost in the gap between handling one tool call and waiting
// for the next, and rejects a pending wait when the run's signal aborts (cancel, timeout, deadline).
function mailbox(worker, abort) {
  const queue = [];
  let waiter;
  const deliver = item => { if (waiter) { const { resolve } = waiter; waiter = undefined; resolve(item); } else queue.push(item); };
  const onMessage = message => deliver({ message });
  const onDead = () => deliver({ dead: true });
  const onAbort = () => { if (waiter) { const { reject } = waiter; waiter = undefined; reject(abort.reason); } };
  worker.on('message', onMessage); worker.on('error', onDead); worker.on('exit', onDead);
  abort?.addEventListener('abort', onAbort, { once: true });
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (abort?.aborted) return Promise.reject(abort.reason);
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    close() { worker.off('message', onMessage); worker.off('error', onDead); worker.off('exit', onDead); abort?.removeEventListener('abort', onAbort); },
  };
}

export async function runCode(ctx, args) {
  const seconds = Number.isFinite(args.timeout_seconds) && args.timeout_seconds > 0 ? Math.min(args.timeout_seconds, 120) : 120;
  const maxCalls = Number.isFinite(args.max_tool_calls) && args.max_tool_calls > 0 ? Math.min(Math.floor(args.max_tool_calls), 60) : 60;
  const code = normalizeCode(args.code);
  // Inside deadline(), ctx.dispatch sees a signal that aborts when the script's time runs out, so an
  // in-flight device call is cancelled and its lease released, not left running past the timeout.
  return deadline(seconds * 1000, () => drive(ctx, code, args.input, maxCalls));
}

async function drive(ctx, code, input, maxCalls) {
  const abort = signal();
  const worker = new Worker(workerUrl, { workerData: { code, inputJson: JSON.stringify(input ?? null) }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  const box = mailbox(worker, abort);
  const calls = [];
  const logs = [];
  const base = () => ({ completed_calls: calls.length, calls, ...(logs.length ? { logs } : {}) });
  const reply = (id, payload) => worker.postMessage({ type: 'result', id, resultJson: JSON.stringify(payload) });
  // A failed call is listed and its error thrown inside the script, which may catch it.
  const failed = (id, call, error) => { calls.push({ call: calls.length + 1, ...call }); reply(id, { error }); };
  // An interrupted call is listed with the calls before it, so the report names what was cut off.
  const cancelled = (error, interrupted) => {
    if (interrupted) calls.push({ call: calls.length + 1, ...interrupted, interrupted: true });
    const reason = stoppingReason(error);
    return { ...base(), stop_reason: reason, next: stopAdvice[reason] ?? stopAdvice.cancelled };
  };
  // Each call goes through ctx.dispatch as a direct call would, outside batch mode, so an action
  // returns the screen it produced and the script can decide from it. A batch skips that readback
  // because it reads the screen once at its end; a script has no end-of-run read to fall back on.
  let summary;
  try {
    for (;;) {
      let event;
      try { event = await box.next(); }
      catch (error) { summary = cancelled(error); break; }
      if (event.dead) { summary = { ...base(), stop_reason: 'sandbox_exited', error: 'The sandbox stopped before returning, which can happen when it exceeds its memory limit. The daemon is unaffected.' }; break; }
      const message = event.message;
      if (message.type === 'log') { logs.push(message.line); continue; }
      if (message.type === 'done') { summary = message.error === undefined ? { ...base(), result: JSON.parse(message.resultJson) } : { ...base(), script_error: message.error }; break; }
      if (message.type !== 'call') continue;
      if (calls.length >= maxCalls) { summary = { ...base(), stop_reason: 'max_tool_calls', next: `The script made more than ${maxCalls} tool calls. Narrow the task or raise max_tool_calls (up to 60).` }; break; }
      const name = stepTool(message.name);
      const toolArgs = JSON.parse(message.argsJson);
      const problem = invalidStep({ tool: name, arguments: toolArgs });
      if (problem) { failed(message.id, { tool: name, elapsed_ms: 0, isError: true, error: problem }, problem); continue; }
      const started = performance.now(),timingFrom=timingCount();
      let result, dispatchError;
      try { checkWork(); result = await ctx.dispatch(name, toolArgs); }
      catch (error) {
        // Only the run's own signal firing (its deadline or a cancel) stops the script. A tool's own
        // failure, including a wait_for that did not find its text, is an ordinary error the code can catch.
        if (abort?.aborted) { summary = cancelled(abort.reason ?? error, { tool: name, elapsed_ms: Math.round(performance.now() - started) }); break; }
        dispatchError = error.message;
      }
      const elapsed_ms = Math.round(performance.now() - started);
      const stages=timingsSince(timingFrom),sum=name=>Math.round(stages.filter(s=>s.phase===name).reduce((n,s)=>n+(s.elapsed_ms??0),0)*100)/100;
      const timing={source_freshness_ms:sum('code_freshness'),target_resolution_ms:sum('target_resolution'),transport:{helper_prepare_ms:sum('native_helper'),identity_wait_ms:sum('native_identity'),response_wait_ms:sum('native_response'),close_wait_ms:sum('native_close')},phase_relation:'Nested phases include their children; do not sum parent and child totals.'};
      if (dispatchError) { failed(message.id, { tool: name, elapsed_ms,timing, isError: true, error: cap(dispatchError) }, dispatchError); continue; }
      const text = result.content?.find(block => block.type === 'text')?.text;
      let receipt; try { receipt = JSON.parse(text); } catch { receipt = text; }
      const meta = result._meta?.stop_reason;
      const hard = stopsRun(meta) || receipt?.sent === false || receipt?.outcome === 'unknown';
      calls.push({ call: calls.length + 1, tool: name, elapsed_ms,timing, isError: Boolean(result.isError), ...(typeof text === 'string' ? { receipt: cap(text) } : {}) });
      if (hard) {
        const stop = stopsRun(meta) ? meta : (receipt?.sent === false ? 'not_sent' : 'unknown');
        summary = { ...base(), stop_reason: stop, stopped_step: { tool: name, arguments: toolArgs, ...(receipt && typeof receipt === 'object' ? { receipt } : { receipt_text: text }) }, next: stopAdvice[stop] };
        break;
      }
      reply(message.id, result.isError ? { error: text ?? 'The tool call failed.' } : { result: receipt ?? null });
    }
  } finally {
    box.close();
    await worker.terminate();
  }
  const reason = summary.stop_reason ?? (summary.script_error !== undefined ? 'error' : undefined);
  if (reason === undefined) return { content: [json(summary)] };
  return { isError: true, content: [json(summary)], _meta: { stop_reason: reason } };
}
