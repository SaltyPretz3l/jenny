"""read_file window results: the header, the output budget and the read snapshot.

Split from ``filesystem.py`` (file-size ceiling); ``filesystem`` re-exports the
constants. Every windowed read_file result is built here, and so is a whole-file
read too long for one tool result.
"""

from __future__ import annotations

import os

from sidecar.ai.tools.builtins.file_state import (
    READ_SNAPSHOT_SCOPE_FULL,
    READ_SNAPSHOT_SCOPE_PARTIAL,
    build_read_snapshot,
)
from sidecar.ai.tools.contracts import ToolHandlerResult

MAX_READ_BYTES = 200_000
MAX_PAGINATED_OUTPUT_BYTES = MAX_READ_BYTES
# The router bounds every tool result to 16,000 characters (harness_helpers.
# MAX_RESPONSE_CHARS) and cuts a longer one out of its middle, which hid the
# middle of a 53 KB file with no line numbers (2026-11-03 review). A read
# stops at whole lines inside this budget and says where to continue instead;
# the rest of the 16,000 is headroom for the header.
READ_OUTPUT_CHAR_BUDGET = 15_000


def build_read_window_result(  # noqa: PLR0913 - keyword-only result fields.
    *,
    relative_path: str,
    stat_result: os.stat_result,
    offset: int,
    limit: int | None,
    total_lines: int,
    selected_lines: list[str],
    truncated_by_bytes: bool,
    full_file_bytes: bytes | None = None,
    totals_known: bool = True,
    has_more: bool = False,
    encoding: str = "utf-8",
    whole_file_read: bool = False,
) -> ToolHandlerResult:
    selected_lines, truncated_by_budget = _fit_output_budget(selected_lines)
    returned_line_count = len(selected_lines)
    returned_line_start = (offset + 1) if selected_lines else None
    returned_line_end = (offset + returned_line_count) if selected_lines else None
    requested_limit = limit if limit is not None else "EOF"
    returned_range = (
        f"{returned_line_start}-{returned_line_end}" if returned_line_start is not None else "empty"
    )
    total_label = str(total_lines) if totals_known else f"at least {total_lines}"
    header_lines = [
        f"path: {relative_path}",
        f"requested: offset={offset}, limit={requested_limit}",
        f"returned: lines {returned_range} of {total_label}",
    ]
    if not totals_known:
        header_lines.append("totals_known: false; stopped after the requested window")
    if truncated_by_bytes:
        header_lines.append(
            f"truncated: selected output exceeded {MAX_PAGINATED_OUTPUT_BYTES} bytes; "
            "returning complete lines that fit"
        )
    if truncated_by_budget:
        header_lines.append(
            f"truncated: stopped at line {returned_line_end} to fit one tool result; "
            f"read the rest with offset={returned_line_end}"
        )
    header = "\n".join(header_lines)
    window_text = "".join(selected_lines)
    output = header if not window_text else f"{header}\n\n{window_text}"
    # A window that starts at the top, isn't byte-truncated, and returned every line has
    # shown the model the whole file, so it earns a full snapshot (sha256 over the real
    # bytes) and can satisfy the read-before-write gate — exactly like an unpaginated
    # read. Without the full bytes in hand (streaming path) it stays a partial snapshot.
    # An unpaginated read cut to the output budget (whole_file_read) hashed every byte too.
    covers_entire_file = full_file_bytes is not None and (
        whole_file_read
        or (
            totals_known
            and offset == 0
            and not truncated_by_bytes
            and returned_line_count == total_lines
        )
    )
    snapshot = build_read_snapshot(
        relative_path=relative_path,
        scope=READ_SNAPSHOT_SCOPE_FULL if covers_entire_file else READ_SNAPSHOT_SCOPE_PARTIAL,
        stat_result=stat_result,
        raw_bytes=full_file_bytes if covers_entire_file else None,
        encoding=encoding,
    )
    metadata: dict[str, object] = {
        "path": relative_path,
        "encoding": encoding,
        "paginated": True,
        "offset": offset,
        "limit": limit,
        "total_lines": total_lines if totals_known else None,
        "lines_scanned": total_lines,
        "totals_known": totals_known,
        "has_more": has_more or truncated_by_budget,
        "returned_line_start": returned_line_start,
        "returned_line_end": returned_line_end,
        "returned_line_count": returned_line_count,
        "truncated_by_bytes": truncated_by_bytes,
        "truncated_by_output_budget": truncated_by_budget,
        "read_snapshot": snapshot.to_metadata(),
    }
    if whole_file_read and truncated_by_budget:
        # A full snapshot whose text the model only partly saw: the same flag
        # the router sets when it cuts a full read (tool_execution_outcomes).
        metadata["content_display_truncated"] = True
    return ToolHandlerResult(output=output, success=True, metadata=metadata)


def _fit_output_budget(lines: list[str]) -> tuple[list[str], bool]:
    """Keep the leading whole lines that fit READ_OUTPUT_CHAR_BUDGET (at least one)."""
    used = 0
    for index, line in enumerate(lines):
        used += len(line)
        if used > READ_OUTPUT_CHAR_BUDGET and index > 0:
            return lines[:index], True
    return lines, False
