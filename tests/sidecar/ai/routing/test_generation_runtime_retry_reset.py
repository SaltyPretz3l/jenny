from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.routing.generation_runtime import generate_step
from sidecar.ai.routing.loop_events import StreamResetEvent, ThinkingEvent, TokenDeltaEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import GenerationResult, StreamingEvent, ThinkingDelta


def _connection_error() -> ProviderHttpError:
    return ProviderHttpError(
        provider="chatgpt",
        status_code=None,
        code="CMP-CLOUD-1003",
        message="provider stream disconnected",
        retryable=True,
        classification="connection_error",
        retry_after_seconds=0.0,
    )


def _kernel(engine: Any, *, max_tokens: int = 128) -> SimpleNamespace:
    return SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            max_tokens=max_tokens,
            temperature=0.0,
            reasoning_effort=None,
            engine_type="chatgpt",
            model="gpt-test",
            feature_flags={"api_retry": True},
            fallback_models=(),
        ),
        _engine_messages=lambda messages, primary_system_text: messages,
        _system_prompt_for_engine=str,
    )


def _generate(
    engine: Any,
    *,
    max_tokens: int = 128,
    events: list[object] | None = None,
) -> tuple[GenerationResult, set[str], list[object], LoopRuntime]:
    events = [] if events is None else events
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_provider_retry",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )
    result, event_types = generate_step(
        _kernel(engine, max_tokens=max_tokens),
        latest_user_content="Inspect the failure.",
        working_messages=[{"role": "user", "content": "Inspect the failure."}],
        reasoning_effort=None,
        prompt_cache_enabled=False,
        source_key="req_provider_retry",
        system_prompt="sys",
        tool_schemas=[],
        cache_break_detector=None,
        runtime=runtime,
    )
    return result, event_types, events, runtime


class _TwiceInterruptedEngine:
    def __init__(self) -> None:
        self.attempts = 0

    def get_model_max_output_tokens(self) -> int:
        return 128

    def stream_with_tools(self, **_kwargs: Any):
        self.attempts += 1
        if self.attempts == 1:
            yield StreamingEvent(kind="content", text="partial first attempt")
            raise _connection_error()
        if self.attempts == 2:
            yield ThinkingDelta(text="partial second-attempt reasoning", is_complete=False)
            raise _connection_error()
        yield StreamingEvent(kind="content", text="clean retry response")
        return GenerationResult(content="clean retry response", finish_reason="stop")


def test_streamed_provider_retries_discard_each_partial_attempt() -> None:
    engine = _TwiceInterruptedEngine()

    result, event_types, events, runtime = _generate(engine)

    visible_parts: list[str] = []
    for event in events:
        if isinstance(event, StreamResetEvent):
            visible_parts.clear()
        elif isinstance(event, TokenDeltaEvent):
            visible_parts.append(event.delta)
    resets = [event for event in events if isinstance(event, StreamResetEvent)]
    assert result.content == "clean retry response"
    assert engine.attempts == 3
    assert "".join(visible_parts) == "clean retry response"
    assert [event.reason for event in resets] == ["provider_retry", "provider_retry"]
    assert any(isinstance(event, ThinkingEvent) for event in events)
    assert event_types == {"chat.token", "chat.stream_reset"}
    assert runtime.last_iteration_unflushed == []


class _FailsBeforeOutputEngine:
    def __init__(self) -> None:
        self.attempts = 0

    def get_model_max_output_tokens(self) -> int:
        return 128

    def stream_with_tools(self, **_kwargs: Any):
        self.attempts += 1
        if self.attempts == 1:
            if False:
                yield "unreachable"
            raise _connection_error()
        yield StreamingEvent(kind="content", text="clean response")
        return GenerationResult(content="clean response", finish_reason="stop")


def test_provider_retry_before_first_output_does_not_emit_false_reset() -> None:
    engine = _FailsBeforeOutputEngine()

    result, event_types, events, _runtime = _generate(engine)

    assert result.content == "clean response"
    assert engine.attempts == 2
    assert not any(isinstance(event, StreamResetEvent) for event in events)
    assert event_types == {"chat.token"}


class _NonRetryableInterruptedEngine:
    def get_model_max_output_tokens(self) -> int:
        return 128

    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="content", text="visible terminal failure")
        raise ProviderHttpError(
            provider="chatgpt",
            status_code=400,
            code="CMP-CLOUD-1003",
            message="invalid request",
            retryable=False,
            classification="invalid_request",
        )


def test_non_retryable_stream_failure_does_not_emit_provider_retry_reset() -> None:
    events: list[object] = []

    with pytest.raises(ToolExecutionFailure):
        _generate(_NonRetryableInterruptedEngine(), events=events)

    assert not any(isinstance(event, StreamResetEvent) for event in events)


class _ContextOverflowInterruptedEngine:
    def __init__(self) -> None:
        self.max_tokens_seen: list[int] = []

    def get_model_max_output_tokens(self) -> int:
        return 20_000

    def stream_with_tools(self, **kwargs: Any):
        self.max_tokens_seen.append(int(kwargs["max_tokens"]))
        if len(self.max_tokens_seen) == 1:
            yield StreamingEvent(kind="content", text="partial oversized response")
            raise ProviderHttpError(
                provider="chatgpt",
                status_code=400,
                code="CMP-CLOUD-1003",
                message="context overflow",
                retryable=True,
                classification="context_overflow",
                body={
                    "error": {
                        "message": (
                            "input length and `max_tokens` exceed context limit: "
                            "188059 + 20000 > 200000"
                        )
                    }
                },
            )
        yield StreamingEvent(kind="content", text="clean reduced response")
        return GenerationResult(content="clean reduced response", finish_reason="stop")


def test_context_overflow_retry_discards_partial_stream_before_replay() -> None:
    engine = _ContextOverflowInterruptedEngine()

    result, event_types, events, _runtime = _generate(engine, max_tokens=20_000)

    resets = [event for event in events if isinstance(event, StreamResetEvent)]
    assert result.content == "clean reduced response"
    assert engine.max_tokens_seen == [20_000, 10_941]
    assert [event.reason for event in resets] == ["provider_retry"]
    assert event_types == {"chat.token", "chat.stream_reset"}
