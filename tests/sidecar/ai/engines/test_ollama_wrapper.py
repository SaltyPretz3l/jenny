"""Regression tests for native Ollama engine resilience behaviors."""

from __future__ import annotations

import json
import logging
import socket
import threading
import urllib.error
import urllib.request

import pytest

from sidecar.ai.engines.ollama import OllamaEngine, _merge_consecutive_system_messages
from sidecar.ai.engines.ollama_metadata import build_tools_payload
from sidecar.ai.exceptions import EngineConnectionError, GenerationError
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore

_PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _connection_error_with_status(status_code: int) -> EngineConnectionError:
    error = EngineConnectionError(
        "Could not connect to Ollama server at http://localhost:11434: "
        f"HTTP Error {status_code}: Bad Request"
    )
    error.__cause__ = urllib.error.HTTPError(
        url="http://localhost:11434/api/chat",
        code=status_code,
        msg="Bad Request",
        hdrs=None,
        fp=None,
    )
    return error


def test_describe_url_error_5xx_reports_runner_failure_not_connectivity() -> None:
    engine = _build_engine()
    http_500 = urllib.error.HTTPError(
        url="http://localhost:11434/api/chat",
        code=500,
        msg="Internal Server Error",
        hdrs=None,
        fp=None,
    )
    message = engine._describe_url_error(http_500, "streaming generation")  # noqa: SLF001
    # A 500 means the connection succeeded but the runner failed -- the message
    # must NOT blame connectivity, and should point at the real cause.
    assert "could not connect" not in message.lower()
    assert "HTTP 500" in message
    assert "out of memory" in message.lower()
    assert "streaming generation" in message


def test_describe_url_error_4xx_reports_rejection_with_status() -> None:
    engine = _build_engine()
    http_400 = urllib.error.HTTPError(
        url="http://localhost:11434/api/chat",
        code=400,
        msg="Bad Request",
        hdrs=None,
        fp=None,
    )
    message = engine._describe_url_error(http_400, "generation")  # noqa: SLF001
    assert "could not connect" not in message.lower()
    assert "HTTP 400" in message
    assert "out of memory" not in message.lower()


def test_describe_url_error_non_http_is_a_real_connection_failure() -> None:
    engine = _build_engine()
    url_error = urllib.error.URLError("Connection refused")
    message = engine._describe_url_error(url_error, "generation")  # noqa: SLF001
    # A genuine transport failure should still read as a connectivity problem.
    assert "Could not connect to Ollama" in message


def _build_engine(*, tools_enabled: bool = True, ready: bool = True) -> OllamaEngine:
    engine = object.__new__(OllamaEngine)
    engine.host = "http://localhost:11434"
    engine._request_timeout_seconds = 300  # noqa: SLF001
    engine.model_name = "test-model"
    engine._ready = ready  # noqa: SLF001
    engine._vision = False  # noqa: SLF001
    engine._thinking = False  # noqa: SLF001
    engine._tool_calls_enabled = tools_enabled  # noqa: SLF001
    engine._tool_call_http_400_streak = 0  # noqa: SLF001
    engine._context_length = None  # noqa: SLF001
    engine._configured_context_length = None  # noqa: SLF001
    engine._thinking_capability_source = "unsupported"  # noqa: SLF001
    engine._cached_tools_key = None  # noqa: SLF001
    engine._cached_tools_payload = None  # noqa: SLF001
    engine._request_context_lock = threading.Lock()  # noqa: SLF001
    return engine


def test_installed_model_bypasses_acquisition_and_reports_loading_then_ready(monkeypatch) -> None:
    engine = _build_engine(ready=False)
    pulled: list[str] = []
    progress: list[dict[str, object]] = []
    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("present", None))
    monkeypatch.setattr(engine, "_pull_model", lambda name, **_kwargs: pulled.append(name))
    monkeypatch.setattr(engine, "get_model_info", lambda _name: {})
    monkeypatch.setattr(engine, "_warmup_model_async", lambda _name: None)

    engine.load_model("ornith:9b", progress_callback=progress.append)

    assert pulled == []
    assert [item["state"] for item in progress] == ["model_loading", "model_ready"]
    assert engine._ready is True  # noqa: SLF001


def test_transient_catalog_failure_raises_and_never_starts_a_pull(monkeypatch) -> None:
    """F18b: 'we could not reach the catalog' must not read as 'model absent'.

    ``_model_exists`` collapsed ANY exception to ``False`` and ``load_model``
    then started an unconfirmed ``POST /api/pull``. The probe is now tri-state,
    so an unreachable/erroring catalog is a connection error instead.
    """
    engine = _build_engine(ready=False)
    pulled: list[str] = []
    transport_error = urllib.error.URLError(socket.timeout("timed out"))
    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("unavailable", transport_error))
    monkeypatch.setattr(engine, "_pull_model", lambda name, **_kwargs: pulled.append(name))

    with pytest.raises(EngineConnectionError):
        engine.load_model("ornith:9b")

    assert pulled == [], "a probe we could not complete must never trigger a pull"
    assert engine._ready is False  # noqa: SLF001


def test_transient_catalog_failure_reports_the_real_transport_cause(monkeypatch) -> None:
    """The message names the actual failure, not a canned 'Ollama is not running'."""
    engine = _build_engine(ready=False)
    http_500 = urllib.error.HTTPError(
        url="http://localhost:11434/api/tags",
        code=500,
        msg="Internal Server Error",
        hdrs=None,
        fp=None,
    )
    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("unavailable", http_500))
    monkeypatch.setattr(
        engine,
        "_pull_model",
        lambda *_a, **_kw: pytest.fail("must not pull on an unavailable catalog"),
    )

    with pytest.raises(EngineConnectionError) as excinfo:
        engine.load_model("ornith:9b")

    assert "HTTP 500" in str(excinfo.value)


def test_absent_model_still_pulls(monkeypatch) -> None:
    """The tri-state must not break the legitimate acquisition path."""
    engine = _build_engine(ready=False)
    pulled: list[str] = []
    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("absent", None))
    monkeypatch.setattr(engine, "_pull_model", lambda name, **_kwargs: pulled.append(name))
    monkeypatch.setattr(engine, "get_model_info", lambda _name: {})
    monkeypatch.setattr(engine, "_warmup_model_async", lambda _name: None)

    engine.load_model("ornith:9b")

    assert pulled == ["ornith:9b"]
    assert engine._ready is True  # noqa: SLF001


def test_probe_catalog_reports_unavailable_rather_than_absent_on_transport_error(
    monkeypatch,
) -> None:
    """The probe itself must not swallow transport failures into 'absent'."""
    engine = _build_engine(ready=False)

    def _boom(*_args, **_kwargs):
        raise urllib.error.URLError(socket.timeout("timed out"))

    monkeypatch.setattr(urllib.request, "urlopen", _boom)

    state, error = engine._probe_catalog("ornith:9b")  # noqa: SLF001

    assert state == "unavailable"
    assert isinstance(error, urllib.error.URLError)


class _FakeStreamingResponse:
    def __init__(self, chunks: list[dict[str, object]]) -> None:
        self._lines = [json.dumps(chunk).encode("utf-8") for chunk in chunks]
        self.closed = threading.Event()

    def __enter__(self) -> "_FakeStreamingResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        self.close()

    def __iter__(self):
        return iter(self._lines)

    def close(self) -> None:
        self.closed.set()


class _ResettingStreamingResponse:
    def __init__(self) -> None:
        self.closed = threading.Event()

    def __enter__(self) -> "_ResettingStreamingResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        self.close()

    def __iter__(self):
        yield json.dumps({"message": {"content": "Partial answer"}, "done": False}).encode("utf-8")
        raise ConnectionResetError(
            10054,
            "An existing connection was forcibly closed by the remote host",
        )

    def close(self) -> None:
        self.closed.set()


def test_generate_with_tools_falls_back_per_request_after_http_400(monkeypatch) -> None:
    """An HTTP 400 degrades this request only; native tools retry next request."""
    engine = _build_engine()
    tool_call_count = 0
    generate_count = 0

    def fake_generate_with_tools_impl(*, prompt, tools, **kwargs):  # noqa: ANN003, ARG001
        nonlocal tool_call_count
        tool_call_count += 1
        raise _connection_error_with_status(400)

    def fake_generate(prompt="", **kwargs):  # noqa: ANN003, ARG001
        nonlocal generate_count
        generate_count += 1
        return "plain fallback response"

    monkeypatch.setattr(engine, "_generate_with_tools_impl", fake_generate_with_tools_impl)
    monkeypatch.setattr(engine, "generate", fake_generate)

    first = engine.generate_with_tools(prompt="hello", tools=[{"name": "demo"}])
    second = engine.generate_with_tools(prompt="hello again", tools=[{"name": "demo"}])

    assert first.content == "plain fallback response"
    assert second.content == "plain fallback response"
    assert first.degraded_tool_transport is True
    assert second.degraded_tool_transport is True
    # Native tools are attempted on EVERY request — the 400 no longer flips
    # the session capability flag.
    assert tool_call_count == 2
    assert generate_count == 2
    assert engine.supports_tool_calling is True
    assert engine._tool_call_http_400_streak == 2  # noqa: SLF001


def test_http_400_streak_resets_after_native_tool_success(monkeypatch) -> None:
    engine = _build_engine()
    responses = iter(["http_400", "ok"])

    def fake_generate_with_tools_impl(*, prompt, tools, **kwargs):  # noqa: ANN003, ARG001
        if next(responses) == "http_400":
            raise _connection_error_with_status(400)
        return GenerationResult(content="native ok", finish_reason="stop")

    monkeypatch.setattr(engine, "_generate_with_tools_impl", fake_generate_with_tools_impl)
    monkeypatch.setattr(engine, "generate", lambda **kwargs: "plain fallback response")

    degraded = engine.generate_with_tools(prompt="hello", tools=[{"name": "demo"}])
    recovered = engine.generate_with_tools(prompt="again", tools=[{"name": "demo"}])

    assert degraded.degraded_tool_transport is True
    assert recovered.content == "native ok"
    assert recovered.degraded_tool_transport is False
    assert engine._tool_call_http_400_streak == 0  # noqa: SLF001


def test_generate_with_tools_extracts_inband_calls_when_native_tools_disabled(
    monkeypatch,
) -> None:
    engine = _build_engine(tools_enabled=False)

    def fake_generate(prompt="", **kwargs):  # noqa: ANN003, ARG001
        return '<tool_call>\n{"name": "read_file", "arguments": {"path": "notes.md"}}\n</tool_call>'

    monkeypatch.setattr(engine, "generate", fake_generate)

    result = engine.generate_with_tools(
        prompt="read notes",
        tools=[
            {
                "name": "read_file",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            }
        ],
    )

    assert result.finish_reason == "tool_calls"
    assert result.content == ""
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_id == "read_file"
    assert result.tool_calls[0].arguments == {"path": "notes.md"}


def test_generate_with_tools_reports_failed_inband_parse_when_native_tools_disabled(
    monkeypatch,
) -> None:
    engine = _build_engine(tools_enabled=False)
    malformed = "<tool_call>\n{not valid json}\n</tool_call>"
    monkeypatch.setattr(engine, "generate", lambda **_kwargs: malformed)

    result = engine.generate_with_tools(
        prompt="read notes",
        tools=[{"name": "read_file", "parameters": {"type": "object"}}],
    )

    assert result.content == malformed
    assert result.finish_reason == "stop"
    assert result.inband_tool_call_parse_failed is True


def test_stream_with_tools_extracts_inband_calls_when_native_tools_disabled(
    monkeypatch,
) -> None:
    engine = _build_engine(tools_enabled=False)
    response = _FakeStreamingResponse(
        [
            {
                "message": {
                    "content": (
                        "<tool_call>\n"
                        '{"name": "glob_files", "arguments": {"pattern": "*.py"}}\n'
                        "</tool_call>"
                    )
                },
                "done": True,
            }
        ]
    )
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: response)

    stream = engine.stream_with_tools(
        prompt="find files",
        tools=[
            {
                "name": "glob_files",
                "parameters": {
                    "type": "object",
                    "properties": {"pattern": {"type": "string"}},
                    "required": ["pattern"],
                },
            }
        ],
    )

    with pytest.raises(StopIteration) as stopped:
        next(stream)
    result = stopped.value.value

    assert result.finish_reason == "tool_calls"
    assert result.content == ""
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_id == "glob_files"
    assert result.tool_calls[0].arguments == {"pattern": "*.py"}


def test_stream_with_tools_disabled_native_branch_propagates_cancellation_and_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _build_engine(tools_enabled=False)
    handle = TurnCancellationHandle(request_id="req_ollama_fallback_cancel")

    class _CancellingFallbackResponse(_FakeStreamingResponse):
        def __iter__(self):
            yield self._lines[0]  # noqa: SLF001 - deterministic transport double.
            handle.cancel(reason="test_cancel")
            yield self._lines[1]  # noqa: SLF001 - must never be consumed.

    response = _CancellingFallbackResponse(
        [
            {"message": {"content": "partial"}, "done": False},
            {"message": {"content": "must not leak"}, "done": True},
        ]
    )
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: response)

    with pytest.raises(TerminalChatStateError):
        list(
            engine.stream_with_tools(
                prompt="hello",
                tools=[],
                cancel_handle=handle,
            )
        )

    assert response.closed.is_set()


def test_stream_closes_ollama_response_when_cancel_handle_is_cancelled(monkeypatch) -> None:
    engine = _build_engine()
    response = _FakeStreamingResponse(
        [
            {"message": {"content": "hello"}, "done": False},
            {"message": {"content": "after cancel"}, "done": False},
        ]
    )
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: response)
    handle = TurnCancellationHandle(request_id="req_ollama_cancel")

    stream = engine.stream(
        prompt="hello",
        max_tokens=8,
        cancel_handle=handle,
    )

    first = next(stream)
    assert getattr(first, "text", "") == "hello"
    handle.cancel(reason="chat_cancel")

    assert response.closed.is_set()


class _RawLinesStreamingResponse:
    """Streaming response stub that yields raw byte lines verbatim."""

    def __init__(self, lines: list[bytes]) -> None:
        self._lines = lines
        self.closed = threading.Event()

    def __enter__(self) -> "_RawLinesStreamingResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        self.close()

    def __iter__(self):
        return iter(self._lines)

    def close(self) -> None:
        self.closed.set()


def test_stream_counts_and_logs_malformed_ndjson_lines(monkeypatch, caplog) -> None:
    """W3.8: malformed NDJSON lines are skipped loudly, not with a bare continue."""
    engine = _build_engine()
    response = _RawLinesStreamingResponse(
        [
            json.dumps({"message": {"content": "hello"}, "done": False}).encode("utf-8"),
            b'{"message": {"content": "drop',
            b"not json at all",
            b'{"broken": ',
            b'{"also": "broken"',
            json.dumps({"message": {"content": " world"}, "done": True}).encode("utf-8"),
        ]
    )
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: response)

    with caplog.at_level(logging.WARNING, logger="sidecar.ai.engines.ollama_runtime"):
        events = list(engine.stream(prompt="hello", max_tokens=8))

    content = "".join(
        getattr(event, "text", "") for event in events if getattr(event, "kind", "") == "content"
    )
    assert content == "hello world"

    malformed_logs = [
        record for record in caplog.records if "malformed Ollama NDJSON" in record.getMessage()
    ]
    assert len(malformed_logs) == 3  # 4 malformed lines; logging capped at 3
    assert malformed_logs[0].malformed_line_count == 1
    assert malformed_logs[0].further_occurrences_suppressed is False
    assert malformed_logs[2].malformed_line_count == 3
    assert malformed_logs[2].further_occurrences_suppressed is True


def test_generate_with_tools_reports_http_error_when_fallback_fails(monkeypatch) -> None:
    engine = _build_engine()

    def fake_generate_with_tools_impl(**kwargs):  # noqa: ANN003, ARG001
        raise _connection_error_with_status(400)

    def fake_generate(**kwargs):  # noqa: ANN003, ARG001
        raise _connection_error_with_status(404)

    monkeypatch.setattr(engine, "_generate_with_tools_impl", fake_generate_with_tools_impl)
    monkeypatch.setattr(engine, "generate", fake_generate)

    with pytest.raises(GenerationError, match="HTTP 404"):
        engine.generate_with_tools(prompt="hello", tools=[{"name": "demo"}])


def test_load_model_reenables_tool_calling_flag(monkeypatch) -> None:
    engine = _build_engine(tools_enabled=False, ready=False)

    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("present", None))
    monkeypatch.setattr(engine, "get_model_info", lambda name: {})

    engine.load_model("gemma3:4b")

    assert engine.supports_tool_calling is True
    assert engine.model_name == "gemma3:4b"


def test_load_model_disables_tool_calling_when_capability_missing(monkeypatch) -> None:
    engine = _build_engine(tools_enabled=True, ready=False)

    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("present", None))
    monkeypatch.setattr(
        engine,
        "get_model_info",
        lambda name: {"capabilities": ["completion", "vision"]},
    )

    engine.load_model("gemma3:4b")

    assert engine.supports_tool_calling is False


def test_load_model_keeps_tool_calling_for_allowlisted_model_without_capability(
    monkeypatch,
) -> None:
    engine = _build_engine(tools_enabled=False, ready=False)

    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("present", None))
    monkeypatch.setattr(
        engine,
        "get_model_info",
        lambda name: {"capabilities": ["completion", "vision"]},
    )

    engine.load_model("qwen3.6:35b-a3b")

    assert engine.supports_tool_calling is True


def test_load_model_keeps_tool_calling_when_capability_present(monkeypatch) -> None:
    engine = _build_engine(tools_enabled=False, ready=False)

    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("present", None))
    monkeypatch.setattr(
        engine,
        "get_model_info",
        lambda name: {"capabilities": ["completion", "tools"]},
    )

    engine.load_model("functiongemma")

    assert engine.supports_tool_calling is True


def test_unload_model_requests_zero_keep_alive_and_clears_state(monkeypatch) -> None:
    engine = _build_engine()
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001
        captured["endpoint"] = endpoint
        captured["data"] = data
        captured["timeout"] = timeout
        return {"done": True}

    monkeypatch.setattr(engine, "_post", fake_post)

    engine.unload_model()

    assert captured["endpoint"] == "/api/generate"
    assert captured["data"] == {
        "model": "test-model",
        "prompt": "",
        "stream": False,
        "keep_alive": 0,
    }
    assert engine.model_name is None
    assert engine._ready is False  # noqa: SLF001


def test_warmup_num_ctx_matches_chat_request_num_ctx(monkeypatch) -> None:
    # Regression: the lazy-load warmup probe omitted num_ctx, so Ollama loaded
    # the model at the tag-default context length (e.g. 49152) and then spun up
    # a SECOND runner when the first real chat arrived with the configured
    # num_ctx (e.g. 32768) -- ~20-27 wasted seconds on every cold first message.
    # The warmup and chat requests must carry identical num_ctx.
    engine = _build_engine()
    engine.set_configured_context_length(32768)
    posts: list[dict[str, object]] = []

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001, ARG001
        posts.append({"endpoint": endpoint, "data": data})
        if endpoint == "/api/chat":
            return {"message": {"content": "hi"}}
        return {"done": True}

    monkeypatch.setattr(engine, "_post", fake_post)

    warmup_thread = engine._warmup_model_async("test-model")  # noqa: SLF001
    warmup_thread.join(timeout=5)
    assert not warmup_thread.is_alive()
    engine.generate(prompt="hello")

    warmup = next(p for p in posts if p["endpoint"] == "/api/generate")
    chat = next(p for p in posts if p["endpoint"] == "/api/chat")
    assert warmup["data"]["options"]["num_ctx"] == 32768
    assert warmup["data"]["options"]["num_ctx"] == chat["data"]["options"]["num_ctx"]


def test_warmup_omits_num_ctx_when_none_configured_like_chat(monkeypatch) -> None:
    # With no configured context length the chat path sends no num_ctx, so the
    # warmup must not send one either -- both fall through to the same Ollama
    # defaults and the loaded runner is reused.
    engine = _build_engine()
    posts: list[dict[str, object]] = []

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001, ARG001
        posts.append({"endpoint": endpoint, "data": data})
        if endpoint == "/api/chat":
            return {"message": {"content": "hi"}}
        return {"done": True}

    monkeypatch.setattr(engine, "_post", fake_post)

    warmup_thread = engine._warmup_model_async("test-model")  # noqa: SLF001
    warmup_thread.join(timeout=5)
    assert not warmup_thread.is_alive()
    engine.generate(prompt="hello")

    warmup = next(p for p in posts if p["endpoint"] == "/api/generate")
    chat = next(p for p in posts if p["endpoint"] == "/api/chat")
    assert "num_ctx" not in warmup["data"]["options"]
    assert "num_ctx" not in chat["data"]["options"]


def test_generate_includes_think_payload_for_thinking_models(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"
    engine._thinking = True  # noqa: SLF001
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001
        captured["endpoint"] = endpoint
        captured["data"] = data
        captured["timeout"] = timeout
        return {"message": {"content": "Visible answer"}}

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate(prompt="hello")

    assert result == "Visible answer"
    assert captured["endpoint"] == "/api/chat"
    assert captured["data"]["think"] is True
    # When thinking is enabled, num_predict should include headroom so
    # reasoning tokens don't starve the visible response.
    assert (
        captured["data"]["options"]["num_predict"] == 16384 + 16384
    )  # default + thinking headroom


def test_generate_with_vision_disables_thinking_for_thinking_models(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "gemma4-vision:12b"
    engine._vision = True  # noqa: SLF001
    engine._thinking = True  # noqa: SLF001
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001
        captured["endpoint"] = endpoint
        captured["data"] = data
        return {"response": "[BUG 42: NullRef at line 137]"}

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate_with_vision(prompt="What does this show?", images=[_PNG_BASE64])

    # Thinking is force-disabled so the answer lands in `response`, not the
    # hidden `thinking` field (which would otherwise leave `response` empty).
    assert result.content == "[BUG 42: NullRef at line 137]"
    assert result.finish_reason == "stop"
    assert captured["endpoint"] == "/api/generate"
    assert captured["data"]["think"] is False


def test_generate_with_vision_omits_think_for_non_thinking_models(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "llava:7b"
    engine._vision = True  # noqa: SLF001
    engine._thinking = False  # noqa: SLF001
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001, ARG001
        captured["data"] = data
        return {"response": "a cat"}

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate_with_vision(prompt="caption", images=[_PNG_BASE64])

    # Non-thinking models must not receive a `think` key at all.
    assert result.content == "a cat"
    assert "think" not in captured["data"]


def test_generate_with_vision_reports_length_finish_reason(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "llava:7b"
    engine._vision = True  # noqa: SLF001
    engine._thinking = False  # noqa: SLF001

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001, ARG001
        return {"response": "a truncated answer that ran ou", "done_reason": "length"}

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate_with_vision(prompt="describe", images=[_PNG_BASE64])

    # Ollama's done_reason must reach the caller so the chat layer can report
    # honest truncation instead of a hardcoded end_turn.
    assert result.content == "a truncated answer that ran ou"
    assert result.finish_reason == "length"


def test_generate_with_vision_falls_back_to_thinking_field(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "gemma4-vision:12b"
    engine._vision = True  # noqa: SLF001
    engine._thinking = True  # noqa: SLF001

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001, ARG001
        return {"response": "", "thinking": "fallback answer"}

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate_with_vision(prompt="hi", images=[_PNG_BASE64])

    # Defensive: a model that still routed output to the reasoning channel
    # should surface that text rather than an empty string.
    assert result.content == "fallback answer"


def test_generate_sends_configured_num_ctx_to_ollama(monkeypatch) -> None:
    engine = _build_engine()
    engine.set_configured_context_length(32768)
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001, ARG001
        captured["endpoint"] = endpoint
        captured["data"] = data
        return {"message": {"content": "Visible answer"}}

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate(prompt="hello", max_tokens=64)

    assert result == "Visible answer"
    assert captured["endpoint"] == "/api/chat"
    assert captured["data"]["options"]["num_ctx"] == 32768


def test_generate_caps_configured_num_ctx_to_native_model_context(monkeypatch) -> None:
    engine = _build_engine()
    engine._context_length = 65_536  # noqa: SLF001 - probed native metadata.
    engine.set_configured_context_length(131_072)
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001, ARG001
        captured["data"] = data
        return {"message": {"content": "Visible answer"}}

    monkeypatch.setattr(engine, "_post", fake_post)

    assert engine.generate(prompt="hello", max_tokens=64) == "Visible answer"
    assert captured["data"]["options"]["num_ctx"] == 65_536


def test_generate_can_disable_thinking_via_request_scoped_debug_override(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"
    engine._thinking = True  # noqa: SLF001
    store = TurnDiagnosticsStore()
    store.begin_turn(
        request_id="req_disable_thinking",
        session_id="sess_disable_thinking",
        mode="assist",
        debug_options={"disable_thinking": True},
    )
    engine.set_turn_diagnostics_store(store)
    engine.begin_request_context(
        request_id="req_disable_thinking",
        diagnostics_store=store,
        debug_options={"disable_thinking": True},
        mode="assist",
    )
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001
        captured["endpoint"] = endpoint
        captured["data"] = data
        captured["timeout"] = timeout
        return {"message": {"content": "Visible answer"}}

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate(prompt="hello", reasoning_effort="high")

    assert result == "Visible answer"
    assert captured["endpoint"] == "/api/chat"
    assert "think" not in captured["data"]
    assert store.snapshot()["think_enabled"] is False
    engine.clear_request_context(request_id="req_disable_thinking")


def test_build_options_adds_repetition_controls_only_for_thinking() -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"

    thinking_options = engine._build_options(16384, 0.7, thinking=True)  # noqa: SLF001
    plain_options = engine._build_options(16384, 0.7, thinking=False)  # noqa: SLF001

    assert thinking_options["repeat_penalty"] == 1.15
    assert thinking_options["repeat_last_n"] == 256
    assert "repeat_penalty" not in plain_options
    assert "repeat_last_n" not in plain_options


def test_build_options_profile_repeat_penalty_wins_over_thinking_fallback() -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"

    profiled = engine._build_options(  # noqa: SLF001
        16384, 0.7, thinking=True, repeat_penalty=1.0
    )
    unprofiled = engine._build_options(16384, 0.7, thinking=True)  # noqa: SLF001
    plain_profiled = engine._build_options(  # noqa: SLF001
        16384, 0.7, thinking=False, repeat_penalty=1.05
    )

    # Profile guidance (Qwen thinking models prescribe 1.0) beats the
    # safe-thinking hardcode; 1.15 stays the no-profile fallback.
    assert profiled["repeat_penalty"] == 1.0
    assert unprofiled["repeat_penalty"] == 1.15
    assert plain_profiled["repeat_penalty"] == 1.05


def test_build_options_passes_profile_top_p_min_p() -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"

    options = engine._build_options(  # noqa: SLF001
        16384, 0.7, thinking=False, top_p=0.95, min_p=0.0
    )
    omitted = engine._build_options(16384, 0.7, thinking=False)  # noqa: SLF001
    out_of_range = engine._build_options(  # noqa: SLF001
        16384, 0.7, thinking=False, top_p=1.5, min_p=-0.1
    )

    assert options["top_p"] == 0.95
    assert options["min_p"] == 0.0
    assert "top_p" not in omitted
    assert "min_p" not in omitted
    assert "top_p" not in out_of_range
    assert "min_p" not in out_of_range


def test_request_context_applies_qwen_repetition_and_top_p_overrides(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.6:35b-a3b"
    captured: dict[str, object] = {}
    engine.begin_request_context(
        request_id="req_qwen_sampler_profile",
        app_profile_behavior={
            "family": "qwen36",
            "variant": "35b-a3b",
            "temperature": 0.6,
            "top_p": 0.95,
            "top_k": 20,
            "min_p": 0.0,
            "repeat_penalty": 1.0,
        },
    )

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001
        captured["data"] = data
        return {"message": {"content": "Visible answer"}}

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate(prompt="hello", temperature=0.2, reasoning_effort="high")

    assert result == "Visible answer"
    options = captured["data"]["options"]
    assert options["temperature"] == 0.6
    assert options["top_k"] == 20
    assert options["top_p"] == 0.95
    assert options["min_p"] == 0.0
    # Thinking turn, but the profile's repeat_penalty=1.0 wins over the
    # 1.15 thinking fallback.
    assert options["repeat_penalty"] == 1.0
    engine.clear_request_context(request_id="req_qwen_sampler_profile")


@pytest.mark.parametrize(
    "case",
    [
        (None, "medium", 1.0, 0.95, 0.0, 65_536),
        ("none", False, 0.7, 0.8, 1.5, 32_768),
    ],
)
def test_qwen38_uses_mode_sampler_and_combined_output_budget(
    monkeypatch,
    case,
) -> None:
    (
        reasoning_effort,
        expected_think,
        expected_temperature,
        expected_top_p,
        expected_presence,
        expected_num_predict,
    ) = case
    engine = _build_engine()
    engine.model_name = "qwen3.8:27b-q3-k-s"
    engine._thinking = True  # noqa: SLF001
    engine._context_length = 262_144  # noqa: SLF001
    engine._configured_context_length = 131_072  # noqa: SLF001
    engine._profile_max_output_tokens = 32_768  # noqa: SLF001
    engine._profile_thinking_headroom = 32_768  # noqa: SLF001
    captured: dict[str, object] = {}
    engine.begin_request_context(
        request_id=f"req_qwen38_{reasoning_effort or 'automatic'}",
        app_profile_behavior={
            "family": "qwen38",
            "thinking_token_headroom": 32_768,
            "thinking_sampler": {
                "temperature": 1.0,
                "top_p": 0.95,
                "top_k": 20,
                "min_p": 0.0,
                "presence_penalty": 0.0,
                "repeat_penalty": 1.0,
            },
            "instruct_sampler": {
                "temperature": 0.7,
                "top_p": 0.8,
                "top_k": 20,
                "min_p": 0.0,
                "presence_penalty": 1.5,
                "repeat_penalty": 1.0,
            },
        },
    )

    def fake_post(_endpoint, data, timeout=0):  # noqa: ANN001, ARG001
        captured["data"] = data
        return {"message": {"content": "Visible answer"}}

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate(
        prompt="hello",
        max_tokens=engine.get_model_max_output_tokens() or 0,
        reasoning_effort=reasoning_effort,
    )

    assert result == "Visible answer"
    data = captured["data"]
    options = data["options"]
    assert data["think"] == expected_think
    assert options["temperature"] == expected_temperature
    assert options["top_p"] == expected_top_p
    assert options["top_k"] == 20
    assert options["min_p"] == 0.0
    assert options["presence_penalty"] == expected_presence
    assert options["repeat_penalty"] == 1.0
    assert options["num_predict"] == expected_num_predict
    engine.clear_request_context()


def test_qwen38_string_effort_http_400_requires_current_ollama(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.8:27b-q3-k-s"
    engine._thinking = True  # noqa: SLF001

    def reject_effort(_endpoint, _data, timeout=0):  # noqa: ANN001, ARG001
        raise urllib.error.HTTPError(
            url="http://localhost:11434/api/chat",
            code=400,
            msg="bad request",
            hdrs=None,
            fp=None,
        )

    monkeypatch.setattr(engine, "_post", reject_effort)

    with pytest.raises(GenerationError, match="string-valued think levels"):
        engine.generate(prompt="hello", reasoning_effort="medium")


def test_qwen38_tool_schema_http_400_preserves_plain_fallback(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.8:27b-q3-k-s"
    engine._thinking = True  # noqa: SLF001
    requests: list[dict[str, object]] = []

    def reject_tools(_endpoint, data, timeout=0):  # noqa: ANN001, ARG001
        requests.append(data)
        if data.get("tools") is not None:
            raise urllib.error.HTTPError(
                url="http://localhost:11434/api/chat",
                code=400,
                msg="tool schema rejected",
                hdrs=None,
                fp=None,
            )
        return {"message": {"content": "Plain fallback answer"}}

    monkeypatch.setattr(engine, "_post", reject_tools)

    result = engine.generate_with_tools(
        prompt="hello",
        tools=[{"name": "demo"}],
        reasoning_effort="medium",
    )

    assert result.content == "Plain fallback answer"
    assert result.degraded_tool_transport is True
    assert len(requests) == 2
    assert requests[0]["think"] == "medium"
    assert "tools" in requests[0]
    assert "tools" not in requests[1]


def test_request_context_applies_gemma_sampler_defaults(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "gemma4-e4b-it"
    captured: dict[str, object] = {}
    engine.begin_request_context(
        request_id="req_gemma_profile",
        app_profile_behavior={
            "family": "gemma4",
            "variant": "e4b",
            "temperature": 1.0,
            "top_k": 40,
            "reasoning_parser_start": "<|channel>thought",
            "reasoning_parser_end": "<channel|>",
        },
    )

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001
        captured["data"] = data
        return {"message": {"content": "Visible answer"}}

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate(prompt="hello", temperature=0.2)

    assert result == "Visible answer"
    assert captured["data"]["options"]["temperature"] == 1.0
    assert captured["data"]["options"]["top_k"] == 40
    engine.clear_request_context(request_id="req_gemma_profile")


def test_thinking_token_headroom_uses_model_size_cutoff() -> None:
    small_engine = _build_engine()
    small_engine.model_name = "qwen3.5:3b"

    large_engine = _build_engine()
    large_engine.model_name = "qwen3.5:32b"

    assert small_engine._thinking_token_headroom() == 4096  # noqa: SLF001
    assert large_engine._thinking_token_headroom() == 16384  # noqa: SLF001


def test_stream_emits_separate_thinking_and_content_events(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"
    engine._thinking = True  # noqa: SLF001
    store = TurnDiagnosticsStore()
    store.begin_turn(
        request_id="req_stream_metrics",
        session_id="sess_stream_metrics",
        mode="chat",
        debug_options=None,
    )
    engine.set_turn_diagnostics_store(store)
    engine.begin_request_context(
        request_id="req_stream_metrics",
        diagnostics_store=store,
        debug_options=None,
        mode="chat",
    )
    chunks = [
        {"message": {"thinking": "Checking the request intent."}, "done": False},
        {"message": {"content": "Visible answer"}, "done": False},
        {"message": {}, "done": True},
    ]

    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeStreamingResponse(chunks),  # noqa: ARG005
    )

    events = list(engine.stream(prompt="hello"))

    assert [(event.kind, event.text) for event in events] == [
        ("thinking", "Checking the request intent."),
        ("content", "Visible answer"),
        ("done", ""),
    ]
    snapshot = store.snapshot()
    assert snapshot["think_enabled"] is True
    assert snapshot["provider_tool_capable"] is False
    assert snapshot["provider_tool_count"] == 0
    assert snapshot["visible_output_chars"] == len("Visible answer")
    assert snapshot["visible_output_tokens_estimate"] > 0
    engine.clear_request_context(request_id="req_stream_metrics")


def test_generate_with_tools_captures_thinking_text(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"
    engine._thinking = True  # noqa: SLF001

    monkeypatch.setattr(
        engine,
        "_post",
        lambda endpoint, data, timeout=0: {  # noqa: ANN001, ARG005
            "message": {
                "content": "Final answer",
                "thinking": "Checking the request intent.",
                "tool_calls": [],
            }
        },
    )

    result = engine.generate_with_tools(
        prompt="hello",
        tools=[{"name": "demo"}],
    )

    assert result.content == "Final answer"
    assert result.thinking_text == "Checking the request intent."


def test_generate_with_tools_uses_gemma_reasoning_parser_fallback(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "gemma4-e4b-it"
    engine.begin_request_context(
        request_id="req_gemma_parser",
        app_profile_behavior={
            "family": "gemma4",
            "variant": "e4b",
            "temperature": 1.0,
            "top_k": 40,
            "reasoning_parser_start": "<|channel>thought",
            "reasoning_parser_end": "<channel|>",
        },
    )

    monkeypatch.setattr(
        engine,
        "_post",
        lambda endpoint, data, timeout=0: {  # noqa: ANN001, ARG005
            "message": {
                "content": "<|channel>thoughtCheck tools first.<channel|>Final answer",
                "tool_calls": [],
            }
        },
    )

    result = engine.generate_with_tools(prompt="hello", tools=[{"name": "demo"}])

    assert result.content == "Final answer"
    assert result.thinking_text == "Check tools first."
    engine.clear_request_context(request_id="req_gemma_parser")


def test_generate_does_not_promote_gemma_reasoning_only_reply_to_visible_content(
    monkeypatch,
) -> None:
    engine = _build_engine()
    engine.model_name = "gemma4-e4b-it"
    engine.begin_request_context(
        request_id="req_gemma_reasoning_only",
        app_profile_behavior={
            "family": "gemma4",
            "variant": "e4b",
            "temperature": 1.0,
            "top_k": 40,
            "reasoning_parser_start": "<|channel>thought",
            "reasoning_parser_end": "<channel|>",
        },
    )

    monkeypatch.setattr(
        engine,
        "_post",
        lambda endpoint, data, timeout=0: {  # noqa: ANN001, ARG005
            "message": {
                "content": "<|channel>thoughtCheck tools first.<channel|>",
            }
        },
    )

    result = engine.generate(prompt="hello")

    assert result == ""
    engine.clear_request_context(request_id="req_gemma_reasoning_only")


def test_generate_with_tools_keeps_gemma_reasoning_only_reply_private(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "gemma4-e4b-it"
    engine.begin_request_context(
        request_id="req_gemma_reasoning_only_tools",
        app_profile_behavior={
            "family": "gemma4",
            "variant": "e4b",
            "temperature": 1.0,
            "top_k": 40,
            "reasoning_parser_start": "<|channel>thought",
            "reasoning_parser_end": "<channel|>",
        },
    )

    monkeypatch.setattr(
        engine,
        "_post",
        lambda endpoint, data, timeout=0: {  # noqa: ANN001, ARG005
            "message": {
                "content": "<|channel>thoughtCheck tools first.<channel|>",
                "tool_calls": [],
            }
        },
    )

    result = engine.generate_with_tools(prompt="hello", tools=[{"name": "demo"}])

    assert result.content == ""
    assert result.tool_calls == ()
    assert result.finish_reason == "stop"
    assert result.thinking_text == "Check tools first."
    engine.clear_request_context(request_id="req_gemma_reasoning_only_tools")


def test_generate_reports_configured_timeout_duration(monkeypatch) -> None:
    engine = _build_engine()
    engine._request_timeout_seconds = 420  # noqa: SLF001

    monkeypatch.setattr(
        engine,
        "_post",
        lambda endpoint, data, timeout=None: (_ for _ in ()).throw(TimeoutError("timed out")),  # noqa: ARG005
    )

    with pytest.raises(GenerationError, match="timed out after 420s waiting for Ollama"):
        engine.generate(prompt="hello")


def test_generate_normalizes_urlerror_wrapped_timeout(monkeypatch) -> None:
    engine = _build_engine()
    engine._request_timeout_seconds = 420  # noqa: SLF001

    monkeypatch.setattr(
        engine,
        "_post",
        lambda endpoint, data, timeout=None: (_ for _ in ()).throw(  # noqa: ARG005
            urllib.error.URLError(socket.timeout("timed out"))
        ),
    )

    with pytest.raises(GenerationError, match="timed out after 420s waiting for Ollama"):
        engine.generate(prompt="hello")


def test_sanitize_thinking_preserves_markdown_and_word_boundaries() -> None:
    """Verify _sanitize_thinking keeps content while stripping marker tokens only."""
    engine = _build_engine()
    # Markdown with headings, newlines, and bullet points must be preserved
    md = "## Analysis\n\n1. **First point**\n2. **Second point**\n\n- bullet"
    assert engine._sanitize_thinking(md) == md  # noqa: SLF001

    # Leading space on streaming chunk encodes word boundary - must survive
    assert engine._sanitize_thinking(" Process") == " Process"  # noqa: SLF001

    # Marker tokens are stripped without removing the reasoning text itself
    assert engine._sanitize_thinking("<think>inner</think>") == "inner"  # noqa: SLF001
    assert engine._sanitize_thinking("before<think>mid</think>after") == "beforemidafter"  # noqa: SLF001
    assert engine._sanitize_thinking("<|channel>thoughtplan<channel|>") == "plan"  # noqa: SLF001


def test_stream_thinking_preserves_word_boundary_spaces(monkeypatch) -> None:
    """Multi-chunk thinking stream must preserve leading spaces between words."""
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"
    engine._thinking = True  # noqa: SLF001
    chunks = [
        {"message": {"thinking": "Thinking"}, "done": False},
        {"message": {"thinking": " Process:"}, "done": False},
        {"message": {"thinking": "\n1."}, "done": False},
        {"message": {"thinking": " **Analyze"}, "done": False},
        {"message": {"content": "Result"}, "done": False},
        {"message": {}, "done": True},
    ]
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeStreamingResponse(chunks),  # noqa: ARG005
    )

    events = list(engine.stream(prompt="hello"))
    thinking_events = [e for e in events if e.kind == "thinking"]

    assert thinking_events[0].text == "Thinking"
    assert thinking_events[1].text == " Process:"
    assert thinking_events[2].text == "\n1."
    assert thinking_events[3].text == " **Analyze"


def test_stream_thinking_forwards_per_token_deltas_verbatim(monkeypatch) -> None:
    """Ollama streams thinking per token; repeats and prefix-shaped chunks are
    real deltas and must never be deduplicated or merged."""
    engine = _build_engine()
    engine.model_name = "qwen3.6:35b-a3b"
    engine._thinking = True  # noqa: SLF001
    chunks = [
        {"message": {"thinking": "The"}, "done": False},
        {"message": {"thinking": " user"}, "done": False},
        {"message": {"thinking": " user"}, "done": False},
        {"message": {"thinking": " users"}, "done": False},
        {"message": {"content": "Visible answer"}, "done": False},
        {"message": {}, "done": True},
    ]
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeStreamingResponse(chunks),  # noqa: ARG005
    )

    events = list(engine.stream(prompt="hello"))
    thinking_events = [e for e in events if e.kind == "thinking"]

    assert [event.text for event in thinking_events] == ["The", " user", " user", " users"]


def test_stream_with_tools_classifies_midstream_connection_reset_as_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _build_engine()
    response = _ResettingStreamingResponse()
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda req, timeout=0: response,  # noqa: ARG005
    )

    with pytest.raises(EngineConnectionError) as exc_info:
        list(engine.stream_with_tools(prompt="hello", tools=[]))

    assert exc_info.value.retryable is True
    assert "interrupted during streaming" in exc_info.value.message
    assert response.closed.is_set()


def test_stream_uses_gemma_reasoning_parser_fallback(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "gemma4-e4b-it"
    engine.begin_request_context(
        request_id="req_gemma_stream_parser",
        app_profile_behavior={
            "family": "gemma4",
            "variant": "e4b",
            "temperature": 1.0,
            "top_k": 40,
            "reasoning_parser_start": "<|channel>thought",
            "reasoning_parser_end": "<channel|>",
        },
    )
    chunks = [
        {"message": {"content": "<|channel>thoughtChecking"}, "done": False},
        {"message": {"content": " the request.<channel|>Visible answer"}, "done": False},
        {"message": {}, "done": True},
    ]
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeStreamingResponse(chunks),  # noqa: ARG005
    )

    events = list(engine.stream(prompt="hello"))

    assert [(event.kind, event.text) for event in events] == [
        ("thinking", "Checking"),
        ("thinking", " the request."),
        ("content", "Visible answer"),
        ("done", ""),
    ]
    engine.clear_request_context(request_id="req_gemma_stream_parser")


def test_stream_does_not_emit_content_fallback_for_gemma_reasoning_only_reply(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "gemma4-e4b-it"
    engine.begin_request_context(
        request_id="req_gemma_stream_reasoning_only",
        app_profile_behavior={
            "family": "gemma4",
            "variant": "e4b",
            "temperature": 1.0,
            "top_k": 40,
            "reasoning_parser_start": "<|channel>thought",
            "reasoning_parser_end": "<channel|>",
        },
    )
    chunks = [
        {"message": {"content": "<|channel>thoughtChecking"}, "done": False},
        {"message": {"content": " tools first.<channel|>"}, "done": False},
        {"message": {}, "done": True},
    ]
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeStreamingResponse(chunks),  # noqa: ARG005
    )

    events = list(engine.stream(prompt="hello"))

    assert [(event.kind, event.text) for event in events] == [
        ("thinking", "Checking"),
        ("thinking", " tools first."),
        ("done", ""),
    ]
    engine.clear_request_context(request_id="req_gemma_stream_reasoning_only")


def test_stream_done_event_carries_finish_reason_without_engine_attribute(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"
    chunks = [
        {"message": {"content": "Visible answer"}, "done": False},
        {"message": {}, "done": True},
    ]
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeStreamingResponse(chunks),  # noqa: ARG005
    )

    events = list(engine.stream(prompt="hello"))

    # The finish reason rides the request's own terminal chunk; the old
    # shared ``engine._last_finish_reason`` attribute leaked verdicts from a
    # tools-path call into a later plain stream's reasoning-only check.
    assert events[-1].kind == "done"
    assert events[-1].finish_reason == "stop"
    assert not hasattr(engine, "_last_finish_reason")


def test_stream_with_tools_no_longer_writes_shared_finish_reason_attribute(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"
    chunks = [
        {"message": {"content": "Tool-free answer"}, "done": False},
        {"message": {}, "done": True},
    ]
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeStreamingResponse(chunks),  # noqa: ARG005
    )

    stream = engine.stream_with_tools(prompt="hello", tools=[{"name": "demo"}])
    while True:
        try:
            next(stream)
        except StopIteration as stopped:
            result = stopped.value
            break

    assert result.finish_reason == "stop"
    assert result.content == "Tool-free answer"
    assert not hasattr(engine, "_last_finish_reason")


def test_stream_forwards_repeated_thinking_chunks(monkeypatch) -> None:
    # Identical chunks are real per-token repeats (a looping model), forwarded
    # verbatim; the repetition guard, not a dedupe, is what stops a runaway loop.
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"
    engine._thinking = True  # noqa: SLF001
    repeated = "Checking the request intent carefully. "
    chunks = [
        {"message": {"thinking": repeated}, "done": False},
        {"message": {"thinking": repeated}, "done": False},
        {"message": {"thinking": repeated}, "done": False},
        {"message": {"thinking": repeated}, "done": False},
        {"message": {"thinking": repeated}, "done": False},
        {"message": {"content": "Visible answer"}, "done": False},
        {"message": {}, "done": True},
    ]
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeStreamingResponse(chunks),  # noqa: ARG005
    )

    events = list(engine.stream(prompt="hello"))

    assert [(event.kind, event.text) for event in events] == [
        # The guard trips on the fourth identical chunk; the rest are suppressed.
        *([("thinking", repeated)] * 3),
        ("content", "Visible answer"),
        ("done", ""),
    ]


def test_stream_suppresses_repetitive_gemma_reasoning_fallback(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "gemma4-e4b-it"
    repeated = "Checking the request intent carefully. " * 50
    engine.begin_request_context(
        request_id="req_gemma_guard",
        app_profile_behavior={
            "family": "gemma4",
            "variant": "e4b",
            "temperature": 1.0,
            "top_k": 40,
            "reasoning_parser_start": "<|channel>thought",
            "reasoning_parser_end": "<channel|>",
        },
    )
    chunks = [
        {"message": {"content": f"<|channel>thought{repeated}"}, "done": False},
        {"message": {"content": repeated}, "done": False},
        {"message": {"content": repeated}, "done": False},
        {"message": {"content": repeated}, "done": False},
        {"message": {"content": repeated}, "done": False},
        {"message": {"content": repeated}, "done": False},
        {"message": {"content": repeated}, "done": False},
        {"message": {"content": f"{repeated}<channel|>Visible answer"}, "done": False},
        {"message": {}, "done": True},
    ]
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeStreamingResponse(chunks),  # noqa: ARG005
    )

    events = list(engine.stream(prompt="hello"))
    thinking_events = [event for event in events if event.kind == "thinking"]

    assert len(thinking_events) < 8
    assert events[-2].kind == "content"
    assert events[-2].text == "Visible answer"
    engine.clear_request_context(request_id="req_gemma_guard")


def test_load_model_detects_qwen_thinking_capability_from_model_name(monkeypatch) -> None:
    engine = _build_engine(tools_enabled=False, ready=False)

    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("present", None))
    monkeypatch.setattr(engine, "get_model_info", lambda name: {})

    engine.load_model("qwen3.5:9b")

    assert engine.capabilities["thinking"] is True


def test_load_model_stores_template_diagnostics_for_known_family(monkeypatch) -> None:
    engine = _build_engine(tools_enabled=False, ready=False)

    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("present", None))
    monkeypatch.setattr(
        engine,
        "get_model_info",
        lambda name: {
            "details": {"family": "llama3"},
        },
    )

    engine.load_model("llama3.2:8b")

    assert engine._template_diagnostics.get("resolved") is True
    assert engine._template_diagnostics.get("family") == "llama3"


def test_load_model_stores_unresolved_template_diagnostics(monkeypatch) -> None:
    engine = _build_engine(tools_enabled=False, ready=False)

    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("present", None))
    monkeypatch.setattr(
        engine,
        "get_model_info",
        lambda name: {
            "details": {"family": "totally-new-arch"},
        },
    )

    engine.load_model("newmodel:7b")

    assert engine._template_diagnostics.get("resolved") is False


def test_load_model_template_diagnostics_empty_when_no_info(monkeypatch) -> None:
    engine = _build_engine(tools_enabled=False, ready=False)

    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("present", None))
    monkeypatch.setattr(engine, "get_model_info", lambda name: None)

    engine.load_model("unknown:latest")

    diag = engine._template_diagnostics
    assert diag.get("resolved") is False or diag == {}


# -- Problem A: _build_tools_payload wraps schemas correctly ---------------


class TestBuildToolsPayload:
    def test_wraps_flat_schema_into_openai_format(self) -> None:
        flat = [
            {
                "name": "glob_files",
                "description": "Search for files by pattern",
                "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}}},
                "side_effecting": False,
            }
        ]
        result = build_tools_payload(flat)
        assert len(result) == 1
        assert result[0]["type"] == "function"
        assert result[0]["function"]["name"] == "glob_files"
        assert result[0]["function"]["description"] == "Search for files by pattern"
        assert "side_effecting" not in result[0]
        assert "side_effecting" not in result[0]["function"]

    def test_skips_entries_without_name(self) -> None:
        tools = [{"description": "no name"}, {"name": "", "description": "empty name"}]
        assert build_tools_payload(tools) == []

    def test_multiple_tools(self) -> None:
        tools = [
            {"name": "read_file", "description": "Read a file", "parameters": {}},
            {"name": "edit_file", "description": "Edit a file", "parameters": {}},
        ]
        result = build_tools_payload(tools)
        assert len(result) == 2
        names = [t["function"]["name"] for t in result]
        assert names == ["read_file", "edit_file"]

    def test_missing_parameters_defaults_to_empty_dict(self) -> None:
        tools = [{"name": "list_dir", "description": "List directory"}]
        result = build_tools_payload(tools)
        assert result[0]["function"]["parameters"] == {}


# -- Problem A: verify _generate_with_tools_impl sends wrapped payload -----


def test_generate_with_tools_sends_wrapped_tool_schemas(monkeypatch) -> None:
    engine = _build_engine()
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001
        captured["data"] = data
        return {
            "message": {
                "content": "Done",
                "tool_calls": [],
            }
        }

    monkeypatch.setattr(engine, "_post", fake_post)

    engine.generate_with_tools(
        prompt="hello",
        tools=[
            {
                "name": "glob_files",
                "description": "Search",
                "parameters": {},
                "side_effecting": False,
            },
        ],
    )

    sent_tools = captured["data"]["tools"]
    assert len(sent_tools) == 1
    assert sent_tools[0]["type"] == "function"
    assert sent_tools[0]["function"]["name"] == "glob_files"


# -- Problem B: _build_messages preserves tool context ---------------------


class TestBuildMessagesToolContext:
    def test_native_tool_role_preserved(self) -> None:
        messages = [
            {"role": "user", "content": "list files"},
            {
                "role": "assistant",
                "content": "Calling tool.",
                "tool_calls": [
                    {"name": "glob_files", "arguments": {"pattern": "*"}},
                ],
            },
            {
                "role": "tool",
                "content": "file1.py\nfile2.py",
                "tool_call_id": "ollama_abc",
                "name": "glob_files",
            },
        ]
        result = OllamaEngine._build_messages("", "You are Jenny.", messages)
        # System message prepended
        assert result[0]["role"] == "system"
        # Assistant message preserves tool_calls
        assistant_msg = result[2]
        assert assistant_msg["role"] == "assistant"
        assert "tool_calls" in assistant_msg
        assert assistant_msg["tool_calls"][0]["function"]["name"] == "glob_files"
        # Tool message keeps role=tool
        tool_msg = result[3]
        assert tool_msg["role"] == "tool"

    def test_inband_tool_role_demoted_to_user(self) -> None:
        messages = [
            {"role": "tool", "content": "result data", "tool_call_id": "inband_glob_files_abc123"},
        ]
        result = OllamaEngine._build_messages("q", "", messages)
        assert result[0]["role"] == "user"


# -- Problem: multiple system messages break Ollama tool-parser generation --
# A community GGUF chat template (Qwen3.6-35B-A3B) raises "Unable to generate
# parser for this template ... While executing CallExpression" when /api/chat
# receives more than one consecutive system message, deterministically failing
# every native tool-calling request. Jenny composes several system messages
# (identity, personality, runtime-skills), so they must be merged before
# sending. Verified live: merged -> HTTP 200 with native tool_calls; 3 system
# messages -> HTTP 400 parser-generation failure at every num_ctx.


class TestMergeConsecutiveSystemMessages:
    def test_merges_runs_of_system_messages_preserving_order(self) -> None:
        merged = _merge_consecutive_system_messages(
            [
                {"role": "system", "content": "identity"},
                {"role": "system", "content": "personality"},
                {"role": "system", "content": "skills"},
                {"role": "user", "content": "hello"},
            ]
        )
        assert [m["role"] for m in merged] == ["system", "user"]
        assert merged[0]["content"] == "identity\n\npersonality\n\nskills"
        assert merged[1]["content"] == "hello"

    def test_non_adjacent_system_messages_not_merged(self) -> None:
        merged = _merge_consecutive_system_messages(
            [
                {"role": "system", "content": "a"},
                {"role": "user", "content": "q"},
                {"role": "system", "content": "b"},
            ]
        )
        assert [m["role"] for m in merged] == ["system", "user", "system"]

    def test_preserves_tool_metadata_and_does_not_mutate_input(self) -> None:
        merged = _merge_consecutive_system_messages(
            [
                {"role": "system", "content": ""},
                {"role": "system", "content": "only"},
                {"role": "tool", "content": "r", "tool_call_id": "x", "name": "read_file"},
            ]
        )
        assert merged[0]["content"] == "only"
        assert merged[1]["tool_call_id"] == "x"
        assert merged[1]["name"] == "read_file"
        original = [{"role": "system", "content": "p"}, {"role": "system", "content": "q"}]
        _merge_consecutive_system_messages(original)
        assert original[0]["content"] == "p"

    def test_build_messages_collapses_multiple_system_messages(self) -> None:
        result = OllamaEngine._build_messages(
            "",
            "",
            [
                {"role": "system", "content": "identity"},
                {"role": "system", "content": "tools"},
                {"role": "system", "content": "context"},
                {"role": "user", "content": "read README"},
            ],
        )
        assert [m["role"] for m in result] == ["system", "user"]
        assert result[0]["content"] == "identity\n\ntools\n\ncontext"

    def test_build_messages_prepends_primary_ahead_of_other_system_rows(self) -> None:
        # The router strips the primary prompt from history because `system`
        # transports it. Other system rows must NOT suppress the prepend — the
        # old existence-based has_system skip dropped the entire system prompt
        # from every post-compaction request.
        result = OllamaEngine._build_messages(
            "",
            "PRIMARY PROMPT",
            [
                {"role": "system", "content": "runtime overlay"},
                {"role": "user", "content": "and phase four?"},
            ],
        )
        assert [m["role"] for m in result] == ["system", "user"]
        assert result[0]["content"].startswith("PRIMARY PROMPT")
        assert "runtime overlay" in result[0]["content"]

    def test_build_messages_demotes_the_compaction_summary_out_of_the_trusted_block(
        self,
    ) -> None:
        """A compaction summary is model-generated text, not policy.

        It used to be merged into the leading system run, so arbitrary
        summarizer output — whose input includes TOOL RESULT rows, making a
        poisoned web-fetch or file-read a live injection source — sat in the
        same trusted block as the primary prompt on every subsequent turn of
        that session. It is now demoted in place to a non-system row: same
        position, same content, no authority. The primary prompt must still be
        prepended (pinned above).
        """
        result = OllamaEngine._build_messages(
            "",
            "PRIMARY PROMPT",
            [
                {"role": "system", "content": "## Compacted Conversation Summary\nstuff"},
                {"role": "user", "content": "and phase four?"},
            ],
        )

        assert [m["role"] for m in result] == ["system", "user", "user"]
        # The trusted block is the primary policy and nothing else.
        assert result[0]["content"] == "PRIMARY PROMPT"
        assert "Compacted Conversation Summary" not in result[0]["content"]
        # The summary survives verbatim, in order, in the untrusted tier.
        assert result[1]["content"] == "## Compacted Conversation Summary\nstuff"

    def test_build_messages_does_not_duplicate_primary_already_in_history(self) -> None:
        result = OllamaEngine._build_messages(
            "",
            "PRIMARY PROMPT",
            [
                {"role": "system", "content": "PRIMARY PROMPT"},
                {"role": "user", "content": "hi"},
            ],
        )
        assert [m["role"] for m in result] == ["system", "user"]
        assert result[0]["content"] == "PRIMARY PROMPT"

    def test_build_messages_demotes_non_leading_system(self) -> None:
        # A system message stranded after the conversation history (e.g. the
        # tool-failure nudge the loop appends) must not reach a system-first
        # GGUF template as a non-leading system message -- ornith:9b-48k's
        # template raises "System message must be at the beginning" -> HTTP 400.
        result = OllamaEngine._build_messages(
            "",
            "",
            [
                {"role": "system", "content": "identity"},
                {"role": "user", "content": "make an artifact"},
                {"role": "assistant", "content": "done"},
                {"role": "system", "content": "Tool failure context: retry."},
            ],
        )
        assert result[0]["role"] == "system"
        assert all(m["role"] != "system" for m in result[1:])
        # Position + content of the nudge are preserved; only the role changes.
        assert result[-1]["role"] == "user"
        assert result[-1]["content"] == "Tool failure context: retry."

    def test_build_messages_demotes_nudge_after_real_tool_failure_shape(self) -> None:
        # Reproduces the actual failing turn: an assistant tool-call message,
        # its tool result, then the trailing tool-failure system nudge appended
        # by _append_failed_tool_context_if_needed. The native tool row must
        # survive as role=tool (with its linkage) while the nudge is demoted to
        # user and the leading system block stays at index 0.
        result = OllamaEngine._build_messages(
            "",
            "",
            [
                {"role": "system", "content": "identity"},
                {"role": "user", "content": "where did you save it?"},
                {
                    "role": "assistant",
                    "content": "Calling tool 'list_dir'.",
                    "tool_calls": [
                        {"id": "call_1", "name": "list_dir", "arguments": {"path": "/x"}}
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "name": "list_dir",
                    "content": "Tool 'list_dir' failed: path does not exist",
                },
                {"role": "system", "content": "Tool failure context: retry."},
            ],
        )
        assert [m["role"] for m in result] == [
            "system",
            "user",
            "assistant",
            "tool",
            "user",
        ]
        # Tool row preserved (native role + call linkage); demote leaves it alone.
        assert result[3]["tool_call_id"] == "call_1"
        assert result[2]["tool_calls"][0]["function"]["name"] == "list_dir"
        # Nudge demoted to user with content intact; leading system untouched.
        assert result[-1]["content"] == "Tool failure context: retry."
        assert result[0]["content"] == "identity"


# -- Problem C: inband fallback in generate_with_tools_impl ----------------


def test_generate_with_tools_extracts_inband_calls_from_text(monkeypatch) -> None:
    engine = _build_engine()

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001
        return {
            "message": {
                "content": (
                    "Let me list the files.\n"
                    "<tool_call>\n"
                    '{"name": "glob_files", "arguments": {"pattern": "*.py"}}\n'
                    "</tool_call>"
                ),
                "tool_calls": [],
            }
        }

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate_with_tools(
        prompt="list files",
        tools=[{"name": "glob_files", "description": "Search files", "parameters": {}}],
    )

    assert result.finish_reason == "tool_calls"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_id == "glob_files"
    assert result.tool_calls[0].arguments == {"pattern": "*.py"}
    assert result.tool_calls[0].call_id.startswith("inband_")
    assert "<tool_call>" not in result.content


# -- Thinking policy ----------------------------------------------------------


def test_build_think_value_returns_true_for_default_effort() -> None:
    engine = _build_engine()
    engine._thinking = True  # noqa: SLF001
    assert engine._build_think_value(None) is True  # noqa: SLF001


def test_build_think_value_returns_true_for_medium_effort() -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.8:27b-q3-k-s"
    engine._thinking = True  # noqa: SLF001
    assert engine._build_think_value("medium") == "medium"  # noqa: SLF001


def test_build_think_value_preserves_qwen38_low_effort() -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.8:27b-q3-k-s"
    engine._thinking = True  # noqa: SLF001
    assert engine._build_think_value("low") == "low"  # noqa: SLF001


def test_build_think_value_returns_true_for_high_effort() -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.8:27b-q3-k-s"
    engine._thinking = True  # noqa: SLF001
    assert engine._build_think_value("high") == "high"  # noqa: SLF001


def test_build_think_value_returns_true_for_xhigh_effort() -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.8:27b-q3-k-s"
    engine._thinking = True  # noqa: SLF001
    assert engine._build_think_value("xhigh") == "max"  # noqa: SLF001


def test_build_think_value_maps_qwen38_automatic_minimal_and_none() -> None:
    engine = _build_engine()
    engine.model_name = "hf.co/unsloth/Qwen3.8-27B-GGUF:Q3_K_S"
    engine._thinking = True  # noqa: SLF001

    assert engine._build_think_value(None) == "medium"  # noqa: SLF001
    assert engine._build_think_value("minimal") == "low"  # noqa: SLF001
    assert engine._build_think_value("none") is False  # noqa: SLF001


def test_build_think_value_coerces_levels_for_boolean_only_model(caplog) -> None:
    # Owner decision 2026-08-31 (CMP-AI-0005): a graded effort carried over from
    # a qwen3.8-family session degrades to automatic thinking with a warning
    # instead of failing the turn. Electron clamps upstream; this WARN firing
    # means a clamp regressed.
    engine = _build_engine()
    engine.model_name = "thinking-model:latest"
    engine._thinking = True  # noqa: SLF001

    with caplog.at_level("WARNING"):
        assert engine._build_think_value("high") is True  # noqa: SLF001
    assert any("Automatic or None" in record.message for record in caplog.records)


def test_build_think_value_returns_none_when_thinking_disabled() -> None:
    engine = _build_engine()
    engine._thinking = False  # noqa: SLF001
    assert engine._build_think_value("high") is None  # noqa: SLF001


def test_generate_sends_think_true_for_default_effort(monkeypatch) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"
    engine._thinking = True  # noqa: SLF001
    store = TurnDiagnosticsStore()
    store.begin_turn(
        request_id="req_think_true_default",
        session_id="sess_think_true_default",
        mode="assist",
        debug_options=None,
    )
    engine.set_turn_diagnostics_store(store)
    engine.begin_request_context(
        request_id="req_think_true_default",
        diagnostics_store=store,
        debug_options=None,
        mode="assist",
    )
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001
        captured["data"] = data
        return {"message": {"content": "Quick answer"}}

    monkeypatch.setattr(engine, "_post", fake_post)

    result = engine.generate(prompt="hello")
    snapshot = store.snapshot()
    engine.clear_request_context(request_id="req_think_true_default")

    assert result == "Quick answer"
    assert captured["data"]["think"] is True
    assert captured["data"]["options"]["repeat_penalty"] == 1.15
    assert captured["data"]["options"]["repeat_last_n"] == 256
    assert snapshot["think_enabled"] is True


def test_generate_coerces_medium_effort_for_boolean_only_qwen(monkeypatch, caplog) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"
    engine._thinking = True  # noqa: SLF001
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001, ARG001
        captured["data"] = data
        return {"message": {"content": "Quick answer"}}

    monkeypatch.setattr(engine, "_post", fake_post)

    with caplog.at_level("WARNING"):
        result = engine.generate(prompt="hello", reasoning_effort="medium")

    assert result == "Quick answer"
    assert captured["data"]["think"] is True
    assert any("Automatic or None" in record.message for record in caplog.records)


def test_generate_coerces_low_effort_for_boolean_only_qwen(monkeypatch, caplog) -> None:
    engine = _build_engine()
    engine.model_name = "qwen3.5:9b"
    engine._thinking = True  # noqa: SLF001
    captured: dict[str, object] = {}

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001, ARG001
        captured["data"] = data
        return {"message": {"content": "Quick answer"}}

    monkeypatch.setattr(engine, "_post", fake_post)

    with caplog.at_level("WARNING"):
        assert engine.generate(prompt="hello", reasoning_effort="low") == "Quick answer"

    assert captured["data"]["think"] is True
    assert any("Automatic or None" in record.message for record in caplog.records)


# -- Phase 3: Tool payload compaction and caching ----------------------------


class TestBuildToolsPayloadCompaction:
    _TOOL_WITH_PARAM_DESCRIPTIONS = [
        {
            "name": "edit_file",
            "description": "Replace exact string matches in a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "The absolute path to the file to modify",
                    },
                    "old_string": {
                        "type": "string",
                        "description": "The text to replace",
                    },
                },
                "required": ["file_path", "old_string"],
            },
        },
    ]

    def test_compact_strips_parameter_descriptions(self) -> None:
        result = build_tools_payload(
            self._TOOL_WITH_PARAM_DESCRIPTIONS,
            compact=True,
        )
        props = result[0]["function"]["parameters"]["properties"]
        assert "description" not in props["file_path"]
        assert "description" not in props["old_string"]

    def test_compact_preserves_tool_level_description(self) -> None:
        result = build_tools_payload(
            self._TOOL_WITH_PARAM_DESCRIPTIONS,
            compact=True,
        )
        assert result[0]["function"]["description"] == "Replace exact string matches in a file."

    def test_compact_preserves_required_and_type_fields(self) -> None:
        result = build_tools_payload(
            self._TOOL_WITH_PARAM_DESCRIPTIONS,
            compact=True,
        )
        params = result[0]["function"]["parameters"]
        assert params["required"] == ["file_path", "old_string"]
        assert params["type"] == "object"
        assert params["properties"]["file_path"]["type"] == "string"

    def test_no_compact_preserves_parameter_descriptions(self) -> None:
        result = build_tools_payload(
            self._TOOL_WITH_PARAM_DESCRIPTIONS,
            compact=False,
        )
        props = result[0]["function"]["parameters"]["properties"]
        assert props["file_path"]["description"] == "The absolute path to the file to modify"

    def test_compact_handles_empty_properties(self) -> None:
        tools = [{"name": "list_dir", "description": "List dir", "parameters": {}}]
        result = build_tools_payload(tools, compact=True)
        assert result[0]["function"]["parameters"] == {}

    def test_compact_preserves_enum_fields(self) -> None:
        tools = [
            {
                "name": "search",
                "description": "Search",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "mode": {
                            "type": "string",
                            "description": "Search mode",
                            "enum": ["fast", "thorough"],
                        },
                    },
                },
            },
        ]
        result = build_tools_payload(tools, compact=True)
        mode_prop = result[0]["function"]["parameters"]["properties"]["mode"]
        assert mode_prop["enum"] == ["fast", "thorough"]
        assert "description" not in mode_prop


class TestToolsPayloadCache:
    def test_cache_reuses_on_same_tool_set(self) -> None:
        engine = _build_engine()
        tools = [
            {"name": "read_file", "description": "Read", "parameters": {}},
            {"name": "edit_file", "description": "Edit", "parameters": {}},
        ]
        first = engine._build_tools_payload_cached(tools)  # noqa: SLF001
        second = engine._build_tools_payload_cached(tools)  # noqa: SLF001
        assert first is second

    def test_cache_rebuilds_on_tool_set_change(self) -> None:
        engine = _build_engine()
        tools_v1 = [{"name": "read_file", "description": "Read", "parameters": {}}]
        tools_v2 = [
            {"name": "read_file", "description": "Read", "parameters": {}},
            {"name": "edit_file", "description": "Edit", "parameters": {}},
        ]
        first = engine._build_tools_payload_cached(tools_v1)  # noqa: SLF001
        second = engine._build_tools_payload_cached(tools_v2)  # noqa: SLF001
        assert first is not second
        assert len(first) == 1
        assert len(second) == 2

    def test_cache_cleared_on_model_reset(self) -> None:
        engine = _build_engine()
        tools = [{"name": "read_file", "description": "Read", "parameters": {}}]
        first = engine._build_tools_payload_cached(tools)  # noqa: SLF001
        engine._reset_loaded_state()  # noqa: SLF001
        second = engine._build_tools_payload_cached(tools)  # noqa: SLF001
        assert first is not second


def test_generate_with_tools_records_tool_payload_bytes(monkeypatch) -> None:
    engine = _build_engine()
    store = TurnDiagnosticsStore()
    store.begin_turn(
        request_id="req_payload_bytes",
        session_id="sess_payload_bytes",
        mode="assist",
        debug_options=None,
    )
    engine.set_turn_diagnostics_store(store)
    engine.begin_request_context(
        request_id="req_payload_bytes",
        diagnostics_store=store,
        debug_options=None,
        mode="assist",
    )

    def fake_post(endpoint, data, timeout=0):  # noqa: ANN001
        return {"message": {"content": "Done", "tool_calls": []}}

    monkeypatch.setattr(engine, "_post", fake_post)

    engine.generate_with_tools(
        prompt="hello",
        tools=[{"name": "read_file", "description": "Read a file", "parameters": {}}],
    )

    snapshot = store.snapshot()
    assert snapshot["provider_tool_payload_bytes"] > 0
    engine.clear_request_context(request_id="req_payload_bytes")
