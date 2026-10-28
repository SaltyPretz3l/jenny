"""Pure search-and-replace matching shared by edit_file and propose_change.

Moved out of ``edit_file.py`` unchanged (Plan Plus C2) so propose_change can
validate a suggestion with exactly the matching edit_file applies, without the
write, checkpoint or journal machinery. Nothing here touches the filesystem.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass

from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED, CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.builtins import shell_settings
from sidecar.ai.tools.builtins.edit_fallbacks import (
    FallbackAmbiguity,
    FallbackMatch,
    find_fallback,
)
from sidecar.ai.tools.builtins.file_state import build_no_match_message
from sidecar.ai.tools.builtins.filesystem import failure_result
from sidecar.ai.tools.contracts import ToolHandlerResult

EditSpec = tuple[str, str, bool]
_LINE_END_RE = re.compile(r"\r\n|\r|\n")


@dataclass(frozen=True)
class FoldContext:
    relative_path: str
    newline_style: str
    max_final_bytes: int
    name_failures: bool
    # propose_change validates suggestions that are never written, so its
    # failures must not hint at earlier edits or at replace_all.
    suggestion_mode: bool = False


def fold_edits(
    edits: tuple[EditSpec, ...],
    *,
    content: str,
    context: FoldContext,
    fallback_notices: list[str] | None = None,
    matched_spans: list[tuple[int, int]] | None = None,
) -> tuple[str, int, bool, tuple[int, ...]] | ToolHandlerResult:
    """Apply ``edits`` in order to LF-normalised ``content``.

    ``matched_spans`` collects, per applied single-match edit, the ``(start,
    end)`` span it matched in the content as it stood before that edit (exact
    or fallback match alike); replace_all edits record no span.
    """
    total_replacements = 0
    applied_replace_all = False
    skipped: list[int] = []
    failures: list[tuple[int, str, str, dict[str, object]]] = []
    for index, (old_string, new_string, replace_all) in enumerate(edits, start=1):
        normalized_old, normalized_new, occurrences, fallback, span = _prepare_match(
            content, old_string, new_string, replace_all=replace_all
        )
        if old_string == new_string and occurrences:
            # A batch item that restates matching text unchanged is skipped and
            # reported instead of discarding the batch's real edits with it.
            skipped.append(index)
            continue
        replacement_count = occurrences if replace_all else 1
        failure = _edit_failure(
            content,
            normalized_old,
            normalized_new,
            occurrences=occurrences,
            replace_all=replace_all,
            replacement_count=replacement_count,
            context=context,
        )
        if failure is not None:
            message, code, metadata = failure
            if isinstance(fallback, FallbackAmbiguity):
                message += f"\n{fallback.notice}"
            if not context.name_failures:
                return failure_result(message=message, error_code=code, metadata=metadata)
            # Batch: keep evaluating later items against the content without this
            # one applied so every problem is reported in a single turn.
            failures.append((index, f"Edit {index}: {message}", code, metadata))
            continue
        content = _apply_prepared_edit(
            content, normalized_old, normalized_new, replace_all=replace_all, fallback=fallback
        )
        if matched_spans is not None and span is not None and not replace_all:
            matched_spans.append(span)
        if isinstance(fallback, FallbackMatch) and fallback_notices is not None:
            fallback_notices.append(fallback.step)
        total_replacements += replacement_count
        applied_replace_all = applied_replace_all or replace_all
    if failures:
        return _batch_failure_result(failures, total=len(edits), context=context)
    if len(skipped) == len(edits):
        return failure_result(
            message=(
                "Every edit has identical old_string and new_string. "
                "No changes were applied."
            ),
            error_code=CMP_TOOL_EXECUTION_FAILED,
            metadata={"path": context.relative_path},
        )
    return content, total_replacements, applied_replace_all, tuple(skipped)


def _prepare_match(
    content: str, old: str, new: str, *, replace_all: bool
) -> tuple[
    str, str, int, FallbackMatch | FallbackAmbiguity | None, tuple[int, int] | None
]:
    """Normalise one edit and locate it; the span is set for a unique match only."""
    old, new = normalize_newlines(old), normalize_newlines(new)
    occurrences = content.count(old)
    fallback = None
    if (
        occurrences == 0 and not replace_all
        and shell_settings.default_on_feature_enabled("edit_match_fallbacks")
    ):
        fallback = find_fallback(content, old, new)
        if isinstance(fallback, FallbackMatch):
            return (
                content[fallback.start:fallback.end], fallback.replacement, 1, fallback,
                (fallback.start, fallback.end),
            )
    span = None
    if occurrences == 1:
        start = content.find(old)
        span = (start, start + len(old))
    return old, new, occurrences, fallback, span


def match_span(content: str, old: str) -> tuple[int, int] | None:
    """Where ``old`` uniquely matches LF-normalised ``content``, exactly or via
    the same fallbacks edit_file applies; ``None`` when absent or ambiguous."""
    return _prepare_match(content, old, old, replace_all=False)[4]


def _apply_prepared_edit(
    content: str, old: str, new: str, *, replace_all: bool,
    fallback: FallbackMatch | FallbackAmbiguity | None,
) -> str:
    if not isinstance(fallback, FallbackMatch):
        return _apply_edit(content, old, new, replace_all=replace_all)
    start, end = fallback.start, fallback.end
    if (
        new == "" and not old.endswith("\n")
        and (start == 0 or content[start - 1] == "\n")
        and content[end:end + 1] == "\n"
    ):
        end += 1
    return content[:start] + new + content[end:]


def _edit_failure(  # noqa: PLR0913 - explicit per-item match context.
    content: str,
    normalized_old: str,
    normalized_new: str,
    *,
    occurrences: int,
    replace_all: bool,
    replacement_count: int,
    context: FoldContext,
) -> tuple[str, str, dict[str, object]] | None:
    if occurrences == 0:
        return (
            build_no_match_message(
                content,
                normalized_old,
                context.relative_path,
                suggestion=context.suggestion_mode,
            ),
            CMP_TOOL_EXECUTION_FAILED,
            {"path": context.relative_path},
        )
    if occurrences > 1 and not replace_all:
        remedy = (
            "Provide more surrounding context so old_string matches exactly once."
            if context.suggestion_mode
            else "Provide more surrounding context or set replace_all to true."
        )
        return (
            f"Found {occurrences} matches in {context.relative_path}. {remedy}",
            CMP_TOOL_EXECUTION_FAILED,
            {"path": context.relative_path, "occurrences": occurrences},
        )
    projected_chars = _projected_rendered_chars(
        content,
        normalized_old,
        normalized_new,
        replacement_count=replacement_count,
        newline_style=context.newline_style,
    )
    if projected_chars > context.max_final_bytes:
        return (
            f"Could not edit {context.relative_path}: final content exceeds byte limit",
            CMP_TOOL_CAP_EXCEEDED,
            {"path": context.relative_path},
        )
    return None


def _batch_failure_result(
    failures: list[tuple[int, str, str, dict[str, object]]],
    *,
    total: int,
    context: FoldContext,
) -> ToolHandlerResult:
    failed_indexes = [index for index, _, _, _ in failures]
    if len(failures) == 1:
        _, message, code, metadata = failures[0]
        return failure_result(
            message=message,
            error_code=code,
            metadata={**metadata, "failed_edits": failed_indexes},
        )
    all_cap = all(code == CMP_TOOL_CAP_EXCEEDED for _, _, code, _ in failures)
    lines = "\n".join(message for _, message, _, _ in failures)
    return failure_result(
        message=(
            f"{len(failures)} of {total} edits failed; no changes were applied.\n{lines}"
        ),
        error_code=CMP_TOOL_CAP_EXCEEDED if all_cap else CMP_TOOL_EXECUTION_FAILED,
        metadata={"path": context.relative_path, "failed_edits": failed_indexes},
    )


def _projected_rendered_chars(
    content: str,
    old_string: str,
    new_string: str,
    *,
    replacement_count: int,
    newline_style: str,
) -> int:
    projected_chars = len(content) + replacement_count * (len(new_string) - len(old_string))
    # Rendered CRLF content adds one byte per normalized newline.
    newline_overhead = len(newline_style) - 1
    if newline_overhead > 0:
        current_newlines = content.count("\n")
        old_newlines = old_string.count("\n")
        new_newlines = new_string.count("\n")
        projected_newlines = current_newlines + replacement_count * (new_newlines - old_newlines)
        projected_chars += max(projected_newlines, 0) * newline_overhead
    return projected_chars


def normalize_newlines(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _apply_edit(
    content: str,
    old_string: str,
    new_string: str,
    *,
    replace_all: bool,
) -> str:
    if new_string != "":
        if replace_all:
            return content.replace(old_string, new_string)
        return content.replace(old_string, new_string, 1)

    spans: list[tuple[int, int]] = []
    search_from = 0
    while True:
        start = content.find(old_string, search_from)
        if start == -1:
            break
        end = start + len(old_string)
        if (
            not old_string.endswith("\n")
            and (start == 0 or content[start - 1] == "\n")
            and content[end : end + 1] == "\n"
        ):
            end += 1
        spans.append((start, end))
        if not replace_all:
            break
        search_from = start + len(old_string)

    updated = content
    for start, end in reversed(spans):
        updated = f"{updated[:start]}{new_string}{updated[end:]}"
    return updated


def dominant_newline(value: str) -> str:
    crlf = value.count("\r\n")
    stripped = value.replace("\r\n", "")
    lf = stripped.count("\n")
    cr = stripped.count("\r")
    counts = [("\r\n", crlf), ("\n", lf), ("\r", cr)]
    counts.sort(key=lambda item: item[1], reverse=True)
    return counts[0][0] if counts[0][1] > 0 else "\n"


def render_with_newlines(value: str, newline_style: str) -> str:
    if newline_style == "\n":
        return value
    return value.replace("\n", newline_style)


def _has_mixed_newlines(value: str) -> bool:
    if "\r" not in value:
        return False
    crlf = value.count("\r\n")
    stripped = value.replace("\r\n", "")
    styles = sum(1 for count in (crlf, stripped.count("\n"), stripped.count("\r")) if count)
    return styles > 1


def _split_lines_with_endings(value: str) -> tuple[list[str], list[str]]:
    lines: list[str] = []
    endings: list[str] = []
    cursor = 0
    for match in _LINE_END_RE.finditer(value):
        lines.append(value[cursor:match.start()])
        endings.append(match.group(0))
        cursor = match.end()
    lines.append(value[cursor:])
    endings.append("")
    return lines, endings


def render_preserving_newlines(original: str, updated: str, newline_style: str) -> str:
    """Render LF-normalised ``updated`` back into ``original``'s line endings.

    A file with one ending style renders with it everywhere. A mixed file keeps
    the ending of every line the edit left alone and gives new or changed lines
    the dominant ending, so an edit never rewrites endings on untouched lines.
    """
    if not _has_mixed_newlines(original):
        return render_with_newlines(updated, newline_style)
    original_lines, original_endings = _split_lines_with_endings(original)
    updated_lines = updated.split("\n")
    last_index = len(updated_lines) - 1
    parts: list[str] = []

    def keep(i: int, j: int) -> None:
        ending = "" if j == last_index else (original_endings[i] or newline_style)
        parts.append(original_lines[i] + ending)

    # Lines shared at both ends are kept outright and only the changed window
    # is diffed: an edit touches a few lines, and SequenceMatcher took 14 s on
    # a repetitive 20k-line file (tool review perf pass, 2026-10-19). Inside
    # the window difflib's autojunk keeps a very repetitive run (blank lines,
    # `}`) from going quadratic; such a line still keeps its ending whenever a
    # neighbouring match extends over it.
    head = 0
    bound = min(len(original_lines), len(updated_lines))
    while head < bound and original_lines[head] == updated_lines[head]:
        head += 1
    tail = 0
    while tail < bound - head and original_lines[-1 - tail] == updated_lines[-1 - tail]:
        tail += 1
    for index in range(head):
        keep(index, index)
    matcher = difflib.SequenceMatcher(
        None,
        original_lines[head : len(original_lines) - tail],
        updated_lines[head : len(updated_lines) - tail],
    )
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for i, j in zip(range(i1, i2), range(j1, j2), strict=True):
                keep(head + i, head + j)
        elif tag in {"replace", "insert"}:
            for j in range(head + j1, head + j2):
                parts.append(updated_lines[j] + ("" if j == last_index else newline_style))
    for offset in range(tail, 0, -1):
        keep(len(original_lines) - offset, len(updated_lines) - offset)
    return "".join(parts)
