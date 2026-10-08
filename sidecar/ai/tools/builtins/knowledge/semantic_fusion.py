"""Search by meaning for ``knowledge_search`` (semantic catalog, roadmap row 41).

A natural-language ``query`` is embedded once (bounded deadline) and ranked
against the read-only catalog; the hits are fused with the exact-word matches
by reciprocal rank over files. Without a catalog (off, not built yet, embedder
down) the search falls back to the query's words and says so in one line.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.semantic.catalog import root_key_for
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


@dataclass(frozen=True)
class Passage:
    path: str
    locator: str
    snippet: str


@dataclass
class SemanticOutcome:
    passages: list[Passage] = field(default_factory=list)
    note: str | None = None
    partial: bool = False


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
    query: str,
    *,
    roots: Sequence[KnowledgeRoot],
    start_paths: Sequence[Path | None],
    include: Callable[[Path, Path], bool] | None,
) -> SemanticOutcome:
    """Catalog hits inside the searched roots and scope; never raises."""
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

    result = search_catalog(
        query,
        root_paths=[str(root.path) for root, _start in scoped.values()],
        limit=SEMANTIC_LIMIT + 4,
        timeout_seconds=SEMANTIC_TIMEOUT_SECONDS,
        accept=accept,
    )
    if result is None:
        return SemanticOutcome(note=NOTE_OFF)
    if result.reason is not None:
        return SemanticOutcome(note=NOTE_UNAVAILABLE)
    passages: list[Passage] = []
    for hit in result.hits:  # already narrowed to the scope by ``accept``
        entry = scoped.get(keys.get(hit.root_path) or root_key_for(hit.root_path))
        root_dir = entry[0].path if entry is not None else None
        if entry is None or root_dir is None or not _is_regular(
            root_dir / PurePosixPath(hit.rel_path)
        ):
            continue
        display = display_path(entry[0], root_dir / PurePosixPath(hit.rel_path))
        passages.append(Passage(display, hit.locator, bound_snippet(hit.snippet)))
    return SemanticOutcome(passages=passages[:SEMANTIC_LIMIT], partial=result.partial)


def _is_regular(path: Path) -> bool:
    """An inaccessible candidate (PermissionError) is skipped, never raised."""
    try:
        return path.is_file()
    except OSError:
        return False


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
        }
        for passage in passages
    ]
