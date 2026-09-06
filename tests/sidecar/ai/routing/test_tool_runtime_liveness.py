from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.routing import tool_runtime_liveness


def test_liveness_snapshot_reports_each_active_runtime_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tool_runtime_liveness, "active_job_ids", lambda: ("job-1",))
    monkeypatch.setattr(
        tool_runtime_liveness,
        "current_operation_ledger",
        lambda: SimpleNamespace(pending_receipts=lambda: ([{"receipt_id": "op-1"}], 0)),
    )
    kernel = SimpleNamespace(
        _monitor_manager=SimpleNamespace(has_active_monitors=lambda: True),
    )

    snapshot = tool_runtime_liveness.snapshot_tool_runtime_liveness(kernel)

    assert snapshot.has_active_background_jobs is True
    assert snapshot.has_active_monitors is True
    assert snapshot.has_pending_operations is True


def test_liveness_probe_failure_degrades_closed_and_logs(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def _raise() -> tuple[str, ...]:
        raise OSError("unavailable")

    monkeypatch.setattr(tool_runtime_liveness, "active_job_ids", _raise)

    with caplog.at_level("WARNING", logger=tool_runtime_liveness.__name__):
        snapshot = tool_runtime_liveness.snapshot_tool_runtime_liveness(SimpleNamespace())

    assert snapshot.has_active_background_jobs is False
    assert snapshot.has_active_monitors is False
    assert snapshot.has_pending_operations is False
    assert any(
        getattr(record, "event", "") == "ai.router.tool_runtime_liveness_probe_failed"
        for record in caplog.records
    )
