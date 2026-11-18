"""Unit tests for the builtin MCP server's stdin pump."""

from __future__ import annotations

import json
import queue
import sys
from types import SimpleNamespace

import pytest

from sidecar.ai.mcp import builtin_server_io

_DEEP_JSON = "[" * 100_000


@pytest.fixture
def _plain_stdin(monkeypatch: pytest.MonkeyPatch):
    """Route the pump through ``sys.stdin.readline`` with no gated reader."""
    monkeypatch.setattr(builtin_server_io, "gated_stdin", lambda _buffer: None)

    def install(lines: list[str] | None = None, error: Exception | None = None):
        queued = list(lines or [])

        def readline() -> str:
            if queued:
                return queued.pop(0)
            if error is not None:
                raise error
            return ""

        monkeypatch.setattr(sys, "stdin", SimpleNamespace(readline=readline))

    return install


def _drain(inbox: "queue.Queue[str | None]") -> list[str | None]:
    items: list[str | None] = []
    while True:
        item = inbox.get(timeout=5)
        items.append(item)
        if item is None:
            return items


def test_pump_delivers_its_sentinel_when_the_reader_fails(_plain_stdin, capsys) -> None:
    _plain_stdin(['{"id": 1, "method": "ping"}\n'], error=OSError("pipe gone"))

    items = _drain(builtin_server_io.start_stdin_pump())

    assert items == ['{"id": 1, "method": "ping"}', None]
    assert "builtin stdin pump failed: OSError" in capsys.readouterr().err


def test_deeply_nested_json_is_forwarded_not_fatal(_plain_stdin) -> None:
    with pytest.raises(RecursionError):
        json.loads(_DEEP_JSON)
    _plain_stdin([_DEEP_JSON + "\n"])

    assert builtin_server_io._intercept_cancellation(_DEEP_JSON) is False
    assert _drain(builtin_server_io.start_stdin_pump()) == [_DEEP_JSON, None]


def test_wake_notification_sets_the_calls_wake_event_without_touching_abort(_plain_stdin) -> None:
    from sidecar.ai.tools.builtins import cancellation

    cancellation.end_tool_call()
    abort = cancellation.begin_tool_call(41)
    wake = cancellation.current_wake_event()
    wake_line = json.dumps(
        {"jsonrpc": "2.0", "method": "notifications/jenny_wake", "params": {"requestId": 41}}
    )
    request_line = '{"jsonrpc": "2.0", "id": 42, "method": "ping"}'
    try:
        _plain_stdin([wake_line + "\n", request_line + "\n"])

        items = _drain(builtin_server_io.start_stdin_pump())

        assert items == [request_line, None], "the wake is intercepted, never forwarded"
        assert wake is not None and wake.is_set()
        assert not abort.is_set()
    finally:
        cancellation.end_tool_call()


@pytest.mark.parametrize(
    "line",
    [
        '{"jsonrpc": "2.0", "id": 7, "method": "notifications/jenny_wake", "params": {"requestId": 7}}',
        '{"jsonrpc": "2.0", "method": "notifications/jenny_wake", "params": "x"}',
        '{"jsonrpc": "2.0", "method": "notifications/jenny_wake"}',
    ],
)
def test_malformed_or_request_shaped_wake_never_wakes_a_call(line: str) -> None:
    from sidecar.ai.tools.builtins import cancellation

    cancellation.end_tool_call()
    cancellation.begin_tool_call(7)
    wake = cancellation.current_wake_event()
    try:
        builtin_server_io._intercept_cancellation(line)

        assert wake is not None and not wake.is_set()
    finally:
        cancellation.end_tool_call()
