import {z} from 'zod';

const identifier = z.string().min(1).max(200);
const webUrl = z.string().min(1).max(4096).refine(value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, 'Use an HTTP(S) URL without credentials.');
const origin = z.string().min(1).max(2048).refine(value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && url.origin === value; }
  catch { return false; }
}, 'Use an exact HTTP(S) origin without a path, query, fragment or credentials.');
const owner = {device: identifier, lease_id: identifier};
const session = {...owner, session_id: identifier};
const observed = {...session, expected_origin: origin};
const selector = z.string().min(1).max(500);
const ordinary = state => z.object({state: z.literal(state), selector}).strict();
const withText = state => z.object({state: z.literal(state), selector, text: z.string().max(10000)}).strict();
const positiveConditions = [
  ordinary('present'), ordinary('unique'), ordinary('enabled'), withText('text'), withText('value'),
];
export const safariConditionSchema = z.discriminatedUnion('state', [
  ...positiveConditions, ordinary('absent'),
]);
const positiveCondition = z.discriminatedUnion('state', positiveConditions);
const timeout = z.number().int().min(100).max(30000).default(15000);
const poll = z.number().int().min(50).max(1000).default(200);
const projection = {
  max_nodes: z.number().int().min(1).max(100).default(50),
  max_text_chars: z.number().int().min(0).max(16000).default(6000),
};

export const safariDefinitions = [
  ['safari_open',
    'Open a new isolated Safari automation session on one exact physical iPhone. Requires an active matching device lease and existing URL-navigation approval. Uses the installed macOS SafariDriver, with Remote Automation already enabled and the phone trusted, unlocked and discoverable by SafariDriver. Does not attach owner tabs, cookies, logins or arbitrary app WebViews. Default origin scope is the URL origin; supply exact allowed_origins for an expected redirect. Requires negotiated ignore behavior for simple dialogs. HTTP WebDriver does not preserve beforeunload warnings; they cannot protect unsaved drafts in this session. Missing setup fails explicitly without changing settings.',
    z.object({...owner, url: webUrl, allowed_origins: z.array(origin).min(1).max(8).optional(),
      timeout_ms: z.number().int().min(1000).max(30000).default(20000)}).strict(), false],
  ['safari_observe',
    'Read bounded visible DOM text and opaque refs from this owned isolated Safari session. Requires its exact device, lease and expected origin. Password values are omitted. Refs expire after 30 seconds and are invalidated by navigation, device revision or an action. Reports projection completeness separately from the live document.',
    z.object({...observed, ...projection}).strict(), true],
  ['safari_query',
    'Query a CSS selector in this owned Safari session and return bounded visible DOM matches. This is a fixed DOM query, not arbitrary JavaScript. The source is the top-level document; cross-origin frames, shadow roots and owner tabs are unsupported. Incomplete scans cannot prove absence.',
    z.object({...observed, selector, ...projection}).strict(), true],
  ['safari_wait_for',
    'Wait for a bounded live DOM predicate in this owned Safari session. Presence, uniqueness, enabled state, exact text/value and absence use fresh observations. Absence requires a complete selector scan. Each poll and final success recheck native Safari foreground/prompts; native AX read time counts toward the deadline. A timeout or cancellation is not success and never retries input.',
    z.object({...observed, condition: safariConditionSchema, timeout_ms: timeout, poll_ms: poll}).strict(), true],
  ['safari_act',
    'Act on one fresh opaque DOM ref from this exact session, device and origin after verifying Safari is still foreground. Fill uses the native DOM value setter plus untrusted input/change events, verifies the live value, and never sends Return, an explicit form submit or a save claim; site event handlers may still run. Click uses one fixed guarded DOM activation script, reports dom_click with untrusted events, refuses obscured/out-of-scope elements, and requires a positive DOM postcondition plus fresh native foreground/prompt checks. Unknown dispatch/result fences further writes; it is never automatically replayed. No passwords, file inputs, arbitrary JS or W3C Actions API.',
    z.object({...observed, timeout_ms: timeout,
      action: z.discriminatedUnion('kind', [
        z.object({kind: z.literal('fill'), ref: identifier, text: z.string().max(10000)}).strict(),
        z.object({kind: z.literal('click'), ref: identifier, expect: positiveCondition}).strict(),
      ])}).strict(), false],
  ['safari_close',
    'Close only this caller-owned Safari automation session and its SafariDriver child. Requires its exact device and active lease. Device release/cancellation also performs owned cleanup. Closing does not undo prior website actions and does not prove an uncertain action failed.',
    z.object(session).strict(), false],
];
