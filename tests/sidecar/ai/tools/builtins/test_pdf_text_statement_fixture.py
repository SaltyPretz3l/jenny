"""Validation of PDF line reconstruction against a real statutory statement.

The fixture is an owner-held quarterly statement (not in the repo). Point
``JENNY_PDF_STATEMENT_FIXTURE`` at it to run; the tests skip otherwise.

Figures below were checked by eye against the rendered page images
(Assets = PDF page 4, Liabilities = PDF page 5). Column association in
this file is a TEST-ONLY helper (nearest header centre); the generic reader
never infers columns. Arithmetic checks report mismatches — the reader is
never allowed to repair a figure, so a known source rounding difference is
asserted as a mismatch, not hidden.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import pdf_text

FIXTURE_ENV = "JENNY_PDF_STATEMENT_FIXTURE"
ASSETS_PAGE = 4
LIABILITIES_PAGE = 5

_NUMBER = re.compile(r"\(?-?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?|\(?-?\d+\.\d+\)?|\(?-?\d{4,}\)?")


@dataclass(frozen=True)
class Cell:
    text: str
    start: int
    end: int

    @property
    def centre(self) -> float:
        return (self.start + self.end) / 2

    @property
    def value(self) -> int:
        raw = self.text.strip()
        negative = raw.startswith("(") and raw.endswith(")")
        digits = raw.strip("()").replace(",", "")
        number = int(round(float(digits)))
        return -number if negative else number


def _fixture_path() -> Path:
    raw = os.environ.get(FIXTURE_ENV, "").strip()
    if not raw or not Path(raw).is_file():
        pytest.skip(f"{FIXTURE_ENV} not set to an existing statement PDF")
    return Path(raw)


def _page_lines(page_number: int) -> list[pdf_text.PdfTextLine]:
    fitz = pytest.importorskip("fitz")
    with fitz.open(_fixture_path()) as document:
        return pdf_text.reconstruct_page_lines(document.load_page(page_number - 1))


def _find_line(lines: list[pdf_text.PdfTextLine], pattern: str) -> pdf_text.PdfTextLine:
    # Patterns are written with single spaces; layout text carries alignment padding.
    matches = [line for line in lines if re.search(pattern, re.sub(r"\s+", " ", line.text))]
    assert len(matches) == 1, (
        f"{pattern!r} matched {len(matches)} lines: {[m.text for m in matches]}"
    )
    return matches[0]


def _header_centres(
    lines: list[pdf_text.PdfTextLine], labels: list[tuple[str, str]]
) -> list[float]:
    """Centre column of each header label, looked up on the line matching ``anchor``."""

    centres: list[float] = []
    for label, anchor in labels:
        line = _find_line(lines, anchor)
        start = line.text.index(label)
        centres.append((2 * start + len(label)) / 2)
    return centres


def _value_cells(line: pdf_text.PdfTextLine, *, values_start: int) -> list[Cell]:
    return [
        Cell(m.group(0), m.start(), m.end())
        for m in _NUMBER.finditer(line.text)
        if m.start() >= values_start
    ]


def _columns(
    line: pdf_text.PdfTextLine, centres: list[float], *, values_start: int
) -> dict[int, int]:
    """Map header column index (1-based) -> value, by nearest header centre."""

    assigned: dict[int, int] = {}
    for cell in _value_cells(line, values_start=values_start):
        column = min(range(len(centres)), key=lambda i: abs(centres[i] - cell.centre)) + 1
        assert column not in assigned, f"two values landed in column {column}: {line.text!r}"
        assigned[column] = cell.value
    return assigned


def _assets_columns(lines: list[pdf_text.PdfTextLine]) -> tuple[list[float], int]:
    centres = _header_centres(
        lines,
        [
            ("Assets", r"\(Cols\. 1 - 2\)"),
            ("Nonadmitted", r"Nonadmitted"),
            ("(Cols. 1 - 2)", r"\(Cols\. 1 - 2\)"),
            ("Admitted Assets", r"\(Cols\. 1 - 2\)"),
        ],
    )
    header = _find_line(lines, r"\(Cols\. 1 - 2\)")
    values_start = header.text.index("Assets") - 12
    return centres, values_start


def _liabilities_columns(lines: list[pdf_text.PdfTextLine]) -> tuple[list[float], int]:
    centres = _header_centres(
        lines, [("Statement Date", r"Statement Date"), ("Prior Year", r"Statement Date")]
    )
    header = _find_line(lines, "Statement Date")
    values_start = header.text.index("Statement Date") - 12
    return centres, values_start


# --- manually checked figures -------------------------------------------------

ASSETS_ROWS: dict[str, dict[int, int]] = {
    r"^\s*1\.?\s+Bonds": {1: 8_798_106, 3: 8_798_106, 4: 12_660_974},
    r"2\.1\s+Preferred stocks": {1: 188_352, 3: 188_352, 4: 186_553},
    r"2\.2\s+Common\s+stocks": {1: 14_153_366, 3: 14_153_366, 4: 4_960_306},
    r"investments \(\$ 0\)": {1: 21_407_782, 3: 21_407_782, 4: 23_263_739},
    r"^\s*8\.?\s+Other invested assets": {1: 56_485, 3: 56_485, 4: 1_125_800},
    r"^\s*12\.?\s+Subtotals": {1: 44_604_091, 3: 44_604_091, 4: 42_197_373},
    r"^\s*14\.?\s+Investment income": {1: 72_498, 3: 72_498, 4: 138_227},
    r"15\.1\s+Uncollected premiums": {1: 1_284_231, 3: 1_284_231, 4: 1_021_452},
    r"16\.2\s+Funds\s+held by or deposited": {1: 2_132_725, 3: 2_132_725},
    r"18\.2\s+Net deferred tax asset": {4: 161_161},
    r"^\s*23\.?\s+Receivables from parent": {1: 5_161, 3: 5_161},
    r"^\s*25\.?\s+Aggregate write-ins for other": {1: 6_830_844, 3: 6_830_844, 4: 7_137_873},
    r"Protected Cell Accounts \(Lines 12 to 25\)": {1: 54_929_550, 3: 54_929_550, 4: 50_656_086},
    r"^\s*28\.?\s+Total \(Lines 26 and 27\)": {1: 54_929_550, 3: 54_929_550, 4: 50_656_086},
    r"2501\.\s+Deferred Policy Acquisition": {1: 2_089_138, 3: 2_089_138, 4: 2_362_768},
    r"2502\.\s+Prepaid": {1: 241_706, 3: 241_706, 4: 275_105},
    r"2503\.\s+Letter of Credit": {1: 4_500_000, 3: 4_500_000, 4: 4_500_000},
    r"2599\.\s+Totals": {1: 6_830_844, 3: 6_830_844, 4: 7_137_873},
}

LIABILITIES_ROWS: dict[str, dict[int, int]] = {
    r"^\s*1\.?\s+Losses \(current accident year": {1: 24_066_365, 2: 21_864_486},
    r"^\s*3\.?\s+Loss adjustment expenses": {1: 7_146_659, 2: 6_692_496},
    r"^\s*5\.?\s+Other expenses": {1: 504_234, 2: 465_525},
    r"^\s*6\.?\s+Taxes, licenses and fees": {1: 173_693, 2: 409_719},
    r"loss ratio rebate per the Public Health Service Act\)": {1: 10_554_822, 2: 11_504_420},
    r"^\s*10\.?\s+Advance premium": {1: 15_906, 2: 15_906},
    r"^\s*12\.?\s+Ceded reinsurance premiums payable": {1: 3_321_626, 2: 1_249_379},
    r"^\s*26\.?\s+Total liabilities excluding": {1: 45_783_305, 2: 42_201_931},
    r"^\s*28\.?\s+Total liabilities \(Lines 26 and 27\)": {1: 45_783_305, 2: 42_201_931},
    r"^\s*30\.?\s+Common capital stock": {1: 2_049_700, 2: 1_861_200},
    r"^\s*34\.?\s+Gross paid in": {1: 12_552_058, 2: 11_798_058},
    r"^\s*35\.?\s+Unassigned funds": {1: -5_455_513, 2: -5_205_103},
    r"^\s*37\.?\s+Surplus as regards policyholders": {1: 9_146_245, 2: 8_454_155},
    r"^\s*38\.?\s+Totals \(Page 2, Line 28, Col\. 3\)": {1: 54_929_550, 2: 50_656_086},
}


def test_assets_page_values_land_in_the_right_columns() -> None:
    lines = _page_lines(ASSETS_PAGE)
    centres, values_start = _assets_columns(lines)
    for pattern, expected in ASSETS_ROWS.items():
        line = _find_line(lines, pattern)
        assert _columns(line, centres, values_start=values_start) == expected, line.text


def test_liabilities_page_values_land_in_the_right_columns() -> None:
    lines = _page_lines(LIABILITIES_PAGE)
    centres, values_start = _liabilities_columns(lines)
    for pattern, expected in LIABILITIES_ROWS.items():
        line = _find_line(lines, pattern)
        assert _columns(line, centres, values_start=values_start) == expected, line.text


def test_parenthesized_negatives_and_inner_leaders_survive() -> None:
    lines = _page_lines(LIABILITIES_PAGE)
    unassigned = _find_line(lines, r"^\s*35\.?\s+Unassigned funds")
    assert "(5,455,513)" in unassigned.text and "(5,205,103)" in unassigned.text
    losses = _find_line(lines, r"^\s*1\.?\s+Losses \(current accident year")
    assert "$ 6,471,572)" in losses.text
    assert ".." not in losses.text
    assets = _page_lines(ASSETS_PAGE)
    cash = _find_line(assets, r"^\s*5\.?\s+Cash \(\$")
    assert "($ 14,380,119)" in cash.text and "($ 7,027,663)" in cash.text


def test_wrapped_labels_keep_values_on_the_last_line() -> None:
    lines = _page_lines(ASSETS_PAGE)
    first = _find_line(lines, r"^\s*5\.?\s+Cash \(\$")
    second = _find_line(lines, r"investments \(\$ 0\)")
    assert second.number == first.number + 1
    _, values_start = _assets_columns(lines)
    assert _value_cells(first, values_start=values_start) == []
    assert len(_value_cells(second, values_start=values_start)) == 3


def test_numbered_lines_carry_source_positions() -> None:
    lines = _page_lines(ASSETS_PAGE)
    assert [line.number for line in lines] == list(range(1, len(lines) + 1))
    assert all(lines[i].y <= lines[i + 1].y for i in range(len(lines) - 1))
    assert (
        re.sub(r"\s+", " ", lines[0].text).strip().startswith("Quarterly Statement as of September")
    )


# --- arithmetic reconciliation (validation only; mismatches are REPORTED) -------


def _sum_rows(
    lines: list[pdf_text.PdfTextLine],
    patterns: list[str],
    column: int,
    *,
    centres: list[float],
    values_start: int,
) -> int:
    total = 0
    for pattern in patterns:
        total += _columns(_find_line(lines, pattern), centres, values_start=values_start).get(
            column, 0
        )
    return total


def test_assets_reconcile_and_the_one_source_rounding_difference_is_reported() -> None:
    lines = _page_lines(ASSETS_PAGE)
    centres, values_start = _assets_columns(lines)
    invested = [
        r"^\s*1\.?\s+Bonds",
        r"2\.1\s+Preferred stocks",
        r"2\.2\s+Common\s+stocks",
        r"investments \(\$ 0\)",
        r"^\s*8\.?\s+Other invested assets",
    ]
    subtotal = _columns(
        _find_line(lines, r"^\s*12\.?\s+Subtotals"), centres, values_start=values_start
    )
    mismatches: dict[str, int] = {}
    for column in (1, 3, 4):
        computed = _sum_rows(lines, invested, column, centres=centres, values_start=values_start)
        if computed != subtotal[column]:
            mismatches[f"line 12 col {column}"] = subtotal[column] - computed
    # The filed statement's prior-year subtotal is 1 higher than its components
    # (rounding in the source). The reader must surface it, never absorb it.
    assert mismatches == {"line 12 col 4": 1}

    total_rows = [
        r"^\s*12\.?\s+Subtotals",
        r"^\s*14\.?\s+Investment income",
        r"15\.1\s+Uncollected premiums",
        r"16\.2\s+Funds\s+held by or deposited",
        r"18\.2\s+Net deferred tax asset",
        r"^\s*23\.?\s+Receivables from parent",
        r"^\s*25\.?\s+Aggregate write-ins for other",
    ]
    total = _columns(
        _find_line(lines, r"Protected Cell Accounts \(Lines 12 to 25\)"),
        centres,
        values_start=values_start,
    )
    for column in (1, 3, 4):
        assert (
            _sum_rows(lines, total_rows, column, centres=centres, values_start=values_start)
            == total[column]
        )

    write_ins = [
        r"2501\.\s+Deferred Policy Acquisition",
        r"2502\.\s+Prepaid",
        r"2503\.\s+Letter of Credit",
    ]
    totals = _columns(_find_line(lines, r"2599\.\s+Totals"), centres, values_start=values_start)
    for column in (1, 3, 4):
        assert (
            _sum_rows(lines, write_ins, column, centres=centres, values_start=values_start)
            == totals[column]
        )


def test_liabilities_and_surplus_reconcile_across_pages() -> None:
    lines = _page_lines(LIABILITIES_PAGE)
    centres, values_start = _liabilities_columns(lines)
    liabilities = [
        r"^\s*1\.?\s+Losses \(current accident year",
        r"^\s*3\.?\s+Loss adjustment expenses",
        r"^\s*5\.?\s+Other expenses",
        r"^\s*6\.?\s+Taxes, licenses and fees",
        r"loss ratio rebate per the Public Health Service Act\)",
        r"^\s*10\.?\s+Advance premium",
        r"^\s*12\.?\s+Ceded reinsurance premiums payable",
    ]
    line_26 = _columns(
        _find_line(lines, r"^\s*26\.?\s+Total liabilities excluding"),
        centres,
        values_start=values_start,
    )
    surplus_parts = [
        r"^\s*30\.?\s+Common capital stock",
        r"^\s*34\.?\s+Gross paid in",
        r"^\s*35\.?\s+Unassigned funds",
    ]
    line_37 = _columns(
        _find_line(lines, r"^\s*37\.?\s+Surplus as regards policyholders"),
        centres,
        values_start=values_start,
    )
    line_38 = _columns(
        _find_line(lines, r"^\s*38\.?\s+Totals \(Page 2"), centres, values_start=values_start
    )
    for column in (1, 2):
        assert (
            _sum_rows(lines, liabilities, column, centres=centres, values_start=values_start)
            == line_26[column]
        )
        assert (
            _sum_rows(lines, surplus_parts, column, centres=centres, values_start=values_start)
            == line_37[column]
        )
        assert line_26[column] + line_37[column] == line_38[column]

    assets = _page_lines(ASSETS_PAGE)
    asset_centres, asset_start = _assets_columns(assets)
    asset_total = _columns(
        _find_line(assets, r"^\s*28\.?\s+Total \(Lines 26 and 27\)"),
        asset_centres,
        values_start=asset_start,
    )
    assert line_38[1] == asset_total[3]
    assert line_38[2] == asset_total[4]
