import asyncio
import logging
from types import SimpleNamespace

import pytest

from sidecar.ai.engines import ollama_generation
from sidecar.ai.engines.admitted import (
    InferenceAdmissionRefused,
    InferenceAttemptContext,
    execute_admitted_provider_attempt,
)
from sidecar.ai.engines.base import BaseEngine
from sidecar.ai.engines.chatgpt_subscription import ChatGPTSubscriptionEngine
from sidecar.ai.engines.inference_budget import inference_budget_ceilings
from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.engines.vllm_engine import VLLMEngine
from tests.sidecar.ai.engines.test_ollama_wrapper import (
    _build_engine,
    _connection_error_with_status,
)

REQUIRED = SimpleNamespace(requires_budget=True)


def _settlement_failure_admission(_context):
    def settle(_outcome):
        raise InferenceAdmissionRefused("inference_authority_timeout")

    return SimpleNamespace(settle=settle)


def _provider_error():
    return ProviderHttpError(
        provider="test",
        status_code=503,
        code="provider_unavailable",
        message="provider failed",
        retryable=True,
        classification="server_overload",
    )


def _attempt_context(*, streaming=False):
    return InferenceAttemptContext(
        request_id="request",
        session_id="session",
        provider="test",
        model="model",
        request_source="chat_send",
        attempt=1,
        streaming=streaming,
    )


def _assert_settlement_warning(caplog):
    records = [
        record
        for record in caplog.records
        if record.name == "sidecar.ai.engines.admitted"
        and record.levelno == logging.WARNING
    ]
    assert len(records) == 1


def test_settlement_failure_does_not_mask_provider_error(caplog):
    provider_error = _provider_error()
    caplog.set_level(logging.WARNING, logger="sidecar.ai.engines.admitted")

    with pytest.raises(ProviderHttpError) as caught:
        execute_admitted_provider_attempt(
            admission=_settlement_failure_admission,
            context=_attempt_context(),
            operation=lambda: (_ for _ in ()).throw(provider_error),
        )

    assert caught.value is provider_error
    assert caught.value.__notes__ == [
        "inference settlement failed: InferenceAdmissionRefused: "
        "inference_authority_timeout"
    ]
    _assert_settlement_warning(caplog)


def test_settlement_failure_does_not_mask_sync_iterator_error(caplog):
    provider_error = _provider_error()
    caplog.set_level(logging.WARNING, logger="sidecar.ai.engines.admitted")

    def source():
        yield "first"
        raise provider_error

    guarded = execute_admitted_provider_attempt(
        admission=_settlement_failure_admission,
        context=_attempt_context(streaming=True),
        operation=source,
    )
    assert next(guarded) == "first"
    with pytest.raises(ProviderHttpError) as caught:
        next(guarded)

    assert caught.value is provider_error
    assert caught.value.__notes__ == [
        "inference settlement failed: InferenceAdmissionRefused: "
        "inference_authority_timeout"
    ]
    _assert_settlement_warning(caplog)


def test_settlement_failure_does_not_mask_awaitable_error(caplog):
    provider_error = _provider_error()
    caplog.set_level(logging.WARNING, logger="sidecar.ai.engines.admitted")

    async def source():
        raise provider_error

    guarded = execute_admitted_provider_attempt(
        admission=_settlement_failure_admission,
        context=_attempt_context(),
        operation=source,
    )
    with pytest.raises(ProviderHttpError) as caught:
        asyncio.run(guarded)

    assert caught.value is provider_error
    assert caught.value.__notes__ == [
        "inference settlement failed: InferenceAdmissionRefused: "
        "inference_authority_timeout"
    ]
    _assert_settlement_warning(caplog)


def test_settlement_failure_on_success_path_still_raises():
    with pytest.raises(InferenceAdmissionRefused) as caught:
        execute_admitted_provider_attempt(
            admission=_settlement_failure_admission,
            context=_attempt_context(),
            operation=lambda: "ok",
        )

    assert caught.value.reason == "inference_authority_timeout"


def test_legacy_admission_does_not_read_engine_metadata():
    assert inference_budget_ceilings(None, 512, None) is None


@pytest.mark.parametrize("native", [None, 0, -1, True, "32768", 1.5])
def test_missing_or_invalid_native_metadata_cannot_use_a_config_fallback(native):
    engine = SimpleNamespace(get_inference_budget_context_length=lambda: native,
                             get_configured_context_length=lambda: 32768)
    with pytest.raises(InferenceAdmissionRefused, match="ceiling_unavailable"):
        inference_budget_ceilings(engine, 512, REQUIRED)


def test_ceilings_conservatively_cover_hidden_output_and_configured_windows():
    engine = SimpleNamespace(get_inference_budget_context_length=lambda: 131072,
                             get_configured_context_length=lambda: 32768)
    assert inference_budget_ceilings(engine, 4096, REQUIRED) == (131072, 131072)
    engine.get_configured_context_length = lambda: 262144
    assert inference_budget_ceilings(engine, 4096, REQUIRED) == (262144, 262144)


def test_output_above_known_context_is_refused():
    engine = SimpleNamespace(get_inference_budget_context_length=lambda: 32768)
    with pytest.raises(InferenceAdmissionRefused, match="output_exceeds_context"):
        inference_budget_ceilings(engine, 32769, REQUIRED)


def test_metadata_read_failure_is_typed_refusal():
    def unavailable():
        raise RuntimeError("metadata offline")
    with pytest.raises(InferenceAdmissionRefused, match="ceiling_unavailable"):
        inference_budget_ceilings(SimpleNamespace(get_inference_budget_context_length=unavailable), 512, REQUIRED)


def test_general_catalog_metadata_does_not_imply_budget_capability():
    engine = SimpleNamespace(get_model_context_length=lambda: 272000)
    with pytest.raises(InferenceAdmissionRefused, match="ceiling_unavailable"):
        inference_budget_ceilings(engine, 4096, REQUIRED)


def test_capability_is_explicit_and_not_inherited_by_compatible_or_subscription_engines():

    assert BaseEngine.get_inference_budget_context_length(None) is None
    assert ChatGPTSubscriptionEngine.get_inference_budget_context_length(None) is None
    assert OpenAICompatibleEngine.get_inference_budget_context_length(None) is None
    local = SimpleNamespace(get_model_context_length=lambda: 32768, _context_length=32768)
    assert OllamaEngine.get_inference_budget_context_length(local) == 32768
    assert VLLMEngine.get_inference_budget_context_length(local) == 32768


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("required", [False, True])
def test_ollama_hidden_http_retry_requires_fresh_budget_admission(monkeypatch, streaming, required):
    engine = _build_engine()
    calls = []
    outcomes = []
    def failed(*_args, **_kwargs):
        calls.append("native")
        raise _connection_error_with_status(400)
    def failed_stream(*args, **kwargs):
        failed(*args, **kwargs)
        yield
    def plain(**_kwargs):
        calls.append("fallback")
        return iter(["ok"]) if streaming else "ok"
    monkeypatch.setattr(engine, "_generate_with_tools_impl", failed)
    monkeypatch.setattr(ollama_generation, "_ollama_stream_with_tools", failed_stream)
    monkeypatch.setattr(engine, "_fallback_plain_generate_result", plain)
    monkeypatch.setattr(engine, "_fallback_plain_stream_result", plain)
    def admit(_context):
        return SimpleNamespace(settle=outcomes.append)
    admit.requires_budget = required
    def run():
        method = engine.stream_with_tools if streaming else engine.generate_with_tools
        result = execute_admitted_provider_attempt(admission=admit,
            context=InferenceAttemptContext(request_id="request", session_id="session",
                provider="ollama", model="model", request_source="chat_send",
                attempt=1, streaming=streaming),
            operation=lambda: method(prompt="hello", tools=[]))
        return list(result) if streaming else result
    if required:
        with pytest.raises(InferenceAdmissionRefused, match="requires_fresh_retry"):
            run()
        assert calls == ["native"]
        assert outcomes[0].status == "failed"
    else:
        assert run() == (["ok"] if streaming else "ok")
        assert calls == ["native", "fallback"]
        assert outcomes[0].status == "succeeded"
    assert len(outcomes) == 1
    assert outcomes[0].cleanup == "confirmed"
