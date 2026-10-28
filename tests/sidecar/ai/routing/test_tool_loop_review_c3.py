"""Tool-loop core review C3: resume wind-down, incremental estimates, single settle."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from sidecar.ai.context.token_budget import TokenBudget, estimate_messages_tokens
from sidecar.ai.error_codes import CMP_TOOL_BACKGROUND_NOT_FOUND
from sidecar.ai.routing import chat_decision, mutation_change_set_lifecycle
from sidecar.ai.routing.iteration_limits import append_wind_down_system_message
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_loop_compaction import (
    compact_tool_loop_context,
    note_request_measurement,
)
from sidecar.ai.routing.tool_loop_cycle_recovery import MissingStatusCounter
from sidecar.ai.routing.tool_loop_run import _ToolLoopRun
from sidecar.ai.tools.models import GenerationResult

from .test_tool_loop import _build_router, _ToolLoopEngine, _ToolPlan

_WIND_DOWN_MARKER = "nearing the iteration limit"


def _final_plan() -> _ToolPlan:
    return _ToolPlan(result=GenerationResult(content="All done.", finish_reason="stop"))


def _resumed_leg(
    monkeypatch: pytest.MonkeyPatch, *, replay_row: bool, iteration_base: int = 8
) -> _ToolLoopEngine:
    real_run_tool_loop = chat_decision.run_tool_loop

    def _replaying_run_tool_loop(**kwargs: Any) -> Any:
        # chat_resume replays the paused leg's working messages; an earlier leg
        # past the 75% mark left its wind-down row in them.
        if replay_row:
            append_wind_down_system_message(kwargs["working_messages"])
        return real_run_tool_loop(**kwargs)

    monkeypatch.setattr(chat_decision, "run_tool_loop", _replaying_run_tool_loop)
    engine = _ToolLoopEngine(plans=[_final_plan()])
    router = _build_router(engine=engine)
    router.build_chat_decision(
        request_id="req_c3_wind_down",
        messages=[{"role": "user", "content": "Finish the task."}],
        latest_user_content="Finish the task.",
        mode="assist",
        approvals_pre_granted=True,
        # 10 steps in all; this leg's first step (9) is past the 75% mark (7).
        runtime=LoopRuntime(
            request_id="req_c3_wind_down",
            max_iterations=2,
            iteration_base=iteration_base,
        ),
    )
    return engine


def _wind_down_rows(engine: _ToolLoopEngine) -> int:
    messages = engine.requests[0].get("messages") or []
    return sum(
        _WIND_DOWN_MARKER in str(message.get("content") or "")
        for message in messages
        if isinstance(message, dict)
    )


def test_a_resumed_leg_past_the_mark_does_not_add_a_second_wind_down_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _resumed_leg(monkeypatch, replay_row=True)

    assert _wind_down_rows(engine) == 1


def test_a_resumed_leg_without_the_row_still_gets_one(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = _resumed_leg(monkeypatch, replay_row=False)

    assert _wind_down_rows(engine) == 1


def test_a_first_leg_does_not_trust_an_old_row(monkeypatch: pytest.MonkeyPatch) -> None:
    # Only a resumed leg (iteration_base > 0) replays this turn's own history.
    engine = _resumed_leg(monkeypatch, replay_row=True, iteration_base=0)

    assert _wind_down_rows(engine) == 2


class _CountingBackend:
    def __init__(self) -> None:
        self.seen: list[str] = []

    def count_tokens(self, text: str) -> int:
        self.seen.append(text)
        return max(1, len(text) // 4)


def _compaction_loop(messages: list[dict[str, Any]], backend: _CountingBackend) -> Any:
    runtime = MagicMock()
    runtime._preview_context_tokens.return_value = 0
    return SimpleNamespace(
        budget_tracker=SimpleNamespace(
            budget=TokenBudget(context_window=22_000, max_output_tokens=8_192),
            backend=backend,
            raw_context_window=32_768,
        ),
        runtime=runtime,
        working_messages=messages,
        feature_flags={"context_compaction": True},
        compaction_stalled=False,
        request_measurement=None,
    )


def test_the_post_tool_estimate_does_not_retokenize_the_measured_prefix() -> None:
    backend = _CountingBackend()
    messages = [{"role": "user", "content": f"prefix row {index}"} for index in range(6)]
    loop = _compaction_loop(messages, backend)
    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=900))
    messages.append({"role": "tool", "content": "new tool result"})
    backend.seen.clear()

    compact_tool_loop_context(loop, num_tools=0)

    assert backend.seen == ["new tool result"]
    assert loop.meter_estimate_tokens == estimate_messages_tokens(messages, _CountingBackend())


def test_the_next_measurement_also_folds_in_only_the_new_rows() -> None:
    backend = _CountingBackend()
    messages = [{"role": "user", "content": "task"}]
    loop = _compaction_loop(messages, backend)
    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=500))
    messages.append({"role": "assistant", "content": "next step"})
    backend.seen.clear()

    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=600))

    assert backend.seen == ["next step"]
    assert loop.request_measurement.estimate == estimate_messages_tokens(
        messages, _CountingBackend()
    )


def test_a_failing_turn_settles_its_change_set_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    real_finish = mutation_change_set_lifecycle.finish_run_change_set

    def _counting_finish(run: Any, **kwargs: Any) -> Any:
        calls.append(str(kwargs.get("reason")))
        return real_finish(run, **kwargs)

    monkeypatch.setattr(
        mutation_change_set_lifecycle, "finish_run_change_set", _counting_finish
    )

    class _RaisingEngine(_ToolLoopEngine):
        def generate_with_tools(self, **_kwargs: Any) -> GenerationResult:
            raise RuntimeError("provider exploded")

    router = _build_router(engine=_RaisingEngine(plans=[]))
    with pytest.raises(Exception):  # noqa: B017 - the router may wrap the error.
        router.build_chat_decision(
            request_id="req_c3_settle",
            messages=[{"role": "user", "content": "Do it."}],
            latest_user_content="Do it.",
            mode="assist",
            approvals_pre_granted=True,
            runtime=LoopRuntime(request_id="req_c3_settle", max_iterations=2),
        )

    assert len(calls) == 1
    assert calls[0].startswith("exception:")


class _Outcome:
    """Counts reads so a rescan of an already-folded outcome is visible."""

    reads = 0

    def __init__(self, tool_name: str) -> None:
        self._tool_name = tool_name
        self.error_code = CMP_TOOL_BACKGROUND_NOT_FOUND

    @property
    def tool_name(self) -> str:
        _Outcome.reads += 1
        return self._tool_name


def test_missing_status_counter_folds_each_outcome_once() -> None:
    counter = MissingStatusCounter()
    outcomes = [_Outcome("check_background_job"), _Outcome("check_background_job")]
    assert counter.retired(outcomes) == frozenset()

    _Outcome.reads = 0
    outcomes.append(_Outcome("check_background_job"))

    assert counter.retired(outcomes) == frozenset({"check_background_job"})
    assert _Outcome.reads == 1


def test_an_unused_gate_grant_is_handed_back() -> None:
    run = SimpleNamespace(gate_iterations_granted=0, max_iterations=8, iteration_total=8)

    assert _ToolLoopRun.grant_gate_iteration(run) is True
    _ToolLoopRun.release_gate_iteration(run)

    assert (run.gate_iterations_granted, run.max_iterations, run.iteration_total) == (0, 8, 8)
