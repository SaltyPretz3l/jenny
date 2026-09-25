"""Request-local aggregation of cleanup proof from owned native processes."""

from __future__ import annotations

import threading
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar

from sidecar.ai.tools.builtins.owned_process_settlement import (
    CleanupObserver,
    OwnedProcessCleanupVerdict,
)

MAX_OBSERVED_CHILDREN = 256
_NO_CHILD_PROOF_TOOLS = frozenset(
    {
        "git_diff",
        "git_log",
        "git_show",
        "git_status",
        "workspace_change_baseline",
        "workspace_change_delta",
        "workspace_manifest_read",
    }
)
_current_observation: ContextVar[OwnedProcessInvocationObservation | None] = ContextVar(
    "owned_process_invocation_observation", default=None
)


def _is_confirmed_cleanup(value: object) -> bool:
    return (
        isinstance(value, Mapping)
        and set(value) == {
            "cleanup",
            "process_tree_terminated",
            "output_readers_terminated",
            "reason",
        }
        and value.get("cleanup") == "confirmed"
        and value.get("process_tree_terminated") is True
        and value.get("output_readers_terminated") is True
        and (value.get("reason") is None or isinstance(value.get("reason"), str))
    )


class OwnedProcessInvocationObservation:
    """Bounded child registrations and their latest owner cleanup verdicts."""

    def __init__(self, tool_name: str) -> None:
        self._tool_name = tool_name
        self._verdicts: list[OwnedProcessCleanupVerdict | None] = []
        self._overflow = False
        self._lock = threading.Lock()

    def register(self, on_cleanup: CleanupObserver | None) -> CleanupObserver | None:
        with self._lock:
            if len(self._verdicts) >= MAX_OBSERVED_CHILDREN:
                self._overflow = True
                child_index = None
            else:
                child_index = len(self._verdicts)
                self._verdicts.append(None)

        def observe(verdict: OwnedProcessCleanupVerdict) -> None:
            if child_index is not None:
                with self._lock:
                    current = self._verdicts[child_index]
                    if current is None or current.cleanup != "confirmed":
                        self._verdicts[child_index] = verdict
            if on_cleanup is not None:
                on_cleanup(verdict)

        return observe

    def resource_cleanup(self) -> dict[str, object] | None:
        with self._lock:
            verdicts = tuple(self._verdicts)
            overflow = self._overflow
        if not verdicts and not overflow:
            if self._tool_name not in _NO_CHILD_PROOF_TOOLS:
                return None
            return {
                "cleanup": "confirmed",
                "process_tree_terminated": True,
                "output_readers_terminated": True,
                "reason": "no_native_process_started",
            }
        pending = any(verdict is None for verdict in verdicts)
        observed = tuple(verdict for verdict in verdicts if verdict is not None)
        confirmed = bool(observed) and not overflow and not pending and all(
            verdict.cleanup == "confirmed"
            and verdict.process_tree_terminated
            and verdict.output_readers_terminated
            for verdict in observed
        )
        reason = None
        if not confirmed:
            if overflow:
                reason = "child_observation_overflow"
            elif pending:
                reason = "child_cleanup_pending"
            else:
                reason = next(
                    (verdict.reason for verdict in observed if verdict.reason),
                    "child_cleanup_unconfirmed",
                )
        return {
            "cleanup": "confirmed" if confirmed else "uncertain",
            "process_tree_terminated": confirmed or (
                not overflow
                and not pending
                and bool(observed)
                and all(verdict.process_tree_terminated for verdict in observed)
            ),
            "output_readers_terminated": confirmed or (
                not overflow
                and not pending
                and bool(observed)
                and all(verdict.output_readers_terminated for verdict in observed)
            ),
            "reason": reason,
        }

    def add_metadata(self, metadata: dict[str, object]) -> None:
        resource_cleanup = self.resource_cleanup()
        if resource_cleanup is None:
            return
        existing = metadata.get("resource_cleanup")
        if "resource_cleanup" not in metadata or (
            resource_cleanup["cleanup"] == "uncertain" and _is_confirmed_cleanup(existing)
        ):
            metadata["resource_cleanup"] = resource_cleanup


def create_process_cleanup_observer(
    on_cleanup: CleanupObserver | None = None,
) -> CleanupObserver | None:
    """Compose an owner callback with the active invocation collector."""
    observation = _current_observation.get()
    if observation is None:
        return on_cleanup
    return observation.register(on_cleanup)


@contextmanager
def observe_owned_process_invocation(
    tool_name: str,
) -> Iterator[OwnedProcessInvocationObservation]:
    observation = OwnedProcessInvocationObservation(tool_name)
    token = _current_observation.set(observation)
    try:
        yield observation
    finally:
        _current_observation.reset(token)


__all__ = [
    "MAX_OBSERVED_CHILDREN",
    "OwnedProcessInvocationObservation",
    "create_process_cleanup_observer",
    "observe_owned_process_invocation",
]
