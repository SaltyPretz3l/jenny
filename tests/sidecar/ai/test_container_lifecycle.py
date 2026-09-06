from __future__ import annotations

import threading

from sidecar.ai.container_lifecycle import StackGenerationOwner


def test_retired_stack_closes_once_after_final_generation_lease() -> None:
    closed: list[object] = []
    owner = StackGenerationOwner(closed.append)
    old_stack = object()
    new_stack = object()
    entered = threading.Event()
    release = threading.Event()
    observed: list[object] = []

    owner.publish(old_stack)

    def _hold_old_generation() -> None:
        with owner.lease() as leased:
            observed.append(leased)
            entered.set()
            assert release.wait(timeout=2.0)
            observed.append(owner.current_stack)

    worker = threading.Thread(target=_hold_old_generation)
    worker.start()
    assert entered.wait(timeout=2.0)

    owner.publish(new_stack)
    assert owner.current_stack is new_stack
    assert closed == []

    release.set()
    worker.join(timeout=3.0)

    assert observed == [old_stack, old_stack]
    assert closed == [old_stack]
    owner.retire_all()
    owner.retire_all()
    assert closed == [old_stack, new_stack]
