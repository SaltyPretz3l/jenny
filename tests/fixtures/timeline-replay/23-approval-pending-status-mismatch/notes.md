Regression lock for the source-event partition fix: a tool whose `approval_state` is
`pending` but whose `tool_call.status` is NOT `pending_approval` (here `running` — a
legacy/migrated session, or a partial write that advanced the status while the approval
stayed pending). The tree-projector still emits an `approval_requested` event purely on
`approval_state === 'pending'`, so a standalone `approval_gap` row is emitted.

Because the gap row OWNS the `approval_requested` event (partition), it is withheld from
the tool_call row's source events — so the tool_call row's state must NOT be derived from
the stale `running` status (which would read `interrupted`). The projector passes
`awaitingApproval` to `buildToolCallRow` so the badge stays `awaiting_approval`, consistent
with the visible Allow/Deny block. Without that fix the tool_call row would render
`interrupted` next to an active approval prompt.

No stream-events.json: this is a projector-only invariant (the live reducer sets
`awaiting_approval` directly from the approval_requested event, independent of the partition).
