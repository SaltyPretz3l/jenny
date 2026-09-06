from __future__ import annotations

from datetime import datetime, timezone

import pytest

from sidecar import server
from sidecar.ai.error_codes import CMP_MEMORY_FAMILY_UNRESOLVED
from sidecar.ai.memory.contracts import build_content_digest
from sidecar.ai.memory.store import MemoryStore
from sidecar.protocol import API_VERSION
from sidecar.runtime import request_dispatch


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
) -> tuple[int, str]:
    timestamp = datetime.now(timezone.utc).isoformat()
    fingerprint = build_content_digest(lesson_kind, lesson_text)
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
            fingerprint,
            category,
            timestamp,
            timestamp,
        ),
    )
    store._connection.commit()  # noqa: SLF001
    assert cursor.lastrowid is not None
    return int(cursor.lastrowid), fingerprint


def test_process_message_memory_suggest_returns_single_preference_candidate(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 151,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 152,
        "method": "memory.suggest",
        "params": {
            "accept_version": API_VERSION,
            "messages": [
                {"role": "assistant", "content": "Hello"},
                {"role": "user", "content": "I prefer tea over coffee."},
                {"role": "user", "content": "I like it."},
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    suggestions = outcome.response["result"]["suggestions"]
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "preference"
    assert suggestions[0]["lesson_text"] == "The user prefers tea over coffee."


def test_process_message_memory_suggest_returns_response_style_candidate(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 152_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 152_2,
        "method": "memory.suggest",
        "params": {
            "accept_version": API_VERSION,
            "messages": [
                {"role": "user", "content": "Please be concise when you answer."},
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    suggestions = outcome.response["result"]["suggestions"]
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "response_style"
    assert suggestions[0]["title"] == "Response style: concise"


@pytest.mark.parametrize(
    ("content", "expected_title", "expected_lesson_text"),
    [
        (
            "Please use rg when searching this repo.",
            "Tool strategy: prefer ripgrep",
            "For repository text search tasks, prefer rg/ripgrep when it is available.",
        ),
        (
            "Prefer apply_patch for small edits.",
            "Tool strategy: use apply_patch",
            "Prefer apply_patch for small manual file edits when practical.",
        ),
        (
            "Don't run tests unless I ask.",
            "Tool strategy: avoid unrequested tests",
            "Do not run tests unless the user explicitly asks for them.",
        ),
        (
            "Keep diffs small and reviewable.",
            "Tool strategy: keep diffs small",
            "Keep changes small and reviewable.",
        ),
        (
            "Plan before implementation.",
            "Tool strategy: plan before implementation",
            "Plan the approach before implementing non-trivial work.",
        ),
    ],
)
def test_process_message_memory_suggest_returns_tool_strategy_candidates(
    tmp_path,
    content,
    expected_title,
    expected_lesson_text,
) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 152_11,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 152_12,
        "method": "memory.suggest",
        "params": {
            "accept_version": API_VERSION,
            "messages": [
                {"role": "user", "content": content},
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    suggestions = outcome.response["result"]["suggestions"]
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "tool_strategy"
    assert suggestions[0]["title"] == expected_title
    assert suggestions[0]["lesson_text"] == expected_lesson_text


def test_process_message_memory_suggest_ranks_response_style_alongside_preference_candidates(
    tmp_path,
) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 152_3,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 152_4,
        "method": "memory.suggest",
        "params": {
            "accept_version": API_VERSION,
            "messages": [
                {"role": "user", "content": "I love jazz. Please be direct when you answer."},
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    suggestions = outcome.response["result"]["suggestions"]
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "response_style"
    assert suggestions[0]["title"] == "Response style: direct"


def test_process_message_memory_suggest_ranks_tool_strategy_alongside_response_style_candidates(
    tmp_path,
) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 152_5,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 152_6,
        "method": "memory.suggest",
        "params": {
            "accept_version": API_VERSION,
            "messages": [
                {"role": "user", "content": "Please be direct and keep diffs small."},
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    suggestions = outcome.response["result"]["suggestions"]
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == "response_style"
    assert suggestions[0]["title"] == "Response style: direct"


@pytest.mark.parametrize(
    ("content", "expected_kind", "expected_title"),
    [
        (
            "Please diagnose the root cause before proposing fixes.",
            "working_preference",
            "Working preference: diagnose root cause first",
        ),
        (
            "This workspace has no .git metadata right now.",
            "project_context",
            "Project context: workspace has no git metadata",
        ),
    ],
)
def test_process_message_memory_suggest_returns_new_batch_d_memory_candidates(
    tmp_path,
    content,
    expected_kind,
    expected_title,
) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 152_13,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 152_14,
        "method": "memory.suggest",
        "params": {
            "accept_version": API_VERSION,
            "messages": [
                {"role": "user", "content": content},
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    suggestions = outcome.response["result"]["suggestions"]
    assert len(suggestions) == 1
    assert suggestions[0]["lesson_kind"] == expected_kind
    assert suggestions[0]["title"] == expected_title


def test_process_message_memory_suggest_skips_duplicate_saved_memory(tmp_path) -> None:
    db_path = tmp_path / "memory.db"
    init_message = {
        "jsonrpc": "2.0",
        "id": 153,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(db_path)},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    memory_store.save_memory(
        session_id="session_1",
        title="Preference: tea over coffee",
        lesson_text="The user prefers tea over coffee.",
        lesson_kind="preference",
        confidence=0.95,
        source_excerpt="I prefer tea over coffee",
    )

    message = {
        "jsonrpc": "2.0",
        "id": 154,
        "method": "memory.suggest",
        "params": {
            "accept_version": API_VERSION,
            "messages": [
                {"role": "user", "content": "I prefer tea over coffee."},
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["suggestions"] == []


def test_process_message_memory_save_dedupes_candidate(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 155,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    candidate = {
        "title": "Preference: tea over coffee",
        "lesson_text": "The user prefers tea over coffee.",
        "lesson_kind": "preference",
        "confidence": 0.95,
        "source_excerpt": "I prefer tea over coffee",
        "content_fingerprint": "preference:the-user-prefers-tea-over-coffee",
    }
    first_message = {
        "jsonrpc": "2.0",
        "id": 156,
        "method": "memory.save",
        "params": {
            "accept_version": API_VERSION,
            "session_id": "session_1",
            "candidate": candidate,
        },
    }
    second_message = {
        "jsonrpc": "2.0",
        "id": 157,
        "method": "memory.save",
        "params": {
            "accept_version": API_VERSION,
            "session_id": "session_2",
            "candidate": candidate,
        },
    }

    first_outcome = server.process_message(first_message, initialized=True)
    second_outcome = server.process_message(second_message, initialized=True)

    assert first_outcome.response is not None
    assert first_outcome.response["result"]["created"] is True
    assert second_outcome.response is not None
    assert second_outcome.response["result"]["created"] is False
    assert (
        first_outcome.response["result"]["memory"]["id"]
        == second_outcome.response["result"]["memory"]["id"]
    )
    assert second_outcome.response["result"]["memory"]["session_id"] == "session_2"


def test_process_message_memory_save_recomputes_untrusted_fingerprint(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 158,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    candidate = {
        "title": "Preference: tea over coffee",
        "lesson_text": "The user prefers tea over coffee.",
        "lesson_kind": "preference",
        "confidence": 0.95,
        "source_excerpt": "I prefer tea over coffee",
        "content_fingerprint": "preference:spoofed-value",
    }
    first_message = {
        "jsonrpc": "2.0",
        "id": 159,
        "method": "memory.save",
        "params": {
            "accept_version": API_VERSION,
            "session_id": "session_1",
            "candidate": candidate,
        },
    }
    second_message = {
        "jsonrpc": "2.0",
        "id": 160,
        "method": "memory.save",
        "params": {
            "accept_version": API_VERSION,
            "session_id": "session_2",
            "candidate": {
                **candidate,
                "content_fingerprint": "preference:another-spoofed-value",
            },
        },
    }

    first_outcome = server.process_message(first_message, initialized=True)
    second_outcome = server.process_message(second_message, initialized=True)

    assert first_outcome.response is not None
    assert first_outcome.response["result"]["memory"]["content_fingerprint"] == (
        build_content_digest("preference", "The user prefers tea over coffee.")
    )
    assert second_outcome.response is not None
    assert second_outcome.response["result"]["created"] is False
    assert second_outcome.response["result"]["memory"]["session_id"] == "session_2"


def test_process_message_memory_save_accepts_response_style_candidate(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_01,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 160_02,
        "method": "memory.save",
        "params": {
            "accept_version": API_VERSION,
            "session_id": "session_style",
            "candidate": {
                "title": "Response style: direct",
                "lesson_text": "Be direct and avoid extra fluff unless the user asks for a softer tone.",
                "lesson_kind": "response_style",
                "confidence": 0.92,
                "source_excerpt": "be direct",
                "content_fingerprint": "response_style:spoofed-direct",
            },
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["created"] is True
    assert outcome.response["result"]["memory"]["lesson_kind"] == "response_style"
    assert outcome.response["result"]["memory"]["family_key"] == ""


def test_process_message_memory_save_accepts_tool_strategy_candidate(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_02_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 160_02_2,
        "method": "memory.save",
        "params": {
            "accept_version": API_VERSION,
            "session_id": "session_tool_strategy",
            "candidate": {
                "title": "Tool strategy: use apply_patch",
                "lesson_text": "Prefer apply_patch for small manual file edits when practical.",
                "lesson_kind": "tool_strategy",
                "confidence": 0.89,
                "source_excerpt": "prefer apply_patch",
                "content_fingerprint": "tool_strategy:spoofed-apply-patch",
            },
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["created"] is True
    assert outcome.response["result"]["memory"]["lesson_kind"] == "tool_strategy"
    assert outcome.response["result"]["memory"]["content_fingerprint"] == (
        build_content_digest(
            "tool_strategy",
            "Prefer apply_patch for small manual file edits when practical.",
        )
    )
    assert outcome.response["result"]["memory"]["family_key"] == "apply_patch"


@pytest.mark.parametrize(
    ("candidate", "expected_kind", "expected_fingerprint"),
    [
        (
            {
                "title": "Working preference: diagnose root cause first",
                "lesson_text": "Diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.",
                "lesson_kind": "working_preference",
                "confidence": 0.94,
                "source_excerpt": "diagnose root cause before proposing fixes",
                "content_fingerprint": "working_preference:spoofed-root-cause",
            },
            "working_preference",
            build_content_digest(
                "working_preference",
                "Diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.",
            ),
        ),
        (
            {
                "title": "Project context: sidecar is stateless per request",
                "lesson_text": "The sidecar is stateless per request.",
                "lesson_kind": "project_context",
                "confidence": 0.94,
                "source_excerpt": "sidecar is stateless per request",
                "content_fingerprint": "project_context:spoofed-stateless",
            },
            "project_context",
            build_content_digest(
                "project_context", "The sidecar is stateless per request."
            ),
        ),
    ],
)
def test_process_message_memory_save_accepts_new_batch_d_kinds(
    tmp_path,
    candidate,
    expected_kind,
    expected_fingerprint,
) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 159_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    outcome = server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 159_2,
            "method": "memory.save",
            "params": {
                "accept_version": API_VERSION,
                "session_id": "session_new_batch_d_kind",
                "candidate": candidate,
            },
        },
        initialized=True,
    )

    assert outcome.response is not None
    assert outcome.response["result"]["memory"]["lesson_kind"] == expected_kind
    assert outcome.response["result"]["memory"]["content_fingerprint"] == expected_fingerprint
    assert outcome.response["result"]["memory"]["family_key"] != ""


def test_process_message_memory_save_logs_unresolved_gated_family_without_rejecting(
    tmp_path, monkeypatch
) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 159_3,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    logged_events = []

    def capture_log_event(_logger, _level, **kwargs):
        logged_events.append(kwargs)

    monkeypatch.setattr(request_dispatch, "log_event", capture_log_event)

    outcome = server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 159_4,
            "method": "memory.save",
            "params": {
                "accept_version": API_VERSION,
                "session_id": "session_unresolved_gated_kind",
                "candidate": {
                    "title": "Working preference: generic",
                    "lesson_text": "Keep this generic so it does not match a shipped family.",
                    "lesson_kind": "working_preference",
                    "confidence": 0.4,
                    "source_excerpt": "generic",
                    "content_fingerprint": "working_preference:spoofed-generic",
                },
            },
        },
        initialized=True,
    )

    assert outcome.response is not None
    assert outcome.response["result"]["created"] is True
    assert outcome.response["result"]["memory"]["family_key"] == ""
    unresolved_log = next(
        entry
        for entry in logged_events
        if entry.get("event") == "sidecar.runtime.memory_save.family_unresolved"
    )
    assert unresolved_log["data"]["code"] == CMP_MEMORY_FAMILY_UNRESOLVED


def test_process_message_memory_save_rejects_unsupported_commitment_kind(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 159_4_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    outcome = server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 159_4_2,
            "method": "memory.save",
            "params": {
                "accept_version": API_VERSION,
                "session_id": "session_commitment_kind",
                "candidate": {
                    "title": "Commitment: school pickup",
                    "lesson_text": "Pick up Sam from school at 3 PM.",
                    "lesson_kind": "commitment",
                    "confidence": 0.95,
                    "source_excerpt": "school pickup",
                },
            },
        },
        initialized=True,
    )

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-MEM-0001"
    assert "CMP-MEM-0003" in outcome.response["error"]["data"]["detail"]


def test_process_message_memory_recall_returns_ranked_memories(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    memory_store.save_memory(
        session_id="session_1",
        title="Preference: tea",
        lesson_text="The user prefers tea over coffee.",
        lesson_kind="preference",
        confidence=0.95,
        source_excerpt="I prefer tea over coffee",
    )
    memory_store.save_memory(
        session_id="session_2",
        title="Preference: green tea",
        lesson_text="The user prefers green tea in the afternoon.",
        lesson_kind="preference",
        confidence=0.7,
        source_excerpt="I prefer green tea in the afternoon",
    )

    message = {
        "jsonrpc": "2.0",
        "id": 160_2,
        "method": "memory.recall",
        "params": {
            "accept_version": API_VERSION,
            "query": "green tea",
            "limit": 2,
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    memories = outcome.response["result"]["memories"]
    assert len(memories) == 2
    assert memories[0]["title"] == "Preference: green tea"
    assert memories[1]["title"] == "Preference: tea"
    assert set(memories[0]) == {
        "id",
        "session_id",
        "title",
        "lesson_text",
        "lesson_kind",
        "confidence",
        "source_excerpt",
        "content_fingerprint",
        "family_key",
        "provenance",
        "created_at",
        "updated_at",
    }


def test_process_message_memory_recall_returns_tool_strategy_memories(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_2_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    memory_store.save_memory(
        session_id="session_tool_strategy",
        title="Tool strategy: prefer ripgrep",
        lesson_text="For repository text search tasks, prefer rg/ripgrep when it is available.",
        lesson_kind="tool_strategy",
        confidence=0.9,
        source_excerpt="prefer ripgrep",
        family_key="ripgrep",
    )

    message = {
        "jsonrpc": "2.0",
        "id": 160_2_2,
        "method": "memory.recall",
        "params": {
            "accept_version": API_VERSION,
            "query": "search repository text with ripgrep",
            "limit": 2,
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    memories = outcome.response["result"]["memories"]
    assert len(memories) == 1
    assert memories[0]["lesson_kind"] == "tool_strategy"
    assert memories[0]["title"] == "Tool strategy: prefer ripgrep"


def test_process_message_memory_recall_returns_working_preference_memories(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_2_3,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    memory_store.save_memory(
        session_id="session_working_preference",
        title="Working preference: diagnose root cause first",
        lesson_text="Diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.",
        lesson_kind="working_preference",
        confidence=0.94,
        source_excerpt="diagnose the root cause before proposing fixes",
        family_key="diagnose_root_cause_first",
    )

    outcome = server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 160_2_4,
            "method": "memory.recall",
            "params": {
                "accept_version": API_VERSION,
                "query": "debug this issue and find the root cause",
                "limit": 2,
            },
        },
        initialized=True,
    )

    assert outcome.response is not None
    memories = outcome.response["result"]["memories"]
    assert len(memories) == 1
    assert memories[0]["lesson_kind"] == "working_preference"


def test_process_message_memory_recall_returns_project_context_memories(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_2_5,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    memory_store.save_memory(
        session_id="session_project_context",
        title="Project context: workspace has no git metadata",
        lesson_text="This workspace has no .git metadata, so branch and status information are unavailable.",
        lesson_kind="project_context",
        confidence=0.95,
        source_excerpt="workspace has no .git metadata",
        family_key="workspace_has_no_git_metadata",
    )

    outcome = server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 160_2_6,
            "method": "memory.recall",
            "params": {
                "accept_version": API_VERSION,
                "query": "what branch does git think I am on?",
                "limit": 2,
            },
        },
        initialized=True,
    )

    assert outcome.response is not None
    memories = outcome.response["result"]["memories"]
    assert len(memories) == 1
    assert memories[0]["lesson_kind"] == "project_context"


def test_process_message_memory_recall_rejects_blank_query(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_3,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 160_4,
        "method": "memory.recall",
        "params": {
            "accept_version": API_VERSION,
            "query": "   ",
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-MEM-0001"


def test_process_message_memory_recall_rejects_boolean_limit(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_4_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 160_4_2,
        "method": "memory.recall",
        "params": {
            "accept_version": API_VERSION,
            "query": "tea",
            "limit": True,
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-MEM-0001"


def test_process_message_memory_list_returns_all_memories(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_4_3,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    older_memory, _ = memory_store.save_memory(
        session_id="session_1",
        title="Preference: tea",
        lesson_text="The user prefers tea over coffee.",
        lesson_kind="preference",
        confidence=0.95,
        source_excerpt="I prefer tea over coffee",
    )
    newer_memory, _ = memory_store.save_memory(
        session_id="session_2",
        title="Response style: concise",
        lesson_text="Use concise answers unless the user asks for more detail.",
        lesson_kind="response_style",
        confidence=0.93,
        source_excerpt="be concise",
    )

    message = {
        "jsonrpc": "2.0",
        "id": 160_4_4,
        "method": "memory.list",
        "params": {
            "accept_version": API_VERSION,
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    memories = outcome.response["result"]["memories"]
    assert [memory["id"] for memory in memories] == [newer_memory.id, older_memory.id]


def test_process_message_memory_pending_list_returns_candidates(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_4_4_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    older_id, _ = _insert_pending_candidate(
        memory_store,
        session_id="session-old",
        source_request_id="request-old",
        title="Goal: finish the garden",
        lesson_text="The user's goal is to finish the garden.",
        lesson_kind="goal",
        confidence=0.91,
        source_excerpt="finish the garden",
        category="user",
    )
    newer_id, _ = _insert_pending_candidate(
        memory_store,
        session_id="session-new",
        source_request_id="request-new",
        title="Routine: morning tea",
        lesson_text="The user's morning routine includes tea.",
        lesson_kind="routine",
        confidence=0.88,
        source_excerpt="morning tea",
        category="user",
    )
    memory_store._connection.execute(  # noqa: SLF001
        "UPDATE pending_memory_candidates SET updated_at = ? WHERE id = ?",
        ("2026-03-15T00:00:00+00:00", older_id),
    )
    memory_store._connection.execute(  # noqa: SLF001
        "UPDATE pending_memory_candidates SET updated_at = ? WHERE id = ?",
        ("2026-03-16T00:00:00+00:00", newer_id),
    )
    memory_store._connection.commit()  # noqa: SLF001

    message = {
        "jsonrpc": "2.0",
        "id": 160_4_4_2,
        "method": "memory.pending.list",
        "params": {
            "accept_version": API_VERSION,
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    candidates = outcome.response["result"]["candidates"]
    assert [candidate["session_id"] for candidate in candidates] == ["session-new", "session-old"]


def test_process_message_memory_update_updates_existing_memory(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_4_5,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    saved, _ = memory_store.save_memory(
        session_id="session_1",
        title="Preference: tea",
        lesson_text="The user prefers tea over coffee.",
        lesson_kind="preference",
        confidence=0.95,
        source_excerpt="I prefer tea over coffee",
    )

    message = {
        "jsonrpc": "2.0",
        "id": 160_4_6,
        "method": "memory.update",
        "params": {
            "accept_version": API_VERSION,
            "memory_id": saved.id,
            "patch": {
                "title": "Preference: green tea",
                "lesson_text": "The user prefers green tea over coffee.",
            },
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["updated"] is True
    assert outcome.response["result"]["memory"]["lesson_kind"] == "preference"
    assert outcome.response["result"]["memory"]["title"] == "Preference: green tea"
    assert outcome.response["result"]["memory"]["content_fingerprint"] == (
        build_content_digest("preference", "The user prefers green tea over coffee.")
    )


def test_process_message_memory_update_rejects_duplicate_lesson_text(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_4_7,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    memory_store.save_memory(
        session_id="session_1",
        title="Preference: tea",
        lesson_text="The user prefers tea over coffee.",
        lesson_kind="preference",
        confidence=0.95,
        source_excerpt="I prefer tea over coffee",
    )
    second_memory, _ = memory_store.save_memory(
        session_id="session_2",
        title="Preference: coffee",
        lesson_text="The user prefers coffee in the morning.",
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt="I prefer coffee in the morning",
    )

    message = {
        "jsonrpc": "2.0",
        "id": 160_4_8,
        "method": "memory.update",
        "params": {
            "accept_version": API_VERSION,
            "memory_id": second_memory.id,
            "patch": {
                "title": "Preference: tea",
                "lesson_text": "The user prefers tea over coffee.",
            },
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-MEM-0002"


def test_process_message_memory_delete_removes_memory(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_4_9,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    saved, _ = memory_store.save_memory(
        session_id="session_1",
        title="Preference: tea",
        lesson_text="The user prefers tea over coffee.",
        lesson_kind="preference",
        confidence=0.95,
        source_excerpt="I prefer tea over coffee",
    )

    message = {
        "jsonrpc": "2.0",
        "id": 160_5_0,
        "method": "memory.delete",
        "params": {
            "accept_version": API_VERSION,
            "memory_id": saved.id,
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["deleted"] is True
    assert outcome.response["result"]["memory_id"] == saved.id
    assert memory_store.get_memory_by_id(saved.id) is None


def test_process_message_memory_delete_rejects_invalid_id(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_5_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 160_5_2,
        "method": "memory.delete",
        "params": {
            "accept_version": API_VERSION,
            "memory_id": 0,
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-MEM-0001"


def test_process_message_memory_pending_delete_removes_candidate(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_5_2_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    _, pending_fingerprint = _insert_pending_candidate(
        memory_store,
        session_id="session-delete",
        source_request_id="request-delete",
        title="Preference: tea",
        lesson_text="The user prefers tea.",
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt="I prefer tea",
        category="user",
    )

    message = {
        "jsonrpc": "2.0",
        "id": 160_5_2_2,
        "method": "memory.pending.delete",
        "params": {
            "accept_version": API_VERSION,
            "session_id": "session-delete",
            "content_fingerprint": pending_fingerprint,
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["deleted"] is True
    assert memory_store.get_pending_candidates("session-delete") == []


def test_process_message_memory_pending_delete_rejects_blank_fingerprint(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_5_2_3,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 160_5_2_4,
        "method": "memory.pending.delete",
        "params": {
            "accept_version": API_VERSION,
            "session_id": "session-delete",
            "content_fingerprint": "   ",
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-MEM-0001"


def test_process_message_memory_recall_recent_returns_recent_memories_by_kind(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_5,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)
    memory_store = server._BRAIN_CONTAINER.stack.memory_store  # noqa: SLF001
    older_memory, _ = memory_store.save_memory(
        session_id="session_old",
        title="Response style: concise",
        lesson_text="Use concise answers unless the user asks for more detail.",
        lesson_kind="response_style",
        confidence=0.93,
        source_excerpt="be concise",
    )
    newer_memory, _ = memory_store.save_memory(
        session_id="session_new",
        title="Response style: step-by-step",
        lesson_text="Explain things step by step when helping the user.",
        lesson_kind="response_style",
        confidence=0.91,
        source_excerpt="step by step",
    )
    profile_memory, _ = memory_store.save_memory(
        session_id="session_profile",
        title="Preferred name: Jen",
        lesson_text="The user's name is Jen.",
        lesson_kind="profile",
        confidence=0.99,
        source_excerpt="my name is Jen",
    )
    memory_store._connection.execute(  # noqa: SLF001
        "UPDATE memories SET updated_at = ? WHERE id = ?",
        ("2026-03-15T00:00:00+00:00", older_memory.id),
    )
    memory_store._connection.execute(  # noqa: SLF001
        "UPDATE memories SET updated_at = ? WHERE id = ?",
        ("2026-03-16T00:00:00+00:00", newer_memory.id),
    )
    memory_store._connection.commit()  # noqa: SLF001

    message = {
        "jsonrpc": "2.0",
        "id": 160_6,
        "method": "memory.recall_recent",
        "params": {
            "accept_version": API_VERSION,
            "lesson_kind": "response_style",
            "limit": 2,
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    memories = outcome.response["result"]["memories"]
    assert [memory["id"] for memory in memories] == [newer_memory.id, older_memory.id]
    assert all(memory["lesson_kind"] == "response_style" for memory in memories)
    assert profile_memory.id not in [memory["id"] for memory in memories]


def test_process_message_memory_recall_recent_rejects_blank_lesson_kind(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_7,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 160_8,
        "method": "memory.recall_recent",
        "params": {
            "accept_version": API_VERSION,
            "lesson_kind": "   ",
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-MEM-0001"


def test_process_message_memory_recall_recent_rejects_boolean_limit(tmp_path) -> None:
    init_message = {
        "jsonrpc": "2.0",
        "id": 160_8_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(tmp_path / "memory.db")},
        },
    }
    server.process_message(init_message, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 160_8_2,
        "method": "memory.recall_recent",
        "params": {
            "accept_version": API_VERSION,
            "lesson_kind": "response_style",
            "limit": True,
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-MEM-0001"
