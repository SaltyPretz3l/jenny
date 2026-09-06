from __future__ import annotations

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.engines.chatgpt_subscription import (
    CHATGPT_MODEL_CONTEXT_LENGTHS,
    CHATGPT_MODEL_REASONING_PROFILES,
)
from sidecar.runtime.capabilities import models_list_result
from sidecar.runtime.provider_capabilities import (
    available_engine_types,
    build_provider_capabilities,
)

_SIGNED_OUT_REASON = "chatgpt engine unavailable: not signed in"


def _catalog_entries() -> list[dict[str, object]]:
    return [
        {
            "id": model,
            "capabilities": {
                "reasoning_effort": True,
                "vision": True,
                **CHATGPT_MODEL_REASONING_PROFILES[model],
            },
        }
        for model in CHATGPT_MODEL_CONTEXT_LENGTHS
    ]


def test_chatgpt_capability_signed_out() -> None:
    capabilities = build_provider_capabilities(RuntimeConfig())

    capability = capabilities["chatgpt"]
    assert capability.available is False
    assert capability.requires_secret is True
    assert capability.secret_configured is False
    assert capability.reason == _SIGNED_OUT_REASON
    assert capability.reasoning_effort_support == "supported"
    assert "chatgpt" not in available_engine_types(capabilities)


def test_chatgpt_capability_signed_in_and_engine_ordering() -> None:
    config = RuntimeConfig(
        codex_cli_enabled=True,
        codex_cli_command="codex",
        codex_cli_runtime_root="G:/fake-codex-runtime",
        codex_cli_auth_ready=True,
        chatgpt_access_token="fake-chatgpt-access-token",
    )
    capabilities = build_provider_capabilities(config)

    capability = capabilities["chatgpt"]
    assert capability.available is True
    assert capability.requires_secret is True
    assert capability.secret_configured is True
    assert capability.reason is None
    assert capability.reasoning_effort_support == "supported"

    engines = available_engine_types(capabilities)
    assert engines.index("codex-cli") < engines.index("chatgpt")
    assert engines.index("chatgpt") < engines.index("replay")
    assert engines.index("chatgpt") < engines.index("mock")


def test_chatgpt_models_list_signed_out_returns_full_catalog() -> None:
    result = models_list_result(
        {"engine_type": "chatgpt", "_runtime_config": RuntimeConfig()},
        models_for_engine=lambda _engine: [],
    )

    assert result == {
        "engine_type": "chatgpt",
        "models": _catalog_entries(),
        "stale": False,
        "available": False,
        "reason": _SIGNED_OUT_REASON,
    }


def test_chatgpt_models_list_signed_in_returns_full_catalog() -> None:
    config = RuntimeConfig(chatgpt_access_token="fake-chatgpt-access-token")

    result = models_list_result(
        {"engine_type": "chatgpt", "_runtime_config": config},
        models_for_engine=lambda _engine: [],
    )

    assert result == {
        "engine_type": "chatgpt",
        "models": _catalog_entries(),
        "stale": False,
        "available": True,
        "reason": "",
    }
