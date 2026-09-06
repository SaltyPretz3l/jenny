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

import pytest

from sidecar.ai.tools.builtins.owned_process import (
    OwnedProcessCapacityError,
    OwnedProcessService,
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
