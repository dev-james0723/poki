import * as cua from './cua.mjs';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { version } from './build-info.mjs';
import {workflowSchema,sequenceSchema,appActionSchema,choiceSchema,snapshotQuerySchema} from './workflow-v2-schema.mjs';

const catalog = JSON.parse(readFileSync(new URL('./data/tools.json', import.meta.url), 'utf8'));
catalog.tools.find(t=>t.name==='snapshot_ui').inputSchema.properties.query=z.toJSONSchema(snapshotQuerySchema,{target:'draft-2020-12'});
// Every direct-input tool accepts an optional exact foreground guard. Without
// this catalog extension Zod silently strips expected_app on raw coordinate
// taps/key presses, leaving the dispatch-level fail-closed gate inactive.
// Preserve unguarded calls for existing clients; guarded calls refuse when the
// phone is in a different or unreadable app before sending any input.
const guardableInputTools = new Set([
  'tap', 'double_tap', 'long_press', 'swipe', 'drag', 'pinch',
  'type_text', 'press_key', 'press_button', 'go_back', 'system_gesture',
]);
for (const tool of catalog.tools) {
  if (!guardableInputTools.has(tool.name)) continue;
  tool.inputSchema.properties.expected_app = {
    type: 'string', minLength: 1, maxLength: 200,
    description: 'Require this exact live foreground name or bundle ID immediately before device input; a mismatch or unreadable app sends nothing.',
  };
}
const defaultTools = new Set([
  'poki_mcp_status', 'list_devices', 'select_device', 'list_elements', 'snapshot_ui', 'observe_fast', 'take_screenshot',
  'get_foreground_app', 'launch_app', 'open_url', 'tap', 'tap_text', 'fill', 'type_text',
  'scroll', 'swipe', 'press_key', 'go_back', 'wait_for', 'handle_alert', 'batch_commands',
  'long_press', 'double_tap', 'drag', 'hide_keyboard', 'press_button',
  'scroll_to', 'terminate_app', 'pinch', 'list_apps', 'get_clipboard',
]);
const instructions = 'When the request already says what to do on the device, use batch_commands for launch_app and steps whose targets are already known; use fill without field for a single visible input, and use exact observed labels when a selector is needed; it is usually the only device call needed. Tapping steps wait for their target, and the reply ends with the visible text. With one device available, skip list_devices and select_device; use them when a call reports several devices. Consecutive calls do not require an explicit device lease. Single-step tools remain for exploring an unknown screen.';
const readOnly = new Set(['snapshot_ui','observe_fast','observe_device','list_devices', 'get_device_info', 'take_screenshot', 'get_foreground_app', 'list_elements', 'list_apps', 'get_clipboard', 'list_crashes', 'get_crash', 'wait_for', 'wait']);
const guidance = {
  acquire_device: 'Only needed to keep other sessions off a device across several calls. One batch_commands call already runs without interruption, so a single-call task needs no lease. If you take one, keep the returned lease_id, renew before expiry, then release.',
  wait_for: 'The timeout covers device capture, AX, OCR and polling. Success includes the matching observation and its image, so a second screenshot is not needed to inspect the matched state.',
  batch_commands: `Batch known operations. A single visible input can be filled without field. Field and button labels come from observed screen text, in its original language; guesses such as a translated Search label or an unobserved New Tab button require an observation first.

Example:
{"commands":[
  {"tool":"launch_app","arguments":{"bundle_id":"com.example.app"}},
  {"tool":"fill","arguments":{"text":"hello","submit":true}},
  {"tool":"tap_text","arguments":{"text":"Open"}},
  {"tool":"go_back","arguments":{}},
  {"tool":"tap_text","arguments":{"text":"Show Alert"}},
  {"tool":"handle_alert","arguments":{"button":"OK"}}
]}

Arguments of common steps: launch_app {bundle_id or name}; tap_text {text}; tap {x, y}; fill {text, field (optional when one text field is visible), submit}; type_text {text}; press_key {key, modifiers, count}; scroll {direction}; scroll_to {text, direction}; swipe {from_x, from_y, to_x, to_y}; go_back {}; handle_alert {button or action}; wait_for {text, gone, timeout_seconds}; wait {seconds}; take_screenshot {}. Use tool names without any client prefix.`,
  fill: 'Omit field when only one text input is visible. When selecting among fields, copy the exact observed label or use a current ref; field labels are not translated. Prefer fill over separate tap + type_text when the target field is known: it uses the field already being edited or taps it once, confirms that exact field before clearing anything, and reads the text back from it before any Return. When the field cannot be confirmed, nothing is typed. Use submit=true only when sending is already authorized; otherwise inspect the draft first.',
  type_text: 'Requires an already focused field. When the target field is known, use fill instead to avoid focus mistakes. To send text already entered, use press_key key=return; do not call type_text with empty text. text_verified confirms input only, not delivery.',
  press_key: 'Use key=return to submit existing text after it has been checked; do not re-enter the text. A sent result only confirms key dispatch, so verify the app result before reporting delivery.',
  touch_path: 'For a circle, make one touch_path call that goes once around and runs about 10 degrees past its first point, so the ends meet even when an app ignores the first few points of movement. Measure the center and radius in points from a current screenshot and keep the whole shape inside the drawing area. Give about one point every 10 to 16 ms; a circle drawn over 1500 ms with 120 points looks smooth. Do not build a circle from several drags or a few corner points. Inspect a screenshot afterwards, and do not erase or redraw automatically.',
  draw_strokes: 'Plan every letter before the call: nothing generates lettering for you. Write cursive or block letters as curves sampled about every 10 to 16 ms, one stroke per pen lift, left to right, sized from a current screenshot of the canvas. Use it only on a canvas that does not scroll or pan when touched; when the canvas or tool must be checked between strokes, use separate touch_path calls. Inspect a screenshot afterwards.',
  launch_app: 'On a simulator it returns once the app shows readable elements, and on a physical device once the app is in front; either way its text is in screen, so there is no need to look again. resumed=true means the app was already running and kept its state; use fresh=true to start it anew. If launch fails with CoreDeviceError 4016, inspect the current screen and use the observed Home Screen or app switcher controls. Avoid repeating the same failing launch until device conditions change.',
};
// JSON Schema cannot say that time_ms increases, so the parsed arguments are checked before any device is touched.
const checkStroke = (points, ctx, path) => {
  if (points[0].time_ms !== 0) ctx.addIssue({ code: 'custom', path: [...path, 0, 'time_ms'], message: 'time_ms of the first point must be 0.' });
  const back = points.findIndex((point, index) => index > 0 && point.time_ms <= points[index - 1].time_ms);
  if (back > 0) ctx.addIssue({ code: 'custom', path: [...path, back, 'time_ms'], message: `time_ms must increase at every point; point ${back} has ${points[back].time_ms} after ${points[back - 1].time_ms}.` });
};
const strokeChecks = {
  touch_path: (args, ctx) => checkStroke(args.points, ctx, ['points']),
  draw_strokes: (args, ctx) => {
    args.strokes.forEach((stroke, index) => checkStroke(stroke.points, ctx, ['strokes', index, 'points']));
    const total = args.strokes.reduce((sum, stroke) => sum + stroke.points.at(-1).time_ms, 0);
    if (total > 60000) ctx.addIssue({ code: 'custom', path: ['strokes'], message: `The strokes together must last at most 60000 ms; these last ${total} ms.` });
  },
};
// Additive observation arguments: legacy clients retain their existing schema
// behavior and the upstream stroke timing refinements are preserved.
const actionObservationTools = new Set(['tap', 'double_tap', 'long_press', 'tap_text', 'swipe',
  'drag', 'scroll', 'pinch', 'type_text', 'fill', 'press_key', 'press_button', 'go_back', 'handle_alert']);
const schemaOf = tool => {
  const schemaWithObservations = actionObservationTools.has(tool.name)
    ? { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
      return_observation: { type: 'boolean', description: 'Request a ref-bearing post-input observation when available.' },
      post_action_ocr: { type: 'boolean', description: 'Capture after stable AX and check image OCR prompts (default false).' } } }
    : tool.name === 'observe_device'
      ? { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
        include_image: { type: 'boolean', description: 'Attach PNG (default true); false retains capture and prompt checks.' } } }
      : tool.inputSchema;
  const generated = z.fromJSONSchema(schemaWithObservations);
  // Preserve query refinements during whole-batch validation.
  const schema = tool.name === 'snapshot_ui'
    ? generated.extend({query:snapshotQuerySchema.optional()})
    : ['fill','type_text'].includes(tool.name)
      ? generated.extend({native_text_result:z.boolean().optional().describe('Opt in only on the final non-submitting text step of a batch with expected_app. Return the native AX field-verification receipt instead of another whole-screen read. No full-screen observation or submission success is claimed; older or incomplete receipts retain normal readback.')})
      : generated;
  return strokeChecks[tool.name] ? schema.superRefine(strokeChecks[tool.name]) : schema;
};
export const definitions = catalog.tools.map(tool => [tool.name, [tool.description, guidance[tool.name]].filter(Boolean).join('\n\n'), schemaOf(tool), readOnly.has(tool.name)]);
definitions.push(['disconnect_device', 'Close the selected remote device connection and its local helper. Cellular reconnection may require returning the iPhone to Wi-Fi. Does not undo input.', z.object({ device: z.string().optional() }), false]);
definitions.push(['reconnect_device', 'Re-establish the selected RemotePairing tunnel. Does not replay input. A new session may require Wi-Fi when iOS closes its remote pairing listener.', z.object({ device: z.string().optional() }), false]);
definitions.push(['poki_mcp_status', 'Report Poki MCP version, current Git commit, native bridge build time, tool count, connected-device count, selected device, approval mode for this session, and any available Poki update with release notes and the update command.', z.object({}), true]);
definitions.push(['run_workflow','Execute an explicitly reviewed, bounded workflow through the existing run_code sandbox in one native MCP call. Requires a live start condition and a positive final result condition. Supports native semantic taps, verified draft fill (never submit), scrolling, numeric tap sequences, optional bounded choice proposals, and existing Shortcuts. Known steps omit redundant readbacks; branching and checkpoints read fresh AX. Existing approval and unknown-delivery stop rules apply. No new phone client or daemon is created.',workflowSchema,false]);
definitions.push(['tap_sequence','Send 2–8 observed numeric Key elements in one native input session on a physical iPhone with a fixed layout. Requires fixed_layout:true, a fresh native AX foreground, complete geometry, current scene revision and a helper advertising native_tap_sequence. One delivery hold follows the sequence. Returns dispatch evidence only, never application success. Unknown delivery stops without replay. Only numeric keypads are supported; inspect the result.',sequenceSchema,false]);
definitions.push(['run_app_action','Run an existing, reviewed iPhone Shortcut via the official shortcuts://run-shortcut URL through the ordinary open_url approval path, then check a fresh AX result in expected_app. Does not create a shortcut, add an App Intent to a third-party app, bypass approval, or grant authority for actions inside the shortcut. A visible result condition is required. An uncertain result is not retried.',appActionSchema,false]);
definitions.push(['choose_action','Read 2–6 current observed navigation candidates and propose one label. A unique exact_label uses local selection with no model or dialog. use_model defaults false. External selection requires a real approval dialog disclosing the app, goal, labels and one potentially billable Jev request; a new live snapshot follows approval. No screenshot or other screen text is sent. The result is proposal-only and never executes a tap. The executor must revalidate before input.',choiceSchema,false]);

// The computer-use profile (POKI_TOOL_PROFILE=cua, cua.mjs): look and do, plus device and status tools.
for (const [name, description, schema, readOnlyHint] of cua.definitions) definitions.push([name, description, z.fromJSONSchema(schema), readOnlyHint]);
const profile = (env = process.env) => env.POKI_TOOL_PROFILE ?? 'default';
const listedFor = name => (name === 'cua' ? cua.tools : defaultTools);

export function createServer(call) {
  const computerUse = profile() === 'cua', listed = listedFor(profile());
  const server = new McpServer({ name: 'poki-mcp', version }, { instructions: computerUse ? cua.instructions : instructions });
  for (const [name, description, inputSchema, readOnlyHint] of definitions) {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint } }, async (args, extra) => {
      try { return await call(name, args, { signal: extra.mcpReq?.signal ?? extra.signal, requestId: extra.mcpReq?._meta?.['poki/request_id'] }); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  if (process.env.POKI_MCP_TOOLS !== 'all') {
    server.server.setRequestHandler('tools/list', () => ({
      tools: definitions.filter(([name]) => listed.has(name)).map(([name, description, inputSchema, readOnlyHint]) => ({
        name, description, inputSchema: z.toJSONSchema(inputSchema, { io: 'input', target: 'draft-2020-12' }),
        annotations: { readOnlyHint },
      })),
    }));
  }
  return server;
}
