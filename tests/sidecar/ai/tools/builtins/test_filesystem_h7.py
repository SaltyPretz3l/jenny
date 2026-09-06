"""H7: Cross-platform file I/O tests for read_file_tool encoding and line endings."""

from __future__ import annotations

import base64
import builtins
import hashlib
import importlib
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_STALE_READ_SNAPSHOT,
)
from sidecar.ai.tools import workspace as workspace_module
from sidecar.ai.tools.builtins import file_state as file_state_module
from sidecar.ai.tools.builtins import filesystem as filesystem_module
from sidecar.ai.tools.builtins import filesystem_content
from sidecar.ai.tools.builtins.file_state import (
    READ_SNAPSHOT_SCOPE_FULL,
    ReadSnapshot,
    encode_utf8_text_bounded,
    validate_current_snapshot,
)
from sidecar.ai.tools.builtins.filesystem import (
    MAX_READ_BYTES,
    configure_filesystem_tools,
    read_file_tool,
    write_bytes_atomic,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def _snapshot(result: ToolHandlerResult) -> dict[str, object]:
    snapshot = result.metadata.get("read_snapshot")
    assert isinstance(snapshot, dict)
    return snapshot


@pytest.fixture(autouse=True)
def _reset_filesystem_tools() -> None:
    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": False}
    )


def test_read_file_refuses_malformed_utf8_without_changing_bytes(tmp_path: Path) -> None:
    target = tmp_path / "malformed.txt"
    original = b"hello \xff world"
    target.write_bytes(original)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        read_file_tool({"path": "malformed.txt"}, _guard(tmp_path))

    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    assert "not valid utf-8" in excinfo.value.message.lower()
    assert target.read_bytes() == original


def test_read_file_preserves_crlf_line_endings(tmp_path: Path) -> None:
    target = tmp_path / "crlf.txt"
    target.write_bytes(b"line1\r\nline2\r\n")

    result = read_file_tool({"path": "crlf.txt"}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert result.output == "line1\r\nline2\r\n"


def test_read_file_preserves_lf_line_endings(tmp_path: Path) -> None:
    target = tmp_path / "lf.txt"
    target.write_bytes(b"line1\nline2\n")

    result = read_file_tool({"path": "lf.txt"}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert result.output == "line1\nline2\n"
    assert "\r" not in result.output


def test_read_file_preserves_cr_line_endings(tmp_path: Path) -> None:
    target = tmp_path / "cr.txt"
    target.write_bytes(b"line1\rline2\r")

    result = read_file_tool({"path": "cr.txt"}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert result.output == "line1\rline2\r"
    assert "\n" not in result.output


def test_read_file_treats_utf8_non_ascii_text_as_text(tmp_path: Path) -> None:
    target = tmp_path / "unicode.txt"
    target.write_text("Hello 你好 🌍\n", encoding="utf-8", newline="")

    result = read_file_tool({"path": "unicode.txt"}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert result.output == "Hello 你好 🌍\n"
    assert _snapshot(result)["scope"] == "full"


@pytest.mark.parametrize(
    ("name", "original"),
    [
        ("utf16-le.txt", b"\xff\xfeh\x00i\x00\n\x00"),
        ("mixed.txt", b"valid caf\xc3\xa9\nlegacy \x96 byte\n"),
        ("truncated.txt", b"valid prefix\ntruncated \xf0\x9f\x8c"),
    ],
)
def test_read_file_refuses_non_editable_text_encodings_without_changing_bytes(
    tmp_path: Path,
    name: str,
    original: bytes,
) -> None:
    target = tmp_path / name
    target.write_bytes(original)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        read_file_tool({"path": name}, _guard(tmp_path))

    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    assert target.read_bytes() == original


def test_read_file_decodes_utf8_bom_and_reports_encoding(tmp_path: Path) -> None:
    target = tmp_path / "utf8-bom.txt"
    target.write_bytes(b"\xef\xbb\xbfhello\n")
    result = read_file_tool({"path": "utf8-bom.txt"}, _guard(tmp_path))
    assert result.output == "hello\n"
    assert result.metadata["encoding"] == "utf-8-sig"
    assert _snapshot(result)["encoding"] == "utf-8-sig"


def test_windowed_utf8_bom_reads_strip_marker_on_fast_and_streaming_paths(tmp_path: Path) -> None:
    fast = tmp_path / "fast.txt"
    fast.write_bytes(b"\xef\xbb\xbfalpha\nbeta\n")
    fast_result = read_file_tool({"path": "fast.txt", "offset": 0, "limit": 1}, _guard(tmp_path))
    assert "\ufeff" not in fast_result.output
    assert fast_result.metadata["encoding"] == "utf-8-sig"

    large = tmp_path / "large.txt"
    large.write_bytes(b"\xef\xbb\xbfalpha\n" + b"x" * (MAX_READ_BYTES + 10))
    streamed = read_file_tool({"path": "large.txt", "offset": 0, "limit": 1}, _guard(tmp_path))
    assert "\ufeff" not in streamed.output
    assert streamed.metadata["encoding"] == "utf-8-sig"


def test_read_file_accepts_exact_full_read_byte_cap(tmp_path: Path) -> None:
    target = tmp_path / "exact-cap.txt"
    target.write_bytes(b"a" * MAX_READ_BYTES)

    result = read_file_tool({"path": "exact-cap.txt"}, _guard(tmp_path))

    assert result.success is True
    assert len(result.output.encode("utf-8")) == MAX_READ_BYTES


def test_read_file_includes_path_in_size_limit_error(tmp_path: Path) -> None:
    target = tmp_path / "huge.txt"
    target.write_bytes(b"x" * (MAX_READ_BYTES + 1))

    with pytest.raises(ToolExecutionFailure) as exc_info:
        read_file_tool({"path": "huge.txt"}, _guard(tmp_path))

    assert "huge.txt" in exc_info.value.message
    assert "byte limit" in exc_info.value.message


def test_read_file_checks_size_before_decoding_full_content(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "huge.txt"
    target.write_bytes(b"x" * (MAX_READ_BYTES + 1))

    def _unexpected_open(*_args, **_kwargs):
        raise AssertionError("full read should not happen for oversized files")

    monkeypatch.setattr(builtins, "open", _unexpected_open)

    with pytest.raises(ToolExecutionFailure, match="byte limit"):
        read_file_tool({"path": "huge.txt"}, _guard(tmp_path))


def test_read_file_includes_path_in_not_a_file_error(tmp_path: Path) -> None:
    subdir = tmp_path / "somedir"
    subdir.mkdir()

    with pytest.raises(ToolExecutionFailure) as exc_info:
        read_file_tool({"path": "somedir"}, _guard(tmp_path))

    assert "somedir" in exc_info.value.message
    assert "file" in exc_info.value.message


def test_read_file_rejects_binary_content(tmp_path: Path) -> None:
    target = tmp_path / "image.dat"
    target.write_bytes(b"\x89PNG\r\n\x1a\n\x00binary")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        read_file_tool({"path": "image.dat"}, _guard(tmp_path))

    assert "binary" in exc_info.value.message.lower()
    assert "image.dat" in exc_info.value.message


def test_read_file_pagination_returns_requested_window_and_metadata(tmp_path: Path) -> None:
    target = tmp_path / "window.txt"
    target.write_text("zero\none\ntwo\nthree\n", encoding="utf-8", newline="")

    result = read_file_tool({"path": "window.txt", "offset": 1, "limit": 2}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert "path: window.txt" in result.output
    assert "requested: offset=1, limit=2" in result.output
    assert "returned: lines 2-3 of 4" in result.output
    assert result.output.endswith("one\ntwo\n")
    assert result.metadata["total_lines"] == 4
    assert result.metadata["returned_line_start"] == 2
    assert result.metadata["returned_line_end"] == 3
    assert _snapshot(result)["scope"] == "partial"


def test_read_file_full_coverage_window_promotes_to_full_snapshot(tmp_path: Path) -> None:
    target = tmp_path / "covered.txt"
    body = b"zero\none\ntwo\nthree\n"
    target.write_bytes(body)

    full = read_file_tool({"path": "covered.txt"}, _guard(tmp_path))
    windowed = read_file_tool(
        {"path": "covered.txt", "offset": 0, "limit": 100}, _guard(tmp_path)
    )

    windowed_snapshot = _snapshot(windowed)
    assert windowed_snapshot["scope"] == "full"
    assert windowed_snapshot["sha256"] == hashlib.sha256(body).hexdigest()
    # A window starting at the top that returned every line earns the same authorizing
    # snapshot as an unpaginated read, so it satisfies the read-before-write gate too.
    assert windowed_snapshot == _snapshot(full)

    # An offset-only read (limit omitted) that starts at the top also covers the file.
    offset_only = read_file_tool({"path": "covered.txt", "offset": 0}, _guard(tmp_path))
    assert _snapshot(offset_only)["scope"] == "full"


def test_read_file_full_coverage_window_refuses_malformed_utf8(tmp_path: Path) -> None:
    target = tmp_path / "covered-malformed.txt"
    raw = b"hello \xff world\n"
    target.write_bytes(raw)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        read_file_tool(
            {"path": "covered-malformed.txt", "offset": 0, "limit": 50},
            _guard(tmp_path),
        )

    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    assert target.read_bytes() == raw


def test_read_file_window_stays_partial_when_offset_skips_lines(tmp_path: Path) -> None:
    target = tmp_path / "skipped.txt"
    target.write_bytes(b"zero\none\ntwo\nthree\n")

    # offset > 0 means the model never saw the top of the file, so the snapshot must
    # remain partial and cannot authorize an overwrite.
    result = read_file_tool({"path": "skipped.txt", "offset": 1, "limit": 100}, _guard(tmp_path))

    snapshot = _snapshot(result)
    assert snapshot["scope"] == "partial"
    assert "sha256" not in snapshot


def test_read_file_pagination_preserves_window_line_endings(tmp_path: Path) -> None:
    target = tmp_path / "crlf-window.txt"
    target.write_bytes(b"zero\r\none\r\ntwo\r\n")

    result = read_file_tool(
        {"path": "crlf-window.txt", "offset": 1, "limit": "2"},
        _guard(tmp_path),
    )

    assert isinstance(result, ToolHandlerResult)
    assert result.output.endswith("one\r\ntwo\r\n")


def test_streaming_read_preserves_utf8_codepoint_split_across_chunks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "split-valid.txt"
    target.write_bytes(b"ab\xc3\xa9\n")
    monkeypatch.setattr(filesystem_module, "READ_WINDOW_FAST_PATH_MAX_BYTES", 1)
    monkeypatch.setattr(filesystem_module, "READ_WINDOW_CHUNK_BYTES", 3)

    result = read_file_tool(
        {"path": "split-valid.txt", "offset": 0, "limit": 1},
        _guard(tmp_path),
    )

    assert result.success is True
    assert result.output.encode("utf-8").endswith(b"ab\xc3\xa9\n")


def test_streaming_read_refuses_truncated_codepoint_split_across_chunks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "split-invalid.txt"
    original = b"ab\xc3\n"
    target.write_bytes(original)
    monkeypatch.setattr(filesystem_module, "READ_WINDOW_FAST_PATH_MAX_BYTES", 1)
    monkeypatch.setattr(filesystem_module, "READ_WINDOW_CHUNK_BYTES", 3)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        read_file_tool(
            {"path": "split-invalid.txt", "offset": 0, "limit": 1},
            _guard(tmp_path),
        )

    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    assert target.read_bytes() == original


def test_streaming_partial_read_does_not_scan_invalid_bytes_outside_selected_window(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "invalid-unselected.txt"
    original = b"selected\nignored \x96\n"
    target.write_bytes(original)
    monkeypatch.setattr(filesystem_module, "READ_WINDOW_FAST_PATH_MAX_BYTES", 1)
    monkeypatch.setattr(filesystem_module, "READ_WINDOW_CHUNK_BYTES", 4)

    result = read_file_tool(
        {"path": "invalid-unselected.txt", "offset": 0, "limit": 1},
        _guard(tmp_path),
    )

    assert result.success is True
    assert result.metadata["totals_known"] is False
    assert result.output.endswith("selected\n")
    assert target.read_bytes() == original


def test_streaming_read_valid_codepoint_split_at_unscanned_chunk_boundary_succeeds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression for the streaming UTF-8 validator finalizing bytes it never
    actually finished scanning. The requested window only needs line 1; the chunk
    read that satisfies it happens to end mid-codepoint (the two-byte "é" sequence
    that starts line 2, split by the fixed chunk-read boundary). The remainder of
    that valid codepoint lives in bytes we deliberately never read (has_more=True),
    so finishing the incremental decoder here must NOT be treated as end-of-file --
    doing so would wrongly report a truncation error for perfectly valid UTF-8."""
    target = tmp_path / "split-unscanned.txt"
    line_one = b"line-one\n"  # 9 bytes
    line_two = "é rest\n".encode("utf-8")  # starts with the 2-byte "é" (\xc3\xa9)
    target.write_bytes(line_one + line_two)
    monkeypatch.setattr(filesystem_module, "READ_WINDOW_FAST_PATH_MAX_BYTES", 1)
    # 10-byte chunks: the first chunk read is exactly line_one (9 bytes) plus the
    # first byte of the following "é" -- a split, but valid, 2-byte codepoint.
    monkeypatch.setattr(filesystem_module, "READ_WINDOW_CHUNK_BYTES", 10)

    result = read_file_tool(
        {"path": "split-unscanned.txt", "offset": 0, "limit": 1},
        _guard(tmp_path),
    )

    assert result.success is True
    assert result.output.endswith("line-one\n")
    assert result.metadata["has_more"] is True
    assert result.metadata["totals_known"] is False


def test_read_file_refuses_when_file_grows_during_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The unpaginated read must be identity/size checked before and after the
    actual read, not just size-capped from a single stat call taken before the
    file handle was even opened -- a file that grows while being read must be
    refused rather than silently handed back as if it were still small/complete."""
    target = tmp_path / "growing.txt"
    target.write_bytes(b"hello\n")

    real_fstat = filesystem_module.os.fstat
    call_count = {"n": 0}

    class _FakeStat:
        def __init__(self, real: object, *, size_delta: int) -> None:
            self.st_dev = real.st_dev
            self.st_ino = real.st_ino
            self.st_mode = real.st_mode
            self.st_size = real.st_size + size_delta
            self.st_mtime_ns = real.st_mtime_ns

    def _fake_fstat(fd: int):
        real = real_fstat(fd)
        call_count["n"] += 1
        # First fstat call is right after opening (baseline); the second is the
        # post-read check -- simulate growth happening in between the two.
        return _FakeStat(real, size_delta=0 if call_count["n"] == 1 else 64)

    monkeypatch.setattr(filesystem_module.os, "fstat", _fake_fstat)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        read_file_tool({"path": "growing.txt"}, _guard(tmp_path))

    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    assert "grew" in excinfo.value.message.lower()


def test_pagination_streams_files_above_paginated_output_cap_instead_of_full_buffering(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The paginated "fast path" reads its whole file into memory to slice a window
    out of it, so it must stay bounded by MAX_PAGINATED_OUTPUT_BYTES -- the same cap
    the streaming path enforces on its output -- rather than a separate, much larger
    ceiling that would let a merely-under-10MB file get fully buffered unbounded."""
    target = tmp_path / "midsize.txt"
    line = ("x" * 100) + "\n"
    total_lines = (filesystem_module.MAX_PAGINATED_OUTPUT_BYTES // len(line)) + 50
    target.write_text(line * total_lines, encoding="utf-8", newline="")
    assert filesystem_module.MAX_PAGINATED_OUTPUT_BYTES < target.stat().st_size < 10 * 1024 * 1024

    def _unexpected_fast_path(*_args: object, **_kwargs: object):
        raise AssertionError("fast (full-buffer) path must not run above MAX_PAGINATED_OUTPUT_BYTES")

    monkeypatch.setattr(filesystem_module, "_read_file_window_fast", _unexpected_fast_path)

    result = read_file_tool(
        {"path": "midsize.txt", "offset": 0, "limit": 2}, _guard(tmp_path)
    )

    assert result.success is True
    assert result.output.endswith(line * 2)


def test_bounded_utf8_chunk_chars_shrinks_for_a_small_remaining_budget() -> None:
    # A tiny remaining budget must produce a tiny chunk (bounded by the 4-bytes-
    # per-code-unit worst case), not the full fixed 64 KiB chunk regardless of cap.
    assert file_state_module._bounded_utf8_chunk_chars(10) == 3
    assert file_state_module._bounded_utf8_chunk_chars(0) == 1
    # A large remaining budget is capped at the fixed chunk size, not left unbounded.
    assert (
        file_state_module._bounded_utf8_chunk_chars(10_000_000)
        == file_state_module.UTF8_ENCODE_CHUNK_CHARS
    )


def test_encode_utf8_text_bounded_never_encodes_a_chunk_far_past_a_small_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With a small max_bytes, the encoder must not allocate a fixed oversized 64 KiB
    chunk on every iteration before rejecting -- it should shrink its chunk size to
    the remaining budget so a huge input string can't force a large wasted allocation
    ahead of the (correctly still-raised) cap-exceeded failure."""
    observed_chunk_lengths: list[int] = []
    real_bounded_chunk_chars = file_state_module._bounded_utf8_chunk_chars

    def _spying_bounded_chunk_chars(remaining_budget: int) -> int:
        chunk_chars = real_bounded_chunk_chars(remaining_budget)
        observed_chunk_lengths.append(chunk_chars)
        return chunk_chars

    monkeypatch.setattr(file_state_module, "_bounded_utf8_chunk_chars", _spying_bounded_chunk_chars)

    huge_value = "a" * 1_000_000
    with pytest.raises(ToolExecutionFailure) as excinfo:
        encode_utf8_text_bounded(huge_value, max_bytes=10, subject="test payload")

    assert excinfo.value.code == CMP_TOOL_CAP_EXCEEDED
    # The chunk-sizing helper must actually be consulted (an implementation that
    # falls back to the fixed UTF8_ENCODE_CHUNK_CHARS stride would never call it).
    assert observed_chunk_lengths
    # Every observed chunk stayed close to the small cap -- never anywhere near the
    # full fixed 64 KiB chunk size the unbounded implementation would have used.
    assert all(length <= 12 for length in observed_chunk_lengths)


def test_read_file_pagination_handles_offset_beyond_eof(tmp_path: Path) -> None:
    target = tmp_path / "short.txt"
    target.write_text("alpha\nbeta\n", encoding="utf-8", newline="")

    result = read_file_tool({"path": "short.txt", "offset": 10, "limit": 2}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert "returned: lines empty of 2" in result.output
    assert result.metadata["total_lines"] == 2
    assert result.metadata["returned_line_count"] == 0


def test_read_file_full_reads_include_snapshot_metadata(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8", newline="")
    stat_result = target.stat()

    result = read_file_tool({"path": "notes.txt"}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    snapshot = _snapshot(result)
    assert snapshot == {
        "path": "notes.txt",
        "scope": "full",
        "size_bytes": stat_result.st_size,
        "mtime_ns": stat_result.st_mtime_ns,
        "sha256": hashlib.sha256(b"hello\n").hexdigest(),
        "encoding": "utf-8",
    }


def test_read_file_accepts_absolute_path_inside_workspace(tmp_path: Path) -> None:
    target = tmp_path / "absolute.txt"
    target.write_text("absolute input\n", encoding="utf-8", newline="")

    result = read_file_tool({"path": str(target)}, _guard(tmp_path))

    assert result.success is True
    assert "absolute input" in result.output
    assert _snapshot(result)["path"] == "absolute.txt"


def test_validate_current_snapshot_accepts_metadata_only_mtime_change() -> None:
    expected = ReadSnapshot(
        path="notes.txt",
        scope=READ_SNAPSHOT_SCOPE_FULL,
        size_bytes=6,
        mtime_ns=100,
        sha256="abc123",
    )
    current = ReadSnapshot(
        path="notes.txt",
        scope=READ_SNAPSHOT_SCOPE_FULL,
        size_bytes=6,
        mtime_ns=101,
        sha256="abc123",
    )

    validate_current_snapshot(
        expected_snapshot=expected,
        current_snapshot=current,
        relative_path="notes.txt",
        action="write",
    )


def test_write_file_accepts_metadata_only_touch_after_full_read(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("before\n", encoding="utf-8", newline="")
    read_result = read_file_tool({"path": "notes.txt"}, _guard(tmp_path))
    before_touch = target.stat()
    os.utime(
        target,
        ns=(before_touch.st_atime_ns, before_touch.st_mtime_ns + 1_000_000_000),
    )

    result = filesystem_module.write_file_tool(
        {
            "path": "notes.txt",
            "content": "after\n",
            "expected_read_snapshot": _snapshot(read_result),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_text(encoding="utf-8") == "after\n"


def test_validate_current_snapshot_rejects_raw_byte_hash_mismatch() -> None:
    expected = ReadSnapshot(
        path="notes.txt",
        scope=READ_SNAPSHOT_SCOPE_FULL,
        size_bytes=6,
        mtime_ns=100,
        sha256="abc123",
    )
    current = ReadSnapshot(
        path="notes.txt",
        scope=READ_SNAPSHOT_SCOPE_FULL,
        size_bytes=6,
        mtime_ns=100,
        sha256="def456",
    )

    with pytest.raises(ToolExecutionFailure) as exc_info:
        validate_current_snapshot(
            expected_snapshot=expected,
            current_snapshot=current,
            relative_path="notes.txt",
            action="write",
        )

    assert exc_info.value.code == CMP_TOOL_STALE_READ_SNAPSHOT


def test_workspace_guard_rejects_mutation_parent_that_revalidates_outside_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guard = _guard(tmp_path)
    safe_dir = tmp_path / "safe"
    safe_dir.mkdir()
    outside_dir = tmp_path.parent / f"{tmp_path.name}_outside_revalidated"
    outside_dir.mkdir()
    original_resolve = Path.resolve

    def _resolve_with_swapped_parent(self: Path, *args, **kwargs):  # noqa: ANN002, ANN003
        if self == safe_dir:
            return outside_dir
        return original_resolve(self, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", _resolve_with_swapped_parent)

    with pytest.raises(ToolExecutionFailure) as exc_info:
        guard.ensure_safe_mutation_path(safe_dir / "notes.txt")

    assert exc_info.value.code == CMP_TOOL_IO_FAILED


def test_windows_reparse_detection_fails_closed_on_stat_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    def _raise_stat(self: Path, *args, **kwargs):  # noqa: ANN002, ANN003
        if self == target and kwargs.get("follow_symlinks") is False:
            raise OSError("metadata unavailable")
        return original_stat(self, *args, **kwargs)

    original_stat = Path.stat
    monkeypatch.setattr(
        workspace_module,
        "os",
        SimpleNamespace(name="nt", path=os.path),
    )
    monkeypatch.setattr(Path, "stat", _raise_stat)

    assert workspace_module._has_windows_reparse_point(target) is True


def test_write_bytes_atomic_revalidates_immediately_before_replace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "notes.txt"
    guard_calls: list[Path] = []

    class _Guard:
        def ensure_safe_mutation_path(self, path: Path) -> Path:
            guard_calls.append(path)
            if len(guard_calls) == 3:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_IO_FAILED,
                    message="mutation path parent changed outside tools workspace root",
                    retryable=True,
                )
            return path

    def _unexpected_replace(*_args, **_kwargs):
        raise AssertionError("os.replace must not run after final mutation guard failure")

    monkeypatch.setattr(filesystem_module.os, "replace", _unexpected_replace)

    with pytest.raises(ToolExecutionFailure) as exc_info:
        write_bytes_atomic(target, b"hello\n", workspace=_Guard())

    assert exc_info.value.code == CMP_TOOL_IO_FAILED
    assert len(guard_calls) == 3
    assert not target.exists()


@pytest.mark.parametrize(
    ("arguments", "expected_message"),
    [
        ({"path": "bad.txt", "offset": -1, "limit": 1}, "offset"),
        ({"path": "bad.txt", "offset": "abc", "limit": 1}, "offset"),
        ({"path": "bad.txt", "offset": 0, "limit": 0}, "limit"),
        ({"path": "bad.txt", "offset": 0, "limit": True}, "limit"),
    ],
)
def test_read_file_pagination_rejects_invalid_offset_and_limit(
    arguments: dict[str, object],
    expected_message: str,
    tmp_path: Path,
) -> None:
    target = tmp_path / "bad.txt"
    target.write_text("alpha\nbeta\n", encoding="utf-8", newline="")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        read_file_tool(arguments, _guard(tmp_path))

    assert expected_message in exc_info.value.message


def test_read_file_pagination_can_read_large_files_beyond_legacy_size_cap(tmp_path: Path) -> None:
    target = tmp_path / "large.txt"
    total_lines = 25_000
    target.write_text(
        "".join(f"line {idx}\n" for idx in range(total_lines)), encoding="utf-8", newline=""
    )
    assert target.stat().st_size > MAX_READ_BYTES

    result = read_file_tool({"path": "large.txt", "offset": 24_998, "limit": 2}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert "returned: lines 24999-25000 of 25000" in result.output
    assert result.output.endswith("line 24998\nline 24999\n")
    assert result.metadata["total_lines"] == total_lines


def test_streaming_window_stops_after_requested_lines_with_unknown_total(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "many-lines.txt"
    target.write_text(
        "".join(f"line-{index}\n" for index in range(10_000)),
        encoding="utf-8",
        newline="",
    )
    monkeypatch.setattr(filesystem_module, "READ_WINDOW_FAST_PATH_MAX_BYTES", 1)
    monkeypatch.setattr(filesystem_module, "READ_WINDOW_CHUNK_BYTES", 64)

    result = read_file_tool(
        {"path": target.name, "offset": 0, "limit": 1},
        _guard(tmp_path),
    )

    assert result.metadata["total_lines"] is None
    assert result.metadata["lines_scanned"] == 1
    assert result.metadata["totals_known"] is False
    assert result.metadata["has_more"] is True
    assert result.output.endswith("line-0\n")


def test_read_file_pagination_truncates_when_selected_output_exceeds_byte_cap(
    tmp_path: Path,
) -> None:
    target = tmp_path / "truncated-window.txt"
    oversized_line = ("a" * (filesystem_module.MAX_PAGINATED_OUTPUT_BYTES // 2)) + "\n"
    target.write_text(oversized_line * 3, encoding="utf-8", newline="")

    result = read_file_tool(
        {"path": "truncated-window.txt", "offset": 0, "limit": 3}, _guard(tmp_path)
    )

    assert isinstance(result, ToolHandlerResult)
    assert result.metadata["truncated_by_bytes"] is True
    assert result.metadata["returned_line_count"] == 1
    assert "truncated: selected output exceeded" in result.output
    assert result.output.endswith(oversized_line)
    # Offset 0 alone must NOT authorize a write: a byte-truncated window never showed the
    # whole file, so the snapshot stays partial (guards against a false read-before-write
    # authorize / silent data loss on the next overwrite).
    snapshot = _snapshot(result)
    assert snapshot["scope"] == "partial"
    assert "sha256" not in snapshot


def test_read_file_pagination_guards_large_single_line_payloads(tmp_path: Path) -> None:
    target = tmp_path / "large-line.txt"
    target.write_text(
        "a" * (filesystem_module.MAX_PAGINATED_OUTPUT_BYTES + 64),
        encoding="utf-8",
        newline="",
    )

    result = read_file_tool({"path": "large-line.txt", "offset": 0, "limit": 1}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert result.metadata["truncated_by_bytes"] is True
    assert result.metadata["returned_line_count"] == 0
    assert "returned: lines empty of 1" in result.output
    assert "truncated: selected output exceeded" in result.output


def test_read_file_image_support_stays_disabled_by_default(tmp_path: Path) -> None:
    target = tmp_path / "image.png"
    target.write_bytes(b"\x89PNG\r\n\x1a\n\x00binary")

    with pytest.raises(ToolExecutionFailure, match="binary"):
        read_file_tool({"path": "image.png"}, _guard(tmp_path))


def test_read_file_can_return_bounded_image_payload_when_enabled(tmp_path: Path) -> None:
    pytest.importorskip("PIL")
    from PIL import Image

    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": True}
    )
    target = tmp_path / "image.png"
    Image.new("RGB", (1200, 800), color="navy").save(target, format="PNG")

    result = read_file_tool({"path": "image.png"}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    payload = json.loads(result.output)
    assert payload["kind"] == "image"
    assert payload["path"] == "image.png"
    # WIDE-019: model-visible output has NO base64 — a safe attachment ref
    # only; the full bytes ride the typed trusted-attachment side channel.
    assert "base64," not in result.output
    assert len(result.output) <= 12_000
    ref = payload["attachments"][0]
    assert ref["mime_type"] == "image/jpeg"
    assert len(result.trusted_attachments) == 1
    attachment = result.trusted_attachments[0]
    assert attachment["id"] == ref["id"]
    assert attachment["kind"] == "image"
    assert attachment["source_tool"] == "read_file"
    decoded = base64.b64decode(attachment["data_base64"], validate=True)
    assert len(decoded) == attachment["byte_length"] == ref["byte_length"]
    # WIDE-021: the encoding is COMPLETE — valid JPEG SOI/EOI markers.
    assert decoded.startswith(b"\xff\xd8") and decoded.endswith(b"\xff\xd9")
    assert result.metadata["kind"] == "image"
    assert result.metadata["backend"] == "Pillow"


def test_read_file_image_preflight_refuses_oversize_before_pixel_load(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """WIDE-021: the pixel-budget refusal must fire from the lazy header open,
    BEFORE Pillow ever decodes (allocates) the raster — spied via Image.load."""
    pytest.importorskip("PIL")
    from PIL import Image

    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": True}
    )
    target = tmp_path / "big.png"
    Image.new("RGB", (64, 48), color="navy").save(target, format="PNG")
    monkeypatch.setattr(filesystem_content, "MAX_MEDIA_PIXELS", 64 * 48 - 1)

    def _unexpected_load(self: object, *args: object, **kwargs: object):
        raise AssertionError("pixel data must not be loaded past the preflight refusal")

    monkeypatch.setattr(Image.Image, "load", _unexpected_load)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        read_file_tool({"path": "big.png"}, _guard(tmp_path))

    assert excinfo.value.code == CMP_TOOL_CAP_EXCEEDED
    assert "pixel budget" in excinfo.value.message


def test_read_file_can_return_pdf_pages_when_enabled(tmp_path: Path) -> None:
    pytest.importorskip("fitz")
    import fitz

    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": True}
    )
    target = tmp_path / "sample.pdf"
    document = fitz.open()
    for page_number in range(3):
        page = document.new_page()
        page.insert_text((72, 72), f"Sample page {page_number + 1}")
    document.save(target)
    document.close()

    result = read_file_tool({"path": "sample.pdf", "pages": "2-3"}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    payload = json.loads(result.output)
    assert payload["kind"] == "pdf"
    assert payload["selected_pages"] == [2, 3]
    assert payload["pages"][0]["page_number"] == 2
    assert "Sample page 2" in payload["pages"][0]["text_excerpt"]
    # WIDE-019: no base64 in the model-visible output; per-page attachment
    # refs point at the typed side channel instead.
    assert "base64," not in result.output
    page_ref = payload["pages"][0]["attachment"]
    assert page_ref["page_number"] == 2
    assert len(result.trusted_attachments) == 2
    first_attachment = result.trusted_attachments[0]
    assert first_attachment["kind"] == "pdf_page"
    assert first_attachment["page_number"] == 2
    assert first_attachment["id"] == page_ref["id"]
    decoded = base64.b64decode(first_attachment["data_base64"], validate=True)
    assert len(decoded) == first_attachment["byte_length"]
    assert decoded.startswith(b"\xff\xd8") and decoded.endswith(b"\xff\xd9")
    assert result.metadata["backend"] == "PyMuPDF"


def test_read_file_pdf_preflight_refuses_huge_page_before_rasterization(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """WIDE-021: a PDF page whose declared dimensions bust the pixel budget is
    refused from page metadata BEFORE get_pixmap rasterizes — spied loader."""
    pytest.importorskip("fitz")
    import fitz

    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": True}
    )
    target = tmp_path / "huge-page.pdf"
    document = fitz.open()
    document.new_page(width=612, height=792)
    document.save(target)
    document.close()
    monkeypatch.setattr(filesystem_content, "MAX_MEDIA_PIXELS", 100)

    def _unexpected_get_pixmap(self: object, *args: object, **kwargs: object):
        raise AssertionError("page must not be rasterized past the preflight refusal")

    monkeypatch.setattr(fitz.Page, "get_pixmap", _unexpected_get_pixmap)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        read_file_tool({"path": "huge-page.pdf"}, _guard(tmp_path))

    assert excinfo.value.code == CMP_TOOL_CAP_EXCEEDED
    assert "pixel budget" in excinfo.value.message


def test_read_file_rejects_invalid_pdf_page_ranges(tmp_path: Path) -> None:
    pytest.importorskip("fitz")
    import fitz

    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": True}
    )
    target = tmp_path / "sample.pdf"
    document = fitz.open()
    document.new_page()
    document.save(target)
    document.close()

    with pytest.raises(ToolExecutionFailure, match="references page 2"):
        read_file_tool({"path": "sample.pdf", "pages": "2"}, _guard(tmp_path))


def test_read_file_rejects_pdf_page_ranges_over_batch_limit(tmp_path: Path) -> None:
    pytest.importorskip("fitz")
    import fitz

    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": True}
    )
    target = tmp_path / "sample.pdf"
    document = fitz.open()
    for _ in range(5):
        document.new_page()
    document.save(target)
    document.close()

    with pytest.raises(ToolExecutionFailure, match="exceeds maximum of 3 pages per request"):
        read_file_tool({"path": "sample.pdf", "pages": "1-4"}, _guard(tmp_path))


def test_parse_pages_argument_rejects_huge_ranges_without_expanding() -> None:
    with pytest.raises(ToolExecutionFailure, match="exceeds maximum of 3 pages per request"):
        filesystem_content._parse_pages_argument("1-100000000", page_count=100000000)


def test_read_file_pdf_payload_stays_within_tool_output_budget(tmp_path: Path) -> None:
    pytest.importorskip("fitz")
    import fitz

    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": True}
    )
    target = tmp_path / "large.pdf"
    document = fitz.open()
    for page_number in range(6):
        page = document.new_page()
        page.insert_text((72, 72), f"Large PDF page {page_number + 1} " + ("x" * 400))
    document.save(target)
    document.close()

    result = read_file_tool({"path": "large.pdf"}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert len(result.output) <= 12_000
    payload = json.loads(result.output)
    assert payload["kind"] == "pdf"
    assert payload["truncated"] is True


def test_read_file_image_support_fails_cleanly_without_pillow(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": True}
    )
    target = tmp_path / "image.png"
    target.write_bytes(b"not-really-an-image")
    original_import_module = importlib.import_module

    def _patched_import(name: str, package: str | None = None):
        if name == "PIL.Image":
            raise ModuleNotFoundError("missing Pillow")
        return original_import_module(name, package)

    monkeypatch.setattr(filesystem_content.importlib, "import_module", _patched_import)

    with pytest.raises(ToolExecutionFailure, match="Pillow"):
        read_file_tool({"path": "image.png"}, _guard(tmp_path))


def test_read_file_image_support_rejects_pillow_pixel_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("PIL")
    from PIL import Image

    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": True}
    )
    target = tmp_path / "large-image.png"
    Image.new("RGB", (10, 10), color="navy").save(target, format="PNG")
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 4)

    with pytest.raises(ToolExecutionFailure, match="safe pixel limit"):
        read_file_tool({"path": "large-image.png"}, _guard(tmp_path))


def test_read_file_missing_file_error_names_the_failure_and_recovery(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as exc_info:
        read_file_tool({"path": "ballerina_music_box.py"}, _guard(tmp_path))

    assert "path does not exist: ballerina_music_box.py" in exc_info.value.message
    assert "list_dir or glob_files" in exc_info.value.message


def test_read_file_directory_error_points_at_list_dir(tmp_path: Path) -> None:
    subdir = tmp_path / "somedir"
    subdir.mkdir()

    with pytest.raises(ToolExecutionFailure) as exc_info:
        read_file_tool({"path": "somedir"}, _guard(tmp_path))

    assert "path is a directory, not a file: somedir" in exc_info.value.message
    assert "list_dir" in exc_info.value.message
