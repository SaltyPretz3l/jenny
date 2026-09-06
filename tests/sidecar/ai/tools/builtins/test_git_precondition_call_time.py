"""Red-first: call-time precondition enforcement replaces the path-code lie.

A missing git repo is not an invalid path. git_ops and worktree tracking
re-run the SAME probe the assembly split used and raise the new
CMP-TOOL-0045 with `precondition_id`, so the W0 baseline's measured
conflation (not_found/denied/precondition all surfacing CMP-TOOL-0004)
starts unwinding.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_PRECONDITION_UNMET
from sidecar.ai.tools.builtins.git_ops import git_status_tool
from sidecar.ai.tools.builtins.worktree_change_tracking import (
    workspace_change_baseline_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.failure_taxonomy import TAXONOMY, classify
from sidecar.ai.tools.workspace import WorkspaceGuard


def test_code_constant_and_taxonomy_row() -> None:
    assert CMP_TOOL_PRECONDITION_UNMET == "CMP-TOOL-0045"
    assert TAXONOMY[CMP_TOOL_PRECONDITION_UNMET] == "precondition_unmet"
    assert classify(CMP_TOOL_PRECONDITION_UNMET) == "precondition_unmet"


def _expect_precondition_failure(exc: ToolExecutionFailure) -> None:
    assert exc.code == CMP_TOOL_PRECONDITION_UNMET
    details = exc.to_error_data()
    assert details.get("precondition_id") == "git_repo"
    assert details.get("failure_class") == "precondition_unmet"
    assert "git repository" in exc.message


def test_git_status_without_repo_raises_precondition_unmet(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as exc_info:
        git_status_tool({}, WorkspaceGuard(str(tmp_path)))
    _expect_precondition_failure(exc_info.value)


def test_worktree_baseline_without_repo_raises_precondition_unmet(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as exc_info:
        workspace_change_baseline_tool({}, WorkspaceGuard(str(tmp_path)))
    _expect_precondition_failure(exc_info.value)


def test_manifest_declares_the_git_and_python_preconditions() -> None:
    import json

    from sidecar.ai.tools.catalog import tool_manifest_path

    manifest = json.loads(tool_manifest_path().read_text(encoding="utf-8"))
    by_name: dict[str, dict] = {}
    for tool in manifest.get("tools", []):
        if isinstance(tool, dict) and tool.get("name"):
            by_name[str(tool["name"])] = tool

    for git_tool in ("git_status", "git_log", "git_diff", "git_show",
                     "workspace_change_baseline", "workspace_change_delta"):
        preconditions = by_name[git_tool].get("preconditions")
        assert isinstance(preconditions, list) and preconditions, git_tool
        assert preconditions[0].get("id") == "git_repo"
        assert preconditions[0].get("probe") == "git_root_present"
        assert preconditions[0].get("severity") == "blocking"

    python_preconditions = by_name["python_execute"].get("preconditions")
    assert isinstance(python_preconditions, list) and python_preconditions
    assert python_preconditions[0].get("id") == "python_runtime"
    assert python_preconditions[0].get("probe") == "python_runtime_ready"
    assert python_preconditions[0].get("severity") == "advisory"
