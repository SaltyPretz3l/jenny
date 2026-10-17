"""Tests for sidecar.protocol — protocol constant validation."""

from __future__ import annotations

from sidecar import protocol


def test_jsonrpc_version_is_2_0() -> None:
    assert protocol.JSONRPC_VERSION == "2.0"


def test_content_length_header_is_standard() -> None:
    assert protocol.CONTENT_LENGTH_HEADER == "Content-Length"


def test_api_version_is_date_formatted() -> None:
    version = protocol.API_VERSION
    assert isinstance(version, str)
    parts = version.split("-")
    assert len(parts) == 3, f"API_VERSION should be YYYY-MM-DD, got {version}"
    assert len(parts[0]) == 4  # year
    assert len(parts[1]) == 2  # month
    assert len(parts[2]) == 2  # day


def test_lifecycle_methods_are_strings() -> None:
    assert isinstance(protocol.INITIALIZE_METHOD, str)
    assert isinstance(protocol.SHUTDOWN_METHOD, str)
    assert isinstance(protocol.CHAT_SEND_METHOD, str)
    assert isinstance(protocol.CHAT_CANCEL_METHOD, str)


def test_streaming_notification_methods_exist() -> None:
    assert protocol.INFERENCE_PERFORMANCE_METHOD == "inference.performance"
    assert protocol.INFERENCE_PERFORMANCE_METHOD in protocol.ALLOWED_NOTIFICATION_METHODS
    from sidecar.ai.routing.loop_events import InferencePerformanceEvent

    # The self-serializing meter event names the protocol constant exactly.
    assert InferencePerformanceEvent.method == protocol.INFERENCE_PERFORMANCE_METHOD
    assert protocol.RUNTIME_PROGRESS_METHOD == "runtime.progress"
    assert protocol.CHAT_TOKEN_METHOD == "chat.token"
    assert protocol.CHAT_THINKING_METHOD == "chat.thinking"
    assert protocol.CHAT_PHASE_STARTED_METHOD == "chat.phase_started"
    assert protocol.CHAT_PHASE_COMPLETED_METHOD == "chat.phase_completed"
    assert protocol.TURN_EVENT_METHOD == "turn.event"
    assert protocol.TOOL_EXECUTING_METHOD == "tool.executing"
    assert protocol.TOOL_RESULT_METHOD == "tool.result"
    assert protocol.CHAT_DONE_METHOD == "chat.done"
    assert protocol.CHAT_ERROR_METHOD == "chat.error"


def test_blocking_approval_method_exists() -> None:
    assert protocol.TOOL_REQUEST_APPROVAL_METHOD == "tool.request_approval"


def test_retired_active_turn_state_method_is_not_versioned() -> None:
    assert "chat.get_active_turn_state" not in protocol.INBOUND_VERSIONED_REQUEST_METHODS


def test_mcp_methods_are_versioned() -> None:
    assert protocol.MCP_INSPECT_METHOD == "mcp.inspect"
    assert protocol.MCP_PROMPT_GET_METHOD == "mcp.prompt_get"
    assert {protocol.MCP_INSPECT_METHOD, protocol.MCP_PROMPT_GET_METHOD} <= protocol.INBOUND_VERSIONED_REQUEST_METHODS


def test_api_version_is_the_memory_v2_bump() -> None:
    # Memory v2 (row 58 W1 S3a) removed and added memory.* methods.
    assert protocol.API_VERSION == "2026-10-15"


def test_memory_methods_roster() -> None:
    memory_methods = {
        method for method in protocol.INBOUND_VERSIONED_REQUEST_METHODS
        if method.startswith("memory.")
    }
    assert memory_methods == {
        "memory.save",
        "memory.list",
        "memory.pending.list",
        "memory.pending.delete",
        "memory.pending.accept",
        "memory.update",
        "memory.delete",
        "memory.recall",
        "memory.status",
        "memory.undo",
        "memory.restore",
        "memory.archive_project",
        "memory.purge_session",
        "memory.export_session",
        "memory.import_session",
        "memory.chat_sessions",
        "memory.clear_suppressions",
        "memory.erase",
        "memory.operations",
        "memory.embed_step",
        "memory.reflection_state",
        "memory.policy_epoch",
        "memory.reflect",
        "memory.apply",
    }
    assert protocol.MEMORY_UNDO_METHOD == "memory.undo"
    assert protocol.MEMORY_RESTORE_METHOD == "memory.restore"
    assert protocol.MEMORY_ARCHIVE_PROJECT_METHOD == "memory.archive_project"
    assert protocol.MEMORY_PURGE_SESSION_METHOD == "memory.purge_session"
    assert protocol.MEMORY_CLEAR_SUPPRESSIONS_METHOD == "memory.clear_suppressions"
    assert protocol.MEMORY_REFLECTION_STATE_METHOD == "memory.reflection_state"
    assert protocol.MEMORY_POLICY_EPOCH_METHOD == "memory.policy_epoch"
    assert protocol.MEMORY_REFLECT_METHOD == "memory.reflect"
    assert protocol.MEMORY_APPLY_METHOD == "memory.apply"


def test_retired_memory_methods_are_gone() -> None:
    for name in (
        "MEMORY_SUGGEST_METHOD",
        "MEMORY_RECALL_RECENT_METHOD",
        "MEMORY_MOVE_PROJECT_METHOD",
    ):
        assert not hasattr(protocol, name)


def test_hardware_methods_exist() -> None:
    assert protocol.HARDWARE_PROFILE_METHOD == "hardware.profile"
    assert protocol.HARDWARE_VRAM_USAGE_METHOD == "hardware.vram_usage"


def test_thinking_kinds_are_strings() -> None:
    assert protocol.CHAT_THINKING_KIND_STATUS == "status"
    assert protocol.CHAT_THINKING_KIND_REASONING == "reasoning"


def test_dot_namespaced_methods_use_dots() -> None:
    """Methods that represent subsystem operations should be dot-namespaced."""
    method_names = [
        protocol.RUNTIME_PROGRESS_METHOD,
        protocol.CHAT_SEND_METHOD,
        protocol.MODELS_LIST_METHOD,
        protocol.CHAT_TOKEN_METHOD,
        protocol.CHAT_DONE_METHOD,
        protocol.CHAT_ERROR_METHOD,
        protocol.CHAT_PHASE_STARTED_METHOD,
        protocol.CHAT_PHASE_COMPLETED_METHOD,
        protocol.TURN_EVENT_METHOD,
        protocol.TOOL_EXECUTING_METHOD,
        protocol.TOOL_RESULT_METHOD,
        protocol.TOOL_REQUEST_APPROVAL_METHOD,
        protocol.MEMORY_SAVE_METHOD,
        protocol.MEMORY_LIST_METHOD,
        protocol.MEMORY_UPDATE_METHOD,
        protocol.MEMORY_DELETE_METHOD,
        protocol.MEMORY_RECALL_METHOD,
        protocol.MEMORY_STATUS_METHOD,
        protocol.MEMORY_UNDO_METHOD,
        protocol.MEMORY_RESTORE_METHOD,
        protocol.MEMORY_ARCHIVE_PROJECT_METHOD,
        protocol.MEMORY_PURGE_SESSION_METHOD,
        protocol.MEMORY_CLEAR_SUPPRESSIONS_METHOD,
        protocol.HARDWARE_PROFILE_METHOD,
        protocol.HARDWARE_VRAM_USAGE_METHOD,
    ]
    for method in method_names:
        assert "." in method, f"method {method} should be dot-namespaced"


def test_lifecycle_methods_are_plain_names() -> None:
    """initialize and shutdown are top-level lifecycle methods without dots."""
    assert protocol.INITIALIZE_METHOD == "initialize"
    assert protocol.SHUTDOWN_METHOD == "shutdown"


def test_command_execute_proposal_method_is_pinned_and_versioned() -> None:
    assert protocol.COMMAND_EXECUTE_PROPOSAL_METHOD == "command.execute_proposal"
    assert protocol.COMMAND_EXECUTE_PROPOSAL_METHOD in protocol.INBOUND_VERSIONED_REQUEST_METHODS


def test_command_proposal_has_no_dedicated_cancel_method() -> None:
    """DB2: cancel reuses chat.cancel by request_id; no command.* cancel exists."""
    assert not any(
        name.startswith("COMMAND_") and "CANCEL" in name for name in dir(protocol)
    )
    assert protocol.CHAT_CANCEL_METHOD == "chat.cancel"
