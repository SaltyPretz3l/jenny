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


def test_memory_methods_exist() -> None:
    assert protocol.MEMORY_SUGGEST_METHOD == "memory.suggest"
    assert protocol.MEMORY_SAVE_METHOD == "memory.save"
    assert protocol.MEMORY_LIST_METHOD == "memory.list"
    assert protocol.MEMORY_UPDATE_METHOD == "memory.update"
    assert protocol.MEMORY_DELETE_METHOD == "memory.delete"
    assert protocol.MEMORY_RECALL_METHOD == "memory.recall"
    assert protocol.MEMORY_RECALL_RECENT_METHOD == "memory.recall_recent"
    assert protocol.MEMORY_STATUS_METHOD == "memory.status"


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
        protocol.MEMORY_SUGGEST_METHOD,
        protocol.MEMORY_SAVE_METHOD,
        protocol.MEMORY_LIST_METHOD,
        protocol.MEMORY_UPDATE_METHOD,
        protocol.MEMORY_DELETE_METHOD,
        protocol.MEMORY_RECALL_METHOD,
        protocol.MEMORY_RECALL_RECENT_METHOD,
        protocol.MEMORY_STATUS_METHOD,
        protocol.HARDWARE_PROFILE_METHOD,
        protocol.HARDWARE_VRAM_USAGE_METHOD,
    ]
    for method in method_names:
        assert "." in method, f"method {method} should be dot-namespaced"


def test_lifecycle_methods_are_plain_names() -> None:
    """initialize and shutdown are top-level lifecycle methods without dots."""
    assert protocol.INITIALIZE_METHOD == "initialize"
    assert protocol.SHUTDOWN_METHOD == "shutdown"
