from __future__ import annotations

import json
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.compaction import CompactionResult
from sidecar.ai.feature_flags import FEATURE_PHASE_EVENTS
from sidecar.ai.routing import tool_call_retry, tool_loop, tool_loop_compaction
from sidecar.ai.routing.generation_runtime_stream import stream_generate_with_tools
from sidecar.ai.routing.loop_events import PhaseStartedEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.provider_tool_limits import MAX_TOOL_CALL_ARGUMENT_BYTES
from sidecar.ai.routing.router import ChatRouter, ToolExecutionOutcome
from sidecar.ai.routing.thinking_checkpoint import (
    build_checkpoint_messages,
    checkpoint_stalled,
)
from sidecar.ai.routing.tool_loop_finalize import _FinalResponseMixin
from sidecar.ai.tools.models import GenerationResult, GenerationUsage, ThinkingDelta
from tests.sidecar.ai.engines.test_thinking_budget_abort import (
    _drain as _drain_engine,
)
from tests.sidecar.ai.engines.test_thinking_budget_abort import (
    _patch_vllm_stream,
    _vllm_chunk,
)
from tests.sidecar.ai.engines.test_vllm_engine_truncated_tool_call import (
    _preamble_length_cut_lines,
)

_CANNED_FALLBACK = "I could not produce a valid response for that request."
# resolve_checkpoint_limit for the default 200k effective window. Asserted
# directly below so a scaling change fails here instead of silently turning
# these into iteration-budget tests.
_CHECKPOINT_LIMIT = 8
_CARRY_CHARS = 12_000
_ELISION_NOTE = "[... earlier reasoning elided at a thinking-budget checkpoint ...]"
_CARRY_FRAME = "(my reasoning so far, continued after a thinking-budget checkpoint)\n"
_NUDGE = (
    "You hit a thinking-budget checkpoint. Your reasoning so far is preserved above. "
    "Act now - emit your tool calls or your final answer. Be decisive; do not restart "
    "your analysis."
)
_HIDDEN_REASONING_NUDGE = (
    "You hit a thinking-budget checkpoint: this step's whole output budget went to "
    "reasoning and none of it was kept. Do not restart your analysis. Keep any further "
    "thinking to a few sentences, then emit your next tool call or your final answer now."
)


class _SequenceEngine:
    def __init__(
        self,
        results: list[GenerationResult],
        *,
        context_window: int | None = None,
    ) -> None:
        self.results = list(results)
        self.calls: list[dict[str, Any]] = []
        self.context_window = context_window

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.calls.append(kwargs)
        return self.results.pop(0)

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return self.context_window


class _MCPClient:
    @property
    def available_tools(self) -> list[Any]:
        return []

    def tool_descriptor(self, _tool_name: str) -> None:
        return None


def _result(  # noqa: PLR0913
    finish_reason: str,
    *,
    content: str = "",
    thinking_text: str = "",
    inband_tool_call_parse_failed: bool = False,
    usage: GenerationUsage | None = None,
    tool_call_truncated: bool = False,
) -> GenerationResult:
    return GenerationResult(
        content=content,
        finish_reason=finish_reason,
        thinking_text=thinking_text,
        inband_tool_call_parse_failed=inband_tool_call_parse_failed,
        usage=usage,
        tool_call_truncated=tool_call_truncated,
    )


def _run_results(  # noqa: PLR0913
    monkeypatch: pytest.MonkeyPatch,
    results: list[GenerationResult],
    *,
    max_iterations: int,
    context_window: int | None = None,
    feature_flags: dict[str, bool] | None = None,
    outcomes: list[ToolExecutionOutcome] | None = None,
) -> tuple[Any, Any, LoopRuntime, _SequenceEngine]:
    captured: dict[str, Any] = {}
    engine = _SequenceEngine(results, context_window=context_window)
    config = replace(
        RuntimeConfig(
            engine_type="ollama",
            model="qwen",
            tools_workspace_root="C:/workspace",
            feature_flags=feature_flags,
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
                self.outcomes.extend(outcomes or [])
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


def _usage(input_tokens: int, output_tokens: int) -> GenerationUsage:
    return GenerationUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        last_request_input_tokens=input_tokens,
    )


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


def test_checkpoint_continuations_do_not_spend_the_iteration_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """TR-005: a continuation resumes the same step; it is not an agent step.

    Three checkpoints in a 3-iteration budget used to leave the third on the
    last iteration (no continuation, CMP-STREAM-INCOMPLETE). Each continuation
    now widens the budget, so the real answer still gets its iteration.
    """
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result("thinking_budget", thinking_text="reasoning one"),
            _result("thinking_budget", thinking_text="reasoning two"),
            _result("thinking_budget", thinking_text="reasoning three"),
            _result("stop", content="Finished answer."),
        ],
        max_iterations=3,
    )

    assert decision.response_text == "Finished answer."
    assert decision.terminal_error_code is None
    assert run.thinking_budget_checkpoints == 3
    assert len(engine.calls) == 4
    assert run.max_iterations == 3 + 3
    assert run.iteration_total == 3 + 3


def test_checkpoint_exhaustion_winds_down_with_the_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A spent checkpoint ladder gets one tools-stripped, thinking-off summary."""
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            *(
                _result("thinking_budget", thinking_text=f"cycle {cycle}")
                for cycle in range(_CHECKPOINT_LIMIT + 1)
            ),
            _result("stop", content="Here is what I worked out so far."),
        ],
        max_iterations=_CHECKPOINT_LIMIT + 4,
    )

    assert decision.response_text == "Here is what I worked out so far."
    assert decision.terminal_error_code is None
    assert run.thinking_budget_checkpoints == _CHECKPOINT_LIMIT
    # The checkpoint cycles plus the one wind-down generation.
    assert len(engine.calls) == _CHECKPOINT_LIMIT + 2
    assert engine.calls[-1]["reasoning_effort"] == "none"
    assert engine.calls[-1]["tools"] == []


def test_checkpoint_exhaustion_fallback_names_cause_and_remedy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the wind-down generation yields nothing, the sentence must explain."""
    decision, _run, _runtime, _engine = _run_results(
        monkeypatch,
        [
            *(
                _result("thinking_budget", thinking_text=f"cycle {cycle}")
                for cycle in range(_CHECKPOINT_LIMIT + 1)
            ),
            _result("stop", content="   "),
        ],
        max_iterations=_CHECKPOINT_LIMIT + 4,
    )

    assert decision.response_text != _CANNED_FALLBACK
    assert "output budget" in decision.response_text
    assert "reasoning effort" in decision.response_text
    assert "turning thinking off" in decision.response_text


def test_reasoning_only_stop_answers_from_the_reasoning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """EOS inside the reasoning ("stop", no text) winds down instead of canned text."""
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result("stop", thinking_text="The answer is 42 because of the premise."),
            _result("stop", content="The answer is 42."),
        ],
        max_iterations=4,
    )

    assert decision.response_text == "The answer is 42."
    assert decision.terminal_error_code is None
    assert len(engine.calls) == 2
    assert engine.calls[-1]["reasoning_effort"] == "none"
    assert engine.calls[-1]["tools"] == []
    carries = [
        message
        for message in run.working_messages
        if message.get("role") == "assistant"
        and "stopped without an answer" in str(message.get("content", ""))
    ]
    assert len(carries) == 1
    assert str(carries[0]["content"]).endswith("The answer is 42 because of the premise.")


def test_reasoning_only_stop_fallback_names_cause_and_remedy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decision, _run, _runtime, _engine = _run_results(
        monkeypatch,
        [
            _result("stop", thinking_text="Still weighing the options."),
            _result("stop", content="  "),
        ],
        max_iterations=4,
    )

    assert decision.response_text != _CANNED_FALLBACK
    assert "while still reasoning" in decision.response_text
    assert "turning thinking off" in decision.response_text


def test_empty_stop_without_reasoning_keeps_the_canned_reply(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decision, _run, _runtime, engine = _run_results(
        monkeypatch,
        [_result("stop")],
        max_iterations=4,
    )

    assert decision.response_text == _CANNED_FALLBACK
    assert len(engine.calls) == 1


def test_last_iteration_checkpoint_still_continues(monkeypatch: pytest.MonkeyPatch) -> None:
    """A checkpoint on the final permitted step continues the same step (TR-005).

    The continuation widens the iteration budget itself, so the last step no
    longer ends in a retryable CMP-STREAM-INCOMPLETE mid-thought.
    """
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result("thinking_budget", thinking_text="last iteration"),
            _result("stop", content="Finished answer."),
        ],
        max_iterations=1,
    )

    assert decision.terminal_error_code is None
    assert decision.response_text == "Finished answer."
    assert run.thinking_budget_checkpoints == 1
    assert len(engine.calls) == 2
    assert run.iteration_total == 1 + 1


def test_no_progress_stall_winds_down_naming_the_repetition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A loop rewriting the same reasoning stops and says so, not the canned line."""
    decision, run, _runtime, _engine = _run_results(
        monkeypatch,
        [
            _result("thinking_budget", thinking_text="the same reasoning over again"),
            _result("thinking_budget", thinking_text="the same reasoning over again"),
            _result("stop", content="   "),
        ],
        max_iterations=4,
    )

    assert run.thinking_budget_checkpoints == 1
    assert decision.response_text != _CANNED_FALLBACK
    assert "repeating the same reasoning" in decision.response_text
    assert "reasoning effort" in decision.response_text


def test_length_capped_reasoning_only_turn_reaches_the_continuation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The owner's live failure, end to end.

    llama-server ends a reasoning-only stream with ``length``; the resolver now
    keeps that verdict, so the turn reaches the checkpoint continuation instead
    of returning the canned empty-generation sentence at tool_loop_run's
    empty-generation guard.
    """
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result("length", content="", thinking_text="reasoning cut off mid-thought"),
            _result("stop", content="Decisive answer."),
        ],
        max_iterations=4,
    )

    assert decision.response_text == "Decisive answer."
    assert decision.response_text != _CANNED_FALLBACK
    assert decision.terminal_error_code is None
    assert run.thinking_budget_checkpoints == 1
    assert len(engine.calls) == 2
    assert _checkpoint_messages(run) == [
        {"role": "assistant", "content": f"{_CARRY_FRAME}reasoning cut off mid-thought"},
        {"role": "system", "content": _NUDGE},
    ]


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


def test_length_at_context_window_compacts_without_checkpoint_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    compaction_calls: list[bool] = []

    def _compact(loop: Any, *, num_tools: int, force: bool = False) -> int:
        assert num_tools >= 0
        compaction_calls.append(force)
        loop.working_messages[:] = [{"role": "user", "content": "compacted task"}]
        return 4

    monkeypatch.setattr(
        tool_loop.tool_loop_compaction,
        "compact_tool_loop_context",
        _compact,
    )
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result(
                "length",
                thinking_text="reasoning stopped when the window filled",
                usage=_usage(32_290, 478),
            ),
            _result("stop", content="Recovered after compaction."),
        ],
        max_iterations=3,
        context_window=32_768,
        feature_flags={"token_budget": True, "context_compaction": True},
    )

    assert decision.response_text == "Recovered after compaction."
    assert decision.terminal_error_code is None
    assert run.thinking_budget_checkpoints == 0
    assert _checkpoint_messages(run) == []
    assert compaction_calls == [True]
    assert len(engine.calls) == 2


def test_length_at_context_window_after_tool_results_compacts_instead_of_winding_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Astra review of F17: with tool results already in the turn, an empty
    context-full stop hit the empty post-tool wind-down first, which generates
    again on the same full window instead of compacting."""
    compaction_calls: list[bool] = []

    def _compact(loop: Any, *, num_tools: int, force: bool = False) -> int:
        compaction_calls.append(force)
        loop.working_messages[:] = [{"role": "user", "content": "compacted task"}]
        return 4

    monkeypatch.setattr(tool_loop.tool_loop_compaction, "compact_tool_loop_context", _compact)
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result("length", thinking_text="window filled", usage=_usage(32_290, 478)),
            _result("stop", content="Recovered after compaction."),
        ],
        max_iterations=3,
        context_window=32_768,
        feature_flags={"token_budget": True, "context_compaction": True},
        outcomes=[ToolExecutionOutcome(tool_name="read_file", output="ok", success=True, call_id="c1")],
    )

    assert decision.response_text == "Recovered after compaction."
    assert compaction_calls == [True]
    assert run.post_tool_continuation_attempted is False
    assert len(engine.calls) == 2


def test_forced_recovery_reaches_the_compactor_below_its_threshold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Astra review of F17: the window filled with prompt plus output while the
    prompt alone sat under the auto-compact threshold; ``force`` must reach
    ``compact_context`` or it declines and recovery finds nothing to free."""
    forced: list[bool] = []

    def _compact_context(messages: list[dict[str, Any]], *_args: Any, **kwargs: Any) -> Any:
        forced.append(bool(kwargs.get("force")))
        compacted = [{"role": "user", "content": "compacted task"}]
        return CompactionResult(messages=compacted, strategy="micro", tokens_before=900, tokens_after=10)

    monkeypatch.setattr(tool_loop_compaction, "compact_context", _compact_context)
    decision, _run, _runtime, _engine = _run_results(
        monkeypatch,
        [
            _result("length", thinking_text="window filled", usage=_usage(32_290, 478)),
            _result("stop", content="Recovered after compaction."),
        ],
        max_iterations=3,
        context_window=32_768,
        feature_flags={"token_budget": True, "context_compaction": True},
    )

    assert decision.response_text == "Recovered after compaction."
    assert forced == [True]


def test_thinking_checkpoint_consults_midturn_compaction_before_continuing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    compaction_calls: list[bool] = []

    def _compact(_loop: Any, *, num_tools: int, force: bool = False) -> int:
        assert num_tools >= 0
        compaction_calls.append(force)
        return 100

    monkeypatch.setattr(
        tool_loop.tool_loop_compaction,
        "compact_tool_loop_context",
        _compact,
    )
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result("thinking_budget", thinking_text="checkpoint carry"),
            _result("stop", content="Continued after the checkpoint."),
        ],
        max_iterations=3,
        context_window=32_768,
        feature_flags={"token_budget": True, "context_compaction": True},
    )

    assert decision.response_text == "Continued after the checkpoint."
    assert run.thinking_budget_checkpoints == 1
    assert compaction_calls == [False]
    assert len(engine.calls) == 2


def test_length_at_context_window_uses_context_budget_terminal_when_not_compactable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result(
                "length",
                thinking_text="reasoning stopped when the window filled",
                usage=_usage(32_290, 478),
            )
        ],
        max_iterations=3,
        context_window=32_768,
        feature_flags={"token_budget": True, "context_compaction": False},
    )

    assert "context budget is used up" in decision.response_text
    assert decision.terminal_error_code is None
    assert run.thinking_budget_checkpoints == 0
    assert _checkpoint_messages(run) == []
    assert len(engine.calls) == 1


def test_output_cap_truncated_tool_call_with_window_room_still_checkpoints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result(
                "length",
                thinking_text="tool arguments were cut at the output cap",
                usage=_usage(10_000, 16_384),
                tool_call_truncated=True,
            ),
            _result("stop", content="Retried in smaller calls."),
        ],
        max_iterations=3,
        context_window=32_768,
    )

    assert decision.response_text == "Retried in smaller calls."
    assert decision.terminal_error_code is None
    assert run.thinking_budget_checkpoints == 1
    assert len(engine.calls) == 2
    assert any(
        "cut off at the output-token limit" in str(message.get("content", ""))
        for message in run.working_messages
    )


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

def test_length_truncated_tool_call_result_reaches_the_continuation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The owner's 2026-09-20 turn, end to end through the real engine parser.

    llama-server hit ``n_predict`` mid tool-call. The engine used to promote the
    partial arguments to a fatal CMP-AI-0005 before resolving the finish reason;
    it must instead hand the loop a ``length`` result with no executable calls,
    which the existing checkpoint ladder continues.
    """
    partial_call = {
        "index": 0,
        "id": "call-1",
        "type": "function",
        "function": {"name": "write_file", "arguments": '{"path": "a.md", "content": "# Sta'},
    }
    lines = [
        _vllm_chunk({"reasoning_content": "deciding which file to write"}),
        "data: " + json.dumps({"choices": [{"delta": {"tool_calls": [partial_call]}}]}),
        "data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "length"}]}),
        "data: [DONE]",
    ]
    engine, _response = _patch_vllm_stream(monkeypatch, lines)
    _events, truncated = _drain_engine(
        engine.stream_with_tools(prompt="write", tools=[], max_tokens=16_384)
    )
    assert truncated.finish_reason == "length"
    assert truncated.tool_calls == ()

    decision, run, _runtime, sequence = _run_results(
        monkeypatch,
        [truncated, _result("stop", content="Decisive answer.")],
        max_iterations=4,
    )

    assert decision.response_text == "Decisive answer."
    assert decision.terminal_error_code is None
    assert run.thinking_budget_checkpoints == 1
    assert len(sequence.calls) == 2
    assert _checkpoint_messages(run) == [
        {"role": "assistant", "content": f"{_CARRY_FRAME}deciding which file to write"},
        {"role": "system", "content": _NUDGE},
    ]


def test_length_cut_tool_call_after_a_preamble_reaches_the_continuation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, _response = _patch_vllm_stream(
        monkeypatch,
        _preamble_length_cut_lines(MAX_TOOL_CALL_ARGUMENT_BYTES + 4_000),
    )
    _events, cut = _drain_engine(
        engine.stream_with_tools(prompt="write", tools=[], max_tokens=16_384)
    )

    decision, run, _runtime, sequence = _run_results(
        monkeypatch,
        [cut, _result("stop", content="Decisive answer.")],
        max_iterations=4,
    )

    assert run.thinking_budget_checkpoints == 1
    assert len(sequence.calls) == 2
    assert decision.response_text == "Decisive answer."
    assert decision.terminal_error_code is None
    # The byte cap, not the token limit, dropped this call (sweep W3-B1).
    assert any(
        message.get("role") == "system"
        and f"{MAX_TOOL_CALL_ARGUMENT_BYTES:,}-byte per-call argument limit"
        in str(message.get("content", ""))
        for message in run.working_messages
    )


@pytest.mark.parametrize(
    ("max_iterations", "continuation_enabled"),
    # A checkpoint on the last iteration now continues (TR-005), so only the
    # kill switch leaves a checkpoint that cannot continue.
    [(4, False)],
    ids=["continuation_disabled"],
)
def test_length_cut_tool_call_that_cannot_continue_fails_retryably(
    monkeypatch: pytest.MonkeyPatch,
    max_iterations: int,
    continuation_enabled: bool,
) -> None:
    if not continuation_enabled:
        monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_CONTINUATION", "0")
    preamble = "Now creating the file."

    decision, _run, _runtime, _sequence = _run_results(
        monkeypatch,
        [
            GenerationResult(
                content=preamble,
                finish_reason="length",
                thinking_text="x",
                tool_call_truncated=True,
            )
        ],
        max_iterations=max_iterations,
    )

    assert decision.terminal_error_code == "CMP-STREAM-INCOMPLETE"
    assert decision.terminal_error_retryable is True
    assert decision.response_text != preamble


_DRAFT_NUDGE = (
    "Your reasoning above already drafts code. Do not re-derive it: write it to disk "
    "now with write_file/edit_file in pieces of at most ~150 lines, then continue."
)


@pytest.mark.parametrize(
    "reasoning",
    [
        "Plan:\n```python\nx = 1\n```\nThen wire it.",
        "def parse(row):\n    return row\n\nclass Report:\n    pass\n",
        "Sketch:\n    def load(path):\n        ...\n    def save(path):\n        ...\n",
    ],
)
def test_checkpoint_with_drafted_code_uses_the_write_it_now_nudge(reasoning: str) -> None:
    messages = build_checkpoint_messages(reasoning, allow_write_draft=True)

    assert messages[-1] == {"role": "system", "content": _DRAFT_NUDGE}
    assert _NUDGE not in [message["content"] for message in messages]


@pytest.mark.parametrize(
    "reasoning",
    [
        "I should read the parser first and then decide.",
        "The helper def parse is used once, so keep it.",
    ],
)
def test_checkpoint_without_code_keeps_the_decisive_nudge(reasoning: str) -> None:
    messages = build_checkpoint_messages(reasoning, allow_write_draft=True)

    assert messages[-1] == {"role": "system", "content": _NUDGE}


# Astra B5 review: a plan, a review of quoted code, or a tool-less chat turn
# must never be told to write its draft to disk. The tool loop opts in only
# for an approved-plan build with write tools available.
def test_checkpoint_draft_nudge_requires_write_permission() -> None:
    reasoning = "def parse(row):\n    return row\n\nclass Report:\n    pass\n"

    assert build_checkpoint_messages(reasoning)[-1] == {"role": "system", "content": _NUDGE}
    assert build_checkpoint_messages(reasoning, allow_write_draft=False)[-1] == {
        "role": "system",
        "content": _NUDGE,
    }


# Dogfood TR-018: a model whose reasoning the engine hides (or drops) ends a long
# think with ``length`` and an empty carry. That is not a repeat: the first such
# stop gets one continuation that keeps the tools; a second one winds down.


def test_length_cap_with_hidden_reasoning_gets_one_tool_keeping_leg(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result("length", usage=_usage(70_000, 8_192)),
            _result("stop", content="Edited."),
        ],
        max_iterations=4,
    )

    assert decision.response_text == "Edited."
    assert run.thinking_budget_checkpoints == 1
    assert len(engine.calls) == 2
    assert engine.calls[1]["reasoning_effort"] != "none"
    assert len(engine.calls[1]["tools"]) == len(engine.calls[0]["tools"]) > 0
    assert _checkpoint_messages(run) == [{"role": "system", "content": _HIDDEN_REASONING_NUDGE}]


def test_hidden_reasoning_leg_is_bounded_then_winds_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decision, run, _runtime, engine = _run_results(
        monkeypatch,
        [
            _result("length", usage=_usage(70_000, 8_192)),
            _result("length", usage=_usage(70_000, 8_192)),
            _result("stop", content="Summary of where the work stands."),
        ],
        max_iterations=4,
    )

    assert run.thinking_budget_checkpoints == 1
    assert len(engine.calls) == 3
    assert engine.calls[-1]["tools"] == []
    assert engine.calls[-1]["reasoning_effort"] == "none"
    assert decision.response_text == "Summary of where the work stands."


def _stall_loop(*, tools: bool = True, cap_stripped: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        tool_payload=[{"type": "function"}] if tools else [],
        tool_cap_tools_stripped=cap_stripped,
        runtime=SimpleNamespace(tool_call_limit=0, remaining_tool_calls=0),
    )


def test_checkpoint_stalled_rules() -> None:
    hidden = _result("length")
    # First empty carry with tools on offer: hidden reasoning, not a stall.
    assert checkpoint_stalled(_stall_loop(), None, "", hidden) is False
    # A second empty carry, no tools, or a spent tool cap keep the stall.
    assert checkpoint_stalled(_stall_loop(), "", "", hidden) is True
    assert checkpoint_stalled(_stall_loop(tools=False), None, "", hidden) is True
    assert checkpoint_stalled(_stall_loop(cap_stripped=True), None, "", hidden) is True
    # Unchanged rules: a dropped tool call with no reasoning continues, a repeat stalls,
    # fresh reasoning continues.
    dropped = _result("length", tool_call_truncated=True)
    assert checkpoint_stalled(_stall_loop(tools=False), "", "", dropped) is False
    assert checkpoint_stalled(_stall_loop(), "same reasoning again", "same reasoning again", hidden) is True
    assert checkpoint_stalled(_stall_loop(), None, "fresh reasoning", hidden) is False


def test_hidden_reasoning_nudge_never_claims_a_preserved_carry() -> None:
    assert build_checkpoint_messages("") == [{"role": "system", "content": _HIDDEN_REASONING_NUDGE}]
    assert "preserved above" not in _HIDDEN_REASONING_NUDGE
    # A dropped tool call keeps the decisive nudge plus its own note.
    assert build_checkpoint_messages("", tool_call_truncated=True)[0] == {"role": "system", "content": _NUDGE}
