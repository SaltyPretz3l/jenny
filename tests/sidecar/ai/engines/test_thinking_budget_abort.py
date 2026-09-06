"""Thinking-budget abort coverage for local streaming engines."""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

import pytest

from sidecar.ai.engines.provider_http import ProviderHttpService
from sidecar.ai.engines.vllm_engine import VLLMEngine
from sidecar.ai.engines import ollama_runtime
from sidecar.ai.engines.ollama_runtime import stream, stream_with_tools
from sidecar.ai.thinking_guard import ThinkingRepetitionGuard
from tests.sidecar.ai.engines.test_ollama_runtime import FakeEngine


@pytest.fixture(autouse=True)
def _default_abort_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", raising=False)


class _TinyThinkingBudgetEngine(FakeEngine):
    def _thinking_token_headroom(self) -> int:
        return 1


def _force_tiny_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    # The shared resolver floors engine-supplied budgets at 16,384 chars, so
    # the tiny-headroom knob alone can no longer force a first-delta trip;
    # patch the resolver at the consuming module to keep the abort intent.
    monkeypatch.setattr(
        ollama_runtime, "resolve_thinking_budget_chars", lambda _engine, _max_tokens: 4
    )


class _TrackingResponse:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = lines
        self.consumed = 0
        self.closed = False

    def __enter__(self) -> "_TrackingResponse":
        return self

    def __exit__(self, *_args: Any) -> bool:
        self.close()
        return False

    def __iter__(self):
        for line in self._lines:
            self.consumed += 1
            yield line

    def close(self) -> None:
        self.closed = True


def _thinking_chunks() -> list[dict[str, Any]]:
    return [
        {"message": {"thinking": "abcde"}},
        {"message": {"thinking": "abcdef"}},
        {"message": {"content": "later content"}},
        {"message": {}, "done": True, "done_reason": "stop"},
    ]


def _patch_stream(monkeypatch: pytest.MonkeyPatch) -> _TrackingResponse:
    lines = [json.dumps(chunk).encode() + b"\n" for chunk in _thinking_chunks()]
    response = _TrackingResponse(lines)
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda _req, timeout=None: response,
    )
    return response


def _drain(generator: Generator[Any, None, Any]) -> tuple[list[Any], Any]:
    events: list[Any] = []
    try:
        while True:
            events.append(next(generator))
    except StopIteration as stop:
        return events, stop.value


class _TrackingSSEStream:
    def __init__(self, lines: list[str]) -> None:
        self._lines = lines
        self.consumed = 0

    def iter_raw(self, *, chunk_size: int):
        _ = chunk_size
        for line in self._lines:
            self.consumed += 1
            yield f"{line}\n".encode()

    def raise_for_status(self) -> None:
        return None


def _vllm_chunk(delta: dict[str, str]) -> str:
    return f'data: {json.dumps({"choices": [{"delta": delta}]})}'


def _patch_vllm_stream(
    monkeypatch: pytest.MonkeyPatch,
    lines: list[str],
) -> tuple[VLLMEngine, _TrackingSSEStream]:
    response = _TrackingSSEStream(lines)

    @contextmanager
    def _stream_response(
        _self: ProviderHttpService,
        _method: str,
        _path: str,
        **_kwargs: Any,
    ):
        yield response

    monkeypatch.setattr(ProviderHttpService, "stream_response", _stream_response)
    engine = VLLMEngine(host="http://localhost:8000")
    engine.model_name = "Qwen/Qwen3.5-9B"
    engine._ready = True  # noqa: SLF001
    engine._thinking = True  # noqa: SLF001
    return engine, response


def _vllm_budget_lines() -> list[str]:
    return [
        _vllm_chunk({"reasoning_content": "a" * 40_000}),
        _vllm_chunk({"reasoning_content": "b" * 40_000}),
        _vllm_chunk({"content": "later content"}),
        "data: [DONE]",
    ]


def test_guard_distinguishes_character_budget_from_repetition() -> None:
    budget_guard = ThinkingRepetitionGuard(max_chars=4)
    assert budget_guard.feed("abcde") is True
    assert budget_guard.stop_reason == "char_limit"
    assert budget_guard.tripped_on_budget() is True

    repetition_guard = ThinkingRepetitionGuard(
        max_chars=100,
        window_chars=4,
        similarity_threshold=0.0,
        max_repetitive_windows=1,
    )
    assert repetition_guard.feed("abcdwxyz") is True
    assert repetition_guard.stop_reason == "repetition"
    assert repetition_guard.tripped_on_budget() is False


def test_ollama_plain_stream_aborts_when_thinking_budget_trips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _patch_stream(monkeypatch)
    _force_tiny_budget(monkeypatch)

    events = list(stream(_TinyThinkingBudgetEngine(think_value=True), prompt="hi"))

    assert response.consumed == 1
    assert response.closed is True
    assert events[-1].kind == "done"
    assert events[-1].finish_reason == "thinking_budget"


def test_ollama_tool_stream_aborts_when_thinking_budget_trips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _patch_stream(monkeypatch)
    _force_tiny_budget(monkeypatch)

    events, result = _drain(
        stream_with_tools(
            _TinyThinkingBudgetEngine(think_value=True),
            prompt="hi",
            tools=[{"function": {"name": "read_file"}}],
        )
    )

    assert response.consumed == 1
    assert response.closed is True
    assert not [event for event in events if getattr(event, "kind", "") == "content"]
    assert result.finish_reason == "thinking_budget"


@pytest.mark.parametrize("with_tools", [False, True])
def test_ollama_thinking_budget_abort_kill_switch_preserves_full_stream(
    monkeypatch: pytest.MonkeyPatch,
    with_tools: bool,
) -> None:
    monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", "0")
    response = _patch_stream(monkeypatch)
    engine = _TinyThinkingBudgetEngine(think_value=True)

    if with_tools:
        _, result = _drain(
            stream_with_tools(
                engine,
                prompt="hi",
                tools=[{"function": {"name": "read_file"}}],
            )
        )
        finish_reason = result.finish_reason
    else:
        events = list(stream(engine, prompt="hi"))
        finish_reason = events[-1].finish_reason

    assert response.consumed == len(_thinking_chunks())
    assert finish_reason != "thinking_budget"


def test_vllm_plain_stream_aborts_after_floored_thinking_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lines = _vllm_budget_lines()
    engine, response = _patch_vllm_stream(monkeypatch, lines)

    events = list(engine.stream(prompt="hi", max_tokens=64))

    assert response.consumed == 2
    assert events[-1].finish_reason == "thinking_budget"


def test_vllm_tool_stream_aborts_after_floored_thinking_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lines = _vllm_budget_lines()
    engine, response = _patch_vllm_stream(monkeypatch, lines)

    _events, result = _drain(
        engine.stream_with_tools(prompt="hi", tools=[], max_tokens=64)
    )

    assert response.consumed == 2
    assert result.finish_reason == "thinking_budget"


def test_vllm_tool_stream_abort_preserves_visible_content_on_tripping_chunk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The abort ends generation AFTER the tripping chunk's visible content is
    out - the budget abort must never eat text the provider already sent."""
    lines = [
        _vllm_chunk({"reasoning_content": "a" * 40_000}),
        _vllm_chunk({"reasoning_content": "b" * 40_000, "content": "kept text"}),
        _vllm_chunk({"content": "never reached"}),
        "data: [DONE]",
    ]
    engine, response = _patch_vllm_stream(monkeypatch, lines)

    events, result = _drain(
        engine.stream_with_tools(prompt="hi", tools=[], max_tokens=64)
    )

    assert result.finish_reason == "thinking_budget"
    assert response.consumed == 2
    content_texts = [
        event.text for event in events if getattr(event, "kind", "") == "content"
    ]
    assert content_texts == ["kept text"]


def test_vllm_thinking_budget_abort_kill_switch_preserves_full_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", "0")
    lines = _vllm_budget_lines()
    engine, response = _patch_vllm_stream(monkeypatch, lines)

    events = list(engine.stream(prompt="hi", max_tokens=64))

    assert response.consumed == len(lines)
    assert events[-1].finish_reason != "thinking_budget"


def test_vllm_small_max_tokens_uses_floored_thinking_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lines = [
        _vllm_chunk({"reasoning_content": "x" * 300}),
        _vllm_chunk({"content": "answer"}),
        "data: [DONE]",
    ]
    engine, response = _patch_vllm_stream(monkeypatch, lines)

    events = list(engine.stream(prompt="hi", max_tokens=64))

    assert response.consumed == len(lines)
    assert events[-1].finish_reason != "thinking_budget"
