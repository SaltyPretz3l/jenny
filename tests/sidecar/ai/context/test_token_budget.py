"""Tests for token counting and budget calculation."""

from __future__ import annotations

import pytest

from sidecar.ai.context.token_budget import (
    _AUTO_COMPACT_RATIO,
    BudgetTracker,
    CharEstimationBackend,
    TokenBudget,
    apply_budget_check,
    build_tool_schema_budget_plan,
    check_budget,
    estimate_messages_tokens,
    resolve_auto_compact_ratio,
    tool_schema_cap_for_budget_level,
)

# -- CharEstimationBackend ---------------------------------------------------


class TestCharEstimationBackend:
    def test_empty_string_returns_zero(self) -> None:
        backend = CharEstimationBackend()
        assert backend.count_tokens("") == 0

    def test_short_text_minimum_one(self) -> None:
        backend = CharEstimationBackend()
        assert backend.count_tokens("hi") == 1  # 2 chars // 4 = 0, clamped to 1

    def test_normal_text(self) -> None:
        backend = CharEstimationBackend()
        # "hello world" = 11 chars => 11 // 4 = 2
        assert backend.count_tokens("hello world") == 2

    def test_longer_text(self) -> None:
        backend = CharEstimationBackend()
        text = "a" * 400
        assert backend.count_tokens(text) == 100

    def test_default_context_window(self) -> None:
        backend = CharEstimationBackend()
        assert backend.get_context_window("any-model") == 200_000

    def test_default_max_output(self) -> None:
        backend = CharEstimationBackend()
        assert backend.get_max_output_tokens("any-model") == 16_384


# -- TokenBudget -------------------------------------------------------------


class TestTokenBudget:
    def test_effective_context_no_tools(self) -> None:
        budget = TokenBudget(context_window=200_000, max_output_tokens=16_384)
        # 200_000 - 16_384 - 8_192 (reserved) - 0 (tools) = 175_424
        assert budget.effective_context(0) == 175_424

    def test_effective_context_with_tools(self) -> None:
        budget = TokenBudget(context_window=200_000, max_output_tokens=16_384)
        # 200_000 - 16_384 - 8_192 - (5 * 500) = 172_924
        assert budget.effective_context(5) == 172_924

    def test_effective_context_custom_reserved(self) -> None:
        budget = TokenBudget(
            context_window=100_000,
            max_output_tokens=4_096,
            reserved_for_summary=2_000,
            tool_overhead_per_tool=100,
        )
        # 100_000 - 4_096 - 2_000 - (3 * 100) = 93_604
        assert budget.effective_context(3) == 93_604

    def test_effective_context_clamps_to_zero(self) -> None:
        budget = TokenBudget(context_window=1_000, max_output_tokens=900)
        # 1_000 - 900 - 8_192 = negative => clamped to 0
        assert budget.effective_context(0) == 0

    def test_warning_threshold(self) -> None:
        budget = TokenBudget(context_window=200_000, max_output_tokens=16_384)
        effective = budget.effective_context(0)  # 175_424
        assert budget.warning_threshold(0) == int(effective * 0.80)

    def test_auto_compact_threshold(self) -> None:
        budget = TokenBudget(context_window=200_000, max_output_tokens=16_384)
        effective = budget.effective_context(0)
        assert budget.auto_compact_threshold(0) == int(effective * 0.90)

    def test_error_threshold(self) -> None:
        budget = TokenBudget(context_window=200_000, max_output_tokens=16_384)
        effective = budget.effective_context(0)
        assert budget.error_threshold(0) == int(effective * 0.95)

    @pytest.mark.parametrize(
        ("context_window", "num_tools", "effective_context", "hard_prompt_limit"),
        [
            (8_192, 24, 3_072, 6_144),
            (32_768, 24, 12_288, 24_576),
            (200_000, 46, 152_424, 183_616),
        ],
    )
    def test_reservations_scale_across_context_windows(
        self,
        context_window: int,
        num_tools: int,
        effective_context: int,
        hard_prompt_limit: int,
    ) -> None:
        budget = TokenBudget(
            context_window=context_window,
            max_output_tokens=min(context_window, 16_384),
        )

        assert budget.effective_context(num_tools) == effective_context
        assert budget.hard_prompt_limit() == hard_prompt_limit


# -- effective_context on small-context models (regression) ------------------


class TestEffectiveContextSmallWindows:
    """Regression for the small-context output-reservation bug.

    An Ollama model whose Modelfile sets no ``num_predict`` derives
    ``max_output_tokens = min(context_length, 16384)`` (see
    ``ollama_metadata.extract_max_output_tokens``). Combined with the fixed
    8K summary reservation, that previously reserved ~the entire window and
    left ``effective_context`` at 0 on turn 1 for the recommended local-model
    tiers (catalog windows 8192 / 16384 / 32768). The reservation math must
    leave a usable budget for any model with a usable window.
    """

    @staticmethod
    def _no_num_predict_budget(context_window: int) -> TokenBudget:
        # Mirrors ollama_metadata.extract_max_output_tokens when the Modelfile
        # carries no num_predict: max_output = min(context_length, 16384).
        return TokenBudget(
            context_window=context_window,
            max_output_tokens=min(context_window, 16_384),
        )

    def test_8k_window_is_usable(self) -> None:
        # Before the fix: 8192 - 8192 - 8192 => 0 (turn-1 "too long" failure).
        budget = self._no_num_predict_budget(8_192)
        assert budget.effective_context(0) >= 2_048

    def test_16k_window_is_usable(self) -> None:
        # Before the fix: 16384 - 16384 - 8192 => 0 (turn-1 failure).
        budget = self._no_num_predict_budget(16_384)
        assert budget.effective_context(0) >= 4_096

    def test_32k_window_materially_exceeds_8k(self) -> None:
        # Before the fix: 32k => 8192 (only 25% of window), 8k => 0.
        small = self._no_num_predict_budget(8_192).effective_context(0)
        large = self._no_num_predict_budget(32_768).effective_context(0)
        assert large >= 16_384
        assert large > small

    def test_reasoning_reservation_is_capped_for_budgeting(self) -> None:
        budget = TokenBudget(
            context_window=65_536,
            max_output_tokens=16_384,
            output_reservation_tokens=49_152,
        )

        assert budget.output_reservation_tokens == 49_152
        assert budget.effective_context(num_tools=15) == 33_460
        assert budget.auto_compact_threshold(num_tools=15) == 30_114


# -- estimate_messages_tokens ------------------------------------------------


class TestEstimateMessagesTokens:
    def test_empty_list(self) -> None:
        assert estimate_messages_tokens([]) == 0

    def test_single_message(self) -> None:
        messages = [{"role": "user", "content": "a" * 40}]
        backend = CharEstimationBackend()
        # 40 chars // 4 = 10 tokens + 4 overhead = 14
        assert estimate_messages_tokens(messages, backend) == 14

    def test_multiple_messages(self) -> None:
        messages = [
            {"role": "system", "content": "a" * 100},  # 25 + 4
            {"role": "user", "content": "b" * 200},  # 50 + 4
            {"role": "assistant", "content": "c" * 80},  # 20 + 4
        ]
        backend = CharEstimationBackend()
        assert estimate_messages_tokens(messages, backend) == 25 + 4 + 50 + 4 + 20 + 4

    def test_message_with_tool_calls(self) -> None:
        messages = [
            {
                "role": "assistant",
                "content": "x" * 20,
                "tool_calls": [
                    {"name": "read", "arguments": {"path": "a" * 40}},
                ],
            },
        ]
        backend = CharEstimationBackend()
        # content: 20/4=5, tool_call args str: "{'path': 'aaa...'}" ~ some length
        tokens = estimate_messages_tokens(messages, backend)
        assert tokens > 5 + 4  # more than just content + overhead

    def test_uses_default_backend(self) -> None:
        messages = [{"role": "user", "content": "a" * 40}]
        assert estimate_messages_tokens(messages) == 14  # same as explicit backend


# -- check_budget ------------------------------------------------------------


class TestCheckBudget:
    def _budget(self) -> TokenBudget:
        return TokenBudget(context_window=200_000, max_output_tokens=16_384)

    def test_ok_when_under_warning(self) -> None:
        budget = self._budget()
        status = check_budget(10_000, budget, num_tools=0)
        assert status.level == "ok"
        assert not status.should_compact

    def test_warning_at_80_percent(self) -> None:
        budget = self._budget()
        threshold = budget.warning_threshold(0)
        status = check_budget(threshold, budget, num_tools=0)
        assert status.level == "warning"
        assert not status.should_compact

    def test_auto_compact_at_90_percent(self) -> None:
        budget = self._budget()
        threshold = budget.auto_compact_threshold(0)
        status = check_budget(threshold, budget, num_tools=0)
        assert status.level == "auto_compact"
        assert status.should_compact

    def test_error_at_95_percent(self) -> None:
        budget = self._budget()
        threshold = budget.error_threshold(0)
        status = check_budget(threshold, budget, num_tools=0)
        assert status.level == "error"
        assert status.should_compact

    def test_zero_effective_returns_error(self) -> None:
        budget = TokenBudget(context_window=100, max_output_tokens=100)
        status = check_budget(50, budget, num_tools=0)
        assert status.level == "error"
        assert status.tokens_available == 0

    def test_utilization_pct_capped_at_one(self) -> None:
        budget = self._budget()
        status = check_budget(999_999, budget, num_tools=0)
        assert status.utilization_pct <= 1.0


# -- tool schema budget pressure --------------------------------------------


class TestToolSchemaBudgetPressure:
    def test_inactive_for_ok_and_unknown_levels(self) -> None:
        assert tool_schema_cap_for_budget_level("ok") is None
        assert tool_schema_cap_for_budget_level("nonsense") is None

        plan = build_tool_schema_budget_plan(
            [f"tool_{index}" for index in range(20)],
            level="ok",
        )

        assert plan.active is False
        assert plan.cap is None
        assert plan.filtered_names == frozenset()
        assert len(plan.kept_names) == 20

    def test_conservative_caps_match_pressure_levels(self) -> None:
        assert tool_schema_cap_for_budget_level("warning") == 12
        assert tool_schema_cap_for_budget_level("auto_compact") == 8
        assert tool_schema_cap_for_budget_level("error") == 5

    def test_filters_after_cap_using_preferred_order(self) -> None:
        plan = build_tool_schema_budget_plan(
            [f"tool_{index}" for index in range(15)],
            level="warning",
            preferred_names=("tool_14", "tool_13"),
        )

        assert plan.active is True
        assert plan.cap == 12
        assert plan.kept_names[:2] == ("tool_14", "tool_13")
        assert len(plan.kept_names) == 12
        assert "tool_12" in plan.filtered_names

    def test_mandatory_names_can_exceed_cap(self) -> None:
        mandatory = tuple(f"tool_{index}" for index in range(7))

        plan = build_tool_schema_budget_plan(
            [*mandatory, "optional"],
            level="error",
            mandatory_names=mandatory,
        )

        assert plan.cap == 5
        assert plan.kept_names == mandatory
        assert plan.filtered_names == frozenset({"optional"})


# -- BudgetTracker -----------------------------------------------------------


class TestBudgetTracker:
    def test_tool_progress_prevents_diminishing_returns_stop(self) -> None:
        tracker = BudgetTracker()
        tracker.record_iteration(100, 1_000)
        tracker.record_iteration(100, 1_000, made_tool_progress=True)
        tracker.record_iteration(100, 1_000)
        assert tracker.check_should_continue()

    def test_no_tool_progress_preserves_diminishing_returns_stop(self) -> None:
        tracker = BudgetTracker()
        for _ in range(3):
            tracker.record_iteration(100, 1_000, made_tool_progress=False)
        assert not tracker.check_should_continue()

    def test_iteration_histories_trim_with_aligned_tails(self) -> None:
        tracker = BudgetTracker()
        tracker.record_iteration(100, 1_000, made_tool_progress=True)
        for _ in range(tracker.iter_history_limit):
            tracker.record_iteration(100, 1_000)

        assert len(tracker._progress_tokens) == tracker.iter_history_limit
        assert len(tracker._made_tool_progress) == tracker.iter_history_limit
        assert not any(tracker._made_tool_progress)
        assert not tracker.check_should_continue()

        tracker.record_iteration(100, 1_000, made_tool_progress=True)
        assert len(tracker._progress_tokens) == tracker.iter_history_limit
        assert len(tracker._made_tool_progress) == tracker.iter_history_limit
        assert tracker._made_tool_progress[-3:] == [False, False, True]
        assert tracker.check_should_continue()

    def test_diminishing_returns_detection(self) -> None:
        tracker = BudgetTracker()
        # 4 iterations with <500 tokens each
        for _ in range(4):
            tracker.record_iteration(100, 1_000)
        assert not tracker.check_should_continue()

    def test_continues_with_healthy_gains(self) -> None:
        tracker = BudgetTracker()
        for _ in range(4):
            tracker.record_iteration(2000, 2_000)
        assert tracker.check_should_continue()

    def test_stops_at_budget_error_threshold(self) -> None:
        budget = TokenBudget(context_window=10_000, max_output_tokens=1_000)
        tracker = BudgetTracker(budget=budget, num_tools=0)
        # ctx 10_000: summary reservation capped to ctx//4 = 2_500, output 1_000
        # => effective = 10_000 - 1_000 - 2_500 = 6_500, error threshold ~6_175
        tracker.record_iteration(100, 9_000)
        assert not tracker.check_should_continue()

    def test_continues_when_under_budget(self) -> None:
        budget = TokenBudget(context_window=200_000, max_output_tokens=16_384)
        tracker = BudgetTracker(budget=budget, num_tools=0)
        tracker.record_iteration(5_000, 5_000)
        assert tracker.check_should_continue()

    def test_snapshot_contains_required_fields(self) -> None:
        budget = TokenBudget(context_window=200_000, max_output_tokens=16_384)
        tracker = BudgetTracker(budget=budget, num_tools=2)
        tracker.record_iteration(1_000, 4_000)
        snap = tracker.snapshot()
        assert "total_tokens" in snap
        assert "cumulative_progress_tokens" in snap
        assert "current_context_tokens" in snap
        assert "iterations" in snap
        assert "effective_context" in snap
        assert "utilization_pct" in snap
        assert snap["total_tokens"] == 1000
        assert snap["cumulative_progress_tokens"] == 1000
        assert snap["current_context_tokens"] == 4000
        assert snap["iterations"] == 1

    def test_total_tokens_accumulates(self) -> None:
        tracker = BudgetTracker()
        tracker.record_iteration(100, 1_000)
        tracker.record_iteration(200, 1_200)
        assert tracker.total_tokens == 300
        assert tracker.cumulative_progress_tokens == 300
        assert tracker.current_context_tokens == 1_200
        assert tracker.iteration_count == 2

    def test_budget_gate_uses_current_context_not_cumulative_progress(self) -> None:
        budget = TokenBudget(
            context_window=100_000,
            max_output_tokens=10_000,
            reserved_for_summary=5_000,
        )
        tracker = BudgetTracker(budget=budget, num_tools=0)
        tracker.record_iteration(50_000, 50_000)
        assert tracker.check_should_continue()
        tracker.record_iteration(50_000, 50_000)
        assert tracker.check_should_continue()

    def test_unknown_progress_does_not_trigger_diminishing_returns_stop(self) -> None:
        tracker = BudgetTracker()
        for _ in range(4):
            tracker.record_iteration(None, 1_000)
        assert tracker.check_should_continue()
        assert tracker.total_tokens == 0


# -- apply_budget_check (integration helper) ---------------------------------


class _StubEngine:
    def get_model_context_length(self) -> int:
        return 100_000

    def get_model_max_output_tokens(self) -> int:
        return 8_000


class _NullEngine:
    def get_model_context_length(self) -> None:
        return None

    def get_model_max_output_tokens(self) -> None:
        return None


class _StubConfig:
    context_length = 50_000
    max_tokens = 4_000


class _ReasoningReservationEngine:
    def get_model_context_length(self) -> int:
        return 262_144

    def get_model_max_output_tokens(self) -> int:
        return 32_768

    def get_request_output_reservation(self, reasoning_effort: str | None = None) -> int:
        return 32_768 if reasoning_effort == "none" else 65_536


class _Qwen38Config:
    context_length = 131_072
    max_tokens = 32_768
    model = "qwen3.8:27b-q3-k-s"


class TestApplyBudgetCheck:
    def test_returns_budget_from_engine(self) -> None:
        messages = [{"role": "user", "content": "hello"}]
        msgs, budget, tracker = apply_budget_check(
            messages,
            _StubConfig(),
            _StubEngine(),
            num_tools=0,  # type: ignore[arg-type]
        )
        assert budget is not None
        assert budget.context_window == 100_000
        assert budget.max_output_tokens == 8_000
        assert tracker is not None
        assert msgs is messages  # unchanged

    def test_falls_back_to_config(self) -> None:
        messages = [{"role": "user", "content": "hello"}]
        msgs, budget, tracker = apply_budget_check(
            messages,
            _StubConfig(),
            _NullEngine(),
            num_tools=0,  # type: ignore[arg-type]
        )
        assert budget is not None
        assert budget.context_window == 50_000
        assert budget.max_output_tokens == 4_000

    def test_reasoning_reservation_accounts_for_hidden_and_visible_output(self) -> None:
        messages = [{"role": "user", "content": "hello"}]
        _, thinking_budget, _ = apply_budget_check(
            messages,
            _Qwen38Config(),  # type: ignore[arg-type]
            _ReasoningReservationEngine(),  # type: ignore[arg-type]
            reasoning_effort="medium",
        )
        _, instruct_budget, _ = apply_budget_check(
            messages,
            _Qwen38Config(),  # type: ignore[arg-type]
            _ReasoningReservationEngine(),  # type: ignore[arg-type]
            reasoning_effort="none",
        )

        assert thinking_budget is not None
        assert instruct_budget is not None
        assert thinking_budget.max_output_tokens == 32_768
        assert thinking_budget.output_reservation_tokens == 65_536
        assert instruct_budget.output_reservation_tokens is None
        assert thinking_budget.effective_context() < instruct_budget.effective_context()


# -- resolve_auto_compact_ratio (per-model override resolution) ---------------


class _RatioConfig:
    def __init__(
        self,
        *,
        global_ratio: float | None = None,
        by_model: dict[str, float] | None = None,
    ) -> None:
        self.token_budget_auto_compact_ratio = global_ratio
        self.token_budget_auto_compact_ratio_by_model = by_model


class TestResolveAutoCompactRatio:
    def test_no_overrides_returns_module_default(self) -> None:
        ratio = resolve_auto_compact_ratio(_RatioConfig(), model_id="qwen3:8b")
        assert ratio == _AUTO_COMPACT_RATIO

    def test_global_override_without_per_model_entry(self) -> None:
        # Existing behavior: the global override must survive unchanged.
        config = _RatioConfig(global_ratio=0.7)
        assert resolve_auto_compact_ratio(config, model_id="qwen3:8b") == 0.7

    def test_per_model_entry_wins_over_global(self) -> None:
        config = _RatioConfig(global_ratio=0.7, by_model={"qwen3:8b": 0.5})
        assert resolve_auto_compact_ratio(config, model_id="qwen3:8b") == 0.5

    def test_per_model_entry_for_other_model_is_ignored(self) -> None:
        config = _RatioConfig(global_ratio=0.7, by_model={"gemma4:12b": 0.5})
        assert resolve_auto_compact_ratio(config, model_id="qwen3:8b") == 0.7

    def test_per_model_entry_without_global_falls_to_default_for_other_model(self) -> None:
        config = _RatioConfig(by_model={"gemma4:12b": 0.5})
        assert resolve_auto_compact_ratio(config, model_id="qwen3:8b") == _AUTO_COMPACT_RATIO

    def test_missing_model_id_falls_back_to_global(self) -> None:
        config = _RatioConfig(global_ratio=0.7, by_model={"qwen3:8b": 0.5})
        assert resolve_auto_compact_ratio(config, model_id=None) == 0.7

    def test_config_without_new_field_behaves_as_before(self) -> None:
        class _LegacyConfig:
            token_budget_auto_compact_ratio = 0.65

        assert resolve_auto_compact_ratio(_LegacyConfig(), model_id="qwen3:8b") == 0.65

    @pytest.mark.parametrize(
        "malformed",
        [True, False, "0.5", float("nan"), float("inf"), -0.1, 0.01, 1.0],
    )
    def test_malformed_global_values_fall_back_to_safe_default(self, malformed: object) -> None:
        config = _RatioConfig()
        config.token_budget_auto_compact_ratio = malformed
        assert resolve_auto_compact_ratio(config, model_id="qwen3:8b") == _AUTO_COMPACT_RATIO

    def test_malformed_model_value_falls_back_to_valid_global(self) -> None:
        config = _RatioConfig(global_ratio=0.7)
        config.token_budget_auto_compact_ratio_by_model = {"qwen3:8b": float("nan")}
        assert resolve_auto_compact_ratio(config, model_id="qwen3:8b") == 0.7


class _PerModelStubConfig:
    context_length = 50_000
    max_tokens = 4_000
    model = "qwen3:8b"
    token_budget_auto_compact_ratio = 0.7
    token_budget_auto_compact_ratio_by_model = {"qwen3:8b": 0.5}


class TestApplyBudgetCheckPerModelRatio:
    def test_budget_uses_per_model_ratio_for_active_model(self) -> None:
        messages = [{"role": "user", "content": "hello"}]
        _msgs, budget, _tracker = apply_budget_check(
            messages,
            _PerModelStubConfig(),  # type: ignore[arg-type]
            _StubEngine(),  # type: ignore[arg-type]
            num_tools=0,
        )
        assert budget is not None
        assert budget.auto_compact_ratio == 0.5

    def test_budget_keeps_global_ratio_when_model_not_mapped(self) -> None:
        class _OtherModelConfig(_PerModelStubConfig):
            model = "gemma4:12b"

        messages = [{"role": "user", "content": "hello"}]
        _msgs, budget, _tracker = apply_budget_check(
            messages,
            _OtherModelConfig(),  # type: ignore[arg-type]
            _StubEngine(),  # type: ignore[arg-type]
            num_tools=0,
        )
        assert budget is not None
        assert budget.auto_compact_ratio == 0.7

    def test_budget_defaults_when_no_overrides_present(self) -> None:
        # Parity pin: unset tunability config keeps the existing default.
        messages = [{"role": "user", "content": "hello"}]
        _msgs, budget, _tracker = apply_budget_check(
            messages,
            _StubConfig(),  # type: ignore[arg-type]
            _StubEngine(),  # type: ignore[arg-type]
            num_tools=0,
        )
        assert budget is not None
        assert budget.auto_compact_ratio == _AUTO_COMPACT_RATIO


def test_budget_tracker_caps_iteration_history() -> None:
    tracker = BudgetTracker()

    for index in range(80):
        tracker.record_iteration(index, index * 10)

    assert tracker.iter_history_limit == 64
    assert tracker.iteration_count == 80
    assert len(tracker.iter_history) == 64
    assert tracker.iter_history[0] == 16
    assert tracker.iter_history[-1] == 79


class TestCreateBestBackend:
    def test_returns_working_backend(self) -> None:
        from sidecar.ai.context.token_budget import _create_best_backend

        backend = _create_best_backend(_StubConfig())  # type: ignore[arg-type]
        assert hasattr(backend, "count_tokens")
        assert backend.count_tokens("hello") > 0

    def test_returns_backend_for_ollama_config(self) -> None:
        from sidecar.ai.config import RuntimeConfig
        from sidecar.ai.context.token_budget import _create_best_backend

        config = RuntimeConfig(engine_type="ollama", model="llama3.2:8b")
        backend = _create_best_backend(config)
        assert hasattr(backend, "count_tokens")
        assert backend.count_tokens("test") > 0


class TestWithReservedTokens:
    def test_shrinks_the_window_by_the_reserved_tokens(self) -> None:
        budget = TokenBudget(context_window=32_000, max_output_tokens=1_024)
        reserved = budget.with_reserved_tokens(1_000)
        assert reserved.context_window == 31_000
        assert reserved.max_output_tokens == budget.max_output_tokens
        assert reserved.effective_context() < budget.effective_context()
        assert reserved.hard_prompt_limit() < budget.hard_prompt_limit()

    def test_zero_or_negative_reservation_returns_the_same_budget(self) -> None:
        budget = TokenBudget(context_window=32_000, max_output_tokens=1_024)
        assert budget.with_reserved_tokens(0) is budget
        assert budget.with_reserved_tokens(-5) is budget

    def test_never_collapses_below_one_token(self) -> None:
        budget = TokenBudget(context_window=100, max_output_tokens=10)
        assert budget.with_reserved_tokens(10_000).context_window == 1
