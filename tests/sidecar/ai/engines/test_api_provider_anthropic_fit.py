"""The Anthropic reply is fitted to the room its prompt leaves (row 183 W1).

The Messages API refuses prompt + ``max_tokens`` over the window, so the engine clamps
``max_tokens`` per request and budgeting holds back only the answer floor.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import httpx
import pytest

from sidecar.ai.context.token_budget import engine_fits_output_to_window
from sidecar.ai.engines.api_provider_anthropic import ApiProviderAnthropicEngine
from sidecar.ai.engines.api_provider_anthropic_stream import (
    COLD_SCALE,
    MARGIN_TOKENS,
    MIN_REPLY_TOKENS,
    OutputFit,
    estimate_payload_tokens,
)
from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.routing.retry import _adjust_max_tokens_for_retry

FIXTURES = Path(__file__).parent / "fixtures" / "api_provider_anthropic"
KEY = "sk-ant-test-0123456789abcdefXYZ"
PROVIDER_ID = "claude-console"
WEATHER = {
    "name": "get_weather",
    "description": "Get the weather.",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
}


def _room(window: int, prompt: int) -> int:
    return window - prompt - max(MARGIN_TOKENS, prompt // 50)


def _payload(chars: int, max_tokens: int = 64_000) -> dict[str, Any]:
    return {
        "model": "m",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "x" * chars}]}],
    }


def test_the_estimate_counts_every_string_and_charges_images_flat() -> None:
    payload = {
        "system": "s" * 400,
        "messages": [
            {"role": "user", "content": [
                {"type": "text", "text": "t" * 800},
                {"type": "image", "source": {"type": "base64", "data": "A" * 400_000}},
            ]},
        ],
    }
    # The image's base64 is not read; the keys' own strings ("role", "user", ...) are values only.
    plain = estimate_payload_tokens({k: v for k, v in payload.items() if k != "messages"})
    assert plain == 100
    assert estimate_payload_tokens(payload) == (400 + 800 + len("user") + len("text")) // 4 + 1_600


def test_a_roomy_prompt_keeps_the_requested_reply() -> None:
    fit = OutputFit()
    payload = _payload(40_000, max_tokens=32_000)
    assert fit.fit(payload, 200_000) == 32_000
    assert payload["max_tokens"] == 32_000


def test_a_cold_tight_prompt_clamps_at_the_cautious_scale() -> None:
    fit = OutputFit()
    payload = _payload(400_000, max_tokens=128_000)  # ~100k estimated, 150k at the cold scale
    estimate = estimate_payload_tokens({k: v for k, v in payload.items() if k != "max_tokens"})
    fitted = fit.fit(payload, 200_000)
    assert fitted == _room(200_000, math.ceil(estimate * COLD_SCALE))
    assert payload["max_tokens"] == fitted


def test_the_learned_ratio_replaces_the_cold_scale() -> None:
    fit = OutputFit()
    payload = _payload(320_000)
    estimate = estimate_payload_tokens({k: v for k, v in payload.items() if k != "max_tokens"})
    fit.fit(payload, 200_000)
    fit.learn(int(estimate * 1.75))
    assert fit.scale == pytest.approx(1.75, rel=0.001)
    again = _payload(320_000, max_tokens=128_000)
    assert fit.fit(again, 200_000) == _room(200_000, math.ceil(estimate * fit.scale))


def test_the_ratio_is_clamped_and_bad_readings_are_ignored() -> None:
    fit = OutputFit()
    fit.fit(_payload(4_000), 200_000)
    fit.learn(10)  # below chars/4: clamped to 1.0
    assert fit.scale == 1.0
    fit.fit(_payload(4_000), 200_000)
    fit.learn(10_000_000)
    assert fit.scale == 4.0
    for bad in (0, None, "n/a", -5):
        fit.fit(_payload(4_000), 200_000)
        fit.learn(bad)
        assert fit.scale == 4.0
    # A reading with no fitted request behind it teaches nothing.
    fit.learn(999)
    assert fit.scale == 4.0


def test_the_reply_is_never_fitted_below_the_floor() -> None:
    fit = OutputFit()
    payload = _payload(800_000)  # far past the window
    assert fit.fit(payload, 200_000) == MIN_REPLY_TOKENS
    small = _payload(800_000, max_tokens=1_000)
    assert fit.fit(small, 200_000) == 1_000  # never raised above what was asked


@pytest.mark.parametrize("window", [None, 0, -1])
def test_an_unknown_window_leaves_the_reply_alone(window: Any) -> None:
    payload = _payload(800_000)
    assert OutputFit().fit(payload, window) == 64_000
    assert payload["max_tokens"] == 64_000


# -- the engine ---------------------------------------------------------------------------------


def _engine(handler: Any, *, window: int, max_output: int) -> ApiProviderAnthropicEngine:
    sources = {key: "preset" for key in ("context_length", "tools", "vision", "reasoning")}
    sources["max_output_tokens"] = "pin"
    engine = ApiProviderAnthropicEngine(
        descriptor={
            "descriptor_schema_version": 6, "provider_id": PROVIDER_ID, "label": "Claude Console",
            "endpoint": "https://api.anthropic.com/v1", "transport": "anthropic_messages_v1",
            "auth_profile": "api_key_header",
        },
        api_key=KEY,
        limits={"context_length": window, "max_output_tokens": max_output, "tools": True,
                "vision": False, "reasoning": True, "sources": sources},
    )
    old = engine._service._client
    engine._service._client = httpx.Client(
        base_url=old.base_url, headers=old.headers, timeout=old.timeout,
        transport=httpx.MockTransport(handler),
    )
    old.close()
    engine.load_model(f"api-provider/{PROVIDER_ID}/claude-test-5")
    return engine


def test_the_engine_declares_and_sends_a_fitted_reply() -> None:
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(
            200, request=request, headers={"content-type": "text/event-stream"},
            stream=httpx.ByteStream((FIXTURES / "text_usage.sse").read_bytes()),
        )

    engine = _engine(handler, window=200_000, max_output=100_000)
    try:
        assert engine_fits_output_to_window(engine) is True
        # ~90k estimated tokens of prompt: the cold scale leaves no room for 100k of reply.
        list(engine.stream("x" * 360_000, max_tokens=100_000))
        cold = json.loads(sent[0].content)["max_tokens"]
        assert MIN_REPLY_TOKENS <= cold < 100_000
        # The fixture answers 47 prompt tokens for that request: the ratio clamps to 1.0.
        assert engine._output_fit.scale == 1.0
        list(engine.stream("x" * 360_000, max_tokens=100_000))
        warm = json.loads(sent[1].content)["max_tokens"]
        assert cold < warm <= 100_000
    finally:
        with contextlib.suppress(Exception):
            engine.close()


# -- a refused request names the overflow, and only the overflow -----------------------------------


def _refusing(status: int, message: str) -> Any:
    body = {"type": "error", "error": {"type": "invalid_request_error", "message": message}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, request=request, json=body)

    return handler


def _refusal(status: int, message: str) -> ProviderHttpError:
    engine = _engine(_refusing(status, message), window=200_000, max_output=32_000)
    try:
        with pytest.raises(ProviderHttpError) as caught:
            list(engine.stream("hi", max_tokens=32_000))
        return caught.value
    finally:
        with contextlib.suppress(Exception):
            engine.close()


def test_a_reply_too_large_for_the_window_keeps_its_numbers_for_the_retry() -> None:
    error = _refusal(
        400,
        "input length and `max_tokens` exceed context limit: 188240 + 32000 > 200000, "
        "decrease input length or `max_tokens` and try again. private provider text",
    )
    assert error.classification == "context_overflow"
    assert error.body == {"error": {"message": (
        "input length and `max_tokens` exceed context limit: 188240 + 32000 > 200000"
    )}}
    assert "private" not in str(error) and "private" not in str(error.body)
    # retry.py resends with the room the numbers show.
    adjusted = _adjust_max_tokens_for_retry(error=error, current=32_000)
    assert adjusted is not None and adjusted < 200_000 - 188_240


def test_a_prompt_too_long_is_named_without_the_provider_text() -> None:
    error = _refusal(400, "prompt is too long: 213462 tokens > 200000 maximum")
    assert error.classification == "prompt_too_long"
    assert error.body == {"error": {"message": "prompt is too long"}}
    assert error.status_code == 400


@pytest.mark.parametrize(
    ("status", "message"),
    [(400, "messages: roles must alternate"), (401, "prompt is too long"),
     (500, "input length and `max_tokens` exceed context limit: 1 + 2 > 3")],
)
def test_other_refusals_keep_the_status_only_class(status: int, message: str) -> None:
    error = _refusal(status, message)
    assert error.body is None
    assert error.classification not in ("context_overflow", "prompt_too_long")


# -- the exact count (row 183 W2) -----------------------------------------------------------------


_NOTE = "handoff note"
_ROWS = [
    {"role": "system", "content": "You are Jenny."},
    {"role": "context", "kind": "session_message", "content": _NOTE, "session_message": {
        "schema_version": 1, "message_id": "11111111-1111-4111-8111-111111111111",
        "source_session_id": "session-src", "source_session_incarnation": "inc-src",
        "source_project_id": "project-src", "destination_session_id": "session-dst",
        "destination_session_incarnation": "inc-dst", "destination_project_id": None,
        "source_turn_id": None, "kind": "user_message", "created_at": "2026-10-15T12:00:00.000Z",
        "body": _NOTE, "body_sha256": hashlib.sha256(_NOTE.encode("utf-8")).hexdigest(),
        "report": None,
    }},
    {"role": "user", "content": "hello"},
]


def _counting(status: int = 200, body: Any = None, seen: list[Any] | None = None) -> Any:
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        reply = {"input_tokens": 1_234} if body is None else body
        return httpx.Response(
            status, request=request, headers={"content-type": "application/json"},
            stream=httpx.ByteStream(json.dumps(reply).encode()),
        )

    return handler


def _count_engine(handler: Any) -> ApiProviderAnthropicEngine:
    return _engine(handler, window=200_000, max_output=32_000)


def test_the_count_posts_the_request_without_generation_fields() -> None:
    seen: list[httpx.Request] = []
    engine = _count_engine(_counting(seen=seen))
    try:
        assert engine.count_request_tokens(messages=_ROWS, tools=[WEATHER]) == 1_234
    finally:
        engine.close()
    assert seen[0].url.path.endswith("/messages/count_tokens")
    body = json.loads(seen[0].content)
    assert not {"max_tokens", "stream", "cache_control", "thinking"} & set(body)
    assert "eager_input_streaming" not in body["tools"][0]
    assert body["model"] == "claude-test-5" and body["tools"][0]["name"] == "get_weather"
    assert "You are Jenny." in json.dumps(body["system"])
    assert "handoff note" in json.dumps(body["messages"])  # a context row counts as user text


def test_a_missing_route_or_unreadable_reply_is_skipped_until_the_next_load() -> None:
    for status, body in ((404, {"error": "nope"}), (400, {"error": "bad"}),
                         (200, {"input_tokens": "lots"})):
        seen: list[httpx.Request] = []
        engine = _count_engine(_counting(status, body, seen))
        try:
            assert engine.count_request_tokens(messages=_ROWS, tools=[]) is None
            assert engine.count_request_tokens(messages=_ROWS, tools=[]) is None
            assert len(seen) == 1
            engine.load_model(f"api-provider/{PROVIDER_ID}/claude-test-5")
            engine.count_request_tokens(messages=_ROWS, tools=[])
            assert len(seen) == 2
        finally:
            engine.close()


def test_a_passing_failure_rests_the_route_for_a_minute(monkeypatch: pytest.MonkeyPatch) -> None:
    import sidecar.ai.engines.api_provider_anthropic as anthropic_module

    clock = [100.0]
    monkeypatch.setattr(anthropic_module.time, "monotonic", lambda: clock[0])
    seen: list[httpx.Request] = []
    engine = _count_engine(_counting(529, {"error": "overloaded"}, seen))
    try:
        assert engine.count_request_tokens(messages=_ROWS, tools=[]) is None
        clock[0] += 59
        assert engine.count_request_tokens(messages=_ROWS, tools=[]) is None
        assert len(seen) == 1
        clock[0] += 2
        engine.count_request_tokens(messages=_ROWS, tools=[])
        assert len(seen) == 2
    finally:
        engine.close()


def test_a_transport_failure_never_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow", request=request)

    engine = _count_engine(handler)
    try:
        assert engine.count_request_tokens(messages=_ROWS, tools=[]) is None
    finally:
        engine.close()


def test_no_rows_or_an_unloaded_engine_sends_nothing() -> None:
    seen: list[httpx.Request] = []
    engine = _count_engine(_counting(seen=seen))
    try:
        assert engine.count_request_tokens(messages=[], tools=[]) is None
        engine.unload_model()
        assert engine.count_request_tokens(messages=_ROWS, tools=[]) is None
    finally:
        engine.close()
    assert seen == []


def test_the_engine_trusts_a_full_prompt_calibration_up_to_two_and_a_half() -> None:
    from sidecar.ai.context.context_count import calibration_band

    assert calibration_band(ApiProviderAnthropicEngine) == (0.9, 2.5)
