from __future__ import annotations

import json
import threading
import time
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.routing import delegate as delegate_module
from sidecar.ai.routing import subagent_scheduler as scheduler_module
from sidecar.ai.routing.delegate import execute_delegate_tool
from sidecar.ai.routing.delegate_contracts import (
    CANONICAL_DELEGATE_EXAMPLE_JSON,
    MAX_DELEGATE_OUTPUT_CHARS,
    build_compact_delegate_settlement,
    extract_tool_observed_evidence,
    validate_delegate_arguments,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatDecision, ToolExecutionOutcome
from sidecar.ai.routing.sub_agent_invocation import SubAgentInvocationResult
from sidecar.ai.routing.subagent_scheduler import (
    DelegateSchedule,
    ScheduledInvocation,
    schedule_delegate_tasks,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.chat_models import ChatRequestContext, TerminalChatStateError
from sidecar.runtime.multiplexer import SubAgentSlotAllocator, TurnCancellationHandle


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


def _runtime(*, capacity: int = 3) -> LoopRuntime:
    return LoopRuntime(
        request_id="parent-request",
        trace_id="trace",
        session_id="session",
        request_context=_context(),
        sub_agent_slot_allocator=SubAgentSlotAllocator(
            max_active_sub_agents=capacity,
            max_sub_agents_per_parent=capacity,
        ),
    )


def _decision(answer: str, *, outcomes: tuple[ToolExecutionOutcome, ...] = ()) -> ChatDecision:
    return ChatDecision(
        thinking_text=None,
        response_text=answer,
        approval_request=None,
        tool_results=outcomes,
    )


@pytest.mark.parametrize(
    "arguments",
    [
        {"tasks": ["inspect"]},
        {"tasks": "inspect"},
        {"task": "inspect"},
        {"prompt": "inspect"},
        {"tasks": [{"task": "inspect"}]},
        {"tasks": [{"prompt": "inspect"}]},
    ],
)
def test_delegate_accepts_canonical_call_and_only_unambiguous_aliases(
    arguments: dict[str, object],
) -> None:
    request = validate_delegate_arguments(arguments)

    assert [task.prompt for task in request.tasks] == ["inspect"]


@pytest.mark.parametrize(
    "arguments",
    [
        {"task": "one", "prompt": "two"},
        {"tasks": ["one"], "max_steps": 3},
        {"tasks": []},
        {"tasks": ["1", "2", "3", "4"]},
        {"tasks": "x" * 32_001},
    ],
)
def test_delegate_rejects_top_level_ambiguity_with_canonical_example(
    arguments: dict[str, object],
) -> None:
    with pytest.raises(ToolExecutionFailure) as raised:
        validate_delegate_arguments(arguments)

    assert CANONICAL_DELEGATE_EXAMPLE_JSON in raised.value.message


def test_delegate_enforces_utf8_byte_limits_not_character_counts() -> None:
    request = validate_delegate_arguments({"tasks": ["é" * 8_001]})

    assert request.tasks[0].prompt is None
    assert request.tasks[0].error is not None
    assert "16000 byte" in request.tasks[0].error["message"]


def test_delegate_isolates_malformed_array_items() -> None:
    request = validate_delegate_arguments(
        {
            "tasks": [
                "valid one",
                {"prompt": "", "task": "ambiguous"},
                {"prompt": "valid three"},
            ]
        }
    )

    assert request.tasks[0].prompt == "valid one"
    assert request.tasks[1].error is not None
    assert CANONICAL_DELEGATE_EXAMPLE_JSON in request.tasks[1].error["message"]
    assert request.tasks[2].prompt == "valid three"


def test_delegate_isolates_invalid_unicode_scalars_per_item() -> None:
    request = validate_delegate_arguments(
        {"tasks": ["valid one", "\ud800", {"prompt": "valid three"}]}
    )

    assert request.tasks[0].prompt == "valid one"
    assert request.tasks[1].prompt is None
    assert request.tasks[1].error is not None
    assert "invalid Unicode" in request.tasks[1].error["message"]
    assert request.tasks[2].prompt == "valid three"


def test_delegate_depth_limit_is_fail_closed() -> None:
    with pytest.raises(ToolExecutionFailure):
        validate_delegate_arguments({"tasks": ["inspect"]}, parent_agent_depth=1)


def test_compact_output_drops_high_ordinal_evidence_before_answers() -> None:
    oversized_evidence = [
        {
            "source_tool": "read_file",
            "relative_path": f"src/file-{index}.py",
            "quote": "q" * 300,
            "provenance": "tool_observed",
        }
        for index in range(3)
    ]
    reports = [
        {
            "ordinal": ordinal,
            "status": "completed",
            "summary": "a" * 1_500,
            "evidence": oversized_evidence,
        }
        for ordinal in (1, 2, 3)
    ]

    settlement = build_compact_delegate_settlement(
        execution="parallel",
        task_reports=reports,
    )

    assert len(settlement.output) <= MAX_DELEGATE_OUTPUT_CHARS
    assert all(len(result["answer"]) <= 1_000 for result in settlement.report["results"])
    assert len(settlement.report["results"][2]["evidence"]) <= len(
        settlement.report["results"][0]["evidence"]
    )


def test_evidence_is_derived_only_from_successful_supported_tool_outcomes() -> None:
    decision = _decision(
        "answer",
        outcomes=(
            ToolExecutionOutcome(
                tool_name="read_file",
                output='path: package.json\nrequested: offset=7, limit=1\nreturned: lines 8-8 of 20\n\n"test": "npm test"',
                success=True,
                metadata={"path": "package.json", "returned_line_start": 8, "returned_line_end": 8},
            ),
            ToolExecutionOutcome(
                tool_name="grep_search",
                output="Found 1 matches:\nsrc/app.py:12:run_tests()",
                success=True,
            ),
            ToolExecutionOutcome(
                tool_name="git_status",
                output="## main...origin/main\n M src/app.py",
                success=True,
            ),
            ToolExecutionOutcome(
                tool_name="read_file",
                output="secret",
                success=False,
                metadata={"path": "secret.txt"},
            ),
            ToolExecutionOutcome(tool_name="web_search", output="claim", success=True),
        ),
    )

    evidence = extract_tool_observed_evidence(decision)

    assert [item["source_tool"] for item in evidence] == [
        "read_file",
        "grep_search",
        "git_status",
    ]
    assert all(item["provenance"] == "tool_observed" for item in evidence)
    assert evidence[0]["line_start"] == 8
    assert evidence[1]["relative_path"] == "src/app.py"
    assert evidence[2]["fact"] == "branch"


def test_evidence_paths_preserve_dotfiles_and_reject_windows_drive_paths() -> None:
    decision = _decision(
        "answer",
        outcomes=(
            ToolExecutionOutcome(
                tool_name="read_file",
                output="enabled=false",
                success=True,
                metadata={"path": ".env"},
            ),
            ToolExecutionOutcome(
                tool_name="read_file",
                output="secret=true",
                success=True,
                metadata={"path": "C:secret.txt"},
            ),
        ),
    )

    assert extract_tool_observed_evidence(decision) == [
        {
            "source_tool": "read_file",
            "relative_path": ".env",
            "quote": "enabled=false",
            "provenance": "tool_observed",
            "line_start": 1,
            "line_end": 1,
        }
    ]


def test_compact_evidence_never_retains_semantic_verified_markers() -> None:
    settlement = build_compact_delegate_settlement(
        execution="single",
        task_reports=[
            {
                "ordinal": 1,
                "status": "completed",
                "summary": "answer",
                "evidence": [
                    {
                        "source_tool": "read_file",
                        "relative_path": "package.json",
                        "quote": "evidence",
                        "provenance": "tool_observed",
                        "verified": True,
                    }
                ],
            }
        ],
    )

    assert settlement.report["results"][0]["evidence"][0] == {
        "source_tool": "read_file",
        "relative_path": "package.json",
        "quote": "evidence",
        "provenance": "tool_observed",
    }


def test_local_multi_task_scheduler_never_overlaps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    active = 0
    maximum = 0
    lock = threading.Lock()

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        time.sleep(0.01)
        with lock:
            active -= 1
        return SubAgentInvocationResult(
            status="completed",
            response_text=str(kwargs["latest_user_content"]),
            decision=_decision(str(kwargs["latest_user_content"])),
            iterations_used=1,
        )

    monkeypatch.setattr(scheduler_module, "invoke_sub_agent", fake_invoke)
    router = SimpleNamespace(_config=parse_runtime_config({"engine_type": "mock"}))
    schedule = schedule_delegate_tasks(
        router=router,
        parent_context=_context(),
        runtime=_runtime(capacity=3),
        request=validate_delegate_arguments({"tasks": ["one", "two", "three"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
    )

    assert schedule.execution == "sequential"
    assert maximum == 1
    assert [item.result.response_text for item in schedule.invocations] == ["one", "two", "three"]


def test_cloud_scheduler_overlaps_and_preserves_input_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    barrier = threading.Barrier(3)

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        barrier.wait(timeout=2)
        prompt = str(kwargs["latest_user_content"])
        return SubAgentInvocationResult(
            status="completed",
            response_text=prompt,
            decision=_decision(prompt),
            iterations_used=1,
        )

    monkeypatch.setattr(scheduler_module, "invoke_sub_agent", fake_invoke)
    router = SimpleNamespace(_config=parse_runtime_config({"engine_type": "chatgpt"}))
    runtime = _runtime(capacity=3)
    schedule = schedule_delegate_tasks(
        router=router,
        parent_context=_context(),
        runtime=runtime,
        request=validate_delegate_arguments({"tasks": ["one", "two", "three"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
    )

    assert schedule.execution == "parallel"
    assert [item.result.response_text for item in schedule.invocations] == ["one", "two", "three"]
    assert runtime.sub_agent_slot_allocator.snapshot()["active_sub_agents"] == 0


def test_cloud_capacity_failure_starts_zero_children(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def fake_invoke(**_kwargs: Any) -> SubAgentInvocationResult:
        nonlocal calls
        calls += 1
        return SubAgentInvocationResult(status="completed")

    monkeypatch.setattr(scheduler_module, "invoke_sub_agent", fake_invoke)
    router = SimpleNamespace(_config=parse_runtime_config({"engine_type": "codex-cli"}))
    schedule = schedule_delegate_tasks(
        router=router,
        parent_context=_context(),
        runtime=_runtime(capacity=1),
        request=validate_delegate_arguments({"tasks": ["one", "two"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
    )

    assert schedule.capacity_rejected is True
    assert calls == 0
    assert all(
        item.result.completion_reason == "capacity_unavailable" for item in schedule.invocations
    )


@pytest.mark.parametrize(
    "engine_type",
    ("mock", "replay", "ollama", "vllm", "openai-compatible", "unknown"),
)
def test_non_cloud_and_unknown_profiles_remain_sequential(
    monkeypatch: pytest.MonkeyPatch,
    engine_type: str,
) -> None:
    monkeypatch.setattr(
        scheduler_module,
        "invoke_sub_agent",
        lambda **kwargs: SubAgentInvocationResult(
            status="completed",
            response_text=str(kwargs["latest_user_content"]),
            decision=_decision(str(kwargs["latest_user_content"])),
            iterations_used=1,
        ),
    )
    router = SimpleNamespace(_config=parse_runtime_config({"engine_type": engine_type}))

    schedule = schedule_delegate_tasks(
        router=router,
        parent_context=_context(),
        runtime=_runtime(),
        request=validate_delegate_arguments({"tasks": ["one", "two"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
    )

    assert schedule.execution == "sequential"


def test_one_cloud_task_uses_single_execution() -> None:
    request = validate_delegate_arguments({"tasks": ["one"]})
    router = SimpleNamespace(_config=parse_runtime_config({"engine_type": "chatgpt"}))

    assert scheduler_module.execution_for_request(router, request) == "single"


def test_cloud_children_receive_configured_limit_and_one_parent_derived_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    barrier = threading.Barrier(3)
    captured: list[dict[str, Any]] = []
    lock = threading.Lock()

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        with lock:
            captured.append(dict(kwargs))
        barrier.wait(timeout=2)
        return SubAgentInvocationResult(
            status="completed",
            response_text=str(kwargs["latest_user_content"]),
            decision=_decision(str(kwargs["latest_user_content"])),
            iterations_used=1,
        )

    monkeypatch.setattr(scheduler_module, "invoke_sub_agent", fake_invoke)
    router = SimpleNamespace(_config=parse_runtime_config({"engine_type": "codex-cli"}))
    runtime = _runtime()
    runtime.wall_clock_deadline = time.monotonic() + 300.0
    schedule = schedule_delegate_tasks(
        router=router,
        parent_context=_context(),
        runtime=runtime,
        request=validate_delegate_arguments({"tasks": ["one", "two", "three"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
    )

    assert {item["iteration_budget_override"] for item in captured} == {10}
    assert {item["max_runtime_ms"] for item in captured} == {
        schedule.effective_max_total_runtime_ms
    }
    assert 239_000 <= schedule.effective_max_total_runtime_ms <= 240_000
    assert len({item["absolute_deadline"] for item in captured}) == 1
    assert all(item["slot_lease"] is not None for item in captured)


def test_single_task_uses_parent_remaining_envelope_not_legacy_120_second_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[dict[str, Any]] = []

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        captured.append(dict(kwargs))
        return SubAgentInvocationResult(
            status="completed",
            response_text="done",
            decision=_decision("done"),
            iterations_used=1,
        )

    monkeypatch.setattr(scheduler_module, "invoke_sub_agent", fake_invoke)
    runtime = _runtime()
    runtime.wall_clock_deadline = time.monotonic() + 300.0
    schedule = schedule_delegate_tasks(
        router=SimpleNamespace(
            _config=parse_runtime_config(
                {"engine_type": "mock", "max_sub_agent_loop_iterations": 14}
            )
        ),
        parent_context=_context(),
        runtime=runtime,
        request=validate_delegate_arguments({"tasks": ["one"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
    )

    assert len(captured) == 1
    assert captured[0]["iteration_budget_override"] == 14
    assert 239_000 <= captured[0]["max_runtime_ms"] <= 240_000
    assert (
        0
        <= schedule.effective_max_total_runtime_ms - captured[0]["max_runtime_ms"]
        <= 1_000
    )
    assert captured[0]["max_runtime_ms"] > 120_000


def test_sequential_children_receive_recomputed_shared_remaining_envelope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 1_000.0
    captured: list[int] = []

    def fake_monotonic() -> float:
        return now

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        nonlocal now
        captured.append(int(kwargs["max_runtime_ms"]))
        now += 20.0
        return SubAgentInvocationResult(
            status="completed",
            response_text=str(kwargs["latest_user_content"]),
            decision=_decision(str(kwargs["latest_user_content"])),
            iterations_used=1,
        )

    monkeypatch.setattr(scheduler_module.time, "monotonic", fake_monotonic)
    monkeypatch.setattr(scheduler_module, "invoke_sub_agent", fake_invoke)
    runtime = _runtime()
    runtime.wall_clock_deadline = now + 300.0
    schedule_delegate_tasks(
        router=SimpleNamespace(_config=parse_runtime_config({"engine_type": "mock"})),
        parent_context=_context(),
        runtime=runtime,
        request=validate_delegate_arguments({"tasks": ["one", "two", "three"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
    )

    assert captured == [240_000, 220_000, 200_000]
    assert captured[0] > 80_000


def test_nearly_exhausted_parent_starts_zero_children(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def fake_invoke(**_kwargs: Any) -> SubAgentInvocationResult:
        nonlocal calls
        calls += 1
        return SubAgentInvocationResult(status="completed")

    monkeypatch.setattr(scheduler_module, "invoke_sub_agent", fake_invoke)
    runtime = _runtime()
    runtime.wall_clock_deadline = time.monotonic() + 30.0
    schedule = schedule_delegate_tasks(
        router=SimpleNamespace(_config=parse_runtime_config({"engine_type": "mock"})),
        parent_context=_context(),
        runtime=runtime,
        request=validate_delegate_arguments({"tasks": ["one", "two"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
    )

    assert calls == 0
    assert schedule.effective_max_total_runtime_ms == 0
    assert all(not item.started for item in schedule.invocations)
    assert all(item.result.error_code == "CMP-TOOL-0034" for item in schedule.invocations)
    assert all(
        "parent turn deadline" in str(item.result.error_message)
        for item in schedule.invocations
    )


def test_parent_deadline_preserves_synthesis_reserve(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        scheduler_module,
        "invoke_sub_agent",
        lambda **kwargs: SubAgentInvocationResult(
            status="completed",
            response_text=str(kwargs["latest_user_content"]),
            decision=_decision(str(kwargs["latest_user_content"])),
            iterations_used=1,
        ),
    )
    runtime = _runtime()
    runtime.wall_clock_deadline = time.monotonic() + 100.0
    schedule = schedule_delegate_tasks(
        router=SimpleNamespace(_config=parse_runtime_config({"engine_type": "mock"})),
        parent_context=_context(),
        runtime=runtime,
        request=validate_delegate_arguments({"tasks": ["one", "two"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
    )

    assert schedule.parent_synthesis_reserve_ms == 60_000
    assert 39_000 <= schedule.effective_max_total_runtime_ms <= 40_000


def test_cloud_prewarm_runs_inside_frozen_parent_envelope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 1_000.0
    captured: list[dict[str, Any]] = []

    def fake_monotonic() -> float:
        return now

    def fake_prewarm(_router: Any) -> None:
        nonlocal now
        now += 30.0

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        captured.append(dict(kwargs))
        return SubAgentInvocationResult(
            status="completed",
            response_text=str(kwargs["latest_user_content"]),
            decision=_decision(str(kwargs["latest_user_content"])),
            iterations_used=1,
        )

    monkeypatch.setattr(scheduler_module.time, "monotonic", fake_monotonic)
    monkeypatch.setattr(scheduler_module, "_prewarm_shared_state", fake_prewarm)
    monkeypatch.setattr(scheduler_module, "invoke_sub_agent", fake_invoke)
    runtime = _runtime()
    runtime.wall_clock_deadline = now + 100.0

    schedule = schedule_delegate_tasks(
        router=SimpleNamespace(_config=parse_runtime_config({"engine_type": "chatgpt"})),
        parent_context=_context(),
        runtime=runtime,
        request=validate_delegate_arguments({"tasks": ["one", "two"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
    )

    assert len(captured) == 2
    assert all(item["absolute_deadline"] == 1_040.0 for item in captured)
    assert all(item["max_runtime_ms"] == 10_000 for item in captured)
    assert schedule.effective_max_total_runtime_ms == 10_000


def test_cloud_sibling_failure_is_isolated_and_ordered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        prompt = str(kwargs["latest_user_content"])
        if prompt == "two":
            raise RuntimeError("provider failed")
        return SubAgentInvocationResult(
            status="completed",
            response_text=prompt,
            decision=_decision(prompt),
            iterations_used=1,
        )

    monkeypatch.setattr(scheduler_module, "invoke_sub_agent", fake_invoke)
    schedule = schedule_delegate_tasks(
        router=SimpleNamespace(_config=parse_runtime_config({"engine_type": "chatgpt"})),
        parent_context=_context(),
        runtime=_runtime(),
        request=validate_delegate_arguments({"tasks": ["one", "two", "three"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
    )

    assert [item.task.ordinal for item in schedule.invocations] == [1, 2, 3]
    assert [item.result.status for item in schedule.invocations] == [
        "completed",
        "failed",
        "completed",
    ]
    assert all(item.started for item in schedule.invocations)
    assert schedule.invocations[1].elapsed_ms >= 0


def test_cloud_parent_cancellation_settles_workers_and_releases_every_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parent_cancel = TurnCancellationHandle(request_id="parent-request")
    runtime = _runtime()
    runtime.cancel_handle = parent_cancel
    all_started = threading.Event()
    started = 0
    started_lock = threading.Lock()
    settled: list[int] = []

    def fake_invoke(**kwargs: Any) -> SubAgentInvocationResult:
        nonlocal started
        with started_lock:
            started += 1
            if started == 3:
                all_started.set()
        cancel_handle = kwargs["cancel_handle"]
        while not cancel_handle.cancelled:
            time.sleep(0.001)
        raise TerminalChatStateError(status="cancelled", message="parent cancelled")

    start_timed_out = threading.Event()

    def cancel_after_start() -> None:
        # Never assert in here. A failed assertion dies with the thread, so the
        # cancel below would never fire and the three fake workers would spin on
        # `while not cancel_handle.cancelled` forever -- schedule_delegate_tasks
        # blocks, and a startup regression HANGS the suite instead of failing it.
        # Record the timeout and cancel anyway, so the workers are always released.
        if not all_started.wait(timeout=2):
            start_timed_out.set()
        parent_cancel.cancel(reason="user_cancel")

    monkeypatch.setattr(scheduler_module, "invoke_sub_agent", fake_invoke)
    canceller = threading.Thread(target=cancel_after_start)
    canceller.start()
    schedule = schedule_delegate_tasks(
        router=SimpleNamespace(_config=parse_runtime_config({"engine_type": "chatgpt"})),
        parent_context=_context(),
        runtime=runtime,
        request=validate_delegate_arguments({"tasks": ["one", "two", "three"]}),
        parent_request_id="parent-request",
        call_id="call",
        parent_agent_id="main@parent-request",
        on_task_settled=lambda item: settled.append(item.task.ordinal),
    )
    canceller.join(timeout=2)
    assert not canceller.is_alive(), "cancel thread never finished"
    assert not start_timed_out.is_set(), "not all three workers started within 2s"

    assert [item.result.status for item in schedule.invocations] == [
        "cancelled",
        "cancelled",
        "cancelled",
    ]
    assert runtime.sub_agent_slot_allocator.snapshot()["active_sub_agents"] == 0
    settled_count = len(settled)
    time.sleep(0.01)
    assert len(settled) == settled_count == 3


def test_execute_delegate_returns_compact_output_and_rich_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task = validate_delegate_arguments({"tasks": ["inspect"]}).tasks[0]
    identity = scheduler_module.build_sub_agent_identity(
        parent_request_id="parent-request",
        canonical_call_id="call",
        parent_agent_id="main@parent-request",
        ordinal=1,
        operation="delegate",
    )
    result = SubAgentInvocationResult(
        status="completed",
        response_text="The test command is npm test.",
        decision=_decision("The test command is npm test."),
        iterations_used=2,
    )
    schedule = DelegateSchedule(
        execution="single",
        invocations=(ScheduledInvocation(task, identity, result, 10, 8, 120_000, True),),
        effective_max_total_runtime_ms=120_000,
        parent_synthesis_reserve_ms=0,
    )
    monkeypatch.setattr(delegate_module, "schedule_delegate_tasks", lambda **_kwargs: schedule)

    outcome = execute_delegate_tool(
        router=SimpleNamespace(_config=parse_runtime_config({})),
        arguments={"tasks": ["inspect"]},
        runtime=_runtime(),
        outcome_type=ToolExecutionOutcome,
        call_id="call",
    )
    payload = json.loads(outcome.output)

    assert payload == {
        "execution": "single",
        "results": [
            {
                "answer": "The test command is npm test.",
                "evidence": [],
                "ordinal": 1,
                "status": "completed",
            }
        ],
        "status": "completed",
    }
    rich = outcome.metadata["subagent_batch_report"]
    assert rich["source_tool"] == "delegate"
    assert rich["tasks"][0]["task_id"].startswith("delegate:")
    assert "batch_id" not in payload
    assert "usage" not in payload


def test_execute_delegate_does_not_emit_terminal_success_after_parent_cancel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task = validate_delegate_arguments({"tasks": ["inspect"]}).tasks[0]
    identity = scheduler_module.build_sub_agent_identity(
        parent_request_id="parent-request",
        canonical_call_id="call",
        parent_agent_id="main@parent-request",
        ordinal=1,
        operation="delegate",
    )
    result = SubAgentInvocationResult(
        status="completed",
        response_text="done",
        decision=_decision("done"),
        iterations_used=1,
    )
    schedule = DelegateSchedule(
        execution="single",
        invocations=(ScheduledInvocation(task, identity, result, 1, 8, 120_000, True),),
        effective_max_total_runtime_ms=120_000,
        parent_synthesis_reserve_ms=0,
    )
    runtime = _runtime()
    runtime.cancel_handle = TurnCancellationHandle(request_id="parent-request")
    notifications: list[dict[str, Any]] = []
    runtime.notification_writer = notifications.append

    def cancel_before_return(**_kwargs: Any) -> DelegateSchedule:
        runtime.cancel_handle.cancel(reason="user_cancel")
        return schedule

    monkeypatch.setattr(delegate_module, "schedule_delegate_tasks", cancel_before_return)

    with pytest.raises(TerminalChatStateError):
        execute_delegate_tool(
            router=SimpleNamespace(_config=parse_runtime_config({})),
            arguments={"tasks": ["inspect"]},
            runtime=runtime,
            outcome_type=ToolExecutionOutcome,
            call_id="call",
        )

    progress = [item["params"] for item in notifications if item["method"] == "agent.progress"]
    assert progress
    assert not any(item.get("terminal") for item in progress)
    assert not any(item.get("status") == "completed" for item in progress)


def test_delegate_emits_every_child_before_scheduling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arguments: dict[str, Any] = {
        "tasks": ["valid one", {"prompt": "", "task": "ambiguous"}, "valid three"]
    }
    runtime = _runtime()
    notifications: list[dict[str, Any]] = []
    runtime.notification_writer = notifications.append

    monkeypatch.setattr(
        delegate_module,
        "schedule_delegate_tasks",
        lambda **_kwargs: DelegateSchedule(
            execution="sequential",
            invocations=(),
            effective_max_total_runtime_ms=240_000,
            parent_synthesis_reserve_ms=60_000,
        ),
    )

    execute_delegate_tool(
        router=SimpleNamespace(_config=parse_runtime_config({})),
        arguments=arguments,
        runtime=runtime,
        outcome_type=ToolExecutionOutcome,
        call_id="call",
    )

    child_progress = [
        item["params"]
        for item in notifications
        if item["method"] == "agent.progress" and item["params"].get("child_task_id")
    ]
    assert [item["child_ordinal"] for item in child_progress[:3]] == [1, 2, 3]
    assert [item["status"] for item in child_progress[:3]] == ["queued", "failed", "queued"]
    assert child_progress[1]["child_terminal"] is True
    assert all(item["child_count"] == 3 for item in child_progress[:3])


def test_delegate_emits_running_transitions_with_monotonic_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        scheduler_module,
        "invoke_sub_agent",
        lambda **kwargs: SubAgentInvocationResult(
            status="completed",
            response_text=str(kwargs["latest_user_content"]),
            decision=_decision(str(kwargs["latest_user_content"])),
            iterations_used=1,
        ),
    )
    runtime = _runtime()
    notifications: list[dict[str, Any]] = []
    runtime.notification_writer = notifications.append

    execute_delegate_tool(
        router=SimpleNamespace(_config=parse_runtime_config({"engine_type": "mock"})),
        arguments={"tasks": ["one", "two", "three"]},
        runtime=runtime,
        outcome_type=ToolExecutionOutcome,
        call_id="call",
    )

    progress = [item["params"] for item in notifications if item["method"] == "agent.progress"]
    child_progress = [item for item in progress if item.get("child_task_id")]
    for ordinal in (1, 2, 3):
        assert [item["status"] for item in child_progress if item["child_ordinal"] == ordinal] == [
            "queued",
            "running",
            "completed",
        ]
    assert [item["percent"] for item in progress] == sorted(item["percent"] for item in progress)
