"""Bounded output capture helpers split out of ``owned_process``."""

from __future__ import annotations

import io

from sidecar.ai.tools.builtins import owned_process
from sidecar.ai.tools.builtins.owned_process_capture import (
    PIPE_READ_CHUNK_BYTES,
    CapturedProcessOutput,
    StreamCapture,
    captured_output_with_diagnostics,
    start_output_reader,
)


def test_stream_capture_counts_every_byte_but_retains_only_its_limit() -> None:
    capture = StreamCapture(limit_bytes=4)

    capture.append(b"abc")
    capture.append(b"defgh")

    assert bytes(capture.data) == b"abcd"
    assert capture.total_bytes == 8


def test_captured_output_reports_truncation_and_read_errors() -> None:
    stdout = StreamCapture(limit_bytes=2)
    stdout.append(b"hello")
    stderr = StreamCapture(limit_bytes=8)
    stderr.read_error = "OSError"

    output, incomplete, errors = captured_output_with_diagnostics(
        already_incomplete=False, stdout_capture=stdout, stderr_capture=stderr
    )

    assert output.stdout == "he"
    assert output.counters() == {
        "stdout_bytes": 5,
        "stderr_bytes": 0,
        "captured_bytes": 2,
        "discarded_bytes": 3,
    }
    assert output.truncated is True
    assert incomplete is True
    assert errors == {"stderr": "OSError"}


def test_captured_output_without_errors_keeps_the_prior_incomplete_flag() -> None:
    output, incomplete, errors = captured_output_with_diagnostics(
        already_incomplete=False,
        stdout_capture=StreamCapture(limit_bytes=4),
        stderr_capture=StreamCapture(limit_bytes=4),
    )

    assert output == CapturedProcessOutput("", "", 0, 0, 0, 0)
    assert (incomplete, errors) == (False, {})


def test_output_reader_drains_the_pipe_through_a_failing_tap() -> None:
    payload = b"x" * (PIPE_READ_CHUNK_BYTES + 10)
    capture = StreamCapture(limit_bytes=len(payload))
    tapped: list[tuple[str, int]] = []

    def _tap(stream: str, chunk: bytes) -> None:
        tapped.append((stream, len(chunk)))
        raise RuntimeError("a broken tap must not stop the drain")

    reader = start_output_reader(io.BytesIO(payload), capture, "stdout", on_chunk=_tap)
    reader.join(timeout=5)

    assert not reader.is_alive()
    assert reader.name == "owned-process-stdout"
    assert bytes(capture.data) == payload
    assert tapped == [("stdout", PIPE_READ_CHUNK_BYTES), ("stdout", 10)]


def test_output_reader_records_a_closed_pipe_as_a_read_error() -> None:
    pipe = io.BytesIO(b"data")
    pipe.close()
    capture = StreamCapture(limit_bytes=8)

    reader = start_output_reader(pipe, capture, "stderr")
    reader.join(timeout=5)

    assert capture.read_error == "ValueError"


def test_owned_process_keeps_its_public_names_and_reader_seam() -> None:
    assert owned_process.CapturedProcessOutput is CapturedProcessOutput
    assert owned_process.OwnedProcessService._start_reader is start_output_reader
