"""Coverage for sidecar/ai/engines/ollama_runtime.py.

This module is the core Ollama request/stream runtime — the streaming loop,
tool-call reconstruction, thinking-delta handling, and malformed-line guard —
and before this file it had zero dedicated tests despite max-complexity ruff
suppression. The functions take ``engine: Any`` and lean on a wide ``engine._*``
surface, so a duck-typed ``FakeEngine`` (the same pattern as test_chat.py's
stub router/engine) exercises them without a real Ollama daemon. Streaming
paths drive ``urllib.request.urlopen`` directly, so those tests monkeypatch it
to return a scripted NDJSON response.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any

import pytest

from sidecar.ai.engines import ollama_stream_thinking
from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.ollama_runtime import (
    _as_dict,
    _as_list,
    _engine_request_id,
    _is_retryable_transport_error,
    _note_malformed_stream_line,
    _thinking_delta,
    _thinking_stop_reason,
    _thinking_suppressed,
    generate,
    generate_with_tools_impl,
    plain_generate_result,
    sanitize_output,
    stream,
    stream_with_tools,
)
from sidecar.ai.engines.ollama_telemetry import build_usage_from_done_chunk
from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.tools.tool_call_healing import configure_tool_call_healing
from sidecar.runtime.ollama_support import (
    EngineConnectionError,
    GenerationError,
    ModelNotLoadedError,
    ThinkingRepetitionGuard,
)


@pytest.fixture(autouse=True)
def _reset_healing_cache():
    configure_tool_call_healing(None)
    yield
    configure_tool_call_healing(None)


class _JsonFormat:
    """Duck-typed ResponseFormat with is_json=True."""

    is_json = True
    json_schema = None


class FakeResponse:
    """Context-manager iterable over scripted NDJSON byte lines."""

    def __init__(self, lines: list[bytes]):
        self._lines = lines
        self.closed = False

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: Any) -> bool:
        return False

    def __iter__(self):
        return iter(self._lines)

    def close(self) -> None:
        self.closed = True


def _raising_post(exc: BaseException):
    def _post(_path: str, _data: dict[str, Any]) -> dict[str, Any]:
        raise exc

    return _post


class FakeEngine:
    """Minimal duck-typed OllamaEngine implementing the ``engine._*`` surface
    the runtime helpers call. Identity transforms keep assertions tied to the
    real ``sanitize_output`` helper rather than this fake's behavior."""

    def __init__(
        self,
        *,
        post_response: Any = None,
        model_name: str = "gemma",
        host: str = "http://localhost:11434",
        reasoning_parser: Any = None,
        think_value: Any = None,
    ):
        self.model_name = model_name
        self.host = host
        self._request_timeout_seconds = 30
        self._post_response = post_response if post_response is not None else {}
        self._reasoning_parser = reasoning_parser
        self._think_value = think_value
        self.visible_outputs: list[str] = []
        self.provider_requests: list[dict[str, Any]] = []
        self.usages: list[dict[str, Any]] = []
        self.completed = 0
        self.first_chunks = 0

    # readiness / message + option building
    def _assert_ready(self) -> None:
        pass

    def _build_messages(self, prompt: str, system: str, messages: list[Any] | None) -> list[Any]:
        out: list[Any] = []
        if system:
            out.append({"role": "system", "content": system})
        if messages:
            out.extend(messages)
        out.append({"role": "user", "content": prompt})
        return out

    def _build_think_value(self, _reasoning_effort: str | None) -> Any:
        return self._think_value

    def _effective_temperature(self, temperature: float) -> float:
        return temperature

    def _effective_top_k(self) -> Any:
        return None

    def _effective_top_p(self) -> Any:
        return None

    def _effective_min_p(self) -> Any:
        return None

    def _effective_repeat_penalty(self) -> Any:
        return None

    def _build_options(self, max_tokens: int, temperature: float, **_kwargs: Any) -> dict[str, Any]:
        return {"num_predict": max_tokens, "temperature": temperature}

    def _build_tools_payload_cached(self, tools: list[Any] | None) -> list[Any]:
        return list(tools or [])

    # recording hooks
    def _record_provider_request(self, **kwargs: Any) -> None:
        self.provider_requests.append(kwargs)

    def _complete_provider_request(self) -> None:
        self.completed += 1

    def _record_first_chunk(self) -> None:
        self.first_chunks += 1

    def _record_visible_output(self, text: str) -> None:
        self.visible_outputs.append(text)

    def _record_provider_usage(self, chunk: dict[str, Any]) -> None:
        self.usages.append(chunk)

    # reasoning / thinking
    def _sanitize_thinking(self, text: str) -> str:
        return text

    def _extract_request_reasoning(self, _raw: str, parser_mode: str = "") -> Any:
        return None

    def _create_request_reasoning_parser(self) -> Any:
        return self._reasoning_parser

    def _thinking_token_headroom(self) -> int:
        return 1000

    def _log_reasoning_parser_fallback(self, **_kwargs: Any) -> None:
        pass

    def _request_id(self) -> str:
        return "req-1"

    # transport
    def _post(self, path: str, data: dict[str, Any]) -> dict[str, Any]:
        if callable(self._post_response):
            return self._post_response(path, data)
        return self._post_response

    # error classification
    def _is_timeout_url_error(self, _error: BaseException) -> bool:
        return False

    def _describe_url_error(self, error: Any, operation: str) -> str:
        # Delegate to the real engine so this fake can't drift from the
        # production HTTP-vs-connection message logic.
        return OllamaEngine._describe_url_error(self, error, operation)  # type: ignore[arg-type]

    def _is_timeout_error(self, _error: BaseException) -> bool:
        return False

    def _timeout_message(self, label: str) -> str:
        return f"{label} timed out"

    def _extract_http_status(self, _error: BaseException) -> Any:
        return None


# --------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------

def test_as_dict_and_as_list_coerce_non_matching_types():
    assert _as_dict({"a": 1}) == {"a": 1}
    assert _as_dict(["x"]) == {}
    assert _as_dict(None) == {}
    assert _as_list([1, 2]) == [1, 2]
    assert _as_list({"a": 1}) == []
    assert _as_list(None) == []


def test_is_retryable_transport_error_matrix():
    assert _is_retryable_transport_error(ConnectionResetError()) is True
    assert _is_retryable_transport_error(BrokenPipeError()) is True
    assert _is_retryable_transport_error(OSError(104, "reset")) is True
    assert _is_retryable_transport_error(ValueError("Connection reset by peer")) is True
    assert _is_retryable_transport_error(ValueError("remote end closed connection")) is True
    assert _is_retryable_transport_error(ValueError("totally unrelated")) is False


def test_thinking_delta_branches():
    assert _thinking_delta("abc", "") == ("", "abc")
    assert _thinking_delta("...0", "0") == ("0", "...00")
    assert _thinking_delta("", " is") == (" is", " is")
    assert _thinking_delta(" is", " island") == (" island", " is island")
    # Repeats and prefix-shaped chunks are real deltas, whatever their length.
    assert _thinking_delta("x" * 40, "x" * 40) == ("x" * 40, "x" * 80)
    assert _thinking_delta("x" * 40, "x" * 40 + "tail") == ("x" * 40 + "tail", "x" * 80 + "tail")
    assert _thinking_delta("abc", "abc") == ("abc", "abcabc")


def test_thinking_stop_reason_and_suppressed_with_no_guard():
    assert _thinking_stop_reason(None) is None
    assert _thinking_suppressed(None, "anything") is False


def test_thinking_guard_suppresses_repetition():
    guard = ThinkingRepetitionGuard(max_chars=40)
    # Feeding the same fragment many times should eventually trip the guard.
    tripped = any(_thinking_suppressed(guard, "loop ") for _ in range(50))
    assert tripped is True
    assert _thinking_stop_reason(guard) is not None


def test_note_malformed_stream_line_counts_and_caps_logging(caplog):
    engine = FakeEngine()
    count = 0
    with caplog.at_level("WARNING"):
        for _ in range(5):
            count = _note_malformed_stream_line(engine, count, b"{bad json")
    assert count == 5
    # Only the first _MALFORMED_LINE_LOG_CAP occurrences are logged.
    assert len(caplog.records) == ollama_stream_thinking._MALFORMED_LINE_LOG_CAP


def test_note_malformed_stream_line_tolerates_non_sized_line():
    engine = FakeEngine()
    assert _note_malformed_stream_line(engine, 0, object()) == 1


def test_engine_request_id_resolution():
    assert _engine_request_id(FakeEngine()) == "req-1"

    class NoGetter:
        pass

    assert _engine_request_id(NoGetter()) is None

    class Raises:
        def _request_id(self):
            raise RuntimeError("boom")

    assert _engine_request_id(Raises()) is None

    class Blank:
        def _request_id(self):
            return "   "

    assert _engine_request_id(Blank()) is None


def test_sanitize_output_strips_think_block_and_bare_thought():
    assert sanitize_output("") == ""
    # closing </think> keeps only the trailing visible text
    assert "answer" in sanitize_output("<think>secret</think>answer")
    # bare "thought ..." prefix with a paragraph break drops the reasoning
    cleaned = sanitize_output("thought reasoning here\n\nThe real answer")
    assert "The real answer" in cleaned
    assert "reasoning here" not in cleaned


# --------------------------------------------------------------------------
# generate (non-streaming)
# --------------------------------------------------------------------------

def test_generate_returns_sanitized_content_and_records_lifecycle():
    engine = FakeEngine(post_response={"message": {"content": "Hello world"}})
    result = generate(engine, prompt="hi", system="sys")
    assert result == sanitize_output("Hello world").strip()
    assert engine.completed == 1
    assert engine.first_chunks == 1
    assert engine.visible_outputs == [result]
    # system message + user message recorded
    assert engine.provider_requests[0]["message_count"] == 2
    assert engine.provider_requests[0]["tool_capable"] is False


def test_generate_sets_think_and_json_format_flags():
    captured: dict[str, Any] = {}

    def _post(_path: str, data: dict[str, Any]) -> dict[str, Any]:
        captured.update(data)
        return {"message": {"content": "ok"}}

    engine = FakeEngine(post_response=_post, think_value=True)
    generate(engine, prompt="hi", response_format=_JsonFormat())
    assert captured["think"] is True
    assert captured["format"] == "json"
    assert engine.provider_requests[0]["think_enabled"] is True


def test_generate_records_the_effective_outbound_sampler_options():
    class SamplerEngine(FakeEngine):
        def _build_options(
            self,
            max_tokens: int,
            temperature: float,
            **_kwargs: Any,
        ) -> dict[str, Any]:
            return {
                "num_predict": max_tokens,
                "temperature": temperature,
                "top_k": 40,
                "repeat_penalty": 1.15,
            }

    engine = SamplerEngine(post_response={"message": {"content": "ok"}})
    generate(engine, prompt="hi", temperature=1.0)

    assert engine.provider_requests[0]["provider_sampler"] == {
        "num_predict": engine.provider_requests[0]["num_predict"],
        "temperature": 1.0,
        "top_k": 40,
        "repeat_penalty": 1.15,
    }


def test_generate_json_object_without_schema_sets_plain_json_format():
    """Parity: ResponseFormat(type="json_object") with no schema -> "json" literal,
    identical to the pre-passthrough behavior."""
    captured: dict[str, Any] = {}

    def _post(_path: str, data: dict[str, Any]) -> dict[str, Any]:
        captured.update(data)
        return {"message": {"content": "ok"}}

    engine = FakeEngine(post_response=_post)
    generate(engine, prompt="hi", response_format=ResponseFormat(type="json_object"))
    assert captured["format"] == "json"


def test_generate_passes_json_schema_dict_through_to_format_field():
    captured: dict[str, Any] = {}

    def _post(_path: str, data: dict[str, Any]) -> dict[str, Any]:
        captured.update(data)
        return {"message": {"content": "ok"}}

    schema = {"type": "object", "properties": {"answer": {"type": "string"}}}
    engine = FakeEngine(post_response=_post)
    generate(
        engine,
        prompt="hi",
        response_format=ResponseFormat(type="json_object", json_schema=schema),
    )
    assert captured["format"] == schema


def test_generate_text_format_omits_format_key():
    captured: dict[str, Any] = {}

    def _post(_path: str, data: dict[str, Any]) -> dict[str, Any]:
        captured.update(data)
        return {"message": {"content": "ok"}}

    engine = FakeEngine(post_response=_post)
    generate(engine, prompt="hi", response_format=ResponseFormat(type="text"))
    assert "format" not in captured


def test_generate_maps_url_timeout_to_generation_error():
    engine = FakeEngine(post_response=_raising_post(urllib.error.URLError("slow")))
    engine._is_timeout_url_error = lambda _error: True
    with pytest.raises(GenerationError):
        generate(engine, prompt="hi")
    assert engine.completed == 1


def test_generate_maps_url_error_to_connection_error():
    engine = FakeEngine(post_response=_raising_post(urllib.error.URLError("down")))
    with pytest.raises(EngineConnectionError):
        generate(engine, prompt="hi")


def test_generate_reraises_model_not_loaded():
    engine = FakeEngine(post_response=_raising_post(ModelNotLoadedError("no model")))
    with pytest.raises(ModelNotLoadedError):
        generate(engine, prompt="hi")


def test_generate_wraps_unexpected_errors():
    engine = FakeEngine(post_response=_raising_post(ValueError("weird")))
    with pytest.raises(GenerationError):
        generate(engine, prompt="hi")


# --------------------------------------------------------------------------
# generate_with_tools_impl (non-streaming, tool-capable)
# --------------------------------------------------------------------------

def _impl(engine: FakeEngine, tools: list[dict[str, Any]] | None = None):
    return generate_with_tools_impl(
        engine,
        prompt="hi",
        tools=tools or [],
        max_tokens=128,
        temperature=0.5,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system="",
        messages=None,
        response_format=None,
    )


def test_generate_with_tools_reconstructs_native_tool_calls():
    engine = FakeEngine(
        post_response={
            "message": {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "read_file", "arguments": {"path": "a"}}, "id": "c1"}
                ],
            }
        }
    )
    result = _impl(engine, tools=[{"function": {"name": "read_file"}}])
    assert result.finish_reason == "tool_calls"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_id == "read_file"
    assert result.tool_calls[0].arguments == {"path": "a"}


def test_generate_with_tools_plain_text_finishes_stop():
    engine = FakeEngine(post_response={"message": {"content": "just text"}})
    result = _impl(engine)
    assert result.finish_reason == "stop"
    assert result.tool_calls == ()
    assert result.content == sanitize_output("just text").strip()


def test_generate_with_tools_json_object_without_schema_parity():
    """Parity: ResponseFormat(type="json_object") with no schema and no tools
    -> "json" literal, matching the with-tools builder's behavior today."""
    captured: dict[str, Any] = {}

    def _post(_path: str, data: dict[str, Any]) -> dict[str, Any]:
        captured.update(data)
        return {"message": {"content": "ok"}}

    engine = FakeEngine(post_response=_post)
    generate_with_tools_impl(
        engine,
        prompt="hi",
        tools=[],
        max_tokens=128,
        temperature=0.5,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system="",
        messages=None,
        response_format=ResponseFormat(type="json_object"),
    )
    assert captured["format"] == "json"


def test_generate_with_tools_schema_and_nonempty_tools_falls_back_to_plain_json():
    """INVARIANT PIN: non-streaming with-tools builder must never combine a
    non-empty tools payload with a schema-dict format."""
    captured: dict[str, Any] = {}

    def _post(_path: str, data: dict[str, Any]) -> dict[str, Any]:
        captured.update(data)
        return {"message": {"content": "just text"}}

    schema = {"type": "object", "properties": {"answer": {"type": "string"}}}
    engine = FakeEngine(post_response=_post)
    generate_with_tools_impl(
        engine,
        prompt="hi",
        tools=[{"function": {"name": "read_file"}}],
        max_tokens=128,
        temperature=0.5,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system="",
        messages=None,
        response_format=ResponseFormat(type="json_object", json_schema=schema),
    )
    assert captured["format"] == "json"
    assert captured["tools"]


def test_generate_with_tools_schema_and_empty_tools_passes_schema_through():
    captured: dict[str, Any] = {}

    def _post(_path: str, data: dict[str, Any]) -> dict[str, Any]:
        captured.update(data)
        return {"message": {"content": "just text"}}

    schema = {"type": "object", "properties": {"answer": {"type": "string"}}}
    engine = FakeEngine(post_response=_post)
    generate_with_tools_impl(
        engine,
        prompt="hi",
        tools=[],
        max_tokens=128,
        temperature=0.5,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system="",
        messages=None,
        response_format=ResponseFormat(type="json_object", json_schema=schema),
    )
    assert captured["format"] == schema
    assert captured["tools"] == []


# --------------------------------------------------------------------------
# plain_generate_result (wraps generate + maps HTTP-status connection errors)
# --------------------------------------------------------------------------

def test_plain_generate_result_happy_path():
    engine = FakeEngine(post_response={"message": {"content": "hello"}})
    result = plain_generate_result(
        engine,
        prompt="hi",
        max_tokens=64,
        temperature=0.5,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system="",
        messages=None,
        response_format=None,
    )
    assert result.finish_reason == "stop"
    assert result.content == "hello"


def test_plain_generate_result_maps_http_status_connection_error():
    engine = FakeEngine(post_response=_raising_post(EngineConnectionError("http 400")))
    engine._extract_http_status = lambda _error: 400
    with pytest.raises(GenerationError):
        plain_generate_result(
            engine,
            prompt="hi",
            max_tokens=64,
            temperature=0.5,
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system="",
            messages=None,
            response_format=None,
        )


def test_plain_generate_result_reraises_connection_error_without_status():
    engine = FakeEngine(post_response=_raising_post(EngineConnectionError("transient")))
    with pytest.raises(EngineConnectionError):
        plain_generate_result(
            engine,
            prompt="hi",
            max_tokens=64,
            temperature=0.5,
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system="",
            messages=None,
            response_format=None,
        )


# --------------------------------------------------------------------------
# stream / stream_with_tools (drive urllib.request.urlopen)
# --------------------------------------------------------------------------

def _patch_urlopen(monkeypatch, lines: list[bytes]) -> None:
    monkeypatch.setattr(
        urllib.request, "urlopen", lambda _req, timeout=None: FakeResponse(lines)
    )


def test_stream_yields_content_chunks_then_done(monkeypatch):
    lines = [
        json.dumps({"message": {"content": "Hello"}}).encode() + b"\n",
        json.dumps({"message": {"content": "world"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    events = list(stream(engine, prompt="hi"))
    assert [e.kind for e in events] == ["content", "content", "done"]
    assert events[0].text == sanitize_output("Hello")
    assert events[1].text == sanitize_output("world")
    assert events[-1].finish_reason == "stop"
    assert engine.completed == 1
    assert engine.usages  # provider usage recorded from the terminal chunk


def test_stream_emits_native_thinking_events(monkeypatch):
    lines = [
        json.dumps({"message": {"thinking": "reasoning", "content": ""}}).encode() + b"\n",
        json.dumps({"message": {"content": "answer"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    events = list(stream(engine, prompt="hi"))
    kinds = [e.kind for e in events]
    assert kinds == ["thinking", "content", "done"]
    assert events[0].text == "reasoning"


def test_stream_skips_malformed_lines_without_crashing(monkeypatch):
    lines = [
        b"{not valid json\n",
        json.dumps({"message": {"content": "ok"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    events = list(stream(engine, prompt="hi"))
    # malformed line skipped; the valid content chunk + done still emitted
    assert [e.kind for e in events] == ["content", "done"]


def test_stream_passes_json_schema_dict_through_to_format_field(monkeypatch):
    captured: dict[str, Any] = {}

    def _fake_urlopen(req, timeout=None):
        captured.update(json.loads(req.data.decode("utf-8")))
        lines = [
            json.dumps({"message": {"content": "ok"}, "done": True}).encode() + b"\n",
        ]
        return FakeResponse(lines)

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    schema = {"type": "object", "properties": {"answer": {"type": "string"}}}
    engine = FakeEngine()
    list(
        stream(
            engine,
            prompt="hi",
            response_format=ResponseFormat(type="json_object", json_schema=schema),
        )
    )
    assert captured["format"] == schema


def test_stream_maps_connection_failure(monkeypatch):
    def _boom(_req, timeout=None):
        raise urllib.error.URLError("refused")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    engine = FakeEngine()
    with pytest.raises(EngineConnectionError):
        list(stream(engine, prompt="hi"))
    assert engine.completed == 1


def test_stream_with_tools_collects_native_tool_calls(monkeypatch):
    lines = [
        json.dumps({"message": {"content": "Calling"}}).encode() + b"\n",
        json.dumps(
            {
                "message": {
                    "tool_calls": [
                        {"function": {"name": "read_file", "arguments": {"path": "a"}}, "id": "c1"}
                    ]
                },
                "done": True,
            }
        ).encode()
        + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    gen = stream_with_tools(engine, prompt="hi", tools=[{"function": {"name": "read_file"}}])
    events: list[Any] = []
    result = None
    try:
        while True:
            events.append(next(gen))
    except StopIteration as stop:
        result = stop.value
    assert any(e.kind == "content" for e in events)
    assert result is not None
    assert result.finish_reason == "tool_calls"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_id == "read_file"
    assert result.tool_calls[0].arguments == {"path": "a"}


def test_stream_with_tools_clamps_pre_response_stall_to_absolute_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_timeout: list[float] = []

    def _stall_before_response(_req: Any, *, timeout: float) -> None:
        captured_timeout.append(float(timeout))
        raise TimeoutError("stalled before response")

    monkeypatch.setattr(urllib.request, "urlopen", _stall_before_response)
    engine = FakeEngine()

    with pytest.raises(GenerationError):
        list(
            stream_with_tools(
                engine,
                prompt="stall",
                tools=[],
                wall_clock_deadline=time.monotonic() + 0.04,
            )
        )

    # urllib has no cancellable request handle before urlopen() returns. The
    # remaining turn budget is therefore the explicit hard upper bound for
    # this acquisition phase (50 ms floor avoids zero meaning no timeout).
    assert captured_timeout and captured_timeout[0] <= 0.06


def test_stream_with_tools_schema_and_nonempty_tools_falls_back_to_plain_json(monkeypatch):
    """INVARIANT PIN: a schema'd ResponseFormat combined with a non-empty tools
    payload must never let the schema dict reach ``format`` — Ollama's behavior
    for tools+schema-dict together is undefined, so tools wins and format stays
    the plain "json" string."""
    captured: dict[str, Any] = {}

    def _fake_urlopen(req, timeout=None):
        captured.update(json.loads(req.data.decode("utf-8")))
        lines = [
            json.dumps({"message": {"content": "final answer"}, "done": True}).encode() + b"\n",
        ]
        return FakeResponse(lines)

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    schema = {"type": "object", "properties": {"answer": {"type": "string"}}}
    engine = FakeEngine()
    gen = stream_with_tools(
        engine,
        prompt="hi",
        tools=[{"function": {"name": "read_file"}}],
        response_format=ResponseFormat(type="json_object", json_schema=schema),
    )
    try:
        while True:
            next(gen)
    except StopIteration:
        pass
    assert captured["format"] == "json"
    assert captured["tools"]  # non-empty tools payload present in the same request


def test_stream_with_tools_schema_and_empty_tools_passes_schema_through(monkeypatch):
    """With an empty tools list the invariant doesn't apply — the schema dict
    may pass through."""
    captured: dict[str, Any] = {}

    def _fake_urlopen(req, timeout=None):
        captured.update(json.loads(req.data.decode("utf-8")))
        lines = [
            json.dumps({"message": {"content": "final answer"}, "done": True}).encode() + b"\n",
        ]
        return FakeResponse(lines)

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    schema = {"type": "object", "properties": {"answer": {"type": "string"}}}
    engine = FakeEngine()
    gen = stream_with_tools(
        engine,
        prompt="hi",
        tools=[],
        response_format=ResponseFormat(type="json_object", json_schema=schema),
    )
    try:
        while True:
            next(gen)
    except StopIteration:
        pass
    assert captured["format"] == schema
    assert captured["tools"] == []


def test_stream_with_tools_plain_completion_finishes_stop(monkeypatch):
    lines = [
        json.dumps({"message": {"content": "final answer"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    result = None
    try:
        while True:
            next(gen)
    except StopIteration as stop:
        result = stop.value
    assert result is not None
    assert result.finish_reason == "stop"
    assert result.tool_calls == ()
    assert "final answer" in result.content


# --------------------------------------------------------------------------
# Native tool-call argument healing (tool_call_reliability_net_enabled)
# --------------------------------------------------------------------------


def _stream_with_tools_result(engine: FakeEngine, monkeypatch, arguments_value: Any):
    lines = [
        json.dumps(
            {
                "message": {
                    "content": "",
                    "tool_calls": [
                        {
                            "function": {
                                "name": "grep_search",
                                "arguments": arguments_value,
                            },
                            "id": "c1",
                        }
                    ],
                },
                "done": True,
            }
        ).encode()
        + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    gen = stream_with_tools(
        engine, prompt="hi", tools=[{"function": {"name": "grep_search"}}]
    )
    result = None
    try:
        while True:
            next(gen)
    except StopIteration as stop:
        result = stop.value
    return result


def _generate_with_tools_result(engine: FakeEngine, arguments_value: Any):
    engine._post_response = {
        "message": {
            "content": "",
            "tool_calls": [
                {
                    "function": {"name": "grep_search", "arguments": arguments_value},
                    "id": "c1",
                }
            ],
        }
    }
    return _impl(engine, tools=[{"function": {"name": "grep_search"}}])


def test_string_arguments_drop_to_empty_dict_when_healing_off(monkeypatch):
    """Flag-OFF parity pin: native string-typed ``arguments`` coerce to ``{}``
    — this is today's shipped (buggy) behavior and must not change while the
    reliability net is disabled."""
    configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
    engine = FakeEngine()
    result = _stream_with_tools_result(engine, monkeypatch, '{"pattern": "x"}')
    assert result.tool_calls[0].arguments == {}
    assert getattr(result.tool_calls[0], "coerced", False) is False


def test_string_arguments_drop_to_empty_dict_non_stream_when_healing_off():
    """Same flag-OFF parity pin on the non-streaming with-tools path."""
    configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
    engine = FakeEngine()
    result = _generate_with_tools_result(engine, '{"pattern": "x"}')
    assert result.tool_calls[0].arguments == {}
    assert getattr(result.tool_calls[0], "coerced", False) is False


def test_string_arguments_parsed_when_healing_on_stream(monkeypatch):
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    engine = FakeEngine()
    result = _stream_with_tools_result(engine, monkeypatch, '{"pattern": "x"}')
    assert result.tool_calls[0].arguments == {"pattern": "x"}
    assert getattr(result.tool_calls[0], "coerced", False) is False


def test_string_arguments_parsed_when_healing_on_non_stream():
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    engine = FakeEngine()
    result = _generate_with_tools_result(engine, '{"pattern": "x"}')
    assert result.tool_calls[0].arguments == {"pattern": "x"}
    assert getattr(result.tool_calls[0], "coerced", False) is False


def test_single_quoted_string_arguments_healed_when_on_stream(monkeypatch):
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    engine = FakeEngine()
    result = _stream_with_tools_result(engine, monkeypatch, "{'pattern': 'x'}")
    assert result.tool_calls[0].arguments == {"pattern": "x"}
    assert getattr(result.tool_calls[0], "coerced", False) is False


def test_trailing_comma_string_arguments_healed_when_on_non_stream():
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    engine = FakeEngine()
    result = _generate_with_tools_result(engine, '{"pattern": "x",}')
    assert result.tool_calls[0].arguments == {"pattern": "x"}
    assert getattr(result.tool_calls[0], "coerced", False) is False


def test_unhealable_string_arguments_fall_back_to_empty_dict_when_on(monkeypatch):
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    engine = FakeEngine()
    result = _stream_with_tools_result(engine, monkeypatch, "@@@")
    assert result.tool_calls[0].arguments == {}
    assert getattr(result.tool_calls[0], "coerced", False) is False


def test_dict_arguments_passthrough_unchanged_when_on_non_stream():
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    engine = FakeEngine()
    result = _generate_with_tools_result(engine, {"pattern": "x"})
    assert result.tool_calls[0].arguments == {"pattern": "x"}
    assert getattr(result.tool_calls[0], "coerced", False) is False


def test_dict_arguments_passthrough_unchanged_when_off_stream(monkeypatch):
    configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
    engine = FakeEngine()
    result = _stream_with_tools_result(engine, monkeypatch, {"pattern": "x"})
    assert result.tool_calls[0].arguments == {"pattern": "x"}
    assert getattr(result.tool_calls[0], "coerced", False) is False


# --------------------------------------------------------------------------
# Provider-truth usage from the done chunk (context-meter work)
# --------------------------------------------------------------------------

def test_build_usage_from_done_chunk_table():
    # Not a dict / counts missing / present-but-zero all fall through to None
    # so the meter estimates instead of reading 0.
    assert build_usage_from_done_chunk(None, model_name="gemma") is None
    assert build_usage_from_done_chunk({"done": True}, model_name="gemma") is None
    assert (
        build_usage_from_done_chunk(
            {"prompt_eval_count": 0, "eval_count": 0}, model_name="gemma"
        )
        is None
    )
    assert (
        build_usage_from_done_chunk(
            {"prompt_eval_count": -3, "eval_count": "bogus"}, model_name="gemma"
        )
        is None
    )
    usage = build_usage_from_done_chunk(
        {"prompt_eval_count": 120, "eval_count": 18}, model_name="gemma"
    )
    assert usage is not None
    assert usage.input_tokens == 120
    assert usage.output_tokens == 18
    assert usage.total_tokens == 138
    assert usage.last_request_input_tokens == 120
    assert usage.provider == "ollama"
    assert usage.model == "gemma"


def test_stream_with_tools_attaches_provider_usage(monkeypatch):
    lines = [
        json.dumps({"message": {"content": "Calling"}}).encode() + b"\n",
        json.dumps(
            {
                "message": {
                    "tool_calls": [
                        {"function": {"name": "read_file", "arguments": {"path": "a"}}, "id": "c1"}
                    ]
                },
                "done": True,
                "prompt_eval_count": 120,
                "eval_count": 18,
            }
        ).encode()
        + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    gen = stream_with_tools(engine, prompt="hi", tools=[{"function": {"name": "read_file"}}])
    result = None
    try:
        while True:
            next(gen)
    except StopIteration as stop:
        result = stop.value
    assert result is not None
    assert result.usage is not None
    assert result.usage.input_tokens == 120
    assert result.usage.output_tokens == 18
    assert result.usage.last_request_input_tokens == 120
    assert result.usage.provider == "ollama"


def test_stream_with_tools_zero_usage_stays_none(monkeypatch):
    lines = [
        json.dumps(
            {
                "message": {"content": "done"},
                "done": True,
                "prompt_eval_count": 0,
                "eval_count": 0,
            }
        ).encode()
        + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    result = None
    try:
        while True:
            next(gen)
    except StopIteration as stop:
        result = stop.value
    assert result is not None
    assert result.usage is None


def test_stream_done_event_carries_provider_usage(monkeypatch):
    lines = [
        json.dumps({"message": {"content": "Hello"}}).encode() + b"\n",
        json.dumps(
            {
                "message": {"content": ""},
                "done": True,
                "prompt_eval_count": 64,
                "eval_count": 7,
                "eval_duration": 2_000_000_000,
                "prompt_eval_duration": 300_000_000,
                "load_duration": 50_000_000,
            }
        ).encode()
        + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    engine._current_time_to_first_token_ms = lambda: 321  # type: ignore[attr-defined]
    events = list(stream(engine, prompt="hi"))
    done_event = events[-1]
    assert done_event.kind == "done"
    assert done_event.usage is not None
    assert done_event.usage.input_tokens == 64
    assert done_event.usage.output_tokens == 7
    assert done_event.usage.last_request_input_tokens == 64
    assert done_event.usage.generation_tokens == 7
    assert done_event.usage.generation_duration_ms == pytest.approx(2000)
    assert done_event.usage.prompt_eval_duration_ms == pytest.approx(300)
    assert done_event.usage.load_duration_ms == pytest.approx(50)
    assert done_event.usage.time_to_first_token_ms == pytest.approx(321)


def test_stream_done_event_usage_none_when_counts_missing(monkeypatch):
    lines = [
        json.dumps({"message": {"content": "Hello"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    events = list(stream(engine, prompt="hi"))
    assert events[-1].kind == "done"
    assert events[-1].usage is None


def test_generate_with_tools_impl_attaches_provider_usage():
    engine = FakeEngine(
        post_response={
            "message": {"content": "answer"},
            "done": True,
            "prompt_eval_count": 42,
            "eval_count": 5,
        }
    )
    result = generate_with_tools_impl(
        engine,
        prompt="hi",
        tools=[],
        max_tokens=64,
        temperature=0.1,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system="",
        messages=None,
        response_format=None,
    )
    assert result.usage is not None
    assert result.usage.input_tokens == 42
    assert result.usage.output_tokens == 5
    assert result.usage.last_request_input_tokens == 42


def test_native_tool_call_carries_structural_argument_repairs():
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    engine = FakeEngine(
        post_response={
            "message": {
                "content": "",
                "tool_calls": [
                    {
                        "function": {
                            "name": "read_file",
                            # Truncated inside the second value: the healer
                            # closes the string and the object.
                            "arguments": '{"path": "a.txt", "content": "hel',
                        },
                        "id": "repaired-call",
                    }
                ],
            }
        }
    )

    result = _impl(engine, tools=[{"function": {"name": "read_file"}}])

    assert result.tool_calls[0].arguments == {"path": "a.txt", "content": "hel"}
    assert "closed_string" in result.tool_calls[0].argument_repairs
    assert "closed_brace" in result.tool_calls[0].argument_repairs


def test_native_tool_call_clean_dict_has_no_argument_repairs():
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    engine = FakeEngine(
        post_response={
            "message": {
                "content": "",
                "tool_calls": [
                    {
                        "function": {
                            "name": "read_file",
                            "arguments": {"path": "a"},
                        },
                        "id": "clean-call",
                    }
                ],
            }
        }
    )

    result = _impl(engine, tools=[{"function": {"name": "read_file"}}])

    assert result.tool_calls[0].argument_repairs == ()
