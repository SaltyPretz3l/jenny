from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.feature_flags import FEATURE_PHASE_EVENTS
from sidecar.ai.routing import tool_call_retry, tool_loop
from sidecar.ai.routing.generation_runtime_stream import stream_generate_with_tools
from sidecar.ai.routing.loop_events import PhaseStartedEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.routing.tool_loop_finalize import _FinalResponseMixin
from sidecar.ai.tools.models import GenerationResult, ThinkingDelta

_MAX_CHECKPOINTS = 3
_CARRY_CHARS = 12_000
_ELISION_NOTE = "[... earlier reasoning elided at a thinking-budget checkpoint ...]"
_CARRY_FRAME = "(my reasoning so far, continued after a thinking-budget checkpoint)\n"
_NUDGE = (
    "You hit a thinking-budget checkpoint. Your reasoning so far is preserved above. "
    "Act now - emit your tool calls or your final answer. Be decisive; do not restart "
    "your analysis."
)


class _SequenceEngine:
    def __init__(self, results: list[GenerationResult]) -> None:
        self.results = list(results)
        self.calls: list[dict[str, Any]] = []

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.calls.append(kwargs)
        return self.results.pop(0)

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _MCPClient:
    @property
    def available_tools(self) -> list[Any]:
        return []

    def tool_descriptor(self, _tool_name: str) -> None:
        return None


def _result(
    finish_reason: str,
    *,
    content: str = "",
    thinking_text: str = "",
    inband_tool_call_parse_failed: bool = False,
) -> GenerationResult:
    return GenerationResult(
        content=content,
        finish_reason=finish_reason,
        thinking_text=thinking_text,
        inband_tool_call_parse_failed=inband_tool_call_parse_failed,
    )


def _run_results(
    monkeypatch: pytest.MonkeyPatch,
    results: list[GenerationResult],
    *,
    max_iterations: int,
) -> tuple[Any, Any, LoopRuntime, _SequenceEngine]:
    captured: dict[str, Any] = {}
    engine = _SequenceEngine(results)
    config = replace(
        RuntimeConfig(
            engine_type="ollama",
            model="qwen",
            tools_workspace_root="C:/workspace",
        ),
        mode="assist",
    )
    router = ChatRouter(
        config=config,
        engine=engine,
        mcp_client=_MCPClient(),
        context_builder=ContextBuilder(None),
    )
    router.set_harness_snapshot_provider(lambda **_kwargs: {"tools": {"items": []}})
    runtime = LoopRuntime(request_id="req_checkpoint", max_iterations=max_iterations)

    with monkeypatch.context() as patch:
        original_run = tool_loop._ToolLoopRun

        class _CapturingRun(original_run):
            def __init__(self, **kwargs: Any) -> None:
                super().__init__(**kwargs)
                captured["run"] = self

        patch.setattr(tool_loop, "_ToolLoopRun", _CapturingRun)
        decision = router.build_chat_decision(
            request_id=runtime.request_id,
            messages=[{"role": "user", "content": "Finish the long task."}],
            latest_user_content="Finish the long task.",
            mode="assist",
            approvals_pre_granted=False,
            runtime=runtime,
        )

    return decision, captured["run"], runtime, engine


def _checkpoint_messages(run: Any) -> list[dict[str, object]]:
    return [
        message
        for message in run.working_messages
        if "thinking-budget checkpoint" in str(message.get("content", ""))
    ]


def test_checkpoint_continues_instead_of_failing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result("thinking_budget", thinking_text="reasoning one"),
            _result("thinking_budget", thinking_text="reasoning two"),
            _result("stop", content="Finished answer."),
        ],
        max_iterations=5,
    )

    assert decision.response_text == "Finished answer."
    assert decision.terminal_error_code is None
    assert run.thinking_budget_checkpoints == 2
    assert len(engine.calls) == 3
    assert _checkpoint_messages(run) == [
        {"role": "assistant", "content": f"{_CARRY_FRAME}reasoning one"},
        {"role": "system", "content": _NUDGE},
        {"role": "assistant", "content": f"{_CARRY_FRAME}reasoning two"},
        {"role": "system", "content": _NUDGE},
    ]


def test_checkpoint_exhaustion_falls_through_to_fence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result("thinking_budget", thinking_text=f"cycle {cycle}")
            for cycle in range(_MAX_CHECKPOINTS + 1)
        ],
        max_iterations=_MAX_CHECKPOINTS + 1,
    )

    assert decision.terminal_error_code == "CMP-STREAM-INCOMPLETE"
    assert decision.terminal_error_retryable is True
    assert run.thinking_budget_checkpoints == _MAX_CHECKPOINTS
    assert len(engine.calls) == _MAX_CHECKPOINTS + 1


def test_last_iteration_never_checkpoints(monkeypatch: pytest.MonkeyPatch) -> None:
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [_result("thinking_budget", thinking_text="last iteration")],
        max_iterations=1,
    )

    assert decision.terminal_error_code == "CMP-STREAM-INCOMPLETE"
    assert decision.terminal_error_retryable is True
    assert run.thinking_budget_checkpoints == 0
    assert len(engine.calls) == 1
    assert _checkpoint_messages(run) == []


def test_length_empty_is_checkpoint_length_with_text_is_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    empty_decision, empty_run, _runtime, empty_engine = _run_results(
        monkeypatch,
        [
            _result("length", content="   ", thinking_text="reasoning tail"),
            _result("stop", content="Recovered answer."),
        ],
        max_iterations=2,
    )
    text_decision, text_run, _runtime, text_engine = _run_results(
        monkeypatch,
        [_result("length", content="Usable visible answer.")],
        max_iterations=2,
    )

    assert empty_decision.response_text == "Recovered answer."
    assert empty_decision.terminal_error_code is None
    assert empty_run.thinking_budget_checkpoints == 1
    assert len(empty_engine.calls) == 2
    assert text_decision.response_text == "Usable visible answer."
    assert text_decision.terminal_error_code is None
    assert text_run.thinking_budget_checkpoints == 0
    assert len(text_engine.calls) == 1


def test_kill_switch_off_restores_terminal_behavior(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_CONTINUATION", "0")
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [_result("thinking_budget", thinking_text="guarded reasoning")],
        max_iterations=4,
    )

    assert decision.terminal_error_code == "CMP-STREAM-INCOMPLETE"
    assert decision.terminal_error_retryable is True
    assert run.thinking_budget_checkpoints == 0
    assert len(engine.calls) == 1


def test_carry_is_bounded_tail_and_marked(monkeypatch: pytest.MonkeyPatch) -> None:
    reasoning = "HEAD-" + ("x" * 199_800) + "TAIL-" + ("z" * 190)
    decision, run, _runtime, _engine = _run_results(
        monkeypatch,
        [
            _result("thinking_budget", thinking_text=reasoning),
            _result("stop", content="Done."),
        ],
        max_iterations=2,
    )

    assert decision.response_text == "Done."
    carried = next(
        str(message["content"])
        for message in run.working_messages
        if message.get("role") == "assistant"
        and str(message.get("content", "")).startswith(_CARRY_FRAME)
    )
    assert len(carried) <= len(_CARRY_FRAME) + len(_ELISION_NOTE) + 1 + _CARRY_CHARS
    assert _ELISION_NOTE in carried
    assert carried.endswith(reasoning[-100:])
    assert "HEAD-" not in carried


def test_reflexive_retry_still_precedes_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def _retry_spy(**kwargs: Any) -> tuple[bool, None]:
        calls.append(kwargs)
        return True, None

    monkeypatch.setattr(tool_call_retry, "run_reflexive_retry", _retry_spy)
    runtime = LoopRuntime(request_id="req_precedence")
    run = SimpleNamespace(
        runtime=runtime,
        kernel=SimpleNamespace(),
        request_id=runtime.request_id,
        session_id=None,
        tool_payload=[{"name": "grep_search", "parameters": {}}],
        working_messages=[],
        reflexive_retry_attempted=False,
        pending_retry_response_format=None,
        streamed_event_types=set(),
        thinking_budget_checkpoints=0,
        iteration_total=2,
    )

    outcome = _FinalResponseMixin._handle_final_response(
        run,
        _result(
            "thinking_budget",
            thinking_text="checkpoint-shaped",
            inband_tool_call_parse_failed=True,
        ),
        1,
    )

    assert outcome is None
    assert len(calls) == 1
    assert run.reflexive_retry_attempted is True
    assert run.thinking_budget_checkpoints == 0
    assert run.working_messages == []


class _ThinkingEngine:
    def stream_with_tools(self, **_kwargs: Any):
        yield ThinkingDelta(text="Continuing reasoning.", is_complete=True)
        return GenerationResult(content="Done.", finish_reason="stop")


def test_phase_summary_set_and_consumed_once(monkeypatch: pytest.MonkeyPatch) -> None:
    decision, _run, runtime, _engine = _run_results(
        monkeypatch,
        [
            _result("thinking_budget", thinking_text="reasoning tail"),
            _result("stop", content="Recovered."),
        ],
        max_iterations=2,
    )
    expected = "Continuing after thinking-budget checkpoint 1"
    assert decision.response_text == "Recovered."
    assert runtime.next_reasoning_phase_summary == expected

    events: list[object] = []
    runtime.emit = events.append
    kernel = SimpleNamespace(
        _engine=_ThinkingEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={FEATURE_PHASE_EVENTS: True},
            engine_type="ollama",
            model="qwen",
        ),
        _system_prompt_for_engine=str,
    )
    for iteration in (3, 4):
        runtime.current_iteration = iteration
        stream_generate_with_tools(
            kernel,
            runtime=runtime,
            latest_user_content="continue",
            prompt_messages=[{"role": "user", "content": "continue"}],
            max_tokens=64,
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system_prompt="system",
            tool_schemas=[],
        )

    summaries = [
        event.summary
        for event in events
        if isinstance(event, PhaseStartedEvent) and event.phase_kind == "reasoning"
    ]
    assert summaries == [expected, "Reasoning through the turn"]
    assert runtime.next_reasoning_phase_summary is None
