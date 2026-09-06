"""Regression tests for reserved ``.jenny`` file-tool paths."""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.builtins.file_state import refuse_reserved_internal_path
from sidecar.ai.tools.builtins.filesystem import write_file_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def _assert_reserved_refusal(result: ToolHandlerResult) -> None:
    assert result.success is False
    assert result.error_code == CMP_TOOL_INVALID_PATH
    assert "reserved .jenny internal state" in result.output


def test_write_file_refuses_new_reserved_path(tmp_path: Path) -> None:
    target = tmp_path / ".jenny" / "check.js"

    result = write_file_tool({"path": ".jenny/check.js", "content": "check\n"}, _guard(tmp_path))

    _assert_reserved_refusal(result)
    assert not target.exists()


def test_write_file_reserved_refusal_precedes_read_snapshot_requirement(
    tmp_path: Path,
) -> None:
    target = tmp_path / ".jenny" / "check.js"
    target.parent.mkdir()
    target.write_text("before\n", encoding="utf-8")

    result = write_file_tool({"path": ".jenny/check.js", "content": "after\n"}, _guard(tmp_path))

    _assert_reserved_refusal(result)
    assert "must be read" not in result.output
    assert target.read_text(encoding="utf-8") == "before\n"


@pytest.mark.parametrize("path_kind", ["dot_relative", "absolute", "upper_case"])
def test_write_file_refuses_normalized_reserved_paths(tmp_path: Path, path_kind: str) -> None:
    target = tmp_path / ".jenny" / "x"
    path = {
        "dot_relative": "./.jenny/x",
        "absolute": str(target),
        "upper_case": ".JENNY/x",
    }[path_kind]

    result = write_file_tool({"path": path, "content": "blocked\n"}, _guard(tmp_path))

    _assert_reserved_refusal(result)
    assert not target.exists()


def test_write_file_allows_similar_non_reserved_path(tmp_path: Path) -> None:
    target = tmp_path / ".jennyfoo" / "x"

    result = write_file_tool({"path": ".jennyfoo/x", "content": "allowed\n"}, _guard(tmp_path))

    assert result.success is True
    assert target.read_text(encoding="utf-8") == "allowed\n"


@pytest.mark.parametrize(
    "path",
    [".jenny", ".jenny/x", "./.jenny/x", ".\\.jenny\\x", "././.jenny/x", ".JENNY/x", ".Jenny"],
)
def test_refuse_reserved_internal_path_normalizes_leading_dot_prefixes(path: str) -> None:
    with pytest.raises(ToolExecutionFailure) as exc_info:
        refuse_reserved_internal_path(path, action="write")

    assert exc_info.value.code == CMP_TOOL_INVALID_PATH
    assert exc_info.value.message == (
        "Ordinary file tools cannot write reserved .jenny internal state."
    )


@pytest.mark.parametrize("path", [".jennyfoo/x", "src/.jenny-ish"])
def test_refuse_reserved_internal_path_allows_similar_paths(path: str) -> None:
    refuse_reserved_internal_path(path, action="write")
