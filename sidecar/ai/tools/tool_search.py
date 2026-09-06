"""Deferred tool loading, fuzzy search index, and history-based un-deferral.

Feature-flag gated by ``FEATURE_TOOL_SEARCH``.  When active, tools that
exceed a token-cost threshold are *deferred* -- the model sees their
names but not their full schemas.  The model can discover deferred tools
via the synthetic ``tool_search`` tool, which performs fuzzy keyword
matching and returns full schemas.

Once a tool is un-deferred it stays un-deferred for the remainder of
the session.  On session resume the un-deferral set is reconstructed by
scanning message history for prior ``tool_search_result`` entries.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Sequence

# ── Constants ───────────────────────────────────────────────────────

DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10
DEFAULT_MAX_RESULTS = 5
MAX_QUERY_LENGTH = 512
MAX_QUERY_TERMS = 32
MAX_RESULTS = 25
MIN_ID_PREFIX_LENGTH = 3
TOOL_SEARCH_TOOL_NAME = "tool_search"

# Scoring weights
SCORE_EXACT_ID = 100
SCORE_ID_PREFIX = 40
SCORE_ALIAS = 30
SCORE_EXACT_PART_BUILTIN = 10
SCORE_EXACT_PART_MCP = 12
SCORE_PARTIAL_PART_BUILTIN = 5
SCORE_PARTIAL_PART_MCP = 6
SCORE_FULL_NAME_FALLBACK = 3
SCORE_SEARCH_HINT = 4
SCORE_DESCRIPTION = 2

# Message-history kind used for tool_search results
TOOL_SEARCH_RESULT_KIND = "tool_search_result"


# ── Enums and data structures ───────────────────────────────────────


class DeferralMode(str, Enum):
    """How tool deferral is decided."""

    TST = "tst"
    TST_AUTO = "tst-auto"
    STANDARD = "standard"


def normalize_deferral_mode(
    value: object,
    *,
    default: DeferralMode = DeferralMode.TST,
) -> DeferralMode:
    token = str(value or "").strip().lower()
    for mode in DeferralMode:
        if mode.value == token:
            return mode
    return default


@dataclass(frozen=True)
class ScoredTool:
    """A tool match with its fuzzy relevance score."""

    name: str
    score: int
    description: str = ""


@dataclass
class ToolResolutionContext:
    """Per-request state for deferred tool resolution.

    Created at the start of ``build_chat_decision()`` and passed
    through the tool loop.  ``un_deferred_names`` is mutable and grows
    monotonically as ToolSearch discovers tools.
    """

    deferred_names: frozenset[str]
    un_deferred_names: set[str] = field(default_factory=set)
    search_index: ToolSearchIndex | None = None
    budget_filtered_names: frozenset[str] = frozenset()
    budget_filter_metadata: dict[str, Any] = field(default_factory=dict)
    retired_names: frozenset[str] = frozenset()

    def remaining_unexposed_names(self) -> frozenset[str]:
        """Return deferred or budget-filtered tools not yet expanded by search.

        ``retired_names`` are subtracted outright. A tool retired mid-turn is
        also added to ``budget_filtered_names`` for the advertisement gate, and
        without this subtraction that alone would put it back INSIDE the
        searchable set -- letting ToolSearch re-promote the very tool the
        retirement had just removed.
        """
        hidden_names = self.deferred_names | self.budget_filtered_names
        return hidden_names - frozenset(self.un_deferred_names) - self.retired_names


def hidden_unexposed_tool_names(resolution_context: Any | None) -> frozenset[str]:
    """Return tool names hidden from the model for *resolution_context*."""
    if resolution_context is None:
        return frozenset()
    return resolution_context.remaining_unexposed_names()


# ── Name parsing helpers ────────────────────────────────────────────

_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def _parse_tool_name_parts(name: str, *, is_mcp: bool) -> list[str]:
    """Split a tool name into lowercase searchable parts."""
    if is_mcp:
        return [p.lower() for segment in name.split("__") for p in segment.split("_") if p]
    expanded = _CAMEL_BOUNDARY.sub(" ", name)
    return [p.lower() for p in expanded.replace("_", " ").split() if p]


def _is_mcp_tool_name(name: str) -> bool:
    return name.startswith("mcp__")


# ── Query parsing ───────────────────────────────────────────────────


@dataclass(frozen=True)
class ParsedQuery:
    """Decomposed search query."""

    mode: str  # "select" | "fuzzy"
    select_names: tuple[str, ...]  # only for mode="select"
    required_terms: tuple[str, ...]  # prefixed with +
    optional_terms: tuple[str, ...]


def parse_tool_search_query(query: str) -> ParsedQuery:
    """Parse a ToolSearch query string.

    ``select:Name1,Name2`` triggers direct selection.  Otherwise tokens
    prefixed with ``+`` are required; the rest are optional fuzzy terms.
    """
    raw = query.strip()
    if len(raw) > MAX_QUERY_LENGTH:
        raise ValueError(f"tool_search query exceeds {MAX_QUERY_LENGTH} characters")
    if raw.startswith("select:"):
        names = tuple(n.strip() for n in raw[len("select:") :].split(",") if n.strip())
        if len(names) > MAX_QUERY_TERMS:
            raise ValueError(f"tool_search select query has too many names; max {MAX_QUERY_TERMS}")
        return ParsedQuery(mode="select", select_names=names, required_terms=(), optional_terms=())

    tokens = raw.split()
    if len(tokens) > MAX_QUERY_TERMS:
        raise ValueError(f"tool_search query has too many terms; max {MAX_QUERY_TERMS}")
    required: list[str] = []
    optional: list[str] = []
    for token in tokens:
        if token.startswith("+") and len(token) > 1:
            required.append(token[1:].lower())
        elif token:
            optional.append(token.lower())
    return ParsedQuery(
        mode="fuzzy",
        select_names=(),
        required_terms=tuple(required),
        optional_terms=tuple(optional),
    )


# ── Fuzzy scoring ──────────────────────────────────────────────────


def score_tool(  # noqa: PLR0913 - optional precompiled patterns avoid per-candidate work.
    query_terms: Sequence[str],
    tool_name: str,
    description: str,
    *,
    is_mcp: bool,
    aliases: Sequence[str] = (),
    search_hint: str = "",
    term_patterns: Mapping[str, re.Pattern[str]] | None = None,
) -> int:
    """Score a single tool against lowercased *query_terms*.

    Returns 0 for no match; higher is better.
    """
    if not query_terms:
        return 0

    parts = _parse_tool_name_parts(tool_name, is_mcp=is_mcp)
    name_lower = tool_name.lower()
    aliases_lower = {alias.lower() for alias in aliases}
    total = 0

    exact_builtin = SCORE_EXACT_PART_MCP if is_mcp else SCORE_EXACT_PART_BUILTIN
    partial_builtin = SCORE_PARTIAL_PART_MCP if is_mcp else SCORE_PARTIAL_PART_BUILTIN

    for term in query_terms:
        matched = False
        pattern = term_patterns.get(term) if term_patterns is not None else None
        term_lower = term.lower()
        if term_lower == name_lower:
            total += SCORE_EXACT_ID
            continue
        if len(term_lower) >= MIN_ID_PREFIX_LENGTH and name_lower.startswith(term_lower):
            total += SCORE_ID_PREFIX
            continue
        if term_lower in aliases_lower:
            total += SCORE_ALIAS
            continue
        for part in parts:
            if term == part:
                total += exact_builtin
                matched = True
                break
            if term in part:
                total += partial_builtin
                matched = True
                break
        if not matched and term in name_lower:
            total += SCORE_FULL_NAME_FALLBACK
            matched = True
        if not matched and pattern is None and (search_hint or description):
            try:
                pattern = re.compile(r"\b" + re.escape(term) + r"\b", re.IGNORECASE)
            except re.error:
                pass
        if search_hint and not matched and pattern is not None and pattern.search(search_hint):
            total += SCORE_SEARCH_HINT
            matched = True
        if description and not matched and pattern is not None and pattern.search(description):
            total += SCORE_DESCRIPTION
    return total


# ── Search index ────────────────────────────────────────────────────


@dataclass(frozen=True)
class _IndexEntry:
    name: str
    description: str
    search_hint: str
    is_mcp: bool
    aliases: tuple[str, ...] = ()


class ToolSearchIndex:
    """Fuzzy search index over deferred tools."""

    def __init__(self, entries: Sequence[_IndexEntry]) -> None:
        self._entries = tuple(entries)
        self._by_name: dict[str, _IndexEntry] = {e.name: e for e in self._entries}

    def search(self, query: str, max_results: int = DEFAULT_MAX_RESULTS) -> list[ScoredTool]:
        """Fuzzy keyword search.  Returns up to *max_results* matches sorted by score."""
        parsed = parse_tool_search_query(query)
        if parsed.mode == "select":
            return self.select(list(parsed.select_names))

        all_terms = list(parsed.required_terms) + list(parsed.optional_terms)
        if not all_terms:
            return []

        # Pre-filter on required terms
        candidates = list(self._entries)
        if parsed.required_terms:
            filtered: list[_IndexEntry] = []
            for entry in candidates:
                haystack = f"{entry.name} {entry.description} {entry.search_hint}".lower()
                if all(req in haystack for req in parsed.required_terms):
                    filtered.append(entry)
            candidates = filtered

        term_patterns: dict[str, re.Pattern[str]] = {}
        for term in all_terms:
            try:
                term_patterns[term] = re.compile(
                    r"\b" + re.escape(term) + r"\b",
                    re.IGNORECASE,
                )
            except re.error:
                continue

        scored: list[ScoredTool] = []
        for entry in candidates:
            s = score_tool(
                all_terms,
                entry.name,
                entry.description,
                is_mcp=entry.is_mcp,
                aliases=entry.aliases,
                search_hint=entry.search_hint,
                term_patterns=term_patterns,
            )
            if s > 0:
                scored.append(ScoredTool(name=entry.name, score=s, description=entry.description))

        scored.sort(key=lambda t: t.score, reverse=True)
        return scored[:max_results]

    def select(self, names: list[str]) -> list[ScoredTool]:
        """Direct selection by exact name (case-insensitive)."""
        lower_map = {n.lower(): e for n, e in self._by_name.items()}
        results: list[ScoredTool] = []
        for name in names:
            entry = lower_map.get(name.lower())
            if entry is not None:
                results.append(
                    ScoredTool(name=entry.name, score=100, description=entry.description)
                )
        return results

# ── Deferral set computation ────────────────────────────────────────


def compute_deferral_set(
    mode: DeferralMode,
    all_descriptors: Sequence[Any],
    builtin_names: frozenset[str],
    *,
    context_window: int = 0,
    tool_token_threshold_pct: int = DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE,
) -> frozenset[str]:
    """Return tool names that should be deferred (schema hidden from model).

    Built-in tools are never deferred.  The ``tool_search`` tool itself
    is never deferred.
    """
    if mode == DeferralMode.STANDARD:
        return frozenset()

    never_defer = builtin_names | {TOOL_SEARCH_TOOL_NAME}
    candidates = [d for d in all_descriptors if d.name not in never_defer]

    if mode == DeferralMode.TST:
        return frozenset(d.name for d in candidates)

    # TST_AUTO: defer only when MCP tool description tokens exceed threshold
    if context_window <= 0 or tool_token_threshold_pct <= 0:
        return frozenset()
    estimated_tokens = sum(
        len(str(getattr(d, "description", "") or "")) // 4
        + len(str(getattr(d, "input_schema", {}) or {})) // 4
        for d in candidates
    )
    threshold = context_window * tool_token_threshold_pct // 100
    if estimated_tokens > threshold:
        return frozenset(d.name for d in candidates)
    return frozenset()


# ── Tool payload builders ───────────────────────────────────────────


def build_deferred_tool_entry(name: str, description: str) -> dict[str, Any]:
    """Build a name-only tool entry for the API payload (no input_schema)."""
    return {
        "name": name,
        "description": description,
        "defer_loading": True,
    }


# ── History scanning for un-deferral recovery ───────────────────────


def scan_history_for_undeferrals(
    messages: Sequence[dict[str, Any]],
) -> frozenset[str]:
    """Scan message history for prior ToolSearch results.

    Returns tool names that were previously un-deferred so the router
    can reconstruct the deferral state on session resume.
    """
    un_deferred: set[str] = set()
    for msg in messages:
        kind = msg.get("kind", "")
        if kind == TOOL_SEARCH_RESULT_KIND:
            content = msg.get("content")
            if isinstance(content, dict):
                discovered = content.get("discovered_tools")
                if isinstance(discovered, list):
                    for name in discovered:
                        if isinstance(name, str) and name.strip():
                            un_deferred.add(name.strip())
            continue
        # Also scan tool_result messages for tool_search responses
        role = msg.get("role", "")
        tool_result = msg.get("tool_result")
        if role == "tool" and isinstance(tool_result, dict):
            tool_name = tool_result.get("tool_name", "")
            if tool_name == TOOL_SEARCH_TOOL_NAME:
                metadata = tool_result.get("metadata")
                if isinstance(metadata, dict):
                    if metadata.get("kind") == TOOL_SEARCH_RESULT_KIND:
                        discovered = metadata.get("discovered_tools")
                        if isinstance(discovered, list):
                            for name in discovered:
                                if isinstance(name, str) and name.strip():
                                    un_deferred.add(name.strip())
                if metadata is not None:
                    continue
                output = tool_result.get("output", "")
                if isinstance(output, str):
                    for line in output.splitlines():
                        stripped = line.strip()
                        if stripped.startswith("- ") and ":" in stripped:
                            name_part = stripped[2:].split(":")[0].strip()
                            if name_part:
                                un_deferred.add(name_part)
    return frozenset(un_deferred)


# ── Search index builder ────────────────────────────────────────────


def build_search_index(
    deferred_names: frozenset[str],
    all_descriptors: Sequence[Any],
) -> ToolSearchIndex:
    """Build a search index over the deferred tool set."""
    entries: list[_IndexEntry] = []
    for d in all_descriptors:
        if d.name not in deferred_names:
            continue
        entries.append(
            _IndexEntry(
                name=d.name,
                description=getattr(d, "description", "") or "",
                search_hint=getattr(d, "search_hint", "") or "",
                is_mcp=_is_mcp_tool_name(d.name),
                aliases=tuple(getattr(d, "aliases", ()) or ()),
            )
        )
    return ToolSearchIndex(entries)
