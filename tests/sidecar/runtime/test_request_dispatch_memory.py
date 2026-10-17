"""Behavioral unit tests for sidecar.runtime.request_dispatch_memory.

Drives process_memory_method through every memory.* handler's guard and
error branches using INJECTED recorders/raisers. The handlers call helpers
imported into the request_dispatch_memory namespace, so we monkeypatch those
names on the module-under-test and assert (a) concrete response shapes and
(b) that the injected helper was invoked with the expected memory_store.

No network/disk/LLM: brain_container is a duck-typed SimpleNamespace and the
memory_store is an opaque sentinel that must be threaded through unchanged.
"""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.request_dispatch_memory as rdm
from sidecar.ai.error_codes import CMP_MEMORY_INVALID_KIND, CMP_MEMORY_PROJECT_ARCHIVED
from sidecar.ai.memory.service import MemoryWriteResult
from sidecar.ai.memory.store import ApprovedMemory
from sidecar.ai.memory.unavailable import UnavailableMemoryStore
from sidecar.exceptions import MemoryStoreError
from sidecar.protocol import (
    API_VERSION,
    JSONRPC_VERSION,
    MEMORY_ARCHIVE_PROJECT_METHOD,
    MEMORY_CLEAR_SUPPRESSIONS_METHOD,
    MEMORY_DELETE_METHOD,
    MEMORY_LIST_METHOD,
    MEMORY_PENDING_ACCEPT_METHOD,
    MEMORY_PENDING_DELETE_METHOD,
    MEMORY_PENDING_LIST_METHOD,
    MEMORY_PURGE_SESSION_METHOD,
    MEMORY_RECALL_METHOD,
    MEMORY_RESTORE_METHOD,
    MEMORY_SAVE_METHOD,
    MEMORY_STATUS_METHOD,
    MEMORY_UNDO_METHOD,
    MEMORY_UPDATE_METHOD,
)
from sidecar.runtime.memory import MemoryRequestError

LOGGER = logging.getLogger("test.request_dispatch_memory")

# Opaque sentinel: the dispatcher must thread this through to every helper
# exactly as it found it on brain_container.stack.memory_store.
MEMORY_STORE_SENTINEL = object()

# (method, the helper it calls)
HANDLERS: list[tuple[str, str]] = [
    (MEMORY_SAVE_METHOD, "save_memory_candidate"),
    (MEMORY_LIST_METHOD, "list_memories_page"),
    (MEMORY_PENDING_LIST_METHOD, "list_pending_memories_page"),
    (MEMORY_UPDATE_METHOD, "update_memory"),
    (MEMORY_DELETE_METHOD, "delete_memory"),
    (MEMORY_PENDING_DELETE_METHOD, "delete_pending_memory"),
    (MEMORY_PENDING_ACCEPT_METHOD, "accept_pending_memory"),
    (MEMORY_RECALL_METHOD, "recall_memories"),
    (MEMORY_UNDO_METHOD, "undo_memory_operation"),
    (MEMORY_RESTORE_METHOD, "restore_memory"),
    (MEMORY_ARCHIVE_PROJECT_METHOD, "archive_project_memories"),
    (MEMORY_PURGE_SESSION_METHOD, "purge_session_memories"),
    (MEMORY_CLEAR_SUPPRESSIONS_METHOD, "clear_memory_suppressions"),
]


def make_brain() -> SimpleNamespace:
    return SimpleNamespace(
        stack=SimpleNamespace(
            memory_store=MEMORY_STORE_SENTINEL,
            memory_service=SimpleNamespace(
                status=lambda **_kwargs: {
                    "available": True,
                    "schema_version": 9,
                    "counts": {"active": 0},
                }
            ),
        )
    )


def accept_params(**extra: Any) -> dict[str, Any]:
    """Params that pass validate_accept_version (accept_version == API_VERSION)."""
    base: dict[str, Any] = {"accept_version": API_VERSION}
    base.update(extra)
    return base


def run(method: str, message_id: Any, params: Any, *, initialized: bool = True):
    return rdm.process_memory_method(
        method=method,
        message_id=message_id,
        params=params,
        initialized=initialized,
        brain_container=make_brain(),
        logger=LOGGER,
    )


class Recorder:
    """Records every call's kwargs; returns a fixed value."""

    def __init__(self, return_value: Any) -> None:
        self.calls: list[dict[str, Any]] = []
        self.return_value = return_value

    def __call__(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self.return_value


class Raiser:
    """Records calls, then raises the supplied exception."""

    def __init__(self, exc: BaseException) -> None:
        self.calls: list[dict[str, Any]] = []
        self.exc = exc

    def __call__(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        raise self.exc


def approved_memory(**overrides: Any) -> ApprovedMemory:
    values: dict[str, Any] = {
        "id": 42,
        "session_id": "sess-1",
        "title": "t",
        "lesson_text": "lt",
        "lesson_kind": "preference",
        "confidence": 0.5,
        "source_excerpt": "se",
        "content_fingerprint": "cf",
        "provenance": "user_approved",
        "created_at": "2026-01-01",
        "updated_at": "2026-01-02",
        **overrides,
    }
    return ApprovedMemory(**values)


def saved(**overrides: Any) -> MemoryWriteResult:
    values: dict[str, Any] = {
        "status": "saved",
        "memory": approved_memory(),
        "operation_id": "op-1",
        "undoable": True,
        **overrides,
    }
    return MemoryWriteResult(**values)


# ---------------------------------------------------------------------------
# memory.status and the unavailable store
# ---------------------------------------------------------------------------


def test_memory_status_returns_content_free_health_payload() -> None:
    outcome = run(MEMORY_STATUS_METHOD, 41, accept_params())

    assert outcome is not None
    assert outcome.response == {
        "api_version": API_VERSION,
        "jsonrpc": JSONRPC_VERSION,
        "id": 41,
        "result": {
            "api_version": API_VERSION,
            "available": True,
            "schema_version": 9,
            "counts": {"active": 0},
        },
    }


def test_memory_status_scope_all_requests_every_project() -> None:
    captured: list[dict[str, Any]] = []

    def _status(**kwargs: Any) -> dict[str, object]:
        captured.append(dict(kwargs))
        return {"available": True, "schema_version": 9, "counts": {"active": 0}}

    brain = make_brain()
    brain.stack.memory_service = SimpleNamespace(status=_status)
    for params in (accept_params(), accept_params(scope="all")):
        outcome = rdm.process_memory_method(
            method=MEMORY_STATUS_METHOD,
            message_id=43,
            params=params,
            initialized=True,
            brain_container=brain,
            logger=LOGGER,
        )
        assert outcome is not None
        assert "error" not in outcome.response
    assert captured == [
        {"project_id": "project_general", "all_projects": False},
        {"project_id": "project_general", "all_projects": True},
    ]


def test_memory_status_contains_unexpected_database_failure(caplog: pytest.LogCaptureFixture) -> None:
    def _fail_status(**_kwargs: Any) -> dict[str, object]:
        raise RuntimeError("database path and row content must not escape")

    with caplog.at_level(logging.WARNING):
        outcome = rdm.process_memory_method(
            method=MEMORY_STATUS_METHOD,
            message_id=42,
            params=accept_params(),
            initialized=True,
            brain_container=SimpleNamespace(
                stack=SimpleNamespace(memory_service=SimpleNamespace(status=_fail_status))
            ),
            logger=LOGGER,
        )

    assert outcome is not None
    result = outcome.response["result"]
    assert result["available"] is False
    assert result["repair_required"] is True
    assert result["degraded_reasons"] == ["CMP-MEM-0001"]
    assert "database path" not in caplog.text


def test_unavailable_store_returns_structured_memory_rpc_error() -> None:
    unavailable = UnavailableMemoryStore(
        db_path=Path("memory.db"),
        reason_code="CMP-MEM-0005",
        reason="future schema requires explicit repair",
    )
    outcome = rdm.process_memory_method(
        method=MEMORY_LIST_METHOD,
        message_id=17,
        params=accept_params(),
        initialized=True,
        brain_container=SimpleNamespace(stack=SimpleNamespace(memory_store=unavailable)),
        logger=LOGGER,
    )

    assert outcome is not None
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["data"]["code"] == "CMP-MEM-0005"
    assert error["data"]["detail"] == "memory is unavailable; explicit repair is required"


# ---------------------------------------------------------------------------
# Cross-cutting guards for every handler
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "method",
    ["not.a.memory.method", "memory.suggest", "memory.recall_recent", "memory.move_project"],
)
def test_unknown_and_retired_methods_return_none(method: str) -> None:
    # None lets request_dispatch answer with its METHOD_NOT_FOUND error.
    assert run(method, 1, accept_params()) is None


@pytest.mark.parametrize("method", [method for method, _ in HANDLERS])
def test_version_mismatch_returns_version_error(method: str) -> None:
    outcome = run(method, 7, {"some": "thing"})
    assert outcome is not None
    assert outcome.shutdown_requested is False
    assert outcome.initialized is True
    assert outcome.notifications == []
    error = outcome.response["error"]
    assert error["message"] == f"{method} requires compatible accept_version"
    assert error["data"]["code"] == rdm.PROTOCOL_VERSION_MISMATCH
    assert error["data"]["expected_version"] == API_VERSION
    assert error["code"] == rdm.INVALID_PARAMS_CODE


@pytest.mark.parametrize("method,helper_name", HANDLERS)
def test_none_message_id_short_circuits_without_calling_helper(
    method: str, helper_name: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    spy = Recorder(return_value=None)
    monkeypatch.setattr(rdm, helper_name, spy)
    outcome = run(method, None, accept_params())
    assert outcome is not None
    assert outcome.response is None
    assert outcome.notifications == []
    assert outcome.shutdown_requested is False
    assert spy.calls == []


@pytest.mark.parametrize("method,helper_name", HANDLERS)
def test_value_error_returns_invalid_params(
    method: str, helper_name: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rdm, helper_name, Raiser(ValueError("bad input")))
    outcome = run(method, 11, accept_params(project_id="project_alpha", session_id="s"))
    error = outcome.response["error"]
    assert error["code"] == rdm.INVALID_PARAMS_CODE
    assert error["message"] == f"{method} invalid params"
    assert error["data"]["detail"] == "bad input"


@pytest.mark.parametrize("method,helper_name", HANDLERS)
def test_store_error_returns_internal_error(
    method: str, helper_name: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    exc = MemoryStoreError("CMP-MEM-0001", "store down", retryable=True)
    monkeypatch.setattr(rdm, helper_name, Raiser(exc))
    outcome = run(method, 12, accept_params(project_id="project_alpha", session_id="s"))
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["message"] == f"{method} failed"
    assert error["data"]["detail"] == "store down"
    assert error["data"]["retryable"] is True


def test_malformed_explicit_project_scope_is_rejected_before_any_helper(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spy = Recorder(return_value={"memories": [], "next_cursor": None})
    monkeypatch.setattr(rdm, "list_memories_page", spy)

    outcome = run(MEMORY_LIST_METHOD, 19, accept_params(project_id="invalid project"))

    assert outcome.response["error"]["code"] == rdm.INVALID_PARAMS_CODE
    assert spy.calls == []


# ---------------------------------------------------------------------------
# memory.save
# ---------------------------------------------------------------------------


def test_save_threads_v9_params_and_returns_the_write_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spy = Recorder(return_value=saved())
    monkeypatch.setattr(rdm, "save_memory_candidate", spy)
    params = accept_params(
        session_id="s9",
        candidate={"lesson_text": "x", "lesson_kind": "fact"},
        project_id="project_alpha",
        scope_session_id="chat-1",
        always_on=False,
        operation_id="op-1",
    )

    result = run(MEMORY_SAVE_METHOD, 20, params).response["result"]

    assert result["created"] is True
    assert result["status"] == "saved" and result["duplicate"] is False
    assert result["operation_id"] == "op-1" and result["undoable"] is True
    assert result["memory"]["id"] == 42 and "family_key" not in result["memory"]
    assert "reason" not in result
    assert spy.calls == [
        {
            "session_id": "s9",
            "candidate": {"lesson_text": "x", "lesson_kind": "fact"},
            "memory_store": MEMORY_STORE_SENTINEL,
            "project_id": "project_alpha",
            "scope_session_id": "chat-1",
            "always_on": False,
            "operation_id": "op-1",
        }
    ]


def test_save_duplicate_is_not_created(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        rdm, "save_memory_candidate", Recorder(saved(duplicate=True, operation_id=None))
    )

    result = run(MEMORY_SAVE_METHOD, 21, accept_params()).response["result"]

    assert result["created"] is False and result["duplicate"] is True


def test_save_refusal_is_a_result_with_reason_and_code_and_logs_no_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    refused = MemoryWriteResult(
        status="refused",
        memory=None,
        operation_id=None,
        reason="project_archived",
        code=CMP_MEMORY_PROJECT_ARCHIVED,
    )
    monkeypatch.setattr(rdm, "save_memory_candidate", Recorder(refused))
    logged: list[dict[str, Any]] = []
    monkeypatch.setattr(rdm, "emit_log_event", lambda *_a, **kwargs: logged.append(kwargs))

    result = run(
        MEMORY_SAVE_METHOD, 22, accept_params(candidate={"lesson_text": "secret text"})
    ).response["result"]

    assert result["created"] is False and result["status"] == "refused"
    assert (result["reason"], result["code"]) == ("project_archived", CMP_MEMORY_PROJECT_ARCHIVED)
    assert [entry["event"] for entry in logged] == ["sidecar.runtime.memory_write.refused"]
    assert logged[0]["data"] == {
        "method": MEMORY_SAVE_METHOD,
        "status": "refused",
        "reason": "project_archived",
        "code": CMP_MEMORY_PROJECT_ARCHIVED,
    }
    assert "secret text" not in repr(logged)


def test_coded_request_error_keeps_its_code(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        rdm,
        "save_memory_candidate",
        Raiser(MemoryRequestError(CMP_MEMORY_INVALID_KIND, "bad kind")),
    )

    error = run(MEMORY_SAVE_METHOD, 23, accept_params()).response["error"]

    assert error["code"] == rdm.INVALID_PARAMS_CODE
    assert error["data"]["code"] == CMP_MEMORY_INVALID_KIND


# ---------------------------------------------------------------------------
# memory.update / memory.delete / memory.undo / memory.restore
# ---------------------------------------------------------------------------


def test_update_threads_flat_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = Recorder(return_value=saved())
    monkeypatch.setattr(rdm, "update_memory", spy)
    params = accept_params(
        memory_id=42, title="new", always_on=True, expected_revision=3, operation_id="op-u"
    )

    result = run(MEMORY_UPDATE_METHOD, 50, params).response["result"]

    assert result["status"] == "saved" and result["memory"]["id"] == 42
    assert spy.calls[0]["memory_id"] == 42
    assert spy.calls[0]["changes"] == {"title": "new", "always_on": True}
    assert spy.calls[0]["expected_revision"] == 3
    assert spy.calls[0]["operation_id"] == "op-u"
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL


def test_update_rejects_the_retired_patch_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = Recorder(return_value=saved())
    monkeypatch.setattr(rdm, "update_memory", spy)

    outcome = run(MEMORY_UPDATE_METHOD, 51, accept_params(memory_id=42, patch={"title": "x"}))

    assert outcome.response["error"]["code"] == rdm.INVALID_PARAMS_CODE
    assert spy.calls == []


def test_update_conflict_is_a_result(monkeypatch: pytest.MonkeyPatch) -> None:
    conflict = MemoryWriteResult(
        status="conflict",
        memory=approved_memory(revision=4),
        operation_id=None,
        reason="stale_revision",
        code="CMP-MEM-0012",
    )
    monkeypatch.setattr(rdm, "update_memory", Recorder(conflict))

    result = run(MEMORY_UPDATE_METHOD, 52, accept_params(memory_id=42)).response["result"]

    assert result["status"] == "conflict" and result["memory"]["revision"] == 4
    assert result["reason"] == "stale_revision"


def test_delete_returns_deleted_operation_and_undoable(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = Recorder(return_value=saved(operation_id="op-d"))
    monkeypatch.setattr(rdm, "delete_memory", spy)

    result = run(
        MEMORY_DELETE_METHOD, 60, accept_params(memory_id=99, expected_revision=2)
    ).response["result"]

    assert result["deleted"] is True
    assert (result["status"], result["operation_id"], result["undoable"]) == (
        "saved",
        "op-d",
        True,
    )
    assert spy.calls[0]["memory_id"] == 99
    assert spy.calls[0]["expected_revision"] == 2


def test_delete_refusal_is_not_deleted(monkeypatch: pytest.MonkeyPatch) -> None:
    refused = MemoryWriteResult(
        status="refused", memory=None, operation_id=None, reason="not_found", code="CMP-MEM-0004"
    )
    monkeypatch.setattr(rdm, "delete_memory", Recorder(refused))

    result = run(MEMORY_DELETE_METHOD, 61, accept_params(memory_id=99)).response["result"]

    assert result["deleted"] is False and result["reason"] == "not_found"


def test_undo_and_restore_thread_their_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    undo_spy = Recorder(return_value=saved(operation_id="op-undo"))
    restore_spy = Recorder(return_value=saved(operation_id="op-r"))
    monkeypatch.setattr(rdm, "undo_memory_operation", undo_spy)
    monkeypatch.setattr(rdm, "restore_memory", restore_spy)

    undone = run(
        MEMORY_UNDO_METHOD,
        70,
        accept_params(project_id="project_alpha", operation_id="op-1", undo_operation_id="op-u"),
    ).response["result"]
    restored = run(MEMORY_RESTORE_METHOD, 71, accept_params(memory_id=5)).response["result"]

    assert undone["status"] == "saved" and restored["status"] == "saved"
    assert undo_spy.calls[0] == {
        "operation_id": "op-1",
        "undo_operation_id": "op-u",
        "memory_store": MEMORY_STORE_SENTINEL,
        "project_id": "project_alpha",
    }
    assert restore_spy.calls[0]["memory_id"] == 5
    assert restore_spy.calls[0]["project_id"] == "project_general"
    assert restore_spy.calls[0]["target_project_id"] is None

    run(MEMORY_RESTORE_METHOD, 72, accept_params(
        project_id="project_alpha", memory_id=5, target_project_id="project_beta",
    ))
    assert restore_spy.calls[1]["target_project_id"] == "project_beta"
    bad = run(MEMORY_RESTORE_METHOD, 73, accept_params(memory_id=5, target_project_id="beta"))
    assert "error" in bad.response
    assert len(restore_spy.calls) == 2


# ---------------------------------------------------------------------------
# lifecycle: archive_project / purge_session / clear_suppressions
# ---------------------------------------------------------------------------


def test_archive_purge_and_clear_return_their_counts(monkeypatch: pytest.MonkeyPatch) -> None:
    archive = Recorder({"ok": True, "archived": 2, "pending_removed": 1})
    purge = Recorder({"ok": True, "removed": 3})
    clear = Recorder({"cleared": 4})
    monkeypatch.setattr(rdm, "archive_project_memories", archive)
    monkeypatch.setattr(rdm, "purge_session_memories", purge)
    monkeypatch.setattr(rdm, "clear_memory_suppressions", clear)

    archived = run(
        MEMORY_ARCHIVE_PROJECT_METHOD, 80, accept_params(project_id="project_alpha")
    ).response["result"]
    purged = run(MEMORY_PURGE_SESSION_METHOD, 81, accept_params(session_id="chat-1")).response[
        "result"
    ]
    cleared_all = run(MEMORY_CLEAR_SUPPRESSIONS_METHOD, 82, accept_params()).response["result"]
    run(MEMORY_CLEAR_SUPPRESSIONS_METHOD, 83, accept_params(project_id="project_alpha"))

    assert (archived["archived"], archived["pending_removed"]) == (2, 1)
    assert purged["removed"] == 3 and cleared_all["cleared"] == 4
    assert archive.calls[0]["project_id"] == "project_alpha"
    assert purge.calls[0]["session_id"] == "chat-1"
    # No project_id clears every project's forgotten list; an explicit one clears one.
    assert [call["project_id"] for call in clear.calls] == [None, "project_alpha"]


# ---------------------------------------------------------------------------
# reads: list / pending list / pending delete / recall
# ---------------------------------------------------------------------------


def test_list_threads_scope_status_and_chat(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = Recorder(return_value={"memories": [{"id": 5}], "next_cursor": "100"})
    monkeypatch.setattr(rdm, "list_memories_page", spy)

    all_page = run(
        MEMORY_LIST_METHOD, 30, accept_params(scope="all", project_id="ignored-with-all-projects")
    ).response["result"]
    run(
        MEMORY_LIST_METHOD,
        31,
        accept_params(project_id="project_alpha", status="archived", scope_session_id="chat-1"),
    )

    assert all_page["memories"] == [{"id": 5}] and all_page["next_cursor"] == "100"
    assert spy.calls[0]["all_projects"] is True
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL
    assert spy.calls[1]["status"] == "archived"
    assert spy.calls[1]["scope_session_id"] == "chat-1"
    assert spy.calls[1]["project_id"] == "project_alpha"


def test_list_rejects_invalid_scope(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = Recorder(return_value={"memories": [], "next_cursor": None})
    monkeypatch.setattr(rdm, "list_memories_page", spy)

    outcome = run(MEMORY_LIST_METHOD, 30, accept_params(scope="workspace"))

    assert outcome.response["error"]["code"] == rdm.INVALID_PARAMS_CODE
    assert spy.calls == []


def test_pending_list_and_delete(monkeypatch: pytest.MonkeyPatch) -> None:
    listed = Recorder(return_value={"candidates": [{"fp": "abc"}], "next_cursor": None})
    deleted = Recorder(return_value=True)
    monkeypatch.setattr(rdm, "list_pending_memories_page", listed)
    monkeypatch.setattr(rdm, "delete_pending_memory", deleted)

    page = run(MEMORY_PENDING_LIST_METHOD, 40, accept_params(scope="all")).response["result"]
    removed = run(
        MEMORY_PENDING_DELETE_METHOD,
        41,
        accept_params(session_id="s2", content_fingerprint="fp-1"),
    ).response["result"]

    assert page["candidates"] == [{"fp": "abc"}]
    assert listed.calls[0]["all_projects"] is True
    assert removed == {"api_version": API_VERSION, "deleted": True}
    assert deleted.calls[0]["session_id"] == "s2"
    assert deleted.calls[0]["content_fingerprint"] == "fp-1"


def test_pending_accept_threads_params_and_reports_acceptance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spy = Recorder(return_value=saved())
    monkeypatch.setattr(rdm, "accept_pending_memory", spy)

    result = run(
        MEMORY_PENDING_ACCEPT_METHOD,
        42,
        accept_params(
            project_id="project_alpha",
            session_id="s2",
            content_fingerprint="fp-1",
            operation_id="op-1",
        ),
    ).response["result"]

    assert result["accepted"] is True
    assert result["status"] == "saved" and result["memory"]["id"] == 42
    assert spy.calls == [
        {
            "session_id": "s2",
            "content_fingerprint": "fp-1",
            "memory_store": MEMORY_STORE_SENTINEL,
            "project_id": "project_alpha",
            "operation_id": "op-1",
        }
    ]


def test_pending_accept_refusal_is_not_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    refused = MemoryWriteResult(
        status="refused", memory=None, operation_id=None, reason="suppressed", code="CMP-MEM-0013"
    )
    monkeypatch.setattr(rdm, "accept_pending_memory", Recorder(refused))

    result = run(MEMORY_PENDING_ACCEPT_METHOD, 43, accept_params()).response["result"]

    assert result["accepted"] is False
    assert (result["status"], result["reason"]) == ("refused", "suppressed")


def test_recall_threads_query_limit_and_chat_scope(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = Recorder(return_value=[{"id": 7}])
    monkeypatch.setattr(rdm, "recall_memories", spy)
    params = accept_params(query="hello", limit=3, include_general=True, scope_session_id="c1")

    result = run(MEMORY_RECALL_METHOD, 80, params).response["result"]

    assert result["memories"] == [{"id": 7}]
    assert spy.calls[0]["query"] == "hello"
    assert spy.calls[0]["limit"] == 3
    assert spy.calls[0]["include_general"] is True
    assert spy.calls[0]["scope_session_id"] == "c1"
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL


def test_recall_rejects_non_boolean_include_general(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = Recorder(return_value=[])
    monkeypatch.setattr(rdm, "recall_memories", spy)

    outcome = run(MEMORY_RECALL_METHOD, 80, accept_params(query="hello", include_general=1))

    assert outcome.response["error"]["code"] == rdm.INVALID_PARAMS_CODE
    assert spy.calls == []


def test_session_transfer_rpcs_use_real_service_and_validate_params(tmp_path: Path) -> None:
    from sidecar.ai.memory.service import MemoryService
    from sidecar.ai.memory.store import MemoryStore
    store = MemoryStore(tmp_path / "memory.db")
    brain = SimpleNamespace(stack=SimpleNamespace(memory_service=MemoryService(store)))
    def request(method, **params):
        outcome = rdm.process_memory_method(method, 1, accept_params(**params), True, brain, LOGGER)
        assert outcome is not None
        return outcome.response
    try:
        assert request("memory.import_session", session_id="chat", project_id="project_alpha", notes=[{"text": "Green tea", "kind": "fact"}], recap="Tea recap")["result"]["imported"] == 1
        assert request("memory.export_session", session_id="chat")["result"]["recap"]["text"] == "Tea recap"
        assert request("memory.chat_sessions")["result"] == {"session_ids": ["chat"], "truncated": False, "api_version": API_VERSION}
        for notes in ([{}] * 201, [None], [{"text": 3, "kind": "fact"}]):
            assert request("memory.import_session", session_id="chat", project_id="project_alpha", notes=notes)["error"]["code"] == -32602
        assert request("memory.import_session", session_id="chat", project_id="project_alpha", notes=[], recap=3)["error"]["code"] == -32602
        assert request("memory.export_session", session_id=3)["error"]["code"] == -32602
        assert request("memory.chat_sessions", limit=2001)["error"]["code"] == -32602
    finally:
        store.close()


def test_session_transfer_round_trip_with_electrons_request_shapes(tmp_path: Path) -> None:
    """Row 58 W3 gate: export -> import under a new chat id, as session-export-import.js sends it."""
    from sidecar.ai.memory.service import MemoryService
    from sidecar.ai.memory.store import MemoryStore
    store = MemoryStore(tmp_path / "memory.db")
    brain = SimpleNamespace(stack=SimpleNamespace(memory_service=MemoryService(store)))

    def result(method, **params):
        outcome = rdm.process_memory_method(method, 1, accept_params(**params), True, brain, LOGGER)
        assert outcome is not None
        return outcome.response["result"]

    try:
        seeded = result(
            "memory.import_session", session_id="sess_source", project_id="project_alpha",
            notes=[{"text": "Parser rewrite uses a Pratt parser.", "kind": "decision",
                    "origin": "reflection"},
                   {"text": "Tests run with pytest -q here.", "kind": "convention", "origin": "jenny"}],
            recap="Chat about the parser rewrite.",
        )
        assert seeded["imported"] == 2
        exported = result("memory.export_session", session_id="sess_source")
        appendix = {
            "notes": [{key: note[key] for key in ("text", "kind", "origin")}
                      for note in exported["notes"]],
            "recap": exported["recap"]["text"],
        }
        imported = result(
            "memory.import_session", session_id="sess_copy", project_id="project_alpha", **appendix
        )
        assert (imported["status"], imported["imported"], imported["skipped"]) == ("imported", 2, 0)
        copy = result("memory.export_session", session_id="sess_copy")
        assert [(n["text"], n["kind"], n["origin"]) for n in copy["notes"]] == [
            (n["text"], n["kind"], n["origin"]) for n in exported["notes"]
        ]
        assert copy["recap"]["text"] == "Chat about the parser rewrite."
        assert result("memory.chat_sessions", limit=2000)["session_ids"] == ["sess_copy", "sess_source"]
    finally:
        store.close()
