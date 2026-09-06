"""Per-task containment policy, and the termination receipt it underwrites.

Every policy case is deterministic on any OS: containment is injected through
``SubprocessManager(containment_factory=...)`` and processes through
``popen_factory``, so no Job Object, no real pid and no Windows box is involved.
That is deliberate - the behaviour being pinned (fail closed for the GPU worker,
fail open but *loudly* for background notes) has to hold on CI too, and a test
that only runs on one platform cannot defend it.

The two things a fake cannot vouch for - the POSIX group logic and the Win32 ABI
- live in ``test_process_containment.py``, because a job that reports success and
contains nothing is exactly the failure a stubbed containment would agree with.
"""

from __future__ import annotations

import logging
import subprocess
import threading
from typing import Any

import pytest

import sidecar.runtime.subprocess_manager as subprocess_manager_module
from sidecar.runtime.process_containment import (
    ContainmentPolicy,
    ContainmentUnavailableError,
)
from sidecar.runtime.subprocess_manager import (
    SubprocessManager,
    TaskAlreadyRunningError,
)

DEGRADED_EVENT = "sidecar.runtime.containment_degraded"


class FakeContainment:
    """Deterministic ``ChildContainment`` stand-in with no kernel objects.

    Shared with ``test_subprocess_manager.py``, which installs it as the default
    factory so its fabricated pids never reach a real Job Object.
    """

    kind = "fake"

    def __init__(  # noqa: PLR0913 - one knob per containment failure mode
        self,
        *,
        policy: ContainmentPolicy | None = None,
        spawn_kwargs: dict[str, Any] | None = None,
        assign_error: BaseException | None = None,
        verify_result: bool = True,
        surviving: tuple[int, ...] = (),
        reap_on_kill_tree: bool = True,
    ) -> None:
        self.policy = policy
        self.spawn_kwargs_value = dict(spawn_kwargs or {})
        self.assign_error = assign_error
        self.verify_result = verify_result
        self.reap_on_kill_tree = reap_on_kill_tree
        self._surviving = tuple(surviving)
        self.pid = 0
        self.assigned = False
        self.verify_calls = 0
        self.kill_tree_calls = 0
        self.closed = False

    def popen_kwargs(self) -> dict[str, Any]:
        return dict(self.spawn_kwargs_value)

    def assign(self, pid: int) -> None:
        self.pid = int(pid)
        if self.assign_error is not None:
            raise self.assign_error
        self.assigned = True

    def verify(self) -> bool:
        self.verify_calls += 1
        return bool(self.verify_result)

    def surviving_pids(self) -> tuple[int, ...]:
        return self._surviving

    def is_empty(self) -> bool:
        return not self._surviving

    def kill_tree(self) -> None:
        self.kill_tree_calls += 1
        if self.reap_on_kill_tree:
            self._surviving = ()

    def close(self) -> None:
        self.closed = True


class FakeProcess:
    """Popen stand-in that records terminate/kill and can be resolved by hand."""

    def __init__(self, pid: int = 9001, *, dies_on_signal: bool = True) -> None:
        self.pid = pid
        self.returncode: int | None = None
        self.terminated = False
        self.killed = False
        self._dies_on_signal = dies_on_signal
        self._exited = threading.Event()

    def poll(self) -> int | None:
        return self.returncode if self._exited.is_set() else None

    def wait(self, timeout: float | None = None) -> int:
        if timeout is not None and not self._exited.wait(timeout):
            raise subprocess.TimeoutExpired("fake", timeout)
        self._exited.wait()
        return self.returncode if self.returncode is not None else 0

    def terminate(self) -> None:
        self.terminated = True
        if self._dies_on_signal:
            self.finish(0)

    def kill(self) -> None:
        self.killed = True
        if self._dies_on_signal:
            self.finish(-9)

    def finish(self, returncode: int = 0) -> None:
        self.returncode = returncode
        self._exited.set()


def _manager(
    process: FakeProcess | None,
    containment: FakeContainment | ContainmentUnavailableError | None,
    *,
    spawned: list[list[str]] | None = None,
) -> SubprocessManager:
    def popen_factory(command, **_kwargs):
        if spawned is not None:
            spawned.append(list(command))
        if process is None:
            raise AssertionError("popen_factory must not be called")
        return process

    def containment_factory(*, policy: ContainmentPolicy):
        if isinstance(containment, BaseException):
            raise containment
        if containment is not None:
            containment.policy = policy
        return containment

    return SubprocessManager(
        popen_factory=popen_factory,
        containment_factory=containment_factory,
    )


def degraded_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if getattr(record, "event", "") == DEGRADED_EVENT
    ]


# ---------------------------------------------------------------------------
# BEST_EFFORT (spawn_module / background notes): fails open, but audibly
# ---------------------------------------------------------------------------


def test_best_effort_failure_still_spawns_and_warns(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The no-regression gate for note-writing on hosts without containment."""
    process = FakeProcess()
    manager = _manager(process, ContainmentUnavailableError("nope", stage="create"))

    with caplog.at_level(logging.WARNING):
        manager.spawn_module("sidecar.runtime.background_worker", task_key="notes")

    assert manager.is_task_running("notes") is True
    records = degraded_records(caplog)
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    assert records[0].data["stage"] == "create"
    assert records[0].data["task_key"] == "notes"
    process.finish()
    manager.close()


def test_best_effort_assign_failure_warns_and_keeps_the_child(
    caplog: pytest.LogCaptureFixture,
) -> None:
    process = FakeProcess()
    containment = FakeContainment(
        assign_error=ContainmentUnavailableError("assign refused", stage="assign")
    )
    manager = _manager(process, containment)

    with caplog.at_level(logging.WARNING):
        manager.spawn_module("sidecar.runtime.background_worker", task_key="notes")

    assert manager.is_task_running("notes") is True
    assert containment.closed is True, "a half-built containment must be released"
    assert [record.data["stage"] for record in degraded_records(caplog)] == ["assign"]
    process.finish()
    manager.close()


def test_best_effort_verify_failure_warns_at_the_verify_stage(
    caplog: pytest.LogCaptureFixture,
) -> None:
    process = FakeProcess()
    manager = _manager(process, FakeContainment(verify_result=False))

    with caplog.at_level(logging.WARNING):
        manager.spawn_module("sidecar.runtime.background_worker", task_key="notes")

    assert manager.is_task_running("notes") is True
    assert [record.data["stage"] for record in degraded_records(caplog)] == ["verify"]
    process.finish()
    manager.close()


def test_successful_containment_emits_no_degraded_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    process = FakeProcess()
    manager = _manager(process, FakeContainment())

    with caplog.at_level(logging.WARNING):
        manager.spawn_module("sidecar.runtime.background_worker", task_key="notes")

    assert degraded_records(caplog) == []
    process.finish()
    manager.close()


# ---------------------------------------------------------------------------
# TerminationReceipt
# ---------------------------------------------------------------------------


def test_containment_verify_budget_is_two_seconds() -> None:
    """Pinned: long enough for a kernel unwind, short enough to still be a bound."""
    assert subprocess_manager_module._CONTAINMENT_VERIFY_SECONDS == 2.0  # noqa: SLF001


def test_receipt_is_terminated_when_root_reaped_and_tree_empty() -> None:
    process = FakeProcess()
    containment = FakeContainment()
    manager = _manager(process, containment)
    manager.spawn_module("worker", task_key="imagegen:op")

    receipt = manager.terminate_task("imagegen:op", timeout_seconds=0.5)

    assert receipt.known is True
    assert receipt.reaped is True
    assert receipt.contained is True
    assert receipt.tree_empty is True
    assert receipt.terminated is True
    assert bool(receipt) is True
    assert receipt.escalated == "terminate"
    assert receipt.surviving_pids == ()
    assert manager.is_task_running("imagegen:op") is False
    manager.close()


def test_receipt_is_unterminated_when_the_tree_survives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The receipt has to be able to say no.

    Killing the root proves nothing on Windows: compile workers and CUDA
    helpers outlive it. A survivor list is the difference between a reported
    cancel and an actual one.
    """
    monkeypatch.setattr(
        subprocess_manager_module, "_CONTAINMENT_VERIFY_SECONDS", 0.05
    )
    process = FakeProcess()
    containment = FakeContainment(surviving=(4242, 4243), reap_on_kill_tree=False)
    manager = _manager(process, containment)
    manager.spawn_module("worker", task_key="imagegen:op")

    receipt = manager.terminate_task("imagegen:op", timeout_seconds=0.01)

    assert receipt.terminated is False
    assert bool(receipt) is False
    assert receipt.tree_empty is False
    assert receipt.escalated == "kill_tree"
    assert receipt.surviving_pids == (4242, 4243)
    assert containment.kill_tree_calls == 1
    # The key stays occupied: an unproven tree must not be replaced by a second
    # worker racing it for the same device.
    assert "imagegen:op" in manager._children  # noqa: SLF001
    with pytest.raises(TaskAlreadyRunningError) as excinfo:
        manager.spawn_module("worker", task_key="imagegen:op")
    assert excinfo.value.task_key == "imagegen:op"

    containment._surviving = ()  # noqa: SLF001 - let the manager close cleanly
    manager.close()


def test_kill_tree_is_the_last_rung_when_the_root_outlives_kill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        subprocess_manager_module, "_CONTAINMENT_VERIFY_SECONDS", 0.5
    )
    process = FakeProcess(dies_on_signal=False)
    containment = FakeContainment(surviving=(9001,))

    def reap_everything() -> None:
        process.finish(-9)

    original_kill_tree = containment.kill_tree

    def kill_tree() -> None:
        original_kill_tree()
        reap_everything()

    containment.kill_tree = kill_tree  # type: ignore[method-assign]
    manager = _manager(process, containment)
    manager.spawn_module("worker", task_key="imagegen:op")

    receipt = manager.terminate_task("imagegen:op", timeout_seconds=0.01)

    assert process.terminated is True
    assert process.killed is True
    assert containment.kill_tree_calls == 1
    assert receipt.escalated == "kill_tree"
    assert receipt.terminated is True
    manager.close()


def test_receipt_for_an_unknown_key_is_known_false_but_terminated() -> None:
    """Keys are removed only after proven reaping, so unknown means nothing runs."""
    manager = _manager(None, FakeContainment())

    receipt = manager.terminate_task("never-started")

    assert receipt.known is False
    assert receipt.terminated is True
    assert bool(receipt) is True
    assert receipt.contained is False
    assert receipt.escalated == ""
    manager.close()


def test_a_concurrent_waiter_cannot_downgrade_the_receipt_to_unverified() -> None:
    """The waiter thread reaps in parallel; it must not blank the receipt.

    ``_finalize_child`` closes the containment as soon as the root exits, and it
    routinely wins this race. Before the ``terminating`` claim, every receipt
    built afterwards read ``child.containment`` as ``None`` and reported
    ``contained=False`` with a ``tree_empty`` taken from the UNCONTAINED
    fallback - which on Windows has no descendant evidence at all and answers
    ``True``. That turned the one field the GPU lease release depends on into a
    fail-open, and only a real-kernel run could see it.
    """
    holder: dict[str, Any] = {}

    class FinalizingProcess(FakeProcess):
        """Exits AND finalizes in the same step, deterministically.

        The real waiter thread does this on its own schedule; forcing the
        interleaving here means the test pins the invariant rather than the
        scheduler.
        """

        def terminate(self) -> None:
            super().terminate()
            manager = holder["manager"]
            manager._finalize_child("race", expected_child=holder["child"])  # noqa: SLF001

    process = FinalizingProcess()
    containment = FakeContainment()
    manager = _manager(process, containment)
    holder["manager"] = manager
    try:
        manager.spawn_module("worker", task_key="race")
        child = manager._children["race"]  # noqa: SLF001
        holder["child"] = child

        receipt = manager.terminate_task("race", timeout_seconds=1.0)

        assert containment.closed is True, "the claim is released, not leaked"

        assert receipt.contained is True
        assert receipt.tree_empty is True
        assert receipt.terminated is True
    finally:
        manager.close(timeout_seconds=1.0)
