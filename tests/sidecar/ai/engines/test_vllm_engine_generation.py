from __future__ import annotations

import contextlib
import json
import logging
from typing import Any
from unittest.mock import Mock

import pytest

from sidecar.ai.engines.engine_events import (
    ENGINE_EVENT_TOOL_CALL_DELTA,
    EngineEvent,
    stream_item_to_engine_event,
)
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.vllm_engine import VLLMEngine
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
)
from sidecar.ai.tools.models import (
    STREAMING_EVENT_KIND_TOOL_ARGUMENTS_PROGRESS,
    StreamingEvent,
)
from tests.sidecar.ai.engines import test_vllm_engine as vllm_test


@pytest.fixture(autouse=True)
def _release_engines(monkeypatch: pytest.MonkeyPatch):
    """Close every engine this module builds and drop its request binding.

    Each engine owns an httpx.Client with keep-alive sockets that only
    VLLMEngine.close() releases, and begin_request_context stores its binding in
    a module-level ContextVar that otherwise outlives the test that set it.
    Engines are built inline and through _make_streaming_engine, so track them at
    __init__ -- OpenAICompatibleEngine subclasses VLLMEngine, so the base
    constructor catches both.
    """
    built: list[VLLMEngine] = []
    original_init = VLLMEngine.__init__

    def _tracking_init(self, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        built.append(self)

    monkeypatch.setattr(VLLMEngine, "__init__", _tracking_init)
    yield
    for engine in built:
        with contextlib.suppress(Exception):
            engine.clear_request_context()
        with contextlib.suppress(Exception):
            engine.close()


def test_tool_stream_parses_reasoning_split_across_sse_chunks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = vllm_test._make_streaming_engine(  # noqa: SLF001
        monkeypatch,
        model="google/gemma-4-e4b-it",
    )
    engine.begin_request_context(
        request_id="req-tool-reasoning-parser",
        app_profile_behavior={
            "reasoning_parser_start": "<|channel>thought",
            "reasoning_parser_end": "<channel|>",
        },
    )
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                vllm_test._sse_chunk(  # noqa: SLF001
                    {"content": "<|channel>thoughtsecret "}
                ),
                vllm_test._sse_chunk(  # noqa: SLF001
                    {"content": "continuation<channel|>visible"}
                ),
                "data: [DONE]",
            ]
        ),
    )

    chunks, result = vllm_test._drain_stream(  # noqa: SLF001
        engine.stream_with_tools(prompt="think", tools=[])
    )

    assert [event.text for event in chunks if event.kind == "thinking"] == [
        "secret ",
        "continuation",
    ]
    assert [event.text for event in chunks if event.kind == "content"] == ["visible"]
    assert result.content == "visible"
    assert result.thinking_text == "secret continuation"


def test_stream_logs_suppressed_provider_reasoning_once(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    model = "meta-llama/Llama-3.1-8B"
    engine = vllm_test._make_streaming_engine(monkeypatch, model=model)  # noqa: SLF001
    engine.begin_request_context(
        request_id="req-suppressed-provider-reasoning",
        app_profile_behavior={},
    )
    reasoning_deltas = ["first thought", "second thought", "third thought"]
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                *[
                    vllm_test._sse_chunk({"reasoning_content": text})  # noqa: SLF001
                    for text in reasoning_deltas
                ],
                "data: [DONE]",
            ]
        ),
    )

    with caplog.at_level(logging.WARNING):
        chunks = list(engine.stream(prompt="think"))

    warnings = [
        record
        for record in caplog.records
        if record.getMessage()
        == "Dropping vLLM provider reasoning: reasoning output is disabled for this model."
    ]
    assert not [event for event in chunks if event.kind == "thinking"]
    assert len(warnings) == 1
    assert warnings[0].model == model
    assert warnings[0].engine == "vLLM"
    assert warnings[0].chars == len(reasoning_deltas[0])


def test_stream_does_not_log_enabled_provider_reasoning(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    engine = vllm_test._make_streaming_engine(  # noqa: SLF001
        monkeypatch,
        model="meta-llama/Llama-3.1-8B",
    )
    engine.begin_request_context(
        request_id="req-enabled-provider-reasoning",
        app_profile_behavior={
            "reasoning_parser_start": "<think>",
            "reasoning_parser_end": "</think>",
        },
    )
    reasoning_deltas = ["first thought", "second thought", "third thought"]
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                *[
                    vllm_test._sse_chunk({"reasoning_content": text})  # noqa: SLF001
                    for text in reasoning_deltas
                ],
                "data: [DONE]",
            ]
        ),
    )

    with caplog.at_level(logging.WARNING):
        chunks = list(engine.stream(prompt="think"))

    assert [event.text for event in chunks if event.kind == "thinking"] == reasoning_deltas
    assert not [
        record
        for record in caplog.records
        if "provider reasoning: reasoning output is disabled" in record.getMessage()
    ]


def test_tool_stream_yields_liveness_while_tool_arguments_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Owner session 2026-09-19: a local model streamed a 7k-token create_artifact
    # call at ~58 tok/s and the router's inactivity watchdog killed the turn as
    # "engine stalled" because argument deltas never reached it.
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    fragments = ['{"title": "Badge', ' spec", "content": "# Ba', 'dge"}']

    def _tool_delta(index: int, fragment: str) -> str:
        call: dict[str, Any] = {"index": 0, "function": {"arguments": fragment}}
        if index == 0:
            call.update(id="call-1", type="function")
            call["function"]["name"] = "create_artifact"
        return vllm_test._sse_chunk({"tool_calls": [call]})  # noqa: SLF001

    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                *(_tool_delta(index, fragment) for index, fragment in enumerate(fragments)),
                "data: "
                + json.dumps({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
                "data: [DONE]",
            ]
        ),
    )

    chunks, result = vllm_test._drain_stream(  # noqa: SLF001
        engine.stream_with_tools(prompt="write it", tools=[])
    )

    # Gate B1 F19: each fragment is a typed tool_call_delta (call id, tool
    # name, fragment), which both keeps the watchdog fed and lets the router
    # emit tool_input_delta so the timeline can say which call is being
    # written, instead of a payload-less liveness marker.
    deltas = [
        chunk
        for chunk in chunks
        if isinstance(chunk, EngineEvent) and chunk.kind == ENGINE_EVENT_TOOL_CALL_DELTA
    ]
    assert [chunk.arguments_delta for chunk in deltas] == fragments
    assert {chunk.tool_name for chunk in deltas} == {"create_artifact"}
    assert not [
        chunk
        for chunk in chunks
        if isinstance(chunk, StreamingEvent)
        and chunk.kind in ("content", STREAMING_EVENT_KIND_TOOL_ARGUMENTS_PROGRESS)
    ]
    assert [(call.tool_id, call.arguments) for call in result.tool_calls] == [
        ("create_artifact", {"title": "Badge spec", "content": "# Badge"})
    ]
    assert {chunk.tool_call_id for chunk in deltas} == {result.tool_calls[0].call_id}
    assert stream_item_to_engine_event(deltas[0]) is deltas[0]


@pytest.mark.parametrize(
    ("lines", "expected_finish_reason"),
    [
        (
            [vllm_test._sse_chunk({"content": "partial"})],  # noqa: SLF001
            FINISH_REASON_INCOMPLETE,
        ),
        (
            [
                vllm_test._sse_chunk({"content": "start"}),  # noqa: SLF001
                'data: {"object":"error","message":"engine died"}',
                vllm_test._sse_chunk({"content": "never read"}),  # noqa: SLF001
                "data: [DONE]",
            ],
            FINISH_REASON_PROVIDER_ERROR,
        ),
        (
            [
                "data: "
                + json.dumps(
                    {
                        "choices": [
                            {"delta": {"content": "clipped"}, "finish_reason": "length"}
                        ]
                    }
                )
            ],
            "length",
        ),
    ],
)
def test_tool_stream_propagates_terminal_classification(
    monkeypatch: pytest.MonkeyPatch,
    lines: list[str],
    expected_finish_reason: str,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(lines),  # noqa: SLF001
    )

    chunks, result = vllm_test._drain_stream(  # noqa: SLF001
        engine.stream_with_tools(prompt="hi", tools=[])
    )

    assert chunks[-1] == StreamingEvent(kind="done", finish_reason=expected_finish_reason)
    assert result.finish_reason == expected_finish_reason
    if expected_finish_reason == FINISH_REASON_PROVIDER_ERROR:
        assert result.content == "start"


@pytest.mark.parametrize("provider_finish_reason", ["length", "max_tokens"])
def test_generate_with_tools_propagates_length_finish_reason(
    monkeypatch: pytest.MonkeyPatch,
    provider_finish_reason: str,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    monkeypatch.setattr(
        engine._service,  # noqa: SLF001
        "post_json",
        lambda *_args, **_kwargs: {
            "choices": [
                {
                    "finish_reason": provider_finish_reason,
                    "message": {"content": "partial"},
                }
            ]
        },
    )

    result = engine.generate_with_tools(prompt="hi", tools=[])

    assert result.content == "partial"
    assert result.finish_reason == "length"


def test_repetition_penalty_uses_provider_specific_payload_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = "meta-llama/Llama-3.1-8B"
    vllm_test._patch_models_probe(  # noqa: SLF001
        monkeypatch,
        lambda *_args, **_kwargs: vllm_test._make_models_response(model),  # noqa: SLF001
    )
    engines = [
        (VLLMEngine(host="http://localhost:8000"), "repetition_penalty"),
        (OpenAICompatibleEngine(host="http://localhost:8033"), "repeat_penalty"),
    ]
    captured_payloads: list[dict[str, Any]] = []
    for index, (engine, _expected_key) in enumerate(engines):
        engine.load_model(model)
        engine.begin_request_context(
            request_id=f"req-repeat-penalty-{index}",
            app_profile_behavior={"repeat_penalty": 1.15},
        )
        post_json = Mock(
            return_value={
                "choices": [{"finish_reason": "stop", "message": {"content": "ok"}}]
            }
        )
        monkeypatch.setattr(engine._service, "post_json", post_json)  # noqa: SLF001
        engine.generate_with_tools(prompt="hi", tools=[])
        captured_payloads.append(post_json.call_args.args[1])

    vllm_payload, openai_compatible_payload = captured_payloads
    assert vllm_payload["repetition_penalty"] == 1.15
    assert "repeat_penalty" not in vllm_payload
    assert openai_compatible_payload["repeat_penalty"] == 1.15
    assert "repetition_penalty" not in openai_compatible_payload


def _terminal_gap_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.engines.vllm.stream_incomplete"
    ]


def test_tool_stream_logs_the_terminal_gap_with_the_provider_error_text(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                vllm_test._sse_chunk({"content": "start"}),  # noqa: SLF001
                'data: {"object":"error","message":"engine died"}',
                "data: [DONE]",
            ]
        ),
    )

    with caplog.at_level(logging.WARNING):
        _chunks, result = vllm_test._drain_stream(  # noqa: SLF001
            engine.stream_with_tools(prompt="hi", tools=[])
        )

    assert result.finish_reason == FINISH_REASON_PROVIDER_ERROR
    # Same actionable event as stream(): the provider's own words ride record.data.
    gaps = _terminal_gap_records(caplog)
    assert len(gaps) == 1
    assert gaps[0].data["finish_reason"] == FINISH_REASON_PROVIDER_ERROR
    assert gaps[0].data["inband_error"] == "engine died"


def test_tool_stream_logs_the_terminal_gap_when_the_stream_ends_early(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream([vllm_test._sse_chunk({"content": "partial"})]),  # noqa: SLF001
    )

    with caplog.at_level(logging.WARNING):
        _chunks, result = vllm_test._drain_stream(  # noqa: SLF001
            engine.stream_with_tools(prompt="hi", tools=[])
        )

    assert result.finish_reason == FINISH_REASON_INCOMPLETE
    assert [record.data["inband_error"] for record in _terminal_gap_records(caplog)] == [""]
