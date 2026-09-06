from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.memory.store import MemoryStore
from sidecar.protocol import API_VERSION, MEMORY_SAVE_METHOD, MEMORY_UPDATE_METHOD
from sidecar.runtime.memory import save_memory_candidate, update_memory
from sidecar.runtime.request_dispatch_memory import (
    INVALID_PARAMS_CODE,
    process_memory_method,
)


@pytest.fixture()
def memory_store(tmp_path: Path) -> MemoryStore:
    store = MemoryStore(tmp_path / "memory.db")
    yield store
    store.close()


def _saved_memory_id(store: MemoryStore) -> int:
    memory, _ = store.save_memory(
        session_id="session-1",
        title="Preference: tea",
        lesson_text="The user prefers tea.",
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt="I prefer tea",
    )
    return memory.id


def _dispatch(method: str, params: dict[str, object], store: MemoryStore):
    return process_memory_method(
        method=method,
        message_id=17,
        params={"accept_version": API_VERSION, **params},
        initialized=True,
        brain_container=SimpleNamespace(
            stack=SimpleNamespace(memory_store=store)
        ),
        logger=logging.getLogger("test.memory_text_validation"),
    )


@pytest.mark.parametrize("field", ["title", "lesson_text"])
@pytest.mark.parametrize("invalid_value", [None, 42], ids=["null", "integer"])
def test_save_rejects_non_string_text_fields_directly(
    memory_store: MemoryStore,
    field: str,
    invalid_value: object,
) -> None:
    candidate: dict[str, object] = {
        "title": "Preference: tea",
        "lesson_text": "The user prefers tea.",
        "lesson_kind": "preference",
        "confidence": 0.9,
        "source_excerpt": "I prefer tea",
    }
    candidate[field] = invalid_value

    with pytest.raises(ValueError, match=rf"candidate\.{field} must be a string"):
        save_memory_candidate(
            session_id="session-1",
            candidate=candidate,
            memory_store=memory_store,
        )


@pytest.mark.parametrize("field", ["title", "lesson_text"])
@pytest.mark.parametrize("invalid_value", [None, 42], ids=["null", "integer"])
def test_save_rejects_non_string_text_fields_through_dispatch(
    memory_store: MemoryStore,
    field: str,
    invalid_value: object,
) -> None:
    candidate: dict[str, object] = {
        "title": "Preference: tea",
        "lesson_text": "The user prefers tea.",
        "lesson_kind": "preference",
        "confidence": 0.9,
        "source_excerpt": "I prefer tea",
    }
    candidate[field] = invalid_value

    outcome = _dispatch(
        MEMORY_SAVE_METHOD,
        {"session_id": "session-1", "candidate": candidate},
        memory_store,
    )

    assert outcome is not None
    error = outcome.response["error"]
    assert error["code"] == INVALID_PARAMS_CODE
    assert error["data"]["detail"] == f"candidate.{field} must be a string"


@pytest.mark.parametrize("field", ["title", "lesson_text"])
@pytest.mark.parametrize("invalid_value", [None, 42], ids=["null", "integer"])
def test_update_rejects_non_string_text_fields_directly(
    memory_store: MemoryStore,
    field: str,
    invalid_value: object,
) -> None:
    memory_id = _saved_memory_id(memory_store)
    patch: dict[str, object] = {
        "title": "Preference: coffee",
        "lesson_text": "The user prefers coffee.",
    }
    patch[field] = invalid_value

    with pytest.raises(ValueError, match=rf"patch\.{field} must be a string"):
        update_memory(memory_id=memory_id, patch=patch, memory_store=memory_store)


@pytest.mark.parametrize("field", ["title", "lesson_text"])
@pytest.mark.parametrize("invalid_value", [None, 42], ids=["null", "integer"])
def test_update_rejects_non_string_text_fields_through_dispatch(
    memory_store: MemoryStore,
    field: str,
    invalid_value: object,
) -> None:
    memory_id = _saved_memory_id(memory_store)
    patch: dict[str, object] = {
        "title": "Preference: coffee",
        "lesson_text": "The user prefers coffee.",
    }
    patch[field] = invalid_value

    outcome = _dispatch(
        MEMORY_UPDATE_METHOD,
        {"memory_id": memory_id, "patch": patch},
        memory_store,
    )

    assert outcome is not None
    error = outcome.response["error"]
    assert error["code"] == INVALID_PARAMS_CODE
    assert error["data"]["detail"] == f"patch.{field} must be a string"
