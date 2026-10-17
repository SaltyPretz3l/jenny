"""End-to-end memory.* JSON-RPC tests through ``server.process_message`` (schema v9)."""

from __future__ import annotations

import itertools
from datetime import datetime, timezone
from typing import Any

import pytest

from sidecar import server
from sidecar.ai.error_codes import (
    CMP_MEMORY_FAILED,
    CMP_MEMORY_FINGERPRINT_CONFLICT,
    CMP_MEMORY_INVALID_KIND,
    CMP_MEMORY_NOT_FOUND,
    CMP_MEMORY_PROJECT_ARCHIVED,
    CMP_MEMORY_SESSION_PURGED,
    CMP_MEMORY_STALE_REVISION,
)
from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, build_text_digest
from sidecar.ai.memory.store import ApprovedMemory, MemoryStore
from sidecar.protocol import API_VERSION

INVALID_PARAMS = -32602
METHOD_NOT_FOUND = -32601
_IDS = itertools.count(10_000)
_SEED_OPS = itertools.count(1)

V9_ROW_KEYS = {
    "id",
    "session_id",
    "title",
    "lesson_text",
    "lesson_kind",
    "confidence",
    "source_excerpt",
    "content_fingerprint",
    "provenance",
    "created_at",
    "updated_at",
    "project_id",
    "scope_session_id",
    "origin",
    "status",
    "archived_at",
    "revision",
    "protected",
    "always_on",
    "source_message_ids",
}


def _init(tmp_path) -> MemoryStore:
    server.process_message(
        {
            "jsonrpc": "2.0",
            "id": next(_IDS),
            "method": "initialize",
            "params": {
                "accept_version": API_VERSION,
                "config": {"memory_db_path": str(tmp_path / "memory.db")},
            },
        },
        initialized=False,
    )
    return server._BRAIN_CONTAINER.stack.memory_store


def _call(method: str, **params: Any) -> dict[str, Any]:
    outcome = server.process_message(
        {
            "jsonrpc": "2.0",
            "id": next(_IDS),
            "method": method,
            "params": {"accept_version": API_VERSION, **params},
        },
        initialized=True,
    )
    assert outcome.response is not None
    return outcome.response


def _remember(  # noqa: PLR0913 - seed helper mirrors the store contract.
    store: MemoryStore,
    text: str,
    *,
    title: str | None = None,
    project_id: str = GENERAL_PROJECT_ID,
    session_id: str = "session_1",
    scope_session_id: str = "",
    kind: str = "preference",
) -> ApprovedMemory:
    result = store.remember(
        operation_id=f"seed-{next(_SEED_OPS)}",
        project_id=project_id,
        text=text,
        kind=kind,
        origin="user",
        session_id=session_id,
        scope_session_id=scope_session_id,
        title=title,
    )
    assert result.status == "saved" and result.memory is not None
    return result.memory


def _candidate(text: str = "The user prefers tea over coffee.", **extra: Any) -> dict[str, Any]:
    return {
        "title": "Preference: tea over coffee",
        "lesson_text": text,
        "lesson_kind": "preference",
        "source_excerpt": "I prefer tea over coffee",
        **extra,
    }


def _insert_pending_candidate(  # noqa: PLR0913 - migrated-row fixture mirrors schema.
    store: MemoryStore,
    *,
    session_id: str,
    source_request_id: str,
    title: str,
    lesson_text: str,
    lesson_kind: str,
    project_id: str = GENERAL_PROJECT_ID,
) -> tuple[int, str]:
    timestamp = datetime.now(timezone.utc).isoformat()
    fingerprint = build_text_digest(lesson_text)
    cursor = store._connection.execute(
        """
        INSERT INTO pending_memory_candidates (
            session_id, source_request_id, title, lesson_text, lesson_kind,
            confidence, source_excerpt, content_fingerprint,
            category, created_at, updated_at, project_id
        ) VALUES (?, ?, ?, ?, ?, 0.9, '', ?, 'user', ?, ?, ?)
        """,
        (
            session_id, source_request_id, title, lesson_text, lesson_kind,
            fingerprint, timestamp, timestamp, project_id,
        ),
    )
    store._connection.commit()
    assert cursor.lastrowid is not None
    return int(cursor.lastrowid), fingerprint


# --- memory.save --------------------------------------------------------------


def test_memory_save_dedupes_candidate(tmp_path) -> None:
    _init(tmp_path)

    first = _call("memory.save", session_id="session_1", candidate=_candidate())["result"]
    second = _call("memory.save", session_id="session_2", candidate=_candidate())["result"]

    assert first["created"] is True and first["status"] == "saved"
    assert first["duplicate"] is False and first["undoable"] is True
    assert isinstance(first["operation_id"], str) and first["operation_id"].startswith("rpc:")
    assert second["created"] is False and second["duplicate"] is True
    assert first["memory"]["id"] == second["memory"]["id"]
    assert second["memory"]["session_id"] == "session_1"
    assert set(first["memory"]) == V9_ROW_KEYS
    assert first["memory"]["origin"] == "user"
    assert first["memory"]["scope_session_id"] == ""


def test_memory_save_recomputes_untrusted_fingerprint(tmp_path) -> None:
    _init(tmp_path)

    result = _call(
        "memory.save",
        session_id="session_1",
        candidate=_candidate(content_fingerprint="preference:spoofed-value"),
    )["result"]

    assert result["memory"]["content_fingerprint"] == build_text_digest(
        "The user prefers tea over coffee."
    )


@pytest.mark.parametrize("kind", ["tool_strategy", "response_style", "commitment", ""])
def test_memory_save_rejects_kinds_outside_the_v9_vocabulary(tmp_path, kind: str) -> None:
    store = _init(tmp_path)

    response = _call(
        "memory.save", session_id="session_1", candidate=_candidate(lesson_kind=kind)
    )

    assert response["error"]["code"] == INVALID_PARAMS
    assert response["error"]["data"]["code"] == CMP_MEMORY_INVALID_KIND
    assert store.get_all_memories() == []


def test_memory_save_replayed_operation_id_returns_replayed_without_a_second_row(
    tmp_path,
) -> None:
    store = _init(tmp_path)

    first = _call(
        "memory.save", session_id="session_1", candidate=_candidate(), operation_id="op-save-1"
    )["result"]
    replay = _call(
        "memory.save", session_id="session_1", candidate=_candidate(), operation_id="op-save-1"
    )["result"]

    assert first["operation_id"] == "op-save-1" and first["replayed"] is False
    assert replay["replayed"] is True
    assert replay["operation_id"] == "op-save-1"
    assert replay["memory"]["id"] == first["memory"]["id"]
    assert len(store.get_all_memories()) == 1


@pytest.mark.parametrize("operation_id", ["", "has space", "x" * 129, 7])
def test_memory_save_rejects_malformed_operation_id(tmp_path, operation_id: object) -> None:
    _init(tmp_path)

    response = _call(
        "memory.save", session_id="session_1", candidate=_candidate(), operation_id=operation_id
    )

    assert response["error"]["code"] == INVALID_PARAMS


def test_memory_save_after_archive_project_is_refused(tmp_path) -> None:
    _init(tmp_path)
    saved = _call(
        "memory.save",
        project_id="project_alpha",
        session_id="session_1",
        candidate=_candidate(),
    )["result"]
    assert saved["created"] is True

    archived = _call("memory.archive_project", project_id="project_alpha")["result"]
    refused = _call(
        "memory.save",
        project_id="project_alpha",
        session_id="session_1",
        candidate=_candidate("The user writes Rust."),
    )["result"]

    assert archived == {
        "api_version": API_VERSION,
        "ok": True,
        "archived": 1,
        "pending_removed": 0,
    }
    assert refused["status"] == "refused" and refused["created"] is False
    assert refused["reason"] == "project_archived"
    assert refused["code"] == CMP_MEMORY_PROJECT_ARCHIVED


def test_memory_archive_project_rejects_general(tmp_path) -> None:
    _init(tmp_path)

    for params in ({}, {"project_id": GENERAL_PROJECT_ID}):
        response = _call("memory.archive_project", **params)
        assert response["error"]["code"] == INVALID_PARAMS


def test_memory_purge_session_then_chat_scope_save_is_refused(tmp_path) -> None:
    _init(tmp_path)
    scoped = _call(
        "memory.save",
        session_id="chat-1",
        scope_session_id="chat-1",
        candidate=_candidate(),
    )["result"]
    assert scoped["memory"]["scope_session_id"] == "chat-1"

    purged = _call("memory.purge_session", session_id="chat-1")["result"]
    refused = _call(
        "memory.save",
        session_id="chat-1",
        scope_session_id="chat-1",
        candidate=_candidate("The user writes Rust."),
    )["result"]

    assert purged["ok"] is True and purged["removed"] == 1
    assert refused["status"] == "refused"
    assert refused["reason"] == "session_purged"
    assert refused["code"] == CMP_MEMORY_SESSION_PURGED


def test_memory_purge_session_requires_a_session(tmp_path) -> None:
    _init(tmp_path)

    assert _call("memory.purge_session")["error"]["code"] == INVALID_PARAMS


def test_memory_save_rejects_always_on_chat_scope(tmp_path) -> None:
    _init(tmp_path)

    response = _call(
        "memory.save",
        session_id="chat-1",
        scope_session_id="chat-1",
        always_on=True,
        candidate=_candidate(),
    )

    assert response["error"]["code"] == INVALID_PARAMS


# --- memory.delete / undo / restore / clear_suppressions ----------------------


def test_memory_undo_of_a_delete_restores_the_row(tmp_path) -> None:
    store = _init(tmp_path)
    saved = _remember(store, "The user prefers tea.")

    deleted = _call("memory.delete", memory_id=saved.id)["result"]
    assert deleted["deleted"] is True and deleted["status"] == "saved"
    assert deleted["undoable"] is True
    assert saved.id not in {row.id for row in store.get_all_memories()}

    undone = _call("memory.undo", operation_id=deleted["operation_id"])["result"]
    listed = _call("memory.list")["result"]["memories"]

    assert undone["status"] == "saved"
    assert undone["memory"]["id"] == saved.id and undone["memory"]["status"] == "active"
    assert saved.id in {row["id"] for row in listed}


def test_memory_undo_requires_a_valid_operation_id(tmp_path) -> None:
    _init(tmp_path)

    assert _call("memory.undo")["error"]["code"] == INVALID_PARAMS
    missing = _call("memory.undo", operation_id="never-recorded")["result"]
    assert missing["status"] == "refused" and missing["reason"] == "not_found"


def test_memory_restore_and_clear_suppressions(tmp_path) -> None:
    store = _init(tmp_path)
    saved = _remember(store, "The user prefers tea.")
    _call("memory.delete", memory_id=saved.id)

    archived = _call("memory.list", status="archived")["result"]["memories"]
    assert [row["id"] for row in archived] == [saved.id]
    assert archived[0]["status"] == "archived" and archived[0]["archived_at"]

    restored = _call("memory.restore", memory_id=saved.id)["result"]
    assert restored["status"] == "saved" and restored["memory"]["status"] == "active"

    _call("memory.delete", memory_id=saved.id)
    cleared = _call("memory.clear_suppressions", project_id=GENERAL_PROJECT_ID)["result"]
    assert cleared["cleared"] == 1
    assert _call("memory.clear_suppressions")["result"]["cleared"] == 0


def test_memory_delete_rejects_invalid_id(tmp_path) -> None:
    _init(tmp_path)

    response = _call("memory.delete", memory_id=0)

    assert response["error"]["code"] == INVALID_PARAMS
    assert response["error"]["data"]["code"] == CMP_MEMORY_FAILED


def test_memory_delete_of_a_missing_row_is_a_refused_result(tmp_path) -> None:
    _init(tmp_path)

    result = _call("memory.delete", memory_id=404)["result"]

    assert result["deleted"] is False
    assert result["status"] == "refused" and result["reason"] == "not_found"
    assert result["operation_id"] is None and result["undoable"] is False


# --- memory.update -------------------------------------------------------------


def test_memory_update_flat_fields_and_stale_revision_is_a_conflict_result(tmp_path) -> None:
    store = _init(tmp_path)
    saved = _remember(store, "The user prefers tea over coffee.", title="Preference: tea")

    updated = _call(
        "memory.update",
        memory_id=saved.id,
        title="Preference: green tea",
        lesson_text="The user prefers green tea over coffee.",
        expected_revision=saved.revision,
    )["result"]
    stale = _call(
        "memory.update",
        memory_id=saved.id,
        lesson_kind="fact",
        expected_revision=saved.revision,
    )["result"]

    assert updated["status"] == "saved"
    assert updated["memory"]["title"] == "Preference: green tea"
    assert updated["memory"]["revision"] == saved.revision + 1
    assert updated["memory"]["protected"] is True
    assert updated["memory"]["content_fingerprint"] == build_text_digest(
        "The user prefers green tea over coffee."
    )
    assert stale["status"] == "conflict"
    assert stale["reason"] == "stale_revision"
    assert stale["code"] == CMP_MEMORY_STALE_REVISION


def test_memory_update_onto_existing_text_is_a_refused_result(tmp_path) -> None:
    store = _init(tmp_path)
    _remember(store, "The user prefers tea over coffee.")
    second = _remember(store, "The user prefers coffee in the morning.")

    result = _call(
        "memory.update", memory_id=second.id, lesson_text="The user prefers tea over coffee."
    )["result"]

    assert result["status"] == "refused"
    assert result["code"] == CMP_MEMORY_FINGERPRINT_CONFLICT


@pytest.mark.parametrize(
    "params",
    [
        {"patch": {"title": "x", "lesson_text": "y"}},
        {},
        {"lesson_kind": "tool_strategy"},
        {"always_on": "yes"},
        {"title": "Tea", "expected_revision": 0},
        {"lesson_text": 42},
    ],
)
def test_memory_update_rejects_invalid_params(tmp_path, params: dict[str, Any]) -> None:
    store = _init(tmp_path)
    saved = _remember(store, "The user prefers tea.")

    response = _call("memory.update", memory_id=saved.id, **params)

    assert response["error"]["code"] == INVALID_PARAMS


# --- memory.recall / memory.list ----------------------------------------------


def test_memory_recall_returns_ranked_layered_memories(tmp_path) -> None:
    store = _init(tmp_path)
    _remember(store, "The user prefers tea over coffee.", title="Preference: tea")
    _remember(
        store,
        "The user prefers green tea in the afternoon.",
        title="Preference: green tea",
        project_id="project_alpha",
    )
    _remember(
        store,
        "The user prefers green tea in another project.",
        title="Preference: green tea elsewhere",
        project_id="project_beta",
    )

    memories = _call(
        "memory.recall",
        query="green tea",
        limit=2,
        project_id="project_alpha",
        include_general=True,
    )["result"]["memories"]

    assert [memory["title"] for memory in memories] == [
        "Preference: green tea",
        "Preference: tea",
    ]
    assert set(memories[0]) == V9_ROW_KEYS


def test_memory_recall_scope_session_adds_only_that_chats_rows(tmp_path) -> None:
    store = _init(tmp_path)
    _remember(store, "The user prefers green tea at work.")
    chat = _remember(
        store, "The user prefers green tea this week.", session_id="chat-1",
        scope_session_id="chat-1",
    )

    without = _call("memory.recall", query="green tea", limit=5)["result"]["memories"]
    within = _call(
        "memory.recall", query="green tea", limit=5, scope_session_id="chat-1"
    )["result"]["memories"]

    assert chat.id not in {row["id"] for row in without}
    assert chat.id in {row["id"] for row in within}


@pytest.mark.parametrize("params", [{"query": "   "}, {"query": "tea", "limit": True}])
def test_memory_recall_rejects_invalid_params(tmp_path, params: dict[str, Any]) -> None:
    _init(tmp_path)

    response = _call("memory.recall", **params)

    assert response["error"]["data"]["code"] == CMP_MEMORY_FAILED


def test_memory_list_scope_all_returns_every_project(tmp_path) -> None:
    store = _init(tmp_path)
    ids = {
        _remember(store, f"The user prefers {project_id} behavior.", project_id=project_id).id
        for project_id in (GENERAL_PROJECT_ID, "project_alpha", "project_beta")
    }

    memories = _call("memory.list", scope="all")["result"]["memories"]

    assert {memory["id"] for memory in memories} == ids
    assert all("family_key" not in memory for memory in memories)


@pytest.mark.parametrize(
    "params",
    [
        {"status": "deleted"},
        {"status": "archived", "scope": "all"},
        {"scope_session_id": 7},
    ],
)
def test_memory_list_rejects_invalid_params(tmp_path, params: dict[str, Any]) -> None:
    _init(tmp_path)

    assert _call("memory.list", **params)["error"]["code"] == INVALID_PARAMS


def test_memory_status_passes_v9_counts(tmp_path) -> None:
    store = _init(tmp_path)
    _remember(store, "The user prefers tea.")

    status = _call("memory.status")["result"]

    assert status["counts"]["active"] == 1
    assert {"archived", "always_on", "pending", "suppressions"} <= set(status["counts"])


# --- memory.pending.* ------------------------------------------------------------


def test_memory_pending_list_and_delete(tmp_path) -> None:
    store = _init(tmp_path)
    _insert_pending_candidate(
        store,
        session_id="session-old",
        source_request_id="request-old",
        title="Goal: finish the garden",
        lesson_text="The user's goal is to finish the garden.",
        lesson_kind="fact",
    )
    _, fingerprint = _insert_pending_candidate(
        store,
        session_id="session-new",
        source_request_id="request-new",
        title="Routine: morning tea",
        lesson_text="The user's morning routine includes tea.",
        lesson_kind="routine",
        project_id="project_alpha",
    )

    candidates = _call("memory.pending.list", scope="all")["result"]["candidates"]
    deleted = _call(
        "memory.pending.delete",
        project_id="project_alpha",
        session_id="session-new",
        content_fingerprint=fingerprint,
    )["result"]
    blank = _call(
        "memory.pending.delete", session_id="session-new", content_fingerprint="   "
    )

    assert {candidate["project_id"] for candidate in candidates} == {
        GENERAL_PROJECT_ID,
        "project_alpha",
    }
    assert all("family_key" not in candidate for candidate in candidates)
    assert deleted["deleted"] is True
    assert blank["error"]["data"]["code"] == CMP_MEMORY_FAILED


def test_memory_pending_accept_saves_the_queued_scope_and_rejects_bad_params(tmp_path) -> None:
    store = _init(tmp_path)
    _, fingerprint = _insert_pending_candidate(
        store,
        session_id="session-new",
        source_request_id="request-new",
        title="Routine: morning tea",
        lesson_text="The user's morning routine includes tea.",
        lesson_kind="routine",
    )

    accepted = _call(
        "memory.pending.accept",
        project_id="project_alpha",
        session_id="session-new",
        content_fingerprint=fingerprint,
    )["result"]
    again = _call(
        "memory.pending.accept",
        project_id="project_alpha",
        session_id="session-new",
        content_fingerprint=fingerprint,
    )["result"]
    blank = _call("memory.pending.accept", session_id="session-new", content_fingerprint="   ")
    malformed = _call(
        "memory.pending.accept", session_id="session-new", content_fingerprint="not-a-digest"
    )
    missing = _call("memory.pending.accept", session_id="session-new")

    assert accepted["accepted"] is True and accepted["status"] == "saved"
    assert accepted["memory"]["project_id"] == GENERAL_PROJECT_ID
    assert accepted["memory"]["origin"] == "jenny"
    assert accepted["memory"]["provenance"] == "user_approved"
    assert isinstance(accepted["operation_id"], str) and accepted["operation_id"].startswith("rpc:")
    assert again["accepted"] is False and again["reason"] == "not_found"
    assert again["code"] == CMP_MEMORY_NOT_FOUND
    for response in (blank, malformed, missing):
        assert response["error"]["code"] == INVALID_PARAMS


# --- retired methods -----------------------------------------------------------


@pytest.mark.parametrize(
    "method", ["memory.suggest", "memory.recall_recent", "memory.move_project"]
)
def test_retired_memory_methods_are_unknown(tmp_path, method: str) -> None:
    _init(tmp_path)

    response = _call(method, project_id="project_alpha", target_project_id=GENERAL_PROJECT_ID)

    assert response["error"]["code"] == METHOD_NOT_FOUND
    assert response["error"]["message"] == f"unknown method: {method}"


# --- reflection (row 58 W2): reflection_state, policy_epoch, apply -------------

_REFLECT_FP1 = "sha256:" + "1" * 64


def _apply_params(**overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "session_id": "sess_9_reflect",
        "project_id": "project_alpha",
        "policy_epoch": 2,
        "epoch_source": "source_a",
        "capture": "auto",
        "expected_fingerprint": None,
        "cursor": {
            "message_count": 4,
            "last_message_id": "m-4",
            "window_fingerprint": _REFLECT_FP1,
            "session_incarnation": "inc_abc",
            "turn_generation": 1,
        },
        "proposals": [
            {"text": "Prefers tabs over spaces.", "kind": "preference",
             "source_message_id": "m-1", "digest": "ignored"},
        ],
        "recap": "A chat about formatting.",
    }
    params.update(overrides)
    return params


def test_reflection_methods_route_inline_and_reflect_on_the_inference_family() -> None:
    from sidecar.protocol import (
        INBOUND_VERSIONED_REQUEST_METHODS,
        MEMORY_APPLY_METHOD,
        MEMORY_POLICY_EPOCH_METHOD,
        MEMORY_REFLECT_METHOD,
        MEMORY_REFLECTION_STATE_METHOD,
    )
    from sidecar.runtime import server_auxiliary_workers as workers

    assert workers.AUXILIARY_FAMILY_BY_METHOD[MEMORY_REFLECT_METHOD] == "inference"
    assert workers.DEFAULT_MAX_WORKERS_BY_FAMILY["inference"] == 1
    for method in (MEMORY_APPLY_METHOD, MEMORY_POLICY_EPOCH_METHOD,
                   MEMORY_REFLECTION_STATE_METHOD):
        assert method not in workers.AUXILIARY_WORKER_METHODS
        assert method in INBOUND_VERSIONED_REQUEST_METHODS
    assert MEMORY_REFLECT_METHOD in INBOUND_VERSIONED_REQUEST_METHODS


def test_memory_apply_then_reflection_state_round_trips_the_cursor(tmp_path) -> None:
    _init(tmp_path)

    empty = _call("memory.reflection_state", session_id="sess_9_reflect")["result"]
    applied = _call("memory.apply", **_apply_params())["result"]
    state = _call("memory.reflection_state", session_id="sess_9_reflect")["result"]
    replay = _call("memory.apply", **_apply_params())["result"]

    assert (empty["cursor"], empty["purged"]) == (None, False)
    assert applied["status"] == "applied" and len(applied["saved"]) == 1
    assert applied["saved"][0]["operation_id"] == (
        f"reflect:sess_9_reflect:{_REFLECT_FP1[7:23]}:0"
    )
    cursor = state["cursor"]
    assert cursor["window_fingerprint"] == _REFLECT_FP1
    assert cursor["session_incarnation"] == "inc_abc"
    assert cursor["project_id"] == "project_alpha"
    assert state["purged"] is False
    assert replay["status"] == "refused" and replay["reason"] == "cursor_moved"


def test_memory_policy_epoch_fences_apply_per_source(tmp_path) -> None:
    _init(tmp_path)

    first = _call("memory.policy_epoch", policy_epoch=5, epoch_source="source_a")["result"]
    lower = _call("memory.policy_epoch", policy_epoch=3, epoch_source="source_a")["result"]
    assert first["latest"] == 5 and lower["latest"] == 5
    stale = _call("memory.apply", **_apply_params(policy_epoch=4))["result"]
    fresh_source = _call("memory.apply", **_apply_params(policy_epoch=0,
                                                         epoch_source="source_b"))["result"]

    assert stale["status"] == "refused" and stale["reason"] == "policy_stale"
    assert fresh_source["status"] == "applied"


@pytest.mark.parametrize(
    ("method", "params"),
    [
        ("memory.reflection_state", {}),
        ("memory.reflection_state", {"session_id": 7}),
        ("memory.policy_epoch", {"policy_epoch": -1, "epoch_source": "a"}),
        ("memory.policy_epoch", {"policy_epoch": True, "epoch_source": "a"}),
        ("memory.policy_epoch", {"policy_epoch": 1, "epoch_source": ""}),
        ("memory.policy_epoch", {"policy_epoch": 1, "epoch_source": "a" * 65}),
        ("memory.apply", _apply_params(capture="off")),
        ("memory.apply", _apply_params(policy_epoch="2")),
        ("memory.apply", _apply_params(project_id="alpha")),
        ("memory.apply", _apply_params(expected_fingerprint=5)),
        ("memory.apply", _apply_params(cursor={"message_count": 1})),
        ("memory.apply", _apply_params(cursor={
            "message_count": 4, "last_message_id": "m-4", "window_fingerprint": "sha256:x",
            "session_incarnation": "inc_abc", "turn_generation": 1})),
        ("memory.apply", _apply_params(proposals=[{"text": "x"}] * 6)),
        ("memory.apply", _apply_params(proposals=[{"text": 4, "kind": "fact",
                                                   "source_message_id": "m-1"}])),
        ("memory.apply", _apply_params(recap="x" * 401)),
        ("memory.apply", _apply_params(session_id="bad session id")),
    ],
)
def test_reflection_methods_reject_invalid_params(tmp_path, method: str, params: dict) -> None:
    _init(tmp_path)

    response = _call(method, **params)

    assert response["error"]["code"] == INVALID_PARAMS


@pytest.mark.parametrize("scope", ["chat", "x", None, [], {}])
def test_memory_apply_validates_scope_and_round_trips_chat_notes(tmp_path, scope: Any) -> None:
    store = _init(tmp_path)
    proposals = [{"text": "Tried the parser migration with tabs.", "kind": "decision",
                  "source_message_id": "m-1", "scope": scope}]
    response = _call("memory.apply", **_apply_params(proposals=proposals, recap=""))

    if scope != "chat":
        assert response["error"]["code"] == INVALID_PARAMS
        assert store.reflection_state("sess_9_reflect")["cursor"] is None
        assert store.get_all_memories(project_id="project_alpha") == []
        return
    saved = response["result"]["saved"]
    assert len(saved) == 1 and saved[0]["scope"] == "chat"
    rows, _ = store.list_active(project_id="project_alpha", scope_session_id="sess_9_reflect")
    assert [(row.id, row.scope_session_id, row.source_message_ids) for row in rows] == [
        (saved[0]["memory_id"], "sess_9_reflect", ("m-1",))
    ]
