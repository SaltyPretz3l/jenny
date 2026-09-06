from __future__ import annotations

import json
from typing import Any

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_SUBAGENT_INVALID_GRANTS,
    CMP_TOOL_SUBAGENT_INVALID_PROMPT,
)
from sidecar.ai.routing import subagent_batch as batch_module
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatDecision, ToolExecutionOutcome
from sidecar.ai.routing.sub_agent_invocation import (
    COMPLETION_REASON_CAPACITY_UNAVAILABLE,
    SUBAGENT_CAPACITY_UNAVAILABLE_MESSAGE,
    SubAgentInvocationResult,
)
from sidecar.ai.routing.subagent_batch import (
    execute_subagent_batch_tool,
    validate_subagent_batch_arguments,
)
from sidecar.ai.routing.subagent_contracts import (
    MAX_BATCH_OUTPUT_CHARS,
    SubagentBatchRequest,
    SubagentBatchTask,
    build_batch_settlement,
)
from sidecar.ai.routing.subagent_run import SubagentRunRequest
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.multiplexer import SubAgentSlotAllocator, TurnCancellationHandle


def _context() -> ChatRequestContext:
    return ChatRequestContext(
        request_id="req_parent",
        trace_id="trace_parent",
        session_id="session_parent",
        mode="assist",
        approvals_pre_granted=True,
        agent_id="main@req_parent",
        workspace_root_present=True,
    )


def _runtime(
    *,
    allocator: SubAgentSlotAllocator | None = None,
    cancel_handle: TurnCancellationHandle | None = None,
    notifications: list[dict[str, Any]] | None = None,
) -> LoopRuntime:
    return LoopRuntime(
        request_id="req_parent",
        trace_id="trace_parent",
        session_id="session_parent",
        request_context=_context(),
        cancel_handle=cancel_handle,
        notification_writer=(notifications.append if notifications is not None else None),
        sub_agent_slot_allocator=allocator or SubAgentSlotAllocator(),
    )


def _completed_result(
    ordinal: int,
    *,
    iterations: int = 1,
    tool_results: int = 0,
) -> SubAgentInvocationResult:
    outcomes = tuple(
        ToolExecutionOutcome(
            tool_name="read_file",
            output=f"evidence {index}",
            success=True,
            tool_input={},
            call_id=f"child_{ordinal}_{index}",
        )
        for index in range(tool_results)
    )
    decision = ChatDecision(
        thinking_text=None,
        response_text=json.dumps(
            {
                "status": "completed",
                "summary": f"summary {ordinal}",
                "evidence": [{"source": f"file-{ordinal}.py", "summary": "checked"}],
                "uncertainties": [],
            }
        ),
        approval_request=None,
        tool_results=outcomes,
    )
    return SubAgentInvocationResult(
        status="completed",
        decision=decision,
        response_text=decision.response_text,
        iterations_used=iterations,
        tool_results_used=tool_results,
        observed_tool_names=("read_file",) if tool_results else (),
    )


def _task(label: str, **overrides: object) -> dict[str, object]:
    return {"label": label, "prompt": f"Research {label}.", **overrides}


def test_validate_batch_defaults_and_preserves_order() -> None:
    request = validate_subagent_batch_arguments(
        {"tasks": [_task("first"), _task("second"), _task("third")]}
    )

    assert [task.ordinal for task in request.tasks] == [1, 2, 3]
    assert [task.label for task in request.tasks] == ["first", "second", "third"]
    assert all(task.request and task.request.max_steps == 6 for task in request.tasks)
    assert all(task.request and task.request.max_runtime_ms == 90_000 for task in request.tasks)
    assert request.max_total_steps == 18
    assert request.max_total_runtime_ms == 240_000


@pytest.mark.parametrize(
    ("arguments", "code"),
    [
        ("not-an-object", CMP_TOOL_SUBAGENT_INVALID_PROMPT),
        ({}, CMP_TOOL_SUBAGENT_INVALID_PROMPT),
        ({"tasks": []}, CMP_TOOL_SUBAGENT_INVALID_PROMPT),
        ({"tasks": [_task(str(i)) for i in range(4)]}, CMP_TOOL_SUBAGENT_INVALID_PROMPT),
        ({"tasks": [_task("x")], "model": "other"}, CMP_TOOL_SUBAGENT_INVALID_GRANTS),
        ({"tasks": [_task("x")], "max_total_steps": True}, CMP_TOOL_SUBAGENT_INVALID_GRANTS),
    ],
)
def test_validate_batch_rejects_malformed_top_level_envelopes(
    arguments: object,
    code: str,
) -> None:
    with pytest.raises(ToolExecutionFailure) as raised:
        validate_subagent_batch_arguments(arguments)

    assert raised.value.code == code


def test_validate_batch_rejects_aggregate_prompt_overflow_before_execution() -> None:
    with pytest.raises(ToolExecutionFailure) as raised:
        validate_subagent_batch_arguments(
            {
                "tasks": [
                    {"prompt": "a" * 16_000},
                    {"prompt": "b" * 16_000},
                    {"prompt": "c"},
                ]
            }
        )

    assert raised.value.code == CMP_TOOL_SUBAGENT_INVALID_PROMPT


def test_validate_batch_isolates_invalid_tasks() -> None:
    request = validate_subagent_batch_arguments(
        {
            "tasks": [
                _task("valid"),
                {"prompt": "", "task_id": "caller-owned"},
                {"label": "x" * 81, "prompt": "valid prompt"},
            ]
        }
    )

    assert request.tasks[0].request is not None
    assert request.tasks[1].error["code"] == CMP_TOOL_SUBAGENT_INVALID_GRANTS
    assert request.tasks[2].error["code"] == CMP_TOOL_SUBAGENT_INVALID_GRANTS


def test_execute_batch_runs_mixed_tasks_sequentially_and_returns_partial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []
    notifications: list[dict[str, Any]] = []

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        calls.append(kwargs)
        return _completed_result(len(calls), iterations=len(calls), tool_results=1)

    monkeypatch.setattr(batch_module, "invoke_sub_agent", fake_invoke)
    outcome = execute_subagent_batch_tool(
        router=object(),
        arguments={
            "tasks": [
                _task("first"),
                {"prompt": "", "task_id": "forbidden"},
                _task("third"),
            ]
        },
        runtime=_runtime(notifications=notifications),
        outcome_type=ToolExecutionOutcome,
        call_id="call_batch_1",
    )
    payload = json.loads(outcome.output)

    assert outcome.success is True
    assert payload["batch_id"] == "subagent_batch:req_parent:call_batch_1"
    assert payload["status"] == "partial"
    assert [task["status"] for task in payload["tasks"]] == [
        "completed",
        "rejected",
        "completed",
    ]
    assert [task["ordinal"] for task in payload["tasks"]] == [1, 2, 3]
    assert [call["identity"].task_id for call in calls] == [
        "subagent_batch:req_parent:call_batch_1:task:1",
        "subagent_batch:req_parent:call_batch_1:task:3",
    ]
    assert all("subagent_batch" in call["tool_preferences_override"]["disabled_tools"] for call in calls)
    assert payload["budget"]["tasks_started"] == 2
    assert payload["budget"]["tasks_completed"] == 2
    assert payload["budget"]["iterations_used"] == 3
    assert payload["budget"]["tool_results_used"] == 2
    assert outcome.metadata["subagent_batch_report"] == payload
    progress = [item["params"] for item in notifications if item.get("method") == "agent.progress"]
    assert progress[0]["task_id"] == payload["batch_id"]
    child_progress = [item for item in progress if item.get("child_task_id")]
    assert [item["child_ordinal"] for item in child_progress if item["status"] == "queued"] == [1, 2, 3]
    assert all(item["tool_call_id"] == "call_batch_1" for item in child_progress)
    assert all(item["child_count"] == 3 for item in child_progress)
    assert all(item.get("child_label") for item in child_progress)
    assert any(item["stage"] == "task_2_rejected" for item in progress)
    assert any(
        item.get("child_ordinal") == 2
        and item.get("child_terminal") is True
        and item.get("child_success") is False
        for item in child_progress
    )
    assert progress[-1]["terminal"] is True
    assert progress[-1]["status"] == "partial"


@pytest.mark.parametrize("task_count", [1, 2, 3])
def test_execute_batch_settles_one_to_three_tasks_deterministically(
    monkeypatch: pytest.MonkeyPatch,
    task_count: int,
) -> None:
    calls: list[int] = []

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        calls.append(kwargs["identity"].task_id.rsplit(":", 1)[-1])
        return _completed_result(len(calls))

    monkeypatch.setattr(batch_module, "invoke_sub_agent", fake_invoke)
    outcome = execute_subagent_batch_tool(
        router=object(),
        arguments={"tasks": [_task(f"task {index}") for index in range(1, task_count + 1)]},
        runtime=_runtime(),
        outcome_type=ToolExecutionOutcome,
        call_id="call_order",
    )
    payload = json.loads(outcome.output)

    assert calls == [str(index) for index in range(1, task_count + 1)]
    assert [task["ordinal"] for task in payload["tasks"]] == list(range(1, task_count + 1))
    assert payload["status"] == "completed"


def test_malformed_completed_child_fails_without_suppressing_later_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def fake_invoke(**_kwargs: Any) -> SubAgentInvocationResult:
        nonlocal calls
        calls += 1
        if calls == 1:
            decision = ChatDecision(
                thinking_text=None,
                response_text="not a JSON report; api_key=child-secret",
                approval_request=None,
                tool_results=(),
            )
            return SubAgentInvocationResult(
                status="completed",
                decision=decision,
                response_text=decision.response_text,
                iterations_used=1,
            )
        return _completed_result(calls)

    monkeypatch.setattr(batch_module, "invoke_sub_agent", fake_invoke)
    outcome = execute_subagent_batch_tool(
        router=object(),
        arguments={"tasks": [_task("malformed"), _task("later-valid")]},
        runtime=_runtime(),
        outcome_type=ToolExecutionOutcome,
        call_id="call_malformed_isolation",
    )
    payload = json.loads(outcome.output)

    assert calls == 2
    assert outcome.success is True
    assert payload["status"] == "partial"
    assert [task["status"] for task in payload["tasks"]] == ["failed", "completed"]
    assert payload["tasks"][0]["error"] == {
        "code": CMP_TOOL_EXECUTION_FAILED,
        "message": "Sub-agent returned an invalid or incomplete report.",
        "retryable": False,
    }
    assert payload["budget"]["tasks_completed"] == 1
    assert "child-secret" not in outcome.output


def test_execute_batch_allocates_only_remaining_iteration_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    allocated: list[int] = []
    notifications: list[dict[str, Any]] = []

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        allocated.append(kwargs["iteration_budget_override"])
        return _completed_result(len(allocated), iterations=kwargs["iteration_budget_override"])

    monkeypatch.setattr(batch_module, "invoke_sub_agent", fake_invoke)
    outcome = execute_subagent_batch_tool(
        router=object(),
        arguments={
            "tasks": [_task("one"), _task("two"), _task("three")],
            "max_total_steps": 7,
        },
        runtime=_runtime(notifications=notifications),
        outcome_type=ToolExecutionOutcome,
        call_id="call_budget",
    )
    payload = json.loads(outcome.output)

    assert allocated == [2, 2, 3]
    assert [task["status"] for task in payload["tasks"]] == [
        "completed",
        "completed",
        "completed",
    ]
    assert payload["budget"]["iterations_used"] == 7
    assert not any(
        "skipped_budget" in item["params"]["stage"]
        for item in notifications
        if item.get("method") == "agent.progress"
    )


def test_execute_batch_allocates_only_remaining_runtime_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [100.0]
    allocated: list[int] = []

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        allocated.append(kwargs["max_runtime_ms"])
        if len(allocated) == 1:
            clock[0] += 0.75
        return _completed_result(len(allocated))

    monkeypatch.setattr(batch_module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(batch_module, "invoke_sub_agent", fake_invoke)
    outcome = execute_subagent_batch_tool(
        router=object(),
        arguments={
            "tasks": [
                _task("one", max_runtime_ms=1_000),
                _task("two", max_runtime_ms=1_000),
            ],
            "max_total_runtime_ms": 1_500,
        },
        runtime=_runtime(),
        outcome_type=ToolExecutionOutcome,
        call_id="call_runtime_budget",
    )
    payload = json.loads(outcome.output)

    assert allocated == [750, 750]
    assert payload["budget"]["elapsed_ms"] == 750
    assert payload["budget"]["elapsed_ms"] <= payload["budget"]["max_total_runtime_ms"]


def test_execute_batch_reserves_parent_synthesis_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [100.0]
    allocated: list[int] = []

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        allocated.append(kwargs["max_runtime_ms"])
        return _completed_result(len(allocated))

    runtime = _runtime()
    runtime.clock = lambda: clock[0]
    runtime.wall_clock_deadline = 180.0
    monkeypatch.setattr(batch_module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(batch_module, "invoke_sub_agent", fake_invoke)

    outcome = execute_subagent_batch_tool(
        router=object(),
        arguments={
            "tasks": [_task("one"), _task("two")],
            "max_total_runtime_ms": 120_000,
        },
        runtime=runtime,
        outcome_type=ToolExecutionOutcome,
        call_id="call_synthesis_reserve",
    )
    payload = json.loads(outcome.output)

    assert allocated == [10_000, 20_000]
    assert payload["budget"]["effective_max_total_runtime_ms"] == 20_000
    assert payload["budget"]["parent_synthesis_reserve_ms"] == 60_000


def test_capacity_failure_stops_without_reprobing_later_tasks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0
    notifications: list[dict[str, Any]] = []

    def fake_invoke(**_kwargs: Any) -> SubAgentInvocationResult:
        nonlocal calls
        calls += 1
        return SubAgentInvocationResult(
            status="failed",
            error_code=CMP_TOOL_EXECUTION_FAILED,
            error_message=SUBAGENT_CAPACITY_UNAVAILABLE_MESSAGE,
            error_retryable=True,
            completion_reason=COMPLETION_REASON_CAPACITY_UNAVAILABLE,
        )

    monkeypatch.setattr(batch_module, "invoke_sub_agent", fake_invoke)
    outcome = execute_subagent_batch_tool(
        router=object(),
        arguments={"tasks": [_task("one"), _task("two"), _task("three")]},
        runtime=_runtime(notifications=notifications),
        outcome_type=ToolExecutionOutcome,
        call_id="call_capacity",
    )
    payload = json.loads(outcome.output)

    assert calls == 1
    assert outcome.success is False
    assert payload["budget"]["tasks_started"] == 0
    assert [task["status"] for task in payload["tasks"]] == ["failed", "failed", "failed"]
    assert all(task["error"]["retryable"] is True for task in payload["tasks"])
    assert {
        item["params"]["stage"]
        for item in notifications
        if item.get("method") == "agent.progress"
    }.issuperset({"task_1_failed", "task_2_failed", "task_3_failed"})


def test_parent_cancellation_prevents_later_task_starts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancel = TurnCancellationHandle(
        request_id="req_parent",
        trace_id="trace_parent",
        session_id="session_parent",
    )
    calls = 0
    notifications: list[dict[str, Any]] = []

    def fake_invoke(**_kwargs: Any) -> SubAgentInvocationResult:
        nonlocal calls
        calls += 1
        cancel.cancel(reason="user_cancel")
        return _completed_result(1)

    monkeypatch.setattr(batch_module, "invoke_sub_agent", fake_invoke)
    outcome = execute_subagent_batch_tool(
        router=object(),
        arguments={"tasks": [_task("one"), _task("two")]},
        runtime=_runtime(cancel_handle=cancel, notifications=notifications),
        outcome_type=ToolExecutionOutcome,
        call_id="call_cancel",
    )
    payload = json.loads(outcome.output)

    assert calls == 1
    assert outcome.success is False
    assert payload["status"] == "cancelled"
    assert [task["status"] for task in payload["tasks"]] == ["cancelled", "cancelled"]
    assert payload["budget"]["tasks_started"] == 1
    assert {
        item["params"]["stage"]
        for item in notifications
        if item.get("method") == "agent.progress"
    }.issuperset({"task_1_cancelled", "task_2_cancelled"})


def test_parent_cancellation_after_completion_preserves_completed_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancel = TurnCancellationHandle(
        request_id="req_parent",
        trace_id="trace_parent",
        session_id="session_parent",
    )
    calls = 0
    notifications: list[dict[str, Any]] = []

    def fake_invoke(**_kwargs: Any) -> SubAgentInvocationResult:
        nonlocal calls
        calls += 1
        if calls == 2:
            cancel.cancel(reason="user_cancel")
        return _completed_result(calls)

    monkeypatch.setattr(batch_module, "invoke_sub_agent", fake_invoke)
    outcome = execute_subagent_batch_tool(
        router=object(),
        arguments={"tasks": [_task("one"), _task("two"), _task("three")]},
        runtime=_runtime(cancel_handle=cancel, notifications=notifications),
        outcome_type=ToolExecutionOutcome,
        call_id="call_partial_cancel",
    )
    payload = json.loads(outcome.output)

    assert calls == 2
    assert outcome.success is True
    assert payload["status"] == "cancelled"
    assert [task["status"] for task in payload["tasks"]] == [
        "completed",
        "cancelled",
        "cancelled",
    ]
    assert payload["budget"]["tasks_started"] == 2
    assert payload["budget"]["tasks_completed"] == 1
    assert {
        item["params"]["stage"]
        for item in notifications
        if item.get("method") == "agent.progress"
    }.issuperset({"task_1_completed", "task_2_cancelled", "task_3_cancelled"})


def test_missing_allocator_returns_structured_failure_without_starting_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = _runtime()
    runtime.sub_agent_slot_allocator = None
    monkeypatch.setattr(
        batch_module,
        "invoke_sub_agent",
        lambda **_kwargs: pytest.fail("child must not start"),
    )

    outcome = execute_subagent_batch_tool(
        router=object(),
        arguments={"tasks": [_task("one")]},
        runtime=runtime,
        outcome_type=ToolExecutionOutcome,
        call_id="call_missing_runtime",
    )
    payload = json.loads(outcome.output)

    assert outcome.success is False
    assert outcome.error_code == CMP_TOOL_EXECUTION_FAILED
    assert payload["tasks"][0]["status"] == "failed"
    assert payload["budget"]["tasks_started"] == 0


def test_aggregate_output_cap_drops_low_priority_lists_before_summaries() -> None:
    request = SubagentBatchRequest(
        tasks=tuple(
            SubagentBatchTask(
                ordinal=ordinal,
                label=f"Task {ordinal}",
                request=SubagentRunRequest(
                    prompt="research",
                    allowed_tool_families=(),
                    max_steps=6,
                    max_runtime_ms=90_000,
                ),
            )
            for ordinal in range(1, 4)
        ),
        max_total_steps=18,
        max_total_runtime_ms=240_000,
    )
    reports = [
        {
            "task_id": f"subagent_batch:req:call:task:{ordinal}",
            "ordinal": ordinal,
            "label": f"Task {ordinal}",
            "status": "completed",
            "summary": f"important summary {ordinal}",
            "evidence": [{"summary": "e" * 1_000} for _ in range(12)],
            "evidence_trust": "model_reported_unverified",
            "tools_used": ["read_file"],
            "uncertainties": ["u" * 300 for _ in range(8)],
            "budget": {
                "max_steps": 6,
                "iterations_used": 1,
                "tool_results_used": 1,
                "max_runtime_ms": 90_000,
                "elapsed_ms": 1,
            },
            "error": None,
        }
        for ordinal in range(1, 4)
    ]

    settlement = build_batch_settlement(
        request=request,
        batch_id="subagent_batch:req:call",
        task_reports=reports,
        tasks_started=3,
        tasks_completed=3,
        iterations_used=3,
        tool_results_used=3,
        elapsed_ms=3,
    )

    assert len(settlement.output) <= MAX_BATCH_OUTPUT_CHARS
    assert [task["summary"] for task in settlement.report["tasks"]] == [
        "important summary 1",
        "important summary 2",
        "important summary 3",
    ]
    assert sum(len(task["evidence"]) for task in settlement.report["tasks"]) < 36
