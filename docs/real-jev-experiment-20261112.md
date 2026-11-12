# Real-phone Jev experiment protocol

Protocol frozen before phase-four measured phone trials, 2026-11-12.

Use Sing, iPhone 15 Pro Max, through the full native Poki MCP only. The existing native `run_code` sandbox may orchestrate tools; no Terminal/SDK phone client is an execution route. Preserve K1's pause, private capabilities and unknown voice ledger.

## Comparators and timing

Run three trials per condition per task, interleaving local/Jev pairs and reversing order in pair two. Both conditions use the same installed software, candidate labels, typed payload, app start state, touch dispatcher and complete positive final AX check. Setup, returning to the start, permission dialogs and warmup are separately recorded and excluded from the timed task. Record every failed or abstained trial; do not silently fall back from Jev to an exact label.

The local condition selects a reviewed, uniquely observed exact label without an external call. The Jev condition supplies no `exact_label`: the real model selects an action ID from current native AX candidates. Execute the returned proposal label only after the normal dispatcher validates the foreground and target. Require `source:jev` and `model_calls:1`. A proposal does not authorize input or certify the result.

Report `decision_timing.decision_ms`, native observation time within the selector, and the elapsed real-phone task through the identical final checkpoint. Approval time has a separate counter. Also retain caller/transport elapsed time; do not add nested parent/child timings. Decision time includes adapter/auth/network/model latency, not just unobservable model compute. Local exact-label choice is not a benchmark of the main chat model. A Jev-versus-local difference cannot establish a speedup over that model or over a person.

## Repeated short tasks

* Settings: verified General page; choose between observed Keyboard/Fonts/Dictionary; open Keyboard without changing settings. Verify Text Replacement and keyboard configuration controls.
* Clock: Timers selected; choose among observed navigation tabs for elapsed-time/lap measurement; open Stopwatch without starting it. Verify Stopwatch selected, Start, Lap and zero elapsed time.
* Notes: reuse only the owned synthetic speed-test note. Replace its controlled contents with the same 56-character probe, choose how to finish editing without sharing/undoing, and verify the exact text with the keyboard dismissed. Reset only after confirming the owned contents; never replace a personal note.

## Ten installed apps, five-day Japan trip

Chrome researches official Tokyo travel information; Google Maps locates the day route; Trip.com searches accommodation; Airbnb compares accommodation; Google Translate prepares a Japanese reservation phrase; Calculator checks an illustrative budget; Notes holds a five-day itinerary; Reminders previews packing tasks; Google Calendar previews the schedule; Gmail prepares the restaurant request.

The phone inventory confirmed these ten apps are installed. Installation is not flow acceptance: preflight each actual UI, freeze observed selectors and positive checkpoints, then use the same operations and data for all six runs. Every model decision must consume the current real phone observation, not a synthetic tree. Review only generic navigation labels for outbound model candidates; do not send email contents, contacts, field values, screenshots or full UI trees to Jev.

The owner chose a real trip and delegated the itinerary choices. The working plan is Tokyo, two people, 8–12 March 2027. Calendar creation and Gmail sending must not repeat six times. Repeated measurements use previews and the owned draft; the final schedule and one restaurant enquiry are separate one-time actions after official contact details and the sender are verified. No booking/payment is part of the benchmark.

Actual preflight foreground names include `AirBNB` rather than its display spelling `Airbnb`. Consent must enumerate the observed foreground identity. Trip.com emits navigation labels with trailing whitespace; normalize matching for reviewed selectors while retaining raw native labels/object identities in the internal model catalog. Multiple normalized matches remain a refusal.

The short-task local comparator is deliberately deterministic. The initial core trials found three successful Clock Jev proposals and six abstentions across Settings/Notes. Keep those failures. A follow-up description may identify the requested submenu explicitly, but must keep the same UI action and final check and must not lower the 0.85 confidence threshold.

For a follow-up typing optimization, explicit non-submitting `native_text_result` may return the native field proof from a direct tool call (or the final batch text step). The subsequent choice still observes current UI and the final note check still verifies exact text and closed editing. Missing native evidence retains the normal full readback. A timed-out explicit `snapshot_ui` ends its batch with a failed-read receipt instead of an automatic second read; no successful postcondition is claimed.

## Scoped consent

Default one-call real approval remains. An optional in-memory consent can cover a finite call count, finite expiry and enumerated apps within one exact device lease and MCP context. It is installed only after the existing human dialog and a new live read. Releasing/replacing the lease, expiry, cancellation or budget exhaustion prevents reuse. Count an authorized failed attempt against the budget; never retry a paid request automatically. Restarting the daemon discards consent.

## Research receipt

Checked 2026-11-12 before implementation:

* [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast/tree/cf3c406f0fc4becff8986ed4d4d37b7b9f102e45), commit cf3c406 (2026-11-11), MIT LICENSE. It has source, tests and documentation. Recent issue 244 was closed on 2026-11-11; two newer issues remain open, which is not a general responsiveness guarantee. Its README redirects new users toward Browser Use's integrated ultrafast path. Adopt the bounded observed-action-space idea through the existing reviewed gateway adapter; do not install its Python/browser controller as a phone interface. Public advisory listing returned zero; absence of published advisories is not a security audit.
* [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c), commit 919bb8e (2026-11-10). Its actual LICENSE describes an Apache-2.0 transition with retained MIT contributions and CC-BY-4.0 documentation; GitHub reports NOASSERTION. It has active source/tests and published security advisories concerning OAuth, session ownership, transport sharing, redirects and request limits. No new SDK code or dependency is adopted here. Retain the pinned local packages and context isolation.
* [Official MCP elicitation specification](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) requires actual user input and forbids secret collection through elicitation forms. Reuse Poki's existing real local approval dialog; do not introduce client elicitation plumbing or manufacture an approval response.

Selected approach: existing dependencies, a context-local WeakMap capability, existing lease validation and existing native tool dispatcher. This adds a small maintenance surface without a new service, model runtime or production dependency. Mocked consent tests verify ownership, expiry, cancellation, refusal, app/count bounds and timing separation. These checks do not establish real model correctness or phone speed; measured results must be recorded separately.
