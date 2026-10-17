from __future__ import annotations

from typing import Any

import pytest

from sidecar.runtime.chat import ChatRequestError
from sidecar.runtime.request_dispatch_chat_support import _validate_chat_send_semantics


@pytest.mark.parametrize(
    "request_id",
    [None, 42, 3.5, True, [], {}, ("value",), object()],
    ids=["null", "integer", "float", "boolean", "list", "dict", "tuple", "object"],
)
def test_explicit_non_string_request_id_is_rejected(request_id: Any) -> None:
    error = _validate_chat_send_semantics(
        params={"request_id": request_id},
        message_id=7,
    )

    assert isinstance(error, ChatRequestError)
    assert error.message == "chat.send params.request_id must be a non-empty string when provided."


def _context_row() -> dict[str, Any]:
    import hashlib

    body = "hello from another chat"
    return {
        "role": "context",
        "kind": "session_message",
        "content": body,
        "session_message": {
            "schema_version": 1,
            "message_id": "m-1",
            "source_session_id": "s-1",
            "source_session_incarnation": "i-1",
            "source_project_id": None,
            "destination_session_id": "s-2",
            "destination_session_incarnation": "i-2",
            "destination_project_id": None,
            "source_turn_id": None,
            "kind": "user_message",
            "created_at": "2026-10-15T00:00:00.000Z",
            "body": body,
            "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
            "report": None,
        },
    }


def test_context_rows_are_rejected_until_session_messages_are_negotiated() -> None:
    params = {"messages": [_context_row(), {"role": "user", "content": "go"}]}

    closed = _validate_chat_send_semantics(params=params, message_id=7)
    assert isinstance(closed, ChatRequestError)
    assert "session_messages capability" in closed.message

    explicit_closed = _validate_chat_send_semantics(
        params=params, message_id=7, session_messages_enabled=False
    )
    assert isinstance(explicit_closed, ChatRequestError)

    assert (
        _validate_chat_send_semantics(params=params, message_id=7, session_messages_enabled=True)
        is None
    )


def test_malformed_context_rows_are_rejected_even_when_negotiated() -> None:
    row = _context_row()
    row["content"] = "tampered"
    error = _validate_chat_send_semantics(
        params={"messages": [row, {"role": "user", "content": "go"}]},
        message_id=7,
        session_messages_enabled=True,
    )
    assert isinstance(error, ChatRequestError)
    assert "session message" in error.message


def _handoff_row() -> dict[str, object]:
    import hashlib

    body = "Decisions so far: use sqlite."
    return {
        "role": "context",
        "kind": "session_handoff",
        "content": body,
        "session_handoff": {
            "schema_version": 1,
            "proposal_id": "proposal_" + "ab" * 32,
            "source_session_id": "s-1",
            "source_session_incarnation": "i-1",
            "body": body,
            "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        },
    }


def test_handoff_rows_are_gated_by_their_own_negotiated_capability() -> None:
    params = {"messages": [_handoff_row(), {"role": "user", "content": "go"}]}

    closed = _validate_chat_send_semantics(params=params, message_id=7)
    assert isinstance(closed, ChatRequestError)
    assert "session_handoff capability" in closed.message
    # the session_messages capability does not open the handoff kind
    assert isinstance(
        _validate_chat_send_semantics(params=params, message_id=7, session_messages_enabled=True),
        ChatRequestError,
    )
    assert (
        _validate_chat_send_semantics(params=params, message_id=7, session_handoff_enabled=True)
        is None
    )
