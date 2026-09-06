# ADR-0004: Electron-Owned Context Management Narrow v1

## Status
Accepted 2026-03-17.

## Context

Phase 5 Feature G needed a narrow implementation that works on the active root Electron shell, preserves Electron-owned canonical history, and keeps the sidecar stateless per request. The repo already had deterministic memory recall, proactive local-only transcript artifacts, and managed-sidecar-only vision support. The missing piece was a user-visible way to control how much prior context Electron sends on the next request.

## Decision

- Persist per-session `context_preferences` in Electron-owned session stores.
- Shape outbound managed-sidecar transcript history in Electron before `chat.send`.
- Support three history scopes:
  - `session`
  - `recent` (last 6 complete user-anchored turn groups)
  - `fresh` (current prompt only)
- Keep personality context injection and approved-memory recall behind the same session-local preference object.
- Leave full transcript persistence unchanged.
- Keep external backend mode unchanged and render the Context controls as unavailable there.

## Consequences

- Context management remains a shell concern, not a sidecar state concern.
- Unknown or malformed history scope values normalize fail-closed to `fresh`, not full-session replay.
- `proactive_suggestion`, `question_batch`, and `interactive_round_recap` messages remain local UI artifacts and are not replayed as model context.
- No JSON-RPC contract change is required for this narrow v1.

## Follow-Up

- Re-run full renderer-shell and CI verification in a normal local environment.
- If later batches add token budgeting or automatic compaction, they should build on the same Electron-owned shaping seam instead of moving transcript ownership into sidecar code.
