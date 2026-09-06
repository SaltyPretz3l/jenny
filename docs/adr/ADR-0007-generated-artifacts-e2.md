# ADR-0007: Generated Scratch Artifacts E2

Status: Accepted

Date: 2026-03-18

## Context

ADR-0005 shipped the initial Artifacts tab as a session-local, renderer-derived, read-only view over persisted image attachments and tool outputs.

That was intentionally narrow. Jenny still lacked a polished path for:

- creating temporary planning documents or helper scripts during a turn
- treating those generated files as first-class artifacts instead of generic tool output
- opening and editing those artifacts in-app without exposing arbitrary renderer file access

We also needed the Electron tool loop and the managed Python sidecar to converge on one canonical artifact shape so the Artifacts tab could stay transcript-derived instead of introducing a second artifact database.

## Decision

We extend the artifact model from read-only projection to explicit generated-file artifacts.

Key decisions:

- First-class scratch artifacts remain transcript-derived.
  They are surfaced only when a persisted `tool_result` carries explicit `generated_artifacts` metadata.
- The default scratch location is session-scoped under the configured tools workspace root:
  `"<tools_workspace_root>/.jenny/artifacts/<sessionId>/"`.
- Artifact creation remains side-effecting and approval-visible through the existing tool approval path.
- Electron owns artifact file resolution and file IO through a dedicated artifact service plus preload IPC.
  The renderer resolves artifacts only by `sessionId + artifactId`, never by raw filesystem path.
- The Artifacts tab stays session-local.
  No global artifact library or cross-session artifact browser is introduced in this batch.
- Generated text/code artifacts are editable in-app through a bounded standalone editor surface.
  We use Monaco standalone when available at runtime, with a renderer-safe textarea fallback for tests and degraded environments.
- Generic `write_file` / `Write` results do not automatically become artifacts.
  Only explicit `create_artifact` results project as first-class generated-file artifacts.

## Consequences

Positive:

- Jenny can now create scratch plans and scripts as intentional workspace artifacts.
- Artifact cards, persistence, and renderer behavior are consistent across Electron-side tools and managed-sidecar tools.
- The renderer keeps a narrow trust boundary because all artifact file actions stay behind Electron IPC.
- The Artifacts tab becomes a practical session workspace without turning into a general-purpose file manager.

Tradeoffs:

- Artifact editing is intentionally narrow: save, revert-to-disk, reveal, open externally, and jump-to-chat only.
- Rename, delete, version history, and cross-session artifact browsing remain out of scope.
- Generated artifacts are still workspace-backed files, so they depend on a configured and valid `tools_workspace_root`.

## Implementation Notes

- Electron artifact file operations live in `services/artifact-workspace-service.js`.
- Canonical message normalization preserves `tool_result.generated_artifacts`.
- The Python sidecar now exposes `create_artifact` through the builtin MCP server and forwards `generated_artifacts` through router/runtime notifications.
- The root-shell Artifacts tab now supports a split list/detail layout with inline generated-file editing.
