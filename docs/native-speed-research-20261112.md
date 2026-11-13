# Native speed research receipt, 2026-11-12

This round keeps the existing Rust `idevice` dependency pinned at `89702099f4d7552f704f93b4526756abda319ceb` (MIT). No production dependency or license change.

## Primary evidence and alternatives

* [pymobiledevice3](https://github.com/doronz88/pymobiledevice3/tree/03d788d23105c1754c27cc4e6ddc1d7e23835b32), commit `03d788d` dated 2026-11-11, GPL-3.0. Its [HID source](https://github.com/doronz88/pymobiledevice3/blob/03d788d23105c1754c27cc4e6ddc1d7e23835b32/pymobiledevice3/remote/core_device/hid_service.py) authenticates touch with a video-only session and a 500ms settle period. [Issue 2036](https://github.com/doronz88/pymobiledevice3/issues/2036) documents dropped first touches at 300ms on an iPhone 11 and the maintainer's fix in PR 2039. There is no demonstrated authenticated/readiness flag to replace that wait. Borrow the protocol pattern; do not copy Python implementation or introduce its dependency tree.
* [go-ios](https://github.com/danielpaulus/go-ios/tree/794aab7018a053b3be9090930c8dba545abbf317), commit `794aab7` dated 2026-11-11, [MIT](https://github.com/danielpaulus/go-ios/blob/794aab7018a053b3be9090930c8dba545abbf317/LICENSE). Reviewed HID session/controls source, gesture/unit tests and open tunnel issues. Its current HID API requires iOS 27/kernel tunnels and is not a drop-in replacement for Poki's Rust RemotePairing architecture. Keep Poki's current transport and release/unknown-delivery rules.

Both repositories were active, not archived, on the check date. Public advisory lookup returned one low-severity pymobiledevice3 advisory, [GHSA-g7ph-v4p5-xwv3](https://github.com/doronz88/pymobiledevice3/security/advisories/GHSA-g7ph-v4p5-xwv3), fixed in 11.17.0, concerning device paths and unauthenticated mirroring servers; go-ios returned no published advisories. This is a public advisory lookup, not a dependency security audit. No third-party server or installer was run.

Agent Reach 1.6.1 was checked. This installation rejects `doctor --json`, but `doctor` worked and reported GitHub available. The referenced `references/dev.md` was absent. Research used the official GitHub API and primary source pages instead.

## Chosen focused changes

* Retain the full fresh AX tree and positive final checkpoints. Reuse a complete, live, revision-matched result for the first fast semantic lookup only within 200ms; reject events, prompts, unverified geometry and stale revisions. Inputs still invalidate the cache.
* Bound disposable AX unsubscribe/shutdown cleanup to 100ms. Keep the overall read deadline and cancellation behavior. Report numeric connect/subscribe/answer/cleanup counters to distinguish device generation from host overhead.
* Check pasted text immediately, then retain at most two delayed reads at 400ms intervals. Never redispatch paste as a verification retry.
* Reuse the clipboard connection only after receiving and validating its complete PULL reply. A failed/timed-out snapshot drops that socket; SET gets a new connection. Preserve the eight-second snapshot budget, exact-field readback, other-field checks and compare-before-restore behavior. Add content-free phase timings.
* Start video only for the HID authentication gate; keep audio+video behavior available to screen-media callers. Retain 500ms authentication settling and the 300ms delivery hold. This does not establish microphone compatibility with K1.

The local `native_execution_v1` overlay had a debug stack overflow before these changes. A boxed measurement body preserves the existing measurement scope while avoiding the large inline future. Its compatibility patch is stored under `docs/integration/`; it applies to that overlay, not to an unmodified upstream tree.

## Jev decision API

Verified the [official Vercel TypeSafe contract](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe). Used the existing Keychain credential only in process; no credential was logged or committed. Six owner-authorized requests sent synthetic Clock button choices, no phone contents or screenshots. All six returned the correct choice with native confidence >=0.85. Jev 1.14.0 took 899/596/253ms; the alias took 292/239/219ms. These were sequential small samples with a cold first connection, so they do not prove the alias is intrinsically faster. Retain the reviewed pinned model for native model proposals and deterministic local selection for known labels. No model proposal grants input authority.

## Verification and qualification

Failing-first tests reproduced the unconditional initial 400ms paste delay and unsafe cache reuse after revision/provenance changes. Tests cover delayed/failed AX reads, wrong fields, paste prompts, expired snapshots, device changes, stalled cleanup and cancellation. Real-device before/after results and exact installed artifacts belong in the round-three benchmark receipt. Synthetic API latency and local unit tests do not establish installed phone speed.
