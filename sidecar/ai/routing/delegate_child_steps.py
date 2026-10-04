"""UI-only tool-step log for one subagent run (Subagent Monitor drill-in).

Lives beside the delegate contracts it shares sanitizers with; the steps ride
only in the report metadata, never in the parent model's tool output.
"""

from __future__ import annotations

import re
from typing import Any

from sidecar.ai.routing.delegate_contracts import (
    _WHITESPACE_RE,
    _safe_relative_path,
    _safe_text,
    _truncate_with_ellipsis,
    strip_format_controls,
)
from sidecar.ai.tools.catalog import tool_display_name

MAX_CHILD_STEPS = 40
MAX_CHILD_STEP_NAME_CHARS = 64
MAX_CHILD_STEP_TEXT_CHARS = 160
MAX_CHILD_STEP_PATTERN_CHARS = 60
MAX_CHILD_ANSWER_CHARS = 4_000
# Shorter input-path fragments would scrub ordinary words out of an error line.
_MIN_PATH_NEEDLE_CHARS = 3
_STEP_PATH_KEYS = ("path", "file_path", "relative_path")
# Only a read tool's out-of-root target falls back to its file name (R-M8);
# a listing or search target could name a directory such as the user's home.
_BASENAME_FALLBACK_TOOL_PREFIX = "read_"
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


def _step_target(tool: str, tool_input: dict[str, Any], metadata: object) -> str:
    raw_path = next(iter(_input_paths(tool_input)), "")
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
    page = _step_page(tool_input, metadata)
    if page is not None:
        target = f"{target} · p{page}"
    return _truncate_with_ellipsis(target, MAX_CHILD_STEP_TEXT_CHARS)


def _step_page(tool_input: dict[str, Any], metadata: object) -> int | None:
    sources = (tool_input, metadata if isinstance(metadata, dict) else {})
    for source in sources:
        value = source.get("page")
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
    return None


def _step_error_detail(output: object, input_paths: list[str]) -> str:
    sanitized = _step_text(output, 1_000)
    first_line = next((line.strip() for line in sanitized.splitlines() if line.strip()), "")
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
        first_line = re.sub(re.escape(needle), "<path>", first_line, flags=re.IGNORECASE)
    for pattern in _PATH_PATTERNS:
        first_line = pattern.sub("<path>", first_line)
    return _truncate_with_ellipsis(first_line, MAX_CHILD_STEP_TEXT_CHARS)


__all__ = [
    "MAX_CHILD_ANSWER_CHARS",
    "MAX_CHILD_STEPS",
    "build_child_steps",
]
