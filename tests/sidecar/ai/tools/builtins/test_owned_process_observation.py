"""Request-local owned-process cleanup aggregation tests."""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

from sidecar.ai.tools.builtins.owned_process_observation import (
    MAX_OBSERVED_CHILDREN,
    create_process_cleanup_observer,
    observe_owned_process_invocation,
)
from sidecar.ai.tools.builtins.owned_process_settlement import OwnedProcessCleanupVerdict

CONFIRMED = OwnedProcessCleanupVerdict(
    cleanup="confirmed",
    process_tree_terminated=True,
    output_readers_terminated=True,
)
UNCERTAIN = OwnedProcessCleanupVerdict(
    cleanup="uncertain",
    process_tree_terminated=True,
    output_readers_terminated=False,
    reason="reader_thread_alive",
)


def test_all_children_must_publish_confirmed_cleanup() -> None:
    with observe_owned_process_invocation("git_diff") as observation:
        first = create_process_cleanup_observer()
        second = create_process_cleanup_observer()
        assert first is not None and second is not None
        first(CONFIRMED)
        second(UNCERTAIN)

    assert observation.resource_cleanup() == {
        "cleanup": "uncertain",
        "process_tree_terminated": True,
        "output_readers_terminated": False,
        "reason": "reader_thread_alive",
    }
    second(CONFIRMED)
    assert observation.resource_cleanup() == CONFIRMED.metadata()


def test_aggregate_uncertainty_downgrades_preexisting_confirmed_metadata() -> None:
    with observe_owned_process_invocation("run_command") as observation:
        first = create_process_cleanup_observer()
        second = create_process_cleanup_observer()
        assert first is not None and second is not None
        first(CONFIRMED)
        second(UNCERTAIN)
    metadata: dict[str, object] = {"resource_cleanup": CONFIRMED.metadata(), "kept": True}

    observation.add_metadata(metadata)

    assert metadata == {
        "resource_cleanup": {
            "cleanup": "uncertain",
            "process_tree_terminated": True,
            "output_readers_terminated": False,
            "reason": "reader_thread_alive",
        },
        "kept": True,
    }


def test_confirmed_aggregate_does_not_upgrade_invalid_existing_metadata() -> None:
    with observe_owned_process_invocation("git_status") as observation:
        callback = create_process_cleanup_observer()
        assert callback is not None
        callback(CONFIRMED)
    invalid = {"cleanup": "confirmed"}
    metadata: dict[str, object] = {"resource_cleanup": invalid}

    observation.add_metadata(metadata)

    assert metadata["resource_cleanup"] is invalid


def test_concurrent_invocations_keep_distinct_child_sets() -> None:
    barrier = threading.Barrier(2)

    def observe_child(publish: bool) -> dict[str, object] | None:
        with observe_owned_process_invocation("probe") as observation:
            barrier.wait()
            callback = create_process_cleanup_observer()
            assert callback is not None
            if publish:
                callback(CONFIRMED)
            barrier.wait()
        return observation.resource_cleanup()

    with ThreadPoolExecutor(max_workers=2) as executor:
        confirmed = executor.submit(observe_child, True)
        pending = executor.submit(observe_child, False)

    assert confirmed.result() == CONFIRMED.metadata()
    assert pending.result() == {
        "cleanup": "uncertain",
        "process_tree_terminated": False,
        "output_readers_terminated": False,
        "reason": "child_cleanup_pending",
    }


def test_zero_child_proof_is_limited_to_inventoried_tools() -> None:
    with observe_owned_process_invocation("git_status") as trusted:
        pass
    with observe_owned_process_invocation("unknown_native_tool") as unknown:
        pass

    assert trusted.resource_cleanup() == {
        "cleanup": "confirmed",
        "process_tree_terminated": True,
        "output_readers_terminated": True,
        "reason": "no_native_process_started",
    }
    assert unknown.resource_cleanup() is None


def test_observation_overflow_stays_uncertain() -> None:
    with observe_owned_process_invocation("git_diff") as observation:
        callbacks = [
            create_process_cleanup_observer() for _index in range(MAX_OBSERVED_CHILDREN + 1)
        ]
        for callback in callbacks:
            assert callback is not None
            callback(CONFIRMED)

    assert observation.resource_cleanup() == {
        "cleanup": "uncertain",
        "process_tree_terminated": False,
        "output_readers_terminated": False,
        "reason": "child_observation_overflow",
    }
