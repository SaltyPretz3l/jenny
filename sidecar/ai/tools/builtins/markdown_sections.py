"""Bounded, fence-aware Markdown heading extraction for ``read_file``."""

from __future__ import annotations

import re
from dataclasses import dataclass

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.contracts import ToolExecutionFailure

MAX_MARKDOWN_SECTION_OUTPUT_CHARS = 15_000
MAX_REQUESTED_HEADINGS = 20
_MAX_HEADING_INDENT_SPACES = 3

_ATX_RE = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$")
_SETEXT_RE = re.compile(r"^ {0,3}(=+|-+)[ \t]*$")
_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_CLOSING_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*$")
_SPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class MarkdownSectionRead:
    text: str
    matched_headings: tuple[str, ...]
    missing_headings: tuple[str, ...]
    truncated: bool


@dataclass(frozen=True)
class _Heading:
    line_index: int
    level: int
    title: str
    normalized: str


def parse_requested_headings(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or len(value) > MAX_REQUESTED_HEADINGS:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"tool argument 'headings' must contain 1-{MAX_REQUESTED_HEADINGS} strings",
            retryable=False,
        )
    headings: list[str] = []
    for item in value:
        if not isinstance(item, str) or not normalize_heading(item):
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="tool argument 'headings' must contain only non-empty strings",
                retryable=False,
            )
        headings.append(item.strip())
    return tuple(headings)


def normalize_heading(value: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^#{1,6}\s+", "", text)
    text = re.sub(r"\s+#+\s*$", "", text)
    return _SPACE_RE.sub(" ", text).strip().casefold()


def extract_markdown_sections(
    text: str,
    requested: tuple[str, ...],
    *,
    max_chars: int = MAX_MARKDOWN_SECTION_OUTPUT_CHARS,
) -> MarkdownSectionRead:
    lines = text.splitlines(keepends=True)
    headings = _scan_headings(lines)
    requested_by_normalized = {normalize_heading(item): item for item in requested}
    matched_normalized = {
        heading.normalized for heading in headings if heading.normalized in requested_by_normalized
    }
    missing = tuple(
        item for item in requested if normalize_heading(item) not in matched_normalized
    )
    if not matched_normalized:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="none of the requested Markdown headings were found",
            retryable=False,
        )

    selected: set[int] = set()
    matched_titles: list[str] = []
    for index, heading in enumerate(headings):
        if heading.normalized not in matched_normalized:
            continue
        matched_titles.append(heading.title)
        end = len(lines)
        for later in headings[index + 1 :]:
            if later.level <= heading.level:
                end = later.line_index
                break
        selected.update(range(heading.line_index, end))

    rendered = "".join(line for index, line in enumerate(lines) if index in selected)
    truncated = len(rendered) > max_chars
    if truncated:
        rendered = rendered[:max_chars]
    return MarkdownSectionRead(
        text=rendered,
        matched_headings=tuple(matched_titles),
        missing_headings=missing,
        truncated=truncated,
    )


def _scan_headings(lines: list[str]) -> list[_Heading]:
    headings: list[_Heading] = []
    active_fence: tuple[str, int] | None = None
    index = 0
    while index < len(lines):
        raw = lines[index].rstrip("\r\n")
        if active_fence is not None:
            closing = _CLOSING_FENCE_RE.match(raw)
            if closing:
                marker = closing.group(1)
                if marker[0] == active_fence[0] and len(marker) >= active_fence[1]:
                    active_fence = None
            index += 1
            continue
        fence = _FENCE_RE.match(raw)
        if fence:
            marker = fence.group(1)
            active_fence = (marker[0], len(marker))
            index += 1
            continue

        atx = _ATX_RE.match(raw)
        if atx:
            title = atx.group(2).strip()
            headings.append(
                _Heading(index, len(atx.group(1)), title, normalize_heading(title))
            )
            index += 1
            continue
        if (
            index + 1 < len(lines)
            and raw.strip()
            and len(raw) - len(raw.lstrip(" ")) <= _MAX_HEADING_INDENT_SPACES
        ):
            underline = _SETEXT_RE.match(lines[index + 1].rstrip("\r\n"))
            if underline:
                title = raw.strip()
                level = 1 if underline.group(1).startswith("=") else 2
                headings.append(_Heading(index, level, title, normalize_heading(title)))
                index += 2
                continue
        index += 1
    return headings
