"""PDF candidates for ``grep_search``: page text through the shared page cache.

Pages are extracted in the tool process (``pdf_text.page_lines``, the same
path and cache ``read_file`` uses); the pattern itself still runs in the
killable regex worker, one bounded request per page chunk. An unchanged file
whose digest is memoized is not hashed again, and when every page is cached
the document is not opened either.
"""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.tools.builtins import filesystem_content, pdf_page_cache, pdf_text
from sidecar.ai.tools.builtins.grep_search_file import (
    FileSearchResult,
    open_regular_file,
    workspace_relative_path,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure

# PDFs use read_file's media limit, not the plain-text search limit.
MAX_PDF_SEARCH_BYTES = filesystem_content.MAX_MEDIA_FILE_BYTES
LARGE_PDF_HINT = "Read the PDF with read_file and its 'pages' argument instead."
# Wall-clock budget for one PDF's page extraction, OCR included. Cached pages
# are always served; past the budget every uncached page is left for a retry.
PDF_GREP_FILE_BUDGET_SECONDS = 12.0
# First guess at one scanned page's OCR cost; the slowest page seen replaces it.
PDF_OCR_PAGE_ESTIMATE_SECONDS = 4.0
# One request carries at most this much JSON text (pattern included), well
# under the worker's 64 KiB protocol line limit alongside the options.
_MAX_REQUEST_TEXT_CHARS = 48_000
_MAX_PDF_LINE_CHARS = 4_000

# Sends one worker request and returns its result (raises on worker timeout).
SendRequest = Callable[[dict[str, object]], FileSearchResult]


@dataclass(frozen=True)
class PdfSearchOutcome:
    result: FileSearchResult
    # Uncached pages left unsearched by this PDF's budget.
    skipped_pages: int
    runtime_exhausted: bool
    # The regex worker timed out on a page; ``result`` holds the pages before it.
    timed_out: bool = False


class _Aggregate:
    def __init__(self, *, max_output_matches: int, max_output_bytes: int) -> None:
        self.max_output_matches = max_output_matches
        self.max_output_bytes = max_output_bytes
        self.lines: list[str] = []
        self.returned = 0
        self.total = 0
        self.bytes_used = 0
        self.truncated_by_bytes = False
        self.truncated_by_line_length = False

    def add(self, result: FileSearchResult) -> None:
        self.lines.extend(result.lines)
        self.returned += result.returned_match_count
        self.total += result.total_match_count
        self.bytes_used += result.output_bytes_used
        self.truncated_by_bytes = self.truncated_by_bytes or result.truncated_by_bytes
        self.truncated_by_line_length = (
            self.truncated_by_line_length or result.truncated_by_line_length
        )

    def result(self) -> FileSearchResult:
        return FileSearchResult(
            lines=self.lines,
            returned_match_count=self.returned,
            total_match_count=self.total,
            truncated=(
                self.total > self.returned
                or self.truncated_by_bytes
                or self.truncated_by_line_length
            ),
            truncated_by_bytes=self.truncated_by_bytes,
            truncated_by_line_length=self.truncated_by_line_length,
            output_bytes_used=self.bytes_used,
        )


def _dedented(texts: Sequence[str]) -> list[str]:
    """Page lines without the page's common left margin, each bounded in length.

    Layout reconstruction renders the margin as spaces; relative column
    alignment inside the page is kept.
    """

    margin = min(
        (len(text) - len(text.lstrip(" ")) for text in texts if text.strip()),
        default=0,
    )
    return [text[margin : margin + _MAX_PDF_LINE_CHARS] for text in texts]


def _chunks(texts: Sequence[str], budget: int) -> Iterator[tuple[int, list[str]]]:
    """``(first line number, lines)`` chunks that each fit one worker request.

    Context lines do not cross a chunk boundary; only pages far denser than
    any real document page are ever split.
    """

    first = 1
    chunk: list[str] = []
    size = 0
    for index, text in enumerate(texts, start=1):
        cost = len(json.dumps(text, ensure_ascii=False)) + 1
        if chunk and size + cost > budget:
            yield first, chunk
            first, chunk, size = index, [], 0
        chunk.append(text)
        size += cost
    if chunk:
        yield first, chunk


def search_pdf(  # noqa: PLR0913
    path: Path,
    compiled: re.Pattern[str],
    *,
    workspace_root: Path | None,
    context_lines: int,
    max_output_matches: int,
    max_output_bytes: int,
    deadline: float,
    send: SendRequest,
) -> PdfSearchOutcome | None:
    """Search every page's text; None when no page of the PDF can be read.

    Without the PDF add-on, for bytes PyMuPDF cannot open, for an encrypted
    document, or when the first page already fails to extract, the caller
    keeps its old binary skip. A page that fails later ends this PDF with the
    pages before it searched.
    """

    try:
        fitz = filesystem_content._load_pymupdf()
    except ToolExecutionFailure:
        return None
    source = _read_source(path, workspace_root)
    if source is None:
        return None
    search = _PageSearch(
        compiled,
        display_path=workspace_relative_path(path, workspace_root),
        context_lines=context_lines,
        aggregate=_Aggregate(
            max_output_matches=max_output_matches,
            max_output_bytes=max_output_bytes,
        ),
        deadline=deadline,
        send=send,
    )
    if source.cached is not None:
        return search.cached(source.cached)
    document = _open_document(fitz, source.raw_pdf)
    if document is None:
        return None
    with document:
        if getattr(document, "needs_pass", False):
            return None
        known = source.known
        if known is None:
            known = pdf_page_cache.PdfDocumentIdentity(
                pdf_text.document_digest(source.raw_pdf), int(document.page_count)
            )
            if source.key is not None:
                pdf_page_cache.remember_document(
                    source.key, digest=known.digest, page_count=known.page_count
                )
        return search.document(document, digest=known.digest)


@dataclass(frozen=True)
class _PdfSource:
    # None when the file changed under the read and must not be remembered.
    key: pdf_page_cache.DocumentKey | None
    known: pdf_page_cache.PdfDocumentIdentity | None
    # Every page's cache entry when the document need not be opened.
    cached: list[pdf_page_cache.CachedPdfPage] | None
    raw_pdf: bytes


def _read_source(path: Path, workspace_root: Path | None) -> _PdfSource | None:
    """The file's memo identity, and its bytes unless every page is cached."""

    known: pdf_page_cache.PdfDocumentIdentity | None = None
    cached: list[pdf_page_cache.CachedPdfPage] | None = None
    raw_pdf = b""
    try:
        # Opened before the memo is consulted: containment is checked on the handle.
        with open_regular_file(path, "rb", authorized_root=workspace_root) as handle:
            key: pdf_page_cache.DocumentKey | None = _document_key(path, handle.fileno())
            assert key is not None
            known = pdf_page_cache.remembered_document(key)
            if known is not None:
                cached = _cached_pages(known)
            if cached is None:
                raw_pdf = handle.read(MAX_PDF_SEARCH_BYTES + 1)
                # A file replaced during the read is not remembered under the old key.
                if _document_key(path, handle.fileno()) != key:
                    key = None
    except OSError:
        return None
    return _PdfSource(key, known, cached, raw_pdf)


def _document_key(path: Path, fd: int) -> pdf_page_cache.DocumentKey:
    stat = os.fstat(fd)
    return (str(path.resolve()), int(stat.st_ino), int(stat.st_size), int(stat.st_mtime_ns))


def _open_document(fitz: Any, raw_pdf: bytes) -> Any | None:
    if len(raw_pdf) > MAX_PDF_SEARCH_BYTES:
        return None
    try:
        return fitz.open(stream=raw_pdf, filetype="pdf")
    except Exception:  # noqa: BLE001 - an unreadable PDF is skipped like any binary.
        return None


def _cached_pages(
    known: pdf_page_cache.PdfDocumentIdentity,
) -> list[pdf_page_cache.CachedPdfPage] | None:
    """Every page's cache entry, or None when any page needs the document.

    Mirrors ``pdf_text.page_lines``: a cached text-less page is only served
    while OCR is enabled.
    """

    from sidecar.ai.tools.builtins import pdf_ocr

    ocr_enabled = pdf_ocr.pdf_ocr_enabled()
    entries: list[pdf_page_cache.CachedPdfPage] = []
    for page_number in range(1, known.page_count + 1):
        entry = pdf_page_cache.cached_page(known.digest, page_number)
        if entry is None or not (entry.text_layer or ocr_enabled):
            return None
        entries.append(entry)
    return entries


class _PageSearch:
    """One PDF's page-by-page search, from the document or from cached pages."""

    def __init__(  # noqa: PLR0913
        self,
        compiled: re.Pattern[str],
        *,
        display_path: str,
        context_lines: int,
        aggregate: _Aggregate,
        deadline: float,
        send: SendRequest,
    ) -> None:
        self.compiled = compiled
        self.display_path = display_path
        self.context_lines = context_lines
        self.aggregate = aggregate
        self.deadline = deadline
        self.send = send
        self.text_budget = _MAX_REQUEST_TEXT_CHARS - len(
            json.dumps(compiled.pattern, ensure_ascii=False)
        )

    def cached(self, entries: Sequence[pdf_page_cache.CachedPdfPage]) -> PdfSearchOutcome:
        for page_number, entry in enumerate(entries, start=1):
            if time.monotonic() >= self.deadline:
                return self._outcome(0, runtime_exhausted=True)
            if not self._send_page(page_number, entry.lines):
                return self._outcome(0, timed_out=True)
        return self._outcome(0)

    def document(self, document: Any, *, digest: str) -> PdfSearchOutcome | None:
        # Lazy like the read paths: pdf_ocr stays out of the server import graph.
        from sidecar.ai.tools.builtins import pdf_ocr

        # A grep never waits on a tessdata download; read_file may fetch it.
        session = pdf_ocr.PdfOcrSession(allow_tessdata_download=False)
        file_deadline = min(self.deadline, time.monotonic() + PDF_GREP_FILE_BUDGET_SECONDS)
        ocr_estimate = PDF_OCR_PAGE_ESTIMATE_SECONDS
        skipped = 0
        searched_any = False
        for page_number in range(1, int(document.page_count) + 1):
            now = time.monotonic()
            if now >= self.deadline:
                return self._outcome(skipped, runtime_exhausted=True)
            try:
                page = document.load_page(page_number - 1)
                if pdf_page_cache.cached_page(digest, page_number) is None and (
                    now >= file_deadline
                    or (
                        session.enabled
                        and now + ocr_estimate > file_deadline
                        and not page.get_text("text").strip()
                    )
                ):
                    skipped += 1
                    continue
                started = time.monotonic()
                load_before = session.rapid_load_seconds
                cache_hits: list[int] = []
                lines, text_layer, _info = pdf_text.page_lines(
                    page,
                    page_number=page_number,
                    ocr_session=session,
                    text_less_pages=[],
                    tool_name="grep_search",
                    digest=digest,
                    cache_hits=cache_hits,
                )
            except Exception:  # noqa: BLE001 - a damaged page ends this PDF; other files still search.
                if not searched_any:
                    return None
                break
            searched_any = True
            if not text_layer and not cache_hits:
                # Waiting on the shared engine (its load, or another caller's
                # page) is not part of this page's OCR cost.
                load_seconds = session.rapid_load_seconds - load_before
                ocr_estimate = max(ocr_estimate, time.monotonic() - started - load_seconds)
            if not self._send_page(page_number, lines):
                return self._outcome(skipped, timed_out=True)
        return self._outcome(skipped)

    def _outcome(
        self, skipped: int, *, runtime_exhausted: bool = False, timed_out: bool = False
    ) -> PdfSearchOutcome:
        return PdfSearchOutcome(
            self.aggregate.result(),
            skipped,
            runtime_exhausted=runtime_exhausted,
            timed_out=timed_out,
        )

    def _send_page(self, page_number: int, lines: Sequence[pdf_text.PdfTextLine]) -> bool:
        """Search one page's lines; False when the regex worker timed out."""

        aggregate = self.aggregate
        texts = _dedented([line.text for line in lines])
        try:
            for first_line, chunk in _chunks(texts, self.text_budget):
                aggregate.add(
                    self.send(
                        {
                            "lines": chunk,
                            "pattern": self.compiled.pattern,
                            "flags": int(self.compiled.flags),
                            "display_path": f"{self.display_path}:p{page_number}",
                            "line_label": "L",
                            "first_line": first_line,
                            "context_lines": self.context_lines,
                            "max_output_matches": max(
                                0, aggregate.max_output_matches - aggregate.returned
                            ),
                            "max_output_bytes": max(
                                0, aggregate.max_output_bytes - aggregate.bytes_used
                            ),
                        }
                    )
                )
        except FutureTimeoutError:
            return False
        return True
