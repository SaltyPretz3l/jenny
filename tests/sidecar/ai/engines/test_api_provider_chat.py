"""Replay hand-written provider streams through ``ApiProviderChatEngine`` (row 78 S1).

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

from sidecar.ai.config_models import RuntimeConfig
from sidecar.ai.engines.api_provider_chat import ApiProviderChatEngine
from sidecar.ai.engines.provider_descriptor_v6 import ProviderDescriptorError
from sidecar.ai.engines.provider_http import ProviderHttpError, is_retryable_http_status
from sidecar.ai.error_codes import CMP_CLOUD_HTTP_ERROR, CMP_CLOUD_RATE_LIMITED
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
)
from sidecar.ai.tools.models import StreamingEvent
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle

FIXTURES = Path(__file__).parent / "fixtures" / "api_provider"
KEY = "sk-test-0123456789abcdefXYZ"
MODEL = "api-provider/openrouter/openai/gpt-6-luna"
WIRE_MODEL = "openai/gpt-6-luna"
ENDPOINT = "https://openrouter.ai/api/v1"
WEATHER_TOOL = {
    "name": "get_weather",
    "description": "Get the current weather for a city.",
    "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}


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


def _limits(**overrides: Any) -> dict[str, Any]:
    limits: dict[str, Any] = {
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


@pytest.fixture
def make_engine() -> Iterator[Callable[..., ApiProviderChatEngine]]:
    built: list[ApiProviderChatEngine] = []

    def _make(
        handler: Handler,
        *,
        descriptor: dict[str, Any] | None = None,
        limits: dict[str, Any] | None = None,
        load: bool = True,
    ) -> ApiProviderChatEngine:
        engine = ApiProviderChatEngine(
            descriptor=descriptor or _descriptor(),
            api_key=KEY,
            limits=limits or _limits(),
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
            wire_prefix = f"api-provider/{(descriptor or _descriptor())['provider_id']}/"
            engine.load_model(wire_prefix + WIRE_MODEL)
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


def _done(items: list[Any]) -> StreamingEvent:
    done = [item for item in items if isinstance(item, StreamingEvent) and item.kind == "done"]
    assert len(done) == 1
    return done[0]


def _replay(name: str, sent: list[httpx.Request] | None = None) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        if sent is not None:
            sent.append(request)
        return _sse(request, name)

    return handler


# -- streaming behaviour ----------------------------------------------------


def test_text_stream_content_done_and_usage(make_engine) -> None:
    engine = make_engine(_replay("text_usage.sse"))

    items = list(engine.stream("hi", max_tokens=256))

    assert _text(items, "content") == "Hello, world."
    done = _done(items)
    assert done.finish_reason == "stop"
    assert done.usage is not None
    assert (done.usage.input_tokens, done.usage.output_tokens) == (42, 7)
    assert done.usage.raw_usage["prompt_tokens_details"]["cached_tokens"] == 30
    assert done.usage.provider == "api-provider"
    assert done.usage.model == MODEL


def test_text_stream_with_tools_returns_result_usage(make_engine) -> None:
    engine = make_engine(_replay("text_usage.sse"))

    items, result = _drain(engine.stream_with_tools("hi", [WEATHER_TOOL], max_tokens=256))

    assert result.content == "Hello, world."
    assert result.tool_calls == ()
    assert (result.usage.input_tokens, result.usage.output_tokens) == (42, 7)
    assert _done(items).finish_reason == "stop"


@pytest.mark.parametrize("name", ["reasoning_content.sse", "reasoning_openrouter.sse"])
def test_reasoning_deltas_become_thinking_events(make_engine, name: str) -> None:
    engine = make_engine(_replay(name))

    items = list(engine.stream("hi", max_tokens=256))

    assert _text(items, "thinking") in {"Let me think.", "Weigh options."}
    assert _text(items, "content") in {"Answer.", "Done."}


def test_reasoning_deltas_are_dropped_when_the_model_does_not_reason(make_engine) -> None:
    engine = make_engine(_replay("reasoning_content.sse"), limits=_limits(reasoning=False))

    items = list(engine.stream("hi", max_tokens=256))

    assert _text(items, "thinking") == ""
    assert _text(items, "content") == "Answer."
    assert engine.capabilities["thinking"] is False


def test_parallel_tool_calls_assemble_split_arguments(make_engine) -> None:
    engine = make_engine(_replay("parallel_tool_calls.sse"))

    items, result = _drain(engine.stream_with_tools("weather?", [WEATHER_TOOL], max_tokens=256))

    calls = [(call.tool_id, call.arguments) for call in result.tool_calls]
    assert calls == [
        ("get_weather", {"city": "Paris"}),
        ("get_weather", {"city": "Rome"}),
    ]
    assert result.finish_reason == "tool_calls"
    assert _done(items).finish_reason == "tool_calls"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("inband_error.sse", {FINISH_REASON_PROVIDER_ERROR}),
        ("cut_midstream.sse", {FINISH_REASON_INCOMPLETE}),
        # OpenRouter's real in-band frame carries no ``object`` marker: it must
        # still never read as a clean stop.
        ("inband_error_openrouter.sse", {FINISH_REASON_PROVIDER_ERROR}),
    ],
)
def test_mid_stream_failures_are_not_a_clean_stop(make_engine, name: str, expected: set) -> None:
    engine = make_engine(_replay(name))

    stream_items = list(engine.stream("hi", max_tokens=256))
    tool_items, result = _drain(engine.stream_with_tools("hi", [WEATHER_TOOL], max_tokens=256))

    assert _done(stream_items).finish_reason in expected
    assert _done(tool_items).finish_reason in expected
    assert result.finish_reason in expected


class _CancellingStream(httpx.SyncByteStream):
    def __init__(self, handle: TurnCancellationHandle) -> None:
        self._handle = handle

    def __iter__(self) -> Iterator[bytes]:
        first = {"choices": [{"index": 0, "delta": {"content": "first"}}]}
        yield f"data: {json.dumps(first)}\n\n".encode()
        self._handle.cancel(reason="test_cancel")
        late = {"choices": [{"index": 0, "delta": {"content": "late"}}]}
        yield f"data: {json.dumps(late)}\n\n".encode()


@pytest.mark.parametrize("with_tools", [False, True])
def test_cancel_after_first_chunk_stops_the_stream(make_engine, with_tools: bool) -> None:
    handle = TurnCancellationHandle(request_id="req-api-provider-cancel")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "text/event-stream"},
            stream=_CancellingStream(handle),
        )

    engine = make_engine(handler)
    seen: list[Any] = []

    def run() -> None:
        if with_tools:
            generator = engine.stream_with_tools(
                "go", [WEATHER_TOOL], max_tokens=64, cancel_handle=handle
            )
        else:
            generator = engine.stream("go", max_tokens=64, cancel_handle=handle)
        for item in generator:
            seen.append(item)

    with pytest.raises(TerminalChatStateError):
        run()

    assert "late" not in _text(seen, "content")
    # The pooled client survives a cancel: only the response was closed.
    assert engine._service._client.is_closed is False


# -- error mapping ----------------------------------------------------------


def _status_handler(
    status: int, sent: list[httpx.Request], headers: dict[str, str] | None = None
) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if request.url.host != "openrouter.ai":
            raise AssertionError("a redirect target was requested")
        body = json.dumps({"error": {"message": f"provider says {KEY} is wrong"}}).encode()
        return httpx.Response(
            status,
            request=request,
            headers={"content-type": "application/json", **(headers or {})},
            content=body,
        )

    return handler


@pytest.mark.parametrize("with_tools", [False, True])
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
    with_tools: bool,
    status: int,
    headers: dict[str, str],
    classification: str,
    code: str,
    retry_after: float | None,
) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_status_handler(status, sent, headers))

    with pytest.raises(ProviderHttpError) as caught:
        if with_tools:
            _drain(engine.stream_with_tools("hi", [WEATHER_TOOL], max_tokens=64))
        else:
            list(engine.stream("hi", max_tokens=64))

    error = caught.value
    assert error.status_code == status
    assert error.classification == classification
    assert error.code == code
    assert error.retryable is is_retryable_http_status(status)
    assert error.retry_after_seconds == retry_after
    assert error.provider == "api-provider"
    assert not _leaks(error, error.args, error.body, repr(error))
    assert len(sent) == 1


@pytest.mark.parametrize("with_tools", [False, True])
def test_redirect_is_refused_and_never_followed(make_engine, with_tools: bool) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(
        _status_handler(307, sent, {"location": "https://attacker.example/v1/chat/completions"})
    )

    assert engine._service._client.follow_redirects is False
    with pytest.raises(ProviderHttpError) as caught:
        if with_tools:
            _drain(engine.stream_with_tools("hi", [WEATHER_TOOL], max_tokens=64))
        else:
            list(engine.stream("hi", max_tokens=64))

    error = caught.value
    assert error.classification == "redirect_refused"
    assert error.status_code == 307
    assert error.retryable is False
    assert [request.url.host for request in sent] == ["openrouter.ai"]
    assert not _leaks(error, error.args, error.body)


# -- request shape ----------------------------------------------------------


def test_request_shape_bearer_url_and_body(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(
        _replay("text_usage.sse", sent),
        descriptor=_descriptor(
            headers=[{"name": "X-Title", "value": "Jenny"}],
        ),
    )

    list(engine.stream("hi", max_tokens=300, temperature=0.9, reasoning_effort="xhigh"))

    request = sent[0]
    assert request.method == "POST"
    assert str(request.url) == f"{ENDPOINT}/chat/completions"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert request.headers["x-title"] == "Jenny"
    body = json.loads(request.content)
    assert body["model"] == WIRE_MODEL
    assert body["max_tokens"] == 300
    assert body["stream"] is True
    assert body["stream_options"] == {"include_usage": True}
    assert body["reasoning_effort"] == "high"
    for sampler in ("temperature", "top_p", "top_k", "min_p", "presence_penalty"):
        assert sampler not in body
    assert "repetition_penalty" not in body and "repeat_penalty" not in body
    assert "return_progress" not in body and "timings_per_token" not in body


def test_request_shape_header_profile_and_verbatim_endpoint(make_engine) -> None:
    sent: list[httpx.Request] = []
    endpoint = "https://generativelanguage.googleapis.com/v1beta/openai"
    engine = make_engine(
        _replay("text_usage.sse", sent),
        descriptor=_descriptor(
            provider_id="google-ai",
            endpoint=endpoint,
            auth_profile="api_key_header",
            token_limit_field="max_completion_tokens",
        ),
    )

    list(engine.stream("hi", max_tokens=300))

    request = sent[0]
    assert str(request.url) == f"{endpoint}/chat/completions"
    assert request.headers["x-api-key"] == KEY
    assert "authorization" not in request.headers
    assert engine._base_url == endpoint
    body = json.loads(request.content)
    assert body["max_completion_tokens"] == 300
    assert "max_tokens" not in body
    assert body["model"] == WIRE_MODEL


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
        (True, "default", None),
        (True, "none", None),
        (False, "high", None),
    ],
)
def test_reasoning_effort_only_when_the_model_reasons(
    make_engine, reasoning: bool, effort: str | None, expected: str | None
) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent), limits=_limits(reasoning=reasoning))

    list(engine.stream("hi", max_tokens=64, reasoning_effort=effort))

    body = json.loads(sent[0].content)
    assert body.get("reasoning_effort") == expected


def test_tool_stream_request_carries_tools_and_no_sampler(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("parallel_tool_calls.sse", sent))

    _drain(engine.stream_with_tools("weather?", [WEATHER_TOOL], max_tokens=64))

    body = json.loads(sent[0].content)
    assert body["tools"][0]["function"]["name"] == "get_weather"
    assert "temperature" not in body
    assert request_paths(sent) == ["/api/v1/chat/completions"]


def request_paths(sent: list[httpx.Request]) -> list[str]:
    return [request.url.path for request in sent]


def test_json_response_format_is_json_object(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent))

    class _Json:
        is_json = True
        json_schema = None

    list(engine.stream("hi", max_tokens=64, response_format=_Json()))

    assert json.loads(sent[0].content)["response_format"] == {"type": "json_object"}


# -- model identity, limits, secrecy ---------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "gpt-6-luna",
        "openrouter/openai/gpt-6-luna",
        "api-provider/other/openai/gpt-6-luna",
        "api-provider/openrouter/",
        "api-provider/openrouter",
        "api-provider/openrouter/ spaced",
        "api-provider/openrouter/bad\nid",
        "chatgpt/gpt-5.5",
        "",
    ],
)
def test_load_model_rejects_foreign_or_malformed_ids_without_network(
    make_engine, name: str
) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent), load=False)

    with pytest.raises(ValueError):
        engine.load_model(name)

    assert sent == []
    assert engine.model_name is None
    assert engine._ready is False


def test_load_model_binds_namespaced_name_and_limits_without_network(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(
        _replay("text_usage.sse", sent),
        limits=_limits(tools=False, vision=True, reasoning=False),
    )

    assert sent == []
    assert engine.model_name == MODEL
    assert engine._wire_model == WIRE_MODEL
    assert engine.supports_tool_calling is False
    assert engine.supported_modalities.__len__() == 2
    assert engine.capabilities["thinking"] is False
    assert engine._local_runtime_capability_sources["tool_calling"] == "preset"
    assert engine._local_runtime_capability_sources["text"] == "engine_default"
    engine.unload_model()
    assert engine.model_name is None and engine._ready is False


def test_limits_drive_context_and_output_budgets(make_engine) -> None:
    engine = make_engine(_replay("text_usage.sse"))
    assert engine.get_model_context_length() == 128_000
    assert engine.get_inference_budget_context_length() == 128_000
    assert engine.get_model_max_output_tokens() == 8_192
    assert engine.supports_tool_calling is True

    small = make_engine(
        _replay("text_usage.sse"),
        limits=_limits(context_length=16_000, max_output_tokens=16_000),
    )
    assert small.get_model_max_output_tokens() == 8_000

    huge = make_engine(
        _replay("text_usage.sse"),
        limits=_limits(context_length=1_000_000, max_output_tokens=500_000),
    )
    assert huge.get_model_max_output_tokens() == 32_768


def test_engine_never_probes_local_endpoints(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent))

    list(engine.stream("hi", max_tokens=64))
    _drain(engine.stream_with_tools("hi", [WEATHER_TOOL], max_tokens=64))

    assert request_paths(sent) == ["/api/v1/chat/completions"] * 2


def test_secret_never_reaches_repr(make_engine) -> None:
    engine = make_engine(_replay("text_usage.sse"))

    assert not _leaks(repr(engine), str(engine))
    assert not _leaks(repr(RuntimeConfig(api_provider_key=KEY)))
    assert not _leaks(repr(RuntimeConfig(api_provider_key=KEY, engine_type="api-provider")))


def test_construction_refuses_unadmitted_inputs() -> None:
    with pytest.raises(ProviderDescriptorError):
        ApiProviderChatEngine(
            descriptor=_descriptor(transport="openai_responses_v1"), api_key=KEY, limits=_limits()
        )
    with pytest.raises(ProviderDescriptorError):
        ApiProviderChatEngine(descriptor=_descriptor(), api_key="", limits=_limits())
    with pytest.raises(ProviderDescriptorError):
        ApiProviderChatEngine(
            descriptor=_descriptor(endpoint="http://api.example.com/v1"),
            api_key=KEY,
            limits=_limits(),
            resolve_local=lambda _host, _port: False,
        )
    with pytest.raises(ProviderDescriptorError):
        ApiProviderChatEngine(descriptor=_descriptor(), api_key=KEY, limits={"context_length": 1})


def test_auth_none_profile_sends_no_key() -> None:
    engine = ApiProviderChatEngine(
        descriptor=_descriptor(auth_profile="none"), api_key=KEY, limits=_limits()
    )
    try:
        assert "authorization" not in engine._service._client.headers
        assert "x-api-key" not in engine._service._client.headers
    finally:
        engine.close()
