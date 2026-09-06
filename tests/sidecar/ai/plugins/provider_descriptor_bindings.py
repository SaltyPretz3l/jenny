"""Adapters that run a provider-descriptor fixture case against the real engine.

One entry in ``BINDINGS`` per name in the loader's closed binding vocabulary.
Each adapter takes ``(case_input, expect)``, drives the SHIPPED ChatGPT
subscription engine (no descriptor interpreter is built or implied), and asserts
the frozen expectation. ``run_case`` is the single entry point shared by the
conformance suite and the mutation suite, so a perturbed expectation exercises
exactly the code path the real one does.

The fakes below are lifted from tests/sidecar/ai/engines/test_chatgpt_subscription.py
so the two suites drive the engine through an identical seam. Engines built for
header/endpoint/catalog cases are closed in a ``finally``: ProviderHttpService
constructs an httpx client eagerly, so an un-closed engine leaks a socket pool.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from scripts.checks.provider_descriptor_fixtures import BINDING_EXPECT_KEYS
from sidecar.ai.context.messages import EMPTY_ASSISTANT_CONTENT_PLACEHOLDER
from sidecar.ai.engines.chatgpt_subscription import (
    CHATGPT_MODEL_CONTEXT_LENGTHS,
    ChatGPTSubscriptionEngine,
)
from sidecar.ai.engines.chatgpt_subscription_request import (
    build_function_tools,
    build_input_items,
    build_responses_payload,
    normalize_reasoning_effort,
)
from sidecar.ai.engines.chatgpt_subscription_stream import (
    _CITATION_END,
    _CITATION_SEPARATOR,
    _CITATION_START,
    raise_for_initial_status,
)
from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.exceptions import GenerationError
from sidecar.ai.tools.models import GenerationResult, StreamingEvent, ToolCallRequest

ROOT = Path(__file__).resolve().parents[4]
AUTH_SERVICE = ROOT / "services" / "backend" / "chatgpt-auth-service.js"
MODEL_CATALOG_FIXTURE = ROOT / "tests" / "fixtures" / "plugins" / "provider-descriptor" / "model_catalog.json"
MODEL_CATALOG_CONSTANTS = json.loads(MODEL_CATALOG_FIXTURE.read_text(encoding="utf-8"))["constants"]

# Synthetic identities. These are the values the fixtures' ${...} constants
# expand to; constant_identity cases pin them so a fixture and this runner can
# never drift into comparing two independently-wrong placeholders.
ACCESS_TOKEN = "synthetic-subscription-access-token"
ACCOUNT_ID = "acct_test_456"
BASE_URL = "https://example.test/backend-api/codex"
DEFAULT_MODEL = "gpt-5.5"

# httpx lowercases header names on the wire, so the declared template is matched
# case-insensitively against this lowercased vocabulary.
TEMPLATE_HEADER_NAMES = (
    "accept",
    "authorization",
    "chatgpt-account-id",
    "content-type",
    "originator",
    "user-agent",
)

_CLIENT_ID_RE = re.compile(r"const\s+CLIENT_ID\s*=\s*'([^']+)'")


def _oauth_client_id() -> str:
    """Read the shipped OAuth client id out of the Electron auth service.

    Read, never imported: this is a JS constant, and pinning it here is what
    turns the descriptor draft's auth_profile note into something a rotation
    would break instead of quietly outdate.
    """
    match = _CLIENT_ID_RE.search(AUTH_SERVICE.read_text(encoding="utf-8"))
    assert match is not None, f"{AUTH_SERVICE}: no `const CLIENT_ID = '...'` declaration found"
    return match.group(1)


# Explicit name -> object table. NEVER getattr/eval on a fixture-supplied string:
# a fixture must not be able to name an arbitrary attribute of the engine.
CONSTANT_OBJECTS: dict[str, Any] = {
    "ACCESS_TOKEN": ACCESS_TOKEN,
    "ACCOUNT_ID": ACCOUNT_ID,
    "BASE_URL": BASE_URL,
    "CHATGPT_MODEL_CATALOG_SOURCE": MODEL_CATALOG_CONSTANTS["CHATGPT_MODEL_CATALOG_SOURCE"],
    "CHATGPT_MODEL_CATALOG_VERSION": MODEL_CATALOG_CONSTANTS["CHATGPT_MODEL_CATALOG_VERSION"],
    "CITATION_END": _CITATION_END,
    "CITATION_SEPARATOR": _CITATION_SEPARATOR,
    "CITATION_START": _CITATION_START,
    "EMPTY_ASSISTANT_CONTENT_PLACEHOLDER": EMPTY_ASSISTANT_CONTENT_PLACEHOLDER,
    "OAUTH_CLIENT_ID": _oauth_client_id(),
}


class _FakeSSEStream:
    """Line-oriented stand-in for an httpx streaming response."""

    def __init__(
        self,
        lines: list[str],
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> None:
        self._lines = lines
        self.status_code = status_code
        self.headers = headers or {}
        self._body = body or {}
        self.closed = False

    def iter_lines(self) -> list[str]:
        return self._lines

    def json(self) -> dict[str, Any]:
        return self._body

    def close(self) -> None:
        self.closed = True

    def __enter__(self) -> _FakeSSEStream:
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()


class _RawByteStream(_FakeSSEStream):
    """Raw-byte variant: CRLF framing split at an arbitrary mid-line boundary."""

    def __init__(self, lines: list[str], *, cut: int) -> None:
        super().__init__(lines)
        self._cut = cut

    def iter_raw(self, chunk_size: int = 0) -> list[bytes]:
        _ = chunk_size
        payload = "".join(f"{line}\r\n" for line in self._lines).encode("utf-8")
        return [payload[: self._cut], payload[self._cut :]]


class _FakeStreamingClient:
    def __init__(self, *responses: _FakeSSEStream) -> None:
        self._responses = list(responses)
        self.requests: list[dict[str, Any]] = []
        self.base_url = ""
        self.closed = False

    def stream(self, method: str, path: str, **kwargs: Any) -> _FakeSSEStream:
        self.requests.append({"method": method, "path": path, **kwargs})
        return self._responses.pop(0)

    def close(self) -> None:
        self.closed = True


def _sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event)}"


def _sse_lines(raw: list[Any]) -> list[str]:
    """A dict entry becomes a framed ``data:`` line; a string is used verbatim."""
    return [line if isinstance(line, str) else _sse(line) for line in raw]


def _build_engine(
    *,
    model: str = DEFAULT_MODEL,
    account_id: str | None = ACCOUNT_ID,
    base_url: str | None = BASE_URL,
    max_reasoning_items: int | None = None,
) -> ChatGPTSubscriptionEngine:
    kwargs: dict[str, Any] = {}
    if max_reasoning_items is not None:
        kwargs["max_reasoning_items"] = max_reasoning_items
    return ChatGPTSubscriptionEngine(
        model=model,
        access_token=ACCESS_TOKEN,
        account_id=account_id,
        base_url=base_url,
        **kwargs,
    )


def _engine_with_client(
    *responses: _FakeSSEStream,
    model: str = DEFAULT_MODEL,
    base_url: str | None = BASE_URL,
) -> tuple[ChatGPTSubscriptionEngine, _FakeStreamingClient]:
    engine = _build_engine(model=model, base_url=base_url)
    client = _FakeStreamingClient(*responses)
    # Captured before the swap: the fake has no base_url of its own, and the
    # resolved value (including the default fallback) is what endpoint cases pin.
    client.base_url = engine._service.base_url
    engine._service._client = client
    return engine, client


def _drain(stream: Any, chunks: list[Any]) -> GenerationResult:
    while True:
        try:
            chunks.append(next(stream))
        except StopIteration as stop:
            return stop.value


def _equal(label: str, actual: Any, expected: Any) -> None:
    assert actual == expected, f"{label}: expected {expected!r}, got {actual!r}"


def _fields(label: str, actual: dict[str, Any], expected: dict[str, Any]) -> None:
    for key, value in expected.items():
        _equal(f"{label}.{key}", actual.get(key), value)


def _project_chunk(chunk: Any) -> dict[str, Any]:
    if isinstance(chunk, ToolCallRequest):
        return {
            "kind": "tool_call",
            "tool_id": chunk.tool_id,
            "call_id": chunk.call_id,
            "arguments": chunk.arguments,
            "coerced": chunk.coerced,
        }
    if isinstance(chunk, StreamingEvent):
        return {"kind": chunk.kind, "text": chunk.text}
    return {"kind": "unprojected", "repr": repr(chunk)}


def _project_result(result: GenerationResult) -> dict[str, Any]:
    usage = result.usage
    return {
        "content": result.content,
        "thinking_text": result.thinking_text,
        "finish_reason": result.finish_reason,
        "tool_calls": [
            {
                "tool_id": call.tool_id,
                "call_id": call.call_id,
                "arguments": call.arguments,
                "coerced": call.coerced,
            }
            for call in result.tool_calls
        ],
        "usage": None
        if usage is None
        else {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "total_tokens": usage.total_tokens,
            "provider": usage.provider,
            "model": usage.model,
        },
    }


def _project_error(error: BaseException) -> dict[str, Any]:
    return {
        "type": type(error).__name__,
        "message": str(error),
        "classification": getattr(error, "classification", None),
        "retryable": getattr(error, "retryable", None),
        "code": getattr(error, "code", None),
        "status_code": getattr(error, "status_code", None),
        "body": getattr(error, "body", None),
    }


def _run_stream(
    case_input: dict[str, Any],
) -> tuple[list[Any], GenerationResult | None, dict[str, Any], BaseException | None]:
    lines = _sse_lines(case_input["sse_lines"])
    cut = case_input.get("raw_byte_framing")
    response = _RawByteStream(lines, cut=int(cut)) if cut else _FakeSSEStream(lines)
    engine, _client = _engine_with_client(response)
    diagnostics: dict[str, Any] = {}
    engine._record_completion_shape = diagnostics.update
    chunks: list[Any] = []
    result: GenerationResult | None = None
    error: BaseException | None = None
    try:
        result = _drain(
            engine.stream_with_tools(
                prompt=case_input.get("prompt", "hi"),
                tools=case_input.get("tools", []),
            ),
            chunks,
        )
    except (ProviderHttpError, GenerationError) as caught:
        error = caught
    finally:
        engine.close()
    return chunks, result, diagnostics, error


def _assert_stream(
    expect: dict[str, Any],
    chunks: list[Any],
    result: GenerationResult | None,
    diagnostics: dict[str, Any],
    error: BaseException | None,
) -> None:
    if "error" in expect:
        assert error is not None, "expected the stream to raise, but it completed"
        _fields("error", _project_error(error), expect["error"])
    else:
        assert error is None, f"stream raised unexpectedly: {error!r}"
    if "stream_items" in expect:
        _equal("stream_items", [_project_chunk(chunk) for chunk in chunks], expect["stream_items"])
    if "result" in expect:
        assert result is not None, "expected a GenerationResult, but the stream raised"
        _fields("result", _project_result(result), expect["result"])
    if "diagnostics" in expect:
        _fields("diagnostics", diagnostics, expect["diagnostics"])


def _bind_sse_stream(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    _assert_stream(expect, *_run_stream(case_input))


def _bind_event_recognition(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    # One event type at a time plus a terminal, so a row claiming "emits nothing"
    # is proved by a stream that really produces nothing.
    events = [*case_input["events"], {"type": "response.completed", "response": {}}]
    _assert_stream(expect, *_run_stream({"sse_lines": events}))


def _bind_initial_status(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    response = _FakeSSEStream(
        [],
        status_code=int(case_input["status_code"]),
        headers=case_input.get("response_headers"),
        body=case_input.get("response_body"),
    )
    error: ProviderHttpError | None = None
    try:
        raise_for_initial_status(response)
    except ProviderHttpError as caught:
        error = caught
    assert error is not None, "expected raise_for_initial_status to raise a ProviderHttpError"
    retry_after = error.retry_after_seconds
    projected = _project_error(error)
    projected["error_type"] = projected["type"]
    projected["retry_after_seconds"] = retry_after
    projected["retry_after_is_non_negative"] = isinstance(retry_after, float) and retry_after >= 0.0
    _fields("initial_status", projected, expect)


def _bind_input_items(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    instructions, items = build_input_items(
        prompt=case_input.get("prompt", ""),
        system=case_input.get("system", ""),
        messages=case_input.get("messages"),
    )
    _fields("input_items", {"instructions": instructions, "items": items}, expect)


def _bind_responses_payload(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    payload = build_responses_payload(
        model=case_input["model"],
        prompt=case_input.get("prompt", ""),
        system=case_input.get("system", ""),
        messages=case_input.get("messages"),
        tools=case_input.get("tools", []),
        reasoning_effort=case_input.get("reasoning_effort"),
    )
    if "payload_fields" in expect:
        _fields("payload", payload, expect["payload_fields"])
    if "payload_key_set" in expect:
        _equal("payload_key_set", sorted(payload), expect["payload_key_set"])


def _bind_function_tools(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    _fields("function_tools", {"tools": build_function_tools(case_input["tools"])}, expect)


def _bind_reasoning_effort(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    wire_value = normalize_reasoning_effort(case_input["value"])
    _fields("reasoning_effort", {"wire_value": wire_value}, expect)


def _bind_model_context_length(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    engine = _build_engine(model=case_input["model"], account_id=None)
    try:
        projected = {"context_length": engine.get_model_context_length()}
    finally:
        engine.close()
    _fields("model_context_length", projected, expect)


def _bind_context_catalog(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    engine = _build_engine(model=case_input["unknown_model"], account_id=None)
    try:
        projected = {
            "catalog": dict(CHATGPT_MODEL_CONTEXT_LENGTHS),
            "catalog_version": MODEL_CATALOG_CONSTANTS["CHATGPT_MODEL_CATALOG_VERSION"],
            "catalog_source": MODEL_CATALOG_CONSTANTS["CHATGPT_MODEL_CATALOG_SOURCE"],
            "fallback_context_length": engine.get_model_context_length(),
        }
    finally:
        engine.close()
    _fields("context_catalog", projected, expect)


def _reasoning_item(capture: dict[str, Any]) -> dict[str, Any]:
    item = capture.get("item")
    if isinstance(item, dict):
        return item
    # Size-only capture: the byte-ceiling case needs multi-megabyte opaque blobs
    # that would be absurd to spell out as fixture bytes.
    return {
        "type": "reasoning",
        "id": f"rs_{capture['call_id']}",
        "encrypted_content": "x" * int(capture["blob_chars"]),
    }


def _bind_reasoning_cache(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    engine = _build_engine(
        account_id=None,
        max_reasoning_items=int(case_input["requested_max_reasoning_items"]),
    )
    try:
        for capture in case_input["captures"]:
            engine._cache_reasoning_items({capture["call_id"]: _reasoning_item(capture)})
        projected = {
            "cached_call_ids": list(engine._reasoning_by_call_id),
            "cache_size": len(engine._reasoning_by_call_id),
            "max_reasoning_items": engine._max_reasoning_items,
        }
    finally:
        engine.close()
    _fields("reasoning_cache", projected, expect)


def _bind_tool_loop_turns(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    turn_1 = case_input["turn_1"]
    turn_2 = case_input["turn_2"]
    engine, client = _engine_with_client(
        _FakeSSEStream(_sse_lines(turn_1["sse_lines"])),
        _FakeSSEStream(_sse_lines(turn_2["sse_lines"])),
    )
    chunks: list[Any] = []
    try:
        result_1 = _drain(
            engine.stream_with_tools(
                prompt=turn_1.get("prompt", ""),
                tools=turn_1.get("tools", []),
            ),
            chunks,
        )
        result_2 = engine.generate_with_tools(
            prompt=turn_2.get("prompt", ""),
            tools=turn_2.get("tools", []),
            messages=turn_2["messages"],
        )
    finally:
        engine.close()
    if "turn_1_stream_items" in expect:
        _equal(
            "turn_1_stream_items",
            [_project_chunk(chunk) for chunk in chunks],
            expect["turn_1_stream_items"],
        )
    if "turn_1_result" in expect:
        _fields("turn_1_result", _project_result(result_1), expect["turn_1_result"])
    if "turn_1_request_tools" in expect:
        _equal("turn_1_request_tools", client.requests[0]["json"]["tools"], expect["turn_1_request_tools"])
    if "turn_2_request_input_items" in expect:
        _equal(
            "turn_2_request_input_items",
            client.requests[1]["json"]["input"],
            expect["turn_2_request_input_items"],
        )
    if "turn_2_result" in expect:
        _fields("turn_2_result", _project_result(result_2), expect["turn_2_result"])


def _bind_request_headers(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    engine = _build_engine(account_id=case_input["account_id"])
    try:
        headers = engine._service._client.headers
        present = [name for name in TEMPLATE_HEADER_NAMES if name in headers]
        projected = {
            "headers": {name: headers[name] for name in present},
            "declared_header_names": present,
        }
    finally:
        engine.close()
    _fields("request_headers", projected, expect)


def _bind_endpoint(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    engine, client = _engine_with_client(
        _FakeSSEStream(_sse_lines(case_input["sse_lines"])),
        base_url=case_input["base_url"],
    )
    try:
        _drain(engine.stream_with_tools(prompt="hi", tools=[]), [])
    finally:
        engine.close()
    request = client.requests[0]
    projected = {
        "method": request["method"],
        "path": request["path"],
        "base_url": client.base_url,
    }
    _fields(
        "endpoint",
        projected,
        {key: value for key, value in expect.items() if key != "payload_fields"},
    )
    if "payload_fields" in expect:
        _fields("endpoint.payload", request["json"], expect["payload_fields"])


def _bind_constant_identity(case_input: dict[str, Any], expect: dict[str, Any]) -> None:
    name = case_input["name"]
    assert name in CONSTANT_OBJECTS, (
        f"constant_identity: '{name}' has no entry in the explicit CONSTANT_OBJECTS table "
        "(a fixture may never name an attribute to resolve dynamically)"
    )
    _fields("constant_identity", {"value": CONSTANT_OBJECTS[name]}, expect)


BINDINGS: dict[str, Callable[[dict[str, Any], dict[str, Any]], None]] = {
    "constant_identity": _bind_constant_identity,
    "context_catalog": _bind_context_catalog,
    "endpoint": _bind_endpoint,
    "event_recognition": _bind_event_recognition,
    "function_tools": _bind_function_tools,
    "initial_status": _bind_initial_status,
    "input_items": _bind_input_items,
    "model_context_length": _bind_model_context_length,
    "reasoning_cache": _bind_reasoning_cache,
    "reasoning_effort": _bind_reasoning_effort,
    "request_headers": _bind_request_headers,
    "responses_payload": _bind_responses_payload,
    "sse_stream": _bind_sse_stream,
    "tool_loop_turns": _bind_tool_loop_turns,
}


def run_case(case: dict[str, Any]) -> None:
    """Execute one already-substituted fixture case against the real engine."""
    binding = case["binding"]
    expect = case["expect"]
    unknown = set(expect) - BINDING_EXPECT_KEYS[binding]
    assert not unknown, f"{case['id']}: expect key(s) {sorted(unknown)} are read by no adapter"
    BINDINGS[binding](case["input"], expect)


__all__ = ["BINDINGS", "CONSTANT_OBJECTS", "TEMPLATE_HEADER_NAMES", "run_case"]
