"""Layout-preserving PDF text reconstruction and continuation helpers."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from statistics import median
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate

_DOT_RUN = re.compile(r"\.{3,}")
_CURSOR = re.compile(r"pdf:([0-9a-f]{16}):([1-9][0-9]*):([1-9][0-9]*)")
# Pages per read_file call; three dense pages fit the response budget.
MAX_PDF_PAGES = 3
# `unread_pages` stays well inside every output-string clip so it remains valid syntax.
_UNREAD_MAX_CHARS = 200
# Model-facing guidance attached to every PDF read, OCR or not, on both read paths.
SOURCES_NOTE = (
    'Lines are numbered per page as "<n>: <text>"; cite that n, never a row number '
    "printed in the document. When your answer states figures or facts from this PDF, "
    "copy them verbatim and end with a Sources table (Item | Value | Where | OCR), one "
    "row per value, Where as p<page> L<n>. OCR: no on text-layer pages, uncertain when "
    "the value contains an ocr_uncertain token, otherwise yes. No commentary in the table."
)
# A token made only of dots this long or longer is a leader, never content.
_LEADER_MIN_DOTS = 2
# Glyph-width estimation ignores very short tokens (punctuation, digits).
_WIDTH_SAMPLE_MIN_CHARS = 3


@dataclass(frozen=True)
class PdfTextLine:
    number: int
    text: str
    y: float


@dataclass(frozen=True)
class PdfCursor:
    digest: str
    page: int
    line: int


@dataclass(frozen=True)
class _Word:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str

    @property
    def center(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def height(self) -> float:
        return self.y1 - self.y0


def _clean_token(token: str) -> str | None:
    if token == "..":
        return token
    if token and set(token) == {"."}:
        if len(token) >= _LEADER_MIN_DOTS:
            return None
        return token
    cleaned = _DOT_RUN.sub(" ", token).strip()
    return cleaned or None


def reconstruct_page_lines(
    page: Any,
    *,
    textpage: Any | None = None,
    words: Sequence[tuple[Any, ...]] | None = None,
) -> list[PdfTextLine]:
    """Reconstruct page words into stable, position-preserving text lines."""

    raw_words = (
        words
        if words is not None
        else (
            page.get_text("words")
            if textpage is None
            else page.get_text("words", textpage=textpage)
        )
    )
    parsed_words: list[_Word] = []
    for item in raw_words:
        x0, y0, x1, y1, token, _block, _line, _word = item
        cleaned = _clean_token(str(token))
        if cleaned is not None:
            parsed_words.append(_Word(float(x0), float(y0), float(x1), float(y1), cleaned))

    widths = [
        (word.x1 - word.x0) / len(word.text)
        for word in parsed_words
        if len(word.text) >= _WIDTH_SAMPLE_MIN_CHARS
    ]
    character_width = min(8.0, max(3.0, median(widths) if widths else 5.0))

    bands: list[list[_Word]] = []
    for word in sorted(parsed_words, key=lambda item: (item.center, item.x0)):
        if bands:
            first = bands[-1][0]
            tolerance = 0.5 * min(word.height, first.height)
            if abs(word.center - first.center) > tolerance:
                bands.append([word])
                continue
            bands[-1].append(word)
        else:
            bands.append([word])

    rendered: list[PdfTextLine] = []
    page_x0 = float(page.rect.x0)
    for band in bands:
        text = ""
        for word in sorted(band, key=lambda item: item.x0):
            column = round((word.x0 - page_x0) / character_width)
            if text and column <= len(text):
                column = len(text) + 1
            text = text.ljust(column) + word.text
        text = text.rstrip()
        if text:
            rendered.append(
                PdfTextLine(
                    number=len(rendered) + 1,
                    text=text,
                    y=min(word.y0 for word in band),
                )
            )
    return rendered


def render_lines(
    lines: Sequence[PdfTextLine],
    *,
    start: int = 1,
    max_chars: int,
) -> tuple[str, int]:
    """Render as many whole numbered lines as fit the character budget."""

    if start < 1:
        raise ValueError("start must be positive")
    start_index = start - 1
    if start_index >= len(lines):
        return "", 0
    rendered: list[str] = []
    for line in lines[start_index:]:
        candidate = f"{line.number}: {line.text}"
        candidate_length = len(candidate) + (1 if rendered else 0)
        if rendered and len("\n".join(rendered)) + candidate_length > max_chars:
            return "\n".join(rendered), line.number
        rendered.append(candidate)
    return "\n".join(rendered), 0


def _render_count(
    lines: Sequence[PdfTextLine],
    *,
    start: int,
    count: int,
    next_line: int,
) -> tuple[str, int]:
    selected = lines[start - 1 : start - 1 + count]
    text = "\n".join(f"{line.number}: {line.text}" for line in selected)
    return text, next_line


def fit_excerpts(
    pages: Sequence[Sequence[PdfTextLine]],
    *,
    starts: Sequence[int],
    page_max_chars: int,
    total_max_chars: int,
    serialized_length: Callable[[Sequence[str]], int],
) -> list[tuple[str, int]]:
    """Trim page excerpts by whole lines until the serialized payload fits."""

    if len(starts) != len(pages):
        raise ValueError("starts must have one entry per page")
    results = [
        render_lines(page, start=starts[index], max_chars=page_max_chars)
        for index, page in enumerate(pages)
    ]
    counts = [
        max(0, (next_line or len(pages[index]) + 1) - starts[index])
        for index, (_text, next_line) in enumerate(results)
    ]
    while serialized_length([text for text, _next in results]) > total_max_chars:
        candidates = [index for index, count in enumerate(counts) if count > 1]
        if not candidates:
            break
        index = max(candidates, key=lambda value: (len(results[value][0]), -value))
        counts[index] -= 1
        dropped = pages[index][starts[index] - 1 + counts[index]]
        results[index] = _render_count(
            pages[index],
            start=starts[index],
            count=counts[index],
            next_line=dropped.number,
        )
    return results


CONTINUATION_HINT = (
    "Some pages show only part of their lines; call read_file again with "
    "cursor={cursor} (no 'pages') to receive the next lines of that page without "
    "gaps. Each truncated page carries its own continue_cursor."
)


def excerpt_fields(
    lines: Sequence[PdfTextLine],
    *,
    start: int,
    excerpt: str,
    page: int,
    digest: str,
) -> dict[str, object]:
    """Model-visible fields for one page excerpt emitted by ``render_lines``.

    ``excerpt`` holds consecutive whole lines from ``start``, so the first
    omitted line is always ``lines_to + 1`` -- the same value ``fit_excerpts``
    reports -- which lets one function serve both budget measurement and the
    final payload.
    """

    emitted = excerpt.count("\n") + 1 if excerpt else 0
    lines_from = start if emitted else 0
    lines_to = start + emitted - 1 if emitted else 0
    fields: dict[str, object] = {
        "text_excerpt": excerpt,
        "line_count": len(lines),
        "lines_from": lines_from,
        "lines_to": lines_to,
    }
    if lines_to < len(lines):
        next_line = lines_to + 1
        fields["text_truncated"] = True
        fields["next_line"] = next_line
        fields["continue_cursor"] = encode_cursor(digest=digest, page=page, line=next_line)
    return fields


def continuation_summary(pages: Sequence[dict[str, object]]) -> dict[str, object]:
    """Top-level continuation fields: the first truncated page's cursor + hint."""

    summary: dict[str, object] = {"text_format": "numbered_lines"}
    for page in pages:
        cursor = page.get("continue_cursor")
        if isinstance(cursor, str):
            summary["cursor"] = cursor
            summary["continuation_hint"] = CONTINUATION_HINT.format(cursor=cursor)
            break
    return summary


def document_digest(raw_pdf: bytes) -> str:
    return hashlib.sha256(raw_pdf).hexdigest()[:16]


def encode_cursor(*, digest: str, page: int, line: int) -> str:
    return f"pdf:{digest}:{page}:{line}"


def decode_cursor(value: object) -> PdfCursor:
    match = _CURSOR.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="tool argument 'cursor' is invalid; expected pdf:<digest>:<page>:<line>",
            retryable=False,
        )
    digest, page, line = match.groups()
    return PdfCursor(digest=digest, page=int(page), line=int(line))


def _pages_failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_EXECUTION_FAILED, message=message, retryable=False)


def _parse_page_token(token: str, *, page_count: int) -> range | list[int]:
    """One comma-separated `pages` token: a page number or an inclusive range."""

    if "-" not in token:
        if not token.isdigit():
            raise _pages_failure("tool argument 'pages' must contain only positive page numbers")
        return [int(token)]
    start_text, end_text = token.split("-", 1)
    if not start_text.strip().isdigit() or not end_text.strip().isdigit():
        raise _pages_failure("tool argument 'pages' must contain only positive page numbers")
    start = int(start_text.strip())
    end = int(end_text.strip())
    if start <= 0 or end <= 0 or end < start:
        raise _pages_failure("tool argument 'pages' contains an invalid range")
    if start > page_count or end > page_count:
        missing_page = start if start > page_count else end
        raise _pages_failure(
            f"tool argument 'pages' references page {missing_page}, "
            f"but the PDF has {page_count} pages"
        )
    return range(start, end + 1)


def _unread_spans(pages: range, selected: Sequence[int]) -> list[tuple[int, int]]:
    """`pages` minus the (at most MAX_PDF_PAGES) selected ones, as inclusive spans.

    Never iterates `pages`: a model can ask for 1-100000000.
    """

    spans: list[tuple[int, int]] = []
    start = pages.start
    for page in sorted(value for value in set(selected) if value in pages):
        if start < page:
            spans.append((start, page - 1))
        start = page + 1
    if start < pages.stop:
        spans.append((start, pages.stop - 1))
    return spans


def _format_unread(spans: Sequence[tuple[int, int]]) -> str:
    """Sorted, merged `pages` syntax, bounded so it survives output clipping intact.

    Past the bound the tail collapses into one covering span: a follow-up may
    re-read a page the model skipped, but never loses one it asked for.
    """

    merged: list[list[int]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    tokens: list[str] = []
    length = 0
    last_page = merged[-1][1] if merged else 0
    for start, span_end in merged:
        end = last_page if length > _UNREAD_MAX_CHARS else span_end
        tokens.append(str(start) if start == end else f"{start}-{end}")
        length += len(tokens[-1]) + 1
        if end == last_page:
            break
    return ",".join(tokens)


def select_pages(raw_value: object, *, page_count: int) -> tuple[list[int], str]:
    """The pages to read (at most MAX_PDF_PAGES) and the requested rest, in `pages` syntax.

    Past the cap the read proceeds with the first pages instead of failing, so a
    model that copies a user's "pages 1-4" loses no round trip; the rest is
    reported for a follow-up call.
    """

    if raw_value is None:
        return list(range(1, min(page_count, MAX_PDF_PAGES) + 1)), ""
    if not isinstance(raw_value, str) or not raw_value.strip():
        raise _pages_failure("tool argument 'pages' must be a non-empty string like '1-3' or '2,5'")
    selected: list[int] = []
    unread: list[tuple[int, int]] = []
    for chunk in raw_value.split(","):
        token = chunk.strip()
        if not token:
            continue
        pages = _parse_page_token(token, page_count=page_count)
        if isinstance(pages, list):
            pages = range(pages[0], pages[0] + 1)
        if pages.start <= 0:
            raise _pages_failure("tool argument 'pages' must contain only positive page numbers")
        if pages.stop - 1 > page_count:
            raise _pages_failure(
                f"tool argument 'pages' references page {pages.stop - 1}, "
                f"but the PDF has {page_count} pages"
            )
        # At most MAX_PDF_PAGES values are taken and at most MAX_PDF_PAGES skipped
        # as duplicates, so this loop stays short whatever the range size.
        for value in pages:
            if len(selected) >= MAX_PDF_PAGES:
                break
            if value not in selected:
                selected.append(value)
        unread.extend(_unread_spans(pages, selected))
    if not selected:
        raise _pages_failure("tool argument 'pages' did not select any pages")
    return selected, _format_unread(unread)


def parse_pages_argument(raw_value: object, *, page_count: int) -> list[int]:
    """Selected page numbers for `pages` (default: the first MAX_PDF_PAGES)."""

    return select_pages(raw_value, page_count=page_count)[0]


def resolve_selection(
    *,
    cursor_argument: object | None,
    pages_argument: object | None,
    digest: str,
    page_count: int,
) -> tuple[list[int], list[int], PdfCursor | None, str]:
    """Selected pages, their first lines, the decoded cursor (if any), and unread pages.

    A cursor must match the document digest (stale cursors are refused) and
    name an existing page; the line bound is checked once the page's lines
    are known, via ``check_cursor_line``.
    """

    if cursor_argument is None:
        selected, unread = select_pages(pages_argument, page_count=page_count)
        return selected, [1] * len(selected), None, unread
    if pages_argument is not None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="tool arguments 'cursor' and 'pages' are mutually exclusive",
            retryable=False,
        )
    cursor = decode_cursor(cursor_argument)
    if cursor.digest != digest:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="cursor is stale: the PDF changed since it was read; re-read it with 'pages'",
            retryable=False,
        )
    if cursor.page > page_count:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message=f"cursor references page {cursor.page}, but the PDF has {page_count} pages",
            retryable=False,
        )
    return [cursor.page], [cursor.line], cursor, ""


def check_cursor_line(cursor: PdfCursor, lines: Sequence[PdfTextLine], *, page_number: int) -> None:
    if cursor.line > len(lines):
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message=(
                f"cursor references line {cursor.line}, but page {page_number} "
                f"has {len(lines)} lines"
            ),
            retryable=False,
        )


def page_lines(
    page: Any,
    *,
    page_number: int,
    ocr_session: Any,
    text_less_pages: list[int],
    tool_name: str,
) -> tuple[list[PdfTextLine], bool, dict[str, object] | None]:
    """``(lines, text_layer, OCR info)`` for one page, sanitized before budgeting.

    A page without a text layer is recorded in ``text_less_pages`` and its
    words are recovered through the OCR session when available.
    """

    text_layer = bool(page.get_text("text").strip())
    result = None
    if text_layer:
        lines = reconstruct_page_lines(page)
    else:
        text_less_pages.append(page_number)
        result = ocr_session.recover_words(page, page_number=page_number)
        if result is None:
            lines = []
        else:
            lines = reconstruct_page_lines(page, words=result.words)
    sanitized = [
        replace(line, text=sanitize_tool_output_no_truncate(line.text, tool_name=tool_name))
        for line in lines
    ]
    if result is None:
        return sanitized, text_layer, None
    uncertain = ocr_session.uncertain_for(
        page,
        page_number=page_number,
        lines=sanitized,
    )
    info: dict[str, object] = {"engine": result.engine, "uncertain": uncertain}
    if result.dpi is not None:
        info["dpi"] = result.dpi
    return sanitized, text_layer, info


def read_note(ocr_note: str, *, unread_pages: str = "") -> str:
    """The model-visible `note` for a PDF read: unread pages, OCR caveats, SOURCES_NOTE."""

    unread_note = ""
    if unread_pages:
        one = unread_pages.isdigit()
        unread_note = (
            f"Only {MAX_PDF_PAGES} pages are read per call; "
            f"{'page' if one else 'pages'} {unread_pages} {'was' if one else 'were'} not read. "
            f"Read {'it' if one else 'them'} with pages: '{unread_pages}'."
        )
    return " ".join(part for part in (unread_note, ocr_note, SOURCES_NOTE) if part)
