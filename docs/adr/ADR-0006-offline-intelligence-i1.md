# ADR-0006: Offline Intelligence I1

- Status: Accepted
- Date: 2026-03-17

## Context

Phase 5 Feature I needed a narrow first slice for `Offline Intelligence` that fit the current architecture instead of introducing a new orchestration layer.

Current repo constraints already in force:

- the active user-facing UI is the root Electron shell in `main.js`, `preload.js`, `renderer.js`, `index.html`, and `styles.css`
- Electron owns canonical session history and persistence
- sidecar requests remain stateless per request
- managed-sidecar readiness, model catalog, and engine fallback state already exist behind Electron services
- Feature D memory recall, Feature G context management, Feature B1 vision/screenshots, and Feature C1 proactive behaviors are already landed on the active shell

The feature goal was to add useful local/offline behavior without:

- moving work into dormant Symphony / React paths
- silently falling back between cloud and local modes
- changing the sidecar JSON-RPC contract for the first slice
- hiding mode changes behind background automation

## Decision

Ship I1 as an explicit shell-owned `local-only chat` mode plus visible offline-readiness state.

The shell now persists:

- `offlineIntelligence.mode`
- `offlineIntelligence.preferredLocalModel`

Electron derives a renderer-facing `OfflineState` from:

- persisted shell config
- managed-sidecar status
- managed runtime `engine_fallback`
- `models.list('ollama')`

The renderer consumes that state only through:

- `window.jennyShell.offline.getState()`
- `window.jennyShell.offline.updateSettings(...)`

When `offlineIntelligence.mode === 'local_only'`, managed sends must:

- require managed-sidecar mode
- require an explicitly selected installed local Ollama model
- use that selected local model for execution without mutating the stored session `preferred_model`
- fail closed before `chat.send` when local runtime/model readiness is unavailable
- fail closed for image sends when the selected local model does not appear vision-capable

I1 does not add:

- automatic cloud-to-local or local-to-cloud failover
- bundled model download UX
- auto-pull of missing local models
- internet-connectivity probing
- hidden background model-backed behaviors

## Consequences

### Ownership and persistence

- Electron remains the source of truth for offline mode, readiness normalization, and canonical session history
- sidecar remains stateless per request
- the stored session `preferred_model` remains canonical session state and is not rewritten by local-only execution overrides
- shell config migration to version `2` is the persistence boundary for this feature

### Fail-closed and privacy behavior

- `engine_fallback` to `mock` is treated as unavailable local runtime state, not valid offline chat
- local-only mode never silently falls back to cloud chat
- image analysis remains current-turn-only and local-only vision fails closed when the selected model lacks vision support
- the feature does not persist raw image bytes, provider secrets, or expanded transcript copies

### UX contract

- the active root-shell Settings view owns the primary `Offline Intelligence` control surface
- the composer shows only a lightweight local-only status pill; I1 does not add hidden background intelligence
- deterministic shell-local features remain usable offline even when local chat is unavailable
- local/offline readiness is explicit and user-controlled rather than inferred from general network probes

## Follow-up

Later Feature I batches may add stricter installed-only local model policy inside the runtime, richer local-model guidance, or cloud/local fallback decisions, but only with explicit user-visible state and without breaking the current ownership boundaries.
