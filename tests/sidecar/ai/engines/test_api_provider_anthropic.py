"""Replay hand-written Anthropic Messages streams through ``ApiProviderAnthropicEngine`` (P3a).

No live network: every request is answered by an ``httpx.MockTransport`` installed on
the engine's own pooled client, so the real header, URL and body the engine builds are
what the handler sees. The key is a fake test value; assertions use ``_leaks`` so a
failure never prints it.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from sidecar.ai.engines.api_provider_anthropic import ApiProviderAnthropicEngine
from sidecar.ai.engines.api_provider_anthropic_wire import (
    MAX_REPLAY_BYTES,
    ThinkingReplayCache,
    build_messages,
    split_system,
)
from sidecar.ai.engines.provider_descriptor_v6 import ProviderDescriptorError
from sidecar.ai.engines.provider_http import ProviderHttpError, is_retryable_http_status
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.error_codes import CMP_CLOUD_HTTP_ERROR, CMP_CLOUD_RATE_LIMITED
from sidecar.ai.tools.models import StreamingEvent, ToolCallRequest
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle

FIXTURES = Path(__file__).parent / "fixtures" / "api_provider_anthropic"
KEY = "sk-ant-test-0123456789abcdefXYZ"
PROVIDER_ID = "claude-console"
WIRE_MODEL = "claude-test-5"
MODEL = f"api-provider/{PROVIDER_ID}/{WIRE_MODEL}"
ENDPOINT = "https://api.anthropic.com/v1"
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
        "provider_id": PROVIDER_ID,
        "label": "Claude Console",
        "endpoint": ENDPOINT,
        "transport": "anthropic_messages_v1",
        "auth_profile": "api_key_header",
    }
    descriptor.update(overrides)
    return descriptor


def _limits(**overrides: Any) -> dict[str, Any]:
    limits: dict[str, Any] = {
        "context_length": 200_000,
        "max_output_tokens": 16_000,
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
def make_engine() -> Iterator[Callable[..., ApiProviderAnthropicEngine]]:
    built: list[ApiProviderAnthropicEngine] = []

    def _make(
        handler: Handler,
        *,
        limits: dict[str, Any] | None = None,
        load: bool = True,
    ) -> ApiProviderAnthropicEngine:
        engine = ApiProviderAnthropicEngine(
            descriptor=_descriptor(), api_key=KEY, limits=limits or _limits()
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
            engine.load_model(MODEL)
        return engine

    yield _make
    for engine in built:
        with contextlib.suppress(Exception):
            engine.clear_request_context()
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


def _replay(name: str | list[str], sent: list[httpx.Request] | None = None) -> Handler:
    names = [name] if isinstance(name, str) else list(name)

    def handler(request: httpx.Request) -> httpx.Response:
        if sent is not None:
            sent.append(request)
        return _sse(request, names[min(len(sent or []) - 1, len(names) - 1)] if sent else names[0])

    return handler


def _body(request: httpx.Request) -> dict[str, Any]:
    return json.loads(request.content)  # type: ignore[no-any-return]


# -- streaming behaviour ----------------------------------------------------


def test_text_stream_content_done_and_usage(make_engine) -> None:
    engine = make_engine(_replay("text_usage.sse"))

    items = list(engine.stream("hi", max_tokens=256))

    assert _text(items, "content") == "Hello, world."
    done = _done(items)
    assert done.finish_reason == "stop"
    assert done.usage is not None
    # Whole prompt: 12 uncached + 5 cache-creation + 30 cache-read.
    assert (done.usage.input_tokens, done.usage.output_tokens) == (47, 7)
    assert done.usage.last_request_input_tokens == 47
    assert done.usage.raw_usage["cache_read_input_tokens"] == 30
    assert done.usage.raw_usage["cache_creation_input_tokens"] == 5
    assert done.usage.provider == "api-provider"
    assert done.usage.model == MODEL


def test_generate_and_generate_with_tools_drain_the_stream(make_engine) -> None:
    engine = make_engine(_replay("text_usage.sse"))

    assert engine.generate("hi", max_tokens=64) == "Hello, world."
    result = engine.generate_with_tools("hi", [WEATHER_TOOL], max_tokens=64)
    assert result.content == "Hello, world." and result.finish_reason == "stop"


def test_summarized_thinking_becomes_thinking_events(make_engine) -> None:
    engine = make_engine(_replay("thinking_text.sse"))

    items, result = _drain(
        engine.stream_with_tools("hi", [], max_tokens=256, reasoning_effort="high")
    )

    assert _text(items, "thinking") == "Let me think."
    assert _text(items, "content") == "Answer."
    assert result.thinking_text == "Let me think." and result.content == "Answer."


def test_thinking_is_dropped_when_the_model_does_not_reason(make_engine) -> None:
    engine = make_engine(_replay("thinking_text.sse"), limits=_limits(reasoning=False))

    items = list(engine.stream("hi", max_tokens=256, reasoning_effort="high"))

    assert _text(items, "thinking") == ""
    assert _text(items, "content") == "Answer."
    assert engine.capabilities["thinking"] is False


# -- the tool round and thinking replay ---------------------------------------


def _round_history() -> list[Any]:
    return [
        {"role": "user", "content": "Weather in Paris and Rome?"},
        {
            "role": "assistant",
            "content": "Checking.",
            "tool_calls": [
                {"id": "toolu_a", "name": "get_weather", "arguments": {"city": "Paris"}},
                {"id": "toolu_b", "name": "get_weather", "arguments": {"city": "Rome"}},
            ],
        },
        {"role": "tool", "tool_call_id": "toolu_a", "content": "18C"},
        {"role": "tool", "tool_call_id": "toolu_b", "content": "22C"},
    ]


def _first_round(engine: Any, request_id: str) -> Any:
    engine.begin_request_context(request_id=request_id)
    _, result = _drain(
        engine.stream_with_tools(
            "w",
            [WEATHER_TOOL],
            max_tokens=512,
            reasoning_effort="high",
            messages=[{"role": "user", "content": "Weather in Paris and Rome?"}],
        )
    )
    return result


def test_parallel_tool_calls_assemble_split_input_json(make_engine) -> None:
    engine = make_engine(_replay("tool_round.sse"))

    items, result = _drain(engine.stream_with_tools("w", [WEATHER_TOOL], max_tokens=512))

    assert [(call.tool_id, call.call_id, call.arguments) for call in result.tool_calls] == [
        ("get_weather", "toolu_a", {"city": "Paris"}),
        ("get_weather", "toolu_b", {"city": "Rome"}),
    ]
    assert result.finish_reason == "tool_calls"
    assert _done(items).finish_reason == "tool_calls"
    assert result.tool_call_truncated is False
    assert result.content == "Checking."
    progress = [i for i in items if isinstance(i, StreamingEvent) and i.kind.endswith("progress")]
    assert len(progress) == 6
    assert sum(isinstance(item, ToolCallRequest) for item in items) == 2


def test_second_iteration_replays_thinking_first_and_merges_tool_results(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay(["tool_round.sse", "tool_round_final.sse"], sent))

    first = _first_round(engine, "req-1")
    assert first.finish_reason == "tool_calls"
    _, second = _drain(
        engine.stream_with_tools(
            "w",
            [WEATHER_TOOL],
            max_tokens=512,
            reasoning_effort="high",
            messages=_round_history(),
        )
    )

    assert second.content == "Paris 18C, Rome 22C."
    second_request = sent[1]
    for request in sent:
        assert request.headers["anthropic-beta"] == "thinking-binding-controls-2026-08-01"
        assert _body(request)["thinking"] == {
            "type": "adaptive",
            "display": "summarized",
            "block_binding": {"prefix_mismatch_behavior": "drop_block"},
        }
        assert _body(request)["output_config"] == {"effort": "high"}
    messages = _body(second_request)["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant", "user"]
    assistant = messages[1]["content"]
    assert [block["type"] for block in assistant] == [
        "thinking",
        "redacted_thinking",
        "text",
        "tool_use",
        "tool_use",
    ]
    assert assistant[0] == {"type": "thinking", "thinking": "Let me think.", "signature": "sig-abc"}
    assert assistant[1] == {"type": "redacted_thinking", "data": "opaque-redacted-blob"}
    assert assistant[3] == {
        "type": "tool_use",
        "id": "toolu_a",
        "name": "get_weather",
        "input": {"city": "Paris"},
    }
    results = messages[2]["content"]
    assert [(b["type"], b["tool_use_id"], b["content"]) for b in results] == [
        ("tool_result", "toolu_a", "18C"),
        ("tool_result", "toolu_b", "22C"),
    ]


def test_other_request_ids_and_released_requests_never_replay(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay(["tool_round.sse", "tool_round_final.sse"] * 3, sent))
    _first_round(engine, "req-1")
    assert len(engine._replay) == 2

    def second_call(request_id: str) -> list[dict[str, Any]]:
        engine.begin_request_context(request_id=request_id)
        _drain(
            engine.stream_with_tools(
                "w", [WEATHER_TOOL], max_tokens=512, reasoning_effort="high",
                messages=_round_history(),
            )
        )
        return _body(sent[-1])["messages"][1]["content"]  # type: ignore[no-any-return]

    other = second_call("req-2")
    assert [block["type"] for block in other] == ["text", "tool_use", "tool_use"]

    engine.release_request_state("req-1")
    assert len(engine._replay) == 0
    again = second_call("req-1")
    assert [block["type"] for block in again][0] == "text"


def test_clear_request_context_releases_the_cache(make_engine) -> None:
    engine = make_engine(_replay("tool_round.sse"))
    _first_round(engine, "req-9")
    assert len(engine._replay) == 2

    engine.clear_request_context(request_id="req-9")

    assert len(engine._replay) == 0


def test_no_request_id_means_no_cache(make_engine) -> None:
    engine = make_engine(_replay("tool_round.sse"))

    _drain(engine.stream_with_tools("w", [WEATHER_TOOL], max_tokens=512, reasoning_effort="high"))

    assert len(engine._replay) == 0


def test_no_replay_when_thinking_is_not_requested(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay(["tool_round.sse", "tool_round_final.sse"], sent))
    _first_round(engine, "req-1")

    _drain(
        engine.stream_with_tools(
            "w", [WEATHER_TOOL], max_tokens=512, reasoning_effort=None, messages=_round_history()
        )
    )

    body = _body(sent[1])
    assert "thinking" not in body and "anthropic-beta" not in sent[1].headers
    assert [b["type"] for b in body["messages"][1]["content"]][0] == "text"


# -- request shape ----------------------------------------------------------


def test_request_shape_headers_url_body_and_cache_breakpoints(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent))

    _drain(
        engine.stream_with_tools(
            "hi",
            [WEATHER_TOOL],
            max_tokens=300,
            temperature=0.9,
            system="You are Jenny.",
            messages=[{"role": "user", "content": "hello"}],
        )
    )

    request = sent[0]
    assert request.method == "POST"
    assert str(request.url) == f"{ENDPOINT}/messages"
    assert request.headers["x-api-key"] == KEY
    assert "authorization" not in request.headers
    assert request.headers["anthropic-version"] == "2026-10-21"
    assert request.headers["content-type"] == "application/json"
    assert request.headers["accept"] == "text/event-stream"
    assert "anthropic-beta" not in request.headers
    body = _body(request)
    assert body["model"] == WIRE_MODEL
    assert body["max_tokens"] == 300
    assert body["stream"] is True
    for sampler in ("temperature", "top_p", "top_k"):
        assert sampler not in body
    assert body["system"] == [
        {"type": "text", "text": "You are Jenny.", "cache_control": {"type": "ephemeral"}}
    ]
    assert body["cache_control"] == {"type": "ephemeral"}
    assert body["tool_choice"] == {"type": "auto"}
    assert body["tools"] == [
        {
            "name": "get_weather",
            "description": "Get the current weather for a city.",
            "input_schema": WEATHER_TOOL["parameters"],
            "eager_input_streaming": True,
        }
    ]
    assert "thinking" not in body and "output_config" not in body
    assert body["messages"] == [{"role": "user", "content": [{"type": "text", "text": "hello"}]}]


def test_plain_stream_has_no_tools_or_tool_choice(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent))

    list(engine.stream("hi", max_tokens=64))

    body = _body(sent[0])
    assert "tools" not in body and "tool_choice" not in body and "system" not in body
    assert body["messages"] == [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]


@pytest.mark.parametrize(
    ("reasoning", "effort", "expected"),
    [
        (True, "minimal", "low"),
        (True, "low", "low"),
        (True, "medium", "medium"),
        (True, "high", "high"),
        (True, "xhigh", "xhigh"),
        (True, "max", "max"),
        (True, "HIGH", "high"),
        (True, "ultra", "max"),
        (True, "bogus", None),
        (True, None, False),
        (True, "", False),
        (True, "default", False),
        (True, "none", False),
        (False, "high", False),
    ],
)
def test_thinking_only_when_the_model_reasons_and_effort_is_requested(
    make_engine, reasoning: bool, effort: str | None, expected: Any
) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent), limits=_limits(reasoning=reasoning))

    list(engine.stream("hi", max_tokens=64, reasoning_effort=effort))

    body = _body(sent[0])
    if expected is False:
        assert "thinking" not in body and "output_config" not in body
        assert "anthropic-beta" not in sent[0].headers
        return
    assert body["thinking"]["type"] == "adaptive"
    assert body["thinking"]["block_binding"] == {"prefix_mismatch_behavior": "drop_block"}
    assert "disabled" not in json.dumps(body) and "budget_tokens" not in body["thinking"]
    assert sent[0].headers["anthropic-beta"] == "thinking-binding-controls-2026-08-01"
    if expected is None:
        assert "output_config" not in body
    else:
        assert body["output_config"] == {"effort": expected}


@pytest.mark.parametrize(
    ("requested", "expected"), [(300, 300), (999_999, 16_000), (0, 16_000), (-5, 16_000)]
)
def test_max_tokens_is_the_smaller_of_requested_and_the_output_cap(
    make_engine, requested: int, expected: int
) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent))

    list(engine.stream("hi", max_tokens=requested))

    assert _body(sent[0])["max_tokens"] == expected


def test_limits_drive_context_and_output_budgets(make_engine) -> None:
    engine = make_engine(_replay("text_usage.sse"))
    assert engine.get_model_context_length() == 200_000
    assert engine.get_inference_budget_context_length() == 200_000
    assert engine.get_model_max_output_tokens() == 16_000
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


def test_history_mapping_system_demotion_images_and_pairing() -> None:
    png = VisionImage(mime_type="image/png", width=1, height=1, frame_count=1, data=b"\x89PNG")
    bmp = VisionImage(mime_type="image/bmp", width=1, height=1, frame_count=1, data=b"BM")
    history: list[Any] = [
        {"role": "system", "content": "Be brief."},
        {"role": "system", "content": "Base rules."},
        {"role": "assistant", "content": "stray assistant"},
        {"role": "user", "content": "look", "images": [png, bmp]},
        {
            "role": "assistant",
            "content": "(no content)",
            "tool_calls": [
                {"id": "toolu_1", "name": "get_weather", "arguments": '{"city": "Oslo"}'},
                {"id": "toolu_orphan", "name": "get_weather", "arguments": {}},
            ],
        },
        {"role": "tool", "tool_call_id": "toolu_1", "content": ""},
        {"role": "tool", "tool_call_id": "toolu_ghost", "content": "no call"},
        {"role": "system", "content": "Wrap up now."},
    ]

    system, remainder = split_system("Base rules.", history)
    messages = build_messages("", remainder, vision=True, replay={})

    # Leading run folded once (deduped against the base), later system rows demoted.
    assert system == "Base rules.\n\nBe brief."
    assert messages[0]["role"] == "user"
    assert messages[0]["content"] == [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw=="}},
        {"type": "text", "text": "look"},
    ]
    assert messages[1] == {
        "role": "assistant",
        "content": [
            {"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {"city": "Oslo"}}
        ],
    }
    assert messages[2]["role"] == "user"
    assert messages[2]["content"] == [
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": "(no output)"},
        {"type": "text", "text": "Wrap up now."},
    ]
    assert len(messages) == 3


def test_history_starting_with_assistant_drops_to_the_first_user_turn() -> None:
    messages = build_messages(
        "",
        [
            {"role": "assistant", "content": "hello"},
            {"role": "tool", "tool_call_id": "toolu_x", "content": "x"},
            {"role": "user", "content": "hi"},
        ],
        vision=False,
        replay={},
    )
    assert [m["role"] for m in messages] == ["user"]


def test_images_are_dropped_when_the_model_has_no_vision() -> None:
    png = VisionImage(mime_type="image/png", width=1, height=1, frame_count=1, data=b"\x89PNG")
    messages = build_messages(
        "", [{"role": "user", "content": "look", "images": [png]}], vision=False, replay={}
    )
    assert messages == [{"role": "user", "content": [{"type": "text", "text": "look"}]}]


# -- replay cache bounds ----------------------------------------------------


def test_replay_cache_is_bounded_by_count_and_bytes() -> None:
    cache = ThinkingReplayCache(max_entries=3)
    for index in range(5):
        cache.store("r", [f"t{index}"], [{"type": "thinking", "thinking": "x", "signature": "s"}])
    assert sorted(cache.snapshot("r")) == ["t2", "t3", "t4"]

    big = ThinkingReplayCache()
    blob = {"type": "redacted_thinking", "data": "z" * (MAX_REPLAY_BYTES // 2 + 1)}
    big.store("r", ["a"], [blob])
    big.store("r", ["b"], [blob])
    assert sorted(big.snapshot("r")) == ["b"]
    big.release("r")
    assert len(big) == 0 and big.snapshot("r") == {}
    big.store("", ["a"], [blob])
    assert len(big) == 0


# -- errors -----------------------------------------------------------------


def _status_handler(
    status: int, sent: list[httpx.Request], headers: dict[str, str] | None = None
) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if request.url.host != "api.anthropic.com":
            raise AssertionError("a redirect target was requested")
        body = json.dumps(
            {"type": "error", "error": {"type": "x", "message": f"{KEY} is wrong"}}
        ).encode()
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
        (529, {}, "server_overload", CMP_CLOUD_HTTP_ERROR, None),
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
        _status_handler(307, sent, {"location": "https://attacker.example/v1/messages"})
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
    assert [request.url.host for request in sent] == ["api.anthropic.com"]
    assert not _leaks(error, error.args, error.body)


def test_in_band_overloaded_error_is_retryable_and_never_echoes_provider_text(
    make_engine,
) -> None:
    engine = make_engine(_replay("inband_overloaded.sse"))
    seen: list[Any] = []

    with pytest.raises(ProviderHttpError) as caught:
        for item in engine.stream("hi", max_tokens=64):
            seen.append(item)

    error = caught.value
    assert error.retryable is True
    assert error.classification == "server_overload"
    assert error.status_code is None
    assert error.body == {"code": "overloaded_error"}
    assert "sk-ant-secret-detail" not in str(error) + repr(error.body)
    assert _text(seen, "content") == "Hel"


def test_in_band_unknown_error_type_is_charset_gated_and_terminal(make_engine) -> None:
    engine = make_engine(_replay("inband_unknown_error.sse"))

    with pytest.raises(ProviderHttpError) as caught:
        list(engine.stream("hi", max_tokens=64))

    assert caught.value.retryable is False
    assert caught.value.body == {"code": "unknown_error"}


def test_max_tokens_with_an_unfinished_tool_input_is_truncated_and_not_executable(
    make_engine,
) -> None:
    engine = make_engine(_replay("max_tokens_tool.sse"))

    items, result = _drain(engine.stream_with_tools("w", [WEATHER_TOOL], max_tokens=64))

    assert result.finish_reason == "length"
    assert result.tool_calls == ()
    assert result.tool_call_truncated is True
    assert result.content == "Writing."
    assert _done(items).finish_reason == "length"


def test_max_tokens_text_is_length_without_a_truncated_tool_call(make_engine) -> None:
    engine = make_engine(_replay("max_tokens_text.sse"))

    _, result = _drain(engine.stream_with_tools("w", [WEATHER_TOOL], max_tokens=64))

    assert result.finish_reason == "length" and result.tool_call_truncated is False


def test_unparseable_complete_tool_input_is_carried_as_malformed(make_engine) -> None:
    engine = make_engine(_replay("malformed_tool.sse"))

    _, result = _drain(engine.stream_with_tools("w", [WEATHER_TOOL], max_tokens=64))

    (call,) = result.tool_calls
    assert call.malformed_arguments is True and call.coerced is True and call.arguments == {}
    assert call.call_id == "toolu_bad"


def test_refusal_is_a_terminal_non_retryable_provider_error(make_engine) -> None:
    engine = make_engine(_replay("refusal.sse"))

    with pytest.raises(ProviderHttpError) as caught:
        _drain(engine.stream_with_tools("w", [], max_tokens=64))

    assert caught.value.retryable is False
    assert str(caught.value) == "the provider declined this request"


@pytest.mark.parametrize("name", ["cut_midstream.sse", "pause_turn.sse"])
def test_stream_without_a_clean_stop_is_incomplete(make_engine, name: str) -> None:
    engine = make_engine(_replay(name))

    stream_items = list(engine.stream("hi", max_tokens=64))
    tool_items, result = _drain(engine.stream_with_tools("hi", [WEATHER_TOOL], max_tokens=64))

    assert _done(stream_items).finish_reason == "incomplete"
    assert _done(tool_items).finish_reason == "incomplete"
    assert result.finish_reason == "incomplete"


class _CancellingStream(httpx.SyncByteStream):
    def __init__(self, handle: TurnCancellationHandle) -> None:
        self._handle = handle

    def __iter__(self) -> Iterator[bytes]:
        start = {"type": "message_start", "message": {"usage": {"input_tokens": 1}}}
        yield f"event: message_start\ndata: {json.dumps(start)}\n\n".encode()
        block = {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}
        yield f"event: content_block_start\ndata: {json.dumps(block)}\n\n".encode()
        first = {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "first"}}
        yield f"event: content_block_delta\ndata: {json.dumps(first)}\n\n".encode()
        self._handle.cancel(reason="test_cancel")
        late = {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "late"}}
        yield f"event: content_block_delta\ndata: {json.dumps(late)}\n\n".encode()


@pytest.mark.parametrize("with_tools", [False, True])
def test_cancel_after_first_chunk_stops_the_stream(make_engine, with_tools: bool) -> None:
    handle = TurnCancellationHandle(request_id="req-anthropic-cancel")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "text/event-stream"},
            stream=_CancellingStream(handle),
        )

    engine = make_engine(handler)
    seen: list[Any] = []

    with pytest.raises(TerminalChatStateError):
        if with_tools:
            generator = engine.stream_with_tools(
                "go", [WEATHER_TOOL], max_tokens=64, cancel_handle=handle
            )
        else:
            generator = engine.stream("go", max_tokens=64, cancel_handle=handle)
        for item in generator:
            seen.append(item)

    assert "late" not in _text(seen, "content")
    # The pooled client survives a cancel: only the response was closed.
    assert engine._service._client.is_closed is False


def test_an_already_cancelled_handle_sends_nothing(make_engine) -> None:
    sent: list[httpx.Request] = []
    engine = make_engine(_replay("text_usage.sse", sent))
    handle = TurnCancellationHandle(request_id="req-anthropic-pre")
    handle.cancel(reason="test_cancel")

    with pytest.raises(TerminalChatStateError):
        list(engine.stream("go", max_tokens=64, cancel_handle=handle))

    assert sent == []


# -- model identity, construction, secrecy -------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        WIRE_MODEL,
        f"claude-console/{WIRE_MODEL}",
        f"api-provider/other/{WIRE_MODEL}",
        f"api-provider/{PROVIDER_ID}/",
        f"api-provider/{PROVIDER_ID}",
        f"api-provider/{PROVIDER_ID}/ spaced",
        f"api-provider/{PROVIDER_ID}/bad\nid",
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
    assert len(engine.supported_modalities) == 2
    assert engine.capabilities["thinking"] is False
    assert engine._local_runtime_capability_sources["tool_calling"] == "preset"
    assert engine._local_runtime_capability_sources["thinking"] == "unsupported"
    engine.unload_model()
    assert engine.model_name is None and engine._ready is False
    with pytest.raises(RuntimeError):
        list(engine.stream("hi", max_tokens=8))


def test_secret_never_reaches_repr(make_engine) -> None:
    engine = make_engine(_replay("text_usage.sse"))

    assert not _leaks(repr(engine), str(engine))


def test_construction_refuses_unadmitted_inputs() -> None:
    with pytest.raises(ProviderDescriptorError):
        ApiProviderAnthropicEngine(
            descriptor=_descriptor(transport="openai_chat_completions_v1"),
            api_key=KEY,
            limits=_limits(),
        )
    with pytest.raises(ProviderDescriptorError):
        ApiProviderAnthropicEngine(
            descriptor=_descriptor(auth_profile="api_key_bearer"), api_key=KEY, limits=_limits()
        )
    with pytest.raises(ProviderDescriptorError):
        ApiProviderAnthropicEngine(
            descriptor=_descriptor(auth_profile="none"), api_key=KEY, limits=_limits()
        )
    with pytest.raises(ProviderDescriptorError):
        ApiProviderAnthropicEngine(descriptor=_descriptor(), api_key="", limits=_limits())
    with pytest.raises(ProviderDescriptorError):
        ApiProviderAnthropicEngine(
            descriptor=_descriptor(endpoint="http://api.example.com/v1"),
            api_key=KEY,
            limits=_limits(),
            resolve_local=lambda _host, _port: False,
        )
    with pytest.raises(ProviderDescriptorError):
        ApiProviderAnthropicEngine(
            descriptor=_descriptor(), api_key=KEY, limits={"context_length": 1}
        )
