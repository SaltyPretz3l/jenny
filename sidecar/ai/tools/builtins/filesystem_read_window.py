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
# A selected line longer than this is returned clipped, with its true length.
READ_FILE_MAX_LINE_CHARS = 2000
# Four bytes cover any UTF-8 character, so this prefix always holds the first
# READ_FILE_MAX_LINE_CHARS characters of a line however long the line is.
_LINE_PREFIX_BYTES = READ_FILE_MAX_LINE_CHARS * 4
_UTF8_CONTINUATION = bytes(range(0x80, 0xC0))


class ClippedLine(str):
    """A line cut to READ_FILE_MAX_LINE_CHARS; the type is how the header counts them."""


def _clipped_line(head: str, true_chars: int, terminator: str) -> ClippedLine:
    return ClippedLine(f"{head} [line clipped: {true_chars} chars]{terminator}")


def clip_long_line(line: str) -> str:
    """Return ``line`` unchanged, or clipped with its true length when it is too long."""
    body = line.rstrip("\r\n")
    if isinstance(line, ClippedLine) or len(body) <= READ_FILE_MAX_LINE_CHARS:
        return line
    return _clipped_line(body[:READ_FILE_MAX_LINE_CHARS], len(body), line[len(body) :])


class StreamedLineBuilder:
    """Builds one line from byte pieces while keeping only a prefix of it.

    The streaming read feeds a line's bytes chunk by chunk, so a 1.7 MB single-line
    file never sits in memory. ``finish`` returns the line text, clipped like
    ``clip_long_line``. Characters are counted by UTF-8 lead bytes, so a character
    split across two chunks counts once.
    """

    def __init__(self) -> None:
        self._prefix = bytearray()
        self._chars = 0

    def feed(self, piece: bytes) -> None:
        self._chars += len(piece.translate(None, _UTF8_CONTINUATION))
        room = _LINE_PREFIX_BYTES - len(self._prefix)
        if room > 0:
            self._prefix += piece[:room]

    def finish(self, terminator: bytes = b"") -> str:
        chars, prefix = self._chars, bytes(self._prefix)
        self._prefix.clear()
        self._chars = 0
        end = terminator.decode("utf-8")
        if chars <= READ_FILE_MAX_LINE_CHARS:
            return prefix.decode("utf-8") + end
        head = prefix.decode("utf-8", errors="ignore")[:READ_FILE_MAX_LINE_CHARS]
        return _clipped_line(head, chars, end)


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
    selected_lines, truncated_by_budget = _fit_output_budget(
        [clip_long_line(line) for line in selected_lines]
    )
    clipped_line_count = sum(isinstance(line, ClippedLine) for line in selected_lines)
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
        f"requested: offset={offset}, limit={requested_limit} "
        f"(offset is 0-based; first line returned is {offset + 1})",
        f"returned: lines {returned_range} of {total_label}"
        + _clipped_label(clipped_line_count),
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
            and not clipped_line_count
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
    if whole_file_read and (truncated_by_budget or clipped_line_count):
        # A full snapshot whose text the model only partly saw: the same flag
        # the router sets when it cuts a full read (tool_execution_outcomes).
        metadata["content_display_truncated"] = True
    return ToolHandlerResult(output=output, success=True, metadata=metadata)


def _clipped_label(count: int) -> str:
    if not count:
        return ""
    return f", {count} long line{'' if count == 1 else 's'} clipped"


def _fit_output_budget(lines: list[str]) -> tuple[list[str], bool]:
    """Keep the leading whole lines that fit READ_OUTPUT_CHAR_BUDGET (at least one)."""
    used = 0
    for index, line in enumerate(lines):
        used += len(line)
        if used > READ_OUTPUT_CHAR_BUDGET and index > 0:
            return lines[:index], True
    return lines, False
