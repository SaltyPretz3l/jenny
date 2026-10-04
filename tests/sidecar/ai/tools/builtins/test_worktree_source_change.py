"""Shell change evidence that separates saved source from bookkeeping and strays.

TR-015: ``git add``/``git commit``, a stray ``cfile=none`` (MQ-014) and data
written to a repo-root ``holdout/`` (MQ-027) all reported ``workspace_changed``
and so counted as a save. ``source_changed`` keeps only real source edits, and
new stray outputs are named in the result so the model sees them.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import worktree_change_tracking as tracking
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from tests.sidecar.ai.tools.builtins.test_worktree_change_tracking import _repo, _run_shell

_NOTE = "New untracked files outside ignored folders: "


@pytest.fixture(autouse=True)
def _reset() -> None:
    tracking._reset_worktree_tracking_for_tests()


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def _write(path: Path, text: str = "x\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _evidence(result: ToolHandlerResult) -> tuple[object, object]:
    return result.metadata.get("workspace_changed"), result.metadata.get("source_changed")


def test_writes_under_gitignored_paths_report_no_change(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    _write(repo / ".gitignore", "out/\n")
    _git(repo, "add", ".gitignore")
    _git(repo, "commit", "-q", "-m", "ignore")

    result = _run_shell(guard, lambda: _write(repo / "out" / "attempts" / "a.py"))

    assert _evidence(result) == (False, False)
    assert "created_untracked_paths" not in result.metadata
    assert result.output == "ok"


def test_index_only_git_add_is_not_a_source_change(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    _write(repo / "tracked.txt", "edited\n")
    _write(repo / "new_module.py")

    result = _run_shell(guard, lambda: _git(repo, "add", "."), tool_name="run_command")

    assert _evidence(result) == (True, False)


def test_edit_and_stage_in_one_command_is_a_source_change(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    def edit_and_stage() -> None:
        _write(repo / "tracked.txt", "edited\n")
        _write(repo / "new_module.py")
        _git(repo, "add", ".")

    result = _run_shell(guard, edit_and_stage, tool_name="run_command")

    assert _evidence(result) == (True, True)


def test_commit_of_staged_work_is_not_a_source_change(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    _write(repo / "tracked.txt", "edited\n")
    _git(repo, "add", ".")

    result = _run_shell(guard, lambda: _git(repo, "commit", "-q", "-m", "w"))

    assert _evidence(result) == (True, False)


def test_stray_extensionless_output_is_not_a_source_change(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(guard, lambda: (repo / "cfile=none").write_bytes(b"\x00bytecode"))

    assert _evidence(result) == (True, False)


def test_new_untracked_python_module_is_a_source_change(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(guard, lambda: _write(repo / "pkg" / "matching.py", "def f(): ...\n"))

    assert _evidence(result) == (True, True)


def test_tracked_edit_is_a_source_change(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(guard, lambda: _write(repo / "tracked.txt", "edited\n"))

    assert _evidence(result) == (True, True)


def test_deleting_a_tracked_file_is_a_source_change(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(guard, (repo / "tracked.txt").unlink, tool_name="run_command")

    assert _evidence(result) == (True, True)


def test_untracked_data_output_folder_is_not_a_source_change(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(guard, lambda: _write(repo / "holdout" / "northwind" / "matches.csv"))

    assert _evidence(result) == (True, False)


def test_new_stray_output_is_named_in_the_result(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(guard, lambda: (repo / "cfile=none").write_bytes(b"\x00"))

    assert result.metadata["created_untracked_paths"] == ["cfile=none"]
    assert result.output == f"ok\n{_NOTE}cfile=none"


def test_a_new_top_level_folder_collapses_to_one_entry(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    def _outputs() -> None:
        for client in ("northwind", "contoso"):
            for name in ("matches.csv", "unmatched.csv", "summary.csv"):
                _write(repo / "holdout" / client / name)
        (repo / "cfile=none").write_bytes(b"\x00")

    result = _run_shell(guard, _outputs)

    assert result.metadata["created_untracked_paths"] == ["cfile=none", "holdout/ (6 files)"]
    assert result.output.endswith(f"{_NOTE}cfile=none, holdout/ (6 files)")


def test_the_note_caps_at_five_entries_and_400_characters(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    def _strays() -> None:
        for index in range(8):
            _write(repo / f"stray_{index}_{'x' * 80}.log")

    result = _run_shell(guard, _strays)

    entries = result.metadata["created_untracked_paths"]
    assert isinstance(entries, list) and len(entries) == 5
    note = result.output.splitlines()[-1]
    assert note.startswith(_NOTE)
    assert len(note) <= 400
    assert note.endswith("(+3 more)")


def test_gitignored_outputs_and_new_source_files_get_no_note(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    _write(repo / ".gitignore", "out/\n")
    _git(repo, "add", ".gitignore")
    _git(repo, "commit", "-q", "-m", "ignore")

    def _work() -> None:
        _write(repo / "out" / "holdout" / "matches.csv")
        _write(repo / "pkg" / "report.py")

    result = _run_shell(guard, _work)

    assert "created_untracked_paths" not in result.metadata
    assert result.output == "ok"


def test_the_note_stays_valid_json_in_a_json_command_result(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    payload = {"stdout": "match ok\n", "exit_code": 0}

    result = tracking.run_with_worktree_observation(
        side_effecting=True,
        tool_name="run_command",
        arguments={"cwd": "repo"},
        workspace=guard,
        handler=lambda: (
            (repo / "cfile=none").write_bytes(b"\x00"),
            ToolHandlerResult(output=json.dumps(payload, indent=2)),
        )[1],
        logger=logging.getLogger(__name__),
    )

    parsed = json.loads(result.output)
    assert parsed["stdout"] == "match ok\n"
    assert parsed["new_untracked_files"] == f"{_NOTE}cfile=none"


def test_typed_file_tools_and_non_git_workspaces_get_no_note(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    typed = _run_shell(guard, lambda: _write(repo / "stray.bin"), tool_name="write_file")
    plain_root = tmp_path / "plain"
    (plain_root / "repo").mkdir(parents=True)
    plain = _run_shell(
        WorkspaceGuard(str(plain_root)), lambda: _write(plain_root / "repo" / "stray.bin")
    )

    for result in (typed, plain):
        assert "created_untracked_paths" not in result.metadata
        assert result.output == "ok"
