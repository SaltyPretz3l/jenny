"""Rich-file PDF inspect adapter tests."""

from __future__ import annotations

import importlib
import re
from dataclasses import replace
from pathlib import Path

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_PDF_ADDON_MISSING,
)
from sidecar.ai.tools.builtins import pdf_ocr, pdf_text
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate
from sidecar.ai.tools.workspace import WorkspaceGuard


def _pdf_tool():
    try:
        module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.pdf")
    except ModuleNotFoundError as exc:
        pytest.fail(f"PDF inspect adapter is not implemented: {exc}")
    return module.pdf_inspect_tool


def _write_pdf(path: Path) -> None:
    fitz = pytest.importorskip("fitz")
    document = fitz.open()
    page = document.new_page(width=160, height=90)
    page.insert_text((20, 40), "Hello rich PDF")
    document.save(path)
    document.close()


def test_pdf_inspect_returns_page_summary_and_preview_artifact(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "sample.pdf"
    _write_pdf(source_path)

    result = _pdf_tool()(
        {
            "path": "sample.pdf",
            "pages": "1",
            "create_preview": True,
            "_jenny_session_id": "session-rich",
        },
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.success is True
    assert result.generated_artifacts
    preview = result.generated_artifacts[0]
    assert preview["artifact_kind"] == "image"
    assert preview["editable"] is False
    assert preview["mime_type"] == "image/png"
    _assert_pdf_preview_artifact_has_pixels(workspace_root, preview)
    assert result.metadata["result_kind"] == "pdf_inspect"
    assert result.metadata["summary"]["page_count"] == 1
    assert result.metadata["summary"]["selected_pages"] == [1]
    assert result.metadata["previews"][0]["page"] == 1
    assert "Hello rich PDF" in result.output
    assert str(workspace_root) not in result.output


def test_pdf_inspect_skips_preview_without_session_id(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "sample.pdf"
    _write_pdf(source_path)

    result = _pdf_tool()(
        {"path": "sample.pdf", "pages": "1", "create_preview": True},
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.success is True
    assert result.generated_artifacts == ()
    assert result.metadata["previews"] == []
    assert "preview skipped" in result.metadata["warnings"][0].lower()


def test_pdf_inspect_fails_with_pdf_addon_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "sample.pdf"
    source_path.write_bytes(b"%PDF-1.4\n")
    module = importlib.import_module("sidecar.ai.tools.builtins.filesystem_content")

    real_import = module.importlib.import_module

    def _missing_fitz(name: str):
        if name == "fitz":
            raise ImportError("fitz unavailable")
        return real_import(name)

    monkeypatch.setattr(module.importlib, "import_module", _missing_fitz)

    with pytest.raises(ToolExecutionFailure) as raised:
        _pdf_tool()({"path": "sample.pdf"}, WorkspaceGuard(str(workspace_root)))

    assert raised.value.code == CMP_TOOL_PDF_ADDON_MISSING
    assert raised.value.retryable is False
    assert raised.value.message.startswith(
        "PDF reading needs the optional PDF reading add-on, which is not installed."
    )


def test_pdf_inspect_invalid_page_selection_fails_before_preview(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "sample.pdf"
    _write_pdf(source_path)

    with pytest.raises(ToolExecutionFailure, match="references page 2"):
        _pdf_tool()({"path": "sample.pdf", "pages": "2"}, WorkspaceGuard(str(workspace_root)))


def test_pdf_inspect_corrupt_pdf_returns_unsupported(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "broken.pdf").write_bytes(b"%PDF-1.4\nnot really a pdf")

    result = _pdf_tool()({"path": "broken.pdf"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["status"] == "unsupported"
    assert result.metadata["failure"]["reason"] == "pdf_parse_failed"


def test_pdf_complete_page_is_not_marked_truncated(tmp_path: Path) -> None:
    """A page whose numbered lines all fit the budget carries no continuation."""
    fitz = pytest.importorskip("fitz")
    module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.pdf")
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    for i in range(1, 6):
        page.insert_text((72, 40 + i * 14), f"{i}. Short line", fontsize=9)
    document.save(workspace_root / "sample.pdf")
    document.close()

    result = module.pdf_inspect_tool(
        {"path": "sample.pdf", "pages": "1"},
        WorkspaceGuard(str(workspace_root)),
    )

    page_payload = result.metadata["summary"]["pages"][0]
    assert page_payload["line_count"] == 5
    assert page_payload["lines_from"] == 1 and page_payload["lines_to"] == 5
    assert "text_truncated" not in page_payload
    assert "continue_cursor" not in page_payload
    assert "cursor" not in result.metadata["summary"]
    assert len(page_payload["text_excerpt"]) <= module.PDF_INSPECT_PAGE_TEXT_CHARS
    assert result.metadata["summary"]["note"] == pdf_text.SOURCES_NOTE


def test_pdf_inspect_reads_first_pages_of_an_over_limit_range(tmp_path: Path) -> None:
    fitz = pytest.importorskip("fitz")
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    document = fitz.open()
    for number in range(1, 6):
        document.new_page(width=160, height=90).insert_text((20, 40), f"Page {number}")
    document.save(workspace_root / "sample.pdf")
    document.close()

    result = _pdf_tool()(
        {"path": "sample.pdf", "pages": "1-5"}, WorkspaceGuard(str(workspace_root))
    )

    summary = result.metadata["summary"]
    assert summary["selected_pages"] == [1, 2, 3]
    assert summary["unread_pages"] == "4-5"
    assert summary["note"].startswith("Only 3 pages are read per call; pages 4-5 were not read.")
    assert summary["note"].endswith(pdf_text.SOURCES_NOTE)


def test_pdf_preview_skips_oversized_render_without_pixmap(tmp_path: Path) -> None:
    module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.pdf")

    class Rect:
        width = 100_000
        height = 100_000

    class Page:
        rect = Rect()

        def get_pixmap(self, **_kwargs: object) -> object:
            raise AssertionError("oversized preview should not render")

    context = module.PdfPreviewContext(  # noqa: SLF001
        workspace=WorkspaceGuard(str(tmp_path)),
        session_id="session-rich",
        source_path=Path("sample.pdf"),
        fitz=object(),
    )

    result = module._create_pdf_page_preview(  # noqa: SLF001
        context=context,
        page=Page(),
        page_number=1,
    )

    assert result.previews == ()
    assert "preview skipped" in result.warnings[0]


def _assert_pdf_preview_artifact_has_pixels(
    workspace_root: Path,
    preview: dict[str, object],
) -> None:
    Image = pytest.importorskip("PIL.Image")
    preview_path = workspace_root / Path(str(preview["display_path"]))
    with Image.open(preview_path) as image:
        assert image.width > 0
        assert image.height > 0
        extrema = image.convert("L").getextrema()
        assert extrema[0] < extrema[1]


def test_pdf_preview_skips_oversized_png_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.pdf")

    class Rect:
        width = 10
        height = 10

    class Pixmap:
        width = 10
        height = 10

        def tobytes(self, _format: str) -> bytes:
            return b"x" * 16

    class Page:
        rect = Rect()

        def get_pixmap(self, **_kwargs: object) -> Pixmap:
            return Pixmap()

    class Fitz:
        @staticmethod
        def Matrix(_x_scale: float, _y_scale: float) -> object:  # noqa: N802
            return object()

    monkeypatch.setattr(module.filesystem_content, "MAX_MEDIA_FILE_BYTES", 8)
    context = module.PdfPreviewContext(  # noqa: SLF001
        workspace=WorkspaceGuard(str(tmp_path)),
        session_id="session-rich",
        source_path=Path("sample.pdf"),
        fitz=Fitz(),
    )

    result = module._create_pdf_page_preview(  # noqa: SLF001
        context=context,
        page=Page(),
        page_number=1,
    )

    assert result.previews == ()
    assert "preview skipped" in result.warnings[0]


def test_pdf_inspect_page_without_text_layer_uses_ocr(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fitz = pytest.importorskip("fitz")

    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source = fitz.open()
    page = source.new_page(width=300, height=150)
    page.insert_text((30, 80), "SCANNED", fontsize=24)
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    scanned = fitz.open()
    image_page = scanned.new_page(width=300, height=150)
    image_page.insert_image(image_page.rect, pixmap=pixmap)
    scanned.save(workspace_root / "scan.pdf")
    scanned.close()

    monkeypatch.delenv("JENNY_ENABLE_PDF_OCR", raising=False)
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR_RAPID", "0")
    monkeypatch.setattr(
        pdf_ocr, "resolve_tessdata",
        lambda **_k: pdf_ocr.TessdataResolution(tmp_path, "override"),
    )
    ocr_source = fitz.open()
    ocr_page = ocr_source.new_page(width=300, height=150)
    ocr_page.insert_text((30, 80), "Premiums earned 12,345", fontsize=12)
    ocr_textpage = ocr_page.get_textpage()

    class _BorrowedTextPage:
        """PyMuPDF only accepts a textpage whose parent is the page being read."""

        def __init__(self, parent: object) -> None:
            self.parent = parent

        def extractWORDS(self, *args: object, **kwargs: object):  # noqa: N802
            return ocr_textpage.extractWORDS(*args, **kwargs)

    def _stub_ocr(page: object, *, tessdata_dir: Path) -> _BorrowedTextPage:
        return _BorrowedTextPage(page)

    monkeypatch.setattr(pdf_ocr, "ocr_page_textpage", _stub_ocr)

    result = _pdf_tool()({"path": "scan.pdf", "pages": "1"}, WorkspaceGuard(str(workspace_root)))

    summary = result.metadata["summary"]
    page_payload = summary["pages"][0]
    assert page_payload["text_layer"] is False
    assert page_payload["ocr"] is True
    assert "Premiums earned 12,345" in page_payload["text_excerpt"]
    assert "recovered with OCR" in summary["note"]
    assert summary["note"].endswith(pdf_text.SOURCES_NOTE)
    assert summary["note"].index("recovered with OCR") < summary["note"].index("Sources table")

    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR", "0")
    result = _pdf_tool()({"path": "scan.pdf", "pages": "1"}, WorkspaceGuard(str(workspace_root)))
    page_payload = result.metadata["summary"]["pages"][0]
    assert page_payload["text_layer"] is False
    assert "ocr" not in page_payload
    assert "JENNY_ENABLE_PDF_OCR=0" in page_payload["ocr_unavailable"]


def _write_dense_pdf(path: Path) -> None:
    fitz = pytest.importorskip("fitz")
    document = fitz.open()
    for _page_number in range(3):
        page = document.new_page(width=612, height=792)
        for i in range(1, 61):
            y = 42 + (i - 1) * 12
            page.insert_text((72, y), f"{i}. Line item {i}", fontsize=9)
            page.insert_text((200, y), "......", fontsize=9)
            page.insert_text((330, y), f"{i * 1000 + i:,}", fontsize=9)
            if i % 2:
                page.insert_text((420, y), f"{i * 10:,}", fontsize=9)
            page.insert_text((510, y), f"({i * 7 + 0.25:,.2f})", fontsize=9)
    document.save(path)
    document.close()


def _follow_page_cursors(
    *,
    workspace_root: Path,
    path: str,
    first_page: dict[str, object],
) -> tuple[list[int], str]:
    page_payload = first_page
    numbered_lines: list[str] = []
    seen_cursors: set[str] = set()
    while True:
        excerpt = str(page_payload["text_excerpt"])
        if excerpt:
            numbered_lines.extend(excerpt.splitlines())
        cursor = page_payload.get("continue_cursor")
        if not isinstance(cursor, str):
            break
        assert cursor not in seen_cursors
        seen_cursors.add(cursor)
        result = _pdf_tool()(
            {"path": path, "cursor": cursor},
            WorkspaceGuard(str(workspace_root)),
        )
        page_payload = result.metadata["summary"]["pages"][0]
    numbers = [int(line.split(":", 1)[0]) for line in numbered_lines]
    return numbers, "\n".join(numbered_lines)


def _expected_numbered_pages(path: Path) -> list[str]:
    fitz = pytest.importorskip("fitz")

    expected: list[str] = []
    with fitz.open(path) as document:
        for page in document:
            lines = [
                replace(
                    line,
                    text=sanitize_tool_output_no_truncate(
                        line.text, tool_name="pdf_inspect"
                    ),
                )
                for line in pdf_text.reconstruct_page_lines(page)
            ]
            expected.append(pdf_text.render_lines(lines, max_chars=10**9)[0])
    return expected


def test_pdf_inspect_page_budget_keeps_whole_numbered_lines(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    _write_dense_pdf(workspace_root / "dense.pdf")

    result = _pdf_tool()(
        {"path": "dense.pdf", "pages": "1"},
        WorkspaceGuard(str(workspace_root)),
    )

    summary = result.metadata["summary"]
    page = summary["pages"][0]
    assert len(page["text_excerpt"]) <= 2_000
    assert all(re.match(r"^[1-9][0-9]*: ", line) for line in page["text_excerpt"].splitlines())
    assert "[truncated]" not in result.output
    assert page["text_truncated"] is True
    assert page["next_line"] == page["lines_to"] + 1
    assert page["continue_cursor"]
    assert summary["cursor"] == page["continue_cursor"]
    assert "without gaps" in summary["continuation_hint"]


def test_pdf_inspect_cursor_continuation_is_gapless(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "dense.pdf"
    _write_dense_pdf(source_path)

    result = _pdf_tool()(
        {"path": "dense.pdf", "pages": "1"},
        WorkspaceGuard(str(workspace_root)),
    )
    first_page = result.metadata["summary"]["pages"][0]
    numbers, joined = _follow_page_cursors(
        workspace_root=workspace_root,
        path="dense.pdf",
        first_page=first_page,
    )

    assert numbers == list(range(1, first_page["line_count"] + 1))
    assert joined == _expected_numbered_pages(source_path)[0]


def test_pdf_inspect_aggregate_budget_and_each_page_cursor_is_gapless(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "dense.pdf"
    _write_dense_pdf(source_path)

    result = _pdf_tool()(
        {"path": "dense.pdf", "pages": "1-3"},
        WorkspaceGuard(str(workspace_root)),
    )

    summary = result.metadata["summary"]
    assert len(result.output) <= 12_000
    assert summary["truncated"] is True
    expected_pages = _expected_numbered_pages(source_path)
    for page_payload, expected in zip(summary["pages"], expected_pages, strict=True):
        assert page_payload["lines_to"] >= page_payload["lines_from"] >= 1
        assert page_payload["continue_cursor"]
        numbers, joined = _follow_page_cursors(
            workspace_root=workspace_root,
            path="dense.pdf",
            first_page=page_payload,
        )
        assert numbers == list(range(1, page_payload["line_count"] + 1))
        assert joined == expected


def test_pdf_inspect_preserves_values_and_blank_columns(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "dense.pdf"
    _write_dense_pdf(source_path)
    expected = _expected_numbered_pages(source_path)[0]

    assert "(14.25)" in expected
    assert "2,002" in expected
    assert ".." not in expected
    even_row = next(line for line in expected.splitlines() if "2. Line item 2" in line)
    assert re.search(r"2,002 {6,}\(14\.25\)", even_row)


def test_pdf_inspect_rejects_stale_conflicting_and_malformed_cursors(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "dense.pdf"
    _write_dense_pdf(source_path)
    guard = WorkspaceGuard(str(workspace_root))
    result = _pdf_tool()({"path": "dense.pdf", "pages": "1"}, guard)
    cursor = result.metadata["summary"]["pages"][0]["continue_cursor"]

    _write_pdf(source_path)
    with pytest.raises(ToolExecutionFailure, match="cursor is stale") as stale:
        _pdf_tool()({"path": "dense.pdf", "cursor": cursor}, guard)
    assert stale.value.code == CMP_TOOL_EXECUTION_FAILED

    with pytest.raises(ToolExecutionFailure, match="mutually exclusive"):
        _pdf_tool()({"path": "dense.pdf", "cursor": cursor, "pages": "1"}, guard)

    with pytest.raises(ToolExecutionFailure, match="tool argument 'cursor' is invalid"):
        _pdf_tool()({"path": "dense.pdf", "cursor": "not-a-cursor"}, guard)


def test_pdf_inspect_scanned_page_uses_ocr_textpage_lines(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fitz = pytest.importorskip("fitz")
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    text_document = fitz.open()
    text_page = text_document.new_page(width=300, height=150)
    text_page.insert_text((30, 80), "Recovered positioned text", fontsize=16)
    textpage = text_page.get_textpage()
    pixmap = text_page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    scanned = fitz.open()
    image_page = scanned.new_page(width=300, height=150)
    image_page.insert_image(image_page.rect, pixmap=pixmap)
    scanned.save(workspace_root / "scan-lines.pdf")
    scanned.close()

    class _BorrowedTextPage:
        def __init__(self, parent: object) -> None:
            self.parent = parent

        def extractWORDS(self, *args: object, **kwargs: object):  # noqa: N802
            return textpage.extractWORDS(*args, **kwargs)

    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR_RAPID", "0")
    monkeypatch.setattr(
        pdf_ocr,
        "resolve_tessdata",
        lambda **_kwargs: pdf_ocr.TessdataResolution(tmp_path, "override"),
    )
    monkeypatch.setattr(
        pdf_ocr,
        "ocr_page_textpage",
        lambda page, *, tessdata_dir: _BorrowedTextPage(page),
    )
    try:
        result = _pdf_tool()(
            {"path": "scan-lines.pdf", "pages": "1"},
            WorkspaceGuard(str(workspace_root)),
        )
    finally:
        text_document.close()

    page_payload = result.metadata["summary"]["pages"][0]
    assert page_payload["ocr"] is True
    assert page_payload["text_layer"] is False
    assert page_payload["text_excerpt"].startswith("1: ")
    assert page_payload["text_excerpt"].split()[-3:] == [
        "Recovered",
        "positioned",
        "text",
    ]
