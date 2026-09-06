---
kind: docs-index
last_reviewed: 2026-05-09
---

# Architecture Decision Records

This directory holds Jenny's accepted Architecture Decision Records (ADRs). Each
ADR captures the context, decision, and consequences for one design choice;
once accepted, an ADR is treated as a frozen historical record. Subsequent
decisions that supersede it land as new ADRs that link back rather than rewrite
history.

The numbering uses four-digit padding (`ADR-0001-…`). The numbering is global
and chronological by acceptance date, not per-track.

## Index

| # | Title | Status | Accepted |
|---|---|---|---|
| [ADR-0001](ADR-0001-face-sentiment-source.md) | Face Sentiment Source | Accepted | 2026-03-16 |
| [ADR-0002](ADR-0002-proactive-c1-architecture.md) | Proactive Behaviors C1 Architecture | Accepted | 2026-03-17 |
| [ADR-0003](ADR-0003-vision-b1-attachment-privacy.md) | Vision B1 Attachment Ownership and Privacy | Accepted | 2026-03-17 |
| [ADR-0004](ADR-0004-context-management-g1.md) | Electron-Owned Context Management Narrow v1 | Accepted | 2026-03-17 |
| [ADR-0005](ADR-0005-artifacts-panel-e1.md) | Artifacts Panel E1 | Accepted | 2026-03-17 |
| [ADR-0006](ADR-0006-offline-intelligence-i1.md) | Offline Intelligence I1 | Accepted | 2026-03-17 |
| [ADR-0007](ADR-0007-generated-artifacts-e2.md) | Generated Scratch Artifacts E2 | Accepted | 2026-03-18 |
| [ADR-0008](ADR-0008-comet-personality-system.md) | Comet Personality System | Accepted | 2026-04-02 |
| [ADR-0009](ADR-0009-sidecar-packaging-strategy.md) | Sidecar Packaging Strategy | Accepted | Phase 4 hardening |

## Authoring conventions

- **One file per decision.** New ADRs take the next available four-digit
  number.
- **Title format.** `# ADR-NNNN: Decision Subject` as the H1; this matches the
  filename suffix.
- **Sections.** Status, Context, Decision, Consequences. Optional sections
  include Alternatives Considered and Implementation Notes.
- **Status lifecycle.** `Proposed` → `Accepted` (with date) → optionally
  `Superseded by ADR-XXXX` if a later ADR replaces this decision. Avoid
  rewriting an accepted ADR; add a new one instead.
- **Cross-references.** Link to other ADRs by their four-digit ID (e.g.,
  `ADR-0008`, not `ADR-008`). Link to source files using markdown links.
- **Filing.** Add the new ADR row to the index table above when accepting.

## See also

- docs/INDEX.md — central docs discovery.
- docs/process/WORKSPACE_MANIFEST_SYSTEM.md — manifest system that records ownership.
