"""TR-005 follow-up: the local task step limit scales with measured model speed.

Owner decision 2026-09-28: at the default local task cap (30), reaching the cap
re-evaluates it from the mean model-generation wall time of this run:
``min(4 x base, base x ceil(mean_s / 30))`` when the mean is >= 30 s (TR-013:
the mean, not the median, so a model that answers most tool steps in seconds but
spends its time in a few long thinks still scales). An explicit user value, a
cloud engine and chat mode never scale; the working-time limit still ends the
turn.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing.iteration_limits import (
    LoopCapScaler,
    resume_iteration_ceiling,
    scalable_task_loop_base,
    scaled_cap,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest

from .test_tool_loop import (
    _build_router,
    _mermaid_descriptor,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)


class _FakeClock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


class _TimedToolEngine(_ToolLoopEngine):
    """Every generation asks for one distinct tool call and takes ``seconds``.

    ``seconds`` may be a sequence: generation ``n`` takes ``seconds[n % len]``.
    """

    def __init__(
        self, *, clock: _FakeClock, seconds: float | Sequence[float], tool_steps: int
    ) -> None:
        super().__init__(
            plans=[
                _ToolPlan(
                    result=GenerationResult(
                        content="",
                        finish_reason="tool_calls",
                        tool_calls=(
                            ToolCallRequest(
                                tool_id="mermaid_generate",
                                arguments={"prompt": f"flowchart TD\n  A{index} --> B{index}"},
                                call_id=f"call_step_{index}",
                            ),
                        ),
                    )
                )
                for index in range(tool_steps)
            ]
        )
        self._clock = clock
        self._seconds = (
            tuple(seconds) if isinstance(seconds, Sequence) else (float(seconds),)
        )
        self._generations = 0

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self._clock.now += self._seconds[self._generations % len(self._seconds)]
        self._generations += 1
        return super().generate_with_tools(**kwargs)


def _run_turn(  # noqa: PLR0913 - compact scenario builder.
    *,
    seconds: float | Sequence[float],
    tool_steps: int,
    engine_type: str = "ollama",
    task_cap: int | None = None,
    max_iterations: int = 30,
    deadline_seconds: float | None = None,
) -> tuple[_TimedToolEngine, _StubMCPClient, Any]:
    clock = _FakeClock()
    engine = _TimedToolEngine(clock=clock, seconds=seconds, tool_steps=tool_steps)
    mcp_client = _StubMCPClient((_mermaid_descriptor(),))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
        max_tools_per_turn=500,
        engine_type=engine_type,
    )
    if task_cap is not None:
        router._config = replace(router._config, max_task_loop_iterations=task_cap)
    runtime = LoopRuntime(
        request_id="req_loop_cap",
        max_iterations=max_iterations,
        clock=clock,
        wall_clock_deadline=(
            clock.now + deadline_seconds if deadline_seconds is not None else None
        ),
    )
    decision = router.build_chat_decision(
        request_id="req_loop_cap",
        messages=[{"role": "user", "content": "Draw every diagram."}],
        latest_user_content="Draw every diagram.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=runtime,
    )
    return engine, mcp_client, decision


def _extension_records(caplog: pytest.LogCaptureFixture) -> list[dict[str, Any]]:
    return [
        record.__dict__["data"]
        for record in caplog.records
        if record.__dict__.get("event") == "ai.router.loop_cap_extended"
    ]


# -- Pure policy ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("mean_s", "expected"),
    [(0.5, 30), (29.9, 30), (30.0, 30), (31.0, 60), (45.0, 60), (120.0, 120), (230.0, 120)],
)
def test_scaled_cap_follows_the_owner_formula(mean_s: float, expected: int) -> None:
    assert scaled_cap(30, mean_s) == expected


# G2 (Bonsai 2, 2026-09-28, stream_bed4453b): most tool steps come back in ~5 s,
# the time goes into a few 250-1350 s thinks. Median 5 s, mean ~108 s.
_G2_LIKE_STEP_SECONDS = (5.0,) * 13 + (250.0,) + (5.0,) * 7 + (1_350.0,) + (4.7,) * 5 + (
    600.0,
    5.0,
    900.0,
)


def _scaler(iteration_base: int = 0, max_iterations: int = 30) -> LoopCapScaler:
    return LoopCapScaler.for_run(
        RuntimeConfig(engine_type="llama-server", model="bonsai"),
        request_context=SimpleNamespace(mode="assist", agent_surface="main"),
        iteration_base=iteration_base,
        max_iterations=max_iterations,
    )


def test_mostly_fast_steps_with_long_thinks_extend_the_cap() -> None:
    """TR-013: the median (5 s) hid the slow thinks; the mean does not."""
    scaler = _scaler()
    for seconds in _G2_LIKE_STEP_SECONDS:
        scaler.record_generation(seconds)

    assert scaler.mean_seconds() == pytest.approx(
        sum(_G2_LIKE_STEP_SECONDS) / len(_G2_LIKE_STEP_SECONDS)
    )
    assert scaler.claim_extension() == 90
    assert scaler.allowed_total == 120


def test_uniformly_fast_steps_below_the_mean_threshold_never_extend() -> None:
    scaler = _scaler()
    for seconds in (5.0, 29.0, 12.0, 28.0, 25.0) * 6:
        scaler.record_generation(seconds)

    assert scaler.mean_seconds() is not None and scaler.mean_seconds() < 30.0
    assert scaler.pending_extension() == 0
    assert scaler.claim_extension() == 0


def test_only_a_local_default_task_cap_may_scale() -> None:
    local = RuntimeConfig(engine_type="llama-server", model="bonsai")
    assert scalable_task_loop_base(local, mode="assist", agent_surface="main") == 30
    assert scalable_task_loop_base(local, mode="task", agent_surface=None) == 30
    # Chat mode, sub-agents, cloud engines and explicit values keep a hard cap.
    assert scalable_task_loop_base(local, mode="chat", agent_surface="main") is None
    assert scalable_task_loop_base(local, mode="assist", agent_surface="sub_agent") is None
    cloud = RuntimeConfig(engine_type="chatgpt", model="gpt")
    assert scalable_task_loop_base(cloud, mode="assist", agent_surface="main") is None
    explicit = replace(local, max_task_loop_iterations=40)
    assert scalable_task_loop_base(explicit, mode="assist", agent_surface="main") is None
    legacy = replace(local, feature_flags={"resource_discipline": False})
    assert scalable_task_loop_base(legacy, mode="assist", agent_surface="main") is None


def test_resumed_run_counts_the_previous_legs_budget() -> None:
    config = RuntimeConfig(engine_type="ollama", model="qwen")
    request_context = SimpleNamespace(mode="assist", agent_surface="main")
    scaler = LoopCapScaler.for_run(
        config,
        request_context=request_context,
        iteration_base=12,
        max_iterations=18,
    )
    assert scaler.allowed_total == 30
    for _ in range(18):
        scaler.record_generation(120.0)
    assert scaler.claim_extension() == 90
    assert scaler.allowed_total == 120
    assert scaler.claim_extension() == 0


def test_plan_build_leg_scales_from_its_fresh_step_budget() -> None:
    """TR-013 (b): planning used 15 steps; the build leg resumes with a fresh 30.

    The leg's scaler starts from that fresh budget (15 + 30 = 45 turn-absolute)
    and a slow model still earns its extension on top of it.
    """
    scaler = _scaler(iteration_base=15, max_iterations=30)
    assert scaler.allowed_total == 45
    for seconds in _G2_LIKE_STEP_SECONDS:
        scaler.record_generation(seconds)

    assert scaler.claim_extension() == 75
    assert scaler.allowed_total == 120


def test_fast_model_never_extends_a_smaller_caller_budget() -> None:
    config = RuntimeConfig(engine_type="ollama", model="qwen")
    request_context = SimpleNamespace(mode="assist", agent_surface="main")
    scaler = LoopCapScaler.for_run(
        config,
        request_context=request_context,
        iteration_base=0,
        max_iterations=1,
    )
    scaler.record_generation(0.2)
    assert scaler.pending_extension() == 0
    assert scaler.claim_extension() == 0


# -- Through the real tool loop --------------------------------------------------


def test_fast_local_model_still_stops_at_the_default_cap(caplog) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")

    _engine, mcp_client, decision = _run_turn(seconds=5.0, tool_steps=40)

    assert len(mcp_client.executions) == 30
    assert decision.resumable_stop == "max_iterations"
    assert _extension_records(caplog) == []


def test_slow_local_model_extends_the_default_cap_to_four_times(caplog) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")

    _engine, mcp_client, decision = _run_turn(seconds=120.0, tool_steps=130)

    assert len(mcp_client.executions) == 120
    assert decision.resumable_stop == "max_iterations"
    extensions = _extension_records(caplog)
    assert len(extensions) == 1
    assert extensions[0]["base"] == 30
    assert extensions[0]["mean_s"] == 120.0
    assert extensions[0]["new_cap"] == 120


def test_g2_like_timings_extend_the_cap_through_the_real_loop(caplog) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")

    _engine, mcp_client, decision = _run_turn(seconds=_G2_LIKE_STEP_SECONDS, tool_steps=130)

    extensions = _extension_records(caplog)
    assert extensions, "a G2-like turn must extend the default cap"
    assert extensions[0]["new_cap"] == 120
    assert extensions[0]["mean_s"] > 30.0
    assert len(mcp_client.executions) == 120
    assert decision.resumable_stop == "max_iterations"


def test_mixed_fast_run_with_a_mean_below_threshold_stops_at_the_cap(caplog) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")

    _engine, mcp_client, decision = _run_turn(
        seconds=(5.0, 29.0, 12.0, 28.0, 25.0), tool_steps=40
    )

    assert len(mcp_client.executions) == 30
    assert decision.resumable_stop == "max_iterations"
    assert _extension_records(caplog) == []


def test_moderately_slow_model_is_re_evaluated_at_each_extended_cap(caplog) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")

    # 45 s per step -> ceil(45 / 30) = 2 -> 60 steps, and no further growth.
    _engine, mcp_client, _decision = _run_turn(seconds=45.0, tool_steps=130)

    assert len(mcp_client.executions) == 60
    assert [record["new_cap"] for record in _extension_records(caplog)] == [60]


def test_explicit_user_cap_is_a_hard_cap(caplog) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")

    _engine, mcp_client, _decision = _run_turn(
        seconds=120.0, tool_steps=130, task_cap=40, max_iterations=40
    )

    assert len(mcp_client.executions) == 40
    assert _extension_records(caplog) == []


def test_cloud_engine_cap_is_unchanged(caplog) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")

    _engine, mcp_client, _decision = _run_turn(
        seconds=120.0, tool_steps=40, engine_type="chatgpt"
    )

    assert len(mcp_client.executions) == 30
    assert _extension_records(caplog) == []


def test_working_time_limit_still_ends_an_extended_turn(caplog) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")

    # The cap extends at step 30 (3600 s), but the 4800 s working-time limit
    # ends the turn long before the extended cap of 120 steps.
    engine, mcp_client, decision = _run_turn(
        seconds=120.0, tool_steps=130, deadline_seconds=4_800.0
    )

    assert [record["new_cap"] for record in _extension_records(caplog)] == [120]
    # 40 generations x 120 s reach the 4800 s limit; the 40th step's tool call
    # never runs and the turn ends on the working-time limit, not the step cap.
    assert engine.call_count == 40
    assert len(mcp_client.executions) == 39
    assert decision.resumable_stop is None
    assert "wall-clock limit exceeded" in decision.response_text


def test_slow_model_is_not_told_to_wind_down_at_the_base_cap() -> None:
    engine, _mcp_client, _decision = _run_turn(seconds=120.0, tool_steps=130)

    def wind_down_injected_at(request_index: int) -> bool:
        messages = engine.requests[request_index].get("messages") or []
        return any(
            "nearing the iteration limit" in str(message.get("content") or "")
            for message in messages
            if isinstance(message, dict)
        )

    # 75% of the base cap (step 22) passes without the wrap-up nudge; it lands
    # at 75% of the extended cap (step 90) instead.
    assert not wind_down_injected_at(29)
    assert wind_down_injected_at(90)


# --- Fable B2 review P1: a paused extended turn must still resume ---------------


def _paused_checkpoint(remaining: int) -> dict:
    return {
        "kind": "before_tool_dispatch",
        "position": {
            "remaining_iterations": remaining,
            "active_budget_ms_remaining": None,
            "completed_iterations": 45,
            "current_iteration": 45,
            "tool_call_limit": None,
            "tool_calls_consumed": 0,
            "ordered_call_ids": [],
        },
    }


def _fresh_runtime() -> SimpleNamespace:
    return SimpleNamespace(
        max_iterations=30,
        clock=lambda: 0.0,
        wall_clock_deadline=None,
        turn_call_ids=set(),
    )


def test_resume_accepts_the_remaining_steps_of_an_extended_cap() -> None:
    """A slow model earned 120 steps and paused at 45: resume keeps its 75."""
    from sidecar.runtime import chat_continuation_resume as resume

    config = RuntimeConfig(engine_type="llama-server", model="bonsai")
    request_context = SimpleNamespace(mode="assist", agent_surface="main")
    runtime = _fresh_runtime()
    ceiling = resume_iteration_ceiling(runtime, config, request_context)

    resume._restore_runtime_position(runtime, _paused_checkpoint(75), ceiling)

    assert runtime.max_iterations == 75
    assert runtime.iteration_base == 45


@pytest.mark.parametrize(
    ("config", "mode"),
    [
        (RuntimeConfig(engine_type="llama-server", model="bonsai", max_task_loop_iterations=40), "assist"),
        (RuntimeConfig(engine_type="chatgpt", model="gpt"), "assist"),
        (RuntimeConfig(engine_type="llama-server", model="bonsai"), "chat"),
    ],
)
def test_resume_still_refuses_more_steps_than_a_non_scaling_run_allows(config, mode) -> None:
    from sidecar.ai.tools.contracts import ToolExecutionFailure
    from sidecar.runtime import chat_continuation_resume as resume

    runtime = _fresh_runtime()
    ceiling = resume_iteration_ceiling(
        runtime, config, SimpleNamespace(mode=mode, agent_surface="main")
    )
    with pytest.raises(ToolExecutionFailure, match="iteration_budget_changed"):
        resume._restore_runtime_position(runtime, _paused_checkpoint(75), ceiling)


def test_resume_refuses_beyond_the_scaler_ceiling() -> None:
    from sidecar.ai.tools.contracts import ToolExecutionFailure
    from sidecar.runtime import chat_continuation_resume as resume

    config = RuntimeConfig(engine_type="llama-server", model="bonsai")
    runtime = _fresh_runtime()
    ceiling = resume_iteration_ceiling(
        runtime, config, SimpleNamespace(mode="assist", agent_surface="main")
    )
    assert ceiling == 120
    with pytest.raises(ToolExecutionFailure, match="iteration_budget_changed"):
        resume._restore_runtime_position(runtime, _paused_checkpoint(121), ceiling)


def test_durable_decision_resume_keeps_the_saved_step_budget() -> None:
    """TR-013 (b): only the live plan approval resets the step budget.

    A plan decision restored from its durable checkpoint (app restart while the
    approval was pending) resumes with the remaining steps it saved, as TR-004
    keeps the saved working time.
    """
    from sidecar.runtime import chat_continuation_resume as resume

    config = RuntimeConfig(engine_type="llama-server", model="bonsai")
    request_context = SimpleNamespace(mode="assist", agent_surface="main")
    runtime = _fresh_runtime()
    checkpoint = _paused_checkpoint(12)
    checkpoint["kind"] = "before_decision_wait"

    resume._restore_runtime_position(
        runtime, checkpoint, resume_iteration_ceiling(runtime, config, request_context)
    )

    assert runtime.max_iterations == 12
    assert runtime.iteration_base == 45
