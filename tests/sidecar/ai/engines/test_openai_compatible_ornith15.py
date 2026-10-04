"""Ornith 1.5 on the OpenAI-compatible (llama-server) engine reasons natively.

Dogfood TR-018: the engine did not recognise the model as a thinking model, so
every ``reasoning_content`` delta was dropped, no thinking guard ran, and long
thinks ended at the provider's output cap with nothing to continue from.
"""

from __future__ import annotations

import pytest

from sidecar.ai.engines.model_name import THINKING_MODEL_PREFIXES, is_ornith15_model
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.provider_http import ProviderHttpService
from tests.sidecar.ai.engines.test_thinking_budget_abort import (
    _drain,
    _TrackingSSEStream,
    _vllm_chunk,
)

_LLAMA_SERVER_TAG = "ornith-1.5-9b-q6_k"


@pytest.mark.parametrize(
    "name",
    [
        _LLAMA_SERVER_TAG,
        "Ornith-1.5-9B-Q6_K.gguf",
        "ornith15:9b-q6-256k",
        "hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q8_0",
    ],
)
def test_ornith15_names_are_thinking_models_on_this_engine(name: str) -> None:
    assert is_ornith15_model(name) is True
    assert OpenAICompatibleEngine._detect_thinking(name) is True


@pytest.mark.parametrize("name", ["ornith:9b-48k", "ornith-1.0-9b", "ornithopter-7b", ""])
def test_ornith_1_0_and_lookalikes_are_not_matched(name: str) -> None:
    assert is_ornith15_model(name) is False
    assert OpenAICompatibleEngine._detect_thinking(name) is False


def test_ornith15_stays_out_of_the_shared_thinking_prefix_list() -> None:
    # That list also feeds the Ollama metadata fallback and the model catalog.
    assert not any(prefix.startswith("ornith") for prefix in THINKING_MODEL_PREFIXES)


def test_ornith15_long_think_ends_on_the_thinking_budget_with_its_reasoning_kept(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lines = [_vllm_chunk({"reasoning_content": "r" * 4_000}) for _ in range(8)]
    lines.append('data: {"choices": [{"delta": {}, "finish_reason": "length"}]}')
    lines.append("data: [DONE]")
    response = _TrackingSSEStream(lines)

    class _Stream:
        def __enter__(self) -> _TrackingSSEStream:
            return response

        def __exit__(self, *_exc: object) -> None:
            return None

    monkeypatch.setattr(ProviderHttpService, "stream_response", lambda *_a, **_kw: _Stream())
    engine = OpenAICompatibleEngine()
    engine.model_name = _LLAMA_SERVER_TAG
    engine._ready = True
    engine._thinking = OpenAICompatibleEngine._detect_thinking(_LLAMA_SERVER_TAG)

    _events, result = _drain(engine.stream_with_tools(prompt="hi", tools=[], max_tokens=8_192))

    # 65% of 8,192 tokens at 3.2 chars/token is about 17,000 chars: the guard
    # ends the generation before the provider's own cap.
    assert result.finish_reason == "thinking_budget"
    assert response.consumed < len(lines)
    assert result.thinking_text.strip()


def _wire_payload(effort: str | None) -> dict[str, object]:
    engine = OpenAICompatibleEngine()
    engine.model_name = _LLAMA_SERVER_TAG
    engine._ready = True
    engine._thinking = True
    captured: dict[str, object] = {}

    def _post_json(_path: str, payload: dict[str, object]) -> dict[str, object]:
        captured.update(payload)
        return {"choices": [{"message": {"content": "ok"}}]}

    engine._service.post_json = _post_json  # type: ignore[method-assign]
    engine.generate_with_tools(prompt="hi", tools=[], reasoning_effort=effort)
    return captured


def test_ornith15_effort_none_turns_the_template_thinking_off() -> None:
    # FG-010: the template reads only enable_thinking (no effort level); the
    # top-level effort alone left None, and the wind-down legs, thinking.
    payload = _wire_payload("none")
    assert payload["chat_template_kwargs"] == {"enable_thinking": False}
    assert payload["reasoning_effort"] == "none"


@pytest.mark.parametrize("effort", [None, "default", "low", "medium"])
def test_ornith15_other_efforts_leave_the_template_default(effort: str | None) -> None:
    assert "chat_template_kwargs" not in _wire_payload(effort)


def test_catalog_offers_none_for_ornith15_on_llama_server(monkeypatch: pytest.MonkeyPatch) -> None:
    from sidecar.ai.engines import catalog

    monkeypatch.setattr(
        catalog.ProviderHttpService,
        "get_json",
        lambda _self, _path, **_kwargs: {"data": [{"id": _LLAMA_SERVER_TAG}]},
    )
    monkeypatch.setattr(catalog, "probe_server_modalities", lambda **_kwargs: None)

    result = catalog.discover_openai_compatible_models()

    assert result.models == [
        {
            "id": _LLAMA_SERVER_TAG,
            "capabilities": {
                "thinking": True,
                "reasoning_effort": True,
                "reasoning_efforts": ["none"],
                "default_reasoning_effort": "default",
            },
        }
    ]
