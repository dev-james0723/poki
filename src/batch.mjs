import { checkWork, phase, stopped, stoppingReason, timingsSince } from './work.mjs';
import { managementTools } from './coordination.mjs';
import { definitions } from './tools.mjs';
import { closestTo, describeScreen } from './interaction.mjs';
import { flagOn } from './element-flags.mjs';

const json = value => ({ type: 'text', text: JSON.stringify(value) });
const receipt = value => ({ type: 'text', text: JSON.stringify(value, null, 2) });
export const offDevice = new Set(['wait', 'list_devices', 'poki_mcp_status', 'request_human_action']);
export const changesDevice = new Set(['select_device', 'start_simulator', 'shut_down_simulator']);
// Clients show tools under a prefixed name, and models copy it into a step.
export const stepTool = tool => tool.replace(/^mcp__poki-mcp__/, '');
// A step's stop_reason that ends the run, for batch_commands and run_code alike. An ordinary error
// and a touch with no observed change are left to the caller: stop_on_error, or the script.
export const stopsRun = reason => Boolean(reason) && reason !== 'error' && reason !== 'no_change';

export function invalidStep(command) {
  if (['batch_commands','run_code','run_workflow'].includes(command.tool)) return 'Nested batches are not supported; neither are run_code or run_workflow.';
  if (managementTools.has(command.tool)) return 'Call device management tools outside a batch.';
  const definition = definitions.find(([name]) => name === command.tool);
  if (!definition) {
    const closest = closestTo(command.tool, definitions.map(([name]) => name));
    return `Unknown tool: ${command.tool}.${closest.length ? ` Did you mean ${closest.join(', ')}?` : ''}`;
  }
  const schema = definition[2], parsed = schema.safeParse(command.arguments ?? {});
  if (parsed.success) return null;
  const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
  return `Invalid arguments for ${command.tool}: ${issues}. It accepts: ${Object.keys(schema.shape ?? {}).join(', ')}.`;
}

function advice(reason, failedStep) {
  const earlier = failedStep > 1 ? `Steps 1-${failedStep - 1} already ran; do not repeat them.` : 'No earlier step ran.';
  if (reason === 'error') return `${earlier} Fix the failed step, then send only remaining_steps.`;
  if (reason === 'unknown') return `${earlier} Step ${failedStep} may have been delivered, so check the screen before resending it.`;
  if (reason === 'no_change') return `${failedStep > 1 ? `Steps 1-${failedStep - 1} already ran; do not repeat them. ` : ''}Step ${failedStep} was sent, and no change was observed after it (same elements, text, values, state and positions). That is not proof it failed, but the steps after it were written for the screen it should produce, so they did not run. Check screen: if it already shows that screen, send only remaining_steps; if not, send step ${failedStep} again followed by remaining_steps. stop_on_error=false runs a batch through such taps.`;
  return `${earlier} Work stopped (${reason}); check the screen before continuing.`;
}

// An explicit last read is already the caller's checkpoint. Reuse only a complete,
// live AX result from this device and revision, taken after the last input. Event
// hints, partial trees and failed reads keep the normal final-read path.
async function finalSnapshot(ctx, command, result) {
  if (command?.tool !== 'snapshot_ui' || result?.isError) return;
  let data;
  try { data = JSON.parse(result.content?.find(block => block.type === 'text')?.text); }
  catch { return; }
  const observation = data?.observation;
  const started = Date.parse(observation?.structure_started_at);
  const completed = Date.parse(observation?.structure_completed_at);
  const inputCompleted = Date.parse(ctx.lastInputCompletedAt);
  if (data?.source !== 'accessibility' || observation?.source !== 'accessibility' ||
      observation.input_freshness !== 'live_read' || data.event_source !== 'accessibility_live' ||
      data.image_captured !== false || data.truncated !== false ||
      data.scope !== undefined || (data.source_total !== undefined && data.source_total !== data.total) ||
      !Array.isArray(data.elements) || !data.elements.length || data.total !== data.elements.length ||
      !(data.foreground?.bundle_id || data.foreground?.name) ||
      !Number.isFinite(started) || !Number.isFinite(completed) || completed < started ||
      (Number.isFinite(inputCompleted) && started < inputCompleted)) return;
  const target = await ctx.target();
  if (observation.device !== target.id || observation.revision !== ctx.coordinator.revision(target.id)) return;
  return { ...describeScreen({foreground:data.foreground,elements:data.elements}),
    observed_at:observation.structure_completed_at, observation_id:observation.id,
    screen_stable:false, ...(data.prompt ? {prompt:data.prompt} : {}) };
}

// A batch is one queued operation, so its steps share a device lookup. A touch is compared with the
// screen before it when a later step depends on that (see Devices.checksStep); the screen itself is
// read back once, after the last step.
export async function runBatch(ctx, args) {
  const batchStarted = performance.now();
  const commands = args.commands.map(command => {
    const tool = stepTool(command.tool);
    const supportsVerification = definitions.find(([name]) => name === tool)?.[2].shape?.verify;
    return { ...command, tool, ...(args.verify === false && supportsVerification ? { arguments: { verify: false, ...command.arguments } } : {}) };
  });
  const unverified = commands.some(command => command.arguments?.verify === false);
  const stopOnError = args.stop_on_error !== false;
  const invalid = stopOnError ? commands.findIndex(invalidStep) : -1;
  if (invalid >= 0) {
    const error = invalidStep(commands[invalid]);
    return { isError: true, content: [json({ step: invalid + 1, tool: commands[invalid].tool, isError: true, elapsed_ms: 0 }), { type: 'text', text: error }, receipt({ completed_steps: 0, stop_reason: 'error', failed_step: { step: invalid + 1, ...commands[invalid], error }, remaining_steps: commands, next: 'Nothing ran. Fix the failed step and send the whole batch again.' })] };
  }
  const blocks = [];
  let stopReason, failed = false, ran = 0, failure, unchanged, lastResult, stepsMs = 0, readbackMs = 0;
  ctx.inBatch = true;
  try {
    for (const [index, command] of commands.entries()) {
      const started = performance.now();
      ctx.batchStep = { next: commands[index + 1], nextIsFinal: index + 2 === commands.length, stopOnError };
      let result;
      try {
        checkWork();
        const problem = invalidStep(command);
        if (problem) throw new Error(problem);
        result = await ctx.dispatch(command.tool, command.arguments ?? {});
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error.message }] };
        if (stopped(error)) stopReason = stoppingReason(error);
      }
      ran++;
      lastResult = result;
      const elapsed = Math.round(performance.now() - started);
      stepsMs += elapsed;
      blocks.push(json({ step: ran, tool: command.tool, isError: Boolean(result.isError), elapsed_ms: elapsed }), ...result.content);
      // A fill that typed the wrong text is an ordinary failure: stop_on_error decides, not this block.
      // A touch with no observed change may still have worked. The batch pauses only to hold back the steps
      // written for the screen it should produce, so with none left, or when the caller allows it, it goes on.
      const reason = result._meta?.stop_reason;
      if (reason === 'no_change') { if (stopOnError && ran < commands.length) { stopReason = reason; unchanged = { step: ran, ...command }; } }
      else if (stopsRun(reason)) stopReason = reason;
      if (result.isError) {
        failed = true;
        failure = { step: ran, ...command, error: result.content.find(block => block.type === 'text')?.text };
        if (!stopReason && stopOnError) stopReason = 'error';
      } else failure = undefined;
      if (stopReason) break;
      if (changesDevice.has(command.tool)) ctx.resolved = undefined;
    }
  } finally { ctx.inBatch = false; ctx.batchStep = undefined; }
  const summary = unverified ? { verified: false } : {};
  // Reading a simulator that a step just shut down would boot it again.
  const last = commands.slice(0, ran).findLast(command => !offDevice.has(command.tool));
  if (last && last.tool !== 'shut_down_simulator') {
    // dispatch restores both when this batch ends.
    if (last.arguments?.device) { ctx.requested = last.arguments.device; ctx.resolved = undefined; }
    const readStarted = performance.now();
    const explicit = await finalSnapshot(ctx, commands[ran - 1], lastResult);
    const { screen, stop_reason } = explicit ? {screen:explicit}
      : await phase('batch_readback', () => ctx.readback(undefined, { once: unverified }));
    stopReason ??= stop_reason;
    summary.screen = screen;
    readbackMs = Math.round(performance.now() - readStarted);
  }
  if (stopReason) {
    if (failure) {
      Object.assign(summary, { failed_step: failure, remaining_steps: commands.slice(failure.step - 1), next: advice(stopReason, failure.step) });
      if (failure.tool === 'fill' && /No visible element matches|Requested field is not visible/.test(failure.error ?? '')) {
        const fields = (ctx.seen?.elements ?? []).filter(element => flagOn(element.visible) && /^(?:AX|XCUIElementType)?(?:Secure)?(?:TextField|TextArea|TextView|SearchField)$/i.test(element.type ?? element.role ?? ''))
          .map(element => element.identifier || element.label || element.placeholder);
        if (fields.length === 1 && fields[0]) {
          const { field: _field, ref: _ref, x: _x, y: _y, ...rest } = failure.arguments ?? {};
          summary.next_commands = [{ tool: 'fill', arguments: { ...rest, field: fields[0] } }, ...commands.slice(failure.step)];
          summary.next = `The current visible text field is ${JSON.stringify(fields[0])}. If this is the intended field, run next_commands with that exact label. No text was entered by the failed fill. Earlier completed steps, including launch_app, need not run again.`;
        }
      }
    }
    else if (unchanged) Object.assign(summary, { unchanged_step: unchanged, remaining_steps: commands.slice(ran), next: advice(stopReason, ran) });
    else Object.assign(summary, { remaining_steps: commands.slice(ran), next: advice(stopReason, ran + 1) });
  }
  const timing = {queue_ms:timingsSince(0).find(entry => entry.phase === 'queue')?.elapsed_ms ?? 0,
    batch_ms:Math.round(performance.now() - batchStarted),steps_ms:stepsMs,readback_ms:readbackMs};
  return { ...(failed || stopReason ? { isError: true } : {}), content: [...blocks, receipt({ completed_steps: ran, stop_reason: stopReason ?? null, ...summary, timing })] };
}
