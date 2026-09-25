"""Regression coverage for the PDFs used by gate B4."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.filesystem_content import read_media_file
from tests.fixtures.documents import make_fixtures

FIXTURES = Path(__file__).resolve().parents[4] / "fixtures" / "documents"


def _read_fixture(name: str, pages: str) -> dict[str, object]:
    result = read_media_file(
        FIXTURES / name,
        relative_path=name,
        pages_argument=pages,
        authorized_root=FIXTURES,
    )
    return json.loads(result.output)


@pytest.mark.skipif(
    importlib.util.find_spec("rapidocr") is None,
    reason="rapidocr is not installed",
)
def test_scanned_text_fixture_recovers_lines_with_rapidocr() -> None:
    payload = _read_fixture("scanned-text.pdf", "1-2")
    pages = payload["pages"]

    assert len(pages) == 2
    assert [page["ocr_engine"] for page in pages] == ["rapidocr", "rapidocr"]
    assert all(page["line_count"] >= 2 for page in pages)
    assert "1,250.00" in pages[0]["text_excerpt"]
    assert "3,905.12" in pages[1]["text_excerpt"]


def test_long_statement_fixture_pages_through_continuation() -> None:
    first = _read_fixture("long-statement.pdf", "1-4")

    assert first["selected_pages"] == [1, 2, 3]
    assert "Read it with pages: '4'" in first["note"]

    last = _read_fixture("long-statement.pdf", "4")
    assert any(
        "Total Schedule A" in line and "91,512.00" in line
        for line in last["pages"][0]["text_excerpt"].splitlines()
    )


def test_scanned_fixture_is_intentionally_blank() -> None:
    payload = _read_fixture("scanned.pdf", "1")
    page = payload["pages"][0]

    assert page["line_count"] == 0
    assert page["text_layer"] is False


def test_gate_fixture_generator_is_byte_stable(tmp_path: Path) -> None:
    make_fixtures.gate_pdfs(tmp_path)

    for name in ("scanned-text.pdf", "long-statement.pdf"):
        generated = hashlib.sha256((tmp_path / name).read_bytes()).digest()
        committed = hashlib.sha256((FIXTURES / name).read_bytes()).digest()
        assert generated == committed
