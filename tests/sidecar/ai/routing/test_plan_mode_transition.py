from __future__ import annotations

import logging

import pytest

from sidecar.ai.context.builder_shared import RuntimeToolStatus
from sidecar.ai.context.runtime_message_markers import (
    APPROVED_PLAN_OVERLAY_HEADING,
    PLAN_MODE_OVERLAY_HEADING,
    RESTORED_TOOL_CONTRACT_HEADING,
    RUNTIME_SYSTEM_MESSAGE_HEADINGS,
)
from sidecar.ai.memory.contracts import MemoryPolicy
from sidecar.ai.routing.plan_mode_transition import (
    apply_restored_tool_contract,
    build_restored_tool_contract_overlay,
    transition_after_exit_outcome,
)
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_loop_calls import _ToolCallPhasesMixin
from sidecar.runtime.chat_models import ChatRequestContext


def _context() -> ChatRequestContext:
    return ChatRequestContext(
        request_id="request",
        trace_id="trace",
        session_id="session",
        mode="assist",
        approvals_pre_granted=False,
        memory_policy=MemoryPolicy(enabled=False, include_response_style=False),
        plan_mode=True,
        read_only=True,
    )


def _outcome(
    decision: str, *, cleared: bool = True, restored: str = "ask"
) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(
        tool_name="exit_plan_mode",
        output="ok",
        success=True,
        metadata={
            "plan_decision": decision,
            "plan_mode_cleared": cleared,
            "run_mode_restored": restored,
            "plan": {"title": "Approved plan", "steps": ["Implement it"]},
        },
    )


def test_restored_tool_contract_overlay_describes_available_and_blocked_tools() -> None:
    overlay = build_restored_tool_contract_overlay(
        tool_statuses=(
            RuntimeToolStatus(
                name="write_file",
                display_name="Write file",
                available=True,
                description="Write a workspace file.",
            ),
            # Production shape: ``available`` statuses never carry ``reason``;
            # a probe-blocked tool reports ``unmet_preconditions`` instead.
            RuntimeToolStatus(
                name="git_status",
                display_name="Git status",
                available=True,
                applicable=False,
                unmet_preconditions=("git_repo",),
            ),
        )
    )

    assert overlay.startswith(RESTORED_TOOL_CONTRACT_HEADING)
    assert "## Executable Tools" in overlay
    assert "supersedes" in overlay
    assert "Available now:\n- `write_file`: Write a workspace file." in overlay
    assert (
        "Available, but will fail until fixed:\n"
        "- `git_status` — requires a git repository; workspace_root is not one. "
        "Fix: none here."
    ) in overlay
    assert "capabilities are answered from this block" in overlay


def test_apply_restored_tool_contract_deduplicates_and_empty_is_noop() -> None:
    statuses = (
        RuntimeToolStatus(
            name="write_file",
            display_name="Write file",
            available=True,
            description="Write a workspace file.",
        ),
    )
    messages: list[dict[str, object]] = [{"role": "user", "content": "go"}]

    apply_restored_tool_contract(working_messages=messages, tool_statuses=statuses)
    apply_restored_tool_contract(working_messages=messages, tool_statuses=statuses)

    restored_rows = [
        row
        for row in messages
        if row.get("role") == "system"
        and str(row.get("content") or "").startswith(RESTORED_TOOL_CONTRACT_HEADING)
    ]
    assert len(restored_rows) == 1
    assert messages[-1] is restored_rows[0]

    untouched = [{"role": "user", "content": "keep"}]
    apply_restored_tool_contract(working_messages=untouched, tool_statuses=())
    assert untouched == [{"role": "user", "content": "keep"}]


def test_restored_tool_contract_heading_is_registered() -> None:
    assert RESTORED_TOOL_CONTRACT_HEADING in RUNTIME_SYSTEM_MESSAGE_HEADINGS


def test_approved_transition_replaces_plan_overlay_and_keeps_prompt_policy(
    caplog: pytest.LogCaptureFixture,
) -> None:
    messages: list[dict[str, object]] = [
        {"role": "system", "content": f"{PLAN_MODE_OVERLAY_HEADING}\nplan"},
        {"role": "user", "content": "go"},
    ]
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.plan_mode_transition")
    context = transition_after_exit_outcome(
        request_context=_context(), outcomes=[_outcome("approved")], working_messages=messages
    )
    assert context.plan_mode is False
    assert context.read_only is False
    assert context.approvals_pre_granted is False
    assert context.approval_mode == "prompt"
    assert not any(str(row.get("content", "")).startswith(PLAN_MODE_OVERLAY_HEADING) for row in messages)
    assert str(messages[-1]["content"]).startswith(APPROVED_PLAN_OVERLAY_HEADING)
    applied = next(
        record
        for record in caplog.records
        if getattr(record, "event", "") == "plan_mode.exit_transition_applied"
    )
    assert applied.levelno == logging.INFO
    assert applied.data == {
        "decision": "approved",
        "run_mode_restored": "ask",
        "approval_mode": "prompt",
    }


def test_approval_policy_follows_restored_mode_not_decision() -> None:
    auto = transition_after_exit_outcome(
        request_context=_context(),
        outcomes=[_outcome("approved", restored="auto")],
        working_messages=[],
    )
    assert auto.approval_mode == "auto_run"
    assert auto.approvals_pre_granted is False
    prompt = transition_after_exit_outcome(
        request_context=_context(),
        outcomes=[_outcome("approved_auto", restored="ask")],
        working_messages=[],
    )
    assert prompt.approval_mode == "prompt"


def test_approved_transition_defaults_to_prompt_without_restored_mode() -> None:
    context = transition_after_exit_outcome(
        request_context=_context(),
        outcomes=[
            ToolExecutionOutcome(
                tool_name="exit_plan_mode",
                output="ok",
                success=True,
                metadata={
                    "plan_decision": "approved",
                    "plan_mode_cleared": True,
                },
            )
        ],
        working_messages=[],
    )

    assert context.plan_mode is False
    assert context.read_only is False
    assert context.approval_mode == "prompt"


def test_approved_auto_transition_restores_auto_run() -> None:
    context = transition_after_exit_outcome(
        request_context=_context(),
        outcomes=[_outcome("approved_auto", restored="auto")],
        working_messages=[],
    )

    assert context.plan_mode is False
    assert context.read_only is False
    assert context.approval_mode == "auto_run"


@pytest.mark.parametrize(
    ("outcome", "declined_guard"),
    [
        (_outcome("approved", cleared=True), "success_not_true"),
        (_outcome("approved", cleared=False), "plan_mode_not_cleared"),
    ],
)
def test_declined_transition_retains_context_and_warns(
    outcome: ToolExecutionOutcome,
    declined_guard: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    if declined_guard == "success_not_true":
        outcome = ToolExecutionOutcome(
            tool_name=outcome.tool_name,
            output=outcome.output,
            success=False,
            metadata=outcome.metadata,
        )
    original = _context()
    messages = [{"role": "user", "content": "keep"}]
    caplog.set_level(logging.WARNING, logger="sidecar.ai.routing.plan_mode_transition")

    context = transition_after_exit_outcome(
        request_context=original,
        outcomes=[outcome],
        working_messages=messages,
    )

    assert context is original
    assert messages == [{"role": "user", "content": "keep"}]
    warning = next(
        record
        for record in caplog.records
        if getattr(record, "event", "") == "plan_mode.exit_transition_declined"
    )
    assert warning.levelno == logging.WARNING
    assert warning.data["declined_guard"] == declined_guard


def test_rejection_retains_plan_mode() -> None:
    rejected = transition_after_exit_outcome(
        request_context=_context(), outcomes=[_outcome("rejected", cleared=False)], working_messages=[]
    )
    assert rejected.plan_mode is True
    assert rejected.read_only is True
    assert rejected.approvals_pre_granted is False


def test_tool_loop_transition_updates_live_run_before_schema_reassembly() -> None:
    run = _ToolCallPhasesMixin()
    run.request_context = _context()
    run.working_messages = [
        {"role": "system", "content": f"{PLAN_MODE_OVERLAY_HEADING}\nplan"}
    ]
    run.plan_mode = True
    run.read_only = True
    run.approvals_pre_granted = True

    assert run._apply_plan_mode_transition(
        [_outcome("approved_auto", restored="auto")]
    ) is True
    assert run.request_context.approval_mode == "auto_run"
    assert run.plan_mode is False
    assert run.read_only is False
    assert run.approvals_pre_granted is False
    assert str(run.working_messages[-1]["content"]).startswith(
        APPROVED_PLAN_OVERLAY_HEADING
    )


def test_tool_loop_transition_reports_false_without_plan_exit() -> None:
    run = _ToolCallPhasesMixin()
    run.request_context = _context()
    run.working_messages = []
    run.plan_mode = True
    run.read_only = True
    run.approvals_pre_granted = True

    assert run._apply_plan_mode_transition([]) is False
