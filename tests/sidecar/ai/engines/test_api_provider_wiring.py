"""Wiring for the ``api-provider`` engine type (row 78 S1): factory, config, secrets,
capabilities, models.list, prompt profile and loop profile.

Nothing here touches the network: construction and ``load_model`` are I/O free, and
``httpx.Client.send`` / DNS are made to fail loudly in the tests that prove it.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from sidecar.ai.config import RuntimeConfig, parse_runtime_config
from sidecar.ai.config_models import (
    SYSTEM_PROMPT_PROFILE_COMPANION,
    SYSTEM_PROMPT_PROFILE_MINIMAL,
    resolve_system_prompt_profile,
)
from sidecar.ai.engines import provider_descriptor_v6
from sidecar.ai.engines.api_provider_anthropic import ApiProviderAnthropicEngine
from sidecar.ai.engines.api_provider_chat import ApiProviderChatEngine
from sidecar.ai.engines.api_provider_responses import ApiProviderResponsesEngine
from sidecar.ai.engines.factory import create_engine
from sidecar.ai.routing.iteration_limits import loop_profile_name, max_iterations_for_mode
from sidecar.ai.routing.subagent_model_routing import _CLOUD_PROVIDERS
from sidecar.ai.routing.tool_loop_run import _CLOUD_PROVIDER_ENGINE_TYPES
from sidecar.ai.tools.builtins.connections import _build_connections_output
from sidecar.runtime import exact_secret_redaction as redaction
from sidecar.runtime.capabilities import (
    _runtime_initialize_config,
    initialize_secrets,
    models_list_result,
)
from sidecar.runtime.provider_capabilities import (
    available_engine_types,
    build_provider_capabilities,
    provider_capabilities_payload,
)
from sidecar.runtime.worker_secrets import (
    BROKERED_SECRET_KEYS,
    SECRET_CONFIG_KEYS,
    merge_config_secrets,
    split_config_secrets,
)

KEY = "sk-test-0123456789abcdefXYZ"
MODEL = "api-provider/openrouter/openai/gpt-6-luna"
ENDPOINT = "https://openrouter.ai/api/v1"


def _descriptor(**overrides: Any) -> dict[str, Any]:
    descriptor: dict[str, Any] = {
        "descriptor_schema_version": 6,
        "provider_id": "openrouter",
        "label": "OpenRouter",
        "endpoint": ENDPOINT,
        "transport": "openai_chat_completions_v1",
        "auth_profile": "api_key_bearer",
        "token_limit_field": "max_tokens",
    }
    descriptor.update(overrides)
    return descriptor


def _limits() -> dict[str, Any]:
    return {
        "context_length": 128_000,
        "max_output_tokens": 8_192,
        "tools": True,
        "vision": False,
        "reasoning": True,
        "sources": {
            key: "preset"
            for key in ("context_length", "max_output_tokens", "tools", "vision", "reasoning")
        },
    }


def _raw_config(**overrides: Any) -> dict[str, Any]:
    raw: dict[str, Any] = {
        "engine_type": "api-provider",
        "model": MODEL,
        "api_provider_descriptor": _descriptor(),
        "api_provider_model_limits": _limits(),
        "api_provider_key": KEY,
    }
    raw.update(overrides)
    return raw


def _config(**overrides: Any) -> RuntimeConfig:
    return parse_runtime_config(_raw_config(**overrides))


def _leaks(*values: Any) -> bool:
    return any(KEY in str(value) for value in values)


@pytest.fixture(autouse=True)
def _clean_registry() -> Iterator[None]:
    redaction.clear_exact_secrets_for_tests()
    yield
    redaction.clear_exact_secrets_for_tests()


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fail(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("network used")

    monkeypatch.setattr(httpx.Client, "send", _fail)
    monkeypatch.setattr(provider_descriptor_v6.socket, "getaddrinfo", _fail)


# -- config parsing ---------------------------------------------------------


def test_parse_runtime_config_carries_the_three_provider_keys() -> None:
    config = _config()

    assert config.engine_type == "api-provider"
    assert config.model == MODEL
    assert config.api_provider_descriptor == _descriptor()
    assert config.api_provider_model_limits == _limits()
    assert config.api_provider_key == KEY


def test_parse_runtime_config_normalizes_malformed_provider_keys() -> None:
    config = parse_runtime_config(
        _raw_config(
            api_provider_descriptor="not a dict",
            api_provider_model_limits=[1],
            api_provider_key="   ",
        )
    )

    assert config.api_provider_descriptor is None
    assert config.api_provider_model_limits is None
    assert config.api_provider_key is None
    assert parse_runtime_config(_raw_config(api_provider_key="  k  ")).api_provider_key == "k"


def test_blank_model_resets_like_chatgpt() -> None:
    assert _config(model="  ").model == ""
    assert parse_runtime_config({"engine_type": "api-provider"}).model == ""


def test_config_repr_never_contains_the_key() -> None:
    assert not _leaks(repr(_config()))


# -- factory ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("transport", "auth_profile", "engine_class"),
    [
        ("openai_responses_v1", "api_key_bearer", ApiProviderResponsesEngine),
        ("anthropic_messages_v1", "api_key_header", ApiProviderAnthropicEngine),
    ],
)
def test_create_engine_dispatches_on_the_descriptor_transport(
    no_network, transport: str, auth_profile: str, engine_class: type
) -> None:
    descriptor = _descriptor(transport=transport, auth_profile=auth_profile)
    selection = create_engine(_config(api_provider_descriptor=descriptor))

    try:
        assert isinstance(selection.engine, engine_class)
        assert selection.engine_type == "api-provider"
        assert selection.engine.model_name == MODEL
        assert selection.fallback_from is None
        assert not _leaks(repr(selection.engine))
    finally:
        selection.engine.close()


def test_create_engine_builds_the_provider_engine_without_network(no_network) -> None:
    selection = create_engine(_config())

    try:
        assert isinstance(selection.engine, ApiProviderChatEngine)
        assert selection.engine_type == "api-provider"
        assert selection.model == MODEL
        assert selection.engine.model_name == MODEL
        assert selection.fallback_from is None
        assert selection.fallback_reason is None
    finally:
        selection.engine.close()


@pytest.mark.parametrize(
    "overrides",
    [
        {"api_provider_descriptor": None},
        {"api_provider_model_limits": None},
        {"api_provider_key": None},
        {"api_provider_descriptor": _descriptor(provider_id="openai")},
        {"api_provider_descriptor": _descriptor(provider_id="anthropic")},
        {"api_provider_descriptor": _descriptor(endpoint="http://api.example.com/v1")},
        # Each transport admits only its own auth profile.
        {"api_provider_descriptor": _descriptor(transport="anthropic_messages_v1")},
        {
            "api_provider_descriptor": _descriptor(
                transport="openai_responses_v1", auth_profile="api_key_header"
            )
        },
        {"api_provider_descriptor": _descriptor(transport="carrier_pigeon_v1")},
        {"api_provider_descriptor": _descriptor(endpoint=f"https://u:{KEY}@openrouter.ai/v1")},
        {"api_provider_model_limits": {"context_length": 10}},
        {"model": "openrouter/openai/gpt-6-luna"},
        {"model": "api-provider/other/openai/gpt-6-luna"},
        {"model": ""},
    ],
)
def test_unusable_configuration_falls_back_to_mock_without_leaking(
    overrides: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    # A public ``http`` endpoint is judged by DNS; make the lookup fail (non-local).
    def _no_dns(*_args: Any, **_kwargs: Any) -> Any:
        raise OSError("no dns in tests")

    monkeypatch.setattr(provider_descriptor_v6.socket, "getaddrinfo", _no_dns)

    selection = create_engine(_config(**overrides))

    assert selection.engine_type == "mock"
    assert selection.fallback_from == "api-provider"
    assert selection.fallback_reason
    assert not _leaks(selection.fallback_reason, selection.model)
    assert "openrouter.ai" not in selection.fallback_reason
    assert "api.example.com" not in selection.fallback_reason


def test_fallback_after_mock_boot_uses_the_local_loop_profile() -> None:
    selection = create_engine(_config(api_provider_descriptor=None))
    fell_back = parse_runtime_config({"engine_type": selection.engine_type})

    assert loop_profile_name(fell_back) == "local"
    assert max_iterations_for_mode(fell_back, mode="task") == 30


def test_the_key_is_registered_for_exact_redaction_after_a_build() -> None:
    selection = create_engine(_config())
    try:
        assert redaction.registered_exact_secret_count() == 1
        assert KEY not in redaction.redact_exact_secrets(f"provider said {KEY} twice")
    finally:
        selection.engine.close()


def test_the_key_is_registered_even_when_the_build_fails() -> None:
    selection = create_engine(_config(api_provider_descriptor=_descriptor(provider_id="openai")))

    assert selection.engine_type == "mock"
    assert KEY not in redaction.redact_exact_secrets(f"detail {KEY}")


def test_an_unconfigured_provider_registers_nothing() -> None:
    create_engine(_config(api_provider_descriptor=None))

    assert redaction.registered_exact_secret_count() == 0


def test_archived_engine_types_remain_unknown_to_the_factory() -> None:
    for engine_type in ("anthropic", "openai", "gemini"):
        selection = create_engine(RuntimeConfig(engine_type=engine_type, model="ignored"))

        assert selection.engine_type == "mock"
        assert selection.fallback_from == engine_type
        assert selection.fallback_reason == f"Unknown engine type '{engine_type}'"


# -- secrets ----------------------------------------------------------------


def test_api_provider_key_is_a_brokered_secret() -> None:
    assert "api_provider_key" in SECRET_CONFIG_KEYS
    assert "api_provider_key" in BROKERED_SECRET_KEYS


def test_split_and_merge_round_trip_the_key() -> None:
    raw = _raw_config()

    scrubbed, secrets = split_config_secrets(raw)

    assert "api_provider_key" not in scrubbed
    assert secrets == {"api_provider_key": KEY}
    assert scrubbed["api_provider_descriptor"] == _descriptor()
    assert merge_config_secrets(scrubbed, secrets) == raw
    assert "api_provider_key" not in merge_config_secrets(scrubbed, None)


def test_initialize_secrets_forwards_and_stringifies_the_key() -> None:
    assert initialize_secrets({"secrets": {"api_provider_key": KEY, "stray": "x"}}) == {
        "api_provider_key": KEY
    }
    assert initialize_secrets({"secrets": {"api_provider_key": 12345}}) == {
        "api_provider_key": "12345"
    }
    assert initialize_secrets({"secrets": {}}) == {}


def test_runtime_initialize_config_strips_the_inline_key() -> None:
    merged = _runtime_initialize_config({"config": _raw_config()})

    assert "api_provider_key" not in merged
    assert merged["api_provider_descriptor"] == _descriptor()
    assert not _leaks(merged)


# -- provider capabilities --------------------------------------------------


def test_capability_for_a_configured_provider() -> None:
    capability = build_provider_capabilities(_config())["api-provider"]

    assert capability.available is True
    assert capability.requires_secret is True
    assert capability.secret_configured is True
    assert capability.reason is None
    assert capability.reasoning_effort_support != "unsupported"
    assert "api-provider" in available_engine_types(build_provider_capabilities(_config()))
    assert not _leaks(provider_capabilities_payload(build_provider_capabilities(_config())))


def test_capability_when_the_key_is_missing() -> None:
    capability = build_provider_capabilities(_config(api_provider_key=None))["api-provider"]

    assert capability.available is False
    assert capability.requires_secret is True
    assert capability.secret_configured is False
    assert capability.reason == "api provider key missing"
    assert "api-provider" not in available_engine_types(
        build_provider_capabilities(_config(api_provider_key=None))
    )


def test_capability_with_auth_none_needs_no_key() -> None:
    config = _config(
        api_provider_descriptor=_descriptor(auth_profile="none"), api_provider_key=None
    )

    capability = build_provider_capabilities(config)["api-provider"]

    assert capability.available is True
    assert capability.requires_secret is False
    assert capability.secret_configured is False


@pytest.mark.parametrize(
    "overrides",
    [
        {"api_provider_descriptor": None},
        {"api_provider_model_limits": None},
    ],
)
def test_capability_when_not_configured(overrides: dict[str, Any]) -> None:
    capability = build_provider_capabilities(_config(**overrides))["api-provider"]

    assert capability.available is False
    assert capability.reason == "api provider not configured"


def test_capability_of_a_default_config_is_unavailable() -> None:
    capability = build_provider_capabilities(RuntimeConfig())["api-provider"]

    assert capability.available is False
    assert capability.requires_secret is False
    assert capability.reason == "api provider not configured"


# -- models.list ------------------------------------------------------------


def test_models_list_answers_the_single_configured_model() -> None:
    result = models_list_result(
        {"engine_type": "api-provider", "_runtime_config": _config()},
        models_for_engine=lambda _engine: ["unused"],
    )

    assert result["engine_type"] == "api-provider"
    assert result["available"] is True
    assert result["stale"] is False
    assert result["models"] == [{"id": MODEL, "context_length": 128_000}]
    assert not _leaks(result)


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"api_provider_key": None}, "api provider key missing"),
        ({"api_provider_descriptor": None}, "api provider not configured"),
        ({"model": ""}, ""),
    ],
)
def test_models_list_is_empty_when_the_provider_is_unusable(
    overrides: dict[str, Any], reason: str
) -> None:
    result = models_list_result(
        {"engine_type": "api-provider", "_runtime_config": _config(**overrides)},
        models_for_engine=lambda _engine: ["unused"],
    )

    assert result["models"] == []
    assert str(result["reason"]) == reason
    assert result["available"] is bool(not reason)


def test_models_list_without_a_runtime_config_is_empty() -> None:
    result = models_list_result(
        {"engine_type": "api-provider"}, models_for_engine=lambda _engine: ["unused"]
    )

    assert result["models"] == []
    assert result["available"] is False


@pytest.mark.parametrize("engine_type", ["anthropic", "openai", "gemini"])
def test_models_list_still_calls_archived_types_archived(engine_type: str) -> None:
    result = models_list_result(
        {"engine_type": engine_type, "_runtime_config": _config()},
        models_for_engine=lambda _engine: ["unused"],
    )

    assert result["available"] is False
    assert result["models"] == []
    assert "archived" in str(result["reason"])


# -- prompt profile and loop profile ---------------------------------------


def test_api_provider_always_uses_the_minimal_prompt_profile() -> None:
    for requested in ("companion", "auto", "minimal", ""):
        assert resolve_system_prompt_profile("api-provider", requested) == (
            SYSTEM_PROMPT_PROFILE_MINIMAL
        )
    assert resolve_system_prompt_profile("API-Provider", "companion") == (
        SYSTEM_PROMPT_PROFILE_MINIMAL
    )
    assert resolve_system_prompt_profile("ollama", "companion") == SYSTEM_PROMPT_PROFILE_COMPANION


def test_api_provider_runs_the_cloud_loop_profile() -> None:
    config = _config()

    assert loop_profile_name(config) == "cloud"
    assert max_iterations_for_mode(config, mode="chat") == 40
    assert max_iterations_for_mode(config, mode="task") == 300
    assert "api-provider" in _CLOUD_PROVIDER_ENGINE_TYPES


def test_api_provider_is_not_a_subagent_cloud_route() -> None:
    assert "api-provider" not in _CLOUD_PROVIDERS


# -- connections tool -------------------------------------------------------


def test_connections_reports_the_provider_host_and_never_the_key() -> None:
    output = _build_connections_output(_config())

    assert "api-provider" in output
    assert "remote (openrouter.ai)" in output
    assert not _leaks(output)


def test_connections_reports_a_custom_endpoint_port() -> None:
    config = _config(api_provider_descriptor=_descriptor(endpoint="https://llm.corp.example:8443/v1"))

    assert "remote (llm.corp.example:8443)" in _build_connections_output(config)


def test_connections_without_a_descriptor_has_no_host() -> None:
    output = _build_connections_output(_config(api_provider_descriptor=None))

    assert "remote (host unavailable)" in output
