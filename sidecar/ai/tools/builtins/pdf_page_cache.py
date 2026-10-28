"""Process-lifetime cache of extracted PDF page text.

Shared by ``read_file``, ``pdf_inspect`` and ``grep_search`` through
``pdf_text.page_lines``, so a scanned page is OCR'd once per sidecar process.
``PDF_DOCUMENT_MEMO`` lets ``grep_search`` find an unchanged file's digest and
page count without reading and hashing it again.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import TYPE_CHECKING

from sidecar.ai.config import read_environment_value

if TYPE_CHECKING:
    from sidecar.ai.tools.builtins.pdf_text import PdfTextLine

# Process-lifetime page-text cache bounds. The character ceiling is the real
# bound; the page cap only stops pathological tiny-page documents. A cap below
# a corpus's page count would evict cyclically under repeated greps.
PDF_PAGE_CACHE_MAX_PAGES = 4096
PDF_PAGE_CACHE_MAX_CHARS = 16_000_000
# Per-line bookkeeping charged against the character ceiling: a PdfTextLine and
# its str/float objects cost a couple hundred bytes beyond the text itself.
_CACHE_LINE_OVERHEAD_CHARS = 200
PDF_DOCUMENT_MEMO_MAX_ENTRIES = 4096

# ``(resolved path, st_ino, st_size, st_mtime_ns)`` of an opened PDF.
DocumentKey = tuple[str, int, int, int]


@dataclass(frozen=True)
class CachedPdfPage:
    """One page's sanitized lines plus what replaying its OCR outcome needs."""

    lines: tuple[PdfTextLine, ...]
    text_layer: bool
    ocr_info: dict[str, object] | None
    ocr_attempts: tuple[str, ...] = ()
    ocr_empty: bool = False

    @property
    def size_chars(self) -> int:
        return sum(len(line.text) + _CACHE_LINE_OVERHEAD_CHARS for line in self.lines) + 1


class PdfPageCache:
    """Bounded LRU of extracted page text keyed by ``(document digest, page)``.

    The digest covers the file bytes, so an edited PDF misses. Only complete
    outcomes are stored: a text-layer page or a page OCR recognized. A page
    whose OCR was unavailable or failed is retried on the next read.
    """

    def __init__(self, *, max_pages: int, max_chars: int) -> None:
        self._max_pages = max_pages
        self._max_chars = max_chars
        self._entries: OrderedDict[tuple[str, int], CachedPdfPage] = OrderedDict()
        self._chars = 0
        self._lock = threading.Lock()

    def get(self, digest: str, page_number: int) -> CachedPdfPage | None:
        key = (digest, page_number)
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                self._entries.move_to_end(key)
            return entry

    def put(self, digest: str, page_number: int, entry: CachedPdfPage) -> None:
        size = entry.size_chars
        if size > self._max_chars:
            return
        key = (digest, page_number)
        with self._lock:
            previous = self._entries.pop(key, None)
            if previous is not None:
                self._chars -= previous.size_chars
            self._entries[key] = entry
            self._chars += size
            while len(self._entries) > self._max_pages or self._chars > self._max_chars:
                _key, evicted = self._entries.popitem(last=False)
                self._chars -= evicted.size_chars

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._chars = 0

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    @property
    def size_chars(self) -> int:
        with self._lock:
            return self._chars


PDF_PAGE_CACHE = PdfPageCache(
    max_pages=PDF_PAGE_CACHE_MAX_PAGES,
    max_chars=PDF_PAGE_CACHE_MAX_CHARS,
)


@dataclass(frozen=True)
class PdfDocumentIdentity:
    digest: str
    page_count: int


class PdfDocumentMemo:
    """Bounded LRU of ``DocumentKey -> (digest, page count)``.

    Any size or modification-time change is a different key, so an edited
    file misses and is read and hashed again.
    """

    def __init__(self, *, max_entries: int) -> None:
        self._max_entries = max_entries
        self._entries: OrderedDict[DocumentKey, PdfDocumentIdentity] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: DocumentKey) -> PdfDocumentIdentity | None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                self._entries.move_to_end(key)
            return entry

    def put(self, key: DocumentKey, identity: PdfDocumentIdentity) -> None:
        with self._lock:
            self._entries.pop(key, None)
            self._entries[key] = identity
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


PDF_DOCUMENT_MEMO = PdfDocumentMemo(max_entries=PDF_DOCUMENT_MEMO_MAX_ENTRIES)


def pdf_page_cache_enabled() -> bool:
    return read_environment_value("JENNY_ENABLE_PDF_PAGE_CACHE", "1") != "0"


def cached_page(digest: str | None, page_number: int) -> CachedPdfPage | None:
    if digest is None or not pdf_page_cache_enabled():
        return None
    return PDF_PAGE_CACHE.get(digest, page_number)


def remembered_document(key: DocumentKey) -> PdfDocumentIdentity | None:
    if not pdf_page_cache_enabled():
        return None
    return PDF_DOCUMENT_MEMO.get(key)


def remember_document(key: DocumentKey, *, digest: str, page_count: int) -> None:
    if pdf_page_cache_enabled():
        PDF_DOCUMENT_MEMO.put(key, PdfDocumentIdentity(digest, page_count))


__all__ = [
    "PDF_DOCUMENT_MEMO",
    "PDF_DOCUMENT_MEMO_MAX_ENTRIES",
    "PDF_PAGE_CACHE",
    "PDF_PAGE_CACHE_MAX_CHARS",
    "PDF_PAGE_CACHE_MAX_PAGES",
    "CachedPdfPage",
    "DocumentKey",
    "PdfDocumentIdentity",
    "PdfDocumentMemo",
    "PdfPageCache",
    "cached_page",
    "pdf_page_cache_enabled",
    "remember_document",
    "remembered_document",
]
