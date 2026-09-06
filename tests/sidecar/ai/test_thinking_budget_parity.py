"""Shared thinking-budget derivation and router abort coverage."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai import thinking_guard
from sidecar.ai.engines import ollama_runtime, vllm_engine_generation
from sidecar.ai.engines.ollama_generation import _OllamaGenerationMixin
from sidecar.ai.routing import generation_runtime_stream
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.thinking_guard import ThinkingRepetitionGuard
from sidecar.ai.tools.models import GenerationResult, StreamingEvent, ThinkingDelta
from sidecar.runtime import chat_streaming
from tests.sidecar.ai.engines.test_ollama_runtime import FakeEngine
from tests.sidecar.ai.engines.test_thinking_budget_abort import (
    _drain,
    _patch_stream,
    _patch_vllm_stream,
)
from tests.sidecar.runtime.test_chat_streaming_incomplete import _response_for


class _BudgetTokensEngine:
    def _thinking_budget_tokens(self, max_tokens: int) -> int:
        assert max_tokens == 16_384
        return 65_536


class _HeadroomEngine:
    def _thinking_token_headroom(self) -> int:
        return 16_384


@pytest.mark.parametrize(
    ("engine", "max_tokens", "expected"),
    [
        (_BudgetTokensEngine(), 16_384, 262_144),
        (_HeadroomEngine(), 16_384, 65_536),
        (object(), 16_384, 65_536),
        (object(), 4_096, 65_536),
        (None, 0, 65_536),
    ],
)
def test_engine_and_fallback_derivations(
    engine: object | None,
    max_tokens: int,
    expected: int,
) -> None:
    assert thinking_guard.resolve_thinking_budget_chars(engine, max_tokens) == expected


class _EffectiveBudgetEngine(_OllamaGenerationMixin):
    _context_length = 20_000

    def _thinking_token_headroom(self) -> int:
        return 16_384

    def _get_request_context_length(self) -> int:
        return 20_000


def test_budget_never_exceeds_effective_num_predict() -> None:
    engine = _EffectiveBudgetEngine()

    assert engine._thinking_budget_tokens(16_384) == 3_616
    assert thinking_guard.resolve_thinking_budget_chars(engine, 16_384) == 16_384


class _TerminalToolEngine:
    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="content", text="done")
        return GenerationResult(content="done", finish_reason="stop")


class _BudgetTripToolEngine:
    def __init__(self) -> None:
        self.consumed = 0

    def stream_with_tools(self, **_kwargs: Any):
        self.consumed += 1
        yield ThinkingDelta("abcd")
        self.consumed += 1
        yield ThinkingDelta("efgh")
        self.consumed += 1
        yield StreamingEvent(kind="content", text="later content")
        return GenerationResult(content="later content", finish_reason="stop")


def _router_call(engine: object) -> tuple[GenerationResult, set[str]]:
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
            engine_type="stub",
            model="stub-model",
        ),
        _system_prompt_for_engine=str,
    )
    runtime = LoopRuntime(
        emit=lambda _event: None,
        request_id="req_thinking_budget",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )
    return generation_runtime_stream.stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Think carefully.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[],
    )


def _capture_guard_max_chars(
    monkeypatch: pytest.MonkeyPatch,
    module: Any,
) -> list[int]:
    captured: list[int] = []

    class _CapturingGuard(ThinkingRepetitionGuard):
        def __init__(self, *, max_chars: int, **kwargs: Any) -> None:
            captured.append(max_chars)
            super().__init__(max_chars=max_chars, **kwargs)

    monkeypatch.setattr(
        module,
        "resolve_thinking_budget_chars",
        lambda _engine, _max_tokens: 123_456,
        raising=False,
    )
    monkeypatch.setattr(module, "ThinkingRepetitionGuard", _CapturingGuard)
    return captured


@pytest.mark.parametrize(
    "site",
    ["generation_runtime", "chat_streaming", "ollama_plain", "ollama_tools", "vllm_plain", "vllm_tools"],
)
def test_all_construction_sites_use_shared_derivation(
    monkeypatch: pytest.MonkeyPatch,
    site: str,
) -> None:
    module = {
        "generation_runtime": generation_runtime_stream,
        "chat_streaming": chat_streaming,
        "ollama_plain": ollama_runtime,
        "ollama_tools": ollama_runtime,
        "vllm_plain": vllm_engine_generation,
        "vllm_tools": vllm_engine_generation,
    }[site]
    captured = _capture_guard_max_chars(monkeypatch, module)

    if site == "generation_runtime":
        _router_call(_TerminalToolEngine())
    elif site == "chat_streaming":
        _response_for("stop")
    elif site.startswith("ollama"):
        _patch_stream(monkeypatch)
        engine = FakeEngine(think_value=True)
        if site == "ollama_plain":
            list(ollama_runtime.stream(engine, prompt="hi"))
        else:
            _drain(ollama_runtime.stream_with_tools(engine, prompt="hi", tools=[]))
    else:
        engine, _response = _patch_vllm_stream(monkeypatch, ["data: [DONE]"])
        if site == "vllm_plain":
            list(engine.stream(prompt="hi", max_tokens=64))
        else:
            _drain(engine.stream_with_tools(prompt="hi", tools=[], max_tokens=64))

    assert captured == [123_456]


def test_router_budget_trip_aborts_with_thinking_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", raising=False)
    monkeypatch.setattr(
        generation_runtime_stream,
        "resolve_thinking_budget_chars",
        lambda _engine, _max_tokens: 4,
        raising=False,
    )
    close_reasons: list[str] = []
    original_close = generation_runtime_stream._close_stream_reader

    def _close_spy(reader: Any, *, runtime: Any, reason: str) -> None:
        close_reasons.append(reason)
        original_close(reader, runtime=runtime, reason=reason)

    monkeypatch.setattr(generation_runtime_stream, "_close_stream_reader", _close_spy)
    engine = _BudgetTripToolEngine()

    result, _event_types = _router_call(engine)

    assert result.finish_reason == "thinking_budget"
    assert result.thinking_text == "abcd"
    assert close_reasons == ["thinking_budget"]


def test_router_abort_kill_switch_off_preserves_suppression(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", "0")
    monkeypatch.setattr(
        generation_runtime_stream,
        "resolve_thinking_budget_chars",
        lambda _engine, _max_tokens: 4,
        raising=False,
    )
    engine = _BudgetTripToolEngine()

    result, _event_types = _router_call(engine)

    assert result.finish_reason != "thinking_budget"
    assert result.content == "later content"
    assert engine.consumed == 3


def test_continuation_kill_switch_default_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JENNY_ENABLE_THINKING_BUDGET_CONTINUATION", raising=False)
    assert thinking_guard.thinking_budget_continuation_enabled() is True

    monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_CONTINUATION", "0")
    assert thinking_guard.thinking_budget_continuation_enabled() is False
