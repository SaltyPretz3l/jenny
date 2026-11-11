"""`git_log` takes an optional ref and an optional path (row 129, group C)."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import git_ops as git_ops_module
from sidecar.ai.tools.builtins.git_ops import git_log_tool
from sidecar.ai.tools.builtins.git_tool_args import build_git_log_arguments, parse_max_count
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.fixture(autouse=True)
def _plain_subprocess(monkeypatch: pytest.MonkeyPatch) -> None:
    def _run_owned(arguments, *, cwd, timeout_seconds, env, **_keys):
        return subprocess.run(
            arguments, cwd=str(cwd), capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=timeout_seconds, check=False, env=env,
        )

    monkeypatch.setattr(git_ops_module, "_run_owned_process", _run_owned)


def _commit(repo: Path, name: str, text: str, message: str) -> None:
    (repo / name).write_text(text, encoding="utf-8", newline="")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", message], cwd=repo, check=True)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    path = tmp_path / "repo"
    path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=path, check=True)
    _commit(path, "a.txt", "1\n", "add a")
    _commit(path, "b.txt", "1\n", "add b")
    _commit(path, "a.txt", "2\n", "change a")
    return path


def test_arguments_without_ref_or_path_are_the_old_command() -> None:
    assert build_git_log_arguments(max_count=7, ref=None, path_filter=None) == [
        "log", "--no-show-signature", "--max-count=7", "--oneline",
    ]


def test_ref_and_path_are_separated_and_literal() -> None:
    assert build_git_log_arguments(max_count=5, ref="main", path_filter="src/*.py") == [
        "log", "--no-show-signature", "--max-count=5", "--oneline",
        "main", "--", ":(literal)src/*.py",
    ]
    assert build_git_log_arguments(max_count=5, ref=None, path_filter="a.txt")[-2:] == [
        "--", ":(literal)a.txt",
    ]
    assert build_git_log_arguments(max_count=5, ref="v1", path_filter=None)[-2:] == ["v1", "--"]


def test_max_count_is_clamped_and_validated() -> None:
    assert parse_max_count({}) == 20
    assert parse_max_count({"max_count": "500"}) == 100
    assert parse_max_count({"max_count": 0}) == 1
    with pytest.raises(ToolExecutionFailure):
        parse_max_count({"max_count": "many"})


def test_log_for_one_path_lists_only_its_commits(repo: Path, tmp_path: Path) -> None:
    output = git_log_tool({"cwd": "repo", "path": "a.txt"}, WorkspaceGuard(str(tmp_path)))

    assert "change a" in output and "add a" in output
    assert "add b" not in output


def test_log_from_a_ref_starts_there(repo: Path, tmp_path: Path) -> None:
    output = git_log_tool({"cwd": "repo", "ref": "HEAD~1"}, WorkspaceGuard(str(tmp_path)))

    assert "change a" not in output
    assert "add b" in output


def test_log_ref_rejects_an_option_lookalike(repo: Path, tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure, match="must not start with '-'"):
        git_log_tool({"cwd": "repo", "ref": "--output=x"}, WorkspaceGuard(str(tmp_path)))


def test_log_path_outside_the_workspace_is_refused(repo: Path, tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure):
        git_log_tool({"cwd": "repo", "path": "../../outside.txt"}, WorkspaceGuard(str(tmp_path)))


def test_extract_boolean_reads_and_rejects() -> None:
    from sidecar.ai.tools.builtins.git_tool_args import extract_boolean

    assert extract_boolean({"staged": True}, "staged") is True
    assert extract_boolean({}, "staged", default=True) is True
    with pytest.raises(ToolExecutionFailure):
        extract_boolean({"staged": "perhaps"}, "staged")
