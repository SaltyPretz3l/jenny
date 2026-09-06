"""Ornith 1.5 request profile for supported local engines.

This module exports ``ORNITH15_PROFILE`` only.  It does **not** self-register;
the registry bootstrap in ``sidecar.ai.app_profiles`` owns registration.

The profile exists for one load-bearing reason: without it, Ollama thinking
requests fall back to the unprofiled ``repeat_penalty=1.15`` /
``repeat_last_n=256`` guard in ``ollama_generation._build_options``, and at
that strength the newline token — the most-repeated token in formatted text —
is suppressed within a few hundred tokens of thinking. Live evidence
(sess_1788049580063, ornith15:9b-q6-256k): 19/19 reasoning entries with zero
newlines across multi-KB thoughts, sentence periods glued to the next word,
and code fences emitted inline. 1.05 keeps a light anti-loop guard while
staying far below the whitespace-suppression regime. Sampler shape (top_p et
al.) is deliberately NOT pinned — no published recipe for this family, so the
request's own values pass through unchanged.

Aliases cover the custom local re-quants (``ornith15:9b-q6-256k``) and the
catalog HF pull tag (``hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q8_0``); the
Ornith 1.0 ``ornith:9b-48k`` tag is deliberately not matched.
"""

from __future__ import annotations

from sidecar.ai.app_profiles import (
    AppProfile,
    ConfigOverrides,
    RequestBehavior,
    VariantSpec,
)

ORNITH15_PROFILE: AppProfile = AppProfile(
    family="ornith15",
    label="Ornith 1.5",
    family_aliases=("ornith15", "ornith-1-5"),
    variants=(
        VariantSpec(
            name="9b",
            aliases=("9b", "ornith15-9b", "ornith-1-5-9b"),
            label="Ornith 1.5 9B",
            param_billions=9.0,
            active_param_billions=9.0,
            native_context_length=262_144,
            is_moe=False,
            family_supports_vision=False,
            family_supports_audio=False,
        ),
    ),
    default_variant="9b",
    # No config overrides: the owner's per-tag context choices (48k/256k
    # re-quants) must win — this profile only tunes request behavior.
    overrides=ConfigOverrides(),
    behavior=RequestBehavior(
        engine_types=("ollama", "openai-compatible"),
        repeat_penalty=1.05,
    ),
)
