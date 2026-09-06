"""Qwen3.8 27B request profile for supported local engines."""

from __future__ import annotations

from sidecar.ai.app_profiles import (
    AppProfile,
    ConfigOverrides,
    RequestBehavior,
    SamplerPreset,
    VariantSpec,
)

_THINKING_SAMPLER = SamplerPreset(
    temperature=1.0,
    top_p=0.95,
    top_k=20,
    min_p=0.0,
    presence_penalty=0.0,
    repeat_penalty=1.0,
)
_INSTRUCT_SAMPLER = SamplerPreset(
    temperature=0.7,
    top_p=0.80,
    top_k=20,
    min_p=0.0,
    presence_penalty=1.5,
    repeat_penalty=1.0,
)

QWEN38_PROFILE: AppProfile = AppProfile(
    family="qwen38",
    label="Qwen3.8",
    family_aliases=("qwen3.8", "qwen38", "qwen-3.8"),
    variants=(
        VariantSpec(
            name="27b",
            aliases=("27b", "qwen3.8-27b", "qwen38-27b"),
            label="Qwen3.8 27B",
            param_billions=27.0,
            active_param_billions=27.0,
            native_context_length=262_144,
            is_moe=False,
            family_supports_vision=False,
            family_supports_audio=False,
            overrides=ConfigOverrides(context_length=131_072),
            behavior=RequestBehavior(
                engine_types=("ollama", "openai-compatible"),
                thinking_sampler=_THINKING_SAMPLER,
                instruct_sampler=_INSTRUCT_SAMPLER,
                max_output_tokens=32_768,
                thinking_token_headroom=32_768,
            ),
        ),
    ),
    default_variant="27b",
    overrides=ConfigOverrides(context_length=131_072),
)
