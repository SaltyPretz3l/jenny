"""Row 96: the live output-chunk emitter forwards `test_progress` (progress-only batches too)."""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.routing.loop_events import ToolOutputChunkEvent
from sidecar.ai.routing.tool_execution import _build_output_chunk_emitter
from sidecar.ai.tools.models import ToolCallRequest


def _emitter(events: list[object]):  # type: ignore[no-untyped-def]
    runtime = SimpleNamespace(emit=events.append)
    call = ToolCallRequest(tool_id="run_command", call_id="call-1", arguments={})
    emit = _build_output_chunk_emitter(runtime, call)
    assert emit is not None
    return emit


def test_progress_only_batch_is_forwarded_unchanged() -> None:
    events: list[object] = []
    progress = {"runner": "pytest", "done": 7, "grid": {"count": 2, "states": "pr"}}
    _emitter(events)({"sequence": 4, "lines": [], "partial": "", "test_progress": progress})
    assert len(events) == 1
    event = events[0]
    assert isinstance(event, ToolOutputChunkEvent)
    assert event.test_progress == progress
    assert event.lines == ()
    assert event.sequence == 4


def test_empty_batch_without_progress_is_still_dropped() -> None:
    events: list[object] = []
    _emitter(events)({"sequence": 1, "lines": [], "partial": ""})
    assert events == []


def test_non_dict_progress_is_ignored_and_lines_still_flow() -> None:
    events: list[object] = []
    _emitter(events)(
        {"sequence": 2, "lines": [{"stream": "stdout", "text": "hi"}], "test_progress": "nope"}
    )
    assert len(events) == 1
    event = events[0]
    assert isinstance(event, ToolOutputChunkEvent)
    assert event.test_progress is None
    assert event.lines == ({"stream": "stdout", "text": "hi"},)
