"""`pages` argument parsing split out of ``pdf_text``."""

from __future__ import annotations

import pytest

from sidecar.ai.tools.builtins import pdf_text
from sidecar.ai.tools.builtins.pdf_page_selection import (
    MAX_PDF_PAGES,
    parse_pages_argument,
    select_pages,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure


def test_default_selection_is_the_first_pages() -> None:
    assert select_pages(None, page_count=10) == (list(range(1, MAX_PDF_PAGES + 1)), "")
    assert select_pages(None, page_count=2) == ([1, 2], "")


def test_selection_caps_pages_and_reports_the_rest() -> None:
    assert select_pages("2,5-9", page_count=10) == ([2, 5, 6], "7-9")
    assert select_pages("4,4,1", page_count=10) == ([4, 1], "")


def test_huge_ranges_are_never_expanded() -> None:
    assert parse_pages_argument("1-100000000", page_count=100000000) == [1, 2, 3]


@pytest.mark.parametrize("argument", ["", "0", "3-1", "²", "11", "1-11", "9" * 13, ",", 5])
def test_invalid_selections_are_refused(argument: object) -> None:
    with pytest.raises(ToolExecutionFailure):
        select_pages(argument, page_count=10)


def test_pdf_text_keeps_its_selection_names() -> None:
    assert pdf_text.select_pages is select_pages
    assert pdf_text.parse_pages_argument is parse_pages_argument
    assert pdf_text.MAX_PDF_PAGES == MAX_PDF_PAGES
