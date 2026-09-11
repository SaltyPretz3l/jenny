"""Real Git ownership refusal, with command trust supplied only by workspace validation."""
import subprocess
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import git_ops, git_process, worktree_change_tracking
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def test_foreign_owner_selected_workspace_status_and_baseline(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / "untracked.txt").write_text("user content")
    config_before = (tmp_path / ".git/config").read_bytes()
    commands = []

    def run(arguments, *, cwd, timeout_seconds, env):
        commands.append(arguments)
        env = {**env, "GIT_TEST_ASSUME_DIFFERENT_OWNER": "1"}
        return subprocess.run(arguments, cwd=cwd, env=env, capture_output=True, text=True,
                              encoding="utf-8", timeout=timeout_seconds, check=False)

    monkeypatch.setattr(git_process, "get_owned_process_service", lambda: SimpleNamespace(run=run))
    guard = WorkspaceGuard(str(tmp_path))
    assert "untracked.txt" in git_ops.git_status_tool({}, guard)
    baseline = worktree_change_tracking.workspace_change_baseline_tool({}, guard)
    delta = worktree_change_tracking.workspace_change_delta_tool(
        {"baseline_id": baseline.metadata["baseline_id"]}, guard)
    assert delta.success
    subdir = tmp_path / "subdir"
    subdir.mkdir()
    git_ops.git_status_tool({"cwd": "subdir"}, guard)
    assert all(command[1:3] == ["-c", f"safe.directory={tmp_path.resolve().as_posix()}"]
               for command in commands)
    assert (tmp_path / ".git/config").read_bytes() == config_before
    with pytest.raises(ToolExecutionFailure, match="dubious ownership"):
        git_ops.git_status_tool({"cwd": str(tmp_path)}, WorkspaceGuard(str(tmp_path.parent)))


def test_delta_cannot_reuse_trust_after_workspace_changes(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    guard = WorkspaceGuard(str(tmp_path))
    baseline = worktree_change_tracking.workspace_change_baseline_tool({}, guard)
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(ToolExecutionFailure):
        worktree_change_tracking.workspace_change_delta_tool(
            {"baseline_id": baseline.metadata["baseline_id"]}, WorkspaceGuard(str(other)))
