"""Tests for the RapidOCR scanned-page engine."""

from __future__ import annotations

import builtins
import importlib.util
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.tools.builtins import pdf_ocr_rapid
from sidecar.ai.tools.builtins.pdf_ocr_rapid import (
    RapidWord,
    alt_readings,
    engine_params,
    load_engine,
    recognize_page,
    render_dpi,
    uncertain_tokens,
    word_tuples,
)
from sidecar.ai.tools.builtins.pdf_text import PdfTextLine, reconstruct_page_lines

fitz = pytest.importorskip("pymupdf")


class _Page:
    def __init__(
        self,
        *,
        width: float = 612,
        origin: tuple[float, float] = (0, 0),
        image_width: int = 0,
        image_error: bool = False,
        words: list[tuple[Any, ...]] | None = None,
    ) -> None:
        self.rect = SimpleNamespace(width=width, x0=origin[0], y0=origin[1])
        self.image_width = image_width
        self.image_error = image_error
        self.words = words or []
        self.pixmap = SimpleNamespace(samples=bytes(range(18)), width=3, height=2, n=3)

    def get_image_info(self) -> list[dict[str, int]]:
        if self.image_error:
            raise RuntimeError("bad image metadata")
        return [{"width": self.image_width}]

    def get_pixmap(self, **_kwargs: Any) -> Any:
        return self.pixmap

    def get_text(self, kind: str, **_kwargs: Any) -> list[tuple[Any, ...]]:
        assert kind == "words"
        return self.words


class _Engine:
    def __init__(self, result: Any) -> None:
        self.result = result
        self.calls: list[tuple[Any, dict[str, Any]]] = []

    def __call__(self, image: Any, **kwargs: Any) -> Any:
        self.calls.append((image, kwargs))
        return self.result


def _polygon(x0: float, y0: float, x1: float, y1: float) -> list[list[float]]:
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def test_reconstruct_page_lines_accepts_equivalent_word_tuples() -> None:
    raw_words = [
        (72.0, 100.0, 112.0, 110.0, "Assets", 0, 0, 0),
        (300.0, 100.0, 350.0, 110.0, "123,456", 0, 0, 1),
    ]
    page = _Page(words=raw_words)

    extracted = reconstruct_page_lines(page)
    supplied = reconstruct_page_lines(page, words=raw_words)

    assert supplied == extracted
    assert supplied[0].text.index("123,456") == extracted[0].text.index("123,456")


@pytest.mark.parametrize(
    ("image_width", "image_error", "expected"),
    [(0, False, 200), (1700, False, 200), (2550, False, 300), (0, True, 200)],
)
def test_render_dpi_uses_embedded_image_resolution(
    image_width: int,
    image_error: bool,
    expected: int,
) -> None:
    assert render_dpi(_Page(image_width=image_width, image_error=image_error)) == expected


@pytest.mark.parametrize(
    ("image_width", "pixel_box", "expected_dpi", "expected_box"),
    [
        (0, _polygon(100, 50, 200, 100), 200, (46.0, 38.0, 82.0, 56.0)),
        (2550, _polygon(125, 250, 250, 375), 300, (40.0, 80.0, 70.0, 110.0)),
    ],
)
def test_recognize_page_converts_per_word_boxes_to_pdf_points(
    image_width: int,
    pixel_box: list[list[float]],
    expected_dpi: int,
    expected_box: tuple[float, float, float, float],
) -> None:
    result = SimpleNamespace(
        boxes=[_polygon(0, 0, 300, 100)],
        txts=["ignored line"],
        scores=[0.4],
        word_results=[(("figure", 0.95, pixel_box),)],
    )
    engine = _Engine(result)
    page = _Page(origin=(10, 20), image_width=image_width)

    words, dpi = recognize_page(engine, page)

    assert dpi == expected_dpi
    assert (words[0].x0, words[0].y0, words[0].x1, words[0].y1) == pytest.approx(expected_box)
    assert words[0].text == "figure"
    assert words[0].score == 0.95
    image, kwargs = engine.calls[0]
    assert image.shape == (2, 3, 3)
    assert str(image.dtype) == "uint8"
    assert kwargs == {"return_word_box": True, "text_score": 0.5}


def test_recognize_page_splits_line_box_by_character_offsets() -> None:
    result = SimpleNamespace(
        boxes=[_polygon(0, 0, 60, 20)],
        txts=["AB CDE"],
        scores=[0.7],
        word_results=None,
    )

    words, dpi = recognize_page(_Engine(result), _Page())

    assert dpi == 200
    assert [word.text for word in words] == ["AB", "CDE"]
    scale = dpi / 72
    assert words[0].x0 == 0
    assert words[0].x1 == pytest.approx(20 / scale)
    assert words[1].x0 == pytest.approx(30 / scale)
    assert words[1].x1 == pytest.approx(60 / scale)
    assert [word.score for word in words] == [0.7, 0.7]


def test_uncertain_tokens_maps_orders_and_caps() -> None:
    words = [
        RapidWord(0, float(index) - 1, 10, float(index) + 1, f"w{index}", index / 100)
        for index in range(1, 26)
    ]
    words.append(RapidWord(0, 49, 10, 51, "certain", 0.85))
    lines = [PdfTextLine(index, f"line {index}", float(index) - 1) for index in range(1, 51)]

    uncertain = uncertain_tokens(words, lines, threshold=0.85, limit=20)

    assert len(uncertain) == 20
    assert [token.score for token in uncertain] == sorted(token.score for token in uncertain)
    assert uncertain[0] == pdf_ocr_rapid.UncertainToken(1, "w1", 0.01, None)
    assert uncertain[-1].line == 20
    assert all(token.token != "certain" for token in uncertain)


def test_uncertain_tokens_match_word_tops_to_band_tops() -> None:
    # A tall word whose centre (10) lies closer to the next band's top (14)
    # than to its own (0) still belongs to the band it starts in.
    words = [RapidWord(0, 0, 30, 20, "120", 0.5), RapidWord(0, 14, 30, 22, "900", 0.5)]
    lines = [PdfTextLine(1, "120", 0.0), PdfTextLine(2, "900", 14.0)]

    uncertain = uncertain_tokens(words, lines, threshold=0.85, limit=20)

    assert [(token.line, token.token) for token in uncertain] == [(1, "120"), (2, "900")]


def test_uncertain_tokens_skip_punctuation_only_tokens() -> None:
    words = [
        RapidWord(0, 0, 10, 10, ",", 0.1),
        RapidWord(20, 0, 30, 10, "...", 0.2),
        RapidWord(40, 0, 60, 10, "24,066,365", 0.3),
    ]
    lines = [PdfTextLine(1, "line", 5.0)]

    assert [token.token for token in uncertain_tokens(words, lines)] == ["24,066,365"]


def test_alt_readings_drop_leader_dots_from_tesseract_words() -> None:
    words = [RapidWord(0, 0, 40, 10, "Offce", 0.4)]
    uncertain = uncertain_tokens(words, [PdfTextLine(1, "line", 5.0)])
    tess_words = [
        (0, 0, 18, 10, "Office", 0, 0, 0),
        (19, 0, 30, 10, "........", 0, 0, 0),
        (31, 0, 40, 10, "424....", 0, 0, 0),
    ]

    enriched = alt_readings(uncertain, words, tess_words)

    assert enriched[0].alt == "Office 424"


def test_alt_readings_sets_only_distinct_overlapping_alternatives() -> None:
    words = [
        RapidWord(0, 0, 20, 10, "Alpha", 0.2),
        RapidWord(30, 0, 50, 10, "Same", 0.3),
        RapidWord(60, 0, 80, 10, "Missing", 0.4),
    ]
    uncertain = [pdf_ocr_rapid.UncertainToken(1, word.text, word.score, None) for word in words]
    tess_words = [
        (10, 1, 19, 9, "second", 0, 0, 0),
        (1, 1, 9, 9, "First", 0, 0, 0),
        (31, 1, 49, 9, "Same", 0, 0, 0),
        (61, 20, 79, 30, "Elsewhere", 0, 0, 0),
    ]

    enriched = alt_readings(uncertain, words, tess_words)

    assert enriched[0].alt == "First second"
    assert enriched[1].alt is None
    assert enriched[2].alt is None
    assert [token.token for token in enriched] == ["Alpha", "Same", "Missing"]
    assert all(token.alt is None for token in uncertain)


def _alt_for(primary: str, tesseract_text: str) -> str | None:
    words = [RapidWord(0, 0, 40, 10, primary, 0.4)]
    uncertain = [pdf_ocr_rapid.UncertainToken(1, primary, 0.4, None)]
    tess_words = [(0, 0, 40, 10, tesseract_text, 0, 0, 0)]
    return alt_readings(uncertain, words, tess_words)[0].alt


def test_alt_readings_drop_implausible_alternatives() -> None:
    assert _alt_for("Suite", ". " * 35) is None
    assert _alt_for("Suite", "S" + ". " * 35) is None
    assert _alt_for("12", "--/--") is None
    assert _alt_for("Total", "lllllll") is None
    assert _alt_for("Total", "-.-.-.-") is None


def test_alt_readings_keep_plausible_alternatives() -> None:
    assert _alt_for("80", "800") == "800"
    assert _alt_for("Sarasota", "Sarasata") == "Sarasata"
    assert _alt_for("1,000,00", "1,000,000") == "1,000,000"


def test_engine_params_and_load_engine_use_explicit_models_and_warning_logger(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    models_dir = tmp_path / "rapidocr" / "models"
    params = engine_params(models_dir)
    for model_kind, filename in pdf_ocr_rapid.MODEL_FILENAMES.items():
        assert params[f"{model_kind}.model_path"] == str(models_dir / filename)
    assert params["Global.log_level"] == "warning"
    assert 1 <= int(params["EngineConfig.onnxruntime.intra_op_num_threads"]) <= 4

    recorded: dict[str, Any] = {}

    def fake_constructor(*, params: dict[str, object]) -> object:
        recorded["params"] = params
        return object()

    fake_module = SimpleNamespace(
        __file__=str(tmp_path / "rapidocr" / "__init__.py"),
        RapidOCR=fake_constructor,
    )
    monkeypatch.setattr(pdf_ocr_rapid, "import_rapidocr", lambda: fake_module)
    logger = logging.getLogger("RapidOCR")
    old_level = logger.level
    logger.setLevel(logging.DEBUG)
    try:
        engine = load_engine()
        assert engine is not None
        assert logger.level == logging.WARNING
    finally:
        logger.setLevel(old_level)
    assert recorded["params"] == engine_params(models_dir)


def test_import_rapidocr_appends_external_site_dir_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_import = builtins.__import__
    fake_module = SimpleNamespace()
    attempts = 0

    def fake_import(name: str, *args: Any, **kwargs: Any) -> Any:
        nonlocal attempts
        if name == "rapidocr":
            attempts += 1
            if attempts == 1:
                raise ImportError("missing from frozen sidecar")
            return fake_module
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    monkeypatch.setenv("JENNY_PDF_OCR_SITE_DIR", str(tmp_path))
    original_path = list(sys.path)
    try:
        assert pdf_ocr_rapid.import_rapidocr() is fake_module
        assert sys.path[-1] == str(tmp_path)
        assert attempts == 2
    finally:
        sys.path[:] = original_path


def test_import_rapidocr_propagates_without_external_site_dir(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_import = builtins.__import__

    def fake_import(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "rapidocr":
            raise ImportError("unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    monkeypatch.delenv("JENNY_PDF_OCR_SITE_DIR", raising=False)
    with pytest.raises(ImportError, match="unavailable"):
        pdf_ocr_rapid.import_rapidocr()


def test_rapid_ocr_enabled_honors_kill_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR_RAPID", "0")
    assert pdf_ocr_rapid.rapid_ocr_enabled() is False


def test_recognize_page_writes_nothing(
    capsys: pytest.CaptureFixture[str],
) -> None:
    result = SimpleNamespace(
        boxes=[_polygon(0, 0, 20, 10)],
        txts=["quiet"],
        scores=[0.9],
        word_results=None,
    )

    recognize_page(_Engine(result), _Page())

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


@pytest.mark.skipif(
    importlib.util.find_spec("rapidocr") is None,
    reason="rapidocr is not installed",
)
def test_real_engine_recognizes_financial_figures_without_stdout(
    capsys: pytest.CaptureFixture[str],
) -> None:
    text = "1. Losses (current accident year $ 6,471,572) 24,066,365 21,864,486"
    source = fitz.open()
    source_page = source.new_page(width=612, height=792)
    source_page.insert_text((30, 100), text, fontsize=10, fontname="cour")
    pixmap = source_page.get_pixmap(dpi=200, colorspace=fitz.csRGB, alpha=False)
    scanned = fitz.open()
    page = scanned.new_page(width=612, height=792)
    page.insert_image(page.rect, pixmap=pixmap)
    assert page.get_text("text") == ""

    try:
        words, _dpi = recognize_page(load_engine(), page)
        lines = reconstruct_page_lines(page, words=word_tuples(words))
    finally:
        scanned.close()
        source.close()

    rendered = "\n".join(line.text for line in lines)
    assert "24,066,365" in rendered
    assert "21,864,486" in rendered
    assert capsys.readouterr().out == ""
