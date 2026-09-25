from __future__ import annotations

import logging
from dataclasses import replace

import pytest

from sidecar.ai.context.builder_shared import RuntimeToolStatus
from sidecar.ai.context.prompt_modes import build_approved_plan_overlay
from sidecar.ai.context.runtime_message_markers import (
    APPROVED_PLAN_OVERLAY_HEADING,
    PLAN_MODE_OVERLAY_HEADING,
    PLAN_REVISION_OVERLAY_HEADING,
    RESTORED_TOOL_CONTRACT_HEADING,
    RUNTIME_SYSTEM_MESSAGE_HEADINGS,
)
from sidecar.ai.engines.chatgpt_subscription_request import build_input_items
from sidecar.ai.memory.contracts import MemoryPolicy
from sidecar.ai.routing.engine_messages import engine_messages
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
    assert messages[0] is restored_rows[0]

    untouched = [{"role": "user", "content": "keep"}]
    apply_restored_tool_contract(working_messages=untouched, tool_statuses=())
    assert untouched == [{"role": "user", "content": "keep"}]


@pytest.mark.parametrize("decision", ["approved", "approved_auto"])
def test_confirmed_exit_survives_provider_instruction_serialization(decision: str) -> None:
    messages = [
        {"role": "system", "content": "Base read-only tool digest"},
        {"role": "system", "content": f"{PLAN_MODE_OVERLAY_HEADING}\nplan"},
        {"role": "user", "content": "Build it"},
        {"role": "assistant", "content": "Submitting plan"},
    ]
    context = transition_after_exit_outcome(
        request_context=_context(), outcomes=[_outcome(decision)], working_messages=messages
    )
    apply_restored_tool_contract(
        working_messages=messages,
        tool_statuses=(RuntimeToolStatus(
            name="write_file", display_name="Write file", available=True,
        ),),
    )
    normalized = engine_messages(messages, primary_system_text="Base read-only tool digest")
    instructions, items = build_input_items(
        prompt="", system="Base read-only tool digest", messages=normalized
    )
    assert context.read_only is False
    assert RESTORED_TOOL_CONTRACT_HEADING in instructions
    assert APPROVED_PLAN_OVERLAY_HEADING in instructions
    assert PLAN_MODE_OVERLAY_HEADING not in instructions
    assert "`write_file`" in instructions
    assert not any(RESTORED_TOOL_CONTRACT_HEADING in str(item) for item in items)


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
    assert str(messages[0]["content"]).startswith(APPROVED_PLAN_OVERLAY_HEADING)
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


def test_edited_approval_overlay_says_the_edit_supersedes_the_proposal() -> None:
    plan = {"title": "Edited plan", "steps": ["Use the edited step"]}
    edited = _outcome("approved")
    edited.metadata["plan"] = plan
    edited.metadata["plan_edited"] = True
    edited_messages: list[dict[str, object]] = []

    transition_after_exit_outcome(
        request_context=_context(),
        outcomes=[edited],
        working_messages=edited_messages,
    )

    edited_overlay = str(edited_messages[0]["content"])
    supersedes = (
        "The user edited this plan before approving it; it supersedes the plan in "
        "your exit_plan_mode call."
    )
    assert supersedes in edited_overlay
    assert "1. Use the edited step" in edited_overlay

    unedited_messages: list[dict[str, object]] = []
    unedited = _outcome("approved")
    unedited.metadata["plan"] = plan
    transition_after_exit_outcome(
        request_context=_context(),
        outcomes=[unedited],
        working_messages=unedited_messages,
    )

    unedited_overlay = str(unedited_messages[0]["content"])
    assert supersedes not in unedited_overlay
    assert unedited_overlay == build_approved_plan_overlay(plan)


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


def _revision_overlays(messages: list[dict[str, object]]) -> list[str]:
    return [
        str(message["content"])
        for message in messages
        if message.get("role") == "system"
        and str(message.get("content") or "").startswith(PLAN_REVISION_OVERLAY_HEADING)
    ]


def test_rejection_carries_the_user_feedback_as_a_system_instruction() -> None:
    # Gate C1 2026-09-24: the feedback arrived only inside the untrusted tool
    # result, and the model called it an injected redirect and ignored it.
    messages: list[dict[str, object]] = [
        {"role": "system", "content": f"{PLAN_MODE_OVERLAY_HEADING}\nPlan only."},
        {"role": "user", "content": "Plan to add the word 'kiwi' to the readme."},
    ]
    context = replace(_context(), plan_feedback="instead of kiwi, plan to add 'strawberry'")
    rejected = transition_after_exit_outcome(
        request_context=context,
        outcomes=[_outcome("rejected", cleared=False)],
        working_messages=messages,
    )
    overlays = _revision_overlays(messages)
    assert len(overlays) == 1
    assert "User feedback: instead of kiwi, plan to add 'strawberry'" in overlays[0]
    assert "user's own instruction" in overlays[0]
    assert "exit_plan_mode" in overlays[0]
    assert rejected.plan_feedback == ""
    # Leading system run, so providers keep it at system authority.
    assert [message["role"] for message in messages] == ["system", "system", "user"]
    assert PLAN_REVISION_OVERLAY_HEADING in RUNTIME_SYSTEM_MESSAGE_HEADINGS


def test_second_rejection_replaces_and_approval_drops_the_revision_overlay() -> None:
    messages: list[dict[str, object]] = [{"role": "user", "content": "Plan it."}]
    for feedback in ("use banana", "<no feedback given>"):
        transition_after_exit_outcome(
            request_context=replace(_context(), plan_feedback=feedback),
            outcomes=[_outcome("rejected", cleared=False)],
            working_messages=messages,
        )
    overlays = _revision_overlays(messages)
    assert len(overlays) == 1
    assert "User feedback" not in overlays[0]
    assert "no written feedback" in overlays[0]
    transition_after_exit_outcome(
        request_context=_context(), outcomes=[_outcome("approved")], working_messages=messages
    )
    assert _revision_overlays(messages) == []


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


def test_accepted_transition_keeps_plan_mode_and_requests_one_toolless_reply() -> None:
    messages: list[dict[str, object]] = [
        {"role": "system", "content": f"{PLAN_MODE_OVERLAY_HEADING}\nplan"},
    ]
    context = transition_after_exit_outcome(
        request_context=_context(),
        outcomes=[_outcome("accepted", cleared=False)],
        working_messages=messages,
    )
    assert context.plan_mode is True
    assert context.read_only is True
    assert context.final_toolless_reply is True
    assert context.plan_decision == ""
    assert str(messages[0]["content"]).startswith(PLAN_MODE_OVERLAY_HEADING)


def test_accepted_that_claims_plan_mode_cleared_is_declined_unchanged() -> None:
    original = _context()
    context = transition_after_exit_outcome(
        request_context=original,
        outcomes=[_outcome("accepted", cleared=True)],
        working_messages=[],
    )
    assert context is original
    assert context.final_toolless_reply is False


def test_exit_transition_is_a_no_op_once_plan_mode_is_off(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Owner gate 2026-09-20 (scenario C): the transition applied repeatedly.

    After the first approved exit the context has plan_mode=False. A later call
    that still sees the exit outcome must not strip the overlay again, insert a
    second approved-plan overlay, or log a second "applied".
    """
    working_messages: list[dict[str, object]] = [
        {"role": "system", "content": f"{PLAN_MODE_OVERLAY_HEADING}\nplanning"},
        {"role": "user", "content": "Build it."},
    ]
    outcome = _outcome("approved")
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.plan_mode_transition")
    first = transition_after_exit_outcome(
        request_context=_context(),
        outcomes=[outcome],
        working_messages=working_messages,
    )
    assert first.plan_mode is False
    overlays_after_first = [
        message
        for message in working_messages
        if str(message.get("content") or "").startswith(APPROVED_PLAN_OVERLAY_HEADING)
    ]
    assert len(overlays_after_first) == 1

    caplog.clear()
    snapshot = [dict(message) for message in working_messages]
    second = transition_after_exit_outcome(
        request_context=first,
        outcomes=[outcome],
        working_messages=working_messages,
    )
    assert second is first, "an already-off context is returned as-is"
    assert working_messages == snapshot, "no overlay churn on the repeat"
    assert not any("exit_transition_applied" in record.getMessage() or getattr(record, "event", "") == "plan_mode.exit_transition_applied" for record in caplog.records)

    never_in_plan_mode = replace(_context(), plan_mode=False, read_only=False)
    assert transition_after_exit_outcome(
        request_context=never_in_plan_mode,
        outcomes=[outcome],
        working_messages=working_messages,
    ) is never_in_plan_mode
