"""Apply validated host model metadata at the runtime capability boundary."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from sidecar.ai.engines.chatgpt_model_catalog import normalize_chatgpt_model_catalog
from sidecar.ai.engines.chatgpt_subscription import (
    CHATGPT_MODEL_CONTEXT_LENGTHS,
    CHATGPT_MODEL_REASONING_PROFILES,
)
from sidecar.runtime.provider_capabilities import ProviderCapability, entitled_chatgpt_models


def model_list_config(params: dict[str, Any], runtime_config: Any, engine: Any) -> Any:
    """Apply host metadata to the current engine and a request-local config copy."""
    if params.get("engine_type") != "chatgpt" or "chatgpt_model_catalog" not in params:
        return runtime_config
    catalog = normalize_chatgpt_model_catalog(params["chatgpt_model_catalog"])
    set_catalog = getattr(engine, "set_model_catalog", None)
    if getattr(engine, "_ENGINE_TYPE", None) == "chatgpt" and callable(set_catalog):
        set_catalog(catalog)
    return replace(runtime_config, chatgpt_model_catalog=catalog)


def chatgpt_model_entries(
    runtime_config: Any, capability: ProviderCapability | None
) -> list[dict[str, Any]]:
    catalog = normalize_chatgpt_model_catalog(getattr(runtime_config, "chatgpt_model_catalog", ()))
    if catalog:
        return [
            {"id": row["id"], "label": row["label"], "capabilities": {
                "vision": row["vision"], "reasoning_effort": True,
                "reasoning_efforts": row["reasoning_efforts"],
                "default_reasoning_effort": row["default_reasoning_effort"],
            }} for row in catalog
        ]
    models = entitled_chatgpt_models(list(CHATGPT_MODEL_CONTEXT_LENGTHS), capability=capability)
    return [{"id": model, "capabilities": {"vision": True, "reasoning_effort": True,
             **CHATGPT_MODEL_REASONING_PROFILES.get(model, {})}} for model in models]


