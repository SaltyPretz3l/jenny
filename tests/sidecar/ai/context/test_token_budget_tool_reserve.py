"""Measured tool-schema reserve and the context meter's whole-prompt units."""

from __future__ import annotations

import json

from sidecar.ai.context.token_budget import (
    TokenBudget,
    apply_budget_check,
    check_budget,
    estimate_tool_schema_tokens,
    measured_tool_overhead_per_tool,
)
from sidecar.runtime.chat_helpers import attach_compact_threshold, attach_context_used_tokens


class _Engine:
    def get_model_context_length(self) -> int:
        return 65_536

    def get_model_max_output_tokens(self) -> int:
        return 16_384


class _Config:
    context_length = 65_536
    max_tokens = 16_384
    token_budget_tool_overhead = None


class _OverrideConfig(_Config):
    token_budget_tool_overhead = 500


def _schema(index: int) -> dict[str, object]:
    return {
        "name": f"tool_{index:02d}",
        "description": "Reads a thing from the workspace and returns it. " * 3,
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Where to read."}},
            "required": ["path"],
        },
    }


def test_tool_overhead_is_the_capped_reserve_effective_context_subtracts() -> None:
    budget = TokenBudget(context_window=65_536, max_output_tokens=16_384)
    assert budget.tool_overhead(29) == 29 * 500
    assert budget.tool_overhead(0) == 0
    # Capped at a quarter of the window, like effective_context always was.
    assert budget.tool_overhead(1_000) == 65_536 // 4
    # The summary reservation overlaps the larger output reservation (TR-006).
    assert budget.effective_context(29) == 65_536 - 16_384 - 29 * 500


def test_meter_threshold_adds_the_tool_reserve_back_to_the_trigger() -> None:
    budget = TokenBudget(context_window=65_536, max_output_tokens=16_384)
    # The owner's 2026-09-18 reading of 29 tools on a 64k window was "23.8k";
    # without the stacked summary reservation it is 31,186.
    assert budget.auto_compact_threshold(29) == 31_186
    assert budget.meter_compact_threshold(29) == 31_186 + 29 * 500
    assert budget.meter_compact_threshold(0) == budget.auto_compact_threshold(0)


def test_meter_threshold_is_zero_when_the_trigger_is() -> None:
    budget = TokenBudget(context_window=1, max_output_tokens=16_384)
    assert budget.auto_compact_threshold(3) == 0
    assert budget.meter_compact_threshold(3) == 0


def test_measured_per_tool_reserve_includes_framing_and_needs_both_inputs() -> None:
    assert measured_tool_overhead_per_tool(5_277, 29) == 228  # ceil(5277 * 1.25 / 29)
    assert measured_tool_overhead_per_tool(None, 29) is None
    assert measured_tool_overhead_per_tool(0, 29) is None
    assert measured_tool_overhead_per_tool(5_000, 0) is None
    # A large MCP schema reserves MORE than the old flat 500, not less.
    assert measured_tool_overhead_per_tool(4_000, 2) == 2_500


def test_schema_tokens_count_only_full_schemas() -> None:
    full = [_schema(index) for index in range(3)]
    deferred = {"name": "deferred_tool", "description": "x" * 4_000, "defer_loading": True}
    expected = sum(len(json.dumps(schema, ensure_ascii=False)) // 4 for schema in full)
    assert estimate_tool_schema_tokens([*full, deferred]) == expected
    assert estimate_tool_schema_tokens(None) == 0
    assert estimate_tool_schema_tokens([]) == 0


def test_apply_budget_check_uses_the_measured_reserve() -> None:
    schemas = [_schema(index) for index in range(29)]
    measured = estimate_tool_schema_tokens(schemas)
    _messages, budget, tracker = apply_budget_check(
        [], _Config(), _Engine(), num_tools=29, tool_schema_tokens=measured,  # type: ignore[arg-type]
    )
    assert budget is not None and tracker is not None
    per_tool = measured_tool_overhead_per_tool(measured, 29)
    assert per_tool is not None and per_tool < 500
    assert budget.tool_overhead_per_tool == per_tool
    # Compare reserves at the same window, including tokenizer headroom.
    flat = TokenBudget(context_window=budget.context_window, max_output_tokens=16_384)
    assert budget.auto_compact_threshold(29) > flat.auto_compact_threshold(29)


def test_config_override_beats_the_measurement() -> None:
    _messages, budget, _tracker = apply_budget_check(
        [], _OverrideConfig(), _Engine(), num_tools=29, tool_schema_tokens=100,  # type: ignore[arg-type]
    )
    assert budget is not None
    assert budget.tool_overhead_per_tool == 500


def test_unmeasured_callers_keep_the_flat_default() -> None:
    _messages, budget, _tracker = apply_budget_check(
        [], _Config(), _Engine(), num_tools=29,  # type: ignore[arg-type]
    )
    assert budget is not None
    assert budget.tool_overhead_per_tool == 500


def test_compaction_still_fires_at_the_same_message_estimate() -> None:
    budget = TokenBudget(context_window=65_536, max_output_tokens=16_384)
    trigger = budget.auto_compact_threshold(29)
    assert check_budget(trigger - 1, budget, num_tools=29).level != "auto_compact"
    assert check_budget(trigger, budget, num_tools=29).level == "auto_compact"


def test_used_tokens_count_the_reserve_on_the_estimate_side() -> None:
    payload: dict[str, object] = {"last_request_input_tokens": 17_040}
    attach_context_used_tokens(payload, context_tokens_estimate=10_720, tool_overhead_tokens=6_500)
    assert payload["context_used_tokens"] == 17_220
    assert payload["context_used_source"] == "estimate"

    provider_wins: dict[str, object] = {"last_request_input_tokens": 17_040}
    attach_context_used_tokens(provider_wins, context_tokens_estimate=10_720, tool_overhead_tokens=0)
    assert provider_wins["context_used_tokens"] == 17_040
    assert provider_wins["context_used_source"] == "provider"

    # No estimate stays "no estimate"; the reserve alone is not a reading.
    empty: dict[str, object] = {}
    attach_context_used_tokens(empty, context_tokens_estimate=0, tool_overhead_tokens=6_500)
    assert "context_used_tokens" not in empty


def test_attach_compact_threshold_returns_the_reserve_it_published() -> None:
    exact: dict[str, object] = {}
    assert attach_compact_threshold(
        exact, None, None, threshold_tokens=40_000, tool_overhead_tokens=6_500,
    ) == 6_500
    assert exact["compact_threshold_tokens"] == 40_000

    fallback: dict[str, object] = {}
    reserve = attach_compact_threshold(fallback, _Engine(), _Config(), num_tools=29)
    budget = TokenBudget(context_window=65_536, max_output_tokens=16_384)
    assert reserve == budget.tool_overhead(29)
    assert fallback["compact_threshold_tokens"] == budget.meter_compact_threshold(29)

    nothing: dict[str, object] = {}
    assert attach_compact_threshold(nothing, None, None, tool_overhead_tokens=6_500) == 0
    assert "compact_threshold_tokens" not in nothing


def test_dogfood_64k_window_with_42_tools_compacts_at_the_measured_threshold() -> None:
    """TR-006 (dogfood 2026-09-28): Bonsai on a 64k llama-server window with 42
    tools compacted mid-turn at 26.4k-28.6k message tokens. The measured
    schema reserve was already live (the session's meter published
    compact_threshold_tokens 38,031, i.e. trigger 26,355); the trigger sat low
    because the 8,192 summary reservation was stacked on the 16,384 output
    reservation. Only the larger is held back now; char-estimator headroom
    further shrinks the budget window and caps both output and tools at a quarter."""
    measured = 9_320  # chars//4 of the 42 full schemas
    _messages, budget, _tracker = apply_budget_check(
        [], _Config(), _Engine(), num_tools=42, tool_schema_tokens=measured,  # type: ignore[arg-type]
    )
    assert budget is not None
    assert budget.tool_overhead_per_tool == 278  # ceil(9320 * 1.25 / 42)
    assert budget.context_window == 45_875  # 30% char-estimator headroom.
    assert budget.tool_overhead(42) == 11_468  # Capped at the reduced window's quarter.
    # Output and tools each reserve a quarter of the reduced window.
    assert budget.effective_context(42) == 45_875 - 11_468 - 11_468 == 22_939
    assert budget.auto_compact_threshold(42) == 20_645
    assert budget.meter_compact_threshold(42) == 32_113

    flat = TokenBudget(context_window=65_536, max_output_tokens=16_384)
    assert flat.tool_overhead(42) == 65_536 // 4  # 42 x 500 capped at a quarter
    assert flat.auto_compact_threshold(42) == 29_491
