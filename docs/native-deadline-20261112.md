# Native batching deadline result

The owner imposed a five-minute stop. No new core patch or service reload was attempted. Use the already installed native batch path for known app launches and reads rather than independent direct launch calls that each automatically read back the UI before an additional explicit snapshot.

Three paired circuits were attempted on Sing through native Poki MCP, with no Jev. Each circuit opened Notes, Reminders and Gmail and independently checked the same owned note, reminder preview and unsent email against complete live AX snapshots. Pair two reversed the order. Two pairs completed all checks; pair three timed out and was excluded from latency comparison. The complete-pair medians were 26.364 seconds and 16.324 seconds: 38.08% less time, about 1.62x speed. This small result measures launch/read orchestration only, not typing or the ten-app trip. See the adjacent sanitized JSON for every attempt.

Known native workflow pattern: one batch_commands call containing launch_app then snapshot_ui for each app, with the same positive checks on each returned snapshot. A batch suppresses redundant launch readback. Do not omit the final checks, replay uncertain input or infer successful effects from a sent receipt.

The ten-app trip preflight prepared the Tokyo itinerary note, hotel searches, transport reference, packing preview, a five-day calendar preview and one Gmail draft. The full ten-app before/after benchmark remains NOT COMPLETE. Calendar Save and Gmail Send remain NOT DONE. The source runtime stays at the previously verified 73d5f0b integration with Jev disabled, ask-human mode and K1 state preserved. This receipt adds documentation and measurements only.
