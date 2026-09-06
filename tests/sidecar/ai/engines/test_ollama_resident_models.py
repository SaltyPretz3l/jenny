"""Tests for OllamaEngine.list_resident_models (Wave 4 model-fit self-catalog)
and a FIM-regression guard that list_loaded_models keeps its narrow
name/expires_at shape (the completion menu depends on it).
"""

from __future__ import annotations

import pytest

from sidecar.ai.engines.ollama import _MAX_RESIDENT_MODELS, OllamaEngine


def _engine_with_ps_payload(monkeypatch: pytest.MonkeyPatch, payload: dict) -> OllamaEngine:
    engine = OllamaEngine()
    monkeypatch.setattr(engine, "_get", lambda endpoint, timeout=None: payload)
    return engine


def test_list_resident_models_coerces_full_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = {
        "models": [
            {
                "name": "llama3.1:8b",
                "digest": "sha256:abc123",
                "size": 4_900_000_000,
                "size_vram": 4_900_000_000,
                "context_length": 8192,
                "expires_at": "2026-09-01T00:05:00Z",
                "details": {
                    "parameter_size": "8.0B",
                    "quantization_level": "Q4_0",
                },
            }
        ]
    }
    engine = _engine_with_ps_payload(monkeypatch, payload)
    models = engine.list_resident_models()
    assert models == [
        {
            "name": "llama3.1:8b",
            "digest": "sha256:abc123",
            "size": 4_900_000_000,
            "size_vram": 4_900_000_000,
            "context_length": 8192,
            "parameter_size": "8.0B",
            "quantization_level": "Q4_0",
            "expires_at": "2026-09-01T00:05:00Z",
        }
    ]


def test_list_resident_models_defensive_coercion_rejects_bools_and_negatives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "models": [
            {
                "name": "broken-model",
                "digest": True,  # not a string -> ""
                "size": True,  # bool rejected -> 0
                "size_vram": -5,  # negative -> 0
                "context_length": -1,  # negative -> None
                "details": {"parameter_size": 8, "quantization_level": None},
            }
        ]
    }
    engine = _engine_with_ps_payload(monkeypatch, payload)
    models = engine.list_resident_models()
    assert len(models) == 1
    entry = models[0]
    assert entry["name"] == "broken-model"
    assert entry["digest"] == ""
    assert entry["size"] == 0
    assert entry["size_vram"] == 0
    assert entry["context_length"] is None
    assert entry["parameter_size"] == ""
    assert entry["quantization_level"] == ""


def test_list_resident_models_truncates_long_strings(monkeypatch: pytest.MonkeyPatch) -> None:
    long_digest = "d" * 500
    long_param = "p" * 100
    payload = {
        "models": [
            {
                "name": "big-strings",
                "digest": long_digest,
                "details": {"parameter_size": long_param, "quantization_level": long_param},
            }
        ]
    }
    engine = _engine_with_ps_payload(monkeypatch, payload)
    entry = engine.list_resident_models()[0]
    assert len(entry["digest"]) == 128
    assert len(entry["parameter_size"]) == 32
    assert len(entry["quantization_level"]) == 32


def test_list_resident_models_skips_entries_without_a_name(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = {"models": [{"digest": "abc"}, {"name": "", "digest": "def"}, "not-a-dict"]}
    engine = _engine_with_ps_payload(monkeypatch, payload)
    assert engine.list_resident_models() == []


def test_list_resident_models_empty_or_missing_models_key(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = _engine_with_ps_payload(monkeypatch, {})
    assert engine.list_resident_models() == []


def test_list_resident_models_raises_on_connection_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = OllamaEngine()

    def _explode(endpoint, timeout=None):
        raise ConnectionError("no daemon")

    monkeypatch.setattr(engine, "_get", _explode)
    with pytest.raises(ConnectionError):
        engine.list_resident_models()


def test_list_resident_models_caps_at_max_resident_models(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = {
        "models": [
            {"name": f"model-{i}:latest", "digest": f"sha256:{i}"}
            for i in range(_MAX_RESIDENT_MODELS + 25)
        ]
    }
    engine = _engine_with_ps_payload(monkeypatch, payload)
    models = engine.list_resident_models()
    assert len(models) == _MAX_RESIDENT_MODELS
    assert [m["name"] for m in models] == [
        f"model-{i}:latest" for i in range(_MAX_RESIDENT_MODELS)
    ]


def test_list_loaded_models_fim_regression_keeps_narrow_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """list_loaded_models must keep returning ONLY name/expires_at — the FIM
    completion menu's ●loaded indicator depends on this narrow shape and must
    not be widened by the models.resident addition."""
    payload = {
        "models": [
            {
                "name": "qwen2.5-coder:7b",
                "digest": "sha256:zzz",
                "size": 123,
                "size_vram": 123,
                "expires_at": "2026-09-01T00:05:00Z",
                "details": {"parameter_size": "7B", "quantization_level": "Q4_0"},
            }
        ]
    }
    engine = _engine_with_ps_payload(monkeypatch, payload)
    models = engine.list_loaded_models()
    assert models == [{"name": "qwen2.5-coder:7b", "expires_at": "2026-09-01T00:05:00Z"}]
    assert list(models[0].keys()) == ["name", "expires_at"]
