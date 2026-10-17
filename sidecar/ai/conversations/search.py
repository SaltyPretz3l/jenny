"""Conversation search (lexical FTS5, hybrid with the catalog embedder) and embed steps.

Lexical search ORs up to 16 quoted query words and orders by ``bm25``. With an
embedder, the query is embedded once (bounded deadline) and ranked by cosine
over the stored message vectors of the same model; both lists are fused by
reciprocal rank. An embedder failure falls back to the lexical list and says
so in ``reason``. Nothing here logs a query, a snippet or a message.
"""

from __future__ import annotations

import math
import re
import time
from array import array
from collections.abc import Callable, Iterable, Sequence
from typing import Any, Protocol

from sidecar.ai.conversations.store import ConversationStore, MessageRow
from sidecar.ai.semantic.vectors import render_template, unpack_vector

MAX_QUERY_TOKENS = 16
MAX_HITS_PER_SESSION = 2
MAX_SNIPPET_CHARS = 280
LEXICAL_SCAN_ROWS = 1_000
FUSION_CANDIDATES = 50
MAX_SIMILARITY_SCAN_ROWS = 20_000
COSINE_FLOOR = 0.30
RRF_K = 60
QUERY_EMBED_TIMEOUT_SECONDS = 1.0
# One embed request may outlast the step budget (a CPU embedder answers only
# when the whole batch is done); new requests start only inside the budget.
EMBED_REQUEST_TIMEOUT_SECONDS = 30.0
_SCORE_DECIMALS = 6
_TOKEN_RE = re.compile(r"(?u)[^\W_]{2,}")
_STOPWORDS = frozenset({
    "an", "as", "at", "be", "by", "if", "in", "is", "it", "me", "my", "of", "on", "or",
    "to", "up", "we", "the", "and", "for", "with", "that", "this", "from", "have", "what",
    "when", "where", "your", "about", "did", "does", "was", "were", "you", "our", "how",
})


class Embedder(Protocol):
    """The ``semantic.runtime.EmbedderHandle`` shape this module reads."""

    @property
    def provider(self) -> Any: ...
    @property
    def model_key(self) -> str: ...
    @property
    def query_template(self) -> str: ...
    @property
    def document_template(self) -> str: ...


def query_tokens(query: str) -> list[str]:
    """Distinct lowercased words (2+ characters, no stopwords), at most 16."""
    tokens: list[str] = []
    for token in _TOKEN_RE.findall(query.lower()):
        if token not in _STOPWORDS and token not in tokens:
            tokens.append(token)
        if len(tokens) == MAX_QUERY_TOKENS:
            break
    return tokens


def fts_match(tokens: Sequence[str]) -> str:
    return " OR ".join('"' + token.replace('"', '""') + '"' for token in tokens)


def _snippet(text: str) -> str:
    return " ".join(text.split())[:MAX_SNIPPET_CHARS]


def _per_session_capped(rowids: Iterable[int], session_of: Callable[[int], str],
                        limit: int) -> list[int]:
    kept: list[int] = []
    per_session: dict[str, int] = {}
    for rowid in rowids:
        session_id = session_of(rowid)
        if per_session.get(session_id, 0) >= MAX_HITS_PER_SESSION:
            continue
        per_session[session_id] = per_session.get(session_id, 0) + 1
        kept.append(rowid)
        if len(kept) == limit:
            break
    return kept


def _hit(row: MessageRow, snippet: str, score: float) -> dict[str, Any]:
    return {
        "session_id": row.session_id, "title": row.title, "message_id": row.message_id,
        "role": row.role, "created_at": row.created_at, "snippet": _snippet(snippet),
        "score": round(score, _SCORE_DECIMALS),
    }


def _load_numpy() -> Any | None:
    try:
        import numpy
    except Exception:  # noqa: BLE001 - numpy is an optional fast path only.
        return None
    return numpy


def _cosine(
    query: list[float], rows: Sequence[tuple[int, bytes, float]]
) -> list[tuple[float, int]]:
    """``[(cosine, rowid)]`` for the usable rows (numpy fast path when available)."""
    packed = array("f", query)
    query_norm = math.sqrt(sum(value * value for value in packed))
    usable = [row for row in rows if len(row[1]) == len(packed) * 4
              and row[2] and math.isfinite(row[2])]
    if query_norm == 0.0 or not usable:
        return []
    numpy = _load_numpy()
    if numpy is not None:
        matrix = numpy.frombuffer(b"".join(row[1] for row in usable), dtype=numpy.float32)
        matrix = matrix.reshape(len(usable), len(packed)).astype(numpy.float64)
        norms = numpy.asarray([row[2] for row in usable], dtype=numpy.float64)
        scores = (matrix @ numpy.asarray(packed, dtype=numpy.float64)) / (norms * query_norm)
        pairs = zip(scores.tolist(), (row[0] for row in usable), strict=True)
        return [(float(score), rowid) for score, rowid in pairs if math.isfinite(score)]
    results: list[tuple[float, int]] = []
    for rowid, blob, norm in usable:
        stored = unpack_vector(blob)
        if stored is None:
            continue
        score = math.fsum(a * b for a, b in zip(packed, stored, strict=True)) / (query_norm * norm)
        if math.isfinite(score):
            results.append((score, rowid))
    return results


def _lexical(store: ConversationStore, query: str, project_id: str,
             exclude: Sequence[str]) -> list[tuple[MessageRow, str, float]]:
    tokens = query_tokens(query)
    if not tokens:
        return []
    rows = store.lexical_rows(fts_match(tokens), project_id, exclude, cap=LEXICAL_SCAN_ROWS)
    sessions = {row.rowid: row.session_id for row, _snippet_text, _score in rows}
    kept = set(_per_session_capped((row.rowid for row, _s, _b in rows), sessions.__getitem__,
                                   FUSION_CANDIDATES))
    return [entry for entry in rows if entry[0].rowid in kept]


def _lexical_hits(lexical: list[tuple[MessageRow, str, float]], limit: int) -> list[dict]:
    by_rowid = {row.rowid: (row, snippet, -bm25) for row, snippet, bm25 in lexical}
    capped = _per_session_capped(by_rowid, lambda rowid: by_rowid[rowid][0].session_id, limit)
    return [_hit(*by_rowid[rowid]) for rowid in capped]


def _vector(store: ConversationStore, query_vector: list[float], model_key: str,
            project_id: str, exclude: Sequence[str]) -> list[int]:
    rows = store.vector_rows(model_key, len(query_vector), project_id, exclude,
                             cap=MAX_SIMILARITY_SCAN_ROWS)
    ranked = sorted(
        ((score, rowid) for score, rowid in _cosine(query_vector, rows) if score >= COSINE_FLOOR),
        key=lambda pair: (-pair[0], -pair[1]),
    )
    return [rowid for _score, rowid in ranked[: FUSION_CANDIDATES * MAX_HITS_PER_SESSION]]


def search_conversations(  # noqa: PLR0913 - the RPC's explicit keyword surface.
    store: ConversationStore,
    *,
    query: str,
    project_id: str,
    exclude_session_ids: Sequence[str],
    limit: int,
    embedder: Embedder | None,
) -> dict[str, Any]:
    """Scoped hits, at most ``MAX_HITS_PER_SESSION`` per session and ``limit`` in all."""
    exclude = list(dict.fromkeys(exclude_session_ids))
    query_vector: list[float] | None = None
    reason: str | None = None
    model_key = ""
    if embedder is not None:
        model_key = embedder.model_key
        text = render_template(embedder.query_template, text=query, title="")
        try:
            query_vector = embedder.provider.embed_many(
                [text], timeout_seconds=QUERY_EMBED_TIMEOUT_SECONDS)[0]
        except Exception:  # noqa: BLE001 - search falls back to the words.
            reason = "embedder_unavailable"
    lexical = _lexical(store, query, project_id, exclude)
    if query_vector is None:
        result: dict[str, Any] = {"ok": True, "mode": "lexical",
                                  "hits": _lexical_hits(lexical, limit)}
        if reason:
            result["reason"] = reason
        return result
    return _hybrid(store, lexical, query_vector, model_key, project_id, exclude, limit)


def _hybrid(  # noqa: PLR0913 - the search's scope, passed through.
    store: ConversationStore,
    lexical: list[tuple[MessageRow, str, float]],
    query_vector: list[float],
    model_key: str,
    project_id: str,
    exclude: Sequence[str],
    limit: int,
) -> dict[str, Any]:
    vector_ids = _vector(store, query_vector, model_key, project_id, exclude)
    vector_rows = store.message_rows(vector_ids)
    vector_ids = _per_session_capped(
        (rowid for rowid in vector_ids if rowid in vector_rows),
        lambda rowid: vector_rows[rowid].session_id, FUSION_CANDIDATES)
    scores: dict[int, float] = {}
    for rank, (row, _snippet_text, _bm25) in enumerate(lexical, start=1):
        scores[row.rowid] = 1.0 / (RRF_K + rank)
    for rank, rowid in enumerate(vector_ids, start=1):
        scores[rowid] = scores.get(rowid, 0.0) + 1.0 / (RRF_K + rank)
    rows = {rowid: (row, row.text) for rowid, row in vector_rows.items()}
    rows.update({row.rowid: (row, snippet) for row, snippet, _bm25 in lexical})
    order = sorted(scores, key=lambda rowid: (-scores[rowid], -rowid))
    capped = _per_session_capped(order, lambda rowid: rows[rowid][0].session_id, limit)
    hits = [_hit(rows[rowid][0], rows[rowid][1], scores[rowid]) for rowid in capped]
    return {"ok": True, "mode": "hybrid", "hits": hits}


def embed_step(
    store: ConversationStore,
    embedder: Embedder | None,
    *,
    budget_seconds: float,
    batch: int,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Embed messages lacking a vector for the current model, within one budget."""
    if embedder is None:
        return {"ok": True, "embedded": 0, "remaining": store.count_missing_vectors(None),
                "reason": "embedder_off"}
    deadline = clock() + budget_seconds
    model_key = embedder.model_key
    store.drop_other_models(model_key)
    embedded = 0
    reason: str | None = None
    while clock() < deadline:
        pending = store.messages_missing_vectors(model_key, batch)
        if not pending:
            break
        texts = [render_template(embedder.document_template, text=message.text,
                                 title=message.title) for message in pending]
        try:
            vectors = embedder.provider.embed_many(
                texts, timeout_seconds=EMBED_REQUEST_TIMEOUT_SECONDS)
        except Exception:  # noqa: BLE001 - the step reports, never raises.
            reason = "embedder_unavailable"
            break
        store.store_vectors(model_key, [
            (message.rowid, vector) for message, vector in zip(pending, vectors, strict=True)])
        embedded += len(pending)
    result: dict[str, Any] = {"ok": True, "embedded": embedded,
                              "remaining": store.count_missing_vectors(model_key)}
    if reason:
        result["reason"] = reason
    return result
