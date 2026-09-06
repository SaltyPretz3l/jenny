The f34016f non-coalescing shape (Ht-E): a turn whose only assistant-side
message is a settled (denied) tool call — the turn never produced assistant
text, so the render layer's whole-turn article gate used to drop it to the
legacy per-message path. This fixture pins the projector/reducer contract for
the shape: the hydrated projection emits a `tool_call` trace row (denied) with
`primary_assistant_message_id` resolved to the tool_use message, and the live
reducer replay reconciles with no stale rows. The render-layer fix
(`chat_tool_trace_rows_fix`) partitions per call: settled calls render the
trace row even when the turn article does not coalesce; unsettled calls keep
the classic approval block. DOM-level regression coverage lives in
tests/renderer-tool-rendering.test.js ("auto-expands pending approval and
denied tool rows").
