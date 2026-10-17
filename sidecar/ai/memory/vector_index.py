"""``memory.embed_step``: embed memory rows with the semantic catalog's embedder.

The step reads a batch of rows that lack a current vector (under the store
lock), embeds them with no lock held, then writes the vectors in one short
transaction of its own; it never runs inside a user write. Text is the
embedder's ``document_template`` applied to ``title + "\\n" + lesson_text``.
Nothing here logs memory text.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from sidecar.ai.memory.store_vectors import VectorTarget
from sidecar.ai.semantic.vectors import render_template

logger = logging.getLogger(__name__)

DEFAULT_EMBED_BUDGET_SECONDS = 1.5
MIN_EMBED_BUDGET_SECONDS = 0.1
MAX_EMBED_BUDGET_SECONDS = 5.0
DEFAULT_EMBED_BATCH = 16
MAX_EMBED_BATCH = 32


_NUMPY: list[Any] = []


def load_numpy() -> Any | None:
    """numpy for the cosine fast path, imported once (None when unavailable).

    The indexer warms it, so a prompt recall never pays the first import
    inside its 250 ms deadline.
    """

    if not _NUMPY:
        loaded: Any = None
        try:
            import numpy

            loaded = numpy
        except Exception:  # noqa: BLE001 - numpy is an optional fast path only.
            loaded = None
        _NUMPY.append(loaded)
    return _NUMPY[0]


def embed_texts(provider: Any, texts: list[str], *, timeout_seconds: float) -> list[Any]:
    embed_many = getattr(provider, "embed_many", None)
    if callable(embed_many):
        return list(embed_many(texts, timeout_seconds=timeout_seconds))
    return [provider.embed(text, timeout_seconds=timeout_seconds) for text in texts]


def _documents(embedder: Any, targets: list[VectorTarget]) -> list[str]:
    return [
        render_template(
            embedder.document_template,
            text=f"{target.title}\n{target.lesson_text}",
            title=target.title,
        )
        for target in targets
    ]


def run_embed_step(
    store: Any,
    embedder: Any,
    *,
    budget_seconds: float = DEFAULT_EMBED_BUDGET_SECONDS,
    batch: int = DEFAULT_EMBED_BATCH,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Embed missing or stale vectors within *budget_seconds*; content-free result."""

    model_key = str(embedder.model_key)
    dims = int(getattr(embedder, "dims", 0) or 0)
    load_numpy()
    deadline = clock() + budget_seconds
    embedded = 0
    reason: str | None = None
    if store.vector_capacity_blocked():
        reason = "capacity"
    while reason is None and clock() < deadline:
        targets = store.vector_targets(model_key=model_key, dims=dims, limit=batch)
        if not targets:
            break
        try:
            vectors = embed_texts(
                embedder.provider, _documents(embedder, targets),
                timeout_seconds=max(deadline - clock(), 0.01),
            )
        except Exception as error:  # noqa: BLE001 - a failed embed leaves rows pending.
            logger.warning("memory_embed_step_failed error_type=%s", type(error).__name__)
            reason = "embedder_error"
            break
        if len(vectors) != len(targets):
            reason = "embedder_error"
            break
        stored = store.store_memory_vectors(
            model_key=model_key, vectors=list(zip(targets, vectors, strict=True))
        )
        embedded += stored
        if stored < len(targets):
            break  # rows changed (or vectors were unusable) mid-step; the next step retries
    result: dict[str, Any] = {
        "ok": True,
        "embedded": embedded,
        "remaining": store.count_vector_targets(model_key=model_key, dims=dims),
    }
    if reason is not None:
        result["reason"] = reason
    return result


__all__ = [
    "DEFAULT_EMBED_BATCH",
    "DEFAULT_EMBED_BUDGET_SECONDS",
    "MAX_EMBED_BATCH",
    "MAX_EMBED_BUDGET_SECONDS",
    "MIN_EMBED_BUDGET_SECONDS",
    "embed_texts",
    "load_numpy",
    "run_embed_step",
]
