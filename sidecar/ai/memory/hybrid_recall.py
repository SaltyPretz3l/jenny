"""Hybrid memory recall: the lexical result fused with a bounded vector leg (row 58 W4 S6).

Used by the prompt recall and the ``memory`` tool's ``recall`` through
``MemoryService.recall``, only while the ``memory_hybrid_recall`` flag is on and
the semantic catalog's embedder is available. The lexical result is computed
first and is the answer whenever the vector leg cannot finish in time:

1. with at least ``MIN_REMAINING_SECONDS`` before the caller's deadline, the
   query is embedded (``query_template``) on a helper thread that is abandoned
   at ``min(remaining - EMBED_RESERVE_SECONDS, MAX_QUERY_EMBED_SECONDS)``;
2. cosine (float32) over the newest stored vectors of in-scope, active,
   non-recap rows whose fingerprint still matches, capped by
   ``store_vectors.vector_scan_rows``; hits under ``COSINE_FLOOR`` abstain;
3. reciprocal-rank fusion (k = 60) of the lexical order and the top
   ``VECTOR_TOP_K`` vector hits; ties go to the lexical rank, then recency.

Any exception, timeout or deadline overrun returns the lexical rows unchanged.
Logs carry error types only, never memory or query text.
"""

from __future__ import annotations

import logging
import math
import threading
from array import array
from collections.abc import Callable, Sequence
from typing import Any

from sidecar.ai.memory.store_shared import ApprovedMemory
from sidecar.ai.memory.store_vectors import StoredVector
from sidecar.ai.memory.vector_index import load_numpy
from sidecar.ai.semantic.vectors import render_template, unpack_vector, validate_vector

logger = logging.getLogger(__name__)

MIN_REMAINING_SECONDS = 0.06
EMBED_RESERVE_SECONDS = 0.04
MAX_QUERY_EMBED_SECONDS = 0.12
COSINE_FLOOR = 0.35
VECTOR_TOP_K = 20
RRF_K = 60
# The numpy-less scoring loop checks the deadline this often (rows).
PYTHON_SCORE_CHUNK = 256
# Query embeds abandoned at their deadline keep running; at most this many at once.
MAX_INFLIGHT_QUERY_EMBEDS = 2
_INFLIGHT = threading.BoundedSemaphore(MAX_INFLIGHT_QUERY_EMBEDS)


def current_embedder() -> Any | None:
    """The semantic catalog's embedder, or None (catalog off, or no accessor yet)."""

    try:
        from sidecar.ai.semantic import runtime
    except Exception:  # noqa: BLE001 - hybrid recall is optional; lexical still answers.
        return None
    accessor = getattr(runtime, "current_embedder", None)
    if not callable(accessor):
        return None
    try:
        return accessor()
    except Exception:  # noqa: BLE001 - an unavailable embedder means lexical only.
        return None


def embed_query(provider: Any, text: str, *, timeout_seconds: float) -> list[float] | None:
    """Embed on a helper thread; None when it fails or misses *timeout_seconds*."""

    if not _INFLIGHT.acquire(blocking=False):
        return None
    outcome: dict[str, Any] = {}
    done = threading.Event()

    def _run() -> None:
        try:
            outcome["vector"] = provider.embed(text, timeout_seconds=timeout_seconds)
        except Exception as error:  # noqa: BLE001 - reported as a missing vector.
            outcome["error"] = type(error).__name__
        finally:
            _INFLIGHT.release()
            done.set()

    try:
        threading.Thread(target=_run, name="memory-query-embed", daemon=True).start()
    except RuntimeError:
        _INFLIGHT.release()
        return None
    if not done.wait(timeout_seconds) or "vector" not in outcome:
        if "error" in outcome:
            logger.warning("memory_hybrid_embed_failed error_type=%s", outcome["error"])
        return None
    try:
        return validate_vector(outcome["vector"])
    except ValueError:
        return None


def cosine_hits(
    query: Sequence[float],
    rows: Sequence[StoredVector],
    *,
    floor: float = COSINE_FLOOR,
    top_k: int = VECTOR_TOP_K,
    expired: Callable[[], bool] = lambda: False,
) -> list[int]:
    """Memory ids of the best rows at or above *floor*, best first (ties: newest id).

    The pure-Python path (no numpy) checks *expired* every
    ``PYTHON_SCORE_CHUNK`` rows and gives up with no hits once it is true.
    """

    packed = array("f", query)
    query_norm = math.sqrt(sum(value * value for value in packed))
    if not rows or query_norm == 0.0:
        return []
    usable = [row for row in rows if row.norm > 0.0 and len(row.blob) == 4 * len(packed)]
    numpy = load_numpy()
    if numpy is not None and usable:
        # float32 keeps the score well inside the deadline; the ranking only
        # compares scores against a 0.35 floor and each other.
        matrix = numpy.frombuffer(b"".join(row.blob for row in usable), dtype=numpy.float32)
        matrix = matrix.reshape(len(usable), len(packed))
        norms = numpy.asarray([row.norm for row in usable], dtype=numpy.float32)
        scores = (matrix @ numpy.frombuffer(packed.tobytes(), dtype=numpy.float32)) / (
            norms * numpy.float32(query_norm)
        )
        scored = list(zip(scores.tolist(), (row.memory_id for row in usable), strict=True))
    else:
        scored = []
        for index, row in enumerate(usable):
            if index % PYTHON_SCORE_CHUNK == 0 and expired():
                return []
            stored = unpack_vector(row.blob)
            if stored is None:
                continue
            dot = math.fsum(a * b for a, b in zip(packed, stored, strict=True))
            scored.append((dot / (row.norm * query_norm), row.memory_id))
    hits = [(score, memory_id) for score, memory_id in scored
            if math.isfinite(score) and score >= floor]
    hits.sort(key=lambda item: (-item[0], -item[1]))
    return [memory_id for _score, memory_id in hits[:top_k]]


def fuse_rankings(
    lexical: Sequence[ApprovedMemory],
    vector: Sequence[ApprovedMemory],
    *,
    limit: int,
) -> list[ApprovedMemory]:
    """Reciprocal-rank fusion; ties by lexical rank, then recency, then id."""

    scores: dict[int, float] = {}
    rows: dict[int, ApprovedMemory] = {}
    for ranking in (lexical, vector):
        for rank, memory in enumerate(ranking, start=1):
            scores[memory.id] = scores.get(memory.id, 0.0) + 1.0 / (RRF_K + rank)
            rows.setdefault(memory.id, memory)
    lexical_rank = {memory.id: rank for rank, memory in enumerate(lexical)}
    unranked = len(lexical)
    ordered = sorted(rows.values(), key=lambda memory: (memory.updated_at, memory.id),
                     reverse=True)
    ordered.sort(key=lambda memory: (-scores[memory.id],
                                     lexical_rank.get(memory.id, unranked)))
    return ordered[: max(1, int(limit))]


def hybrid_recall(  # noqa: PLR0913 - the recall scope plus the shared deadline.
    store: Any,
    embedder: Any,
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
    """Fuse *lexical* with the vector leg, or return *lexical* unchanged."""

    remaining = deadline - clock()
    if remaining < MIN_REMAINING_SECONDS:
        return lexical
    try:
        vector = embed_query(
            embedder.provider,
            render_template(embedder.query_template, text=query, title=""),
            timeout_seconds=min(remaining - EMBED_RESERVE_SECONDS, MAX_QUERY_EMBED_SECONDS),
        )
        if vector is None or clock() >= deadline:
            return lexical
        rows = store.vector_candidates(
            model_key=str(embedder.model_key), dim=len(vector), project_id=project_id,
            include_general=include_general, scope_session_id=scope_session_id,
        )
        if clock() >= deadline:
            return lexical
        hit_ids = cosine_hits(vector, rows, expired=lambda: clock() >= deadline)
        if not hit_ids or clock() >= deadline:
            return lexical
        fused = fuse_rankings(lexical, store.active_memories_by_id(hit_ids), limit=limit)
    except Exception as error:  # noqa: BLE001 - the lexical answer always stands.
        logger.warning("memory_hybrid_recall_failed error_type=%s", type(error).__name__)
        return lexical
    return lexical if clock() > deadline else fused


__all__ = [
    "COSINE_FLOOR",
    "MAX_QUERY_EMBED_SECONDS",
    "MIN_REMAINING_SECONDS",
    "RRF_K",
    "VECTOR_TOP_K",
    "cosine_hits",
    "current_embedder",
    "embed_query",
    "fuse_rankings",
    "hybrid_recall",
]
