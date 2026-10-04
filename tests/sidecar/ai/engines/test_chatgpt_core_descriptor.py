"""The ChatGPT engine uses the core provider descriptor (plugin retirement, stage 2).

Until 2026-10-02 the descriptor arrived in the signed official plugin's runtime
generation, and a ChatGPT start fell back to the mock engine until it did. The
descriptor is now a core constant, so a signed-in start builds the real engine
at once, and a broken descriptor still fails closed.
"""

from __future__ import annotations

import copy
import logging

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.engines.chatgpt_provider_descriptor import CORE_CHATGPT_PROVIDER_DESCRIPTOR
from sidecar.ai.engines.chatgpt_subscription import ChatGPTSubscriptionEngine
from sidecar.ai.engines.factory import create_engine
from sidecar.ai.engines.responses_descriptor import validate_responses_descriptor

_TOKEN = "subscription-access-token-secret"


def _config() -> RuntimeConfig:
    return RuntimeConfig(engine_type="chatgpt", model="", chatgpt_access_token=_TOKEN)


def test_the_core_descriptor_passes_the_engine_validator() -> None:
    validated = validate_responses_descriptor(CORE_CHATGPT_PROVIDER_DESCRIPTOR)
    assert validated["provider_id"] == "chatgpt"
    assert validated["endpoint"] == "https://chatgpt.com/backend-api/codex"


def test_a_signed_in_start_builds_the_real_engine_without_any_plugin() -> None:
    selected = create_engine(_config())
    try:
        assert selected.engine_type == "chatgpt"
        assert selected.fallback_from is None
        assert isinstance(selected.engine, ChatGPTSubscriptionEngine)
    finally:
        selected.engine.close()


def test_a_missing_token_still_falls_back_to_mock() -> None:
    selected = create_engine(RuntimeConfig(engine_type="chatgpt", model=""))
    assert selected.engine_type == "mock"
    assert selected.fallback_reason == "chatgpt engine unavailable: not signed in"


def test_a_present_but_invalid_descriptor_still_fails_closed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.INFO, logger="sidecar.ai.engines.factory"):
        selected = create_engine(_config(), provider_descriptor={})
    assert selected.engine_type == "mock"
    assert selected.fallback_from == "chatgpt"
    assert "failed to initialize" in str(selected.fallback_reason)


def test_the_engine_never_mutates_the_core_constant() -> None:
    before = copy.deepcopy(CORE_CHATGPT_PROVIDER_DESCRIPTOR)
    selected = create_engine(_config())
    selected.engine.close()
    assert CORE_CHATGPT_PROVIDER_DESCRIPTOR == before
