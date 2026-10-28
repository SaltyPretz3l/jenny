"""Process-lifetime PDF page-text cache: OCR runs once per (digest, page)."""

from __future__ import annotations

import json
from pathlib import Path

import fitz
import pytest

from sidecar.ai.tools.builtins import pdf_ocr, pdf_ocr_rapid, pdf_page_cache, pdf_text
from sidecar.ai.tools.builtins.filesystem_content import read_media_file
from sidecar.ai.tools.builtins.rich_files.pdf import pdf_inspect_tool
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.fixture(autouse=True)
def _ocr_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR", "1")
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR_RAPID", "1")
    monkeypatch.delenv("JENNY_ENABLE_PDF_PAGE_CACHE", raising=False)
    pdf_page_cache.PDF_PAGE_CACHE.clear()


def _write_image_only_pdf(path: Path, text: str = "Losses 24,066,365 21,864,486") -> None:
    source = fitz.open()
    source_page = source.new_page(width=612, height=792)
    source_page.insert_text((36, 60), text, fontsize=12)
    pixmap = source_page.get_pixmap(dpi=72, colorspace=fitz.csRGB, alpha=False)
    scanned = fitz.open()
    page = scanned.new_page(width=612, height=792)
    page.insert_image(page.rect, pixmap=pixmap)
    scanned.save(path)
    scanned.close()
    source.close()


def _counting_rapid(monkeypatch: pytest.MonkeyPatch, *, words: bool = True) -> list[int]:
    calls: list[int] = []

    def recognize(_engine: object, _page: object) -> tuple[list[pdf_ocr_rapid.RapidWord], int]:
        calls.append(1)
        if not words:
            return [], 200
        return [
            pdf_ocr_rapid.RapidWord(36, 50, 76, 62, "Losses", 0.99),
            pdf_ocr_rapid.RapidWord(180, 50, 250, 62, "24,066,365", 0.60),
        ], 200

    monkeypatch.setattr(pdf_ocr_rapid, "load_engine", object)
    monkeypatch.setattr(pdf_ocr_rapid, "recognize_page", recognize)
    monkeypatch.setattr(
        pdf_ocr,
        "resolve_tessdata",
        lambda **_kwargs: pdf_ocr.TessdataResolution(None, "not installed"),
    )
    return calls


def _read(target: Path, root: Path):
    return read_media_file(
        target,
        relative_path=target.name,
        pages_argument="1",
        authorized_root=root,
    )


def test_two_reads_of_a_text_less_page_run_ocr_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "scan.pdf"
    _write_image_only_pdf(target)
    calls = _counting_rapid(monkeypatch)

    first = _read(target, tmp_path)
    second = _read(target, tmp_path)

    assert len(calls) == 1
    assert first.metadata["cache_hit"] is False
    assert second.metadata["cache_hit"] is True
    assert second.metadata["cached_pages"] == [1]
    first_payload = json.loads(first.output)
    second_payload = json.loads(second.output)
    # The replayed page and note are indistinguishable from the first read.
    for key in ("ocr", "ocr_engine", "ocr_uncertain", "text_excerpt", "text_layer"):
        assert second_payload["pages"][0][key] == first_payload["pages"][0][key]
    assert second_payload["note"] == first_payload["note"]
    assert second.metadata["ocr_pages"] == [1]
    assert second.metadata["ocr_engines"] == {1: "rapidocr"}
    assert second.metadata["text_less_pages"] == [1]


def test_pdf_inspect_reuses_the_page_read_file_recognized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "scan.pdf"
    _write_image_only_pdf(target)
    calls = _counting_rapid(monkeypatch)

    _read(target, tmp_path)
    rich = pdf_inspect_tool({"path": "scan.pdf", "pages": "1"}, WorkspaceGuard(str(tmp_path)))

    assert len(calls) == 1
    page = rich.metadata["summary"]["pages"][0]
    assert page["ocr_engine"] == "rapidocr"
    assert page["ocr_uncertain"][0]["word"] == "24,066,365"
    assert rich.metadata["summary"]["note"].startswith("Page 1 has no text layer; its text")


def test_an_edited_pdf_misses_the_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / "scan.pdf"
    _write_image_only_pdf(target)
    calls = _counting_rapid(monkeypatch)

    first = _read(target, tmp_path)
    _write_image_only_pdf(target, text="Gains 1,000")
    second = _read(target, tmp_path)

    assert len(calls) == 2
    assert first.metadata["digest"] != second.metadata["digest"]
    assert second.metadata["cache_hit"] is False


def test_a_page_ocr_could_not_read_is_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "scan.pdf"
    _write_image_only_pdf(target)
    calls = _counting_rapid(monkeypatch, words=False)

    _read(target, tmp_path)
    second = _read(target, tmp_path)

    assert len(calls) == 2
    assert second.metadata["cache_hit"] is False
    assert json.loads(second.output)["pages"][0]["ocr_unavailable"]


def test_kill_switch_disables_the_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JENNY_ENABLE_PDF_PAGE_CACHE", "0")
    target = tmp_path / "scan.pdf"
    _write_image_only_pdf(target)
    calls = _counting_rapid(monkeypatch)

    _read(target, tmp_path)
    second = _read(target, tmp_path)

    assert len(calls) == 2
    assert second.metadata["cache_hit"] is False


def _entry(text: str) -> pdf_page_cache.CachedPdfPage:
    return pdf_page_cache.CachedPdfPage(
        lines=(pdf_text.PdfTextLine(number=1, text=text, y=0.0),),
        text_layer=True,
        ocr_info=None,
    )


def test_cache_evicts_least_recently_used_pages_past_the_page_bound() -> None:
    cache = pdf_page_cache.PdfPageCache(max_pages=2, max_chars=1_000_000)
    cache.put("a" * 16, 1, _entry("one"))
    cache.put("a" * 16, 2, _entry("two"))
    assert cache.get("a" * 16, 1) is not None  # page 1 is now most recent
    cache.put("a" * 16, 3, _entry("three"))

    assert len(cache) == 2
    assert cache.get("a" * 16, 2) is None
    assert cache.get("a" * 16, 1) is not None
    assert cache.get("a" * 16, 3) is not None


def test_cache_enforces_its_character_ceiling() -> None:
    entry_size = _entry("x" * 100).size_chars
    cache = pdf_page_cache.PdfPageCache(max_pages=100, max_chars=entry_size * 2)
    for page in range(1, 4):
        cache.put("b" * 16, page, _entry("x" * 100))

    assert len(cache) == 2
    assert cache.size_chars == entry_size * 2
    cache.put("b" * 16, 9, _entry("x" * (entry_size * 3)))
    assert cache.get("b" * 16, 9) is None
    assert len(cache) == 2


def test_document_memo_is_a_bounded_lru() -> None:
    memo = pdf_page_cache.PdfDocumentMemo(max_entries=2)
    first = pdf_page_cache.PdfDocumentIdentity("a" * 16, 3)
    memo.put(("a.pdf", 10, 1), first)
    memo.put(("b.pdf", 10, 1), pdf_page_cache.PdfDocumentIdentity("b" * 16, 1))
    assert memo.get(("a.pdf", 10, 1)) == first
    memo.put(("c.pdf", 10, 1), pdf_page_cache.PdfDocumentIdentity("c" * 16, 1))

    assert len(memo) == 2
    assert memo.get(("b.pdf", 10, 1)) is None
    assert memo.get(("a.pdf", 10, 2)) is None
    assert memo.get(("a.pdf", 10, 1)) == first


def test_ocr_kill_switch_hides_a_cached_ocr_page(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "scan.pdf"
    _write_image_only_pdf(target)
    _counting_rapid(monkeypatch)
    _read(target, tmp_path)

    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR", "0")
    second = _read(target, tmp_path)

    page = json.loads(second.output)["pages"][0]
    assert second.metadata["cache_hit"] is False
    assert "ocr" not in page
    assert "JENNY_ENABLE_PDF_OCR=0" in page["ocr_unavailable"]


def _tesseract_reads(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    ocr_source = fitz.open()
    ocr_page = ocr_source.new_page(width=612, height=792)
    ocr_page.insert_text((36, 60), "Losses 24,066,365", fontsize=12)
    textpage = ocr_page.get_textpage()

    class _BorrowedTextPage:
        """PyMuPDF only accepts a textpage whose parent is the page being read."""

        def __init__(self, parent: object) -> None:
            self.parent = parent

        def extractWORDS(self, *args: object, **kwargs: object):
            return textpage.extractWORDS(*args, **kwargs)

    monkeypatch.setattr(
        pdf_ocr,
        "resolve_tessdata",
        lambda **_kwargs: pdf_ocr.TessdataResolution(tmp_path, "override"),
    )
    def borrowed_ocr(page: object, *, tessdata_dir: Path) -> _BorrowedTextPage:
        return _BorrowedTextPage(page)

    monkeypatch.setattr(pdf_ocr, "ocr_page_textpage", borrowed_ocr)


def test_tesseract_page_after_a_transient_rapid_failure_is_not_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "scan.pdf"
    _write_image_only_pdf(target)
    loads: list[int] = []

    def flaky_load() -> object:
        loads.append(1)
        if len(loads) == 1:
            raise RuntimeError("onnxruntime init failed")
        return object()

    monkeypatch.setattr(pdf_ocr_rapid, "load_engine", flaky_load)
    monkeypatch.setattr(pdf_ocr_rapid, "RAPID_LOAD_RETRY_SECONDS", 0.0)
    monkeypatch.setattr(
        pdf_ocr_rapid,
        "recognize_page",
        lambda _engine, _page: ([pdf_ocr_rapid.RapidWord(36, 50, 76, 62, "Losses", 0.99)], 200),
    )
    _tesseract_reads(monkeypatch, tmp_path)
    guard = WorkspaceGuard(str(tmp_path))

    first = pdf_inspect_tool({"path": "scan.pdf", "pages": "1"}, guard)
    second = pdf_inspect_tool({"path": "scan.pdf", "pages": "1"}, guard)

    assert first.metadata["summary"]["pages"][0]["ocr_engine"] == "tesseract"
    assert second.metadata["summary"]["pages"][0]["ocr_engine"] == "rapidocr"
    assert loads == [1, 1]


def test_tesseract_page_without_the_rapid_package_is_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "scan.pdf"
    _write_image_only_pdf(target)
    loads: list[int] = []
    textpages: list[int] = []

    def missing() -> object:
        loads.append(1)
        raise ImportError("rapidocr package missing")

    monkeypatch.setattr(pdf_ocr_rapid, "load_engine", missing)
    _tesseract_reads(monkeypatch, tmp_path)
    recognize = pdf_ocr.ocr_page_textpage
    monkeypatch.setattr(
        pdf_ocr,
        "ocr_page_textpage",
        lambda page, *, tessdata_dir: textpages.append(1) or recognize(page, tessdata_dir=tessdata_dir),
    )
    guard = WorkspaceGuard(str(tmp_path))

    first = pdf_inspect_tool({"path": "scan.pdf", "pages": "1"}, guard)
    second = pdf_inspect_tool({"path": "scan.pdf", "pages": "1"}, guard)

    assert first.metadata["summary"]["pages"][0]["ocr_engine"] == "tesseract"
    assert second.metadata["summary"]["pages"][0]["ocr_engine"] == "tesseract"
    assert textpages == [1]
    assert loads == [1]
