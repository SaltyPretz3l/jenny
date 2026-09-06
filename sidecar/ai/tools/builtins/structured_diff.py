"""Bounded structured diff metadata for sidecar file mutations."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any

from sidecar.runtime.diagnostics import log_event

MAX_DIFF_BYTES = 32 * 1024
MAX_DIFF_HUNKS = 64
MAX_DIFF_LINES = 200
MAX_DIFF_LINE_CHARS = 2000
MAX_DIFF_CONTEXT_LINES = 3
MAX_LOG_PATH_BASENAME_CHARS = 120
NO_NEWLINE_MARKER = "\\ No newline at end of file"
DIFF_GENERATION_WARNING_CODE = "diff_generation_failed"
DIFF_GENERATION_WARNING_MESSAGE = (
    "Structured diff metadata could not be generated; file mutation succeeded."
)
Opcode = tuple[str, int, int, int, int]

@dataclass(frozen=True)
class DiffCaps:
    max_diff_bytes: int = MAX_DIFF_BYTES
    max_diff_hunks: int = MAX_DIFF_HUNKS
    max_diff_lines: int = MAX_DIFF_LINES
    max_diff_line_chars: int = MAX_DIFF_LINE_CHARS
    context_lines: int = MAX_DIFF_CONTEXT_LINES


def compute_structured_diff(  # noqa: PLR0913
    file_path: object,
    old_text: object,
    new_text: object,
    *,
    diff_id: object = "",
    operation_index: object = 0,
    status: object | None = None,
    hash_kind: object = "diff_input_text",
    logger: logging.Logger | None = None,
    max_diff_bytes: object | None = None,
    max_diff_hunks: object | None = None,
    max_diff_lines: object | None = None,
    max_diff_line_chars: object | None = None,
    context_lines: object | None = None,
) -> dict[str, Any] | None:
    """Return JS-compatible V1 diff metadata, or ``None`` on generation failure."""

    caps = _resolve_caps(
        max_diff_bytes=max_diff_bytes,
        max_diff_hunks=max_diff_hunks,
        max_diff_lines=max_diff_lines,
        max_diff_line_chars=max_diff_line_chars,
        context_lines=context_lines,
    )
    try:
        normalized_old = normalize_diff_input_text(old_text)
        normalized_new = normalize_diff_input_text(new_text)
        resolved_status = _resolve_status(status, normalized_old)
        old_tokens = _line_tokens(normalized_old)
        new_tokens = _line_tokens(normalized_new)
        groups = _grouped_opcodes(old_tokens, new_tokens, caps.context_lines)
        additions, deletions = _count_group_changes(groups)
        truncation_reason = _preflight_truncation_reason(groups, old_tokens, new_tokens, caps)
        hunks = (
            []
            if truncation_reason
            else _build_hunks_from_groups(groups, old_tokens, new_tokens)
        )
        truncation_reason = truncation_reason or _resolve_truncation_reason(hunks, caps)
        truncated = truncation_reason is not None
        body_kind = "summary_only" if truncated else ("inline_hunks" if hunks else "none")
        review_state = "summary_only" if truncated or not hunks else "full"
        return {
            "diff_id": _normalize_text_field(diff_id),
            "operation_index": _non_negative_int(operation_index, 0),
            "status": resolved_status,
            "review_state": review_state,
            "body_kind": body_kind,
            "additions": additions,
            "deletions": deletions,
            "truncated": truncated,
            "truncation_reason": truncation_reason,
            "before_hash": None if resolved_status == "created" else sha256_text(normalized_old),
            "after_hash": None if resolved_status == "deleted" else sha256_text(normalized_new),
            "hash_kind": _normalize_text_field(hash_kind) or "diff_input_text",
            "hunks": [] if truncated else hunks,
        }
    except Exception as error:  # noqa: BLE001
        log_diff_failure(logger, file_path, error)
        return None


# Signature mirrors compute_structured_diff fallback inputs used by file mutation helpers.
def build_failed_diff_metadata(  # noqa: PLR0913
    file_path: object,
    old_text: object,
    new_text: object,
    *,
    status: object | None = None,
    operation_index: object = 0,
    hash_kind: object = "diff_input_text",
) -> dict[str, Any]:
    resolved_status = "unknown"
    additions = 0
    deletions = 0
    before_hash = None
    after_hash = None
    try:
        normalized_old = normalize_diff_input_text(old_text)
        normalized_new = normalize_diff_input_text(new_text)
        resolved_status = _resolve_status(status, normalized_old)
        additions, deletions = _count_changed_tokens(normalized_old, normalized_new)
        before_hash = None if resolved_status == "created" else sha256_text(normalized_old)
        after_hash = None if resolved_status == "deleted" else sha256_text(normalized_new)
    except Exception:  # noqa: BLE001
        resolved_status = _normalize_text_field(status) or "unknown"
    return {
        "diff_id": "",
        "operation_index": _non_negative_int(operation_index, 0),
        "status": resolved_status,
        "review_state": "failed",
        "body_kind": "none",
        "additions": additions,
        "deletions": deletions,
        "truncated": True,
        "truncation_reason": DIFF_GENERATION_WARNING_CODE,
        "before_hash": before_hash,
        "after_hash": after_hash,
        "hash_kind": _normalize_text_field(hash_kind) or "diff_input_text",
        "hunks": [],
    }


def diff_generation_warning() -> dict[str, str]:
    return {
        "code": DIFF_GENERATION_WARNING_CODE,
        "message": DIFF_GENERATION_WARNING_MESSAGE,
    }


def log_diff_failure(
    target_logger: logging.Logger | None,
    file_path: object,
    error: BaseException,
) -> None:
    if target_logger is None:
        return
    log_event(
        target_logger,
        logging.WARNING,
        component="ai.tools.structured_diff",
        event="tool.diff_generation_failed",
        message="Structured diff generation failed",
        status="degraded",
        data={
            **_build_path_log_hint(file_path),
            "error_type": type(error).__name__,
        },
    )


def normalize_diff_input_text(value: object) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n")


def sha256_text(value: object) -> str:
    return f"sha256:{hashlib.sha256(str(value or '').encode('utf-8')).hexdigest()}"


def _resolve_caps(
    *,
    max_diff_bytes: object | None,
    max_diff_hunks: object | None,
    max_diff_lines: object | None,
    max_diff_line_chars: object | None,
    context_lines: object | None,
) -> DiffCaps:
    return DiffCaps(
        max_diff_bytes=_positive_int(max_diff_bytes, MAX_DIFF_BYTES),
        max_diff_hunks=_positive_int(max_diff_hunks, MAX_DIFF_HUNKS),
        max_diff_lines=_positive_int(max_diff_lines, MAX_DIFF_LINES),
        max_diff_line_chars=_positive_int(max_diff_line_chars, MAX_DIFF_LINE_CHARS),
        context_lines=_positive_int(context_lines, MAX_DIFF_CONTEXT_LINES),
    )


def _positive_int(value: object | None, fallback: int) -> int:
    if isinstance(value, bool) or value is None:
        return fallback
    if not isinstance(value, (int, float, str)):
        return fallback
    try:
        candidate = int(float(value))
    except (TypeError, ValueError):
        return fallback
    return candidate if candidate > 0 else fallback


def _non_negative_int(value: object, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    if not isinstance(value, (int, float, str)):
        return fallback
    try:
        candidate = int(float(value))
    except (TypeError, ValueError):
        return fallback
    return candidate if candidate >= 0 else fallback


def _resolve_status(status: object | None, normalized_old_text: str) -> str:
    explicit = _normalize_text_field(status)
    return explicit or ("modified" if normalized_old_text else "created")


def _normalize_text_field(value: object | None) -> str:
    return str(value or "").strip()


def _line_tokens(value: str) -> list[str]:
    if value == "":
        return []
    return value.splitlines(keepends=True)


def _grouped_opcodes(
    old_tokens: list[str],
    new_tokens: list[str],
    context_lines: int,
) -> list[list[Opcode]]:
    matcher = SequenceMatcher(a=old_tokens, b=new_tokens, autojunk=False)
    return [
        list(group)
        for group in matcher.get_grouped_opcodes(n=context_lines)
        if group and not all(tag == "equal" for tag, *_rest in group)
    ]


def _build_hunks_from_groups(
    groups: list[list[Opcode]],
    old_tokens: list[str],
    new_tokens: list[str],
) -> list[dict[str, Any]]:
    return [_build_hunk(group, old_tokens, new_tokens) for group in groups]


def _build_hunk(
    group: list[Opcode],
    old_tokens: list[str],
    new_tokens: list[str],
) -> dict[str, Any]:
    first = group[0]
    last = group[-1]
    lines: list[str] = []
    for tag, old_start, old_end, new_start, new_end in group:
        if tag == "equal":
            _append_context_lines(lines, old_tokens[old_start:old_end])
        elif tag == "delete":
            _append_removed_lines(lines, old_tokens[old_start:old_end])
        elif tag == "insert":
            _append_added_lines(lines, new_tokens[new_start:new_end])
        elif tag == "replace":
            _append_removed_lines(lines, old_tokens[old_start:old_end])
            _append_added_lines(lines, new_tokens[new_start:new_end])
    return {
        "oldStart": first[1] + 1,
        "oldLines": last[2] - first[1],
        "newStart": first[3] + 1,
        "newLines": last[4] - first[3],
        "lines": lines,
    }


def _append_context_lines(target: list[str], tokens: list[str]) -> None:
    # Unified-diff convention: the no-newline marker follows a context line at
    # EOF too (it flags BOTH sides); the renderer's hunk-apply utils rely on it
    # to preserve a missing trailing newline through reject/undo reconstruction.
    for token in tokens:
        target.append(f" {_display_line(token)}")
        if not token.endswith("\n"):
            target.append(NO_NEWLINE_MARKER)


def _append_removed_lines(target: list[str], tokens: list[str]) -> None:
    for token in tokens:
        target.append(f"-{_display_line(token)}")
        if not token.endswith("\n"):
            target.append(NO_NEWLINE_MARKER)


def _append_added_lines(target: list[str], tokens: list[str]) -> None:
    for token in tokens:
        target.append(f"+{_display_line(token)}")
        if not token.endswith("\n"):
            target.append(NO_NEWLINE_MARKER)


def _display_line(token: str) -> str:
    return token[:-1] if token.endswith("\n") else token


def _count_group_changes(
    groups: list[list[Opcode]],
) -> tuple[int, int]:
    additions = 0
    deletions = 0
    for group in groups:
        for tag, old_start, old_end, new_start, new_end in group:
            if tag in {"insert", "replace"}:
                additions += new_end - new_start
            if tag in {"delete", "replace"}:
                deletions += old_end - old_start
    return additions, deletions


def _count_changed_tokens(old_text: str, new_text: str) -> tuple[int, int]:
    old_tokens = _line_tokens(old_text)
    new_tokens = _line_tokens(new_text)
    additions = 0
    deletions = 0
    matcher = SequenceMatcher(a=old_tokens, b=new_tokens, autojunk=False)
    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        if tag in {"insert", "replace"}:
            additions += new_end - new_start
        if tag in {"delete", "replace"}:
            deletions += old_end - old_start
    return additions, deletions


def _resolve_truncation_reason(hunks: list[dict[str, Any]], caps: DiffCaps) -> str | None:
    if len(hunks) > caps.max_diff_hunks:
        return "hunk_limit"
    total_lines = 0
    total_bytes = 0
    for hunk in hunks:
        lines = hunk.get("lines", [])
        total_lines += len(lines) if isinstance(lines, list) else 0
        for line in lines if isinstance(lines, list) else []:
            if len(str(line or "")) > caps.max_diff_line_chars:
                return "line_limit"
        total_bytes += _estimate_hunk_bytes(hunk)
    if total_lines > caps.max_diff_lines:
        return "line_limit"
    if total_bytes > caps.max_diff_bytes:
        return "byte_limit"
    return None


def _preflight_truncation_reason(
    groups: list[list[Opcode]],
    old_tokens: list[str],
    new_tokens: list[str],
    caps: DiffCaps,
) -> str | None:
    if len(groups) > caps.max_diff_hunks:
        return "hunk_limit"
    total_lines = 0
    for group in groups:
        for opcode in group:
            total_lines += _preflight_opcode_line_count(opcode, old_tokens, new_tokens)
            if _preflight_opcode_exceeds_line_cap(opcode, old_tokens, new_tokens, caps):
                return "line_limit"
            if total_lines > caps.max_diff_lines:
                return "line_limit"
    return None


def _preflight_opcode_line_count(
    opcode: Opcode,
    old_tokens: list[str],
    new_tokens: list[str],
) -> int:
    tag, old_start, old_end, new_start, new_end = opcode
    if tag == "equal":
        return old_end - old_start
    if tag == "delete":
        return _changed_token_line_count(old_tokens, old_start, old_end)
    if tag == "insert":
        return _changed_token_line_count(new_tokens, new_start, new_end)
    if tag == "replace":
        return _changed_token_line_count(old_tokens, old_start, old_end) + (
            _changed_token_line_count(new_tokens, new_start, new_end)
        )
    return 0


def _preflight_opcode_exceeds_line_cap(
    opcode: Opcode,
    old_tokens: list[str],
    new_tokens: list[str],
    caps: DiffCaps,
) -> bool:
    tag, old_start, old_end, new_start, new_end = opcode
    if tag == "equal":
        return _token_range_exceeds_line_cap(old_tokens, old_start, old_end, " ", caps)
    if tag == "delete":
        return _token_range_exceeds_line_cap(old_tokens, old_start, old_end, "-", caps)
    if tag == "insert":
        return _token_range_exceeds_line_cap(new_tokens, new_start, new_end, "+", caps)
    if tag == "replace":
        return _token_range_exceeds_line_cap(
            old_tokens,
            old_start,
            old_end,
            "-",
            caps,
        ) or _token_range_exceeds_line_cap(
            new_tokens,
            new_start,
            new_end,
            "+",
            caps,
        )
    return False


def _changed_token_line_count(tokens: list[str], start: int, end: int) -> int:
    count = 0
    for token in tokens[start:end]:
        count += 1
        if not token.endswith("\n"):
            count += 1
    return count


def _token_range_exceeds_line_cap(
    tokens: list[str],
    start: int,
    end: int,
    prefix: str,
    caps: DiffCaps,
) -> bool:
    for token in tokens[start:end]:
        if len(f"{prefix}{_display_line(token)}") > caps.max_diff_line_chars:
            return True
        if not token.endswith("\n") and len(NO_NEWLINE_MARKER) > caps.max_diff_line_chars:
            return True
    return False


def _estimate_hunk_bytes(hunk: dict[str, Any]) -> int:
    payload: dict[str, Any] = {
        "oldStart": _non_negative_int(hunk.get("oldStart"), 0),
        "oldLines": _non_negative_int(hunk.get("oldLines"), 0),
        "newStart": _non_negative_int(hunk.get("newStart"), 0),
        "newLines": _non_negative_int(hunk.get("newLines"), 0),
        "lines": hunk.get("lines") if isinstance(hunk.get("lines"), list) else [],
    }
    return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _build_path_log_hint(file_path: object) -> dict[str, str]:
    text = _safe_log_text(file_path)
    if not text:
        return {}
    file_name = _basename_from_path_hint(text)[:MAX_LOG_PATH_BASENAME_CHARS]
    return {
        "file_name": file_name,
        "path_hash": sha256_text(text),
    }


def _basename_from_path_hint(value: str) -> str:
    parts = [part for part in re.split(r"[\\/]+", value.strip()) if part]
    return parts[-1] if parts else ""


def _safe_log_text(value: object) -> str:
    if value is None:
        return ""
    try:
        return str(value).strip()
    except Exception:  # noqa: BLE001
        return ""
