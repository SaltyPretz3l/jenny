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

from sidecar.ai.context.token_budget import TokenBudget, estimate_messages_tokens
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
        budget_tracker=SimpleNamespace(budget=_budget(), backend=None, raw_context_window=raw_window),
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
