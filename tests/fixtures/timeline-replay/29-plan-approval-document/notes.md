# 29 — plan approval document

Pins one `exit_plan_mode` approval from the live stream through persisted replay.
The approval-needed payload carries the full pending plan document; the approved
`plan_mode_transition` result settles the same plan. Both canonical plan-document
events use the backend payload shape and must coalesce into one deterministic row
with `state: "approved"` and transitions `pending` then `approved`.

Harness artifact: `session.json` carries TWO messages with the same id
`plan_document_plan-29-1` (pending, then approved). Production persists ONE
message and patches it in place, keeping the transition history in the turn-event
log — a shape the corpus harness (which derives turn events from messages) cannot
express. If a future message normalizer dedupes by id, this scenario hollows out;
re-express the history through real persisted turn events instead.

The corpus lockstep checks also require the live plan row to be present whenever
hydration produces one, and require live-to-hydrated reconciliation to leave no
stale row. The terminal `complete` event intentionally makes sealing a no-op for
the already approved plan; pending-to-abandoned sealing has its own focused unit
test in `tests/renderer-stream-rehydrate.test.js`.
