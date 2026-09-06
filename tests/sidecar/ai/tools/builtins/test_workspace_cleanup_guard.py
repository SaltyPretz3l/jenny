"""Guarded cleanup regression coverage for workspace-local generated state."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins import workspace_cleanup as cleanup_module
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_store import DeleteOutcome, GuardedWorkspaceStore


def _make_junction(link: Path, target: Path) -> bool:
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        check=False,
        text=True,
    )
    return result.returncode == 0


def test_cleanup_noop_when_no_workspace_root() -> None:
    assert cleanup_module.cleanup_workspace_artifacts(None) == cleanup_module.CleanupResult()


def test_cleanup_noop_does_not_create_missing_jenny_dir(tmp_path: Path) -> None:
    result = cleanup_module.cleanup_workspace_artifacts(tmp_path)

    assert result == cleanup_module.CleanupResult()
    assert not (tmp_path / ".jenny").exists()


def test_cleanup_prunes_stale_tool_results_normally(tmp_path: Path) -> None:
    stale = tmp_path / ".jenny" / "tool-results" / "old-job"
    stale.mkdir(parents=True)
    (stale / "status.json").write_text("{}", encoding="utf-8")
    old_time = time.time() - cleanup_module.TOOL_RESULTS_MAX_AGE_SECONDS - 3600
    os.utime(stale / "status.json", (old_time, old_time))
    os.utime(stale, (old_time, old_time))

    result = cleanup_module.cleanup_workspace_artifacts(tmp_path)

    assert not stale.exists()
    assert result.tool_results_removed == 1


def test_cleanup_does_not_count_quarantined_delete_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stale = tmp_path / ".jenny" / "tool-results" / "old-job"
    stale.mkdir(parents=True)
    old_time = time.time() - cleanup_module.TOOL_RESULTS_MAX_AGE_SECONDS - 3600
    os.utime(stale, (old_time, old_time))

    monkeypatch.setattr(
        GuardedWorkspaceStore,
        "delete",
        lambda *_args, **_kwargs: DeleteOutcome(
            removed=False,
            quarantined=True,
            entries_removed=0,
        ),
    )

    result = cleanup_module.cleanup_workspace_artifacts(tmp_path)

    assert result.tool_results_removed == 0


def test_cleanup_never_deletes_artifact_sessions(tmp_path: Path) -> None:
    # WIDE-010: the sidecar cannot prove an artifact directory unreferenced
    # (Electron owns the persisted generated_artifacts references), so startup
    # cleanup must NEVER delete artifact session directories — regardless of
    # how many exist or how old their mtimes are. It only reports the count.
    artifacts = tmp_path / ".jenny" / "artifacts"
    artifacts.mkdir(parents=True)
    total = 25
    for index in range(total):
        session = artifacts / f"session-{index:02d}"
        session.mkdir()
        (session / "artifact.md").write_text("body", encoding="utf-8")
        os.utime(session, (100 + index, 100 + index))

    result = cleanup_module.cleanup_workspace_artifacts(tmp_path)

    survivors = sorted(entry.name for entry in artifacts.iterdir())
    assert survivors == [f"session-{index:02d}" for index in range(total)]
    assert result.artifact_sessions_found == total


def test_cleanup_isolates_tool_result_failure_from_artifact_report(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_tool_results(_store: GuardedWorkspaceStore) -> int:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="simulated",
            retryable=True,
        )

    monkeypatch.setattr(
        cleanup_module,
        "_prune_stale_tool_results",
        fail_tool_results,
    )
    monkeypatch.setattr(cleanup_module, "_report_artifact_sessions", lambda _store: 2)

    result = cleanup_module.cleanup_workspace_artifacts(tmp_path)

    assert result.tool_results_removed == 0
    assert result.artifact_sessions_found == 2


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_cleanup_quarantines_junctioned_tool_results_root(tmp_path: Path) -> None:
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    sentinel = outside / "keep.txt"
    sentinel.write_text("keep", encoding="utf-8")
    jenny = tmp_path / ".jenny"
    jenny.mkdir()
    junction = jenny / "tool-results"
    if not _make_junction(junction, outside):
        pytest.skip("mklink /J not permitted in this environment")

    result = cleanup_module.cleanup_workspace_artifacts(tmp_path)

    assert result.tool_results_removed == 0
    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert not junction.exists()
    quarantined = [
        entry for entry in (jenny / "quarantine").iterdir() if "tool-results" in entry.name
    ]
    assert len(quarantined) == 1
    os.rmdir(quarantined[0])


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_cleanup_quarantines_junction_child_without_deleting_target(tmp_path: Path) -> None:
    results = tmp_path / ".jenny" / "tool-results"
    results.mkdir(parents=True)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    sentinel = outside / "keep.txt"
    sentinel.write_text("keep", encoding="utf-8")
    junction = results / "old-job"
    if not _make_junction(junction, outside):
        pytest.skip("mklink /J not permitted in this environment")

    cleanup_module.cleanup_workspace_artifacts(tmp_path)

    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert not junction.exists()
    quarantined = [
        entry for entry in (tmp_path / ".jenny" / "quarantine").iterdir()
        if "old-job" in entry.name
    ]
    assert len(quarantined) == 1
    os.rmdir(quarantined[0])
