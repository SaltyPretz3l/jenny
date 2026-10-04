"""PDF parser containment and truncation regressions."""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import pdf_text
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from tests.sidecar.ai.tools.builtins.test_rich_files_pdf import _write_pdf


def test_pdf_parser_rejects_redirected_handle_after_validation(tmp_path, monkeypatch):
    import builtins
    import io

    from sidecar.ai.error_codes import CMP_TOOL_OUTSIDE_WORKSPACE
    module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.pdf")
    root = tmp_path / "workspace"
    root.mkdir()
    path = root / "sample.pdf"
    outside = tmp_path / "outside.pdf"
    _write_pdf(path)
    _write_pdf(outside)
    original_validate = module.validate_rich_file_source
    original_open = builtins.open
    original_io_open = io.open
    def validate_then_redirect(**kwargs):
        source = original_validate(**kwargs)
        def redirect(file, *args, **options):
            target = outside if isinstance(file, (str, Path)) and Path(file) == path else file
            return original_open(target, *args, **options)
        def redirect_io(file, *args, **options):
            target = outside if isinstance(file, (str, Path)) and Path(file) == path else file
            return original_io_open(target, *args, **options)
        monkeypatch.setattr(builtins, "open", redirect)
        monkeypatch.setattr(io, "open", redirect_io)
        return source
    monkeypatch.setattr(module, "validate_rich_file_source", validate_then_redirect)
    with pytest.raises(ToolExecutionFailure) as exc:
        module.pdf_inspect_tool({"path": "sample.pdf"}, WorkspaceGuard(str(root)))
    assert exc.value.code == CMP_TOOL_OUTSIDE_WORKSPACE


def test_pdf_parser_rechecks_byte_limit_after_validation(tmp_path, monkeypatch):
    module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.pdf")
    path = tmp_path / "sample.pdf"
    _write_pdf(path)
    limit = path.stat().st_size + 1
    original_validate = module.validate_rich_file_source
    def validate_then_grow(**kwargs):
        source = original_validate(**kwargs)
        path.write_bytes(path.read_bytes() + b"x" * limit)
        return source
    monkeypatch.setattr(module.filesystem_content, "MAX_MEDIA_FILE_BYTES", limit)
    monkeypatch.setattr(module, "validate_rich_file_source", validate_then_grow)
    with pytest.raises(ToolExecutionFailure, match="size limit"):
        module.pdf_inspect_tool({"path": "sample.pdf"}, WorkspaceGuard(str(tmp_path)))


def test_pdf_oversized_line_is_explicitly_nonrecoverable_after_serialization(tmp_path, monkeypatch):
    import json
    module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.pdf")
    _write_pdf(tmp_path / "long.pdf")
    monkeypatch.setattr(pdf_text, "page_lines", lambda *a, **k: (
        [pdf_text.PdfTextLine(1, "x" * 3_000, 0.0)], True, None,
    ))
    result = module.pdf_inspect_tool({"path": "long.pdf"}, WorkspaceGuard(str(tmp_path)))
    page = json.loads(result.output)["summary"]["pages"][0]
    assert page["text_truncated"] is True
    assert page["nonrecoverable_truncation"] is True
    assert page["lines_to"] == 0
    assert len(page["text_excerpt"]) <= 2_000
    assert "continue_cursor" not in page
    assert result.metadata["summary"]["truncated"] is True



def test_pdf_clipped_line_does_not_claim_gapless_continuation(tmp_path, monkeypatch):
    import json

    module = importlib.import_module("sidecar.ai.tools.builtins.rich_files.pdf")
    _write_pdf(tmp_path / "long.pdf")
    monkeypatch.setattr(pdf_text, "page_lines", lambda *a, **k: (
        [pdf_text.PdfTextLine(1, "x" * 3_000, 0.0), pdf_text.PdfTextLine(2, "following", 1.0)],
        True, None,
    ))
    result = module.pdf_inspect_tool({"path": "long.pdf"}, WorkspaceGuard(str(tmp_path)))
    summary = json.loads(result.output)["summary"]
    assert summary["pages"][0]["lines_to"] == 0
    assert summary["pages"][0]["incomplete_line"] == 1
    assert summary["pages"][0]["next_line"] == 2
    assert "without gaps" not in summary["continuation_hint"]
    assert "cannot be recovered" in summary["continuation_hint"]
    following = module.pdf_inspect_tool({"path": "long.pdf", "cursor": summary["cursor"]},
                                        WorkspaceGuard(str(tmp_path)))
    page = json.loads(following.output)["summary"]["pages"][0]
    assert page["text_excerpt"] == "2: following"
    assert page["lines_from"] == page["lines_to"] == 2
