from __future__ import annotations

import json
import urllib.request
from collections.abc import Generator
from typing import Any

import pytest

from sidecar.ai.engines.ollama_runtime import stream, stream_with_tools
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


def test_stream_processes_content_and_done_on_repeated_thinking_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_stream(
        monkeypatch,
        [
            {"message": {"thinking": "reasoning so far"}},
            {
                "message": {
                    "thinking": "reasoning so far",
                    "content": "answer",
                },
                "done": True,
            },
        ],
    )

    events = list(stream(FakeEngine(), prompt="hi"))

    # The repeated frame is a real delta, forwarded ahead of the content/done.
    assert [event.kind for event in events] == ["thinking", "thinking", "content", "done"]
    assert events[2].text == "answer"
    assert events[-1].finish_reason == "stop"


def test_tool_stream_processes_fields_on_repeated_thinking_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_stream(
        monkeypatch,
        [
            {"message": {"thinking": "reasoning so far"}},
            {
                "message": {
                    "thinking": "reasoning so far",
                    "content": "calling",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "function": {
                                "name": "read_file",
                                "arguments": {"path": "a.txt"},
                            },
                        }
                    ],
                },
                "done": True,
            },
        ],
    )

    events, result = _drain(
        stream_with_tools(
            FakeEngine(),
            prompt="hi",
            tools=[{"function": {"name": "read_file"}}],
        )
    )

    # The trailing engine event is the mid-stream tool-call announcement
    # (see test_ollama_runtime_tool_call_announce.py for its contract).
    assert [event.kind for event in events] == [
        "thinking", "thinking", "content", "tool_call_completed"
    ]
    assert result.finish_reason == "tool_calls"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_id == "read_file"


def test_tool_stream_does_not_open_connection_when_already_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class CancelledHandle:
        def raise_if_cancelled(self) -> None:
            raise RuntimeError("already cancelled")

    def fail_urlopen(*_args: Any, **_kwargs: Any) -> None:
        pytest.fail("urlopen must not be called for a pre-cancelled request")

    monkeypatch.setattr(urllib.request, "urlopen", fail_urlopen)

    with pytest.raises(RuntimeError, match="already cancelled"):
        list(
            stream_with_tools(
                FakeEngine(),
                prompt="hi",
                tools=[],
                cancel_handle=CancelledHandle(),
            )
        )
