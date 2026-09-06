from __future__ import annotations

import pytest

from sidecar.ai.error_codes import CMP_MCP_SSE_DISABLED, CMP_TOOL_DISABLED
from sidecar.protocol import RUNTIME_GAP_CANDIDATE_METHOD
from sidecar.runtime.chat import ChatRequestError
from sidecar.runtime.outcomes import chat_error_outcome
from sidecar.runtime.runtime_gap import (
    RUNTIME_GAP_FINGERPRINT_VERSION,
    RUNTIME_GAP_SCHEMA_VERSION,
    build_runtime_gap_candidate_notification,
)


def _error(*, code: str, message: str) -> ChatRequestError:
    return ChatRequestError(
        request_id="req-gap-1",
        trace_id="trace-gap-1",
        session_id="session-gap-1",
        code=code,
        message=message,
        rpc_code=-32602,
        retryable=False,
    )


def test_runtime_gap_notification_uses_versioned_schema_and_redacts_paths() -> None:
    notification = build_runtime_gap_candidate_notification(
        _error(
            code=CMP_MCP_SSE_DISABLED,
            message=(
                "mcp server 'docs' requested sse transport but mcp_sse_enabled is false "
                "for C:\\Users\\example\\secret.txt"
            ),
        )
    )

    assert notification is not None
    assert notification["method"] == RUNTIME_GAP_CANDIDATE_METHOD
    payload = notification["params"]
    assert payload["schema_version"] == RUNTIME_GAP_SCHEMA_VERSION
    assert payload["fingerprint_version"] == RUNTIME_GAP_FINGERPRINT_VERSION
    assert payload["source_kind"] == "deterministic"
    assert payload["thread_id"] == "session-gap-1"
    assert payload["turn_id"] == "req-gap-1"
    assert payload["session_id"] == "session-gap-1:req-gap-1"
    assert payload["evidence_issue_safe"]["message"].count("[redacted-path]") == 1
    assert len(payload["semantic_fingerprint"]) == 64


@pytest.mark.parametrize(
    "path",
    [
        '"C:\\Users\\Alice Smith\\private-project\\secret.txt"',
        '"/home/Alice Smith/private-project/secret.txt"',
    ],
    ids=["windows", "unix"],
)
def test_runtime_gap_issue_safe_message_redacts_quoted_paths_with_spaces(path: str) -> None:
    notification = build_runtime_gap_candidate_notification(
        _error(
            code=CMP_MCP_SSE_DISABLED,
            message=f"mcp transport failed for {path}",
        )
    )

    assert notification is not None
    safe_message = notification["params"]["evidence_issue_safe"]["message"]
    assert safe_message.count("[redacted-path]") == 1
    assert "Alice" not in safe_message
    assert "private-project" not in safe_message
    assert "secret.txt" not in safe_message


def test_chat_error_outcome_appends_runtime_gap_notification_for_allowlisted_codes() -> None:
    error = _error(code=CMP_TOOL_DISABLED, message="tools are disabled by configuration")

    outcome = chat_error_outcome(
        initialized=True,
        message_id=17,
        error=error,
        error_response=lambda message_id, **payload: {"id": message_id, "error": payload},
        chat_error_notification=lambda candidate: {
            "method": "chat.error",
            "params": {"code": candidate.code, "message": candidate.message},
        },
    )

    methods = [item["method"] for item in outcome.notifications]
    assert methods == ["chat.error", RUNTIME_GAP_CANDIDATE_METHOD]


def test_chat_error_outcome_skips_runtime_gap_notification_for_non_allowlisted_codes() -> None:
    error = _error(code="CMP-CHAT-9999", message="unexpected request shape")

    outcome = chat_error_outcome(
        initialized=True,
        message_id=18,
        error=error,
        error_response=lambda message_id, **payload: {"id": message_id, "error": payload},
        chat_error_notification=lambda candidate: {
            "method": "chat.error",
            "params": {"code": candidate.code, "message": candidate.message},
        },
    )

    methods = [item["method"] for item in outcome.notifications]
    assert methods == ["chat.error"]
