"""Mid-turn mail (row 70 W2a): the tool loop drains parked rows before its next generation."""

from __future__ import annotations

from typing import Any

from sidecar.ai.context.session_messages import SESSION_MESSAGE_PREAMBLE
from sidecar.ai.routing.loop_events import MailConsumedEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.protocol import API_VERSION
from sidecar.runtime.chat_serialization import _serialize_loop_event
from sidecar.runtime.turn_state import PendingMailQueue, bind_pending_mail

from ...runtime.test_multiplexer_mail_arrived import mail_row
from .test_tool_loop import (
    _build_router,
    _mermaid_descriptor,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)


class _MailDuringToolEngine(_ToolLoopEngine):
    """Parks one mail row while the first generation (the tool call) is in flight."""

    def __init__(self, plans: list[_ToolPlan], pending: PendingMailQueue, rows: list[dict[str, Any]]) -> None:
        super().__init__(plans)
        self._pending = pending
        self._rows = rows

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        if self.call_count == 0 and self._rows:
            self._pending.push(self._rows)
        return super().generate_with_tools(**kwargs)


def _plans() -> list[_ToolPlan]:
    return [
        _ToolPlan(
            result=GenerationResult(
                content="",
                finish_reason="tool_calls",
                tool_calls=(
                    ToolCallRequest(
                        tool_id="mermaid_generate",
                        arguments={"prompt": "flowchart TD\n  A --> B"},
                        call_id="call_mid_turn_mail",
                    ),
                ),
            )
        ),
        _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
    ]


def _run(rows: list[dict[str, Any]]) -> tuple[_ToolLoopEngine, list[Any]]:
    pending = PendingMailQueue()
    engine = _MailDuringToolEngine(_plans(), pending, rows)
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
    )
    events: list[Any] = []
    with bind_pending_mail(pending):
        router.build_chat_decision(
            request_id="req_mid_turn_mail",
            messages=[{"role": "user", "content": "Generate a diagram."}],
            latest_user_content="Generate a diagram.",
            mode="assist",
            approvals_pre_granted=True,
            runtime=LoopRuntime(request_id="req_mid_turn_mail", max_iterations=4, emit=events.append),
        )
    return engine, events


def _texts(request: dict[str, Any]) -> list[tuple[str, str]]:
    return [(str(m.get("role")), str(m.get("content") or "")) for m in request["messages"]]


def test_parked_mail_reaches_the_next_generation_after_the_tool_results() -> None:
    row = mail_row(1, body="Please also check the README.")
    engine, events = _run([row])

    assert engine.call_count == 2
    first, second = (_texts(request) for request in engine.requests)
    assert not any(SESSION_MESSAGE_PREAMBLE in text for _role, text in first)
    mail_index = next(i for i, (_role, text) in enumerate(second) if SESSION_MESSAGE_PREAMBLE in text)
    role, text = second[mail_index]
    assert role == "user"
    assert "Please also check the README." in text
    roles_before = [r for r, _t in second[:mail_index]]
    assert "tool" in roles_before, "the mail entry follows the tool results"
    assert mail_index == len(second) - 1

    consumed = [event for event in events if isinstance(event, MailConsumedEvent)]
    assert len(consumed) == 1
    assert consumed[0].message_ids == [row["session_message"]["message_id"]]
    assert consumed[0].iteration == 2


def test_empty_queue_changes_nothing() -> None:
    engine, events = _run([])

    assert engine.call_count == 2
    assert not any(SESSION_MESSAGE_PREAMBLE in text for request in engine.requests for _r, text in _texts(request))
    assert not any(isinstance(event, MailConsumedEvent) for event in events)


def test_mail_consumed_serializes_as_the_ephemeral_notification() -> None:
    event = MailConsumedEvent(message_ids=["m-1"], iteration=3)
    frame = _serialize_loop_event(event, "req-1", trace_id=None, session_id="session-dst")

    assert frame is not None
    assert frame["method"] == "session.mail_consumed"
    assert frame["params"] == {
        "api_version": API_VERSION,
        "request_id": "req-1",
        "session_id": "session-dst",
        "message_ids": ["m-1"],
        "iteration": 3,
    }
