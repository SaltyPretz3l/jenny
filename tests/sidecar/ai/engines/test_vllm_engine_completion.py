"""Non-streaming completion and payload mixin split from ``vllm_engine_generation`` (row 105)."""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.engines import vllm_engine_completion, vllm_engine_generation
from sidecar.ai.engines.vllm_engine import VLLMEngine
from sidecar.ai.engines.vllm_engine_telemetry import _VLLMTelemetryMixin


class _Rejection(Exception):
    def __init__(self, status_code: int, body: str) -> None:
        super().__init__(body)
        self.status_code = status_code
        self.body = body


def test_completion_mixin_sits_between_streaming_and_telemetry() -> None:
    mro = VLLMEngine.__mro__

    assert (
        mro.index(vllm_engine_generation._VLLMGenerationMixin)
        < mro.index(vllm_engine_completion._VLLMCompletionMixin)
        < mro.index(_VLLMTelemetryMixin)
    )
    for name in ("generate", "generate_with_tools", "_build_payload", "_json_response_format"):
        assert name in vllm_engine_completion._VLLMCompletionMixin.__dict__
    for name in ("stream", "stream_with_tools", "_build_tool_stream_payload"):
        assert name in vllm_engine_generation._VLLMGenerationMixin.__dict__


def test_response_format_rejection_needs_a_capability_400() -> None:
    reject = vllm_engine_completion._is_response_format_rejection

    assert reject(_Rejection(400, "response_format_not_supported"))
    assert reject(_Rejection(400, "response_format is not supported"))
    assert not reject(_Rejection(400, "bad schema for response_format"))
    assert not reject(_Rejection(500, "response_format_not_supported"))


def test_plain_vllm_keeps_json_object_mode_and_its_own_output_ceiling() -> None:
    engine = VLLMEngine(host="http://127.0.0.1:9")

    assert engine._json_response_format(SimpleNamespace(json_schema={"title": "T"})) == {
        "type": "json_object"
    }
    assert engine._fit_output_to_window({"max_tokens": 12}) == 12
