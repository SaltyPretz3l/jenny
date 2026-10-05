"""Ornith 1.5 on the OpenAI-compatible (llama-server) engine reasons natively.

Dogfood TR-018: the engine did not recognise the model as a thinking model, so
every ``reasoning_content`` delta was dropped, no thinking guard ran, and long
thinks ended at the provider's output cap with nothing to continue from.
"""

from __future__ import annotations

import pytest

from sidecar.ai.engines.local_server_props import (
    ThinkingControl,
    thinking_control_from_props,
    thinking_ladder,
)
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


def _wire_payload(
    effort: str | None,
    *,
    model: str = _LLAMA_SERVER_TAG,
    control: ThinkingControl | None = None,
    max_tokens: int = 16_384,
) -> dict[str, object]:
    engine = OpenAICompatibleEngine()
    engine.model_name = model
    engine._ready = True
    engine._thinking = True
    engine._served_thinking_control = control
    captured: dict[str, object] = {}

    def _post_json(_path: str, payload: dict[str, object]) -> dict[str, object]:
        captured.update(payload)
        return {"choices": [{"message": {"content": "ok"}}]}

    engine._service.post_json = _post_json  # type: ignore[method-assign]
    engine.generate_with_tools(
        prompt="hi", tools=[], reasoning_effort=effort, max_tokens=max_tokens
    )
    return captured


_TOGGLE = ThinkingControl(native_effort=False, toggle=True)
_NATIVE = ThinkingControl(native_effort=True, toggle=False)
# The captured Ornith 1.5 /props (llama-server build 10749), trimmed.
_ORNITH_PROPS = {
    "chat_template_caps": {"supports_reasoning_effort": False, "supports_tools": True},
    "chat_template": "{%- if enable_thinking is defined and not enable_thinking %}<think>\n\n</think>",
}


def test_ornith15_effort_none_turns_the_template_thinking_off() -> None:
    # FG-010: the template reads only enable_thinking (no effort level); the
    # top-level effort alone left None, and the wind-down legs, thinking.
    payload = _wire_payload("none")
    assert payload["chat_template_kwargs"] == {"enable_thinking": False}
    assert payload["reasoning_effort"] == "none"
    assert "thinking_budget_tokens" not in payload


@pytest.mark.parametrize("effort", [None, "default"])
def test_ornith15_automatic_leaves_the_template_default(effort: str | None) -> None:
    payload = _wire_payload(effort)
    assert "chat_template_kwargs" not in payload
    assert "thinking_budget_tokens" not in payload


@pytest.mark.parametrize(
    ("effort", "budget"),
    [("minimal", 1_024), ("low", 1_024), ("medium", 4_096), ("high", 7_987), ("max", 7_987)],
)
def test_ornith15_levels_are_per_request_thinking_budgets(effort: str, budget: int) -> None:
    # Owner 2026-10-05: Low/Medium/High = 1k/4k/8k, ended by llama-server
    # (probe: the budget holds with MTP on). High sits just under the guard:
    # 65% of 16,384 at a 0.75 share is 7,987 tokens.
    payload = _wire_payload(effort, max_tokens=16_384)
    assert payload["chat_template_kwargs"] == {"enable_thinking": True}
    assert payload["thinking_budget_tokens"] == budget


def test_thinking_budget_stays_under_the_jenny_guard() -> None:
    assert _wire_payload("high", max_tokens=4_096)["thinking_budget_tokens"] == 1_996


def test_too_little_output_room_turns_thinking_off_instead_of_overrunning() -> None:
    # Astra P2: a floor above the cap sent 256 thinking tokens with 64 output.
    payload = _wire_payload("low", max_tokens=64)
    assert "thinking_budget_tokens" not in payload
    assert payload["chat_template_kwargs"] == {"enable_thinking": False}


def test_thinking_budget_follows_the_output_fitted_to_the_window() -> None:
    # Astra P1: a 4,096-token window fits about 3,580 output tokens; the
    # budget computed from the requested 16,384 (7,987) overran it.
    engine = OpenAICompatibleEngine(configured_context_length=4_096)
    engine.model_name = _LLAMA_SERVER_TAG
    engine._ready = True
    engine._thinking = True
    captured: dict[str, object] = {}

    def _post_json(_path: str, payload: dict[str, object]) -> dict[str, object]:
        captured.update(payload)
        return {"choices": [{"message": {"content": "ok"}}]}

    engine._service.post_json = _post_json  # type: ignore[method-assign]
    engine.generate_with_tools(prompt="hi", tools=[], reasoning_effort="high", max_tokens=16_384)

    fitted = int(captured["max_tokens"])
    assert fitted < 4_096
    assert captured["thinking_budget_tokens"] == int(fitted * 0.65 * 0.75)


def test_served_props_decide_for_a_model_no_name_list_knows() -> None:
    payload = _wire_payload("medium", model="acme-reasoner-14b", control=_TOGGLE)
    assert payload["thinking_budget_tokens"] == 4_096
    assert _wire_payload("none", model="acme-reasoner-14b", control=_TOGGLE)[
        "chat_template_kwargs"
    ] == {"enable_thinking": False}
    # A template that takes no level gets nothing new.
    plain = _wire_payload(
        "high", model="acme-chat-7b", control=ThinkingControl(native_effort=False, toggle=False)
    )
    assert "chat_template_kwargs" not in plain and "thinking_budget_tokens" not in plain


def test_native_effort_template_gets_the_level_itself() -> None:
    payload = _wire_payload("xhigh", model="acme-effort-20b", control=_NATIVE)
    assert payload["reasoning_effort"] == "high"
    assert "thinking_budget_tokens" not in payload
    assert "chat_template_kwargs" not in payload


def test_native_only_template_never_receives_none() -> None:
    # Astra P2: the wind-down and recovery legs send None internally.
    payload = _wire_payload("none", model="acme-effort-20b", control=_NATIVE)
    assert payload["reasoning_effort"] == "low"
    assert "chat_template_kwargs" not in payload


def test_thinking_control_reads_the_captured_ornith_props() -> None:
    assert thinking_control_from_props(_ORNITH_PROPS) == _TOGGLE
    assert thinking_control_from_props({"chat_template_caps": {"supports_reasoning_effort": True}}) == _NATIVE
    assert thinking_control_from_props({"modalities": {"vision": False}}) is None
    assert thinking_control_from_props(None) is None
    # Astra P2: a mention is not a switch.
    for template in (
        "{# enable_thinking is not supported #}{{ messages }}",
        "{{ 'enable_thinking' }} {{ messages }}",
        "Plain text says enable_thinking. {{ messages }}",
    ):
        assert thinking_control_from_props({"chat_template": template}).toggle is False
    assert thinking_control_from_props({"chat_template": "{%- if not enable_thinking %}x{% endif %}"}).toggle
    assert thinking_ladder(_TOGGLE)["reasoning_efforts"] == ["none", "low", "medium", "high"]
    assert thinking_ladder(_NATIVE)["reasoning_efforts"] == ["low", "medium", "high"]
    assert thinking_ladder(ThinkingControl(native_effort=False, toggle=False)) is None


def _discover(monkeypatch: pytest.MonkeyPatch, ids: list[str], props: object) -> list[object]:
    from sidecar.ai.engines import catalog

    monkeypatch.setattr(
        catalog.ProviderHttpService,
        "get_json",
        lambda _self, _path, **_kwargs: {"data": [{"id": model_id} for model_id in ids]},
    )
    monkeypatch.setattr(catalog, "probe_server_modalities", lambda **_kwargs: props)
    return catalog.discover_openai_compatible_models().models


_TOGGLE_LADDER = {
    "thinking": True,
    "reasoning_effort": True,
    "reasoning_efforts": ["none", "low", "medium", "high"],
    "default_reasoning_effort": "default",
}


def test_catalog_offers_graded_levels_for_ornith15_without_props(monkeypatch: pytest.MonkeyPatch) -> None:
    # The name list is the fallback when /props does not answer.
    assert _discover(monkeypatch, [_LLAMA_SERVER_TAG], None) == [
        {"id": _LLAMA_SERVER_TAG, "capabilities": _TOGGLE_LADDER}
    ]


def test_negative_props_drop_the_ornith_name_ladder_in_catalog_and_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Astra P2: a custom Ornith template with neither control kept Medium
    # selectable while the engine (rightly) sent nothing for it.
    none_props = {"chat_template_caps": {"supports_reasoning_effort": False}, "chat_template": "{{ messages }}"}
    [model] = _discover(monkeypatch, [_LLAMA_SERVER_TAG], none_props)
    assert model == {"id": _LLAMA_SERVER_TAG, "capabilities": {"thinking": True}}
    payload = _wire_payload(
        "medium", control=ThinkingControl(native_effort=False, toggle=False)
    )
    assert "thinking_budget_tokens" not in payload and "chat_template_kwargs" not in payload


def test_catalog_stamps_the_props_ladder_and_keeps_tuned_families(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    models = _discover(monkeypatch, ["acme-reasoner-14b", "qwen3.8-27b"], _ORNITH_PROPS)
    assert models[0] == {"id": "acme-reasoner-14b", "capabilities": _TOGGLE_LADDER}
    assert models[1]["capabilities"]["reasoning_efforts"] == ["none", "low", "medium", "xhigh"]


def test_load_model_reads_the_thinking_control_from_props(monkeypatch: pytest.MonkeyPatch) -> None:
    from sidecar.ai.engines import vllm_engine as vllm_engine_module

    engine = OpenAICompatibleEngine()
    monkeypatch.setattr(engine, "_query_models", lambda: [{"id": "acme-reasoner-14b"}])
    monkeypatch.setattr(vllm_engine_module, "probe_server_modalities", lambda **_kwargs: _ORNITH_PROPS)

    engine.load_model("acme-reasoner-14b")

    assert engine._served_thinking_control == _TOGGLE
    assert engine._thinking is True
    assert engine._local_runtime_capability_sources["thinking"] == "server_props"
    engine.unload_model()
    assert engine._served_thinking_control is None
