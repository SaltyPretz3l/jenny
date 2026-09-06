"""Rich-file PDF inspect adapter tests."""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING
from sidecar.ai.tools.contracts import ToolExecutionFailure
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


def test_pdf_inspect_dependency_missing_degrades(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "sample.pdf"
    source_path.write_bytes(b"%PDF-1.4\n")
    module = importlib.import_module("sidecar.ai.tools.builtins.filesystem_content")

    def _missing_pymupdf():
        raise ModuleNotFoundError("missing PyMuPDF")

    monkeypatch.setattr(module, "_load_pymupdf", _missing_pymupdf)

    result = _pdf_tool()({"path": "sample.pdf"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["status"] == "unavailable"
    assert result.metadata["failure"]["error_code"] == CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING
    assert result.generated_artifacts == ()


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


def test_pdf_exact_page_text_cap_is_not_marked_truncated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.pdf")
    filesystem_content = importlib.import_module("sidecar.ai.tools.builtins.filesystem_content")
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "sample.pdf").write_bytes(b"%PDF-1.4\n")

    class Page:
        def get_text(self, _kind: str) -> str:
            return "x" * filesystem_content.MAX_PDF_PAGE_TEXT_CHARS

    class Document:
        page_count = 1

        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

        def load_page(self, _index: int) -> Page:
            return Page()

    class Fitz:
        @staticmethod
        def open(_path: Path) -> Document:
            return Document()

    monkeypatch.setattr(filesystem_content, "_load_pymupdf", Fitz)

    result = module.pdf_inspect_tool(
        {"path": "sample.pdf", "pages": "1"},
        WorkspaceGuard(str(workspace_root)),
    )

    page = result.metadata["summary"]["pages"][0]
    assert len(page["text_excerpt"]) == filesystem_content.MAX_PDF_PAGE_TEXT_CHARS
    assert "text_truncated" not in page


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
