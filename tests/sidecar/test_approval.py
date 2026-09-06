from __future__ import annotations

import logging
import time

import pytest

from sidecar.runtime.approval import (
    approval_decision_from_response,
    approval_request_message,
    approval_resolution_from_response,
    request_tool_approval,
)
from sidecar.runtime.multiplexer import TurnCancellationHandle

_LOGGER = logging.getLogger("tests.approval")


# ── approval_request_message ──


def test_approval_request_message_structure() -> None:
    msg = approval_request_message({"tool_name": "shell", "reason": "needs confirmation"})
    assert msg["jsonrpc"] == "2.0"
    assert "id" in msg
    assert msg["method"] == "tool.request_approval"
    assert msg["params"]["tool_name"] == "shell"
    assert "api_version" in msg["params"]


def test_approval_request_message_ids_are_unique() -> None:
    msg1 = approval_request_message({"tool_name": "a"})
    msg2 = approval_request_message({"tool_name": "b"})
    assert msg1["id"] != msg2["id"]


# ── approval_decision_from_response ──


def test_decision_approved_true() -> None:
    msg_id = 1000
    assert (
        approval_decision_from_response({"id": msg_id, "result": {"approved": True}}, msg_id)
        is True
    )


def test_decision_approved_false() -> None:
    msg_id = 1001
    assert (
        approval_decision_from_response({"id": msg_id, "result": {"approved": False}}, msg_id)
        is False
    )


def test_decision_string_approve() -> None:
    msg_id = 1002
    assert (
        approval_decision_from_response({"id": msg_id, "result": {"decision": "approve"}}, msg_id)
        is True
    )


def test_decision_string_denied() -> None:
    msg_id = 1003
    assert (
        approval_decision_from_response({"id": msg_id, "result": {"decision": "denied"}}, msg_id)
        is False
    )


def test_decision_wrong_id_returns_false() -> None:
    assert approval_decision_from_response({"id": 999, "result": {"approved": True}}, 1000) is False


def test_decision_missing_result_returns_false() -> None:
    assert approval_decision_from_response({"id": 1000}, 1000) is False


@pytest.mark.parametrize("decision", ["approved", "approved_auto", "rejected"])
def test_plan_decisions_authorize_handler_and_preserve_feedback(decision: str) -> None:
    resolution = approval_resolution_from_response(
        {"id": 1004, "result": {"decision": decision, "feedback": "Please revise"}},
        1004,
    )
    assert resolution.approved is True
    assert resolution.decision == decision
    assert resolution.feedback == "Please revise"


def test_plan_decision_rejects_non_string_feedback_as_malformed() -> None:
    resolution = approval_resolution_from_response(
        {"id": 1005, "result": {"decision": "approved", "feedback": {"unsafe": True}}},
        1005,
    )
    assert resolution.approved is False
    assert resolution.status == "malformed"


def test_plan_decision_preserves_bounded_edited_plan_and_drops_non_dict() -> None:
    edited_plan = {"title": "Edited", "steps": ["Build"]}
    resolution = approval_resolution_from_response(
        {
            "id": 1006,
            "result": {"decision": "approved", "edited_plan": edited_plan},
        },
        1006,
    )
    assert resolution.approved is True
    assert resolution.edited_plan is edited_plan

    malformed = approval_resolution_from_response(
        {"id": 1007, "result": {"decision": "approved", "edited_plan": ["bad"]}},
        1007,
    )
    assert malformed.approved is True
    assert malformed.edited_plan is None


def test_oversized_edited_plan_is_dropped_and_logged_without_failing_approval(caplog) -> None:
    written: list[dict[str, object]] = []

    def _write_message(payload: dict[str, object]) -> None:
        written.append(payload)

    def _read_message(_timeout: float) -> dict[str, object]:
        return {
            "jsonrpc": "2.0",
            "id": int(written[0]["id"]),
            "result": {
                "decision": "approved",
                "edited_plan": {"title": "x" * (16 * 1024), "steps": ["Build"]},
            },
        }

    with caplog.at_level(logging.WARNING):
        resolution = request_tool_approval(
            {"request_id": "req_plan", "tool_name": "exit_plan_mode"},
            write_message=_write_message,
            read_message=_read_message,
            timeout_seconds=1.0,
            logger=_LOGGER,
        )

    assert resolution.approved is True
    assert resolution.edited_plan is None
    assert any(
        getattr(record, "event", "") == "sidecar.runtime.approval.edited_plan_dropped"
        for record in caplog.records
    )


# ── request_tool_approval ──


def test_request_tool_approval_ignores_unrelated_responses_until_expected_id() -> None:
    written: list[dict[str, object]] = []
    calls = {"count": 0}

    def _write_message(payload: dict[str, object]) -> None:
        written.append(payload)

    def _read_message(_timeout: float) -> dict[str, object]:
        calls["count"] += 1
        expected_id = int(written[0]["id"])
        if calls["count"] == 1:
            return {"jsonrpc": "2.0", "id": expected_id + 1, "result": {"approved": False}}
        return {"jsonrpc": "2.0", "id": expected_id, "result": {"approved": True}}

    resolution = request_tool_approval(
        {"request_id": "req_1", "tool_name": "write_file", "reason": "needs confirmation"},
        write_message=_write_message,
        read_message=_read_message,
        timeout_seconds=1.0,
        logger=_LOGGER,
    )

    assert resolution.approved is True
    assert resolution.status == "approved"


def test_request_tool_approval_logs_mismatches_without_auto_deny(caplog) -> None:
    written: list[dict[str, object]] = []
    calls = {"count": 0}

    def _write_message(payload: dict[str, object]) -> None:
        written.append(payload)

    def _read_message(_timeout: float) -> dict[str, object]:
        calls["count"] += 1
        expected_id = int(written[0]["id"])
        if calls["count"] <= 75:
            return {
                "jsonrpc": "2.0",
                "id": expected_id + calls["count"],
                "method": "chat.token",
                "params": {
                    "request_id": "req_1",
                    "trace_id": "trace_incoming",
                    "session_id": "session_incoming",
                    "tool_call_id": "call_incoming",
                },
            }
        return {"jsonrpc": "2.0", "id": expected_id, "result": {"approved": True}}

    with caplog.at_level(logging.INFO):
        resolution = request_tool_approval(
            {
                "request_id": "req_1",
                "trace_id": "trace_1",
                "session_id": "session_1",
                "tool_call_id": "call_1",
                "tool_name": "write_file",
            },
            write_message=_write_message,
            read_message=_read_message,
            timeout_seconds=1.0,
            logger=_LOGGER,
        )

    assert resolution.approved is True
    assert resolution.status == "approved"
    mismatch_records = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "sidecar.runtime.approval.mismatch"
    ]
    assert mismatch_records
    assert getattr(mismatch_records[0], "tool_call_id", None) == "call_1"
    assert getattr(mismatch_records[0], "approval_id", None) == int(written[0]["id"])
    assert mismatch_records[0].levelno == logging.WARNING
    assert mismatch_records[0].data["incoming_request_id"] == "req_1"
    assert mismatch_records[0].data["incoming_trace_id"] == "trace_incoming"
    assert mismatch_records[0].data["incoming_session_id"] == "session_incoming"
    assert mismatch_records[0].data["incoming_tool_call_id"] == "call_incoming"


def test_request_tool_approval_bounds_and_redacts_logged_correlation(caplog) -> None:
    secret_id = "api_key=sk-abcdefghijklmnop " + ("x" * 300)
    written: list[dict[str, object]] = []
    responses: list[dict[str, object]] = [
        {
            "jsonrpc": "2.0",
            "id": 999,
            "params": {
                "request_id": secret_id,
                "trace_id": secret_id,
                "session_id": secret_id,
                "tool_call_id": secret_id,
            },
        }
    ]

    def _write(payload: dict[str, object]) -> None:
        written.append(payload)
        responses.append(
            {
                "jsonrpc": "2.0",
                "id": int(payload["id"]),
                "result": {"approved": True},
            }
        )

    def _read(_timeout: float) -> dict[str, object]:
        return responses.pop(0)

    with caplog.at_level(logging.WARNING, logger="tests.approval"):
        resolution = request_tool_approval(
            {"request_id": secret_id, "tool_name": "write_file", "tool_call_id": secret_id},
            write_message=_write,
            read_message=_read,
            timeout_seconds=1.0,
            logger=_LOGGER,
        )

    assert resolution.approved is True
    mismatch_record = next(
        record
        for record in caplog.records
        if getattr(record, "event", "") == "sidecar.runtime.approval.mismatch"
    )
    assert len(mismatch_record.request_id) <= 160
    assert "sk-abcdefghijklmnop" not in mismatch_record.request_id
    assert "sk-abcdefghijklmnop" not in mismatch_record.tool_call_id
    assert len(mismatch_record.data["incoming_request_id"]) <= 160
    assert "sk-abcdefghijklmnop" not in mismatch_record.data["incoming_request_id"]


def test_request_tool_approval_denied() -> None:
    written: list[dict[str, object]] = []

    def _write(payload: dict[str, object]) -> None:
        written.append(payload)

    def _read(_timeout: float) -> dict[str, object]:
        return {"jsonrpc": "2.0", "id": int(written[0]["id"]), "result": {"approved": False}}

    resolution = request_tool_approval(
        {"tool_name": "shell"},
        write_message=_write,
        read_message=_read,
        timeout_seconds=1.0,
        logger=_LOGGER,
    )
    assert resolution.approved is False
    assert resolution.status == "denied"


def test_request_tool_approval_timeout() -> None:
    written: list[dict[str, object]] = []

    def _write(payload: dict[str, object]) -> None:
        written.append(payload)

    def _read(_timeout: float) -> dict[str, object]:
        raise TimeoutError("timed out")

    resolution = request_tool_approval(
        {"tool_name": "write_file"},
        write_message=_write,
        read_message=_read,
        timeout_seconds=0.01,
        logger=_LOGGER,
    )
    assert resolution.approved is False
    assert resolution.status == "timeout"


def test_request_tool_approval_zero_timeout_fails_closed_without_writing_or_reading() -> None:
    written: list[dict[str, object]] = []
    read_calls: list[float] = []

    resolution = request_tool_approval(
        {"tool_name": "write_file"},
        write_message=written.append,
        read_message=lambda timeout: read_calls.append(timeout) or {"result": {"approved": True}},
        timeout_seconds=0,
        logger=logging.getLogger("test.approval.zero-timeout"),
    )

    assert resolution.approved is False
    assert resolution.status == "timeout"
    assert written == []
    assert read_calls == []


def test_request_tool_approval_registers_before_write_and_always_closes_waiter() -> None:
    registered = False
    closed = False
    response: dict[str, object] = {}

    def _factory(expected_id: int, **_kwargs: object):
        nonlocal registered
        registered = True
        response.update({"jsonrpc": "2.0", "id": expected_id, "result": {"approved": True}})

        def _read(_timeout: float) -> dict[str, object]:
            return response

        def _close() -> None:
            nonlocal closed
            closed = True
            raise RuntimeError("close failed")

        _read.close = _close  # type: ignore[attr-defined]
        return _read

    def _write(_payload: dict[str, object]) -> None:
        assert registered is True

    resolution = request_tool_approval(
        {"tool_name": "shell"},
        write_message=_write,
        read_message=lambda _timeout: {},
        response_reader_factory=_factory,
        timeout_seconds=1.0,
        logger=_LOGGER,
    )

    assert resolution.approved is True
    assert closed is True


def test_request_tool_approval_closes_registered_waiter_when_write_fails() -> None:
    closed = False

    def _factory(_expected_id: int, **_kwargs: object):
        def _read(_timeout: float) -> dict[str, object]:
            return {}

        def _close() -> None:
            nonlocal closed
            closed = True

        _read.close = _close  # type: ignore[attr-defined]
        return _read

    with pytest.raises(RuntimeError, match="write failed"):
        request_tool_approval(
            {"tool_name": "shell"},
            write_message=lambda _payload: (_ for _ in ()).throw(RuntimeError("write failed")),
            read_message=lambda _timeout: {},
            response_reader_factory=_factory,
            timeout_seconds=1.0,
            logger=_LOGGER,
        )

    assert closed is True


def test_request_tool_approval_cancel_wins_over_queued_response() -> None:
    written: list[dict[str, object]] = []
    cancel_handle = TurnCancellationHandle(request_id="req_cancel_race")
    cancel_handle.cancel(reason="user_cancel")

    def _write(payload: dict[str, object]) -> None:
        written.append(payload)

    def _factory(_approval_id: int, *, cancel_handle=None):  # noqa: ANN001
        _ = cancel_handle

        def _read(_timeout: float) -> dict[str, object]:
            return {"jsonrpc": "2.0", "id": int(written[0]["id"]), "result": {"approved": True}}

        return _read

    resolution = request_tool_approval(
        {"request_id": "req_cancel_race", "tool_name": "shell"},
        write_message=_write,
        read_message=lambda _timeout: {},
        response_reader_factory=_factory,
        timeout_seconds=1.0,
        logger=_LOGGER,
        cancel_handle=cancel_handle,
    )

    assert resolution.approved is False
    assert resolution.status == "cancelled"


def test_request_tool_approval_read_exception_returns_false() -> None:
    written: list[dict[str, object]] = []

    def _write(payload: dict[str, object]) -> None:
        written.append(payload)

    def _read(_timeout: float) -> dict[str, object]:
        raise RuntimeError("connection lost")

    resolution = request_tool_approval(
        {"tool_name": "shell"},
        write_message=_write,
        read_message=_read,
        timeout_seconds=1.0,
        logger=_LOGGER,
    )
    assert resolution.approved is False
    assert resolution.status == "runtime_error"


def test_request_tool_approval_fallback_cancellation_and_message() -> None:
    cancel_handle = TurnCancellationHandle(request_id="req_cancel_fallback")
    cancel_handle.cancel(reason="user_cancel")

    written: list[dict[str, object]] = []
    def _write(payload: dict[str, object]) -> None:
        written.append(payload)

    def _read_slow(_timeout: float) -> dict[str, object]:
        time.sleep(0.5)
        return {"jsonrpc": "2.0", "id": 12345, "result": {"approved": True}}

    resolution = request_tool_approval(
        {"request_id": "req_cancel_fallback", "tool_name": "shell"},
        write_message=_write,
        read_message=_read_slow,
        timeout_seconds=2.0,
        logger=_LOGGER,
        cancel_handle=cancel_handle,
    )
    assert resolution.approved is False
    assert resolution.status == "cancelled"

    cancel_handle_2 = TurnCancellationHandle(request_id="req_cancel_msg")
    def _read_cancel_msg(_timeout: float) -> dict[str, object]:
        return {"jsonrpc": "2.0", "method": "chat.cancel", "params": {"request_id": "req_cancel_msg"}}

    resolution_2 = request_tool_approval(
        {"request_id": "req_cancel_msg", "tool_name": "shell"},
        write_message=_write,
        read_message=_read_cancel_msg,
        timeout_seconds=2.0,
        logger=_LOGGER,
        cancel_handle=cancel_handle_2,
    )
    assert resolution_2.approved is False
    assert resolution_2.status == "cancelled"
    assert cancel_handle_2.cancelled is True
