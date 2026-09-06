from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.routing.generation_runtime import stream_generate_with_tools
from sidecar.ai.routing.loop_events import ThinkingEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult, ThinkingDelta
from sidecar.protocol import CHAT_THINKING_KIND_REASONING


class _ThinkingSequenceEngine:
    def __init__(self, deltas: list[str]) -> None:
        self._deltas = deltas

    def stream_with_tools(self, **_kwargs: Any):
        for index, delta in enumerate(self._deltas):
            yield ThinkingDelta(text=delta, is_complete=index == len(self._deltas) - 1)
        return GenerationResult(content="Done.", finish_reason="stop")


def _run_thinking_sequence(deltas: list[str]) -> tuple[GenerationResult, list[ThinkingEvent]]:
    kernel = SimpleNamespace(
        _engine=_ThinkingSequenceEngine(deltas),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=str,
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req-thinking-whitespace",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, _emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )
    thinking_events = [
        event
        for event in events
        if isinstance(event, ThinkingEvent) and event.kind == CHAT_THINKING_KIND_REASONING
    ]
    return result, thinking_events


def test_tool_loop_forwards_whitespace_after_reasoning_starts() -> None:
    result, thinking_events = _run_thinking_sequence(["Real", "\n\n", "thinking."])

    assert [event.delta for event in thinking_events] == ["Real", "\n\n", "thinking."]
    assert result.thinking_text == "Real\n\nthinking."


def test_tool_loop_drops_whitespace_before_reasoning_starts() -> None:
    _result, thinking_events = _run_thinking_sequence(["   ", "Real"])

    assert [event.delta for event in thinking_events] == ["Real"]
