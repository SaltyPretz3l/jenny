"""Turn-start preflight and preview on the count-source ladder (row 66)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.context.compaction import CompactionCircuitBreaker
from sidecar.ai.context.context_count import ContextCalibration
from sidecar.ai.context.preview import _compact_at_tokens
from sidecar.ai.context.token_budget import CharEstimationBackend, estimate_messages_tokens
from sidecar.ai.feature_flags import FEATURE_CONTEXT_COMPACTION, FEATURE_TOKEN_BUDGET
from sidecar.ai.routing import chat_decision as _chat_decision
from sidecar.ai.routing.loop_events import ContextCompactedEvent


@pytest.fixture(autouse=True)
def _char_estimator(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the inner estimator so the numbers do not depend on installed tokenizers."""
    monkeypatch.setattr(
        "sidecar.ai.context.token_budget._create_best_backend",
        lambda _config: CharEstimationBackend(),
    )


_SUMMARY = (
    "<summary>\n" + "\n".join(f"{i}. **Section {i}** kept." for i in range(1, 10)) + "\n</summary>"
)
_CALIBRATION = ContextCalibration(15_000, 10_000, "ninfer", "qwen3.8", "CharEstimationBackend")


class _PreflightEngine:
    def __init__(
        self, *, window: int, exact_scale: float | None = None, full_prompt: bool = False
    ) -> None:
        self._window = window
        self._exact_scale = exact_scale
        self.reports_full_prompt_input_tokens = full_prompt
        self.count_calls = 0
        self.request_context: dict[str, Any] = {}
        if exact_scale is not None:
            self.count_request_tokens = self._count  # type: ignore[assignment]

    def _count(self, *, messages: Any, tools: Any) -> int:
        self.count_calls += 1
        assert self._exact_scale is not None
        return int(estimate_messages_tokens(messages, CharEstimationBackend()) * self._exact_scale)

    def _current_request_context(self) -> dict[str, Any]:
        return self.request_context

    def get_model_context_length(self) -> int:
        return self._window

    def get_model_max_output_tokens(self) -> int:
        return 512


def _preflight_context(
    engine: Any,
    *,
    emitted: list[object],
    calibration: ContextCalibration | None = None,
    count_scale: tuple[float | None, str] | None = None,
    window: int = 8_000,
) -> _chat_decision._BudgetPreflightContext:
    config = SimpleNamespace(
        tools_enabled=False,
        engine_type="ninfer",
        model="qwen3.8",
        context_length=window,
        max_tokens=512,
        resolved_user_max_output_tokens=None,
        feature_flags={FEATURE_TOKEN_BUDGET: True, FEATURE_CONTEXT_COMPACTION: True},
    )
    kernel = SimpleNamespace(
        _config=config,
        _engine=engine,
        _context_builder=SimpleNamespace(
            build_context_pressure_advisory=lambda _status: "",
            insert_runtime_system_messages=lambda messages, _rt: list(messages),
        ),
        _compaction_breakers=SimpleNamespace(for_key=lambda _key: CompactionCircuitBreaker()),
        _build_compaction_generate_fn=lambda **_kwargs: (lambda _messages: _SUMMARY),
    )
    return _chat_decision._BudgetPreflightContext(
        kernel=kernel,
        feature_flags=config.feature_flags,
        tool_payload=[],
        prompt_cache_enabled=False,
        request_id="req-ladder",
        session_id=None,
        system_prompt_text="",
        runtime=SimpleNamespace(emit_safe=emitted.append, current_iteration=0),
        cache_break_detector=None,
        cache_source_key="",
        reasoning_effort=None,
        input_complete=True,
        context_calibration=calibration,
        count_scale=count_scale,
    )


def _long_history(turns: int = 20) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for index in range(turns):
        rows.append({"role": "user", "content": f"question {index} " + "word " * 80})
        rows.append({"role": "assistant", "content": f"answer {index} " + "word " * 80})
    rows.append({"role": "user", "content": "continue"})
    return rows


@pytest.fixture
def _quiet_preflight(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_chat_decision, "_emit_preflight_context_usage", lambda *_a, **_k: None)
    monkeypatch.setattr(_chat_decision, "resolve_compaction_prompt", lambda _config: "compact")


def _prepare(context: Any, history: list[dict[str, object]], **kwargs: Any) -> Any:
    return _chat_decision._prepare_context_budget(
        context, working_messages=history, runtime_system_messages=[], **kwargs
    )


def test_preflight_uses_the_exact_count_against_the_raw_window(_quiet_preflight: None) -> None:
    engine = _PreflightEngine(window=8_000, exact_scale=1.25)

    result = _prepare(_preflight_context(engine, emitted=[]), _long_history(20))

    tracker = result.budget_tracker
    assert tracker is not None and tracker.budget is not None
    assert engine.count_calls == 1
    assert tracker.count_source == "exact"
    assert tracker.raw_context_window == 8_000
    # The raw window, not the estimator's 30% haircut.
    assert tracker.budget.context_window == 8_000
    assert tracker.backend.count_tokens("x" * 400) == 125  # 100 estimator tokens x 1.25
    # The engine sizes max_tokens from the same scale.
    assert engine.request_context["prompt_token_scale"] == pytest.approx(1.25, abs=0.01)


def test_preflight_uses_a_matching_calibration_against_the_raw_window(
    _quiet_preflight: None,
) -> None:
    engine = _PreflightEngine(window=8_000, full_prompt=True)

    result = _prepare(
        _preflight_context(engine, emitted=[], calibration=_CALIBRATION), _long_history(4)
    )

    tracker = result.budget_tracker
    assert tracker is not None and tracker.budget is not None
    assert tracker.count_source == "calibrated"
    assert tracker.budget.context_window == 8_000
    assert tracker.backend.count_tokens("x" * 400) == 150
    assert engine.request_context["prompt_token_scale"] == 1.5


def test_preflight_reuses_the_probes_scale_without_a_second_count(_quiet_preflight: None) -> None:
    engine = _PreflightEngine(window=8_000, exact_scale=0.5)

    result = _prepare(
        _preflight_context(engine, emitted=[], count_scale=(1.25, "exact")), _long_history(20)
    )

    assert engine.count_calls == 0
    assert result.budget_tracker is not None
    assert result.budget_tracker.backend.count_tokens("x" * 400) == 125


@pytest.mark.parametrize(
    "calibration",
    [
        ContextCalibration(15_000, 10_000, "ollama", "qwen3.8", "CharEstimationBackend"),
        ContextCalibration(15_000, 10_000, "ninfer", "other-model", "CharEstimationBackend"),
        ContextCalibration(15_000, 10_000, "ninfer", "qwen3.8", "TiktokenBackend"),
        ContextCalibration(4_000, 10_000, "ninfer", "qwen3.8", "CharEstimationBackend"),
    ],
    ids=["engine", "model", "estimator", "uncached-tail ratio"],
)
def test_preflight_ignores_an_unusable_calibration(
    _quiet_preflight: None, calibration: ContextCalibration
) -> None:
    engine = _PreflightEngine(window=8_000, full_prompt=True)

    result = _prepare(
        _preflight_context(engine, emitted=[], calibration=calibration), _long_history(4)
    )

    assert result.budget_tracker is not None
    assert result.budget_tracker.count_source == "estimate"
    assert engine.request_context["prompt_token_scale"] is None


def test_preflight_ignores_calibration_on_an_engine_without_full_prompt_counts(
    _quiet_preflight: None,
) -> None:
    ollama_like = _PreflightEngine(window=8_000, full_prompt=False)

    result = _prepare(
        _preflight_context(ollama_like, emitted=[], calibration=_CALIBRATION), _long_history(4)
    )

    assert result.budget_tracker is not None
    assert result.budget_tracker.count_source == "estimate"


def test_a_ladder_triggered_compaction_is_not_a_no_op(_quiet_preflight: None) -> None:
    """The scaled count crosses the threshold the plain estimate would not, and
    the compactor must judge with the same scaled backend or it returns early."""
    history = _long_history(20)
    inner_total = estimate_messages_tokens(history, CharEstimationBackend())
    engine = _PreflightEngine(window=8_000, exact_scale=2.0)
    emitted: list[object] = []
    # 8_000 window, no cut: effective 6_976, compact at 6_278. The estimate alone
    # sits below it; the exact (2x) count sits above it.
    assert 3_600 <= inner_total < 6_278 < inner_total * 2

    result = _prepare(_preflight_context(engine, emitted=emitted), history)

    assert result.terminal_decision is None
    assert result.budget_tracker is not None and result.budget_tracker.count_source == "exact"
    events = [event for event in emitted if isinstance(event, ContextCompactedEvent)]
    assert len(events) == 1
    assert events[0].tokens_after < events[0].tokens_before
    assert len(result.working_messages) < len(history)


def test_compaction_does_not_run_below_the_scaled_threshold(_quiet_preflight: None) -> None:
    history = _long_history(20)
    # A low exact count is floored at 1.0, so this judges on the plain estimate.
    engine = _PreflightEngine(window=8_000, exact_scale=0.5)
    emitted: list[object] = []

    result = _prepare(_preflight_context(engine, emitted=emitted), history)

    assert [event for event in emitted if isinstance(event, ContextCompactedEvent)] == []
    assert result.working_messages == history


def test_the_terminal_meter_estimate_counts_with_the_trackers_backend() -> None:
    engine = _PreflightEngine(window=8_000, exact_scale=0.5)
    context = _preflight_context(engine, emitted=[])
    history = _long_history(20)
    tracker = _prepare(context, history).budget_tracker
    kernel = SimpleNamespace(_context_tokens_estimate=lambda _messages: -1)

    decision = _chat_decision._build_chat_decision(
        kernel,
        working_messages=history,
        thinking_text=None,
        response_text="",
        approval_request=None,
        tool_results=(),
        budget_tracker=tracker,
    )

    assert decision.context_tokens_estimate == estimate_messages_tokens(history, tracker.backend)


# -- preview ----------------------------------------------------------------------


class _QwenEngine:
    reports_full_prompt_input_tokens = True
    fits_output_to_window = True

    def get_model_context_length(self) -> int:
        return 262_144

    def get_model_max_output_tokens(self) -> int:
        return 32_768

    def get_request_output_reservation(self, reasoning_effort: str | None = None) -> int:
        return 65_536


def test_preview_compact_point_follows_the_scaled_count_source() -> None:
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            tools_enabled=False,
            engine_type="ninfer",
            model="qwen3.8",
            context_length=262_144,
            max_tokens=32_768,
            feature_flags={FEATURE_TOKEN_BUDGET: True, FEATURE_CONTEXT_COMPACTION: True},
        ),
        _engine=_QwenEngine(),
    )
    request = SimpleNamespace(reasoning_effort="medium")

    plain = _compact_at_tokens(kernel, request, [], 0, 262_144)  # type: ignore[arg-type]
    scaled = _compact_at_tokens(
        kernel, request, [], 0, 262_144, token_scale=1.2, scale_source="calibrated"  # type: ignore[arg-type]
    )

    # 183_500 - 20_480 = 163_020 -> x0.9 = 146_718 on the estimate path.
    assert plain == 146_718
    # Raw window: 262_144 - 20_480 = 241_664 -> x0.9 = 217_497 calibrated.
    assert scaled == 217_497
