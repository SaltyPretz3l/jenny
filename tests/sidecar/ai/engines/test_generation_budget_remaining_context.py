"""Regression coverage for Ollama generation budgets within remaining context."""

from __future__ import annotations

import threading
from typing import Any

import pytest

from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.ollama_runtime import _build_chat_request
from sidecar.ai.engines.ollama_telemetry import record_ollama_chat_request


def _build_engine(context_length: int | None) -> OllamaEngine:
    engine = object.__new__(OllamaEngine)
    engine.host = "http://localhost:11434"
    engine._request_timeout_seconds = 300  # noqa: SLF001
    engine.model_name = "qwen3.8:27b-ud-iq3-s"
    engine._ready = True  # noqa: SLF001
    engine._vision = False  # noqa: SLF001
    engine._thinking = True  # noqa: SLF001
    engine._tool_calls_enabled = True  # noqa: SLF001
    engine._tool_call_http_400_streak = 0  # noqa: SLF001
    engine._context_length = context_length  # noqa: SLF001
    engine._configured_context_length = context_length  # noqa: SLF001
    engine._max_output_tokens = None  # noqa: SLF001
    engine._profile_max_output_tokens = None  # noqa: SLF001
    engine._profile_thinking_headroom = None  # noqa: SLF001
    engine._thinking_capability_source = "metadata"  # noqa: SLF001
    engine._request_context_lock = threading.Lock()  # noqa: SLF001
    return engine


@pytest.mark.parametrize(
    ("context_length", "prompt_tokens_estimate", "expected"),
    [
        (32_768, 9_035, 23_221),
        (65_536, 9_035, 32_768),
        (32_768, None, 32_768),
        (32_768, 40_000, 1_024),
    ],
)
def test_build_options_caps_num_predict_by_remaining_context(
    context_length: int,
    prompt_tokens_estimate: int | None,
    expected: int,
) -> None:
    engine = _build_engine(context_length)

    options = engine._build_options(  # noqa: SLF001
        16_384,
        0.7,
        thinking=True,
        prompt_tokens_estimate=prompt_tokens_estimate,
    )

    assert options["num_predict"] == expected


@pytest.mark.parametrize(
    ("remaining_tokens", "expected"),
    [(23_221, 16_384), (1_024, 768)],
)
def test_thinking_headroom_preserves_final_reserve(
    remaining_tokens: int,
    expected: int,
) -> None:
    engine = _build_engine(32_768)

    assert (  # noqa: SLF001
        engine._thinking_token_headroom(remaining_tokens=remaining_tokens) == expected
    )


def test_plain_generation_is_also_capped_by_remaining_context() -> None:
    engine = _build_engine(32_768)

    options = engine._build_options(  # noqa: SLF001
        16_384,
        0.7,
        thinking=False,
        prompt_tokens_estimate=40_000,
    )

    assert options["num_predict"] == 1_024


def test_estimate_request_prompt_tokens_counts_json_overhead() -> None:
    estimate = OllamaEngine._estimate_request_prompt_tokens(  # noqa: SLF001
        {"messages": [{"role": "user", "content": "x" * 400}], "tools": []}
    )

    assert 100 <= estimate <= 130


def test_chat_request_passes_prompt_estimate_to_options(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = _build_engine(32_768)
    captured: dict[str, Any] = {}

    def _capture_options(
        max_tokens: int,
        temperature: float,
        **kwargs: Any,
    ) -> dict[str, Any]:
        captured.update(kwargs)
        return {"num_predict": max_tokens, "temperature": temperature}

    monkeypatch.setattr(engine, "_build_options", _capture_options)
    messages = [{"role": "user", "content": "hello"}]

    data = _build_chat_request(
        engine,
        msgs=messages,
        max_tokens=16_384,
        temperature=0.7,
        reasoning_effort=None,
        stream=True,
    )

    assert captured["prompt_tokens_estimate"] == engine._estimate_request_prompt_tokens(data)


def test_chat_request_telemetry_carries_remaining_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _build_engine(32_768)
    captured: dict[str, Any] = {}
    monkeypatch.setattr(engine, "_record_provider_request", lambda **kwargs: captured.update(kwargs))
    data = {
        "messages": [{"role": "user", "content": "hello"}],
        "options": {"num_predict": 23_221, "temperature": 0.7},
        "think": True,
    }

    record_ollama_chat_request(engine, data, data["messages"], 16_384)

    estimate = engine._estimate_request_prompt_tokens(data)
    assert captured["prompt_tokens_estimate"] == estimate
    assert captured["remaining_context_tokens"] == 32_768 - estimate - 512
