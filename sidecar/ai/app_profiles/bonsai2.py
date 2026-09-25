"""Bonsai 2 (PrismML Ternary-Bonsai-2-27B) request profile.

This module exports ``BONSAI2_PROFILE`` only.  It does **not** self-register;
the registry bootstrap in ``sidecar.ai.app_profiles`` owns registration.

Bonsai 2 is PrismML's ternary quantization of Qwen3.8-27B (GGUF arch
``qwen35``, 262,144-token native context, vision through a separate
projector). It runs only on PrismML's llama.cpp fork, so Jenny serves it
exclusively through the managed llama-server -- the ``openai-compatible``
engine -- and the request behavior is scoped to that engine alone.

The profile sets no context window: the managed server's served window
(``--ctx-size``, reported by ``/props``) is the one requests actually get.

The model card's samplers equal Qwen3.8's (thinking 1.0 / 0.95 / 20 / 0 with
presence 0; instruct 0.7 / 0.80 / 20 / 0 with presence 1.5; repetition 1.0),
so the presets are shared, not copied. The card's reasoning-effort rule (no
``low``: it behaves close to ``xhigh``) lives in the engine and catalog
layers, not here.

The aliases mirror ``sidecar.ai.engines.model_name.BONSAI2_MODEL_PREFIXES``:
only whole 27B forms, with or without the hyphen after "bonsai".
``ternary-bonsai-2`` and ``bonsai-2`` are string prefixes of the previous
generation's ``ternary-bonsai-27b`` / ``bonsai-27b``, and a bare ``bonsai2``
would claim ``bonsai27b`` and the like.
"""

from __future__ import annotations

from sidecar.ai.app_profiles import (
    AppProfile,
    ConfigOverrides,
    RequestBehavior,
    VariantSpec,
)
from sidecar.ai.app_profiles.qwen38 import QWEN38_INSTRUCT_SAMPLER, QWEN38_THINKING_SAMPLER

BONSAI2_PROFILE: AppProfile = AppProfile(
    family="bonsai2",
    label="Bonsai 2",
    family_aliases=("ternary-bonsai-2-27b", "bonsai-2-27b", "ternary-bonsai2-27b", "bonsai2-27b"),
    variants=(
        VariantSpec(
            name="27b",
            aliases=("27b", "bonsai-2-27b"),
            label="Bonsai 2 27B",
            param_billions=27.0,
            active_param_billions=27.0,
            native_context_length=262_144,
            is_moe=False,
            family_supports_vision=True,
            family_supports_audio=False,
            behavior=RequestBehavior(
                # Only PrismML's llama.cpp fork loads the ternary GGUF.
                engine_types=("openai-compatible",),
                thinking_sampler=QWEN38_THINKING_SAMPLER,
                instruct_sampler=QWEN38_INSTRUCT_SAMPLER,
                max_output_tokens=32_768,
                thinking_token_headroom=32_768,
            ),
        ),
    ),
    default_variant="27b",
    overrides=ConfigOverrides(),
)
