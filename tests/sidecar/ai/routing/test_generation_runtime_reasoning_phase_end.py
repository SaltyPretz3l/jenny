"""The reasoning phase ends at the model's first tool-call output (gate B1 F19).

Tool-call arguments carry no visible text, so before this fix the reasoning
phase stayed open until the whole provider call ended. Electron stamps the
phase's ``completed_at`` when ``chat.phase_completed`` arrives, so a call that
reasoned for 50 s and then streamed a large ``write_file`` for 3 minutes read
"Thought for 247.0s".
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.engines.engine_events import EngineEvent
from sidecar.ai.routing.generation_runtime import stream_generate_with_tools
from sidecar.ai.routing.loop_events import (
    PhaseCompletedEvent,
    PhaseStartedEvent,
    ToolCallDeltaEvent,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import (
    STREAMING_EVENT_KIND_TOOL_ARGUMENTS_PROGRESS,
    GenerationResult,
    StreamingEvent,
    ToolCallRequest,
)

_WRITE_CALL = ToolCallRequest(
    tool_id="write_file",
    arguments={"path": "a.md", "content": "hi"},
    call_id="call_w1",
)


class _ReasonThenToolArgumentsEngine:
    """Reasons, then streams one call's arguments as tool_call_delta events."""

    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="thinking", text="Plan the file.")
        yield EngineEvent(
            kind="tool_call_delta",
            tool_call_id="call_w1",
            tool_name="write_file",
            arguments_delta='{"path": "a.md", ',
            sequence=1,
        )
        yield EngineEvent(
            kind="tool_call_delta",
            tool_call_id="call_w1",
            tool_name="write_file",
            arguments_delta='"content": "hi"}',
            sequence=2,
        )
        yield EngineEvent(kind="done")
        return GenerationResult(content="", finish_reason="tool_calls", tool_calls=(_WRITE_CALL,))


class _ReasonProgressReasonEngine:
    """ChatGPT-subscription shape: a bare argument-progress marker, no payload."""

    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="thinking", text="Plan the file.")
        yield StreamingEvent(kind=STREAMING_EVENT_KIND_TOOL_ARGUMENTS_PROGRESS)
        yield StreamingEvent(kind="thinking", text="Second thought.")
        yield EngineEvent(kind="done")
        return GenerationResult(content="", finish_reason="tool_calls", tool_calls=(_WRITE_CALL,))


def _run(engine: Any) -> list[object]:
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={"phase_events": True},
        ),
        _system_prompt_for_engine=str,
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_phase_end",
        streaming=True,
        chunk_inactivity_seconds=5.0,
    )
    stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Write a file.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )
    return events


def _reasoning_phase_events(events: list[object], event_type: type) -> list[int]:
    return [
        index
        for index, event in enumerate(events)
        if isinstance(event, event_type) and event.phase_kind == "reasoning"
    ]


def test_reasoning_phase_completes_before_the_first_tool_argument_delta() -> None:
    events = _run(_ReasonThenToolArgumentsEngine())

    completed = _reasoning_phase_events(events, PhaseCompletedEvent)
    deltas = [index for index, event in enumerate(events) if isinstance(event, ToolCallDeltaEvent)]
    assert len(deltas) == 2
    # Exactly one completion, and it lands before the arguments start streaming.
    assert len(completed) == 1
    assert completed[0] < deltas[0]


def test_reasoning_after_tool_argument_progress_opens_a_new_phase() -> None:
    events = _run(_ReasonProgressReasonEngine())

    started = _reasoning_phase_events(events, PhaseStartedEvent)
    completed = _reasoning_phase_events(events, PhaseCompletedEvent)
    # The progress marker closed the first reasoning phase; the later
    # reasoning is a new phase that shares the generation's thinking id.
    assert len(started) == 2
    assert len(completed) == 2
    assert completed[0] < started[1]
    first, second = (events[index] for index in started)
    assert isinstance(first, PhaseStartedEvent) and isinstance(second, PhaseStartedEvent)
    assert first.thinking_id == second.thinking_id
