"""Pure search-and-replace matching shared by edit_file and propose_change.

Moved out of ``edit_file.py`` unchanged (Plan Plus C2) so propose_change can
validate a suggestion with exactly the matching edit_file applies, without the
write, checkpoint or journal machinery. Nothing here touches the filesystem.
"""

from __future__ import annotations

from dataclasses import dataclass

from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED, CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.builtins.file_state import build_no_match_message
from sidecar.ai.tools.builtins.filesystem import failure_result
from sidecar.ai.tools.contracts import ToolHandlerResult

EditSpec = tuple[str, str, bool]


@dataclass(frozen=True)
class _FoldContext:
    relative_path: str
    newline_style: str
    max_final_bytes: int
    name_failures: bool
    # propose_change validates suggestions that are never written, so its
    # failures must not hint at earlier edits or at replace_all.
    suggestion_mode: bool = False


def _fold_edits(
    edits: tuple[EditSpec, ...],
    *,
    content: str,
    context: _FoldContext,
) -> tuple[str, int, bool, tuple[int, ...]] | ToolHandlerResult:
    total_replacements = 0
    applied_replace_all = False
    skipped: list[int] = []
    failures: list[tuple[int, str, str, dict[str, object]]] = []
    for index, (old_string, new_string, replace_all) in enumerate(edits, start=1):
        normalized_old = _normalize_newlines(old_string)
        normalized_new = _normalize_newlines(new_string)
        occurrences = content.count(normalized_old)
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
            if not context.name_failures:
                return failure_result(message=message, error_code=code, metadata=metadata)
            # Batch: keep evaluating later items against the content without this
            # one applied so every problem is reported in a single turn.
            failures.append((index, f"Edit {index}: {message}", code, metadata))
            continue
        content = _apply_edit(
            content,
            normalized_old,
            normalized_new,
            replace_all=replace_all,
        )
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


def _edit_failure(  # noqa: PLR0913 - explicit per-item match context.
    content: str,
    normalized_old: str,
    normalized_new: str,
    *,
    occurrences: int,
    replace_all: bool,
    replacement_count: int,
    context: _FoldContext,
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
    context: _FoldContext,
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


def _normalize_newlines(value: str) -> str:
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


def _dominant_newline(value: str) -> str:
    crlf = value.count("\r\n")
    stripped = value.replace("\r\n", "")
    lf = stripped.count("\n")
    cr = stripped.count("\r")
    counts = [("\r\n", crlf), ("\n", lf), ("\r", cr)]
    counts.sort(key=lambda item: item[1], reverse=True)
    return counts[0][0] if counts[0][1] > 0 else "\n"


def _render_with_newlines(value: str, newline_style: str) -> str:
    if newline_style == "\n":
        return value
    return value.replace("\n", newline_style)
