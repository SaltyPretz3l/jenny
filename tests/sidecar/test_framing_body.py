from __future__ import annotations

import io
from unittest.mock import Mock

from sidecar.runtime.framing import (
    encode_framed_body,
    write_framed_body,
    write_framed_message,
)

HEADER = "Content-Length"


def test_write_framed_body_emits_the_exact_wire_bytes() -> None:
    # Golden bytes, not a comparison against write_framed_message: that helper
    # now delegates to write_framed_body, so comparing the two would move
    # together under any encoding regression and assert nothing.
    stdout = io.BytesIO()

    write_framed_body(
        stdout_buffer=stdout,
        content_length_header=HEADER,
        body=encode_framed_body({"jsonrpc": "2.0", "id": 7}),
    )

    assert stdout.getvalue() == b'Content-Length: 27\r\n\r\n{"jsonrpc": "2.0", "id": 7}'


def test_write_framed_body_counts_utf8_bytes_not_characters() -> None:
    # Content-Length is a BYTE count and the encoder keeps non-ASCII literal
    # (ensure_ascii=False), so CJK and emoji must widen the declared length.
    stdout = io.BytesIO()
    body = encode_framed_body({"text": "漢字🙂"})

    write_framed_body(
        stdout_buffer=stdout,
        content_length_header=HEADER,
        body=body,
    )

    written = stdout.getvalue()
    header, _, payload = written.partition(b"\r\n\r\n")
    assert header == b"Content-Length: 22"
    assert payload == '{"text": "漢字🙂"}'.encode("utf-8")
    assert len(payload) == 22
    assert len('{"text": "漢字🙂"}') == 15


def test_write_framed_message_round_trips_through_the_body_writer() -> None:
    message = {"jsonrpc": "2.0", "id": 7, "result": {"text": "漢字🙂"}}
    encoded = io.BytesIO()
    pre_encoded = io.BytesIO()

    write_framed_message(
        stdout_buffer=encoded,
        content_length_header=HEADER,
        message=message,
    )
    write_framed_body(
        stdout_buffer=pre_encoded,
        content_length_header=HEADER,
        body=encode_framed_body(message),
    )

    assert pre_encoded.getvalue() == encoded.getvalue()


def test_write_framed_body_combines_header_and_body_in_one_write() -> None:
    # The point of the change: one write syscall per frame, not two. This is
    # the assertion that fails against the pre-change two-write form.
    stdout = Mock()
    body = encode_framed_body({"jsonrpc": "2.0", "id": 9})

    write_framed_body(
        stdout_buffer=stdout,
        content_length_header=HEADER,
        body=body,
    )

    expected_header = f"{HEADER}: {len(body)}\r\n\r\n".encode("utf-8")
    stdout.write.assert_called_once_with(expected_header + body)
    stdout.flush.assert_called_once_with()
