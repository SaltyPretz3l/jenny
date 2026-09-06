from __future__ import annotations

import io

import pytest

from sidecar.runtime.bounded_io import (
    BoundedBinaryReader,
    BoundedIOError,
    iter_bounded_byte_lines,
    read_bounded_bytes,
)


def test_binary_reader_preserves_body_bytes_buffered_after_header() -> None:
    reader = BoundedBinaryReader(io.BytesIO(b"Content-Length: 2\r\n\r\n{}"))

    assert reader.read_line(max_bytes=64) == b"Content-Length: 2\r\n"
    assert reader.read_line(max_bytes=64) == b"\r\n"
    assert reader.read_exact(2) == b"{}"


def test_binary_reader_rejects_never_newline_stream_at_limit() -> None:
    reader = BoundedBinaryReader(io.BytesIO(b"x" * 65), read_chunk_bytes=8)

    with pytest.raises(BoundedIOError, match="line exceeds"):
        reader.read_line(max_bytes=64)


def test_chunk_line_iterator_handles_split_records_and_total_limit() -> None:
    assert list(
        iter_bounded_byte_lines(
            [b'{"a":', b"1}\n{", b'"b":2}'],
            max_line_bytes=16,
            max_total_bytes=32,
        )
    ) == [b'{"a":1}\n', b'{"b":2}']

    with pytest.raises(BoundedIOError, match="total byte"):
        list(
            iter_bounded_byte_lines(
                [b"1234", b"5"],
                max_line_bytes=8,
                max_total_bytes=4,
            )
        )


def test_read_bounded_bytes_rejects_before_full_materialization() -> None:
    with pytest.raises(BoundedIOError, match="byte limit"):
        read_bounded_bytes(io.BytesIO(b"x" * 129), max_bytes=128)

