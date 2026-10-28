"""Layout-preserving PDF text reconstruction and continuation helpers."""

from __future__ import annotations

import copy
import hashlib
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from statistics import median
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.builtins.pdf_page_cache import (
    PDF_PAGE_CACHE,
    CachedPdfPage,
    cached_page,
    pdf_page_cache_enabled,
)
from sidecar.ai.tools.builtins.pdf_page_selection import (
    MAX_PDF_PAGES,
    parse_pages_argument,  # noqa: F401 - re-export for filesystem_content
    select_pages,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate

_DOT_RUN = re.compile(r"\.{3,}")
# Page and line stay inside int()'s digit limit and far below any real document.
_CURSOR = re.compile(r"pdf:([0-9a-f]{16}):([1-9][0-9]{0,8}):([1-9][0-9]{0,8})")
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
    """Render whole lines, or a bounded prefix of an oversized first line.

    ``excerpt_fields`` identifies that prefix as nonrecoverable truncation.
    """

    if start < 1:
        raise ValueError("start must be positive")
    start_index = start - 1
    if start_index >= len(lines):
        return "", 0
    rendered: list[str] = []
    for line in lines[start_index:]:
        candidate = f"{line.number}: {line.text}"
        candidate_length = len(candidate) + (1 if rendered else 0)
        if len("\n".join(rendered)) + candidate_length > max_chars:
            if rendered:
                return "\n".join(rendered), line.number
            return candidate[:max_chars], line.number + 1 if line.number < len(lines) else 0
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

    Complete lines count toward ``lines_to``. An oversized first line is
    identified separately; its clipped suffix cannot be recovered by cursor.
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
    next_line = start + emitted
    if emitted and excerpt.rsplit("\n", maxsplit=1)[-1] != (
        f"{lines[lines_to - 1].number}: {lines[lines_to - 1].text}"
    ):
        fields["text_truncated"] = True
        fields["nonrecoverable_truncation"] = True
        fields["incomplete_line"] = lines_to
        fields["truncation_reason"] = "PDF line exceeds the excerpt character limit."
        fields["lines_from"] = start if emitted > 1 else 0
        fields["lines_to"] = lines_to - 1 if emitted > 1 else 0
    if next_line <= len(lines):
        fields["text_truncated"] = True
        fields["next_line"] = next_line
        fields["continue_cursor"] = encode_cursor(digest=digest, page=page, line=next_line)
    return fields


def continuation_summary(pages: Sequence[dict[str, object]]) -> dict[str, object]:
    """Top-level continuation fields: the first truncated page's cursor + hint."""

    summary: dict[str, object] = {"text_format": "numbered_lines"}
    incomplete = any(page.get("nonrecoverable_truncation") for page in pages)
    if incomplete:
        summary["nonrecoverable_truncation"] = True
    for page in pages:
        cursor = page.get("continue_cursor")
        if isinstance(cursor, str):
            summary["cursor"] = cursor
            summary["continuation_hint"] = (
                "A PDF line was clipped; its suffix cannot be recovered. "
                f"To read the remaining lines, call read_file again with cursor={cursor}."
                if incomplete
                else CONTINUATION_HINT.format(cursor=cursor)
            )
            break
    return summary


def document_digest(raw_pdf: bytes) -> str:
    return document_digest_from_sha256(hashlib.sha256(raw_pdf).hexdigest())


def document_digest_from_sha256(sha256_hex: str) -> str:
    """``document_digest`` of bytes whose full SHA-256 hex digest is already known."""

    return sha256_hex[:16]


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


def _replay_cached_page(
    entry: CachedPdfPage,
    *,
    page_number: int,
    ocr_session: Any,
    text_less_pages: list[int],
) -> tuple[list[PdfTextLine], bool, dict[str, object] | None]:
    info = copy.deepcopy(entry.ocr_info)
    if not entry.text_layer:
        text_less_pages.append(page_number)
        if info is not None:
            ocr_session.record_cached_page(
                page_number,
                engine=str(info["engine"]),
                attempts=entry.ocr_attempts,
                empty=entry.ocr_empty,
                uncertain=bool(info.get("uncertain")),
            )
    return list(entry.lines), entry.text_layer, info


def page_lines(  # noqa: PLR0913
    page: Any,
    *,
    page_number: int,
    ocr_session: Any,
    text_less_pages: list[int],
    tool_name: str,
    digest: str | None = None,
    cache_hits: list[int] | None = None,
) -> tuple[list[PdfTextLine], bool, dict[str, object] | None]:
    """``(lines, text_layer, OCR info)`` for one page, sanitized before budgeting.

    A page without a text layer is recorded in ``text_less_pages`` and its
    words are recovered through the OCR session when available. With the
    document ``digest`` the outcome is served from and stored in
    ``PDF_PAGE_CACHE``; a served page is appended to ``cache_hits``.
    """

    entry = cached_page(digest, page_number)
    # OCR's kill switch also hides OCR text recognized before it was set.
    if entry is not None and (entry.text_layer or ocr_session.enabled):
        if cache_hits is not None:
            cache_hits.append(page_number)
        return _replay_cached_page(
            entry,
            page_number=page_number,
            ocr_session=ocr_session,
            text_less_pages=text_less_pages,
        )
    lines, text_layer, info = _extract_page_lines(
        page,
        page_number=page_number,
        ocr_session=ocr_session,
        text_less_pages=text_less_pages,
        tool_name=tool_name,
    )
    # A Tesseract reading taken only because RapidOCR failed transiently is not
    # cached, so a later read gives RapidOCR another chance at the page.
    rapid_retry_owed = (
        info is not None
        and info.get("engine") == "tesseract"
        and bool(getattr(ocr_session, "rapid_transient_failure", False))
    )
    if (
        digest is not None
        and pdf_page_cache_enabled()
        and (text_layer or info is not None)
        and not rapid_retry_owed
    ):
        attempts, empty = ((), False) if info is None else ocr_session.page_outcome(page_number)
        PDF_PAGE_CACHE.put(
            digest,
            page_number,
            CachedPdfPage(
                lines=tuple(lines),
                text_layer=text_layer,
                ocr_info=copy.deepcopy(info),
                ocr_attempts=attempts,
                ocr_empty=empty,
            ),
        )
    return lines, text_layer, info


def _extract_page_lines(
    page: Any,
    *,
    page_number: int,
    ocr_session: Any,
    text_less_pages: list[int],
    tool_name: str,
) -> tuple[list[PdfTextLine], bool, dict[str, object] | None]:
    # One extraction serves both the text-layer test and the line reconstruction.
    words = page.get_text("words")
    text_layer = any(str(word[4]).strip() for word in words)
    result = None
    if text_layer:
        lines = reconstruct_page_lines(page, words=words)
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
