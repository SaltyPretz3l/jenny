"""UI-only tool-step log for one subagent run (Subagent Monitor drill-in).

Lives beside the delegate contracts it shares sanitizers with; the steps ride
only in the report metadata, never in the parent model's tool output.
"""

from __future__ import annotations

import re
from typing import Any

from sidecar.ai.routing.delegate_contracts import (
    _WHITESPACE_RE,
    DELEGATE_TOOL_NAME,
    _safe_relative_path,
    _safe_text,
    _truncate_with_ellipsis,
    strip_format_controls,
)
from sidecar.ai.tools.catalog import tool_display_name
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate, truncate_text

MAX_CHILD_STEPS = 40
MAX_CHILD_STEP_NAME_CHARS = 64
MAX_CHILD_STEP_TEXT_CHARS = 160
MAX_CHILD_STEP_PATTERN_CHARS = 60
MAX_CHILD_STEP_RANGE_CHARS = 40
MAX_CHILD_STEP_HEADING_CHARS = 30
MAX_CHILD_ANSWER_CHARS = 4_000
# Shorter input-path fragments would scrub ordinary words out of an error line.
_MIN_PATH_NEEDLE_CHARS = 3
_STEP_PATH_KEYS = ("path", "file_path", "relative_path")
_EN_DASH = "\u2013"
_PAGES_KEEP_RE = re.compile(r"[^0-9,\- ]")
# Only a read tool's out-of-root target falls back to its file name (R-M8);
# a listing or search target could name a directory such as the user's home.
_BASENAME_FALLBACK_TOOL_PREFIX = "read_"
_ONE_FILE_WRITE_TOOLS = frozenset({"edit_file", "write_file"})
# A quoted span holding a separator is a path an OS error echoed (an OSError
# repr keeps spaces and doubles backslashes), so it goes first, whole.
_QUOTED_PATH_RE = re.compile(r"""(['"])(?=[^'"\n]*[\\/])[^'"\n]*\1""")
# A path may hold spaces: after the first run, keep eating words that hold
# a separator ("C:\Users\me\My Docs\a.txt" -> "<path>", not "<path> Docs\a.txt").
_SPACED_PATH_TAIL = r"(?: [^\s\"'`<>|()]*[\\/][^\s\"'`<>|()]*)*"
_WINDOWS_ABSOLUTE_RE = re.compile(r"[A-Za-z]:[\\/][^\s\"'`<>|]*" + _SPACED_PATH_TAIL)
_POSIX_ABSOLUTE_RE = re.compile(r"(?<![\w.:/~-])/(?:[\w.@+-]+/)+[\w.@+-]*" + _SPACED_PATH_TAIL)
_UNC_PATH_RE = re.compile(r"(?:\\\\|//)[^\s\"'`<>|\\/()]+[\\/][^\s\"'`<>|()]*")
_PARENT_RELATIVE_RE = re.compile(r"(?:\.\.[\\/])+[^\s\"'`<>|()]*")
_HOME_RELATIVE_RE = re.compile(r"(?<![\w.])~[\\/][^\s\"'`<>|()]*")
_PATH_PATTERNS = (
    _QUOTED_PATH_RE,
    _UNC_PATH_RE,
    _WINDOWS_ABSOLUTE_RE,
    _POSIX_ABSOLUTE_RE,
    _PARENT_RELATIVE_RE,
    _HOME_RELATIVE_RE,
)


def build_child_steps(decision: Any | None) -> list[dict[str, Any]]:
    """Bounded, UI-only tool-step log for one child run.

    Never carries successful tool output; only a relativized target and, for
    failed steps, one sanitized error line.
    """

    steps: list[dict[str, Any]] = []
    for outcome in tuple(getattr(decision, "tool_results", ()) or ()):
        if len(steps) >= MAX_CHILD_STEPS:
            break
        tool = _step_text(getattr(outcome, "tool_name", ""), MAX_CHILD_STEP_NAME_CHARS)
        if not tool:
            continue
        ok = getattr(outcome, "success", False) is True
        step: dict[str, Any] = {
            "tool": tool,
            "display": _step_text(tool_display_name(tool), MAX_CHILD_STEP_NAME_CHARS) or tool,
            "ok": ok,
        }
        tool_input = getattr(outcome, "tool_input", None)
        tool_input = tool_input if isinstance(tool_input, dict) else {}
        if ok:
            # Only a call the tool admitted gets a target: a failed call may have
            # been refused at the workspace boundary (a symlink or junction out
            # of the root reads as a lexically relative path), so its row shows
            # the scrubbed error instead.
            target = _step_target(tool, tool_input, getattr(outcome, "metadata", None))
            if target:
                step["target"] = target
            step_range = _step_range(tool_input, getattr(outcome, "metadata", None))
            if step_range:
                step["range"] = step_range
            # Only a single-file tool's workspace-relative spelling is a
            # clickable path: a directory root, a home-relative path or a
            # read tool's basename fallback stays plain text.
            step_path = _safe_relative_path(_first_input_path(tool_input))
            if step_path and _opens_one_file(tool) and not step_path.startswith("~"):
                step["path"] = step_path
        else:
            code = _step_text(getattr(outcome, "error_code", None), MAX_CHILD_STEP_NAME_CHARS)
            if code:
                step["error_code"] = code
            detail = _step_error_detail(getattr(outcome, "output", ""), _input_paths(tool_input))
            if detail:
                step["detail"] = detail
        steps.append(step)
    return steps


def _step_text(value: object, max_chars: int) -> str:
    return strip_format_controls(_safe_text(value, max_chars=max_chars))


def _input_paths(tool_input: dict[str, Any]) -> list[str]:
    return [
        tool_input[key]
        for key in _STEP_PATH_KEYS
        if isinstance(tool_input.get(key), str) and tool_input[key].strip()
    ]


def _basename(value: str) -> str:
    return value.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]


def _opens_one_file(tool: str) -> bool:
    return tool.startswith(_BASENAME_FALLBACK_TOOL_PREFIX) or tool in _ONE_FILE_WRITE_TOOLS


def _first_input_path(tool_input: dict[str, Any]) -> str:
    return next(iter(_input_paths(tool_input)), "")


def _step_target(tool: str, tool_input: dict[str, Any], metadata: object) -> str:
    raw_path = _first_input_path(tool_input)
    path = _safe_relative_path(raw_path)
    if not path and raw_path and tool.startswith(_BASENAME_FALLBACK_TOOL_PREFIX):
        basename = _basename(raw_path)
        if basename not in {"", ".", ".."}:
            path = _step_text(basename, MAX_CHILD_STEP_TEXT_CHARS)
    pattern = tool_input.get("pattern")
    quoted = ""
    if isinstance(pattern, str) and pattern.strip():
        text = _WHITESPACE_RE.sub(" ", _step_text(pattern, 200)).strip()
        if text:
            quoted = f'"{_truncate_with_ellipsis(text, MAX_CHILD_STEP_PATTERN_CHARS)}"'
    target = f"{quoted} in {path}" if quoted and path else quoted or path
    if not target:
        return ""
    return _truncate_with_ellipsis(target, MAX_CHILD_STEP_TEXT_CHARS)


def _int_value(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _step_page(tool_input: dict[str, Any], metadata: object) -> int | None:
    sources = (tool_input, metadata if isinstance(metadata, dict) else {})
    for source in sources:
        value = _int_value(source.get("page"))
        if value is not None and value > 0:
            return value
    return None


def _step_range(tool_input: dict[str, Any], metadata: object) -> str:
    """Short page/line range label; never echoes a cursor value."""

    page = _step_page(tool_input, metadata)
    cursor = tool_input.get("cursor")
    candidates = (
        _pages_label(tool_input.get("pages")),
        f"p{page}" if page is not None else "",
        _lines_label(tool_input.get("offset"), tool_input.get("limit")),
        "cont." if isinstance(cursor, str) and cursor.strip() else "",
        _heading_label(tool_input.get("headings")),
    )
    return next((label for label in candidates if label), "")


def _pages_label(pages: object) -> str:
    if not isinstance(pages, str):
        return ""
    value = _WHITESPACE_RE.sub(" ", _PAGES_KEEP_RE.sub("", pages)).strip()
    if not value:
        return ""
    return _truncate_with_ellipsis(f"p{value.replace('-', _EN_DASH)}", MAX_CHILD_STEP_RANGE_CHARS)


def _lines_label(offset: object, limit: object) -> str:
    start = _int_value(offset)
    start = start if start is not None and start >= 0 else None
    count = _int_value(limit)
    count = count if count is not None and count >= 1 else None
    if start is not None and count is not None:
        return f"lines {start + 1}{_EN_DASH}{start + count}"
    if start is not None:
        return f"from line {start + 1}"
    if count is not None:
        return f"lines 1{_EN_DASH}{count}"
    return ""


def _heading_label(headings: object) -> str:
    if not isinstance(headings, list) or not headings or not isinstance(headings[0], str):
        return ""
    heading = _WHITESPACE_RE.sub(" ", _step_text(headings[0], 200)).strip()
    if not heading:
        return ""
    return f"§ {_truncate_with_ellipsis(heading, MAX_CHILD_STEP_HEADING_CHARS)}"


def child_answer(response_text: object, *, summary_chars: int) -> tuple[str, str, bool]:
    """One sanitize pass over the child's reply: the summary and the stored
    answer, each cut exactly as ``_safe_text`` cuts (the parent reads the
    answer), and whether the reply was longer than the stored answer."""

    full = sanitize_tool_output_no_truncate(response_text, tool_name=DELEGATE_TOOL_NAME)
    summary = truncate_text(full, summary_chars).strip()
    answer = strip_format_controls(truncate_text(full, MAX_CHILD_ANSWER_CHARS).strip())
    return summary, answer, len(full) > MAX_CHILD_ANSWER_CHARS


def scrub_failed_paths(text: str, tool_input: object, *, max_chars: int) -> str:
    """The failed-step path scrub over the first ``max_chars`` of ``text``.

    ``text`` must already be sanitized. The rejected input paths and every
    path-like run become ``<path>``; a short path grows into ``<path>``, so the
    caller cuts the result to its own bound.
    """

    paths = _input_paths(tool_input) if isinstance(tool_input, dict) else []
    return _scrub_paths(text[:max_chars], paths)


def _step_error_detail(output: object, input_paths: list[str]) -> str:
    sanitized = _step_text(output, 1_000)
    first_line = next((line.strip() for line in sanitized.splitlines() if line.strip()), "")
    return _truncate_with_ellipsis(_scrub_paths(first_line, input_paths), MAX_CHILD_STEP_TEXT_CHARS)


def _scrub_paths(text: str, input_paths: list[str]) -> str:
    # The rejected input path (in either separator spelling, its repr with
    # doubled backslashes, and its file name) goes first: it may hold spaces
    # the pattern scrubs cannot see. Needles under three characters would
    # scrub ordinary words, not paths.
    needles: set[str] = set()
    for raw in input_paths:
        value = raw.strip()
        if value.startswith("./"):
            value = value[2:]
        backward = value.replace("/", "\\")
        spellings = (
            value,
            value.replace("\\", "/"),
            backward,
            backward.replace("\\", "\\\\"),
        )
        for spelling in spellings:
            if len(spelling) >= _MIN_PATH_NEEDLE_CHARS:
                needles.add(spelling)
        name = _basename(value)
        if len(name) >= _MIN_PATH_NEEDLE_CHARS:
            needles.add(name)
    # Case-insensitive: a Windows filesystem may echo the path in another case.
    for needle in sorted(needles, key=len, reverse=True):
        text = re.sub(re.escape(needle), "<path>", text, flags=re.IGNORECASE)
    for pattern in _PATH_PATTERNS:
        text = pattern.sub("<path>", text)
    return text


__all__ = [
    "MAX_CHILD_ANSWER_CHARS",
    "MAX_CHILD_STEPS",
    "build_child_steps",
    "child_answer",
    "scrub_failed_paths",
]
