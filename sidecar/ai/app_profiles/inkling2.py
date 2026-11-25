"""Inkling 2 Mini request profile.

This module exports ``INKLING2_PROFILE`` only.  It does **not** self-register;
the registry bootstrap in ``sidecar.ai.app_profiles`` owns registration.

Inkling 2 Mini is a native-reasoning mixture-of-experts chat model with a
1,048,576-token native context and vision. A local server loads it as a
single model and exposes it over the OpenAI REST shape, so Jenny reaches it
through the ``openai-compatible`` engine and the request behavior is scoped to
that engine alone.

The profile sets no context window: the window the server actually serves
(per slot, reported by its ``/props``) is the one requests get. The only
sampler it pins is the model card's temperature of 1.0; the other samplers
stay unset so the server's own defaults apply.

Output limits: a final answer of up to 16,384 tokens, plus 16,384 tokens of
thinking headroom that the engine adds to ``max_tokens`` for every thinking
level. The reasoning-effort mapping and the graded thinking budgets live in
the engine layer, not here.

The aliases mirror ``sidecar.ai.engines.model_name.INKLING2_MODEL_PREFIXES``:
only the Mini size matches, so the cloud ids ``inkling`` and ``inkling-small``
(a different model) are never claimed.
"""

from __future__ import annotations

from sidecar.ai.app_profiles import (
    AppProfile,
    ConfigOverrides,
    RequestBehavior,
    VariantSpec,
)

INKLING2_PROFILE: AppProfile = AppProfile(
    family="inkling2",
    label="Inkling 2 Mini",
    family_aliases=("inkling-2-mini", "inkling2-mini"),
    variants=(
        VariantSpec(
            name="mini",
            aliases=("mini", "inkling-2-mini"),
            label="Inkling 2 Mini",
            native_context_length=1_048_576,
            is_moe=True,
            behavior=RequestBehavior(
                engine_types=("openai-compatible",),
                temperature=1.0,
                max_output_tokens=16_384,
                thinking_token_headroom=16_384,
            ),
        ),
    ),
    default_variant="mini",
    overrides=ConfigOverrides(),
)
