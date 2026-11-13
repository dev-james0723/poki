# Poki phone capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development, with isolated worktrees for independent tasks and controller-owned shared integration.

**Goal:** Deliver the selected phone-control capabilities through real APIs, with durable evidence and an installable, verified release.
**Architecture:** AX-only predicates; daemon-owned shortcut journal/callback receiver; shared iOS task registry; lease-bound W3C Safari adapter.
**Tech Stack:** Node.js 24, Zod, native Rust AX bridge, Swift App Intents, Apple SafariDriver.
**Spec:** docs/superpowers/specs/2026-11-12-phone-capabilities.md

## Global Constraints
- Work only in assigned isolated worktree; do not write the installed dirty checkout or interrupt its live owner.
- Preserve approvals, phone privacy pauses, device leases and uncertain-mutation no-replay behavior.
- No private identifiers, tokens, callback origins or user content in tracked files.
- Native AX collection remains full-tree; receipts separately report verified coverage. Receipt size reduction is not measured native speedup.
- Shortcut callback and app-state verification are distinct evidence; unknown never means not executed.
- Safari automation is isolated and must bind the exact phone and active lease.
- All new tools require schema, discovery, routing, meaningful tests and honest readiness receipts.
- User authorized implementation, commit, push and deployment. Do not ask again for ordinary authorized work.
- Each implementer owns only assigned files and commits only those files. Root owns shared integration.
- Apply test-first behavioral verification. Stop optional testing after concrete risks and gates are covered.

## Review Focus
Cross-device actions; stale/incomplete absence proofs; callback replay/restart; unbounded or secret outputs; stale DOM refs; idle ownership cleanup; Swift task ownership; source/build/deployment identity.

### Task 1: Native AX query and wait
**Worktree:** ../phone-capabilities-ax-20261112
**Files:** create src/ui-query.mjs, src/ui-query-schema.mjs, test/ui-query.test.mjs; narrowly extend src/ax-snapshot.mjs only if required.
**Consumes:** snapshotUI, work deadline/abort, target/app/revision metadata.
**Produces:** uiQueryDefinitions, queryUI(ctx,args), waitForUI(ctx,args); plain JSON receipts.
- [ ] Write failing tests for exact field equality, bounds, absence on incomplete source, foreground mismatch, prompt and cancellation.
- [ ] Implement validated query_ui/wait_for_ui contracts from the spec without image attachments or input-cache reuse.
- [ ] Record actual read source/completeness and timing; keep native full-read limitation explicit.
- [ ] Run targeted tests and npm test, inspect diff, commit owned files.
- [ ] Report API exports, commit, test evidence and live dependencies to root.

### Task 2: Correlated actions and task intents
**Worktree:** ../phone-capabilities-actions-20261112
**Files:** create src/app-actions.mjs, src/app-actions-schema.mjs, src/app-links.mjs, test/app-actions.test.mjs; own new Swift PokiTaskIntents/registry files and narrow AskPoki/PokiApp integration.
**Consumes:** existing open_url approval dispatcher, stateDir, ChatModel/SessionStore/AskPoki ownership.
**Produces:** appActionDefinitions; AppActionStore; runShortcut(ctx,args,store); get status/list/open link helpers; callback handler; retained Swift task intents.
- [ ] Write failing behavioral tests for idempotency, exact device binding, callback states, restart barrier and no dispatch with invalid origin.
- [ ] Implement durable private journal, strict callback endpoint and bounded retained receipt handling.
- [ ] Export HTTP handler for root's daemon/relay integration; explicit reachable origin required.
- [ ] Add small owned-route registry with honest verification metadata.
- [ ] Implement Swift intents reusing existing task ownership/cancellation; compile or report exact compiler blocker.
- [ ] Run targeted tests and npm test, inspect diff, commit only owned files.
- [ ] Report callback handler contract, cleanup, Swift build evidence and commit.

### Task 3: Physical Safari DOM
**Worktree:** ../phone-capabilities-safari-20261112
**Files:** create src/safari-dom.mjs, src/safari-dom-schema.mjs, test/safari-dom.test.mjs.
**Consumes:** device target, coordinator lease, work deadline/signal, native foreground verification, URL approval.
**Produces:** safariTools Set; safariTool(ctx,name,args); closeSafari(ctx,onlyDevices); safariDefinitions.
- [ ] Write failing tests for session/device/lease binding, stale refs, origin mismatch, isolated session and uncertain action handling.
- [ ] Implement real SafariDriver W3C lifecycle, bounded DOM queries/actions/waits and ownership cleanup.
- [ ] Return actionable Remote Automation/setup errors without falsely claiming ready.
- [ ] Keep owner Web Inspector/CDP unsupported explicitly; do not misrepresent independent Safari sessions.
- [ ] Run targeted tests and npm test, inspect diff, commit owned files.
- [ ] Report exact integration hooks, commit and remaining physical prerequisites.

### Task 4: Shared integration and documentation
**Worktree:** phone-capabilities-20261112
**Files:** src/tools.mjs, src/device.mjs, src/daemon.mjs, src/coordination.mjs only if necessary; integration tests; docs.
**Consumes:** reviewed commits from Tasks 1–3.
**Produces:** discoverable routed tools, daemon callback endpoint/available relay, cleanup and readiness, updated tool docs.
- [ ] Run baseline regression suite before integration.
- [ ] Write failing integration tests for schemas, coordinator/approval routing and callback lifetime.
- [ ] Cherry-pick reviewed subsystem commits and implement central dispatch/cleanup.
- [ ] Keep callback public ingress result-only; reuse an existing approved relay if available, otherwise report configuration readiness truthfully.
- [ ] Verify tool catalog/discovery, npm test, Swift build, and permitted physical smoke cases.
- [ ] Update release evidence with source and build identities, limits and exact observed outcomes.

### Task 5: Ship and verify
**Files:** release evidence, PR description; existing deployment configuration only when ownership permits.
- [ ] Review complete branch for spec and quality, fix material findings, rerun relevant gates.
- [ ] Commit task files; push new dev branch; create/update reviewable PR with exact validation.
- [ ] Recheck installed checkout and phone ownership before touching the live daemon.
- [ ] Preserve existing overlays, state directory/token/port; deploy through the existing controlled path with rollback.
- [ ] Verify deployed tool inventory, exact code/build identity and safe user-visible paths.
- [ ] If an external owner/privacy/setup gate remains, retain the concrete release and state the exact uncompleted gate rather than claiming production success.

## Decisions
- Use the public native-speed branch as an explicit stacked dependency; the installed dirty private tree is not a public source.
- Independent implementations run concurrently in separate worktrees; shared files have one owner.
- Do not invent scoped iOS AX queries absent a verified native API.
- Use SafariDriver now; owner-session Web Inspector needs a separately verified backend.
- Callback origin is configured rather than guessed; root will inspect the existing ingress path.
