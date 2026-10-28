"""Budget numbers under the count-source ladder (row 66): the answer-floor
reservation for output-fitting engines, the pinned Qwen3.8 @ 262,144 trigger,
and the auto-compact ratio cap."""

from __future__ import annotations

import math
from types import SimpleNamespace

import pytest

from sidecar.ai.context.token_budget import (
    CharEstimationBackend,
    TokenBudget,
    apply_budget_check,
    resolve_auto_compact_ratio,
)


@pytest.fixture(autouse=True)
def _char_estimator(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the inner estimator so the numbers do not depend on installed tokenizers."""
    monkeypatch.setattr(
        "sidecar.ai.context.token_budget._create_best_backend",
        lambda _config: CharEstimationBackend(),
    )


# -- reservation (part C) --------------------------------------------------------


def test_qwen38_reservation_is_the_answer_floor_not_answer_plus_thinking() -> None:
    budget = TokenBudget(
        context_window=262_144,
        max_output_tokens=32_768,
        output_reservation_tokens=65_536,
        fitted_output=True,
    )

    assert budget._output_reservation() == 20_480


def test_an_engine_that_does_not_fit_output_keeps_the_quarter_cap_rule() -> None:
    budget = TokenBudget(
        context_window=262_144, max_output_tokens=32_768, output_reservation_tokens=65_536
    )

    assert budget._output_reservation() == 65_536


def test_a_128k_window_keeps_its_requested_output_reservation() -> None:
    budget = TokenBudget(context_window=131_072, max_output_tokens=16_384, fitted_output=True)

    assert budget._output_reservation() == 16_384


@pytest.mark.parametrize("fitted", [False, True])
@pytest.mark.parametrize(
    ("window", "requested", "reservation", "effective"),
    [
        # Quarter-window cap binds at 64k and below: identical to the old rule.
        (32_768, 32_768, 8_192, 24_576),
        (65_536, 65_536, 16_384, 49_152),
        (16_384, 8_000, 4_096, 12_288),
    ],
)
def test_small_windows_are_unchanged(
    window: int, requested: int, reservation: int, effective: int, fitted: bool
) -> None:
    budget = TokenBudget(context_window=window, max_output_tokens=requested, fitted_output=fitted)

    assert budget._output_reservation() == reservation
    assert budget.effective_context(0) == effective


def test_a_small_requested_output_still_binds() -> None:
    budget = TokenBudget(context_window=262_144, max_output_tokens=4_096, fitted_output=True)

    assert budget._output_reservation() == 4_096


# -- pinned Qwen3.8 @ 262,144 numbers ----------------------------------------------


class _QwenEngine:
    reports_full_prompt_input_tokens = True
    fits_output_to_window = True

    def get_model_context_length(self) -> int:
        return 262_144

    def get_model_max_output_tokens(self) -> int:
        return 32_768

    def get_request_output_reservation(self, reasoning_effort: str | None = None) -> int:
        return 65_536


_QWEN_CONFIG = SimpleNamespace(
    context_length=262_144, max_tokens=32_768, model="qwen3.8", engine_type="ninfer"
)


def test_exact_scale_puts_the_qwen38_trigger_near_218k() -> None:
    _, budget, tracker = apply_budget_check(
        [],
        _QWEN_CONFIG,
        _QwenEngine(),
        num_tools=29,
        reasoning_effort="medium",
        tool_schema_tokens=4_600,
        token_scale=1.0,
        scale_source="exact",
    )

    assert budget is not None and tracker is not None
    # Window is not cut: a scaled count carries no estimator headroom.
    assert budget.context_window == 262_144
    assert tracker.raw_context_window == 262_144
    assert tracker.count_source == "exact"
    # Per-tool reserve = ceil(4_600 * 1.25 / 29) = 199; tools = 199 * 29 = 5_771.
    # Effective = 262_144 - 20_480 (answer floor) - 5_771 = 235_893.
    # Compact at int(235_893 * 0.9) = 212_303; meter point adds the tools back:
    # 212_303 + 5_771 = 218_074.
    assert budget.tool_overhead(29) == 5_771
    assert budget.effective_context(29) == 235_893
    assert budget.auto_compact_threshold(29) == 212_303
    assert budget.meter_compact_threshold(29) == 218_074


def test_the_same_inputs_on_the_estimate_path_keep_the_estimator_headroom() -> None:
    _, budget, tracker = apply_budget_check(
        [],
        _QWEN_CONFIG,
        _QwenEngine(),
        num_tools=29,
        reasoning_effort="medium",
        tool_schema_tokens=4_600,
    )

    assert budget is not None and tracker is not None
    assert tracker.count_source == "estimate"
    # Window = int(262_144 * 0.70) = 183_500; the quarter cap (45_875) leaves the
    # 20_480 floor binding. Effective = 183_500 - 20_480 - 5_771 = 157_249.
    # Compact at int(157_249 * 0.9) = 141_524; meter point 141_524 + 5_771.
    assert budget.context_window == 183_500
    assert budget.effective_context(29) == 157_249
    assert budget.auto_compact_threshold(29) == 141_524
    assert budget.meter_compact_threshold(29) == 147_295


def test_a_calibrated_scale_uses_the_raw_window_like_the_tool_loop() -> None:
    # The tool loop judges a provider-measured prompt against the raw window;
    # turn start must use the same one so the meter's 100% is the trigger.
    _, budget, tracker = apply_budget_check(
        [], _QWEN_CONFIG, _QwenEngine(), token_scale=1.4, scale_source="calibrated"
    )

    assert budget is not None and tracker is not None
    assert budget.context_window == tracker.raw_context_window == 262_144
    assert tracker.count_source == "calibrated"
    assert tracker.backend.count_tokens("x" * 400) == math.ceil(100 * 1.4)
    assert tracker.backend.is_exact_match is False


def test_an_exact_scale_marks_the_backend_exact() -> None:
    _, _budget, tracker = apply_budget_check(
        [], _QWEN_CONFIG, _QwenEngine(), token_scale=1.2, scale_source="exact"
    )

    assert tracker is not None and tracker.backend.is_exact_match is True


def test_a_scale_without_a_scaling_source_is_ignored() -> None:
    _, budget, tracker = apply_budget_check(
        [], _QWEN_CONFIG, _QwenEngine(), token_scale=2.0, scale_source="estimate"
    )

    assert budget is not None and tracker is not None
    assert isinstance(tracker.backend, CharEstimationBackend)
    assert budget.context_window == 183_500


@pytest.mark.parametrize("window", [32_768, 65_536])
def test_small_window_thresholds_are_unchanged(window: int) -> None:
    engine = SimpleNamespace(
        get_model_context_length=lambda: window,
        get_model_max_output_tokens=lambda: 32_768,
    )
    config = SimpleNamespace(context_length=window, max_tokens=32_768)

    _, budget, _ = apply_budget_check([], config, engine, num_tools=0)

    assert budget is not None
    cut = int(window * 0.70)
    reservation = min(32_768, max(cut // 4, 1_024))  # the old rule: the quarter cap binds
    assert budget._output_reservation() == reservation
    assert budget.effective_context(0) == cut - max(reservation, budget.summary_reservation())


# -- ratio clamp -------------------------------------------------------------------


def _ratio(value: float, by_model: dict[str, float] | None = None, model: str | None = None) -> float:
    config = SimpleNamespace(
        token_budget_auto_compact_ratio=value, token_budget_auto_compact_ratio_by_model=by_model
    )
    return resolve_auto_compact_ratio(config, model_id=model)


def test_auto_compact_ratio_never_meets_the_error_threshold() -> None:
    assert _ratio(0.99) == 0.93
    assert _ratio(0.95) == 0.93
    assert _ratio(0.5, {"m": 0.97}, "m") == 0.93


def test_auto_compact_ratio_keeps_its_floor_and_precedence() -> None:
    assert _ratio(0.85) == 0.85
    assert _ratio(0.05) == 0.90
    assert _ratio(0.8, {"m": 0.7}, "m") == 0.7
    assert _ratio(0.8, {"m": 0.7}, "other") == 0.8
