"""OCR fallback for PDF pages that carry no text layer.

PyMuPDF wheels bundle the Tesseract engine but not its language data, so the
only runtime dependency is ``eng.traineddata``. It is resolved from, in order:

1. ``JENNY_TESSDATA_DIR`` (explicit override),
2. ``TESSDATA_PREFIX`` when it already holds the English file,
3. Jenny's per-user cache directory, fetched once on first use from the
   pinned ``tessdata_fast`` release and verified by SHA-256 before use.

``JENNY_ENABLE_PDF_OCR=0`` is the kill switch: pages without a text layer are
then reported as such, and no download or recognition is attempted.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from sidecar.ai.config import read_environment_value
from sidecar.ai.tools.builtins import pdf_ocr_rapid
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

ENGLISH_TESSDATA_FILENAME = "eng.traineddata"
# tessdata_fast English model. Pinned by digest: a mismatch is refused, never
# "best effort" — a corrupt model would silently produce garbage numbers.
ENGLISH_TESSDATA_URL = (
    "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata"
)
ENGLISH_TESSDATA_SHA256 = (
    "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"
)
ENGLISH_TESSDATA_MAX_BYTES = 8 * 1024 * 1024
TESSDATA_DOWNLOAD_TIMEOUT_SECONDS = 60.0
OCR_RENDER_DPI = 200
# Rasterization budget shared by both OCR engines (the same 50M pixels as
# MAX_MEDIA_PIXELS in filesystem_content): a page's declared size alone can
# request billions of pixels at OCR resolution, so it is refused before any
# render, at the highest DPI either engine would use.
OCR_MAX_PIXELS = 50_000_000
OCR_MAX_RENDER_DPI = max(OCR_RENDER_DPI, pdf_ocr_rapid.RAPID_RENDER_DPI_HIGH)
OCR_LANGUAGE = "eng"

_download_lock = threading.Lock()
_DOWNLOAD_CHUNK_BYTES = 256 * 1024


@dataclass(frozen=True)
class TessdataResolution:
    directory: Path | None
    reason: str


@dataclass(frozen=True)
class OcrPageResult:
    words: list[tuple[Any, ...]]
    engine: str
    dpi: int | None


def pdf_ocr_enabled() -> bool:
    return read_environment_value("JENNY_ENABLE_PDF_OCR", "1") != "0"


def page_has_text_layer(text: str) -> bool:
    return bool(text and text.strip())


def default_tessdata_dir() -> Path:
    if os.name == "nt":
        base = read_environment_value("LOCALAPPDATA") or read_environment_value("APPDATA")
        if base:
            return Path(base) / "jenny" / "tessdata"
    xdg_cache = read_environment_value("XDG_CACHE_HOME")
    if xdg_cache:
        return Path(xdg_cache) / "jenny" / "tessdata"
    return Path.home() / ".cache" / "jenny" / "tessdata"


def _english_file_verified(directory: Path) -> bool:
    candidate = directory / ENGLISH_TESSDATA_FILENAME
    try:
        if not candidate.is_file() or candidate.stat().st_size > ENGLISH_TESSDATA_MAX_BYTES:
            return False
        digest = hashlib.sha256()
        with candidate.open("rb") as handle:
            for chunk in iter(lambda: handle.read(_DOWNLOAD_CHUNK_BYTES), b""):
                digest.update(chunk)
    except OSError:
        return False
    return digest.hexdigest() == ENGLISH_TESSDATA_SHA256


def _download_english_tessdata(
    directory: Path,
    *,
    opener: Callable[..., Any],
) -> str:
    """Fetch the pinned model into ``directory``; return "" or a reason."""

    target = directory / ENGLISH_TESSDATA_FILENAME
    partial = directory / (ENGLISH_TESSDATA_FILENAME + ".part")
    try:
        directory.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(
            ENGLISH_TESSDATA_URL, headers={"User-Agent": "jenny-pdf-ocr"}
        )
        digest = hashlib.sha256()
        received = 0
        with opener(request, timeout=TESSDATA_DOWNLOAD_TIMEOUT_SECONDS) as response, \
                partial.open("wb") as handle:
            while True:
                chunk = response.read(_DOWNLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                received += len(chunk)
                if received > ENGLISH_TESSDATA_MAX_BYTES:
                    raise ValueError("tessdata download exceeded its byte limit")
                digest.update(chunk)
                handle.write(chunk)
        if digest.hexdigest() != ENGLISH_TESSDATA_SHA256:
            raise ValueError("tessdata download failed its SHA-256 check")
        os.replace(partial, target)
    except Exception as exc:  # noqa: BLE001 — every failure degrades to "unavailable".
        try:
            partial.unlink(missing_ok=True)
        except OSError:
            pass
        return f"{type(exc).__name__}: {exc}"[:200]
    return ""


def _configured_tessdata() -> TessdataResolution | None:
    """Explicit locations (override env, TESSDATA_PREFIX); None means "use the cache"."""

    override = read_environment_value("JENNY_TESSDATA_DIR").strip()
    if override:
        directory = Path(override)
        if (directory / ENGLISH_TESSDATA_FILENAME).is_file():
            return TessdataResolution(directory, "override")
        return TessdataResolution(None, f"JENNY_TESSDATA_DIR has no {ENGLISH_TESSDATA_FILENAME}")
    prefix = read_environment_value("TESSDATA_PREFIX").strip()
    if prefix and (Path(prefix) / ENGLISH_TESSDATA_FILENAME).is_file():
        return TessdataResolution(Path(prefix), "tessdata_prefix")
    return None


def resolve_tessdata(
    *,
    allow_download: bool = True,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> TessdataResolution:
    configured = _configured_tessdata()
    if configured is not None:
        return configured

    directory = default_tessdata_dir()
    if _english_file_verified(directory):
        return TessdataResolution(directory, "cached")
    if not allow_download:
        return TessdataResolution(None, "English OCR model not installed")
    return _download_into(directory, opener=opener)


def _download_into(directory: Path, *, opener: Callable[..., Any]) -> TessdataResolution:
    with _download_lock:
        if _english_file_verified(directory):
            return TessdataResolution(directory, "cached")
        log_event(
            logger,
            logging.INFO,
            component="tools.pdf_ocr",
            event="tools.pdf_ocr.tessdata_download_started",
            message="Downloading the English OCR model for PDF pages without a text layer.",
            status="ok",
            data={"url": ENGLISH_TESSDATA_URL, "directory": str(directory)},
        )
        failure = _download_english_tessdata(directory, opener=opener)
    if failure:
        log_event(
            logger,
            logging.WARNING,
            component="tools.pdf_ocr",
            event="tools.pdf_ocr.tessdata_download_failed",
            message="English OCR model download failed; scanned pages stay unreadable.",
            status="failure",
            data={"reason": failure},
        )
        return TessdataResolution(None, f"OCR model download failed ({failure})")
    return TessdataResolution(directory, "downloaded")


def page_exceeds_pixel_budget(page: Any) -> bool:
    """True when rendering ``page`` at OCR resolution would exceed OCR_MAX_PIXELS."""

    try:
        width = float(page.rect.width)
        height = float(page.rect.height)
    except Exception:  # noqa: BLE001 - malformed geometry is not a reason to render.
        return True
    scale = OCR_MAX_RENDER_DPI / 72
    return width * scale * height * scale > OCR_MAX_PIXELS


def ocr_page_textpage(page: Any, *, tessdata_dir: Path) -> Any:
    """Recognize the full page and return PyMuPDF's textpage object."""

    return page.get_textpage_ocr(
        language=OCR_LANGUAGE,
        dpi=OCR_RENDER_DPI,
        full=True,
        tessdata=str(tessdata_dir),
    )


def ocr_page_text(page: Any, *, tessdata_dir: Path) -> str:
    """Recognize the full page as an image. Raises on engine failure."""

    textpage = ocr_page_textpage(page, tessdata_dir=tessdata_dir)
    return str(textpage.extractText() or "")


@dataclass
class PdfOcrSession:
    """Per-read OCR context: resolves tessdata at most once, records outcome."""

    enabled: bool = True
    _resolution: TessdataResolution | None = None
    used_pages: list[int] | None = None
    unavailable_reason: str = ""
    rapid_unavailable_reason: str = ""
    engines_used: dict[int, str] = field(default_factory=dict)
    empty_pages: set[int] = field(default_factory=set)
    _engines_attempted: dict[int, list[str]] = field(
        default_factory=dict,
        init=False,
        repr=False,
    )
    _rapid_engine: Any | None = field(default=None, init=False, repr=False)
    _rapid_load_attempted: bool = field(default=False, init=False, repr=False)
    _rapid_failed: bool = field(default=False, init=False, repr=False)
    _rapid_words: dict[int, list[pdf_ocr_rapid.RapidWord]] = field(
        default_factory=dict,
        init=False,
        repr=False,
    )
    _has_uncertain_tokens: bool = field(default=False, init=False, repr=False)

    def __post_init__(self) -> None:
        self.enabled = self.enabled and pdf_ocr_enabled()
        self.used_pages = []

    def _record_use(self, page_number: int, engine: str) -> None:
        assert self.used_pages is not None
        self.used_pages.append(page_number)
        self.engines_used[page_number] = engine

    def _load_rapid_engine(self) -> Any | None:
        if self._rapid_load_attempted:
            return self._rapid_engine
        self._rapid_load_attempted = True
        try:
            self._rapid_engine = pdf_ocr_rapid.load_engine()
        except Exception as exc:  # noqa: BLE001 - RapidOCR is an optional fallback.
            error_type = type(exc).__name__
            self.rapid_unavailable_reason = (
                f"{error_type}: {exc}"[:200]
                if isinstance(exc, ImportError)
                else error_type[:120]
            )
            self._rapid_failed = True
            log_event(
                logger,
                logging.WARNING,
                component="tools.pdf_ocr",
                event="tools.pdf_ocr.rapid_unavailable",
                message="RapidOCR is unavailable; falling back to Tesseract.",
                status="failure",
                data={"error_type": error_type},
            )
        return self._rapid_engine

    def recover_words(self, page: Any, *, page_number: int) -> OcrPageResult | None:
        """Recover PDF-point word tuples, preferring RapidOCR per page."""

        if not self.enabled:
            self.unavailable_reason = "OCR disabled (JENNY_ENABLE_PDF_OCR=0)"
            return None
        if self._refuse_oversized(page, page_number=page_number):
            return None
        if pdf_ocr_rapid.rapid_ocr_enabled() and not self._rapid_failed:
            engine = self._load_rapid_engine()
            if engine is not None:
                try:
                    rapid_words, dpi = pdf_ocr_rapid.recognize_page(engine, page)
                except Exception as exc:  # noqa: BLE001 - this page can use Tesseract.
                    log_event(
                        logger,
                        logging.WARNING,
                        component="tools.pdf_ocr",
                        event="tools.pdf_ocr.page_failed",
                        message="RapidOCR of a PDF page failed; trying Tesseract.",
                        status="failure",
                        data={
                            "page_number": page_number,
                            "error_type": type(exc).__name__,
                            "engine": "rapidocr",
                        },
                    )
                else:
                    self._engines_attempted.setdefault(page_number, []).append("rapidocr")
                    if rapid_words:
                        self._rapid_words[page_number] = rapid_words
                        self._record_use(page_number, "rapidocr")
                        return OcrPageResult(
                            pdf_ocr_rapid.word_tuples(rapid_words),
                            "rapidocr",
                            dpi,
                        )
                    # No words is not a recovery: let Tesseract look before
                    # the note claims the page's text was recovered.
                    log_event(
                        logger,
                        logging.INFO,
                        component="tools.pdf_ocr",
                        event="tools.pdf_ocr.page_empty",
                        message="RapidOCR found no words on a PDF page; trying Tesseract.",
                        status="ok",
                        data={"page_number": page_number, "engine": "rapidocr"},
                    )

        if self._resolution is None:
            self._resolution = resolve_tessdata()
        if self._resolution.directory is None:
            self.unavailable_reason = self._resolution.reason
            return None
        try:
            textpage = ocr_page_textpage(page, tessdata_dir=self._resolution.directory)
            words = list(page.get_text("words", textpage=textpage))
        except Exception as exc:  # noqa: BLE001 - OCR is best-effort recovery.
            self.unavailable_reason = f"OCR failed: {type(exc).__name__}"[:120]
            log_event(
                logger,
                logging.WARNING,
                component="tools.pdf_ocr",
                event="tools.pdf_ocr.page_failed",
                message="OCR of a PDF page failed.",
                status="failure",
                data={"page_number": page_number, "error_type": type(exc).__name__},
            )
            return None
        self._engines_attempted.setdefault(page_number, []).append("tesseract")
        if not words:
            self.empty_pages.add(page_number)
        self._record_use(page_number, "tesseract")
        return OcrPageResult(words, "tesseract", None)

    def uncertain_for(
        self,
        page: Any,
        *,
        page_number: int,
        lines: list[Any],
    ) -> list[dict[str, object]]:
        """Report RapidOCR uncertainty, optionally enriched by Tesseract."""

        rapid_words = self._rapid_words.get(page_number)
        if rapid_words is None:
            return []
        uncertain = pdf_ocr_rapid.uncertain_tokens(rapid_words, lines)
        if not uncertain:
            return []
        self._has_uncertain_tokens = True
        try:
            if self._resolution is None:
                self._resolution = resolve_tessdata()
            if self._resolution.directory is None:
                raise RuntimeError(self._resolution.reason)
            textpage = ocr_page_textpage(page, tessdata_dir=self._resolution.directory)
            tess_words = list(page.get_text("words", textpage=textpage))
            uncertain = pdf_ocr_rapid.alt_readings(uncertain, rapid_words, tess_words)
        except Exception as exc:  # noqa: BLE001 - the primary reading remains usable.
            log_event(
                logger,
                logging.WARNING,
                component="tools.pdf_ocr",
                event="tools.pdf_ocr.second_opinion_failed",
                message="Tesseract second opinion for RapidOCR tokens failed.",
                status="failure",
                data={"page_number": page_number, "error_type": type(exc).__name__},
            )
        fields: list[dict[str, object]] = []
        for token in uncertain:
            item: dict[str, object] = {
                "line": token.line,
                "token": token.token,
                "score": round(token.score, 2),
            }
            if token.alt is not None:
                item["alt"] = token.alt
            fields.append(item)
        return fields

    def recover_text(self, page: Any, *, page_number: int) -> str | None:
        """Return OCR text for a page without a text layer, or None."""

        textpage = self.recover_textpage(page, page_number=page_number)
        if textpage is None:
            return None
        return str(textpage.extractText() or "")

    def _refuse_oversized(self, page: Any, *, page_number: int) -> bool:
        if not page_exceeds_pixel_budget(page):
            return False
        self.unavailable_reason = "page too large to rasterize for OCR"
        log_event(
            logger,
            logging.WARNING,
            component="tools.pdf_ocr",
            event="tools.pdf_ocr.page_too_large",
            message="PDF page exceeds the OCR pixel budget; it was not rendered.",
            status="failure",
            data={"page_number": page_number, "max_pixels": OCR_MAX_PIXELS},
        )
        return True

    def recover_textpage(self, page: Any, *, page_number: int) -> Any | None:
        """Return an OCR textpage for a page without a text layer, or None."""

        if not self.enabled:
            self.unavailable_reason = "OCR disabled (JENNY_ENABLE_PDF_OCR=0)"
            return None
        if self._refuse_oversized(page, page_number=page_number):
            return None
        if self._resolution is None:
            self._resolution = resolve_tessdata()
        if self._resolution.directory is None:
            self.unavailable_reason = self._resolution.reason
            return None
        try:
            textpage = ocr_page_textpage(page, tessdata_dir=self._resolution.directory)
        except Exception as exc:  # noqa: BLE001 — OCR is best-effort recovery.
            self.unavailable_reason = f"OCR failed: {type(exc).__name__}"[:120]
            log_event(
                logger,
                logging.WARNING,
                component="tools.pdf_ocr",
                event="tools.pdf_ocr.page_failed",
                message="OCR of a PDF page failed.",
                status="failure",
                data={"page_number": page_number, "error_type": type(exc).__name__},
            )
            return None
        assert self.used_pages is not None
        self.used_pages.append(page_number)
        return textpage

    def note(self, *, text_less_pages: list[int]) -> str:
        """One model-visible line explaining what happened to scanned pages."""

        if not text_less_pages:
            return ""
        pages = ", ".join(str(number) for number in text_less_pages)
        single = len(text_less_pages) == 1
        subject = f"Page {pages} has" if single else f"Pages {pages} have"
        used_pages = self.used_pages or []
        tesseract_pages = [
            number
            for number in used_pages
            if self.engines_used.get(number, "tesseract") == "tesseract"
        ]
        rapid_pages = [
            number
            for number in used_pages
            if self.engines_used.get(number, "tesseract") == "rapidocr"
        ]
        if rapid_pages and tesseract_pages:
            engines = (
                "RapidOCR; Tesseract for pages "
                + ", ".join(str(number) for number in tesseract_pages)
            )
        elif rapid_pages:
            engines = "RapidOCR"
        else:
            engines = "Tesseract"
        empty_pages = sorted(self.empty_pages.intersection(text_less_pages))
        if empty_pages:
            note = self._note_with_empty_pages(
                empty_pages=empty_pages,
                used_pages=used_pages,
                engines=engines,
                text_less_pages=text_less_pages,
            )
        elif self.used_pages and set(self.used_pages) >= set(text_less_pages):
            note = (
                f"{subject} no text layer; {'its' if single else 'their'} text was "
                f"recovered with OCR "
                f"({engines}) and may contain recognition errors."
            )
        elif self.used_pages:
            note = (
                f"{subject} no text layer; OCR ({engines}) recovered text for pages "
                f"{', '.join(str(n) for n in self.used_pages)} only "
                f"({self.unavailable_reason or 'unknown reason'})."
            )
        else:
            note = (
                f"{subject} no text layer (scanned image) and OCR is unavailable: "
                f"{self.unavailable_reason or 'unknown reason'}."
            )
        if self.rapid_unavailable_reason and tesseract_pages:
            note += (
                f" RapidOCR was unavailable ({self.rapid_unavailable_reason}); "
                "Tesseract was used."
            )
        if self._has_uncertain_tokens:
            note += (
                " Low-confidence tokens are listed per page under ocr_uncertain (the "
                "alternate reading may be shown). Report them exactly as read and mark them "
                "uncertain; do not try to resolve them."
            )
        return note

    def _note_with_empty_pages(
        self,
        *,
        empty_pages: list[int],
        used_pages: list[int],
        engines: str,
        text_less_pages: list[int],
    ) -> str:
        recovered_pages = [
            number for number in used_pages if number not in self.empty_pages
        ]
        notes: list[str] = []
        if recovered_pages:
            recovered = ", ".join(str(number) for number in recovered_pages)
            recovered_single = len(recovered_pages) == 1
            recovered_subject = (
                f"Page {recovered} has" if recovered_single else f"Pages {recovered} have"
            )
            notes.append(
                f"{recovered_subject} no text layer; "
                f"{'its' if recovered_single else 'their'} text was recovered with "
                f"OCR ({engines}) and may contain recognition errors."
            )
        for number in empty_pages:
            attempted = self._engines_attempted.get(number, [])
            if attempted == ["rapidocr", "tesseract"]:
                empty_engines = "RapidOCR, then Tesseract"
            elif attempted == ["rapidocr"]:
                empty_engines = "RapidOCR"
            else:
                empty_engines = "Tesseract"
            notes.append(
                f"Page {number} has no text layer, and OCR ({empty_engines}) found "
                "no text on it (blank or unreadable image)."
            )
        unread_pages = [
            number
            for number in text_less_pages
            if number not in used_pages and number not in self.empty_pages
        ]
        if unread_pages:
            unread = ", ".join(str(number) for number in unread_pages)
            unread_single = len(unread_pages) == 1
            notes.append(
                f"{'Page' if unread_single else 'Pages'} {unread} "
                f"{'has' if unread_single else 'have'} no text layer and OCR could not "
                f"read {'it' if unread_single else 'them'} "
                f"({self.unavailable_reason or 'unknown reason'})."
            )
        return " ".join(notes)


def ocr_page_fields(
    info: dict[str, object] | None,
    *,
    text_layer: bool,
    session: PdfOcrSession,
) -> dict[str, object]:
    """Shared model-visible per-page OCR fields for both PDF read paths."""

    if info is None:
        return {} if text_layer else {"ocr_unavailable": session.unavailable_reason}
    fields: dict[str, object] = {"ocr": True, "ocr_engine": info["engine"]}
    uncertain = info.get("uncertain")
    if uncertain:
        fields["ocr_uncertain"] = uncertain
    return fields
