"""Text extraction for catalog documents (text/code, PDF text layer, docx).

Every path is re-checked against its root's ``WorkspaceGuard`` before any byte
is read, so a symlink or junction that escapes the root is never opened. PDF
support needs the optional PyMuPDF add-on, imported lazily; background
extraction never runs OCR.
"""

from __future__ import annotations

import hashlib
import importlib
import time
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from xml.etree.ElementTree import ParseError

from sidecar.ai.tools.builtins.file_state import is_binary_file
from sidecar.ai.tools.builtins.grep_search import _iter_candidate_files
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024  # the knowledge registry's per-file cap
# PDF/docx are compressed containers; their raw files get a larger, still
# bounded, ceiling (the hash streams; extraction is bounded by pages/XML size).
MAX_CONTAINER_FILE_BYTES = 64 * 1024 * 1024
MAX_PDF_PAGES = 500
# One PDF's text extraction is cut off at this many seconds or characters; the
# pages read so far are cataloged. Bounds how long a step can outlast its budget.
MAX_PDF_EXTRACT_SECONDS = 5.0
MAX_PDF_TEXT_CHARS = 800_000
MAX_DOCX_XML_BYTES = 20 * 1024 * 1024
_HASH_CHUNK_BYTES = 1024 * 1024
_WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

TEXT_EXTENSIONS = frozenset(
    {
        ".txt", ".md", ".markdown", ".rst", ".org", ".csv", ".tsv", ".json", ".yaml",
        ".yml", ".toml", ".ini", ".cfg", ".html", ".htm", ".xml", ".tex", ".log",
        ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".java", ".kt", ".go",
        ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift",
        ".sh", ".ps1", ".sql", ".r", ".lua", ".scala",
    }
)
PDF_EXTENSION = ".pdf"
DOCX_EXTENSION = ".docx"
SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | {PDF_EXTENSION, DOCX_EXTENSION}

STATUS_OK = "ok"
STATUS_SKIPPED = "skipped"
STATUS_FAILED = "failed"


@dataclass(frozen=True)
class ExtractResult:
    status: str
    reason: str | None = None
    sections: list[tuple[str, str]] = field(default_factory=list)
    sha256: str | None = None


# The catalog's containment boundary is the tools' WorkspaceGuard, one per root.
CatalogRootGuard = WorkspaceGuard


def is_supported_path(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_EXTENSIONS


def iter_supported_files(guard: WorkspaceGuard) -> Iterator[Path]:
    """Walk a root without following links, applying containment and ignore rules."""
    root = guard.root
    if root is None:
        return
    for path in _iter_candidate_files(root, guard, None):
        if is_supported_path(path):
            yield path


def _skipped(reason: str, sha256: str | None = None) -> ExtractResult:
    return ExtractResult(status=STATUS_SKIPPED, reason=reason, sha256=sha256)


def _failed(reason: str, sha256: str | None = None) -> ExtractResult:
    return ExtractResult(status=STATUS_FAILED, reason=reason, sha256=sha256)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(_HASH_CHUNK_BYTES):
            digest.update(block)
    return digest.hexdigest()


def _extract_text(path: Path) -> ExtractResult:
    if is_binary_file(path):
        return _skipped("binary")
    raw = path.read_bytes()
    if len(raw) > MAX_TEXT_FILE_BYTES:
        return _skipped("too_large")
    text = raw.decode("utf-8", errors="replace")
    sections = [(f"L{index}-{index}", line) for index, line in enumerate(text.splitlines(), 1)]
    return ExtractResult(STATUS_OK, None, sections, hashlib.sha256(raw).hexdigest())


def _load_fitz() -> Any | None:
    try:
        return importlib.import_module("fitz")
    except Exception:  # noqa: BLE001 - any import failure means the add-on is unusable.
        return None


def _extract_pdf(path: Path) -> ExtractResult:
    fitz = _load_fitz()
    if fitz is None:
        return _skipped("pdf_addon_missing")
    sha256 = _file_sha256(path)
    try:
        document = fitz.open(str(path))
    except Exception:  # noqa: BLE001 - PyMuPDF raises its own error types.
        return _failed("pdf_unreadable", sha256)
    try:
        if getattr(document, "needs_pass", False):
            return _skipped("pdf_encrypted", sha256)
        sections: list[tuple[str, str]] = []
        deadline = time.monotonic() + MAX_PDF_EXTRACT_SECONDS
        total_chars = 0
        for index in range(min(len(document), MAX_PDF_PAGES)):
            if total_chars >= MAX_PDF_TEXT_CHARS or (sections and time.monotonic() >= deadline):
                break
            text = document[index].get_text("text")
            if isinstance(text, str) and text.strip():
                sections.append((f"p{index + 1}", text))
                total_chars += len(text)
    except Exception:  # noqa: BLE001 - a damaged page fails this document only.
        return _failed("pdf_unreadable", sha256)
    finally:
        document.close()
    if not sections:
        return _skipped("needs_ocr", sha256)
    return ExtractResult(STATUS_OK, None, sections, sha256)


def _docx_paragraphs(xml_bytes: bytes) -> list[tuple[str, str]]:
    # defusedxml is a core dependency; imported dynamically like rich_files/ooxml.py.
    safe_tree = importlib.import_module("defusedxml.ElementTree")
    root = safe_tree.fromstring(xml_bytes)
    sections: list[tuple[str, str]] = []
    for paragraph in root.iter(f"{_WORD_NS}p"):
        text = "".join(node.text or "" for node in paragraph.iter(f"{_WORD_NS}t"))
        if text.strip():
            sections.append((f"para{len(sections) + 1}", text))
    return sections


def _extract_docx(path: Path) -> ExtractResult:
    sha256 = _file_sha256(path)
    try:
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > MAX_DOCX_XML_BYTES:
                return _skipped("too_large", sha256)
            with archive.open(info) as handle:
                xml_bytes = handle.read(MAX_DOCX_XML_BYTES + 1)
        if len(xml_bytes) > MAX_DOCX_XML_BYTES:
            return _skipped("too_large", sha256)
        sections = _docx_paragraphs(xml_bytes)
    except (zipfile.BadZipFile, KeyError, ValueError, OSError, ParseError):
        return _failed("docx_unreadable", sha256)
    return ExtractResult(STATUS_OK, None, sections, sha256)


def _contained_file(path: Path, guard: WorkspaceGuard) -> Path | ExtractResult:
    """Resolve ``path`` inside the guard's root, or explain why it is not read."""
    try:
        if path.is_symlink():
            return _skipped("outside_root")
        resolved = guard.ensure_within_root(path)
    except ToolExecutionFailure:
        return _skipped("outside_root")
    except OSError:
        return _failed("unreadable")
    return resolved


def _extract_contained(resolved: Path, suffix: str) -> ExtractResult:
    if not resolved.is_file():
        return _failed("unreadable")
    limit = MAX_TEXT_FILE_BYTES if suffix in TEXT_EXTENSIONS else MAX_CONTAINER_FILE_BYTES
    if resolved.stat().st_size > limit:
        return _skipped("too_large")
    if suffix == PDF_EXTENSION:
        return _extract_pdf(resolved)
    if suffix == DOCX_EXTENSION:
        return _extract_docx(resolved)
    return _extract_text(resolved)


def extract_document(path: Path, guard: WorkspaceGuard) -> ExtractResult:
    """Extract ``(locator, text)`` sections from one file inside ``guard``'s root."""
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        return _skipped("unsupported_type")
    resolved = _contained_file(path, guard)
    if isinstance(resolved, ExtractResult):
        return resolved
    try:
        return _extract_contained(resolved, suffix)
    except (OSError, ToolExecutionFailure):
        return _failed("unreadable")
