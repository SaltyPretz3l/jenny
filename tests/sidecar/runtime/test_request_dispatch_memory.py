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
from sidecar.ai.memory.unavailable import UnavailableMemoryStore
from sidecar.exceptions import MemoryStoreError
from sidecar.protocol import (
    API_VERSION,
    JSONRPC_VERSION,
    MEMORY_DELETE_METHOD,
    MEMORY_LIST_METHOD,
    MEMORY_PENDING_DELETE_METHOD,
    MEMORY_PENDING_LIST_METHOD,
    MEMORY_RECALL_METHOD,
    MEMORY_RECALL_RECENT_METHOD,
    MEMORY_SAVE_METHOD,
    MEMORY_STATUS_METHOD,
    MEMORY_SUGGEST_METHOD,
    MEMORY_UPDATE_METHOD,
)

LOGGER = logging.getLogger("test.request_dispatch_memory")

# Opaque sentinel: the dispatcher must thread this through to every helper
# exactly as it found it on brain_container.stack.memory_store.
MEMORY_STORE_SENTINEL = object()


def make_brain() -> SimpleNamespace:
    return SimpleNamespace(
        stack=SimpleNamespace(
            memory_store=MEMORY_STORE_SENTINEL,
            memory_service=SimpleNamespace(
                status=lambda: {
                    "available": True,
                    "schema_version": 7,
                    "counts": {"approved": 0},
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
            "schema_version": 7,
            "counts": {"approved": 0},
        },
    }


def test_memory_status_contains_unexpected_database_failure(caplog: pytest.LogCaptureFixture) -> None:
    def _fail_status() -> dict[str, object]:
        raise RuntimeError("database path and row content must not escape")

    with caplog.at_level(logging.WARNING):
        outcome = rdm.process_memory_method(
            method=MEMORY_STATUS_METHOD,
            message_id=42,
            params=accept_params(),
            initialized=True,
            brain_container=SimpleNamespace(
                stack=SimpleNamespace(
                    memory_service=SimpleNamespace(status=_fail_status)
                )
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
        brain_container=SimpleNamespace(
            stack=SimpleNamespace(memory_store=unavailable)
        ),
        logger=LOGGER,
    )

    assert outcome is not None
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["data"]["code"] == "CMP-MEM-0005"
    assert error["data"]["detail"] == "memory is unavailable; explicit repair is required"


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


def approved_memory() -> SimpleNamespace:
    return SimpleNamespace(
        id=42,
        session_id="sess-1",
        title="t",
        lesson_text="lt",
        lesson_kind="lk",
        confidence=0.5,
        source_excerpt="se",
        content_fingerprint="cf",
        family_key="fk",
        provenance="pv",
        created_at="2026-01-01",
        updated_at="2026-01-02",
    )


# ---------------------------------------------------------------------------
# Cross-cutting: unknown method short-circuits to None (covers final return).
# ---------------------------------------------------------------------------


def test_unknown_method_returns_none() -> None:
    assert run("not.a.memory.method", 1, accept_params()) is None


# ---------------------------------------------------------------------------
# Version-mismatch guard (covers `version_error is not None` branch per method).
# accept_version absent -> validate_accept_version returns an error response.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "method",
    [
        MEMORY_SUGGEST_METHOD,
        MEMORY_SAVE_METHOD,
        MEMORY_LIST_METHOD,
        MEMORY_PENDING_LIST_METHOD,
        MEMORY_UPDATE_METHOD,
        MEMORY_DELETE_METHOD,
        MEMORY_PENDING_DELETE_METHOD,
        MEMORY_RECALL_METHOD,
        MEMORY_RECALL_RECENT_METHOD,
    ],
)
def test_version_mismatch_returns_version_error(method: str) -> None:
    # params lacks accept_version -> request_accept_version() is None != API_VERSION
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


# ---------------------------------------------------------------------------
# message_id is None guard (covers the notification short-circuit per method):
# version passes, but no id => response is None, helper must NOT be invoked.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "method,helper_name",
    [
        (MEMORY_SUGGEST_METHOD, "suggest_memories"),
        (MEMORY_SAVE_METHOD, "save_memory_candidate"),
        (MEMORY_LIST_METHOD, "list_memories_page"),
        (MEMORY_PENDING_LIST_METHOD, "list_pending_memories_page"),
        (MEMORY_UPDATE_METHOD, "update_memory"),
        (MEMORY_DELETE_METHOD, "delete_memory"),
        (MEMORY_PENDING_DELETE_METHOD, "delete_pending_memory"),
        (MEMORY_RECALL_METHOD, "recall_memories"),
        (MEMORY_RECALL_RECENT_METHOD, "recall_recent_memories"),
    ],
)
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
    # Short-circuit guard: the memory helper must never run for a notification.
    assert spy.calls == []


# ---------------------------------------------------------------------------
# memory.suggest
# ---------------------------------------------------------------------------


def test_suggest_success_threads_store_and_returns_suggestions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spy = Recorder(return_value=[{"id": 1}, {"id": 2}])
    monkeypatch.setattr(rdm, "suggest_memories", spy)
    params = accept_params(session_id="s1", messages=[{"role": "user"}])
    outcome = run(MEMORY_SUGGEST_METHOD, 10, params)
    assert outcome.response["result"]["suggestions"] == [{"id": 1}, {"id": 2}]
    assert outcome.response["jsonrpc"] == JSONRPC_VERSION
    assert outcome.response["id"] == 10
    assert len(spy.calls) == 1
    assert spy.calls[0]["session_id"] == "s1"
    assert spy.calls[0]["messages"] == [{"role": "user"}]
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL


def test_suggest_value_error_returns_invalid_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rdm, "suggest_memories", Raiser(ValueError("bad messages")))
    outcome = run(MEMORY_SUGGEST_METHOD, 11, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INVALID_PARAMS_CODE
    assert error["message"] == "memory.suggest invalid params"
    assert error["data"]["detail"] == "bad messages"


def test_suggest_store_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    exc = MemoryStoreError("CMP-MEM-0001", "store down", retryable=True)
    monkeypatch.setattr(rdm, "suggest_memories", Raiser(exc))
    outcome = run(MEMORY_SUGGEST_METHOD, 12, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["message"] == "memory.suggest failed"
    assert error["data"]["detail"] == "store down"
    assert error["data"]["retryable"] is True


# ---------------------------------------------------------------------------
# memory.save
# ---------------------------------------------------------------------------


def test_save_success_no_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    save_result = SimpleNamespace(
        created=True,
        warning_code=None,
        warning_detail=None,
        memory=approved_memory(),
    )
    spy = Recorder(return_value=save_result)
    monkeypatch.setattr(rdm, "save_memory_candidate", spy)
    emit_calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        rdm, "emit_log_event", lambda *a, **k: emit_calls.append(k)
    )
    params = accept_params(session_id="s9", candidate={"title": "x"})
    outcome = run(MEMORY_SAVE_METHOD, 20, params)
    result = outcome.response["result"]
    assert result["created"] is True
    assert result["memory"]["id"] == 42
    assert result["memory"]["session_id"] == "sess-1"
    assert spy.calls[0]["session_id"] == "s9"
    assert spy.calls[0]["candidate"] == {"title": "x"}
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL
    # No warning code/detail -> the family-unresolved log must NOT be emitted.
    assert emit_calls == []


def test_save_success_with_warning_emits_log(monkeypatch: pytest.MonkeyPatch) -> None:
    mem = approved_memory()
    save_result = SimpleNamespace(
        created=False,
        warning_code="CMP-MEM-FAMILY",
        warning_detail="family unresolved",
        memory=mem,
    )
    monkeypatch.setattr(rdm, "save_memory_candidate", Recorder(save_result))
    emit_calls: list[dict[str, Any]] = []

    def fake_emit(logger: Any, level: int, **kwargs: Any) -> None:
        emit_calls.append({"level": level, **kwargs})

    monkeypatch.setattr(rdm, "emit_log_event", fake_emit)
    outcome = run(MEMORY_SAVE_METHOD, 21, accept_params(candidate={}))
    assert outcome.response["result"]["created"] is False
    assert len(emit_calls) == 1
    emitted = emit_calls[0]
    assert emitted["level"] == logging.WARNING
    assert emitted["event"] == "sidecar.runtime.memory_save.family_unresolved"
    assert emitted["data"]["code"] == "CMP-MEM-FAMILY"
    assert emitted["data"]["detail"] == "family unresolved"
    assert emitted["data"]["memory_id"] == mem.id


def test_save_value_error_returns_invalid_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdm, "save_memory_candidate", Raiser(ValueError("missing candidate"))
    )
    outcome = run(MEMORY_SAVE_METHOD, 22, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INVALID_PARAMS_CODE
    assert error["message"] == "memory.save invalid params"
    assert error["data"]["detail"] == "missing candidate"


def test_save_store_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdm, "save_memory_candidate", Raiser(MemoryStoreError("c", "disk full"))
    )
    outcome = run(MEMORY_SAVE_METHOD, 23, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["message"] == "memory.save failed"
    assert error["data"]["detail"] == "disk full"


# ---------------------------------------------------------------------------
# memory.list
# ---------------------------------------------------------------------------


def test_list_success_returns_memories(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = Recorder(return_value={"memories": [{"id": 5}], "next_cursor": "100"})
    monkeypatch.setattr(rdm, "list_memories_page", spy)
    outcome = run(MEMORY_LIST_METHOD, 30, accept_params())
    assert outcome.response["result"]["memories"] == [{"id": 5}]
    assert outcome.response["result"]["next_cursor"] == "100"
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL


def test_list_store_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdm, "list_memories_page", Raiser(MemoryStoreError("c", "list boom"))
    )
    outcome = run(MEMORY_LIST_METHOD, 31, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["message"] == "memory.list failed"
    assert error["data"]["detail"] == "list boom"


# ---------------------------------------------------------------------------
# memory.pending.list
# ---------------------------------------------------------------------------


def test_pending_list_success_returns_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spy = Recorder(return_value={"candidates": [{"fp": "abc"}], "next_cursor": None})
    monkeypatch.setattr(rdm, "list_pending_memories_page", spy)
    outcome = run(MEMORY_PENDING_LIST_METHOD, 40, accept_params())
    assert outcome.response["result"]["candidates"] == [{"fp": "abc"}]
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL


def test_pending_list_store_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdm, "list_pending_memories_page", Raiser(MemoryStoreError("c", "pending boom"))
    )
    outcome = run(MEMORY_PENDING_LIST_METHOD, 41, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["message"] == "memory.pending.list failed"
    assert error["data"]["detail"] == "pending boom"


# ---------------------------------------------------------------------------
# memory.update
# ---------------------------------------------------------------------------


def test_update_success_returns_updated_memory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mem = approved_memory()
    spy = Recorder(return_value=mem)
    monkeypatch.setattr(rdm, "update_memory", spy)
    params = accept_params(memory_id=42, patch={"title": "new"})
    outcome = run(MEMORY_UPDATE_METHOD, 50, params)
    result = outcome.response["result"]
    assert result["updated"] is True
    assert result["memory"]["id"] == 42
    assert spy.calls[0]["memory_id"] == 42
    assert spy.calls[0]["patch"] == {"title": "new"}
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL


def test_update_value_error_returns_invalid_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rdm, "update_memory", Raiser(ValueError("bad patch")))
    outcome = run(MEMORY_UPDATE_METHOD, 51, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INVALID_PARAMS_CODE
    assert error["message"] == "memory.update invalid params"
    assert error["data"]["detail"] == "bad patch"


def test_update_store_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdm, "update_memory", Raiser(MemoryStoreError("c", "update boom"))
    )
    outcome = run(MEMORY_UPDATE_METHOD, 52, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["message"] == "memory.update failed"
    assert error["data"]["detail"] == "update boom"


# ---------------------------------------------------------------------------
# memory.delete
# ---------------------------------------------------------------------------


def test_delete_success_returns_deleted_and_int_memory_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spy = Recorder(return_value=True)
    monkeypatch.setattr(rdm, "delete_memory", spy)
    outcome = run(MEMORY_DELETE_METHOD, 60, accept_params(memory_id=99))
    result = outcome.response["result"]
    assert result["deleted"] is True
    # integer (non-bool) memory_id is echoed back when deleted
    assert result["memory_id"] == 99
    assert spy.calls[0]["memory_id"] == 99
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL


def test_delete_not_found_returns_none_memory_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rdm, "delete_memory", Recorder(return_value=False))
    outcome = run(MEMORY_DELETE_METHOD, 61, accept_params(memory_id=99))
    result = outcome.response["result"]
    assert result["deleted"] is False
    # not deleted -> memory_id is None regardless of the requested id
    assert result["memory_id"] is None


def test_delete_bool_memory_id_is_not_echoed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rdm, "delete_memory", Recorder(return_value=True))
    # bool is excluded by the `not isinstance(..., bool)` guard
    outcome = run(MEMORY_DELETE_METHOD, 62, accept_params(memory_id=True))
    result = outcome.response["result"]
    assert result["deleted"] is True
    assert result["memory_id"] is None


def test_delete_value_error_returns_invalid_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rdm, "delete_memory", Raiser(ValueError("bad id")))
    outcome = run(MEMORY_DELETE_METHOD, 63, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INVALID_PARAMS_CODE
    assert error["message"] == "memory.delete invalid params"
    assert error["data"]["detail"] == "bad id"


def test_delete_store_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdm, "delete_memory", Raiser(MemoryStoreError("c", "delete boom"))
    )
    outcome = run(MEMORY_DELETE_METHOD, 64, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["message"] == "memory.delete failed"
    assert error["data"]["detail"] == "delete boom"


# ---------------------------------------------------------------------------
# memory.pending.delete
# ---------------------------------------------------------------------------


def test_pending_delete_success_returns_deleted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spy = Recorder(return_value=True)
    monkeypatch.setattr(rdm, "delete_pending_memory", spy)
    params = accept_params(session_id="s2", content_fingerprint="fp-1")
    outcome = run(MEMORY_PENDING_DELETE_METHOD, 70, params)
    assert outcome.response["result"]["deleted"] is True
    assert spy.calls[0]["session_id"] == "s2"
    assert spy.calls[0]["content_fingerprint"] == "fp-1"
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL


def test_pending_delete_value_error_returns_invalid_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdm, "delete_pending_memory", Raiser(ValueError("bad fp"))
    )
    outcome = run(MEMORY_PENDING_DELETE_METHOD, 71, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INVALID_PARAMS_CODE
    assert error["message"] == "memory.pending.delete invalid params"
    assert error["data"]["detail"] == "bad fp"


def test_pending_delete_store_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdm,
        "delete_pending_memory",
        Raiser(MemoryStoreError("c", "pending delete boom")),
    )
    outcome = run(MEMORY_PENDING_DELETE_METHOD, 72, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["message"] == "memory.pending.delete failed"
    assert error["data"]["detail"] == "pending delete boom"


# ---------------------------------------------------------------------------
# memory.recall
# ---------------------------------------------------------------------------


def test_recall_success_threads_query_and_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spy = Recorder(return_value=[{"id": 7}])
    monkeypatch.setattr(rdm, "recall_memories", spy)
    params = accept_params(query="hello", limit=3)
    outcome = run(MEMORY_RECALL_METHOD, 80, params)
    assert outcome.response["result"]["memories"] == [{"id": 7}]
    assert spy.calls[0]["query"] == "hello"
    assert spy.calls[0]["limit"] == 3
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL


def test_recall_value_error_returns_invalid_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rdm, "recall_memories", Raiser(ValueError("bad query")))
    outcome = run(MEMORY_RECALL_METHOD, 81, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INVALID_PARAMS_CODE
    assert error["message"] == "memory.recall invalid params"
    assert error["data"]["detail"] == "bad query"


def test_recall_store_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdm, "recall_memories", Raiser(MemoryStoreError("c", "recall boom"))
    )
    outcome = run(MEMORY_RECALL_METHOD, 82, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["message"] == "memory.recall failed"
    assert error["data"]["detail"] == "recall boom"


# ---------------------------------------------------------------------------
# memory.recall_recent
# ---------------------------------------------------------------------------


def test_recall_recent_success_threads_lesson_kind_and_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spy = Recorder(return_value=[{"id": 9}])
    monkeypatch.setattr(rdm, "recall_recent_memories", spy)
    params = accept_params(lesson_kind="bugfix", limit=2)
    outcome = run(MEMORY_RECALL_RECENT_METHOD, 90, params)
    assert outcome.response["result"]["memories"] == [{"id": 9}]
    assert spy.calls[0]["lesson_kind"] == "bugfix"
    assert spy.calls[0]["limit"] == 2
    assert spy.calls[0]["memory_store"] is MEMORY_STORE_SENTINEL


def test_recall_recent_value_error_returns_invalid_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdm, "recall_recent_memories", Raiser(ValueError("bad lesson_kind"))
    )
    outcome = run(MEMORY_RECALL_RECENT_METHOD, 91, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INVALID_PARAMS_CODE
    assert error["message"] == "memory.recall_recent invalid params"
    assert error["data"]["detail"] == "bad lesson_kind"


def test_recall_recent_store_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdm,
        "recall_recent_memories",
        Raiser(MemoryStoreError("c", "recall recent boom")),
    )
    outcome = run(MEMORY_RECALL_RECENT_METHOD, 92, accept_params())
    error = outcome.response["error"]
    assert error["code"] == rdm.INTERNAL_ERROR_CODE
    assert error["message"] == "memory.recall_recent failed"
    assert error["data"]["detail"] == "recall recent boom"
