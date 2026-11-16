"""A stub OpenAI-compatible server on 127.0.0.1 and the real chat.send dispatch path.

Shared by the route-token tests and the model-profile tests: ``StubServer``
answers ``/v1/models``, ``/props`` and scripted ``/v1/chat/completions`` and
records each request's headers; ``chat_send`` drives
``process_chat_send_request`` against an engine with a real router.
"""

from __future__ import annotations

import json
import logging
import threading
from contextlib import nullcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.router import ChatRouter
from sidecar.protocol import API_VERSION, ROUTE_TOKEN_HEADER
from sidecar.runtime.request_dispatch_chat import process_chat_send_request
from tests.sidecar.ai.routing.test_tool_loop import _StubMCPClient

MODEL_ID = "stub-model"
REDIRECT_TARGET = "/v1/redirect-target"


def sse(*chunks: dict[str, Any]) -> bytes:
    lines = [f"data: {json.dumps(chunk)}\n\n" for chunk in chunks]
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode("utf-8")


def text_stream(text: str) -> bytes:
    return sse(
        {"choices": [{"index": 0, "delta": {"role": "assistant", "content": text}}]},
        {
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
        },
    )


def tool_call_stream(name: str) -> bytes:
    call = {
        "index": 0,
        "id": "call_1",
        "type": "function",
        "function": {"name": name, "arguments": "{}"},
    }
    return sse(
        {"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [call]}}]},
        {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
    )


def text_completion(text: str) -> dict[str, Any]:
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


def completion_reply(
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
        return 200, json.dumps(text_completion("Hello there")).encode(), "application/json", ""
    if kind.startswith("tool:"):
        return 200, tool_call_stream(kind[5:]), "text/event-stream", ""
    return 200, text_stream("Hello there"), "text/event-stream", ""


class StubServer:
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
                self._send(*completion_reply(status, kind, bool(payload.get("stream")), echoed))

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

    def __enter__(self) -> StubServer:
        self._thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


def descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="mermaid_generate",
        description="Generate a Mermaid diagram artifact.",
        input_schema={"type": "object", "additionalProperties": True},
        side_effecting=False,
        server_name="stub",
    )


def chat_send(
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
    mcp_client = _StubMCPClient((descriptor(),) if tools else ())
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
