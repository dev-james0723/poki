# Poki phone capabilities — PRD and engineering specification

Date: 2026-11-12
Status: implementation, commit, push and deployment authorized by the user. The initial backend choices below are engineering decisions, not separate user approval to narrow the selected outcomes.
Scope: targeted AX reads/waits, correlated Shortcuts and task App Intents, verified navigation, physical-iPhone Safari DOM.
Base: public native-speed branch at 73d5f0b. Work in isolated dev/* worktrees.

## Product outcomes
1. Ask whether an exact visible field equals text, results exist, a button remains at expected bounds, or a loading indicator has disappeared.
2. Execute an installed Shortcut once, correlate its success/cancel/error result to the correct phone and operation, and report uncertainty without replay.
3. Start, inspect and cancel retained Poki tasks through iOS App Intents using the existing task and approval machinery.
4. Deliver an initial set of 5–10 useful workflows for the user's common apps, with supported links/actions, parameters, expected destinations and physical verification recorded. The three owned Poki routes are an initial subset, not fulfillment of this outcome.
5. Use DOM references for public Safari research and form preparation on the selected physical phone.
6. Expose complete contracts, tests, capability readiness and release evidence.

## Constraints and honesty
- Preserve original dirty checkout, private code, phone ownership, active recording, approval controls, service state and credentials.
- Never bypass a live write lease, phone privacy pause or tool approval by switching transports.
- Do not publish private identifiers, callbacks, tokens, task text or local state to the public fork.
- Existing native AX transport requests the full tree. Report collection scope separately from verified coverage; missing native child lists and unknown visibility stay incomplete. Do not claim scoped native reads or a speedup without measurement.
- Reads must identify device, app, capture time, revision/source and completeness. A field receipt proves its value only, not save/send.
- Unknown mutation outcomes are never automatically retried. Cancellation after dispatch does not prove the phone action was cancelled.
- SafariDriver creates an isolated automation session. Do not claim reuse of owner's cookies/tabs or arbitrary WKWebView access.
- Tool definitions must be discoverable, routed, validated before side effects, and covered by integration tests.
- Every side-effecting path retains existing device coordinator and approval semantics.

## 1. AX query and wait
New tools: query_ui and wait_for_ui. Reuse the native AX snapshot machinery without screenshot/OCR attachments.
Inputs: explicit/selected device; required expected_app; query with labels, roles, object_ids; condition state present, absent, unique, field_equals or bounds_match.
field_equals uses exactly one matched element and exact Unicode value/text equality.
bounds_match uses exactly one matched element and explicit expected bounds plus bounded tolerance.
wait_for_ui accepts timeout_ms (100..30000) and poll_ms (100..1000). Use the shared deadline, abort signal and checkWork machinery.
Receipt: matched, attempts, elapsed_ms, observation/source/device/revision/app/prompt and unambiguous stop reason.
Absence is proven only from a fresh, complete, untruncated, root-verified AX source for the expected foreground app.
Full-tree prompt detection precedes filtering. Offscreen/unavailable/stale/wrong-app data cannot prove a condition.
Events may wake a poll but cannot stand in for the final fresh read. Initial release may use bounded polling.
Do not seed or reuse input targets from a read-only query.

Outstanding efficiency work: investigate whether the existing idevice/iOS interfaces support narrowing native collection or reusing sufficiently fresh field evidence without weakening the proof requirements. Record supported scope and measured latency against the full-tree path on the intended physical phone, or the observed interface limitation. This investigation and measured acceptance remain required; predicates and waits alone do not complete that outcome.

## 2. Shortcut completion and navigation
New tools: run_shortcut, get_app_action_status, list_app_links, open_verified_link.
Keep existing run_app_action compatibility. New callback execution is the explicit reliable completion path.
run_shortcut inputs: device, shortcut, input text, caller operation_key, bounded timeout; optional independent expected_app/postcondition.
Service: one daemon-owned AppActionStore; durable private journal under stateDir; exact resolved device and digest bind operation_key.
Journal prepared and dispatch intent before opening Apple shortcuts://x-callback-url/run-shortcut through the existing open_url approval path.
Host-generated single-use 256-bit tokens bind device, operation key and status. The general MCP bearer token never appears in URLs.
States: prepared, dispatched, success, cancelled, error, unknown, not_sent. Repeated same key+digest returns retained record; conflicting reuse rejects.
Restart, timeout, connection loss or caller abort after dispatch yield unknown until a valid callback settles the retained operation. Never dispatch a second time.
Duplicate callbacks are idempotent; conflicting terminal results cannot overwrite a receipt.
Callback endpoint is result-only, bounded and strict. Reject unknown fields, oversized text, wrong tokens and path/method mismatch.
POKI_SHORTCUT_CALLBACK_BASE_URL is explicit, phone-reachable HTTPS; missing/invalid setup refuses before any URL dispatch.
Root integrates the endpoint/relay. Service constructor accepts explicit origin and state path for tests. No automatic public listener or guessed hostname.
Success callback and optional app-state proof are separate fields.
The initial implemented link registry contains only the three owned Poki routes, with exact supported parameters, expected app/route evidence and honest physical verification status. The common-app workflow inventory, link/action definitions and physical verification needed to complete the set of 5–10 useful workflows remain outstanding.
Unsupported routes reject before navigation. Use existing open_url authority. No arbitrary URL scheme registry or arbitrary command execution.

## 3. iOS App Intents
Provide StartPokiTaskIntent, GetPokiTaskStatusIntent, CancelPokiTaskIntent and a bounded retained MainActor task registry.
Use existing ChatModel.runDelegated, stop, SessionStore, application authentication and action approvals.
Operation IDs deduplicate task starts. Report stable task_id and queued/running/succeeded/failed/cancelling/cancelled/unknown state without consuming completed records.
Respect the owner chat and AskPoki's single-writer guard; do not create an independent task runner.
Require local-device authentication for task start. Cancellation requests settle through existing ChatModel cancellation.
Accept text, with a clearly bounded text-file input if supported by current App Intents API; unsupported input fails explicitly.
No unverified third-party App Intent enumeration or execution claim.
Compile against the actual iOS project. Simulator build proves compilation only; physical acceptance is separate.

## 4. Safari DOM
New tools: safari_open, safari_observe, safari_query, safari_wait_for, safari_act, safari_close.
Use installed /usr/bin or Cryptex SafariDriver W3C; no Appium server/WDA dependency.
Module contract: safariTool(ctx,name,args) returns JSON; safariTools Set; closeSafari(ctx,onlyDevices) cleans only owned resources.
Schema exports safariDefinitions four-tuples compatible with tools.mjs.
Require explicit device and active matching lease_id; bind session to caller, exact resolved UDID, allowed origin and current device revision.
safari_open uses existing URL navigation approval semantics. Reserve an available loopback port; verify owned driver readiness and echoed UDID.
Capability discovery reports Remote Automation prerequisites, backend, isolated session and actual readiness errors.
Observe/query return bounded DOM text and opaque element refs; omit password values. No arbitrary evaluation API.
Act requires current observed ref, expected origin, correct Safari foreground and active lease. Fill prepares content and never implicitly submits.
Wait uses bounded predicates, deadline and cancellation. Never automatically retry uncertain actions.
Close and device lease/session cleanup delete only sessions/processes owned by this context.
No owner-tab Web Inspector/CDP takeover in this release unless separately implemented and verified; report unsupported instead of substituting an isolated session silently.
SafariDriver is the selected first backend for public travel search and reading acceptance. After that acceptance, evaluate Web Inspector/CDP for actually inspectable Safari pages or WebViews and workflows requiring a private login. That evaluation remains pending; no unrestricted owner-tab takeover is promised.

## Acceptance and release
- Meaningful unit tests exercise exact match/absence/completeness, prompts, deadlines, cancellation and wrong app/device.
- Callback tests exercise success/cancel/error, duplicate/conflicting keys and callbacks, restart, unreachable config, bounded inputs and uncertain dispatch.
- DOM tests exercise exact phone binding, current refs/origins, lease cleanup, driver faults and no replay.
- Root integration tests enumerate tool schemas and dispatch all new paths; existing npm test regression suite remains green.
- Compile Swift App Intents with the actual project target. No fake build receipt.
- Live acceptance requires valid phone control/owner availability: AX field/loading check, harmless installed Shortcut output, public Safari DOM read/fill, task start/status/cancel.
- Report each live case separately as verified, failed or blocked. Never convert a blocked physical check into success.
- Commit only reviewed task files, push a new dev branch and create/update a PR. Never force push or modify main directly.
- Production install/reload uses the existing deployment path only when its live owner permits. Record source commit plus binary/build identity and rollback handle.
- Preserve existing dual-phone and private overlays; public branch alone cannot replace their installation.
