"""Bounded file-content scanning and rendering for ``grep_search``."""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from sidecar.ai.tools.builtins.filesystem import (
    SEARCH_IGNORE_DIRS as _SEARCH_IGNORE_DIRS,
)
from sidecar.ai.tools.builtins.filesystem import (
    is_binary_file as _is_binary_file,
)
from sidecar.ai.tools.builtins.filesystem import (
    workspace_relative_path,
)

MAX_RENDERED_LINE_CHARS = 500
MAX_BRACE_EXPANSIONS = 32
SEARCH_IGNORE_DIRS = _SEARCH_IGNORE_DIRS
is_binary_file = _is_binary_file


class BraceExpansionLimitError(ValueError):
    pass


def expand_brace_patterns(pattern: str) -> tuple[str, ...]:
    """Expand comma-separated brace alternatives without invoking a shell."""
    pending = [pattern]
    expanded: list[str] = []
    while pending:
        candidate = pending.pop()
        brace = _find_expandable_brace(candidate)
        if brace is None:
            expanded.append(candidate)
            continue
        start, end, alternatives = brace
        if len(pending) + len(expanded) + len(alternatives) > MAX_BRACE_EXPANSIONS:
            raise BraceExpansionLimitError
        prefix = candidate[:start]
        suffix = candidate[end + 1 :]
        pending.extend(f"{prefix}{alternative}{suffix}" for alternative in alternatives)
    return tuple(dict.fromkeys(expanded))


def _find_expandable_brace(pattern: str) -> tuple[int, int, tuple[str, ...]] | None:
    stack: list[int] = []
    for index, character in enumerate(pattern):
        if character == "{":
            stack.append(index)
            continue
        if character != "}" or not stack:
            continue
        start = stack.pop()
        alternatives = tuple(pattern[start + 1 : index].split(","))
        if len(alternatives) > 1:
            return start, index, alternatives
    return None


@dataclass(frozen=True)
class FileSearchResult:
    lines: list[str]
    returned_match_count: int
    total_match_count: int
    truncated: bool
    truncated_by_bytes: bool
    truncated_by_line_length: bool
    output_bytes_used: int


def search_file(  # noqa: PLR0913
    path: Path,
    compiled: re.Pattern[str],
    workspace_root: Path | None,
    context_lines: int,
    max_output_matches: int,
    max_output_bytes: int,
) -> FileSearchResult:
    display_path = workspace_relative_path(path, workspace_root)
    if context_lines <= 0:
        return _search_without_context(
            path,
            compiled,
            display_path,
            max_output_matches,
            max_output_bytes,
        )
    return _search_with_context(
        path,
        compiled,
        display_path,
        context_lines,
        max_output_matches,
        max_output_bytes,
    )


class _OutputAccumulator:
    def __init__(self, *, max_bytes: int) -> None:
        self._max_bytes = max(0, max_bytes)
        self.lines: list[str] = []
        self.bytes_used = 0
        self.truncated = False

    def add_line(self, line: str) -> bool:
        additional_bytes = len(line.encode("utf-8"))
        if self.lines:
            additional_bytes += 1
        if self.bytes_used + additional_bytes > self._max_bytes:
            self.truncated = True
            return False
        self.lines.append(line)
        self.bytes_used += additional_bytes
        return True


def _render_search_line(display_path: str, line_number: int, line: str) -> tuple[str, bool]:
    content = line.rstrip("\r\n")
    truncated = False
    if len(content) > MAX_RENDERED_LINE_CHARS:
        content = content[:MAX_RENDERED_LINE_CHARS] + " [truncated]"
        truncated = True
    return f"{display_path}:{line_number}:{content}", truncated


def _search_without_context(
    path: Path,
    compiled: re.Pattern[str],
    display_path: str,
    max_output_matches: int,
    max_output_bytes: int,
) -> FileSearchResult:
    output = _OutputAccumulator(max_bytes=max_output_bytes)
    returned_match_count = 0
    total_match_count = 0
    truncated_by_line_length = False
    with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not compiled.search(line):
                continue
            total_match_count += 1
            if returned_match_count >= max_output_matches or output.truncated:
                continue
            rendered_line, line_truncated = _render_search_line(display_path, line_number, line)
            if not output.add_line(rendered_line):
                continue
            truncated_by_line_length = truncated_by_line_length or line_truncated
            returned_match_count += 1
    truncated = (
        total_match_count > returned_match_count or output.truncated or truncated_by_line_length
    )
    return FileSearchResult(
        lines=list(output.lines),
        returned_match_count=returned_match_count,
        total_match_count=total_match_count,
        truncated=truncated,
        truncated_by_bytes=output.truncated,
        truncated_by_line_length=truncated_by_line_length,
        output_bytes_used=output.bytes_used,
    )


def _search_with_context(  # noqa: PLR0913
    path: Path,
    compiled: re.Pattern[str],
    display_path: str,
    context_lines: int,
    max_output_matches: int,
    max_output_bytes: int,
) -> FileSearchResult:
    before: deque[tuple[int, str]] = deque(maxlen=context_lines)
    block_lines: list[tuple[int, str, bool]] = []
    output = _OutputAccumulator(max_bytes=max_output_bytes)
    last_added_line = 0
    pending_after = 0
    render_slots_used = 0
    visible_match_count = 0
    total_match_count = 0
    truncated_by_line_length = False

    with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
        for line_number, line in enumerate(handle, start=1):
            is_match = compiled.search(line) is not None
            if is_match:
                total_match_count += 1

            if is_match and render_slots_used < max_output_matches and not output.truncated:
                for buffered_line in before:
                    last_added_line = _append_context_line(
                        block_lines,
                        buffered_line,
                        last_added_line,
                        is_match=False,
                    )
                last_added_line = _append_context_line(
                    block_lines,
                    (line_number, line),
                    last_added_line,
                    is_match=True,
                )
                render_slots_used += 1
                pending_after = context_lines
            elif pending_after > 0 and block_lines:
                last_added_line = _append_context_line(
                    block_lines,
                    (line_number, line),
                    last_added_line,
                    is_match=False,
                )
                pending_after -= 1
                if pending_after == 0:
                    visible_count, block_line_truncated = _flush_block(
                        display_path,
                        block_lines,
                        output,
                    )
                    visible_match_count += visible_count
                    truncated_by_line_length = truncated_by_line_length or block_line_truncated
                    block_lines = []
            before.append((line_number, line))

    if block_lines:
        visible_count, block_line_truncated = _flush_block(display_path, block_lines, output)
        visible_match_count += visible_count
        truncated_by_line_length = truncated_by_line_length or block_line_truncated

    truncated = (
        total_match_count > visible_match_count or output.truncated or truncated_by_line_length
    )
    return FileSearchResult(
        lines=list(output.lines),
        returned_match_count=visible_match_count,
        total_match_count=total_match_count,
        truncated=truncated,
        truncated_by_bytes=output.truncated,
        truncated_by_line_length=truncated_by_line_length,
        output_bytes_used=output.bytes_used,
    )


def _append_context_line(
    block_lines: list[tuple[int, str, bool]],
    candidate: tuple[int, str],
    last_added_line: int,
    *,
    is_match: bool,
) -> int:
    line_number, line = candidate
    if line_number <= last_added_line:
        return last_added_line
    block_lines.append((line_number, line, is_match))
    return line_number


def _flush_block(
    display_path: str,
    block_lines: list[tuple[int, str, bool]],
    output: _OutputAccumulator,
) -> tuple[int, bool]:
    visible_match_count = 0
    truncated_by_line_length = False
    appended_any = False
    for line_number, line, is_match in block_lines:
        rendered_line, line_truncated = _render_search_line(display_path, line_number, line)
        if not output.add_line(rendered_line):
            break
        appended_any = True
        truncated_by_line_length = truncated_by_line_length or line_truncated
        if is_match:
            visible_match_count += 1
    if appended_any and not output.truncated:
        output.add_line("")
    return visible_match_count, truncated_by_line_length
