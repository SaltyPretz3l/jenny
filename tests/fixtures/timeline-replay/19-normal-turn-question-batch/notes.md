# 19 — normal-turn question batch (B7b post-router emission)

A normal **chat-mode** turn that answers AND appends a clarifying question batch
on the **same turn** (same `streamId` `stream_19`) — the shape produced by the
B7b post-router emission point (D2), gated at runtime behind the default-off
`interactive_post_router_questions` feature flag.

The turn projects (post-B6 trace projector) to three rows:
`user_bubble`, `assistant_text` (the router answer), and `batch` (the appended
`question_batch`). This is distinct from fixture 15, where the batch is a
standalone interactive-mode turn with no preceding assistant answer.

Carry-free / mode-invariant: the `batch` row payload carries the full
`question_batch` object; live-vs-inert rendering is decided at render time from
`session.pending_question_batch` (B7a), not stored in the row — so this fixture
is a stable projector/reducer spec. Additive to the corpus (existing goldens
byte-identical).
