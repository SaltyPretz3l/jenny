A tool call that is blocked awaiting user approval (no resolution, no result). The
hydrated projection emits a standalone `approval_gap` row (the Allow/Deny block) after
the `tool_call` row. The stream-events replay (started -> tool_use -> tool_approval_needed)
must reduce to a matching `tool_call` + `approval_gap` provisional pair via the streaming
reducer — this is the regression guard for the "Awaiting approval" soft-lock, where the
live reducer flipped the tool_call status but never surfaced the standalone approval-gap
row, so the buttons never rendered live.

Replay note: `tool_approval_needed` carries the `stream_22:approval_requested:0` event id
(the converter's id for the pending-approval signal) so the provisional gap row's identity
reconciles cleanly against the hydrated trace row. The `tool_use` event deliberately omits
`pending_approval` here so the gap row is created from the single canonical approval signal
rather than a suffixed duplicate; the reducer's unit tests cover the live
`tool_use(pending_approval)` path directly.
