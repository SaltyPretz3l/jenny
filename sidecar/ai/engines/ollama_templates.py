"""Ollama model family template registry — diagnostics only.

Maps model families to prompt format metadata.  Used for diagnostics,
mismatch warnings, and recommended settings.  Does NOT change the
``/api/chat`` transport or ``_build_messages()`` behavior.

When a loaded model's family string is not found in the registry, a
warning is logged indicating the registry may be stale.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

# ---------------------------------------------------------------------------
# Template entry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OllamaTemplateEntry:
    """Metadata for a single model family's prompt template."""

    family: str
    prompt_start: str = ""
    prompt_end: str = ""
    stop_tokens: tuple[str, ...] = ()
    suggested_num_ctx: int = 0
    eos_token: str = ""
    notes: str = ""


# ---------------------------------------------------------------------------
# Registry data
# ---------------------------------------------------------------------------

_REGISTRY: dict[str, OllamaTemplateEntry] = {}


def _register(entry: OllamaTemplateEntry) -> None:
    _REGISTRY[entry.family.lower()] = entry


# llama3 family
_register(
    OllamaTemplateEntry(
        family="llama3",
        prompt_start="<|begin_of_text|>",
        prompt_end="<|eot_id|>",
        stop_tokens=("<|eot_id|>", "<|end_of_text|>"),
        suggested_num_ctx=8192,
        eos_token="<|eot_id|>",
        notes="Llama 3 / 3.1 / 3.2 chat template with header/eot delimiters.",
    )
)

# mistral family
_register(
    OllamaTemplateEntry(
        family="mistral",
        prompt_start="[INST]",
        prompt_end="[/INST]",
        stop_tokens=("</s>",),
        suggested_num_ctx=8192,
        eos_token="</s>",
        notes="Mistral instruct format.",
    )
)

# gemma family
_register(
    OllamaTemplateEntry(
        family="gemma",
        prompt_start="<start_of_turn>",
        prompt_end="<end_of_turn>",
        stop_tokens=("<end_of_turn>",),
        suggested_num_ctx=8192,
        eos_token="<end_of_turn>",
        notes="Gemma / Gemma 2 / Gemma 3 chat template.",
    )
)

# phi family
_register(
    OllamaTemplateEntry(
        family="phi",
        prompt_start="<|user|>",
        prompt_end="<|end|>",
        stop_tokens=("<|end|>", "<|endoftext|>"),
        suggested_num_ctx=4096,
        eos_token="<|end|>",
        notes="Microsoft Phi-2 / Phi-3 / Phi-4 format.",
    )
)

# qwen family
_register(
    OllamaTemplateEntry(
        family="qwen",
        prompt_start="<|im_start|>",
        prompt_end="<|im_end|>",
        stop_tokens=("<|im_end|>", "<|endoftext|>"),
        suggested_num_ctx=32768,
        eos_token="<|im_end|>",
        notes="Qwen / Qwen2 / Qwen3 ChatML-style template.",
    )
)

# chatML generic
_register(
    OllamaTemplateEntry(
        family="chatml",
        prompt_start="<|im_start|>",
        prompt_end="<|im_end|>",
        stop_tokens=("<|im_end|>",),
        suggested_num_ctx=8192,
        eos_token="<|im_end|>",
        notes="Generic ChatML template used by many community fine-tunes.",
    )
)

# LiquidAI LFM2 family (ChatML-style role delimiters with start-of-text).
_register(
    OllamaTemplateEntry(
        family="lfm2",
        prompt_start="<|startoftext|><|im_start|>",
        prompt_end="<|im_end|>",
        stop_tokens=("<|im_end|>",),
        suggested_num_ctx=32768,
        eos_token="<|im_end|>",
        notes="LiquidAI LFM2 instruct ChatML-style template; diagnostics only.",
    )
)

# command-r family
_register(
    OllamaTemplateEntry(
        family="command-r",
        prompt_start="<|START_OF_TURN_TOKEN|><|USER_TOKEN|>",
        prompt_end="<|END_OF_TURN_TOKEN|>",
        stop_tokens=("<|END_OF_TURN_TOKEN|>",),
        suggested_num_ctx=131072,
        eos_token="<|END_OF_TURN_TOKEN|>",
        notes="Cohere Command R / R+ format.",
    )
)

# deepseek family
_register(
    OllamaTemplateEntry(
        family="deepseek",
        prompt_start="<|begin▁of▁sentence|>",
        prompt_end="<|end▁of▁sentence|>",
        stop_tokens=("<|end▁of▁sentence|>",),
        suggested_num_ctx=16384,
        eos_token="<|end▁of▁sentence|>",
        notes="DeepSeek V2/V3/R1 format.",
    )
)

# vicuna family
_register(
    OllamaTemplateEntry(
        family="vicuna",
        prompt_start="USER:",
        prompt_end="</s>",
        stop_tokens=("</s>",),
        suggested_num_ctx=4096,
        eos_token="</s>",
        notes="Vicuna/LLaMA-1 era legacy format.",
    )
)

# ---------------------------------------------------------------------------
# Lookup API
# ---------------------------------------------------------------------------


def resolve_template(
    family: str | None = None,
    families: list[str] | None = None,
) -> OllamaTemplateEntry | None:
    """Resolve a template entry from a family string or families list.

    Tries the primary ``family`` first, then each entry in ``families``.
    Returns ``None`` when no match is found.
    """
    candidates: list[str] = []
    if family:
        candidates.append(str(family).strip().lower())
    if families:
        for f in families:
            token = str(f).strip().lower()
            if token and token not in candidates:
                candidates.append(token)

    for candidate in candidates:
        # Direct lookup
        if candidate in _REGISTRY:
            return _REGISTRY[candidate]
        # Prefix match (e.g. "llama3.2" matches "llama3")
        for key, entry in _REGISTRY.items():
            if candidate.startswith(key):
                return entry

    return None


def resolve_template_from_model_info(
    info: dict[str, Any] | None,
) -> tuple[OllamaTemplateEntry | None, str]:
    """Resolve a template from ``/api/show`` metadata.

    Returns ``(entry, resolution_source)`` where ``resolution_source``
    describes how the match was made (e.g. "details.family",
    "details.families", or "unresolved").
    """
    if not info or not isinstance(info, dict):
        return None, "no_metadata"

    details = info.get("details")
    if not isinstance(details, dict):
        return None, "no_details"

    family = str(details.get("family") or "").strip().lower()
    families_raw = details.get("families")
    families: list[str] = []
    if isinstance(families_raw, list):
        families = [str(f).strip().lower() for f in families_raw if str(f).strip()]

    # Try primary family
    if family:
        entry = resolve_template(family=family)
        if entry is not None:
            return entry, "details.family"

    # Try families list
    if families:
        entry = resolve_template(families=families)
        if entry is not None:
            return entry, "details.families"

    # Unresolved
    logger.warning(
        "Ollama template registry has no entry for family=%r families=%r. "
        "The registry (schema_version=%d) may be stale for this model.",
        family,
        families,
        SCHEMA_VERSION,
    )
    return None, "unresolved"


def template_diagnostics(
    model_name: str,
    info: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build diagnostics payload for a loaded model's template resolution.

    Returns a dict suitable for logging and metadata surfaces.
    """
    entry, source = resolve_template_from_model_info(info)
    result: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "model": model_name,
        "resolution_source": source,
    }
    if entry is not None:
        result["family"] = entry.family
        result["suggested_num_ctx"] = entry.suggested_num_ctx
        result["eos_token"] = entry.eos_token
        result["stop_tokens"] = list(entry.stop_tokens)
        result["resolved"] = True
    else:
        result["resolved"] = False
        # Extract what we know from metadata
        if info and isinstance(info, dict):
            details = info.get("details")
            if isinstance(details, dict):
                result["raw_family"] = str(details.get("family") or "")
                raw_families = details.get("families")
                if isinstance(raw_families, list):
                    result["raw_families"] = [str(f) for f in raw_families]
    return result
