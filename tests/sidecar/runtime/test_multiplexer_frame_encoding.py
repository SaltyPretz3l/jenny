from __future__ import annotations

import logging
import threading
from unittest.mock import Mock

import pytest

from sidecar.runtime import framing, multiplexer


def _message(index: int, *, text: str | None = None) -> dict[str, object]:
    return {
        "jsonrpc": "2.0",
        "method": "chat.token",
        "params": {"request_id": "req_encoding", "delta": text or str(index)},
    }


def test_outbound_frames_are_encoded_once_end_to_end(monkeypatch) -> None:
    original_encode = framing.encode_framed_body
    encoded_bodies: list[bytes] = []

    def counted_encode(message: dict[str, object]) -> bytes:
        body = original_encode(message)
        encoded_bodies.append(body)
        return body

    monkeypatch.setattr(framing, "encode_framed_body", counted_encode)
    monkeypatch.setattr(multiplexer, "encode_framed_body", counted_encode)
    stdout = Mock()
    written_bodies: list[bytes] = []

    def write_frame_body(body: bytes) -> None:
        written_bodies.append(body)
        framing.write_framed_body(
            stdout_buffer=stdout,
            content_length_header="Content-Length",
            body=body,
        )

    writer = multiplexer.PrioritizedMessageWriter(
        write_message=lambda message: framing.write_framed_message(
            stdout_buffer=stdout,
            content_length_header="Content-Length",
            message=message,
        ),
        write_frame_body=write_frame_body,
        logger=logging.getLogger("tests.multiplexer.frame_encoding"),
    )
    messages = [_message(index) for index in range(5)]
    writer.enqueue_batch(messages, lane="data")

    assert writer.close(join_timeout_seconds=1.0).drained is True
    assert len(encoded_bodies) == len(messages)
    assert len(written_bodies) == len(messages)
    assert all(
        written is encoded
        for written, encoded in zip(written_bodies, encoded_bodies, strict=True)
    )


def test_frame_size_property_matches_encoded_body() -> None:
    message = _message(1)
    body = framing.encode_framed_body(message)
    frame = multiplexer._OutboundFrame(  # noqa: SLF001
        body=body,
        message=message,
        lane="data",
    )

    assert frame.body is body
    assert frame.encoded_size == len(frame.body)
    assert frame.encoded_size == len(framing.encode_framed_body(message))


def test_every_frame_is_written_through_the_body_writer() -> None:
    bodies: list[bytes] = []
    writer = multiplexer.PrioritizedMessageWriter(
        write_message=lambda _message: pytest.fail("message writer must not be used"),
        write_frame_body=bodies.append,
        logger=logging.getLogger("tests.multiplexer.body_writer"),
    )
    writer.enqueue({"jsonrpc": "2.0", "id": 1, "result": {}}, control=True)
    writer.enqueue_batch([_message(1), _message(2)], lane="terminal")
    writer.enqueue(_message(3), control=False)

    assert writer.close(join_timeout_seconds=1.0).drained is True
    assert len(bodies) == 4
    assert bodies[-1] == framing.encode_framed_body(_message(3))


def test_frames_carry_no_message_copy_when_a_body_writer_is_wired() -> None:
    # The frame already holds the encoded body; retaining the source dict too
    # would double queue retention for every buffered token.
    writer = multiplexer.PrioritizedMessageWriter(
        write_message=lambda _message: None,
        write_frame_body=lambda _body: None,
        logger=logging.getLogger("tests.multiplexer.no_message_copy"),
    )
    entered = threading.Event()
    release = threading.Event()
    writer._write_frame_body = lambda _body: (  # noqa: SLF001
        entered.set(), release.wait(timeout=2.0)
    )
    writer.enqueue({"jsonrpc": "2.0", "id": 1, "result": {}}, control=True)
    assert entered.wait(timeout=1.0)
    writer.enqueue(_message(1), control=False)

    try:
        queued = writer._data_queue.queue[0].frames[0]  # noqa: SLF001
        assert queued.message is None
        assert queued.body == framing.encode_framed_body(_message(1))
        assert queued.encoded_size == len(queued.body)
    finally:
        release.set()
        writer.close(join_timeout_seconds=1.0)


def test_control_frames_are_not_delayed_behind_queued_data() -> None:
    # Control priority is the reason the writer exists: a queued approval
    # request must not wait behind a backlog of chat tokens. The pump commits
    # to one batch at a time, so control overtakes after at most one frame.
    entered = threading.Event()
    release = threading.Event()
    order: list[str] = []

    def write_frame_body(body: bytes) -> None:
        decoded = body.decode("utf-8")
        order.append("control" if '"id"' in decoded else "data")
        if len(order) == 1:
            entered.set()
            release.wait(timeout=2.0)

    writer = multiplexer.PrioritizedMessageWriter(
        write_message=lambda _message: None,
        write_frame_body=write_frame_body,
        logger=logging.getLogger("tests.multiplexer.control_priority"),
    )
    writer.enqueue({"jsonrpc": "2.0", "id": 1, "result": {}}, control=True)
    assert entered.wait(timeout=1.0)
    for index in range(60):
        writer.enqueue(_message(index), control=False)
    writer.enqueue({"jsonrpc": "2.0", "id": 2, "result": {}}, control=True)
    release.set()

    assert writer.close(join_timeout_seconds=2.0).drained is True
    assert order.count("control") == 2
    # The second control frame lands after at most one already-committed data
    # frame, never behind the whole 60-frame backlog.
    assert order.index("control", 1) <= 2


def test_terminal_batch_keeps_notifications_ahead_of_the_response() -> None:
    # The terminal lane's ordering contract, exercised through the body writer
    # that production actually wires. Without this the batched write path has
    # no standing ordering coverage.
    entered = threading.Event()
    release = threading.Event()
    order: list[str] = []

    def write_frame_body(body: bytes) -> None:
        payload = body.decode("utf-8")
        if '"chat.token"' in payload:
            order.append("token")
        elif '"chat.done"' in payload:
            order.append("done")
        else:
            order.append("response")
        if len(order) == 1:
            entered.set()
            release.wait(timeout=2.0)

    writer = multiplexer.PrioritizedMessageWriter(
        write_message=lambda _message: None,
        write_frame_body=write_frame_body,
        logger=logging.getLogger("tests.multiplexer.terminal_order"),
    )
    writer.enqueue({"jsonrpc": "2.0", "id": 1, "result": {}}, control=True)
    assert entered.wait(timeout=1.0)
    for index in range(40):
        writer.enqueue(_message(index), control=False)
    writer.enqueue_batch(
        [
            _message(99),
            {"jsonrpc": "2.0", "method": "chat.done", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "result": {"ok": True}},
        ],
        lane="terminal",
    )
    release.set()

    assert writer.close(join_timeout_seconds=2.0).drained is True
    assert order[-3:] == ["token", "done", "response"]


def test_non_ascii_backpressure_uses_utf8_wire_body_size() -> None:
    entered = threading.Event()
    release = threading.Event()

    def blocking_write(_message: dict[str, object]) -> None:
        entered.set()
        release.wait(timeout=2.0)

    writer = multiplexer.PrioritizedMessageWriter(
        write_message=blocking_write,
        logger=logging.getLogger("tests.multiplexer.unicode_size"),
    )
    writer.enqueue({"jsonrpc": "2.0", "id": 1, "result": {}}, control=True)
    assert entered.wait(timeout=1.0)
    message = _message(1, text="漢字🙂")
    expected_body = framing.encode_framed_body(message)
    writer.enqueue(message, control=False)

    try:
        assert writer.stats()["data_buffered_bytes"] == len(expected_body)
        assert len(expected_body) > len(expected_body.decode("utf-8"))
    finally:
        release.set()
        writer.close(join_timeout_seconds=1.0)
