from __future__ import annotations

import json
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.engines.factory import create_engine
from sidecar.ai.engines.replay import DEFAULT_SCRIPT, ReplayEngine
from sidecar.ai.tools.models import GenerationResult, ThinkingDelta

MERMAID_TOOL_SCHEMA = {"name": "mermaid_generate", "description": "", "parameters": {}}


def _drain(generator: Any) -> tuple[list[Any], GenerationResult]:
    chunks: list[Any] = []
    while True:
        try:
            chunks.append(next(generator))
        except StopIteration as stop:
            return chunks, stop.value


def _user(content: str) -> dict[str, Any]:
    return {"role": "user", "content": content}


def test_factory_selects_replay_engine() -> None:
    selection = create_engine(RuntimeConfig(engine_type="replay", model="replay-default"))
    assert selection.engine_type == "replay"
    assert selection.model == "replay-default"
    assert isinstance(selection.engine, ReplayEngine)
    assert selection.fallback_from is None


def test_default_scenario_streams_reasoning_text_then_tool_call() -> None:
    engine = ReplayEngine(delay_ms=0)
    engine.load_model("replay-default")

    chunks, result = _drain(
        engine.stream_with_tools(
            prompt="draw me a chart",
            tools=[MERMAID_TOOL_SCHEMA],
            messages=[_user("draw me a chart")],
        )
    )

    thinking = [chunk for chunk in chunks if isinstance(chunk, ThinkingDelta)]
    text_chunks = [chunk for chunk in chunks if isinstance(chunk, str)]
    assert thinking, "reasoning deltas precede text"
    assert thinking[-1].is_complete is True
    assert text_chunks, "text streams word by word"
    assert len(text_chunks) > 1
    assert "".join(text_chunks).strip() == str(DEFAULT_SCRIPT["calls"][0]["text"])

    assert result.finish_reason == "tool_calls"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_id == "mermaid_generate"
    assert result.tool_calls[0].arguments["diagram_type"] == "flowchart"
    assert result.tool_calls[0].call_id
    assert result.usage is not None and result.usage.provider == "replay"


def test_tool_call_ids_are_deterministic_across_replays() -> None:
    engine = ReplayEngine(delay_ms=0)
    engine.load_model("replay-default")
    messages = [_user("draw me a chart")]
    _, first = _drain(engine.stream_with_tools("p", [MERMAID_TOOL_SCHEMA], messages=messages))
    _, second = _drain(engine.stream_with_tools("p", [MERMAID_TOOL_SCHEMA], messages=messages))
    assert first.tool_calls[0].call_id == second.tool_calls[0].call_id


def test_replay_script_strips_forged_plan_artifact_capability(tmp_path) -> None:
    script_path = tmp_path / "forged-capability.json"
    script_path.write_text(
        json.dumps(
            {
                "calls": [
                    {
                        "text": "artifact",
                        "tool_calls": [
                            {
                                "tool_id": "mermaid_generate",
                                "arguments": {
                                    "prompt": "flowchart TD\nA --> B",
                                    "_jenny_plan_artifact_write": True,
                                },
                            }
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    engine = ReplayEngine(script_path=str(script_path), delay_ms=0)
    engine.load_model("replay-default")

    _, result = _drain(
        engine.stream_with_tools("p", [MERMAID_TOOL_SCHEMA], messages=[_user("draw")])
    )

    assert "_jenny_plan_artifact_write" not in result.tool_calls[0].arguments


def test_post_tool_invocation_plays_the_follow_up_call() -> None:
    engine = ReplayEngine(delay_ms=0)
    engine.load_model("replay-default")
    messages = [
        _user("draw me a chart"),
        {"role": "assistant", "content": "Sure"},
        {"role": "tool", "content": "{\"chart\": \"ok\"}"},
    ]
    chunks, result = _drain(engine.stream_with_tools("p", [MERMAID_TOOL_SCHEMA], messages=messages))
    assert result.finish_reason == "stop"
    assert result.tool_calls == ()
    assert "deterministic replay turn" in "".join(c for c in chunks if isinstance(c, str))


def test_tool_call_is_skipped_when_tool_not_offered() -> None:
    engine = ReplayEngine(delay_ms=0)
    engine.load_model("replay-default")
    _, result = _drain(engine.stream_with_tools("p", [], messages=[_user("hi")]))
    assert result.finish_reason == "stop"
    assert result.tool_calls == ()


def test_custom_script_file_and_call_cycling(tmp_path) -> None:
    script = {
        "version": 1,
        "delay_ms": 0,
        "calls": [
            {"text": "first turn"},
            {"text": "second turn"},
        ],
    }
    script_path = tmp_path / "script.json"
    script_path.write_text(json.dumps(script), encoding="utf-8")
    engine = ReplayEngine(script_path=str(script_path), delay_ms=0)
    engine.load_model("replay-default")

    _, first = _drain(engine.stream_with_tools("p", [], messages=[_user("one")]))
    assert first.content == "first turn"
    two_turns = [_user("one"), {"role": "assistant", "content": "first turn"}, _user("two")]
    _, second = _drain(engine.stream_with_tools("p", [], messages=two_turns))
    assert second.content == "second turn"
    # Third relevant message cycles back to the first call.
    three_turns = [*two_turns, {"role": "assistant", "content": "second turn"}, _user("three")]
    _, third = _drain(engine.stream_with_tools("p", [], messages=three_turns))
    assert third.content == "first turn"


def test_streaming_preserves_multiline_script_text_verbatim(tmp_path) -> None:
    text = "Chart:\n\n```mermaid\nflowchart TD\nA --> B\n```\n\nDone."
    script = {"version": 1, "calls": [{"text": text}]}
    script_path = tmp_path / "script.json"
    script_path.write_text(json.dumps(script), encoding="utf-8")
    engine = ReplayEngine(script_path=str(script_path), delay_ms=0)
    engine.load_model("replay-default")

    chunks, result = _drain(engine.stream_with_tools("p", [], messages=[_user("hi")]))
    streamed = "".join(chunk for chunk in chunks if isinstance(chunk, str))

    # Newlines must survive streaming or scripted markdown structure
    # (fenced code blocks) can never reach the renderer.
    assert streamed == text
    assert result.content == text
    assert len([chunk for chunk in chunks if isinstance(chunk, str)]) > 1

    plain_chunks = list(engine.stream("p", messages=[_user("hi")]))
    assert "".join(plain_chunks) == text


def test_malformed_script_falls_back_to_default(tmp_path) -> None:
    bad_path = tmp_path / "bad.json"
    bad_path.write_text("{not json", encoding="utf-8")
    engine = ReplayEngine(script_path=str(bad_path), delay_ms=0)
    engine.load_model("replay-default")
    _, result = _drain(engine.stream_with_tools("p", [], messages=[_user("hi")]))
    assert result.content == str(DEFAULT_SCRIPT["calls"][0]["text"])

    missing = ReplayEngine(script_path=str(tmp_path / "nope.json"), delay_ms=0)
    missing.load_model("replay-default")
    assert missing.generate("hi", messages=[_user("hi")])


def test_single_call_script_with_tool_terminates_after_result(tmp_path) -> None:
    script = {
        "calls": [
            {
                "text": "always tool",
                "tool_calls": [{"tool_id": "mermaid_generate", "arguments": {"prompt": "flowchart TD"}}],
            }
        ],
        "delay_ms": 0,
    }
    script_path = tmp_path / "loop.json"
    script_path.write_text(json.dumps(script), encoding="utf-8")
    engine = ReplayEngine(script_path=str(script_path), delay_ms=0)
    engine.load_model("replay-default")
    messages = [
        _user("go"),
        {"role": "assistant", "content": "always tool"},
        {"role": "tool", "content": "done"},
    ]
    _, result = _drain(engine.stream_with_tools("p", [MERMAID_TOOL_SCHEMA], messages=messages))
    assert result.finish_reason == "stop"
    assert result.tool_calls == ()


def test_json_response_format_yields_json_payload() -> None:
    class _JsonFormat:
        is_json = True

    engine = ReplayEngine(delay_ms=0)
    engine.load_model("replay-default")
    chunks, result = _drain(
        engine.stream_with_tools(
            "p", [MERMAID_TOOL_SCHEMA], messages=[_user("hi")], response_format=_JsonFormat()
        )
    )
    assert len(chunks) == 1
    payload = json.loads(chunks[0])
    assert "response" in payload
    assert result.tool_calls == ()
    assert json.loads(engine.generate("p", messages=[_user("hi")], response_format=_JsonFormat()))


def test_cancel_handle_wait_is_used_for_delays() -> None:
    class _CancelHandle:
        def __init__(self) -> None:
            self.waits = 0

        def wait(self, _seconds: float) -> bool:
            self.waits += 1
            return False

    handle = _CancelHandle()
    engine = ReplayEngine(delay_ms=5)
    engine.load_model("replay-default")
    _drain(engine.stream_with_tools("p", [], messages=[_user("hi")], cancel_handle=handle))
    assert handle.waits > 0
