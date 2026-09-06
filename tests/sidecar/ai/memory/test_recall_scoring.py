from __future__ import annotations

from datetime import datetime, timezone

from sidecar.ai.memory.recall_scoring import score_memory, tokenize


def test_tokenize_preserves_meaningful_two_character_terms() -> None:
    assert {"ai", "go", "js", "db"} <= tokenize("AI Go JS DB")


def test_score_memory_matches_two_character_query_tokens() -> None:
    now = datetime.now(timezone.utc)
    query_tokens = tokenize("Go AI preferences")

    score = score_memory(
        lesson_kind="preference",
        family_key="",
        title="Go AI workflow",
        lesson_text="The user likes Go and AI tooling.",
        source_excerpt="Go AI",
        confidence=0.8,
        updated_at=now.isoformat(),
        query_tokens=query_tokens,
        normalized_query="go ai preferences",
        now=now,
    )

    assert score > 0.0
