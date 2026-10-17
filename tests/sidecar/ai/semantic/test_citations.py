"""Citation locators: parsing, the locator kind a file needs and range verdicts (pure)."""
from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.semantic.citations import (
    Locator,
    locator_kind_for_path,
    parse_locator,
    validate_locator,
)


def test_parse_locator_reads_every_catalog_shape():
    assert parse_locator("L10-12") == Locator("lines", 10, 12)
    assert parse_locator("L7") == Locator("lines", 7, 7)
    assert parse_locator("p2") == Locator("pages", 2, 2)
    assert parse_locator("p2-3") == Locator("pages", 2, 3)
    assert parse_locator("para3") == Locator("paragraphs", 3, 3)
    assert parse_locator(" para4-9 ") == Locator("paragraphs", 4, 9)


@pytest.mark.parametrize("text", [
    "", "line 4", "P1", "l2-3", "L-3", "p1,3", "L1-2-3", "page 2", "L" + "9" * 40, None, 7,
])
def test_garbage_is_an_invalid_locator(text):
    assert parse_locator(text) is None
    assert validate_locator(text, "notes.md", extent=None) == "invalid_locator"


def test_page_locator_on_a_markdown_file_is_a_kind_mismatch():
    # Q11 shape: the model invented p1 for AGENTS.md.
    assert validate_locator("p1", "corpus/AGENTS.md", extent=None) == "invalid_locator_kind"
    assert validate_locator("p1", "notes.md", extent=40) == "invalid_locator_kind"
    assert validate_locator("L3-4", "pdfs/mixed.pdf", extent=2) == "invalid_locator_kind"
    assert validate_locator("p1", "docs/report.docx", extent=None) == "invalid_locator_kind"


def test_locator_kind_follows_the_file_type():
    assert locator_kind_for_path("pdfs/Report.PDF") == "pages"
    assert locator_kind_for_path(Path("docs/report.docx")) == "paragraphs"
    assert locator_kind_for_path("notes.md") == "lines"
    assert locator_kind_for_path("src/app.py") == "lines"


def test_range_verdicts():
    assert validate_locator("L9999-9999", "notes.md", extent=40) == "locator_out_of_range"
    assert validate_locator("L5-3", "notes.md", extent=None) == "locator_out_of_range"
    assert validate_locator("L0-2", "notes.md", extent=None) == "locator_out_of_range"
    assert validate_locator("p3", "pdfs/mixed.pdf", extent=2) == "locator_out_of_range"
    assert validate_locator("L38-40", "notes.md", extent=40) == "ok"
    assert validate_locator("L1-2", "notes.md", extent=None) == "ok"
    assert validate_locator("para3", "docs/report.docx", extent=None) == "ok"
    assert validate_locator("p2", "pdfs/mixed.pdf", extent=2) == "ok"
