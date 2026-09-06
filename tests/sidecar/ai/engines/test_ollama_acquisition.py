from __future__ import annotations

import io
import json
import socket
from collections.abc import Callable
from typing import Any

import pytest

from sidecar.ai.engines.ollama_acquisition import (
    _MAX_PULL_SOCKET_TIMEOUT_SECONDS,
    _PullDeadline,
    pull_ollama_model,
)
from sidecar.ai.engines.ollama_stream_transport import MAX_PROVIDER_STREAM_LINE_BYTES


class _Response(io.BytesIO):
    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()


class _ChunkedResponse:
    """HTTPResponse-shaped fake whose read() would buffer provider chunks."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = iter(chunks)
        self.read_calls = 0
        self.read1_calls = 0

    def __enter__(self) -> "_ChunkedResponse":
        return self

    def __exit__(self, *_args: Any) -> None:
        return None

    def read(self, _size: int) -> bytes:
        self.read_calls += 1
        raise AssertionError("buffering read() must not be used for streaming NDJSON")

    def read1(self, _size: int) -> bytes:
        self.read1_calls += 1
        return next(self._chunks, b"")


class _DeadlineResponse(_ChunkedResponse):
    def __init__(self, chunks: list[bytes], expire: Callable[[], None]) -> None:
        super().__init__(chunks)
        self._expire = expire

    def read1(self, size: int) -> bytes:
        chunk = super().read1(size)
        self._expire()
        return chunk


def _stream(*records: object) -> _Response:
    body = b"".join(json.dumps(record).encode("utf-8") + b"\n" for record in records)
    return _Response(body)


def test_progressing_pull_normalizes_monotonic_progress(monkeypatch) -> None:
    records = [
        {"status": "pulling manifest"},
        *(
            {"status": "downloading", "completed": index, "total": 81}
            for index in range(1, 82)
        ),
        {"status": "success"},
    ]
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.urllib.request.urlopen",
        lambda *_args, **_kwargs: _stream(*records),
    )
    progress: list[dict[str, Any]] = []

    pull_ollama_model(
        host="http://localhost:11434",
        model="ornith:9b",
        timeout_seconds=600,
        progress_callback=progress.append,
    )

    assert progress[0]["state"] == "model_acquiring"
    assert progress[-1]["percent"] == 100.0
    assert [item["percent"] for item in progress] == sorted(
        item["percent"] for item in progress
    )
    assert [item["completed_bytes"] for item in progress] == sorted(
        item["completed_bytes"] for item in progress
    )


def test_pull_consumes_chunked_progress_with_incremental_read1(monkeypatch) -> None:
    response = _ChunkedResponse(
        [
            b'{"status":"downloading","completed":1,',
            b'"total":2}\n',
            b'{"status":"success"}\n',
        ]
    )
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.urllib.request.urlopen",
        lambda *_args, **_kwargs: response,
    )
    progress: list[dict[str, Any]] = []

    pull_ollama_model(
        host="http://localhost:11434",
        model="ornith:9b",
        timeout_seconds=600,
        progress_callback=progress.append,
    )

    assert response.read_calls == 0
    assert response.read1_calls >= 3
    assert [item["completed_bytes"] for item in progress] == [0, 1, 1]
    assert progress[-1]["percent"] == 100.0


def test_pull_enforces_total_deadline_and_bounds_each_socket_operation(monkeypatch) -> None:
    clock = [100.0]
    response = _DeadlineResponse(
        [b'{"status":"downloading","completed":1,"total":2}\n'],
        lambda: clock.__setitem__(0, 102.0),
    )
    observed_timeout: list[float] = []

    def open_response(*_args: Any, **kwargs: Any) -> _DeadlineResponse:
        observed_timeout.append(float(kwargs["timeout"]))
        return response

    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.urllib.request.urlopen",
        open_response,
    )
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.monotonic",
        lambda: clock[0],
    )

    with pytest.raises(RuntimeError, match="total timeout"):
        pull_ollama_model(
            host="http://localhost:11434",
            model="ornith:9b",
            timeout_seconds=1.0,
        )

    assert observed_timeout == [1.0]


@pytest.mark.parametrize(
    "response, expected",
    [
        (_Response(b"not-json\n"), "malformed NDJSON"),
        (_stream(["not", "an", "object"]), "non-object"),
        (_stream({"error": "disk full"}), "disk full"),
        (_stream({"status": "downloading", "completed": -1}), "invalid completed"),
        (_stream({"status": "downloading"}), "ended before success"),
    ],
)
def test_pull_fails_closed_on_invalid_or_failed_stream(monkeypatch, response, expected) -> None:
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.urllib.request.urlopen",
        lambda *_args, **_kwargs: response,
    )
    with pytest.raises(RuntimeError, match=expected):
        pull_ollama_model(
            host="http://localhost:11434",
            model="ornith:9b",
            timeout_seconds=600,
        )


class _VerifyGapResponse(_ChunkedResponse):
    """Fake /api/pull stream whose ``recv`` times out during a silent gap.

    Ollama emits ``verifying sha256 digest`` once, then sends nothing until
    ``writing manifest``. This models that gap: the chunk following the verify
    line only arrives if the caller's socket timeout out-waits ``gap_seconds``;
    otherwise ``recv`` raises ``socket.timeout`` exactly as a real socket would.
    """

    def __init__(self, chunks: list[bytes], *, socket_timeout: float, gap_seconds: float) -> None:
        super().__init__(chunks)
        self._socket_timeout = socket_timeout
        self._gap_seconds = gap_seconds
        self._served_verify = False

    def read1(self, size: int) -> bytes:
        chunk = _ChunkedResponse.read1(self, size)
        if chunk == b'{"status":"verifying sha256 digest"}\n':
            self._served_verify = True
            return chunk
        if self._served_verify:
            self._served_verify = False
            if self._gap_seconds > self._socket_timeout:
                raise socket.timeout("timed out")
        return chunk


def test_pull_survives_silent_verify_gap_within_socket_timeout(monkeypatch) -> None:
    # A 40s silent verify gap trips the pre-regression 15s socket timeout but is
    # well within the verify-sized ceiling; the pull must reach success and the
    # socket timeout urlopen receives must be the widened value, not 15s.
    chunks = [
        b'{"status":"pulling manifest"}\n',
        b'{"status":"verifying sha256 digest"}\n',
        b'{"status":"writing manifest"}\n',
        b'{"status":"success"}\n',
    ]
    observed_timeout: list[float] = []

    def open_response(*_args: Any, **kwargs: Any) -> _VerifyGapResponse:
        timeout = float(kwargs["timeout"])
        observed_timeout.append(timeout)
        return _VerifyGapResponse(chunks, socket_timeout=timeout, gap_seconds=40.0)

    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.urllib.request.urlopen",
        open_response,
    )
    progress: list[dict[str, Any]] = []

    pull_ollama_model(
        host="http://localhost:11434",
        model="ornith:9b",
        timeout_seconds=600,
        progress_callback=progress.append,
    )

    # urlopen received the verify-sized socket timeout, not the old 15s cap.
    assert observed_timeout == [_MAX_PULL_SOCKET_TIMEOUT_SECONDS]
    assert _MAX_PULL_SOCKET_TIMEOUT_SECONDS >= 300.0
    assert progress[-1]["percent"] == 100.0
    assert progress[-1]["status"] == "Model download complete"


def test_pull_socket_timeout_gap_beyond_ceiling_still_aborts(monkeypatch) -> None:
    # The widened socket timeout is still a real per-recv bound: a gap that
    # out-lasts even the verify-sized ceiling raises (deadline honored), so the
    # fix does not silently swallow socket timeouts.
    chunks = [
        b'{"status":"verifying sha256 digest"}\n',
        b'{"status":"success"}\n',
    ]

    def open_response(*_args: Any, **kwargs: Any) -> _VerifyGapResponse:
        timeout = float(kwargs["timeout"])
        return _VerifyGapResponse(
            chunks, socket_timeout=timeout, gap_seconds=timeout + 1.0
        )

    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.urllib.request.urlopen",
        open_response,
    )

    with pytest.raises(RuntimeError, match="Failed to pull model"):
        pull_ollama_model(
            host="http://localhost:11434",
            model="ornith:9b",
            timeout_seconds=600,
        )


def test_pull_fails_closed_on_oversized_ndjson(monkeypatch) -> None:
    response = _Response(b'{' + (b'x' * MAX_PROVIDER_STREAM_LINE_BYTES) + b'}\n')
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.urllib.request.urlopen",
        lambda *_args, **_kwargs: response,
    )
    with pytest.raises(Exception, match="bounded|maximum|exceed"):
        pull_ollama_model(
            host="http://localhost:11434",
            model="ornith:9b",
            timeout_seconds=600,
        )


# ---------------------------------------------------------------------------
# F18c: the force-close timer must ride the ABSOLUTE deadline.
#
# The deadline instant is fixed at construction and expired()/raise_if_expired()
# check it on every NDJSON line, so any pull that PRODUCES output was already
# bounded correctly. The residue was time spent blocked in I/O: the timer was
# scheduled for a full fresh `timeout_seconds` measured from AFTER connect and
# headers, so a stalled connect plus a stalled read could overrun the total by
# the socket ceiling (~5 min) and orphan a sidecar pull that outlives the
# Electron-side abort.
# ---------------------------------------------------------------------------


class _ClosableResponse:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


def test_pull_deadline_timer_is_scheduled_against_the_absolute_deadline(
    monkeypatch,
) -> None:
    clock = [100.0]
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.monotonic",
        lambda: clock[0],
    )
    deadline = _PullDeadline(600.0)

    # A stalled connect + headers burns 300s before start() is reached.
    clock[0] = 400.0
    deadline.start(_ClosableResponse())
    try:
        assert deadline._timer is not None  # noqa: SLF001
        assert deadline._timer.interval == pytest.approx(300.0), (  # noqa: SLF001
            "the timer must fire at the absolute deadline, not restart the budget"
        )
    finally:
        deadline.close()


def test_pull_deadline_remaining_seconds_tracks_the_construction_deadline(
    monkeypatch,
) -> None:
    clock = [100.0]
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.monotonic",
        lambda: clock[0],
    )
    deadline = _PullDeadline(60.0)

    assert deadline.remaining_seconds() == pytest.approx(60.0)
    clock[0] = 130.0
    assert deadline.remaining_seconds() == pytest.approx(30.0)
    clock[0] = 200.0
    assert deadline.remaining_seconds() == 0.0, "must clamp, never go negative"


def test_pull_connect_timeout_is_bounded_by_the_remaining_total_budget(
    monkeypatch,
) -> None:
    """A slow start must not hand urlopen a fresh socket-ceiling-sized budget."""
    readings = iter([100.0])
    current = [100.0]

    def _clock() -> float:
        current[0] = next(readings, 500.0)
        return current[0]

    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.monotonic",
        _clock,
    )
    observed_timeout: list[float] = []

    def open_response(*_args: Any, **kwargs: Any) -> _Response:
        observed_timeout.append(float(kwargs["timeout"]))
        return _stream({"status": "success"})

    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_acquisition.urllib.request.urlopen",
        open_response,
    )

    pull_ollama_model(
        host="http://localhost:11434",
        model="ornith:9b",
        timeout_seconds=600,
    )

    # Deadline fixed at 100+600=700; by connect time the clock reads 500, so
    # only 200s remain. The socket ceiling alone would have allowed 300s.
    assert observed_timeout == [pytest.approx(200.0)]
    assert observed_timeout[0] < _MAX_PULL_SOCKET_TIMEOUT_SECONDS
