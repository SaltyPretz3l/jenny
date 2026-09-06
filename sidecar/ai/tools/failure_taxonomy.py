"""Closed failure taxonomy for sidecar error codes."""

from __future__ import annotations

from collections.abc import Mapping

from sidecar.ai import error_codes

FAILURE_CLASSES: tuple[str, ...] = (
    "bad_arguments",
    "precondition_unmet",
    "not_found",
    "conflict",
    "denied",
    "cancelled",
    "unavailable",
    "limit_exceeded",
    "transient",
    "internal_error",
)

RETRY_DISPOSITIONS: Mapping[str, str] = {
    "bad_arguments": "changed_args",
    "precondition_unmet": "after_fix",
    "not_found": "changed_args",
    "conflict": "after_fix",
    "denied": "never",
    "cancelled": "not_yet",
    "unavailable": "never",
    "limit_exceeded": "changed_args",
    "transient": "same_args",
    "internal_error": "never",
}

RECOVERY_CLASS_PROJECTION: Mapping[str, str] = {
    "bad_arguments": "tool",
    "precondition_unmet": "tool",
    "not_found": "tool",
    "conflict": "tool",
    "denied": "denied",
    "cancelled": "cancelled",
    "unavailable": "tool",
    "limit_exceeded": "tool",
    "transient": "tool",
    "internal_error": "tool",
}

TAXONOMY: Mapping[str, str] = {
    # Malformed inputs and validation failures.
    error_codes.CMP_TOOL_INVALID_PATH: "bad_arguments",
    error_codes.CMP_TOOL_COERCED_ARGS_REJECTED: "bad_arguments",
    error_codes.CMP_TOOL_TODO_INVALID: "bad_arguments",
    error_codes.CMP_TOOL_MERMAID_VALIDATION: "bad_arguments",
    error_codes.CMP_TOOL_MERMAID_UNSUPPORTED_TYPE: "bad_arguments",
    error_codes.CMP_TOOL_MERMAID_FORMAT: "bad_arguments",
    error_codes.CMP_TOOL_APPLY_PATCH_PARSE_FAILED: "bad_arguments",
    error_codes.CMP_TOOL_SUBAGENT_INVALID_PROMPT: "bad_arguments",
    error_codes.CMP_TOOL_SUBAGENT_INVALID_GRANTS: "bad_arguments",
    error_codes.CMP_TOOL_RICH_FILES_MIME_MISMATCH: "bad_arguments",
    error_codes.CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED: "bad_arguments",
    error_codes.CMP_MEMORY_INVALID_KIND: "bad_arguments",
    error_codes.CMP_MCP_CONFIG_INVALID: "bad_arguments",
    error_codes.CMP_CTX_SKILL_INVALID: "bad_arguments",
    error_codes.CMP_LOOP_INVALID_TOOL_CALL: "bad_arguments",
    error_codes.CMP_LOOP_TOOL_INPUT_VALIDATION: "bad_arguments",
    error_codes.CMP_CHAT_INVALID_PARAMS: "bad_arguments",
    error_codes.CMP_BACKGROUND_INVALID_PARAMS: "bad_arguments",
    error_codes.CMP_WEB_INVALID_URL: "bad_arguments",
    error_codes.CMP_TSRCH_INVALID_QUERY: "bad_arguments",
    # Required prior state is absent.
    error_codes.CMP_TOOL_READ_SNAPSHOT_REQUIRED: "precondition_unmet",
    error_codes.CMP_TOOL_PRECONDITION_UNMET: "precondition_unmet",
    # Deferred tools tell the model to tool_search first and then retry, so the
    # honest disposition is after_fix, never "unavailable: never retry".
    error_codes.CMP_TSRCH_DEFERRED_TOOL: "precondition_unmet",
    # Named entities do not exist.
    error_codes.CMP_TOOL_UNKNOWN: "not_found",
    error_codes.CMP_TOOL_BACKGROUND_NOT_FOUND: "not_found",
    error_codes.CMP_TOOL_APPLY_PATCH_TARGET_MISSING: "not_found",
    error_codes.CMP_TOOL_SKILL_NOT_FOUND: "not_found",
    error_codes.CMP_TOOL_WORKTREE_BASELINE_NOT_FOUND: "not_found",
    error_codes.CMP_MEMORY_NOT_FOUND: "not_found",
    error_codes.CMP_MCP_TOOL_NOT_FOUND: "not_found",
    error_codes.CMP_MCP_RESOURCE_NOT_FOUND: "not_found",
    error_codes.CMP_HARNESS_TURN_NOT_FOUND: "not_found",
    # Optimistic-concurrency conflicts.
    error_codes.CMP_TOOL_STALE_READ_SNAPSHOT: "conflict",
    error_codes.CMP_TOOL_APPLY_PATCH_PREIMAGE_MISMATCH: "conflict",
    error_codes.CMP_TOOL_APPLY_PATCH_TARGET_EXISTS: "conflict",
    error_codes.CMP_MEMORY_FINGERPRINT_CONFLICT: "conflict",
    error_codes.CMP_PLUGIN_EPOCH_REGRESSION: "conflict",
    error_codes.CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT: "conflict",
    error_codes.CMP_PROTO_DUPLICATE_REQUEST_ID: "conflict",
    # Policy, approval, mode, and containment refusals.
    error_codes.CMP_TOOL_APPROVAL_DENIED: "denied",
    error_codes.CMP_TOOL_OUTSIDE_WORKSPACE: "denied",
    error_codes.CMP_TOOL_COMMAND_BLOCKED: "denied",
    error_codes.CMP_TOOL_SUBAGENT_DEPTH_LIMIT: "denied",
    error_codes.CMP_TOOL_SUBAGENT_MUTATING_REQUIRES_WORKTREE: "denied",
    error_codes.CMP_TOOL_POLICY_DENIED: "denied",
    error_codes.CMP_MODE_TOOL_BLOCKED: "denied",
    error_codes.CMP_ROUTE_FAIL_CLOSED: "denied",
    error_codes.CMP_APPROVAL_REJECTED: "denied",
    error_codes.CMP_PLUGIN_POLICY_BLOCKED: "denied",
    error_codes.CMP_PLUGIN_ADVISORY_BLOCKED: "denied",
    error_codes.CMP_WEB_SSRF_BLOCKED: "denied",
    error_codes.CMP_WEB_REDIRECT_BLOCKED: "denied",
    # User and stop-policy interruptions.
    error_codes.CMP_TOOL_COMMAND_ABORTED: "cancelled",
    error_codes.CMP_TOOL_APPROVAL_WINDOW_DROPPED: "cancelled",
    error_codes.CMP_LOOP_TOOL_INTERRUPTED: "cancelled",
    error_codes.CMP_PLUGIN_OPERATION_CANCELLED: "cancelled",
    # Capabilities unavailable in the current session.
    error_codes.CMP_TOOL_DISABLED: "unavailable",
    error_codes.CMP_TOOL_PYTHON_NOT_AVAILABLE: "unavailable",
    error_codes.CMP_TOOL_RICH_FILES_UNSUPPORTED: "unavailable",
    error_codes.CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING: "unavailable",
    error_codes.CMP_MCP_SSE_DISABLED: "unavailable",
    error_codes.CMP_CFG_WORKSPACE_MISSING: "unavailable",
    error_codes.CMP_ROUTE_TOOL_DISABLED: "unavailable",
    error_codes.CMP_AI_MODEL_NOT_LOADED: "unavailable",
    error_codes.CMP_AI_UNSUPPORTED_MODAL: "unavailable",
    error_codes.CMP_PLUGIN_SAFE_MODE_ACTIVE: "unavailable",
    error_codes.CMP_PLUGIN_FEATURE_DISABLED: "unavailable",
    error_codes.CMP_PLUGIN_SOURCE_UNAVAILABLE: "unavailable",
    error_codes.CMP_PLUGIN_REMOTE_PROTOCOL_UNSUPPORTED: "unavailable",
    # Auth gaps and unsupported resource kinds need the user, not a retry.
    error_codes.CMP_PLUGIN_REMOTE_AUTH_REQUIRED: "unavailable",
    error_codes.CMP_PLUGIN_REMOTE_AUTH_FAILED: "unavailable",
    error_codes.CMP_MCP_RESOURCE_UNSUPPORTED: "unavailable",
    # Resource, quota, size, timeout, and budget limits.
    error_codes.CMP_TOOL_CAP_EXCEEDED: "limit_exceeded",
    error_codes.CMP_TOOL_TODO_OVERFLOW: "limit_exceeded",
    error_codes.CMP_TOOL_MERMAID_OUTPUT_TOO_LARGE: "limit_exceeded",
    error_codes.CMP_TOOL_SUBAGENT_BUDGET_EXCEEDED: "limit_exceeded",
    error_codes.CMP_TOOL_RICH_FILES_TOO_LARGE: "limit_exceeded",
    error_codes.CMP_MEMORY_CAPACITY_EXCEEDED: "limit_exceeded",
    error_codes.CMP_MEMORY_BACKGROUND_TIMEOUT: "limit_exceeded",
    error_codes.CMP_CTX_BUDGET_EXHAUSTED: "limit_exceeded",
    error_codes.CMP_LOOP_WALL_CLOCK_EXCEEDED: "limit_exceeded",
    error_codes.CMP_LOOP_BUDGET_EXCEEDED: "limit_exceeded",
    error_codes.CMP_AI_RATE_LIMIT: "limit_exceeded",
    error_codes.CMP_PLUGIN_RESOURCE_LIMIT_EXCEEDED: "limit_exceeded",
    error_codes.CMP_RESOURCE_EXCEEDED: "limit_exceeded",
    error_codes.CMP_WEB_RATE_LIMITED: "limit_exceeded",
    error_codes.CMP_WEB_CONTENT_TOO_LARGE: "limit_exceeded",
    error_codes.CMP_CLOUD_RATE_LIMITED: "limit_exceeded",
    # Retryable transport and I/O failures.
    # A busy lease is contention, not a quota: retry unchanged later.
    error_codes.CMP_PLUGIN_LEASE_BUSY: "transient",
    error_codes.CMP_TOOL_IO_FAILED: "transient",
    error_codes.CMP_MCP_SERVER_FAILED: "transient",
    error_codes.CMP_MCP_PROTOCOL_FAILED: "transient",
    error_codes.CMP_LOOP_ENGINE_STALLED: "transient",
    error_codes.CMP_STREAM_INCOMPLETE: "transient",
    error_codes.CMP_AI_ENGINE_CONNECTION: "transient",
    error_codes.CMP_CHAT_STREAM_FAILED: "transient",
    error_codes.CMP_PLUGIN_REMOTE_TRANSPORT_FAILED: "transient",
    error_codes.CMP_PLUGIN_HOST_FAILED: "transient",
    error_codes.CMP_WEB_FETCH_FAILED: "transient",
    error_codes.CMP_CLOUD_NETWORK_ERROR: "transient",
    error_codes.CMP_CLOUD_HTTP_ERROR: "transient",
    # Internal, indeterminate, and server-shape failures.
    error_codes.CMP_TOOL_EXECUTION_FAILED: "internal_error",
    error_codes.CMP_TOOL_PYTHON_EXECUTION_FAILED: "internal_error",
    error_codes.CMP_TOOL_MERMAID_INTERNAL: "internal_error",
    error_codes.CMP_TOOL_APPLY_PATCH_PARTIAL_ROLLBACK: "internal_error",
    error_codes.CMP_MEMORY_FAILED: "internal_error",
    error_codes.CMP_MEMORY_SCHEMA_MIGRATION: "internal_error",
    error_codes.CMP_MEMORY_FAMILY_UNRESOLVED: "internal_error",
    error_codes.CMP_MEMORY_ROW_QUARANTINED: "internal_error",
    error_codes.CMP_MCP_RESOURCE_INVALID: "internal_error",
    error_codes.CMP_MCP_TOOL_SURFACE_CHANGED: "internal_error",
    error_codes.CMP_LOOP_MAX_ITERATIONS: "internal_error",
    error_codes.CMP_LOOP_GENERATION_FAILED: "internal_error",
    error_codes.CMP_LOOP_CYCLE_DETECTED: "internal_error",
    error_codes.CMP_LOOP_REPEATED_ERRORS: "internal_error",
    error_codes.CMP_LOOP_REPEATED_OBSERVATIONS: "internal_error",
    error_codes.CMP_LOOP_STUCK_SUSPECTED: "internal_error",
    error_codes.CMP_STREAM_REASONING_ONLY: "internal_error",
    error_codes.CMP_AI_GENERATION: "internal_error",
    error_codes.CMP_PLUGIN_GENERATION_INVALID: "internal_error",
    error_codes.CMP_PLUGIN_OUTCOME_INDETERMINATE: "internal_error",
    error_codes.CMP_PLUGIN_UPDATE_METADATA_INVALID: "internal_error",
    error_codes.CMP_PLUGIN_ROLLBACK_OR_FREEZE_DETECTED: "internal_error",
    error_codes.CMP_SRV_INITIALIZE_FAILED: "internal_error",
    error_codes.CMP_PROTO_VERSION_MISMATCH: "internal_error",
    error_codes.CMP_PROTO_INVALID_ENVELOPE: "internal_error",
    error_codes.CMP_CACHE_BREAK_DETECTED: "internal_error",
    error_codes.CMP_CLOUD_RESPONSE_PARSE: "internal_error",
}


def classify(
    error_code: str | None,
    *,
    retryable: bool = False,
    error_details: Mapping[str, object] | None = None,
) -> str:
    """Return the closed failure class for an error without raising."""
    try:
        if isinstance(error_details, Mapping):
            override = error_details.get("failure_class")
            if isinstance(override, str) and override in FAILURE_CLASSES:
                return override
        normalized_code = error_code.strip() if isinstance(error_code, str) else ""
        return TAXONOMY.get(
            normalized_code,
            "transient" if retryable else "internal_error",
        )
    except Exception:
        return "transient" if retryable else "internal_error"
