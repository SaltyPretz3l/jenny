"""Per-tool answers a local model can act on (row 129, group B: B3 to B6, B8, B12)."""

from __future__ import annotations

import subprocess
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import CMP_TOOL_OUTSIDE_WORKSPACE, CMP_TOOL_SKILL_NOT_FOUND
from sidecar.ai.tools.builtins import delete_file as delete_module
from sidecar.ai.tools.builtins.git_ops import git_diff_tool
from sidecar.ai.tools.builtins.python_runtime import tool as python_tool
from sidecar.ai.tools.builtins.skills import (
    _reset_skill_tool_state,
    configure_skill_tool,
    load_skill_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.tool_families import saved_tool_output
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.fixture(autouse=True)
def _clean_skill_state() -> Iterator[None]:
    _reset_skill_tool_state()
    yield
    _reset_skill_tool_state()


def _git(repo: Path, *arguments: str) -> None:
    subprocess.run(["git", *arguments], cwd=repo, check=True, capture_output=True)


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "tracked.txt").write_text("one\n", encoding="utf-8", newline="")
    (repo / ".gitignore").write_text("ignored.log\n", encoding="utf-8", newline="")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "first")
    return repo


# -- B3 ---------------------------------------------------------------------


def test_delete_file_does_not_promise_a_move_that_is_refused(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("hello\n", encoding="utf-8")

    result = delete_module.delete_file_tool({"path": "notes.txt"}, WorkspaceGuard(str(tmp_path)))

    assert "move it back" not in result.output
    assert "The user can restore it" in result.output
    assert "move_file cannot reach it" in result.output


# -- B4 ---------------------------------------------------------------------


def test_git_diff_names_new_untracked_files(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    guard = WorkspaceGuard(str(tmp_path))
    assert git_diff_tool({"cwd": "repo"}, guard) == "(no changes found)"

    (repo / "new_module.py").write_text("x = 1\n", encoding="utf-8", newline="")
    (repo / "ignored.log").write_text("noise\n", encoding="utf-8", newline="")
    output = git_diff_tool({"cwd": "repo"}, guard)

    assert "1 new untracked file(s)" in output
    assert "new_module.py" in output
    assert "ignored.log" not in output
    # A staged or ref diff never covers untracked files, and a path filter narrows them.
    assert git_diff_tool({"cwd": "repo", "staged": True}, guard) == "(no changes found)"
    assert git_diff_tool({"cwd": "repo", "ref": "HEAD"}, guard) == "(no changes found)"
    assert git_diff_tool({"cwd": "repo", "path": "tracked.txt"}, guard) == "(no changes found)"
    assert "new_module.py" in git_diff_tool({"cwd": "repo", "path": "new_module.py"}, guard)


def test_git_diff_still_shows_the_patch_when_tracked_files_changed(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    (repo / "tracked.txt").write_text("two\n", encoding="utf-8", newline="")
    (repo / "new_module.py").write_text("x = 1\n", encoding="utf-8", newline="")

    output = git_diff_tool({"cwd": "repo"}, WorkspaceGuard(str(tmp_path)))

    assert "+two" in output
    assert "untracked" not in output


def test_git_diff_caps_the_untracked_list(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    for index in range(25):
        (repo / f"n{index:02}.txt").write_text("x\n", encoding="utf-8", newline="")

    output = git_diff_tool({"cwd": "repo"}, WorkspaceGuard(str(tmp_path)))

    assert "25 new untracked file(s)" in output
    assert "n19.txt" in output and "n20.txt" not in output
    assert "and 5 more" in output


# -- B5 ---------------------------------------------------------------------


def _skill(root: Path, name: str) -> None:
    skill_dir = root / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: test skill\n---\n\nBody of {name}.\n", encoding="utf-8"
    )


def test_load_skill_takes_the_label_its_own_failure_lists(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    _skill(bundled_root, "pdf")
    configure_skill_tool({"skills_bundled_root": str(bundled_root)})
    guard = WorkspaceGuard(None)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        load_skill_tool({"name": "absent"}, guard)
    assert excinfo.value.code == CMP_TOOL_SKILL_NOT_FOUND
    assert "bundled/pdf" in excinfo.value.message
    assert "Pass one of these as name." in excinfo.value.message

    by_label = load_skill_tool({"name": "bundled/pdf"}, guard)
    by_name = load_skill_tool({"name": "pdf", "scope": "bundled"}, guard)
    assert "Body of pdf." in by_label.output
    assert by_label.output == by_name.output

    with pytest.raises(ToolExecutionFailure) as missing:
        load_skill_tool({"name": "bundled/absent"}, guard)
    assert missing.value.code == CMP_TOOL_SKILL_NOT_FOUND


# -- B6 ---------------------------------------------------------------------


def test_a_leading_slash_reads_as_a_workspace_path(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    (root / "src").mkdir(parents=True)
    (root / "src" / "app.py").write_text("x\n", encoding="utf-8")
    guard = WorkspaceGuard(str(root))

    assert guard.resolve_read_path("/src/app.py") == (root / "src" / "app.py").resolve()
    assert guard.resolve_read_path("\\src\\app.py") == (root / "src" / "app.py").resolve()
    # A new file under an existing folder; a missing folder is not invented.
    assert guard.resolve_write_path("/src/new.py") == (root / "src" / "new.py").resolve()


def test_a_path_outside_the_workspace_is_refused_with_an_example_and_no_echo(
    tmp_path: Path,
) -> None:
    root = tmp_path / "ws"
    root.mkdir()
    outside = tmp_path / "elsewhere.txt"
    outside.write_text("x\n", encoding="utf-8")
    guard = WorkspaceGuard(str(root))

    for requested in ("../elsewhere.txt", str(outside)):
        with pytest.raises(ToolExecutionFailure) as excinfo:
            guard.resolve_read_path(requested)
        assert excinfo.value.code == CMP_TOOL_OUTSIDE_WORKSPACE
        assert excinfo.value.message.startswith("path is outside the workspace. ")
        assert requested not in excinfo.value.message
        assert "such as src/app.py" in excinfo.value.message
    # A leading slash is never healed into a path that leaves the root.
    with pytest.raises(ToolExecutionFailure):
        guard.resolve_write_path("/../elsewhere.txt")


# -- B8 ---------------------------------------------------------------------


def test_python_execute_reports_the_codes_own_error_as_fixable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _run(returncode: int, error: object) -> object:
        monkeypatch.setattr(python_tool.sys, "platform", "win32")
        monkeypatch.setattr(python_tool, "ensure_runtime_venv", lambda *_a, **_k: tmp_path)
        monkeypatch.setattr(
            python_tool,
            "execute_sandboxed",
            lambda **_k: SimpleNamespace(payload={}, work_dir=tmp_path, returncode=returncode),
        )
        monkeypatch.setattr(
            python_tool, "format_python_output", lambda *_a, **_k: ({"error": error}, [])
        )
        return python_tool.python_execute_tool({"code": "1/0"}, WorkspaceGuard(str(tmp_path)))

    failed = _run(1, {"type": "ZeroDivisionError", "message": "division by zero"})
    passed = _run(0, None)

    assert failed.success is False
    assert failed.metadata["failure_class"] == "precondition_unmet"
    assert "Fix the code and run it again." in failed.metadata["remediation"]
    assert passed.success is True
    assert "failure_class" not in passed.metadata


# -- B12 --------------------------------------------------------------------


def test_a_failed_browser_step_is_not_saved_as_finished() -> None:
    assert saved_tool_output("browser", "page text", {}) == "Browser step finished."
    assert saved_tool_output("browser", "page text", {"failure_class": "denied"}) == (
        "Browser step failed."
    )
    assert saved_tool_output(
        "browser", "page text", {"failure_class": "denied", "step_summary": "Opened x"}
    ) == "Opened x"
    assert saved_tool_output("read_file", "text", {"failure_class": "denied"}) == "text"
