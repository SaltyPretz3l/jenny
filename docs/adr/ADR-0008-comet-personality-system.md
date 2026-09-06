# ADR-0008: Comet Personality System

## Status

Accepted - 2026-04-02

## Context

Feature F (Face Personality) delivered sentiment-driven SVG face expressions, but the face avatar never achieved the desired look and was disabled by default. The existing comet animation (`renderer-comet.js`) — an SVG orbiting tail used as a thinking/streaming indicator — already had the right visual DNA: a glowing, ethereal particle with smooth motion and color cycling.

The decision was made to pivot from the face avatar to a Navi-like comet companion as Jenny's primary visual personality. The comet should:
- Be persistently visible, not just during inference
- React to user actions, stream state, and sentiment
- Use modular, pluggable movement behaviors for future extensibility
- Eventually break out of the app window as a desktop overlay companion (Phase 2)

The face avatar taught us that visual personality experiments need clean kill switches. Every layer of the comet system must be independently disableable with zero impact on core functionality.

## Decision

### Architecture: layered modules with zero-coupling teardown

```
renderer-comet.js              (extended — backward-compatible new APIs)
comet/behaviors/               (plugin directory — one file per movement behavior)
  behavior-registry.js         (registry + engine with lerp transitions)
  idle-drift.js, settle.js, follow-cursor.js, alert.js, excited.js
renderer-comet-personality.js  (state machine: 8 states -> behavior + palette)
comet/index.js                 (orchestrator, feature-flag gate)
comet/comet-dom.js             (persistent DOM layer spanning workspace)
```

### Key design decisions

1. **Behavior plugin system.** Each movement behavior is a standalone UMD module implementing `{ name, enter(pos), update(dt, ctx), exit() }`. The registry resolves behaviors by name and lerps between them during transitions. Adding a new behavior = one new file + `engine.register()`. No other files change.

2. **Single comet instance.** The personality system creates one persistent comet in a workspace-spanning DOM layer. During thinking/responding, the personality module coordinates with the existing thinking indicator's state machine (stall detection, shimmer timing) while the live-thinking chip remains a status-only surface.

3. **Sentiment reuse.** The comet reuses `inferSentimentFromText()` from `face-personality-utils.js` — the same deterministic keyword heuristic from ADR-0001. No new model schema or sidecar changes.

4. **Feature flag isolation.** `comet_personality` defaults on as Jenny's primary in-app personality layer, but remains independently disableable. All integration in `renderer.js` uses optional chaining (`?.`) and null-safe proxies. Removing all comet script tags from `index.html` causes zero errors.

5. **Phase 2 independence.** The future desktop overlay is gated by a separate `comet_overlay` flag and runs as an isolated Electron service. It can be disabled or crash without affecting the in-app comet or Jenny's core functionality.

## Consequences

Positive:
- Lightweight visual personality that works immediately with every provider.
- Modular behavior system supports incremental experimentation without risk.
- Zero-coupling design means the feature can be disabled or removed at any time.
- Reuses the comet visual language without a second renderer — the live-thinking indicator continues to provide timing/status feedback without its own comet instance.

Tradeoffs:
- The comet expresses personality through motion and color only — no facial features, expressions, or eye tracking. This is intentional but limits expressiveness compared to the face system.
- Two animation loops run when the personality is active (comet's own rAF for SVG rendering + personality's rAF for behavior engine). Performance impact is negligible on desktop but should be monitored.

Follow-up:
- Phase 2: Desktop breakout overlay (`comet_overlay` flag, transparent `BrowserWindow`, `setIgnoreMouseEvents` for click-through).
- Cursor interaction refinement: follow-cursor behavior tuning, hover reactions, on-comet-click actions.
- User customization: palette selection, behavior speed, tail length preferences via Settings UI.
- Voice integration: if Voice (Feature A) ships, the comet could pulse with audio amplitude.
