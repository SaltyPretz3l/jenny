from __future__ import annotations

import subprocess
import threading
from typing import Any

from sidecar.runtime.subprocess_manager import SubprocessManager


class _Process:
    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.returncode: int | None = None
        self._exited = threading.Event()

    def poll(self) -> int | None:
        return self.returncode if self._exited.is_set() else None

    def wait(self, timeout: float | None = None) -> int:
        if not self._exited.wait(timeout):
            raise subprocess.TimeoutExpired("fake", timeout)
        return int(self.returncode or 0)

    def terminate(self) -> None:
        self.finish()

    def kill(self) -> None:
        self.finish(-9)

    def finish(self, returncode: int = 0) -> None:
        self.returncode = returncode
        self._exited.set()


class _CloseTrackingContainment:
    def __init__(self) -> None:
        self.close_calls = 0

    def popen_kwargs(self) -> dict[str, Any]:
        return {}

    def assign(self, _pid: int) -> None:
        return None

    def verify(self) -> bool:
        return True

    def is_empty(self) -> bool:
        return True

    def close(self) -> None:
        self.close_calls += 1


def test_reaped_same_key_replacement_closes_stale_containment_once() -> None:
    first_process = _Process(1001)
    second_process = _Process(1002)
    processes = iter([first_process, second_process])
    containments: list[_CloseTrackingContainment] = []
    waiter_gate = threading.Event()

    def containment_factory(**_kwargs: Any) -> _CloseTrackingContainment:
        containment = _CloseTrackingContainment()
        containments.append(containment)
        return containment

    manager = SubprocessManager(
        popen_factory=lambda *_args, **_kwargs: next(processes),
        containment_factory=containment_factory,
    )
    original_wait_for_exit = manager._wait_for_exit  # noqa: SLF001

    def delayed_wait(child: Any) -> None:
        assert waiter_gate.wait(1.0)
        original_wait_for_exit(child)

    manager._wait_for_exit = delayed_wait  # type: ignore[method-assign]  # noqa: SLF001

    try:
        manager.spawn_module("sidecar.runtime.background_worker", task_key="reused")
        first_process.finish()
        manager.spawn_module("sidecar.runtime.background_worker", task_key="reused")

        assert containments[0].close_calls == 1
    finally:
        second_process.finish()
        waiter_gate.set()
        manager.close()
    assert containments[0].close_calls == 1
