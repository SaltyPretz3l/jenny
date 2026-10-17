"""conversations.* JSON-RPC dispatch: versioning, params, unavailable results, round trips."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.request_dispatch_conversations as rdc
from sidecar.ai.config import parse_runtime_config
from sidecar.ai.conversations import runtime
from sidecar.ai.conversations import store as store_module
from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.ai.host_policy import HOST_ALLOWED_RPC_METHODS
from sidecar.ai.semantic import runtime as semantic_runtime
from sidecar.protocol import (
    API_VERSION,
    CONVERSATIONS_EMBED_STEP_METHOD,
    CONVERSATIONS_INDEX_SESSION_METHOD,
    CONVERSATIONS_INDEX_STATE_METHOD,
    CONVERSATIONS_PURGE_METHOD,
    CONVERSATIONS_SEARCH_METHOD,
    INBOUND_VERSIONED_REQUEST_METHODS,
)
from sidecar.runtime import request_dispatch, server_auxiliary_workers
from tests.sidecar.ai.conversations.helpers import SynonymProvider, handle

LOGGER = logging.getLogger("test.request_dispatch_conversations")
METHODS = (
    CONVERSATIONS_INDEX_STATE_METHOD,
    CONVERSATIONS_INDEX_SESSION_METHOD,
    CONVERSATIONS_PURGE_METHOD,
    CONVERSATIONS_SEARCH_METHOD,
    CONVERSATIONS_EMBED_STEP_METHOD,
)
VALID_PARAMS: dict[str, dict[str, Any]] = {
    CONVERSATIONS_INDEX_STATE_METHOD: {},
    CONVERSATIONS_INDEX_SESSION_METHOD: {
        "session_id": "s1", "project_id": "p1", "title": "T", "updated_at": "u",
        "fingerprint": "f", "messages": [],
    },
    CONVERSATIONS_PURGE_METHOD: {"all": True},
    CONVERSATIONS_SEARCH_METHOD: {"query": "x", "project_id": "p1"},
    CONVERSATIONS_EMBED_STEP_METHOD: {},
}


def _container(config: Any = None) -> Any:
    return SimpleNamespace(stack=SimpleNamespace(config=config or parse_runtime_config({})))


def _enabled(tmp_path: Path) -> Any:
    return _container(parse_runtime_config({
        "conversation_index": {"enabled": True, "db_path": str(tmp_path / "ci.db")},
    }))


def _run(method: str, params: Any, *, message_id: Any = 7, container: Any = None) -> Any:
    return rdc.process_conversations_method(
        method=method,
        message_id=message_id,
        params=params,
        initialized=True,
        brain_container=container or _container(),
        logger=LOGGER,
    )


def _params(**extra: Any) -> dict[str, Any]:
    return {"accept_version": API_VERSION, **extra}


def _message(index: int, text: str, role: str = "user") -> dict[str, Any]:
    return {"message_id": f"m{index}", "role": role, "created_at": "2026-10-15", "text": text}


def _index(container: Any, session_id: str, texts: list[str], **extra: Any) -> dict[str, Any]:
    params = {
        "session_id": session_id, "project_id": "p1", "title": f"Chat {session_id}",
        "updated_at": "2026-10-15T10:00:00Z", "fingerprint": f"fp-{session_id}",
        "messages": [_message(i, text) for i, text in enumerate(texts)],
    }
    params.update(extra)
    return _run(CONVERSATIONS_INDEX_SESSION_METHOD, _params(**params),
                container=container).response["result"]


@pytest.fixture(autouse=True)
def _reset_runtime(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    runtime.configure_conversation_index({})
    monkeypatch.setattr(semantic_runtime, "current_embedder", lambda: None)
    yield
    runtime.configure_conversation_index({})


def test_methods_are_versioned_routed_off_loop_and_not_hosted() -> None:
    families = server_auxiliary_workers.AUXILIARY_FAMILY_BY_METHOD
    caps = server_auxiliary_workers.DEFAULT_MAX_WORKERS_BY_FAMILY
    for method in METHODS:
        assert method.startswith("conversations.")
        assert method in INBOUND_VERSIONED_REQUEST_METHODS
        assert method in server_auxiliary_workers.AUXILIARY_WORKER_METHODS
        assert method not in HOST_ALLOWED_RPC_METHODS
    for method in (CONVERSATIONS_INDEX_SESSION_METHOD, CONVERSATIONS_PURGE_METHOD,
                   CONVERSATIONS_EMBED_STEP_METHOD):
        assert families[method] == "conversation_index"
    for method in (CONVERSATIONS_SEARCH_METHOD, CONVERSATIONS_INDEX_STATE_METHOD):
        assert families[method] == "conversation_read"
    assert (caps["conversation_index"], caps["conversation_read"]) == (1, 2)


def test_main_dispatcher_routes_the_family(tmp_path: Path) -> None:
    outcome = request_dispatch.process_message(
        {"jsonrpc": "2.0", "id": 3, "method": CONVERSATIONS_INDEX_STATE_METHOD,
         "params": _params()},
        True,
        brain_container=_enabled(tmp_path),
        logger=LOGGER,
        write_message=lambda _message: None,
        read_message=lambda: {},
    )

    assert outcome.response["result"]["ok"] is True


def test_other_methods_are_not_handled() -> None:
    assert _run("catalog.status", _params()) is None


@pytest.mark.parametrize("method", METHODS)
def test_accept_version_mismatch_is_rejected(method: str) -> None:
    outcome = _run(method, {"accept_version": "1999-01-01", **VALID_PARAMS[method]})

    assert outcome.response["error"]["data"]["code"] == CMP_PROTO_VERSION_MISMATCH


def test_notifications_get_no_response() -> None:
    outcome = _run(CONVERSATIONS_INDEX_STATE_METHOD, _params(), message_id=None)

    assert outcome is not None and outcome.response is None


@pytest.mark.parametrize("method", METHODS)
def test_disabled_config_is_index_unavailable(method: str) -> None:
    result = _run(method, _params(**VALID_PARAMS[method])).response["result"]

    assert (result["ok"], result["reason"]) == (False, "index_unavailable")


_SESSION = VALID_PARAMS[CONVERSATIONS_INDEX_SESSION_METHOD]


@pytest.mark.parametrize(
    ("method", "params"),
    [
        (CONVERSATIONS_INDEX_SESSION_METHOD, {**_SESSION, "session_id": ""}),
        (CONVERSATIONS_INDEX_SESSION_METHOD, {**_SESSION, "session_id": "s" * 129}),
        (CONVERSATIONS_INDEX_SESSION_METHOD, {**_SESSION, "project_id": None}),
        (CONVERSATIONS_INDEX_SESSION_METHOD, {**_SESSION, "title": "t" * 201}),
        (CONVERSATIONS_INDEX_SESSION_METHOD, {**_SESSION, "fingerprint": 5}),
        (CONVERSATIONS_INDEX_SESSION_METHOD, {**_SESSION, "messages": "nope"}),
        (CONVERSATIONS_INDEX_SESSION_METHOD,
         {**_SESSION, "messages": [_message(i, "x") for i in range(501)]}),
        (CONVERSATIONS_INDEX_SESSION_METHOD,
         {**_SESSION, "messages": [_message(0, "x" * 2001)]}),
        (CONVERSATIONS_INDEX_SESSION_METHOD,
         {**_SESSION, "messages": [_message(0, "x", role="system")]}),
        (CONVERSATIONS_INDEX_SESSION_METHOD,
         {**_SESSION, "messages": [_message(0, "a"), _message(0, "b")]}),
        (CONVERSATIONS_INDEX_SESSION_METHOD,
         {**_SESSION, "messages": [{"message_id": "m", "role": "user"}]}),
        (CONVERSATIONS_PURGE_METHOD, {}),
        (CONVERSATIONS_PURGE_METHOD, {"all": "true"}),
        (CONVERSATIONS_PURGE_METHOD, {"all": True, "session_ids": []}),
        (CONVERSATIONS_PURGE_METHOD, {"session_ids": ["s"] * 501}),
        (CONVERSATIONS_PURGE_METHOD, {"session_ids": [""]}),
        (CONVERSATIONS_SEARCH_METHOD, {"query": "", "project_id": "p"}),
        (CONVERSATIONS_SEARCH_METHOD, {"query": "   ", "project_id": "p"}),
        (CONVERSATIONS_SEARCH_METHOD, {"query": "x" * 501, "project_id": "p"}),
        (CONVERSATIONS_SEARCH_METHOD, {"query": "x"}),
        (CONVERSATIONS_SEARCH_METHOD, {"query": "x", "project_id": "p", "limit": 11}),
        (CONVERSATIONS_SEARCH_METHOD, {"query": "x", "project_id": "p", "limit": 0}),
        (CONVERSATIONS_SEARCH_METHOD,
         {"query": "x", "project_id": "p", "exclude_session_ids": ["s"] * 51}),
        (CONVERSATIONS_EMBED_STEP_METHOD, {"budget_seconds": 0.05}),
        (CONVERSATIONS_EMBED_STEP_METHOD, {"budget_seconds": 5.1}),
        (CONVERSATIONS_EMBED_STEP_METHOD, {"budget_seconds": True}),
        (CONVERSATIONS_EMBED_STEP_METHOD, {"batch": 65}),
        (CONVERSATIONS_INDEX_STATE_METHOD, None),
    ],
)
def test_invalid_params_are_rejected(method: str, params: dict[str, Any] | None) -> None:
    payload = _params(**params) if params is not None else ["not", "an", "object"]

    error = _run(method, payload).response["error"]

    assert error["code"] == -32602
    if params is not None:
        assert error["message"] == f"{method} invalid params" and error["data"]["detail"]


def test_index_state_search_purge_round_trip(tmp_path: Path) -> None:
    container = _enabled(tmp_path)

    assert _index(container, "s1", ["we chose postgres", "   ", "sounds good"]) == {
        "ok": True, "indexed": 2, "api_version": API_VERSION}
    _index(container, "s2", ["postgres again"], project_id="p2")

    state = _run(CONVERSATIONS_INDEX_STATE_METHOD, _params(), container=container)
    result = state.response["result"]
    assert result["sessions"] == [{"session_id": "s1", "fingerprint": "fp-s1"},
                                  {"session_id": "s2", "fingerprint": "fp-s2"}]
    assert (result["count"], result["message_count"], result["vector_count"]) == (2, 3, 0)

    search = _run(CONVERSATIONS_SEARCH_METHOD, _params(query="postgres", project_id="p1"),
                  container=container).response["result"]
    assert search["mode"] == "lexical"
    assert [hit["session_id"] for hit in search["hits"]] == ["s1"]

    purge = _run(CONVERSATIONS_PURGE_METHOD, _params(session_ids=["s1"]),
                 container=container).response["result"]
    assert (purge["ok"], purge["removed"]) == (True, 1)
    purge_all = _run(CONVERSATIONS_PURGE_METHOD, _params(all=True),
                     container=container).response["result"]
    assert (purge_all["ok"], purge_all["removed"]) == (True, 1)


def test_full_index_refuses_new_sessions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store_module, "MAX_SESSIONS", 1)
    container = _enabled(tmp_path)
    _index(container, "s1", ["one"])

    result = _index(container, "s2", ["two"])

    assert (result["ok"], result["reason"]) == (False, "index_full")


def test_hybrid_search_and_embed_step_use_the_live_embedder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    container = _enabled(tmp_path)
    _index(container, "s1", ["car trouble"])
    _index(container, "s2", ["lunch plans"])
    provider = SynonymProvider()
    monkeypatch.setattr(semantic_runtime, "current_embedder", lambda: handle(provider))

    step = _run(CONVERSATIONS_EMBED_STEP_METHOD, _params(budget_seconds=1.0, batch=4),
                container=container).response["result"]
    assert (step["ok"], step["embedded"], step["remaining"]) == (True, 2, 0)

    search = _run(CONVERSATIONS_SEARCH_METHOD, _params(query="automobile", project_id="p1"),
                  container=container).response["result"]
    assert search["mode"] == "hybrid"
    assert [hit["session_id"] for hit in search["hits"]] == ["s1"]


def test_embed_step_with_the_embedder_off(tmp_path: Path) -> None:
    container = _enabled(tmp_path)
    _index(container, "s1", ["one", "two"])

    step = _run(CONVERSATIONS_EMBED_STEP_METHOD, _params(), container=container)

    result = step.response["result"]
    assert (result["embedded"], result["remaining"], result["reason"]) == (0, 2, "embedder_off")


def test_store_faults_are_index_unavailable_results(tmp_path: Path) -> None:
    container = _enabled(tmp_path)
    _index(container, "s1", ["one"])
    store = runtime.current_store()
    assert store is not None
    store._connection.close()

    result = _run(CONVERSATIONS_INDEX_STATE_METHOD, _params(),
                  container=container).response["result"]

    assert (result["ok"], result["reason"]) == (False, "index_unavailable")


def test_logs_never_carry_query_or_text(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    container = _enabled(tmp_path)
    _index(container, "s1", ["secret banana message"])
    store = runtime.current_store()
    assert store is not None
    store._connection.close()

    with caplog.at_level(logging.DEBUG):
        _run(CONVERSATIONS_SEARCH_METHOD, _params(query="secret banana", project_id="p1"),
             container=container)

    assert "banana" not in caplog.text
