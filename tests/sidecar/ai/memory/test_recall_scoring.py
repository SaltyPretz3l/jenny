from __future__ import annotations

from datetime import datetime, timezone

from sidecar.ai.memory.recall_scoring import score_memory, tokenize


def test_tokenize_preserves_meaningful_two_character_terms() -> None:
    assert {"ai", "go", "js", "db"} <= tokenize("AI Go JS DB")


def test_score_memory_matches_two_character_query_tokens() -> None:
    now = datetime.now(timezone.utc)
    query_tokens = tokenize("Go AI preferences")

    score = score_memory(
        title="Go AI workflow",
        lesson_text="The user likes Go and AI tooling.",
        source_excerpt="Go AI",
        confidence=0.8,
        updated_at=now.isoformat(),
        query_tokens=query_tokens,
        now=now,
    )

    assert score > 0.0


def test_every_kind_scores_on_overlap_alone_without_a_family_gate() -> None:
    now = datetime.now(timezone.utc)

    score = score_memory(
        title="Lesson",
        lesson_text="Plan the approach before implementing non-trivial work.",
        source_excerpt="",
        confidence=1.0,
        updated_at=now.isoformat(),
        query_tokens=tokenize("approach"),
        now=now,
    )

    assert score > 0.0
