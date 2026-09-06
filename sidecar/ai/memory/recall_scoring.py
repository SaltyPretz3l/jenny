"""Scoring and recall helpers for memory retrieval."""

from __future__ import annotations

import re
from datetime import datetime, timedelta

from sidecar.ai.memory.datetime_utils import parse_iso_datetime
from sidecar.ai.memory.families import (
    GATED_MEMORY_KINDS,
    PROJECT_CONTEXT_FAMILY_PATTERNS,
    TOOL_STRATEGY_QUERY_PATTERNS,
    WORKING_PREFERENCE_FAMILY_PATTERNS,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"(?u)[^\W_]{2,}")
_RECALL_STOPWORDS = {
    "an",
    "as",
    "at",
    "be",
    "by",
    "if",
    "in",
    "is",
    "it",
    "me",
    "my",
    "of",
    "on",
    "or",
    "to",
    "up",
    "we",
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "have",
    "what",
    "when",
    "where",
    "your",
    "about",
    "should",
    "would",
    "could",
    "there",
    "their",
    "them",
    "then",
    "into",
    "user",
}
TITLE_OVERLAP_WEIGHT = 12.0
LESSON_TEXT_OVERLAP_WEIGHT = 10.0
SOURCE_EXCERPT_OVERLAP_WEIGHT = 8.0
MIN_GATED_OVERLAP_SCORE = 16.0

# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def tokenize(value: str) -> set[str]:
    """Return lowercased tokens (2+ word chars) minus stopwords."""
    return {
        token
        for token in _TOKEN_RE.findall(str(value or "").lower())
        if token not in _RECALL_STOPWORDS
    }


def overlap_count(left: set[str], right: set[str]) -> int:
    if not left or not right:
        return 0
    return len(left & right)


def recency_bonus(updated_at: str, *, now: datetime) -> float:
    raw_updated_at = str(updated_at)
    if raw_updated_at != raw_updated_at.strip():
        return 0.0
    updated = parse_iso_datetime(raw_updated_at)
    if updated is None:
        return 0.0
    if updated >= now - timedelta(days=7):
        return 2.0
    if updated >= now - timedelta(days=30):
        return 1.0
    return 0.0


def intent_patterns_for_memory(
    lesson_kind: str,
    family_key: str,
) -> tuple[re.Pattern[str], ...] | None:
    """Return intent-gate regex patterns for a memory, or ``None``."""
    if not family_key:
        return None
    if lesson_kind == "tool_strategy":
        return TOOL_STRATEGY_QUERY_PATTERNS.get(family_key)
    if lesson_kind == "working_preference":
        return WORKING_PREFERENCE_FAMILY_PATTERNS.get(family_key)
    if lesson_kind == "project_context":
        return PROJECT_CONTEXT_FAMILY_PATTERNS.get(family_key)
    return None


def matches_gated_intent(
    lesson_kind: str,
    family_key: str,
    normalized_query: str,
) -> bool:
    """Return ``True`` when *normalized_query* matches a gated memory's intent."""
    patterns = intent_patterns_for_memory(lesson_kind, family_key)
    if not patterns:
        return False
    return any(pattern.search(normalized_query) for pattern in patterns)


def score_memory(
    *,
    lesson_kind: str,
    family_key: str,
    title: str,
    lesson_text: str,
    source_excerpt: str,
    confidence: float,
    updated_at: str,
    query_tokens: set[str],
    normalized_query: str,
    now: datetime,
) -> float:
    """Compute a relevance score for a single approved memory."""
    is_gated = lesson_kind in GATED_MEMORY_KINDS
    if is_gated and not matches_gated_intent(lesson_kind, family_key, normalized_query):
        return 0.0

    title_overlap = overlap_count(query_tokens, tokenize(title))
    lesson_overlap = overlap_count(query_tokens, tokenize(lesson_text))
    excerpt_overlap = overlap_count(query_tokens, tokenize(source_excerpt))
    weighted_overlap = (
        title_overlap * TITLE_OVERLAP_WEIGHT
        + lesson_overlap * LESSON_TEXT_OVERLAP_WEIGHT
        + excerpt_overlap * SOURCE_EXCERPT_OVERLAP_WEIGHT
    )
    if weighted_overlap <= 0.0:
        return 0.0
    if is_gated and weighted_overlap < MIN_GATED_OVERLAP_SCORE:
        return 0.0
    return (
        weighted_overlap
        + max(0.0, min(float(confidence), 1.0))
        + recency_bonus(updated_at, now=now)
    )
