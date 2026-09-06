# 28 — reasoning replay after text

Pins the live and persisted halves of the 2026-08-29 duplicate-Thought-row fix. A
same-entry-id reasoning completion arrives after the assistant text row; the reducer
must update the existing reasoning row in place, never append a duplicate below the
answer. Deterministic row ids must exact-pair both the reasoning and assistant-text
rows with their hydrated twins in the P2 lockstep gate.

The canonical collector coalesces the same-phase reasoning events, so hydration
projects exactly one reasoning row before the answer. The focused reducer and renderer
regressions remain in `tests/renderer-turn-reducer.test.js` and
`tests/renderer-reasoning-row-dupe.test.js`.
