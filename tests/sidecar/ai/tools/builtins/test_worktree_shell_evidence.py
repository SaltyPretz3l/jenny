"""Pure shell change-evidence helpers split out of ``worktree_change_tracking``."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_COMMAND_ABORTED, CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.builtins import worktree_change_tracking as tracking
from sidecar.ai.tools.builtins import worktree_shell_evidence as evidence
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult


def _snapshot(status: dict[str, str]) -> tracking.WorktreeSnapshot:
    return tracking.WorktreeSnapshot(repo_root=Path("."), head=None, branch=None, status=status)


def test_cache_paths_are_not_the_models_edits() -> None:
    assert evidence.is_cache_path("pkg/__pycache__/mod.cpython-312.pyc")
    assert evidence.is_cache_path(".pytest_cache/v/cache/nodeids")
    assert evidence.is_cache_path("build/mod.pyc")
    assert not evidence.is_cache_path("pkg/module.py")


def test_kill_switch_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(evidence.SHELL_CHANGE_EVIDENCE_FLAG, raising=False)
    assert evidence.shell_change_evidence_enabled() is True
    monkeypatch.setenv(evidence.SHELL_CHANGE_EVIDENCE_FLAG, "0")
    assert evidence.shell_change_evidence_enabled() is False


def test_call_and_failure_outcomes() -> None:
    assert evidence.call_outcome(ToolHandlerResult(output="", success=True)) == "succeeded"
    assert evidence.call_outcome(ToolHandlerResult(output="", success=False)) == "failed"
    timed_out = ToolHandlerResult(output="", success=False, metadata={"timed_out": True})
    assert evidence.call_outcome(timed_out) == "timed_out"

    aborted = ToolExecutionFailure(code=CMP_TOOL_COMMAND_ABORTED, message="stop", retryable=False)
    assert evidence.failure_outcome(aborted) == "cancelled"
    expired = ToolExecutionFailure(code=CMP_TOOL_EXECUTION_FAILED, message="slow", retryable=False)
    expired.__cause__ = subprocess.TimeoutExpired(["cmd"], 1)
    assert evidence.failure_outcome(expired) == "timed_out"
    failed = ToolExecutionFailure(code=CMP_TOOL_EXECUTION_FAILED, message="no", retryable=False)
    assert evidence.failure_outcome(failed) == "failed"


def test_new_stray_outputs_collapse_per_top_level_folder() -> None:
    before = _snapshot({"notes.txt": "??"})
    after = _snapshot(
        {"notes.txt": "??", "out/a.csv": "??", "out/b.csv": "??", "cfile=none": "??", "new.py": "??"}
    )
    changed = sorted(after.status)

    entries = evidence.created_untracked_entries(before, after, changed)

    assert entries == ("cfile=none", "out/ (2 files)")


def test_stray_note_bounds_its_entries() -> None:
    entries = tuple(f"file-{index}.dat" for index in range(7))

    note = evidence.stray_note(entries)

    assert note.startswith("New untracked files outside ignored folders: file-0.dat")
    assert note.endswith(" (+2 more)")
    assert len(evidence.stray_note(("x" * 1000,))) <= evidence.MAX_STRAY_NOTE_CHARS


def test_model_notes_name_rewritten_sources_then_strays() -> None:
    before = _snapshot({})
    after = _snapshot({"src/app.py": " M", "made.py": "??"})

    notes = evidence.model_notes(before, after, ["made.py", "src/app.py"], ("out/",))

    assert [key for key, _note in notes] == ["scripted_edit_note", "new_untracked_files"]
    assert "src/app.py" in notes[0][1]
    assert "made.py" not in notes[0][1]


def test_notes_extend_json_objects_and_append_to_text() -> None:
    notes = [("new_untracked_files", "New untracked files outside ignored folders: x")]

    assert json.loads(evidence.with_model_notes('{"ok": true}', notes)) == {
        "ok": True,
        "new_untracked_files": notes[0][1],
    }
    assert evidence.with_model_notes("done", notes) == f"done\n{notes[0][1]}"
    assert evidence.with_model_notes("done", []) == "done"


def test_tracking_keeps_the_names_its_callers_use() -> None:
    assert tracking.SHELL_CHANGE_EVIDENCE_FLAG == evidence.SHELL_CHANGE_EVIDENCE_FLAG
    assert tracking.shell_change_evidence_enabled is evidence.shell_change_evidence_enabled
    assert tracking.diff_id_prefix_for is evidence.diff_id_prefix_for
    assert tracking._is_cache_path is evidence.is_cache_path
