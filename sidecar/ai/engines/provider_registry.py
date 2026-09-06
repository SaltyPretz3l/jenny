"""Lazy provider engine exports for factory wiring."""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from sidecar.ai.engines.codex_cli import CodexCliEngine
    from sidecar.ai.engines.ollama import OllamaEngine
    from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
    from sidecar.ai.engines.replay import ReplayEngine
    from sidecar.ai.engines.responses_descriptor import ResponsesDescriptorEngine
    from sidecar.ai.engines.vllm_engine import VLLMEngine

_ENGINE_IMPORTS = {
    "ResponsesDescriptorEngine": (
        "sidecar.ai.engines.responses_descriptor",
        "ResponsesDescriptorEngine",
    ),
    "CodexCliEngine": ("sidecar.ai.engines.codex_cli", "CodexCliEngine"),
    "OllamaEngine": ("sidecar.ai.engines.ollama", "OllamaEngine"),
    "OpenAICompatibleEngine": (
        "sidecar.ai.engines.openai_compatible",
        "OpenAICompatibleEngine",
    ),
    "ReplayEngine": ("sidecar.ai.engines.replay", "ReplayEngine"),
    "VLLMEngine": ("sidecar.ai.engines.vllm_engine", "VLLMEngine"),
}


def __getattr__(name: str) -> Any:
    target = _ENGINE_IMPORTS.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module_name, class_name = target
    engine_class = getattr(importlib.import_module(module_name), class_name)
    globals()[name] = engine_class
    return engine_class

__all__ = [
    "ResponsesDescriptorEngine",
    "CodexCliEngine",
    "OllamaEngine",
    "OpenAICompatibleEngine",
    "ReplayEngine",
    "VLLMEngine",
]
