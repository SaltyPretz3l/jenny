"""Tests for sidecar.runtime.outcomes — ProcessOutcome and chat_error_outcome."""

from __future__ import annotations

from sidecar.runtime.chat import ChatRequestError
from sidecar.runtime.outcomes import ProcessOutcome, chat_error_outcome


def test_process_outcome_fields() -> None:
    outcome = ProcessOutcome(
        initialized=True,
        shutdown_requested=False,
        response={"id": 1},
        notifications=[],
    )
    assert outcome.initialized is True
    assert outcome.shutdown_requested is False
    assert outcome.response == {"id": 1}
    assert outcome.notifications == []


def test_process_outcome_is_named_tuple() -> None:
    outcome = ProcessOutcome(
        initialized=False,
        shutdown_requested=True,
        response=None,
        notifications=[{"method": "chat.done"}],
    )
    init, shutdown, resp, notifs, post_settlement_callback = outcome
    assert init is False
    assert shutdown is True
    assert resp is None
    assert len(notifs) == 1
    assert post_settlement_callback is None


def test_chat_error_outcome_produces_error_response() -> None:
    error = ChatRequestError(
        request_id="req_1",
        trace_id="trace_1",
        session_id="sess_1",
        code="CMP-CHAT-0001",
        message="something failed",
        rpc_code=-32000,
        retryable=True,
    )

    def _error_response(
        message_id: object, *, code: int, message: str, data: dict[str, object] | None = None
    ) -> dict[str, object]:
        return {"id": message_id, "error": {"code": code, "message": message, "data": data or {}}}

    def _chat_error_notification(err: ChatRequestError) -> dict[str, object]:
        return {"method": "chat.error", "params": {"code": err.code, "message": err.message}}

    outcome = chat_error_outcome(
        initialized=True,
        message_id=42,
        error=error,
        error_response=_error_response,
        chat_error_notification=_chat_error_notification,
    )

    assert outcome.initialized is True
    assert outcome.shutdown_requested is False
    assert outcome.response["id"] == 42
    assert outcome.response["error"]["code"] == -32000
    assert len(outcome.notifications) >= 1
    assert outcome.notifications[0]["method"] == "chat.error"


def test_chat_error_outcome_preserves_initialized_state() -> None:
    error = ChatRequestError(
        request_id="req_2",
        trace_id="trace_2",
        session_id="sess_2",
        code="CMP-CHAT-0002",
        message="init failure",
        rpc_code=-32000,
        retryable=False,
    )

    def _error_response(message_id: object, **kwargs: object) -> dict[str, object]:
        return {"id": message_id, "error": kwargs}

    def _chat_error_notification(err: ChatRequestError) -> dict[str, object]:
        return {"method": "chat.error", "params": {}}

    outcome_false = chat_error_outcome(
        initialized=False,
        message_id=1,
        error=error,
        error_response=_error_response,
        chat_error_notification=_chat_error_notification,
    )
    assert outcome_false.initialized is False

    outcome_true = chat_error_outcome(
        initialized=True,
        message_id=2,
        error=error,
        error_response=_error_response,
        chat_error_notification=_chat_error_notification,
    )
    assert outcome_true.initialized is True
