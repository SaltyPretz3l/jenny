# ADR-0005: Artifacts Panel E1

- Status: Accepted
- Date: 2026-03-17

## Context

Phase 5 Feature E needed a narrow first slice for an `Artifacts` surface in the active root shell.

Current repo constraints already in force:

- the active user-facing UI is the root Electron shell in `main.js`, `preload.js`, `renderer.js`, `index.html`, and `styles.css`
- Electron owns canonical session history and persistence
- sidecar requests remain stateless per request
- Feature B1 already persists safe image attachment metadata in session history
- tool execution state already persists `tool_use` and `tool_result` transcript records in Electron

The feature goal was to expose useful session artifacts without introducing a new artifact store, filesystem scanner, or cross-session content-management system.

## Decision

Ship E1 as a lightweight top-level `Artifacts` tab in the active root shell.

The panel is renderer-derived from the active session's persisted message history only.

E1 indexes only:

- persisted image attachments and screenshots already stored as safe message metadata
- persisted tool outputs derived from `tool_use` and `tool_result` transcript records

The panel is read-only in E1.

It does not add:

- new preload or IPC artifact APIs
- main-process artifact management services
- sidecar protocol/runtime changes
- cross-session browsing
- arbitrary filesystem scanning
- per-artifact deletion

## Consequences

### Persistence and ownership

- canonical artifact source data remains inside Electron-owned session messages
- no separate artifact database, cache file, or global artifact library is created
- deleting a session deletes its artifact index implicitly because the source messages are removed
- existing B1 image-asset pruning on session deletion remains the cleanup boundary for local image files

### Privacy and fail-closed behavior

- the panel shows only data already persisted in canonical session history
- raw image bytes, clipboard blobs, and inferred file contents are not persisted for artifact indexing
- missing local image assets render an unavailable placeholder instead of attempting recovery or path exposure
- raw filesystem paths are not surfaced as user actions in E1
- tool outputs without safe, explicit file metadata remain generic tool-output artifacts

### UX contract

- the transcript remains canonical; the Artifacts tab is a navigation/index surface, not a second source of truth
- every artifact links back to its source message in Chat with scroll + temporary highlight
- unsent queued attachments do not appear in Artifacts
- browsing Artifacts does not change context preferences, memory injection, or proactive behavior

## Follow-up

Later Feature E batches may add safe artifact actions or explicit generated-file artifacts, but only behind an Electron service boundary and only with explicit metadata rather than filesystem inference.
