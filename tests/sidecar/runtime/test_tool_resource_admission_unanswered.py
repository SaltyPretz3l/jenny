"""An admit written but never answered sends a best-effort compensating settle (C5-D)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.multiplexer import ApprovalResponseCancelledError
from sidecar.runtime.tool_resource_admission import (
    RuntimeToolResourceRequest,
    acquire_tool_resource,
)
from tests.sidecar.runtime.test_tool_resource_admission import _Reader, _request


def _settled(rpc_id: int, sent: list[dict[str, Any]]) -> dict[str, Any]:
    return {"id": rpc_id, "result": {
        "schema_version": 1, "operation_id": "call_7", "status": "settled",
    }}


def _phases(sent: list[dict[str, Any]]) -> list[tuple[str, Any, Any]]:
    return [
        (m["params"]["phase"], m["params"].get("status"), m["params"].get("cleanup"))
        for m in sent
    ]


def _raise(error: BaseException) -> Any:
    def admit() -> Any:
        raise error

    return admit


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (ApprovalResponseCancelledError("turn cancelled"), "authority_incomplete"),
        (TimeoutError("no answer"), "authority_incomplete"),
    ],
)
def test_unanswered_admit_settles_cancelled_uncertain(error: BaseException, reason: str) -> None:
    sent: list[dict[str, Any]] = []
    seen: list[dict[str, Any]] = []
    cancel = SimpleNamespace(cancelled=False)

    # The settle reader is created after the settle is written, so build it lazily.
    def factory(rpc_id: int, **kwargs: Any) -> _Reader:
        seen.append(kwargs)
        if len(seen) == 1:
            return _Reader(_raise(error))
        return _Reader(lambda: _settled(rpc_id, sent))

    with pytest.raises(ToolExecutionFailure, match=reason):
        acquire_tool_resource(_request(sent, factory, cancel_handle=cancel))
    assert _phases(sent) == [("admit", None, None), ("settle", "cancelled", "uncertain")]
    # The compensating settle never inherits request cancellation.
    assert seen == [{"cancel_handle": cancel}, {"cancel_handle": None}]


def test_cancelled_after_write_settles_and_keeps_the_original_failure() -> None:
    sent: list[dict[str, Any]] = []
    cancel = SimpleNamespace(cancelled=False)

    def write(message: dict[str, Any]) -> None:
        sent.append(message)
        cancel.cancelled = True

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        return _Reader(lambda: _settled(rpc_id, sent))

    request = RuntimeToolResourceRequest(
        request_id="request_1", session_id="session_1", authority_revision="authority_1",
        operation_id="call_7", tool_name="read_file", arguments={},
        write_message=write, response_reader_factory=factory, cancel_handle=cancel,
    )
    with pytest.raises(ToolExecutionFailure, match="admission_cancelled"):
        acquire_tool_resource(request)
    assert _phases(sent) == [("admit", None, None), ("settle", "cancelled", "uncertain")]


def test_admit_deadline_settles_once() -> None:
    sent: list[dict[str, Any]] = []
    calls = {"n": 0}

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        calls["n"] += 1
        if calls["n"] == 1:
            return _Reader(lambda: {"id": -1})  # never the admit's id
        return _Reader(lambda: _settled(rpc_id, sent))

    request = RuntimeToolResourceRequest(
        request_id="request_1", session_id="session_1", authority_revision="authority_1",
        operation_id="call_7", tool_name="read_file", arguments={},
        write_message=sent.append, response_reader_factory=factory, timeout_seconds=0.1,
    )
    with pytest.raises(ToolExecutionFailure, match="authority_timeout"):
        acquire_tool_resource(request)
    assert _phases(sent) == [("admit", None, None), ("settle", "cancelled", "uncertain")]


def test_compensating_settle_failure_is_swallowed() -> None:
    sent: list[dict[str, Any]] = []
    seen: list[dict[str, Any]] = []

    def factory(rpc_id: int, **kwargs: Any) -> _Reader:
        seen.append(kwargs)
        if len(seen) == 1:
            return _Reader(_raise(TimeoutError("no answer")))
        raise RuntimeError("bridge closed")

    with pytest.raises(ToolExecutionFailure, match="authority_incomplete"):
        acquire_tool_resource(_request(sent, factory))
    assert len(seen) == 2


def test_answered_rejection_sends_no_compensating_settle() -> None:
    sent: list[dict[str, Any]] = []

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        return _Reader(lambda: {"id": rpc_id, "result": {
            "schema_version": 1, "operation_id": "call_7", "status": "rejected",
        }})

    with pytest.raises(ToolExecutionFailure, match="capacity_rejected"):
        acquire_tool_resource(_request(sent, factory))
    assert _phases(sent) == [("admit", None, None)]
