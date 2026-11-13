# Phone queries, Shortcut receipts and Safari DOM

This branch adds twelve MCP tools and three iOS App Intents. The tools appear in the default MCP profile. Safari requires an explicit device lease; ordinary native queries and Shortcut calls retain the existing coordinator and approval policy.

These APIs are an initial delivery of the selected request. Implementation authorization did not separately approve narrowing the original outcomes; the outstanding work below remains required.

## Capability boundaries

| Capability | Interface | Evidence returned |
|---|---|---|
| Exact visible native field / button check | `query_ui` | Fresh AX facts, selector coverage, app and device identity |
| Wait for a native condition | `wait_for_ui` | Final fresh predicate result, attempts and elapsed time |
| Installed Shortcut execution | `run_shortcut` | Durable operation receipt and correlated callback |
| Revisit uncertain/completed execution | `get_app_action_status` | Retained receipt; never dispatches again |
| Owned app navigation | `list_app_links`, `open_verified_link` | Fixed route catalog; fresh destination marker proof |
| Isolated physical Safari session | `safari_open`, `safari_close` | Exact device/session binding and owned cleanup |
| DOM reading | `safari_observe`, `safari_query` | Bounded visible text and expiring element refs |
| DOM condition / action | `safari_wait_for`, `safari_act` | Fresh predicate or guarded action with explicit proof |

These interfaces do not imply physical acceptance on a particular phone. `poki_mcp_status.phone_capabilities` reports configuration and backend boundaries. It does not turn a configured callback URL or installed SafariDriver into a successful live check.

## Native AX queries

Use the exact foreground bundle ID. Select by `labels`, `roles` and/or `object_ids`. Each condition is one of `present`, `absent`, `unique`, `field_equals`, or `bounds_match`.

Example MCP tool arguments:

```json
{
  "device": "<resolved-device-id>",
  "expected_app": "<exact-app-bundle-id>",
  "condition": {
    "state": "field_equals",
    "query": {"object_ids": ["<fresh-field-object-id>"]},
    "field": "value",
    "equals": "廣東話 🙂"
  }
}
```

Pass those arguments to `query_ui`. For a bounded wait, use `wait_for_ui` and add `timeout_ms` and optionally `poll_ms`. Defaults are 6 seconds for a query and 10 seconds for a wait; both cap at 30 seconds. Queue time counts toward those deadlines.

The native request still collects a full AX tree. This release reduces the result to the requested proof; it does not establish faster native collection. Missing, malformed or unresolved child coverage stays incomplete. Unknown element geometry stays unknown rather than becoming evidence that the element is absent. Privacy/passcode prompts are checked before viewport filtering.

Investigating native collection narrowing or reuse of sufficiently fresh field evidence remains required. Compare the supported path with full-tree collection on the intended phone and record measured scope/latency or the observed interface limitation; this release has not completed that acceptance.

An observed visible element can prove presence. One exact object ID can prove its own field value or bounds when its narrower selector is unambiguous. Absence and general uniqueness additionally require complete relevant coverage. Receipts distinguish `native_source_complete`, `visibility_complete`, `source_complete`, and query-specific completeness. A field value proves neither save nor send.

## Shortcut completion callbacks

Configure the existing daemon with an explicit phone-reachable HTTPS origin:

```text
POKI_SHORTCUT_CALLBACK_BASE_URL=https://<your-existing-callback-origin>
```

The origin must not include a path, query, credentials or fragment. The handler path is `/app-actions/callback`. Missing configuration returns `not_sent` before opening Shortcuts.

```json
{
  "device": "<resolved-device-id>",
  "shortcut": "<installed-shortcut-name>",
  "input": "Text for this operation",
  "operation_key": "workflow-20261113-001",
  "timeout_ms": 15000
}
```

Call `run_shortcut` with those arguments. Keep the same operation key when inspecting an uncertain attempt; reuse returns its retained receipt. A different device or different arguments with the same key are refused. Use `get_app_action_status` with the original device and `operation_key` to inspect later callbacks.

| State | Meaning |
|---|---|
| `prepared` | Durable identity exists; dispatch intent has not been recorded |
| `dispatched` | Dispatch intent is durable; completion is pending |
| `success` | The correlated success callback was accepted |
| `cancelled` / `error` | The corresponding callback was accepted |
| `unknown` | Dispatch may have happened, but completion is not established |
| `not_sent` | This retained operation was refused before confirmed dispatch |

The journal uses private files under the daemon state directory, synchronizes dispatch intent before navigation, and stores callback token hashes. Separate random tokens bind the three outcomes. Duplicate identical callbacks are idempotent; conflicting terminal callbacks are rejected. A restart after dispatch retains uncertainty until a valid callback arrives. A timeout never triggers another execution.

The journal defaults to 512 retained identities and refuses new work when full. Do not delete replay barriers as an automatic recovery. Review retention and operation-key ownership explicitly before maintenance. Callback receipts expire after 24 hours by default.

An optional `expected_app` plus positive `expect` requests independent AX proof. Callback success and app-state proof are separate. The callback may open Safari, so a successful Shortcut can still have an unverified app postcondition.

### Result-only HTTPS relay

The generic adapters are `shortcut-callback-relay.mjs`, `shortcut-callback-forward.mjs`, and `shortcut-callback-router.mjs`. Integrate them with the existing authenticated outbound bridge. Keep callback jobs in a separate bounded queue from phone-control jobs.

Only validated callback results may enter this queue. The bridge forwards them to the exact loopback daemon endpoint file. It does not forward the general MCP bearer token, execute tools, or retry a phone action. Callback acknowledgments omit input, result text and credentials; do not add request-URL logging to the ingress or bridge.

Keep existing OAuth scopes, target-device binding and MCP allowlists intact. A connector that currently exposes only read tools does not acquire action authority by deploying this callback receiver. Expand a connector through its existing authorization process separately when required.

## iOS task intents and owned routes

The iOS app provides `StartPokiTaskIntent`, `GetPokiTaskStatusIntent`, and `CancelPokiTaskIntent`. They reuse Poki's configured model, existing ChatModel runner, ownership guards and action approvals. All three require local device authentication.

Start accepts either nonempty task text or one UTF-8 plain-text file, up to 8192 bytes. An optional stable operation ID deduplicates starts. Status retains task state and result. Cancellation requests the existing runner to stop; it does not reverse completed phone actions.

Installing the updated iOS build is required for these intents and destination markers. The initial implemented navigation catalog contains three owned Poki routes:

| Link ID | URL | Required AX identifier |
|---|---|---|
| `poki.chat` | `poki://chat` | `poki.route.chat` |
| `poki.setup` | `poki://setup` | `poki.route.setup` |
| `poki.activity` | `poki://log` | `poki.route.activity` |

Listing reports physical verification as pending. An individual `open_verified_link` call can verify the current destination only from fresh complete AX evidence. Older app builds without markers return unverified.

These three routes are an initial subset. The required initial set of 5–10 useful workflows for the user's common apps remains outstanding, including supported link/action parameters, expected destinations and physical verification receipts. Generic installed-Shortcut execution alone does not supply or validate that workflow collection.

## Physical Safari DOM

The backend is the installed macOS SafariDriver. The phone must be trusted, unlocked, discoverable by SafariDriver, and already configured for Remote Automation. Missing setup fails with its observed error; tools do not silently enable settings.

1. Acquire the exact physical device using `acquire_device`.
2. Pass its `device` and `lease_id` to `safari_open`, with an HTTP(S) URL and any expected redirect origins in `allowed_origins`.
3. Use the returned `session_id`, the same device/lease, and exact `expected_origin` on subsequent calls.
4. Read or query the page, then use a returned opaque ref in `safari_act`.
5. Close the session or release the device. Cleanup targets only this caller's driver/session.

```json
{
  "device": "<resolved-physical-device-id>",
  "lease_id": "<owned-lease-id>",
  "session_id": "<returned-session-id>",
  "expected_origin": "https://example.com",
  "action": {"kind": "fill", "ref": "<fresh-ref>", "text": "Hong Kong"}
}
```

Refs expire after 30 seconds and invalidate after navigation, actions or a device revision change. Fixed scripts validate document, URL, element fingerprint, visibility and origin. Click rechecks these in the same synchronous activation job and requires a positive postcondition. Fill verifies the live field value. Neither establishes persistence or submission.

Both fill and click use DOM operations with untrusted events. Sites requiring trusted input may reject them. Site event handlers can still run. Passwords and file inputs are refused. There is no arbitrary JavaScript API, owner-tab attachment, cross-origin frame traversal or arbitrary WebView access.

Simple dialogs must negotiate `unhandledPromptBehavior: ignore`. HTTP WebDriver does not preserve `beforeunload` warnings; do not depend on them to protect drafts in this isolated session. Native foreground and prompt checks run before reads/actions and again before final proof. Those AX reads count toward the 15-second default wait/action budget; the maximum is 30 seconds.

Unknown actions fence later writes and are never automatically replayed. Isolated Safari sessions do not inherit the owner's ordinary cookies, history, AutoFill or login state. Owner-session Web Inspector/CDP remains explicitly unsupported.

SafariDriver matches the selected first path for public travel search and reading. After public-page acceptance, evaluate Web Inspector/CDP for actually inspectable Safari pages or WebViews and workflows requiring a private login; that evaluation is still pending and carries no promise of unrestricted owner-session access.

## Verification and rollout

Use the committed PRD and implementation plan in `docs/superpowers/`. Focused behavior tests, complete root regression, native tests/release build and actual iOS compilation are different gates. Cloudflare's Linux subset reports its own explicit coverage.

Before activating an installed checkout, reconcile local overlays and current writer ownership, stage the combined source, preserve the daemon state directory/port/token/approval mode, and retain a rollback copy. Verify the running tool inventory and source/build identity after cutover. Physical phone cases require an available, authorized phone; paused sharing is a blocked case, not a pass.

The release record must state native query, harmless Shortcut callback, owned route, Safari DOM and App Intent physical outcomes separately. Do not infer production acceptance or latency gains from mocks, compiler success or an HTTP deployment acknowledgment.
