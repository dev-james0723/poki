# Tool behavior and conventions

**Poki MCP** is a local macOS MCP server that lets AI clients inspect and control an iPhone or iOS Simulator. By default it lists the tools for phone tasks, and it can expose a complete catalog for screenshots, accessibility and Vision OCR inspection, touch and keyboard input, application management, screen recording, and diagnostics.

- **Screen & UI Inspection**: Capture screenshots (`take_screenshot`, `save_screenshot`) and inspect UI hierarchies via Accessibility or Vision OCR (`list_elements`).
- **Touch & Keyboard Input**: Send taps, swipes, hardware keys, and Unicode text across simulators and paired physical devices.
- **App & Device Lifecycle**: Manage applications, open URLs, inspect containers, record video, and run diagnostic checks.
- **Local Daemon Architecture**: Runs a local service (`127.0.0.1:47825` by default) with serialized device execution, per-client session isolation, and interactive local approval gates for sensitive actions. Loopback only unless `POKI_BIND_HOST` names another address, and `POKI_HOST_ALLOW` then lists the `Host` names it answers to; `127.0.0.1` is always served, because local clients read that endpoint from `mcp.json`.

Tool names and input validation schemas live in [`src/data/tools.json`](../src/data/tools.json) with remote connection maintenance definitions in [`src/tools.mjs`](../src/tools.mjs). MCP serves them through `tools/list`. `poki_mcp_status` returns the selected device, available device count, approval mode, and separate counts for device, observation, management, and total tools.

## MCP tool profiles

The default `tools/list` response contains the tools for phone tasks. Tool names, arguments, and execution behavior are unchanged.

| Use | Default tools |
| --- | --- |
| Service and devices | `poki_mcp_status`, `list_devices`, `select_device` |
| Read the screen | `list_elements`, `take_screenshot`, `get_foreground_app` |
| Apps and URLs | `list_apps`, `launch_app`, `terminate_app`, `open_url` |
| Touch and input | `tap`, `tap_text`, `long_press`, `double_tap`, `drag`, `pinch`, `fill`, `type_text`, `scroll`, `scroll_to`, `swipe`, `press_key`, `go_back`, `hide_keyboard`, `press_button`, `get_clipboard` |
| Wait, prompts, and batches | `wait_for`, `handle_alert`, `batch_commands` |

The runtime default list is defined in `src/tools.mjs`. The complete catalog includes simulator management, app installation, recording, location, appearance, drawing with `touch_path` and `draw_strokes`, and device leases.

### Complete catalog

`POKI_MCP_TOOLS=all` makes `tools/list` return the complete catalog. Any other value, including an unset or empty value, selects the default list.

For a stdio client, the variable belongs to the MCP process environment. This client configuration enables the complete catalog:

```json
{
  "mcpServers": {
    "poki": {
      "command": "node",
      "args": ["/absolute/path/to/poki-mcp/src/stdio.mjs"],
      "env": {
        "POKI_MCP_TOOLS": "all"
      }
    }
  }
}
```

The client needs to reconnect after a configuration change. Each stdio client has its own profile, independent of the daemon's profile.

Direct HTTP clients receive the daemon's profile. Starting the daemon with `POKI_MCP_TOOLS=all npm start` enables the complete catalog for those clients.

### Calls and device selection

Profiles affect discovery only. Every tool remains callable by name through `tools/call`, including tools absent from `tools/list`. The same applies to steps inside `batch_commands`. Argument validation, approvals, cancellation, and device arbitration still apply.

Consecutive device calls do not require `acquire_device`. With one available device, calls select it automatically. With multiple devices, `list_devices` and `select_device` identify the target. An explicit lease remains available for sessions that need exclusive access across several calls. Another session's lease can still block access.

Poki Agent starts its own stdio process with `POKI_MCP_TOOLS=all`. Its existing tool allowlist determines which tools reach its model.

### Computer-use profile: look and do

`POKI_TOOL_PROFILE=cua` lists only `look`, `do`, `list_apps`, `list_devices`, `select_device` and `poki_mcp_status`, with short server instructions. It works the way desktop computer-use tools do: `do` runs a list of actions in order (tap by element number or point, type, key, swipe, scroll_to, long_press, drag, pinch, button, launch, wait), waits a short fixed time after the last one, and reads the screen once; `look` reads it without acting. Each answer lists the screen's elements with numbers for the next call, marks the ones that are new since the previous read, names what disappeared, and attaches a screenshot. There is no verdict: the model decides what happened from the elements and the picture.

- Each action is reported as `sent`, `not_sent` or `unknown`. Nothing after a failed action is sent, and an `unknown` action is never sent again. Element numbers that are not in the latest read are refused before anything is sent.
- `look` and `do` work on a physical iPhone through the native bridge, on a booted simulator, and on a phone running WebDriverAgent (see below). A physical iPhone needs the bridge built from this version by `./bin/setup`, because typing uses its `type_keys` and `pasteboard` operations.
- On a physical iPhone, typing uses hardware key presses (the bridge's `type_keys`). Only text the keyboard cannot type is pasted, and then the user's clipboard is saved first and put back afterwards; a clipboard that cannot be read back exactly is never pasted over. Key presses that fail part way are reported `unknown` and are never followed by a paste, with or without `clear`.
- On a simulator, `launch` starts the app with `simctl` the way `launch_app` does, and `type` uses the simulator's own `type_text`: key presses, and for text the keyboard cannot type a paste through the simulator's pasteboard, which keeps that text afterwards.
- Accessibility gets `POKI_CUA_TREE_MS` (default 2500 ms) per read; after that the screenshot's OCR answers instead. When accessibility names nothing across a third of the screen's height, the screenshot's text it did not name is listed after its elements, and the read says `accessibility + ocr`. Actions and the wait after them get at most `POKI_CUA_ACTION_CAP_MS` (default 4000 ms).
- A locked or dark phone, or Poki's own app in front, stops the actions.
- `POKI_CUA_BACKEND=wda` with `POKI_WDA_URL=http://<phone>:8100` reads and acts through a
  WebDriverAgent runner deliberately launched for network access by the Mac instead of the bridge.
  That WDA must use a reachable, non-loopback `USE_IP`; Poki's standalone iOS launcher always binds
  its own runner to `127.0.0.1`. `look` and `do` answer the same way on either backend.

The complete catalog (`POKI_MCP_TOOLS=all`) includes `look` and `do` too.

### One daemon, several clients

`POKI_INPUT_LOCK=1` gives each MCP session its own queue instead of one queue for every session. Read-only tools run beside other sessions' work, capped by `POKI_MAX_CONCURRENT_READS` (default 4), and tools that change the screen take a lock on their device. The lock belongs to the device a call resolves to, so a session that names a phone and one that gives its UDID wait for each other. A call whose device is not known yet, such as a phone's name before this session has listed or used that phone, or a batch that reaches more than one device, locks every device. A call that cannot get the lock within `POKI_INPUT_LOCK_WAIT_MS` (default 30000 ms) fails with an error that names the session and tool holding it. The lock lives in one daemon; two daemons driving one phone are not supported.

`POKI_MCP_CALL_LOG=<path>` appends one JSON line per finished tool call: the tool, how long it took, its verdict when it has one, and whether it failed. Arguments, text and images are never written, and the session appears only as a hash.

## Ask in plain language

Ask your agent for the task you want done:

```text
Start an iPhone simulator, open Settings, and tell me the iOS version.
```

Three tools handle most interactions:

- `batch_commands` runs a known multi-step task in a single call and returns the visible on-screen text at the end, saving a screenshot round trip.
- `fill` focuses an input field, replaces its text, and verifies the new value.
- `tap_text` looks for five seconds. If the target is not found, it aborts without tapping and returns what is currently on screen. A screen accessibility cannot read gets a few more seconds for screen text recognition to answer, because that read has already started; nothing new begins after the five seconds.

Installing apps, opening URLs, and reading the clipboard trigger a macOS approval dialog on your Mac. See [Approval & Clipboard Behavior](#approval--clipboard-behavior).

## Optional action verification

`tap`, `tap_text`, `swipe`, `scroll`, and `go_back` accept `verify: false`. These calls omit the reads that compare the screen before and after an action. Their results include `verified: false` and do not confirm that the app accepted the input. Omitting `verify`, or setting it to `true`, keeps the default verification.

`tap_text` still reads the current screen to locate its target. With verification disabled, it uses the first matching position without waiting for two stable positions. Coordinate actions still obtain the current display dimensions. This option does not promise a call with no device reads.

`batch_commands` also accepts `verify: false`. Supported steps inherit that value, and a step can override it with `arguments.verify: true`. A batch with unverified steps reads the final screen once. That snapshot does not verify each preceding action. An unknown input outcome still stops the batch, including with `stop_on_error: false`.

Inside a batch, a touch step (`tap`, `tap_text`, `double_tap`, `long_press`, `go_back` or `handle_alert`) is compared with the screen before it unless the next step is also aimed by coordinates (`tap`, `double_tap`, `long_press`, `swipe`, `drag`, `scroll` or `pinch`) or the batch sets `stop_on_error: false`. A run of coordinate steps is written for one screen, so the batch does not pause inside it, even after a tap that changed nothing. A step with `arguments.verify: true` is always compared. With the default `stop_on_error`, a compared touch with no observed change pauses the batch before the steps after it.

Accessibility can miss changes that affect only pixels, such as Calculator's display after AC. A default batch can still stop with `no_change` in that case. An unverified tap does not produce `no_change`; inspect the final screenshot before reporting the task result.

## All MCP tools

| Group | Tool | What it does |
| --- | --- | --- |
| Devices | `list_devices` | Find attached iOS devices and booted or previously used simulators. |
| Devices | `start_simulator` | Boot an existing simulator by id or name, or create one from an available model. |
| Devices | `shut_down_simulator` | Shut down the selected simulator. |
| Devices | `reconnect_device` | Attempt a replacement RemotePairing tunnel while preserving a working tunnel if replacement fails. Does not replay input. |
| Devices | `disconnect_device` | Close the selected RemotePairing helper and tunnel. |
| Devices | `select_device` | Select one connected device by id or unambiguous name for this MCP session. |
| Devices | `get_device_info` | Read device identity, capture dimensions in logical points, and optionally platform settings. |
| Devices | `poki_mcp_status` | Report tool counts, connected-device count, selected device, and approval mode. |
| Coordination | `acquire_device` | Exclusively occupy one device across tool calls in this MCP session. |
| Coordination | `renew_device` | Extend this session’s active device lease by 1–600 seconds (default 120). |
| Coordination | `release_device` | Release this session’s device lease after cancelling accepted work and awaiting recording/location cleanup. |
| Coordination | `cancel_device` | Stop all previously accepted work and background recording/location in this MCP session, including calls without a lease. |
| Screen | `observe_device` | Capture one image with its structured observation, non-reused element references and prompt check. |
| Screen | `take_screenshot` | Capture the current display and return a JPEG image with screen dimensions and a prompt warning check. |
| Screen | `save_screenshot` | Save a full-resolution screenshot to an absolute PNG or JPEG path or directory. |
| Screen | `start_recording` | Start recording the selected device display to an H.264 movie. |
| Screen | `stop_recording` | Finalize the session recording and inspect the saved movie before returning its path and media details. |
| Screen | `get_foreground_app` | Read the current foreground application from accessibility services. |
| Screen | `list_elements` | Read accessibility elements, or OCR when auto mode cannot use accessibility. Auto mode adds screenshot text that accessibility leaves out across a third of the screen. |
| Screen | `wait_for` | Poll visible text until it appears, or disappears when gone=true. |
| Screen | `wait` | Pause for seconds without interacting with a device. |
| Touch | `tap` | Tap at x/y in screen points or at the center of a current element ref. |
| Touch | `tap_text` | Find one visible element matching text, waiting for it to appear and hold still (five seconds on a screen accessibility can read, longer when only screen text recognition can find it), trying OCR when needed, and tap it. |
| Touch | `double_tap` | Send two taps at x/y in logical screen points or at a current element ref. |
| Touch | `long_press` | Hold one touch at x/y or an element ref. |
| Touch | `swipe` | Move a touch from from_x/from_y to to_x/to_y in logical screen points. |
| Touch | `scroll` | Scroll up, down, left, or right around x/y, or the screen center when omitted. |
| Touch | `scroll_to` | Search for visible text and scroll until it is found, content stops changing, or max_scrolls is reached. |
| Touch | `drag` | Hold a touch, then move between the supplied logical-point endpoints. |
| Touch | `pinch` | Perform a two-finger gesture centered at x/y in screen points. |
| Touch | `touch_path` | Draw one continuous stroke through timed points, such as a circle or a curve. `time_ms` may have a fractional part. |
| Touch | `draw_strokes` | Draw 1 to 12 separately lifted strokes in one call, such as handwriting or a signature. |
| Text and keys | `fill` | Focus a field by ref, coordinates, or matching field label/placeholder/value/identifier, replace its text, and optionally submit after text verification. |
| Text and keys | `type_text` | Enter text into the focused field, optionally clearing it first and sending Return after verification. |
| Text and keys | `press_key` | Send a named keyboard key with optional modifiers and count (default one). |
| Text and keys | `hide_keyboard` | Detect a visible keyboard, send its toggle event, and verify dismissal. |
| Text and keys | `get_clipboard` | Read clipboard contents supported by the platform. |
| Text and keys | `set_clipboard` | Replace the selected device clipboard with text. |
| System | `press_button` | Send a hardware-style button event such as Home, lock, volume, mute, or Siri. |
| System | `system_gesture` | Send the requested system navigation gesture. |
| System | `go_back` | Tap a uniquely identified back control when available, otherwise swipe from the left edge. |
| System | `rotate` | Request a display orientation and invalidate cached coordinates. |
| System | `set_appearance` | Request light or dark appearance through the selected platform adapter. |
| System | `set_accessibility` | Change supported text-size or accessibility display settings. |
| System | `set_location` | Start a simulated latitude/longitude for the selected device. |
| System | `clear_location` | Stop the location simulation owned by this service for the selected device. |
| System | `handle_alert` | Choose a visible alert button by text or accept/dismiss action, looking for five seconds; recognition already running on an unreadable screen may finish after that. |
| System | `request_human_action` | Show a macOS dialog asking the user to complete a step on the device. |
| Apps | `list_apps` | List installed applications, excluding system apps unless include_system=true. |
| Apps | `launch_app` | Launch an application by bundle_id or unambiguous name. |
| Apps | `terminate_app` | Stop an application identified by bundle_id on the selected device. |
| Apps | `install_app` | Install an application from a local path. |
| Apps | `uninstall_app` | Remove an installed application identified by bundle_id. |
| Apps | `open_settings` | Open a supported Settings page or an application settings page. |
| Apps | `open_url` | Ask the selected device to open a URL. |
| Apps | `build_and_run` | Build an Xcode project or workspace from project_path, install the result, and launch it. |
| Apps | `download_app_container` | Copy an accessible application container to a local destination, or the service state directory by default. |
| Apps | `list_crashes` | List available reports, optionally filtering by process name or bundle identifier and kind. |
| Apps | `get_crash` | Read a report by path from list_crashes, or find the newest report for process. |
| Batches | `batch_commands` | Do a whole known task in one call: launch the app, tap, fill, scroll, go back and answer alerts, each {tool, arguments}. |
| Batches | `run_code` | Run an async JavaScript function on an isolated worker, calling device tools with `await tools.<name>(args)`, so the code loops, filters and decides each next step from the results in one call instead of a model round trip per step. |

`run_code` is in the complete catalog, not the default `tools/list`, so it is reached by name or after `POKI_MCP_TOOLS=all`. The sandbox exposes only `tools`, `input` and `console`: no require, file system, network, process or timers. A tool error throws and the code can catch it; an action receipt with `sent=false` or an unknown outcome stops the script and returns the steps already run, as `batch_commands` does; cancellation and timeout also stop it and cancel the device call in progress. The result lists every tool call with its name, elapsed time and receipt. Default limits are 120 seconds and 60 tool calls, set with `timeout_seconds` and `max_tool_calls`. Use it for predictable multi-step work such as scrolling until something appears and then reading it; use a single tool for a one-step action, and return to the model when the next step needs visual judgement.

## Agent skills

[Unlock an iPhone](../agent/skills/iphone-unlock/SKILL.md) packages an authorized passcode workflow, a calibrated portrait keypad, and a native helper that keeps one connection open for the entire input sequence. Poki Agent loads this skill and exposes the host-side `unlock_device` tool when the user has configured a passcode locally. It requires Poki device ownership; it does not add an MCP tool. The skill documents the physical-device evidence and supported layout.

## Coordinates, Screenshots, and Recordings

- All coordinates and element frames use **logical screen points**.
- `take_screenshot` returns JPEG data. Passing `max_width` scales the returned image without changing logical interaction coordinates.
- `save_screenshot` writes a full-resolution PNG or JPEG based on the file extension.
- The `lossless` parameter does not alter either screenshot rule.
- On a simulator, the screen's rounded corners and Dynamic Island area are black in screenshots. Without this mask, that area differs between frames of a still screen, which would expire element refs.
- Default output directories:
  - Screenshots: `~/Pictures/Poki MCP`
  - Recordings: `~/Movies/Poki MCP`

## Element Inspection & Delivery Flags

- `list_elements` prefers Accessibility in `auto` mode and falls back to Vision OCR when Accessibility cannot be read. Every response reports which source was used. Some apps draw a list with their own renderer and publish only a header to Accessibility. When the named elements leave a third of the screen's height empty, `auto` mode adds the screenshot text that Accessibility did not name, after the Accessibility elements, each with `"source": "ocr"`. `source: "accessibility"` turns this off.
- Element `ref` identifiers are never reassigned within an MCP session. They expire after known input, a device change, a newly captured image showing a change, or **30 seconds**. Input and image changes observed by another session in the same daemon also invalidate the old observation. Re-fetch elements before acting on stale refs. Poki cannot detect an external touch or controller change until it observes that change; it does not continuously watch the display.
- In action responses, `sent=true` means the touch or key report was written to the connection. It does not mean the device acted on it. The device does not acknowledge reports, and a dropped report returns no error.
- A standalone action reads the screen back after it runs. `screen` lists the foreground app and visible text. When `screen_change_verified=true`, `screen_changed` indicates whether the accessibility output changed. This covers elements, text, values, positions, and selected, enabled, or focused states. `false` means no change was observed. It does not prove the action failed. The effect might not be exposed to accessibility, such as a canvas update, or might not have appeared yet. `true` does not prove the action caused the change, because another element may have updated at the same time. `screen_change_verified=false` means the before and after states could not be compared, such as in an app with no accessibility elements. In that case, inspect the screen directly.

## Device ownership and stopping work

Consecutive calls do not require a lease. For exclusive ownership across several calls, call `acquire_device` with an explicit device ID or unambiguous name. Acquisition resolves the device without booting it and returns `lease_id`, `device`, `state` and `expires_at`. Each session can hold one device lease. While holding it, release before switching to another device. Acquisition is serialized with ordinary operations; renewal, release and cancellation bypass that queue.

- `acquire_device({device, ttl_seconds?})`: default TTL 120 seconds, allowed integer range 1–600 seconds. Another session cannot acquire, observe or operate this device during the lease. Selection, aliases, automatic selection, batch steps and existing simulator startup all pass through the same device check. Creating a new simulator reserves its creation operation before running it; an existing lease must be released first.
- `renew_device({lease_id, ttl_seconds?})`: extend the matching session's active lease from the current time. Long operations do not renew automatically. Renew before expiry, including while a long tool is running.
- `release_device({lease_id})`: invalidate accepted work, stop recording and simulated location owned by this session, await cleanup, then make the device available. A lease stays `releasing` until cleanup finishes.
- `cancel_device({lease_id?})`: stop **all previously accepted work in this MCP session**, including queued calls made without a lease, and stop its background recording/location. If supplied, `lease_id` must match this session's active lease. Other sessions are unaffected. New work may be submitted after cleanup finishes; an old queued operation never resumes as an unleased operation.

The stop result identifies its scope, reason and cleanup outcomes. Cancellation stops owned local processes and waits; it cannot undo input already dispatched to the device. Inspect the screen before retrying an unknown outcome. The stdio bridge forwards SDK request cancellation to the corresponding daemon operation, including waits, device helpers and the local approval dialog. A normal HTTP response closing is not a session cancellation. Normal stdio EOF or termination requests session cleanup; a crashed client holding an explicit lease is bounded by its TTL. A client without a lease has no persistent ownership guarantee after an abnormal exit; use an explicit lease for recordings and multi-call tasks.

`list_devices` still reports discovery and occupancy (`occupied`, `owned_by_session`, `state`, `expires_at`) without exposing another session's task. Occupied physical devices are not queried for additional name/model information by other sessions. If an alias has not been discovered, use the displayed device ID. An unleased recording or location must be stopped by its owner before a different session can acquire that device.

This arbitration exists only in **one shared Poki daemon**. Different daemon instances and different `POKI_MCP_STATE_DIR` values are independent. It does not lock out other control software or a person touching the screen. Run one daemon for the clients that need to coordinate; do not start multiple daemons against the same endpoint directory. No persistent task database or recovery across daemon restarts is provided.

## Observations, deadlines and receipts

`observe_device` returns structured elements and a prompt check, plus a PNG by default. `include_image:false` omits the PNG attachment but still captures a frame and checks OCR. For selected single actions, `return_observation:true` reuses the stable **post-input** AX tree with short-lived element refs and an AX-based prompt check; it does **not** add a screenshot or image OCR by default. Fast routes additionally request `post_action_ocr:true`, which captures an image **after** AX stabilization and performs OCR prompt checking. The sources remain non-atomic and their original timestamps are preserved. Each action-bound observation must pass receipt, device/revision, time, foreground, completeness and prompt checks; otherwise Agent and routes fall back to a new `list_elements`/`observe_device` call. AX-only refs are bound to the most recently measured viewport and expire after known input, explicit later capture, session/display changes or 30 seconds. The Agent sends the model **one trimmed element list**, not both the full nested receipt and a duplicate list; full evidence remains in the verification trace. No observed state or `sent:true` alone proves task success or permits retrying uncertain input. Existing tools and callers retain their default behavior.

`wait_for` uses a monotonic deadline covering capture, AX, OCR and polling. It starts no new read after that deadline, aborts in-flight external work and waits for owned processes to close. Consequently response delivery can include bounded process termination time after the deadline; the deadline is not a claim that the HTTP response arrives at the exact requested millisecond.

Input receipts retain `sent`, `text_verified`, `submit_sent` and other confirmed facts when recording recovery fails. The separate `recording` object reports recovery failure. Unconfirmed delivery remains `outcome: "unknown"`; it is never automatically replayed. Automatic recovery is suspended while native input intentionally interrupts the media stream. Normal reconnection after an explicit input is counted as `input_reconnects` and does not consume the automatic retry budget, so healthy multi-step recording is not limited to three inputs. Only background recovery from unexpected stream disconnects consumes `automatic_retries`, at most three per recording lifetime. Each reconnect still has a five-second first-frame deadline. `reconnects` is the total of these two counters. A failed reconnect leaves an explicit error; stop/start a recording to begin a new automatic budget. Stop, release, cancellation and session cleanup disable retries and await owned recording processes, and cleanup reports finalization errors separately.

Batch results retain the executed prefix and each step's `elapsed_ms`, then report `stop_reason`. A step's `device` applies to that step alone; steps without one use the session selection, and the screen read after the last step comes from the device that step used. Human handoff, cancellation, expiry, timeout and unknown input outcomes always stop subsequent steps even with `stop_on_error=false`. A successful action's receipt remains present if stopping occurs later. A detected human-only prompt in `handle_alert`, `take_screenshot`, `observe_device` or the screen read after the last step sets the same `needs_human_action` stop reason; observation tools retain their captured image and structure. With the default `stop_on_error`, every step is checked before any runs, so a mistyped step costs nothing. The last block carries `screen`, and after a stop also `failed_step`, `remaining_steps` and `next`, so the following call can fix one step and send only what is left.

Tool responses include `_meta.timing.stages` with queue, capture, AX, OCR, input, recording recovery and external-process durations where exercised. Each stage has an ID and parent ID. Parent durations include their children, so do not add parents and children. External-process time includes helper startup, connection and work inside the helper; those internal costs are not separately measured. Timing metadata contains no input text, device identifiers or image content, and it does not measure model reasoning or client round-trip time. No end-to-end speed multiplier is claimed.

## Efficient short workflows

- **Put the whole known task in one batch:** When the request already names what to do, send `launch_app` and every step in one `batch_commands` call. `launch_app` on a simulator returns once the interface is readable; `tap_text`, `fill` and `handle_alert` wait five seconds for their target to appear and hold still (a recognition already running on a screen accessibility cannot read may finish a few seconds later), so a batch can cross screens; the reply ends with the visible text, so a closing `take_screenshot` is only needed for pixels. Leave out a step when whether to do it depends on what an earlier step shows, or when it needs the user's decision. A wrong target stops the batch without tapping and reports the closest text on screen. Each step result reports `elapsed_ms`, which reflects server-side execution time only and excludes model reasoning and client round-trip overhead.
- **Use `fill` for known input fields:** Call `fill` directly instead of chaining `tap` and `type_text`; `field` can be left out when one text field is visible. On physical devices, `fill` focuses, replaces, and verifies text within a single native input session to avoid an extra connection wait. On simulators it taps, waits for focus and types, and a verified mismatch is an error. Plain text typed on a simulator first switches its keyboard to `en_US` (`simctl keyboard`), because a simulator created on a Chinese Mac types through Pinyin and rewrites Latin text and punctuation; the setting stays on that simulator. Because `fill` replaces existing field content, review your draft beforehand; reserve `type_text` for appending to an already-focused field.
- **Review and submit with `return`:** To inspect text before sending, `fill` and read the `screen` it returns. After verifying the draft, submit using `press_key` with `return` and inspect the resulting screen. Do not re-enter the full text or call `type_text` with an empty string to submit. Note that `text_verified` only confirms text entry into the field and `sent` only confirms the action was dispatched; neither guarantees application-level delivery.
- **Handle `CoreDeviceError` 4016 via observed UI:** If launching an app fails with `CoreDeviceError` 4016, inspect the current screen and continue through an observed Home Screen or App Switcher entry point. Do not repeatedly retry the same launch path unless device conditions change. This serves as invocation guidance and does not permanently mark the app as unavailable after a single failure.

## Approval & Clipboard Behavior

- **Local approval dialog**: Installing or uninstalling apps, building and running projects, opening URLs, downloading app containers, and reading or writing the clipboard trigger a local macOS approval dialog by default.
- Setting `POKI_MCP_APPROVAL_MODE=allow` bypasses this local daemon prompt for preapproved workflows, but it **never** auto-completes iOS/macOS system authorization dialogs or makes `request_human_action` succeed automatically.
- **Unicode paste & clipboard restoration**:
  - Unicode text entry may use the device clipboard. On physical devices, Poki MCP attempts to save and restore a complete clipboard snapshot; if full restoration is not possible, the response explicitly reports restoration as unavailable.
  - The snapshot is held only in memory for the duration of that single operation and cannot be restored by a subsequent tool call after a human handoff.
  - If a paste prompt is pending or the target field cannot be verified, automatic submission stops and leaves the intended text on the clipboard.
  - Poki MCP **never** auto-accepts an iOS **Allow Paste** prompt. Note that a true first-time **Allow Paste** human-handoff flow remains unverified on hardware (prior successful paste checks did not trigger the system prompt).


## Bounded workflow tools

The complete catalog adds `run_workflow`, `tap_sequence`, `run_app_action` and `choose_action`. See [native workflow behavior and activation](native-workflow-speed-v2.md) and [measured multi-app results](native-multi-app-results-20261112.md). Use `POKI_MCP_TOOLS=all` and normal client reconnection for discovery.
