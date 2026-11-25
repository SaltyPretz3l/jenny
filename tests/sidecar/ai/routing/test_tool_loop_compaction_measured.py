"""Mid-turn compaction judges the provider's own prompt count, when it has one.

Gate 2026-10-14 F16: on a 32k llama-server window the char estimator's 30%
headroom compacted at ~11k estimated tokens, and the shrunken history let one
file read re-trigger it.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from sidecar.ai.context.compaction import compact_context
from sidecar.ai.context.compaction_micro import compaction_policy
from sidecar.ai.context.token_budget import (
    BudgetTracker,
    TokenBudget,
    estimate_messages_tokens,
)
from sidecar.ai.routing import tool_loop_compaction
from sidecar.ai.routing.tool_loop_compaction import (
    RequestMeasurement,
    compact_tool_loop_context,
    note_request_measurement,
)

RAW_WINDOW = 32_768
NUM_TOOLS = 52


class _Compacted(Exception):
    pass


def _budget() -> TokenBudget:
    return TokenBudget(
        context_window=int(RAW_WINDOW * 0.7),
        max_output_tokens=8_192,
        tool_overhead_per_tool=200,
    )


def _history(tokens: int) -> list[dict[str, Any]]:
    # Several mid-sized rows so the estimate lands near the asked size.
    rows = [{"role": "user", "content": "task"}]
    while estimate_messages_tokens(rows, None) < tokens:
        rows.append({"role": "tool", "content": "line of file content\n" * 100})
    return rows


def _loop(messages: list[dict[str, Any]], raw_window: int = RAW_WINDOW) -> Any:
    kernel = MagicMock()
    kernel._config.max_tokens = 8_192
    kernel._config.resolved_user_max_output_tokens = None
    kernel._engine.get_model_max_output_tokens.return_value = 8_192
    runtime = MagicMock()
    runtime._preview_context_tokens.return_value = 0
    return SimpleNamespace(
        budget_tracker=BudgetTracker(
            budget=_budget(), num_tools=NUM_TOOLS, backend=None, raw_context_window=raw_window,
        ),
        runtime=runtime,
        working_messages=messages,
        feature_flags={"context_compaction": True},
        compaction_stalled=False,
        request_id="request",
        session_id="session",
        system_prompt="system",
        latest_user_content="task",
        prompt_cache_enabled=False,
        kernel=kernel,
        request_context=None,
        request_measurement=None,
    )


@pytest.fixture
def compactions(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []

    def _fake_compact(*_args: Any, **kwargs: Any) -> Any:
        seen.append(kwargs)
        raise _Compacted

    monkeypatch.setattr(tool_loop_compaction, "compact_context", _fake_compact)
    monkeypatch.setattr(tool_loop_compaction, "resolve_compaction_prompt", lambda _config: None)
    return seen


def test_the_padded_estimate_compacts_a_32k_window_near_11k() -> None:
    assert _budget().auto_compact_threshold(NUM_TOOLS) == 10_322


def test_a_provider_count_well_under_the_window_does_not_compact(compactions: list[Any]) -> None:
    messages = _history(9_000)
    loop = _loop(messages)
    # The request carried those messages plus ~5.7k of tool schemas.
    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=14_000))
    messages.extend(_history(2_500)[1:])  # one more file read since that request
    assert estimate_messages_tokens(messages, None) > _budget().auto_compact_threshold(NUM_TOOLS)

    current = compact_tool_loop_context(loop, num_tools=NUM_TOOLS)

    assert compactions == []
    # The figure the stop rule reads stays clear of the error line.
    assert current < _budget().error_threshold(NUM_TOOLS)


def test_the_measured_trigger_sits_near_the_unpadded_window(compactions: list[Any]) -> None:
    messages = _history(1_000)
    loop = _loop(messages)
    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=22_000))
    compact_tool_loop_context(loop, num_tools=NUM_TOOLS)
    assert compactions == []

    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=23_500))
    with pytest.raises(_Compacted):
        compact_tool_loop_context(loop, num_tools=NUM_TOOLS)
    # Over the line by the provider's count: compact even if the estimate is not.
    assert compactions[-1]["force"] is True


def test_without_a_provider_count_the_estimate_still_decides(compactions: list[Any]) -> None:
    loop = _loop(_history(11_000))
    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=0))
    assert loop.request_measurement is None
    with pytest.raises(_Compacted):
        compact_tool_loop_context(loop, num_tools=NUM_TOOLS)


def test_a_rewritten_history_drops_the_provider_count(compactions: list[Any]) -> None:
    messages = _history(11_000)
    loop = _loop(messages)
    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=12_000))
    messages[1] = {"role": "system", "content": "summary of earlier work"}
    with pytest.raises(_Compacted):
        compact_tool_loop_context(loop, num_tools=NUM_TOOLS)


def test_an_unknown_raw_window_keeps_the_estimate_path(compactions: list[Any]) -> None:
    loop = _loop(_history(11_000), raw_window=0)
    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=12_000))
    assert isinstance(loop.request_measurement, RequestMeasurement)
    with pytest.raises(_Compacted):
        compact_tool_loop_context(loop, num_tools=NUM_TOOLS)


def test_a_completed_compaction_clears_the_provider_count(monkeypatch: pytest.MonkeyPatch) -> None:
    compacted = [{"role": "user", "content": "summary"}]
    monkeypatch.setattr(
        tool_loop_compaction,
        "compact_context",
        lambda *_args, **_kwargs: SimpleNamespace(
            messages=compacted, tokens_before=11_000, tokens_after=100, error=None,
            strategy="full", summary_status="ok", summary_failure_code=None,
            summary_message="summary", covered_through_tool_call_id=None,
            summary_input_dropped_messages=0,
        ),
    )
    monkeypatch.setattr(tool_loop_compaction, "resolve_compaction_prompt", lambda _config: None)
    loop = _loop(_history(1_000))
    loop.cache_break_detector = None
    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=30_000))
    compact_tool_loop_context(loop, num_tools=NUM_TOOLS)
    assert loop.working_messages == compacted
    assert loop.request_measurement is None


def test_a_pass_the_provider_forces_aims_at_the_provider_trigger(compactions: list[Any]) -> None:
    # The estimate sits under its own threshold while the provider's count is over the
    # unpadded trigger: the pass gets a scale that moves its target to match.
    messages = _history(8_000)
    loop = _loop(messages)
    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=26_000))
    tokens_now = estimate_messages_tokens(messages, None)
    assert tokens_now < _budget().auto_compact_threshold(NUM_TOOLS)
    with pytest.raises(_Compacted):
        compact_tool_loop_context(loop, num_tools=NUM_TOOLS)
    trigger = loop.budget_tracker.provider_compact_threshold(NUM_TOOLS)
    estimate_threshold = _budget().auto_compact_threshold(NUM_TOOLS)
    fixed = tool_loop_compaction._fixed_prompt_tokens(loop, loop.budget_tracker)
    # No leading system row here, so the separate system prompt joins the tool schemas.
    assert fixed > loop.budget_tracker.meter_tool_tokens() > 0
    scale = compactions[-1]["threshold_scale"]
    assert 0 < scale < 1
    # Read in the provider's units (the same ratio for every part of the prompt), the pass
    # target plus the part it cannot shrink lands at two-thirds of the trigger (row 183 W3).
    ratio = 26_000 / (tokens_now + fixed)
    target = estimate_threshold * scale * 2 / 3
    assert ratio * (target + fixed) == pytest.approx(trigger * 2 / 3, rel=0.001)


def test_the_micro_pass_count_drops_to_one_once_the_provider_counts(
    compactions: list[Any],
) -> None:
    loop = _loop(_history(8_000))
    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=26_000))
    with pytest.raises(_Compacted):
        compact_tool_loop_context(loop, num_tools=NUM_TOOLS)
    assert compactions[-1]["policy"].max_micro_passes == 1
    estimate_only = _loop(_history(11_000))
    with pytest.raises(_Compacted):
        compact_tool_loop_context(estimate_only, num_tools=NUM_TOOLS)
    assert compactions[-1]["policy"].max_micro_passes == 3


def test_an_unforced_estimate_pass_keeps_its_own_target(compactions: list[Any]) -> None:
    loop = _loop(_history(11_000))
    with pytest.raises(_Compacted):
        compact_tool_loop_context(loop, num_tools=NUM_TOOLS)
    assert compactions[-1]["threshold_scale"] == 1.0


def test_a_scaled_pass_trims_to_the_scaled_micro_target() -> None:
    budget = _budget()
    messages = _history(14_000) + [{"role": "user", "content": "tail"}] * 6
    policy = compaction_policy({})
    full = compact_context(messages, budget, None, num_tools=NUM_TOOLS, force=True, policy=policy)
    scaled = compact_context(
        messages, budget, None, num_tools=NUM_TOOLS, force=True, policy=policy, threshold_scale=0.6,
    )
    assert full.strategy == scaled.strategy == "micro"
    assert scaled.tokens_after < full.tokens_after
    assert scaled.tokens_after <= int(budget.auto_compact_threshold(NUM_TOOLS) * 0.6 * 2 / 3)


def test_the_meter_shows_the_trigger_compaction_uses_once_the_provider_counts() -> None:
    # A 350k Anthropic window: the estimate's headroom leaves 245k, and the meter read
    # 163-170k while compaction fired on the provider's count near 238k.
    tracker = BudgetTracker(
        budget=TokenBudget(context_window=245_000, max_output_tokens=128_000,
                           tool_overhead_per_tool=500),
        num_tools=44, backend=None, raw_context_window=350_000,
    )
    estimate_trigger = tracker.meter_compact_threshold()
    assert 160_000 < estimate_trigger < 175_000
    loop = _loop(_history(1_000))
    loop.budget_tracker = tracker
    note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=200_000))
    assert tracker.provider_counted is True
    assert tracker.meter_compact_threshold() == tracker.provider_compact_threshold() > 235_000


# -- a provider overflow compacts once and retries once (row 183 W1) ---------------------------


class _Overflow(Exception):
    classification = "prompt_too_long"
    status_code: int | None = 400


class _InBandOverflow(_Overflow):
    classification = "context_overflow"
    status_code = None


def _recovering(monkeypatch: pytest.MonkeyPatch, *, frees: bool = True) -> list[bool]:
    forced: list[bool] = []

    def _fake(loop: Any, *, num_tools: int, force: bool = False) -> int:
        forced.append(force)
        if frees:
            loop.working_messages = [{"role": "user", "content": "summary"}]
        return 0

    monkeypatch.setattr(tool_loop_compaction, "compact_tool_loop_context", _fake)
    return forced


def _generator(*outcomes: Any) -> tuple[Any, list[Any]]:
    seen: list[Any] = []
    queue = list(outcomes)

    def generate(*, working_messages: Any, **_step: Any) -> Any:
        seen.append(working_messages)
        outcome = queue.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    return generate, seen


def _recover(loop: Any, generate: Any) -> Any:
    return tool_loop_compaction.generate_with_overflow_recovery(
        loop, generate, lambda rows: [dict(row) for row in rows], runtime="r"
    )


def test_an_overflow_compacts_with_force_and_retries_with_the_new_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    forced = _recovering(monkeypatch)
    loop = _loop(_history(1_000))
    generate, seen = _generator(_Overflow("prompt is too long"), "answer")
    assert _recover(loop, generate) == "answer"
    assert forced == [True]
    assert seen[1] == [{"role": "user", "content": "summary"}]
    assert loop.overflow_recoveries == 1


def test_the_tool_loop_failure_wrapping_the_provider_error_is_recognised(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sidecar.ai.tools.contracts import ToolExecutionFailure

    forced = _recovering(monkeypatch)
    loop = _loop(_history(1_000))
    wrapped = ToolExecutionFailure(
        code="CMP-LOOP-0001", message="model generation failed",
        error_details={"classification": "prompt_too_long"},
    )
    wrapped.__cause__ = _Overflow("prompt is too long")
    generate, _seen = _generator(wrapped, "answer")
    assert _recover(loop, generate) == "answer"
    assert forced == [True]


def test_an_overflow_on_the_retry_and_past_the_cap_is_not_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    forced = _recovering(monkeypatch)
    loop = _loop(_history(1_000))
    generate, _seen = _generator(_Overflow("first"), _Overflow("second"))
    with pytest.raises(_Overflow, match="second"):
        _recover(loop, generate)
    loop.working_messages = _history(1_000)
    generate, _seen = _generator(_Overflow("third"), "answer")
    assert _recover(loop, generate) == "answer"
    loop.working_messages = _history(1_000)
    generate, _seen = _generator(_Overflow("fourth"))
    with pytest.raises(_Overflow, match="fourth"):
        _recover(loop, generate)
    assert forced == [True] * tool_loop_compaction.MAX_OVERFLOW_RECOVERIES


@pytest.mark.parametrize("error", [RuntimeError("rate limited"), _InBandOverflow("in band")])
def test_other_failures_are_not_retried(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    # An in-band overflow can follow streamed text, so a resend could show it twice.
    forced = _recovering(monkeypatch)
    loop = _loop(_history(1_000))
    generate, seen = _generator(error)
    with pytest.raises(type(error)):
        _recover(loop, generate)
    assert forced == [] and len(seen) == 1


def test_a_compaction_that_frees_nothing_raises_the_overflow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    forced = _recovering(monkeypatch, frees=False)
    loop = _loop(_history(1_000))
    generate, seen = _generator(_Overflow("prompt is too long"))
    with pytest.raises(_Overflow):
        _recover(loop, generate)
    assert forced == [True] and len(seen) == 1


def test_a_leading_system_row_is_not_counted_twice_in_the_fixed_part() -> None:
    loop = _loop([{"role": "system", "content": "system " * 2_000}, *_history(1_000)])
    loop.system_prompt = "system " * 2_000
    assert tool_loop_compaction._fixed_prompt_tokens(loop, loop.budget_tracker) == (
        loop.budget_tracker.meter_tool_tokens()
    )
