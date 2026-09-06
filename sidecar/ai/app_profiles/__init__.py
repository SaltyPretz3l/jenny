"""App profile system — model-family-specific knowledge for Jenny.

An app profile is a data-driven bundle of model-family-specific knowledge:
variant specs, capability flags, and runtime config overrides.  Profiles are
additive and optional — when no profile matches, behaviour is unchanged.

Registration is explicit: each profile module exports a constant, and this
module imports and seeds ``_REGISTRY`` at the bottom of the file.
"""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, fields
from typing import TYPE_CHECKING

from sidecar.runtime.diagnostics import log_event

if TYPE_CHECKING:
    from sidecar.ai.config import RuntimeConfig

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ConfigOverrides:
    """RuntimeConfig fields applied on every configure (v1: model-coupled only)."""

    context_length: int | None = None
    tools_image_read_enabled: bool | None = None


@dataclass(frozen=True)
class SamplerPreset:
    """Validated provider sampler values selected by request thinking mode."""

    temperature: float
    top_p: float
    top_k: int
    min_p: float
    presence_penalty: float
    repeat_penalty: float


@dataclass(frozen=True)
class RequestBehavior:
    """Request-time tuning resolved from an app profile."""

    engine_types: tuple[str, ...] = ()
    temperature: float | None = None
    top_k: int | None = None
    top_p: float | None = None
    min_p: float | None = None
    presence_penalty: float | None = None
    repeat_penalty: float | None = None
    reasoning_parser_start: str | None = None
    reasoning_parser_end: str | None = None
    prompt_addendum: str | None = None
    thinking_sampler: SamplerPreset | None = None
    instruct_sampler: SamplerPreset | None = None
    max_output_tokens: int | None = None
    thinking_token_headroom: int | None = None


@dataclass(frozen=True)
class VariantSpec:
    """One model variant within a family."""

    name: str
    aliases: tuple[str, ...]
    label: str
    param_billions: float
    active_param_billions: float
    native_context_length: int
    is_moe: bool = False
    family_supports_vision: bool = True
    family_supports_audio: bool = False
    overrides: ConfigOverrides | None = None
    behavior: RequestBehavior | None = None


@dataclass(frozen=True)
class AppProfile:
    """A model-family profile."""

    family: str
    label: str
    family_aliases: tuple[str, ...]
    variants: tuple[VariantSpec, ...]
    default_variant: str
    overrides: ConfigOverrides
    behavior: RequestBehavior = RequestBehavior()


# ---------------------------------------------------------------------------
# Model-name canonicalization
# ---------------------------------------------------------------------------

_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")


def canonicalize_model_name(model_name: str) -> str:
    """Normalize a model ID for matching.

    Handles HF repo IDs (``google/gemma-4-26B-A4B-it``),
    Ollama tags (``gemma4:26b-a4b-it-q4_K_M``), vLLM-style strings,
    and custom local names.
    """
    key = str(model_name).strip().lower()
    base = key.rsplit("/", 1)[-1]
    base = base.split(":", 1)[0]
    return _NON_ALNUM_RE.sub("-", base).strip("-")


def _canonicalize_model_variant_key(model_name: str) -> str:
    key = str(model_name or "").strip().lower().replace("/", "-")
    return _NON_ALNUM_RE.sub("-", key).strip("-")


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_REGISTRY: dict[str, AppProfile] = {}
_ALIAS_INDEX: dict[str, str] = {}  # normalized alias -> family


def register_profile(profile: AppProfile) -> None:
    """Register a profile.  Raises on duplicate family or alias collision."""
    if profile.family in _REGISTRY:
        msg = f"duplicate app profile family: {profile.family!r}"
        raise ValueError(msg)
    for alias in profile.family_aliases:
        norm = canonicalize_model_name(alias)
        if norm in _ALIAS_INDEX:
            msg = (
                f"app profile alias {alias!r} (normalized {norm!r}) "
                f"collides with family {_ALIAS_INDEX[norm]!r}"
            )
            raise ValueError(msg)
    # Commit only after all checks pass.
    for alias in profile.family_aliases:
        _ALIAS_INDEX[canonicalize_model_name(alias)] = profile.family
    _REGISTRY[profile.family] = profile


# ---------------------------------------------------------------------------
# Detection & matching helpers
# ---------------------------------------------------------------------------


def _detect_profile(model_name: str) -> AppProfile | None:
    canon = canonicalize_model_name(model_name)
    if not canon:
        return None
    for alias, family in _ALIAS_INDEX.items():
        if canon.startswith(alias):
            return _REGISTRY[family]
    return None


def _profile_matches_model(profile: AppProfile, model_name: str) -> bool:
    canon = canonicalize_model_name(model_name)
    if not canon:
        return False
    return any(canon.startswith(canonicalize_model_name(a)) for a in profile.family_aliases)


# ---------------------------------------------------------------------------
# Public resolution API
# ---------------------------------------------------------------------------


def resolve_profile(
    model_name: str,
    explicit: str | None = None,
) -> AppProfile | None:
    """Resolve an app profile for the given model string.

    * *explicit* wins when it matches the model.
    * Stale *explicit* values (model changed, profile didn't) fall back to
      auto-detect — they do **not** disable profiles.
    * Unknown *explicit* values degrade gracefully to auto-detect.
    """
    detected = _detect_profile(model_name)

    if not explicit:
        return detected

    explicit_profile = _REGISTRY.get(explicit)
    if explicit_profile is None:
        log_event(
            logger,
            logging.WARNING,
            component="ai.app_profiles",
            event="ai.app_profiles.unknown_explicit",
            message=f"Unknown explicit app_profile {explicit!r}, falling back to auto-detect",
            status="warning",
            data={"explicit": explicit, "model_name": model_name},
        )
        return detected

    if not model_name:
        return explicit_profile

    if _profile_matches_model(explicit_profile, model_name):
        return explicit_profile

    log_event(
        logger,
        logging.WARNING,
        component="ai.app_profiles",
        event="ai.app_profiles.stale_explicit",
        message=(f"Stale app_profile {explicit_profile.family!r} ignored for model {model_name!r}"),
        status="warning",
        data={
            "explicit": explicit_profile.family,
            "model_name": model_name,
            "detected": detected.family if detected else None,
        },
    )
    return detected


def resolve_variant(profile: AppProfile, model_name: str) -> VariantSpec:
    """Match a variant within *profile* from the model string.

    Falls back to ``profile.default_variant`` when no substring match.
    """
    canon = _canonicalize_model_variant_key(model_name)
    for variant in profile.variants:
        if variant.name in canon:
            return variant
        if any(alias in canon for alias in variant.aliases):
            return variant
    # Fallback
    for variant in profile.variants:
        if variant.name == profile.default_variant:
            return variant
    return profile.variants[0]


def apply_overrides(
    config: RuntimeConfig,
    profile: AppProfile,
    variant: VariantSpec,
) -> RuntimeConfig:
    """Apply profile + variant overrides to *config*.

    v1: all override fields are applied unconditionally (no pinning).
    """
    from dataclasses import replace

    merged: dict[str, object] = {}
    for f in fields(ConfigOverrides):
        profile_val = getattr(profile.overrides, f.name)
        if profile_val is not None:
            merged[f.name] = profile_val
    if variant.overrides is not None:
        for f in fields(ConfigOverrides):
            variant_val = getattr(variant.overrides, f.name)
            if variant_val is not None:
                merged[f.name] = variant_val
    if not merged:
        return config
    return replace(config, **merged)  # type: ignore[arg-type]


def apply_behavior(
    config: RuntimeConfig,
    profile: AppProfile,
    variant: VariantSpec,
) -> RuntimeConfig:
    """Apply resolved request-time behavior metadata to *config*."""
    from dataclasses import replace

    merged: dict[str, object] = {
        "resolved_app_profile_family": profile.family,
        "resolved_app_profile_variant": variant.name,
    }

    resolved_behavior: dict[str, object] = {}
    for field in fields(RequestBehavior):
        profile_value = getattr(profile.behavior, field.name)
        if field.name == "engine_types":
            if profile_value:
                resolved_behavior[field.name] = profile_value
            continue
        if profile_value is not None:
            resolved_behavior[field.name] = profile_value
    if variant.behavior is not None:
        for field in fields(RequestBehavior):
            variant_value = getattr(variant.behavior, field.name)
            if field.name == "engine_types":
                if variant_value:
                    resolved_behavior[field.name] = variant_value
                continue
            if variant_value is not None:
                resolved_behavior[field.name] = variant_value

    engine_scope = resolved_behavior.get("engine_types")
    if isinstance(engine_scope, tuple) and engine_scope:
        current_engine = str(getattr(config, "engine_type", "") or "").strip().lower()
        if current_engine not in engine_scope:
            # A silently discarded matched profile is invisible until downstream behavior degrades.
            log_event(
                logger,
                logging.INFO,
                component="ai.app_profiles",
                event="ai.app_profiles.engine_scope_skipped",
                message=(
                    f"App profile {profile.family!r} not applied: "
                    f"engine {current_engine!r} is out of scope"
                ),
                status="ok",
                data={
                    "family": profile.family,
                    "variant": variant.name,
                    "engine_type": current_engine,
                    "engine_types": list(engine_scope),
                },
            )
            return replace(config, **merged)  # type: ignore[arg-type]

    behavior_field_map = {
        "temperature": "resolved_app_profile_temperature",
        "top_k": "resolved_app_profile_top_k",
        "top_p": "resolved_app_profile_top_p",
        "min_p": "resolved_app_profile_min_p",
        "presence_penalty": "resolved_app_profile_presence_penalty",
        "repeat_penalty": "resolved_app_profile_repeat_penalty",
        "reasoning_parser_start": "resolved_app_profile_reasoning_parser_start",
        "reasoning_parser_end": "resolved_app_profile_reasoning_parser_end",
        "prompt_addendum": "resolved_app_profile_prompt_addendum",
        "thinking_sampler": "resolved_app_profile_thinking_sampler",
        "instruct_sampler": "resolved_app_profile_instruct_sampler",
        "max_output_tokens": "resolved_app_profile_max_output_tokens",
        "thinking_token_headroom": "resolved_app_profile_thinking_token_headroom",
    }
    for source_name, target_name in behavior_field_map.items():
        value = resolved_behavior.get(source_name)
        if value is not None:
            merged[target_name] = asdict(value) if isinstance(value, SamplerPreset) else value

    return replace(config, **merged)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Registry bootstrap — explicit imports, no side-effect magic
# ---------------------------------------------------------------------------

from sidecar.ai.app_profiles.gemma4 import GEMMA4_PROFILE  # noqa: E402
from sidecar.ai.app_profiles.ornith15 import ORNITH15_PROFILE  # noqa: E402
from sidecar.ai.app_profiles.qwen36 import QWEN36_PROFILE  # noqa: E402
from sidecar.ai.app_profiles.qwen38 import QWEN38_PROFILE  # noqa: E402

register_profile(GEMMA4_PROFILE)
register_profile(ORNITH15_PROFILE)
register_profile(QWEN36_PROFILE)
register_profile(QWEN38_PROFILE)
