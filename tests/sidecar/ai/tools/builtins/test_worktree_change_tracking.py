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
    tracking._reset_worktree_tracking_for_tests()  # noqa: SLF001


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
    original_capture = tracking._capture_repo  # noqa: SLF001
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
    tracking._reset_worktree_tracking_for_tests()  # noqa: SLF001
    with pytest.raises(ToolExecutionFailure) as excinfo:
        _delta(guard, baseline_id)
    assert excinfo.value.code == CMP_TOOL_WORKTREE_BASELINE_NOT_FOUND


def test_expired_baseline_returns_0043(tmp_path: Path) -> None:
    _repo(tmp_path)
    guard = WorkspaceGuard(str(tmp_path))
    baseline_id = _baseline(guard)
    tracking._BASELINES[baseline_id].created_at -= tracking.BASELINE_TTL_SECONDS + 1  # noqa: SLF001
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
        tracking._BASELINES[baseline_id] = baseline  # noqa: SLF001
        tracking._ACTIVE_BY_SESSION_REPO[("session", str(snapshot.repo_root).casefold())] = (  # noqa: SLF001
            baseline_id
        )
    tracking._evict_locked()  # noqa: SLF001
    assert len(tracking._BASELINES) == tracking.MAX_BASELINES  # noqa: SLF001
    assert "baseline-0" not in tracking._BASELINES  # noqa: SLF001


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
