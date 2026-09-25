from __future__ import annotations

import builtins
import os
from typing import Any

from sidecar.ai.engines import ollama_model_info
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


_BLOB_NAME = "sha256-" + "0" * 64
# Another machine or a device, as Windows spells it. A stat or open of one
# connects to the host it names and sends that host the user's credentials.
_WINDOWS_NETWORK_PATHS = (
    "\\\\attacker.example\\share\\" + _BLOB_NAME,
    "//attacker.example/share/" + _BLOB_NAME,
    "\\\\?\\UNC\\attacker.example\\share\\" + _BLOB_NAME,
    "\\\\.\\pipe\\" + _BLOB_NAME,
    "\\\\?\\C:\\ollama\\blobs\\" + _BLOB_NAME,
    "\\ollama\\blobs\\" + _BLOB_NAME,
)


def _guard_blob_fs(monkeypatch, allowed_root) -> list[str]:
    """Record every path the resolver stats or opens.

    Only paths under ``allowed_root`` reach the real filesystem: a real call on a
    network path would contact its host.
    """
    touched: list[str] = []
    allowed = str(allowed_root)
    real_isfile = os.path.isfile

    def _isfile(candidate: Any) -> bool:
        touched.append(str(candidate))
        return str(candidate).startswith(allowed) and real_isfile(candidate)

    def _open(candidate: Any, *args: Any, **kwargs: Any) -> Any:
        touched.append(str(candidate))
        if not str(candidate).startswith(allowed):
            raise OSError("outside the test directory")
        return builtins.open(candidate, *args, **kwargs)

    monkeypatch.setattr(os.path, "isfile", _isfile)
    monkeypatch.setattr(ollama_model_info, "open", _open, raising=False)
    return touched


def test_resolve_ollama_model_blob_reads_only_the_from_lines_ollama_writes(
    monkeypatch, tmp_path
) -> None:
    # Ollama writes its own FROM lines first; the template, system prompt and
    # license after them are text the model's publisher wrote.
    blob = tmp_path / "model-blob"
    decoy = tmp_path / "decoy-blob"
    blob.write_bytes(b"GGUFmodel")
    decoy.write_bytes(b"GGUFdecoy")
    share = "//attacker.example/share/" + _BLOB_NAME
    modelfile = "\n".join([
        '# Modelfile generated by "ollama show"',
        "# To build a new Modelfile based on this, replace FROM with:",
        "# FROM publisher/model:latest",
        "",
        f"FROM {blob}",
        'TEMPLATE """{{ .Prompt }}',
        f"FROM {share}",
        '"""',
        'SYSTEM "Answer briefly.',
        f"FROM {decoy}",
        '"',
        'PARAMETER stop "<|end|>"',
        f'LICENSE """FROM {share}',
        f'FROM {decoy}"""',
    ])
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        lambda **_kwargs: {"modelfile": modelfile},
    )
    touched = _guard_blob_fs(monkeypatch, tmp_path)

    result = resolve_ollama_model_blob(
        host="http://127.0.0.1:11434",
        model_id="publisher/model:latest",
    )

    assert (result["blob_path"], result["mmproj_path"]) == (str(blob), "")
    assert touched == [str(blob), str(blob)]


def test_resolve_ollama_model_blob_finds_the_projector_after_an_adapter(
    monkeypatch, tmp_path
) -> None:
    blob = tmp_path / "model-blob"
    adapter = tmp_path / "adapter-blob"
    mmproj = tmp_path / "projector-blob"
    for item in (blob, adapter, mmproj):
        item.write_bytes(b"GGUF")
    modelfile = "\n".join([
        f"FROM {blob}",
        f"ADAPTER {adapter}",
        f"FROM {mmproj}",
        "TEMPLATE {{ .Prompt }}",
    ])
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        lambda **_kwargs: {"modelfile": modelfile},
    )

    result = resolve_ollama_model_blob(host="http://127.0.0.1:11434", model_id="vision:latest")

    assert (result["blob_path"], result["mmproj_path"]) == (str(blob), str(mmproj))


def test_resolve_ollama_model_blob_never_touches_a_network_path_on_windows(
    monkeypatch, tmp_path
) -> None:
    touched = _guard_blob_fs(monkeypatch, tmp_path)
    for candidate in _WINDOWS_NETWORK_PATHS:
        monkeypatch.setattr(
            "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
            lambda candidate=candidate, **_kwargs: {"modelfile": f"FROM {candidate}"},
        )
        result = resolve_ollama_model_blob(
            host="http://127.0.0.1:11434",
            model_id="model:latest",
            platform="win32",
        )
        assert result["reason"] == "no_local_blob", candidate
    assert touched == []

    # A drive path, a share mapped to a drive letter included, is still read.
    drive_blob = "Z:\\ollama\\blobs\\" + _BLOB_NAME
    monkeypatch.setattr(
        "sidecar.ai.engines.ollama_model_info.fetch_ollama_model_info",
        lambda **_kwargs: {"modelfile": f"FROM {drive_blob}"},
    )
    resolve_ollama_model_blob(
        host="http://127.0.0.1:11434",
        model_id="model:latest",
        platform="win32",
    )
    assert touched == [drive_blob]
