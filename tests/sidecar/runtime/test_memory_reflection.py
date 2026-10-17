"""memory.reflect: the background reflection runner (row 58 W2, slice R)."""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar import server
from sidecar.ai.memory.contracts import build_text_digest
from sidecar.ai.memory.reflection_checks import REFLECTION_SCHEMA
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.protocol import API_VERSION, MEMORY_REFLECT_METHOD
from sidecar.runtime.memory_reflection import (
    ReflectionOutputInvalid,
    parse_reflect_request,
    reflect_memories,
)
from tests.sidecar.runtime.test_auxiliary_cancellation import _assert_cancelled_response, _Harness

LOG = logging.getLogger("test.memory_reflection")
PROJECT = "project_alpha"
CHAT = "sess_1_abc"
FP = "sha256:" + hashlib.sha256(b"window").hexdigest()


def _params(**overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "accept_version": API_VERSION,
        "request_id": "reflect_1",
        "session_id": CHAT,
        "project_id": PROJECT,
        "messages": [
            {"id": "m-1", "role": "user", "content": "I prefer tabs over spaces in Python."},
            {"id": "m-2", "role": "assistant", "content": "Noted. You also run PostgreSQL."},
            {"id": "m-3", "role": "user", "content": "My sister Ana lives in Lisbon."},
        ],
        "new_user_ids": ["m-1", "m-3"],
        "window_fingerprint": FP,
    }
    params.update(overrides)
    return params


MODEL_OUTPUT = json.dumps({
    "memories": [
        {"text": "Prefers tabs over spaces in Python.", "kind": "preference", "from": 0},
        {"text": "Runs PostgreSQL in production.", "kind": "fact", "from": 0},
        {"text": "Sister Ana lives in Lisbon.", "kind": "person", "from": 1},
    ],
    "recap": "Chat about \u200btabs   and family.",
})


class _Engine:
    def __init__(self, output: str = MODEL_OUTPUT) -> None:
        self.output = output
        self.calls: list[dict[str, Any]] = []

    def generate(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        return self.output


@pytest.fixture
def store(tmp_path: Path) -> Iterator[MemoryStore]:
    memory_store = MemoryStore(tmp_path / "memory.db")
    try:
        yield memory_store
    finally:
        memory_store.close()


def _stack(store: MemoryStore, engine: Any) -> SimpleNamespace:
    return SimpleNamespace(
        engine=engine,
        config=SimpleNamespace(engine_type="ollama", model="qwen-local", feature_flags={}),
        memory_service=MemoryService(store),
    )


def _write_counts(store: MemoryStore) -> tuple[int, ...]:
    return tuple(
        int(store._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        for table in ("memories", "memory_operations", "pending_memory_candidates",
                      "memory_reflection_cursor", "memory_suppressions")
    )


def test_reflect_returns_checked_proposals_and_a_scrubbed_recap_without_writes(
    store: MemoryStore,
) -> None:
    engine = _Engine()
    stack = _stack(store, engine)
    handle = SimpleNamespace(cancelled=False, raise_if_cancelled=lambda: None)
    before = _write_counts(store)

    result = reflect_memories(
        stack=stack, backend=stack.memory_service, request=parse_reflect_request(_params()),
        logger=LOG, cancel_handle=handle,
    )

    assert result["proposals"] == [
        {"text": "Prefers tabs over spaces in Python.", "kind": "preference",
         "source_message_id": "m-1", "scope": "project",
         "digest": build_text_digest("Prefers tabs over spaces in Python.")},
        {"text": "Sister Ana lives in Lisbon.", "kind": "person", "source_message_id": "m-3", "scope": "project",
         "digest": build_text_digest("Sister Ana lives in Lisbon.")},
    ]
    assert result["recap"] == "Chat about tabs and family."
    assert result["window_fingerprint"] == FP
    assert result["dropped"] == {"schema": 0, "attribution": 1, "kind": 0, "length": 0,
                                 "suppressed": 0, "duplicate": 0, "unsafe": 0}
    assert result["model"] == "qwen-local"
    assert isinstance(result["elapsed_ms"], int)
    assert _write_counts(store) == before
    call = engine.calls[0]
    assert call["cancel_handle"] is handle
    assert call["reasoning_effort"] == "low"
    assert call["max_tokens"] == 700
    assert call["response_format"].type == "json_object"
    assert call["response_format"].json_schema == REFLECTION_SCHEMA
    assert "NEW USER MESSAGE 1: My sister Ana lives in Lisbon." in call["prompt"]
    assert "m-3" not in call["prompt"] and PROJECT not in call["prompt"]


def test_a_parse_failure_fails_the_run_so_nothing_is_applied(
    monkeypatch: pytest.MonkeyPatch, store: MemoryStore,
) -> None:
    # An empty result would let Electron apply it: the cursor would skip
    # messages nothing read and the chat's recap would be replaced.
    stack = _stack(store, _Engine("I could not decide."))
    before = _write_counts(store)
    with pytest.raises(ReflectionOutputInvalid):
        reflect_memories(
            stack=stack, backend=stack.memory_service, request=parse_reflect_request(_params()),
            logger=LOG,
        )

    monkeypatch.setattr(server, "_BRAIN_CONTAINER", SimpleNamespace(stack=stack))
    response = server.process_message(_message(85), initialized=True).response
    assert response is not None
    assert response["error"]["code"] == -32000
    assert response["error"]["data"]["reason"] == "reflection_output_invalid"
    assert _write_counts(store) == before


def test_suppressed_and_existing_rows_are_dropped(store: MemoryStore) -> None:
    store.remember(operation_id="seed-1", project_id="project_general",
                   text="Sister Ana lives in Lisbon.", kind="person", origin="user",
                   session_id="s0")
    saved = store.remember(operation_id="seed-2", project_id=PROJECT,
                           text="Prefers tabs over spaces in Python.", kind="preference",
                           origin="user", session_id="s0")
    assert saved.memory is not None
    store.forget(operation_id="seed-3", project_id=PROJECT, memory_id=saved.memory.id,
                 expected_revision=None, origin="user")
    stack = _stack(store, _Engine())

    result = reflect_memories(
        stack=stack, backend=stack.memory_service, request=parse_reflect_request(_params()),
        logger=LOG,
    )

    assert result["proposals"] == []
    assert result["dropped"]["suppressed"] == 1 and result["dropped"]["duplicate"] == 1


@pytest.mark.parametrize(
    "overrides",
    [
        {"session_id": ""},
        {"project_id": "general"},
        {"request_id": 4},
        {"window_fingerprint": ""},
        {"messages": "nope"},
        {"messages": [{"id": "m-1", "role": "system", "content": "x"}]},
        {"messages": [{"id": "m-1", "role": "user", "content": "x" * 2001}]},
        {"messages": [{"id": f"m-{i}", "role": "user", "content": "x" * 2000}
                      for i in range(7)], "new_user_ids": ["m-6"]},
        {"messages": [{"id": f"m-{i}", "role": "user", "content": "x"} for i in range(25)],
         "new_user_ids": ["m-1"]},
        {"new_user_ids": []},
        {"new_user_ids": ["m-2"]},
        {"new_user_ids": ["m-1", "m-1"]},
        {"new_user_ids": [f"m-{i}" for i in range(9)]},
    ],
)
def test_invalid_reflect_params_raise_value_error(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        parse_reflect_request(_params(**overrides))


def _message(message_id: int, **overrides: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "method": MEMORY_REFLECT_METHOD,
            "params": _params(**overrides)}


def test_reflect_dispatch_answers_a_result_and_rejects_invalid_params(
    monkeypatch: pytest.MonkeyPatch, store: MemoryStore,
) -> None:
    monkeypatch.setattr(server, "_BRAIN_CONTAINER", SimpleNamespace(stack=_stack(store, _Engine())))

    ok = server.process_message(_message(81), initialized=True).response
    bad = server.process_message(_message(82, new_user_ids=["m-2"]), initialized=True).response
    early = server.process_message(_message(83), initialized=False).response

    assert ok is not None and len(ok["result"]["proposals"]) == 2
    assert bad is not None and bad["error"]["code"] == -32602
    assert early is not None and early["error"]["code"] == -32002


def test_an_engine_failure_is_a_coded_error_not_a_crash(
    monkeypatch: pytest.MonkeyPatch, store: MemoryStore,
) -> None:
    def boom(**_kwargs: Any) -> str:
        raise RuntimeError("engine down")

    monkeypatch.setattr(server, "_BRAIN_CONTAINER", SimpleNamespace(
        stack=_stack(store, SimpleNamespace(generate=boom))))

    response = server.process_message(_message(84), initialized=True).response

    assert response is not None
    assert response["error"]["code"] == -32000
    assert response["error"]["data"]["reason"] == "reflection_inference_failed"


def test_a_cancel_answers_auxiliary_cancelled_and_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, store: MemoryStore,
) -> None:
    harness = _Harness()
    entered = threading.Event()
    seen: dict[str, Any] = {}

    def generate(**kwargs: Any) -> str:
        handle = kwargs["cancel_handle"]
        seen["handle"] = handle
        entered.set()
        handle.wait(3.0)
        handle.raise_if_cancelled()
        return MODEL_OUTPUT

    monkeypatch.setattr(server, "_BRAIN_CONTAINER", SimpleNamespace(
        stack=_stack(store, SimpleNamespace(generate=generate))))
    before = _write_counts(store)
    thread = harness.worker(_message(91, request_id="reflect_cancel"), server.process_message)
    try:
        thread.start()
        assert entered.wait(3.0)
        assert seen["handle"] is harness.mux._auxiliary_handles["reflect_cancel"]
        assert harness.deliver_cancel("reflect_cancel", message_id=92)["result"]["status"] == (
            "cancel_requested"
        )
        thread.join(timeout=3.0)
        assert not thread.is_alive()
        _assert_cancelled_response(harness.wait_for_id(91))
        assert _write_counts(store) == before
    finally:
        harness.mux.close()


def test_reflect_is_admitted_under_its_session_scoped_inference_context(
    store: MemoryStore,
) -> None:
    # Electron sends memory.reflect session-scoped; the real admission callback
    # refuses an attempt whose session differs from the inference context.
    from sidecar.runtime.inference_admission import (
        build_auxiliary_inference_admission_callback,
        inference_context_from_params,
    )
    from tests.sidecar.runtime.test_auxiliary_inference_admission import _bridge

    sent, factory = _bridge(["granted", "settled"])
    context = inference_context_from_params({"inference_context": {
        "schema_version": 1, "request_id": "reflect_1", "session_id": CHAT,
        "authority_revision": "authority_1", "engine_type": "ollama",
    }})
    admission = build_auxiliary_inference_admission_callback(
        context=context, write_message=sent.append, response_reader_factory=factory,
    )
    engine = _Engine()
    stack = _stack(store, engine)

    result = reflect_memories(
        stack=stack, backend=stack.memory_service, request=parse_reflect_request(_params()),
        logger=LOG, inference_admission=admission,
        cancel_handle=SimpleNamespace(cancelled=False, raise_if_cancelled=lambda: None),
    )

    assert len(engine.calls) == 1
    assert [frame["params"]["phase"] for frame in sent] == ["admit", "settle"]
    assert sent[0]["params"]["session_id"] == CHAT
    assert len(result["proposals"]) == 2


@pytest.mark.parametrize("session", [CHAT, "another-chat"])
def test_reflect_carries_chat_scope_and_dedupes_only_its_own_chat(
    store: MemoryStore, session: str,
) -> None:
    text = "Prefers tabs over spaces in Python."
    store.remember(operation_id="seed-chat", project_id=PROJECT, text=text, kind="preference",
                   origin="user", session_id=CHAT, scope_session_id=CHAT)
    engine = _Engine(json.dumps({"memories": [
        {"text": text, "kind": "preference", "from": 0, "scope": "chat"}
    ], "recap": ""}))
    stack = _stack(store, engine)
    result = reflect_memories(
        stack=stack, backend=stack.memory_service,
        request=parse_reflect_request(_params(session_id=session)), logger=LOG,
    )
    if session == CHAT:
        assert result["proposals"] == [] and result["dropped"]["duplicate"] == 1
    else:
        assert len(result["proposals"]) == 1 and result["proposals"][0]["scope"] == "chat"
