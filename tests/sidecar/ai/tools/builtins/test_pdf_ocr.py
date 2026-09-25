"""Unit tests for the PDF OCR fallback (tessdata resolution + session notes)."""

from __future__ import annotations

import hashlib
import io
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.tools.builtins import pdf_ocr


def _clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("JENNY_TESSDATA_DIR", "TESSDATA_PREFIX", "JENNY_ENABLE_PDF_OCR"):
        monkeypatch.delenv(key, raising=False)


def _pin_default_dir(monkeypatch: pytest.MonkeyPatch, directory: Path) -> None:
    monkeypatch.setattr(pdf_ocr, "default_tessdata_dir", lambda: directory)


def _pin_digest(monkeypatch: pytest.MonkeyPatch, payload: bytes) -> None:
    monkeypatch.setattr(pdf_ocr, "ENGLISH_TESSDATA_SHA256", hashlib.sha256(payload).hexdigest())


class _Response(io.BytesIO):
    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()


def test_override_dir_wins_without_download(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    override = tmp_path / "override"
    override.mkdir()
    (override / pdf_ocr.ENGLISH_TESSDATA_FILENAME).write_bytes(b"model")
    monkeypatch.setenv("JENNY_TESSDATA_DIR", str(override))

    def _no_network(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("download must not run when an override is present")

    resolution = pdf_ocr.resolve_tessdata(opener=_no_network)
    assert resolution.directory == override
    assert resolution.reason == "override"


def test_override_dir_without_model_is_unavailable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("JENNY_TESSDATA_DIR", str(tmp_path))
    resolution = pdf_ocr.resolve_tessdata(opener=lambda *_a, **_k: _Response(b""))
    assert resolution.directory is None
    assert pdf_ocr.ENGLISH_TESSDATA_FILENAME in resolution.reason


def test_download_verifies_digest_and_caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    cache = tmp_path / "cache"
    _pin_default_dir(monkeypatch, cache)
    payload = b"english-model-bytes"
    _pin_digest(monkeypatch, payload)
    calls: list[str] = []

    def _opener(request: Any, *, timeout: float) -> _Response:
        calls.append(request.full_url)
        assert timeout == pdf_ocr.TESSDATA_DOWNLOAD_TIMEOUT_SECONDS
        return _Response(payload)

    first = pdf_ocr.resolve_tessdata(opener=_opener)
    assert first.directory == cache
    assert first.reason == "downloaded"
    assert (cache / pdf_ocr.ENGLISH_TESSDATA_FILENAME).read_bytes() == payload
    assert not (cache / (pdf_ocr.ENGLISH_TESSDATA_FILENAME + ".part")).exists()

    second = pdf_ocr.resolve_tessdata(opener=_opener)
    assert second.reason == "cached"
    assert calls == [pdf_ocr.ENGLISH_TESSDATA_URL]


def test_download_with_wrong_digest_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    cache = tmp_path / "cache"
    _pin_default_dir(monkeypatch, cache)
    _pin_digest(monkeypatch, b"expected")

    resolution = pdf_ocr.resolve_tessdata(opener=lambda *_a, **_k: _Response(b"tampered"))
    assert resolution.directory is None
    assert "SHA-256" in resolution.reason
    assert not (cache / pdf_ocr.ENGLISH_TESSDATA_FILENAME).exists()
    assert not (cache / (pdf_ocr.ENGLISH_TESSDATA_FILENAME + ".part")).exists()


def test_download_over_byte_limit_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    _pin_default_dir(monkeypatch, tmp_path / "cache")
    monkeypatch.setattr(pdf_ocr, "ENGLISH_TESSDATA_MAX_BYTES", 8)
    resolution = pdf_ocr.resolve_tessdata(opener=lambda *_a, **_k: _Response(b"x" * 9))
    assert resolution.directory is None
    assert "byte limit" in resolution.reason


def test_download_failure_reports_reason(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    _pin_default_dir(monkeypatch, tmp_path / "cache")

    def _offline(*_args: Any, **_kwargs: Any) -> None:
        raise OSError("network unreachable")

    resolution = pdf_ocr.resolve_tessdata(opener=_offline)
    assert resolution.directory is None
    assert "OSError" in resolution.reason


def test_no_download_when_disallowed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    _pin_default_dir(monkeypatch, tmp_path / "cache")
    resolution = pdf_ocr.resolve_tessdata(allow_download=False)
    assert resolution.directory is None
    assert "not installed" in resolution.reason


def test_cached_model_with_bad_digest_is_redownloaded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / pdf_ocr.ENGLISH_TESSDATA_FILENAME).write_bytes(b"stale")
    _pin_default_dir(monkeypatch, cache)
    payload = b"fresh"
    _pin_digest(monkeypatch, payload)
    resolution = pdf_ocr.resolve_tessdata(opener=lambda *_a, **_k: _Response(payload))
    assert resolution.reason == "downloaded"
    assert (cache / pdf_ocr.ENGLISH_TESSDATA_FILENAME).read_bytes() == payload


class _OcrPage:
    # Letter size: pages without readable geometry fail closed before OCR renders.
    rect = SimpleNamespace(width=612.0, height=792.0)

    def __init__(self, text: str = "recovered", *, fail: bool = False) -> None:
        self._text = text
        self._fail = fail
        self.calls: list[dict[str, Any]] = []

    def get_textpage_ocr(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self._fail:
            raise RuntimeError("No tessdata specified and Tesseract is not installed")
        text = self._text

        class _TextPage:
            @staticmethod
            def extractText() -> str:  # noqa: N802 - PyMuPDF API name.
                return text

        return _TextPage()


def test_session_disabled_by_kill_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR", "0")
    page = _OcrPage()
    session = pdf_ocr.PdfOcrSession()
    assert session.recover_text(page, page_number=1) is None
    assert page.calls == []
    assert "JENNY_ENABLE_PDF_OCR=0" in session.unavailable_reason
    assert "OCR is unavailable" in session.note(text_less_pages=[1])


def test_session_recovers_text_and_resolves_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    resolutions: list[int] = []

    def _resolve(**_kwargs: Any) -> pdf_ocr.TessdataResolution:
        resolutions.append(1)
        return pdf_ocr.TessdataResolution(tmp_path, "override")

    monkeypatch.setattr(pdf_ocr, "resolve_tessdata", _resolve)
    session = pdf_ocr.PdfOcrSession()
    page = _OcrPage("Total assets 1,234")
    assert session.recover_text(page, page_number=2) == "Total assets 1,234"
    assert session.recover_text(_OcrPage("more"), page_number=3) == "more"
    assert len(resolutions) == 1
    assert page.calls[0]["tessdata"] == str(tmp_path)
    assert page.calls[0]["language"] == "eng"
    assert page.calls[0]["full"] is True
    assert session.used_pages == [2, 3]
    note = session.note(text_less_pages=[2, 3])
    assert "recovered with OCR" in note and "recognition errors" in note


def test_session_engine_failure_degrades_with_reason(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setattr(
        pdf_ocr, "resolve_tessdata",
        lambda **_k: pdf_ocr.TessdataResolution(tmp_path, "override"),
    )
    session = pdf_ocr.PdfOcrSession()
    assert session.recover_text(_OcrPage(fail=True), page_number=1) is None
    assert session.unavailable_reason.startswith("OCR failed: RuntimeError")
    assert session.used_pages == []


def test_session_partial_recovery_note(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setattr(
        pdf_ocr, "resolve_tessdata",
        lambda **_k: pdf_ocr.TessdataResolution(tmp_path, "override"),
    )
    session = pdf_ocr.PdfOcrSession()
    assert session.recover_text(_OcrPage("ok"), page_number=1) == "ok"
    assert session.recover_text(_OcrPage(fail=True), page_number=2) is None
    note = session.note(text_less_pages=[1, 2])
    assert "pages 1 only" in note


def test_no_note_when_every_page_has_text() -> None:
    assert pdf_ocr.PdfOcrSession().note(text_less_pages=[]) == ""


def test_page_has_text_layer() -> None:
    assert pdf_ocr.page_has_text_layer("Balance sheet")
    assert not pdf_ocr.page_has_text_layer("")
    assert not pdf_ocr.page_has_text_layer(" \n\t ")


@pytest.mark.skipif(
    not (Path(pdf_ocr.default_tessdata_dir()) / pdf_ocr.ENGLISH_TESSDATA_FILENAME).is_file(),
    reason="English tessdata not installed on this machine",
)
def test_real_ocr_recovers_rendered_text(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fitz = pytest.importorskip("fitz")
    _clear_env(monkeypatch)
    # Build a page whose text is baked into a raster image, so it has no text layer.
    source = fitz.open()
    page = source.new_page(width=400, height=200)
    page.insert_text((40, 100), "NET INCOME 4521", fontsize=28)
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    scanned = fitz.open()
    target = scanned.new_page(width=400, height=200)
    target.insert_image(target.rect, pixmap=pixmap)
    assert not target.get_text().strip()

    session = pdf_ocr.PdfOcrSession()
    text = session.recover_text(target, page_number=1)
    assert text is not None
    assert "NET INCOME" in text.upper()
    assert "4521" in text
