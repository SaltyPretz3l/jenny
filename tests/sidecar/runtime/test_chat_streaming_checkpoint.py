from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.feature_flags import FEATURE_CANONICAL_TURN_EVENTS, FEATURE_PHASE_EVENTS
from sidecar.protocol import (
    CHAT_DONE_METHOD,
    CHAT_ERROR_METHOD,
    CHAT_PHASE_STARTED_METHOD,
)
from sidecar.runtime.chat_streaming import build_live_streaming_chat_response


class _SequenceEngine:
    def __init__(self, streams: list[list[SimpleNamespace]]) -> None:
        self.streams = list(streams)
        self.calls: list[dict[str, Any]] = []

    def stream(self, **kwargs: Any):
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        yield from self.streams.pop(0)

    def get_model_context_length(self) -> int:
        return 32_768

    def get_model_max_output_tokens(self) -> None:
        return None


def _thinking(text: str) -> SimpleNamespace:
    return SimpleNamespace(kind="thinking", text=text)


def _content(text: str) -> SimpleNamespace:
    return SimpleNamespace(kind="content", text=text)


def _done(reason: str) -> SimpleNamespace:
    return SimpleNamespace(kind="done", text="", finish_reason=reason)


def _response_for(engine: _SequenceEngine) -> Any:
    config = SimpleNamespace(
        mode="chat",
        engine_type="stub",
        model="stub-model",
        feature_flags={
            FEATURE_CANONICAL_TURN_EVENTS: True,
            FEATURE_PHASE_EVENTS: True,
        },
        system_prompt="System prompt for testing.",
        max_tokens=4096,
        tools_workspace_manifest_enabled=False,
        tools_task_capsule_enabled=False,
    )
    brain = SimpleNamespace(
        stack=SimpleNamespace(
            config=config,
            engine=engine,
            context_builder=ContextBuilder(None),
            memory_store=None,
            turn_diagnostics=None,
        )
    )
    return build_live_streaming_chat_response(
        request_id="req_checkpoint",
        trace_id=None,
        session_id=None,
        latest_user_content="Answer the question.",
        messages=[{"role": "user", "content": "Answer the question."}],
        brain_container=brain,
        reasoning_effort=None,
        learned_lessons=None,
        max_tokens=256,
    )


def _notifications(response: Any, method: str) -> list[dict[str, Any]]:
    return [item for item in response.notifications if item.get("method") == method]


def test_chat_checkpoint_continues_to_visible_answer() -> None:
    engine = _SequenceEngine(
        [
            [_thinking("reasoning pass one"), _done("thinking_budget")],
            [_content("Finished answer."), _done("stop")],
        ]
    )

    response = _response_for(engine)

    assert response.result["status"] == "completed"
    assert not _notifications(response, CHAT_ERROR_METHOD)
    assert len(_notifications(response, CHAT_DONE_METHOD)) == 1
    reasoning_phases = [
        item
        for item in _notifications(response, CHAT_PHASE_STARTED_METHOD)
        if item["params"]["phase_kind"] == "reasoning"
    ]
    assert len(reasoning_phases) == 2
    assert reasoning_phases[1]["params"]["summary"] == (
        "Continuing after thinking-budget checkpoint 1"
    )
    assert len(engine.calls) == 2
    assert engine.calls[1]["messages"][-2:] == [
        {
            "role": "assistant",
            "content": (
                "(my reasoning so far, continued after a thinking-budget checkpoint)\n"
                "reasoning pass one"
            ),
        },
        {
            "role": "system",
            "content": (
                "You hit a thinking-budget checkpoint. Your reasoning so far is preserved "
                "above. Act now - emit your tool calls or your final answer. Be decisive; "
                "do not restart your analysis."
            ),
        },
    ]


def test_chat_checkpoint_kill_switch_preserves_incomplete_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_CONTINUATION", "0")
    engine = _SequenceEngine(
        [
            [_thinking("reasoning pass one"), _done("thinking_budget")],
            [_content("Finished answer."), _done("stop")],
        ]
    )

    response = _response_for(engine)

    errors = _notifications(response, CHAT_ERROR_METHOD)
    assert len(errors) == 1
    assert errors[0]["params"]["code"] == "CMP-STREAM-INCOMPLETE"
    assert errors[0]["params"]["message"] == (
        "The model spent its entire thinking budget without reaching a final answer, so "
        "the turn was stopped. Retry, or lower the reasoning effort."
    )
    assert not _notifications(response, CHAT_DONE_METHOD)
    assert len(engine.calls) == 1


def test_chat_checkpoint_stops_when_reasoning_makes_no_progress() -> None:
    repeated_reasoning = "same detailed reasoning remains " * 500
    engine = _SequenceEngine(
        [
            [_thinking(repeated_reasoning), _done("thinking_budget")],
            [_thinking(repeated_reasoning), _done("thinking_budget")],
        ]
    )

    response = _response_for(engine)

    assert len(_notifications(response, CHAT_ERROR_METHOD)) == 1
    assert not _notifications(response, CHAT_DONE_METHOD)
    assert response.result["status"] == "runtime_error"
    assert response.result["terminal_subcode"] == "thinking_budget"
    assert len(engine.calls) == 2
