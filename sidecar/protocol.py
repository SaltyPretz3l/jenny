"""Protocol constants for JSON-RPC communication between Electron and sidecar."""

from __future__ import annotations

JSONRPC_VERSION = "2.0"
CONTENT_LENGTH_HEADER = "Content-Length"

# Version handshake between Electron and sidecar.
# Jenny currently ships the Electron shell and sidecar in lockstep, so wire
# changes can bump one shared API version without extra capability negotiation.
# Upgrade policy: see docs/operations/versioning-and-migration.md.
# The paired client constant lives at services/backend/sidecar-client.js.
API_VERSION = "2026-10-15"

INITIALIZE_METHOD = "initialize"
# Initialize `mode` discriminator value (sidecar/runtime/initialize_mode.py owns
# the behavioral guard). Duplicated here as a plain literal rather than imported
# so this module keeps its zero-intra-package-import posture -- keep
# byte-identical to sidecar.runtime.initialize_mode.FULL_RUNTIME_MODE.
INITIALIZE_MODE_FULL_RUNTIME = "full_runtime"
SHUTDOWN_METHOD = "shutdown"
BACKGROUND_RUN_METHOD = "background.run"
# Optional subagent_routing: host-normalized provider preferences, captured on
# ChatRequestContext for this turn. It changes neither engine nor tool authority.
CHAT_SEND_METHOD = "chat.send"
CHAT_CANCEL_METHOD = "chat.cancel"
# Exact-command Run adapter (row 59 checkpoint 3): a chat-shaped turn that runs ONE
# already-proposed run_command call through the ordinary policy/approval/admission/
# execution owners with no model. Cancelled by the existing chat.cancel (request_id).
# Capability: initialize result ``command_proposal_version`` (1). Desktop only: it is
# deliberately absent from HOST_ALLOWED_RPC_METHODS.
COMMAND_EXECUTE_PROPOSAL_METHOD = "command.execute_proposal"
# Inbound shell->sidecar NOTIFICATION (no id, no response): the shell observed
# the managed local engine producing work (decode/prompt-eval/load telemetry on
# its captured stderr). Stamps the engine-liveness clock consulted by the
# stream-inactivity watchdog so a silently-busy engine (e.g. Ollama buffering a
# huge tool call) is not mistaken for a hung one. Routed by the multiplexer.
ENGINE_ACTIVITY_METHOD = "engine.activity"
SESSION_RUN_MODE_UPDATED_METHOD = "session.run_mode_updated"
# Manual context-compaction trigger. Request/response sibling of chat.send /
# chat.cancel -- NOT a notification, so it is intentionally absent from
# ALLOWED_NOTIFICATION_METHODS. Success re-emits the existing
# CONTEXT_COMPACTED_METHOD notification; no new notification channel exists.
CHAT_COMPACT_METHOD = "chat.compact"
CONTEXT_PREVIEW_METHOD = "context.preview"
MODELS_LIST_METHOD = "models.list"
MODELS_UNLOAD_METHOD = "models.unload"
# Returns the models currently resident in the app-managed Ollama daemon
# (`/api/ps`) enriched with measured footprint (size, size_vram, digest,
# parameter_size, quantization_level) for the model-fit "record on first
# load" self-catalog feature. See sidecar/runtime/request_dispatch.py.
MODELS_RESIDENT_METHOD = "models.resident"
MODELS_OLLAMA_BLOB_METHOD = "models.ollama_blob"
MEMORY_SAVE_METHOD = "memory.save"
MEMORY_LIST_METHOD = "memory.list"
MEMORY_PENDING_LIST_METHOD = "memory.pending.list"
MEMORY_PENDING_DELETE_METHOD = "memory.pending.delete"
MEMORY_PENDING_ACCEPT_METHOD = "memory.pending.accept"
MEMORY_UPDATE_METHOD = "memory.update"
MEMORY_DELETE_METHOD = "memory.delete"
MEMORY_RECALL_METHOD = "memory.recall"
MEMORY_STATUS_METHOD = "memory.status"
# Memory v2 (schema v9) user actions from Electron; never exposed as tools.
# Undo/restore act on the operations ledger; archive_project is the desktop
# project delete; purge_session is a chat delete; clear_suppressions empties
# the forgotten list ("Clear forgotten list").
MEMORY_UNDO_METHOD = "memory.undo"
MEMORY_RESTORE_METHOD = "memory.restore"
MEMORY_ARCHIVE_PROJECT_METHOD = "memory.archive_project"
MEMORY_PURGE_SESSION_METHOD = "memory.purge_session"
MEMORY_EXPORT_SESSION_METHOD = "memory.export_session"
MEMORY_IMPORT_SESSION_METHOD = "memory.import_session"
MEMORY_CHAT_SESSIONS_METHOD = "memory.chat_sessions"
MEMORY_CLEAR_SUPPRESSIONS_METHOD = "memory.clear_suppressions"
# Memory v2 reflection ("Jenny takes notes", row 58 W2). reflection_state,
# policy_epoch and apply run inline; reflect is a preemptible auxiliary
# inference (family `inference`) that carries inference_context and writes
# nothing. Electron re-checks consent before it calls apply.
MEMORY_REFLECTION_STATE_METHOD = "memory.reflection_state"
MEMORY_POLICY_EPOCH_METHOD = "memory.policy_epoch"
MEMORY_REFLECT_METHOD = "memory.reflect"
MEMORY_APPLY_METHOD = "memory.apply"
# Memory v2 W4: erase (hard delete of one row, inline), operations (the
# content-free undo ledger, inline) and embed_step (Electron pumps it while the
# chat model is idle and hybrid recall is on; family `memory_index`).
MEMORY_ERASE_METHOD = "memory.erase"
MEMORY_OPERATIONS_METHOD = "memory.operations"
MEMORY_EMBED_STEP_METHOD = "memory.embed_step"
# Semantic catalog (row 41): Electron pumps index_step while the chat model is
# idle; search/status/purge serve the knowledge tools and Settings. Desktop only.
CATALOG_INDEX_STEP_METHOD = "catalog.index_step"
CATALOG_SEARCH_METHOD = "catalog.search"
CATALOG_STATUS_METHOD = "catalog.status"
CATALOG_PURGE_METHOD = "catalog.purge"
# Conversation index (row 58 W4): Electron pushes chat text into the derived
# conversation-index.db and searches it for conversations_search. Desktop only.
CONVERSATIONS_INDEX_STATE_METHOD = "conversations.index_state"
CONVERSATIONS_INDEX_SESSION_METHOD = "conversations.index_session"
CONVERSATIONS_PURGE_METHOD = "conversations.purge"
CONVERSATIONS_SEARCH_METHOD = "conversations.search"
CONVERSATIONS_EMBED_STEP_METHOD = "conversations.embed_step"
SUGGESTIONS_GENERATE_METHOD = "suggestions.generate"
COMMIT_GENERATE_MESSAGE_METHOD = "commit.generate_message"
HARDWARE_PROFILE_METHOD = "hardware.profile"
HARDWARE_VRAM_USAGE_METHOD = "hardware.vram_usage"
HARNESS_INSPECT_METHOD = "harness.inspect"
HARNESS_TURN_DIAGNOSTIC_METHOD = "harness.turn_diagnostic"
MCP_INSPECT_METHOD = "mcp.inspect"
MCP_PROMPT_GET_METHOD = "mcp.prompt_get"
WORKSPACE_LIST_CHANGE_SETS_METHOD = "workspace.list_change_sets"
WORKSPACE_PREFLIGHT_UNDO_METHOD = "workspace.preflight_undo"
WORKSPACE_UNDO_CHANGE_SET_METHOD = "workspace.undo_change_set"
# Re-arms an undone change set after the Changes view Redo put its bytes back.
WORKSPACE_REAPPLY_CHANGE_SET_METHOD = "workspace.reapply_change_set"
WORKSPACE_RESTORE_TRASH_ENTRY_METHOD = "workspace.restore_trash_entry"
# WO-26: user-initiated wall-clock-review surfacing for change sets that have
# aged past the 365-day wall cap without evicting anything -- listing never
# mutates; acknowledging durably records `retention.wall_clock_review_presented_at`
# so a LATER maintenance pass may age-evict that set. Neither is a notification.
WORKSPACE_LIST_RECOVERY_REVIEW_METHOD = "workspace.list_recovery_review"
WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD = "workspace.acknowledge_recovery_review"
WORKSPACE_ABANDON_RESTORE_METHOD = "workspace.abandon_restore"
# Private runtime owner cleanup; never exposed as a tool or renderer operation.
WORKSPACE_RECONCILE_RUNTIME_PREPARATIONS_METHOD = "workspace.reconcile_runtime_preparations"
WORKSPACE_CONFIRM_RUNTIME_CHECKPOINT_METHOD = "workspace.confirm_runtime_checkpoint"
WORKSPACE_RELEASE_RUNTIME_CHECKPOINT_METHOD = "workspace.release_runtime_checkpoint"
# Plan Plus C4: Electron-consented apply of suggested changes with explicit root
# authority; one call is one journal change set. Desktop only (not hosted).
WORKSPACE_APPLY_SUGGESTED_CHANGES_METHOD = "workspace.apply_suggested_changes"
# Private one-operation peer used only by the desktop Workspace Test Runner.
WORKSPACE_TEST_RUN_METHOD = "workspace_test.run"
WORKSPACE_TEST_CANCEL_METHOD = "workspace_test.cancel"
WORKSPACE_TEST_CLEANUP_METHOD = "workspace_test.cleanup"
WORKSPACE_TEST_CLOSE_METHOD = "workspace_test.close"

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
        COMMAND_EXECUTE_PROPOSAL_METHOD,
        CHAT_COMPACT_METHOD,
        CONTEXT_PREVIEW_METHOD,
        MODELS_LIST_METHOD,
        MODELS_UNLOAD_METHOD,
        MODELS_RESIDENT_METHOD,
        MODELS_OLLAMA_BLOB_METHOD,
        MEMORY_SAVE_METHOD,
        MEMORY_LIST_METHOD,
        MEMORY_PENDING_LIST_METHOD,
        MEMORY_PENDING_DELETE_METHOD,
        MEMORY_PENDING_ACCEPT_METHOD,
        MEMORY_UPDATE_METHOD,
        MEMORY_DELETE_METHOD,
        MEMORY_RECALL_METHOD,
        MEMORY_STATUS_METHOD,
        MEMORY_UNDO_METHOD,
        MEMORY_RESTORE_METHOD,
        MEMORY_ARCHIVE_PROJECT_METHOD,
        MEMORY_PURGE_SESSION_METHOD,
        MEMORY_EXPORT_SESSION_METHOD,
        MEMORY_IMPORT_SESSION_METHOD,
        MEMORY_CHAT_SESSIONS_METHOD,
        MEMORY_CLEAR_SUPPRESSIONS_METHOD,
        MEMORY_REFLECTION_STATE_METHOD,
        MEMORY_POLICY_EPOCH_METHOD,
        MEMORY_REFLECT_METHOD,
        MEMORY_APPLY_METHOD,
        MEMORY_ERASE_METHOD,
        MEMORY_OPERATIONS_METHOD,
        MEMORY_EMBED_STEP_METHOD,
        CATALOG_INDEX_STEP_METHOD,
        CATALOG_SEARCH_METHOD,
        CATALOG_STATUS_METHOD,
        CATALOG_PURGE_METHOD,
        CONVERSATIONS_INDEX_STATE_METHOD,
        CONVERSATIONS_INDEX_SESSION_METHOD,
        CONVERSATIONS_PURGE_METHOD,
        CONVERSATIONS_SEARCH_METHOD,
        CONVERSATIONS_EMBED_STEP_METHOD,
        SUGGESTIONS_GENERATE_METHOD,
        COMMIT_GENERATE_MESSAGE_METHOD,
        HARDWARE_PROFILE_METHOD,
        HARDWARE_VRAM_USAGE_METHOD,
        HARNESS_INSPECT_METHOD,
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        MCP_INSPECT_METHOD,
        MCP_PROMPT_GET_METHOD,
        WORKSPACE_LIST_CHANGE_SETS_METHOD,
        WORKSPACE_PREFLIGHT_UNDO_METHOD,
        WORKSPACE_UNDO_CHANGE_SET_METHOD,
        WORKSPACE_REAPPLY_CHANGE_SET_METHOD,
        WORKSPACE_RESTORE_TRASH_ENTRY_METHOD,
        WORKSPACE_LIST_RECOVERY_REVIEW_METHOD,
        WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD,
        WORKSPACE_ABANDON_RESTORE_METHOD,
        WORKSPACE_CONFIRM_RUNTIME_CHECKPOINT_METHOD,
        WORKSPACE_RELEASE_RUNTIME_CHECKPOINT_METHOD,
        WORKSPACE_RECONCILE_RUNTIME_PREPARATIONS_METHOD,
        WORKSPACE_APPLY_SUGGESTED_CHANGES_METHOD,
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
# Owner decision D3 additive optional fields on the same CHAT_SEND_METHOD
# request, following the WO-26 precedent (no new method, no notification):
# ``params.safety_mode`` (``"normal"|"strict"|"paranoid"``) and
# ``params.auto_approve_streak_cap`` (non-negative integer, clamped to 500).
# Electron fills both from the live chatUi state at send time and OMITS them
# (never ``null``) when that state is unavailable. The sidecar validates them
# per request; a missing or invalid value falls back to the initialized
# RuntimeConfig value and never fails the turn. See
# sidecar/ai/routing/route_policy_runtime.py (``with_request_safety``).
# Row 59 cp6 additive chat.send field, following WO-26 / D3:
# params.inference_performance = {live: bool, provider_kind:
# "ninfer"|"llama-server"|"ollama"|"other"}. Closed object; invalid fields
# (including unknown keys) are ignored, never a turn failure. Only live=True
# with provider_kind="ninfer" requests timings_per_token / return_progress.
# Desktop advertises inference_performance_version: 1; hosted strips it.
# Terminal capture is always on; notifications are ephemeral, outside history.
INFERENCE_PERFORMANCE_METHOD = "inference.performance"
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
# approval_wait transitions.  Orthogonal to CHAT_STREAM_RESET_METHOD -- the
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
# request -- older/newer sidecars and consumers that do not know this key are
# unaffected. The same
# snapshot also travels mid-turn on CHAT_PLAN_USAGE_METHOD below.
# ``chat.done.params.resumable_stop`` is an additive optional scalar naming a
# resumable budget stop: ``tool_cap``, ``diminishing_returns``,
# ``context_budget``, or ``max_iterations``. The key is omitted when absent;
# this is not a new notification method and needs no allowlist change.
# ``chat.done.params.completion_reason`` + ``proposal_id`` are an additive optional
# pair (both or neither) naming an end-of-turn session-proposal boundary:
# ``awaiting_proposal`` (a propose_session offer) or ``session_handoff_completed``
# (a complete_session_handoff). The turn may carry no visible text; not a Resume stop.
CHAT_DONE_METHOD = "chat.done"
CHAT_ERROR_METHOD = "chat.error"
# Scrubbed account-usage snapshot per provider response; never a canonical event.
CHAT_PLAN_USAGE_METHOD = "chat.plan_usage"
TOOL_EXECUTING_METHOD = "tool.executing"
# Live stdout/stderr tail for an in-flight run_command (W2-1). EPHEMERAL:
# batches are never journaled and never enter the canonical turn record -- the
# final tool.result output stays the persisted snapshot. Payload: standard
# chat ctx + ``tool_call_id``, ``tool_name``, ``sequence`` (int, per-call),
# ``lines`` ([{stream: stdout|stderr, text}]), ``emitted_lines``,
# ``dropped_lines``, ``elapsed_ms``.
TOOL_OUTPUT_CHUNK_METHOD = "tool.output_chunk"
TOOL_RESULT_METHOD = "tool.result"
TOOL_REQUEST_APPROVAL_METHOD = "tool.request_approval"
TOOL_EXECUTE_ELECTRON_METHOD = "tool.execute_electron"
# Internal sidecar -> application request used for a live per-operation
# authority check. It is never advertised as a model tool or notification.
RUNTIME_OPERATION_METHOD = "runtime.operation"
MONITOR_EVENT_METHOD = "monitor.event"
# delegate child frames additionally carry reasoning_effort and child_activity:
# cumulative sequence, <=40 sanitized steps, <=4000 visible-text characters,
# counts/truncation flags and an optional current-response visible-token estimate.
# Advisory/ephemeral only; terminal report metadata remains reload authority.
AGENT_PROGRESS_METHOD = "agent.progress"
BUDGET_UPDATE_METHOD = "budget.update"
# Ephemeral compaction-start notification; never enters the canonical turn record.
# Payload: standard chat ctx + ``phase``, ``tokens_before``, ``message_count``.
CONTEXT_COMPACTION_STARTED_METHOD = "context.compaction_started"
CONTEXT_COMPACTED_METHOD = "context.compacted"
HEURISTIC_FIRE_METHOD = "heuristic.fire"
# Mid-turn context-usage snapshot for the composer context ring. EPHEMERAL:
# snapshots are never journaled and never enter the canonical turn record --
# ``chat.done``'s usage block stays the terminal truth. Payload: standard chat
# ctx + ``phase`` (preflight|iteration), ``iteration``, ``context_used_tokens``,
# ``context_used_source`` (provider|estimate), ``context_tokens_estimate``,
# ``last_request_input_tokens``, ``context_window``,
# ``compact_threshold_tokens``, ``model``, ``provider``.
CONTEXT_USAGE_METHOD = "context.usage"
RUNTIME_GAP_CANDIDATE_METHOD = "runtime.gap_candidate"
RUNTIME_PROGRESS_METHOD = "runtime.progress"
RUNTIME_LOAD_FAILURE_METHOD = "runtime.load_failure"

# Canonical set of notification method names the sidecar is permitted to emit.
# Any new notification method MUST be added here so `rpc.notification()` can
# fail fast on drift. Request/response methods (initialize, chat.send, etc.)
# are intentionally excluded -- only fire-and-forget notification channels live
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
        CONTEXT_COMPACTION_STARTED_METHOD,
        CONTEXT_COMPACTED_METHOD,
        HEURISTIC_FIRE_METHOD,
        CONTEXT_USAGE_METHOD,
        INFERENCE_PERFORMANCE_METHOD,
        CHAT_PLAN_USAGE_METHOD,
        RUNTIME_GAP_CANDIDATE_METHOD,
        RUNTIME_PROGRESS_METHOD,
        RUNTIME_LOAD_FAILURE_METHOD,
    }
)
