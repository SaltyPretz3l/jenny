"""Search by meaning for ``knowledge_search`` (semantic catalog, roadmap row 41).

A natural-language ``query`` is embedded once (bounded deadline) and ranked
against the read-only catalog; the hits are fused with the exact-word matches
by reciprocal rank over files. Without a catalog (off, not built yet, embedder
down) the search falls back to the query's words and says so in one line.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.semantic.evidence import current_evidence, root_key_for, source_identity
from sidecar.ai.semantic.reader import search_catalog
from sidecar.ai.tools.builtins.knowledge.roots import KnowledgeRoot, bound_snippet, display_path
from sidecar.ai.tools.builtins.regex_safety import compile_safe_pattern
from sidecar.ai.tools.contracts import ToolExecutionFailure

MAX_QUERY_CHARS = 2000
MAX_QUERY_TERMS = 8
SEMANTIC_LIMIT = 8
SEMANTIC_TIMEOUT_SECONDS = 1.5
RRF_K = 60
_TERM_RE = re.compile(r"\w{3,}")

NOTE_OFF = "Search by meaning is off, so this matched the query's words."
NOTE_UNAVAILABLE = "Search by meaning is unavailable right now, so this matched the query's words."
NOTE_COVERAGE_UNAVAILABLE = (
    "The search index could not be read, so PDF coverage notices (source_statuses) are "
    "unavailable; a missing notice does not mean a PDF's text is complete.")


@dataclass(frozen=True)
class Passage:
    path: str
    locator: str
    snippet: str
    source_hash: str | None = None
    extraction: dict[str, Any] | None = None


@dataclass
class SemanticOutcome:
    passages: list[Passage] = field(default_factory=list)
    note: str | None = None
    partial: bool = False
    source_statuses: list[dict[str, Any]] = field(default_factory=list)
    reason: str | None = None  # the catalog's failure code, with or without a query


def _invalid(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_INVALID_PATH, message=message, retryable=False)


def compile_search_pattern(arguments: dict[str, object]) -> tuple[re.Pattern[str], str | None]:
    """The regex to grep with and the optional ``query``.

    ``pattern`` wins for the grep pass; with only a ``query`` its words become
    a case-insensitive alternation. One of the two is required.
    """
    raw_query = arguments.get("query")
    query: str | None = None
    if raw_query is not None:
        if not isinstance(raw_query, str) or len(raw_query) > MAX_QUERY_CHARS:
            raise _invalid(f"tool argument 'query' must be at most {MAX_QUERY_CHARS} characters")
        query = raw_query.strip() or None
    pattern = arguments.get("pattern")
    ignore_case = arguments.get("ignore_case")
    if not (isinstance(pattern, str) and pattern.strip()):
        if query is None:
            raise _invalid("pass 'pattern' (a regex), 'query' (what to find, in words), or both")
        pattern, ignore_case = query_terms_pattern(query), True
    compiled = compile_safe_pattern(
        pattern,
        ignore_case=isinstance(ignore_case, bool) and ignore_case,
        error_code=CMP_TOOL_INVALID_PATH,
    )
    return compiled, query


def query_terms_pattern(query: str) -> str:
    """An alternation of the query's distinct words (3+ characters) for the grep fallback."""
    terms: list[str] = []
    for term in _TERM_RE.findall(query.lower()):
        if term not in terms:
            terms.append(term)
        if len(terms) >= MAX_QUERY_TERMS:
            break
    if not terms:
        return re.escape(query.strip()[:200])
    return "|".join(re.escape(term) for term in terms)


def _in_scope(resolved: Path, start: Path | None) -> bool:
    if start is None:
        return True
    return resolved == start or start in resolved.parents


def _search_base(root_path: Path, start: Path | None, resolved: Path) -> Path:
    """The directory grep walked for this file, which ``include_glob`` is relative to."""
    if start is None:
        return root_path
    return start.parent if resolved == start else start


def semantic_passages(
    query: str | None,
    *,
    roots: Sequence[KnowledgeRoot],
    start_paths: Sequence[Path | None],
    include: Callable[[Path, Path], bool] | None,
) -> SemanticOutcome:
    """Scoped hits/coverage; None queries return only coverage, without embedding."""
    scoped: dict[str, tuple[KnowledgeRoot, Path | None]] = {}
    for root, start in zip(roots, start_paths, strict=True):
        if root.path is not None:
            scoped[root_key_for(str(root.path))] = (root, start)
    if not scoped:
        return SemanticOutcome()

    keys: dict[str, str] = {}  # stored root path -> key; few roots, many rows

    def accept(root_path: str, rel_path: str) -> bool:
        key = keys.get(root_path)
        if key is None:
            key = keys[root_path] = root_key_for(root_path)
        entry = scoped.get(key)
        if entry is None or entry[0].path is None:
            return False
        base_root, start = entry[0].path, entry[1]
        resolved = base_root / PurePosixPath(rel_path)
        if not _in_scope(resolved, start):
            return False
        return include is None or include(resolved, _search_base(base_root, start, resolved))

    def admit(root_path: str, rel_path: str, expected: str | None,
              extraction: dict[str, Any] | None) -> bool:
        entry = scoped.get(keys.get(root_path) or root_key_for(root_path))
        if entry is None or entry[0].path is None:
            return False
        return current_evidence(entry[0].path / PurePosixPath(rel_path), entry[0].guard,
                                expected, extraction)

    result = search_catalog(
        query,
        root_paths=[str(root.path) for root, _start in scoped.values()],
        limit=SEMANTIC_LIMIT + 4,
        timeout_seconds=SEMANTIC_TIMEOUT_SECONDS,
        accept=accept,
        admit=admit,  # current sources only, before the catalog's caps
    )
    if result is None:
        return SemanticOutcome(note=NOTE_OFF if query is not None else None)
    note = None
    if result.reason:
        note = NOTE_UNAVAILABLE if query is not None else NOTE_COVERAGE_UNAVAILABLE
    return SemanticOutcome(
        passages=_passages(result.hits, scoped)[:SEMANTIC_LIMIT], partial=result.partial,
        note=note, source_statuses=_source_statuses(result.source_statuses, scoped, accept),
        reason=result.reason,
    )


def _passages(
    hits: Sequence[Any], scoped: dict[str, tuple[KnowledgeRoot, Path | None]],
) -> list[Passage]:
    """Display-path passages; hits are narrowed by ``accept`` and current by ``admit``."""
    passages: list[Passage] = []
    for hit in hits:
        entry = scoped.get(root_key_for(hit.root_path))
        root_dir = entry[0].path if entry is not None else None
        if entry is None or root_dir is None:
            continue
        display = display_path(entry[0], root_dir / PurePosixPath(hit.rel_path))
        passages.append(Passage(display, hit.locator, bound_snippet(hit.snippet),
                                hit.source_hash, hit.extraction))
    return passages


def _source_statuses(
    rows: Sequence[dict[str, Any]], scoped: dict[str, tuple[KnowledgeRoot, Path | None]],
    accept: Callable[[str, str], bool],
) -> list[dict[str, Any]]:
    statuses: list[dict[str, Any]] = []
    for status in rows:
        entry = scoped.get(root_key_for(status["root_path"]))
        if entry is None or entry[0].path is None:
            continue
        if not accept(status["root_path"], status["rel_path"]):
            continue
        path = entry[0].path / PurePosixPath(status["rel_path"])
        statuses.append({"path": display_path(entry[0], path), "extraction": status["extraction"]})
    return statuses


def fuse_entries(
    exact: Sequence[tuple[str, str]],
    passages: Sequence[Passage],
) -> list[tuple[str, str]]:
    """Reciprocal-rank fusion over files: ``[(display path, snippet)]``, best first.

    A file found by both lists ranks above either alone; its snippet comes from
    the passage, which is the part that matched by meaning.
    """
    scores: dict[str, float] = {}
    snippets: dict[str, str] = {}
    for rank, (path, snippet) in enumerate(exact, start=1):
        if path not in scores:
            scores[path] = 1.0 / (RRF_K + rank)
            snippets[path] = snippet
    seen: set[str] = set()
    for rank, passage in enumerate(passages, start=1):
        if passage.path in seen:
            continue
        seen.add(passage.path)
        scores[passage.path] = scores.get(passage.path, 0.0) + 1.0 / (RRF_K + rank)
        snippets[passage.path] = passage.snippet
    order = sorted(scores, key=lambda path: -scores[path])
    return [(path, snippets[path]) for path in order]


def attach_identities(
    sources: Sequence[dict[str, object]],
    passages: Sequence[Passage],
    lexical: Mapping[str, tuple[KnowledgeRoot, Path]],
    *,
    limit: int,
) -> bool:
    """Pin each cited source to its current bytes; True when ``limit`` cut some off.

    A source found by meaning keeps its passage hash and extraction receipt. A
    lexical-only source gets a fresh ``source_hash`` plus its ``locator_kind``,
    hashed for at most ``limit`` sources per call; later ones stay unpinned.
    """
    identities = {passage.path: passage for passage in passages}
    hashed = 0
    truncated = False
    for source in sources:
        path = str(source.get("path"))
        passage = identities.get(path)
        if passage is not None:
            if passage.source_hash:
                source["source_hash"] = passage.source_hash
            if passage.extraction:
                source["extraction"] = passage.extraction
            continue
        entry = lexical.get(path)
        if entry is None:
            continue
        if hashed >= limit:
            truncated = True
            continue
        hashed += 1
        identity = source_identity(entry[1], entry[0].guard)
        if identity is not None:
            source.update(identity)
    return truncated


def passages_payload(
    passages: Sequence[Passage],
    sources: Sequence[dict[str, object]],
) -> list[dict[str, object]]:
    """The passages with their ``kb:N`` source ids, for the model to cite or open."""
    ids = {str(source.get("path")): str(source.get("id")) for source in sources}
    return [
        {
            "source": ids.get(passage.path, ""),
            "path": passage.path,
            "locator": passage.locator,
            "text": passage.snippet,
            **({"source_hash": passage.source_hash} if passage.source_hash else {}),
            **({"extraction": passage.extraction} if passage.extraction else {}),
        }
        for passage in passages
    ]
