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

    assert result.success is False
    assert result.metadata["status"] == "unsupported"
    assert result.metadata["failure"]["reason"] == "document_format_unsupported"


def test_document_inspect_corrupt_docx_returns_unsupported(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "broken.docx").write_bytes(b"not an OOXML zip")

    result = _document_tool()({"path": "broken.docx"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is False
    assert result.metadata["status"] == "unsupported"
    assert result.metadata["failure"]["reason"] == "document_parse_failed"


def test_document_parses_the_validated_bytes_without_reopening(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import hashlib

    module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.document")
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    path = workspace_root / "sample.docx"
    _write_docx(path)
    validated = hashlib.sha256(path.read_bytes()).hexdigest()
    original_validate = module.validate_rich_file_source

    def validate_then_swap(**kwargs):
        source = original_validate(**kwargs)
        # A swap or growth after validation never reaches the parser: it reads
        # the bytes validation hashed, not the file again.
        path.write_bytes(b"swapped after validation" * 4096)
        return source

    monkeypatch.setattr(module, "validate_rich_file_source", validate_then_swap)
    result = module.document_inspect_tool({"path": "sample.docx"}, WorkspaceGuard(str(workspace_root)))

    assert result.success is True
    assert result.metadata["source"]["sha256"] == validated
    assert "Visible opening paragraph" in result.output


def _write_long_docx(path: Path, *, paragraphs: int, chars: int) -> list[str]:
    texts = [f"Paragraph {number:02d} " + "x" * chars for number in range(1, paragraphs + 1)]
    body = "".join(f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>" for text in texts)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body>{body}</w:body></w:document>",
        )
    return texts


def test_document_continue_cursor_reads_every_paragraph_once_in_order(tmp_path: Path) -> None:
    # The 2026-10-20 memo had 64 paragraphs; the reader stopped at 20 with no way on.
    texts = _write_long_docx(tmp_path / "memo.docx", paragraphs=64, chars=300)
    guard = WorkspaceGuard(str(tmp_path))
    seen: list[str] = []
    arguments: dict[str, object] = {"path": "memo.docx"}
    reads = 0
    while True:
        result = _document_tool()(arguments, guard)
        reads += 1
        assert result.success is True
        assert len(result.output) <= 12_000
        summary = result.metadata["summary"]
        assert summary["paragraphs"], "every slice makes progress"
        seen.extend(paragraph["text_excerpt"] for paragraph in summary["paragraphs"])
        cursor = summary.get("continue_cursor")
        if cursor is None:
            assert "continuation_hint" not in summary
            break
        assert f"cursor={cursor}" in summary["continuation_hint"]
        arguments = {"path": "memo.docx", "cursor": cursor}
        assert reads < 10

    assert seen == texts
    assert reads > 1


def test_document_long_paragraph_keeps_more_than_the_old_400_char_excerpt(
    tmp_path: Path,
) -> None:
    _write_long_docx(tmp_path / "memo.docx", paragraphs=1, chars=1_200)

    result = _document_tool()({"path": "memo.docx"}, WorkspaceGuard(str(tmp_path)))

    paragraph = result.metadata["summary"]["paragraphs"][0]
    assert paragraph["text_truncated"] is False
    assert len(paragraph["text_excerpt"]) > 1_200
    assert "continue_cursor" not in result.metadata["summary"]


def test_document_cursor_is_refused_after_the_file_changes(tmp_path: Path) -> None:
    from sidecar.ai.tools.contracts import ToolExecutionFailure

    target = tmp_path / "memo.docx"
    _write_long_docx(target, paragraphs=64, chars=300)
    guard = WorkspaceGuard(str(tmp_path))
    first = _document_tool()({"path": "memo.docx"}, guard)
    cursor = first.metadata["summary"]["continue_cursor"]
    _write_long_docx(target, paragraphs=65, chars=300)

    with pytest.raises(ToolExecutionFailure, match="stale"):
        _document_tool()({"path": "memo.docx", "cursor": cursor}, guard)
    with pytest.raises(ToolExecutionFailure, match="invalid for a Word document"):
        _document_tool()({"path": "memo.docx", "cursor": "pdf:0123456789abcdef:2:17"}, guard)


_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _write_body_and_table_docx(path: Path) -> None:
    """Raw order: P1 body1, P2 body2, P3-P4 table cells, P5 body3, P6 body4."""

    def paragraph(text: str) -> str:
        return f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"

    table = (
        "<w:tbl><w:tr>"
        f"<w:tc>{paragraph('Cell A')}</w:tc><w:tc>{paragraph('Cell B')}</w:tc>"
        "</w:tr></w:tbl>"
    )
    body = (
        paragraph("Body one")
        + paragraph("Body two")
        + table
        + paragraph("Body three")
        + paragraph("Body four")
    )
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<w:document xmlns:w="{_W_NS}"><w:body>{body}</w:body></w:document>',
        )


def test_document_pages_selects_paragraphs_by_printed_index(tmp_path: Path) -> None:
    _write_body_and_table_docx(tmp_path / "mix.docx")
    guard = WorkspaceGuard(str(tmp_path))

    ranged = _document_tool()({"path": "mix.docx", "pages": "3-5"}, guard)
    single = _document_tool()({"path": "mix.docx", "pages": "6"}, guard)

    summary = ranged.metadata["summary"]
    assert [p["index"] for p in summary["paragraphs"]] == [3, 4, 5]
    assert [p["text_excerpt"] for p in summary["paragraphs"]] == [
        "Cell A",
        "Cell B",
        "Body three",
    ]
    assert "continue_cursor" not in summary
    assert [p["index"] for p in single.metadata["summary"]["paragraphs"]] == [6]


def test_document_prints_body_index_only_for_top_level_paragraphs(tmp_path: Path) -> None:
    _write_body_and_table_docx(tmp_path / "mix.docx")

    result = _document_tool()({"path": "mix.docx"}, WorkspaceGuard(str(tmp_path)))

    paragraphs = result.metadata["summary"]["paragraphs"]
    assert [(p["index"], p.get("body_index")) for p in paragraphs] == [
        (1, 1),
        (2, 2),
        (3, None),
        (4, None),
        (5, 3),
        (6, 4),
    ]


def test_document_pages_range_is_capped_and_continues_with_a_cursor(tmp_path: Path) -> None:
    module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.document")
    _write_long_docx(tmp_path / "long.docx", paragraphs=150, chars=5)
    guard = WorkspaceGuard(str(tmp_path))

    capped = _document_tool()({"path": "long.docx", "pages": "11-150"}, guard)
    inside = _document_tool()({"path": "long.docx", "pages": "11-60"}, guard)

    summary = capped.metadata["summary"]
    indexes = [p["index"] for p in summary["paragraphs"]]
    assert indexes == list(range(11, 11 + module.MAX_PARAGRAPHS))
    assert summary["continue_cursor"].endswith(f":{11 + module.MAX_PARAGRAPHS}")
    assert [p["index"] for p in inside.metadata["summary"]["paragraphs"]] == list(range(11, 61))
    assert "continue_cursor" not in inside.metadata["summary"]


def test_document_omitted_count_starts_at_the_slice_not_the_document(tmp_path: Path) -> None:
    _write_long_docx(tmp_path / "memo.docx", paragraphs=64, chars=300)
    guard = WorkspaceGuard(str(tmp_path))
    first = _document_tool()({"path": "memo.docx"}, guard).metadata["summary"]
    second = _document_tool()(
        {"path": "memo.docx", "cursor": first["continue_cursor"]}, guard
    ).metadata["summary"]

    shown_before = len(first["paragraphs"])
    assert first["omitted_paragraph_count"] == 64 - shown_before
    assert second["omitted_paragraph_count"] == 64 - shown_before - len(second["paragraphs"])


@pytest.mark.parametrize(
    "pages",
    ["5-3", "0", "abc", "1-x", "1,3", "", "-4", "7", "7-9", "1" * 30],
)
def test_document_pages_rejects_invalid_ranges(tmp_path: Path, pages: str) -> None:
    from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
    from sidecar.ai.tools.contracts import ToolExecutionFailure

    _write_body_and_table_docx(tmp_path / "mix.docx")

    with pytest.raises(ToolExecutionFailure) as failure:
        _document_tool()({"path": "mix.docx", "pages": pages}, WorkspaceGuard(str(tmp_path)))

    assert failure.value.code == CMP_TOOL_EXECUTION_FAILED
    assert "'pages'" in failure.value.message


def test_document_pages_clamps_an_end_past_the_last_paragraph(tmp_path: Path) -> None:
    _write_body_and_table_docx(tmp_path / "mix.docx")

    result = _document_tool()(
        {"path": "mix.docx", "pages": "5-99"}, WorkspaceGuard(str(tmp_path))
    )

    assert [p["index"] for p in result.metadata["summary"]["paragraphs"]] == [5, 6]


def test_document_pages_and_cursor_are_mutually_exclusive(tmp_path: Path) -> None:
    from sidecar.ai.tools.contracts import ToolExecutionFailure

    _write_long_docx(tmp_path / "memo.docx", paragraphs=64, chars=300)
    guard = WorkspaceGuard(str(tmp_path))
    cursor = _document_tool()({"path": "memo.docx"}, guard).metadata["summary"]["continue_cursor"]

    with pytest.raises(ToolExecutionFailure, match="mutually exclusive"):
        _document_tool()({"path": "memo.docx", "pages": "1-3", "cursor": cursor}, guard)
