"""Transport dispatch for user API-key providers (row 78).

The descriptor's ``transport`` picks the engine class; an unknown transport has
none, so the factory falls back instead of guessing a wire shape. Imports are
lazy so a chat-completions selection never loads the Responses or Messages code.
"""

from __future__ import annotations

from typing import Any


def api_provider_engine_class(descriptor: dict[str, Any] | None) -> Any | None:
    """The engine class for the descriptor's transport; None for an unknown one."""
    transport = descriptor.get("transport") if isinstance(descriptor, dict) else None
    if transport == "openai_chat_completions_v1":
        from sidecar.ai.engines.api_provider_chat import ApiProviderChatEngine

        return ApiProviderChatEngine
    if transport == "openai_responses_v1":
        from sidecar.ai.engines.api_provider_responses import ApiProviderResponsesEngine

        return ApiProviderResponsesEngine
    if transport == "anthropic_messages_v1":
        from sidecar.ai.engines.api_provider_anthropic import ApiProviderAnthropicEngine

        return ApiProviderAnthropicEngine
    return None
