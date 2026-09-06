"""Mid-stream tool-call announcement from the Ollama native tool stream.

While the model generates tool-call arguments the provider is silent; once a
call is fully parsed the stream must announce it immediately (EngineEvent
``tool_call_completed``) instead of holding everything until ``done``, so the
timeline can name the tool early. The announced call id MUST equal the id the
final GenerationResult derives for the same call — a mismatch would strand an
orphaned "requested" tool row in the renderer.
"""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Generator
from typing import Any

import pytest

from sidecar.ai.engines.engine_events import ENGINE_EVENT_TOOL_CALL_COMPLETED, EngineEvent
from sidecar.ai.engines.ollama_runtime import stream_with_tools
from tests.sidecar.ai.engines.test_ollama_runtime import FakeEngine, FakeResponse


def _patch_stream(
    monkeypatch: pytest.MonkeyPatch,
    chunks: list[dict[str, Any]],
) -> None:
    lines = [json.dumps(chunk).encode() + b"\n" for chunk in chunks]
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda _req, timeout=None: FakeResponse(lines),
    )


def _drain(generator: Generator[Any, None, Any]) -> tuple[list[Any], Any]:
    events: list[Any] = []
    try:
        while True:
            events.append(next(generator))
    except StopIteration as stop:
        return events, stop.value


def _tool_call_chunk(call: dict[str, Any], *, done: bool = False) -> dict[str, Any]:
    chunk: dict[str, Any] = {"message": {"tool_calls": [call]}}
    if done:
        chunk["done"] = True
    return chunk


def test_announces_tool_call_before_done(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_stream(
        monkeypatch,
        [
            {"message": {"content": "on it"}},
            _tool_call_chunk(
                {
                    "id": "call-1",
                    "function": {"name": "write_file", "arguments": {"path": "a.txt"}},
                }
            ),
            {"message": {}, "done": True},
        ],
    )

    events, result = _drain(
        stream_with_tools(
            FakeEngine(),
            prompt="hi",
            tools=[{"function": {"name": "write_file"}}],
        )
    )

    announcements = [
        event for event in events
        if isinstance(event, EngineEvent) and event.kind == ENGINE_EVENT_TOOL_CALL_COMPLETED
    ]
    assert len(announcements) == 1
    announced = announcements[0]
    assert announced.tool_name == "write_file"
    assert announced.arguments == {"path": "a.txt"}
    assert announced.sequence == 0
    # Identity invariant: the announced id equals the final result's id.
    assert len(result.tool_calls) == 1
    assert announced.tool_call_id == result.tool_calls[0].call_id


def test_multiple_calls_announce_in_order_with_stable_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_stream(
        monkeypatch,
        [
            _tool_call_chunk(
                {"function": {"name": "read_file", "arguments": {"path": "a.txt"}}}
            ),
            _tool_call_chunk(
                {"function": {"name": "edit_file", "arguments": {"path": "b.txt"}}},
                done=True,
            ),
        ],
    )

    events, result = _drain(
        stream_with_tools(
            FakeEngine(),
            prompt="hi",
            tools=[{"function": {"name": "read_file"}}, {"function": {"name": "edit_file"}}],
        )
    )

    announcements = [
        event for event in events
        if isinstance(event, EngineEvent) and event.kind == ENGINE_EVENT_TOOL_CALL_COMPLETED
    ]
    assert [event.tool_name for event in announcements] == ["read_file", "edit_file"]
    assert [event.sequence for event in announcements] == [0, 1]
    assert len(result.tool_calls) == 2
    assert [event.tool_call_id for event in announcements] == [
        call.call_id for call in result.tool_calls
    ]


def test_kill_switch_suppresses_announcement(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JENNY_ENABLE_TOOL_CALL_EARLY_ANNOUNCE", "0")
    _patch_stream(
        monkeypatch,
        [
            _tool_call_chunk(
                {
                    "id": "call-1",
                    "function": {"name": "write_file", "arguments": {"path": "a.txt"}},
                },
                done=True,
            ),
        ],
    )

    events, result = _drain(
        stream_with_tools(
            FakeEngine(),
            prompt="hi",
            tools=[{"function": {"name": "write_file"}}],
        )
    )

    assert not [
        event for event in events
        if isinstance(event, EngineEvent) and event.kind == ENGINE_EVENT_TOOL_CALL_COMPLETED
    ]
    # The final result still carries the call — behavior reverts byte-identically.
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_id == "write_file"
