"""Shared model-facing renderer for structured tool-result envelopes."""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from sidecar.ai.tools.failure_taxonomy import FAILURE_CLASSES, RETRY_DISPOSITIONS
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate

_OPEN_TAG = "<untrusted_tool_output>"
_CLOSE_TAG = "</untrusted_tool_output>"
_DETAIL_LIMIT = 240
_WHITESPACE_RE = re.compile(r"\s+")
# Leading whitespace still renders as a Markdown heading in most viewers, so
# an indented forged header is as dangerous as a column-zero one.
_TOOL_RESULT_HEADER_RE = re.compile(r"(?m)^[ \t]*## Tool Result")
_EFFECTS_VOCABULARY = frozenset({"none", "committed", "partial", "unknown"})

_FIX_TEMPLATES: dict[str, str] = {
    "bad_arguments": "Correct the tool arguments to match the schema, then retry.",
    "precondition_unmet": "Satisfy the stated precondition, then retry the tool.",
    "not_found": (
        "The named entity does not exist. List or search first (list_dir, glob_files, "
        "grep_search), then retry with a name from the results."
    ),
    "conflict": "Refresh the current state, resolve the conflict, then retry.",
    "denied": (
        "Do not retry; choose an allowed operation or ask the user to change the relevant "
        "permission."
    ),
    "cancelled": (
        "Confirm the operation is still wanted, then retry only after cancellation clears."
    ),
    "unavailable": "Use an available tool or restore the required runtime before trying again.",
    "limit_exceeded": "Reduce the request size or scope to fit the stated limit, then retry.",
    "transient": "Retry the same arguments after a brief delay.",
    "internal_error": (
        "Do not retry automatically; inspect diagnostics and use a safer alternative."
    ),
}


_FIELD_LIMIT = 240


def _optional_text(value: object) -> str | None:
    """Single-line, bounded field value.

    Field values arrive from handler metadata and persisted history; an
    embedded newline would let them forge envelope lines, so whitespace runs
    collapse to single spaces before the bound is applied.
    """
    if value is None:
        return None
    text = _WHITESPACE_RE.sub(" ", str(value)).strip()
    return text[:_FIELD_LIMIT] if text else None


def _coerce_elapsed_ms(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return None
    try:
        parsed = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    if not parsed.is_finite() or parsed < 0:
        return None
    return int(parsed)


def _header_identifier(value: object, *, fallback: str) -> str:
    """Bound and single-line an identifier before header interpolation.

    Provider-supplied call ids keep internal newlines, and persisted history
    supplies tool names unflattened — either could otherwise forge an early
    close tag or a second trusted-looking header ABOVE the genuine wrapper.
    """
    text = _WHITESPACE_RE.sub(" ", str(value or "")).strip()
    text = text.replace("## Tool Result", "[escaped]")
    text = text.replace(_OPEN_TAG, "[escaped]").replace(_CLOSE_TAG, "[escaped]")
    return text[:100] or fallback


# Every terminator a downstream renderer or tokenizer might treat as a line
# break. `(?m)^` anchors only after \n, so a lone \r (or \v, \f, NEL, LS, PS)
# would otherwise smuggle a forged header past neutralization — the history
# lane re-wraps PERSISTED text that never went through the output sanitizer's
# newline normalization.
_LINE_TERMINATOR_RE = re.compile('\r\n|[\r\x0b\x0c\x85\u2028\u2029]')


def _neutralize_body(text: str) -> str:
    text = _LINE_TERMINATOR_RE.sub("\n", text)
    neutralized = _TOOL_RESULT_HEADER_RE.sub("## [escaped] Tool Result", text)
    neutralized = neutralized.replace(_OPEN_TAG, "<untrusted_tool_output[escaped]>")
    return neutralized.replace(_CLOSE_TAG, "</untrusted_tool_output[escaped]>")


def _sanitize_detail(value: object) -> str | None:
    flattened = _WHITESPACE_RE.sub(" ", str(value or "")).strip()
    if not flattened:
        return None
    sanitized = sanitize_tool_output_no_truncate(flattened)
    sanitized = sanitized.replace("## Tool Result", "## [escaped] Tool Result")
    sanitized = sanitized.replace(_OPEN_TAG, "<untrusted_tool_output[escaped]>")
    sanitized = sanitized.replace(_CLOSE_TAG, "</untrusted_tool_output[escaped]>")
    return sanitized[:_DETAIL_LIMIT]


def render_tool_result_envelope(
    *,
    tool_id: str,
    call_id: str,
    ok: bool,
    output_text: object,
    effects: str | None = None,
    elapsed_ms: int | str | None = None,
    failure_class: str | None = None,
    error_code: str | None = None,
    failed_phase: str | None = None,
    trace: str | None = None,
    detail: str | None = None,
    remediation: str | None = None,
) -> str:
    """Render the closed W1 envelope without mutating the raw tool output."""
    header_tool = _header_identifier(tool_id, fallback="tool")
    header_call = _header_identifier(call_id, fallback="call")
    lines = [
        f"## Tool Result — {header_tool} [{header_call}]",
        f"outcome: {'ok' if ok else 'error'}",
    ]
    elapsed = _coerce_elapsed_ms(elapsed_ms)
    if effects is not None and effects not in _EFFECTS_VOCABULARY:
        effects = None  # closed vocabulary: an invalid claim renders as absent, never as fact

    if ok:
        if (effects_text := _optional_text(effects)) is not None:
            lines.append(f"effects: {effects_text}")
        if elapsed is not None:
            lines.append(f"elapsed_ms: {elapsed}")
    else:
        valid_failure_class = (
            failure_class if failure_class in FAILURE_CLASSES else None
        )
        if valid_failure_class is not None:
            lines.append(f"error_class: {valid_failure_class}")
        if (error_code_text := _optional_text(error_code)) is not None:
            lines.append(f"error_code: {error_code_text}")
        if (effects_text := _optional_text(effects)) is not None:
            lines.append(f"effects: {effects_text}")
        if (failed_phase_text := _optional_text(failed_phase)) is not None:
            lines.append(f"failed_phase: {failed_phase_text}")
        if elapsed is not None:
            lines.append(f"elapsed_ms: {elapsed}")
        if valid_failure_class is not None:
            lines.append(f"retry: {RETRY_DISPOSITIONS[valid_failure_class]}")
            fix = _optional_text(remediation) or _FIX_TEMPLATES[valid_failure_class]
            lines.append(f"fix: {fix}")
        if (trace_text := _optional_text(trace)) is not None:
            lines.append(f"trace: {trace_text}")
        if (detail_text := _sanitize_detail(detail)) is not None:
            lines.append(f"detail: {detail_text}")

    body = _neutralize_body(str(output_text or ""))
    lines.extend((_OPEN_TAG, body, _CLOSE_TAG))
    return "\n".join(lines)
