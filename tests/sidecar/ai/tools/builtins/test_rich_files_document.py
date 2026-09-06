"""Rich-file document inspect adapter tests."""

from __future__ import annotations

import importlib
import zipfile
from pathlib import Path

import pytest

from sidecar.ai.tools.workspace import WorkspaceGuard


def _document_tool():
    try:
        module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.document")
    except ModuleNotFoundError as exc:
        pytest.fail(f"document inspect adapter is not implemented: {exc}")
    return module.document_inspect_tool


def _write_docx(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "word/document.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:t>Visible opening paragraph</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden needle text</w:t></w:r></w:p>
    <w:p><w:ins><w:r><w:t>Inserted tracked text</w:t></w:r></w:ins></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Visible table text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>""",
        )
        archive.writestr(
            "word/comments.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="1"><w:p><w:r><w:t>comment secret</w:t></w:r></w:p></w:comment>
</w:comments>""",
        )
        archive.writestr(
            "word/_rels/document.xml.rels",
            """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
    Target="file:///C:/Users/Alice/secret.txt" TargetMode="External"/>
  <Relationship Id="rId2"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject"
    Target="embeddings/oleObject1.bin"/>
</Relationships>""",
        )
        archive.writestr("word/vbaProject.bin", b"macro")


def _write_move_only_docx(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "word/document.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:moveFrom><w:r><w:t>Moved revision text</w:t></w:r></w:moveFrom></w:p>
  </w:body>
</w:document>""",
        )


def _write_revision_and_style_docx(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "word/styles.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="character" w:styleId="HiddenBase">
    <w:rPr><w:vanish/></w:rPr>
  </w:style>
  <w:style w:type="character" w:styleId="HiddenDerived">
    <w:basedOn w:val="HiddenBase"/>
  </w:style>
  <w:style w:type="character" w:styleId="VisibleOverride">
    <w:basedOn w:val="HiddenBase"/>
    <w:rPr><w:vanish w:val="0"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="HiddenParagraph">
    <w:rPr><w:vanish/></w:rPr>
  </w:style>
</w:styles>""",
        )
        archive.writestr(
            "word/document.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t>Visible lead</w:t></w:r>
      <w:r><w:rPr><w:vanish/></w:rPr><w:t>direct hidden</w:t></w:r>
      <w:r><w:t>Visible tail</w:t></w:r>
    </w:p>
    <w:p><w:r><w:rPr><w:rStyle w:val="HiddenDerived"/></w:rPr><w:t>styled hidden</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:rStyle w:val="VisibleOverride"/></w:rPr><w:t>Style override visible</w:t></w:r></w:p>
    <w:p>
      <w:moveFrom><w:r><w:t>Moved old text</w:t></w:r></w:moveFrom>
      <w:ins><w:r><w:t>Inserted current text</w:t></w:r></w:ins>
    </w:p>
    <w:p><w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>Explicit visible</w:t></w:r></w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="HiddenParagraph"/></w:pPr>
      <w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>Run override visible</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t>Outer paragraph</w:t></w:r>
      <w:p><w:r><w:t>Nested paragraph</w:t></w:r></w:p>
    </w:p>
  </w:body>
</w:document>""",
        )


def test_document_inspect_summarizes_docx_without_sensitive_text(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    _write_docx(workspace_root / "sample.docx")

    result = _document_tool()({"path": "sample.docx"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["result_kind"] == "document_inspect"
    assert result.metadata["status"] == "inspected"
    summary = result.metadata["summary"]
    assert summary["paragraph_count"] == 4
    assert summary["table_count"] == 1
    assert summary["comment_count"] == 1
    assert summary["tracked_changes_present"] is True
    assert summary["hidden_text_present"] is True
    assert summary["macro_enabled"] is True
    assert summary["external_link_count"] == 1
    assert summary["embedded_object_count"] == 1
    assert "Visible opening paragraph" in result.output
    assert "Visible table text" in result.output
    assert "hidden needle text" not in result.output
    assert "comment secret" not in result.output
    assert "secret.txt" not in result.output
    assert str(workspace_root) not in result.output


def test_document_inspect_detects_move_only_tracked_changes(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    _write_move_only_docx(workspace_root / "moved.docx")

    result = _document_tool()({"path": "moved.docx"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["summary"]["tracked_changes_present"] is True


def test_document_inspect_handles_revisions_hidden_styles_and_nested_paragraphs(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    _write_revision_and_style_docx(workspace_root / "styled.docx")

    result = _document_tool()(
        {"path": "styled.docx"},
        WorkspaceGuard(str(workspace_root)),
    )

    summary = result.metadata["summary"]
    assert summary["paragraph_count"] == 8
    assert summary["tracked_changes_present"] is True
    assert summary["hidden_text_present"] is True
    assert [paragraph["text_excerpt"] for paragraph in summary["paragraphs"]] == [
        "Visible lead Visible tail",
        "Style override visible",
        "Inserted current text",
        "Explicit visible",
        "Run override visible",
        "Outer paragraph",
        "Nested paragraph",
    ]
    assert "direct hidden" not in result.output
    assert "styled hidden" not in result.output
    assert "Moved old text" not in result.output


def test_document_inspect_rejects_legacy_doc_format(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "legacy.doc").write_bytes(b"legacy binary")

    result = _document_tool()({"path": "legacy.doc"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["status"] == "unsupported"
    assert result.metadata["failure"]["reason"] == "document_format_unsupported"


def test_document_inspect_corrupt_docx_returns_unsupported(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "broken.docx").write_bytes(b"not an OOXML zip")

    result = _document_tool()({"path": "broken.docx"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["status"] == "unsupported"
    assert result.metadata["failure"]["reason"] == "document_parse_failed"
