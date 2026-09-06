"""Rich-file presentation inspect adapter tests."""

from __future__ import annotations

import importlib
import zipfile
from pathlib import Path

import pytest

from sidecar.ai.tools.workspace import WorkspaceGuard


def _presentation_tool():
    try:
        module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.presentation")
    except ModuleNotFoundError as exc:
        pytest.fail(f"presentation inspect adapter is not implemented: {exc}")
    return module.presentation_inspect_tool


def _write_pptx(path: Path) -> None:
    slide_template = """<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"{show_attr}>
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "ppt/slides/slide1.xml",
            slide_template.format(show_attr="", text="Visible roadmap slide"),
        )
        archive.writestr(
            "ppt/slides/slide2.xml",
            slide_template.format(show_attr=' show="false"', text="Hidden speaker strategy"),
        )
        archive.writestr(
            "ppt/notesSlides/notesSlide1.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>speaker notes secret</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>""",
        )
        archive.writestr(
            "ppt/comments/comment1.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cm><p:text>review comment secret</p:text></p:cm>
</p:cmLst>""",
        )
        archive.writestr(
            "ppt/slides/_rels/slide1.xml.rels",
            """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
    Target="https://example.invalid/private" TargetMode="External"/>
  <Relationship Id="rId2"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
    Target="../media/image1.png"/>
</Relationships>""",
        )
        archive.writestr("ppt/media/image1.png", b"png")
        archive.writestr("ppt/vbaProject.bin", b"macro")


def _write_relationship_ordered_pptx(path: Path) -> None:
    slide_template = """<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "ppt/slides/slide1.xml",
            slide_template.format(text="Filename first"),
        )
        archive.writestr(
            "ppt/slides/slide2.xml",
            slide_template.format(text="Relationship first"),
        )
        archive.writestr(
            "ppt/slides/slide3.xml",
            slide_template.format(text="Orphan slide"),
        )
        archive.writestr(
            "ppt/presentation.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
    <p:sldId id="257" r:id="rId1"/>
  </p:sldIdLst>
</p:presentation>""",
        )
        archive.writestr(
            "ppt/_rels/presentation.xml.rels",
            """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
    Target="slides/slide1.xml"/>
  <Relationship Id="rId2"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
    Target="slides/slide2.xml"/>
</Relationships>""",
        )


def test_presentation_inspect_summarizes_pptx_without_hidden_or_note_text(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    _write_pptx(workspace_root / "deck.pptx")

    result = _presentation_tool()({"path": "deck.pptx"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["result_kind"] == "presentation_inspect"
    summary = result.metadata["summary"]
    assert summary["slide_count"] == 2
    assert summary["hidden_slide_count"] == 1
    assert summary["speaker_notes_present"] is True
    assert summary["comment_count"] == 1
    assert summary["comments_present"] is True
    assert summary["macro_enabled"] is True
    assert summary["external_link_count"] == 1
    assert summary["embedded_media_count"] == 1
    assert "Visible roadmap slide" in result.output
    assert "Hidden speaker strategy" not in result.output
    assert "speaker notes secret" not in result.output
    assert "review comment secret" not in result.output
    assert "private" not in result.output
    assert str(workspace_root) not in result.output


def test_presentation_inspect_uses_relationship_order_and_ignores_orphan_parts(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    _write_relationship_ordered_pptx(workspace_root / "ordered.pptx")

    result = _presentation_tool()(
        {"path": "ordered.pptx"},
        WorkspaceGuard(str(workspace_root)),
    )

    summary = result.metadata["summary"]
    assert summary["slide_count"] == 2
    assert [slide["text_excerpt"] for slide in summary["slides"]] == [
        "Relationship first",
        "Filename first",
    ]
    assert [slide["slide"] for slide in summary["slides"]] == [1, 2]
    assert "Orphan slide" not in result.output


def test_presentation_inspect_rejects_legacy_ppt_format(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "legacy.ppt").write_bytes(b"legacy binary")

    result = _presentation_tool()({"path": "legacy.ppt"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["status"] == "unsupported"
    assert result.metadata["failure"]["reason"] == "presentation_format_unsupported"


def test_presentation_inspect_corrupt_pptx_returns_unsupported(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "broken.pptx").write_bytes(b"not an OOXML zip")

    result = _presentation_tool()({"path": "broken.pptx"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["status"] == "unsupported"
    assert result.metadata["failure"]["reason"] == "presentation_parse_failed"
