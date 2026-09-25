"""Tests for layout-preserving PDF text extraction helpers."""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.builtins import pdf_ocr, pdf_text
from sidecar.ai.tools.builtins.pdf_text import (
    PdfCursor,
    PdfTextLine,
    decode_cursor,
    document_digest,
    encode_cursor,
    fit_excerpts,
    reconstruct_page_lines,
    render_lines,
    select_pages,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure

fitz = pytest.importorskip("fitz")


def _make_pdf(
    tmp_path: Path,
    name: str,
    tokens: list[tuple[float, float, str]],
) -> Path:
    path = tmp_path / name
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    for x, y, text in tokens:
        page.insert_text((x, y), text, fontsize=9, fontname="helv")
    document.save(path)
    document.close()
    return path


def _clean_extracted_token(token: str) -> str | None:
    if set(token) == {"."} and len(token) >= 2:
        return None
    cleaned = re.sub(r"\.{3,}", " ", token).strip()
    return cleaned or None


def test_table_preserves_blank_middle_cell_and_drops_dot_leader(tmp_path: Path) -> None:
    path = _make_pdf(
        tmp_path,
        "table.pdf",
        [
            (330, 100, "Assets"),
            (420, 100, "Nonadmitted"),
            (510, 100, "Net"),
            (72, 120, "1. Bonds"),
            (140, 120, "........"),
            (330, 120, "8,798,106"),
            (510, 120, "8,798,106"),
        ],
    )
    with fitz.open(path) as document:
        page = document[0]
        raw_words = page.get_text("words")
        lines = reconstruct_page_lines(page)

    header = next(line.text for line in lines if "Nonadmitted" in line.text)
    row = next(line.text for line in lines if "Bonds" in line.text)
    first_value = row.index("8,798,106")
    second_value = row.index("8,798,106", first_value + 1)
    assert first_value >= header.index("Assets") - 2
    assert abs(first_value - header.index("Assets")) <= 2
    assert second_value >= header.index("Net") - 2
    assert ".." not in row

    expected = [
        cleaned
        for word in raw_words
        if (cleaned := _clean_extracted_token(str(word[4]))) is not None
    ]
    assert Counter(word for line in lines for word in line.text.split()) == Counter(expected)


def test_wrapped_label_keeps_value_on_second_line(tmp_path: Path) -> None:
    path = _make_pdf(
        tmp_path,
        "wrapped.pdf",
        [
            (72, 140, "Deferred acquisition costs"),
            (72, 152, "and other assets"),
            (510, 152, "123,456"),
        ],
    )
    with fitz.open(path) as document:
        lines = reconstruct_page_lines(document[0])

    assert len(lines) == 2
    assert not any(character.isdigit() for character in lines[0].text)
    assert "123,456" not in lines[0].text
    assert "123,456" in lines[1].text


def test_numeric_tokens_survive_and_inner_leaders_are_cleaned(tmp_path: Path) -> None:
    path = _make_pdf(
        tmp_path,
        "numbers.pdf",
        [
            (72, 100, "(1,234.50)"),
            (145, 100, "-987.65"),
            (210, 100, "0.5%"),
            (270, 100, "....."),
            (330, 100, "$......14,380,119"),
            (72, 120, "1.5"),
            (120, 120, ".5"),
            (165, 120, "N/A."),
            (220, 120, ".."),
        ],
    )
    with fitz.open(path) as document:
        rendered = "\n".join(line.text for line in reconstruct_page_lines(document[0]))

    for token in ("(1,234.50)", "-987.65", "0.5%", "1.5", ".5", "N/A.", ".."):
        assert token in rendered
    assert "$ 14,380,119" in rendered
    assert "....." not in rendered


def test_two_column_prose_preserves_every_word_and_row(tmp_path: Path) -> None:
    input_words = [
        "LeftAlpha",
        "RightAlpha",
        "LeftBeta",
        "RightBeta",
        "LeftGamma",
        "RightGamma",
    ]
    path = _make_pdf(
        tmp_path,
        "columns.pdf",
        [
            (72, 100, input_words[0]),
            (330, 100, input_words[1]),
            (72, 115, input_words[2]),
            (330, 115, input_words[3]),
            (72, 130, input_words[4]),
            (330, 130, input_words[5]),
        ],
    )
    with fitz.open(path) as document:
        lines = reconstruct_page_lines(document[0])

    assert len(lines) == 3
    for line, left, right in zip(lines, input_words[::2], input_words[1::2], strict=True):
        assert line.text.index(left) < line.text.index(right)
        between = line.text[line.text.index(left) + len(left) : line.text.index(right)]
        assert len(between) >= 2 and not between.strip()
    assert Counter(word for line in lines for word in line.text.split()) == Counter(input_words)


class _Rect:
    x0 = 0.0


class _BandPage:
    rect = _Rect()

    @staticmethod
    def get_text(_kind: str) -> list[tuple[float, float, float, float, str, int, int, int]]:
        return [
            (72, 100, 98, 110, "Base", 0, 0, 0),
            (110, 102, 122, 106, "Sup", 0, 0, 1),
            (72, 112, 105, 122, "Lower", 0, 1, 0),
        ]


def test_line_band_tolerance_keeps_superscript_but_separates_next_row() -> None:
    lines = reconstruct_page_lines(_BandPage())
    assert len(lines) == 2
    assert "Base" in lines[0].text and "Sup" in lines[0].text
    assert lines[1].text.strip() == "Lower"
    assert lines[0].y == 100


def _numbered_lines(count: int, *, fill: str = "") -> list[PdfTextLine]:
    return [PdfTextLine(number=i, text=f"line {i}{fill}", y=float(i)) for i in range(1, count + 1)]


def test_render_lines_is_whole_gapless_and_continuable() -> None:
    lines = _numbered_lines(10)
    first_four = "\n".join(f"{line.number}: {line.text}" for line in lines[:4])
    first, next_line = render_lines(lines, max_chars=len(first_four))
    assert first == first_four
    assert next_line == 5

    remaining, final_next = render_lines(lines, start=next_line, max_chars=10**9)
    full, _ = render_lines(lines, max_chars=10**9)
    assert final_next == 0
    assert f"{first}\n{remaining}" == full

    long_line = [PdfTextLine(1, "x" * 100, 0.0)]
    assert render_lines(long_line, max_chars=1) == ("1: " + "x" * 100, 0)
    assert render_lines(lines, start=len(lines) + 1, max_chars=20) == ("", 0)
    with pytest.raises(ValueError):
        render_lines(lines, start=0, max_chars=20)


def test_fit_excerpts_trims_longest_page_first_and_remains_gapless() -> None:
    pages = [
        _numbered_lines(30, fill="A" * 30),
        _numbered_lines(30, fill="B" * 20),
        _numbered_lines(30, fill="C" * 10),
    ]

    def serialized_length(excerpts):
        return sum(len(excerpt) for excerpt in excerpts) + 50

    initial = [render_lines(page, max_chars=10**9)[0] for page in pages]
    budget = serialized_length(initial) - 1

    fitted = fit_excerpts(
        pages,
        starts=[1, 1, 1],
        page_max_chars=10**9,
        total_max_chars=budget,
        serialized_length=serialized_length,
    )

    excerpts = [excerpt for excerpt, _next in fitted]
    assert serialized_length(excerpts) <= budget
    assert all(excerpt for excerpt in excerpts)
    assert fitted[0][1] == 30
    assert fitted[1][1] == 0 and fitted[2][1] == 0
    for page, (kept, next_line) in zip(pages, fitted, strict=True):
        remaining = render_lines(page, start=next_line, max_chars=10**9)[0] if next_line else ""
        combined = kept if not remaining else f"{kept}\n{remaining}"
        assert combined == render_lines(page, max_chars=10**9)[0]


@pytest.mark.parametrize(
    "value",
    [
        None,
        123,
        "txt:0123456789abcdef:1:1",
        "pdf:0123456789abcde:1:1",
        "pdf:0123456789ABCDEf:1:1",
        "pdf:0123456789abcdef:0:1",
        "pdf:0123456789abcdef:-1:1",
        "pdf:0123456789abcdef:1:0",
        "pdf:0123456789abcdef:1:-1",
        "pdf:0123456789abcdef:1:1:extra",
    ],
)
def test_decode_cursor_rejects_invalid_values(value: object) -> None:
    with pytest.raises(ToolExecutionFailure) as caught:
        decode_cursor(value)
    assert caught.value.code == CMP_TOOL_EXECUTION_FAILED
    assert caught.value.message.startswith("tool argument 'cursor' is invalid")


def test_cursor_round_trip_and_document_digest() -> None:
    digest = "0123456789abcdef"
    encoded = encode_cursor(digest=digest, page=3, line=17)
    assert encoded == "pdf:0123456789abcdef:3:17"
    assert decode_cursor(encoded) == PdfCursor(digest=digest, page=3, line=17)
    assert document_digest(b"abc") == hashlib.sha256(b"abc").hexdigest()[:16]


class _TextPage:
    @staticmethod
    def extractText() -> str:  # noqa: N802 - PyMuPDF API name.
        return "recovered text"


class _OcrPage:
    # Letter size: pages without readable geometry fail closed before OCR renders.
    rect = SimpleNamespace(width=612.0, height=792.0)

    def __init__(self, textpage: Any) -> None:
        self.textpage = textpage
        self.calls: list[dict[str, Any]] = []

    def get_textpage_ocr(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self.textpage


def test_ocr_session_can_return_textpage_and_text(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        pdf_ocr,
        "resolve_tessdata",
        lambda **_kwargs: pdf_ocr.TessdataResolution(tmp_path, "override"),
    )
    sentinel = _TextPage()
    page = _OcrPage(sentinel)
    session = pdf_ocr.PdfOcrSession()

    assert session.recover_textpage(page, page_number=4) is sentinel
    assert session.recover_text(page, page_number=5) == "recovered text"
    assert session.used_pages == [4, 5]
    assert page.calls[0] == {
        "language": pdf_ocr.OCR_LANGUAGE,
        "dpi": pdf_ocr.OCR_RENDER_DPI,
        "full": True,
        "tessdata": str(tmp_path),
    }


@pytest.mark.parametrize(
    ("argument", "page_count", "selected", "unread"),
    [
        (None, 10, [1, 2, 3], ""),
        ("1-3", 10, [1, 2, 3], ""),
        ("2,5", 10, [2, 5], ""),
        ("1-4", 10, [1, 2, 3], "4"),
        ("1-4,9", 10, [1, 2, 3], "4,9"),
        ("1-3,2-5", 10, [1, 2, 3], "4-5"),
        ("3-7,1", 10, [3, 4, 5], "1,6-7"),
        ("1-5,4", 10, [1, 2, 3], "4-5"),
        ("4,4,4", 10, [4], ""),
        ("1-100000000", 100000000, [1, 2, 3], "4-100000000"),
    ],
)
def test_select_pages_reads_the_first_three_and_reports_the_rest(
    argument: str | None, page_count: int, selected: list[int], unread: str
) -> None:
    assert select_pages(argument, page_count=page_count) == (selected, unread)


@pytest.mark.parametrize("argument", ["0", "0-2", "2-1", "11", "1-11", "a", ","])
def test_select_pages_still_rejects_invalid_selections(argument: str) -> None:
    with pytest.raises(ToolExecutionFailure):
        select_pages(argument, page_count=10)


def test_read_note_orders_unread_ocr_and_sources_with_correct_number() -> None:
    assert pdf_text.read_note("") == pdf_text.SOURCES_NOTE
    note = pdf_text.read_note("OCR caveat.", unread_pages="4-9,12")
    assert note == (
        "Only 3 pages are read per call; pages 4-9,12 were not read. "
        "Read them with pages: '4-9,12'. OCR caveat. " + pdf_text.SOURCES_NOTE
    )
    assert "never a row number printed in the document" in pdf_text.SOURCES_NOTE
    assert "uncertain when the value contains an ocr_uncertain token" in pdf_text.SOURCES_NOTE


def test_select_pages_keeps_long_unread_lists_short_and_valid() -> None:
    every_page = ",".join(str(page) for page in range(1, 601))
    assert select_pages(every_page, page_count=600) == ([1, 2, 3], "4-600")

    # Alternating pages cannot merge; the tail collapses into one covering span
    # so the string stays valid `pages` syntax and loses no requested page.
    _selected, unread = select_pages(
        ",".join(str(page) for page in range(1, 601, 2)), page_count=600
    )
    assert len(unread) <= 220
    assert unread.endswith("-599")
    assert select_pages(unread, page_count=600)[0] == [7, 9, 11]
