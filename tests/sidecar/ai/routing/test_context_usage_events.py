"""Mid-turn ``ContextUsageEvent`` emission from the tool loop.

The loop already computes the exact per-iteration context size
(``compact_tool_loop_context`` -> ``BudgetTracker.record_iteration``) and used
to discard it, so the composer context ring showed the PREVIOUS turn's number
for the whole of a long agentic turn. These tests pin the ephemeral snapshot
stream that publishes it:

* one snapshot per loop iteration, with the turn's absolute iteration number
  and the figures the loop actually computed;
* zero snapshots when ``token_budget`` is off (no tracker => byte-identical
  pre-feature behavior);
* zero snapshots when ``context_usage_live`` is off (the sidecar half of the
  two-layer kill switch);
* no repeat snapshot when a reading has not changed.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from sidecar.ai.context.token_budget import BudgetTracker, TokenBudget
from sidecar.ai.feature_flags import (
    FEATURE_CONTEXT_COMPACTION,
    FEATURE_CONTEXT_USAGE_LIVE,
    FEATURE_TOKEN_BUDGET,
)
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_events import ContextUsageEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult, GenerationUsage, ToolCallRequest
from tests.sidecar.ai.routing.test_tool_loop import (
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

_REQUEST_ID = "req_context_usage"
_CONTEXT_WINDOW = 40_000


def _read_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="read_file",
        description="Read a file",
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        side_effecting=False,
        server_name="tools",
        tool_family="filesystem",
    )


def _tool_plan(call_id: str, *, input_tokens: int) -> _ToolPlan:
    return _ToolPlan(
        result=GenerationResult(
            content="",
            finish_reason="tool_calls",
            tool_calls=(
                ToolCallRequest(
                    tool_id="read_file",
                    arguments={"path": f"{call_id}.md"},
                    call_id=call_id,
                ),
            ),
            usage=GenerationUsage(
                input_tokens=input_tokens,
                output_tokens=12,
                total_tokens=input_tokens + 12,
                last_request_input_tokens=input_tokens,
            ),
        ),
    )


def _final_plan() -> _ToolPlan:
    return _ToolPlan(result=GenerationResult(content="All done.", finish_reason="stop"))


def _tracker() -> BudgetTracker:
    budget = TokenBudget(context_window=_CONTEXT_WINDOW, max_output_tokens=2_048)
    return BudgetTracker(budget=budget, num_tools=0, backend=None)


def _install_budget(monkeypatch: pytest.MonkeyPatch, tracker: BudgetTracker) -> None:
    """Hand the routing lane a deterministic budget instead of a real tokenizer."""
    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision.apply_budget_check",
        lambda messages, _config, _engine, *, num_tools=0, reasoning_effort=None: (
            messages,
            tracker.budget,
            tracker,
        ),
    )


def _install_iteration_context_tokens(
    monkeypatch: pytest.MonkeyPatch, values: list[int]
) -> None:
    """Script the per-iteration context size the loop would have measured."""
    remaining = list(values)

    def _fake_compact(_loop: Any, *, num_tools: int = 0) -> int:
        _ = num_tools
        return remaining.pop(0) if remaining else (values[-1] if values else 0)

    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop_compaction.compact_tool_loop_context",
        _fake_compact,
    )


def _run(router: Any, events: list[object]) -> Any:
    return router.build_chat_decision(
        request_id=_REQUEST_ID,
        messages=[{"role": "user", "content": "read the docs"}],
        latest_user_content="read the docs",
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(
            emit=events.append,
            request_id=_REQUEST_ID,
            max_iterations=6,
        ),
    )


def _router(*, flags: dict[str, bool], plans: list[_ToolPlan]) -> Any:
    router = _build_router(
        engine=_ToolLoopEngine(plans=plans),
        mcp_client=_StubMCPClient((_read_descriptor(),)),
    )
    router._config = replace(router._config, feature_flags=dict(flags))
    return router


def _usage_events(events: list[object]) -> list[ContextUsageEvent]:
    return [event for event in events if isinstance(event, ContextUsageEvent)]


def _three_tool_plans() -> list[_ToolPlan]:
    return [
        _tool_plan("call_iter1", input_tokens=1_100),
        _tool_plan("call_iter2", input_tokens=2_200),
        _tool_plan("call_iter3", input_tokens=3_300),
        _final_plan(),
    ]


def test_three_iteration_loop_emits_one_snapshot_per_iteration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tracker = _tracker()
    _install_budget(monkeypatch, tracker)
    # Iteration context sizes strictly above each iteration's provider figure,
    # so ``max(provider, estimate)`` resolves to the sidecar estimate and the
    # numerator is unambiguous.
    _install_iteration_context_tokens(monkeypatch, [9_000, 12_000, 15_000])
    router = _router(
        flags={FEATURE_TOKEN_BUDGET: True, FEATURE_CONTEXT_COMPACTION: True},
        plans=_three_tool_plans(),
    )
    events: list[object] = []

    _run(router, events)

    snapshots = _usage_events(events)
    iterations = [event for event in snapshots if event.phase == "iteration"]
    assert [event.iteration for event in iterations] == [1, 2, 3]
    assert [event.context_used_tokens for event in iterations] == [9_000, 12_000, 15_000]
    assert [event.context_tokens_estimate for event in iterations] == [
        9_000,
        12_000,
        15_000,
    ]
    assert [event.last_request_input_tokens for event in iterations] == [
        1_100,
        2_200,
        3_300,
    ]
    assert {event.context_used_source for event in iterations} == {"estimate"}
    # The denominator is the exact auto-compaction trigger for this budget --
    # the same quantity the terminal usage payload publishes.
    expected_threshold = tracker.budget.auto_compact_threshold(tracker.num_tools)
    assert expected_threshold > 0
    assert {event.compact_threshold_tokens for event in iterations} == {
        expected_threshold
    }
    assert {event.model for event in iterations} == {"qwen"}
    assert {event.provider for event in iterations} == {"ollama"}
    # The preflight reading lands first so the ring stops showing the previous
    # turn's number before the first model call, not after it.
    assert snapshots[0].phase == "preflight"


def test_threshold_is_omitted_when_context_compaction_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Mirror of the terminal lanes' gate: with compaction off the runtime will
    # never act on the auto-compact point, so mid-turn snapshots must not
    # advertise one either (the ring then renders against the raw window).
    tracker = _tracker()
    _install_budget(monkeypatch, tracker)
    _install_iteration_context_tokens(monkeypatch, [9_000])
    router = _router(
        flags={FEATURE_TOKEN_BUDGET: True, FEATURE_CONTEXT_COMPACTION: False},
        plans=[_tool_plan("call_nocompact", input_tokens=1_100), _final_plan()],
    )
    events: list[object] = []

    _run(router, events)

    snapshots = _usage_events(events)
    assert snapshots, "snapshots still flow with compaction disabled"
    assert {event.compact_threshold_tokens for event in snapshots} == {0}


def test_provider_truth_wins_when_it_exceeds_the_sidecar_estimate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tracker = _tracker()
    _install_budget(monkeypatch, tracker)
    _install_iteration_context_tokens(monkeypatch, [400])
    router = _router(
        flags={FEATURE_TOKEN_BUDGET: True},
        plans=[_tool_plan("call_provider", input_tokens=7_500), _final_plan()],
    )
    events: list[object] = []

    _run(router, events)

    iterations = [
        event for event in _usage_events(events) if event.phase == "iteration"
    ]
    assert len(iterations) == 1
    assert iterations[0].context_used_tokens == 7_500
    assert iterations[0].context_used_source == "provider"
    assert iterations[0].context_tokens_estimate == 400


def test_token_budget_off_emits_no_snapshots(monkeypatch: pytest.MonkeyPatch) -> None:
    """No tracker => no meter stream => byte-identical pre-feature behavior."""
    _install_iteration_context_tokens(monkeypatch, [9_000, 12_000, 15_000])
    router = _router(flags={}, plans=_three_tool_plans())
    events: list[object] = []

    _run(router, events)

    assert _usage_events(events) == []


def test_context_usage_live_off_emits_no_snapshots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sidecar half of the two-layer kill switch."""
    _install_budget(monkeypatch, _tracker())
    _install_iteration_context_tokens(monkeypatch, [9_000, 12_000, 15_000])
    router = _router(
        flags={FEATURE_TOKEN_BUDGET: True, FEATURE_CONTEXT_USAGE_LIVE: False},
        plans=_three_tool_plans(),
    )
    events: list[object] = []

    _run(router, events)

    assert _usage_events(events) == []


def test_unchanged_reading_is_not_re_emitted(monkeypatch: pytest.MonkeyPatch) -> None:
    """A repaint for an identical number is noise; the request-scoped memo drops it."""
    _install_budget(monkeypatch, _tracker())
    # Iterations 1 and 2 measure the same context size (a no-op tool result);
    # iteration 3 moves. Provider figures stay below the estimate so they
    # cannot perturb the numerator.
    _install_iteration_context_tokens(monkeypatch, [9_000, 9_000, 11_000])
    router = _router(
        flags={FEATURE_TOKEN_BUDGET: True},
        plans=[
            _tool_plan("call_same1", input_tokens=100),
            _tool_plan("call_same2", input_tokens=100),
            _tool_plan("call_moved", input_tokens=100),
            _final_plan(),
        ],
    )
    events: list[object] = []

    _run(router, events)

    iterations = [
        event for event in _usage_events(events) if event.phase == "iteration"
    ]
    assert [event.iteration for event in iterations] == [1, 3]
    assert [event.context_used_tokens for event in iterations] == [9_000, 11_000]
