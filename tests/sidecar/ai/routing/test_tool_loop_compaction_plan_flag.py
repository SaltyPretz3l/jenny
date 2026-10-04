"""The tool loop forwards the in-turn plan approval flag to mid-turn compaction."""

from __future__ import annotations

from types import MethodType, SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from sidecar.ai.context.token_budget import TokenBudget
from sidecar.ai.routing import tool_loop_compaction
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_loop_compaction import compact_tool_loop_context
from sidecar.ai.routing.tool_loop_run import _ToolLoopRun
from sidecar.ai.routing.write_progress import READS_WITHOUT_WRITE_LIMIT, WriteProgress


class _Captured(Exception):
    pass


def _loop(request_context: Any) -> Any:
    kernel = MagicMock()
    kernel._config.max_tokens = 100
    kernel._config.resolved_user_max_output_tokens = None
    kernel._engine.get_model_max_output_tokens.return_value = 100
    runtime = MagicMock()
    runtime._preview_context_tokens.return_value = 0
    budget = TokenBudget(context_window=1_800, max_output_tokens=200, reserved_for_summary=200)
    return SimpleNamespace(
        budget_tracker=SimpleNamespace(budget=budget, backend=None),
        runtime=runtime,
        working_messages=[{"role": "user", "content": "task"}],
        feature_flags={"context_compaction": True},
        compaction_stalled=False,
        request_id="request",
        session_id="session",
        system_prompt="system",
        latest_user_content="task",
        prompt_cache_enabled=False,
        kernel=kernel,
        request_context=request_context,
    )


def _forwarded_flag(monkeypatch: pytest.MonkeyPatch, request_context: Any) -> Any:
    seen: dict[str, Any] = {}

    def _fake_compact(*_args: Any, **kwargs: Any) -> Any:
        seen.update(kwargs)
        raise _Captured

    monkeypatch.setattr(tool_loop_compaction, "compact_context", _fake_compact)
    monkeypatch.setattr(tool_loop_compaction, "resolve_compaction_prompt", lambda _config: None)
    with pytest.raises(_Captured):
        compact_tool_loop_context(_loop(request_context), num_tools=0, force=True)
    return seen["plan_approved_in_turn"]


def test_forwards_true_when_the_plan_was_approved_in_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = SimpleNamespace(plan_approved_in_turn=True)
    assert _forwarded_flag(monkeypatch, context) is True


def test_an_unanswered_write_nudge_survives_the_compaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """TR-015 G5: the nudge fell out of the six-row tail and was summarised away."""
    progress = WriteProgress()
    progress.observe(
        [ToolExecutionOutcome(tool_name="read_file", output="x", success=True)]
        * READS_WITHOUT_WRITE_LIMIT
    )
    nudge = progress.next_text()
    compacted = [{"role": "user", "content": "summary"}, {"role": "system", "content": "resume"}]
    monkeypatch.setattr(
        tool_loop_compaction,
        "compact_context",
        lambda *_args, **_kwargs: SimpleNamespace(
            messages=compacted, tokens_before=900, tokens_after=100, error=None,
            strategy="full", summary_status="ok", summary_failure_code=None,
            summary_message="summary", covered_through_tool_call_id=None,
            summary_input_dropped_messages=0,
        ),
    )
    monkeypatch.setattr(tool_loop_compaction, "resolve_compaction_prompt", lambda _config: None)
    loop = _loop(SimpleNamespace(plan_approved_in_turn=True))
    loop._write_progress = progress
    loop.cache_break_detector = None
    loop._after_context_compaction = MethodType(_ToolLoopRun._after_context_compaction, loop)

    compact_tool_loop_context(loop, num_tools=0, force=True)

    assert loop.working_messages[:2] == compacted
    assert loop.working_messages[-1] == {"role": "system", "content": nudge}


def test_forwards_false_otherwise(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _forwarded_flag(monkeypatch, SimpleNamespace(plan_approved_in_turn=False)) is False
    assert _forwarded_flag(monkeypatch, SimpleNamespace()) is False
    assert _forwarded_flag(monkeypatch, None) is False


def test_the_turn_context_row_sits_out_compaction_and_keeps_its_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sidecar.ai.context import turn_context
    from sidecar.ai.context.compaction import COMPACTED_SUMMARY_HEADING
    from sidecar.ai.context.token_budget import estimate_messages_tokens

    row = turn_context.build_turn_context_row(["## Workspace Manifest\n" + "src/a.py\n" * 200])
    seen: dict[str, Any] = {}
    summary = {"role": "system", "content": f"{COMPACTED_SUMMARY_HEADING}\nearlier"}

    def _fake_compact(messages: list[dict[str, Any]], budget: TokenBudget, *_a: Any, **_k: Any):
        seen.update(messages=messages, window=budget.context_window)
        return SimpleNamespace(
            messages=[summary, {"role": "user", "content": "task"}], tokens_before=900,
            tokens_after=100, error=None, strategy="full", summary_status="ok",
            summary_failure_code=None, summary_message="summary",
            covered_through_tool_call_id=None, summary_input_dropped_messages=0,
        )

    monkeypatch.setattr(tool_loop_compaction, "compact_context", _fake_compact)
    monkeypatch.setattr(tool_loop_compaction, "resolve_compaction_prompt", lambda _config: None)
    loop = _loop(None)
    loop.working_messages = [dict(row), {"role": "user", "content": "task"}]
    loop.cache_break_detector = None
    loop._hold_turn_context_row = MethodType(_ToolLoopRun._hold_turn_context_row, loop)
    loop._after_context_compaction = MethodType(_ToolLoopRun._after_context_compaction, loop)
    row_tokens = estimate_messages_tokens([row], None)

    tokens = compact_tool_loop_context(loop, num_tools=0, force=True)

    assert not any(turn_context.is_turn_context_row(m) for m in seen["messages"])
    assert seen["window"] == 1_800 - row_tokens
    assert loop.working_messages == [summary, dict(row), {"role": "user", "content": "task"}]
    assert tokens == 100 + row_tokens
