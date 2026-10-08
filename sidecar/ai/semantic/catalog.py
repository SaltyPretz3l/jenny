"""Semantic catalog orchestration: bounded index steps, search, status, purge.

One ``index_step`` does at most one budget of work (``max_chunks`` embedded
chunks or ``max_seconds``) in a fixed order: purge removed roots, scan roots
whose scan cycle is open, extract and chunk pending documents, embed chunks
missing a vector for the active ``model_key``, and drop other models' vectors
once the active model covers every chunk. Embedder failures end the step and
come back in the result; nothing raises out of ``index_step`` or ``search``.
"""

from __future__ import annotations

import math
import os
import re
import sqlite3
import time
from array import array
from collections.abc import Callable, Iterator, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

from sidecar.ai.error_codes import (
    CMP_CATALOG_CAPACITY_REACHED,
    CMP_CATALOG_EMBEDDER_UNAVAILABLE,
    CMP_CATALOG_INDEX_UNAVAILABLE,
)
from sidecar.ai.semantic.chunker import chunk_sections
from sidecar.ai.semantic.extract import (
    CatalogRootGuard,
    ExtractResult,
    extract_document,
    iter_supported_files,
)
from sidecar.ai.semantic.store import (
    MAX_CATALOG_CHUNKS,
    MAX_CATALOG_DOCUMENTS,
    MAX_CATALOG_ROOTS,
    CatalogStore,
    CatalogStoreError,
    ChunkInput,
    EmbeddableChunk,
    PendingDocument,
    RootRow,
    ScanEntry,
    VectorRow,
    empty_root_counts,
)
from sidecar.ai.semantic.vectors import unpack_vector

MAX_SCAN_FILES_PER_ROOT_STEP = 5_000
# Files one step may walk past before yielding. A root's walk resumes where the
# previous step stopped (until the process restarts), so a large root costs one
# pass per cycle and always completes; the deadline is only checked once a new
# file was recorded, so a fresh walk over the seen prefix still makes progress.
MAX_SCAN_VISITS_PER_ROOT_STEP = 50_000
MAX_SIMILARITY_SCAN_ROWS = 20_000
MAX_SEARCH_LIMIT = 20
MAX_SNIPPET_CHARS = 280
DEFAULT_PROVIDER_BATCH = 16
# Embed requests start small and grow with success, halving on a failure, so a
# slow CPU embedder settles on a batch it can finish.
INITIAL_EMBED_BATCH = 4
# One request may outlast the step budget: llama-server answers only when the
# whole batch is done, and a timed-out request retried unchanged never finishes.
EMBED_REQUEST_TIMEOUT_SECONDS = 30.0
# A single chunk that fails this many times in a row (with the server reachable)
# fails its document, so one bad passage cannot stall the catalog.
POISON_ATTEMPTS = 3
# This many documents failed that way with no success in between means the
# embedder itself is broken: stop failing documents and report the error.
MAX_CONSECUTIVE_POISONED = 3
_PENDING_PAGE = 8
_PYTHON_SCORE_DEADLINE_STRIDE = 256
_SCORE_DECIMALS = 6
_PLACEHOLDER_RE = re.compile(r"\{(text|title)\}")
_CATALOG_CODE_PREFIX = CMP_CATALOG_EMBEDDER_UNAVAILABLE.rsplit("-", 1)[0] + "-"
_STORE_ERRORS = (CatalogStoreError, sqlite3.Error, OSError)


class CatalogEmbeddingProvider(Protocol):
    def embed_many(
        self, texts: Sequence[str], *, timeout_seconds: float
    ) -> list[list[float]]: ...


@dataclass(frozen=True)
class CatalogRootSpec:
    path: str


@dataclass(frozen=True)
class StepResult:
    more: bool
    state: str
    counts: dict[str, int]
    step: dict[str, int]
    error: dict[str, str] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SearchHit:
    root_path: str
    rel_path: str
    locator: str
    snippet: str
    score: float


@dataclass(frozen=True)
class SearchResult:
    hits: list[SearchHit] = field(default_factory=list)
    partial: bool = False
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "hits": [asdict(hit) for hit in self.hits],
            "partial": self.partial,
            "reason": self.reason,
        }


@dataclass
class _Step:
    clock: Callable[[], float]
    deadline: float
    budget_seconds: float
    max_chunks: int
    started: float
    scanned: int = 0
    extracted: int = 0
    embedded: int = 0
    purged: int = 0
    error: dict[str, str] | None = None

    def expired(self) -> bool:
        return self.clock() >= self.deadline

    def remaining(self) -> float:
        return max(self.deadline - self.clock(), 0.0)


def root_key_for(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def render_template(template: str, *, text: str, title: str) -> str:
    values = {"text": text, "title": title}
    return _PLACEHOLDER_RE.sub(lambda match: values[match.group(1)], template)


def _load_numpy() -> Any | None:
    try:
        import numpy
    except Exception:  # noqa: BLE001 - numpy is an optional fast path only.
        return None
    return numpy


def _snippet(text: str) -> str:
    return " ".join(text.split())[:MAX_SNIPPET_CHARS]


def _error(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _provider_error(error: Exception) -> dict[str, str]:
    """Typed embedder errors keep their CMP-CAT code; anything else is "unavailable"."""
    code = getattr(error, "code", None)
    message = getattr(error, "message", None)
    if isinstance(code, str) and code.startswith(_CATALOG_CODE_PREFIX) and isinstance(message, str):
        return _error(code, message)
    return _error(CMP_CATALOG_EMBEDDER_UNAVAILABLE, f"embedder failed ({type(error).__name__})")


class SemanticCatalog:
    """Index/search facade over one ``CatalogStore`` and one embedder."""

    def __init__(  # noqa: PLR0913 - the contract's explicit keyword surface.
        self,
        store: CatalogStore,
        provider: CatalogEmbeddingProvider,
        *,
        model_key: str,
        query_template: str,
        document_template: str,
        dims: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._store = store
        self._provider = provider
        self._model_key = model_key
        self._query_template = query_template
        self._document_template = document_template
        self._dims = dims
        self._clock = clock
        self._roots_capped = False
        self._documents_capped = False
        self._walks: dict[str, Iterator[Path]] = {}
        self._embed_batch = INITIAL_EMBED_BATCH
        self._embed_ceiling = DEFAULT_PROVIDER_BATCH
        self._suspect_chunk: int | None = None
        self._suspect_failures = 0
        self._poisoned_in_a_row = 0

    @property
    def model_key(self) -> str:
        return self._model_key

    def close(self) -> None:
        closer = getattr(self._provider, "close", None)
        if callable(closer):
            closer()
        self._store.close()

    # -- index ---------------------------------------------------------------

    def index_step(
        self,
        roots: Sequence[CatalogRootSpec],
        *,
        max_chunks: int,
        max_seconds: float,
        rescan: bool,
    ) -> StepResult:
        started = self._clock()
        step = _Step(
            clock=self._clock,
            deadline=started + max_seconds,
            budget_seconds=max_seconds,
            max_chunks=max_chunks,
            started=started,
        )
        try:
            active = self._sync_roots(roots, step)
            self._scan_roots(active, rescan, step)
            self._extract_pending(step)
            self._embed_missing(step)
            if step.error is None and self._store.count_missing_vectors(self._model_key) == 0:
                self._store.drop_other_models(self._model_key)
            return self._step_result(active, step)
        except _STORE_ERRORS as error:
            step.error = _error(
                CMP_CATALOG_INDEX_UNAVAILABLE, f"catalog index failed ({type(error).__name__})"
            )
            return StepResult(True, "working", {}, self._step_counters(step), step.error)

    def _sync_roots(self, roots: Sequence[CatalogRootSpec], step: _Step) -> list[RootRow]:
        wanted: dict[str, str] = {}
        for spec in roots:
            real = os.path.realpath(spec.path)
            wanted.setdefault(os.path.normcase(real), real)
        existing = {row.root_key: row for row in self._store.roots()}
        stale = [key for key in existing if key not in wanted]
        if stale:
            step.purged += self._store.delete_roots(stale)
            for key in stale:
                self._walks.pop(key, None)
        self._roots_capped = False
        for key, path in wanted.items():
            known = existing.get(key)
            if (known is None or known.path != path) and not self._store.add_root(key, path):
                self._roots_capped = True
        return [row for row in self._store.roots() if row.root_key in wanted]

    def _scan_roots(self, active: Sequence[RootRow], rescan: bool, step: _Step) -> None:
        if rescan:
            # Open every root's cycle first, so a root later in the list is not
            # skipped when an earlier one uses up this step's budget.
            for row in active:
                if row.scan_complete_at is not None:
                    self._store.begin_rescan(row.root_key)
                    self._walks.pop(row.root_key, None)
            active = [row for row in self._store.roots() if row.root_key in
                      {root.root_key for root in active}]
        scanned_any = False
        for row in active:
            if row.scan_complete_at is not None:
                continue
            if scanned_any and step.expired():
                return  # the first open root always gets this step's walk
            self._scan_root(row, step)
            scanned_any = True

    def _scan_root(self, row: RootRow, step: _Step) -> None:
        guard = CatalogRootGuard(row.path)
        root = guard.root
        if root is None:
            self._walks.pop(row.root_key, None)
            return  # unavailable (e.g. unmounted): keep its rows, retry next step
        walk = self._walks.get(row.root_key)
        if walk is None:
            walk = self._walks[row.root_key] = iter_supported_files(guard)
        known = self._store.document_stats(row.root_key)
        entries: list[ScanEntry] = []
        complete = False
        visits = 0
        while True:
            if (
                len(entries) >= MAX_SCAN_FILES_PER_ROOT_STEP
                or visits >= MAX_SCAN_VISITS_PER_ROOT_STEP
                or (entries and step.expired())
            ):
                break  # checked before pulling, so the walk resumes at the next file
            path = next(walk, None)
            if path is None:
                complete = True
                break
            visits += 1
            rel_path = path.relative_to(root).as_posix()
            stat = known.get(rel_path)
            if stat is not None and stat.seen:
                continue
            try:
                info = path.stat()
            except OSError:
                continue
            entries.append(ScanEntry(rel_path, int(info.st_size), int(info.st_mtime_ns)))
        step.scanned += len(entries)
        if entries and self._store.apply_scan(row.root_key, entries):
            self._documents_capped = True
        if complete:
            self._walks.pop(row.root_key, None)
            step.purged += self._store.complete_scan(row.root_key)

    def _extract_pending(self, step: _Step) -> None:
        backlog = self._store.count_missing_vectors(self._model_key)
        guards: dict[str, CatalogRootGuard] = {}
        while not step.expired() and backlog < step.max_chunks:
            batch = self._store.pending_documents(_PENDING_PAGE)
            if not batch:
                return
            for document in batch:
                if step.expired() or backlog >= step.max_chunks:
                    return
                backlog += self._extract_one(document, guards)
                step.extracted += 1

    def _extract_one(self, document: PendingDocument, guards: dict[str, CatalogRootGuard]) -> int:
        """Extract + chunk one pending document; returns its new un-embedded chunks."""
        guard = guards.setdefault(document.root_key, CatalogRootGuard(document.root_path))
        if guard.root is None:
            self._store.mark_document(document.doc_id, "failed", "root_unavailable")
            return 0
        path = Path(guard.root, *PurePosixPath(document.rel_path).parts)
        try:
            result = extract_document(path, guard)
            chunks = chunk_sections(result.sections) if result.status == "ok" else []
        except Exception:  # noqa: BLE001 - one bad file fails only that document.
            result, chunks = ExtractResult("failed", "extract_error"), []
        if result.status != "ok":
            self._store.mark_document(
                document.doc_id, result.status, result.reason, sha256=result.sha256
            )
            return 0
        if result.sha256 == document.sha256 and document.chunk_count > 0:
            self._store.mark_document(document.doc_id, "indexed", None)
            return 0
        if not chunks:
            self._store.mark_document(document.doc_id, "skipped", "empty", sha256=result.sha256)
            return 0
        stored = self._store.replace_chunks(
            document.doc_id,
            [ChunkInput(chunk.ordinal, chunk.locator, chunk.text) for chunk in chunks],
            result.sha256 or "",
        )
        return len(chunks) if stored else 0

    def _embed_missing(self, step: _Step) -> None:
        max_batch = max(int(getattr(self._provider, "batch_size", DEFAULT_PROVIDER_BATCH)), 1)
        while not step.expired() and step.embedded < step.max_chunks:
            want = min(step.max_chunks - step.embedded, self._embed_batch, max_batch)
            pending = self._store.chunks_missing_vectors(self._model_key, want)
            if not pending:
                return
            texts = [
                render_template(
                    self._document_template,
                    text=chunk.text,
                    title=PurePosixPath(chunk.rel_path).name,
                )
                for chunk in pending
            ]
            try:
                vectors = self._provider.embed_many(
                    texts, timeout_seconds=EMBED_REQUEST_TIMEOUT_SECONDS
                )
            except Exception as error:  # noqa: BLE001 - never escape the step.
                self._embed_failed(pending, error, step)
                return
            self._store.store_vectors(
                self._model_key,
                [(chunk.chunk_id, vector) for chunk, vector in zip(pending, vectors, strict=True)],
            )
            step.embedded += len(pending)
            self._embed_batch = min(self._embed_batch * 2, max_batch, self._embed_ceiling)
            self._suspect_chunk, self._suspect_failures, self._poisoned_in_a_row = None, 0, 0

    def _embed_failed(
        self, pending: Sequence[EmbeddableChunk], error: Exception, step: _Step
    ) -> None:
        """Shrink the batch, then isolate a chunk the reachable embedder keeps refusing."""
        code = getattr(error, "code", None)
        typed = isinstance(code, str) and code.startswith(_CATALOG_CODE_PREFIX)
        if getattr(error, "unreachable", False) or not typed:
            # The server is down, or an unexpected fault: nothing to learn about the batch.
            step.error = _provider_error(error)
            return
        if self._embed_batch > 1:
            self._embed_batch = max(1, self._embed_batch // 2)
            self._embed_ceiling = self._embed_batch  # stop growing back into the failing size
            return  # no error: the next step retries promptly with a smaller batch
        lead = pending[0]
        same = self._suspect_chunk == lead.chunk_id
        self._suspect_chunk = lead.chunk_id
        self._suspect_failures = self._suspect_failures + 1 if same else 1
        if self._suspect_failures < POISON_ATTEMPTS:
            return
        self._suspect_chunk, self._suspect_failures = None, 0
        if self._poisoned_in_a_row >= MAX_CONSECUTIVE_POISONED:
            step.error = _provider_error(error)
            return
        self._poisoned_in_a_row += 1
        self._store.mark_document(lead.doc_id, "failed", "embed_failed")

    def _step_counters(self, step: _Step) -> dict[str, int]:
        return {
            "scanned": step.scanned,
            "extracted": step.extracted,
            "embedded": step.embedded,
            "purged": step.purged,
            "elapsed_ms": int(max(self._clock() - step.started, 0.0) * 1000),
        }

    def _step_result(self, active: Sequence[RootRow], step: _Step) -> StepResult:
        counts = self._store.counts(self._model_key)
        open_scans = any(
            row.scan_complete_at is None and os.path.isdir(row.path)
            for row in self._store.roots()
            if row.root_key in {root.root_key for root in active}
        )
        more = bool(
            open_scans
            or counts["pending"]
            or self._store.count_missing_vectors(self._model_key)
        )
        return StepResult(
            more=more,
            state="working" if more else "caught_up",
            counts=counts,
            step=self._step_counters(step),
            error=step.error,
        )

    # -- search --------------------------------------------------------------

    def search(
        self,
        query: str,
        *,
        root_paths: Sequence[str],
        limit: int = 8,
        timeout_seconds: float = 1.5,
        accept: Callable[[str, str], bool] | None = None,
    ) -> SearchResult:
        """Rank stored chunks of ``root_paths`` by cosine similarity; never raises.

        ``accept(root_path, rel_path)`` narrows the candidates before ranking,
        so a scoped search ranks only in-scope chunks.
        """
        deadline = self._clock() + max(float(timeout_seconds), 0.0)
        if not query.strip() or not root_paths:
            return SearchResult()
        text = render_template(self._query_template, text=query, title="")
        try:
            query_vector = self._provider.embed_many([text], timeout_seconds=timeout_seconds)[0]
        except Exception as error:  # noqa: BLE001 - search must fail soft.
            return SearchResult(reason=_provider_error(error)["code"])
        keys = list(dict.fromkeys(root_key_for(path) for path in root_paths))
        try:
            return self._rank(query_vector, keys, max(1, min(int(limit), MAX_SEARCH_LIMIT)),
                              lambda: self._clock() >= deadline, accept)
        except Exception:  # noqa: BLE001 - search must fail soft.
            return SearchResult(reason=CMP_CATALOG_INDEX_UNAVAILABLE)

    def _rank(
        self,
        query_vector: list[float],
        keys: list[str],
        limit: int,
        expired: Callable[[], bool],
        accept: Callable[[str, str], bool] | None = None,
    ) -> SearchResult:
        query = array("f", query_vector)
        query_norm = math.sqrt(sum(value * value for value in query))
        if query_norm == 0.0:
            return SearchResult()
        rows, partial = self._store.vector_rows(
            self._model_key, keys, dim=len(query), cap=MAX_SIMILARITY_SCAN_ROWS, expired=expired
        )
        if accept is not None:
            rows = [row for row in rows if accept(row.root_path, row.rel_path)]
        scores, scored_partial = _cosine_scores(query, query_norm, rows, expired)
        ranked = sorted(scores, key=lambda pair: (-pair[0], -rows[pair[1]].chunk_id))
        hits = [
            SearchHit(
                root_path=rows[index].root_path,
                rel_path=rows[index].rel_path,
                locator=rows[index].locator,
                snippet=_snippet(rows[index].text),
                score=score,
            )
            for score, index in ranked[:limit]
        ]
        return SearchResult(hits=hits, partial=partial or scored_partial)

    # -- status / purge ------------------------------------------------------

    def status(self) -> dict[str, Any]:
        counts = self._store.counts(self._model_key)
        per_root = self._store.root_counts(self._model_key)
        roots = [
            {
                "path": row.path,
                **per_root.get(row.root_key, empty_root_counts()),
                "scan_complete": row.scan_complete_at is not None,
            }
            for row in self._store.roots()[:MAX_CATALOG_ROOTS]
        ]
        capacity = {
            "roots": self._roots_capped or counts["roots"] >= MAX_CATALOG_ROOTS,
            "documents": self._documents_capped or counts["documents"] >= MAX_CATALOG_DOCUMENTS,
            "chunks": counts["chunks"] >= MAX_CATALOG_CHUNKS
            or self._store.count_skipped_for_cap() > 0,
        }
        reached = any(capacity.values())
        other_models = {
            key: count for key, count in self._store.model_keys().items()
            if key != self._model_key
        }
        return {
            "available": True,
            "schema_version": self._store.schema_version,
            "model_key": self._model_key,
            "dims": self._dims,
            "counts": counts,
            "roots": roots,
            "size_bytes": self._store.size_bytes(),
            "coverage": {
                "embedded": counts["embedded"],
                "chunks": counts["chunks"],
                "complete": counts["embedded"] >= counts["chunks"],
                "other_models": other_models,
            },
            "capacity": {
                **capacity,
                "reached": reached,
                "code": CMP_CATALOG_CAPACITY_REACHED if reached else None,
            },
        }

    def purge(self, root_paths: Sequence[str] | None) -> int:
        """Delete the given roots' rows and scan state (everything when ``None``).

        Returns the number of documents purged; a purged root is rescanned from
        scratch by the next ``index_step`` that names it.
        """
        if root_paths is None:
            self._documents_capped = False
            self._walks.clear()
            return self._store.delete_roots(None)
        keys = list(dict.fromkeys(root_key_for(path) for path in root_paths))
        for key in keys:
            self._walks.pop(key, None)
        return self._store.delete_roots(keys)


def _cosine_scores(
    query: array,
    query_norm: float,
    rows: Sequence[VectorRow],
    expired: Callable[[], bool],
) -> tuple[list[tuple[float, int]], bool]:
    """Return ``[(rounded score, row index)]`` and whether the deadline cut it short."""
    if not rows:
        return [], False
    numpy = _load_numpy()
    if numpy is not None:
        return _cosine_scores_numpy(numpy, query, query_norm, rows), False
    scores: list[tuple[float, int]] = []
    for index, row in enumerate(rows):
        if index % _PYTHON_SCORE_DEADLINE_STRIDE == 0 and index and expired():
            return scores, True
        stored = unpack_vector(row.blob)
        norm = float(row.norm)
        if stored is None or len(stored) != len(query) or not norm or not math.isfinite(norm):
            continue
        dot = math.fsum(a * b for a, b in zip(query, stored, strict=True))
        score = dot / (query_norm * norm)
        if math.isfinite(score):
            scores.append((round(score, _SCORE_DECIMALS), index))
    return scores, False


def _cosine_scores_numpy(
    numpy: Any, query: array, query_norm: float, rows: Sequence[VectorRow]
) -> list[tuple[float, int]]:
    dim = len(query)
    usable = [
        index for index, row in enumerate(rows)
        if len(row.blob) == dim * 4 and row.norm and math.isfinite(float(row.norm))
    ]
    if not usable:
        return []
    matrix = numpy.frombuffer(
        b"".join(rows[index].blob for index in usable), dtype=numpy.float32
    ).reshape(len(usable), dim).astype(numpy.float64)
    norms = numpy.asarray([float(rows[index].norm) for index in usable], dtype=numpy.float64)
    dots = matrix @ numpy.asarray(query, dtype=numpy.float64)
    scores = dots / (norms * query_norm)
    return [
        (round(float(score), _SCORE_DECIMALS), index)
        for score, index in zip(scores.tolist(), usable, strict=True)
        if math.isfinite(score)
    ]
