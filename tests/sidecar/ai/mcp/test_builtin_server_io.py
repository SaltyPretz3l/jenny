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

    assert builtin_server_io._intercept_cancellation(_DEEP_JSON) is False  # noqa: SLF001
    assert _drain(builtin_server_io.start_stdin_pump()) == [_DEEP_JSON, None]
