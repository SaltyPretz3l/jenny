"""A failed delegate helper reports an ``error`` field, never its error text as the answer."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.routing import delegate as delegate_module
from sidecar.ai.routing import subagent_scheduler as scheduler_module
from sidecar.ai.routing.delegate import execute_delegate_tool
from sidecar.ai.routing.delegate_contracts import (
    MAX_DELEGATE_OUTPUT_CHARS,
    build_compact_delegate_settlement,
    validate_delegate_arguments,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatDecision, ToolExecutionOutcome
from sidecar.ai.routing.sub_agent_invocation import SubAgentInvocationResult
from sidecar.ai.routing.subagent_scheduler import DelegateSchedule, ScheduledInvocation
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.multiplexer import SubAgentSlotAllocator


def _failed_report(ordinal: int, message: str = "Provider timed out.", **extra: Any) -> dict:
    # Same shape delegate._task_report builds: summary falls back to the error text.
    report: dict[str, Any] = {
        "ordinal": ordinal,
        "status": "failed",
        "summary": message,
        "answer": "",
        "evidence": [],
        "error": {"code": "CMP-TOOL-0001", "message": message, "retryable": False},
    }
    report.update(extra)
    return report


def _done_report(ordinal: int, answer: str = "Found it.") -> dict:
    return {"ordinal": ordinal, "status": "completed", "answer": answer, "evidence": []}


def test_failed_helper_has_empty_answer_and_an_error_field() -> None:
    settlement = build_compact_delegate_settlement(
        execution="parallel", task_reports=[_done_report(1), _failed_report(2)]
    )

    done, failed = settlement.report["results"]
    assert done == {"ordinal": 1, "status": "completed", "answer": "Found it.", "evidence": []}
    assert "error" not in done
    assert failed["status"] == "failed"
    assert failed["answer"] == ""
    assert failed["error"] == "Provider timed out."
    assert "Provider timed out." not in json.dumps(done)


def test_failed_helper_without_an_error_record_still_reports_an_error_not_an_answer() -> None:
    settlement = build_compact_delegate_settlement(
        execution="single",
        task_reports=[{"ordinal": 1, "status": "failed", "summary": "", "evidence": []}],
    )

    [item] = settlement.report["results"]
    assert item["answer"] == ""
    assert item["error"]


def test_cancelled_helper_has_empty_answer_and_an_error_field() -> None:
    cancelled = {
        "ordinal": 2,
        "status": "cancelled",
        "summary": "Sub-agent cancelled.",
        "answer": "stale half answer",
        "evidence": [],
        "error": {"code": "CMP-TOOL-0001", "message": "Sub-agent cancelled.", "retryable": False},
    }
    settlement = build_compact_delegate_settlement(
        execution="parallel", task_reports=[_done_report(1), cancelled]
    )

    item = settlement.report["results"][1]
    assert item["answer"] == ""
    assert item["error"] == "Sub-agent cancelled."


def test_partial_helper_keeps_its_findings_and_carries_the_reason_in_error() -> None:
    partial = {
        "ordinal": 1,
        "status": "partial",
        "answer": "Two of three files read.",
        "evidence": [],
        "error": {"code": "CMP-TOOL-0001", "message": "Ran out of steps.", "retryable": False},
    }
    plain_partial = {"ordinal": 2, "status": "partial", "answer": "Half.", "evidence": []}
    settlement = build_compact_delegate_settlement(
        execution="parallel", task_reports=[partial, plain_partial]
    )

    first, second = settlement.report["results"]
    assert first["answer"] == "Two of three files read."
    assert first["error"] == "Ran out of steps."
    assert "error" not in second


def test_completed_helper_never_carries_an_error_key() -> None:
    report = _done_report(1)
    report["error"] = {"code": "x", "message": "ignored", "retryable": False}

    settlement = build_compact_delegate_settlement(execution="single", task_reports=[report])

    assert "error" not in settlement.report["results"][0]


def test_error_text_is_redacted_and_bounded_like_other_helper_text() -> None:
    long_message = "bad " * 200
    settlement = build_compact_delegate_settlement(
        execution="single", task_reports=[_failed_report(1, long_message)]
    )

    error = settlement.report["results"][0]["error"]
    assert 0 < len(error) <= 300


def test_summary_counts_finished_and_failed_helpers_when_any_failed() -> None:
    settlement = build_compact_delegate_settlement(
        execution="parallel",
        task_reports=[_done_report(1), _done_report(2), _failed_report(3)],
    )

    assert settlement.report["summary"] == "2 of 3 investigations finished; 1 failed (see its error)."
    assert json.loads(settlement.output)["summary"] == settlement.report["summary"]
    assert settlement.success is True
    assert settlement.status == "partial"


def test_summary_uses_plural_wording_for_several_failures() -> None:
    settlement = build_compact_delegate_settlement(
        execution="parallel",
        task_reports=[_done_report(1), _failed_report(2), _failed_report(3)],
    )

    assert settlement.report["summary"] == (
        "1 of 3 investigations finished; 2 failed (see their errors)."
    )
    assert settlement.success is True


def test_summary_is_absent_when_nothing_failed() -> None:
    settlement = build_compact_delegate_settlement(
        execution="parallel", task_reports=[_done_report(1), _done_report(2)]
    )

    assert "summary" not in settlement.report
    assert "summary" not in json.loads(settlement.output)


def test_all_failed_call_is_unsuccessful_and_names_the_first_error() -> None:
    settlement = build_compact_delegate_settlement(
        execution="parallel",
        task_reports=[_failed_report(1, "Model went away."), _failed_report(2, "Second.")],
    )

    assert settlement.success is False
    assert settlement.status == "failed"
    assert "Model went away." in settlement.report["summary"]
    assert "Second." not in settlement.report["summary"]
    assert settlement.report["summary"].startswith("None of the 2 investigations finished")


def test_single_failed_helper_summary_names_its_error() -> None:
    settlement = build_compact_delegate_settlement(
        execution="single", task_reports=[_failed_report(1, "Model went away.")]
    )

    assert settlement.success is False
    assert settlement.report["summary"] == "The investigation failed: Model went away."


def test_bound_still_holds_with_error_fields_counted() -> None:
    reports = [
        {
            "ordinal": ordinal,
            "status": "partial",
            "answer": "a" * 2_500,
            "evidence": [],
            "error": {"code": "x", "message": "e" * 300, "retryable": False},
        }
        for ordinal in (1, 2, 3)
    ]
    reports[2] = _failed_report(3, "f" * 300)

    settlement = build_compact_delegate_settlement(execution="parallel", task_reports=reports)

    assert len(settlement.output) <= MAX_DELEGATE_OUTPUT_CHARS
    assert all(item.get("error") for item in settlement.report["results"])
    assert settlement.report["results"][2]["answer"] == ""


def _context() -> ChatRequestContext:
    return ChatRequestContext(
        request_id="parent-request",
        trace_id="trace",
        session_id="session",
        mode="assist",
        approvals_pre_granted=True,
        agent_id="main@parent-request",
        workspace_root_present=True,
    )


def _invocation(task: Any, result: SubAgentInvocationResult) -> ScheduledInvocation:
    identity = scheduler_module.build_sub_agent_identity(
        parent_request_id="parent-request",
        canonical_call_id="call",
        parent_agent_id="main@parent-request",
        ordinal=task.ordinal,
        operation="delegate",
    )
    return ScheduledInvocation(task, identity, result, 10, 8, 120_000, True)


def test_execute_delegate_reports_a_failed_helper_as_error_and_keeps_the_rich_card_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = validate_delegate_arguments({"tasks": ["one", "two"]})
    good = SubAgentInvocationResult(
        status="completed",
        response_text="Entry point is main.js.",
        decision=ChatDecision(
            thinking_text=None,
            response_text="Entry point is main.js.",
            approval_request=None,
            tool_results=(),
        ),
        iterations_used=1,
    )
    bad = SubAgentInvocationResult(
        status="failed",
        error_code="CMP-TOOL-0001",
        error_message="Provider timed out.",
        iterations_used=1,
    )
    schedule = DelegateSchedule(
        execution="parallel",
        invocations=(_invocation(request.tasks[0], good), _invocation(request.tasks[1], bad)),
        effective_max_total_runtime_ms=120_000,
        parent_synthesis_reserve_ms=0,
    )
    monkeypatch.setattr(delegate_module, "schedule_delegate_tasks", lambda **_kwargs: schedule)
    runtime = LoopRuntime(
        request_id="parent-request",
        trace_id="trace",
        session_id="session",
        request_context=_context(),
        sub_agent_slot_allocator=SubAgentSlotAllocator(
            max_active_sub_agents=3, max_sub_agents_per_parent=3
        ),
    )

    outcome = execute_delegate_tool(
        router=SimpleNamespace(_config=parse_runtime_config({})),
        arguments={"tasks": ["one", "two"]},
        runtime=runtime,
        outcome_type=ToolExecutionOutcome,
        call_id="call",
    )

    payload = json.loads(outcome.output)
    assert outcome.success is True
    assert payload["summary"] == "1 of 2 investigations finished; 1 failed (see its error)."
    assert payload["results"][1]["answer"] == ""
    assert payload["results"][1]["error"] == "Provider timed out."
    assert "error" not in payload["results"][0]
    # The monitor card still reads the rich report unchanged.
    rich_task = outcome.metadata["subagent_batch_report"]["tasks"][1]
    assert rich_task["error"]["message"] == "Provider timed out."
    assert rich_task["summary"] == "Provider timed out."
