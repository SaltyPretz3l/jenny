"""Candidate walking, glob matching and bounded file-content scanning for ``grep_search``.

The glob matcher and link-entry rule are shared with ``glob_files``.
"""

from __future__ import annotations

import fnmatch
import os
import re
from collections import deque
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins.file_state import open_regular_file
from sidecar.ai.tools.builtins.filesystem import (
    SEARCH_IGNORE_DIRS,
    is_binary_file,  # noqa: F401 - re-exported for grep_search.
    workspace_relative_path,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure

if TYPE_CHECKING:
    from sidecar.ai.tools.workspace import WorkspaceGuard

MAX_RENDERED_LINE_CHARS = 500
MAX_BRACE_EXPANSIONS = 32
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400
_IO_REPARSE_TAG_NAME_SURROGATE = 0x20000000
_WALK_BUDGET_CHECK_INTERVAL = 256


class BraceExpansionLimitError(ValueError):
    pass


def matches_relative_glob(relative_path: str, pattern: str) -> bool:
    """Match a search-root-relative path against one brace-expanded glob.

    A slash-free pattern matches the file name at any depth; otherwise the path
    must match segment by segment, anchored at the search root, where ``**``
    spans zero or more directories (so a leading ``**/`` also matches root files).
    """
    normalized = relative_path.replace("\\", "/")
    token = pattern.replace("\\", "/")
    if "/" not in token:
        return matches_segment(normalized.rsplit("/", 1)[-1], token)
    path_parts = tuple(part for part in normalized.split("/") if part)
    pattern_parts = tuple(part for part in token.split("/") if part)
    return matches_glob_parts(path_parts, pattern_parts)


def matches_glob_parts(
    path_parts: tuple[str, ...],
    pattern_parts: tuple[str, ...],
) -> bool:
    states: set[tuple[int, int]] = {(0, 0)}
    visited: set[tuple[int, int]] = set()
    while states:
        path_index, pattern_index = states.pop()
        state = (path_index, pattern_index)
        if state in visited:
            continue
        visited.add(state)
        if pattern_index == len(pattern_parts):
            if path_index == len(path_parts):
                return True
            continue
        pattern_part = pattern_parts[pattern_index]
        if pattern_part == "**":
            states.add((path_index, pattern_index + 1))
            if path_index < len(path_parts):
                states.add((path_index + 1, pattern_index))
            continue
        if path_index < len(path_parts) and matches_segment(
            path_parts[path_index], pattern_part
        ):
            states.add((path_index + 1, pattern_index + 1))
    return False


def matches_segment(value: str, pattern: str) -> bool:
    if os.name == "nt":
        return fnmatch.fnmatchcase(value.lower(), pattern.lower())
    return fnmatch.fnmatchcase(value, pattern)


def is_link_entry(entry: os.DirEntry[str]) -> bool:
    """A symlink, or on Windows a junction or other name-surrogate reparse point.

    Python 3.11 does not report a junction as a symlink, so a walk would follow
    it (loops, duplicates). Other reparse points (cloud-file placeholders, dedup)
    are the file itself and stay walkable; an unknown tag fails closed.
    """
    if entry.is_symlink():
        return True
    if os.name != "nt":
        return False
    info = entry.stat(follow_symlinks=False)
    if not getattr(info, "st_file_attributes", 0) & _FILE_ATTRIBUTE_REPARSE_POINT:
        return False
    tag = int(getattr(info, "st_reparse_tag", 0) or 0)
    return not tag or bool(tag & _IO_REPARSE_TAG_NAME_SURROGATE)


def iter_candidate_files(
    search_root: Path,
    workspace: WorkspaceGuard,
    include_patterns: Sequence[str] | None,
    *,
    budget_exhausted: Callable[[], bool] | None = None,
) -> Iterator[Path]:
    """Files under ``search_root`` in walk order, never following links.

    Containment is resolved once per directory; a file is trusted as a regular
    non-link entry of a verified directory (the worker re-verifies the opened
    handle against the workspace root). ``budget_exhausted`` is polled every
    256 entries so a walk whose files ``include_patterns`` all reject still stops.
    """
    if search_root.is_file():
        if not include_patterns or any(
            matches_relative_glob(search_root.name, pattern) for pattern in include_patterns
        ):
            yield search_root
        return
    walk = _CandidateWalk(search_root, workspace, budget_exhausted)
    while walk.pending:
        files = walk.next_directory()
        if files is None:
            return
        for candidate in files:
            if include_patterns and not any(
                matches_relative_glob(candidate.relative_to(search_root).as_posix(), pattern)
                for pattern in include_patterns
            ):
                continue
            yield candidate


class _CandidateWalk:
    def __init__(
        self,
        root: Path,
        workspace: WorkspaceGuard,
        budget_exhausted: Callable[[], bool] | None,
    ) -> None:
        self._workspace = workspace
        self._budget_exhausted = budget_exhausted
        self._entries = 0
        self.pending = [root]
        # Backstop against any link shape the entry check misses.
        self._seen = {os.path.normcase(str(root))}

    def next_directory(self) -> list[Path] | None:
        """The next directory's files, sorted; queues its subdirectories.

        None once the runtime budget is exhausted.
        """
        directory = self.pending.pop()
        try:
            with os.scandir(directory) as iterator:
                entries = list(iterator)
        except OSError:
            return []
        files: list[str] = []
        subdirectories: list[str] = []
        for entry in entries:
            self._entries += 1
            if self._entries % _WALK_BUDGET_CHECK_INTERVAL == 0 and self._over_budget():
                return None
            try:
                if is_link_entry(entry):
                    continue
                if entry.is_dir(follow_symlinks=False):
                    if entry.name not in SEARCH_IGNORE_DIRS:
                        subdirectories.append(entry.name)
                elif entry.is_file(follow_symlinks=False):
                    files.append(entry.name)
            except OSError:
                continue
        self._queue(directory, subdirectories)
        return [directory / name for name in sorted(files, key=str.lower)]

    def _over_budget(self) -> bool:
        return self._budget_exhausted is not None and self._budget_exhausted()

    def _queue(self, directory: Path, names: list[str]) -> None:
        kept: list[Path] = []
        for name in sorted(names, key=str.lower):
            try:
                resolved = self._workspace.ensure_within_root(directory / name)
            except ToolExecutionFailure:
                continue
            key = os.path.normcase(str(resolved))
            if key not in self._seen:
                self._seen.add(key)
                kept.append(resolved)
        self.pending.extend(reversed(kept))


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
    # Set only by a match-summary request: the index of the first summarized text
    # the pattern matches (None for none) and its distinct non-empty matches.
    first_match_index: int | None = None
    distinct_match_count: int | None = None


def search_file(  # noqa: PLR0913
    path: Path,
    compiled: re.Pattern[str],
    workspace_root: Path | None,
    context_lines: int,
    max_output_matches: int,
    max_output_bytes: int,
) -> FileSearchResult:
    display_path = workspace_relative_path(path, workspace_root)
    with open_regular_file(
        path, "r", authorized_root=workspace_root, encoding="utf-8", errors="replace", newline="",
    ) as handle:
        return search_lines(
            handle,
            compiled,
            display_path,
            context_lines,
            max_output_matches,
            max_output_bytes,
        )


def search_lines(  # noqa: PLR0913
    lines: Iterable[str],
    compiled: re.Pattern[str],
    display_path: str,
    context_lines: int,
    max_output_matches: int,
    max_output_bytes: int,
    *,
    line_label: str = "",
    first_line: int = 1,
) -> FileSearchResult:
    """Search already-extracted lines, e.g. one PDF page, numbered from ``first_line``.

    ``line_label`` prefixes each rendered line number (``L`` gives ``p3:L7``).
    """
    if context_lines <= 0:
        return _search_without_context(
            lines,
            compiled,
            display_path,
            max_output_matches,
            max_output_bytes,
            line_label=line_label,
            first_line=first_line,
        )
    return _search_with_context(
        lines,
        compiled,
        display_path,
        context_lines,
        max_output_matches,
        max_output_bytes,
        line_label=line_label,
        first_line=first_line,
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


def _line_window(content: str, match_start: int) -> tuple[int, int]:
    """Return the ``[start, end)`` slice of ``content`` to show around a match."""
    limit = MAX_RENDERED_LINE_CHARS
    start = max(0, min(match_start, len(content)) - limit // 3)
    end = min(len(content), start + limit)
    if end == len(content):
        start = max(0, end - limit)
    return start, end


def _render_search_line(
    display_path: str,
    line_number: int,
    line: str,
    match_start: int | None = None,
    line_label: str = "",
) -> tuple[str, bool]:
    """Render one result line; long matched lines show a window around the match.

    Context lines (``match_start`` is None) keep the head clip.
    """
    content = line.rstrip("\r\n")
    prefix = f"{display_path}:{line_label}{line_number}:"
    if len(content) <= MAX_RENDERED_LINE_CHARS:
        return f"{prefix}{content}", False
    if match_start is None:
        return f"{prefix}{content[:MAX_RENDERED_LINE_CHARS]} [truncated]", True
    start, end = _line_window(content, match_start)
    column_marker = f"[col {start + 1}] ..." if start > 0 else ""
    tail_marker = " [truncated]" if end < len(content) else ""
    return f"{prefix}{column_marker}{content[start:end]}{tail_marker}", True


def _search_without_context(  # noqa: PLR0913
    lines: Iterable[str],
    compiled: re.Pattern[str],
    display_path: str,
    max_output_matches: int,
    max_output_bytes: int,
    *,
    line_label: str = "",
    first_line: int = 1,
) -> FileSearchResult:
    output = _OutputAccumulator(max_bytes=max_output_bytes)
    returned_match_count = 0
    total_match_count = 0
    truncated_by_line_length = False
    for line_number, line in enumerate(lines, start=first_line):
        match = compiled.search(line)
        if match is None:
            continue
        total_match_count += 1
        if returned_match_count >= max_output_matches or output.truncated:
            continue
        rendered_line, line_truncated = _render_search_line(
            display_path, line_number, line, match.start(), line_label
        )
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
    lines: Iterable[str],
    compiled: re.Pattern[str],
    display_path: str,
    context_lines: int,
    max_output_matches: int,
    max_output_bytes: int,
    *,
    line_label: str = "",
    first_line: int = 1,
) -> FileSearchResult:
    before: deque[tuple[int, str]] = deque(maxlen=context_lines)
    block_lines: list[_BlockLine] = []
    output = _OutputAccumulator(max_bytes=max_output_bytes)
    last_added_line = 0
    pending_after = 0
    render_slots_used = 0
    visible_match_count = 0
    total_match_count = 0
    truncated_by_line_length = False

    for line_number, line in enumerate(lines, start=first_line):
        match = compiled.search(line)
        is_match = match is not None
        if match is not None:
            total_match_count += 1

        if is_match and render_slots_used < max_output_matches and not output.truncated:
            for buffered_line in before:
                last_added_line = _append_context_line(
                    block_lines,
                    buffered_line,
                    last_added_line,
                )
            last_added_line = _append_context_line(
                block_lines,
                (line_number, line),
                last_added_line,
                match_start=match.start() if match is not None else None,
            )
            render_slots_used += 1
            pending_after = context_lines
        elif pending_after > 0 and block_lines:
            last_added_line = _append_context_line(
                block_lines,
                (line_number, line),
                last_added_line,
            )
            pending_after -= 1
            if pending_after == 0:
                visible_count, block_line_truncated = _flush_block(
                    display_path,
                    block_lines,
                    output,
                    line_label,
                )
                visible_match_count += visible_count
                truncated_by_line_length = truncated_by_line_length or block_line_truncated
                block_lines = []
        before.append((line_number, line))

    if block_lines:
        visible_count, block_line_truncated = _flush_block(
            display_path, block_lines, output, line_label
        )
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


# (line number, raw line, match start column or None for a context line)
_BlockLine = tuple[int, str, int | None]


def _append_context_line(
    block_lines: list[_BlockLine],
    candidate: tuple[int, str],
    last_added_line: int,
    *,
    match_start: int | None = None,
) -> int:
    line_number, line = candidate
    if line_number <= last_added_line:
        return last_added_line
    block_lines.append((line_number, line, match_start))
    return line_number


def _flush_block(
    display_path: str,
    block_lines: list[_BlockLine],
    output: _OutputAccumulator,
    line_label: str = "",
) -> tuple[int, bool]:
    visible_match_count = 0
    truncated_by_line_length = False
    appended_any = False
    for line_number, line, match_start in block_lines:
        rendered_line, line_truncated = _render_search_line(
            display_path, line_number, line, match_start, line_label
        )
        if not output.add_line(rendered_line):
            break
        appended_any = True
        truncated_by_line_length = truncated_by_line_length or line_truncated
        if match_start is not None:
            visible_match_count += 1
    if appended_any and not output.truncated:
        output.add_line("")
    return visible_match_count, truncated_by_line_length


# Worker protocol: grep_search's regex worker runs these in its own process.

MATCH_SUMMARY_OP = "match_summary"


def run_lines_request(request: dict[str, object]) -> dict[str, object]:
    """Worker side of a ``lines`` request: one chunk of extracted text, e.g. a PDF page."""
    if request.get("op") == MATCH_SUMMARY_OP:
        return run_match_summary_request(request)
    lines_value = request.get("lines")
    display_path = request.get("display_path")
    pattern_value = request.get("pattern")
    if (
        not isinstance(lines_value, list)
        or not all(isinstance(line, str) for line in lines_value)
        or not isinstance(display_path, str)
        or not isinstance(pattern_value, str)
    ):
        return worker_error_response(
            code=CMP_TOOL_IO_FAILED,
            message="grep worker received invalid lines, display path or pattern",
            retryable=True,
        )
    try:
        result = search_lines(
            lines_value,
            re.compile(pattern_value, int(str(request.get("flags", 0)))),
            display_path,
            int(str(request.get("context_lines", 0))),
            int(str(request.get("max_output_matches", 0))),
            int(str(request.get("max_output_bytes", 0))),
            line_label=str(request.get("line_label") or ""),
            first_line=int(str(request.get("first_line", 1))),
        )
    except Exception as error:  # noqa: BLE001
        return worker_error_response(
            code=CMP_TOOL_IO_FAILED,
            message=f"grep worker failed: {error}",
            retryable=True,
        )
    return worker_ok_response(result)


def run_match_summary_request(request: dict[str, object]) -> dict[str, object]:
    """Worker side of knowledge_search's per-file snippet and term-count pass.

    Over already-rendered line texts: the first one the pattern matches and how
    many distinct non-empty matches (casefolded) they hold. It runs here, under
    the worker's timeout, so the model's regex never executes in the parent.
    """
    texts = request.get("lines")
    pattern_value = request.get("pattern")
    if (
        not isinstance(texts, list)
        or not all(isinstance(text, str) for text in texts)
        or not isinstance(pattern_value, str)
    ):
        return worker_error_response(
            code=CMP_TOOL_IO_FAILED,
            message="grep worker received invalid summary lines or pattern",
            retryable=True,
        )
    try:
        compiled = re.compile(pattern_value, int(str(request.get("flags", 0))))
        first_match_index = next(
            (index for index, text in enumerate(texts) if compiled.search(text)), None
        )
        distinct = {
            match.group(0).casefold()
            for text in texts
            for match in compiled.finditer(text)
            if match.group(0)
        }
    except Exception as error:  # noqa: BLE001
        return worker_error_response(
            code=CMP_TOOL_IO_FAILED,
            message=f"grep worker failed: {error}",
            retryable=True,
        )
    return worker_ok_response(FileSearchResult(
        lines=[],
        returned_match_count=0,
        total_match_count=0,
        truncated=False,
        truncated_by_bytes=False,
        truncated_by_line_length=False,
        output_bytes_used=0,
        first_match_index=first_match_index,
        distinct_match_count=len(distinct),
    ))


def worker_ok_response(result: FileSearchResult) -> dict[str, object]:
    response: dict[str, object] = {
        "status": "ok",
        "lines": list(result.lines),
        "returned_match_count": result.returned_match_count,
        "total_match_count": result.total_match_count,
        "truncated": result.truncated,
        "truncated_by_bytes": result.truncated_by_bytes,
        "truncated_by_line_length": result.truncated_by_line_length,
        "output_bytes_used": result.output_bytes_used,
    }
    if result.distinct_match_count is not None:
        response["first_match_index"] = result.first_match_index
        response["distinct_match_count"] = result.distinct_match_count
    return response


def search_result_from_response(response: object) -> FileSearchResult:
    """Parent side of a worker response; the inverse of ``worker_ok_response``."""
    if not isinstance(response, dict):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="grep worker returned an invalid response payload",
            retryable=True,
        )
    if response.get("status") != "ok":
        raise ToolExecutionFailure(
            code=str(response.get("error_code") or CMP_TOOL_IO_FAILED),
            message=str(response.get("message") or "grep worker failed"),
            retryable=bool(response.get("retryable", True)),
        )
    lines = response.get("lines")
    if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="grep worker returned invalid search lines",
            retryable=True,
        )
    return FileSearchResult(
        lines=list(lines),
        returned_match_count=int(response.get("returned_match_count", 0)),
        total_match_count=int(response.get("total_match_count", 0)),
        truncated=bool(response.get("truncated", False)),
        truncated_by_bytes=bool(response.get("truncated_by_bytes", False)),
        truncated_by_line_length=bool(response.get("truncated_by_line_length", False)),
        output_bytes_used=int(response.get("output_bytes_used", 0)),
        first_match_index=_optional_count(response.get("first_match_index")),
        distinct_match_count=_optional_count(response.get("distinct_match_count")),
    )


def _optional_count(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def worker_error_response(*, code: str, message: str, retryable: bool) -> dict[str, object]:
    return {
        "status": "error",
        "error_code": code,
        "message": message,
        "retryable": retryable,
    }
