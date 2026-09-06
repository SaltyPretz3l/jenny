"""Protocol constants for JSON-RPC communication between Electron and sidecar."""

from __future__ import annotations

JSONRPC_VERSION = "2.0"
CONTENT_LENGTH_HEADER = "Content-Length"

# Version handshake between Electron and sidecar.
# Jenny currently ships the Electron shell and sidecar in lockstep, so wire
# changes can bump one shared API version without extra capability negotiation.
# Upgrade policy: see docs/operations/versioning-and-migration.md.
# The paired client constant lives at services/backend/sidecar-client.js.
API_VERSION = "2026-08-17"

INITIALIZE_METHOD = "initialize"
# Stage-4-reserved initialize `mode` discriminator values (PLUG-D16;
# sidecar/runtime/initialize_mode.py owns the behavioral guard). Duplicated
# here as plain literals rather than imported so this module keeps its
# zero-intra-package-import posture -- keep byte-identical to
# sidecar.runtime.initialize_mode.FULL_RUNTIME_MODE / PLUGIN_RUNTIME_MODE.
INITIALIZE_MODE_FULL_RUNTIME = "full_runtime"
INITIALIZE_MODE_PLUGIN_RUNTIME = "plugin_runtime"
SHUTDOWN_METHOD = "shutdown"
BACKGROUND_RUN_METHOD = "background.run"
CHAT_SEND_METHOD = "chat.send"
CHAT_CANCEL_METHOD = "chat.cancel"
# Inbound shell->sidecar NOTIFICATION (no id, no response): the shell observed
# the managed local engine producing work (decode/prompt-eval/load telemetry on
# its captured stderr). Stamps the engine-liveness clock consulted by the
# stream-inactivity watchdog so a silently-busy engine (e.g. Ollama buffering a
# huge tool call) is not mistaken for a hung one. Routed by the multiplexer.
ENGINE_ACTIVITY_METHOD = "engine.activity"
SESSION_RUN_MODE_UPDATED_METHOD = "session.run_mode_updated"
# Manual context-compaction trigger. Request/response sibling of chat.send /
# chat.cancel — NOT a notification, so it is intentionally absent from
# ALLOWED_NOTIFICATION_METHODS. Success re-emits the existing
# CONTEXT_COMPACTED_METHOD notification; no new notification channel exists.
CHAT_COMPACT_METHOD = "chat.compact"
MODELS_LIST_METHOD = "models.list"
MODELS_UNLOAD_METHOD = "models.unload"
# Returns the models currently resident in the app-managed Ollama daemon
# (`/api/ps`) enriched with measured footprint (size, size_vram, digest,
# parameter_size, quantization_level) for the model-fit "record on first
# load" self-catalog feature. See sidecar/runtime/request_dispatch.py.
MODELS_RESIDENT_METHOD = "models.resident"
MODELS_OLLAMA_BLOB_METHOD = "models.ollama_blob"
MEMORY_SUGGEST_METHOD = "memory.suggest"
MEMORY_SAVE_METHOD = "memory.save"
MEMORY_LIST_METHOD = "memory.list"
MEMORY_PENDING_LIST_METHOD = "memory.pending.list"
MEMORY_PENDING_DELETE_METHOD = "memory.pending.delete"
MEMORY_UPDATE_METHOD = "memory.update"
MEMORY_DELETE_METHOD = "memory.delete"
MEMORY_RECALL_METHOD = "memory.recall"
MEMORY_RECALL_RECENT_METHOD = "memory.recall_recent"
MEMORY_STATUS_METHOD = "memory.status"
SUGGESTIONS_GENERATE_METHOD = "suggestions.generate"
COMMIT_GENERATE_MESSAGE_METHOD = "commit.generate_message"
INLINE_COMPLETE_METHOD = "inline.complete"
INLINE_LOADED_MODELS_METHOD = "inline.loaded_models"
INLINE_UNLOAD_METHOD = "inline.unload"
HARDWARE_PROFILE_METHOD = "hardware.profile"
HARDWARE_VRAM_USAGE_METHOD = "hardware.vram_usage"
HARNESS_INSPECT_METHOD = "harness.inspect"
HARNESS_TURN_DIAGNOSTIC_METHOD = "harness.turn_diagnostic"
MCP_INSPECT_METHOD = "mcp.inspect"
WORKSPACE_LIST_CHANGE_SETS_METHOD = "workspace.list_change_sets"
WORKSPACE_PREFLIGHT_UNDO_METHOD = "workspace.preflight_undo"
WORKSPACE_UNDO_CHANGE_SET_METHOD = "workspace.undo_change_set"
WORKSPACE_RESTORE_TRASH_ENTRY_METHOD = "workspace.restore_trash_entry"
# WO-26: user-initiated wall-clock-review surfacing for change sets that have
# aged past the 365-day wall cap without evicting anything -- listing never
# mutates; acknowledging durably records `retention.wall_clock_review_presented_at`
# so a LATER maintenance pass may age-evict that set. Neither is a notification.
WORKSPACE_LIST_RECOVERY_REVIEW_METHOD = "workspace.list_recovery_review"
WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD = "workspace.acknowledge_recovery_review"
WORKSPACE_ABANDON_RESTORE_METHOD = "workspace.abandon_restore"

# Shell -> sidecar request methods that participate in the lockstep API-version
# contract. ``engine.activity`` and ``session.run_mode_updated`` are unversioned
# inbound notifications;
# JSON-RPC responses (tool approval decisions) carry no method or params.
INBOUND_VERSIONED_REQUEST_METHODS: frozenset[str] = frozenset(
    {
        INITIALIZE_METHOD,
        SHUTDOWN_METHOD,
        BACKGROUND_RUN_METHOD,
        CHAT_SEND_METHOD,
        CHAT_CANCEL_METHOD,
        CHAT_COMPACT_METHOD,
        MODELS_LIST_METHOD,
        MODELS_UNLOAD_METHOD,
        MODELS_RESIDENT_METHOD,
        MODELS_OLLAMA_BLOB_METHOD,
        MEMORY_SUGGEST_METHOD,
        MEMORY_SAVE_METHOD,
        MEMORY_LIST_METHOD,
        MEMORY_PENDING_LIST_METHOD,
        MEMORY_PENDING_DELETE_METHOD,
        MEMORY_UPDATE_METHOD,
        MEMORY_DELETE_METHOD,
        MEMORY_RECALL_METHOD,
        MEMORY_RECALL_RECENT_METHOD,
        MEMORY_STATUS_METHOD,
        SUGGESTIONS_GENERATE_METHOD,
        COMMIT_GENERATE_MESSAGE_METHOD,
        INLINE_COMPLETE_METHOD,
        INLINE_LOADED_MODELS_METHOD,
        INLINE_UNLOAD_METHOD,
        HARDWARE_PROFILE_METHOD,
        HARDWARE_VRAM_USAGE_METHOD,
        HARNESS_INSPECT_METHOD,
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        MCP_INSPECT_METHOD,
        WORKSPACE_LIST_CHANGE_SETS_METHOD,
        WORKSPACE_PREFLIGHT_UNDO_METHOD,
        WORKSPACE_UNDO_CHANGE_SET_METHOD,
        WORKSPACE_RESTORE_TRASH_ENTRY_METHOD,
        WORKSPACE_LIST_RECOVERY_REVIEW_METHOD,
        WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD,
        WORKSPACE_ABANDON_RESTORE_METHOD,
    }
)

# WO-26 additive optional field on the existing CHAT_SEND_METHOD request:
# ``params.workspace_active_use_seconds`` (snake_case, non-negative integer).
# Electron owns cumulative active-use accounting (it owns window visibility
# and is the always-on process) and passes the running total for the current
# workspace; the field is OMITTED (never ``0``) whenever Electron does not yet
# know a value. The sidecar never emits a corresponding notification -- this
# is a plain additive request field, so it needs no ALLOWED_NOTIFICATION_METHODS
# entry and no new method constant. See docs/plans/WORKSPACE_MUTATION_JOURNAL.md
# section 7 and sidecar/ai/tools/workspace_retention.py.
CHAT_TOKEN_METHOD = "chat.token"
# Streamed assistant text token. Required payload: ``delta`` and ``role``.
# Optional additive payload: ``sequence`` (monotonic token index) so Electron
# can build renderer-bound replay envelopes without changing notification names.
# Transport-level buffer flush: emitted by the sidecar when a provider or
# tool-loop retry discards accumulated text so the renderer can start fresh.
# This is a physical transport concern and must NOT be reused for phase
# signalling. ``tool_continuation`` is the only conditionally preserving reason;
# ``provider_retry``, ``nudge_retry``, ``reflexive_retry``,
# ``post_tool_restart``, and ``deterministic_replacement`` are discard-only.
# Empty or unknown reasons fail safe as discard-only.
CHAT_STREAM_RESET_METHOD = "chat.stream_reset"
# Streamed thinking notification.  Required payload: ``delta``, ``thinking_id``,
# ``kind`` (``reasoning`` or ``status``), ``persist`` (bool).  Optional payload:
# ``tokens_per_second`` (float, present only when the underlying engine reports
# generation timing for the chunk; the renderer treats it as best-effort meta).
CHAT_THINKING_METHOD = "chat.thinking"
# Semantic phase-boundary events: signal reasoning/text/tool_use/tool_result/
# approval_wait transitions.  Orthogonal to CHAT_STREAM_RESET_METHOD — the
# renderer handles them independently.  Gated by FEATURE_PHASE_EVENTS.
# Required payload: ``phase_id``, ``phase_kind``, ``iteration`` (int).  Optional:
# ``thinking_id``, ``tool_call_id``, ``tool_name``, ``summary`` (free-form
# short reason text synthesized from the phase context; consumers treat it as
# advisory and optional).
CHAT_PHASE_STARTED_METHOD = "chat.phase_started"
CHAT_PHASE_COMPLETED_METHOD = "chat.phase_completed"
# Additive canonical turn-event notification. During migration this is emitted
# alongside the legacy chat/tool notifications and reduced by Electron only
# when FEATURE_CANONICAL_TURN_EVENTS is enabled.
TURN_EVENT_METHOD = "turn.event"
CHAT_THINKING_KIND_STATUS = "status"
CHAT_THINKING_KIND_REASONING = "reasoning"
CHAT_QUESTION_BATCH_METHOD = "chat.question_batch"
# Additive optional plan-usage hint: ``chat.done.params.usage.plan_usage`` and
# ``chat.error.params.plan_usage`` (sidecar/runtime/plan_usage_snapshot.py).
# Key omitted entirely when there is no ChatGPT plan-usage snapshot for the
# request or the ``chatgpt_plan_meter`` feature flag is off -- older/newer
# sidecars and consumers that do not know this key are unaffected. Not a new
# notification method; no ALLOWED_NOTIFICATION_METHODS change.
# ``chat.done.params.resumable_stop`` is an additive optional scalar naming a
# resumable budget stop: ``tool_cap``, ``diminishing_returns``,
# ``context_budget``, or ``max_iterations``. The key is omitted when absent;
# this is not a new notification method and needs no allowlist change.
CHAT_DONE_METHOD = "chat.done"
CHAT_ERROR_METHOD = "chat.error"
TOOL_EXECUTING_METHOD = "tool.executing"
# Live stdout/stderr tail for an in-flight run_command (W2-1). EPHEMERAL:
# batches are never journaled and never enter the canonical turn record — the
# final tool.result output stays the persisted snapshot. Payload: standard
# chat ctx + ``tool_call_id``, ``tool_name``, ``sequence`` (int, per-call),
# ``lines`` ([{stream: stdout|stderr, text}]), ``emitted_lines``,
# ``dropped_lines``, ``elapsed_ms``.
TOOL_OUTPUT_CHUNK_METHOD = "tool.output_chunk"
TOOL_RESULT_METHOD = "tool.result"
TOOL_REQUEST_APPROVAL_METHOD = "tool.request_approval"
TOOL_EXECUTE_ELECTRON_METHOD = "tool.execute_electron"
MONITOR_EVENT_METHOD = "monitor.event"
AGENT_PROGRESS_METHOD = "agent.progress"
BUDGET_UPDATE_METHOD = "budget.update"
CONTEXT_COMPACTED_METHOD = "context.compacted"
# Mid-turn context-usage snapshot for the composer context ring. EPHEMERAL:
# snapshots are never journaled and never enter the canonical turn record —
# ``chat.done``'s usage block stays the terminal truth. Payload: standard chat
# ctx + ``phase`` (preflight|iteration), ``iteration``, ``context_used_tokens``,
# ``context_used_source`` (provider|estimate), ``context_tokens_estimate``,
# ``last_request_input_tokens``, ``context_window``,
# ``compact_threshold_tokens``, ``model``, ``provider``.
CONTEXT_USAGE_METHOD = "context.usage"
RUNTIME_GAP_CANDIDATE_METHOD = "runtime.gap_candidate"
RUNTIME_PROGRESS_METHOD = "runtime.progress"
# Plugin-runtime notification vocabulary is pinned by check_protocol_contract.py.
# runtime_applied is emitted after plugin-runtime initialization; operation_progress
# and operation_result remain reserved and currently unemitted.
PLUGIN_OPERATION_PROGRESS_METHOD = "plugin.operation_progress"
PLUGIN_OPERATION_RESULT_METHOD = "plugin.operation_result"
PLUGIN_RUNTIME_APPLIED_METHOD = "plugin.runtime_applied"

# Canonical set of notification method names the sidecar is permitted to emit.
# Any new notification method MUST be added here so `rpc.notification()` can
# fail fast on drift. Request/response methods (initialize, chat.send, etc.)
# are intentionally excluded — only fire-and-forget notification channels live
# in this set.
ALLOWED_NOTIFICATION_METHODS: frozenset[str] = frozenset(
    {
        CHAT_TOKEN_METHOD,
        CHAT_STREAM_RESET_METHOD,
        CHAT_THINKING_METHOD,
        CHAT_PHASE_STARTED_METHOD,
        CHAT_PHASE_COMPLETED_METHOD,
        TURN_EVENT_METHOD,
        CHAT_QUESTION_BATCH_METHOD,
        CHAT_DONE_METHOD,
        CHAT_ERROR_METHOD,
        TOOL_EXECUTING_METHOD,
        TOOL_OUTPUT_CHUNK_METHOD,
        TOOL_RESULT_METHOD,
        TOOL_REQUEST_APPROVAL_METHOD,
        MONITOR_EVENT_METHOD,
        AGENT_PROGRESS_METHOD,
        BUDGET_UPDATE_METHOD,
        CONTEXT_COMPACTED_METHOD,
        CONTEXT_USAGE_METHOD,
        RUNTIME_GAP_CANDIDATE_METHOD,
        RUNTIME_PROGRESS_METHOD,
        PLUGIN_OPERATION_PROGRESS_METHOD,
        PLUGIN_OPERATION_RESULT_METHOD,
        PLUGIN_RUNTIME_APPLIED_METHOD,
    }
)
