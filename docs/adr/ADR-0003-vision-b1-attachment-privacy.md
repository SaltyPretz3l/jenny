# ADR-0003: Vision B1 Attachment Ownership and Privacy

## Status

Accepted - 2026-03-17

## Context

Feature B in `NEXT_STEPS.md` called for screenshots and vision chat, but the active app surface is still the root Electron shell in `main.js`, `preload.js`, `renderer.js`, `index.html`, and `styles.css`. The existing attachment flow only supported text files, and the current architecture still requires:

- Electron-owned canonical session persistence
- sidecar statelessness per request
- root-shell ownership of active user-facing UI
- fail-closed behavior when a backend, model, or mode cannot safely support a feature

This batch also needed an explicit privacy boundary. Clipboard images, imported files, and capture results must be reviewable by the user before send, and the app must not persist raw image blobs inside session history.

## Decision

Implement Vision B1 as a root-shell Electron attachment pipeline with managed-sidecar multimodal dispatch.

Concrete ownership:

- `services/attachment-service.js` owns mixed text/image attachment normalization and safe persisted metadata shaping.
- `services/attachment-asset-store.js` owns app-managed image asset persistence under Electron user data.
- `main.js` and `preload.js` own the renderer bridge for picking files, preparing drag/drop payloads, saving pasted/captured image assets, and releasing staged assets.
- The active root-shell composer and transcript own the privacy-review UI for queued images, transcript rendering, and explicit capture initiation.
- `services/backend/backend-service.js` and `services/backend/managed-sidecar-chat.js` own fail-closed gating and current-turn attachment dispatch for managed mode.
- `sidecar/runtime/chat.py` owns top-level `chat.send.attachments` validation and `generate_with_vision(...)` dispatch for supported engines only.

Privacy and persistence rules:

- Imported and captured images are copied into an app-managed asset directory immediately.
- Persisted message records store only safe metadata such as `id`, `kind`, `displayName`, `mimeType`, `sizeBytes`, `width`, `height`, `assetPath`, and `sourceKind`.
- Electron does not persist raw image bytes, clipboard blobs, base64 payloads, or derived image text in session history.
- Removing a staged image or clearing the queue deletes the unreferenced staged asset, and session deletion prunes image assets that are no longer referenced by any remaining message.

Multimodal runtime rules:

- Vision v1 is current-turn-only: top-level `chat.send.attachments` carries image attachments for the active send while prior history stays text-based.
- Vision v1 is chat-mode-only and managed-sidecar-only.
- Unsupported engines/models, external backend mode, and unsupported conversation modes fail closed with an explicit user-facing error instead of silently dropping images.

## Consequences

Positive:

- The feature lands on the shell users actually run today.
- Users get a visible review step before sending local screenshots or pasted images.
- Session persistence stays compact and privacy-bounded.
- The sidecar stays stateless per request while still supporting image analysis for the current turn.

Tradeoffs:

- Vision support is intentionally narrower than a full multimodal conversation schema.
- External backend mode does not get image analysis in this batch.
- Screen capture is explicit full-screen/window capture only; region selection is deferred.

Follow-up:

- If multimodal history becomes necessary later, design it as a deliberate protocol and persistence change instead of backfilling raw image data into the current message history format.
- If additional engines gain production-ready `generate_with_vision(...)` support, they can be added behind the same fail-closed validation path.
