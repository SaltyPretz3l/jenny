"""Tests for sidecar.runtime.message_reader — BackgroundMessageReader."""

from __future__ import annotations

import io
import threading
import time

import pytest

from sidecar.runtime.framing import RecoverablePayloadError, read_framed_message
from sidecar.runtime.message_reader import BackgroundMessageReader


def _immediate_reader(messages: list[dict[str, object]]) -> callable:
    """Return a reader callable that yields messages then raises EOFError."""
    iterator = iter(messages)

    def _read() -> dict[str, object]:
        try:
            return next(iterator)
        except StopIteration:
            raise EOFError("end of messages") from None

    return _read


def test_read_single_message() -> None:
    reader = BackgroundMessageReader(_immediate_reader([{"id": 1}]))
    result = reader.read(timeout_seconds=2.0)
    assert result == {"id": 1}
    reader.close()


def test_read_multiple_messages_in_order() -> None:
    messages = [{"id": i} for i in range(5)]
    reader = BackgroundMessageReader(_immediate_reader(messages))
    results = [reader.read(timeout_seconds=2.0) for _ in range(5)]
    assert [r["id"] for r in results] == [0, 1, 2, 3, 4]
    reader.close()


def test_read_after_exhaustion_raises_terminal_error() -> None:
    reader = BackgroundMessageReader(_immediate_reader([{"id": 1}]))
    reader.read(timeout_seconds=2.0)
    with pytest.raises(EOFError):
        reader.read(timeout_seconds=1.0)
    reader.close()


def test_read_timeout_raises_timeout_error() -> None:
    barrier = threading.Event()

    def _blocking_reader() -> dict[str, object]:
        barrier.wait()
        return {"id": 1}

    reader = BackgroundMessageReader(_blocking_reader)
    with pytest.raises(TimeoutError, match="timed out"):
        reader.read(timeout_seconds=0.05)
    barrier.set()
    reader.close()


def test_close_before_read_raises_eof_error() -> None:
    reader = BackgroundMessageReader(_immediate_reader([{"id": 1}]))
    reader.close()
    with pytest.raises(EOFError, match="closed"):
        reader.read(timeout_seconds=0.1)


def test_reader_exception_propagates() -> None:
    def _failing_reader() -> dict[str, object]:
        raise RuntimeError("connection lost")

    reader = BackgroundMessageReader(_failing_reader)
    with pytest.raises(RuntimeError, match="connection lost"):
        reader.read(timeout_seconds=2.0)
    reader.close()


def test_recoverable_payload_error_does_not_stop_following_messages() -> None:
    calls = 0

    def _reader() -> dict[str, object]:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RecoverablePayloadError("malformed JSON body")
        if calls == 2:
            return {"id": 2}
        raise EOFError("done")

    reader = BackgroundMessageReader(_reader)
    with pytest.raises(RecoverablePayloadError, match="malformed JSON"):
        reader.read(timeout_seconds=2.0)
    assert reader.read(timeout_seconds=2.0) == {"id": 2}
    reader.close()


def test_double_close_is_safe() -> None:
    reader = BackgroundMessageReader(_immediate_reader([]))
    reader.close()
    reader.close()  # Should not raise.


def test_lazy_start() -> None:
    """Thread should not start until first read."""
    reader = BackgroundMessageReader(_immediate_reader([{"id": 1}]))
    assert reader._started is False
    reader.read(timeout_seconds=2.0)
    assert reader._started is True
    reader.close()


def test_bounded_backpressure_does_not_drop_messages() -> None:
    """When the queue is full, the pump should wait instead of dropping."""
    count = 200  # Well above _QUEUE_MAXSIZE (128).
    messages = [{"id": i} for i in range(count)]
    reader = BackgroundMessageReader(_immediate_reader(messages))

    results = []
    for _ in range(count):
        results.append(reader.read(timeout_seconds=5.0))

    assert len(results) == count
    assert [r["id"] for r in results] == list(range(count))
    reader.close()


def test_undecodable_frame_does_not_kill_the_stdin_pump() -> None:
    """End-to-end over the REAL framing decoder, not a fake reader.

    A frame whose body is fully consumed but undecodable (here: nesting past the
    recursion budget) must arrive as a per-message RecoverablePayloadError. Before
    the framing guard it escaped read_framed_message as a raw RecursionError, hit
    _pump's `except BaseException`, and was cached as _terminal_error — so the
    following valid request was never delivered and the pump never ran again.
    """
    deep = b'{"a": ' + b"[" * 1200 + b"]" * 1200 + b"}"
    later = b'{"jsonrpc":"2.0","id":9,"method":"shutdown"}'
    stream = io.BytesIO(
        f"Content-Length: {len(deep)}\r\n\r\n".encode()
        + deep
        + f"Content-Length: {len(later)}\r\n\r\n".encode()
        + later
    )

    def _read() -> dict[str, object]:
        return read_framed_message(
            stdin_buffer=stream,
            content_length_header="Content-Length",
            max_content_length_bytes=10 * 1024 * 1024,
        )

    reader = BackgroundMessageReader(_read)
    with pytest.raises(RecoverablePayloadError, match="nesting is too deep"):
        reader.read(timeout_seconds=2.0)
    assert reader.read(timeout_seconds=2.0)["id"] == 9
    reader.close()


def test_reader_exhaustion_does_not_hang() -> None:
    # A bare ValueError stands in for a genuinely terminal transport failure
    # (TransportDesynchronizedError is a ValueError subclass). Payload-decode
    # failures are NOT in this class — framing normalizes every one of them to
    # RecoverablePayloadError, covered above.
    def _failing_reader() -> dict[str, object]:
        raise ValueError("corrupted data")

    reader = BackgroundMessageReader(_failing_reader)
    with pytest.raises(ValueError, match="corrupted data"):
        reader.read(timeout_seconds=2.0)

    start_time = time.monotonic()
    with pytest.raises(ValueError, match="corrupted data"):
        reader.read(timeout_seconds=5.0)
    duration = time.monotonic() - start_time
    assert duration < 0.1
    reader.close()
