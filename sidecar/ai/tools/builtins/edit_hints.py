"""Shared helpers for actionable 'no match' edit errors.

When a search-and-replace style edit fails to match, a small local model often
cannot recover from a bare "not found" message. These helpers locate the file
region most similar to what the model was looking for and render a bounded,
line-numbered excerpt so the model can re-anchor in a single tool round-trip.
"""

from __future__ import annotations

import difflib
import re

MAX_EXCERPT_LINES = 7
MAX_EXCERPT_LINE_CHARS = 200
CLOSEST_REGION_MIN_RATIO = 0.6
MAX_DIAGNOSTIC_CONTEXT_CHARS = 80
MAX_PREFIX_SCAN_CHARS = 64 * 1024


def collapse_horizontal_whitespace(value: str) -> str:
    """Collapse runs of spaces/tabs and trim each line, preserving line breaks."""
    return "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in value.split("\n"))


def _clip(line: str) -> str:
    if len(line) > MAX_EXCERPT_LINE_CHARS:
        return line[:MAX_EXCERPT_LINE_CHARS] + "…"
    return line


def _first_probe_line(text: str) -> str:
    return next((line.strip() for line in text.split("\n") if line.strip()), "")


def closest_region_excerpt(file_lines: list[str], target: str) -> str | None:
    """Return a bounded, line-numbered excerpt of the file region most similar to
    ``target`` (the text the edit looked for), or ``None`` when nothing in the
    file is similar enough to be a useful hint (avoids pointing at noise)."""
    probe = _first_probe_line(target)
    if not probe or not file_lines:
        return None

    best_index = -1
    best_ratio = 0.0
    matcher = difflib.SequenceMatcher(b=probe)
    for index, line in enumerate(file_lines):
        matcher.set_seq1(line.strip())
        ratio = matcher.quick_ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_index = index

    if best_index < 0 or best_ratio < CLOSEST_REGION_MIN_RATIO:
        return None

    context = MAX_EXCERPT_LINES // 2
    start = max(0, best_index - context)
    end = min(len(file_lines), best_index + context + 1)
    rendered = "\n".join(
        f"  {index + 1:>5} | {_clip(file_lines[index])}" for index in range(start, end)
    )
    return f"Closest matching region (lines {start + 1}-{end}):\n{rendered}"


def first_difference_diagnostic(content: str, target: str) -> str | None:
    """Return bounded exact-match diagnostics without scanning unbounded inputs."""
    if not target:
        return None
    probe = target[:MAX_PREFIX_SCAN_CHARS]
    best = 0
    best_actual_index = 0
    start = 0
    first = probe[0]
    while start < len(content) and best < len(probe):
        candidate = content.find(first, start)
        if candidate < 0:
            break
        matched = 0
        available = min(len(probe), len(content) - candidate)
        while matched < available and content[candidate + matched] == probe[matched]:
            matched += 1
        if matched > best:
            best = matched
            best_actual_index = candidate + matched
        start = candidate + 1
    expected = _escaped_context(target, best)
    actual = _escaped_context(content, best_actual_index)
    line_ending_only = target.replace("\r\n", "\n") in content.replace("\r\n", "\n")
    return (
        f"Matched prefix: {best} of {len(target)} characters. "
        f"First difference expected={expected!r}, actual={actual!r}. "
        f"line_ending_only={'true' if line_ending_only else 'false'}."
    )


def _escaped_context(value: str, index: int) -> str:
    start = max(0, index - MAX_DIAGNOSTIC_CONTEXT_CHARS // 2)
    end = min(len(value), index + MAX_DIAGNOSTIC_CONTEXT_CHARS // 2)
    return value[start:end].encode("unicode_escape", errors="backslashreplace").decode("ascii")
