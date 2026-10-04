"""The tool loop appends the TR-015 write-progress nudge during approved-plan builds."""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.write_progress import (
    IGNORED_CALLS_BEFORE_ESCALATION,
    READS_WITHOUT_WRITE_LIMIT,
    WriteProgress,
    append_write_progress_nudge,
)
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.chat_models import ChatRequestContext
from tests.sidecar.ai.routing.test_tool_loop import (
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

_NUDGE_MARKER = "read-only tool calls since your last file write"
_APPROVED_PLAN = {"title": "Build the reporter", "steps": ["Write reporting.py"]}


def _descriptor(name: str, *, side_effecting: bool) -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name=name,
        description=f"{name} stub.",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
        side_effecting=side_effecting,
        server_name="stub",
    )


def _read_plans(read_count: int) -> list[_ToolPlan]:
    calls = tuple(
        ToolCallRequest(
            tool_id="read_file",
            arguments={"path": f"module_{index}.py"},
            call_id=f"read_{index}",
        )
        for index in range(read_count)
    )
    return [
        _ToolPlan(
            result=GenerationResult(
                content="Reading.", tool_calls=calls, finish_reason="tool_calls"
            )
        ),
        _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
    ]


def _read_batches(*counts: int) -> list[_ToolPlan]:
    plans = []
    for batch, count in enumerate(counts):
        calls = tuple(
            ToolCallRequest(
                tool_id="read_file",
                arguments={"path": "bank_recon/matching.py"},
                call_id=f"read_{batch}_{index}",
            )
            for index in range(count)
        )
        plans.append(
            _ToolPlan(
                result=GenerationResult(
                    content="Checking once more.", tool_calls=calls, finish_reason="tool_calls"
                )
            )
        )
    plans.append(_ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")))
    return plans


def _run_turn(
    read_count: int, *, plans: list[_ToolPlan] | None = None, **context_overrides: Any
) -> _ToolLoopEngine:
    engine = _ToolLoopEngine(plans or _read_plans(read_count))
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient(
            (
                _descriptor("read_file", side_effecting=False),
                _descriptor("edit_file", side_effecting=True),
            )
        ),
        max_tools_per_turn=64,
    )
    router._config = replace(router._config, max_tokens=4096)
    context = ChatRequestContext(
        request_id="req_write_progress",
        trace_id="trace_write_progress",
        session_id="session_write_progress",
        mode="assist",
        approvals_pre_granted=False,
        workspace_root_present=True,
        **context_overrides,
    )
    router.build_chat_decision(
        request_id=context.request_id,
        messages=[{"role": "user", "content": "Build the reporter."}],
        latest_user_content="Build the reporter.",
        mode="assist",
        approvals_pre_granted=False,
        request_context=context,
        runtime=LoopRuntime(
            request_id=context.request_id, request_context=context, max_iterations=12
        ),
    )
    return engine


def _nudge_rows(engine: _ToolLoopEngine) -> list[dict[str, Any]]:
    assert len(engine.requests) >= 2
    # The loop appends a system row; local engine builders demote non-leading
    # system rows to the user tier before dispatch, so accept either role.
    return [
        message
        for message in engine.requests[1]["messages"]
        if message.get("role") in {"system", "user"}
        and _NUDGE_MARKER in str(message.get("content"))
    ]


def test_tool_loop_appends_write_progress_nudge_after_read_streak() -> None:
    engine = _run_turn(READS_WITHOUT_WRITE_LIMIT, approved_plan=_APPROVED_PLAN)

    rows = _nudge_rows(engine)
    assert len(rows) == 1
    assert engine.requests[1]["messages"][-1] is rows[0]
    assert f"{READS_WITHOUT_WRITE_LIMIT} read-only tool calls" in str(rows[0]["content"])


def test_tool_loop_appends_nudge_when_the_plan_was_approved_in_turn() -> None:
    engine = _run_turn(READS_WITHOUT_WRITE_LIMIT, plan_approved_in_turn=True)

    assert len(_nudge_rows(engine)) == 1


def test_no_nudge_below_the_read_limit() -> None:
    engine = _run_turn(READS_WITHOUT_WRITE_LIMIT - 1, approved_plan=_APPROVED_PLAN)

    assert _nudge_rows(engine) == []


@pytest.mark.parametrize("mode_flag", ["plan_mode", "read_only"])
def test_no_nudge_in_plan_mode_or_read_only(mode_flag: str) -> None:
    engine = _run_turn(
        READS_WITHOUT_WRITE_LIMIT + 8, approved_plan=_APPROVED_PLAN, **{mode_flag: True}
    )

    assert _nudge_rows(engine) == []


def test_no_nudge_without_an_approved_plan() -> None:
    engine = _run_turn(20)

    assert _nudge_rows(engine) == []


def _tool_names(request: dict[str, Any]) -> list[str]:
    names = []
    for schema in request.get("tools") or []:
        function = schema.get("function") if isinstance(schema.get("function"), dict) else schema
        names.append(str(function.get("name")))
    return names


# TR-015 reopen: in G5 the model acknowledged the nudge and kept verifying.
def test_ignored_nudges_escalate_then_offer_only_write_tools_for_one_step() -> None:
    ignored = IGNORED_CALLS_BEFORE_ESCALATION
    engine = _run_turn(
        0,
        plans=_read_batches(READS_WITHOUT_WRITE_LIMIT, ignored, ignored, 1),
        approved_plan=_APPROVED_PLAN,
    )

    assert len(engine.requests) == 5
    directive = str(engine.requests[2]["messages"][-1]["content"])
    assert "must be edit_file" in directive
    assert "bank_recon/matching.py" in directive
    assert "only write_file and edit_file" in str(engine.requests[3]["messages"][-1]["content"])
    assert "read_file" in _tool_names(engine.requests[2])
    assert _tool_names(engine.requests[3]) == ["edit_file"]
    assert "read_file" in _tool_names(engine.requests[4]), "the gate lasts one step"


# TR-015 Day 5b: every approval resume builds a new loop run, which used to
# start a fresh tracker and lose the outstanding instruction and stall count.
def _outcomes(tool_name: str, count: int) -> list[ToolExecutionOutcome]:
    return [ToolExecutionOutcome(tool_name=tool_name, output="ok", success=True)] * count


def _run(
    outcomes: list[Any], messages: list[dict[str, Any]], **context: Any
) -> SimpleNamespace:
    """A loop run as the approval resume builds it: carried state, no tracker."""
    return SimpleNamespace(
        plan_mode=False,
        read_only=False,
        request_context=SimpleNamespace(**({"approved_plan": _APPROVED_PLAN} | context)),
        tool_contract=SimpleNamespace(available_names=("read_file", "edit_file")),
        outcomes=list(outcomes),
        working_messages=list(messages),
    )


def _tool_phase(run: SimpleNamespace, batch: list[Any]) -> dict[str, Any] | None:
    """Mirror the loop seam: tool rows land, then the tracker folds the batch."""
    before = len(run.working_messages)
    run.outcomes.extend(batch)
    run.working_messages.extend(
        {"role": "tool", "name": outcome.tool_name, "content": "ok"} for outcome in batch
    )
    append_write_progress_nudge(run, batch)
    added = run.working_messages[before + len(batch):]
    return added[-1] if added else None


_START = [{"role": "system", "content": "prompt"}, {"role": "user", "content": "Build it."}]


def test_escalation_survives_an_approval_resume() -> None:
    run_a = _run([], _START)
    nudge = _tool_phase(run_a, _outcomes("read_file", READS_WITHOUT_WRITE_LIMIT))
    assert nudge is not None and _NUDGE_MARKER in nudge["content"]
    # The next call needed approval: chat_resume ran it and built a new run.
    approved = _outcomes("run_temp_script", 1)
    run_b = _run(
        [*run_a.outcomes, *approved],
        [*run_a.working_messages, {"role": "tool", "name": "run_temp_script", "content": "ok"}],
    )

    row = _tool_phase(run_b, _outcomes("read_file", IGNORED_CALLS_BEFORE_ESCALATION - 1))

    assert row is not None, "the ignored nudge must escalate in the resumed run"
    assert "must be edit_file" in row["content"]


def test_rehydration_ignores_reads_before_the_plan_approval() -> None:
    planning = _outcomes("read_file", 20)
    exit_plan = _outcomes("exit_plan_mode", 1)
    messages = [*_START, *({"role": "tool", "content": "ok"} for _ in range(21))]
    run = _run([*planning, *exit_plan], messages, approved_plan=None, plan_approved_in_turn=True)

    assert _tool_phase(run, _outcomes("read_file", 2)) is None


def test_rehydration_counts_sent_nudges_from_working_messages() -> None:
    sent = WriteProgress()
    messages = list(_START)
    outcomes: list[Any] = []
    for _ in range(2):
        sent.observe(_outcomes("read_file", READS_WITHOUT_WRITE_LIMIT))
        text = sent.nudge_text()
        assert text is not None
        outcomes += [*_outcomes("read_file", READS_WITHOUT_WRITE_LIMIT), *_outcomes("edit_file", 1)]
        messages += [{"role": "tool", "content": "ok"}] * READS_WITHOUT_WRITE_LIMIT
        messages += [{"role": "system", "content": text}, {"role": "tool", "content": "ok"}]
    run = _run(outcomes, messages)

    assert _tool_phase(run, _outcomes("read_file", READS_WITHOUT_WRITE_LIMIT)) is None
