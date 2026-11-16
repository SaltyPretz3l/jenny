"""read_file stops at whole lines inside one tool result instead of being middle-cut.

2026-11-03 review: a whole-file read of a 53 KB Rust file came back from the
router as head + "[middle truncated by router]" + tail with no line numbers, so
the model shelled out to count lines and re-read a gap it could not place.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.routing.harness_helpers import MAX_RESPONSE_CHARS
from sidecar.ai.routing.tool_execution_results import bounded_tool_output
from sidecar.ai.tools.builtins.file_state import (
    READ_SNAPSHOT_SCOPE_FULL,
    READ_SNAPSHOT_SCOPE_PARTIAL,
)
from sidecar.ai.tools.builtins.filesystem import read_file_tool
from sidecar.ai.tools.builtins.filesystem_read_window import (
    MAX_READ_BYTES,
    READ_FILE_MAX_LINE_CHARS,
    READ_OUTPUT_CHAR_BUDGET,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _write_lines(path: Path, count: int, width: int = 60) -> list[str]:
    lines = [f"{index:05d} " + "x" * width + "\n" for index in range(count)]
    path.write_text("".join(lines), encoding="utf-8", newline="\n")
    return lines


def test_whole_file_read_over_budget_returns_head_window_with_next_offset(tmp_path: Path) -> None:
    lines = _write_lines(tmp_path / "big.rs", 1362)
    result = read_file_tool({"path": "big.rs"}, WorkspaceGuard(str(tmp_path)))

    assert result.success
    returned = result.metadata["returned_line_count"]
    assert isinstance(returned, int) and 0 < returned < len(lines)
    assert result.metadata["total_lines"] == len(lines)
    assert result.metadata["has_more"] is True
    assert result.metadata["truncated_by_output_budget"] is True
    assert f"returned: lines 1-{returned} of {len(lines)}" in result.output
    assert f"read the rest with offset={returned}" in result.output
    header, body = result.output.split("\n\n", 1)
    assert body == "".join(lines[:returned])
    # Every byte was read and hashed: the read still satisfies the write gate.
    assert result.metadata["read_snapshot"]["scope"] == READ_SNAPSHOT_SCOPE_FULL
    assert result.metadata["content_display_truncated"] is True

    sanitized, router_truncated = bounded_tool_output(
        result.output, tool_name="read_file", max_chars=MAX_RESPONSE_CHARS, keep_edges=True,
    )
    assert not router_truncated
    assert "middle truncated" not in sanitized


def test_continuing_from_the_named_offset_reads_the_next_lines(tmp_path: Path) -> None:
    lines = _write_lines(tmp_path / "big.rs", 1362)
    guard = WorkspaceGuard(str(tmp_path))
    first = read_file_tool({"path": "big.rs"}, guard)
    offset = first.metadata["returned_line_end"]

    second = read_file_tool({"path": "big.rs", "offset": offset, "limit": 100}, guard)

    assert second.metadata["returned_line_start"] == offset + 1
    assert second.output.split("\n\n", 1)[1] == "".join(lines[offset:offset + 100])
    assert second.metadata["truncated_by_output_budget"] is False


def test_oversized_window_is_cut_at_whole_lines_and_stays_partial(tmp_path: Path) -> None:
    lines = _write_lines(tmp_path / "big.rs", 1362)
    result = read_file_tool(
        {"path": "big.rs", "offset": 100, "limit": 1000}, WorkspaceGuard(str(tmp_path)),
    )

    returned = result.metadata["returned_line_count"]
    assert isinstance(returned, int) and 0 < returned < 1000
    end = 100 + returned
    assert f"read the rest with offset={end}" in result.output
    assert result.output.split("\n\n", 1)[1] == "".join(lines[100:end])
    assert result.metadata["read_snapshot"]["scope"] == READ_SNAPSHOT_SCOPE_PARTIAL


def test_small_whole_file_read_is_unchanged(tmp_path: Path) -> None:
    lines = _write_lines(tmp_path / "small.rs", 20)
    result = read_file_tool({"path": "small.rs"}, WorkspaceGuard(str(tmp_path)))

    assert result.output == "".join(lines)
    assert "paginated" not in result.metadata


def test_whole_file_read_with_a_line_wider_than_the_budget_clips_it_and_shows_the_rest(
    tmp_path: Path,
) -> None:
    (tmp_path / "wide.txt").write_text(
        "y" * (READ_OUTPUT_CHAR_BUDGET + 10) + "\nz\n", encoding="utf-8", newline="\n",
    )
    result = read_file_tool({"path": "wide.txt"}, WorkspaceGuard(str(tmp_path)))

    assert result.metadata["returned_line_count"] == 2
    assert f"[line clipped: {READ_OUTPUT_CHAR_BUDGET + 10} chars]" in result.output
    assert result.output.endswith("\nz\n")
    # Every byte was hashed (full snapshot) but the model saw line 1 clipped.
    assert result.metadata["read_snapshot"]["scope"] == READ_SNAPSHOT_SCOPE_FULL
    assert result.metadata["content_display_truncated"] is True


def test_over_limit_file_error_names_its_size_and_the_windowed_read(tmp_path: Path) -> None:
    (tmp_path / "huge.log").write_bytes(b"x" * (MAX_READ_BYTES + 1))

    with pytest.raises(ToolExecutionFailure) as caught:
        read_file_tool({"path": "huge.log"}, WorkspaceGuard(str(tmp_path)))

    message = caught.value.message
    assert f"{MAX_READ_BYTES + 1} bytes" in message
    assert "offset=0" in message and "limit=400" in message
    assert "grep_search" in message
    assert "huge.log" in message


def test_over_limit_text_file_can_be_read_in_windows(tmp_path: Path) -> None:
    lines = _write_lines(tmp_path / "huge.log", 4000)  # ~250 KB, over the 200 KB limit
    guard = WorkspaceGuard(str(tmp_path))

    first = read_file_tool({"path": "huge.log", "offset": 0, "limit": 100}, guard)
    deep = read_file_tool({"path": "huge.log", "offset": 3900, "limit": 50}, guard)

    assert first.output.split("\n\n", 1)[1] == "".join(lines[:100])
    assert deep.output.split("\n\n", 1)[1] == "".join(lines[3900:3950])


def _write_long_line_file(path: Path, long_chars: int) -> None:
    rows = ["line one\n", "line two\n", "L" * long_chars + "\n", "line four\n", "line five\n", "line six\n"]
    path.write_text("".join(rows), encoding="utf-8", newline="\n")


def _assert_long_line_clipped_and_read_continues(result, long_chars: int) -> None:
    assert result.success
    body = result.output.split("\n\n", 1)[1]
    lines = body.split("\n")
    assert lines[:2] == ["line one", "line two"]
    assert lines[2] == "L" * READ_FILE_MAX_LINE_CHARS + f" [line clipped: {long_chars} chars]"
    assert lines[3:5] == ["line four", "line five"]
    assert result.metadata["returned_line_count"] == 5
    assert result.metadata["returned_line_end"] == 5
    assert "returned: lines 1-5 of" in result.output
    assert "1 long line clipped" in result.output
    # The model did not see line 3 in full, so the read cannot license an edit.
    assert result.metadata["read_snapshot"]["scope"] == READ_SNAPSHOT_SCOPE_PARTIAL


def test_streaming_window_clips_a_giant_line_and_keeps_reading(tmp_path: Path) -> None:
    long_chars = 500_000  # file is over the fast-path size, so this takes the streaming path
    _write_long_line_file(tmp_path / "giant.html", long_chars)
    result = read_file_tool(
        {"path": "giant.html", "offset": 0, "limit": 5}, WorkspaceGuard(str(tmp_path)),
    )

    _assert_long_line_clipped_and_read_continues(result, long_chars)
    assert result.metadata["totals_known"] is False
    assert result.metadata["truncated_by_bytes"] is False
    assert len(result.output) < READ_OUTPUT_CHAR_BUDGET


def test_fast_window_clips_a_long_line_and_keeps_reading(tmp_path: Path) -> None:
    long_chars = 150_000  # file stays under the fast-path size
    _write_long_line_file(tmp_path / "long.html", long_chars)
    result = read_file_tool(
        {"path": "long.html", "offset": 0, "limit": 5}, WorkspaceGuard(str(tmp_path)),
    )

    _assert_long_line_clipped_and_read_continues(result, long_chars)
    assert result.metadata["totals_known"] is True
    assert result.metadata["total_lines"] == 6


def test_clipped_window_that_reaches_the_end_is_still_partial(tmp_path: Path) -> None:
    _write_long_line_file(tmp_path / "long.html", 5_000)
    result = read_file_tool(
        {"path": "long.html", "offset": 0, "limit": 10}, WorkspaceGuard(str(tmp_path)),
    )

    assert result.metadata["returned_line_count"] == 6
    assert "[line clipped: 5000 chars]" in result.output
    assert result.metadata["read_snapshot"]["scope"] == READ_SNAPSHOT_SCOPE_PARTIAL


def test_window_after_the_giant_line_reads_without_clipping(tmp_path: Path) -> None:
    _write_long_line_file(tmp_path / "giant.html", 500_000)
    result = read_file_tool(
        {"path": "giant.html", "offset": 3, "limit": 3}, WorkspaceGuard(str(tmp_path)),
    )

    assert result.output.split("\n\n", 1)[1] == "line four\nline five\nline six\n"
    assert "clipped" not in result.output


def test_giant_line_with_multibyte_text_and_crlf_is_clipped_by_characters(tmp_path: Path) -> None:
    wide = "é中" * 300_000  # 600,000 characters, 3 bytes per pair
    (tmp_path / "wide.txt").write_bytes(
        b"head\r\n" + wide.encode("utf-8") + b"\r\ntail\r\n",
    )
    result = read_file_tool(
        {"path": "wide.txt", "offset": 0, "limit": 3}, WorkspaceGuard(str(tmp_path)),
    )

    body = result.output.split("\n\n", 1)[1]
    assert body == "head\r\n" + wide[:READ_FILE_MAX_LINE_CHARS] + " [line clipped: 600000 chars]\r\n" + "tail\r\n"
    assert result.metadata["returned_line_count"] == 3


def test_window_header_states_that_offset_is_zero_based(tmp_path: Path) -> None:
    lines = _write_lines(tmp_path / "rows.txt", 400)
    result = read_file_tool(
        {"path": "rows.txt", "offset": 250, "limit": 2}, WorkspaceGuard(str(tmp_path)),
    )

    assert "requested: offset=250, limit=2" in result.output
    assert "0-based; first line returned is 251" in result.output
    assert "returned: lines 251-252 of 400" in result.output
    assert result.output.split("\n\n", 1)[1] == "".join(lines[250:252])
