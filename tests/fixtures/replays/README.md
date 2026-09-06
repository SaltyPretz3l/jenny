# Replay Fixture Corpus

Provider-neutral fixture corpus for the deterministic-local-harness roadmap (Phase 3).

Each fixture is a self-contained JSON document that captures one streamed assistant turn at five levels:

1. **Wire shape** (`raw_chunks`) — documentation of the on-the-wire chunks the engine wrapper consumes (Ollama JSON-lines or vLLM SSE). **Not consumed by the harness directly.**
2. **Engine yield** (`expected_engine_events`) — the canonical `StreamingEvent` / `ThinkingDelta` / `ToolCallRequest` instances the engine wrapper would yield to `stream_generate_with_tools`. Ollama fixtures whose stream carries a native tool call also pin the mid-stream `EngineEvent(kind="tool_call_completed")` announcement the wrapper emits as soon as the call is parsed (`sidecar/ai/engines/ollama_tool_call_announce.py`); the corpus records the production default, so the fixtures are red when `JENNY_ENABLE_TOOL_CALL_EARLY_ANNOUNCE=0` pins the kill switch.
3. **Routing emit** (`expected_loop_events`) — the typed `loop_events` emitted by the direct `stream_generate_with_tools` replay harness. Tool dispatch events such as `ToolExecutingEvent` belong to the post-approval dispatch layer and are covered by tool-loop/runtime tests.
4. **Wire notifications** (`expected_notifications`) — the JSON-RPC notification dicts that a translator over the routing-layer events would produce. Methods are validated against `sidecar.protocol.ALLOWED_NOTIFICATION_METHODS` at fixture load time.

5. **Canonical persistence** (`expected_turn_events`) — the finalized `turn_events[]` rows produced by `CanonicalTurnEventCollector`. Text and reasoning content is sourced from the notification stream, tool requests from `expected_generation_result.tool_calls`, and malformed/rejected outcomes from their fixture-family evidence. Every row pins its durable `payload.canonical_event_type`, canonical part id/sequence, message ownership, status, and tool-call identity.

Plus a final `expected_generation_result` that mirrors the `GenerationResult` returned by the engine on terminal.

## Schema

`schema_version: 1`. Required top-level keys: `schema_version`, `metadata`, `raw_chunks`, `expected_engine_events`, `expected_loop_events`, `expected_notifications`, `expected_turn_events`, `expected_generation_result`.

`metadata` requires: `fixture_family`, `provider`, `model`, `description`, `target_phase`.

Allowed `fixture_family` values (9):
- `native_tool_schema_stream`
- `thinking_plus_content_plus_tool`
- `inband_json_tool_call`
- `content_null_between_tool_deltas`
- `malformed_tool_arguments`
- `reasoning_only_completion`
- `tool_delta_then_final_text`
- `parallel_tool_calls`
- `tool_call_canceled_or_rejected`

Allowed `provider` values: `ollama`, `vllm`, `provider_neutral`.

Allowed `target_phase` values: `3`, `4`, `5`, `6`, `7`.

## Field-name convention

`expected_engine_events[*]` and `expected_loop_events[*]` use a `_class` discriminator that names the canonical Python dataclass (e.g., `StreamingEvent`, `ThinkingDelta`, `ToolCallRequest`, `TokenDeltaEvent`, `ThinkingEvent`, `ToolExecutingEvent`, `StopEvent`). The remaining keys are the dataclass field names verbatim — **no shorthand**:

- `ToolCallRequest` uses `tool_id`, `arguments`, `call_id` (not `id` / `name`).
- `expected_generation_result.tool_calls[*]` uses the same field names.
- `EngineEvent` uses `kind`, `tool_call_id`, `tool_name`, `arguments`, `sequence`; its routing-level counterpart `ToolCallCompletedEvent` uses `call_id` (not `tool_call_id`), `tool_name`, `arguments`, `sequence`.
- An announced `tool_call_id` MUST equal the `call_id` the fixture's `expected_generation_result.tool_calls[*]` declares for the same call — a mismatch strands an orphaned "requested" tool row in the renderer.

The schema validator (`tests/sidecar/replay/fixture_format.py`) rejects unknown class names, unknown method names, unknown turn-event kinds, and unknown fixture families at load time.

## Corpus

| # | Family | Provider | target_phase |
|---|---|---|---|
| 1 | `native_tool_schema_stream` | `ollama` | 3 |
| 2 | `native_tool_schema_stream` | `vllm` | 3 |
| 3 | `thinking_plus_content_plus_tool` | `ollama` | 3 |
| 4 | `thinking_plus_content_plus_tool` | `vllm` | 3 |
| 5 | `inband_json_tool_call` | `provider_neutral` | 3 |
| 6 | `content_null_between_tool_deltas` | `vllm` | 4 |
| 7 | `malformed_tool_arguments` | `vllm` | 4 |
| 8 | `reasoning_only_completion` | `ollama` | 4 |
| 9 | `reasoning_only_completion` | `vllm` | 4 |
| 10 | `tool_delta_then_final_text` | `vllm` | 4 |
| 11 | `parallel_tool_calls` | `ollama` | 4 |
| 12 | `parallel_tool_calls` | `vllm` | 4 |
| 13 | `tool_call_canceled_or_rejected` | `provider_neutral` | 5 |

**Acceptance:** all Phase 3 and Phase 4 routing/protocol fixture assertions pass; 1 fixture `skip` remains for the Phase 5 dependency.

## Volatile fields stripped before comparison

The harness fills or normalizes these at runtime and strips them before comparison:

- Notifications: `request_id`, `trace_id`, `session_id`, `api_version`.
- Persisted turn events: `event_id`, `event_seq`, `started_at`, `completed_at`, `turn_id`.

The corpus uses deterministic `event_id` and `turn_id` placeholders so each fixture also documents the complete `noteEvent()` input shape; those placeholders are still treated as volatile by the assertion.

## Authoring rules

- No live HTTP. `raw_chunks` are hand-authored from the on-the-wire shapes documented in `tests/sidecar/ai/engines/test_ollama_wrapper.py` and `tests/sidecar/ai/engines/test_vllm_engine.py`.
- The `request_id` used by the harness is `req_replay`, so any fixture-encoded `thinking_id` must be `think_req_replay_model` (since iteration starts at 0).
- Methods in `expected_notifications` must be in `sidecar.protocol.ALLOWED_NOTIFICATION_METHODS`.
- Kinds in `expected_turn_events` must be one of the 16 frozen `EVENT_KIND_PRIORITY` values from `renderer-turn-tree-projector.js`.
- Canonical text rows contain the concatenated `chat.token` deltas for the turn. Reasoning deltas are grouped by real phase, with one coalesced `reasoning_phase` row per phase and one entry per documented chunk.
- Persisted reasoning uses the sidecar canonical part identity (`t_replay:reasoning_part:<canonical_seq>`) for `thinking_id` and entry `thinkingId`; it does not use the legacy renderer `-thinking` suffix.
- A documented valid tool call carries `tool_use`, `tool_executing`, and `tool_result`. Parallel calls keep separate `tool_call_id` values. Malformed arguments fail before `tool_executing`; rejected approval carries `approval_requested`, `approval_resolved`, and a failed synthetic `tool_result`.
- The Node corpus guard independently reconciles text, reasoning, tool inputs/outcomes, and canonical ordering against the other fixture levels before running the collector round-trip. This keeps payload edits, event deletion, and order swaps non-vacuous.
