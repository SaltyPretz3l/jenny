"""Provider capability helpers for initialize/models metadata."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sidecar.ai.config import RuntimeConfig, codex_cli_unavailable_reason

_ENGINE_ORDER = (
    "ollama",
    "vllm",
    "openai-compatible",
    "codex-cli",
    "chatgpt",
    "plugin_host",
    "replay",
    "mock",
)
_REASONING_EFFORT_SUPPORTED_ENGINES = frozenset(
    {"ollama", "vllm", "openai-compatible", "codex-cli", "chatgpt"}
)


@dataclass(frozen=True)
class ProviderCapability:
    engine: str
    available: bool
    requires_secret: bool
    secret_configured: bool
    reason: str | None
    reasoning_effort_support: str = "unsupported"

    def as_payload(self) -> dict[str, Any]:
        return {
            "engine": self.engine,
            "available": self.available,
            "requires_secret": self.requires_secret,
            "secret_configured": self.secret_configured,
            "reason": self.reason,
            "reasoning_effort_support": self.reasoning_effort_support,
        }


def build_provider_capabilities(config: RuntimeConfig) -> dict[str, ProviderCapability]:
    capabilities: dict[str, ProviderCapability] = {}
    capabilities["ollama"] = ProviderCapability(
        engine="ollama",
        available=True,
        requires_secret=False,
        secret_configured=False,
        reason=None,
        reasoning_effort_support=_reasoning_effort_support("ollama"),
    )
    capabilities["vllm"] = ProviderCapability(
        engine="vllm",
        available=True,
        requires_secret=False,
        secret_configured=False,
        reason=None,
        reasoning_effort_support=_reasoning_effort_support("vllm"),
    )
    capabilities["openai-compatible"] = ProviderCapability(
        engine="openai-compatible",
        available=True,
        requires_secret=False,
        secret_configured=False,
        reason=None,
        reasoning_effort_support=_reasoning_effort_support("openai-compatible"),
    )
    codex_cli_reason = codex_cli_unavailable_reason(config)
    capabilities["codex-cli"] = ProviderCapability(
        engine="codex-cli",
        available=codex_cli_reason is None,
        requires_secret=False,
        secret_configured=False,
        reason=codex_cli_reason,
        reasoning_effort_support=_reasoning_effort_support("codex-cli"),
    )
    chatgpt_access_token = str(getattr(config, "chatgpt_access_token", "") or "").strip()
    capabilities["chatgpt"] = ProviderCapability(
        engine="chatgpt",
        available=bool(chatgpt_access_token),
        requires_secret=True,
        secret_configured=bool(chatgpt_access_token),
        reason=(None if chatgpt_access_token else "chatgpt engine unavailable: not signed in"),
        reasoning_effort_support=_reasoning_effort_support("chatgpt"),
    )
    plugin_host_available = str(
        getattr(config, "engine_type", "") or ""
    ).strip().lower() == "plugin_host" and bool(str(getattr(config, "model", "") or "").strip())
    capabilities["plugin_host"] = ProviderCapability(
        engine="plugin_host",
        available=plugin_host_available,
        requires_secret=False,
        secret_configured=False,
        reason=None if plugin_host_available else "plugin host engine unavailable",
        reasoning_effort_support="unsupported",
    )
    capabilities["replay"] = ProviderCapability(
        engine="replay",
        available=True,
        requires_secret=False,
        secret_configured=False,
        reason=None,
        reasoning_effort_support=_reasoning_effort_support("replay"),
    )
    capabilities["mock"] = ProviderCapability(
        engine="mock",
        available=True,
        requires_secret=False,
        secret_configured=False,
        reason=None,
        reasoning_effort_support=_reasoning_effort_support("mock"),
    )

    return capabilities


def available_engine_types(capabilities: dict[str, ProviderCapability]) -> list[str]:
    ordered: list[str] = []
    for engine in _ENGINE_ORDER:
        capability = capabilities.get(engine)
        if capability is None or not capability.available:
            continue
        ordered.append(engine)

    if "mock" not in ordered:
        ordered.append("mock")
    return ordered


def provider_capabilities_payload(
    capabilities: dict[str, ProviderCapability],
) -> dict[str, dict[str, Any]]:
    return {engine: capability.as_payload() for engine, capability in capabilities.items()}


def is_engine_available(capabilities: dict[str, ProviderCapability], engine_type: str) -> bool:
    normalized = str(engine_type or "").strip().lower()
    capability = capabilities.get(normalized)
    if capability is None:
        return normalized == "mock"
    return capability.available


def entitled_chatgpt_models(
    catalog: Sequence[str],
    *,
    capability: ProviderCapability | None = None,
    entitlements: frozenset[str] | None = None,
) -> list[str]:
    """Filter the static ChatGPT catalog down to the account's entitled models.

    This is a documented no-op today: no authenticated model-discovery call ships,
    so every caller passes ``entitlements=None`` and receives the catalog unchanged.

    It deliberately does NOT key on ``capability.available`` or
    ``capability.secret_configured``: a signed-out account still gets the full
    catalog (pinned by test_chatgpt_models_list_signed_out_returns_full_catalog),
    and a configured secret is not entitlement data. ``capability`` is accepted and
    currently unused -- it is the seam a future authenticated capture would consult.
    Do not delete it as dead.

    Fails open in both directions: non-string entries are ignored, and an empty
    intersection returns the full catalog, so a malformed future entitlement payload
    can never empty the renderer's model picker.
    """

    ordered = [str(model) for model in catalog if isinstance(model, str) and model.strip()]
    if entitlements is None:
        return ordered
    allowed = {
        str(model).strip()
        for model in entitlements
        if isinstance(model, str) and str(model).strip()
    }
    filtered = [model for model in ordered if model in allowed]
    return filtered or ordered


def _reasoning_effort_support(engine: str) -> str:
    normalized = str(engine or "").strip().lower()
    return "supported" if normalized in _REASONING_EFFORT_SUPPORTED_ENGINES else "unsupported"
