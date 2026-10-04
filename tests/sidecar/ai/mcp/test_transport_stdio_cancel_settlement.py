"""Cancellation at dispatch boundaries must settle shared stdio requests."""

from __future__ import annotations

import io
import json
import threading
from collections.abc import Callable, Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp import transport_stdio
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.transport_stdio import StdioMCPTransport
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle


class _Writer(io.StringIO):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[dict[str, Any]] = []
        self.on_flush: Callable[[dict[str, Any]], None] = lambda _message: None

    def write(self, line: str) -> int:
        self.messages.append(json.loads(line))
        return len(line)

    def flush(self) -> None:
        self.on_flush(self.messages[-1])


@pytest.fixture
def pipe_transport() -> Iterator[tuple[StdioMCPTransport, _Writer]]:
    writer = _Writer()
    process = MagicMock(stdin=writer, stdout=io.StringIO(), stderr=io.StringIO())
    process.poll.return_value = None
    with (
        patch.object(transport_stdio, "_validate_stdio_command"),
        patch.object(transport_stdio, "MCPProcessContainment"),
        patch.object(transport_stdio.subprocess, "Popen", return_value=process),
        patch.object(threading.Thread, "start"),
        patch.object(transport_stdio, "_register_active_transport"),
        patch.object(transport_stdio, "_register_active_process"),
    ):
        transport = StdioMCPTransport(
            MCPServerConfig(name="builtin", transport="stdio", command="python"),
            request_timeout_seconds=0.4,
        )
    transport._initialized = True
    try:
        yield transport, writer
    finally:
        transport.close()


def _reply(transport: StdioMCPTransport, request_id: int, *, aborted: bool = False) -> None:
    response: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
    if aborted:
        response["error"] = {
            "code": -32000,
            "message": "aborted",
            "data": {"code": "CMP-TOOL-0041"},
        }
    else:
        response["result"] = {"value": request_id}
    transport._reader_queue.put_nowait(json.dumps(response))


def _assert_retired(transport: StdioMCPTransport) -> None:
    assert transport._pending_responses == {}
    assert transport._pending_output_callbacks == {}
    assert transport._tool_lifecycle._events == {}
    assert transport._tool_lifecycle._operation_ids == {}
    assert not transport._request_lock.locked()
    assert not transport._response_read_lock.locked()


@pytest.mark.parametrize("acknowledge", [False, True])
def test_cancel_immediately_after_write_settles_and_discards_late_reply(
    pipe_transport: tuple[StdioMCPTransport, _Writer], acknowledge: bool,
) -> None:
    transport, writer = pipe_transport
    handle = TurnCancellationHandle(request_id="after-write")

    def flush(message: dict[str, Any]) -> None:
        if message["method"] == "tools/call":
            handle.cancel()
        elif acknowledge:
            _reply(transport, message["params"]["requestId"], aborted=True)

    writer.on_flush = flush
    with pytest.raises(TerminalChatStateError) as raised:
        transport.call_tool("run_command", {}, cancel_handle=handle)

    assert [message["method"] for message in writer.messages] == [
        "tools/call", "notifications/cancelled",
    ]
    request_id = writer.messages[0]["id"]
    assert writer.messages[1]["params"]["requestId"] == request_id
    if acknowledge:
        assert isinstance(raised.value.__cause__, MCPError)
        assert raised.value.__cause__.code == "CMP-TOOL-0041"
    _assert_retired(transport)
    if not acknowledge:
        # An unacknowledged sole request escalates to transport termination.
        transport._containment.terminate.assert_called_once()
        return

    # A cancelled request's late reply cannot become the next call's result.
    _reply(transport, request_id)
    writer.on_flush = lambda message: _reply(transport, message["id"])
    assert transport.call_tool("next", {}) == {"value": request_id + 1}
    _assert_retired(transport)


def test_cancel_after_write_with_reply_already_buffered_returns_the_reply(
    pipe_transport: tuple[StdioMCPTransport, _Writer],
) -> None:
    transport, writer = pipe_transport
    handle = TurnCancellationHandle(request_id="buffered-reply")

    def flush(message: dict[str, Any]) -> None:
        if message["method"] == "tools/call":
            request_id = message["id"]
            transport._pending_responses[request_id].put({
                "jsonrpc": "2.0", "id": request_id, "result": {"ok": True},
            })
            handle.cancel()

    writer.on_flush = flush
    # The settled reply wins the race: no needless cancel, no discarded success.
    result = transport.call_tool("run_command", {}, cancel_handle=handle)

    assert result == {"ok": True}
    assert [message["method"] for message in writer.messages] == ["tools/call"]
    _assert_retired(transport)


def test_cancel_behind_another_response_reader_notifies_and_other_call_completes(
    pipe_transport: tuple[StdioMCPTransport, _Writer], monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, writer = pipe_transport
    handle = TurnCancellationHandle(request_id="read-lock")
    reading = threading.Event()
    waiting = threading.Event()
    original_acquire = transport._acquire_lock
    results: dict[str, Any] = {}
    errors: dict[str, BaseException] = {}

    def acquire(lock: Any, **kwargs: Any) -> None:
        if lock is transport._response_read_lock and kwargs["cancel_handle"] is handle:
            assert lock.locked()
            waiting.set()
        original_acquire(lock, **kwargs)
        if lock is transport._response_read_lock and kwargs["cancel_handle"] is None:
            reading.set()

    monkeypatch.setattr(transport, "_acquire_lock", acquire)

    def flush(message: dict[str, Any]) -> None:
        if message["method"] == "notifications/cancelled":
            _reply(transport, message["params"]["requestId"], aborted=True)
            _reply(transport, writer.messages[0]["id"])

    writer.on_flush = flush

    def call(name: str, cancel_handle: Any = None) -> None:
        try:
            results[name] = transport.call_tool(
                name, {}, cancel_handle=cancel_handle, timeout_seconds=3,
            )
        except Exception as error:  # noqa: BLE001 - Assert worker failures on the test thread.
            errors[name] = error

    first = threading.Thread(target=call, args=("first",), daemon=True)
    second = threading.Thread(target=call, args=("second", handle), daemon=True)
    first.start()
    try:
        assert reading.wait(timeout=1)
        second.start()
        assert waiting.wait(timeout=1)
        handle.cancel()
        second.join(timeout=1)
        # Let the first call finish even on the unfixed red path.
        if first.is_alive() and len(writer.messages) == 2:
            _reply(transport, writer.messages[0]["id"])
        first.join(timeout=1)
        assert [message["method"] for message in writer.messages] == [
            "tools/call", "tools/call", "notifications/cancelled",
        ]
        assert writer.messages[2]["params"]["requestId"] == writer.messages[1]["id"]
        assert not first.is_alive() and not second.is_alive()
        assert results == {"first": {"value": writer.messages[0]["id"]}}
        assert isinstance(errors.get("second"), TerminalChatStateError)
        assert isinstance(errors["second"].__cause__, MCPError)
        _assert_retired(transport)
    finally:
        _reply(transport, writer.messages[0]["id"])
        first.join(timeout=1)
        if second.ident is not None:
            second.join(timeout=1)


def test_three_cancellations_after_request_lock_admission_retire_lifecycle(
    pipe_transport: tuple[StdioMCPTransport, _Writer], monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, writer = pipe_transport
    original_acquire = transport._acquire_request_lock

    def acquire(*, deadline: float, cancel_handle: Any) -> None:
        original_acquire(deadline=deadline, cancel_handle=cancel_handle)
        cancel_handle.cancel()

    monkeypatch.setattr(transport, "_acquire_request_lock", acquire)
    for index in range(3):
        with pytest.raises(TerminalChatStateError):
            transport.call_tool(
                "run_command", {}, cancel_handle=TurnCancellationHandle(request_id=str(index)),
            )

    assert writer.messages == []
    _assert_retired(transport)


@pytest.mark.parametrize("boundary", ["begin", "cursor", "write"])
def test_exception_after_lifecycle_registration_retires_and_releases_lock(
    pipe_transport: tuple[StdioMCPTransport, _Writer], monkeypatch: pytest.MonkeyPatch,
    boundary: str,
) -> None:
    transport, writer = pipe_transport

    def fail(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("injected dispatch failure")

    if boundary == "begin":
        original_begin = transport._tool_lifecycle.begin

        def begin(request_id: int) -> Any:
            original_begin(request_id)
            fail()

        monkeypatch.setattr(transport._tool_lifecycle, "begin", begin)
    elif boundary == "cursor":
        monkeypatch.setattr(transport._stderr_evidence, "cursor", fail)
    else:
        monkeypatch.setattr(transport, "_write_line", fail)

    with pytest.raises(RuntimeError, match="injected dispatch failure"):
        transport.call_tool("run_command", {}, on_output_chunk=lambda _chunk: None)

    assert writer.messages == []
    _assert_retired(transport)
