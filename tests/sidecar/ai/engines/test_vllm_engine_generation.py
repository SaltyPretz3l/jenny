from __future__ import annotations

import contextlib
import json
import logging
from typing import Any
from unittest.mock import Mock

import pytest

from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.vllm_engine import VLLMEngine
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
)
from sidecar.ai.tools.models import StreamingEvent
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
