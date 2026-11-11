"""The opaque per-request routing token reaches a loopback gateway, and nothing else.

A ``chat.send`` request may carry ``route_token``. While that one request runs,
every chat-completion call of the ``openai-compatible`` engine carries the token
in ``ROUTE_TOKEN_HEADER``, but only when the engine's base URL host is a loopback
IP literal. These tests drive the real dispatch path against a stub server on
127.0.0.1 that records request headers, and the engine against a mock transport
for hosts that must never be contacted.
"""

from __future__ import annotations

import contextlib
import inspect
import json
import logging
import secrets
import socket
import threading
from contextlib import nullcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from typing import Any, Iterator

import httpx
import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.engines.api_provider_chat import ApiProviderChatEngine
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.provider_http import ProviderHttpError, ProviderHttpService
from sidecar.ai.engines.request_route import (
    bind_route_token,
    current_route_token,
    with_route_token,
)
from sidecar.ai.engines.vllm_engine import VLLMEngine
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.retry import MAX_PROVIDER_RETRY_ATTEMPTS
from sidecar.ai.routing.router import ChatRouter
from sidecar.protocol import API_VERSION, ROUTE_TOKEN_HEADER
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.request_dispatch_chat import process_chat_send_request
from tests.sidecar.ai.routing.test_tool_loop import _StubMCPClient

MODEL_ID = "stub-model"
REDIRECT_TARGET = "/v1/redirect-target"
HEADER_KEY = ROUTE_TOKEN_HEADER.lower()


def _token() -> str:
    return secrets.token_urlsafe(32)


# -- the holder ---------------------------------------------------------------


def test_bind_sets_and_resets() -> None:
    token = _token()
    assert len(token) == 43
    assert current_route_token() is None
    with bind_route_token(token):
        assert current_route_token() == token
    assert current_route_token() is None


def test_bind_resets_when_the_body_raises() -> None:
    token = _token()
    with pytest.raises(RuntimeError, match="boom"), bind_route_token(token):
        assert current_route_token() == token
        raise RuntimeError("boom")
    assert current_route_token() is None


def test_nested_bind_restores_the_outer_value() -> None:
    outer, inner = _token(), _token()
    with bind_route_token(outer):
        with bind_route_token(inner):
            assert current_route_token() == inner
        assert current_route_token() == outer
    assert current_route_token() is None


@pytest.mark.parametrize(
    "value",
    [
        "",
        None,
        42,
        b"A" * 43,
        ["A" * 43],
        "A" * 42,
        "A" * 44,
        "A" * 42 + "=",
        "A" * 42 + "+",
        "A" * 42 + "/",
        "A" * 42 + " ",
        "A" * 42 + "\n",
        "A" * 42 + "é",
    ],
)
def test_invalid_values_bind_nothing(value: Any) -> None:
    with bind_route_token(value):
        assert current_route_token() is None
    # An invalid inner value hides an outer token rather than leaking it onward.
    with bind_route_token(_token()), bind_route_token(value):
        assert current_route_token() is None


def test_bound_value_is_not_visible_in_an_unrelated_thread() -> None:
    seen: list[str | None] = []
    with bind_route_token(_token()):
        worker = threading.Thread(target=lambda: seen.append(current_route_token()))
        worker.start()
        worker.join(timeout=5)
    assert seen == [None]


# -- a stub OpenAI-compatible server on 127.0.0.1 -----------------------------


def _sse(*chunks: dict[str, Any]) -> bytes:
    lines = [f"data: {json.dumps(chunk)}\n\n" for chunk in chunks]
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode("utf-8")


def _text_stream(text: str) -> bytes:
    return _sse(
        {"choices": [{"index": 0, "delta": {"role": "assistant", "content": text}}]},
        {
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
        },
    )


def _tool_call_stream(name: str) -> bytes:
    call = {
        "index": 0,
        "id": "call_1",
        "type": "function",
        "function": {"name": name, "arguments": "{}"},
    }
    return _sse(
        {"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [call]}}]},
        {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
    )


def _text_completion(text: str) -> dict[str, Any]:
    return {
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
    }


def _completion_reply(
    status: int, kind: str, stream: bool, echoed: str
) -> tuple[int, bytes, str, str]:
    """(status, body, content type, Location) for one scripted completion reply."""
    if kind == "redirect":
        return status, b"{}", "application/json", REDIRECT_TARGET
    if status != 200:
        # "echo" reflects the route header back, as a careless gateway might.
        echoed = echoed if kind == "echo" else ""
        body = {"error": {"message": f"busy {echoed}".strip(), "header": echoed}}
        return status, json.dumps(body).encode(), "application/json", ""
    if not stream:
        return 200, json.dumps(_text_completion("Hello there")).encode(), "application/json", ""
    if kind.startswith("tool:"):
        return 200, _tool_call_stream(kind[5:]), "text/event-stream", ""
    return 200, _text_stream("Hello there"), "text/event-stream", ""


class _StubServer:
    """Answer /v1/models, /props and scripted /v1/chat/completions; record headers."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        self.replies: list[tuple[int, str]] = []  # (status, "text"|"tool:<name>")
        self._lock = threading.Lock()
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                return

            def _record(self) -> None:
                headers = {key.lower(): value for key, value in self.headers.items()}
                with stub._lock:
                    stub.requests.append((self.command, self.path, headers))

            def _send(
                self, status: int, body: bytes, content_type: str, location: str = ""
            ) -> None:
                self.send_response(status)
                if location:
                    self.send_header("Location", location)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Retry-After", "0")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:
                self._record()
                if self.path == "/v1/models":
                    body = {"object": "list", "data": [{"id": MODEL_ID, "object": "model"}]}
                    self._send(200, json.dumps(body).encode(), "application/json")
                elif self.path == "/props":
                    body = {"default_generation_settings": {"n_ctx": 8192}}
                    self._send(200, json.dumps(body).encode(), "application/json")
                else:
                    self._send(404, b"{}", "application/json")

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
                self._record()
                if self.path != "/v1/chat/completions":
                    self._send(404, b"{}", "application/json")
                    return
                with stub._lock:
                    status, kind = stub.replies.pop(0) if stub.replies else (200, "text")
                echoed = self.headers.get(ROUTE_TOKEN_HEADER, "")
                self._send(*_completion_reply(status, kind, bool(payload.get("stream")), echoed))

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}/v1"

    def completion_headers(self) -> list[dict[str, str]]:
        with self._lock:
            return [h for _m, path, h in self.requests if path == "/v1/chat/completions"]

    def other_headers(self) -> list[dict[str, str]]:
        with self._lock:
            return [h for _m, path, h in self.requests if path != "/v1/chat/completions"]

    def requests_headers(self) -> list[dict[str, str]]:
        with self._lock:
            return [h for _m, _path, h in self.requests]

    def __enter__(self) -> _StubServer:
        self._thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


@pytest.fixture
def stub() -> Iterator[_StubServer]:
    with _StubServer() as server:
        yield server


def _descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="mermaid_generate",
        description="Generate a Mermaid diagram artifact.",
        input_schema={"type": "object", "additionalProperties": True},
        side_effecting=False,
        server_name="stub",
    )


def _chat_send(
    engine: OpenAICompatibleEngine,
    params_extra: dict[str, Any],
    *,
    tools: bool = False,
    stream: bool = True,
    retry: bool = True,
) -> tuple[Any, list[dict[str, Any]]]:
    # Production enables provider retries (``api_retry`` defaults on in Electron).
    config = RuntimeConfig(
        engine_type="openai-compatible",
        model=MODEL_ID,
        max_tokens=64,
        feature_flags={"api_retry": retry},
    )
    context_builder = ContextBuilder(None)
    mcp_client = _StubMCPClient((_descriptor(),) if tools else ())
    router = ChatRouter(
        config=config, engine=engine, mcp_client=mcp_client, context_builder=context_builder
    )
    container = SimpleNamespace(
        stack=SimpleNamespace(
            config=config,
            raw_config={},
            engine=engine,
            router=router,
            context_builder=context_builder,
            mcp_client=mcp_client,
            memory_store=None,
            tool_observations=None,
        ),
        subprocess_manager=None,
        request_boundary=lambda *_args, **_kwargs: nullcontext(),
    )
    params = {
        "accept_version": API_VERSION,
        "request_id": "request",
        "trace_id": "trace",
        "session_id": "session",
        "logical_turn_id": "turn",
        "messages": [{"role": "user", "content": "Draw a diagram" if tools else "Hi"}],
        **params_extra,
    }
    messages: list[dict[str, Any]] = []
    outcome = process_chat_send_request(
        message_id="message",
        params=params,
        initialized=True,
        interactive_approval=False,
        stream_notifications=stream,
        brain_container=container,
        logger=logging.getLogger(__name__),
        write_message=messages.append,
        read_message=lambda: {},
    )
    return outcome, messages


@pytest.fixture
def engine(stub: _StubServer) -> Iterator[OpenAICompatibleEngine]:
    built = OpenAICompatibleEngine(host=stub.base_url, configured_context_length=8192)
    built.load_model(MODEL_ID)
    try:
        yield built
    finally:
        built.close()


def _assert_secret_absent(token: str, caplog: pytest.LogCaptureFixture, *texts: Any) -> None:
    for record in caplog.records:
        assert token not in record.getMessage()
        assert token not in repr(record.__dict__)
    for text in texts:
        assert token not in json.dumps(text, default=repr)


def test_header_arrives_on_the_completion_request(
    stub: _StubServer, engine: OpenAICompatibleEngine, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    token = _token()
    outcome, messages = _chat_send(engine, {"route_token": token})
    assert outcome.response["result"]["status"] == "completed"
    sent = stub.completion_headers()
    assert sent and all(headers.get(HEADER_KEY) == token for headers in sent)
    assert all(HEADER_KEY not in headers for headers in stub.other_headers())
    assert current_route_token() is None
    _assert_secret_absent(token, caplog, outcome.response, messages)


def test_header_arrives_on_the_second_model_call_of_a_tool_loop(
    stub: _StubServer, engine: OpenAICompatibleEngine, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    token = _token()
    stub.replies = [(200, "tool:mermaid_generate"), (200, "text")]
    outcome, messages = _chat_send(engine, {"route_token": token}, tools=True)
    assert outcome.response["result"]["status"] == "completed"
    sent = stub.completion_headers()
    assert len(sent) >= 2
    assert all(headers.get(HEADER_KEY) == token for headers in sent)
    _assert_secret_absent(token, caplog, outcome.response, messages)


def test_header_arrives_on_a_retry_after_a_retryable_status(
    stub: _StubServer, engine: OpenAICompatibleEngine, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    token = _token()
    stub.replies = [(503, "text"), (200, "text")]
    # The provider retry policy retries a typed provider error; the non-streaming
    # completion raises one for a 503 (a streaming 503 is not retried today).
    outcome, messages = _chat_send(engine, {"route_token": token}, stream=False)
    assert outcome.response["result"]["status"] == "completed"
    sent = stub.completion_headers()
    assert len(sent) == 2
    assert all(headers.get(HEADER_KEY) == token for headers in sent)
    _assert_secret_absent(token, caplog, outcome.response, messages)


def test_header_is_absent_without_a_route_token(
    stub: _StubServer, engine: OpenAICompatibleEngine
) -> None:
    outcome, _messages = _chat_send(engine, {})
    assert outcome.response["result"]["status"] == "completed"
    assert stub.completion_headers()
    assert all(HEADER_KEY not in headers for headers in stub.requests_headers())


@pytest.mark.parametrize("value", ["", "short", "A" * 42 + "=", 7, None, {"t": "x"}])
def test_invalid_route_token_is_dropped_and_the_turn_completes(
    stub: _StubServer, engine: OpenAICompatibleEngine, value: Any
) -> None:
    outcome, _messages = _chat_send(engine, {"route_token": value})
    assert outcome.response["result"]["status"] == "completed"
    assert stub.completion_headers()
    assert all(HEADER_KEY not in headers for headers in stub.requests_headers())


def test_listing_and_props_probe_never_carry_the_header(stub: _StubServer) -> None:
    token = _token()
    probe = OpenAICompatibleEngine(host=stub.base_url, configured_context_length=8192)
    try:
        with bind_route_token(token):
            probe.load_model(MODEL_ID)
            probe.probe_reachable()
    finally:
        probe.close()
    paths = {path for _m, path, _h in stub.requests}
    assert {"/v1/models", "/props"} <= paths
    assert all(HEADER_KEY not in headers for headers in stub.requests_headers())


# -- the loopback rule, against a mock transport (no real outbound call) -----


def _mock_engine(
    host: str | None, engine_class: type = OpenAICompatibleEngine, **kwargs: Any
) -> tuple[Any, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        payload = json.loads(request.content or b"{}")
        if payload.get("stream"):
            body, content_type = _text_stream("ok"), "text/event-stream"
        else:
            body, content_type = json.dumps(_text_completion("ok")).encode(), "application/json"
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": content_type},
            stream=httpx.ByteStream(body),
        )

    built = engine_class(**kwargs) if host is None else engine_class(host=host, **kwargs)
    old = built._service._client
    built._service._client = httpx.Client(
        base_url=old.base_url, headers=old.headers, transport=httpx.MockTransport(handler)
    )
    old.close()
    built._ready = True
    built.model_name = MODEL_ID
    return built, seen


def _drive_all_completion_paths(built: Any) -> None:
    messages = [{"role": "user", "content": "Hi"}]
    list(built.stream(prompt="Hi", messages=messages, max_tokens=16))
    list(built.stream_with_tools(prompt="Hi", tools=[], messages=messages, max_tokens=16))
    built.generate_with_tools(prompt="Hi", tools=[], messages=messages, max_tokens=16)


@pytest.mark.parametrize(
    "host,expected",
    [
        ("http://127.0.0.1:8123/v1", True),
        ("http://127.0.0.2:8123/v1", True),
        ("http://[::1]:8123/v1", True),
        ("http://0.0.0.0:8123/v1", False),
        ("http://[::ffff:127.0.0.1]:8123/v1", False),
        ("http://127.0.0.1@evil.example/v1", False),
        ("http://2130706433:8123/v1", False),
        ("http://localhost.:8123/v1", False),
        ("http://[::1%25lo]:8123/v1", False),
        ("http://localhost:8123/v1", False),
        ("http://192.168.1.20:8123/v1", False),
        ("http://10.0.0.5:8123/v1", False),
        ("http://[fe80::1]:8123/v1", False),
        ("https://api.example.com/v1", False),
        ("http://127.0.0.1.example.com:8123/v1", False),
    ],
)
def test_header_only_for_a_loopback_ip_literal(
    host: str, expected: bool, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    token = _token()
    built, seen = _mock_engine(host)
    try:
        with bind_route_token(token):
            _drive_all_completion_paths(built)
    finally:
        built.close()
    assert len(seen) == 3
    assert all(request.url.path.endswith("/chat/completions") for request in seen)
    for request in seen:
        assert (request.headers.get(ROUTE_TOKEN_HEADER) == token) is expected
    _assert_secret_absent(token, caplog)


def test_no_header_without_a_bound_token_on_loopback() -> None:
    built, seen = _mock_engine("http://127.0.0.1:8123/v1")
    try:
        _drive_all_completion_paths(built)
    finally:
        built.close()
    assert len(seen) == 3
    assert all(ROUTE_TOKEN_HEADER not in request.headers for request in seen)


def test_client_headers_are_kept_alongside_the_route_header() -> None:
    token = _token()
    built, seen = _mock_engine("http://127.0.0.1:8123/v1", api_key="local-key-123456")
    try:
        with bind_route_token(token):
            _drive_all_completion_paths(built)
    finally:
        built.close()
    for request in seen:
        assert request.headers.get("authorization") == "Bearer local-key-123456"
        assert request.headers.get(ROUTE_TOKEN_HEADER) == token


def _api_provider_kwargs() -> dict[str, Any]:
    descriptor = {
        "descriptor_schema_version": 6,
        "provider_id": "localgw",
        "label": "Local",
        "endpoint": "http://127.0.0.1:8123/v1",
        "transport": "openai_chat_completions_v1",
        "auth_profile": "api_key_bearer",
        "token_limit_field": "max_tokens",
    }
    limits = {
        "context_length": 8192,
        "max_output_tokens": 1024,
        "tools": True,
        "vision": False,
        "reasoning": False,
        "sources": {
            key: "preset"
            for key in ("context_length", "max_output_tokens", "tools", "vision", "reasoning")
        },
    }
    return {
        "descriptor": descriptor,
        "api_key": "test-key-abcdefgh",
        "limits": limits,
        "resolve_local": lambda *_args: True,
    }


@pytest.mark.parametrize("engine_class", [VLLMEngine, ApiProviderChatEngine])
def test_other_engines_on_the_same_http_layer_send_no_header(engine_class: type) -> None:
    token = _token()
    if engine_class is VLLMEngine:
        built, seen = _mock_engine("http://127.0.0.1:8123/v1", engine_class=VLLMEngine)
    else:
        built, seen = _mock_engine(None, engine_class=engine_class, **_api_provider_kwargs())
        built._wire_model = MODEL_ID
    try:
        with bind_route_token(token):
            _drive_all_completion_paths(built)
    finally:
        built.close()
    assert len(seen) == 3
    assert all(request.url.host == "127.0.0.1" for request in seen)
    assert all(ROUTE_TOKEN_HEADER not in request.headers for request in seen)


def test_every_completion_path_carries_the_header_over_a_real_socket(
    stub: _StubServer, engine: OpenAICompatibleEngine
) -> None:
    token = _token()
    messages = [{"role": "user", "content": "Hi"}]
    with bind_route_token(token):
        list(engine.stream(prompt="Hi", messages=messages, max_tokens=16))
        list(engine.stream_with_tools(prompt="Hi", tools=[], messages=messages, max_tokens=16))
        engine.generate_with_tools(prompt="Hi", tools=[], messages=messages, max_tokens=16)
        # A cancellable non-streaming call opens its own one-shot connection.
        engine.generate_with_tools(
            prompt="Hi",
            tools=[],
            messages=messages,
            max_tokens=16,
            cancel_handle=TurnCancellationHandle(request_id="request"),
        )
    sent = stub.completion_headers()
    assert len(sent) == 4
    assert all(headers.get(HEADER_KEY) == token for headers in sent)
    assert all(HEADER_KEY not in headers for headers in stub.other_headers())


# -- the shared HTTP layer's per-call headers ---------------------------------


def test_provider_http_per_call_headers_merge_over_the_client_headers() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "application/json"},
            stream=httpx.ByteStream(b"{}"),
        )

    service = ProviderHttpService(
        provider="probe", base_url="http://127.0.0.1:9/v1", headers={"X-Client": "kept"}
    )
    service._client.close()
    service._client = httpx.Client(
        base_url="http://127.0.0.1:9/v1",
        headers={"X-Client": "kept"},
        transport=httpx.MockTransport(handler),
    )
    extra = {"X-Per-Call": "one"}
    try:
        service.get_json("/a")
        service.post_json("/b", {}, headers=extra)
        with service.stream_response("POST", "/c", json={}, headers=extra) as response:
            response.read()
        service.get_json("/d")
        service.post_json("/e", {})
        with service.stream_response("POST", "/f", json={}) as response:
            response.read()
    finally:
        service.close()
    assert [request.url.path for request in seen] == [f"/v1/{c}" for c in "abcdef"]
    assert all(request.headers.get("x-client") == "kept" for request in seen)
    assert [request.headers.get("x-per-call") for request in seen] == [None, "one", "one"] + [
        None
    ] * 3
    assert "x-per-call" not in service_headers_after(service)


def service_headers_after(service: ProviderHttpService) -> dict[str, str]:
    # A per-call header never sticks to the pooled client.
    return {key.lower(): value for key, value in service._client.headers.items()}


# -- review round: proxies, redirects, one-shot client, final failures --------


def _capture_one_shot_clients(monkeypatch: pytest.MonkeyPatch, handler: Any) -> list[httpx.Client]:
    """Route the one-shot client ``post_json_interruptible`` builds to a mock transport.

    httpx skips environment proxies when a transport is passed, so each captured
    client also records ``env_mounts``: the proxy mounts the same arguments build.
    """
    built: list[httpx.Client] = []
    real_client = httpx.Client

    class _OneShot(real_client):  # type: ignore[misc, valid-type]
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            with real_client(*args, **kwargs) as as_built:
                self.env_mounts = dict(as_built._mounts)
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)
            built.append(self)

    monkeypatch.setattr(httpx, "Client", _OneShot)
    return built


def _json_ok(request: httpx.Request) -> httpx.Response:
    body = json.dumps(_text_completion("ok")).encode()
    return httpx.Response(
        200,
        request=request,
        headers={"content-type": "application/json"},
        stream=httpx.ByteStream(body),
    )


@pytest.mark.parametrize(
    "base_url,trusts_env",
    [
        ("http://127.0.0.1:8123/v1", False),
        ("http://127.0.0.2:8123/v1", False),
        ("http://[::1]:8123/v1", False),
        ("http://localhost:8123/v1", True),
        ("http://192.168.1.20:8123/v1", True),
        ("https://api.example.com/v1", True),
    ],
)
def test_loopback_literal_services_ignore_environment_proxies(
    monkeypatch: pytest.MonkeyPatch, base_url: str, trusts_env: bool
) -> None:
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        monkeypatch.setenv(name, "http://127.0.0.1:9")
    service = ProviderHttpService(provider="probe", base_url=base_url, headers={})
    one_shot = _capture_one_shot_clients(monkeypatch, _json_ok)
    try:
        service.post_json_interruptible(
            "/chat/completions", {}, cancel_handle=TurnCancellationHandle(request_id="r")
        )
        pooled = service._client
        assert len(one_shot) == 1
        for client, mounts in ((pooled, pooled._mounts), (one_shot[0], one_shot[0].env_mounts)):
            assert client.trust_env is trusts_env
            assert bool(mounts) is trusts_env
            assert client.follow_redirects is False
    finally:
        service.close()


def test_neither_client_follows_a_redirect(stub: _StubServer) -> None:
    engine = OpenAICompatibleEngine(host=stub.base_url, configured_context_length=8192)
    engine._ready, engine.model_name = True, MODEL_ID
    messages = [{"role": "user", "content": "Hi"}]
    stub.replies = [(307, "redirect")] * 3
    try:
        with contextlib.suppress(Exception):
            list(engine.stream(prompt="Hi", messages=messages, max_tokens=16))
        with contextlib.suppress(Exception):
            engine.generate_with_tools(prompt="Hi", tools=[], messages=messages, max_tokens=16)
        with contextlib.suppress(Exception):
            engine.generate_with_tools(
                prompt="Hi",
                tools=[],
                messages=messages,
                max_tokens=16,
                cancel_handle=TurnCancellationHandle(request_id="request"),
            )
    finally:
        engine.close()
    paths = [path for _m, path, _h in stub.requests]
    assert paths.count("/v1/chat/completions") == 3
    assert REDIRECT_TARGET not in paths


@pytest.mark.parametrize(
    "host", ["https://api.example.com/v1", "http://192.168.1.20:8123/v1", "http://localhost:8/v1"]
)
def test_cancellable_completion_sends_no_header_to_a_non_loopback_url(
    monkeypatch: pytest.MonkeyPatch, host: str
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _json_ok(request)

    built = OpenAICompatibleEngine(host=host)
    built._ready, built.model_name = True, MODEL_ID
    one_shot = _capture_one_shot_clients(monkeypatch, handler)
    try:
        with bind_route_token(_token()):
            built.generate_with_tools(
                prompt="Hi",
                tools=[],
                messages=[{"role": "user", "content": "Hi"}],
                max_tokens=16,
                cancel_handle=TurnCancellationHandle(request_id="request"),
            )
    finally:
        built.close()
    assert len(one_shot) == 1 and len(seen) == 1
    assert ROUTE_TOKEN_HEADER not in seen[0].headers


def _error_texts(error: BaseException) -> list[str]:
    texts: list[str] = []
    current: BaseException | None = error
    while current is not None:
        texts += [str(current), repr(current), repr(getattr(current, "body", None))]
        texts += [repr(getattr(current, "data", None))]
        current = current.__cause__ or current.__context__
    return texts


def _closed_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def test_connection_refused_with_a_token_bound_leaks_nothing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    token = _token()
    engine = OpenAICompatibleEngine(
        host=f"http://127.0.0.1:{_closed_loopback_port()}/v1", configured_context_length=8192
    )
    engine._ready, engine.model_name = True, MODEL_ID
    messages = [{"role": "user", "content": "Hi"}]
    raised: list[BaseException] = []
    try:
        with bind_route_token(token):
            for call in (
                lambda: list(engine.stream(prompt="Hi", messages=messages, max_tokens=16)),
                lambda: engine.generate_with_tools(
                    prompt="Hi", tools=[], messages=messages, max_tokens=16
                ),
            ):
                with pytest.raises(Exception) as caught:
                    call()
                raised.append(caught.value)
        # No provider retries: a refused connection backs off for minutes otherwise.
        outcome, notices = _chat_send(engine, {"route_token": token}, stream=False, retry=False)
    finally:
        engine.close()
    assert "error" in outcome.response
    texts = [text for error in raised for text in _error_texts(error)]
    _assert_secret_absent(token, caplog, outcome.response, notices, texts)


@pytest.mark.parametrize("status", [401, 500])
def test_final_http_failure_with_a_token_bound_leaks_nothing(
    stub: _StubServer, caplog: pytest.LogCaptureFixture, status: int
) -> None:
    caplog.set_level(logging.DEBUG)
    token = _token()
    engine = OpenAICompatibleEngine(host=stub.base_url, configured_context_length=8192)
    engine._ready, engine.model_name = True, MODEL_ID
    messages = [{"role": "user", "content": "Hi"}]
    stub.replies = [(status, "echo")] * (MAX_PROVIDER_RETRY_ATTEMPTS + 4)
    try:
        with bind_route_token(token), pytest.raises(ProviderHttpError) as caught:
            engine.generate_with_tools(prompt="Hi", tools=[], messages=messages, max_tokens=16)
        before = len(stub.completion_headers())
        outcome, notices = _chat_send(engine, {"route_token": token}, stream=False)
    finally:
        engine.close()
    # The gateway did receive the token (and echoed it); nothing on our side repeats it.
    assert all(headers.get(HEADER_KEY) == token for headers in stub.completion_headers())
    attempts = len(stub.completion_headers()) - before
    assert attempts == (MAX_PROVIDER_RETRY_ATTEMPTS if status == 500 else 1)
    assert "error" in outcome.response
    _assert_secret_absent(token, caplog, outcome.response, notices, _error_texts(caught.value))


def test_the_chat_send_entry_takes_params_by_keyword_only() -> None:
    # ``with_route_token`` reads ``params=``; a keyword-only parameter means every
    # caller (server.py, request_dispatch.py) must pass it that way.
    entry = inspect.unwrap(process_chat_send_request)
    assert inspect.signature(entry).parameters["params"].kind is inspect.Parameter.KEYWORD_ONLY
    token = _token()
    seen: list[str | None] = []

    @with_route_token
    def probe(*, params: Any) -> None:
        seen.append(current_route_token())

    probe(params={"route_token": token})
    assert seen == [token]
