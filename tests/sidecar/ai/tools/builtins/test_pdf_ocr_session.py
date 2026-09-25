"""RapidOCR-first PDF OCR session and read-path integration tests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.tools.builtins import pdf_ocr, pdf_ocr_rapid, pdf_text
from sidecar.ai.tools.builtins.filesystem_content import read_media_file
from sidecar.ai.tools.builtins.rich_files.pdf import pdf_inspect_tool
from sidecar.ai.tools.workspace import WorkspaceGuard

fitz = pytest.importorskip("fitz")


class _Rect:
    x0 = 0.0
    y0 = 0.0
    width = 612.0
    height = 792.0


class _TextPage:
    pass


class _Page:
    rect = _Rect()

    def __init__(
        self,
        *,
        tess_words: list[tuple[Any, ...]] | None = None,
        fail_tesseract: bool = False,
    ) -> None:
        self.tess_words = tess_words or []
        self.fail_tesseract = fail_tesseract
        self.textpage = _TextPage()

    def get_text(self, kind: str, *, textpage: Any | None = None) -> Any:
        if kind == "text":
            return ""
        if kind == "words":
            return self.tess_words if textpage is self.textpage else []
        raise AssertionError(f"unexpected get_text kind: {kind}")

    def get_textpage_ocr(self, **_kwargs: Any) -> _TextPage:
        if self.fail_tesseract:
            raise RuntimeError("tesseract failed")
        return self.textpage


@pytest.fixture(autouse=True)
def _ocr_flags_and_no_stdout(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR", "1")
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR_RAPID", "1")
    yield
    assert capsys.readouterr().out == ""


def _rapid_words() -> list[pdf_ocr_rapid.RapidWord]:
    return [
        pdf_ocr_rapid.RapidWord(36, 50, 76, 62, "Losses", 0.99),
        pdf_ocr_rapid.RapidWord(180, 50, 250, 62, "24,066,365", 0.60),
        pdf_ocr_rapid.RapidWord(300, 50, 370, 62, "21,864,486", 0.99),
    ]


def _tessdata(tmp_path: Path) -> pdf_ocr.TessdataResolution:
    return pdf_ocr.TessdataResolution(tmp_path, "override")


def test_recover_words_prefers_rapidocr_and_records_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = object()
    loads: list[int] = []
    monkeypatch.setattr(
        pdf_ocr_rapid,
        "load_engine",
        lambda: loads.append(1) or engine,
    )
    monkeypatch.setattr(
        pdf_ocr_rapid,
        "recognize_page",
        lambda actual, _page: (_rapid_words(), 200) if actual is engine else None,
    )
    session = pdf_ocr.PdfOcrSession()

    result = session.recover_words(_Page(), page_number=2)

    assert result == pdf_ocr.OcrPageResult(
        pdf_ocr_rapid.word_tuples(_rapid_words()),
        "rapidocr",
        200,
    )
    assert loads == [1]
    assert session.used_pages == [2]
    assert session.engines_used == {2: "rapidocr"}


def test_rapid_load_failure_logs_once_then_uses_tesseract(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, Any]] = []

    def fail_load() -> object:
        raise ImportError("rapidocr package missing")

    monkeypatch.setattr(pdf_ocr_rapid, "load_engine", fail_load)
    monkeypatch.setattr(pdf_ocr, "resolve_tessdata", lambda **_kwargs: _tessdata(tmp_path))
    monkeypatch.setattr(
        pdf_ocr,
        "log_event",
        lambda *_args, **kwargs: events.append(kwargs),
    )
    words = [(10, 20, 30, 32, "Tess", 0, 0, 0)]
    session = pdf_ocr.PdfOcrSession()

    first = session.recover_words(_Page(tess_words=words), page_number=1)
    second = session.recover_words(_Page(tess_words=words), page_number=2)

    assert first == pdf_ocr.OcrPageResult(words, "tesseract", None)
    assert second == pdf_ocr.OcrPageResult(words, "tesseract", None)
    assert session.rapid_unavailable_reason == "ImportError: rapidocr package missing"
    assert session.engines_used == {1: "tesseract", 2: "tesseract"}
    rapid_events = [
        event for event in events if event["event"] == "tools.pdf_ocr.rapid_unavailable"
    ]
    assert len(rapid_events) == 1
    assert rapid_events[0]["data"] == {"error_type": "ImportError"}


def test_rapid_page_failure_falls_back_once_then_retries_rapid(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = object()
    first_page = _Page(tess_words=[(10, 20, 30, 32, "Tess", 0, 0, 0)])
    second_page = _Page()
    monkeypatch.setattr(pdf_ocr_rapid, "load_engine", lambda: engine)

    def recognize(_engine: object, page: _Page):
        if page is first_page:
            raise RuntimeError("bad raster")
        return _rapid_words(), 300

    monkeypatch.setattr(pdf_ocr_rapid, "recognize_page", recognize)
    monkeypatch.setattr(pdf_ocr, "resolve_tessdata", lambda **_kwargs: _tessdata(tmp_path))
    session = pdf_ocr.PdfOcrSession()

    first = session.recover_words(first_page, page_number=1)
    second = session.recover_words(second_page, page_number=2)

    assert first is not None and first.engine == "tesseract"
    assert second is not None and second.engine == "rapidocr"
    assert session.engines_used == {1: "tesseract", 2: "rapidocr"}


def test_rapid_flag_off_uses_tesseract_without_loading(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR_RAPID", "0")
    monkeypatch.setattr(
        pdf_ocr_rapid,
        "load_engine",
        lambda: pytest.fail("RapidOCR must not load"),
    )
    monkeypatch.setattr(pdf_ocr, "resolve_tessdata", lambda **_kwargs: _tessdata(tmp_path))

    result = pdf_ocr.PdfOcrSession().recover_words(
        _Page(tess_words=[(10, 20, 30, 32, "Tess", 0, 0, 0)]),
        page_number=1,
    )

    assert result is not None and result.engine == "tesseract"


def test_all_ocr_flag_off_calls_neither_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR", "0")
    monkeypatch.setattr(
        pdf_ocr_rapid,
        "load_engine",
        lambda: pytest.fail("RapidOCR must not load"),
    )
    monkeypatch.setattr(
        pdf_ocr,
        "resolve_tessdata",
        lambda **_kwargs: pytest.fail("Tesseract must not resolve"),
    )
    session = pdf_ocr.PdfOcrSession()

    assert session.recover_words(_Page(), page_number=1) is None
    assert session.unavailable_reason == "OCR disabled (JENNY_ENABLE_PDF_OCR=0)"


def test_page_lines_reports_uncertain_tokens_and_tesseract_alternatives(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rapid_words = [
        pdf_ocr_rapid.RapidWord(10, 20, 50, 32, "Losses", 0.99),
        pdf_ocr_rapid.RapidWord(120, 20, 190, 32, "24,066,365", 0.60),
        pdf_ocr_rapid.RapidWord(240, 20, 310, 32, "21,864,486", 0.70),
    ]
    tess_words = [
        (120, 20, 190, 32, "24,086,365", 0, 0, 0),
        (240, 20, 310, 32, "21,864,486", 0, 0, 1),
    ]
    monkeypatch.setattr(pdf_ocr_rapid, "load_engine", object)
    monkeypatch.setattr(
        pdf_ocr_rapid,
        "recognize_page",
        lambda _engine, _page: (rapid_words, 200),
    )
    monkeypatch.setattr(pdf_ocr, "resolve_tessdata", lambda **_kwargs: _tessdata(tmp_path))
    session = pdf_ocr.PdfOcrSession()
    text_less_pages: list[int] = []

    lines, text_layer, info = pdf_text.page_lines(
        _Page(tess_words=tess_words),
        page_number=1,
        ocr_session=session,
        text_less_pages=text_less_pages,
        tool_name="read_file",
    )

    assert text_layer is False
    assert text_less_pages == [1]
    assert [line.number for line in lines] == [1]
    assert lines[0].text.split() == ["Losses", "24,066,365", "21,864,486"]
    assert info == {
        "engine": "rapidocr",
        "dpi": 200,
        "uncertain": [
            {"line": 1, "token": "24,066,365", "score": 0.6, "alt": "24,086,365"},
            {"line": 1, "token": "21,864,486", "score": 0.7},
        ],
    }


def test_note_names_engines_unavailability_and_uncertain_tokens() -> None:
    rapid = pdf_ocr.PdfOcrSession()
    rapid.used_pages = [1, 2]
    rapid.engines_used = {1: "rapidocr", 2: "rapidocr"}
    rapid_note = rapid.note(text_less_pages=[1, 2])
    assert "OCR (RapidOCR)" in rapid_note
    assert rapid_note.startswith("Pages 1, 2 have no text layer; their text")
    assert "page image" not in rapid_note

    mixed = pdf_ocr.PdfOcrSession()
    mixed.used_pages = [1, 3, 5]
    mixed.engines_used = {1: "rapidocr", 3: "tesseract", 5: "tesseract"}
    assert "OCR (RapidOCR; Tesseract for pages 3, 5)" in mixed.note(text_less_pages=[1, 3, 5])

    unavailable = pdf_ocr.PdfOcrSession()
    unavailable.used_pages = [1]
    unavailable.engines_used = {1: "tesseract"}
    unavailable.rapid_unavailable_reason = "ImportError: missing"
    note = unavailable.note(text_less_pages=[1])
    assert "OCR (Tesseract)" in note
    assert "RapidOCR was unavailable (ImportError: missing); Tesseract was used." in note

    uncertain = pdf_ocr.PdfOcrSession()
    uncertain.used_pages = [1]
    uncertain.engines_used = {1: "rapidocr"}
    uncertain._has_uncertain_tokens = True
    note = uncertain.note(text_less_pages=[1])
    assert "Low-confidence tokens are listed per page under ocr_uncertain" in note
    assert "Report them exactly as read and mark them uncertain" in note
    assert "do not try to resolve them" in note
    assert "page image" not in note


def test_note_reports_blank_page_when_ocr_finds_no_words(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(pdf_ocr_rapid, "load_engine", object)
    monkeypatch.setattr(pdf_ocr_rapid, "recognize_page", lambda _engine, _page: ([], 200))
    monkeypatch.setattr(pdf_ocr, "resolve_tessdata", lambda **_kwargs: _tessdata(tmp_path))

    blank = pdf_ocr.PdfOcrSession()
    assert blank.recover_words(_Page(), page_number=1) == pdf_ocr.OcrPageResult(
        [],
        "tesseract",
        None,
    )
    blank_note = blank.note(text_less_pages=[1])
    assert blank_note == (
        "Page 1 has no text layer, and OCR (RapidOCR, then Tesseract) found no "
        "text on it (blank or unreadable image)."
    )
    assert "recovered" not in blank_note

    recovered = pdf_ocr.PdfOcrSession()
    words = [(10, 20, 30, 32, "Tess", 0, 0, 0)]
    assert recovered.recover_words(
        _Page(tess_words=words),
        page_number=1,
    ) == pdf_ocr.OcrPageResult(words, "tesseract", None)
    assert recovered.note(text_less_pages=[1]) == (
        "Page 1 has no text layer; its text was recovered with OCR (Tesseract) "
        "and may contain recognition errors."
    )

    # A blank page must not hide another page OCR could not read.
    mixed = pdf_ocr.PdfOcrSession()
    assert mixed.recover_words(_Page(), page_number=1) == pdf_ocr.OcrPageResult(
        [],
        "tesseract",
        None,
    )
    mixed.unavailable_reason = "page too large to rasterize for OCR"
    assert mixed.note(text_less_pages=[1, 2]) == (
        "Page 1 has no text layer, and OCR (RapidOCR, then Tesseract) found no "
        "text on it (blank or unreadable image). Page 2 has no text layer and OCR "
        "could not read it (page too large to rasterize for OCR)."
    )


def _write_image_only_pdf(path: Path) -> None:
    source = fitz.open()
    source_page = source.new_page(width=612, height=792)
    source_page.insert_text(
        (36, 60),
        "Losses 24,066,365 21,864,486",
        fontsize=12,
    )
    pixmap = source_page.get_pixmap(dpi=200, colorspace=fitz.csRGB, alpha=False)
    scanned = fitz.open()
    page = scanned.new_page(width=612, height=792)
    page.insert_image(page.rect, pixmap=pixmap)
    scanned.save(path)
    scanned.close()
    source.close()


def test_media_and_rich_pdf_paths_publish_rapidocr_details(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "scan.pdf"
    _write_image_only_pdf(target)
    monkeypatch.setattr(pdf_ocr_rapid, "load_engine", object)
    monkeypatch.setattr(
        pdf_ocr_rapid,
        "recognize_page",
        lambda _engine, _page: (_rapid_words(), 200),
    )
    monkeypatch.setattr(
        pdf_ocr,
        "resolve_tessdata",
        lambda **_kwargs: pdf_ocr.TessdataResolution(None, "not installed"),
    )

    media = read_media_file(
        target,
        relative_path="scan.pdf",
        pages_argument="1",
        authorized_root=tmp_path,
    )
    media_payload = json.loads(media.output)
    media_page = media_payload["pages"][0]
    assert media_page["ocr_engine"] == "rapidocr"
    assert media_page["ocr_uncertain"] == [{"line": 1, "token": "24,066,365", "score": 0.6}]
    assert "24,066,365" in media_page["text_excerpt"]
    assert "21,864,486" in media_page["text_excerpt"]
    assert media.metadata["ocr_engines"] == {1: "rapidocr"}
    media_note = media_payload["note"]
    assert media_note.startswith("Page 1 has no text layer; its text was recovered")
    assert media_note.endswith(pdf_text.SOURCES_NOTE)

    rich = pdf_inspect_tool(
        {"path": "scan.pdf", "pages": "1"},
        WorkspaceGuard(str(tmp_path)),
    )
    rich_page = rich.metadata["summary"]["pages"][0]
    assert rich_page["ocr_engine"] == "rapidocr"
    assert rich_page["ocr_uncertain"][0]["token"] == "24,066,365"
    rich_note = rich.metadata["summary"]["note"]
    assert rich_note.startswith("Page 1 has no text layer; its text was recovered")
    assert rich_note.endswith(pdf_text.SOURCES_NOTE)



def test_rapid_empty_page_is_not_a_recovery_and_falls_through_to_tesseract(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, Any]] = []
    monkeypatch.setattr(pdf_ocr_rapid, "load_engine", object)
    monkeypatch.setattr(pdf_ocr_rapid, "recognize_page", lambda _engine, _page: ([], 200))
    monkeypatch.setattr(pdf_ocr, "resolve_tessdata", lambda **_kwargs: _tessdata(tmp_path))
    monkeypatch.setattr(pdf_ocr, "log_event", lambda *_args, **kwargs: events.append(kwargs))
    words = [(10, 20, 30, 32, "Tess", 0, 0, 0)]
    session = pdf_ocr.PdfOcrSession()

    result = session.recover_words(_Page(tess_words=words), page_number=1)

    assert result == pdf_ocr.OcrPageResult(words, "tesseract", None)
    assert session.engines_used == {1: "tesseract"}
    assert session.rapid_unavailable_reason == ""
    assert [event["event"] for event in events] == ["tools.pdf_ocr.page_empty"]


class _HugeRect:
    x0 = 0.0
    y0 = 0.0
    width = 200_000.0
    height = 200_000.0


def test_oversized_page_is_refused_before_either_engine_renders(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        pdf_ocr_rapid,
        "load_engine",
        lambda: pytest.fail("RapidOCR must not load"),
    )
    monkeypatch.setattr(
        pdf_ocr,
        "resolve_tessdata",
        lambda **_kwargs: pytest.fail("Tesseract must not resolve"),
    )
    page = _Page()
    page.rect = _HugeRect()
    session = pdf_ocr.PdfOcrSession()

    assert session.recover_words(page, page_number=1) is None
    assert session.unavailable_reason == "page too large to rasterize for OCR"
    assert session.recover_textpage(page, page_number=1) is None
    assert session.used_pages == []
    assert pdf_ocr.page_exceeds_pixel_budget(_Page()) is False
    assert pdf_ocr.page_exceeds_pixel_budget(object()) is True
