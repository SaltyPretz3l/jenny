"""Authoritative orchestration boundary for backend memory behavior."""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Sequence, cast

from sidecar.ai.error_codes import (
    CMP_MEMORY_CAPACITY_EXCEEDED,
    CMP_MEMORY_FAILED,
    CMP_MEMORY_ROW_QUARANTINED,
)
from sidecar.ai.memory.contracts import (
    GENERAL_PROJECT_ID,
    PROMPT_MEMORY_TOKEN_BUDGET,
    MemoryPolicy,
    RecapLine,
    require_project_id,
)
from sidecar.ai.memory.recall_pipeline import HybridRecall, pack_prompt_recall
from sidecar.ai.memory.reflection_epochs import PolicyEpochFence
from sidecar.ai.memory.store import (
    ApprovedMemory,
    MemoryStore,
    MemoryWriteResult,
    PendingMemoryCandidate,
)
from sidecar.ai.memory.unavailable import UnavailableMemoryStore
from sidecar.exceptions import MemoryStoreError

logger = logging.getLogger(__name__)

# One end-to-end budget for every store read a prompt recall makes.
PROMPT_RECALL_DEADLINE_SECONDS = 0.25


class ApprovedMemoryService:
    """Typed approved-memory operations owned by :class:`MemoryService`."""

    def __init__(self, store: MemoryStore) -> None:
        self._store = store

    def get_all_memories(
        self, *, project_id: str = GENERAL_PROJECT_ID
    ) -> list[ApprovedMemory]:
        return self._store.get_all_memories(project_id=project_id)

    def get_memories_page(
        self,
        *,
        limit: int,
        snapshot_max_id: int | None = None,
        after_id: int | None = None,
        project_id: str = GENERAL_PROJECT_ID,
        all_projects: bool = False,
    ) -> tuple[list[ApprovedMemory], tuple[int, int] | None]:
        return self._store.get_memories_page(
            limit=limit,
            snapshot_max_id=snapshot_max_id,
            after_id=after_id,
            project_id=project_id,
            all_projects=all_projects,
        )

    def recall_memories(  # noqa: PLR0913 - mirrors the store recall contract.
        self,
        query: str,
        *,
        limit: int,
        project_id: str = GENERAL_PROJECT_ID,
        include_general: bool = False,
        scope_session_id: str | None = None,
        deadline: float | None = None,
        clock: Callable[[], float] | None = None,
    ) -> list[ApprovedMemory]:
        optional: dict[str, Any] = {}
        if scope_session_id is not None:
            optional["scope_session_id"] = scope_session_id
        if deadline is not None:
            optional["deadline"] = deadline
        if clock is not None:
            optional["clock"] = clock
        return self._store.recall_memories(
            query,
            limit=limit,
            project_id=project_id,
            include_general=include_general,
            **optional,
        )

    def recaps_for_sessions(
        self, *, project_id: str, session_ids: Sequence[str], limit: int = 3
    ) -> list[tuple[str, str, str]]:
        return self._store.recaps_for_sessions(
            project_id=project_id, session_ids=session_ids, limit=limit
        )

    def export_session(self, session_id: str) -> dict[str, Any]:
        return self._store.export_session(session_id)

    def import_session(self, **kwargs: Any) -> dict[str, Any]:
        return self._store.import_session(**kwargs)

    def chat_sessions(self, *, limit: int = 2000) -> dict[str, Any]:
        return self._store.chat_sessions(limit=limit)

    # --- schema v9 write API (one transaction each; refusals are results) ---

    def remember(self, **kwargs: Any) -> MemoryWriteResult:
        return self._store.remember(**kwargs)

    def update(self, **kwargs: Any) -> MemoryWriteResult:
        return self._store.update(**kwargs)

    def forget(self, **kwargs: Any) -> MemoryWriteResult:
        return self._store.forget(**kwargs)

    def restore(self, **kwargs: Any) -> MemoryWriteResult:
        return self._store.restore(**kwargs)

    def restore_to(self, **kwargs: Any) -> MemoryWriteResult:
        return self._store.restore_to(**kwargs)

    def undo(self, **kwargs: Any) -> MemoryWriteResult:
        return self._store.undo(**kwargs)

    def erase(self, *, project_id: str, memory_id: int) -> bool:
        return self._store.erase(project_id=project_id, memory_id=memory_id)

    def archive_project(self, project_id: str) -> dict[str, int]:
        return self._store.archive_project(project_id)

    def unarchive_project(self, project_id: str) -> bool:
        return self._store.unarchive_project(project_id)

    def purge_session(self, session_id: str) -> dict[str, int]:
        return self._store.purge_session(session_id)

    def is_session_purged(self, session_id: str) -> bool:
        return self._store.is_session_purged(session_id)

    def clear_suppressions(self, *, project_id: str | None = None) -> int:
        return self._store.clear_suppressions(project_id=project_id)

    # --- schema v9 reads ---

    def list_active(self, **kwargs: Any) -> tuple[list[ApprovedMemory], str | None]:
        return self._store.list_active(**kwargs)

    def list_archived(self, **kwargs: Any) -> tuple[list[ApprovedMemory], str | None]:
        return self._store.list_archived(**kwargs)

    def always_on_rows(self, project_id: str) -> list[ApprovedMemory]:
        return self._store.always_on_rows(project_id)

    def list_operations(self, *, project_id: str, limit: int = 50) -> list[dict[str, Any]]:
        return self._store.list_operations(project_id=project_id, limit=limit)

    # --- reflection (row 58 W2) ---

    def reflection_state(self, session_id: str) -> dict[str, Any]:
        return self._store.reflection_state(session_id)

    def reflection_dedupe_rows(
        self, *, project_id: str, limit: int, scope_session_id: str = ""
    ) -> list[tuple[str, str]]:
        return self._store.reflection_dedupe_rows(
            project_id=project_id, limit=limit, scope_session_id=scope_session_id
        )

    def apply_reflection(self, **kwargs: Any) -> dict[str, Any]:
        return self._store.apply_reflection(**kwargs)


class PendingMemoryService:
    """Typed pending-candidate and suppression operations."""

    def __init__(self, store: MemoryStore) -> None:
        self._store = store

    def queue_candidate(self, **kwargs: Any) -> bool:
        return self._store.queue_candidate(**kwargs)

    def accept_pending(self, **kwargs: Any) -> MemoryWriteResult:
        return self._store.accept_pending(**kwargs)

    def get_pending_candidates_for_harness(
        self, *, limit: int, project_id: str = GENERAL_PROJECT_ID
    ) -> list[PendingMemoryCandidate]:
        return self._store.get_pending_candidates_for_harness(
            limit=limit, project_id=project_id
        )

    def get_pending_candidates_page(
        self,
        *,
        limit: int,
        snapshot_max_id: int | None = None,
        after_id: int | None = None,
        project_id: str = GENERAL_PROJECT_ID,
        all_projects: bool = False,
    ) -> tuple[list[PendingMemoryCandidate], tuple[int, int] | None]:
        return self._store.get_pending_candidates_page(
            limit=limit,
            snapshot_max_id=snapshot_max_id,
            after_id=after_id,
            project_id=project_id,
            all_projects=all_projects,
        )

    def delete_pending_candidate(
        self,
        *,
        session_id: str,
        content_fingerprint: str,
        project_id: str = GENERAL_PROJECT_ID,
    ) -> bool:
        return self._store.delete_pending_candidate(
            session_id=session_id,
            content_fingerprint=content_fingerprint,
            project_id=project_id,
        )

    def is_memory_suppressed(
        self, content_fingerprint: str, *, project_id: str = GENERAL_PROJECT_ID
    ) -> bool:
        return self._store.is_memory_suppressed(
            content_fingerprint, project_id=project_id
        )


class MemoryService:
    """Own backend memory operations without an untyped store proxy."""

    def __init__(
        self,
        store: MemoryStore | UnavailableMemoryStore,
        *,
        hybrid_recall_enabled: bool = False,
        embedder_source: Callable[[], Any] | None = None,
    ) -> None:
        self._store = store
        # Row 58 W4: the vector leg runs only with the flag on and an embedder.
        self.hybrid = HybridRecall(enabled=hybrid_recall_enabled, embedder_source=embedder_source)
        concrete = (
            None
            if isinstance(store, UnavailableMemoryStore)
            else cast(MemoryStore, store)
        )
        self.approved = ApprovedMemoryService(concrete) if concrete is not None else None
        self.pending = PendingMemoryService(concrete) if concrete is not None else None
        # Process memory: the highest policy epoch each Electron process reported.
        self.policy_epochs = PolicyEpochFence()

    @property
    def available(self) -> bool:
        return not isinstance(self._store, UnavailableMemoryStore)

    @property
    def store_compat(self) -> MemoryStore | UnavailableMemoryStore:
        """Narrow compatibility accessor for legacy diagnostics and harness callers."""

        return self._store

    def close(self) -> None:
        self._store.close()

    def recall(  # noqa: PLR0913 - the store recall contract plus the shared deadline.
        self,
        query: str,
        *,
        limit: int,
        project_id: str,
        include_general: bool = False,
        scope_session_id: str | None = None,
        deadline: float | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> list[ApprovedMemory]:
        """Lexical recall, fused with the vector leg while hybrid recall is on."""

        approved = self.approved
        if approved is None:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "memory is unavailable")
        # Without a caller deadline the lexical read keeps the store's own bound
        # and the vector leg gets the prompt recall's end-to-end budget.
        hybrid_deadline = (
            clock() + PROMPT_RECALL_DEADLINE_SECONDS if deadline is None else deadline
        )
        lexical = approved.recall_memories(
            query, limit=limit, project_id=project_id, include_general=include_general,
            scope_session_id=scope_session_id, deadline=deadline, clock=clock,
        )
        return self.hybrid.fuse(
            self._store, lexical, query, limit=limit, project_id=project_id,
            include_general=include_general, scope_session_id=scope_session_id,
            deadline=hybrid_deadline, clock=clock,
        )

    def embed_step(self, **kwargs: Any) -> dict[str, Any]:
        """memory.embed_step: index missing memory vectors within a time budget."""

        if self.hybrid.enabled and self.approved is None:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "memory is unavailable")
        return self.hybrid.embed_step(self._store, **kwargs)

    def recall_for_prompt(  # noqa: PLR0913 - mirrors the store recall contract.
        self,
        query: str,
        *,
        policy: MemoryPolicy | None = None,
        limit: int = 5,
        max_prompt_tokens: int = PROMPT_MEMORY_TOKEN_BUDGET,
        clock: Callable[[], float] = time.monotonic,
        scope_session_id: str | None = None,
    ) -> list[ApprovedMemory]:
        memories, _ = self.recall_for_prompt_with_recaps(
            query, policy=policy, limit=limit, scope_session_id=scope_session_id,
            clock=clock, max_prompt_tokens=max_prompt_tokens,
        )
        return memories

    def recall_for_prompt_with_recaps(  # noqa: PLR0913 - shared prompt recall contract.
        self,
        query: str,
        *,
        policy: MemoryPolicy | None = None,
        limit: int = 5,
        scope_session_id: str | None = None,
        clock: Callable[[], float] = time.monotonic,
        max_prompt_tokens: int = PROMPT_MEMORY_TOKEN_BUDGET,
    ) -> tuple[list[ApprovedMemory], list[RecapLine]]:
        effective_policy = policy or MemoryPolicy()
        approved = self.approved
        if not effective_policy.enabled or not effective_policy.recall or approved is None:
            return [], []
        deadline = clock() + PROMPT_RECALL_DEADLINE_SECONDS
        recalled = self.recall(
            query,
            limit=limit,
            project_id=effective_policy.project_id,
            include_general=True,
            scope_session_id=scope_session_id,
            deadline=deadline,
            clock=clock,
        )
        return pack_prompt_recall(
            recalled, policy=effective_policy, scope_session_id=scope_session_id,
            read_recaps=approved.recaps_for_sessions, limit=limit,
            max_prompt_tokens=max_prompt_tokens, deadline=deadline, clock=clock,
        )

    def status(
        self,
        *,
        project_id: str = GENERAL_PROJECT_ID,
        all_projects: bool = False,
    ) -> dict[str, Any]:
        scope = require_project_id(project_id)
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
                "project_id": scope,
            }
        try:
            status = self._store.status_snapshot(
                project_id=scope, all_projects=all_projects
            )
            status.update(self.hybrid.status(self._store))
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
                "project_id": scope,
            }
        degraded_reasons: list[str] = []
        operational_counts = status.get("operational_counts", {})
        storage = status.get("storage", {})
        if (
            isinstance(operational_counts, dict)
            and int(operational_counts.get("quarantined", 0) or 0) > 0
        ):
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
    "MemoryWriteResult",
    "PendingMemoryService",
    "approved_memory_api",
    "pending_memory_api",
]
