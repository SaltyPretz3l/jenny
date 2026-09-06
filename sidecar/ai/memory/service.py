"""Authoritative orchestration boundary for backend memory behavior."""

from __future__ import annotations

import logging
from typing import Any, cast

from sidecar.ai.context.token_budget import CharEstimationBackend
from sidecar.ai.error_codes import (
    CMP_MEMORY_CAPACITY_EXCEEDED,
    CMP_MEMORY_FAILED,
    CMP_MEMORY_ROW_QUARANTINED,
)
from sidecar.ai.memory.contracts import MemoryPolicy
from sidecar.ai.memory.store import (
    ApprovedMemory,
    MemoryStore,
    PendingMemoryCandidate,
)
from sidecar.ai.memory.unavailable import UnavailableMemoryStore
from sidecar.exceptions import MemoryStoreError

logger = logging.getLogger(__name__)


class ApprovedMemoryService:
    """Typed approved-memory operations owned by :class:`MemoryService`."""

    def __init__(self, store: MemoryStore) -> None:
        self._store = store

    def save_memory(self, **kwargs: Any) -> tuple[ApprovedMemory, bool]:
        return self._store.save_memory(**kwargs)

    def get_all_memories(self) -> list[ApprovedMemory]:
        return self._store.get_all_memories()

    def get_memories_page(
        self,
        *,
        limit: int,
        snapshot_max_id: int | None = None,
        after_id: int | None = None,
        legacy_offset: int | None = None,
    ) -> tuple[list[ApprovedMemory], tuple[int, int] | int | None]:
        return self._store.get_memories_page(
            limit=limit,
            snapshot_max_id=snapshot_max_id,
            after_id=after_id,
            legacy_offset=legacy_offset,
        )

    def get_memory_by_id(self, memory_id: int) -> ApprovedMemory | None:
        return self._store.get_memory_by_id(memory_id)

    def update_memory(self, **kwargs: Any) -> ApprovedMemory:
        return self._store.update_memory(**kwargs)

    def delete_memory(self, memory_id: int) -> bool:
        return self._store.delete_memory(memory_id)

    def recall_memories(self, query: str, *, limit: int) -> list[ApprovedMemory]:
        return self._store.recall_memories(query, limit=limit)

    def get_recent_memories_by_kind(
        self, lesson_kind: str, limit: int
    ) -> list[ApprovedMemory]:
        return self._store.get_recent_memories_by_kind(lesson_kind, limit)

    def has_memory_fingerprint(self, content_fingerprint: str) -> bool:
        return self._store.has_memory_fingerprint(content_fingerprint)


class PendingMemoryService:
    """Typed pending-candidate and suppression operations."""

    def __init__(self, store: MemoryStore) -> None:
        self._store = store

    def get_pending_candidates(
        self, session_id: str, *, limit: int = 5
    ) -> list[PendingMemoryCandidate]:
        return self._store.get_pending_candidates(session_id, limit=limit)

    def get_pending_candidates_for_harness(
        self, *, limit: int
    ) -> list[PendingMemoryCandidate]:
        return self._store.get_pending_candidates_for_harness(limit=limit)

    def get_pending_candidates_page(
        self,
        *,
        limit: int,
        snapshot_max_id: int | None = None,
        after_id: int | None = None,
        legacy_offset: int | None = None,
    ) -> tuple[list[PendingMemoryCandidate], tuple[int, int] | int | None]:
        return self._store.get_pending_candidates_page(
            limit=limit,
            snapshot_max_id=snapshot_max_id,
            after_id=after_id,
            legacy_offset=legacy_offset,
        )

    def delete_pending_candidate(
        self, *, session_id: str, content_fingerprint: str
    ) -> bool:
        return self._store.delete_pending_candidate(
            session_id=session_id,
            content_fingerprint=content_fingerprint,
        )

    def is_memory_suppressed(self, content_fingerprint: str) -> bool:
        return self._store.is_memory_suppressed(content_fingerprint)


class MemoryService:
    """Own backend memory operations without an untyped store proxy."""

    def __init__(self, store: MemoryStore | UnavailableMemoryStore) -> None:
        self._store = store
        concrete = (
            None
            if isinstance(store, UnavailableMemoryStore)
            else cast(MemoryStore, store)
        )
        self.approved = ApprovedMemoryService(concrete) if concrete is not None else None
        self.pending = PendingMemoryService(concrete) if concrete is not None else None

    @property
    def available(self) -> bool:
        return not isinstance(self._store, UnavailableMemoryStore)

    @property
    def store_compat(self) -> MemoryStore | UnavailableMemoryStore:
        """Narrow compatibility accessor for legacy diagnostics and harness callers."""

        return self._store

    def close(self) -> None:
        self._store.close()

    def recall_for_prompt(
        self,
        query: str,
        *,
        policy: MemoryPolicy | None = None,
        limit: int = 5,
        max_prompt_tokens: int = 256,
    ) -> list[ApprovedMemory]:
        effective_policy = policy or MemoryPolicy()
        approved = self.approved
        if not effective_policy.enabled or approved is None:
            return []
        recalled = approved.recall_memories(query, limit=limit)
        style_rows = (
            approved.get_recent_memories_by_kind("response_style", 1)
            if effective_policy.include_response_style
            else []
        )
        candidates: list[ApprovedMemory] = []
        seen: set[str] = set()
        for memory in [*style_rows, *recalled]:
            if memory.content_fingerprint in seen:
                continue
            seen.add(memory.content_fingerprint)
            candidates.append(memory)
            if len(candidates) >= limit:
                break
        merged: list[ApprovedMemory] = []
        tokens_used = 0
        backend = CharEstimationBackend()
        for memory in candidates:
            text = "\n".join(
                (memory.title, memory.lesson_kind, memory.lesson_text, memory.source_excerpt)
            )
            memory_tokens = max(1, backend.count_tokens(text))
            if tokens_used + memory_tokens > max_prompt_tokens:
                continue
            merged.append(memory)
            tokens_used += memory_tokens
        return merged

    def status(self) -> dict[str, Any]:
        if isinstance(self._store, UnavailableMemoryStore):
            return {
                "available": False,
                "schema_version": None,
                "recall_index": "unavailable",
                "counts": {},
                "storage": {"state": "unavailable"},
                "maintenance": {"state": "unavailable"},
                "preserved": self._store.preserved,
                "repair_required": True,
                "degraded_reasons": [self._store.reason_code],
            }
        try:
            status = self._store.status_snapshot()
        except Exception as error:  # noqa: BLE001 - status must never terminate the sidecar.
            code = error.code if isinstance(error, MemoryStoreError) else CMP_MEMORY_FAILED
            logger.warning(
                "memory status degraded",
                extra={
                    "event": "ai.memory.status_failed",
                    "code": code,
                    "error_type": type(error).__name__,
                },
            )
            return {
                "available": False,
                "schema_version": None,
                "recall_index": "unavailable",
                "counts": {},
                "storage": {"state": "unavailable"},
                "maintenance": {"state": "unavailable"},
                "preserved": False,
                "repair_required": True,
                "degraded_reasons": [code],
            }
        degraded_reasons: list[str] = []
        counts = status.get("counts", {})
        storage = status.get("storage", {})
        if isinstance(counts, dict) and int(counts.get("quarantined", 0) or 0) > 0:
            degraded_reasons.append(CMP_MEMORY_ROW_QUARANTINED)
        if isinstance(storage, dict) and storage.get("state") == "blocked":
            degraded_reasons.append(CMP_MEMORY_CAPACITY_EXCEEDED)
        if status.get("recall_index") != "fts5":
            degraded_reasons.append("recall_index_unavailable")
        if status.get("recall_partial") is True:
            degraded_reasons.append("recall_partial")
        return {**status, "degraded_reasons": degraded_reasons}


def approved_memory_api(
    backend: MemoryService | MemoryStore,
) -> ApprovedMemoryService | MemoryStore:
    approved = backend.approved if isinstance(backend, MemoryService) else backend
    if approved is None:
        raise MemoryStoreError(CMP_MEMORY_FAILED, "memory is unavailable")
    return approved


def pending_memory_api(backend: MemoryService | MemoryStore) -> PendingMemoryService | MemoryStore:
    pending = backend.pending if isinstance(backend, MemoryService) else backend
    if pending is None:
        raise MemoryStoreError(CMP_MEMORY_FAILED, "memory is unavailable")
    return pending


__all__ = [
    "ApprovedMemoryService",
    "MemoryService",
    "PendingMemoryService",
    "approved_memory_api",
    "pending_memory_api",
]
