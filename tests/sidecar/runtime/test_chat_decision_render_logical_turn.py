"""Canonical turn events rendered from a decision carry the logical turn id.

A resumed continuation runs under a fresh request id but belongs to the same
logical turn; its durable ``turn.event`` rows must join that turn, not start a
second one keyed by the transport request id.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.tools.models import GenerationResult
from sidecar.protocol import TURN_EVENT_METHOD
from sidecar.runtime.chat_decision_render import _chat_response_from_decision
from sidecar.runtime.chat_models import ChatRequestContext
from tests.sidecar.ai.routing.test_stream_incomplete_surfacing import _decision_for, _Engine
from tests.sidecar.runtime.test_chat_decision_render_plan_usage import _brain


def _turn_events(logical_turn_id: str | None) -> list[dict[str, Any]]:
    engine = _Engine(GenerationResult(content="", finish_reason="stop"))
    response = _chat_response_from_decision(
        request_context=ChatRequestContext(
            request_id="req_render_logical",
            trace_id=None,
            session_id="sess_render_logical",
            mode="chat",
            approvals_pre_granted=False,
            logical_turn_id=logical_turn_id,
        ),
        latest_user_content="Answer the question.",
        canonical_session_messages=[],
        session_title="",
        brain_container=_brain(engine=engine, feature_flags={"canonical_turn_events": True}),
        decision=_decision_for("stop"),
    )
    return [
        entry["params"]
        for entry in response.notifications
        if entry.get("method") == TURN_EVENT_METHOD
    ]


def test_canonical_turn_events_carry_the_logical_turn_id_when_bound() -> None:
    events = _turn_events("turn_logical_1")
    assert events, "a stop decision must render at least one canonical turn event"
    assert {event["turn_id"] for event in events} == {"turn_logical_1"}
    assert {event["stream_id"] for event in events} == {"req_render_logical"}


def test_canonical_turn_events_fall_back_to_the_request_id_without_a_logical_turn() -> None:
    events = _turn_events(None)
    assert events
    assert {event["turn_id"] for event in events} == {"req_render_logical"}
