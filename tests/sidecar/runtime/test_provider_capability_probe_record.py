"""Shared engine probe writers for the provider capability-profile store.

The Ollama and vLLM engines used to carry byte-identical copies of these
writers that swallowed a store failure silently; both now delegate here.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.vllm_engine import VLLMEngine
from sidecar.runtime import provider_capability_profile as profile_module
from sidecar.runtime.provider_capability_profile import (
    PROBE_STATUS_FAILED,
    PROBE_STATUS_READY,
    ProviderCapabilityProfileStore,
    derive_endpoint_id,
    derive_profile_id,
    record_capability_probe_failure,
    record_capability_probe_success,
)


class _ExplodingStore:
    def record_probe_result(self, **_kwargs: Any) -> None:
        raise RuntimeError("store exploded")

    def mark_failed(self, **_kwargs: Any) -> None:
        raise RuntimeError("store exploded")


def _profile(store: ProviderCapabilityProfileStore, engine_type: str, url: str, model: str) -> Any:
    return store.get_profile(derive_profile_id(derive_endpoint_id(engine_type, url), model))


def test_success_writes_a_ready_profile_with_engine_features() -> None:
    store = ProviderCapabilityProfileStore()
    record_capability_probe_success(
        store,
        engine_type="ollama",
        base_url="http://localhost:11434",
        model_id="qwen3:8b",
        native_tools_supported=True,
        thinking_supported=True,
        context_length=32768,
    )
    profile = _profile(store, "ollama", "http://localhost:11434", "qwen3:8b")
    assert profile is not None
    assert profile.probe_status == PROBE_STATUS_READY
    assert profile.features.native_tools_supported is True
    assert profile.features.thinking_or_reasoning_supported is True
    assert profile.observed.max_context_advertised == 32768


def test_failure_marks_the_profile_failed_with_a_bounded_reason() -> None:
    store = ProviderCapabilityProfileStore()
    record_capability_probe_failure(
        store,
        engine_type="vllm",
        base_url="http://localhost:8000",
        model_id="",
        error=ValueError("x" * 500),
    )
    profile = _profile(store, "vllm", "http://localhost:8000", "unknown")
    assert profile is not None
    assert profile.probe_status == PROBE_STATUS_FAILED
    assert profile.diagnostics.reason.startswith("ValueError: ")
    assert len(profile.diagnostics.reason) <= len("ValueError: ") + 120


def test_missing_store_is_a_noop() -> None:
    record_capability_probe_success(
        None,
        engine_type="ollama",
        base_url=None,
        model_id="m",
        native_tools_supported=False,
        thinking_supported=False,
        context_length=None,
    )
    record_capability_probe_failure(
        None, engine_type="ollama", base_url=None, model_id="m", error=RuntimeError()
    )


@pytest.mark.parametrize(
    "engine_factory",
    [
        pytest.param(lambda: OllamaEngine(host="http://localhost:11434"), id="ollama"),
        pytest.param(VLLMEngine, id="vllm"),
    ],
)
def test_engine_probe_store_failures_are_logged_not_raised(
    engine_factory: Any,
    caplog: pytest.LogCaptureFixture,
) -> None:
    engine = engine_factory()
    engine._provider_capability_profile_store = _ExplodingStore()
    with caplog.at_level(logging.WARNING, logger=profile_module.logger.name):
        engine._record_capability_probe_success("model-a")
        engine._record_capability_probe_failure("model-a", RuntimeError("load"))

    messages = [r.getMessage() for r in caplog.records if r.name == profile_module.logger.name]
    assert len(messages) == 2
    assert "probe=ready" in messages[0]
    assert "probe=failed" in messages[1]
