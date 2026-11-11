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
from sidecar.ai.tools.builtins.filesystem_read_window import MAX_READ_BYTES, READ_OUTPUT_CHAR_BUDGET
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


def test_single_line_longer_than_the_budget_is_still_returned(tmp_path: Path) -> None:
    (tmp_path / "wide.txt").write_text("y" * (READ_OUTPUT_CHAR_BUDGET + 10) + "\nz\n", encoding="utf-8")
    result = read_file_tool({"path": "wide.txt"}, WorkspaceGuard(str(tmp_path)))

    assert result.metadata["returned_line_count"] == 1
    assert "read the rest with offset=1" in result.output


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
