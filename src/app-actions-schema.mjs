import {z} from 'zod';

const device = z.string().trim().min(1).max(200).optional();
const label = z.string().trim().min(1).max(200);
const operationKey = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const guard = z.object({
  all:z.array(label).max(20).default([]),
  any:z.array(label).max(20).default([]),
  none:z.array(label).max(20).default([]),
}).strict().refine(value=>value.all.length+value.any.length>0,'A positive postcondition is required');

export const runShortcutSchema = z.object({
  device,
  shortcut:label,
  input:z.string().max(10000).optional(),
  operation_key:operationKey,
  timeout_ms:z.number().int().min(100).max(30000).default(10000),
  expected_app:label.optional(),
  expect:guard.optional(),
}).strict().refine(value=>Boolean(value.expected_app)===Boolean(value.expect),
  'expected_app and expect must be supplied together');

export const appActionStatusSchema = z.object({device,operation_key:operationKey}).strict();
export const listAppLinksSchema = z.object({device}).strict();
export const openVerifiedLinkSchema = z.object({
  device,
  link_id:z.enum(['poki.chat','poki.setup','poki.activity']),
  expected_app:label.default('Poki'),
  timeout_ms:z.number().int().min(100).max(10000).default(3000),
}).strict();

export const appActionDefinitions = [
  ['run_shortcut',
    'Run one installed iPhone Shortcut once through the existing open_url approval path. Requires an explicitly configured phone-reachable HTTPS callback origin. A durable operation_key binds exact resolved device and arguments; reuse never replays the action. Returns correlated success/cancel/error or unknown. A success callback proves Shortcut completion, not an optional independent app postcondition. Unknown delivery is never retried.',
    runShortcutSchema,false],
  ['get_app_action_status',
    'Read a retained Shortcut receipt by operation_key on the exact selected iPhone. Never launches a Shortcut. A late valid callback may settle an unknown receipt; wrong-device reads refuse.',
    appActionStatusSchema,true],
  ['list_app_links',
    'List the fixed supported Poki navigation routes, their required destination evidence and physical verification status. Does not enumerate third-party App Intents or launch an app.',
    listAppLinksSchema,true],
  ['open_verified_link',
    'Open one fixed supported Poki route through the ordinary open_url approval path, then verify a fresh complete AX result containing the route accessibility identifier in the expected app. Does not run a task. Older installed apps without the route marker return unverified, never success.',
    openVerifiedLinkSchema,false],
];
export const appActionTools = new Set(appActionDefinitions.map(([name])=>name));
