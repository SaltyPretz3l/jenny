"""PDF numbered-line reads and gapless cursor continuation."""

from __future__ import annotations

import base64
import json
import re
from dataclasses import replace
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.builtins import pdf_ocr, pdf_text
from sidecar.ai.tools.builtins.filesystem import (
    configure_filesystem_tools,
    read_file_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate
from sidecar.ai.tools.workspace import WorkspaceGuard

fitz = pytest.importorskip("fitz")


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


@pytest.fixture(autouse=True)
def _enable_pdf_reads() -> None:
    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": True}
    )


@pytest.fixture
def dense_statement(tmp_path: Path) -> Path:
    target = tmp_path / "dense-statement.pdf"
    document = fitz.open()
    for _page_number in range(1, 4):
        page = document.new_page()
        for i in range(1, 61):
            y = 55 + ((i - 1) * 11)
            page.insert_text((72, y), f"{i}. Line item {i}", fontsize=9)
            page.insert_text((200, y), "......", fontsize=9)
            page.insert_text((330, y), f"{i * 1000 + i:,}", fontsize=9)
            if i % 2:
                page.insert_text((420, y), f"{i * 2:,}", fontsize=9)
            page.insert_text((510, y), f"({i * 7 + 0.25:,.2f})", fontsize=9)
    document.save(target)
    document.close()
    return target


def _read(path: Path, tmp_path: Path, **arguments: object):
    result = read_file_tool(
        {"path": path.name, **arguments},
        _guard(tmp_path),
    )
    return result, json.loads(result.output)


def _expected_page_text(path: Path, page_number: int) -> str:
    with fitz.open(path) as document:
        lines = pdf_text.reconstruct_page_lines(document[page_number - 1])
    sanitized = [
        replace(
            line,
            text=sanitize_tool_output_no_truncate(
                line.text,
                tool_name="read_file",
            ),
        )
        for line in lines
    ]
    return pdf_text.render_lines(sanitized, max_chars=10**9)[0]


def _continue_page(
    path: Path,
    tmp_path: Path,
    first_page: dict[str, object],
) -> str:
    excerpts = [str(first_page["text_excerpt"])]
    page_payload = first_page
    while "continue_cursor" in page_payload:
        result, payload = _read(
            path,
            tmp_path,
            cursor=page_payload["continue_cursor"],
        )
        assert len(result.output) <= 12_000
        page_payload = payload["pages"][0]
        excerpts.append(page_payload["text_excerpt"])
    return "\n".join(excerpts)


def _line_numbers(text: str) -> list[int]:
    return [int(line.split(":", 1)[0]) for line in text.splitlines()]


def test_pdf_page_budget_uses_whole_numbered_lines(
    tmp_path: Path,
    dense_statement: Path,
) -> None:
    result, payload = _read(dense_statement, tmp_path, pages="1")
    page = payload["pages"][0]
    excerpt = page["text_excerpt"]

    assert len(excerpt) <= 4000
    assert all(re.match(r"^\d+: ", line) for line in excerpt.splitlines())
    assert "[truncated]" not in result.output
    assert page["text_truncated"] is True
    assert page["next_line"] == page["lines_to"] + 1
    assert page["continue_cursor"]
    assert payload["cursor"] == page["continue_cursor"]
    assert page["continue_cursor"] in payload["continuation_hint"]


def test_pdf_continuation_is_gapless(
    tmp_path: Path,
    dense_statement: Path,
) -> None:
    _result, payload = _read(dense_statement, tmp_path, pages="1")
    page = payload["pages"][0]
    combined = _continue_page(dense_statement, tmp_path, page)

    assert _line_numbers(combined) == list(range(1, page["line_count"] + 1))
    assert combined == _expected_page_text(dense_statement, 1)


def test_pdf_aggregate_budget_and_each_page_continuation(
    tmp_path: Path,
    dense_statement: Path,
) -> None:
    result, payload = _read(dense_statement, tmp_path, pages="1-3")

    assert len(result.output) <= 12_000
    assert payload["truncated"] is True
    for page_number, page in enumerate(payload["pages"], start=1):
        assert page["lines_to"] >= page["lines_from"] >= 1
        assert page["continue_cursor"]
        combined = _continue_page(dense_statement, tmp_path, page)
        assert _line_numbers(combined) == list(range(1, page["line_count"] + 1))
        assert combined == _expected_page_text(dense_statement, page_number)


def test_pdf_layout_preserves_values_and_blank_columns(
    tmp_path: Path,
    dense_statement: Path,
) -> None:
    _result, payload = _read(dense_statement, tmp_path, pages="1")
    excerpt = payload["pages"][0]["text_excerpt"]

    assert "2,002" in excerpt
    assert "(14.25)" in excerpt
    assert ".." not in excerpt
    assert re.search(r"2,002 {6,}\(14\.25\)", excerpt)


def test_pdf_cursor_is_rejected_after_file_changes(
    tmp_path: Path,
    dense_statement: Path,
) -> None:
    _result, payload = _read(dense_statement, tmp_path, pages="1")
    cursor = payload["cursor"]
    replacement = tmp_path / "replacement.pdf"
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "changed")
    document.save(replacement)
    document.close()
    replacement.replace(dense_statement)

    with pytest.raises(ToolExecutionFailure) as caught:
        _read(dense_statement, tmp_path, cursor=cursor)

    assert caught.value.code == CMP_TOOL_EXECUTION_FAILED
    assert "cursor is stale" in caught.value.message


def test_pdf_cursor_argument_rules(
    tmp_path: Path,
    dense_statement: Path,
) -> None:
    result, payload = _read(dense_statement, tmp_path, pages="1")
    cursor = payload["cursor"]
    digest = result.metadata["digest"]
    line_count = payload["pages"][0]["line_count"]

    with pytest.raises(ToolExecutionFailure, match="mutually exclusive"):
        _read(dense_statement, tmp_path, cursor=cursor, pages="1")
    with pytest.raises(ToolExecutionFailure, match="tool argument 'cursor' is invalid"):
        _read(dense_statement, tmp_path, cursor="bad")
    with pytest.raises(ToolExecutionFailure, match="references line"):
        _read(
            dense_statement,
            tmp_path,
            cursor=pdf_text.encode_cursor(
                digest=digest,
                page=1,
                line=line_count + 1,
            ),
        )
    with pytest.raises(ToolExecutionFailure, match="references page"):
        _read(
            dense_statement,
            tmp_path,
            cursor=pdf_text.encode_cursor(digest=digest, page=4, line=1),
        )

    image = tmp_path / "image.png"
    image.write_bytes(b"not decoded because cursor validation runs first")
    with pytest.raises(ToolExecutionFailure, match="only supported for PDF files"):
        _read(image, tmp_path, cursor=cursor)


def test_scanned_pdf_page_uses_ocr_textpage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "scanned.pdf"
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )
    document = fitz.open()
    scanned_page = document.new_page()
    scanned_page.insert_image(fitz.Rect(72, 72, 144, 144), stream=png)
    text_page = document.new_page()
    text_page.insert_text((72, 72), "Recovered OCR statement 12,345")
    document.save(target)
    document.close()

    source_document = fitz.open(target)
    source_page = source_document[1]
    textpage = source_page.get_textpage()

    class _BorrowedTextPage:
        def __init__(self, parent: object) -> None:
            self.parent = parent

        def extractWORDS(self, *args: object, **kwargs: object):  # noqa: N802
            return textpage.extractWORDS(*args, **kwargs)

    def _recover_textpage(page: object, *, tessdata_dir: Path) -> object:
        return _BorrowedTextPage(page)

    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR_RAPID", "0")
    monkeypatch.setattr(
        pdf_ocr,
        "resolve_tessdata",
        lambda **_kwargs: pdf_ocr.TessdataResolution(tmp_path, "override"),
    )
    monkeypatch.setattr(pdf_ocr, "ocr_page_textpage", _recover_textpage)
    try:
        _result, payload = _read(target, tmp_path, pages="1")
    finally:
        source_document.close()

    page = payload["pages"][0]
    assert page["ocr"] is True
    assert page["text_layer"] is False
    assert page["text_excerpt"].startswith("1: ")
    assert "Recovered OCR statement 12,345" in page["text_excerpt"]


def test_pdf_metadata_includes_digest_cursor_and_line_counts(
    tmp_path: Path,
    dense_statement: Path,
) -> None:
    result, payload = _read(dense_statement, tmp_path, pages="1-3")

    assert re.fullmatch(r"[0-9a-f]{16}", result.metadata["digest"])
    assert result.metadata["cursor"] == payload["cursor"]
    assert result.metadata["line_counts"] == {
        page["page_number"]: page["line_count"] for page in payload["pages"]
    }
