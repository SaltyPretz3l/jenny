"""The memory recall pipeline behind ``MemoryService`` (row 58 W3/W4).

Two steps after the store's lexical recall:

* :class:`HybridRecall` owns the ``memory_hybrid_recall`` flag and the embedder
  source; it fuses the lexical rows with the vector leg
  (:mod:`sidecar.ai.memory.hybrid_recall`), runs ``memory.embed_step``
  (:mod:`sidecar.ai.memory.vector_index`) and reports the content-free status
  fields. Both vector modules load on the first fused recall or embed step,
  so the hybrid flag costs nothing on the sidecar startup path;
* :func:`pack_prompt_recall` packs the recalled rows (5 rows within 256 tokens)
  and up to 3 recap lines (600 tokens in all) for the prompt overlay.

Every read shares the caller's deadline; nothing here logs memory text.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Sequence
from typing import Any

from sidecar.ai.context.token_budget import CharEstimationBackend
from sidecar.ai.memory.contracts import (
    ALWAYS_ON_BUDGET_CHARS,
    ALWAYS_ON_HEADING_RESERVE,
    ALWAYS_ON_ROW_OVERHEAD,
    MAX_PROMPT_RECAP_LINES,
    PROMPT_RECALL_TOKEN_BUDGET,
    MemoryPolicy,
    RecapLine,
)
from sidecar.ai.memory.store_shared import MAX_RECALL_LIMIT, ApprovedMemory

logger = logging.getLogger(__name__)

# The renderer computes the always-on meter from these (memory.status).
ALWAYS_ON_BUDGET = {
    "budget_chars": ALWAYS_ON_BUDGET_CHARS,
    "heading_reserve": ALWAYS_ON_HEADING_RESERVE,
    "row_overhead": ALWAYS_ON_ROW_OVERHEAD,
}


class HybridRecall:
    """The hybrid flag, the embedder source and the vector-leg operations."""

    def __init__(
        self, *, enabled: bool, embedder_source: Callable[[], Any] | None = None
    ) -> None:
        self.enabled = bool(enabled)
        self._embedder_source = embedder_source or _current_embedder

    def embedder(self) -> Any | None:
        return self._embedder_source() if self.enabled else None

    def fuse(  # noqa: PLR0913 - the recall scope plus the shared deadline.
        self,
        store: Any,
        lexical: list[ApprovedMemory],
        query: str,
        *,
        limit: int,
        project_id: str,
        include_general: bool,
        scope_session_id: str | None,
        deadline: float,
        clock: Callable[[], float],
    ) -> list[ApprovedMemory]:
        embedder = self.embedder()
        if embedder is None:
            return lexical
        from sidecar.ai.memory import hybrid_recall

        return hybrid_recall.hybrid_recall(
            store, embedder, lexical, query,
            limit=max(1, min(int(limit), MAX_RECALL_LIMIT)), project_id=project_id,
            include_general=include_general, scope_session_id=scope_session_id,
            deadline=deadline, clock=clock,
        )

    def embed_step(
        self,
        store: Any,
        *,
        budget_seconds: float | None = None,
        batch: int | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> dict[str, Any]:
        """Unset bounds take the vector_index defaults (1.5 s, 16 rows)."""

        if not self.enabled:
            return {"ok": True, "embedded": 0, "remaining": 0, "reason": "hybrid_off"}
        embedder = self._embedder_source()
        if embedder is None:
            return {"ok": True, "embedded": 0, "remaining": 0, "reason": "embedder_off"}
        from sidecar.ai.memory import vector_index

        return vector_index.run_embed_step(
            store,
            embedder,
            budget_seconds=(
                vector_index.DEFAULT_EMBED_BUDGET_SECONDS
                if budget_seconds is None
                else budget_seconds
            ),
            batch=vector_index.DEFAULT_EMBED_BATCH if batch is None else batch,
            clock=clock,
        )

    def status(self, store: Any) -> dict[str, Any]:
        embedder = self.embedder()
        state = "off" if not self.enabled else "on" if embedder is not None else "unavailable"
        model_key = None if embedder is None else str(embedder.model_key)
        return {
            "recall_hybrid": state,
            "vector_count": store.vector_count(model_key=model_key),
            "always_on_budget": dict(ALWAYS_ON_BUDGET),
        }


def _current_embedder() -> Any | None:
    from sidecar.ai.memory.hybrid_recall import current_embedder

    return current_embedder()


def pack_prompt_recall(  # noqa: PLR0913 - the prompt overlay's budgets and deadline.
    recalled: Sequence[ApprovedMemory],
    *,
    policy: MemoryPolicy,
    scope_session_id: str | None,
    read_recaps: Callable[..., list[tuple[str, str, str]]],
    limit: int,
    max_prompt_tokens: int,
    deadline: float,
    clock: Callable[[], float],
) -> tuple[list[ApprovedMemory], list[RecapLine]]:
    """Dedupe and pack recalled rows, then add recap lines of the recent chats."""

    candidates: list[ApprovedMemory] = []
    seen: set[str] = set()
    for memory in recalled:
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
    recaps: list[RecapLine] = []
    chats = {chat.session_id: chat.title for chat in policy.recent_chats
             if chat.session_id != scope_session_id}
    if chats and clock() < deadline:
        try:
            rows = read_recaps(
                project_id=policy.project_id,
                session_ids=list(chats), limit=MAX_PROMPT_RECAP_LINES,
            )
        except Exception as error:  # noqa: BLE001 - recaps never drop recalled memories.
            logger.warning("memory recap read failed error_type=%s", type(error).__name__)
            rows = []
        for session, text, updated_at in rows:
            if clock() >= deadline:
                break
            title = chats[session]
            cost = max(1, backend.count_tokens(title + "\n" + text))
            if tokens_used + cost > PROMPT_RECALL_TOKEN_BUDGET:
                continue
            recaps.append(RecapLine(title, updated_at[:10], text))
            tokens_used += cost
    return merged, recaps


__all__ = ["ALWAYS_ON_BUDGET", "HybridRecall", "pack_prompt_recall"]
