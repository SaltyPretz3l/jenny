from __future__ import annotations

from typing import Any

from sidecar.ai.engines.ollama_model_info import (
    fetch_ollama_model_info,
    inspect_ollama_model,
    resolve_ollama_model_blob,
)
from sidecar.ai.engines.provider_http import ProviderHttpError


def test_fetch_ollama_model_info_uses_fixed_show_path_and_closes(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    class FakeProviderHttpService:
        def __init__(self, **kwargs: Any) -> None:
            captured["init"] = kwargs

        def post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
            captured["path"] = path
            captured["payload"] = payload
            return {"model_info": {"qwen35.context_length": 262_144}}

        def close(self) -> None:
            captured["closed"] = True

    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.ProviderHttpService",
        FakeProviderHttpService,
    )

    result = fetch_ollama_model_info(
        host="http://127.0.0.1:11434",
        model_id="ornith15:9b-q6-256k",
    )

    assert result["model_info"]["qwen35.context_length"] == 262_144
    assert captured["path"] == "/api/show"
    assert captured["payload"] == {"name": "ornith15:9b-q6-256k"}
    assert captured["closed"] is True


def test_inspect_ollama_model_returns_only_bounded_native_context(monkeypatch) -> None:
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        lambda **_kwargs: {
            "model_info": {"qwen35.context_length": 262_144},
            "template": "sensitive provider payload",
        },
    )

    result = inspect_ollama_model(
        host="http://127.0.0.1:11434",
        model_id="ornith15:9b-q6-256k",
    )

    assert result == {
        "model_id": "ornith15:9b-q6-256k",
        "available": True,
        "native_context_length": 262_144,
        "reason": "",
    }
    assert "sensitive provider payload" not in str(result)


def test_inspect_ollama_model_handles_missing_context_and_invalid_ids(monkeypatch) -> None:
    calls = 0

    def _fetch(**_kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return {"model_info": {"architecture": "qwen35"}}

    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        _fetch,
    )

    assert inspect_ollama_model(host="http://127.0.0.1:11434", model_id="model:latest") == {
        "model_id": "model:latest",
        "available": False,
        "native_context_length": None,
        "reason": "native_context_unavailable",
    }
    assert inspect_ollama_model(host="http://127.0.0.1:11434", model_id=" ") == {
        "model_id": "",
        "available": False,
        "native_context_length": None,
        "reason": "invalid_model_id",
    }
    assert calls == 1


def test_inspect_ollama_model_maps_provider_failures_without_leaking_body(monkeypatch) -> None:
    def _missing(**_kwargs: Any) -> dict[str, Any]:
        raise ProviderHttpError(
            provider="ollama",
            status_code=404,
            code="missing",
            message="secret provider detail",
            retryable=False,
            body={"secret": "do-not-return"},
        )

    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        _missing,
    )

    result = inspect_ollama_model(
        host="http://127.0.0.1:11434",
        model_id="missing:latest",
    )

    assert result == {
        "model_id": "missing:latest",
        "available": False,
        "native_context_length": None,
        "reason": "model_not_found",
    }
    assert "secret" not in str(result)


def test_inspect_ollama_model_contains_unexpected_failures(monkeypatch) -> None:
    def _fail(**_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("unexpected sensitive failure")

    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        _fail,
    )

    assert inspect_ollama_model(
        host="http://127.0.0.1:11434",
        model_id="model:latest",
    )["reason"] == "provider_unavailable"


def test_resolve_ollama_model_blob_returns_first_two_gguf_files(monkeypatch, tmp_path) -> None:
    blob = tmp_path / "model-blob"
    mmproj = tmp_path / "vision-projector"
    blob.write_bytes(b"GGUFmodel")
    mmproj.write_bytes(b"GGUFprojector")
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        lambda **_kwargs: {"modelfile": f"FROM {blob}\nfrom {mmproj}"},
    )

    assert resolve_ollama_model_blob(
        host="http://127.0.0.1:11434",
        model_id="gemma4:12b",
    ) == {
        "model_id": "gemma4:12b",
        "available": True,
        "blob_path": str(blob),
        "mmproj_path": str(mmproj),
        "reason": "",
    }


def test_resolve_ollama_model_blob_skips_unusable_paths(monkeypatch, tmp_path) -> None:
    missing = tmp_path / "missing-blob"
    wrong_header = tmp_path / "not-gguf"
    wrong_header.write_bytes(b"NOPE")
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        lambda **_kwargs: {
            "modelfile": (
                f"FROM relative.gguf\nFROM {missing}\nFROM {wrong_header}"
            )
        },
    )

    assert resolve_ollama_model_blob(
        host="http://127.0.0.1:11434",
        model_id="gemma4:12b",
    ) == {
        "model_id": "gemma4:12b",
        "available": False,
        "blob_path": "",
        "mmproj_path": "",
        "reason": "no_local_blob",
    }


def test_resolve_ollama_model_blob_accepts_quoted_path(monkeypatch, tmp_path) -> None:
    blob = tmp_path / "quoted model blob"
    blob.write_bytes(b"GGUFmodel")
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        lambda **_kwargs: {"modelfile": f'FROM "{blob}"'},
    )

    result = resolve_ollama_model_blob(
        host="http://127.0.0.1:11434",
        model_id="model:latest",
    )

    assert result["available"] is True
    assert result["blob_path"] == str(blob)


def test_resolve_ollama_model_blob_maps_not_found(monkeypatch) -> None:
    def _missing(**_kwargs: Any) -> dict[str, Any]:
        raise ProviderHttpError(
            provider="ollama",
            status_code=404,
            code="missing",
            message="secret provider detail",
            retryable=False,
            body={"secret": "do-not-return"},
        )

    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        _missing,
    )

    assert resolve_ollama_model_blob(
        host="http://127.0.0.1:11434",
        model_id="missing:latest",
    ) == {
        "model_id": "missing:latest",
        "available": False,
        "blob_path": "",
        "mmproj_path": "",
        "reason": "model_not_found",
    }


def test_resolve_ollama_model_blob_does_not_expose_modelfile(monkeypatch, tmp_path) -> None:
    blob = tmp_path / "model-blob"
    blob.write_bytes(b"GGUFmodel")
    sensitive_modelfile = f"FROM {blob}\nPARAMETER secret value"
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        lambda **_kwargs: {
            "modelfile": sensitive_modelfile,
            "template": "sensitive template",
            "parameters": "sensitive parameters",
        },
    )

    result = resolve_ollama_model_blob(
        host="http://127.0.0.1:11434",
        model_id="model:latest",
    )

    assert set(result) == {"model_id", "available", "blob_path", "mmproj_path", "reason"}
    assert sensitive_modelfile not in str(result)
    assert "sensitive template" not in str(result)
    assert "sensitive parameters" not in str(result)
