"""Inkling 2 Mini is its own ``inkling2`` family with a graded thinking contract.

The model reasons natively and takes explicit effort levels plus a thinking
token budget on the ``openai-compatible`` engine. ``auto`` and ``default`` must
never reach the wire (a server may read them as the highest level), and
``chat_template_kwargs`` must never carry a falsy ``enable_thinking`` beside a
level. A server that is restarting lists no models; its root ``/health`` then
names the wait instead of the generic "not serving" error.

Only the Mini size matches: the cloud ids ``inkling``, ``inkling-small`` and
``thinkingmachines/inkling`` name a different model. Engine behaviour is also
asserted on the live ``BrainContainer.configure`` path.
"""

# new-test-file: new Inkling 2 model family surface (row 200 S1)

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

import sidecar.ai.container as container_mod
from sidecar.ai.app_profiles import (
    apply_behavior,
    apply_overrides,
    canonicalize_model_name,
    resolve_profile,
    resolve_variant,
)
from sidecar.ai.config import RuntimeConfig
from sidecar.ai.container import BrainContainer
from sidecar.ai.engines import catalog, model_name
from sidecar.ai.engines import vllm_engine as vllm_engine_module
from sidecar.ai.engines import vllm_engine_generation as generation_module
from sidecar.ai.engines.local_server_props import ThinkingControl
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.provider_http import ProviderHttpService
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.engines.vllm_engine import VLLMEngine
from sidecar.ai.exceptions import EngineConnectionError
from sidecar.runtime.local_engine.request_context import bind_chat_request_context

REPO_ROOT = Path(__file__).resolve().parents[4]
ACCELERATION_CATALOG_PATH = REPO_ROOT / "config" / "model-acceleration-catalog.json"

MODEL = "inkling-2-mini-sq-20"
HEADROOM = 16_384
INKLING_NAMES = (
    "inkling-2-mini-sq-20",
    "Inkling-2-Mini-SQ-20",
    "inkling-2-mini",
    "Inkling_2_Mini_SQ_15",
    "hf.co/strata-engine/Inkling-2-Mini-Strata",
    "inkling2-mini-sq-10",
    "Inkling-2-Mini-SQ-20.strata",
)
# Cloud ids and other sizes: a different model, never claimed.
OTHER_NAMES = (
    "inkling",
    "inkling-small",
    "inkling-small:free",
    "thinkingmachines/inkling",
    "accounts/fireworks/models/inkling",
    "inkling-2",
    "inkling-3-mini",
    "qwen3.8-27b",
    "ornith-1.5-9b",
)
# Jenny effort -> (wire reasoning_effort, thinking_budget_tokens).
EFFORT_MAPPING = {
    "none": ("none", None),
    "minimal": ("minimal", 1_024),
    "low": ("low", 2_048),
    "medium": ("medium", 4_096),
    "default": ("medium", 4_096),
    "auto": ("medium", 4_096),
    None: ("medium", 4_096),
    "high": ("high", 8_192),
    "xhigh": ("xhigh", 16_384),
    "max": ("xhigh", 16_384),
}
INKLING_CATALOG_CAPS = {
    "reasoning_effort": True,
    "reasoning_efforts": ["none", "low", "medium", "high", "xhigh"],
    "default_reasoning_effort": "medium",
}
SSE = (
    b'data: {"choices":[{"delta":{"reasoning_content":"hm"}}]}\n\n'
    b'data: {"choices":[{"delta":{"content":"391"},"finish_reason":"stop"}]}\n\n'
    b"data: [DONE]\n\n"
)


def _engine(model: str = MODEL, *, window: int | None = None) -> OpenAICompatibleEngine:
    engine = OpenAICompatibleEngine(
        configured_context_length=window,
        profile_max_output_tokens=HEADROOM,
        profile_thinking_headroom=HEADROOM,
    )
    engine.model_name = model
    engine._ready = True
    engine._thinking = OpenAICompatibleEngine._detect_thinking(model)
    return engine


def _wire(  # noqa: PLR0913 - one helper, keyword-only test knobs.
    effort: str | None,
    *,
    model: str = MODEL,
    max_tokens: int = 2_048,
    window: int | None = None,
    control: ThinkingControl | None = None,
    messages: list[Any] | None = None,
) -> dict[str, Any]:
    """The payload a streamed turn puts on the wire (fitted, as it is sent)."""
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "text/event-stream", "connection": "close"},
            stream=httpx.ByteStream(SSE),
        )

    engine = _engine(model, window=window)
    engine._served_thinking_control = control
    engine._service._client.close()
    engine._service._client = httpx.Client(
        base_url=engine._base_url, transport=httpx.MockTransport(handler)
    )
    try:
        list(
            engine.stream(
                prompt="",
                max_tokens=max_tokens,
                temperature=1.0,
                reasoning_effort=effort,
                messages=messages or [{"role": "user", "content": "17*23?"}],
            )
        )
    finally:
        engine.close()
    return sent[-1]


# ---------------------------------------------------------------------------
# Detection and profile
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", INKLING_NAMES)
def test_inkling_names_match_the_detector_the_profile_and_the_engine(name: str) -> None:
    profile = resolve_profile(name)

    assert model_name.is_inkling_model(name) is True
    assert profile is not None
    assert profile.family == "inkling2"
    assert resolve_variant(profile, name).name == "mini"
    assert OpenAICompatibleEngine._detect_thinking(name) is True
    # Not a Qwen3.8-contract name, and not in the shared thinking prefix list.
    assert model_name.uses_qwen38_chat_contract(name) is False
    assert VLLMEngine._detect_thinking(name) is False


@pytest.mark.parametrize("name", OTHER_NAMES)
def test_other_inkling_ids_and_unrelated_names_are_not_claimed(name: str) -> None:
    profile = resolve_profile(name)

    assert model_name.is_inkling_model(name) is False
    assert profile is None or profile.family != "inkling2"
    assert resolve_profile(name, "inkling2") is None or resolve_profile(name, "inkling2") is profile
    for form in (model_name.canonical_model_token(name), canonicalize_model_name(name)):
        assert not form.startswith(model_name.INKLING2_MODEL_PREFIXES), form


def test_none_and_empty_names_are_not_inkling() -> None:
    assert model_name.is_inkling_model(None) is False
    assert model_name.is_inkling_model("") is False
    assert "inkling" not in " ".join(model_name.THINKING_MODEL_PREFIXES)


def _profiled_config(engine_type: str) -> RuntimeConfig:
    config = RuntimeConfig(engine_type=engine_type, model=MODEL)
    profile = resolve_profile(MODEL)
    assert profile is not None
    variant = resolve_variant(profile, MODEL)
    return apply_behavior(apply_overrides(config, profile, variant), profile, variant)


def test_the_profile_invents_no_window_and_pins_temperature_and_output_limits() -> None:
    profile = resolve_profile(MODEL)
    assert profile is not None
    assert profile.label == "Inkling 2 Mini"
    assert profile.family_aliases == model_name.INKLING2_MODEL_PREFIXES
    assert profile.overrides.context_length is None
    (variant,) = profile.variants
    assert variant.native_context_length == 1_048_576
    assert variant.is_moe is True
    assert variant.overrides is None

    configured = _profiled_config("openai-compatible")

    assert configured.context_length is None
    assert configured.resolved_app_profile_family == "inkling2"
    assert configured.resolved_app_profile_temperature == 1.0
    assert configured.resolved_app_profile_max_output_tokens == 16_384
    assert configured.resolved_app_profile_thinking_token_headroom == 16_384
    assert configured.resolved_app_profile_thinking_sampler is None
    assert configured.resolved_app_profile_top_p is None


@pytest.mark.parametrize("engine_type", ["ollama", "vllm", "chatgpt"])
def test_profile_behavior_applies_only_on_the_openai_compatible_engine(engine_type: str) -> None:
    configured = _profiled_config(engine_type)

    assert configured.resolved_app_profile_family == "inkling2"
    assert configured.resolved_app_profile_temperature is None
    assert configured.resolved_app_profile_max_output_tokens is None
    assert configured.resolved_app_profile_thinking_token_headroom is None


# ---------------------------------------------------------------------------
# The thinking contract on the wire
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("effort", list(EFFORT_MAPPING))
def test_each_effort_sends_the_mapped_level_and_budget(effort: str | None) -> None:
    level, budget = EFFORT_MAPPING[effort]

    payload = _wire(effort, max_tokens=40_000)

    assert payload["reasoning_effort"] == level
    assert payload.get("thinking_budget_tokens") == budget
    assert "chat_template_kwargs" not in payload


@pytest.mark.parametrize("effort", list(EFFORT_MAPPING))
def test_the_wire_never_carries_default_or_auto(effort: str | None) -> None:
    payload = _wire(effort)

    assert payload["reasoning_effort"] not in {"default", "auto"}
    assert "default" not in json.dumps({k: v for k, v in payload.items() if k != "messages"})
    assert "auto" not in json.dumps({k: v for k, v in payload.items() if k != "messages"})


@pytest.mark.parametrize("effort", [e for e in EFFORT_MAPPING if e != "none"])
def test_every_thinking_level_adds_the_profile_headroom(effort: str | None) -> None:
    payload = _wire(effort, max_tokens=2_048)

    assert payload["max_tokens"] == 2_048 + HEADROOM
    assert isinstance(payload["thinking_budget_tokens"], int)
    assert isinstance(payload["reasoning_effort"], str)


def test_effort_none_keeps_the_requested_max_tokens_and_sends_no_budget() -> None:
    payload = _wire("none", max_tokens=2_048)

    assert payload["max_tokens"] == 2_048
    assert payload["reasoning_effort"] == "none"
    assert "thinking_budget_tokens" not in payload
    assert "chat_template_kwargs" not in payload


def test_a_base_chat_template_kwargs_never_survives_on_an_inkling_payload() -> None:
    # A served template that reads enable_thinking (a /props verdict) changes nothing.
    toggle = ThinkingControl(native_effort=False, toggle=True)
    for effort in ("none", "high"):
        assert "chat_template_kwargs" not in _wire(effort, control=toggle)


@pytest.mark.parametrize(
    ("effort", "expected_budget"),
    [("minimal", 1_024), ("low", 2_048), ("medium", 4_096), ("high", 8_192), ("xhigh", 15_974)],
)
def test_jenny_guard_fires_before_strata_answer_reserve_at_the_profile_output(
    effort: str, expected_budget: int
) -> None:
    # Plan G3: at the profile's 16,384-token answer, max_tokens is 32,768 with headroom.
    # Jenny's guard (0.65 x 0.75 = 15,974) sits under Strata's answer reserve (thinking
    # may use 3/4 of max_tokens = 24,576), so only xhigh is trimmed, and by Jenny.
    payload = _wire(effort, max_tokens=16_384)

    assert payload["max_tokens"] == 32_768
    assert payload["thinking_budget_tokens"] == expected_budget
    assert payload["thinking_budget_tokens"] < payload["max_tokens"] * 3 // 4


def test_the_budget_follows_the_fitted_output_under_a_tight_window() -> None:
    # 20k window: max_tokens fits to the room left; the budget stays under the guard share.
    payload = _wire("xhigh", max_tokens=2_048, window=20_000)

    assert payload["max_tokens"] <= 20_000
    assert payload["reasoning_effort"] == "xhigh"
    assert payload["thinking_budget_tokens"] <= 16_384
    assert "chat_template_kwargs" not in payload


def test_a_cap_collapse_at_build_time_sends_none_and_no_budget() -> None:
    # No headroom: max_tokens 64 leaves less than a useful think, so the cap turns thinking off.
    engine = _engine()
    engine._profile_thinking_headroom = 0

    payload = engine._build_payload(
        prompt="",
        max_tokens=64,
        temperature=1.0,
        reasoning_effort="high",
        prompt_cache_enabled=False,
        system="",
        messages=[{"role": "user", "content": "hi"}],
        response_format=None,
    )

    assert payload["reasoning_effort"] == "none"
    assert "thinking_budget_tokens" not in payload
    assert "chat_template_kwargs" not in payload


def test_a_cap_collapse_at_window_fit_time_sends_none_and_no_budget() -> None:
    payload = _wire("high", max_tokens=64, window=200)

    assert payload["reasoning_effort"] == "none"
    assert "thinking_budget_tokens" not in payload
    assert "chat_template_kwargs" not in payload
    assert isinstance(payload["max_tokens"], int)


def test_an_unknown_effort_is_rejected_by_family_name() -> None:
    with pytest.raises(ValueError, match="Unsupported Inkling 2 reasoning effort: turbo"):
        _wire("turbo")


def test_the_output_reservation_adds_headroom_unless_thinking_is_off() -> None:
    engine = _engine()

    assert engine.get_request_output_reservation("none") == HEADROOM
    for effort in ("minimal", "high", None, "default", "xhigh"):
        assert engine.get_request_output_reservation(effort) == 2 * HEADROOM


def test_the_payload_keeps_known_roles_tool_ids_data_uris_and_no_unsupported_keys() -> None:
    image = VisionImage("image/png", 1, 1, 1, b"synthetic-image")
    messages: list[Any] = [
        {"role": "user", "content": "Weather in Paris?"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call_0", "name": "get_weather", "arguments": {"city": "Paris"}}],
        },
        {"role": "tool", "tool_call_id": "call_0", "name": "get_weather", "content": "12C"},
        {"role": "user", "content": "And this picture?", "images": [image]},
    ]

    payload = _wire("medium", messages=messages)

    assert {m["role"] for m in payload["messages"]} <= {"system", "user", "assistant", "tool"}
    assert all(m.get("tool_call_id") for m in payload["messages"] if m["role"] == "tool")
    urls = [
        part["image_url"]["url"]
        for m in payload["messages"]
        if isinstance(m.get("content"), list)
        for part in m["content"]
        if part.get("type") == "image_url"
    ]
    assert urls
    assert all(url.startswith("data:") for url in urls)
    assert not [key for key in payload if key.startswith("strata_")]
    assert "logprobs" not in payload
    assert "logit_bias" not in payload


def test_reasoning_reaches_the_turn_and_a_thinking_guard_is_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    built: list[int] = []
    real_guard = generation_module.ThinkingRepetitionGuard

    def _guard(*args: Any, **kwargs: Any) -> Any:
        built.append(1)
        return real_guard(*args, **kwargs)

    monkeypatch.setattr(generation_module, "ThinkingRepetitionGuard", _guard)
    engine = _engine()
    assert engine._thinking is True
    assert engine.capabilities["thinking"] is True

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "text/event-stream", "connection": "close"},
            stream=httpx.ByteStream(SSE),
        )

    engine._service._client.close()
    engine._service._client = httpx.Client(
        base_url=engine._base_url, transport=httpx.MockTransport(handler)
    )
    try:
        events = list(
            engine.stream(prompt="", max_tokens=512, messages=[{"role": "user", "content": "x"}])
        )
    finally:
        engine.close()

    kinds = {getattr(event, "kind", None): getattr(event, "text", "") for event in events}
    assert kinds["thinking"] == "hm"
    assert kinds["content"] == "391"
    assert built == [1]


# ---------------------------------------------------------------------------
# Other families keep their payloads
# ---------------------------------------------------------------------------


def test_qwen38_payload_is_unchanged() -> None:
    payload = _wire("high", model="qwen3.8-27b", max_tokens=2_048)

    assert payload["chat_template_kwargs"] == {"enable_thinking": True, "reasoning_effort": "xhigh"}
    assert payload["reasoning_effort"] == "xhigh"
    assert payload["max_tokens"] == 2_048 + HEADROOM
    assert "thinking_budget_tokens" not in payload


def test_bonsai2_payload_is_unchanged() -> None:
    payload = _wire("low", model="ternary-bonsai-2-27b-pq2_0", max_tokens=2_048)

    assert payload["chat_template_kwargs"] == {"enable_thinking": False}
    assert payload["reasoning_effort"] == "none"
    assert payload["max_tokens"] == 2_048


def test_ornith15_payload_is_unchanged() -> None:
    payload = _wire("high", model="ornith-1.5-9b", max_tokens=40_000)

    assert payload["chat_template_kwargs"] == {"enable_thinking": True}
    assert payload["thinking_budget_tokens"] == 8_192
    assert payload["reasoning_effort"] == "high"


def test_an_unknown_name_keeps_the_base_payload() -> None:
    payload = _wire("high", model="some-other-model")

    assert payload["reasoning_effort"] == "high"
    assert "chat_template_kwargs" not in payload
    assert "thinking_budget_tokens" not in payload


# ---------------------------------------------------------------------------
# Model catalog (reasoning-effort picker metadata)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", INKLING_NAMES)
def test_inkling_ids_get_the_graded_ladder_on_the_openai_compatible_path(name: str) -> None:
    rows = catalog._parse_vllm_models_payload(
        {"data": [{"id": name}]}, openai_compatible_controls=True
    )

    assert rows == [{"id": name, "capabilities": {"thinking": True, **INKLING_CATALOG_CAPS}}]


@pytest.mark.parametrize("name", OTHER_NAMES[:5])
def test_cloud_inkling_ids_get_no_thinking_row(name: str) -> None:
    rows = catalog._parse_vllm_models_payload(
        {"data": [{"id": name}]}, openai_compatible_controls=True
    )

    assert rows == [name]


@pytest.mark.parametrize(
    "control",
    [
        ThinkingControl(native_effort=False, toggle=False),
        ThinkingControl(native_effort=False, toggle=True),
        ThinkingControl(native_effort=True, toggle=False),
    ],
)
def test_a_props_ladder_never_overrides_the_inkling_efforts(control: ThinkingControl) -> None:
    rows = catalog._parse_vllm_models_payload(
        {"data": [{"id": MODEL}, {"id": "ornith-1.5-9b"}]}, openai_compatible_controls=True
    )
    assert isinstance(rows, list)
    before = json.dumps(rows[0], sort_keys=True)

    catalog._stamp_thinking_ladder(rows, control)

    assert json.dumps(rows[0], sort_keys=True) == before


def test_openai_compatible_discovery_row_for_inkling(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(catalog, "_get_provider_json", lambda **_kwargs: {"data": [{"id": MODEL}]})
    monkeypatch.setattr(
        catalog,
        "probe_server_modalities",
        lambda **_kwargs: {
            "modalities": {"vision": True},
            "chat_template": "{{ reasoning_effort }}",
        },
    )

    result = catalog.discover_openai_compatible_models()

    assert result.available is True
    (row,) = result.models
    assert isinstance(row, dict)
    capabilities = row["capabilities"]
    assert capabilities["thinking"] is True
    for key, value in INKLING_CATALOG_CAPS.items():
        assert capabilities[key] == value


# ---------------------------------------------------------------------------
# Managed llama-server acceleration catalog
# ---------------------------------------------------------------------------


def test_acceleration_catalog_lists_inkling2_without_drafting() -> None:
    families = json.loads(ACCELERATION_CATALOG_PATH.read_text(encoding="utf-8"))["families"]
    entry = next((item for item in families if item["family"] == "inkling2"), None)

    assert entry is not None
    assert entry["matchPrefixes"] == list(model_name.INKLING2_MODEL_PREFIXES)
    assert entry["mtp"] == "no"
    assert entry["mtpShape"] == "native"
    assert entry["ngram"] is False
    assert entry["vramHeadroomMb"] == 2048
    for name in INKLING_NAMES:
        token = canonicalize_model_name(name)
        first = next(
            (f["family"] for f in families if any(token.startswith(p) for p in f["matchPrefixes"])),
            None,
        )
        assert first == "inkling2", name


# ---------------------------------------------------------------------------
# Still loading
# ---------------------------------------------------------------------------


def _json_response(request: httpx.Request, status: int, body: bytes) -> httpx.Response:
    return httpx.Response(
        status,
        request=request,
        headers={"content-type": "application/json", "connection": "close"},
        stream=httpx.ByteStream(body),
    )


def _loading_engine(
    *, models: Any, health: tuple[int, bytes] | None, calls: list[str]
) -> OpenAICompatibleEngine:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/v1/models":
            return _json_response(request, 200, json.dumps(models).encode())
        if request.url.path == "/health" and health is not None:
            return _json_response(request, *health)
        return _json_response(request, 404, b'{"error": "not found"}')

    engine = OpenAICompatibleEngine(host="http://127.0.0.1:8095/v1")
    engine._service._client.close()
    engine._service._client = httpx.Client(
        base_url=engine._base_url, transport=httpx.MockTransport(handler)
    )
    return engine


@pytest.fixture(autouse=True)
def _no_props_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vllm_engine_module, "probe_server_modalities", lambda **_kwargs: None)


def test_an_empty_catalog_with_loaded_false_is_a_named_loading_error() -> None:
    calls: list[str] = []
    engine = _loading_engine(
        models={"object": "list", "data": []}, health=(200, b'{"loaded": false}'), calls=calls
    )

    with pytest.raises(EngineConnectionError) as raised:
        engine.load_model(MODEL)

    assert str(raised.value).endswith(
        "OpenAI-compatible server at http://127.0.0.1:8095/v1 is still loading its model. "
        "Wait for it to finish, then try again."
    )
    assert calls == ["/v1/models", "/health"]
    engine.close()


@pytest.mark.parametrize(
    "health",
    [
        (200, b'{"loaded": true}'),
        (200, b"{}"),
        (200, b'{"loaded": "false"}'),
        (200, b'{"loaded": 0}'),
        (200, b"[false]"),
        (200, b"not json"),
        (500, b'{"loaded": false}'),
        None,
    ],
)
def test_any_other_health_answer_keeps_the_not_serving_error(
    health: tuple[int, bytes] | None,
) -> None:
    engine = _loading_engine(models={"data": []}, health=health, calls=[])

    with pytest.raises(EngineConnectionError, match="not serving model"):
        engine.load_model(MODEL)
    engine.close()


def test_a_non_empty_catalog_never_asks_health() -> None:
    calls: list[str] = []
    engine = _loading_engine(
        models={"data": [{"id": "another-model"}]}, health=(200, b'{"loaded": false}'), calls=calls
    )

    with pytest.raises(EngineConnectionError, match="not serving model"):
        engine.load_model(MODEL)

    assert calls == ["/v1/models"]
    engine.close()


# ---------------------------------------------------------------------------
# The live BrainContainer.configure path
# ---------------------------------------------------------------------------


@pytest.fixture
def containers() -> Iterator[list[BrainContainer]]:
    built: list[BrainContainer] = []
    yield built
    for container in built:
        container.close()


@pytest.fixture
def live_stack(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, containers: list[BrainContainer]
) -> Callable[..., Any]:
    """Configure a real ``BrainContainer`` against a fake served model."""
    monkeypatch.setenv("JENNY_OPERATION_LEDGER_ROOT", str(tmp_path / "ledger"))
    for attr, fake in (
        ("MemoryStore", lambda _path: MagicMock()),
        ("ContextBuilder", lambda *_args, **_kwargs: MagicMock()),
        ("MCPClient", lambda **_kwargs: MagicMock()),
        ("ChatRouter", lambda **_kwargs: MagicMock()),
        ("HarnessSnapshotBuilder", lambda **_kwargs: MagicMock()),
        ("resolve_memory_db_path", lambda _config: str(tmp_path / "memory.db")),
        ("resolve_background_runtime_root", lambda _config: tmp_path / "runtime"),
    ):
        monkeypatch.setattr(container_mod, attr, fake)
    served: list[str] = []

    def _get_json(self: ProviderHttpService, path: str, **_kwargs: Any) -> dict[str, Any]:
        del self, path
        return {"data": [{"id": model} for model in served]}

    monkeypatch.setattr(ProviderHttpService, "get_json", _get_json)

    def _configure(model: str) -> Any:
        served[:] = [model]
        container = BrainContainer()
        containers.append(container)
        stack = container.configure({"engine_type": "openai-compatible", "model": model})
        assert stack.engine_fallback_from is None, stack.engine_fallback_reason
        return stack

    return _configure


def _send_live(stack: Any, effort: str | None) -> dict[str, Any]:
    """One non-stream request, with room for the largest budget under the guard share."""
    engine = stack.engine
    bind_chat_request_context(
        engine,
        request_context=SimpleNamespace(request_id="inkling2-family", trace_id="inkling2-family"),
        runtime_config=stack.config,
    )
    captured: dict[str, Any] = {}

    def _post_json(_path: str, payload: dict[str, Any]) -> dict[str, Any]:
        captured.update(payload)
        return {"choices": [{"message": {"content": "ok"}}]}

    engine._service.post_json = _post_json
    try:
        engine.generate_with_tools(
            prompt="hi", tools=[], reasoning_effort=effort, max_tokens=40_000
        )
    finally:
        engine.clear_request_context()
    return captured


@pytest.mark.parametrize("name", ["inkling-2-mini-sq-20", "Inkling_2_Mini_SQ_15"])
def test_the_live_stack_carries_the_profile_and_the_graded_payload(
    live_stack: Callable[..., Any], name: str
) -> None:
    stack = live_stack(name)

    assert stack.config.resolved_app_profile_family == "inkling2"
    assert stack.config.resolved_app_profile_temperature == 1.0
    assert stack.config.resolved_app_profile_max_output_tokens == 16_384
    assert stack.config.resolved_app_profile_thinking_token_headroom == 16_384
    assert stack.config.context_length is None
    assert stack.engine.capabilities["thinking"] is True

    payload = _send_live(stack, "high")

    assert payload["reasoning_effort"] == "high"
    assert payload["thinking_budget_tokens"] == 8_192
    assert payload["temperature"] == 1.0
    assert "chat_template_kwargs" not in payload
    assert isinstance(payload["max_tokens"], int)

    payload = _send_live(stack, "default")

    assert payload["reasoning_effort"] == "medium"
    assert payload["thinking_budget_tokens"] == 4_096
