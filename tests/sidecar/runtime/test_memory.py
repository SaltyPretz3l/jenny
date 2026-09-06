"""Unit tests for sidecar.runtime.memory extraction, normalization, and validation."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from sidecar.ai.memory.store import MemoryStore
from sidecar.runtime.memory import (
    GENERIC_CAPTURE_VALUES,
    MAX_CAPTURE_LENGTH,
    _build_fingerprint,
    _normalize_capture,
    _normalize_lesson_text,
    _normalize_title,
    _sanitize_source_excerpt,
    _validate_capture,
    delete_pending_memory,
    list_memories_page,
    save_memory_candidate,
    suggest_memories,
    update_memory,
)


def _insert_pending_candidate(  # noqa: PLR0913 - migrated-row fixture mirrors schema.
    store: MemoryStore,
    *,
    session_id: str,
    source_request_id: str,
    title: str,
    lesson_text: str,
    lesson_kind: str,
    confidence: float,
    source_excerpt: str,
    category: str = "",
) -> int:
    timestamp = datetime.now(timezone.utc).isoformat()
    cursor = store._connection.execute(  # noqa: SLF001
        """
        INSERT INTO pending_memory_candidates (
            session_id, source_request_id, title, lesson_text, lesson_kind,
            confidence, source_excerpt, content_fingerprint, family_key,
            category, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
        """,
        (
            session_id,
            source_request_id,
            title,
            lesson_text,
            lesson_kind,
            confidence,
            source_excerpt,
            _build_fingerprint(lesson_kind, lesson_text),
            category,
            timestamp,
            timestamp,
        ),
    )
    store._connection.commit()  # noqa: SLF001
    assert cursor.lastrowid is not None
    return int(cursor.lastrowid)


# ---------------------------------------------------------------------------
# _normalize_capture
# ---------------------------------------------------------------------------


def test_normalize_capture_removes_please_and_thanks() -> None:
    assert _normalize_capture("please use dark mode thanks") == "use dark mode"


def test_normalize_capture_strips_trailing_punctuation() -> None:
    assert _normalize_capture("use dark mode!!!") == "use dark mode"


def test_normalize_capture_normalizes_whitespace() -> None:
    assert _normalize_capture("  use   dark\tmode  ") == "use dark mode"


def test_normalize_capture_handles_empty_string() -> None:
    assert _normalize_capture("") == ""


# ---------------------------------------------------------------------------
# _validate_capture
# ---------------------------------------------------------------------------


def test_validate_capture_rejects_too_short() -> None:
    assert _validate_capture("ab") is False


def test_validate_capture_rejects_too_long() -> None:
    assert _validate_capture("a " * (MAX_CAPTURE_LENGTH + 1)) is False


def test_validate_capture_rejects_generic_values() -> None:
    for generic in GENERIC_CAPTURE_VALUES:
        assert _validate_capture(generic) is False


def test_validate_capture_rejects_too_many_words() -> None:
    assert (
        _validate_capture("one two three four five six seven eight nine ten eleven twelve") is False
    )


def test_validate_capture_accepts_valid_value() -> None:
    assert _validate_capture("dark mode") is True


def test_validate_capture_accepts_value_at_min_length() -> None:
    assert _validate_capture("tea") is True


# ---------------------------------------------------------------------------
# _build_fingerprint
# ---------------------------------------------------------------------------


def test_build_fingerprint_normalizes_and_prefixes() -> None:
    fp = _build_fingerprint("preference", "The user prefers tea.")
    assert fp.startswith("sha256:")
    assert len(fp) == 71
    assert " " not in fp


def test_build_fingerprint_truncates_at_160() -> None:
    long_text = "word " * 100
    fp = _build_fingerprint("profile", long_text)
    assert len(fp) == 71


def test_build_fingerprint_is_lowercase() -> None:
    fp = _build_fingerprint("preference", "The User PREFERS Tea.")
    assert fp == fp.lower()


# ---------------------------------------------------------------------------
# _normalize_title / _normalize_lesson_text
# ---------------------------------------------------------------------------


def test_normalize_title_truncates_to_120() -> None:
    result = _normalize_title("x" * 200)
    assert len(result) == 120


def test_normalize_lesson_text_appends_period_if_missing() -> None:
    assert _normalize_lesson_text("The user likes tea").endswith(".")


def test_normalize_lesson_text_does_not_double_period() -> None:
    result = _normalize_lesson_text("The user likes tea.")
    assert not result.endswith("..")


def test_normalize_lesson_text_truncates_to_240() -> None:
    result = _normalize_lesson_text("x" * 300)
    assert len(result) == 240


def test_source_provenance_sanitization_bounds_input_before_redaction() -> None:
    source = (
        r"C:\Users\Alice\private\notes.txt alice@example.com api_key=sk-test-secret-value "
        + ("private detail " * 10_000)
    )

    excerpt = _sanitize_source_excerpt(source)

    assert len(excerpt) <= 240
    assert "Alice" not in excerpt
    assert "alice@example.com" not in excerpt
    assert "sk-test-secret-value" not in excerpt
    assert "[LOCAL_PATH_REDACTED]" in excerpt
    assert "[EMAIL_REDACTED]" in excerpt


# ---------------------------------------------------------------------------
# suggest_memories — profile / preference patterns
# ---------------------------------------------------------------------------


@pytest.fixture()
def empty_store(tmp_path: Path) -> MemoryStore:
    store = MemoryStore(tmp_path / "memory.db")
    yield store
    store.close()


def test_suggest_profile_my_name_is(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "my name is Brendan"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "profile"
    assert "Brendan" in suggestions[0]["lesson_text"]


def test_suggest_profile_call_me(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "call me Bren"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "profile"
    assert "Bren" in suggestions[0]["lesson_text"]


def test_suggest_preference_i_prefer(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "I prefer dark mode for coding"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "preference"


def test_suggest_preference_i_like(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "I like TypeScript"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "preference"


def test_suggest_preference_i_dislike(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "I dislike verbose code"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "preference"


def test_suggested_provenance_is_redacted_before_it_can_be_persisted(
    empty_store: MemoryStore,
) -> None:
    messages = [{
        "role": "user",
        "content": r"my goal is to use C:\Users\Alice\private\notes api_key=sk-test-secret-value",
    }]

    suggestions = suggest_memories(messages=messages, memory_store=empty_store)

    assert len(suggestions) == 1
    excerpt = str(suggestions[0]["source_excerpt"])
    assert "Alice" not in excerpt
    assert "sk-test-secret-value" not in excerpt
    assert "[LOCAL_PATH_REDACTED]" in excerpt


def test_list_memories_redacts_legacy_source_provenance(
    empty_store: MemoryStore,
) -> None:
    empty_store.save_memory(
        session_id="legacy-session",
        title="Preference: concise replies",
        lesson_text="The user prefers concise replies.",
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt=r"C:\Users\Alice\private\notes.txt api_key=sk-test-secret-value",
    )

    page = list_memories_page(cursor=None, limit=10, memory_store=empty_store)

    excerpt = str(page["memories"][0]["source_excerpt"])
    assert "Alice" not in excerpt
    assert "sk-test-secret-value" not in excerpt
    assert "[LOCAL_PATH_REDACTED]" in excerpt


# ---------------------------------------------------------------------------
# suggest_memories — response style patterns
# ---------------------------------------------------------------------------


def test_suggest_response_style_concise(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "be concise please"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "response_style"
    assert "concise" in suggestions[0]["lesson_text"].lower()


def test_suggest_response_style_step_by_step(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "walk me through this step by step"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "response_style"


# ---------------------------------------------------------------------------
# suggest_memories — tool strategy patterns
# ---------------------------------------------------------------------------


def test_suggest_tool_strategy_prefer_ripgrep(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "prefer rg for searching code"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "tool_strategy"
    assert "ripgrep" in suggestions[0]["lesson_text"].lower()


def test_suggest_tool_strategy_plan_before_implementation(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "plan before implementation"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "tool_strategy"


# ---------------------------------------------------------------------------
# suggest_memories — working preference patterns
# ---------------------------------------------------------------------------


def test_suggest_working_preference_root_cause(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "diagnose the root cause first"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "working_preference"


def test_suggest_working_preference_schema_migrations(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "treat schema changes as migrations"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "working_preference"


# ---------------------------------------------------------------------------
# suggest_memories — project context patterns
# ---------------------------------------------------------------------------


def test_suggest_project_context_no_git(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "this workspace has no .git metadata"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "project_context"


def test_suggest_project_context_no_vector_db(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "do not use a vector db for memory"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "project_context"


# ---------------------------------------------------------------------------
# suggest_memories â€” routine / goal / important person patterns
# ---------------------------------------------------------------------------


def test_suggest_routine_morning(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "Every morning I stretch, journal, and make tea."}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "routine"
    assert "stretch, journal, and make tea" in suggestions[0]["lesson_text"]


def test_suggest_goal_working_toward(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "I'm working toward finishing my portfolio by summer."}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "goal"
    assert "finishing my portfolio by summer" in suggestions[0]["title"]


def test_suggest_important_person_generic_relationship(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "My coworker Alex helped me prep for the demo."}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "important_person"
    assert suggestions[0]["title"] == "Important person: Alex (coworker)"
    assert suggestions[0]["lesson_text"] == "The user's coworker is Alex."


def test_suggest_important_person_explicit_relationship_stops_at_sentence_continuation(
    empty_store: MemoryStore,
) -> None:
    messages = [{"role": "user", "content": "my partner alex is very supportive."}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "important_person"
    assert suggestions[0]["title"] == "Important person: Alex (partner)"
    assert suggestions[0]["lesson_text"] == "The user's partner is Alex."


@pytest.mark.parametrize(
    "content",
    [
        "Morning routines are hard to keep.",
        "Goals can change over time.",
        "My friend is visiting this weekend.",
    ],
)
def test_suggest_new_memory_kinds_ignore_near_misses(
    empty_store: MemoryStore, content: str
) -> None:
    messages = [{"role": "user", "content": content}]
    assert suggest_memories(messages=messages, memory_store=empty_store) == []


# ---------------------------------------------------------------------------
# suggest_memories — deduplication and edge cases
# ---------------------------------------------------------------------------


def test_suggest_skips_already_saved_fingerprints(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "my name is Alice"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1

    # Save the suggestion, then re-suggest — should return empty
    empty_store.save_memory(
        session_id="s1",
        title=suggestions[0]["title"],
        lesson_text=suggestions[0]["lesson_text"],
        lesson_kind=suggestions[0]["lesson_kind"],
        confidence=suggestions[0]["confidence"],
        source_excerpt=suggestions[0]["source_excerpt"],
    )
    second = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(second) == 0


def test_suggest_ignores_assistant_messages(empty_store: MemoryStore) -> None:
    messages = [{"role": "assistant", "content": "my name is Jenny"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 0


def test_suggest_returns_at_most_one(empty_store: MemoryStore) -> None:
    messages = [
        {"role": "user", "content": "my name is Alice"},
        {"role": "user", "content": "I prefer dark mode"},
    ]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) <= 1


def test_suggest_rejects_generic_captures(empty_store: MemoryStore) -> None:
    messages = [{"role": "user", "content": "I prefer it"}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 0


@pytest.mark.parametrize(
    "content, expected_kind",
    [
        ("Every morning I read for twenty minutes.", "routine"),
        ("My goal is to finish the garden this spring.", "goal"),
        ("my partner alex is very supportive.", "important_person"),
    ],
)
def test_suggest_new_kinds_skip_saved_fingerprints(
    empty_store: MemoryStore,
    content: str,
    expected_kind: str,
) -> None:
    messages = [{"role": "user", "content": content}]
    suggestions = suggest_memories(messages=messages, memory_store=empty_store)
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == expected_kind

    empty_store.save_memory(
        session_id="s1",
        title=suggestions[0]["title"],
        lesson_text=suggestions[0]["lesson_text"],
        lesson_kind=suggestions[0]["lesson_kind"],
        confidence=suggestions[0]["confidence"],
        source_excerpt=suggestions[0]["source_excerpt"],
    )

    assert suggest_memories(messages=messages, memory_store=empty_store) == []


@pytest.mark.parametrize(
    ("lesson_kind", "title", "lesson_text"),
    [
        (
            "routine",
            "Routine: morning routine",
            "The user's morning routine includes stretching and tea.",
        ),
        ("goal", "Goal: finish the garden", "The user's goal is to finish the garden."),
        ("important_person", "Important person: Alex (partner)", "The user's partner is Alex."),
    ],
)
def test_save_memory_candidate_accepts_new_kinds(
    empty_store: MemoryStore,
    lesson_kind: str,
    title: str,
    lesson_text: str,
) -> None:
    result = save_memory_candidate(
        session_id="session-new-kind",
        candidate={
            "title": title,
            "lesson_text": lesson_text,
            "lesson_kind": lesson_kind,
            "confidence": 0.92,
            "source_excerpt": title,
        },
        memory_store=empty_store,
    )

    assert result.created is True
    assert result.memory.lesson_kind == lesson_kind
    assert result.memory.family_key == ""


def test_save_memory_candidate_rejects_unsupported_commitment_kind(
    empty_store: MemoryStore,
) -> None:
    with pytest.raises(ValueError, match="CMP-MEM-0003"):
        save_memory_candidate(
            session_id="session-unsupported-kind",
            candidate={
                "title": "Commitment: school pickup",
                "lesson_text": "Pick up Sam from school at 3 PM.",
                "lesson_kind": "commitment",
                "confidence": 0.95,
                "source_excerpt": "school pickup",
            },
            memory_store=empty_store,
        )


def test_save_memory_candidate_bounds_and_redacts_source_provenance(
    empty_store: MemoryStore,
) -> None:
    source = (
        r"C:\Users\Alice\secret.txt \\server\private\note.txt /workspace/jenny/plan.md "
        "alice@example.com api_key=sk-test-secret "
        + ("private detail " * 40)
    )

    result = save_memory_candidate(
        session_id="session-provenance",
        candidate={
            "title": "Preference: concise replies",
            "lesson_text": "The user prefers concise replies.",
            "lesson_kind": "preference",
            "confidence": 0.9,
            "source_excerpt": source,
        },
        memory_store=empty_store,
    )

    excerpt = result.memory.source_excerpt
    assert len(excerpt) <= 240
    assert "Alice" not in excerpt
    assert "server" not in excerpt
    assert "workspace" not in excerpt
    assert "alice@example.com" not in excerpt
    assert "sk-test-secret" not in excerpt
    assert "[LOCAL_PATH_REDACTED]" in excerpt
    assert "[EMAIL_REDACTED]" in excerpt


def test_update_memory_can_remove_source_without_deleting_memory(
    empty_store: MemoryStore,
) -> None:
    saved = save_memory_candidate(
        session_id="session-remove-source",
        candidate={
            "title": "Preference: tea",
            "lesson_text": "The user prefers tea.",
            "lesson_kind": "preference",
            "confidence": 0.9,
            "source_excerpt": "I prefer tea while working.",
        },
        memory_store=empty_store,
    ).memory

    updated = update_memory(
        memory_id=saved.id,
        patch={
            "title": saved.title,
            "lesson_text": saved.lesson_text,
            "remove_provenance": True,
        },
        memory_store=empty_store,
    )

    assert updated.id == saved.id
    assert updated.title == saved.title
    assert updated.lesson_text == saved.lesson_text
    assert updated.source_excerpt == ""
    assert updated.provenance == "source_removed"
    assert empty_store.get_memory_by_id(saved.id) == updated


def test_suggest_raises_on_non_list_messages(empty_store: MemoryStore) -> None:
    with pytest.raises(ValueError, match="messages must be a list"):
        suggest_memories(messages="not a list", memory_store=empty_store)


def test_suggest_memories_prefers_pending_session_candidates(empty_store: MemoryStore) -> None:
    _insert_pending_candidate(
        empty_store,
        session_id="session-1",
        source_request_id="request-1",
        title="Preference: tea",
        lesson_text="The user prefers tea.",
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt="I prefer tea",
        category="user",
    )

    suggestions = suggest_memories(
        session_id="session-1",
        messages=[{"role": "user", "content": "my name is Alice"}],
        memory_store=empty_store,
    )

    assert len(suggestions) == 1
    assert suggestions[0]["title"] == "Preference: tea"
    assert suggestions[0]["category"] == "user"


def test_suggest_memories_deletes_stale_pending_candidates_and_falls_back(
    empty_store: MemoryStore,
) -> None:
    _insert_pending_candidate(
        empty_store,
        session_id="session-1",
        source_request_id="request-1",
        title="Preference: tea",
        lesson_text="The user prefers tea.",
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt="I prefer tea",
        category="user",
    )
    empty_store.save_memory(
        session_id="session-1",
        title="Preference: tea",
        lesson_text="The user prefers tea.",
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt="I prefer tea",
    )

    suggestions = suggest_memories(
        session_id="session-1",
        messages=[{"role": "user", "content": "my name is Alice"}],
        memory_store=empty_store,
    )

    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "profile"
    assert empty_store.get_pending_candidates("session-1") == []


def test_delete_pending_memory_removes_matching_candidate(empty_store: MemoryStore) -> None:
    fingerprint = _build_fingerprint("preference", "The user prefers tea.")
    _insert_pending_candidate(
        empty_store,
        session_id="session-delete",
        source_request_id="request-delete",
        title="Preference: tea",
        lesson_text="The user prefers tea.",
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt="I prefer tea",
        category="user",
    )

    deleted = delete_pending_memory(
        session_id="session-delete",
        content_fingerprint=fingerprint.upper(),
        memory_store=empty_store,
    )

    assert deleted is True
    assert empty_store.get_pending_candidates("session-delete") == []


def test_save_memory_candidate_clears_matching_pending_candidate(empty_store: MemoryStore) -> None:
    _insert_pending_candidate(
        empty_store,
        session_id="session-approved",
        source_request_id="request-approved",
        title="Goal: finish the garden",
        lesson_text="The user's goal is to finish the garden.",
        lesson_kind="goal",
        confidence=0.9,
        source_excerpt="finish the garden",
        category="user",
    )

    result = save_memory_candidate(
        session_id="session-approved",
        candidate={
            "title": "Goal: finish the garden",
            "lesson_text": "The user's goal is to finish the garden.",
            "lesson_kind": "goal",
            "confidence": 0.9,
            "source_excerpt": "finish the garden",
        },
        memory_store=empty_store,
    )

    assert result.created is True
    assert empty_store.get_pending_candidates("session-approved") == []


def test_approved_memory_cursor_is_snapshot_stable_during_concurrent_changes(
    empty_store: MemoryStore,
) -> None:
    initial_ids: list[int] = []
    for index in range(4):
        memory, _ = empty_store.save_memory(
            session_id="session-1",
            title=f"Memory {index}",
            lesson_text=f"The user prefers item {index}.",
            lesson_kind="preference",
            confidence=0.8,
            source_excerpt=f"item {index}",
        )
        initial_ids.append(memory.id)

    first_page = list_memories_page(cursor=None, limit=2, memory_store=empty_store)
    first_ids = [int(row["id"]) for row in first_page["memories"]]
    cursor = first_page["next_cursor"]
    assert isinstance(cursor, str) and cursor.startswith("v1:")

    empty_store.update_memory(
        memory_id=initial_ids[0],
        title="Updated oldest memory",
        lesson_text="The user still prefers item zero.",
    )
    inserted, _ = empty_store.save_memory(
        session_id="session-1",
        title="New memory",
        lesson_text="The user prefers the newly inserted item.",
        lesson_kind="preference",
        confidence=0.8,
        source_excerpt="new item",
    )

    second_page = list_memories_page(
        cursor=cursor,
        limit=2,
        memory_store=empty_store,
    )
    second_ids = [int(row["id"]) for row in second_page["memories"]]
    assert set(first_ids).isdisjoint(second_ids)
    assert set(first_ids + second_ids) == set(initial_ids)
    assert inserted.id not in second_ids

    legacy_page = list_memories_page(cursor="2", limit=2, memory_store=empty_store)
    assert len(legacy_page["memories"]) == 2
