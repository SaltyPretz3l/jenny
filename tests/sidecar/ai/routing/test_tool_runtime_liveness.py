from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.routing import tool_runtime_liveness
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore


def test_liveness_snapshot_reports_each_active_runtime_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tool_runtime_liveness, "active_job_ids", lambda **_kwargs: ("job-1",))
    monkeypatch.setattr(
        tool_runtime_liveness,
        "current_operation_ledger",
        lambda: SimpleNamespace(pending_receipts=lambda: ([{"receipt_id": "op-1"}], 0)),
    )
    kernel = SimpleNamespace(
        _config=SimpleNamespace(tools_workspace_root=str(tmp_path)),
        _monitor_manager=SimpleNamespace(has_active_monitors=lambda: True),
    )

    snapshot = tool_runtime_liveness.snapshot_tool_runtime_liveness(kernel)

    assert snapshot.has_active_background_jobs is True
    assert snapshot.has_active_monitors is True
    assert snapshot.has_pending_operations is True


def test_liveness_scopes_background_jobs_to_the_request_workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root_a = tmp_path / "a"
    root_b = tmp_path / "b"
    root_a.mkdir()
    root_b.mkdir()
    key_a = GuardedWorkspaceStore(root_a).cache_key
    seen: list[str | None] = []

    def _active_job_ids(*, store_key: str | None = None) -> list[str]:
        seen.append(store_key)
        return ["job-1"] if store_key == key_a else []

    monkeypatch.setattr(tool_runtime_liveness, "active_job_ids", _active_job_ids)
    monkeypatch.setattr(tool_runtime_liveness, "current_operation_ledger", lambda: None)

    def _kernel(root: Path | None) -> SimpleNamespace:
        return SimpleNamespace(
            _config=SimpleNamespace(tools_workspace_root=str(root) if root else None)
        )

    snapshot = tool_runtime_liveness.snapshot_tool_runtime_liveness
    assert snapshot(_kernel(root_a)).has_active_background_jobs is True
    # Another workspace's job is invisible here: it cannot be checked or stopped.
    assert snapshot(_kernel(root_b)).has_active_background_jobs is False
    # The request's execution root outranks the process-wide config root.
    request_context = SimpleNamespace(
        execution_context=SimpleNamespace(root_path=str(root_a))
    )
    assert (
        snapshot(_kernel(root_b), request_context=request_context).has_active_background_jobs
        is True
    )
    # Without a workspace nothing can own a job, and the registry is never
    # asked for every workspace's jobs.
    assert snapshot(_kernel(None)).has_active_background_jobs is False
    assert None not in seen


def test_liveness_probe_failure_degrades_closed_and_logs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def _raise(**_kwargs: object) -> tuple[str, ...]:
        raise OSError("unavailable")

    monkeypatch.setattr(tool_runtime_liveness, "active_job_ids", _raise)
    kernel = SimpleNamespace(_config=SimpleNamespace(tools_workspace_root=str(tmp_path)))

    with caplog.at_level("WARNING", logger=tool_runtime_liveness.__name__):
        snapshot = tool_runtime_liveness.snapshot_tool_runtime_liveness(kernel)

    assert snapshot.has_active_background_jobs is False
    assert snapshot.has_active_monitors is False
    assert snapshot.has_pending_operations is False
    assert any(
        getattr(record, "event", "") == "ai.router.tool_runtime_liveness_probe_failed"
        for record in caplog.records
    )
