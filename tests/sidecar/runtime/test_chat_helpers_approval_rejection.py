"""Focused tests for ``chat_helpers.emit_approval_rejection`` (Phase 9).

Production callers pass ``runtime=None`` and append the returned chat.error
notification to ``ProcessOutcome.notifications``; the replay-corpus driver
passes a recording runtime so the same call also emits a ``StopEvent`` for
the loop-events corpus assertion.
"""

from __future__ import annotations

from sidecar.ai.routing.loop_events import LoopEvent, StopEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_observation import (
    KIND_USER_APPROVAL_REJECTED,
    ToolObservationStore,
)
from sidecar.protocol import CHAT_ERROR_METHOD
from sidecar.runtime.chat_helpers import chat_error_notification, emit_approval_rejection
from sidecar.runtime.chat_models import ChatRequestError


def test_emit_approval_rejection_returns_chat_error_notification() -> None:
    notification = emit_approval_rejection(
        runtime=None,
        request_id="req_1",
        trace_id=None,
        session_id=None,
        tool_name="dangerous_op",
    )
    assert notification["method"] == CHAT_ERROR_METHOD
    params = notification["params"]
    assert params["code"] == "CMP-APPROVAL-REJECTED"
    assert params["message"] == "User rejected approval for dangerous_op"
    assert params["retryable"] is False
    assert params["request_id"] == "req_1"


def test_emit_approval_rejection_with_runtime_emits_stop_event() -> None:
    captured: list[LoopEvent] = []
    runtime = LoopRuntime(emit=captured.append, request_id="req_1")
    notification = emit_approval_rejection(
        runtime=runtime,
        request_id="req_1",
        trace_id=None,
        session_id=None,
        tool_name="dangerous_op",
    )
    assert len(captured) == 1
    event = captured[0]
    assert isinstance(event, StopEvent)
    assert event.code == "CMP-APPROVAL-REJECTED"
    assert event.reason == "User rejected approval for dangerous_op"
    assert event.user_hint == ""
    # The notification dict is also returned for the wire-level append.
    assert notification["method"] == CHAT_ERROR_METHOD


def test_emit_approval_rejection_swallows_runtime_emit_failure() -> None:
    def _bad_emit(_event: LoopEvent) -> None:
        raise RuntimeError("boom")

    runtime = LoopRuntime(emit=_bad_emit, request_id="req_1")
    # No exception expected; notification still returned.
    notification = emit_approval_rejection(
        runtime=runtime,
        request_id="req_1",
        trace_id=None,
        session_id=None,
        tool_name="dangerous_op",
    )
    assert notification["params"]["code"] == "CMP-APPROVAL-REJECTED"


def test_emit_approval_rejection_includes_trace_and_session_when_provided() -> None:
    notification = emit_approval_rejection(
        runtime=None,
        request_id="req_1",
        trace_id="trace_42",
        session_id="sess_99",
        tool_name="risky",
    )
    params = notification["params"]
    assert params["trace_id"] == "trace_42"
    assert params["session_id"] == "sess_99"


def test_emit_approval_rejection_omits_optional_context_when_none() -> None:
    notification = emit_approval_rejection(
        runtime=None,
        request_id="req_1",
        trace_id=None,
        session_id=None,
        tool_name="risky",
    )
    params = notification["params"]
    assert "trace_id" not in params
    assert "session_id" not in params


def test_emit_approval_rejection_audits_observation_store() -> None:
    """Phase 6 Q19: when an observation store is supplied, rejection writes a
    ``KIND_USER_APPROVAL_REJECTED`` audit row that the Electron promotion
    bridge can promote into ``approval_resolved``."""
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_reject")

    emit_approval_rejection(
        runtime=None,
        request_id="req_reject",
        trace_id=None,
        session_id=None,
        tool_name="write_file",
        tool_call_id="call-denied",
        observation_store=store,
    )

    audit_events = store.recent_events(request_id="req_reject", limit=50)
    assert audit_events
    last = audit_events[-1]
    assert last.kind == KIND_USER_APPROVAL_REJECTED
    assert last.tool_call_id == "call-denied"
    assert last.tool_name == "write_file"
    assert last.error_code == "CMP-APPROVAL-REJECTED"


def test_emit_approval_rejection_swallows_observation_store_failure() -> None:
    """A faulty observation store must not break the rejection path."""

    class _FaultyStore(ToolObservationStore):
        def record(self, _event):  # type: ignore[override]
            raise RuntimeError("boom")

    notification = emit_approval_rejection(
        runtime=None,
        request_id="req_reject",
        trace_id=None,
        session_id=None,
        tool_name="write_file",
        tool_call_id="call-denied",
        observation_store=_FaultyStore(),
    )
    assert notification["params"]["code"] == "CMP-APPROVAL-REJECTED"


def test_chat_error_notification_redacts_terminal_message_and_data() -> None:
    notification = chat_error_notification(
        ChatRequestError(
            request_id="req_secret",
            trace_id="trace_secret",
            session_id="sess_secret",
            code="CMP-CHAT-0002",
            message="stream failed with authorization=secret-token",
            rpc_code=-32000,
            retryable=True,
            data={
                "detail": "provider returned bearer hidden-token",
                "headers": {"authorization": "Bearer nested-token"},
            },
        )
    )

    params = notification["params"]
    raw = str(params)
    assert params["message"] == "stream failed with authorization=[redacted]"
    assert "secret-token" not in raw
    assert "hidden-token" not in raw
    assert "nested-token" not in raw
    assert params["headers"]["authorization"] == "[redacted]"
    assert params["request_id"] == "req_secret"
    assert params["trace_id"] == "trace_secret"
