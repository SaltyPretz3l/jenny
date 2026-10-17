"""Replay recorded ninfer-serve responses through the OpenAI-compatible engine.

Roadmap row 54 (NInfer on the RTX 5090), slices N0/N1. The fixtures under
``fixtures/ninfer`` are raw responses from a real ``ninfer-serve`` (the
natpate Windows fork, v0.9.1) to Jenny's Qwen3.8 request shapes; their
provenance is in ``capture.json``. These tests pin that Jenny's existing
engine binds the model, reads the served window and thinking control from the
fork's ``/props`` shim, splits reasoning from content, and parses NInfer's
whole-call tool deltas.
"""

from __future__ import annotations

import contextlib
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from sidecar.ai.app_profiles import resolve_profile, resolve_variant
from sidecar.ai.app_profiles.qwen38 import (
    QWEN38_INSTRUCT_SAMPLER,
    QWEN38_PROFILE,
    QWEN38_THINKING_SAMPLER,
)
from sidecar.ai.engines import vllm_engine as vllm_engine_module
from sidecar.ai.engines.local_server_props import ThinkingControl
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.provider_http import _response_error
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.tools.models import StreamingEvent

FIXTURES = Path(__file__).parent / "fixtures" / "ninfer"
BASE_URL = "http://127.0.0.1:8080/v1"
MODEL_ID = "qwen3.8-27b-nvfp4"
WEATHER_TOOL = {
    "name": "get_weather",
    "description": "Get the current weather for a city.",
    "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}


def _fixture_json(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _recorded_deltas(sse_name: str, field: str) -> str:
    """Concatenate one delta field across a recorded stream."""
    parts: list[str] = []
    for line in (FIXTURES / sse_name).read_text(encoding="utf-8").splitlines():
        if not line.startswith("data: {"):
            continue
        for choice in json.loads(line[len("data: ") :]).get("choices") or []:
            value = (choice.get("delta") or {}).get(field)
            if isinstance(value, str):
                parts.append(value)
    return "".join(parts)


@pytest.fixture
def make_engine(monkeypatch: pytest.MonkeyPatch):
    """Build an engine bound to the recorded server, replaying ``sse_name``."""
    built: list[tuple[OpenAICompatibleEngine, list[dict[str, Any]]]] = []
    monkeypatch.setattr(
        vllm_engine_module,
        "probe_server_modalities",
        lambda **_kwargs: _fixture_json("props.json"),
    )

    def _make(sse_name: str | None = None) -> tuple[OpenAICompatibleEngine, list[dict[str, Any]]]:
        sent: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            # Byte streams, not json=: the service reads bodies raw to bound them.
            if request.url.path == "/v1/models":
                body, content_type = (FIXTURES / "v1_models.json").read_bytes(), "application/json"
            else:
                assert request.url.path == "/v1/chat/completions" and sse_name is not None
                sent.append(json.loads(request.content))
                body, content_type = (FIXTURES / sse_name).read_bytes(), "text/event-stream"
            return httpx.Response(
                200,
                request=request,
                headers={"content-type": content_type},
                stream=httpx.ByteStream(body),
            )

        engine = OpenAICompatibleEngine(
            host=BASE_URL,
            configured_context_length=8192,
            profile_max_output_tokens=2048,
            profile_thinking_headroom=2048,
        )
        engine._service._client.close()
        engine._service._client = httpx.Client(
            base_url=engine._base_url, transport=httpx.MockTransport(handler)
        )
        engine.load_model(MODEL_ID)
        built.append((engine, sent))
        return engine, sent

    yield _make
    for engine, _sent in built:
        with contextlib.suppress(Exception):
            engine.close()


def _drain(generator: Any) -> tuple[list[Any], Any]:
    items: list[Any] = []
    while True:
        try:
            items.append(next(generator))
        except StopIteration as stop:
            return items, stop.value


def _event_text(items: list[Any], kind: str) -> str:
    return "".join(
        item.text for item in items if isinstance(item, StreamingEvent) and item.kind == kind
    )


@pytest.mark.parametrize("options,enabled", [
    ({"live": True, "provider_kind": "ninfer"}, True),
    ({"live": False, "provider_kind": "ninfer"}, False),
    ({"live": True, "provider_kind": "llama-server"}, False),
    ({"live": True, "provider_kind": "ollama"}, False),
    ({"live": True, "provider_kind": "other"}, False),
    (None, False),
])
def test_payload_metrics_options_only_for_live_ninfer(make_engine, monkeypatch, options, enabled):
    engine, sent = make_engine("think_off.sse")
    monkeypatch.setattr(engine, "_current_request_context", lambda: {"inference_performance": options})
    list(engine.stream("Hi", max_tokens=64))
    assert (sent[-1].get("timings_per_token") is True) is enabled
    assert (sent[-1].get("return_progress") is True) is enabled


@pytest.mark.parametrize("tools", [False, True])
def test_metrics_replay_enters_both_stream_paths_without_usage(make_engine, monkeypatch, tools):
    from sidecar.ai.engines.engine_events import EngineEvent

    engine, _ = make_engine("think_off.sse")
    monkeypatch.setattr(engine, "_current_request_context", lambda: {
        "inference_performance": {"live": True, "provider_kind": "ninfer"},
        "inference_performance_enabled": True,
    })
    stream = engine.stream_with_tools("Hi", tools=[]) if tools else engine.stream("Hi")
    items, _ = _drain(stream)
    samples = [item.performance for item in items if isinstance(item, EngineEvent) and item.performance]
    assert samples[0].phase == "waiting"
    assert samples[-1].generated_tokens == 8
    assert samples[-1].terminal_decode_tps == pytest.approx(124.18, abs=0.01)
    assert len({sample.attempt_id for sample in samples}) == 1


def test_recorded_ninfer_metrics_cross_real_reader_consumer_and_serializer(make_engine, monkeypatch):
    from types import SimpleNamespace

    from sidecar.ai.routing.generation_runtime import stream_generate_with_tools
    from sidecar.ai.routing.loop_runtime import LoopRuntime
    from sidecar.runtime.chat_serialization import _serialize_loop_event

    engine, _ = make_engine("think_off.sse")
    monkeypatch.setattr(engine, "_current_request_context", lambda: {
        "inference_performance": {"live": True, "provider_kind": "ninfer"},
        "inference_performance_enabled": True,
    })
    messages = []
    runtime = LoopRuntime(
        request_id="physical-request", streaming=True,
        request_context=SimpleNamespace(logical_turn_id="logical-turn"),
        emit=lambda event: messages.append(_serialize_loop_event(
            event, "physical-request", trace_id="trace", session_id="session",
        )),
    )
    kernel = SimpleNamespace(
        _engine=engine, _system_prompt_for_engine=str,
        _config=SimpleNamespace(temperature=0.0, reasoning_effort=None, feature_flags={}),
    )
    result, _ = stream_generate_with_tools(
        kernel, runtime=runtime, latest_user_content="Hi", prompt_messages=[], max_tokens=64,
        reasoning_effort=None, prompt_cache_enabled=False, system_prompt="Jenny", tool_schemas=[],
    )
    samples = [message["params"] for message in messages
               if message and message["method"] == "inference.performance"]
    assert result.finish_reason == "stop"
    assert [sample["phase"] for sample in samples] == ["waiting", "decode", "finished"]
    assert samples[-1]["terminal_decode_tps"] == pytest.approx(124.18, abs=0.01)
    assert samples[-1]["turn_id"] == "logical-turn"
    assert samples[-1]["request_id"] == "physical-request"


def test_nonstream_completion_captures_timings_without_usage(make_engine, monkeypatch):
    from types import SimpleNamespace

    from sidecar.ai.routing.inference_performance import InferencePerformanceStatus

    engine, _ = make_engine()
    emitted = []
    status = InferencePerformanceStatus(SimpleNamespace(request_id="request", emit_safe=emitted.append))
    monkeypatch.setattr(engine, "_current_request_context", lambda: {
        "inference_performance": {"live": False, "provider_kind": "ninfer"},
        "inference_performance_enabled": True,
        "inference_performance_emit": status.accept,
    })
    terminal = next(json.loads(line[6:]) for line in (FIXTURES / "think_off.sse").read_text().splitlines()
                    if '"timings"' in line)
    body = {"choices": [{"message": {"content": "Hello"}, "finish_reason": "stop"}],
            "timings": terminal["timings"]}
    monkeypatch.setattr(engine._service, "post_json", lambda *_args, **_kwargs: body)
    result = engine.generate_with_tools("Hi", tools=[])
    assert result.content == "Hello"
    assert [event.observation.phase for event in emitted] == ["waiting", "finished"]
    assert emitted[-1].observation.terminal_decode_tps == pytest.approx(124.18, abs=0.01)
    assert emitted[-1].observation.prompt_tokens == 18


def test_nonstream_failure_finishes_once_without_masking_provider_error(make_engine, monkeypatch):
    from types import SimpleNamespace

    from sidecar.ai.routing.inference_performance import InferencePerformanceStatus

    engine, _ = make_engine()
    emitted = []
    status = InferencePerformanceStatus(SimpleNamespace(request_id="request", emit_safe=emitted.append))
    monkeypatch.setattr(engine, "_current_request_context", lambda: {
        "inference_performance_emit": status.accept,
        "inference_performance_enabled": True,
    })
    def fail(*_args, **_kwargs):
        raise RuntimeError("provider failed")
    monkeypatch.setattr(engine._service, "post_json", fail)
    with pytest.raises(RuntimeError, match="provider failed"):
        engine.generate_with_tools("Hi", tools=[])
    assert [event.observation.phase for event in emitted] == ["waiting", "failed"]


def test_load_model_reads_window_and_thinking_from_ninfer_props(make_engine) -> None:
    engine, _sent = make_engine()

    assert engine.model_name == MODEL_ID
    # /props (n_ctx 32768) wins over Electron's configured 8192.
    assert engine.get_configured_context_length() == 32768
    assert engine._served_thinking_control == ThinkingControl(native_effort=False, toggle=True)
    assert engine._thinking is True
    assert engine._vision is False


def test_thinking_stream_splits_reasoning_from_content(make_engine) -> None:
    engine, sent = make_engine("think_on_medium.sse")

    items, _ = _drain(
        engine.stream(
            prompt="",
            max_tokens=512,
            temperature=0.6,
            reasoning_effort="medium",
            messages=[{"role": "user", "content": "What is 17*23? Answer with just the number."}],
        )
    )

    assert _event_text(items, "content").strip() == "391"
    assert _event_text(items, "content") == _recorded_deltas("think_on_medium.sse", "content")
    assert _event_text(items, "thinking") == _recorded_deltas(
        "think_on_medium.sse", "reasoning_content"
    )
    # Jenny's Qwen3.8 contract fields, all of which ninfer-serve accepted live.
    payload = sent[0]
    assert payload["model"] == MODEL_ID
    assert payload["chat_template_kwargs"] == {
        "enable_thinking": True,
        "reasoning_effort": "medium",
    }


def test_ninfer_model_id_takes_the_qwen38_profile_within_ninfer_sampler_bounds() -> None:
    profile = resolve_profile(MODEL_ID)

    assert profile is QWEN38_PROFILE
    assert resolve_variant(profile, MODEL_ID).name == "27b"
    # ninfer-serve rejects top_k outside [0, 20] with a 400 (fixtures/ninfer/errors.json).
    for preset in (QWEN38_THINKING_SAMPLER, QWEN38_INSTRUCT_SAMPLER):
        assert 0 <= preset.top_k <= 20


def test_thinking_off_stream_has_no_reasoning(make_engine) -> None:
    engine, sent = make_engine("think_off.sse")

    items, _ = _drain(
        engine.stream(
            prompt="",
            max_tokens=256,
            temperature=0.6,
            reasoning_effort="none",
            messages=[{"role": "user", "content": "Say hello in five words."}],
        )
    )

    assert _event_text(items, "thinking") == ""
    assert _event_text(items, "content") == _recorded_deltas("think_off.sse", "content")
    assert sent[0]["chat_template_kwargs"] == {"enable_thinking": False}


@pytest.mark.parametrize(
    ("sse_name", "effort", "city"),
    [("tool_call.sse", "none", "Paris"), ("tool_call_thinking.sse", "medium", "Oslo")],
)
def test_whole_call_tool_delta_parses_to_one_call(
    make_engine, sse_name: str, effort: str, city: str
) -> None:
    engine, sent = make_engine(sse_name)

    _items, result = _drain(
        engine.stream_with_tools(
            prompt="",
            tools=[WEATHER_TOOL],
            max_tokens=512,
            temperature=0.6,
            reasoning_effort=effort,
            messages=[{"role": "user", "content": f"What's the weather in {city}? Use the tool."}],
        )
    )

    assert result.finish_reason == "tool_calls"
    assert [(call.tool_id, call.arguments) for call in result.tool_calls] == [
        ("get_weather", {"city": city})
    ]
    assert [tool["function"]["name"] for tool in sent[0]["tools"]] == ["get_weather"]


@pytest.mark.parametrize(
    ("case", "classification"),
    [
        ("wrong_model", "invalid_model"),
        ("top_k_40", "client_error"),
        ("five_stops", "client_error"),
    ],
)
def test_ninfer_error_bodies_classify(case: str, classification: str) -> None:
    recorded = _fixture_json("errors.json")[case]
    response = httpx.Response(
        recorded["status"],
        request=httpx.Request("POST", f"{BASE_URL}/chat/completions"),
        json=recorded["body"],
    )

    error = _response_error("openai-compatible", response)

    assert error.classification == classification
    assert error.retryable is False


@pytest.mark.parametrize("vision", [False, True])
def test_synthetic_ninfer_vision_props_and_image_payload(make_engine, monkeypatch, vision):
    # Synthetic variants of the recorded text-only props, not new live evidence.
    props = _fixture_json("props.json")
    props["modalities"]["vision"] = vision
    monkeypatch.setattr(vllm_engine_module, "probe_server_modalities", lambda **_kwargs: props)
    engine, sent = make_engine("think_off.sse")
    assert engine._vision is vision
    assert engine._local_runtime_capability_sources["vision"] == "server_props"
    if vision:
        image = VisionImage("image/png", 1, 1, 1, b"synthetic-image")
        content = [
            {"type": "text", "text": "Describe this image."},
            {"type": "image_url", "image_url": {"url": image.as_data_uri()}},
        ]
        _drain(engine.stream(prompt="", max_tokens=64, messages=[{"role": "user", "content": "Describe this image.", "images": [image]}]))
        assert sent[-1]["messages"][-1]["content"] == content
