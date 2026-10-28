"""`pages` argument parsing for PDF reads: a bounded selection plus the unread rest.

Split out of ``pdf_text``, which re-exports ``select_pages`` and
``parse_pages_argument`` for its existing callers.
"""

from __future__ import annotations

from collections.abc import Sequence

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure

# A `pages` token longer than this is refused before int() can see it.
_MAX_PAGE_TOKEN_DIGITS = 12
# Pages per read_file call; three dense pages fit the response budget.
MAX_PDF_PAGES = 3
# `unread_pages` stays well inside every output-string clip so it remains valid syntax.
_UNREAD_MAX_CHARS = 200


def _pages_failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_EXECUTION_FAILED, message=message, retryable=False)


def _page_number(text: str) -> int:
    """A `pages` number: ASCII digits only ("²".isdigit() is True) and bounded for int()."""

    value = text.strip()
    if not (value.isascii() and value.isdigit()) or len(value) > _MAX_PAGE_TOKEN_DIGITS:
        raise _pages_failure("tool argument 'pages' must contain only positive page numbers")
    return int(value)


def _parse_page_token(token: str, *, page_count: int) -> range | list[int]:
    """One comma-separated `pages` token: a page number or an inclusive range."""

    if "-" not in token:
        return [_page_number(token)]
    start_text, end_text = token.split("-", 1)
    start = _page_number(start_text)
    end = _page_number(end_text)
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


__all__ = ["MAX_PDF_PAGES", "parse_pages_argument", "select_pages"]
