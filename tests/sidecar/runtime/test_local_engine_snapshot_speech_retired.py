"""Speech-block retirement (owner decision, 2026-08-24).

local_speech (STT/TTS) was removed in the lean-harness trim; the wire kept a
stub "speech" block that always reported unavailable. That dead block is now
retired end-to-end: the sidecar stops emitting it and the Electron status
normalizer stops carrying it.
"""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.runtime.local_engine import snapshot
from sidecar.runtime.local_engine.snapshot import (
    build_local_runtime_payload,
    derive_legacy_runtime_aliases,
)


def _payload() -> dict[str, object]:
    return build_local_runtime_payload(
        runtime_config=SimpleNamespace(
            engine_type="ollama",
            model="ornith:9b",
            context_length=None,
            resolved_app_profile_family=None,
        ),
        engine=SimpleNamespace(
            model_name="ornith:9b",
            _ready=True,
            capabilities={"text": True},
            supports_tool_calling=False,
        ),
    )


def test_local_runtime_payload_no_longer_carries_the_speech_stub() -> None:
    assert "speech" not in _payload()


def test_legacy_aliases_no_longer_carry_speech_status() -> None:
    aliases = derive_legacy_runtime_aliases(
        local_runtime=_payload(),
        active_app_profile=None,
        active_model_capabilities={},
    )

    assert "speech_status" not in aliases


def test_the_speech_stub_builder_is_gone() -> None:
    assert not hasattr(snapshot, "build_default_speech_status_payload")
