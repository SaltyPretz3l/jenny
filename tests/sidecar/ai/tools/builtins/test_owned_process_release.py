"""Release-after-direct-reap contract for ``OwnedProcessService``.

The monitor manager reaps its root process with a direct ``process.wait()``
instead of ``OwnedProcessService.wait``; ``release`` is the path that frees
its capacity lease without ever signalling the reaped (possibly recycled)
PID. Regression gate for the clean-exit lease leak that exhausted the
service's ``max_active`` slots after enough completed monitors.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins.owned_process import (
    OwnedProcess,
    OwnedProcessCapacityError,
    OwnedProcessService,
)
from sidecar.ai.tools.builtins.owned_process_settlement import (
    CleanupObservation,
    OwnedProcessCleanupVerdict,
)


def test_release_frees_capacity_after_direct_reap(tmp_path: Path) -> None:
    service = OwnedProcessService(max_active=1, max_queued=0)
    owned = service.spawn(
        [sys.executable, "-c", "print('done')"], cwd=tmp_path, allow_queue=False
    )
    assert owned.process.wait(timeout=10) == 0

    # The lease is still held after the direct reap: a second spawn must be
    # refused until release frees it.
    with pytest.raises(OwnedProcessCapacityError):
        service.spawn([sys.executable, "-c", "pass"], cwd=tmp_path, allow_queue=False)

    service.release(owned)
    assert service.snapshot().active == 0

    replacement = service.spawn(
        [sys.executable, "-c", "print('ok')"], cwd=tmp_path, allow_queue=False
    )
    try:
        assert replacement.process.wait(timeout=10) == 0
    finally:
        service.release(replacement)
    assert service.snapshot().active == 0


def test_release_is_idempotent_and_closes_containment(tmp_path: Path) -> None:
    service = OwnedProcessService(max_active=1, max_queued=0)
    owned = service.spawn([sys.executable, "-c", "pass"], cwd=tmp_path, allow_queue=False)
    owned.process.wait(timeout=10)

    service.release(owned)
    service.release(owned)  # a second release is a no-op, never a double-free

    assert service.snapshot().active == 0
    assert owned.job_object is None


def test_foreground_result_reports_owner_confirmed_cleanup(tmp_path: Path) -> None:
    observed = []
    service = OwnedProcessService(max_active=1, max_queued=0)

    result = service.run(
        [sys.executable, "-c", "print('done')"],
        cwd=tmp_path,
        timeout_seconds=10,
        on_cleanup=observed.append,
    )

    assert result.cleanup_verdict.cleanup == "confirmed"
    assert result.cleanup_verdict.process_tree_terminated is True
    assert result.cleanup_verdict.output_readers_terminated is True
    assert observed == [result.cleanup_verdict]
    assert service.snapshot().active == 0


def test_wait_returns_the_same_cleanup_verdict_it_publishes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    uncertain = OwnedProcessCleanupVerdict(
        cleanup="uncertain",
        process_tree_terminated=True,
        output_readers_terminated=False,
        reason="output_reader_termination_unconfirmed",
    )
    confirmed = OwnedProcessCleanupVerdict(
        cleanup="confirmed",
        process_tree_terminated=True,
        output_readers_terminated=True,
    )
    observed = []
    service = OwnedProcessService(max_active=1, max_queued=0)
    finalize_calls = 0

    def _finalize(owned: OwnedProcess) -> OwnedProcessCleanupVerdict:
        nonlocal finalize_calls
        finalize_calls += 1
        verdict = uncertain if finalize_calls == 1 else confirmed
        owned._cleanup_observation.publish(verdict)  # noqa: SLF001
        return verdict

    monkeypatch.setattr(service, "_finalize", _finalize)

    result = service.run(
        [sys.executable, "-c", "print('done')"],
        cwd=tmp_path,
        timeout_seconds=10,
        on_cleanup=observed.append,
    )

    assert finalize_calls == 1
    assert result.cleanup_verdict == uncertain
    assert observed == [uncertain]


def test_uncertain_cleanup_quarantines_capacity_until_owner_retry_confirms() -> None:
    class _Job:
        provable = False
        closed = False

        def assigned_process_ids(self) -> tuple[int, ...]:
            if not self.provable:
                raise OSError("query unavailable")
            return ()

        def terminate_tree(self) -> bool:
            return True

        def close(self) -> None:
            self.closed = True

    class _Reader:
        alive = True

        def is_alive(self) -> bool:
            return self.alive

        def join(self, timeout: float) -> None:
            del timeout

    service = OwnedProcessService(max_active=1, max_queued=0)
    lease = service._acquire_capacity(  # noqa: SLF001 - construct owned test fixture.
        allow_queue=False, timeout_seconds=0
    )
    job = _Job()
    reader = _Reader()
    observed = []
    owned = OwnedProcess(
        process=SimpleNamespace(  # type: ignore[arg-type]
            pid=42,
            poll=lambda: 0,
            stdout=None,
            stderr=None,
        ),
        args=("fake",),
        containment="windows_job_object_bootstrap",
        process_group_id=None,
        job_object=job,  # type: ignore[arg-type]
        _service=service,
        _lease=lease,
        _cleanup_observation=CleanupObservation(observed.append),
        _output_readers=(reader,),  # type: ignore[arg-type]
    )
    with service._condition:  # noqa: SLF001 - mirror spawn registration.
        service._active[id(owned)] = owned  # noqa: SLF001

    first = service.release(owned)
    repeated = service.release(owned)

    assert first.cleanup == repeated.cleanup == "uncertain"
    assert first.process_tree_terminated is False
    assert first.output_readers_terminated is False
    assert service.snapshot().active == 1
    assert observed == [first]
    with pytest.raises(OwnedProcessCapacityError):
        service._acquire_capacity(allow_queue=False, timeout_seconds=0)  # noqa: SLF001

    job.provable = True
    reader.alive = False
    retried = service.retry_quarantined_cleanup()

    assert len(retried) == 1
    assert retried[0].cleanup == "confirmed"
    assert job.closed is True
    assert service.snapshot().active == 0
    assert [verdict.cleanup for verdict in observed] == ["uncertain", "confirmed"]
    assert service.retry_quarantined_cleanup() == ()
