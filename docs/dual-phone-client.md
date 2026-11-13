# Independent phone sessions

Poki's one-shot CLI gives each ordinary invocation its own MCP session. `connectPair()` provides two persistent clients for workflows on two physical phones. Both connect to an existing Poki daemon, with one session and an explicit device identity per workflow.

The included acceptance runners exercise a bounded Calculator workflow. Separate client sessions let both workflows make progress without switching a Mac window. Whether native handlers actually overlap is a separate measurement; client request overlap alone does not prove it.

## Paths and prerequisites

| Item | Repository-relative path |
| --- | --- |
| One-shot CLI | `bin/call.mjs` |
| Persistent connection API | `bin/dual-phone/connect.mjs` |
| Device session wrapper | `bin/dual-phone/device-session.mjs` |
| AX acceptance runner | `bin/dual-phone/run.mjs` |
| Interactive visual acceptance runner | `bin/dual-phone/visual-run.mjs` |
| Native handler overlap analyzer | `bin/dual-phone/analyze-native-overlap.mjs` |
| Native build provenance helper | `bin/native-build-receipt.py` |
| Private device configuration template | `bin/dual-phone/devices.example.json` |
| Private AX plan template | `bin/dual-phone/inspect-plan.example.json` |

Use the Node version required by the checkout and its installed dependencies. Configure the existing daemon's state directory explicitly; the default state directory may refer to a different service. These clients read the endpoint privately. A token does not belong in command arguments, reports, or the repository.

The shell examples assume these values have been set for the current installation:

```sh
cd /absolute/path/to/checkout
POKI_CHECKOUT="$(pwd)"
export POKI_MCP_STATE_DIR='/absolute/path/to/existing-private-daemon-state'
POKI_PRIVATE_RUN='/absolute/path/to/private-acceptance-files'
```

The paths above are placeholders. Use an existing configured daemon and an owner-controlled private directory outside the repository for device identities, plans, and captured phone content. The runners require exactly two explicitly configured, distinct physical iPhones using `RemotePairing`. They do not choose devices from discovery order or provide built-in personal identities.

## One-shot CLI

Use the existing CLI with the intended physical device ID:

```sh
node "$POKI_CHECKOUT/bin/call.mjs" \
  get_foreground_app '{"device":"EXACT_VERIFIED_PHYSICAL_DEVICE_ID"}'
```

Replace the device placeholder with the verified identity. Use an explicit ID on every phone-targeted call when more than one device is available.

The CLI inherits the environment. The stdio bridge supplies a UUID when `POKI_MCP_SESSION` is absent, instead of the CLI forcing unrelated invocations into the shared `terminal` session. An intentionally supplied `POKI_MCP_SESSION` remains effective.

Each invocation closes its own session on exit. Selection, leases, observations, and other session state therefore do not carry over to a later invocation. Concurrent processes that deliberately reuse the same explicit session name share that session and its cleanup scope. Use persistent clients for a multi-call task.

## Persistent clients

`connectPair()` accepts absolute repository and state paths and returns two distinct MCP clients. It loads the SDK and stdio bridge from that repository and gives each client a unique session name, including when the parent environment already contains `POKI_MCP_SESSION`.

For a module located in the checkout's root:

```js
import { connectPair } from './bin/dual-phone/connect.mjs';

const clients = await connectPair({
  repo: process.cwd(),
  stateDirectory: process.env.POKI_MCP_STATE_DIR,
});

const devices = ['FIRST_VERIFIED_DEVICE_ID', 'SECOND_VERIFIED_DEVICE_ID'];
try {
  const results = await Promise.all(clients.map((client, index) =>
    client.callTool({
      name: 'get_foreground_app',
      arguments: { device: devices[index] },
    })
  ));
  // Evaluate each result independently before continuing its device workflow.
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
}
```

The connection API establishes separate sessions; the caller supplies and verifies each physical target. Keep each workflow bound to its own client. If a task requires exclusive ownership across several calls, acquire and renew that device's lease in the same session, then release it before closing. Keep lease capabilities private and use only the exact lease returned to that client.

`PinnedPhoneSession` implements identity checks, a per-device FIFO, bounded calls, lease handling, and uncertainty fencing for the acceptance runners. Its task helpers are limited to Calculator. The raw clients expose the installed MCP API; other applications need their own observed targets, result checks, and task authorization.

## Execution and Mac focus

The client route addresses device services through the daemon and the phone transport. It does not use iPhone Mirroring or issue Mac mouse or keyboard events. Each phone still needs an available authorized transport and a suitable device and app state.

Separate sessions avoid sharing one session's scheduling and cleanup scope. The daemon retains its device ownership rules, input serialization, read concurrency limit, and approval behavior. Bind each task and batch to one verified phone; unresolved targets and batches spanning devices can require a wider lock. Parallel client calls do not remove those server constraints or establish simultaneous physical touch contacts.

## Private device configuration

Copy `devices.example.json` to a private location and replace every placeholder with values from the verified device inventory. The template is deliberately invalid until completed. The visual runner requires an absolute `--devices` path and validates it before connecting.

```json
{
  "version": 1,
  "devices": [
    {
      "id": "FIRST_VERIFIED_PHYSICAL_DEVICE_ID",
      "name": "EXACT_FIRST_INVENTORY_NAME",
      "kind": "physical",
      "connection": "RemotePairing"
    },
    {
      "id": "SECOND_VERIFIED_PHYSICAL_DEVICE_ID",
      "name": "EXACT_SECOND_INVENTORY_NAME",
      "kind": "physical",
      "connection": "RemotePairing"
    }
  ]
}
```

Records allow only `id`, `name`, `kind`, `connection`, and optional `model`. The ID must be a modern iPhone UDID or a legacy 40-character hexadecimal ID; names must be nonempty exact inventory names. When supplied, `model` must be an actual `iPhone<digits>,<digits>` identifier. All configured fields must match the live inventory. A missing, blocked, occupied, or mismatched device stops preflight. The order fixes the lane assignment: the first record is lane 0 and the second is lane 1.

## Bounded AX acceptance

| Mode | Behavior | Successful report status |
| --- | --- | --- |
| `inspect` | Verify identity, transport, and approval state; acquire each device; observe both phones with `snapshot_ui` | `STAGE_PASS` |
| `launch` | Perform preflight, then launch Calculator and obtain a verified AX observation on each phone | `STAGE_PASS` |
| `exercise` | Run both observed-label calculations, verify their displays, stop only lane 0, then verify lane 1 continues | `FUNCTIONAL_PASS` |

Use a private reviewed plan based on `inspect-plan.example.json`. The AX runner reads each exact device record from `lanes[].device`; it does not take the visual runner's `--devices` flag. Discovery and acquisition run sequentially because discovery touches shared inventory. Phone execution phases then run in parallel. Both runners check `approval_mode === "ask-human"` and preserve the daemon's existing approval behavior.

```sh
node "$POKI_CHECKOUT/bin/dual-phone/run.mjs" \
  --repo "$POKI_CHECKOUT" \
  --state "$POKI_MCP_STATE_DIR" \
  --plan "$POKI_PRIVATE_RUN/reviewed-plan.json" \
  --report "$POKI_PRIVATE_RUN/new-inspect-report.json" \
  --mode inspect
```

Report files use exclusive creation and mode `0600`; an existing report is preserved and the command refuses to overwrite it. For `launch`, change the mode and use a new report path. A successful native launch receipt must identify Calculator and its foreground PID; a subsequent AX observation must agree. An arbitrary app name or unrelated PID is insufficient. Launch/readback latency depends on the installed daemon, so clean-base tests and a custom daemon's physical results must be recorded separately.

The optional `--observations-out /absolute/path/to/new-private-AX.json` exports raw AX observations to a separate private `0600` file during `inspect` or `launch`. It is unavailable in `exercise`. Normal reports omit field values, button labels, screenshots, and complete AX trees, but still contain device identities and should remain private.

### Exercise plan requirements

The plan contains exactly two distinct verified physical devices. Each calculation supplies exact observed button labels and a selector for the current result display: its `objectId`, non-button `role`, actual `field` (`label`, `value`, or `text`), and expected text. Copy labels from a fresh observation in each phone's actual language. A match in Calculator history is insufficient.

The isolation phase stops lane 0 using `cancel` or `release`, then runs the reviewed continuation on lane 1. All phone-targeted calls carry an explicit physical ID. Management operations use the exact lease obtained by their own client.

The runner does not retry input. An uncertain outcome fences later input on that lane. Cleanup is attempted in the same session, and uncertain cleanup changes the report to `UNVERIFIED`. If acquisition completed but its receipt was lost, cleanup cancels only that client's accepted session work.

## Interactive visual acceptance

`visual-run.mjs` provides a bounded screenshot-reviewed Calculator exercise when AX observations are unreliable. Calculator must already be open through an authorized workflow. Supply the required private configuration and a private output directory:

```sh
node "$POKI_CHECKOUT/bin/dual-phone/visual-run.mjs" \
  --repo "$POKI_CHECKOUT" \
  --state "$POKI_MCP_STATE_DIR" \
  --devices "$POKI_PRIVATE_RUN/devices.json" \
  --out "$POKI_PRIVATE_RUN/new-visual-run"
```

Keep stdin open. The runner accepts one JSON object per line and returns JSON receipts. Use a new output directory for each run; it must be private. Screenshot and journal filenames are created exclusively with mode `0600` inside a directory with mode `0700`.

### Command sequence

1. Capture both phones:

   ```json
   {"op":"capture","lanes":[0,1]}
   ```

   Inspect both JPEG files. Confirm Calculator is visible, identify the actual clear/digit/operator keys, and read the returned logical dimensions. Use the runner's `screenshot_id` for grounding; `provider_observation_id` is a different ID.

2. Supply reviewed points for one or both lanes:

   ```json
   {"op":"calculator_taps","lanes":[{"lane":0,"screenshotId":"LATEST_LANE_0_SCREENSHOT_ID","points":[{"x":"REPLACE_WITH_REVIEWED_NUMERIC_X","y":"REPLACE_WITH_REVIEWED_NUMERIC_Y"}]},{"lane":1,"screenshotId":"LATEST_LANE_1_SCREENSHOT_ID","points":[{"x":"REPLACE_WITH_REVIEWED_NUMERIC_X","y":"REPLACE_WITH_REVIEWED_NUMERIC_Y"}]}]}
   ```

   The strings are deliberately non-executable coordinate placeholders. Replace them with numbers measured in the returned logical points and supply the complete reviewed sequence. Do not reuse historical coordinates. The runner accepts 1–8 points per lane and validates all supplied plans before starting either sequence.

3. Capture both phones again and visually verify their displayed results:

   ```json
   {"op":"capture","lanes":[0,1]}
   ```

   A successful tap receipt means `SENT_REQUIRES_VISUAL_VERIFICATION`, not an automatic calculation verdict. Each input phase consumes its grounding, so every later phase needs a new capture.

4. Stop only lane 0:

   ```json
   {"op":"stop","lanes":[0],"mode":"cancel"}
   ```

   `"mode":"release"` is also supported. Verify the stop receipt, then capture lane 1:

   ```json
   {"op":"capture","lanes":[1]}
   ```

   Inspect that image, send a `calculator_taps` command containing only lane 1 with its latest grounding ID and freshly reviewed points, then capture again and verify the continuation result.

5. Close the remaining owned session and inspect cleanup:

   ```json
   {"op":"close"}
   ```

   The cleanup receipt is `OWN_SESSIONS_CLOSED` or `CLEANUP_UNVERIFIED`. End-of-input also triggers cleanup.

### Bounds and verification responsibility

The visual runner allows at most 10 minutes per session, 60 seconds per input phase, and 30 commands. Each point plan must use its own lane's latest capture. The capture must remain at most 90 seconds old before every input, including after any lease wait. Coordinates must be inside the measured logical viewport. An uncertain input fences later input on that lane.

The runner records `runtime_app_guard:false` and `automatic_visual_verification:false`. Raw taps use `verify:false` because their targets come from operator-reviewed screenshots. The operator must confirm the app, targets, and resulting display. The age bound does not prove the screen stayed unchanged; stop if the relevant screen changes after review. This runner provides no app launching, generic tool dispatch, input retry, or automatic visual PASS.

## Regression verification

Run the focused suite from the release checkout against that checkout's dependencies:

```sh
cd "$POKI_CHECKOUT"
node --test test/cli-session.test.mjs \
  bin/dual-phone/session.test.mjs \
  bin/dual-phone/visual.test.mjs \
  bin/dual-phone/native-overlap.test.mjs
```

The CLI tests run actual CLI subprocesses and the actual stdio bridge against an isolated loopback MCP endpoint with a synthetic dispatcher. They check unique default sessions, overlapping requests, survival of a sibling call after the first session closes, and preservation of an explicit session override. Runner tests use synthetic identities and fake clients to check identity validation, bounded execution, observations, cleanup, and isolation. These tests neither start the production daemon nor operate phones.

The overlap analyzer tests cover exact integer nanosecond arithmetic, distinct-device overlap, touching intervals without overlap, stale or mixed builds, invalid run/session/device bindings, malformed or conflicting receipts, and merged journals. Native build provenance has a separate test at `test/native-build-receipt.test.py`.

For an equal-runtime red/green comparison, `POKI_CLI_UNDER_TEST` selects the CLI file and `POKI_SOURCE_UNDER_TEST` selects the fixture's source modules. The selected CLI still resolves its stdio bridge through its own adjacent `src/config.mjs`; keep that runtime baseline identical when comparing wrappers.

## Native handler overlap verification

An instrumented native bridge can attach `native_runtime` and `native_execution` receipts. Normal runner operations remain compatible with older receipts, but a native overlap claim requires the measured receipts. The visual journal preserves them alongside the actual client-session and device bindings. The analyzer reads that private journal without connecting to the daemon or operating a phone:

```sh
node "$POKI_CHECKOUT/bin/dual-phone/analyze-native-overlap.mjs" \
  --journal "$POKI_PRIVATE_RUN/visual-EXACT_RUN_UUID.jsonl" \
  --devices "$POKI_PRIVATE_RUN/devices.json" \
  --expected-build EXACT_VERSIONED_BUILD_ID \
  --run-id EXACT_RUN_UUID
```

Replace the run ID with the UUID from the single completed run. Use the expected build ID from the deployed native binary's provenance. Keep the journal, configuration, provenance, and analyzer output private: they contain device and process/session identities. Do not concatenate runs or compare clocks from separate hosts or boots.

The analyzer requires matching `connectPair` session bindings, a common connection group, two distinct configured physical devices, matching versioned builds, the `native_execution_v1` feature, and consistent native process/device identities. It checks receipt schema, clock, scope, operation UUID uniqueness, and ordered decimal nanosecond intervals before comparison. Its clock comparison assumes one trusted run on the same local daemon host and boot; the report states this assumption explicitly.

Only successful raw tap calls with confirmed `sent:true` receipts enter the overlap calculation. Preserved screenshot receipts are not counted as tap evidence. Intervals bracket `execute_connected` inside the native helper, which can include service setup and delivery waits. Their overlap establishes concurrent handler execution, not simultaneous physical touch contacts or the correctness of the displayed calculation.

| Analyzer result | Meaning |
| --- | --- |
| `NATIVE_HANDLER_OVERLAP_OBSERVED` | At least one pair of verified tap-handler intervals on distinct phones overlaps |
| `NO_NATIVE_HANDLER_OVERLAP_OBSERVED` | The verified intervals contain no positive cross-phone overlap |
| `NATIVE_TIMING_UNVERIFIED` | Missing, inconsistent, or invalid evidence prevents the claim; the CLI exits with status 2 |

The JSON result includes `maximum_overlap_ns` as an exact decimal string, `maximum_overlap_ms`, `overlapping_pair_count`, interval records, and overlapping pairs. It identifies `scope: "execute_connected"`, `operation_kind: "successful_raw_tap"`, and `physical_touch_overlap: "NOT_MEASURED"`. Visually verify the phone results and cancellation isolation separately.

Retain the native source and binary provenance produced for the build, together with the deployed file hashes. A build that includes pre-existing local changes must be identified as that combined runtime. Deploying exact committed client files and committed native instrumentation hunks into such an installation does not mean that the entire clean release commit is the running daemon. Record clean-checkout verification separately from physical verification against the combined live build.

## Physical verification record

An integration exercise on 2026-11-12 used two physical phones through an existing customized daemon. Fresh, manually reviewed Calculator captures showed `7 + 8 = 15` on lane 0 and `9 + 8 = 17` on lane 1. After cancelling lane 0, lane 1 continued to `17 + 1 = 18`. Both owned sessions confirmed cleanup. Those results establish the recorded functional exercise against that runtime. They do not establish a clean-base daemon's behavior or verification of a later commit.

The recorded client requests overlapped. The exercise did not directly measure native handler overlap or simultaneous touch contacts. Mac foreground samples before, during, and after showed the same application and window, and the test issued no Mac input or focus-changing operation; continuous foreground behavior and simultaneous human typing were not measured. An earlier AX observation timeout on one phone remains a separate reliability issue.

Keep revision-specific unit results, private physical evidence, and deployed file hashes in the release verification record. Public summaries can state the date, tested stage, result, and runtime scope. Device identifiers, local account paths, screenshots, tokens, and private evidence locations stay outside public commits.

## Interpreting evidence and deploying

| Evidence | What it establishes |
| --- | --- |
| Clean release checkout tests | Behavior under the tested fixtures at that source revision |
| `STAGE_PASS` | The requested inspection or launch stage and its cleanup |
| AX `FUNCTIONAL_PASS` | Both reviewed calculations and one-device stop/other-device continuation |
| Manually reviewed visual results | The observed app state and calculation results in those captures |
| Overlapping SDK calls | Client request overlap only |
| Native request intervals | Request lifetime, which can include helper and transport waiting |
| Native handler intervals | Handler overlap only when measured inside each handler and tied to the running binary |

Native dispatch concurrency remains `NOT_MEASURED` unless separately measured with runtime provenance. Offline tests, private integration results, and clean-base compatibility are separate claims. A failed AX read alone does not establish a Mac-window scheduling dependency.

Client-only changes in `bin/` load when new client processes start and do not require restarting the existing daemon. Verify the exact committed client files against the deployed copies, then run fresh clients against the intended state directory. A status command reporting the checkout's current Git commit does not by itself prove what server or native code an existing process loaded. Server or native-binary changes need their own controlled deployment and runtime verification; preserve the existing freshness checks, active ownership, and other resident workflows.
