"""Replay hand-written Responses streams through ``ApiProviderResponsesEngine`` (row 78 P3b).

No live network: every request is answered by an ``httpx.MockTransport`` installed
on the engine's own pooled client, so the real header, URL and body the engine
builds are what the handler sees. The key is a fake test value; assertions use
``_leaks`` so a failure never prints it.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from sidecar.ai.engines.api_provider_responses import ApiProviderResponsesEngine
from sidecar.ai.engines.provider_descriptor_v6 import ProviderDescriptorError
from sidecar.ai.engines.provider_http import ProviderHttpError, is_retryable_http_status
from sidecar.ai.error_codes import CMP_CLOUD_HTTP_ERROR, CMP_CLOUD_RATE_LIMITED
from sidecar.ai.exceptions import GenerationError
from sidecar.ai.tools.models import StreamingEvent
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle

FIXTURES = Path(__file__).parent / "fixtures" / "api_provider_responses"
KEY = "sk-test-0123456789abcdefXYZ"
MODEL = "api-provider/openai-api/gpt-6-luna"
WIRE_MODEL = "gpt-6-luna"
ENDPOINT = "https://api.openai.com/v1"
WEATHER_TOOL = {
    "name": "get_weather",
    "description": "Get the current weather for a city.",
    "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}
CALL_HISTORY: list[dict[str, Any]] = [
    {"role": "user", "content": "weather?"},
    {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"name": "get_weather", "arguments": {"city": "Paris"}, "call_id": "call_1"}],
    },
    {"role": "tool", "tool_call_id": "call_1", "content": "sunny"},
]


def _descriptor(**overrides: Any) -> dict[str, Any]:
    descriptor: dict[str, Any] = {
        "descriptor_schema_version": 6,
        "provider_id": "openai-api",
        "label": "OpenAI",
        "endpoint": ENDPOINT,
        "transport": "openai_responses_v1",
        "auth_profile": "api_key_bearer",
        "token_limit_field": "max_completion_tokens",
    }
    descriptor.update(overrides)
    return descriptor


def _limits(**overrides: Any) -> dict[str, Any]:
    limits: dict[str, Any] = {
        "context_length": 400_000,
        "max_output_tokens": 128_000,
        "tools": True,
        "vision": False,
        "reasoning": True,
        "sources": {
            key: "preset"
            for key in ("context_length", "max_output_tokens", "tools", "vision", "reasoning")
        },
    }
    limits.update(overrides)
    return limits


def _leaks(*values: Any) -> bool:
    """True when the key appears in any value (never echoes the key itself)."""
    return any(KEY in str(value) for value in values)


def _sse(request: httpx.Request, name: str) -> httpx.Response:
    return httpx.Response(
        200,
        request=request,
        headers={"content-type": "text/event-stream"},
        stream=httpx.ByteStream((FIXTURES / name).read_bytes()),
    )


Handler = Callable[[httpx.Request], httpx.Response]


def _replay(*names: str, sent: list[httpx.Request] | None = None) -> Handler:
    """Answer request N with fixture N (the last fixture repeats)."""
    served = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal served
        if sent is not None:
            sent.append(request)
        name = names[min(served, len(names) - 1)]
        served += 1
        return _sse(request, name)

    return handler


@pytest.fixture
def make_engine() -> Iterator[Callable[..., ApiProviderResponsesEngine]]:
    built: list[ApiProviderResponsesEngine] = []

    def _make(
        handler: Handler,
        *,
        descriptor: dict[str, Any] | None = None,
        limits: dict[str, Any] | None = None,
        load: bool = True,
    ) -> ApiProviderResponsesEngine:
        admitted = descriptor or _descriptor()
        engine = ApiProviderResponsesEngine(
            descriptor=admitted, api_key=KEY, limits=limits or _limits()
        )
        old = engine._service._client
        engine._service._client = httpx.Client(
            base_url=old.base_url,
            headers=old.headers,
            timeout=old.timeout,
            transport=httpx.MockTransport(handler),
        )
        old.close()
        built.append(engine)
        if load:
            engine.load_model(f"api-provider/{admitted['provider_id']}/{WIRE_MODEL}")
        return engine

    yield _make
    for engine in built:
        with contextlib.suppress(Exception):
            engine.close()


def _drain(generator: Any) -> tuple[list[Any], Any]:
    items: list[Any] = []
    while True:
        try:
            items.append(next(generator))
        except StopIteration as stop:
            return items, stop.value


def _text(items: list[Any], kind: str) -> str:
    return "".join(
        item.text for item in items if isinstance(item, StreamingEvent) and item.kind == kind
    )


def _body(request: httpx.Request) -> dict[str, Any]:
    return json.loads(request.content)


class _Store:
    """Minimal diagnostics store: records the usage the engine reports."""

    def __init__(self) -> None:
        self.usage: list[dict[str, Any]] = []

    def record_provider_usage(self, **kwargs: Any) -> None:
        self.usage.append(kwargs)

    def __getattr__(self, name: str) -> Callable[..., None]:
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda **_kwargs: None


# -- streaming behaviour ----------------------------------------------------


def test_text_stream_with_usage_and_cached_tokens(make_engine) -> None:
    engine = make_engine(_replay("text_usage.sse"))
    store = _Store()
    engine.begin_request_context(request_id="req-text", diagnostics_store=store)
    try:
        items, result = _drain(engine.stream_with_tools("hi", [], max_tokens=256))
    finally:
        engine.clear_request_context(request_id="req-text")

    assert _text(items, "content") == "Hello, world."
    assert result.content == "Hello, world."
    assert result.finish_reason == "stop"
    assert (result.usage.input_tokens, result.usage.output_tokens) == (42, 7)
    assert result.usage.total_tokens == 49
    assert result.usage.provider == "api-provider"
    assert result.usage.model == MODEL
    assert len(store.usage) == 1
    assert store.usage[0]["cached_tokens"] == 30
    assert store.usage[0]["provider_label"] == "api-provider"


def test_stream_and_generate_share_the_same_transport(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent=sent))

    assert _text(list(engine.stream("hi", max_tokens=64)), "content") == "Hello, world."
    assert engine.generate("hi", max_tokens=64) == "Hello, world."
    assert [request.url.path for request in sent] == ["/v1/responses"] * 2


def test_reasoning_item_precedes_function_call_and_summary_is_thinking(make_engine) -> None:
    engine = make_engine(_replay("reasoning_function_call.sse"))

    items, result = _drain(engine.stream_with_tools("weather?", [WEATHER_TOOL], max_tokens=256))

    assert _text(items, "thinking") == "Check the weather."
    assert [(call.call_id, call.tool_id, call.arguments) for call in result.tool_calls] == [
        ("call_1", "get_weather", {"city": "Paris"})
    ]
    assert result.finish_reason == "tool_calls"
    assert engine._reasoning_snapshot()["call_1"]["encrypted_content"] == "enc-blob-one"


def test_parallel_function_calls_share_one_reasoning_item(make_engine) -> None:
    engine = make_engine(_replay("parallel_function_calls.sse"))

    _items, result = _drain(engine.stream_with_tools("weather?", [WEATHER_TOOL], max_tokens=256))

    assert [(call.call_id, call.arguments) for call in result.tool_calls] == [
        ("call_a", {"city": "Paris"}),
        ("call_b", {"city": "Rome"}),
    ]
    assert result.finish_reason == "tool_calls"
    assert engine._reasoning_snapshot()["call_a"]["id"] == "rs_p"


def test_incomplete_for_output_cap_returns_partial_with_length(make_engine) -> None:
    engine = make_engine(_replay("incomplete_length.sse"))

    _items, result = _drain(engine.stream_with_tools("hi", [], max_tokens=64))

    assert result.content == "cut off"
    assert result.finish_reason == "length"


# -- stateless reasoning replay ---------------------------------------------


def test_reasoning_is_replayed_for_the_same_request_only(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(
        _replay("reasoning_function_call.sse", "text_usage.sse", "text_usage.sse", sent=sent)
    )

    engine.begin_request_context(request_id="child-1", agent_depth=1)
    try:
        _drain(engine.stream_with_tools("weather?", [WEATHER_TOOL], max_tokens=64))
        _drain(engine.stream_with_tools("", [WEATHER_TOOL], max_tokens=64, messages=CALL_HISTORY))
    finally:
        engine.clear_request_context(request_id="child-1")
    engine.begin_request_context(request_id="child-2", agent_depth=1)
    try:
        _drain(engine.stream_with_tools("", [WEATHER_TOOL], max_tokens=64, messages=CALL_HISTORY))
    finally:
        engine.clear_request_context(request_id="child-2")

    replayed = _body(sent[1])["input"]
    call_index = next(i for i, item in enumerate(replayed) if item["type"] == "function_call")
    assert replayed[call_index - 1]["type"] == "reasoning"
    assert replayed[call_index - 1]["encrypted_content"] == "enc-blob-one"
    foreign = _body(sent[2])["input"]
    assert [item["type"] for item in foreign] == ["message", "function_call", "function_call_output"]
    engine.release_request_state("child-1")
    assert engine._reasoning_snapshot("child-1") == {}


def test_primary_turn_reasoning_is_replayed_across_calls(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("reasoning_function_call.sse", "text_usage.sse", sent=sent))

    _drain(engine.stream_with_tools("weather?", [WEATHER_TOOL], max_tokens=64))
    _drain(engine.stream_with_tools("", [WEATHER_TOOL], max_tokens=64, messages=CALL_HISTORY))

    types = [item["type"] for item in _body(sent[1])["input"]]
    assert types == ["message", "reasoning", "function_call", "function_call_output"]


# -- request shape ----------------------------------------------------------


def test_request_shape_bearer_only_url_and_body(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(
        _replay("text_usage.sse", sent=sent),
        descriptor=_descriptor(headers=[{"name": "X-Title", "value": "Jenny"}]),
    )

    _drain(
        engine.stream_with_tools(
            "hi",
            [WEATHER_TOOL],
            max_tokens=300,
            temperature=0.9,
            reasoning_effort="xhigh",
            system="Be brief.",
        )
    )

    request = sent[0]
    assert request.method == "POST"
    assert str(request.url) == f"{ENDPOINT}/responses"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert request.headers["x-title"] == "Jenny"
    assert request.headers["accept"] == "text/event-stream"
    for forbidden in ("chatgpt-account-id", "originator", "x-api-key"):
        assert forbidden not in request.headers
    assert request.headers["user-agent"] != "jenny"
    body = _body(request)
    assert body["model"] == WIRE_MODEL
    assert body["instructions"] == "Be brief."
    assert body["stream"] is True
    assert body["store"] is False
    assert body["include"] == ["reasoning.encrypted_content"]
    assert body["reasoning"] == {"summary": "auto", "effort": "high"}
    assert body["max_output_tokens"] == 300
    assert body["tools"][0]["name"] == "get_weather"
    assert body["tool_choice"] == "auto"
    for sampler in ("temperature", "top_p", "top_k", "presence_penalty", "max_tokens"):
        assert sampler not in body


def test_request_without_tools_omits_tool_fields(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent=sent))

    list(engine.stream("hi", max_tokens=64))

    body = _body(sent[0])
    for field in ("tools", "tool_choice", "parallel_tool_calls", "instructions"):
        assert field not in body


def test_verbatim_endpoint_with_path(make_engine) -> None:
    sent: list[httpx.Request] = []
    endpoint = "https://example.openai.azure.com/openai/v1"
    engine = make_engine(
        _replay("text_usage.sse", sent=sent),
        descriptor=_descriptor(provider_id="azure-x", endpoint=endpoint),
    )

    list(engine.stream("hi", max_tokens=64))

    assert str(sent[0].url) == f"{endpoint}/responses"


@pytest.mark.parametrize(
    ("reasoning", "effort", "expected"),
    [
        (True, "minimal", "minimal"),
        (True, "low", "low"),
        (True, "medium", "medium"),
        (True, "high", "high"),
        (True, "xhigh", "high"),
        (True, "max", "high"),
        (True, "HIGH", "high"),
        (True, None, None),
        (True, "", None),
        (True, "none", None),
        (True, "default", None),
    ],
)
def test_reasoning_effort_values(make_engine, reasoning: bool, effort: str | None, expected) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent=sent), limits=_limits(reasoning=reasoning))

    list(engine.stream("hi", max_tokens=64, reasoning_effort=effort))

    assert _body(sent[0])["reasoning"].get("effort") == expected


def test_non_reasoning_model_sends_no_reasoning_fields(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent=sent), limits=_limits(reasoning=False))

    list(engine.stream("hi", max_tokens=64, reasoning_effort="high"))

    body = _body(sent[0])
    assert "reasoning" not in body
    assert "include" not in body
    assert body["store"] is False
    assert engine.capabilities["thinking"] is False


@pytest.mark.parametrize(("asked", "sent_cap"), [(0, 32_768), (4, 16), (20_000, 20_000), (900_000, 32_768)])
def test_output_cap_follows_the_limits(make_engine, asked: int, sent_cap: int) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(
        _replay("text_usage.sse", sent=sent),
        limits=_limits(context_length=1_000_000, max_output_tokens=128_000),
    )

    list(engine.stream("hi", max_tokens=asked))

    assert _body(sent[0])["max_output_tokens"] == sent_cap


# -- error mapping ----------------------------------------------------------


def _status_handler(
    status: int, sent: list[httpx.Request], headers: dict[str, str] | None = None
) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if request.url.host != "api.openai.com":
            raise AssertionError("a redirect target was requested")
        body = json.dumps({"error": {"message": f"provider says {KEY} is wrong"}}).encode()
        return httpx.Response(
            status,
            request=request,
            headers={"content-type": "application/json", **(headers or {})},
            content=body,
        )

    return handler


@pytest.mark.parametrize(
    ("status", "headers", "classification", "code", "retry_after"),
    [
        (401, {}, "invalid_api_key", CMP_CLOUD_HTTP_ERROR, None),
        (403, {}, "client_error", CMP_CLOUD_HTTP_ERROR, None),
        (429, {"retry-after": "7"}, "rate_limit", CMP_CLOUD_RATE_LIMITED, 7),
        (500, {}, "server_error", CMP_CLOUD_HTTP_ERROR, None),
    ],
)
def test_initial_status_maps_to_typed_provider_errors(  # noqa: PLR0913
    make_engine,
    status: int,
    headers: dict[str, str],
    classification: str,
    code: str,
    retry_after: float | None,
) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_status_handler(status, sent, headers))

    with pytest.raises(ProviderHttpError) as caught:
        _drain(engine.stream_with_tools("hi", [WEATHER_TOOL], max_tokens=64))

    error = caught.value
    assert error.status_code == status
    assert error.classification == classification
    assert error.code == code
    assert error.retryable is is_retryable_http_status(status)
    assert error.retry_after_seconds == retry_after
    assert error.provider == "api-provider"
    assert not _leaks(error, error.args, error.body, repr(error))
    assert len(sent) == 1


def test_redirect_is_refused_and_never_followed(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(
        _status_handler(307, sent, {"location": "https://attacker.example/v1/responses"})
    )

    assert engine._service._client.follow_redirects is False
    with pytest.raises(ProviderHttpError) as caught:
        list(engine.stream("hi", max_tokens=64))

    error = caught.value
    assert error.classification == "redirect_refused"
    assert error.status_code == 307
    assert error.retryable is False
    assert [request.url.host for request in sent] == ["api.openai.com"]
    assert not _leaks(error, error.args, error.body, repr(error))


def test_in_band_quota_failure_is_a_rate_limit_without_provider_text(make_engine) -> None:
    engine = make_engine(_replay("failed_quota.sse"))

    with pytest.raises(ProviderHttpError) as caught:
        _drain(engine.stream_with_tools("hi", [], max_tokens=64))

    assert caught.value.classification == "rate_limit"
    # The shared Responses stream is ChatGPT's; the error names the user's provider.
    assert caught.value.provider == "api-provider"
    assert "ChatGPT" not in str(caught.value)
    assert not _leaks(caught.value, caught.value.args, caught.value.body)


@pytest.mark.parametrize("name", ["failed_unknown.sse", "error_event.sse", "cut_midstream.sse"])
def test_other_stream_failures_are_not_a_clean_stop(make_engine, name: str) -> None:
    engine = make_engine(_replay(name))

    with pytest.raises(GenerationError) as caught:
        _drain(engine.stream_with_tools("hi", [], max_tokens=64))

    assert not _leaks(caught.value, caught.value.args)
    assert "ChatGPT" not in str(caught.value)
    # The rebrand keeps the error's own fields and one code prefix, never "[code] [code] ...".
    assert not caught.value.message.startswith("[")
    assert str(caught.value).count(f"[{caught.value.code}]") == 1
    with pytest.raises(GenerationError) as streamed:
        list(engine.stream("hi", max_tokens=64))
    assert "ChatGPT" not in str(streamed.value)


class _CancellingStream(httpx.SyncByteStream):
    def __init__(self, handle: TurnCancellationHandle) -> None:
        self._handle = handle

    def __iter__(self) -> Iterator[bytes]:
        first = {"type": "response.output_text.delta", "delta": "first"}
        yield f"data: {json.dumps(first)}\n\n".encode()
        self._handle.cancel(reason="test_cancel")
        late = {"type": "response.output_text.delta", "delta": "late"}
        yield f"data: {json.dumps(late)}\n\n".encode()


@pytest.mark.parametrize("with_tools", [False, True])
def test_cancel_after_first_chunk_stops_the_stream(make_engine, with_tools: bool) -> None:
    handle = TurnCancellationHandle(request_id="req-responses-cancel")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "text/event-stream"},
            stream=_CancellingStream(handle),
        )

    engine = make_engine(handler)
    seen: list[Any] = []
    tools = [WEATHER_TOOL] if with_tools else []

    with pytest.raises(TerminalChatStateError):
        for item in engine.stream_with_tools("go", tools, max_tokens=64, cancel_handle=handle):
            seen.append(item)

    assert "late" not in _text(seen, "content")
    # The pooled client survives a cancel: only the response was closed.
    assert engine._service._client.is_closed is False


# -- admission, identity, secrecy ------------------------------------------


def test_construction_refuses_unadmitted_inputs() -> None:
    cases: list[dict[str, Any]] = [
        {"descriptor": _descriptor(transport="openai_chat_completions_v1")},
        {"descriptor": _descriptor(transport="anthropic_messages_v1")},
        {"descriptor": _descriptor(auth_profile="api_key_header")},
        {"descriptor": _descriptor(auth_profile="none")},
        {"api_key": ""},
        {"limits": {"context_length": 1}},
        {
            "descriptor": _descriptor(endpoint="http://api.example.com/v1"),
            "resolve_local": lambda _host, _port: False,
        },
    ]
    for override in cases:
        arguments: dict[str, Any] = {
            "descriptor": _descriptor(),
            "api_key": KEY,
            "limits": _limits(),
            **override,
        }
        with pytest.raises(ProviderDescriptorError) as caught:
            ApiProviderResponsesEngine(**arguments)
        assert not _leaks(caught.value, caught.value.args)


@pytest.mark.parametrize(
    "name",
    [
        "gpt-6-luna",
        "openai/gpt-6-luna",
        "api-provider/other/gpt-6-luna",
        "api-provider/openai-api/",
        "api-provider/openai-api",
        "api-provider/openai-api/ spaced",
        "api-provider/openai-api/bad\nid",
        "chatgpt/gpt-5.5",
        "",
    ],
)
def test_load_model_rejects_foreign_or_malformed_ids_without_network(make_engine, name: str) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent=sent), load=False)

    with pytest.raises(ValueError):
        engine.load_model(name)

    assert sent == []
    assert engine._wire_model is None
    assert not engine.model_name


def test_unloaded_engine_refuses_to_stream_without_network(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent=sent), load=False)

    with pytest.raises(GenerationError):
        list(engine.stream("hi", max_tokens=64))

    assert sent == []


def test_load_model_binds_name_capabilities_and_sources_without_network(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(
        _replay("text_usage.sse", sent=sent),
        limits=_limits(tools=False, vision=True, reasoning=False),
    )

    assert sent == []
    assert engine.model_name == MODEL
    assert engine._wire_model == WIRE_MODEL
    assert engine.supports_tool_calling is False
    assert len(engine.supported_modalities) == 2
    assert engine.capabilities["vision"] is True
    assert engine.capabilities["thinking"] is False
    assert engine._local_runtime_capability_sources["tool_calling"] == "preset"
    assert engine._local_runtime_capability_sources["thinking"] == "unsupported"
    engine.unload_model()
    assert not engine.model_name and engine._wire_model is None


def test_limits_drive_context_and_output_budgets(make_engine) -> None:
    engine = make_engine(_replay("text_usage.sse"))
    assert engine.get_model_context_length() == 400_000
    assert engine.get_model_max_output_tokens() == 32_768
    assert engine.supports_tool_calling is True
    assert engine.capabilities == {"text": True, "vision": False, "thinking": True}

    small = make_engine(
        _replay("text_usage.sse"),
        limits=_limits(context_length=16_000, max_output_tokens=16_000),
    )
    assert small.get_model_max_output_tokens() == 8_000


def test_engine_never_probes_other_endpoints(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent=sent))

    list(engine.stream("hi", max_tokens=64))

    assert [request.url.path for request in sent] == ["/v1/responses"]


def test_secret_never_reaches_repr(make_engine) -> None:
    engine = make_engine(_replay("text_usage.sse"))

    assert not _leaks(repr(engine), str(engine))
    assert "openai-api" in repr(engine)
    assert engine.MODEL_RESIDENCY == "remote"
