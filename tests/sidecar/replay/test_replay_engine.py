"""Meta-tests for the :class:`ReplayEngine` test double."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sidecar.ai.tools.models import StreamingEvent, ThinkingDelta
from tests.sidecar.replay.fixture_format import SCHEMA_VERSION, load_fixture
from tests.sidecar.replay.replay_engine import ReplayEngine, make_kernel


def _fixture_doc() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "metadata": {
            "fixture_family": "native_tool_schema_stream",
            "provider": "ollama",
            "model": "qwen2.5-coder:14b",
            "description": "Test fixture used by ReplayEngine meta-tests.",
            "target_phase": 3,
        },
        "raw_chunks": [],
        "expected_engine_events": [
            {"_class": "StreamingEvent", "kind": "content", "text": "hello"},
            {"_class": "ThinkingDelta", "text": "thinking out loud", "is_complete": True},
        ],
        "expected_loop_events": [],
        "expected_notifications": [],
        "expected_turn_events": [],
        "expected_generation_result": {
            "content": "hello",
            "thinking_text": "thinking out loud",
            "tool_calls": [
                {
                    "tool_id": "read_file",
                    "arguments": {"path": "README.md"},
                    "call_id": "call_1",
                }
            ],
            "finish_reason": "tool_calls",
        },
    }


def _write(tmp_path: Path, document: Any, name: str = "fixture.json") -> Path:
    target = tmp_path / name
    target.write_text(json.dumps(document), encoding="utf-8")
    return target


def test_replay_engine_yields_then_returns(tmp_path: Path) -> None:
    fixture = load_fixture(_write(tmp_path, _fixture_doc()))
    engine = ReplayEngine(fixture)
    stream = engine.stream_with_tools(prompt="hi", tools=[], max_tokens=128)
    yielded = list(stream)
    assert len(yielded) == 2
    assert isinstance(yielded[0], StreamingEvent)
    assert yielded[0].kind == "content"
    assert yielded[0].text == "hello"
    assert isinstance(yielded[1], ThinkingDelta)
    assert yielded[1].text == "thinking out loud"
    assert yielded[1].is_complete is True


def test_replay_engine_returns_generation_result(tmp_path: Path) -> None:
    fixture = load_fixture(_write(tmp_path, _fixture_doc()))
    engine = ReplayEngine(fixture)
    stream = engine.stream_with_tools()
    result: Any = None
    while True:
        try:
            next(stream)
        except StopIteration as stop:
            result = stop.value
            break
    assert result is not None
    assert result.content == "hello"
    assert result.thinking_text == "thinking out loud"
    assert result.finish_reason == "tool_calls"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_id == "read_file"
    assert result.tool_calls[0].call_id == "call_1"


def test_replay_engine_records_invocation_kwargs(tmp_path: Path) -> None:
    fixture = load_fixture(_write(tmp_path, _fixture_doc()))
    engine = ReplayEngine(fixture)
    list(engine.stream_with_tools(prompt="ask", tools=[], max_tokens=64))
    assert engine.recorded_calls == [{"prompt": "ask", "tools": [], "max_tokens": 64}]


def test_replay_engine_exposes_minimal_engine_surface(tmp_path: Path) -> None:
    fixture = load_fixture(_write(tmp_path, _fixture_doc()))
    engine = ReplayEngine(fixture, max_output_tokens=2048)
    assert engine.supports_tool_calling is True
    assert engine.get_model_max_output_tokens() == 2048


def test_make_kernel_provides_required_attributes(tmp_path: Path) -> None:
    fixture = load_fixture(_write(tmp_path, _fixture_doc()))
    engine = ReplayEngine(fixture)
    kernel = make_kernel(engine)
    assert kernel._engine is engine
    assert kernel._config.temperature == 0.0
    assert kernel._config.reasoning_effort is None
    assert kernel._config.feature_flags == {}
    assert kernel._system_prompt_for_engine("hi") == "hi"
