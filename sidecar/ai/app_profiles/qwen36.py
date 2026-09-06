"""Qwen 3.6 app profile data.

This module exports ``QWEN36_PROFILE`` only.  It does **not** self-register;
``app_profiles/__init__.py`` handles registration explicitly.

Model-card constants (``param_billions``, ``active_param_billions``,
``native_context_length``, ``is_moe``, 40-block layout) verified against
https://huggingface.co/Qwen/Qwen3.6-35B-A3B on 2026-04-19.  The card states
"Number of Parameters: 35B in total and 3B activated", "Context Length:
262,144 natively and extensible up to 1,010,000 tokens", "Mixture Of
Experts: Number of Experts: 256, Number of Activated Experts: 8 Routed + 1
Shared", and "Number of Layers: 40".  Re-verify before changing any of
these — a profile's numeric constants are sticky once shipped.

The card also recommends: "we advise maintaining a context length of at
least 128K tokens to preserve thinking capabilities" — so the default
``context_length`` override is 131_072 (128K) even though native is 262,144.

Sampler preset (temperature=0.6, top_p=0.95, top_k=20, min_p=0.0,
presence_penalty=0.0, repeat_penalty=1.0) mirrors the Qwen3 thinking recipe
and the Reddit GGUF tuning post referenced in QWEN36_JENNY_INTEGRATION_PLAN.md.
"""

from __future__ import annotations

from sidecar.ai.app_profiles import (
    AppProfile,
    ConfigOverrides,
    RequestBehavior,
    VariantSpec,
)

QWEN36_PROFILE = AppProfile(
    family="qwen36",
    label="Qwen3.6",
    family_aliases=("qwen3.6", "qwen36", "qwen-3.6"),
    variants=(
        VariantSpec(
            name="35b-a3b",
            aliases=("35ba3b", "35b-a3b", "qwen3.6-35b-a3b"),
            label="Qwen3.6 35B A3B",
            param_billions=35.0,
            active_param_billions=3.0,
            native_context_length=262_144,
            is_moe=True,
            family_supports_vision=False,
            family_supports_audio=False,
            overrides=ConfigOverrides(context_length=131_072),
            behavior=RequestBehavior(
                # Managed OpenAI-compatible local runtimes need this sampler.
                # Do not list unregistered engine types: apply_behavior() would
                # silently no-op for them.
                engine_types=("vllm", "ollama", "openai-compatible"),
                temperature=0.6,
                top_p=0.95,
                top_k=20,
                min_p=0.0,
                presence_penalty=0.0,
                repeat_penalty=1.0,
            ),
        ),
    ),
    default_variant="35b-a3b",
    overrides=ConfigOverrides(context_length=131_072),
)
