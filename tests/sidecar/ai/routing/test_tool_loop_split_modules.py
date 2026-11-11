"""Modules carved out of the tool-loop hub and its runner: replies, result, run lifecycle."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_LOOP_ENGINE_STALLED
from sidecar.ai.routing import (
    tool_loop,
    tool_loop_replies,
    tool_loop_result,
    tool_loop_run,
    tool_loop_run_lifecycle,
)
from sidecar.ai.routing.loop_stop import StopReason
from sidecar.ai.tools.contracts import ToolExecutionFailure


def test_hub_reexports_are_the_carved_out_objects() -> None:
    # Siblings call these as ``_tl_hub.NAME`` and tests patch them on the hub.
    for name in (
        "_empty_post_tool_context_response",
        "_quota_block_guidance",
        "TOOL_NUDGE_FALLBACK_RESPONSE",
        "_TOOL_FAILURE_CONTEXT_NUDGE",
    ):
        assert getattr(tool_loop, name) is getattr(tool_loop_replies, name)
    for name in ("ToolLoopResult", "_build_stopped_tool_loop_result", "GUARDRAIL_FOOTER",
                 "flush_unflushed_terminal_output", "_emit_deterministic_response_tokens"):
        assert getattr(tool_loop, name) is getattr(tool_loop_result, name)
    assert (
        tool_loop_run._CLOUD_PROVIDER_ENGINE_TYPES
        is tool_loop_run_lifecycle._CLOUD_PROVIDER_ENGINE_TYPES
    )
    assert issubclass(tool_loop_run._ToolLoopRun, tool_loop_run_lifecycle._RunLifecycleMixin)


def test_replies_summarize_failed_and_successful_outcomes() -> None:
    outcomes = [
        SimpleNamespace(success=True, tool_name="read_file", output="ok", error_code=None),
        SimpleNamespace(success=False, tool_name="grep", output="boom", error_code="CMP-X-1"),
    ]
    response = tool_loop_replies._empty_post_tool_context_response(outcomes)
    assert response is not None
    assert "read_file: ok" in response
    assert "grep [CMP-X-1]: boom" in response
    assert tool_loop_replies._empty_post_tool_context_response([], lead="Stopped.") is None
    assert "per-turn" in tool_loop_replies._quota_block_guidance("web_per_turn", 10)


def test_stopped_response_keeps_model_text_with_the_guardrail_footer() -> None:
    reason = StopReason(code="CMP-LOOP-0001", message="stopped", decision=None)  # type: ignore[arg-type]
    text, source = tool_loop_result._build_stopped_response_text(reason, "partial")
    assert text == f"partial{tool_loop_result.GUARDRAIL_FOOTER}"
    assert source == "model"
    assert tool_loop_result._build_stopped_response_text(reason, "") == (
        "stopped",
        "deterministic_tool_fallback",
    )


class _Host(tool_loop_run_lifecycle._RunLifecycleMixin):
    def __init__(self, *, engine_type: str, runtime: Any) -> None:
        self.kernel = SimpleNamespace(_config=SimpleNamespace(engine_type=engine_type))
        self.runtime = runtime
        self.gate_iterations_granted = 0
        self.max_iterations = 4
        self.iteration_total = 4
        self.settled: list[str] = []

    def _settle_unfinished_tool_results(self, reason: str) -> int:
        self.settled.append(reason)
        return 0


def test_gate_iteration_grants_widen_both_counters_until_the_cap() -> None:
    from sidecar.ai.routing.verification_gate import GATE_MAX_RETRIES

    host = _Host(engine_type="ollama", runtime=SimpleNamespace())
    grants = [host.grant_gate_iteration() for _ in range(GATE_MAX_RETRIES + 1)]
    assert grants == [True] * GATE_MAX_RETRIES + [False]
    assert host.max_iterations == host.iteration_total == 4 + GATE_MAX_RETRIES
    host.release_gate_iteration()
    assert host.max_iterations == host.iteration_total == 3 + GATE_MAX_RETRIES


@pytest.mark.parametrize(
    ("engine_type", "phrase"),
    [("ollama", "local model did not start"), ("chatgpt", "cloud model provider did not begin")],
)
def test_engine_stall_settles_rows_and_raises_the_coded_failure(
    engine_type: str, phrase: str
) -> None:
    runtime = SimpleNamespace(
        chunk_inactivity_seconds=30.0, stall_phase="model_load", model_load_grace_seconds=240.0
    )
    host = _Host(engine_type=engine_type, runtime=runtime)
    with pytest.raises(ToolExecutionFailure) as raised:
        host._raise_engine_stall()
    assert raised.value.code == CMP_LOOP_ENGINE_STALLED
    assert raised.value.retryable is True
    assert phrase in raised.value.message
    assert "240s" in raised.value.message
    assert host.settled == ["engine_stalled"]
