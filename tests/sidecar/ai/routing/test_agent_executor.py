from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.feature_flags import FEATURE_TASK_LIFECYCLE
from sidecar.ai.routing.agent_executor import AgentExecutor
from sidecar.ai.routing.router import ChatDecision
from sidecar.runtime.chat_models import ChatRequestContext, TerminalChatStateError
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED


class _Router:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.error = error

    def build_chat_decision(self, **kwargs: Any) -> ChatDecision:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return ChatDecision(
            thinking_text=None,
            response_text="done",
            approval_request=None,
            tool_results=(),
        )


def _context() -> ChatRequestContext:
    return ChatRequestContext(
        request_id="req-1",
        trace_id="trace-1",
        session_id="session-1",
        mode="assist",
        approvals_pre_granted=True,
        plan_mode=True,
        agent_id="main@req-1",
    )


def test_executor_routes_once_without_hidden_planner_or_verifier_calls() -> None:
    router = _Router()
    events = []
    executor = AgentExecutor(
        router=router,
        on_progress=events.append,
        feature_flags={},
    )

    decision = executor.execute(
        request_context=_context(),
        messages=[{"role": "user", "content": "plan this"}],
        latest_user_content="plan this",
        runtime=SimpleNamespace(),
    )

    assert decision.response_text == "done"
    assert len(router.calls) == 1
    assert router.calls[0]["plan_mode"] is True
    assert [event.stage for event in events] == [
        "task_created",
        "tool_loop",
        "finalizing",
        "complete",
    ]
    assert events[-1].terminal is True
    assert events[-1].success is True


def test_executor_repairs_tool_pairing_only_when_task_lifecycle_enabled() -> None:
    router = _Router()
    executor = AgentExecutor(
        router=router,
        feature_flags={FEATURE_TASK_LIFECYCLE: True},
    )
    messages = [
        {"role": "assistant", "tool_calls": [{"id": "call-1", "type": "function"}]},
        {"role": "user", "content": "continue"},
    ]

    executor.execute(
        request_context=_context(),
        messages=messages,
        latest_user_content="continue",
    )

    routed = router.calls[0]["messages"]
    assert isinstance(routed, list)
    assert len(routed) >= len(messages)


def test_executor_emits_cancelled_terminal_progress() -> None:
    router = _Router(
        error=TerminalChatStateError(
            status=TURN_STATE_CANCELLED,
            terminal_subcode="user_cancel",
            message="cancelled",
        )
    )
    events = []
    executor = AgentExecutor(router=router, on_progress=events.append)

    with pytest.raises(TerminalChatStateError):
        executor.execute(
            request_context=_context(),
            messages=[],
            latest_user_content="",
        )

    assert events[-1].stage == "cancelled"
    assert events[-1].status == "cancelled"
    assert events[-1].terminal_subcode == "user_cancel"
    assert events[-1].terminal is True


def test_executor_records_generic_router_failure() -> None:
    secret_diagnostic = "token=sk-secret local_path=C:/private/repo"
    router = _Router(error=RuntimeError(secret_diagnostic))
    events = []
    executor = AgentExecutor(router=router, on_progress=events.append)

    with pytest.raises(RuntimeError, match="token=sk-secret"):
        executor.execute(
            request_context=_context(),
            messages=[],
            latest_user_content="",
        )

    assert events[-1].stage == "failed"
    assert events[-1].status == "failed"
    assert events[-1].summary == "Agent execution failed."
    assert secret_diagnostic not in events[-1].summary
    assert events[-1].terminal is True
    assert events[-1].success is False


def test_executor_forwards_optional_router_arguments_without_mutating_messages() -> None:
    router = _Router()
    executor = AgentExecutor(router=router, on_progress=None)
    messages = [{"role": "user", "content": "inspect"}]
    original = [dict(message) for message in messages]
    lessons = []
    canonical = [{"role": "assistant", "content": "prior"}]
    runtime = SimpleNamespace(name="runtime")

    decision = executor.execute(
        request_context=_context(),
        messages=messages,
        latest_user_content="inspect",
        learned_lessons=lessons,
        canonical_session_messages=canonical,
        runtime=runtime,
    )

    assert decision.response_text == "done"
    assert messages == original
    assert router.calls[0]["learned_lessons"] is lessons
    assert router.calls[0]["canonical_session_messages"] is canonical
    assert router.calls[0]["runtime"] is runtime
    assert router.calls[0]["tool_preferences"] is None


def test_executor_emits_completed_request_lifecycle() -> None:
    events = []
    executor = AgentExecutor(router=_Router(), on_progress=events.append)
    executor.execute(
        request_context=_context(),
        messages=[],
        latest_user_content="",
    )

    assert [event.stage for event in events] == [
        "task_created",
        "tool_loop",
        "finalizing",
        "complete",
    ]
    assert events[-1].status == "completed"
    assert events[-1].terminal is True


def test_executor_emits_distinct_lifecycles_between_requests() -> None:
    events = []
    executor = AgentExecutor(router=_Router(), on_progress=events.append)
    executor.execute(
        request_context=_context(),
        messages=[],
        latest_user_content="first",
    )
    second_context = ChatRequestContext(
        request_id="req-2",
        trace_id="trace-2",
        session_id="session-1",
        mode="assist",
        approvals_pre_granted=True,
        plan_mode=False,
        agent_id="main@req-2",
    )
    executor.execute(
        request_context=second_context,
        messages=[],
        latest_user_content="second",
    )

    completed = [event for event in events if event.stage == "complete"]
    assert len(completed) == 2
    assert completed[0].task_id != completed[1].task_id
    assert completed[1].agent_id == "main@req-2"
