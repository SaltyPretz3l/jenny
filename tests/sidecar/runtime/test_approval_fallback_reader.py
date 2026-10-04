"""The no-multiplexer approval fallback reader must not steal later stdin frames.

The old reader ran free: after handing over the approval response it re-entered
the blocking ``read_message`` at once, so the NEXT frame on stdin (typically the
next ``chat.send``) was consumed into a queue nobody read and lost.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Any

import pytest

from sidecar.runtime import approval
from sidecar.runtime.approval import request_tool_approval

_LOGGER = logging.getLogger("tests.approval_fallback")
_THREAD_NAME = "approval-fallback-reader"


class _FakeStdin:
    """A blocking framed-message source standing in for the sidecar's stdin."""

    def __init__(self) -> None:
        self.frames: queue.Queue[dict[str, Any]] = queue.Queue()
        self.reads = 0

    def read_message(self, _timeout: float) -> dict[str, Any]:
        frame = self.frames.get()  # blocks like a real stdin read
        self.reads += 1
        return frame


def _reader_threads(ignore: frozenset[threading.Thread] = frozenset()) -> list[threading.Thread]:
    return [
        t
        for t in threading.enumerate()
        if t.name == _THREAD_NAME and t.is_alive() and t not in ignore
    ]


def test_next_stdin_frame_stays_readable_after_the_approval_resolves() -> None:
    stdin = _FakeStdin()
    next_request = {"jsonrpc": "2.0", "id": 7, "method": "chat.send", "params": {}}
    earlier = frozenset(_reader_threads())

    def _write(payload: dict[str, Any]) -> None:
        # Electron answers the approval and immediately sends the next request.
        stdin.frames.put({"jsonrpc": "2.0", "id": payload["id"], "result": {"approved": True}})
        stdin.frames.put(next_request)

    resolution = request_tool_approval(
        {"request_id": "req_fallback", "tool_name": "write_file"},
        write_message=_write,
        read_message=stdin.read_message,
        timeout_seconds=2.0,
        logger=_LOGGER,
    )
    time.sleep(0.2)  # give a free-running reader time to steal the next frame

    assert resolution.status == "approved"
    assert stdin.reads == 1
    assert stdin.frames.get_nowait() == next_request
    assert _reader_threads(earlier) == []


def test_frame_read_after_an_abandoned_wait_is_logged_not_silently_dropped(
    caplog: pytest.LogCaptureFixture,
) -> None:
    stdin = _FakeStdin()
    earlier = frozenset(_reader_threads())

    with caplog.at_level(logging.WARNING, logger=approval.__name__):
        resolution = request_tool_approval(
            {"request_id": "req_timeout", "tool_name": "write_file"},
            write_message=lambda _payload: None,
            read_message=stdin.read_message,
            timeout_seconds=0.2,
            logger=_LOGGER,
        )
        assert resolution.status == "timeout"
        # The abandoned read is still blocked; the next frame lands in it.
        stdin.frames.put({"jsonrpc": "2.0", "id": 9, "method": "chat.send"})
        deadline = time.monotonic() + 2.0
        while _reader_threads(earlier) and time.monotonic() < deadline:
            time.sleep(0.02)

    assert _reader_threads(earlier) == []
    orphaned = [r for r in caplog.records if "has no consumer" in r.getMessage()]
    assert len(orphaned) == 1
    assert "method=chat.send" in orphaned[0].getMessage()
