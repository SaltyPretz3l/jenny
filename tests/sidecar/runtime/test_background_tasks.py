from __future__ import annotations

import subprocess
import threading

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.runtime.background_tasks import run_background_task
from sidecar.runtime.subprocess_manager import SubprocessManager


class _CapturingManager:
    def __init__(self) -> None:
        self.timeout_seconds: float | None = None

    def is_task_running(self, _task_key: str) -> bool:
        return False

    def spawn_json_worker(
        self,
        _task_name: str,
        _payload: dict[str, object],
        *,
        payload_dir,
        task_key: str,
        secrets: dict[str, object] | None = None,
        timeout_seconds: float | None = None,
    ) -> object:
        self.timeout_seconds = timeout_seconds
        return object()


def test_automation_dispatch_passes_normalized_budget_to_worker_deadline(tmp_path) -> None:
    runtime_root = tmp_path / "runtime"
    result_path = runtime_root / "automations" / "task" / "run.result.json"
    manager = _CapturingManager()

    result = run_background_task(
        task="automation_run",
        params={
            "run_id": "run_123",
            "result_path": str(result_path),
            "automation": {"run_id": "run_123", "runtime_budget_ms": 1_000},
        },
        config=RuntimeConfig(
            background_runtime_root=str(runtime_root),
            tools_automations_enabled=True,
        ),
        raw_config={},
        subprocess_manager=manager,
    )

    assert result["status"] == "started"
    assert manager.timeout_seconds == 30.0


def test_subprocess_deadline_terminates_over_budget_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deadline_fired = threading.Event()
    waits: list[float] = []
    terminations: list[tuple[str, float]] = []

    class _TimedOutProcess:
        def wait(self, timeout: float) -> None:
            waits.append(timeout)
            raise subprocess.TimeoutExpired("background-worker", timeout)

    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: _TimedOutProcess())

    def terminate_task(task_key: str, *, timeout_seconds: float):
        terminations.append((task_key, timeout_seconds))
        deadline_fired.set()

    monkeypatch.setattr(manager, "terminate_task", terminate_task)
    manager._watch_worker_deadline(  # noqa: SLF001
        _TimedOutProcess(),
        task_key="automation:run_123",
        timeout_seconds=0.01,
    )

    assert deadline_fired.wait(timeout=1)
    assert waits == [0.01]
    assert terminations == [("automation:run_123", 1.0)]
    manager.close()
