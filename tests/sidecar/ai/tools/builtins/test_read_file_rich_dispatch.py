"""W7a-S3: read_file dispatches rich-file suffixes to the inspect adapters.

The six *_inspect tools retire from the model surface; read_file gains
suffix dispatch gated by tools_rich_files_enabled. These tests pin the
fold contract red-first:
- suffix map .docx/.xlsx/.xlsm/.pptx/.ipynb (+ .pdf when the media path
  did not already serve it),
- media-path precedence for .pdf when image reading is enabled,
- delegation forwards ONLY path (+ pages for pdf) — create_preview and
  injected keys never reach the adapters through read_file,
- offset/limit are refused for rich suffixes with an explicit error,
- flag off preserves the legacy behavior exactly,
- the registry no longer binds *_inspect tools while knowledge tools
  keep their injected rich adapters.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins import filesystem as filesystem_module
from sidecar.ai.tools.builtins.filesystem import (
    configure_filesystem_tools,
    read_file_tool,
)
from sidecar.ai.tools.builtins.rich_files import notebook as notebook_module
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.registry import build_default_registry
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def _configure(*, rich: bool, image: bool = False) -> None:
    configure_filesystem_tools(
        {
            "tools_max_edit_file_bytes": 2_097_152,
            "tools_image_read_enabled": image,
            "tools_rich_files_enabled": rich,
        }
    )


@pytest.fixture(autouse=True)
def _reset_filesystem_tools():
    yield
    configure_filesystem_tools(
        {"tools_max_edit_file_bytes": 2_097_152, "tools_image_read_enabled": False}
    )


def _write_notebook(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "nbformat": 4,
                "nbformat_minor": 5,
                "metadata": {"language_info": {"name": "python"}},
                "cells": [
                    {
                        "cell_type": "markdown",
                        "metadata": {},
                        "source": "# Rich dispatch fixture",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def test_read_file_dispatches_ipynb_to_notebook_adapter(tmp_path: Path) -> None:
    _configure(rich=True)
    target = tmp_path / "analysis.ipynb"
    _write_notebook(target)

    result = read_file_tool({"path": "analysis.ipynb"}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert result.success is True
    assert result.metadata.get("result_kind") == "notebook_inspect"


@pytest.mark.parametrize(
    ("suffix", "expected_kind"),
    [
        (".docx", "document_inspect"),
        (".xlsx", "spreadsheet_inspect"),
        (".xlsm", "spreadsheet_inspect"),
        (".pptx", "presentation_inspect"),
    ],
)
def test_read_file_dispatches_office_suffixes_to_adapters(
    tmp_path: Path, suffix: str, expected_kind: str
) -> None:
    # Garbage bytes still prove dispatch: each adapter reports its bounded
    # unsupported/parse-failed payload as a successful inspect result
    # instead of read_file's legacy binary-file refusal.
    _configure(rich=True)
    target = tmp_path / f"fixture{suffix}"
    target.write_bytes(b"\x00\x01\x02 not a real office file \x03")

    result = read_file_tool({"path": f"fixture{suffix}"}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert result.metadata.get("result_kind") == expected_kind


def test_read_file_dispatches_pdf_to_adapter_when_media_path_is_off(
    tmp_path: Path,
) -> None:
    _configure(rich=True, image=False)
    target = tmp_path / "report.pdf"
    target.write_bytes(b"%PDF-1.4 truncated garbage")

    result = read_file_tool({"path": "report.pdf"}, _guard(tmp_path))

    assert isinstance(result, ToolHandlerResult)
    assert result.metadata.get("result_kind") == "pdf_inspect"


def test_read_file_media_path_still_wins_for_pdf_when_image_read_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure(rich=True, image=True)
    target = tmp_path / "report.pdf"
    target.write_bytes(b"%PDF-1.4 truncated garbage")
    sentinel = ToolHandlerResult(output="media path", success=True, metadata={"via": "media"})
    monkeypatch.setattr(
        filesystem_module, "read_media_file", lambda *args, **kwargs: sentinel
    )

    result = read_file_tool({"path": "report.pdf"}, _guard(tmp_path))

    assert result is sentinel


def test_read_file_rich_delegation_forwards_only_whitelisted_arguments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure(rich=True)
    target = tmp_path / "analysis.ipynb"
    _write_notebook(target)
    seen: list[dict[str, object]] = []

    def _recorder(arguments: dict[str, object], workspace: WorkspaceGuard) -> ToolHandlerResult:
        seen.append(dict(arguments))
        return ToolHandlerResult(output="{}", success=True, metadata={})

    monkeypatch.setattr(notebook_module, "notebook_inspect_tool", _recorder)

    read_file_tool(
        {
            "path": "analysis.ipynb",
            "create_preview": True,
            "_jenny_session_id": "session-123",
        },
        _guard(tmp_path),
    )

    assert len(seen) == 1
    assert "create_preview" not in seen[0]
    assert "_jenny_session_id" not in seen[0]
    assert seen[0].get("path") == "analysis.ipynb"


def test_read_file_forwards_pages_to_pdf_adapter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sidecar.ai.tools.builtins.rich_files import pdf as pdf_module

    _configure(rich=True, image=False)
    target = tmp_path / "report.pdf"
    target.write_bytes(b"%PDF-1.4 truncated garbage")
    seen: list[dict[str, object]] = []

    def _recorder(arguments: dict[str, object], workspace: WorkspaceGuard) -> ToolHandlerResult:
        seen.append(dict(arguments))
        return ToolHandlerResult(output="{}", success=True, metadata={})

    monkeypatch.setattr(pdf_module, "pdf_inspect_tool", _recorder)

    read_file_tool({"path": "report.pdf", "pages": "1-2"}, _guard(tmp_path))

    assert len(seen) == 1
    assert seen[0].get("pages") == "1-2"


def test_read_file_refuses_offset_and_limit_for_rich_suffixes(tmp_path: Path) -> None:
    _configure(rich=True)
    target = tmp_path / "analysis.ipynb"
    _write_notebook(target)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        read_file_tool({"path": "analysis.ipynb", "offset": 0, "limit": 5}, _guard(tmp_path))

    assert excinfo.value.code == CMP_TOOL_INVALID_PATH
    assert "offset" in str(excinfo.value.message) or "rich" in str(excinfo.value.message)


def test_read_file_flag_off_keeps_legacy_text_read_for_ipynb(tmp_path: Path) -> None:
    _configure(rich=False)
    target = tmp_path / "analysis.ipynb"
    _write_notebook(target)

    result = read_file_tool({"path": "analysis.ipynb"}, _guard(tmp_path))

    assert result.success is True
    assert result.metadata.get("result_kind") is None
    assert "Rich dispatch fixture" in result.output


def test_read_file_flag_off_keeps_legacy_binary_refusal_for_docx(tmp_path: Path) -> None:
    _configure(rich=False)
    target = tmp_path / "fixture.docx"
    target.write_bytes(b"\x00\x01\x02 not a real office file \x03")

    with pytest.raises(ToolExecutionFailure) as excinfo:
        read_file_tool({"path": "fixture.docx"}, _guard(tmp_path))

    assert excinfo.value.code == CMP_TOOL_IO_FAILED


def test_registry_no_longer_binds_inspect_tools_even_when_rich_enabled() -> None:
    enabled = build_default_registry(config={"tools_rich_files_enabled": True})
    for tool_name in (
        "pdf_inspect",
        "image_inspect",
        "spreadsheet_inspect",
        "document_inspect",
        "presentation_inspect",
        "notebook_inspect",
    ):
        assert tool_name not in enabled, f"{tool_name} must not be a model-facing tool"
    assert "read_file" in enabled


def test_knowledge_tools_keep_injected_rich_adapters() -> None:
    registry = build_default_registry(
        config={
            "tools_rich_files_enabled": True,
            "tools_knowledge_enabled": True,
        }
    )
    assert "knowledge_view" in registry
