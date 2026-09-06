"""A turn that needs TWO tool approvals must be asked twice.

Owner repro, twice now. On 2026-08-21 a resumed turn that needed a second
approval settled silently with no output; that was fixed one layer down, in
``resume_chat_send_response_from_approval_plan``, which now pauses and returns
``status: "awaiting_approval"`` with the next ``approval_request`` attached
(covered by test_chat.py::...reprompts_for_a_second_approval).

The dispatcher never learned to consume it. ``process_chat_send_request``
handled approvals with a single ``if``, so the second request was built,
attached to the response, and dropped -- and the turn ended carrying a status
no consumer recognized. On 2026-08-26 that surfaced as two long turns dying
with "The request was denied." seconds after the owner clicked Approve.

So the fix moved the symptom rather than removing it, and this file is the
missing coverage: the loop, at the layer that drives it.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import sidecar.runtime.request_dispatch as rd
import sidecar.runtime.request_dispatch_chat as dispatch_chat
from sidecar.protocol import API_VERSION
from sidecar.runtime.approval import ApprovalResolution
from sidecar.runtime.chat_models import ChatRequestContext

LOGGER = logging.getLogger("test.multi_round_tool_approval")


class _NullContextManager:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *_args: Any) -> bool:
        return False


class _StubApprovalPlanCache:
    """Enough of the plan cache for the resume leg to find its plan."""

    # Mirrors the real signatures: put() takes the plan (which carries its own
    # ids), consume()/evict() take them separately. Only one plan is in flight
    # per round here, so a single slot is enough.
    def __init__(self) -> None:
        self.plan: Any = None

    def put(self, plan: Any, **_kwargs: Any) -> None:
        self.plan = plan

    def consume(self, _request_id: str, _call_id: str) -> Any:
        plan, self.plan = self.plan, None
        return plan

    def evict(self, _request_id: str, _call_id: str) -> None:
        self.plan = None


def test_plan_approval_context_forwards_edited_plan() -> None:
    edited_plan = {"title": "Edited", "steps": ["Build"]}
    context = ChatRequestContext(
        request_id="req", trace_id="trace", session_id="session", mode="plan",
        approvals_pre_granted=False, plan_mode=True, read_only=True,
    )

    updated = dispatch_chat._context_with_plan_approval(  # noqa: SLF001
        context,
        ApprovalResolution(
            approved=True,
            status="approved",
            decision="approved",
            feedback="",
            edited_plan=edited_plan,
        ),
    )

    assert updated.plan_decision == "approved"
    assert updated.edited_plan is edited_plan


def _approval_request(call_id: str, tool_name: str) -> dict[str, Any]:
    return {
        "tool_call_id": call_id,
        "tool_name": tool_name,
        "reason": f"{tool_name} requires approval",
        "request_id": "rq-two-approvals",
    }


def _response(*, approval_request: dict[str, Any] | None, status: str) -> SimpleNamespace:
    return SimpleNamespace(
        request_id="rq-two-approvals",
        result={"status": status, "request_id": "rq-two-approvals"},
        notifications=[],
        approval_request=approval_request,
        approval_plan=SimpleNamespace(approval_plan_hash="hash") if approval_request else None,
        post_settlement_callback=None,
    )


def test_a_turn_needing_two_approvals_is_asked_twice_and_completes(monkeypatch) -> None:
    approvals_asked: list[str] = []
    resume_calls: list[dict[str, Any]] = []

    # Every leg -- the initial one and each resume -- comes back through
    # _build_chat_response. The first asks for approval #1, the resumed leg asks
    # for #2, and the leg after THAT completes. Pre-fix the dispatcher stopped
    # after the first resume and returned its unconsumed "awaiting_approval".
    legs = [
        _response(approval_request=_approval_request("call-1", "edit_file"), status="awaiting_approval"),
        _response(approval_request=_approval_request("call-2", "write_file"), status="awaiting_approval"),
        _response(approval_request=None, status="completed"),
    ]

    def _fake_build_chat_response(**kwargs: Any):
        resume_calls.append(kwargs)
        return legs[len(resume_calls) - 1]

    def _fake_request_tool_approval(approval_request, **_kwargs: Any):  # noqa: ANN001
        approvals_asked.append(str(approval_request.get("tool_call_id")))
        return ApprovalResolution(approved=True, status="approved", decision="approved")

    monkeypatch.setattr(rd, "_build_chat_response", _fake_build_chat_response)
    monkeypatch.setattr(rd, "request_tool_approval", _fake_request_tool_approval)
    monkeypatch.setattr(rd, "_APPROVAL_PLAN_CACHE", _StubApprovalPlanCache())
    monkeypatch.setattr(
        "sidecar.runtime.request_dispatch_chat._effective_approval_wait_timeout",
        lambda *_a, **_k: 30.0,
    )

    config = SimpleNamespace(
        tools_workspace_root="/ws",
        agent_workspace_root=None,
        tools_enabled=True,
        feature_flags={},
        max_tools_per_turn=20,
        cloud_max_tools_per_turn=200,
    )
    brain = SimpleNamespace(
        stack=SimpleNamespace(config=config, engine=None, tool_observations=None),
        request_boundary=lambda *_a, **_k: _NullContextManager(),
    )

    outcome = rd.process_chat_send_request(
        message_id=1,
        params={"accept_version": API_VERSION, "request_id": "rq-two-approvals"},
        initialized=True,
        interactive_approval=True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=lambda _msg: None,
        read_message=lambda: {},
    )

    assert approvals_asked == ["call-1", "call-2"], (
        "both approvals must be put to the user; pre-fix only call-1 was asked"
    )
    assert len(resume_calls) == 3, (
        "one initial leg plus one resume per approval; pre-fix there were only 2"
    )
    assert outcome.response["result"]["status"] == "completed", (
        "the turn must finish, not settle on the unconsumed awaiting_approval status"
    )


def test_approval_rounds_are_bounded_by_the_turn_tool_budget(monkeypatch) -> None:
    """A turn that asks forever stops at its own tool budget, not never."""
    approvals_asked: list[str] = []

    def _always_asks(*_args: Any, **_kwargs: Any):
        return _response(
            approval_request=_approval_request("call-loop", "run_command"),
            status="awaiting_approval",
        )

    def _fake_request_tool_approval(approval_request, **_kwargs: Any):  # noqa: ANN001
        approvals_asked.append(str(approval_request.get("tool_call_id")))
        return ApprovalResolution(approved=True, status="approved", decision="approved")

    monkeypatch.setattr(rd, "build_chat_send_response", lambda *a, **k: _always_asks())
    monkeypatch.setattr(rd, "_build_chat_response", lambda **k: _always_asks())
    monkeypatch.setattr(rd, "request_tool_approval", _fake_request_tool_approval)
    monkeypatch.setattr(rd, "_APPROVAL_PLAN_CACHE", _StubApprovalPlanCache())
    monkeypatch.setattr(
        "sidecar.runtime.request_dispatch_chat._effective_approval_wait_timeout",
        lambda *_a, **_k: 30.0,
    )

    config = SimpleNamespace(
        tools_workspace_root="/ws",
        agent_workspace_root=None,
        tools_enabled=True,
        feature_flags={},
        max_tools_per_turn=3,
        cloud_max_tools_per_turn=3,
    )
    brain = SimpleNamespace(
        stack=SimpleNamespace(config=config, engine=None, tool_observations=None),
        request_boundary=lambda *_a, **_k: _NullContextManager(),
    )

    rd.process_chat_send_request(
        message_id=1,
        params={"accept_version": API_VERSION, "request_id": "rq-two-approvals"},
        initialized=True,
        interactive_approval=True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=lambda _msg: None,
        read_message=lambda: {},
    )

    assert len(approvals_asked) == 3, (
        "the loop must terminate at the turn's tool budget rather than spinning"
    )
