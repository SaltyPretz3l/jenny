"""Count-source ladder and scaled backend (row 66).

Budget numbers live in test_token_budget_count_parity.py and the turn-start
preflight in test_context_count_preflight.py.
"""

from __future__ import annotations

import math
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.context.context_count import (
    ContextCalibration,
    ScaledTokenizerBackend,
    engine_reports_full_prompt_tokens,
    normalize_context_calibration,
    publish_request_token_scale,
    resolve_token_scale,
    scale_in_band,
)
from sidecar.ai.context.token_budget import (
    CharEstimationBackend,
    TokenizerBackend,
    estimate_tool_schema_tokens,
)
from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.vllm_engine import VLLMEngine


@pytest.fixture(autouse=True)
def _char_estimator(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the inner estimator so the numbers do not depend on installed tokenizers."""
    monkeypatch.setattr(
        "sidecar.ai.context.token_budget._create_best_backend",
        lambda _config: CharEstimationBackend(),
    )


# -- scale_in_band / ScaledTokenizerBackend --------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1.0, 1.0),
        (1.37, 1.37),
        (0.89, None),
        (1.61, None),
        (0, None),
        (float("nan"), None),
        (float("inf"), None),
        (True, None),
        ("1.2", None),
        (None, None),
    ],
)
def test_scale_in_band(value: Any, expected: float | None) -> None:
    assert scale_in_band(value, (0.9, 1.6)) == expected


def test_scaled_backend_rescales_counts_and_satisfies_the_protocol() -> None:
    inner = CharEstimationBackend()
    scaled = ScaledTokenizerBackend(inner, 1.5)

    assert isinstance(scaled, TokenizerBackend)
    assert scaled.inner is inner
    assert scaled.count_tokens("") == 0
    assert scaled.count_tokens("x" * 400) == math.ceil(100 * 1.5) == 150
    assert scaled.count_tokens("abc") == math.ceil(1 * 1.5)
    # The scale carries the estimator's error, so no window headroom is kept.
    assert scaled.headroom_factor == 0.0
    assert scaled.is_exact_match is False
    assert ScaledTokenizerBackend(inner, 1.5, exact=True).is_exact_match is True
    assert scaled.get_context_window("m") == inner.get_context_window("m")
    assert scaled.get_max_output_tokens("m") == inner.get_max_output_tokens("m")


@pytest.mark.parametrize("scale", [float("nan"), 0.0, -1.0, 0.1, 9.0])
def test_scaled_backend_rejects_an_unusable_scale(scale: float) -> None:
    with pytest.raises(ValueError):
        ScaledTokenizerBackend(CharEstimationBackend(), scale)


# -- ContextCalibration --------------------------------------------------------

_GOOD = {
    "provider_tokens": 150_000,
    "estimate_tokens": 100_000,
    "engine": "ninfer",
    "model": "qwen3.8",
    "estimator": "CharEstimationBackend",
}


def test_normalize_context_calibration_accepts_a_well_formed_mapping() -> None:
    calibration = normalize_context_calibration(_GOOD)

    assert calibration == ContextCalibration(
        150_000, 100_000, "ninfer", "qwen3.8", "CharEstimationBackend"
    )
    assert calibration is not None and calibration.ratio == 1.5


@pytest.mark.parametrize(
    ("provider", "estimate", "ratio"),
    [
        (1_000_000, 1_000, None),  # far off the estimator: not carried forward
        (1, 1_000, None),  # an uncached-tail count, not the whole prompt
        (85_000, 100_000, None),
        (95_000, 100_000, 1.0),  # trusted, but never below the estimate
        (160_000, 100_000, 1.6),
    ],
)
def test_calibration_ratio_is_trusted_only_inside_the_band(
    provider: int, estimate: int, ratio: float | None
) -> None:
    assert ContextCalibration(provider, estimate, "e", "m", "x").ratio == ratio


@pytest.mark.parametrize(
    "mutation",
    [
        {"provider_tokens": 0},
        {"provider_tokens": -5},
        {"provider_tokens": 1.5},
        {"provider_tokens": "150000"},
        {"provider_tokens": True},
        {"estimate_tokens": 0},
        {"estimate_tokens": None},
        {"engine": ""},
        {"engine": 7},
        {"model": "m" * 201},
        {"estimator": "   "},
        {"provider_tokens": ...},
        {"estimator": ...},
    ],
)
def test_normalize_context_calibration_fails_closed(mutation: dict[str, Any]) -> None:
    raw = dict(_GOOD)
    for key, value in mutation.items():
        if value is ...:
            raw.pop(key)
        else:
            raw[key] = value

    assert normalize_context_calibration(raw) is None


@pytest.mark.parametrize("raw", [None, [], "calibration", 5, [("provider_tokens", 1)]])
def test_normalize_context_calibration_rejects_non_mappings(raw: Any) -> None:
    assert normalize_context_calibration(raw) is None


# -- engine capability ----------------------------------------------------------


def test_only_full_prompt_reporting_engines_opt_in() -> None:
    assert engine_reports_full_prompt_tokens(VLLMEngine) is True
    assert engine_reports_full_prompt_tokens(OpenAICompatibleEngine) is True
    assert engine_reports_full_prompt_tokens(OllamaEngine) is False
    assert engine_reports_full_prompt_tokens(SimpleNamespace()) is False
    # A truthy non-bool never counts: the contract is the literal True.
    assert (
        engine_reports_full_prompt_tokens(SimpleNamespace(reports_full_prompt_input_tokens=1))
        is False
    )


def test_publish_request_token_scale_writes_the_engine_request_context() -> None:
    context: dict[str, Any] = {}
    publish_request_token_scale(SimpleNamespace(_current_request_context=lambda: context), 1.3)
    assert context == {"prompt_token_scale": 1.3}
    # No bound context, or no accessor: nothing to write, never an error.
    publish_request_token_scale(SimpleNamespace(_current_request_context=lambda: None), 1.3)
    publish_request_token_scale(SimpleNamespace(), 1.3)


# -- resolve_token_scale ---------------------------------------------------------

_WINDOW = 10_000


class _CountingEngine:
    reports_full_prompt_input_tokens = True

    def __init__(self, total: Any = None, error: Exception | None = None) -> None:
        self.total = total
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def count_request_tokens(self, *, messages: Any, tools: Any) -> Any:
        self.calls.append({"messages": messages, "tools": tools})
        if self.error is not None:
            raise self.error
        return self.total


def _history(tokens: int) -> list[dict[str, Any]]:
    # One user row of ``tokens`` estimator tokens (4 chars each) plus 4 framing.
    return [{"role": "user", "content": "x" * (4 * (tokens - 4))}]


_CONFIG = SimpleNamespace(engine_type="ninfer", model="qwen3.8")
_CALIBRATION = ContextCalibration(14_000, 10_000, "ninfer", "qwen3.8", "CharEstimationBackend")


def _resolve(engine: Any, *, messages: Any = None, calibration: Any = None, **kwargs: Any) -> Any:
    return resolve_token_scale(
        engine=engine,
        config=kwargs.pop("config", _CONFIG),
        messages=messages if messages is not None else _history(6_000),
        tool_payload=kwargs.pop("tool_payload", []),
        inner_backend=kwargs.pop("inner_backend", CharEstimationBackend()),
        calibration=calibration,
        raw_window=kwargs.pop("raw_window", _WINDOW),
        **kwargs,
    )


def test_exact_count_sets_the_scale_from_the_engine_total() -> None:
    engine = _CountingEngine(total=9_000)

    scale, source = _resolve(engine)  # inner estimate is 6_000

    assert (scale, source) == (1.5, "exact")
    assert len(engine.calls) == 1


def test_an_exact_ratio_outside_the_calibration_band_is_still_used() -> None:
    # CJK-heavy text can run ~4x the chars/4 estimate; the exact count is truth.
    assert _resolve(_CountingEngine(total=24_000)) == (4.0, "exact")


def test_exact_count_includes_the_tool_schemas_on_both_sides() -> None:
    tools = [{"name": "t", "parameters": {"type": "object", "properties": {}}}]
    engine = _CountingEngine(total=12_000)

    scale, source = _resolve(engine, messages=_history(5_000), tool_payload=tools)

    inner_total = 5_000 + estimate_tool_schema_tokens(tools)
    assert source == "exact"
    assert scale == pytest.approx(12_000 / inner_total)
    assert engine.calls[0]["tools"] == tools


def test_an_image_turn_skips_the_exact_count() -> None:
    # The router's messages carry no images yet, so a server count would be text
    # only while the tiles are budgeted as a separate surcharge.
    engine = _CountingEngine(total=12_000)

    assert _resolve(engine, extra_tokens=3_000) == (None, "estimate")
    assert engine.calls == []


def test_an_image_turn_still_uses_a_matching_calibration() -> None:
    engine = _CountingEngine(total=12_000)

    assert _resolve(engine, extra_tokens=3_000, calibration=_CALIBRATION) == (1.4, "calibrated")


def test_an_exact_count_below_the_estimate_is_floored_at_one() -> None:
    # A low server figure most likely missed part of the prompt (an unverified
    # NInfer route, a template that dropped rows): never trim below the estimate.
    assert _resolve(_CountingEngine(total=3_000)) == (1.0, "exact")


def test_small_chats_skip_the_exact_round_trip() -> None:
    engine = _CountingEngine(total=9_000)

    # 3_000 < 0.5 * 0.9 * 10_000 = 4_500.
    scale, source = _resolve(engine, messages=_history(3_000))

    assert (scale, source) == (None, "estimate")
    assert engine.calls == []


@pytest.mark.parametrize("bad_total", [None, 0, -4, 1.5, "9000", True, 600, 60_000])
def test_a_missing_malformed_or_absurd_exact_count_falls_through(bad_total: Any) -> None:
    scale, source = _resolve(_CountingEngine(total=bad_total))

    assert (scale, source) == (None, "estimate")


def test_an_exact_count_failure_falls_through_to_calibration() -> None:
    engine = _CountingEngine(error=TimeoutError("slow"))

    scale, source = _resolve(engine, calibration=_CALIBRATION)

    assert (scale, source) == (1.4, "calibrated")


def test_allow_exact_false_never_calls_the_engine() -> None:
    engine = _CountingEngine(total=9_000)

    scale, source = _resolve(engine, allow_exact=False)

    assert (scale, source) == (None, "estimate")
    assert engine.calls == []


def test_calibration_applies_when_everything_matches() -> None:
    engine = SimpleNamespace(reports_full_prompt_input_tokens=True)

    assert _resolve(engine, calibration=_CALIBRATION) == (1.4, "calibrated")


def test_an_out_of_band_calibration_falls_back_to_the_estimate() -> None:
    engine = SimpleNamespace(reports_full_prompt_input_tokens=True)
    tail_only = ContextCalibration(3_000, 10_000, "ninfer", "qwen3.8", "CharEstimationBackend")

    assert _resolve(engine, calibration=tail_only) == (None, "estimate")


_FULL = SimpleNamespace(reports_full_prompt_input_tokens=True)


@pytest.mark.parametrize(
    ("engine", "config", "estimator"),
    [
        (_FULL, SimpleNamespace(engine_type="vllm", model="qwen3.8"), "CharEstimationBackend"),
        (_FULL, SimpleNamespace(engine_type="ninfer", model="other"), "CharEstimationBackend"),
        (_FULL, _CONFIG, "TiktokenBackend"),
        (SimpleNamespace(reports_full_prompt_input_tokens=False), _CONFIG, "CharEstimationBackend"),
        (SimpleNamespace(), _CONFIG, "CharEstimationBackend"),
    ],
    ids=["engine", "model", "estimator", "ollama-like attribute False", "no attribute"],
)
def test_calibration_is_ignored_on_any_mismatch(engine: Any, config: Any, estimator: str) -> None:
    calibration = ContextCalibration(14_000, 10_000, "ninfer", "qwen3.8", estimator)

    assert _resolve(engine, config=config, calibration=calibration) == (None, "estimate")


def test_the_plain_estimate_is_the_default() -> None:
    assert _resolve(SimpleNamespace()) == (None, "estimate")


def test_the_backend_and_window_default_to_the_budgets_own() -> None:
    engine = _CountingEngine(total=9_000)
    engine.get_model_context_length = lambda: _WINDOW  # type: ignore[attr-defined]

    scale, source = resolve_token_scale(
        engine=engine,
        config=SimpleNamespace(engine_type="ninfer", model="qwen3.8", context_length=_WINDOW),
        messages=_history(6_000),
        tool_payload=[],
        calibration=None,
    )

    assert source == "exact"
    assert scale == pytest.approx(9_000 / 6_000, rel=0.01)
