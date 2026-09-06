"""Fail-soft memory-store replacement for unavailable persisted state."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, NoReturn

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.store import MemoryStore
from sidecar.exceptions import MemoryStoreError
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class UnavailableMemoryStore:
    db_path: Path
    reason_code: str
    reason: str
    journal_mode: str = "unavailable"
    available: bool = False
    preserved: bool = False

    @classmethod
    def from_failure(cls, db_path: Path, error: Exception) -> "UnavailableMemoryStore":
        if isinstance(error, MemoryStoreError):
            code = error.code
            reason = str(error.message or "memory database unavailable")[:240]
        else:
            code = CMP_MEMORY_FAILED
            reason = f"memory storage unavailable ({type(error).__name__})"
        return cls(
            db_path=db_path,
            reason_code=code,
            reason=reason,
            preserved=getattr(error, "preserved", None) is True,
        )

    def close(self) -> None:
        return None

    def recall_memories_for_prompt(self, _query: str, *, limit: int) -> list[Any]:
        # Prompt recall is ancillary to ordinary chat. A disabled store behaves
        # as an empty overlay here while explicit memory RPCs remain coded errors.
        _ = limit
        return []

    def status_payload(self) -> dict[str, Any]:
        return {
            "available": False,
            "code": self.reason_code,
            "reason": self.reason,
            "journal_mode": self.journal_mode,
            "preserved": self.preserved,
            "repair_required": True,
        }

    def __getattr__(self, name: str) -> NoReturn:
        if name.startswith("_"):
            raise AttributeError(name)
        raise MemoryStoreError(
            self.reason_code,
            "memory is unavailable; explicit repair is required",
        )


def memory_store_status_payload(store: Any) -> dict[str, Any]:
    if isinstance(store, UnavailableMemoryStore):
        return store.status_payload()
    return {
        "available": True,
        "code": None,
        "reason": None,
        "journal_mode": str(getattr(store, "journal_mode", "") or ""),
        "preserved": True,
        "repair_required": False,
    }


def open_memory_store(
    db_path: Path,
    *,
    store_factory: Callable[[Path], MemoryStore] = MemoryStore,
) -> MemoryStore | UnavailableMemoryStore:
    try:
        return store_factory(db_path)
    except Exception as error:  # noqa: BLE001
        unavailable = UnavailableMemoryStore.from_failure(db_path, error)
        log_event(
            logger,
            logging.WARNING,
            component="ai.memory",
            event="ai.memory.store_unavailable",
            message="Optional memory storage is unavailable; chat will continue.",
            status="degraded",
            data={
                "code": unavailable.reason_code,
                "error_type": type(error).__name__,
                "repair_required": True,
                "preserved": unavailable.preserved,
            },
        )
        return unavailable
