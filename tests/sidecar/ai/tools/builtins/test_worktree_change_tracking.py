from __future__ import annotations

import logging
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_WORKTREE_BASELINE_NOT_FOUND
from sidecar.ai.tools.builtins import worktree_change_tracking as tracking
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard


def _repo(tmp_path: Path) -> tuple[Path, WorkspaceGuard]:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    (repo / "tracked.txt").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=repo, check=True)
    return repo, WorkspaceGuard(str(tmp_path))


@pytest.fixture(autouse=True)
def _reset() -> None:
    tracking._reset_worktree_tracking_for_tests()


def _baseline(guard: WorkspaceGuard) -> str:
    result = tracking.workspace_change_baseline_tool({"cwd": "repo"}, guard)
    return str(result.metadata["baseline_id"])


def test_baseline_accepts_absolute_repo_cwd(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = tracking.workspace_change_baseline_tool({"cwd": str(repo)}, guard)

    assert result.success is True
    assert result.metadata["status"] == []


def _delta(guard: WorkspaceGuard, baseline_id: str) -> dict[str, object]:
    result = tracking.workspace_change_delta_tool(
        {"cwd": "repo", "baseline_id": baseline_id}, guard
    )
    return result.metadata


def test_clean_baseline_attributes_created_file_to_session(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    baseline_id = _baseline(guard)
    observation = tracking.begin_mutation_observation(
        tool_name="write_file", arguments={"cwd": "repo"}, workspace=guard
    )
    assert observation is not None
    (repo / "created.txt").write_text("new\n", encoding="utf-8")
    tracking.finish_mutation_observation(observation, workspace=guard, arguments={"cwd": "repo"})
    assert _delta(guard, baseline_id)["created_by_session"] == ["created.txt"]


def test_session_created_file_removed_later_is_reported_as_resolved(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    baseline_id = _baseline(guard)

    create_observation = tracking.begin_mutation_observation(
        tool_name="write_file", arguments={"cwd": "repo"}, workspace=guard
    )
    assert create_observation is not None
    target = repo / "created-then-removed.txt"
    target.write_text("temporary\n", encoding="utf-8")
    tracking.finish_mutation_observation(
        create_observation, workspace=guard, arguments={"cwd": "repo"}
    )
    assert _delta(guard, baseline_id)["created_by_session"] == [
        "created-then-removed.txt"
    ]

    remove_observation = tracking.begin_mutation_observation(
        tool_name="edit_file", arguments={"cwd": "repo"}, workspace=guard
    )
    assert remove_observation is not None
    target.unlink()
    tracking.finish_mutation_observation(
        remove_observation, workspace=guard, arguments={"cwd": "repo"}
    )

    delta = _delta(guard, baseline_id)
    assert delta["created_then_removed_by_session"] == ["created-then-removed.txt"]
    assert delta["category_totals"]["created_then_removed_by_session"] == 1
    assert delta["mixed_or_ambiguous"] == []
    assert "ignored paths" in delta["attribution_caveat"]


def test_nested_repository_baseline_drives_mutation_and_delta_without_repeated_cwd(
    tmp_path: Path,
) -> None:
    repo, guard = _repo(tmp_path)
    baseline_id = _baseline(guard)
    observation = tracking.begin_mutation_observation(
        tool_name="write_file", arguments={}, workspace=guard
    )
    assert observation is not None
    (repo / "nested-created.txt").write_text("new\n", encoding="utf-8")
    tracking.finish_mutation_observation(observation, workspace=guard, arguments={})
    result = tracking.workspace_change_delta_tool({"baseline_id": baseline_id}, guard)
    assert result.metadata["created_by_session"] == ["nested-created.txt"]


def test_dirty_start_external_mixed_and_resolved_categories(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    (repo / "dirty.txt").write_text("before\n", encoding="utf-8")
    baseline_id = _baseline(guard)
    (repo / "external.txt").write_text("outside\n", encoding="utf-8")
    observation = tracking.begin_mutation_observation(
        tool_name="write_file", arguments={"cwd": "repo"}, workspace=guard
    )
    assert observation is not None
    (repo / "external.txt").write_text("inside\n", encoding="utf-8")
    subprocess.run(["git", "add", "external.txt"], cwd=repo, check=True)
    (repo / "dirty.txt").unlink()
    tracking.finish_mutation_observation(observation, workspace=guard, arguments={"cwd": "repo"})
    delta = _delta(guard, baseline_id)
    assert delta["resolved_preexisting"] == ["dirty.txt"]
    assert delta["mixed_or_ambiguous"] == ["external.txt"]


def test_preexisting_dirty_file_touched_without_status_change_is_attributed(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    target = repo / "tracked.txt"
    target.write_text("dirty one\n", encoding="utf-8")
    baseline_id = _baseline(guard)
    observation = tracking.begin_mutation_observation(
        tool_name="edit_file", arguments={"cwd": "repo"}, workspace=guard
    )
    assert observation is not None
    target.write_text("dirty two and larger\n", encoding="utf-8")
    tracking.finish_mutation_observation(observation, workspace=guard, arguments={"cwd": "repo"})
    assert _delta(guard, baseline_id)["preexisting_and_touched"] == ["tracked.txt"]


def test_clean_tracked_file_touched_after_baseline_remains_preexisting(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    target = repo / "tracked.txt"
    baseline_id = _baseline(guard)
    observation = tracking.begin_mutation_observation(
        tool_name="edit_file", arguments={"cwd": "repo"}, workspace=guard
    )
    assert observation is not None
    target.write_text("changed after clean baseline\n", encoding="utf-8")
    tracking.finish_mutation_observation(observation, workspace=guard, arguments={"cwd": "repo"})

    delta = _delta(guard, baseline_id)

    assert delta["created_by_session"] == []
    assert delta["preexisting_and_touched"] == ["tracked.txt"]


def test_external_and_background_changes_are_never_session_attributed(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    baseline_id = _baseline(guard)
    (repo / "external.txt").write_text("outside\n", encoding="utf-8")
    first = _delta(guard, baseline_id)
    assert first["appeared_externally"] == ["external.txt"]
    observation = tracking.begin_mutation_observation(
        tool_name="run_command",
        arguments={"cwd": "repo", "run_in_background": True},
        workspace=guard,
    )
    assert observation is not None
    tracking.finish_mutation_observation(observation, workspace=guard, arguments={"cwd": "repo"})
    (repo / "later.txt").write_text("later\n", encoding="utf-8")
    delta = _delta(guard, baseline_id)
    assert "later.txt" in delta["mixed_or_ambiguous"]
    assert delta["ambiguity_reasons"]


def test_background_stop_changes_are_never_session_attributed(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    baseline_id = _baseline(guard)
    observation = tracking.begin_mutation_observation(
        tool_name="stop_background_job",
        arguments={"cwd": "repo"},
        workspace=guard,
    )
    assert observation is not None
    (repo / "during-stop.txt").write_text("background tail\n", encoding="utf-8")
    tracking.finish_mutation_observation(
        observation,
        workspace=guard,
        arguments={"cwd": "repo"},
    )

    delta = _delta(guard, baseline_id)
    assert delta["mixed_or_ambiguous"] == ["during-stop.txt"]
    assert delta["created_by_session"] == []


def test_failed_observation_marks_later_change_ambiguous(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo, guard = _repo(tmp_path)
    baseline_id = _baseline(guard)
    original_capture = tracking._capture_repo
    monkeypatch.setattr(
        tracking,
        "_capture_repo",
        lambda repo_root: (_ for _ in ()).throw(RuntimeError("git unavailable")),
    )
    tracking.run_with_worktree_observation(
        side_effecting=True,
        tool_name="write_file",
        arguments={},
        workspace=guard,
        handler=lambda: (repo / "uncertain.txt").write_text("x\n", encoding="utf-8"),
        logger=logging.getLogger(__name__),
    )
    monkeypatch.setattr(tracking, "_capture_repo", original_capture)
    delta = tracking.workspace_change_delta_tool({"baseline_id": baseline_id}, guard).metadata
    assert delta["mixed_or_ambiguous"] == ["uncertain.txt"]
    assert "pre-observation failed" in delta["ambiguity_reasons"]


def test_missing_or_reset_baseline_returns_0043(tmp_path: Path) -> None:
    _repo(tmp_path)
    guard = WorkspaceGuard(str(tmp_path))
    baseline_id = _baseline(guard)
    tracking._reset_worktree_tracking_for_tests()
    with pytest.raises(ToolExecutionFailure) as excinfo:
        _delta(guard, baseline_id)
    assert excinfo.value.code == CMP_TOOL_WORKTREE_BASELINE_NOT_FOUND


def test_expired_baseline_returns_0043(tmp_path: Path) -> None:
    _repo(tmp_path)
    guard = WorkspaceGuard(str(tmp_path))
    baseline_id = _baseline(guard)
    tracking._BASELINES[baseline_id].created_at -= tracking.BASELINE_TTL_SECONDS + 1
    with pytest.raises(ToolExecutionFailure) as excinfo:
        _delta(guard, baseline_id)
    assert excinfo.value.code == CMP_TOOL_WORKTREE_BASELINE_NOT_FOUND


def test_baseline_capacity_evicts_oldest_entry(tmp_path: Path) -> None:
    for index in range(tracking.MAX_BASELINES + 1):
        snapshot = tracking.WorktreeSnapshot(
            repo_root=tmp_path / f"repo-{index}", head="head", branch="main", status={}
        )
        baseline_id = f"baseline-{index}"
        baseline = tracking.WorktreeBaseline(
            baseline_id=baseline_id,
            session_id="session",
            created_at=float(index),
            initial=snapshot,
            last_observed=snapshot,
        )
        tracking._BASELINES[baseline_id] = baseline
        tracking._ACTIVE_BY_SESSION_REPO[("session", str(snapshot.repo_root).casefold())] = (
            baseline_id
        )
    tracking._evict_locked()
    assert len(tracking._BASELINES) == tracking.MAX_BASELINES
    assert "baseline-0" not in tracking._BASELINES


def test_operation_ledger_records_bounded_per_call_delta(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    baseline_id = _baseline(guard)

    def create_file():
        (repo / "created.txt").write_text("new\n", encoding="utf-8")
        return ToolHandlerResult(output="ok")

    result = tracking.run_with_worktree_observation(
        side_effecting=True,
        tool_name="write_file",
        arguments={"cwd": "repo", "_jenny_operation_id": "op_test"},
        workspace=guard,
        handler=create_file,
        logger=logging.getLogger(__name__),
    )

    observation = result.metadata["worktree_observation"]
    assert observation["operation_id"] == "op_test"
    assert observation["changed_paths"] == ["created.txt"]
    assert observation["changed_path_count"] == 1
    assert observation["changed_paths_truncated"] is False
    ledger = _delta(guard, baseline_id)["operation_ledger"]
    assert ledger[-1]["tool_name"] == "write_file"
    assert "arguments" not in ledger[-1]


def test_operation_ledger_bounds_changed_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _repo(tmp_path)
    guard = WorkspaceGuard(str(tmp_path))
    baseline_id = _baseline(guard)
    observation = tracking.begin_mutation_observation(
        tool_name="edit_file", arguments={"cwd": "repo"}, workspace=guard
    )
    assert observation is not None
    monkeypatch.setattr(
        tracking,
        "_changed_paths",
        lambda _before, _after: {f"path-{index:04d}.txt" for index in range(300)},
    )

    entry = tracking.finish_mutation_observation(
        observation, workspace=guard, arguments={"cwd": "repo"}
    )

    assert entry is not None
    assert entry["changed_path_count"] == 300
    assert entry["changed_paths_truncated"] is True
    assert len(entry["changed_paths"]) == tracking.MAX_OPERATION_LEDGER_PATHS
    assert _delta(guard, baseline_id)["operation_ledger"][-1] == entry


# TR-015 G5: a Python run_temp_script rewrote a tracked source file and nothing
# downstream (write-progress streak, edit surfaces) could tell it was a save.
def _run_shell(
    guard: WorkspaceGuard, handler: object, *, tool_name: str = "run_temp_script", **extra: object
) -> ToolHandlerResult:
    return tracking.run_with_worktree_observation(
        side_effecting=True,
        tool_name=tool_name,
        arguments={"cwd": "repo", **extra},
        workspace=guard,
        handler=lambda: (handler(), ToolHandlerResult(output="ok"))[1],
        logger=logging.getLogger(__name__),
    )


def test_a_foreground_script_that_edits_a_tracked_file_reports_workspace_changed(
    tmp_path: Path,
) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(guard, lambda: (repo / "tracked.txt").write_text("edited\n", "utf-8"))

    assert result.metadata["workspace_changed"] is True


def test_a_second_edit_to_an_already_dirty_file_still_counts(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    (repo / "tracked.txt").write_text("dirty\n", encoding="utf-8")

    result = _run_shell(
        guard,
        lambda: (repo / "tracked.txt").write_text("dirty and longer\n", "utf-8"),
        tool_name="run_command",
    )

    assert result.metadata["workspace_changed"] is True


def test_a_read_only_command_reports_no_change(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(guard, lambda: (repo / "tracked.txt").read_text("utf-8"))

    assert result.metadata["workspace_changed"] is False


def test_interpreter_caches_are_not_workspace_changes(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    def _cache_only() -> None:
        (repo / "__pycache__").mkdir()
        (repo / "__pycache__" / "mod.cpython-311.pyc").write_bytes(b"\0")
        (repo / ".pytest_cache").mkdir()
        (repo / ".pytest_cache" / "README.md").write_text("x", encoding="utf-8")

    result = _run_shell(guard, _cache_only)

    assert result.metadata["workspace_changed"] is False


def test_background_commands_and_non_shell_tools_carry_no_evidence(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    def _edit() -> None:
        (repo / "tracked.txt").write_text("edited\n", "utf-8")

    background = _run_shell(guard, _edit, tool_name="run_command", run_in_background=True)
    other = _run_shell(guard, _edit, tool_name="write_file")

    assert "workspace_changed" not in background.metadata
    assert "workspace_changed" not in other.metadata


def test_shell_change_evidence_kill_switch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, guard = _repo(tmp_path)
    monkeypatch.setenv(tracking.SHELL_CHANGE_EVIDENCE_FLAG, "0")

    result = _run_shell(guard, lambda: (repo / "tracked.txt").write_text("edited\n", "utf-8"))

    assert "workspace_changed" not in result.metadata


def test_a_workspace_without_git_carries_no_evidence(tmp_path: Path) -> None:
    (tmp_path / "repo").mkdir()
    guard = WorkspaceGuard(str(tmp_path))

    result = _run_shell(guard, lambda: (tmp_path / "repo" / "a.txt").write_text("x", "utf-8"))

    assert "workspace_changed" not in result.metadata


# Row 34 S1: scripted edits carry user-only review evidence (diffs plus a
# scripted_change_review record); the model sees one path-only line.
def _review(result: ToolHandlerResult) -> dict[str, object]:
    review = result.metadata["scripted_change_review"]
    assert isinstance(review, dict)
    return review


def test_python_execute_rewriting_a_dirty_tracked_file_yields_a_diff(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    (repo / "tracked.txt").write_text("dirty\n", encoding="utf-8")

    result = _run_shell(
        guard,
        lambda: (repo / "tracked.txt").write_text("dirty\nrewritten\n", "utf-8"),
        tool_name="python_execute",
    )

    assert result.metadata["workspace_changed"] is True
    diff = result.metadata["diffs"][0]
    assert diff["path"] == "tracked.txt"
    assert diff["status"] == "modified"
    assert diff["diff_id"].startswith("scripted:")
    assert "+rewritten" in diff["hunks"][0]["lines"]
    review = _review(result)
    assert review["schema_version"] == 1
    assert review["state"] == "observed"
    assert review["call_outcome"] == "succeeded"
    assert review["certainty"] == "observed_during_call"
    assert review["changed_paths"] == ["tracked.txt"]
    assert review["coverage"] == "git_status_paths"


def test_a_status_cap_breach_yields_an_unavailable_review(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, guard = _repo(tmp_path)
    (repo / "dirty.txt").write_text("x\n", encoding="utf-8")
    monkeypatch.setattr(tracking, "MAX_STATUS_PATHS", 0)

    result = _run_shell(guard, lambda: (repo / "tracked.txt").write_text("e\n", "utf-8"))

    review = _review(result)
    assert (review["state"], review["reason"]) == ("unavailable", "status_over_limit")
    assert "diffs" not in result.metadata
    assert "workspace_changed" not in result.metadata
    assert result.output == "ok"


def test_a_live_baseline_no_longer_suppresses_the_shell_probe(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    _baseline(guard)

    result = _run_shell(guard, lambda: (repo / "tracked.txt").write_text("edited\n", "utf-8"))

    assert result.metadata["workspace_changed"] is True
    assert result.metadata["diffs"][0]["path"] == "tracked.txt"
    assert result.metadata["worktree_observation"]["changed_paths"] == ["tracked.txt"]


def test_unobserved_calls_say_why_instead_of_reporting_no_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, guard = _repo(tmp_path)

    def edit() -> None:
        (repo / "tracked.txt").write_text("edited\n", "utf-8")

    background = _run_shell(guard, edit, tool_name="run_command", run_in_background=True)
    plain_root = tmp_path / "plain"
    (plain_root / "repo").mkdir(parents=True)
    non_git = _run_shell(WorkspaceGuard(str(plain_root)), edit)
    no_root = _run_shell(WorkspaceGuard(None), edit, tool_name="python_execute")
    monkeypatch.setenv(tracking.SHELL_CHANGE_EVIDENCE_FLAG, "0")
    disabled = _run_shell(guard, edit)

    observed = {
        name: (_review(result)["state"], _review(result)["reason"])
        for name, result in {
            "background": background, "non_git": non_git, "no_root": no_root, "disabled": disabled
        }.items()
    }
    assert observed == {
        "background": ("unavailable", "background"),
        "non_git": ("unsupported", "not_git"),
        "no_root": ("unsupported", "no_workspace"),
        "disabled": ("unavailable", "disabled"),
    }
    for result in (background, non_git, no_root, disabled):
        assert "diffs" not in result.metadata
        assert result.output == "ok"


def test_a_timed_out_command_maps_to_timed_out(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    def timed_out() -> ToolHandlerResult:
        (repo / "tracked.txt").write_text("half written\n", "utf-8")
        return ToolHandlerResult(output="timeout", success=False, metadata={"timed_out": True})

    result = tracking.run_with_worktree_observation(
        side_effecting=True, tool_name="run_command", arguments={"cwd": "repo"},
        workspace=guard, handler=timed_out, logger=logging.getLogger(__name__),
    )

    assert _review(result)["call_outcome"] == "timed_out"
    assert result.metadata["diffs"][0]["status"] == "modified"
    assert result.metadata["timed_out"] is True


# Row 34 S5 step 4: routing hands each scripted call the turn's restore point
# as a private ``_jenny_restore_point`` argument; it reaches the user-only
# review and never the model-facing output.
_RESTORE_POINT = {
    "kind": "git_checkpoint",
    "ref": "refs/jenny/checkpoints/sess-1/7",
    "created_at": "2026-10-05T12:00:00.000Z",
}


def test_a_scripted_edit_review_carries_the_restore_point(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(
        guard,
        lambda: (repo / "tracked.txt").write_text("edited\n", "utf-8"),
        tool_name="run_command",
        _jenny_restore_point=dict(_RESTORE_POINT),
    )

    assert _review(result)["restore_point"] == _RESTORE_POINT
    assert _RESTORE_POINT["ref"] not in result.output
    assert "restore_point" not in result.output


def test_an_unobserved_call_still_carries_the_restore_point(tmp_path: Path) -> None:
    (tmp_path / "repo").mkdir()
    guard = WorkspaceGuard(str(tmp_path))
    point = {"kind": "none", "reason": "not_git"}

    result = _run_shell(guard, lambda: None, tool_name="python_execute", _jenny_restore_point=point)

    review = _review(result)
    assert (review["state"], review["reason"]) == ("unsupported", "not_git")
    assert review["restore_point"] == point


def test_a_scripted_call_without_a_restore_point_reports_none(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    plain = _run_shell(guard, lambda: (repo / "tracked.txt").write_text("a\n", "utf-8"))
    malformed = _run_shell(
        guard,
        lambda: (repo / "tracked.txt").write_text("b\n", "utf-8"),
        _jenny_restore_point={"kind": "git_checkpoint", "ref": "refs/heads/main"},
    )

    assert "restore_point" not in _review(plain)
    assert "restore_point" not in _review(malformed)


def test_a_non_scripted_tool_never_gets_a_review_from_a_restore_point(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(
        guard,
        lambda: (repo / "tracked.txt").write_text("c\n", "utf-8"),
        tool_name="write_file",
        _jenny_restore_point=dict(_RESTORE_POINT),
    )

    assert "scripted_change_review" not in result.metadata
