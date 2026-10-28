from __future__ import annotations

import copy
from typing import Any

import pytest

from sidecar.ai.engines.chatgpt_provider_descriptor import CORE_CHATGPT_PROVIDER_DESCRIPTOR
from sidecar.ai.engines.provider_descriptor_v6 import (
    ProviderDescriptorError,
    resolved_auth_headers,
    validate_model_limits,
    validate_provider_descriptor,
    validate_provider_endpoint,
)
from sidecar.ai.engines.responses_descriptor import validate_responses_descriptor


def _never_local(_host: str, _port: int | None) -> bool:
    return False


def _always_local(_host: str, _port: int | None) -> bool:
    return True


def descriptor(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "descriptor_schema_version": 6,
        "provider_id": "openrouter",
        "label": "OpenRouter",
        "endpoint": "https://openrouter.ai/api/v1",
        "transport": "openai_chat_completions_v1",
        "auth_profile": "api_key_bearer",
        "headers": [{"name": "X-Title", "value": "Jenny"}],
        "model_catalog": [
            {"id": "openai/gpt-5.5", "context_length": 400_000, "max_output_tokens": 128_000,
             "tools": True, "vision": True, "reasoning": True},
        ],
    }
    base.update(overrides)
    return base


def limits(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "context_length": 32_768, "max_output_tokens": 4_096, "tools": True,
        "vision": False, "reasoning": False,
        "sources": {"context_length": "fallback", "max_output_tokens": "fallback",
                    "tools": "fallback", "vision": "fallback", "reasoning": "fallback"},
    }
    base.update(overrides)
    return base


def test_preset_descriptor_is_admitted_and_normalized() -> None:
    admitted = validate_provider_descriptor(descriptor(), resolve_local=_never_local)
    assert admitted["endpoint"] == "https://openrouter.ai/api/v1"
    assert admitted["token_limit_field"] == "max_tokens"
    assert admitted["headers"] == [{"name": "X-Title", "value": "Jenny"}]
    assert admitted["model_catalog"][0]["context_length"] == 400_000


def test_validator_returns_a_copy_not_the_caller_object() -> None:
    raw = descriptor()
    admitted = validate_provider_descriptor(raw, resolve_local=_never_local)
    admitted["headers"].append({"name": "x", "value": "y"})
    assert raw["headers"] == [{"name": "X-Title", "value": "Jenny"}]


@pytest.mark.parametrize(
    "overrides",
    [
        {"descriptor_schema_version": 5},
        {"descriptor_schema_version": True},
        {"transport": "openai_completions_v0"},
        {"transport": "ollama_chat"},
        {"auth_profile": "chatgpt_subscription_oauth"},
        {"auth_profile": "key_cmd"},
        {"provider_id": "anthropic"},
        {"provider_id": "openai"},
        {"provider_id": "gemini"},
        {"provider_id": "chatgpt"},
        {"provider_id": "api-provider"},
        {"provider_id": "Bad_Id"},
        {"provider_id": "x"},
        {"label": ""},
        {"label": "x" * 65},
        {"token_limit_field": "max_output"},
        {"stream_map": []},
        {"error_map": []},
        {"request_template": "openai_responses_v1"},
    ],
)
def test_closed_vocabulary_rejects(overrides: dict[str, Any]) -> None:
    with pytest.raises(ProviderDescriptorError):
        validate_provider_descriptor(descriptor(**overrides), resolve_local=_never_local)


@pytest.mark.parametrize(
    "headers",
    [
        [{"name": "Authorization", "value": "Bearer x"}],
        [{"name": "Cookie", "value": "a=b"}],
        [{"name": "Connection", "value": "close"}],
        [{"name": "x-api-key", "value": "sk-zzz"}],
        [{"name": "X-Title", "value": "{secret:api_key}"}],
        [{"name": "X-Title", "value": "Bearer {secret:access_token}"}],
        [{"name": "X-Title", "value": "a\r\nInjected: 1"}],
        [{"name": "X-Title", "value": "x" * 257}],
        [{"name": "X-Title", "value": "a"}, {"name": "x-title", "value": "b"}],
        [{"name": "X-Title", "value": "a", "extra": 1}],
        "X-Title: a",
    ],
)
def test_forbidden_or_malformed_headers_are_rejected(headers: Any) -> None:
    with pytest.raises(ProviderDescriptorError):
        validate_provider_descriptor(descriptor(headers=headers), resolve_local=_never_local)


def test_allowlisted_header_names_are_canonicalized() -> None:
    admitted = validate_provider_descriptor(
        descriptor(headers=[{"name": "http-referer", "value": "https://jenny.local"}]),
        resolve_local=_never_local,
    )
    assert admitted["headers"] == [{"name": "HTTP-Referer", "value": "https://jenny.local"}]


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://api.example.com/v1",
        "ftp://api.example.com/v1",
        "https://user:pass@api.example.com/v1",
        "https://sk-abc@api.example.com/v1",
        "https://api.example.com/v1?key=sk-abc",
        "https://api.example.com/v1#frag",
        "https:///v1",
        " https://api.example.com/v1",
        "https://api.example.com/v1\n",
        "https://" + "a" * 2050 + ".com",
        "",
        None,
    ],
)
def test_endpoint_policy_rejects(endpoint: Any) -> None:
    with pytest.raises(ProviderDescriptorError):
        validate_provider_endpoint(endpoint, resolve_local=_never_local)


def test_plain_http_is_allowed_only_for_a_local_host() -> None:
    assert validate_provider_endpoint(
        "http://192.168.1.20:8000/v1/", resolve_local=_always_local
    ) == "http://192.168.1.20:8000/v1"
    with pytest.raises(ProviderDescriptorError):
        validate_provider_endpoint("http://192.168.1.20:8000/v1", resolve_local=_never_local)


def test_default_resolver_treats_loopback_literals_as_local() -> None:
    assert validate_provider_endpoint("http://127.0.0.1:9000/v1") == "http://127.0.0.1:9000/v1"
    assert validate_provider_endpoint("http://localhost:9000/v1") == "http://localhost:9000/v1"


def test_default_resolver_refuses_http_to_a_public_literal() -> None:
    with pytest.raises(ProviderDescriptorError):
        validate_provider_endpoint("http://8.8.8.8/v1")


def test_error_messages_never_echo_values() -> None:
    secret = "sk-test-SECRETKEYVALUE123456"
    with pytest.raises(ProviderDescriptorError) as excinfo:
        validate_provider_endpoint(f"https://api.example.com/v1?key={secret}")
    assert secret not in str(excinfo.value)
    with pytest.raises(ProviderDescriptorError) as excinfo:
        validate_provider_descriptor(descriptor(provider_id=secret), resolve_local=_never_local)
    assert secret not in str(excinfo.value)


@pytest.mark.parametrize(
    "catalog",
    [
        [{"id": "a"}, {"id": "a"}],
        [{"id": ""}],
        [{"id": "x" * 201}],
        [{"id": "a", "context_length": 0}],
        [{"id": "a", "context_length": True}],
        [{"id": "a", "tools": "yes"}],
        [{"id": "a", "price": 1}],
        [{"id": f"m{i}"} for i in range(257)],
        {"id": "a"},
    ],
)
def test_model_catalog_rows_are_bounded(catalog: Any) -> None:
    with pytest.raises(ProviderDescriptorError):
        validate_provider_descriptor(descriptor(model_catalog=catalog), resolve_local=_never_local)


def test_auth_headers_follow_the_profile_only() -> None:
    admitted = validate_provider_descriptor(descriptor(), resolve_local=_never_local)
    assert resolved_auth_headers(admitted, "sk-test-123")["Authorization"] == "Bearer sk-test-123"
    header = validate_provider_descriptor(
        descriptor(auth_profile="api_key_header"), resolve_local=_never_local
    )
    assert resolved_auth_headers(header, "k-1") == {"X-Title": "Jenny", "x-api-key": "k-1"}
    open_profile = validate_provider_descriptor(
        descriptor(auth_profile="none"), resolve_local=_never_local
    )
    assert resolved_auth_headers(open_profile, "sk-unused") == {"X-Title": "Jenny"}


@pytest.mark.parametrize("key", ["", "   ", None, "sk-\r\nX: y"])
def test_a_key_profile_refuses_a_missing_or_control_character_key(key: Any) -> None:
    admitted = validate_provider_descriptor(descriptor(), resolve_local=_never_local)
    with pytest.raises(ProviderDescriptorError):
        resolved_auth_headers(admitted, key)


def test_model_limits_are_admitted_with_sources() -> None:
    assert validate_model_limits(limits())["sources"]["context_length"] == "fallback"


@pytest.mark.parametrize(
    "raw",
    [
        limits(context_length=0),
        limits(max_output_tokens=40_000),
        limits(tools="true"),
        limits(sources={"context_length": "guess"}),
        limits(extra=1),
        {k: v for k, v in limits().items() if k != "vision"},
        None,
    ],
)
def test_model_limits_reject(raw: Any) -> None:
    with pytest.raises(ProviderDescriptorError):
        validate_model_limits(raw)


def test_chatgpt_descriptor_admission_is_unchanged() -> None:
    pinned = copy.deepcopy(CORE_CHATGPT_PROVIDER_DESCRIPTOR)
    assert validate_responses_descriptor(pinned)["provider_id"] == "chatgpt"
    with pytest.raises(ProviderDescriptorError):
        validate_provider_descriptor(pinned, resolve_local=_never_local)
