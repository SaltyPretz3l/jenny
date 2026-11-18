"""Model-profile resolution for a configured local or cloud engine selection.

The app profile (model family defaults), the per-model context override and the
per-model generation profile resolve from the model an engine actually serves.
The primary stack and a delegate child on another engine (row 179) share this
one sequence so a child gets the same defaults the primary would.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from sidecar.ai.config import RuntimeConfig


def apply_model_profile(
    config: RuntimeConfig,
    *,
    engine_type: str,
    model: str,
) -> tuple[RuntimeConfig, tuple[Any, Any] | None]:
    """Resolve app profile, context override and generation profile for ``model``.

    Returns the resolved config and ``(profile, variant)`` when an app profile
    matched, for the caller's own logging.
    """
    from sidecar.ai.app_profiles import (
        apply_behavior,
        apply_overrides,
        resolve_profile,
        resolve_variant,
    )

    resolved: tuple[Any, Any] | None = None
    profile = resolve_profile(model, config.app_profile or None)
    if profile is not None:
        variant = resolve_variant(profile, model)
        config = apply_overrides(config, profile, variant)
        config = apply_behavior(config, profile, variant)
        resolved = (profile, variant)
    # A persisted per-model user choice is the final authority over the
    # conservative app-profile/default clamp. It remains bounded at parse.
    config = _apply_context_length_override(
        config,
        selected_engine_type=engine_type,
        selected_model=model,
    )
    config = _apply_generation_profile(
        config,
        selected_engine_type=engine_type,
        selected_model=model,
    )
    return config, resolved


def _append_system_prompt_addendum(base_prompt: str, addendum: str) -> str:
    normalized_base = str(base_prompt or "").rstrip()
    normalized_addendum = str(addendum or "").strip()
    if not normalized_addendum:
        return normalized_base
    if not normalized_base:
        return normalized_addendum
    return f"{normalized_base}\n\n{normalized_addendum}"


def _apply_context_length_override(
    config: RuntimeConfig,
    *,
    selected_engine_type: str,
    selected_model: str,
) -> RuntimeConfig:
    override = config.context_length_override
    applies = (
        override is not None
        and selected_engine_type == "ollama"
        and selected_model.strip() == config.model.strip()
    )
    return replace(config, context_length=override) if applies else config


def _canonical_model_id(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return ""
    last_segment = normalized.rsplit("/", 1)[-1]
    return normalized if ":" in last_segment else f"{normalized}:latest"


def _sync_engine_with_effective_config(engine: Any, config: RuntimeConfig) -> None:
    """Hand the loaded engine the limits that resolve only after it loaded.

    The app profile resolves from the model the engine actually loaded, and the
    context override follows it, so the engine was built before either existed
    (HB-016: Bonsai 2's output limits never reached llama-server).
    """
    set_context_length = getattr(engine, "set_configured_context_length", None)
    if callable(set_context_length):
        set_context_length(config.context_length)
    set_output_limits = getattr(engine, "set_profile_output_limits", None)
    if callable(set_output_limits):
        set_output_limits(
            max_output_tokens=config.resolved_app_profile_max_output_tokens,
            thinking_headroom=config.resolved_app_profile_thinking_token_headroom,
        )


def _generation_profile_model_key(value: str, *, engine_type: str) -> str:
    normalized = str(value or "").strip()
    return _canonical_model_id(normalized) if engine_type == "ollama" else normalized


def _merge_sampler_overrides(
    preset: dict[str, float | int] | None,
    overrides: dict[str, float | int],
) -> dict[str, float | int] | None:
    if not isinstance(preset, dict) or not overrides:
        return preset
    return {**preset, **overrides}


def _apply_generation_profile(
    config: RuntimeConfig,
    *,
    selected_engine_type: str,
    selected_model: str,
) -> RuntimeConfig:
    if selected_engine_type not in {"ollama", "vllm", "openai-compatible"}:
        return config
    profiles = config.generation_profiles_by_model or {}
    selected_key = _generation_profile_model_key(
        selected_model,
        engine_type=selected_engine_type,
    )
    profile = next(
        (
            entry
            for model_id, entry in profiles.items()
            if _generation_profile_model_key(
                model_id,
                engine_type=selected_engine_type,
            )
            == selected_key
        ),
        None,
    )
    if not isinstance(profile, dict):
        return config
    sampler_overrides = {
        target_name: profile[source_name]
        for source_name, target_name in {
            "temperature": "temperature",
            "topK": "top_k",
            "topP": "top_p",
            "minP": "min_p",
            "presencePenalty": "presence_penalty",
            "repetitionPenalty": "repeat_penalty",
        }.items()
        if source_name in profile
    }
    return replace(
        config,
        resolved_app_profile_temperature=(
            float(profile["temperature"])
            if "temperature" in profile
            else config.resolved_app_profile_temperature
        ),
        resolved_app_profile_top_k=(
            int(profile["topK"])
            if "topK" in profile
            else config.resolved_app_profile_top_k
        ),
        resolved_app_profile_top_p=(
            float(profile["topP"])
            if "topP" in profile
            else config.resolved_app_profile_top_p
        ),
        resolved_app_profile_min_p=(
            float(profile["minP"])
            if "minP" in profile
            else config.resolved_app_profile_min_p
        ),
        resolved_app_profile_presence_penalty=(
            float(profile["presencePenalty"])
            if "presencePenalty" in profile
            else config.resolved_app_profile_presence_penalty
        ),
        resolved_app_profile_repeat_penalty=(
            float(profile["repetitionPenalty"])
            if "repetitionPenalty" in profile
            else config.resolved_app_profile_repeat_penalty
        ),
        resolved_user_max_output_tokens=(
            int(profile["maxOutputTokens"])
            if "maxOutputTokens" in profile
            else config.resolved_user_max_output_tokens
        ),
        resolved_app_profile_thinking_sampler=_merge_sampler_overrides(
            config.resolved_app_profile_thinking_sampler,
            sampler_overrides,
        ),
        resolved_app_profile_instruct_sampler=_merge_sampler_overrides(
            config.resolved_app_profile_instruct_sampler,
            sampler_overrides,
        ),
    )
