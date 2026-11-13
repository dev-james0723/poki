# Native speed follow-up and Jev stop

The owner stopped Jev use on 12 November 2026 after the matched short-task results showed extra latency. No further real Jev request is part of this work. The ten-app Jev trip benchmark was **NOT RUN**; calendar creation and the one restaurant email remain **NOT DONE**. Earlier failures and abstentions remain in the original dataset.

## Real-phone evidence

Full native Poki MCP on Sing was the phone interface, including the native `run_code` sandbox. Setup/reset and approval were recorded separately from each timed task. Both conditions had the same physical operation and complete positive final AX check. The follow-up had three trials per condition per app and 18/18 verified task outcomes.

| Task | Local total median | Jev total median | Local decision median | Jev decision median |
| --- | ---: | ---: | ---: | ---: |
| Settings General to Keyboard | 5.569 s | 8.272 s | 0.05 ms | 708.52 ms |
| Clock Timers to Stopwatch | 3.221 s | 5.015 s | 0.11 ms | 545.86 ms |
| Owned Notes probe, 56 characters | 14.110 s | 13.140 s | 0.15 ms | 741.85 ms |

Jev was about 49% slower on Settings and 56% slower on Clock. The apparent 7% Notes improvement does not establish causality: native AX/helper waits varied, including a 28.207-second local outlier. Each Jev trial used a real observed-action model proposal, with no `exact_label` or silent local fallback. The local comparator is a deterministic reviewed selector, not the chat model's reasoning time. These measurements do not establish a human-speed ratio.

Sanitized follow-up records: [JSON](benchmarks/real-jev-core-followup-20261112.json). Preserve the [earlier core results](benchmarks/real-jev-core-20261112.json), including Settings/Notes Jev abstentions.

## Installed policy and diagnostics

`POKI_JEV_DISABLED=1` rejects external `choose_action` proposals before a new observation, approval or model request when no exact local selector is supplied. A mismatched exact selector also refuses before external approval. It revokes existing model-session consent; exact local choices continue to work. The Gateway transport independently refuses before Keychain access or network use. This flag must be set in the service's normal environment and requires its ordinary restart; it does not delete credentials or change other applications. `poki_mcp_status.jev_policy` reports `disabled` or `opt-in`. Default external proposals remain opt-in with real approval on installations without the flag.

Per-call source-freshness, target-resolution and helper identity/response/close timings expose where execution waits. They contain durations, not UI or credential values, and do not change the sandbox script's returned result. Parent and child durations overlap and must not be summed. The observed phase4c trials had roughly 5–21 ms source checks, sub-millisecond target resolution and socket identity/close waits, and 1.2–3.7-second helper responses. The earlier ten-second outliers were not reproduced or fully explained.

The local LaunchAgent's ProcessType was changed from Background to Interactive, retaining its supervisor and KeepAlive. The old daemon was priority 4 while the helper was priority 31. This is consistent with scheduling delay but is not proof of the cause. A same-process read-only priority comparison did not reproduce a ten-second stall. The separate restart/QoS control is confounded by restart and cannot establish the whole improvement.

## Rejected scroll optimization

A candidate replaced an otherwise unnecessary screenshot with a fresh native viewport for directional scrolling. The timed scroll plus final AX took 2.552/3.092/2.601 seconds, but only 1/3 trials reached both required language labels. The earlier Background baseline passed 2/3, and the unchanged-source Interactive control also passed 2/3. Preserve all failures: fixed start labels did not pin the exact list offset, so these trials do not isolate the reason for differing endpoints.

The new scroll implementation was withdrawn from the final source and local runtime. Faster dispatch with an unqualified endpoint is not accepted. Content-free [trial data](benchmarks/native-scroll-rejected-20261112.json) remains available. Previously qualified native reading, text input, batch and workflow features are retained.

## Validation

Focused public checks passed 103/103. The final private integration candidate passed 88/88, including K1 unlock, launch-speed and workflow-grant checks. New disable tests first failed, then passed with the guard: no observation/approval/model access for a pure external request, exact local selection still works, a wrong exact label cannot reach external approval, an existing consent is revoked, and direct Gateway use cannot read a key or send. These are local software checks, not full CI or ten-app acceptance.
