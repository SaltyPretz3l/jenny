"""Bounded cleanup evidence and transition-safe observation for owned processes."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Callable, Literal

CleanupStatus = Literal["confirmed", "uncertain"]


@dataclass(frozen=True, slots=True)
class OwnedProcessCleanupVerdict:
    """Owner-derived proof state for the native process tree and pipe readers."""

    cleanup: CleanupStatus
    process_tree_terminated: bool
    output_readers_terminated: bool
    reason: str | None = None

    def metadata(self) -> dict[str, object]:
        return {
            "cleanup": self.cleanup,
            "process_tree_terminated": self.process_tree_terminated,
            "output_readers_terminated": self.output_readers_terminated,
            "reason": self.reason,
        }


CleanupObserver = Callable[[OwnedProcessCleanupVerdict], None]


class CleanupObservation:
    """Publish uncertain once and a later confirmed transition once."""

    def __init__(self, observer: CleanupObserver | None = None) -> None:
        self._observer = observer
        self._latest: OwnedProcessCleanupVerdict | None = None
        self._lock = threading.Lock()

    @property
    def latest(self) -> OwnedProcessCleanupVerdict | None:
        with self._lock:
            return self._latest

    def publish(self, verdict: OwnedProcessCleanupVerdict) -> bool:
        observer: CleanupObserver | None
        with self._lock:
            current = self._latest
            if current is not None and current.cleanup in {
                "confirmed", verdict.cleanup
            }:
                return False
            self._latest = verdict
            observer = self._observer
        if observer is not None:
            try:
                observer(verdict)
            except Exception:  # noqa: BLE001 - observation cannot corrupt cleanup.
                return True
        return True


__all__ = [
    "CleanupObservation",
    "CleanupObserver",
    "OwnedProcessCleanupVerdict",
]
