"""Regression coverage for context-proportional Ollama generation budgets."""

from __future__ import annotations

import threading

import pytest

from sidecar.ai.engines.ollama import OllamaEngine


def _build_engine(
    context_length: int | None,
    *,
    model_name: str = "qwen3.5:32b",
) -> OllamaEngine:
    engine = object.__new__(OllamaEngine)
    engine.host = "http://localhost:11434"
    engine._request_timeout_seconds = 300  # noqa: SLF001
    engine.model_name = model_name
    engine._ready = True  # noqa: SLF001
    engine._vision = False  # noqa: SLF001
    engine._thinking = True  # noqa: SLF001
    engine._tool_calls_enabled = True  # noqa: SLF001
    engine._tool_call_http_400_streak = 0  # noqa: SLF001
    engine._context_length = context_length  # noqa: SLF001
    engine._configured_context_length = context_length  # noqa: SLF001
    engine._max_output_tokens = None  # noqa: SLF001
    engine._profile_max_output_tokens = None  # noqa: SLF001
    engine._profile_thinking_headroom = None  # noqa: SLF001
    engine._thinking_capability_source = "metadata"  # noqa: SLF001
    engine._request_context_lock = threading.Lock()  # noqa: SLF001
    return engine


@pytest.mark.parametrize(
    ("context_length", "model_name", "expected"),
    [
        (None, "qwen3.5:3b", 4096),
        (8192, "qwen3.5:32b", 4096),
        (49_152, "qwen3.5:32b", 16_384),
        (131_072, "qwen3.5:32b", 32_768),
        (262_144, "qwen3.5:32b", 65_536),
    ],
)
def test_thinking_headroom_scales_with_effective_context_floor_wins(
    context_length: int | None,
    model_name: str,
    expected: int,
) -> None:
    engine = _build_engine(context_length, model_name=model_name)

    assert engine._thinking_token_headroom() == expected  # noqa: SLF001


@pytest.mark.parametrize(
    ("context_length", "expected"),
    [
        (None, None),
        (8192, None),
        (49_152, None),
        (131_072, 32_768),
        (262_144, 65_536),
    ],
)
def test_model_max_output_scales_with_effective_context_floor_wins(
    context_length: int | None,
    expected: int | None,
) -> None:
    engine = _build_engine(context_length)

    assert engine.get_model_max_output_tokens() == expected


def test_native_context_alone_does_not_enable_budget_scaling() -> None:
    engine = _build_engine(262_144)
    engine._configured_context_length = None  # noqa: SLF001

    assert engine._thinking_token_headroom() == 16_384  # noqa: SLF001
    assert engine.get_model_max_output_tokens() is None


@pytest.mark.parametrize(
    ("context_length", "max_tokens", "expected"),
    [
        (49_152, 16_384, 32_768),
        (131_072, 32_768, 65_536),
    ],
)
def test_build_options_combines_scaled_output_and_thinking_budgets(
    context_length: int,
    max_tokens: int,
    expected: int,
) -> None:
    engine = _build_engine(context_length)

    options = engine._build_options(max_tokens, 0.7, thinking=True)  # noqa: SLF001

    assert options["num_predict"] == expected


def test_build_options_caps_combined_budget_at_half_of_large_context() -> None:
    engine = _build_engine(262_144)

    options = engine._build_options(200_000, 0.7, thinking=True)  # noqa: SLF001

    assert options["num_predict"] == 131_072


def test_build_options_ceiling_binds_below_combined_budget() -> None:
    engine = _build_engine(98_304)
    engine._profile_thinking_headroom = 32_768  # noqa: SLF001

    options = engine._build_options(32_768, 0.7, thinking=True)  # noqa: SLF001

    assert options["num_predict"] == 49_152


def test_build_options_caps_at_configured_context_below_native_context() -> None:
    engine = _build_engine(131_072)
    engine._configured_context_length = 32_768  # noqa: SLF001
    engine._profile_thinking_headroom = 32_768  # noqa: SLF001

    options = engine._build_options(32_768, 0.7, thinking=True)  # noqa: SLF001

    assert options["num_predict"] == 32_768


def test_profile_thinking_headroom_override_wins_without_scaling() -> None:
    engine = _build_engine(262_144)
    engine._profile_thinking_headroom = 12_345  # noqa: SLF001

    assert engine._thinking_token_headroom() == 12_345  # noqa: SLF001


def test_behavior_thinking_headroom_override_wins_without_scaling() -> None:
    engine = _build_engine(262_144)
    engine.begin_request_context(
        request_id="behavior-headroom",
        app_profile_behavior={"thinking_token_headroom": 23_456},
    )
    try:
        assert engine._thinking_token_headroom() == 23_456  # noqa: SLF001
    finally:
        engine.clear_request_context(request_id="behavior-headroom")


def test_profile_max_output_override_wins_without_scaling() -> None:
    engine = _build_engine(262_144)
    engine._profile_max_output_tokens = 34_567  # noqa: SLF001

    assert engine.get_model_max_output_tokens() == 34_567


def test_detected_max_output_override_wins_without_scaling() -> None:
    engine = _build_engine(262_144)
    engine._max_output_tokens = 45_678  # noqa: SLF001

    assert engine.get_model_max_output_tokens() == 45_678
