# Installed native speed and typing, 2026-11-12

All physical operations used the full native Poki MCP path on Sing (iPhone 15 Pro Max). No CLI/SDK phone-control client was used. Terminal was used for source/build/tests and a catalog-only registration diagnostic.

## Matched three-trial navigation/draft comparison

Preparation was excluded from timing, and reset/checkpoint/timed calls ran consecutively without model-turn gaps. Each timed task ended with a complete native AX check. All 18 matched observations verified their positive result. The warm procedure differs from the prior exploratory one-shot report. Do not attribute the whole historical 6.4x-to-current change to this patch.

| Task | Before median | After median | Median reduction | Before mean | After mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| Settings General → Keyboard | 3.129s | 1.633s | 47.8% | 3.457s | 2.331s |
| Clock Timers → Stopwatch | 3.081s | 1.535s | 50.2% | 3.307s | 1.536s |
| Notes empty owned draft → 56 characters | 12.614s | 9.879s | 21.7% | 12.933s | 9.328s |

The six navigation trials totaled 20.29s before and 11.60s after. The owner reported about 5s for six corresponding manual trials, giving a pooled current ratio of 2.32x. There are no per-app human times or human typing measurements.

Individual milliseconds (all retained):
* Settings: [3129, 3026, 4215] → [3763, 1633, 1596].
* Clock: [3081, 3764, 3075] → [1535, 1542, 1531].
* Notes: [12614, 11380, 14805] → [10380, 9879, 7724].

## Clock and the remaining delay

The previous 4.495s/7.484s samples were both cold HID sessions. A five-second idle release had discarded the warm media/touch connection during preparation/model gaps. The new controlled baseline used warm touch in all three trials. This is evidence of a confound, not proof that one factor explained the entire old regression.

The first new cache prototype lost its native viewport binding at dispatch and triggered an extra screenshot: Clock 5.809/2.913/3.000s. These three rejected prototype trials remain in the JSON. Semantic lookup now rebinds only complete, live, revision-matched native geometry within 200ms; raw coordinate/CUA rotation checks remain intact. The final Clock trials used one AX read and no screenshot. Input took about 354ms, including the retained 300ms delivery hold; final AX took about 1.15s.

The after Settings outlier (3.763s) required two AX subscriptions. Notes still spends seconds generating/receiving AX data; its full final read took 1.956–4.740s. Native cleanup was normally 0ms, so a 100ms cleanup cap is a bound against stalls, not a demonstrated main speedup. Queue wait stayed below 1ms. The historical unexplained 12–18s admission delay did not reproduce and is not claimed solved by Jev.

## Typing: 1,000 Unicode characters, three trials per mode

Standard type_text + whole-screen checkpoint: [10034, 9150, 8761]ms; median 9.150s.
Explicit native_text_result: [4835, 4313, 4677]ms; median 4.677s, 48.9% lower response latency. All three native receipts confirmed the exact text without Return, and all three independent full AX checks also matched. Those independent checks occurred after stopping the fast-mode timer and took [4022, 1360, 4529]ms.

This improvement removes a redundant full-screen read after native AX already verified the exact field. It does not mean the underlying paste keystroke became twice as fast. It is for a final draft-input task; workflows that need the next screen/control must still observe it. Native field identity, secure-field refusal, prompt handling, text comparison, other-field checks and clipboard compare-before-restore remain in force. Incomplete/old/unknown receipts fall back to the normal readback. A dependent step, submit, missing expected_app, or requested screen observation rejects the option before any input.

The 56-character full-checkpoint Notes trials also showed native input-phase median about 5.77s → 4.12s, with AX variability inside that phase. New phase counters show initial/verification AX around 1.5s each, clipboard snapshot around 0.2s and a zero extra connection when the complete PULL connection is reusable. A failed PULL uses a new connection; no late reply is reused. Clipboard restoration was unavailable on one 56-character after trial and one standard 1,000-character trial; all three fast 1,000-character trials restored it. No clipboard contents are included in this report.

## Jev and 4710c0f

4710c0f was already ported in d342e1e; this round verified the installed implementation rather than cherry-picking private history again. Six real owner-authorized Jev API calls sent synthetic button data only. All six selected the correct option; latency was 219–899ms. These calls did not choose the actions in the fixed phone benchmark. A causal Jev end-to-end speedup is NOT MEASURED. Known labels use deterministic local selection.

A freshly initialized native stdio registration exposes 70 tools, including run_workflow, tap_sequence, run_app_action and choose_action. The current chat still has 66 directly exposed names from its cached client; editing configuration did not hot-load them. The unmodified compiled workflow program ran through native run_code on the phone with four successful calls, a local choose_action proposal and a positive final Stopwatch condition. This qualifies the installed workflow core, not a direct run_workflow call from this cached catalog. Numeric tap_sequence and an existing-Shortcut app action were not additionally exercised live in this round.

## Installed artifact, source and validation

Public source: ce97e4f (native speed) and 1ebb933 (final-draft text result), on dev/native-mcp-speed-20261112; draft PR #2. The installed checkout retains its existing 7e3df7c Git HEAD and other private work; that HEAD is not the compiled source identity. Installed native source fingerprint: `583fd4e657ace1e679221f0dc326d0346b51ca3d9710be20d6c071a9fa1a1186`; binary SHA-256: `0cb5835bb02777e2ceb856ccab5fa386b02a6c3ae04d5c7216bd814c575aad3b`. The local native-build receipt binds source bytes/modes to the embedded build ID. It is not a hermetic/reproducible-build claim.

Local checks: full public JS suite at ce97e4f 428/428; native public Rust 42/42; integrated native Rust 46/46; final typing/batch/workflow focused tests 97/97; K1 plus new typing integration tests 77/77; final focused cache/text checks 29/29. Tests first reproduced the unconditional paste delay, stale cache/provenance reuse and text-only result failures. A debug stack overflow also reproduced on the unchanged local native overlay; boxing its measurement future fixed it without increasing the production stack or weakening unknown-delivery handling.

The initial geometry reload accidentally replaced the private Device extensions. K1 remained paused, and no K1 phone input ran in that interval. The final integration restores those extensions through a three-way merge, preserves the private tool definitions, and passes the K1 tests. The uncertain voice session remains open UNCERTAIN/UNSENT, without any Send claim or replay. The resident receiver stays stopped. The synthetic Notes draft was restored to its original 56-character probe; no timer/stopwatch was started.

One local MCP token rotation occurred during the initial source-mode recovery, and the native client recovered through its supported lazy reconnect path. Subsequent reloads preserved that token. Pairing/state/port and five private configuration files were preserved. GitHub jobs are blocked by the account billing lock; no billing change was made.

See [research receipt](native-speed-research-20261112.md), [fast typing usage](native-fast-typing.md), and [raw numeric observations](benchmarks/native-round3-20261112.json).
