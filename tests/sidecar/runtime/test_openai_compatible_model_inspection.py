"""Model inspection for an OpenAI-compatible server (the managed llama-server).

Tune's context preflight needs the served model's trained window. Ollama answers
through ``/api/show``; llama-server reports it as ``meta.n_ctx_train`` on
``/v1/models``. Without it a local GGUF (Bonsai 2) had no native window, so every
request above 32768 was refused as ``hardware_profile_unavailable`` (2026-09-18).
The engine's own native window deliberately stays unset (served ``n_ctx`` wins,
see test_openai_compatible.py); this is inspection-only.
"""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.engines import catalog
from sidecar.runtime import capabilities
from sidecar.runtime.capabilities import models_list_result

ALIAS = "ternary-bonsai-2-27b-pq2_0"


def _serve(monkeypatch: pytest.MonkeyPatch, entries: list[dict[str, Any]]) -> None:
    monkeypatch.setattr(catalog, "_get_provider_json", lambda **_kwargs: {"data": entries})
    monkeypatch.setattr(catalog, "probe_server_modalities", lambda **_kwargs: None)


def _inspect(model_id: str) -> dict[str, Any]:
    result = models_list_result(
        {
            "engine_type": "openai-compatible",
            "inspect_model_id": model_id,
            "_runtime_config": RuntimeConfig(),
        },
        models_for_engine=lambda _engine: [],
    )
    return result["model_inspection"]


def test_discovery_records_each_models_trained_window(monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, [
        {"id": ALIAS, "meta": {"n_ctx_train": 262144}},
        {"id": "no-meta"},
        {"id": "bad", "meta": {"n_ctx_train": True}},
        {"id": "zero", "meta": {"n_ctx_train": 0}},
    ])

    result = catalog.discover_openai_compatible_models()

    assert result.trained_context_lengths == {ALIAS: 262144}


def test_inspection_reports_the_served_models_trained_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _serve(monkeypatch, [{"id": ALIAS, "meta": {"n_ctx_train": 262144}}])

    assert _inspect(ALIAS) == {
        "model_id": ALIAS,
        "available": True,
        "native_context_length": 262144,
        "reason": "",
    }


def test_inspection_of_a_model_the_server_does_not_hold(monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, [{"id": ALIAS, "meta": {"n_ctx_train": 262144}}])

    inspection = _inspect("qwen3.8:27b")

    assert inspection["available"] is False
    assert inspection["native_context_length"] is None
    assert inspection["reason"] == "model_not_found"


def test_inspection_when_the_server_is_down(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        capabilities,
        "discover_openai_compatible_models",
        lambda **_kwargs: catalog.ModelCatalogResult(models=[], available=False, reason="down"),
    )

    inspection = _inspect(ALIAS)

    assert inspection["available"] is False
    assert inspection["reason"] == "server_unavailable"
