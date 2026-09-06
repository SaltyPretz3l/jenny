# Timeline Replay Coverage Matrix

This matrix maps each replay fixture to the renderer projection branch or
contract it is meant to guard. Keep it updated when adding, renaming, or
removing timeline replay scenarios.

| Scenario | Intended coverage |
|---|---|
| `25-stream-error` | Partial assistant text followed by a persisted runtime stream error; pins answer-plus-terminal-recovery projection and the single assistant-error notice. |
| `26-tool-timed-out` | Persisted tool approval/lifecycle timeout; pins canonical `timed_out` tool-call projection without fabricating a result row. |
| `27-long-reasoning-summary` | Long provider reasoning summary in a collapsed completed phase followed by a concise final answer; pins dense reasoning rehydration and row ordering. |
| `01-simple-turn` | Baseline user/assistant turn projection with one visible assistant text segment. |
| `02-one-tool-pre-post-reasoning` | Tool turn with pre-tool reasoning, commentary, a completed tool split into `tool_call` + `tool_result` rows, post-tool reasoning, and final answer text. |
| `03-approval-approved` | Approval-resolved approved state followed by a successful tool result and final assistant answer. |
| `04-interleaved-tools` | Multiple tool calls in one turn where approval wait, execution, and resolution events interleave without row duplication. |
| `05-approval-denied` | Denied approval terminal state without a persisted tool result. |
| `06-inline-artifacts` | `generated_artifacts` metadata hydration for stable inline artifact affordances after reload. |
| `07-tool-use-error-invalid-args` | Invalid tool arguments producing a failed tool-use/tool-result pair that splits into an errored `tool_call` row and a separate errored `tool_result` row; also the stream-events reconcile witness. |
| `08-stream-reset-after-text` | Reset-style assistant text replacement where a visible segment is followed by a reset notice and restarted assistant segment. |
| `09-agent-progress` | Agent-progress snapshot row projected between the user bubble and the final answer; carry-free (mode-invariant). |
| `11-branched-retry` | Multi-turn projection for an original answer plus a simplified retry turn. |
| `12-legacy-no-phases` | Legacy transcript fallback projection when persisted phase records are absent. |
| `13-slash-output` | Renderer-synth slash-command output projects as its own standalone turn with a single slash_output row. |
| `14-attachment-cluster` | User attachment cluster folded into the user_bubble row at projection (no standalone attachment row at HEAD); pins the D3 merge contract. |
| `15-interactive-batch-recap` | Settled interactive question batch + round recap project as first-class batch + recap rows; carry-free (mode-invariant). |
| `16-reload-mid-running-tool` | Reload-mid-turn hydration for a running tool without a result, rendered as one interrupted `tool_call` row (no `tool_result`). |
| `17-system-notice-subkinds` | A context_compacted system-notice subkind projects as a system_notice row between bubbles; complements 08's unknown_kind subkind. |
| `18-stream-events-tool-call-trace` | A normal successful tool call whose stream-events replay reduces to a `tool_call` + `tool_result` provisional pair that reconciles against the hydrated trace projection with no stale rows — the D1 trace-parity reflow witness (second stream-events fixture alongside 07). |
| `19-normal-turn-question-batch` | Normal chat-mode turn that answers AND appends a clarifying question batch on the same turn/`streamId` (the B7b post-router emission shape — always-on since composer-rethink C1, with the `interactive_post_router_questions` kill-switch); projects to `user_bubble` + `assistant_text` + `batch` rows, carry-free (mode-invariant) — distinct from 15, where the batch is a standalone interactive-mode turn with no preceding assistant answer. |
| `20-plan-proposal` | Legacy compatibility fixture for an older sidecar that settled a structured proposal; projects to `user_bubble` + `assistant_text` + an inert `plan_proposal` row carrying the historical payload. Current sidecars no longer emit this terminal shape. |
| `21-jenny-write-edit-diff-metadata` | Phase 4 Jenny-authored `write_file` + `edit_file` tool sequence carrying bounded `tool_result.metadata.diff` payloads; pins the trace `tool_call` + `tool_result` row pairs for the agentic-coding write+edit pattern the code-review rail surfaces. |
| `22-approval-pending` | Tool call blocked awaiting user approval (no resolution/result); both the hydrated projection and the stream-events reducer (`started` → `tool_use` → `tool_approval_needed`) emit a standalone `approval_gap` (Allow/Deny) row after the `tool_call` row — the regression guard for the "Awaiting approval" soft-lock where the live reducer flipped the tool_call status but never surfaced the gap row live. |
| `23-approval-pending-status-mismatch` | Source-event partition lock: `approval_state` is `pending` but `tool_call.status` is NOT `pending_approval` (here `running`, from a legacy/partial write). The gap row owns the `approval_requested` event, so the projector must pass `awaitingApproval` to keep the tool_call badge `awaiting_approval` instead of deriving stale-`running` `interrupted`. Projector-only invariant (no stream-events). |
| `24-settled-tool-no-assistant-text` | The f34016f non-coalescing shape (Ht-E): a settled (denied) tool call in a turn with NO assistant text — pins the hydrated projection (`tool_call` trace row with `primary_assistant_message_id` resolved to the tool_use message) and the stream-events replay (`started` → `tool_use(pending_approval)` → `tool_use(denied)`) reconciling with no stale rows; the render-layer per-call partition behind `chat_tool_trace_rows_fix` relies on this contract. |
| `28-reasoning-replay-after-text` | Persisted-only pin for the 2026-08-29 duplicate-Thought-row fix: the coalesced persisted log projects exactly ONE reasoning row before the assistant text. The live same-entry-id echo half is pinned in renderer-turn-reducer-reasoning-replay.test.js and renderer-reasoning-row-dupe.test.js (the corpus live lane cannot twin-pair reasoning/text rows under legacy row ids; harness gap filed). |
| `29-plan-approval-document` | One `exit_plan_mode` approval carried from the live stream through persisted replay coalesces the pending plan document and approved `plan_mode_transition` result into one deterministic plan-document row with `state: "approved"` and transitions `pending` then `approved`. |
