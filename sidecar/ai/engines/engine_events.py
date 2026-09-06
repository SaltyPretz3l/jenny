"""Provider-neutral engine event adapter.

Retains GenerationResult compatibility while exposing an event-shaped stream to the
routing layer.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Mapping

from sidecar.ai.tools.models import StreamingEvent, ThinkingDelta, ToolCallRequest

ENGINE_EVENT_TEXT_DELTA = "text_delta"
ENGINE_EVENT_REASONING_DELTA = "reasoning_delta"
ENGINE_EVENT_TOOL_CALL_BOUNDARY = "tool_call_boundary"
ENGINE_EVENT_TOOL_CALL_DELTA = "tool_call_delta"
ENGINE_EVENT_TOOL_CALL_COMPLETED = "tool_call_completed"
ENGINE_EVENT_DONE = "done"
ENGINE_EVENT_FAILED = "failed"

@dataclass(frozen=True)
class EngineEvent:
    """One normalized event emitted by an engine stream."""

    kind: str
    text: str = ""
    thinking_id: str | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    arguments_delta: str = ""
    arguments: dict[str, Any] = field(default_factory=dict)
    sequence: int = 0
    is_complete: bool = False
    finish_reason: str = ""
    result: Any = None
    source: str = "engine_stream"


def _coerce_arguments(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    return {}


def _coerce_text(value: Any) -> str:
    return str(value or "")


def generation_result_to_done_event(result: Any) -> EngineEvent:
    finish_reason = str(getattr(result, "finish_reason", "") or "")
    return EngineEvent(
        kind=ENGINE_EVENT_DONE,
        finish_reason=finish_reason,
        result=result,
    )


def _tool_call_request_to_event(item: ToolCallRequest) -> EngineEvent:
    return EngineEvent(
        kind=ENGINE_EVENT_TOOL_CALL_BOUNDARY,
        tool_call_id=item.call_id,
        tool_name=item.tool_id,
        arguments=_coerce_arguments(item.arguments),
    )


def _thinking_delta_to_event(item: ThinkingDelta) -> EngineEvent:
    return EngineEvent(
        kind=ENGINE_EVENT_REASONING_DELTA,
        text=_coerce_text(item.text),
        is_complete=bool(item.is_complete),
    )


def _streaming_event_to_event(item: StreamingEvent) -> EngineEvent | None:
    kind = str(item.kind or "content").strip().lower()
    if kind == "thinking":
        return EngineEvent(
            kind=ENGINE_EVENT_REASONING_DELTA,
            text=_coerce_text(item.text),
            is_complete=True,
        )
    if kind == "content":
        return EngineEvent(kind=ENGINE_EVENT_TEXT_DELTA, text=_coerce_text(item.text))
    return None


_StreamItemAdapter = Callable[[Any], EngineEvent | None]

_STREAM_ITEM_ADAPTERS: tuple[tuple[type[Any], _StreamItemAdapter], ...] = (
    (ToolCallRequest, _tool_call_request_to_event),
    (ThinkingDelta, _thinking_delta_to_event),
    (StreamingEvent, _streaming_event_to_event),
)


def stream_item_to_engine_event(item: Any) -> EngineEvent | None:
    """Adapt legacy engine stream items to ``EngineEvent`` records."""
    if isinstance(item, EngineEvent):
        return item
    for item_type, adapter in _STREAM_ITEM_ADAPTERS:
        if isinstance(item, item_type):
            return adapter(item)
    return EngineEvent(kind=ENGINE_EVENT_TEXT_DELTA, text=_coerce_text(item))
