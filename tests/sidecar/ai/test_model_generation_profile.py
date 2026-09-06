from __future__ import annotations

from sidecar.ai.app_profiles import (
    apply_behavior,
    apply_overrides,
    resolve_profile,
    resolve_variant,
)
from sidecar.ai.config import parse_runtime_config
from sidecar.ai.config_models import RuntimeConfig
from sidecar.ai.container import _apply_generation_profile
from sidecar.ai.engines.ollama_shared import _MAX_REQUEST_CONTEXT_LENGTH


def test_user_profile_applies_after_app_profile_for_supported_local_engine() -> None:
    config = RuntimeConfig(
        generation_profiles_by_model={
            "Gemma3": {
                "temperature": 0.3,
                "topK": 12,
                "maxOutputTokens": 2048,
            }
        },
        resolved_app_profile_temperature=0.9,
        resolved_app_profile_top_k=40,
        resolved_app_profile_max_output_tokens=8192,
    )
    applied = _apply_generation_profile(
        config,
        selected_engine_type="ollama",
        selected_model="gemma3:latest",
    )
    assert applied.resolved_app_profile_temperature == 0.3
    assert applied.resolved_app_profile_top_k == 12
    assert applied.resolved_user_max_output_tokens == 2048


def test_user_profile_is_hidden_from_unsupported_provider_engine() -> None:
    config = RuntimeConfig(
        generation_profiles_by_model={"gemma3:latest": {"temperature": 0.3}}
    )
    assert _apply_generation_profile(
        config,
        selected_engine_type="chatgpt",
        selected_model="gemma3:latest",
    ) is config


def test_user_profile_overrides_qwen_sampler_presets_for_both_reasoning_modes() -> None:
    config = RuntimeConfig(
        generation_profiles_by_model={
            "qwen3.8:latest": {
                "temperature": 0.25,
                "topP": 0.8,
                "repetitionPenalty": 1.15,
            }
        },
        resolved_app_profile_thinking_sampler={
            "temperature": 0.6,
            "top_p": 0.95,
            "top_k": 40,
        },
        resolved_app_profile_instruct_sampler={
            "temperature": 0.7,
            "top_p": 0.9,
            "min_p": 0.05,
        },
    )
    applied = _apply_generation_profile(
        config,
        selected_engine_type="ollama",
        selected_model="qwen3.8",
    )

    assert applied.resolved_app_profile_thinking_sampler == {
        "temperature": 0.25,
        "top_p": 0.8,
        "top_k": 40,
        "repeat_penalty": 1.15,
    }
    assert applied.resolved_app_profile_instruct_sampler == {
        "temperature": 0.25,
        "top_p": 0.8,
        "min_p": 0.05,
        "repeat_penalty": 1.15,
    }


def test_non_ollama_model_ids_do_not_use_ollama_alias_or_case_folding() -> None:
    config = RuntimeConfig(
        generation_profiles_by_model={"CaseSensitiveModel": {"temperature": 0.3}}
    )

    assert _apply_generation_profile(
        config,
        selected_engine_type="vllm",
        selected_model="casesensitivemodel",
    ) is config


def test_ornith15_manual_repeat_penalty_overrides_app_profile_pin() -> None:
    model = "ornith15:9b-q6-256k"
    profile = resolve_profile(model)
    assert profile is not None
    assert profile.family == "ornith15"
    variant = resolve_variant(profile, model)

    manual_config = RuntimeConfig(
        engine_type="ollama",
        model=model,
        generation_profiles_by_model={
            model: {"repetitionPenalty": 1.4},
        },
    )
    manual_config = apply_overrides(manual_config, profile, variant)
    manual_config = apply_behavior(manual_config, profile, variant)
    assert manual_config.resolved_app_profile_repeat_penalty == 1.05

    manual_config = _apply_generation_profile(
        manual_config,
        selected_engine_type="ollama",
        selected_model=model,
    )
    assert manual_config.resolved_app_profile_repeat_penalty == 1.4

    pinned_config = RuntimeConfig(engine_type="ollama", model=model)
    pinned_config = apply_overrides(pinned_config, profile, variant)
    pinned_config = apply_behavior(pinned_config, profile, variant)
    pinned_config = _apply_generation_profile(
        pinned_config,
        selected_engine_type="ollama",
        selected_model=model,
    )
    assert pinned_config.resolved_app_profile_repeat_penalty == 1.05


def test_context_ceiling_order_matches_renderer_config_and_ollama() -> None:
    # Renderer maximum from services/shell-config-compaction-tuning.js
    # CONTEXT_LENGTH_STEPS (pinned by the tests/shell-config-service.test.js twin).
    renderer_context_length_max = 262_144

    # The renderer's largest step must survive the sidecar parse bound...
    assert (
        parse_runtime_config(
            {"context_length_override": renderer_context_length_max}
        ).context_length_override
        == renderer_context_length_max
    )
    # ...and the parse bound sits exactly at that maximum: one past it drops.
    assert (
        parse_runtime_config(
            {"context_length_override": renderer_context_length_max + 1}
        ).context_length_override
        is None
    )
    assert renderer_context_length_max <= _MAX_REQUEST_CONTEXT_LENGTH
