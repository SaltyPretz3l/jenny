"""Gemma 4 app profile data.

This module exports ``GEMMA4_PROFILE`` only.  It does **not** self-register;
``app_profiles/__init__.py`` handles registration explicitly.
"""

from __future__ import annotations

from sidecar.ai.app_profiles import (
    AppProfile,
    ConfigOverrides,
    RequestBehavior,
    VariantSpec,
)

_GEMMA4_PROMPT_ADDENDUM = (
    "Gemma 4 runtime guidance:\n"
    "- Think before acting and keep tool use sequential; plan one tool call at a time.\n"
    "- For coding work, use a plan-act-verify loop and prefer small atomic edits over full-file rewrites.\n"
    "- If an action fails, diagnose before retrying and do not repeat the same failed call twice.\n"
    "- When emitting private reasoning, wrap it with `<|channel>thought` and `<channel|>`."
)

GEMMA4_PROFILE = AppProfile(
    family="gemma4",
    label="Gemma 4",
    family_aliases=("gemma4", "gemma-4"),
    variants=(
        VariantSpec(
            name="e2b",
            aliases=("e2b-it",),
            label="Gemma 4 E2B",
            native_context_length=128_000,
            overrides=ConfigOverrides(
                context_length=8192,
            ),
        ),
        VariantSpec(
            name="e4b",
            aliases=(
                "e4b-it",
                "e4b-it-ud",
                "e4b-ud",
            ),
            label="Gemma 4 E4B",
            native_context_length=131_072,
        ),
        VariantSpec(
            name="12b",
            aliases=(
                "12b-it",
                "12b-it-gguf",
                "gemma-4-12b",
            ),
            label="Gemma 4 12B",
            native_context_length=262_144,
        ),
        VariantSpec(
            name="31b",
            aliases=("31b-it",),
            label="Gemma 4 31B",
            native_context_length=256_000,
        ),
        VariantSpec(
            name="26b-a4b",
            aliases=("26ba4b", "a4b", "26b-a4b-it"),
            label="Gemma 4 26B A4B",
            native_context_length=256_000,
            is_moe=True,
        ),
    ),
    default_variant="e4b",
    # The user's Image and PDF reads toggle wins.
    overrides=ConfigOverrides(context_length=32768),
    behavior=RequestBehavior(
        engine_types=("ollama", "vllm", "openai-compatible"),
        temperature=1.0,
        top_k=40,
        reasoning_parser_start="<|channel>thought",
        reasoning_parser_end="<channel|>",
        prompt_addendum=_GEMMA4_PROMPT_ADDENDUM,
    ),
)
