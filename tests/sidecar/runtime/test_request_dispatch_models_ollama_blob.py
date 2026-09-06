from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.request_dispatch as rd
from sidecar.protocol import API_VERSION, MODELS_OLLAMA_BLOB_METHOD

LOGGER = logging.getLogger("test.request_dispatch_models_ollama_blob")


def _null_writer(_message: dict[str, Any]) -> None:
    pass


def _null_reader() -> dict[str, Any]:
    return {}


def _make_minimal_brain() -> SimpleNamespace:
    config = SimpleNamespace(
        tools_workspace_root=None,
        agent_workspace_root=None,
        tools_enabled=True,
        feature_flags={},
    )
    return SimpleNamespace(
        stack=SimpleNamespace(
            config=config,
            engine=SimpleNamespace(model_name="dummy-model"),
            tool_observations=None,
        )
    )


def _patch_sub_dispatchers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rd, "process_background_method", lambda *args, **kwargs: None)
    monkeypatch.setattr(rd, "process_memory_method", lambda *args, **kwargs: None)
    monkeypatch.setattr(rd, "process_harness_method", lambda *args, **kwargs: None)
    monkeypatch.setattr(rd, "process_suggestions_method", lambda *args, **kwargs: None)


def test_models_ollama_blob_returns_resolver_payload_and_passes_model_id(monkeypatch) -> None:
    _patch_sub_dispatchers(monkeypatch)
    engine = SimpleNamespace(host="http://127.0.0.1:22434")
    monkeypatch.setattr(rd, "_resolve_resident_models_engine", lambda _brain: engine)
    payload = {
        "model_id": "gemma4:12b",
        "available": True,
        "blob_path": "G:/Ollama/blobs/model",
        "mmproj_path": "G:/Ollama/blobs/mmproj",
        "reason": "",
    }
    captured: dict[str, Any] = {}

    def _resolve(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return payload

    monkeypatch.setattr(rd, "resolve_ollama_model_blob", _resolve)

    outcome = rd.process_message(
        {
            "method": MODELS_OLLAMA_BLOB_METHOD,
            "id": 41,
            "params": {"accept_version": API_VERSION, "model_id": "gemma4:12b"},
        },
        True,
        brain_container=_make_minimal_brain(),  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    assert outcome.response["result"] == {**payload, "api_version": API_VERSION}
    assert captured == {"host": "http://127.0.0.1:22434", "model_id": "gemma4:12b"}


def test_models_ollama_blob_returns_provider_unavailable_without_engine(monkeypatch) -> None:
    _patch_sub_dispatchers(monkeypatch)
    monkeypatch.setattr(rd, "_resolve_resident_models_engine", lambda _brain: None)

    outcome = rd.process_message(
        {
            "method": MODELS_OLLAMA_BLOB_METHOD,
            "id": 42,
            "params": {"accept_version": API_VERSION, "model_id": "gemma4:12b"},
        },
        True,
        brain_container=_make_minimal_brain(),  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    assert outcome.response["result"] == {
        "api_version": API_VERSION,
        "model_id": "gemma4:12b",
        "available": False,
        "blob_path": "",
        "mmproj_path": "",
        "reason": "provider_unavailable",
    }
