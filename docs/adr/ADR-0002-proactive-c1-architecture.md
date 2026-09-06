# ADR-0002: Proactive Behaviors C1 Architecture

## Status

Accepted - 2026-03-17

## Context

Feature C in `NEXT_STEPS.md` called for proactive companion behaviors, but the earlier roadmap was pointing at Symphony and React settings paths that are not the active user-facing shell. The current app still runs through the root Electron shell in `main.js`, `preload.js`, `renderer.js`, `index.html`, and `styles.css`.

This batch also needed a canonical owner for `tools_workspace_root` before watcher-based behaviors could ship safely. The existing runtime was still relying on environment-driven workspace-root defaults, which is not sufficient for user-controlled proactive behavior.

The unresolved Feature C questions for this batch were:

- are proactive behaviors opt-in per behavior or behind one global toggle?
- should file watchers use only configured globs or auto-detect interesting files?
- should the architecture live in Symphony or in the active Electron shell?
- may C1 make background LLM calls?

## Decision

Implement Proactive Behaviors C1 as an Electron-owned local subsystem with persisted shell config.

- Consent model: opt-in per behavior.
- Watcher scope: configured globs only.
- Architecture: Electron-owned services plus the active root-shell UI, not Symphony.
- Model usage: no background LLM calls in C1.

Concrete ownership:

- `services/shell-config-service.js` is the canonical owner of persisted `tools_workspace_root`, proactive settings, reminders, and the last emitted morning briefing date.
- `services/proactive/` owns proactive scheduling, watcher lifecycle, cooldowns, dedupe, and suggestion emission.
- `services/backend/backend-service.js` consumes the persisted workspace root when building managed sidecar config and refreshes managed config when that root changes.
- `preload.js` exposes the renderer-facing proactive API.
- The active root shell owns proactive settings, toasts, transcript rendering, and composer-prefill UX.

## Consequences

Positive:

- The feature lands on the UI users actually run today.
- Workspace-root gating becomes explicit, persisted, and visible in the shell.
- Proactive behaviors remain deterministic, cheap, and testable.
- Suggestions stay user-visible and non-blocking instead of silently invoking tools or models.

Tradeoffs:

- Morning briefings are limited to local deterministic sources for now.
- File watchers do not auto-detect "interesting" files outside the user's allowlist.
- Repository-host data such as open PRs is deferred until a dedicated integration surface exists.

Follow-up:

- Future Feature C work may add richer enrichments or provider-backed summaries only with an explicit visible-consent design.
- Repository-host integrations should be a later batch on top of this Electron-owned foundation, not a reason to move the runtime into Symphony.
