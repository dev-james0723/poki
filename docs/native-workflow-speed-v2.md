# Native workflow speed v2 — clean fork port

This branch ports five bounded speed improvements and their required native/AX/session support onto the clean fork history. Shared-service activation is tracked separately from source and software validation. Physical-iPhone acceptance, app-specific Shortcuts, live provider acceptance and a human speed comparison remain unverified. Software fixtures do not establish those outcomes.

The port is based on fork main `291a904c42930b7b6a5efd3e92235ce97ca07349` plus the first-stage commits on this branch. The isolated implementation was originally reviewed against `7e3df7c2662f5128fbca7fa1a9bc6580619a6d73`. All phone operations continue through the existing native Poki MCP dispatcher, its one daemon, device arbitration and approval paths. No Terminal phone client or additional daemon is introduced. Existing unrelated K1 and stage-one work is excluded.

## 1. One native call for a complete workflow

`run_workflow` validates a declarative plan and compiles it to the existing `run_code` sandbox. User strings remain JSON input, never executable JavaScript. A live start condition and a positive final result condition are mandatory. Conditional branches and checkpoints read fresh AX; known navigation steps omit redundant action readbacks. A final check always runs. The existing 120-second and 60-tool-call bounds remain in force, and nested workflows are rejected.

Supported steps are semantic `tap`, verified draft-only `fill`, `scroll`, local/opt-in `choose`, numeric `sequence`, and `app_action`. The plan is an explicit reviewed procedure, not an authorization or a general classifier for consequential actions. A `when` condition can skip an unnecessary action locally without a model round trip. A missing start, failed checkpoint, unknown input outcome or cancellation stops execution.

Example plan, for use only after the labels and initial screen have been observed on the selected iPhone:

```json
{
  "device": "EXACT_DEVICE_ID",
  "expected_app": "Calculator",
  "start": {"all": ["Change Mode"]},
  "steps": [
    {"kind": "tap", "label": "Change Mode"},
    {"kind": "tap", "label": "Scientific"}
  ],
  "finish": {"all": ["Sine", "Cosine"]}
}
```

## 2. One native input session for numeric key sequences

`tap_sequence` accepts 2–8 observed numeric Key labels and requires `fixed_layout:true`. It obtains a live AX observation, checks device, foreground, scene revision, complete geometry and prompt state, then prevalidates all key positions. It reobserves immediately before input and refuses any changed key positions. System or secure keypads and devices with active recording owners are refused. Simulators and old native helpers are refused before input.

The new Rust `tap_sequence` request reuses one touch service and retains the existing 300ms delivery hold once after the sequence. Per-key press durations and inter-key intervals are bounded. A failed report names earlier completed taps and the uncertain tap, stops and never replays the sequence. A successful receipt remains `verified:false`: it proves dispatch, not application acceptance.

This is deliberately a numeric-keypad implementation. Arbitrary moving buttons, Send/Return, purchases, deleting data and multi-screen macros are outside its supported input set. Hardware qualification must precede broader support or a shorter delivery hold.

## 3. Scoped AX output

`snapshot_ui` accepts `query.labels` and/or `query.roles`. Only matching elements are returned, reducing model/worker payload and irrelevant content. The result exposes `source_total` and `scope.returned:"query_matches"`.

The iPhone still sends a complete AX tree. This change does **not** claim to reduce the native subscription or iPhone-to-Mac read latency. Full-tree prompt checks and input caches remain intact; a filtered result is never represented as an unfiltered whole-screen observation. Label queries use the same NFKC, case and whitespace normalization as workflow conditions, so a negative condition cannot silently omit an equivalent visible label. Whole-screen batch readbacks reject scoped projections and inconsistent source counts. Event hints remain observation hints and cannot authorize input.

## 4. Existing native app actions

`run_app_action` constructs the official `shortcuts://run-shortcut` URL for an existing, reviewed Shortcut, with optional text input. It dispatches ordinary `open_url`, preserving its normal approval mode and without passing K1/voice capabilities. A fresh live AX result must match the requested device, foreground and positive result condition.

The tool verifies the requested visible result state. It cannot prove an unseen background side effect merely from a pre-existing label. Choose result conditions that distinguish completion from the initial screen; for a purpose-built probe, pass a unique nonce and require that nonce in the visible result. Unknown outcomes are not automatically retried.

This does not add App Intents to third-party apps or create Shortcuts. The selected app must expose the required action, or the owner must already have a reviewed Shortcut. Approval for a Shortcut does not grant new authority for payments, messages or other actions inside it.

## 5. Local-first navigation decisions

`choose_action` reads 2–6 current observed navigation labels. A unique `exact_label` uses deterministic selection, without a model or dialog. `use_model` defaults to false; an ambiguous local decision returns REOBSERVE.

An external choice requires a real host approval dialog disclosing the app, goal, labels and one potentially billable Jev request. The tool reobserves after approval, binds the one-request grant to that fresh observation, and uses the existing Vercel gateway adapter with `typesafe-ai/jev-1.14.0`. Only the minimized goal/app/candidate catalogue is transmitted, not screenshots or other screen contents. Credentials remain in the existing Keychain path and are not logged. Source staleness, changed foreground/revision, invalid or low-confidence choices, cancellation and provider failure stop selection without retries.

The returned label is a proposal with `execution_authorized:false`. `run_workflow` revalidates it through normal native `tap_text` before input. `model_calls` counts external HTTP attempts started, not successful inference or billed cost. Approval and model phases are separately timed.

## Compatibility and activation

Four additive tools raise the full catalogue from 65 to 69. The existing default discovery profile remains unchanged. Use the owner-required `POKI_MCP_TOOLS=all`; a newly connected client is needed to discover the additions. Editing this branch does not hot-load tools into existing chats.

The shared service and remote helper must be updated at a coordinated safe boundary before physical use. A live native observation must advertise `native_tap_sequence`; merely finding a new binary on disk is insufficient. Keep existing state, pairing, credentials, approvals and other owners' operations. No deployment or phone operation is performed by importing these modules.

## Research receipt

Primary evidence was reviewed on 2026-11-11/12:

* [Appium WebDriverAgent v16.15.3](https://github.com/appium/WebDriverAgent/releases/tag/v16.15.3), release commit `02cb92f`, 2026-10-16: native action sequence source and integration tests. Its BSD-style [LICENSE](https://github.com/appium/WebDriverAgent/blob/v16.15.3/LICENSE) was inspected. A recent release fixes MJPEG address binding; it is evidence of maintenance, not phone-speed acceptance. Its security page listed no published advisories, which is not a security audit.
* [browser-use/jev-ultrafast performance evidence](https://github.com/browser-use/jev-ultrafast/blob/main/docs/performance.md): structured state, combined operation/target choices and fewer protocol calls. Its MIT [LICENSE](https://github.com/browser-use/jev-ultrafast/blob/main/LICENSE) was inspected. The published three-pair browser comparison reports 9.450s to 7.092s median; it excludes initial navigation and a fresh independent post-run check. This is not an iPhone or human benchmark. The report pins the original arm to `68c077bf79caca4e817b8e8a5854b2efa0c81ff6`; the optimized commit was not independently pinned in this research. Public security and maintenance evidence is incomplete, so no dependency is adopted.
* [Apple App Intents](https://developer.apple.com/documentation/appintents/acceleratingappinteractionswithappintents/): official action entry points, subject to app support. The [Shortcuts URL scheme page](https://support.apple.com/guide/shortcuts/run-a-shortcut-from-a-url-apd624386f42/ios) returned HTTP 429 during this round; its exact contract was reused from the existing Poki path and URL encoding was software-tested. Recheck that primary page before live qualification; no rate-limit bypass was attempted.
* Existing local Poki `run_code`, `snapshot_ui`, `input`, decision-selector and Vercel transport were reused. Agent Reach 1.6.1 doctor worked; its GitHub channel remained unverified and the installed `references/dev.md` was absent. Official upstream web sources supplied the research.

Selected strategy: adapt proven patterns within existing Poki modules. No third-party code was copied and no production dependency, license, credential, pairing or shared configuration changed. There is therefore no new transitive dependency tree to audit. Replacing Poki with WDA, idb or a browser driver was rejected for this task because it would add transport/signing/maintenance work and would not preserve the requested native Poki interface.

## Physical qualification still required

Start with matched, practiced tasks on the same iPhone and connection: familiar navigation, known long-text entry, and a multi-step task. Alternate human/Poki order, separate warm and cold starts, and count all loading, errors, recovery and final result checks. Measure goal-to-verified-result time in addition to native motor time; component timings exclude model/client overhead and must not be presented as end-to-end times.

Use a small pilot first, then at least 30 matched trials per selected task before a performance qualification. Report every failure and intervention, median and tail observations; a small-sample p95 is exploratory. The proposed first target is at least 20% lower median task time with no observed reliability regression. Broader claims require broader tasks and more evidence. No claim of faster-than-human performance is made by this branch.


## Port and admission diagnostics (2026-11-12)

The port includes bounded/cancellable AX, shared foreground-aware AX cache signatures, warm native input channels with explicit cleanup, exact remote identity resolution, lazy/resilient stdio discovery, guarded native URL transport, and the proposal-only gateway adapter. The existing pinned idevice checkout is clean at `89702099f4d7552f704f93b4526756abda319ceb`; its MIT notice is already included. No production dependency, dependency revision or license changed. Private K1 grants, personal device defaults, old local commit history and credentials are excluded. Public selector callers must supply the expected device explicitly.

A read-only batch previously acquired a wildcard input lock when it had no selected device. Adding a wait to an exact-device input batch could also widen that lock to all phones. Controlled tests reproduced both cases before the fix. Read-only batches now use existing bounded read admission, and only input steps determine a mixed batch's device lock. Unknown/multiple-device inputs retain global arbitration, and session ordering/cancellation remain intact. A controlled held-lock test assigns the wait to the lock-wait counter.

Completed and failed batch/workflow/sandbox envelopes expose content-free `timing`: total service and dispatch time, total queue time, session-queue/device-resolution/lock-wait components, and selected nested phase totals/counts. Parents include children, so totals must not be summed across levels. A plain-text early error remains verbatim and gains a separate `diagnostic_only` timing receipt; it never claims whether prior input was delivered. This remains visible when an MCP host strips `_meta`. Comparing client elapsed time with `service_ms` separates daemon work from the external RPC/client interval without bypassing any admission or approval gate.

The historical 12–18 s no-input batch delay did not repeat before this port: current no-input native calls were 19–24 ms with the old source. The host permission profile and concurrent activity changed between rounds, so these observations alone cannot prove the historical cause or credit a code speedup. Current-epoch baseline preparation also encountered 45 s target lookup and 10 s AX timeouts. A native reconnect was followed by a 2.1 s successful read; another attempted trial overlapped a shared K1 reload. These failures/interference are retained, not counted as successful speed measurements.

Software validation: full public Node suite 415/415 passed before the final diagnostic-only error receipt addition; final diagnostic and protocol checks are recorded separately. Rust 38/38 passed and an optimized native release binary built locally against the unchanged pinned dependency. Gateway device-binding/cancellation and workflow checks passed 73/73 with synthetic inputs and no live credentials/model calls. A mistakenly copied test for an unrelated, unported Terminal phone runner was moved out of this native-only port; no existing public test was removed.

Physical qualification covers Calculator plus Settings navigation, Clock tab navigation and a synthetic Notes draft. Each task needs a verified final state, all failures and preparation/interference reported separately. These are planned qualification tasks until measured results are attached; software tests do not establish phone-speed or all-app acceptance.


## Installed physical result

The coordinated Sing update and three-app comparison are complete for the scope in [the measured results](native-multi-app-results-20261112.md). The installed runtime advertised 70 tools including local K1 support; the clean public catalog has 69. Existing client discovery still needs normal reconnection. All six specified single-trial app flows were verified, with both faster and slower observations. Hardware qualification of every new API is not claimed. GitHub CI could not start because the account is billing-locked; local checks passed.
