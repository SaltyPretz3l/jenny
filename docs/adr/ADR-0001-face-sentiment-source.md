# ADR-0001: Face Sentiment Source

## Status

Accepted - 2026-03-16

## Context

Feature F in `NEXT_STEPS.md` requires Jenny's face to react to conversation tone, but the feature's open question leaves the sentiment source undecided:

- parse Jenny's own response text locally, or
- request an explicit emotion tag from the model in structured output

The current shell already has a renderer-local face controller, expression presets, and transcript state. The Phase 5 scope boundary also says sentiment mapping should be a static lookup table, not a new ML classifier.

## Decision

Use deterministic renderer-local sentiment parsing against Jenny's completed assistant text.

- No model schema or prompt changes.
- No sidecar or IPC changes.
- Tone detection is a static keyword/question heuristic that maps responses into face expressions such as `warm`, `concerned`, `confused`, and `idle`.
- Tool execution states remain a separate higher-priority ambient signal in the renderer.

## Consequences

Positive:

- Works with every provider immediately.
- Keeps Feature F inside the active shell with a small, reviewable diff.
- Avoids coupling face behavior to structured output reliability.
- Honors the `NEXT_STEPS.md` scope boundary for static sentiment mapping.

Tradeoffs:

- Tone detection is heuristic and may misclassify some edge cases.
- We do not get an explicit emotional intent signal from the model.

Follow-up:

- If Voice (Feature A) or future multimodal work needs richer affect signals, we can add an optional structured emotion channel later without invalidating this renderer-local fallback.
- The comet personality system (ADR-0008, 2026-04-02) reuses `inferSentimentFromText()` from this ADR as its sentiment bridge, mapping keyword-heuristic sentiment into comet behavior and palette changes. The face avatar is superseded but the sentiment source decision remains valid and load-bearing.
