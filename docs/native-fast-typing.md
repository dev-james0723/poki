# Fast verified final draft input

Use the native Poki MCP batch tool. Observe the intended app/field first. For a final draft input that needs no further screen-dependent step:

```json
{"commands":[{"tool":"fill","arguments":{"device":"YOUR_DEVICE_ID","expected_app":"Notes","field":"Note","text":"Your draft","submit":false,"native_text_result":true}}]}
```

Use `type_text` instead of `fill` only when the intended field is already focused. `native_text_result` is optional and defaults off. It must be the final text step, with explicit `submit:false` and `expected_app`. It cannot be combined with a requested screen observation or dependent step; these combinations refuse before any input.

A successful `native_text_result` summary has `scope:"text_input"`, `text_verified:true`, the Unicode character count, field role/name and clipboard status. It is the existing native AX exact-field verification, not a whole-screen snapshot or proof of submission. It never seeds a new input cache. Old, malformed, incomplete, wrong-device or unknown-delivery receipts retain the normal screen readback. Do not retry ambiguous input.

When another control or app state is needed, request a fresh native `snapshot_ui`. If the task ends after typing, the native text proof avoids paying for another full screen subscription. Clipboard restoration can still be unavailable and is reported independently.
