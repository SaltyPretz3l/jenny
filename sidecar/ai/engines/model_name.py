"""Shared model-id canonicalization for engine capability detectors.

Registry-pulled tags carry a namespace prefix — ``hf.co/unsloth/Qwen3.6-...``
from an Ollama HuggingFace pull, or ``Qwen/Qwen3.5-9B`` from a vLLM/OpenAI model
id. The family-name detectors (vision / thinking / tool-calling / FIM) match the
bare model family, which is always the final path segment. Centralizing the
strip here gives every detector one canonicalizer.
"""

from __future__ import annotations

from typing import Any

VISION_MODEL_PREFIXES = (
    "llava",
    "bakllava",
    "moondream",
    "minicpm-v",
    "llama3.2-vision",
    "gemma3",
    "gemma4",
    "qwen2-vl",
    "qwen2.5-vl",
    "qwen2.5vl",
    "qwen-vl",
    "phi-3-vision",
    "phi3-vision",
)
VLLM_VISION_MODEL_PREFIXES = (
    "qwen2-vl",
    "qwen2.5-vl",
    "llava",
    "pixtral",
    "internvl",
    "phi-3-vision",
    "minicpm-v",
)
QWEN38_MODEL_PREFIXES = ("qwen3.8", "qwen38", "qwen-3.8")
THINKING_MODEL_PREFIXES = ("qwen3.5", "qwen3.6", "qwen36", *QWEN38_MODEL_PREFIXES)


def canonical_model_token(name: str | None) -> str:
    """Return ``name`` lowercased, whitespace-stripped, and namespace-free.

    The registry namespace is everything up to and including the final ``/``;
    a name without a ``/`` is returned unchanged (``rsplit`` yields the whole
    token). The model *tag* (the post-``:`` quant/size suffix) is preserved, so
    ``hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS`` canonicalizes to
    ``qwen3.6-35b-a3b-gguf:ud-iq4_xs`` — a form the family-prefix allowlists
    (``qwen3.6``) can match.
    """
    normalized = str(name or "").strip().lower()
    return normalized.rsplit("/", 1)[-1]


def is_qwen38_model(name: str | None) -> bool:
    """Return whether ``name`` identifies a Qwen3.8 model variant."""

    token = canonical_model_token(name)
    return any(token.startswith(prefix) for prefix in QWEN38_MODEL_PREFIXES)


def supports_ollama_reasoning_levels(name: str | None) -> bool:
    """Return whether Jenny knows this Ollama family accepts effort strings."""

    return is_qwen38_model(name)


def advertised_capability_source(
    entry: dict[str, Any],
    capability: str,
    *,
    normalize_lists: bool = True,
) -> str | None:
    """Return the first metadata path that advertises ``capability``."""
    details = entry.get("details")
    candidates = (
        ("capabilities", entry.get("capabilities")),
        (
            "details.capabilities",
            details.get("capabilities") if isinstance(details, dict) else None,
        ),
    )
    for source, advertised in candidates:
        if isinstance(advertised, list):
            values = (
                {str(value).strip().lower() for value in advertised if str(value).strip()}
                if normalize_lists
                else advertised
            )
            if capability in values:
                return source
        if isinstance(advertised, dict) and advertised.get(capability) is True:
            return source
    return None


def extract_family_tokens(
    entry: dict[str, Any],
    *,
    include_family: bool = True,
    stringify_family: bool = False,
) -> tuple[tuple[str, str], ...]:
    """Return normalized ``(token, source)`` pairs from entry details."""
    details = entry.get("details")
    if not isinstance(details, dict):
        return ()

    tokens: list[tuple[str, str]] = []
    family = details.get("family")
    if include_family:
        if stringify_family:
            family_token = str(family or "").strip().lower()
        elif isinstance(family, str):
            family_token = family.strip().lower()
        else:
            family_token = ""
        if family_token:
            tokens.append((family_token, "details.family"))

    families = details.get("families")
    if isinstance(families, list):
        tokens.extend(
            (token, "details.families")
            for value in families
            if (token := str(value).strip().lower())
        )
    return tuple(tokens)


def model_token_matches(
    token: str | None,
    *,
    marker: str,
    prefixes: tuple[str, ...],
) -> bool:
    """Return whether a normalized token contains ``marker`` or a known prefix."""
    normalized = str(token or "").strip().lower()
    if not normalized:
        return False
    return marker in normalized or any(normalized.startswith(prefix) for prefix in prefixes)
