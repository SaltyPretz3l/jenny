"""The stdin gate: no pending ReadFile on the inherited pipe while idle.

Regression for the read_file/RapidOCR hang of 2026-09-22: the builtin server's
stdin pump sat in ``ReadFile`` on its stdin pipe while the tool handler imported
numpy on the dispatch thread; OpenBLAS's DLL initializer queries the stdin
handle and blocked behind that pending read until the request timed out.
"""
from __future__ import annotations

import io
import os
import subprocess
import sys
import textwrap
import threading
from pathlib import Path

import pytest

from sidecar.runtime import pipe_stdin
from sidecar.runtime.pipe_stdin import GatedPipeReader, gated_stdin

REPO_ROOT = Path(__file__).resolve().parents[3]
WINDOWS_ONLY = pytest.mark.skipif(os.name != "nt", reason="Windows pipe semantics")


class _ScriptedRaw:
    """A raw stream that returns one scripted chunk per read (short reads)."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)
        self.reads = 0

    def read(self, size: int) -> bytes:
        self.reads += 1
        if not self._chunks:
            return b""
        chunk = self._chunks.pop(0)
        assert len(chunk) <= size
        return chunk

    def fileno(self) -> int:
        return 99


@pytest.fixture
def no_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pipe_stdin, "wait_for_pipe_bytes", lambda handle: None)


def test_readline_reassembles_lines_split_across_short_reads(no_wait: None) -> None:
    reader = GatedPipeReader(_ScriptedRaw([b"ab", b"c\nde", b"f\n", b"tail"]), handle=1)

    assert reader.readline() == b"abc\n"
    assert reader.readline() == b"def\n"
    assert reader.readline() == b"tail"
    assert reader.readline() == b""


def test_readline_honors_the_size_limit_like_buffered_reader(no_wait: None) -> None:
    reader = GatedPipeReader(_ScriptedRaw([b"Content-Length: 12\r\n", b"\r\nbody"]), handle=1)

    assert reader.readline(8) == b"Content-"
    assert reader.readline(100) == b"Length: 12\r\n"
    assert reader.readline(100) == b"\r\n"
    assert reader.read(4) == b"body"


def test_read_blocks_until_the_exact_size_or_eof(no_wait: None) -> None:
    raw = _ScriptedRaw([b"12", b"345", b"6789"])
    reader = GatedPipeReader(raw, handle=1)

    assert reader.read(5) == b"12345"
    assert reader.read(10) == b"6789"
    assert reader.read(1) == b""
    assert reader.read() == b""


def test_gated_stdin_leaves_non_pipe_streams_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pipe_stdin, "pipe_handle", lambda stream: None)
    buffered = io.BufferedReader(io.BytesIO(b"x"))
    plain = io.BytesIO(b"x")

    assert gated_stdin(buffered) is buffered
    assert gated_stdin(plain) is plain
    assert gated_stdin(None) is None


def test_shared_gated_stdin_reuses_one_reader_per_raw_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pipe_stdin, "pipe_handle", lambda stream: 7)
    monkeypatch.setattr(pipe_stdin, "_shared_readers", [])
    first = io.BufferedReader(io.BytesIO(b"a"))
    second = io.BufferedReader(io.BytesIO(b"b"))

    reader = pipe_stdin.shared_gated_stdin(first)

    assert isinstance(reader, GatedPipeReader)
    assert pipe_stdin.shared_gated_stdin(first) is reader
    replacement = pipe_stdin.shared_gated_stdin(second)
    assert replacement is not reader and replacement.raw is second.raw


@WINDOWS_ONLY
def test_pipe_handle_distinguishes_pipes_from_files(tmp_path: Path) -> None:
    read_fd, write_fd = os.pipe()
    try:
        with io.FileIO(read_fd, closefd=False) as pipe_end:
            assert pipe_stdin.pipe_handle(pipe_end) is not None
    finally:
        os.close(read_fd)
        os.close(write_fd)
    regular = tmp_path / "regular.txt"
    regular.write_bytes(b"data")
    with regular.open("rb") as handle:
        assert pipe_stdin.pipe_handle(handle.raw) is None


@WINDOWS_ONLY
def test_gated_reader_wakes_on_bytes_and_on_writer_close() -> None:
    read_fd, write_fd = os.pipe()
    raw = io.FileIO(read_fd, closefd=True)
    buffered = io.BufferedReader(raw)  # kept alive: its finalizer closes raw
    reader = gated_stdin(buffered)
    assert isinstance(reader, GatedPipeReader)

    threading.Timer(0.2, lambda: os.write(write_fd, b"hello\nrest")).start()
    assert reader.readline() == b"hello\n"
    threading.Timer(0.2, lambda: os.close(write_fd)).start()
    assert reader.read() == b"rest"
    assert reader.readline() == b""
    raw.close()


_IMPORT_UNDER_PUMP = textwrap.dedent(
    """
    import sys, time
    sys.path.insert(0, {repo!r})
    from sidecar.ai.mcp import builtin_server_io
    builtin_server_io.configure_stdio()
    builtin_server_io.start_stdin_pump()
    time.sleep(0.3)
    started = time.time()
    import numpy
    print("numpy ok", round(time.time() - started, 2), flush=True)
    """
)

_IMPORT_UNDER_FRAMED_READER = textwrap.dedent(
    """
    import sys, threading, time
    sys.path.insert(0, {repo!r})
    from sidecar import server
    threading.Thread(target=server.read_message, daemon=True).start()
    time.sleep(0.3)
    started = time.time()
    import numpy
    print("numpy ok", round(time.time() - started, 2), flush=True)
    """
)


@WINDOWS_ONLY
@pytest.mark.parametrize("script", [_IMPORT_UNDER_PUMP, _IMPORT_UNDER_FRAMED_READER])
def test_numpy_imports_while_a_stdin_reader_waits_on_a_pipe(script: str) -> None:
    pytest.importorskip("numpy")
    process = subprocess.Popen(
        [sys.executable, "-c", script.format(repo=str(REPO_ROOT))],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    # stdin stays open for the whole import: closing it would end the pending
    # read and hide the deadlock this test exists to catch.
    captured: list[str] = []
    drain = threading.Thread(target=lambda: captured.append(process.stdout.read()), daemon=True)
    drain.start()
    drain.join(timeout=30)
    if drain.is_alive():
        process.kill()
        pytest.fail("import numpy deadlocked behind the pending stdin read")
    stderr = process.stderr.read()
    process.stdin.close()
    process.wait(timeout=10)
    # configure_stdio routes ordinary prints to stderr; the framed reader does not.
    assert "numpy ok" in captured[0] + stderr, stderr
