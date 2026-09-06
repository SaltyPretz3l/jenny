from __future__ import annotations

from types import SimpleNamespace

from sidecar.runtime.local_engine.snapshot import build_local_runtime_payload


def test_failed_ollama_load_does_not_report_named_model_as_loaded() -> None:
    payload = build_local_runtime_payload(
        runtime_config=SimpleNamespace(
            engine_type="ollama",
            model="ornith:9b",
            context_length=None,
            resolved_app_profile_family=None,
        ),
        engine=SimpleNamespace(
            model_name="ornith:9b",
            _ready=False,
            capabilities={"text": True},
            supports_tool_calling=False,
        ),
    )

    assert payload["model"] == {"id": "ornith:9b", "loaded": False}
    assert payload["readiness"] == {
        "status": "idle",
        "ready": False,
        "model_loaded": False,
    }
