"""Replay Strata's response shapes through the OpenAI-compatible engine.

Roadmap row 200 (Strata engine support, first test model Inkling 2 Mini), slices
S0a/S1. The fixtures under ``fixtures/strata`` are SYNTHETIC: written from the
Strata v0.2.21 source (commit d46f5f2), not recorded from a live server; their
provenance is in ``fixtures/strata/README.md``. S0b replaces them with
recordings. These tests pin that Jenny's existing engine binds Strata's
Inkling id, reads the served window and vision from ``/props``, keeps
Inkling's reasoning, sends the plan's effort mapping with explicit limits,
retries a failed JSON-mode request once without ``response_format``, and
names a server that is still loading its model.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from sidecar.ai.engines import vllm_engine as vllm_engine_module
from sidecar.ai.engines.local_server_props import ThinkingControl
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.provider_http import _response_error
from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.exceptions import EngineConnectionError
from sidecar.ai.tools.models import StreamingEvent

FIXTURES = Path(__file__).parent / "fixtures" / "strata"
BASE_URL = "http://127.0.0.1:8095/v1"
MODEL_ID = "inkling-2-mini-sq-20"
PROFILE_MAX_OUTPUT = 16_384
PROFILE_HEADROOM = 16_384
WEATHER_TOOL = {
    "name": "get_weather",
    "description": "Get the current weather for a city.",
    "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}
READ_FILE_TOOL = {
    "name": "read_file",
    "description": "Read a text file from the project.",
    "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
}
# The plan's Inkling effort mapping (section 4): Jenny value -> (reasoning_effort, thinking_budget_tokens).
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
JSON_MODE = ResponseFormat(type="json_object")


def _fixture_json(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _recorded_deltas(sse_name: str, field: str) -> str:
    parts: list[str] = []
    for line in (FIXTURES / sse_name).read_text(encoding="utf-8").splitlines():
        if not line.startswith("data: {"):
            continue
        for choice in json.loads(line[len("data: ") :]).get("choices") or []:
            value = (choice.get("delta") or {}).get(field)
            if isinstance(value, str):
                parts.append(value)
    return "".join(parts)


def _drain(generator: Any) -> tuple[list[Any], Any]:
    items: list[Any] = []
    while True:
        try:
            items.append(next(generator))
        except StopIteration as stop:
            return items, stop.value


def _event_text(items: list[Any], kind: str) -> str:
    return "".join(
        item.text for item in items if isinstance(item, StreamingEvent) and item.kind == kind
    )


@pytest.fixture
def make_engine(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., Any]]:
    """Build an engine bound to the synthetic server.

    ``streams`` is the list of SSE fixtures the chat route answers with, in order;
    ``props``/``models``/``health`` pick the catalog fixtures.
    """
    built: list[OpenAICompatibleEngine] = []

    def _make(
        *streams: str,
        props: dict[str, Any] | None = None,
        models: str = "v1_models.json",
        health: str = "health.json",
        load: bool = True,
    ) -> tuple[OpenAICompatibleEngine, list[dict[str, Any]]]:
        served_props = props if props is not None else _fixture_json("props.json")
        monkeypatch.setattr(
            vllm_engine_module, "probe_server_modalities", lambda **_kwargs: served_props
        )
        queue = list(streams)
        sent: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/models":
                body, content_type = (FIXTURES / models).read_bytes(), "application/json"
            elif request.url.path == "/health":
                body, content_type = (FIXTURES / health).read_bytes(), "application/json"
            else:
                assert request.url.path == "/v1/chat/completions" and queue, request.url.path
                sent.append(json.loads(request.content))
                body, content_type = (FIXTURES / queue.pop(0)).read_bytes(), "text/event-stream"
            return httpx.Response(
                200,
                request=request,
                headers={"content-type": content_type, "connection": "close"},
                stream=httpx.ByteStream(body),
            )

        engine = OpenAICompatibleEngine(
            host=BASE_URL,
            configured_context_length=8192,
            profile_max_output_tokens=PROFILE_MAX_OUTPUT,
            profile_thinking_headroom=PROFILE_HEADROOM,
        )
        engine._service._client.close()
        engine._service._client = httpx.Client(
            base_url=engine._base_url, transport=httpx.MockTransport(handler)
        )
        built.append(engine)
        if load:
            engine.load_model(MODEL_ID)
        return engine, sent

    yield _make
    for engine in built:
        with contextlib.suppress(Exception):
            engine.close()


def _stream(engine: OpenAICompatibleEngine, *, effort: str | None, max_tokens: int = 2048) -> list[Any]:
    items, _ = _drain(
        engine.stream(
            prompt="",
            max_tokens=max_tokens,
            temperature=1.0,
            reasoning_effort=effort,
            messages=[{"role": "user", "content": "What is 17*23? Answer with just the number."}],
        )
    )
    return items


# --- binding and capabilities -------------------------------------------------------------------


def test_load_model_binds_the_inkling_id_and_reads_window_and_vision(make_engine) -> None:
    engine, _sent = make_engine()

    assert engine.model_name == MODEL_ID
    # /props n_ctx (49152, recorded at four slots) wins over Electron's configured 8192.
    assert engine.get_configured_context_length() == 49_152
    assert engine._vision is True
    # Strata's /props has no supports_reasoning_effort and the Inkling template no enable_thinking.
    assert engine._served_thinking_control == ThinkingControl(native_effort=False, toggle=False)


def test_inkling_id_is_a_thinking_model_so_its_reasoning_reaches_the_turn(make_engine) -> None:
    engine, _sent = make_engine("think_medium.sse")

    assert engine._thinking is True
    items = _stream(engine, effort="medium")

    assert _event_text(items, "content") == _recorded_deltas("think_medium.sse", "content")
    assert _event_text(items, "thinking") == _recorded_deltas("think_medium.sse", "reasoning_content")


# --- the effort mapping table (G2, G3) ----------------------------------------------------------


@pytest.mark.parametrize("effort", list(EFFORT_MAPPING))
def test_each_jenny_effort_sends_the_mapped_level_and_budget(make_engine, effort) -> None:
    engine, sent = make_engine("think_medium.sse")
    wire_effort, budget = EFFORT_MAPPING[effort]

    # A max_tokens with room for the largest budget under Jenny's own guard share.
    _stream(engine, effort=effort, max_tokens=40_000)

    payload = sent[-1]
    assert payload["reasoning_effort"] == wire_effort
    if budget is None:
        assert "thinking_budget_tokens" not in payload
    else:
        assert payload["thinking_budget_tokens"] == budget


@pytest.mark.parametrize("effort", list(EFFORT_MAPPING))
def test_the_wire_never_carries_default_or_auto(make_engine, effort) -> None:
    engine, sent = make_engine("think_medium.sse")

    _stream(engine, effort=effort)

    payload = sent[-1]
    assert payload["reasoning_effort"] not in {"default", "auto"}
    kwargs = payload.get("chat_template_kwargs") or {}
    assert kwargs.get("reasoning_effort") not in {"default", "auto"}


@pytest.mark.parametrize("effort", ["minimal", "low", "medium", "high", "xhigh", None])
def test_every_thinking_request_carries_explicit_limits_with_headroom(make_engine, effort) -> None:
    engine, sent = make_engine("think_medium.sse")

    _stream(engine, effort=effort, max_tokens=2048)

    payload = sent[-1]
    # Thinking headroom covers Inkling as it does the Qwen3.8 contract (G3).
    assert payload["max_tokens"] == 2048 + PROFILE_HEADROOM
    assert isinstance(payload["thinking_budget_tokens"], int)
    assert isinstance(payload["reasoning_effort"], str)


def test_effort_none_sends_none_with_no_budget_and_no_thinking_kwargs(make_engine) -> None:
    engine, sent = make_engine("think_none.sse")

    items = _stream(engine, effort="none")

    payload = sent[-1]
    assert payload["reasoning_effort"] == "none"
    assert "thinking_budget_tokens" not in payload
    assert (payload.get("chat_template_kwargs") or {}).get("enable_thinking") is not True
    assert isinstance(payload["max_tokens"], int) and payload["max_tokens"] > 0
    assert _event_text(items, "content") == _recorded_deltas("think_none.sse", "content")


def test_a_cap_collapse_sends_none_and_no_budget(make_engine) -> None:
    # A 200-token window leaves Jenny's guard share under a useful think, so the cap turns
    # thinking off; the wire must then say none rather than keep the requested level.
    props = _fixture_json("props.json")
    props["default_generation_settings"]["n_ctx"] = 200
    engine, sent = make_engine("think_none.sse", props=props)

    _stream(engine, effort="high", max_tokens=64)

    payload = sent[-1]
    assert payload["reasoning_effort"] == "none"
    assert "thinking_budget_tokens" not in payload


# --- request hygiene (G12, G17, G18) ------------------------------------------------------------


def test_payload_has_no_strata_keys_known_roles_tool_ids_and_data_uris_only(make_engine) -> None:
    engine, sent = make_engine("think_none.sse")
    image = VisionImage("image/png", 1, 1, 1, b"synthetic-image")

    _drain(
        engine.stream(
            prompt="",
            max_tokens=256,
            reasoning_effort="none",
            messages=[
                {"role": "user", "content": "Weather in Paris?"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "call_0", "name": "get_weather", "arguments": {"city": "Paris"}}
                    ],
                },
                {"role": "tool", "tool_call_id": "call_0", "name": "get_weather", "content": "12C"},
                {"role": "developer", "content": "Never reaches the wire as developer."},
                {"role": "user", "content": "And this picture?", "images": [image]},
            ],
        )
    )

    payload = sent[-1]
    assert not [key for key in payload if key.startswith("strata_")]
    roles = {message["role"] for message in payload["messages"]}
    assert roles <= {"system", "user", "assistant", "tool"}
    assert all(m.get("tool_call_id") for m in payload["messages"] if m["role"] == "tool")
    urls = [
        part["image_url"]["url"]
        for message in payload["messages"]
        if isinstance(message.get("content"), list)
        for part in message["content"]
        if part.get("type") == "image_url"
    ]
    assert urls and all(url.startswith("data:") for url in urls)
    assert "logprobs" not in payload and "logit_bias" not in payload


# --- stream shapes --------------------------------------------------------------------------------


def test_streamed_tool_call_parses_to_one_call(make_engine) -> None:
    engine, sent = make_engine("tool_call.sse")

    _items, result = _drain(
        engine.stream_with_tools(
            prompt="",
            tools=[READ_FILE_TOOL],
            max_tokens=512,
            reasoning_effort="low",
            messages=[{"role": "user", "content": "Read notes.txt and tell me its first line."}],
        )
    )

    assert result.finish_reason == "tool_calls"
    assert [(call.tool_id, call.arguments) for call in result.tool_calls] == [
        ("read_file", {"path": "notes.txt"})
    ]
    assert sent[0]["stream_options"] == {"include_usage": True}


def test_no_answer_note_stays_visible_with_its_finish_reason(make_engine) -> None:
    engine, _sent = make_engine("no_answer_length.sse")

    _items, result = _drain(
        engine.stream_with_tools(
            prompt="",
            tools=[],
            max_tokens=64,
            reasoning_effort="high",
            messages=[{"role": "user", "content": "Prove it."}],
        )
    )

    assert result.content.startswith("[No answer: ")
    assert result.finish_reason == "length"


# --- JSON mode (G9) -------------------------------------------------------------------------------


def test_a_failed_json_mode_stream_is_retried_once_without_response_format(make_engine) -> None:
    engine, sent = make_engine("json_failed.sse", "json_ok.sse")

    _items, result = _drain(
        engine.stream_with_tools(
            prompt="",
            tools=[],
            max_tokens=256,
            reasoning_effort="none",
            messages=[{"role": "user", "content": "Title for this chat, as JSON."}],
            response_format=JSON_MODE,
        )
    )

    assert len(sent) == 2
    assert "response_format" in sent[0]
    assert "response_format" not in sent[1]
    assert result.content == '{"title":"Inception","year":2010}'
    # One failure is a per-request validation miss, not a capability answer.
    assert getattr(engine, "_json_response_format_unsupported", False) is False


def test_three_consecutive_json_mode_failures_turn_json_mode_off(make_engine) -> None:
    engine, sent = make_engine(*(["json_failed.sse", "json_ok.sse"] * 3), "json_ok.sse")

    for _ in range(4):
        _drain(
            engine.stream_with_tools(
                prompt="",
                tools=[],
                max_tokens=256,
                reasoning_effort="none",
                messages=[{"role": "user", "content": "Title, as JSON."}],
                response_format=JSON_MODE,
            )
        )

    assert ["response_format" in payload for payload in sent] == [
        True, False, True, False, True, False, False,
    ]
    assert engine._json_response_format_unsupported is True


def test_a_nonstream_502_structured_output_failed_is_retried_without_response_format(
    make_engine, monkeypatch
) -> None:
    engine, _sent = make_engine()
    recorded = _fixture_json("errors.json")["structured_output_failed"]
    failure = _response_error(
        "openai-compatible",
        httpx.Response(
            recorded["status"],
            request=httpx.Request("POST", f"{BASE_URL}/chat/completions"),
            json=recorded["body"],
        ),
    )
    posted: list[dict[str, Any]] = []
    ok = {"choices": [{"message": {"content": '{"title": "x"}'}, "finish_reason": "stop"}]}

    def post(_path: str, payload: dict[str, Any], **_kwargs: Any) -> Any:
        posted.append(dict(payload))
        if len(posted) == 1:
            raise failure
        return ok

    monkeypatch.setattr(engine._service, "post_json", post)
    result = engine.generate_with_tools(
        "Title, as JSON.", tools=[], max_tokens=256, reasoning_effort="none",
        response_format=JSON_MODE,
    )

    assert result.content == '{"title": "x"}'
    assert ["response_format" in payload for payload in posted] == [True, False]
    assert getattr(engine, "_json_response_format_unsupported", False) is False


# --- loading and errors (G9, G6) ------------------------------------------------------------------


def test_an_empty_catalog_while_health_says_loading_is_a_named_loading_error(make_engine) -> None:
    engine, _sent = make_engine(
        models="v1_models_loading.json", health="health_loading.json", load=False
    )

    with pytest.raises(EngineConnectionError, match="still loading"):
        engine.load_model(MODEL_ID)


def test_an_empty_catalog_on_a_loaded_server_stays_not_serving(make_engine) -> None:
    engine, _sent = make_engine(models="v1_models_loading.json", health="health.json", load=False)

    with pytest.raises(EngineConnectionError, match="not serving"):
        engine.load_model(MODEL_ID)


@pytest.mark.parametrize(
    ("case", "classification", "retryable"),
    [
        ("model_not_found", "invalid_model", False),
        ("logprobs", "client_error", False),
        # Recorded overflow: the prompt alone leaves no room, so compaction recovers it.
        ("context_overflow", "prompt_too_long", False),
        ("admission_full", "rate_limit", True),
        ("engine_starting", "server_error", True),
    ],
)
def test_strata_error_bodies_classify(case: str, classification: str, retryable: bool) -> None:
    recorded = _fixture_json("errors.json")[case]
    response = httpx.Response(
        recorded["status"],
        request=httpx.Request("POST", f"{BASE_URL}/chat/completions"),
        json=recorded["body"],
    )

    error = _response_error("openai-compatible", response)

    assert error.classification == classification
    assert error.retryable is retryable


def test_null_timings_after_a_stopped_stream_parse_cleanly(make_engine) -> None:
    # Recorded: the request right after a client Stop carries null clocks in `timings`.
    engine, _sent = make_engine("after_stop_null_timings.sse")

    items, result = _drain(
        engine.stream_with_tools(
            prompt="", tools=[], max_tokens=64, reasoning_effort="none",
            messages=[{"role": "user", "content": "Say ok."}],
        )
    )

    assert result.finish_reason == "stop"
    assert result.content == _recorded_deltas("after_stop_null_timings.sse", "content")
