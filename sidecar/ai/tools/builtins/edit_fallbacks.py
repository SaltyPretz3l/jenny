"""Deterministic, uniquely anchored edit fallbacks on LF-normalised text."""

from __future__ import annotations

from dataclasses import dataclass
from os.path import commonprefix

_TYPOGRAPHY = str.maketrans({
    **dict.fromkeys('“”„″', '"'),
    **dict.fromkeys("‘’‚′", "'"),
    **dict.fromkeys("–—−", "-"),
    "\u00a0": " ",
})


@dataclass(frozen=True)
class FallbackMatch:
    step: str
    start: int
    end: int
    replacement: str


@dataclass(frozen=True)
class FallbackAmbiguity:
    step: str
    count: int

    @property
    def notice(self) -> str:
        return (
            f"A normalised match was ambiguous ({self.step}: {self.count} places); "
            "include more surrounding lines."
        )


def _normalise(text: str, *, typography: bool) -> tuple[str, list[int]]:
    """Keep a source offset for each retained character, including newlines."""
    parts: list[str] = []
    offsets: list[int] = []
    offset = 0
    for line in text.split("\n"):
        mapped = line.translate(_TYPOGRAPHY) if typography else line
        kept = mapped.rstrip(" \t")
        parts.append(kept)
        offsets.extend(range(offset, offset + len(kept)))
        offset += len(line)
        if offset < len(text):
            offsets.append(offset)
        offset += 1
    return "\n".join(parts), offsets


def _preserve_lines(original: str, old: str, new: str, *, typography: bool) -> str:
    original_lines, old_lines, new_lines = original.split("\n"), old.split("\n"), new.split("\n")
    for index in range(min(len(original_lines), len(old_lines), len(new_lines))):
        old_line = _normalise(old_lines[index], typography=typography)[0]
        new_line = _normalise(new_lines[index], typography=typography)[0]
        if old_line == new_line:
            new_lines[index] = original_lines[index]
    return "\n".join(new_lines)


def _substring_match(
    content: str, old: str, new: str, *, typography: bool
) -> FallbackMatch | FallbackAmbiguity | None:
    step = "typography" if typography else "trailing_whitespace"
    haystack, offsets = _normalise(content, typography=typography)
    needle = _normalise(old, typography=typography)[0]
    if not needle:
        return None
    spans: list[tuple[int, int]] = []
    position = haystack.find(needle)
    while position >= 0:
        stop = position + len(needle)
        start, end = offsets[position], offsets[stop - 1] + 1
        # Include stripped trailing whitespace at a matched end-of-line.
        if not needle.endswith("\n") and (stop == len(haystack) or haystack[stop] == "\n"):
            end = offsets[stop] if stop < len(offsets) else len(content)
        if _normalise(content[start:end], typography=typography)[0] == needle:
            spans.append((start, end))
        position = haystack.find(needle, position + 1)
    if len(spans) > 1:
        return FallbackAmbiguity(step, len(spans))
    if not spans:
        return None
    start, end = spans[0]
    replacement = _preserve_lines(content[start:end], old, new, typography=typography)
    return FallbackMatch(step, start, end, replacement)


def _indent(lines: list[str]) -> str:
    prefixes = [line[:len(line) - len(line.lstrip(" \t"))] for line in lines if line.strip()]
    return commonprefix(prefixes) if prefixes else ""


def _dedent(lines: list[str], indent: str) -> list[str]:
    return [line[len(indent):] if line.strip() else "" for line in lines]


def _indentation_match(
    content: str, old: str, new: str
) -> FallbackMatch | FallbackAmbiguity | None:
    normal_old = _normalise(old, typography=True)[0]
    old_lines = normal_old.removesuffix("\n").split("\n")
    old_indent = _indent(old_lines)
    target = _dedent(old_lines, old_indent)
    if not any(target):
        return None
    lines = content.split("\n")
    if content.endswith("\n"):
        lines.pop()
    normal_lines = [_normalise(line, typography=True)[0] for line in lines]
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line) + 1)
    matches: list[tuple[int, int, str]] = []
    for index in range(len(lines) - len(target) + 1):
        run = normal_lines[index:index + len(target)]
        indent = _indent(run)
        if _dedent(run, indent) == target:
            end = offsets[index + len(target)] - 1
            if old.endswith("\n"):
                if content[end:end + 1] != "\n":
                    continue
                end += 1
            matches.append((offsets[index], end, indent))
    if len(matches) > 1:
        return FallbackAmbiguity("indentation", len(matches))
    if not matches:
        return None
    start, end, indent = matches[0]
    replacement = "\n".join(
        indent + line.removeprefix(old_indent) if line.strip() else ""
        for line in new.split("\n")
    )
    return FallbackMatch("indentation", start, end, replacement)


def find_fallback(content: str, old: str, new: str) -> FallbackMatch | FallbackAmbiguity | None:
    """Stop at the first unique match or ambiguity; callers gate exact/replace-all/flags."""
    for typography in (False, True):
        result = _substring_match(content, old, new, typography=typography)
        if result is not None:
            return result
    return _indentation_match(content, old, new)
