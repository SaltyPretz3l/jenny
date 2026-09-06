# 20 — plan proposal (Wave F contract fixture)

A normal chat-mode turn that answers AND settles with a structured
**plan proposal** on the same turn (same `streamId` `stream_20`) — the
persisted shape of the Wave F `chat.plan_proposal` contract (the terminal
sibling of `chat.question_batch`, fixture 19). Emission is gated behind the
default-off `plan_proposal_surface` sidecar flag and does not exist yet
(F3); this fixture pins the renderer-side projection contract ahead of it.

The turn projects (trace projector) to three rows: `user_bubble`,
`assistant_text` (the answer), and `plan_proposal` (the appended proposal).
The `plan_proposal` row payload carries the full proposal object
(`proposal_id`, `title`, `intro_text`, `steps[{id,label,detail?}]`).

Mode-invariant: live-vs-inert rendering ("Jenny proposes" Approve / Adjust /
Dismiss card vs the inert "Jenny proposed" summary) is decided at render
time from `session.pending_plan_proposal`, not stored in the row — so this
fixture is a stable projector/reducer spec. Additive to the corpus
(existing goldens byte-identical).
