"""Extended coverage for sidecar/ai/engines/ollama_runtime.py — reasoning/thinking,
bare-thought, repetition-guard, malformed-stream, error paths, and flush branches.

All fakes are kept local (no imports from the sibling test file) so this module
can be collected independently.  Monkeypatch approach mirrors the sibling file.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

import pytest

from sidecar.ai.engines import ollama_runtime
from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.ollama_runtime import (
    _extract_content_and_thinking,
    _is_retryable_transport_error,
    _raise_reasoning_effort_rejection,
    _raise_stream_transport_error,
    _register_response_cancel_callback,
    generate,
    generate_with_tools_impl,
    stream,
    stream_with_tools,
)
from sidecar.ai.engines.ollama_telemetry import record_ollama_chat_request
from sidecar.runtime.ollama_support import (
    EngineConnectionError,
    GenerationError,
    ModelNotLoadedError,
    ThinkingRepetitionGuard,
)

# ---------------------------------------------------------------------------
# Fakes (self-contained copies so this module needs no sibling imports)
# ---------------------------------------------------------------------------


class _JsonFormat:
    is_json = True


class FakeResponse:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = lines
        self.closed = False

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: Any) -> bool:
        return False

    def __iter__(self):
        return iter(self._lines)

    def close(self) -> None:
        self.closed = True


class FakeEngine:
    """Duck-typed engine — mirrors the one in test_ollama_runtime.py."""

    def __init__(
        self,
        *,
        post_response: Any = None,
        model_name: str = "gemma",
        host: str = "http://localhost:11434",
        reasoning_parser: Any = None,
        think_value: Any = None,
    ) -> None:
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
        self.reasoning_fallback_calls: list[dict[str, Any]] = []

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

    def _build_think_value(self, _effort: str | None) -> Any:
        return self._think_value

    def _effective_temperature(self, t: float) -> float:
        return t

    def _effective_top_k(self) -> Any:
        return None

    def _effective_top_p(self) -> Any:
        return None

    def _effective_min_p(self) -> Any:
        return None

    def _effective_repeat_penalty(self) -> Any:
        return None

    def _build_options(self, max_tokens: int, temperature: float, **_kw: Any) -> dict[str, Any]:
        return {"num_predict": max_tokens, "temperature": temperature}

    def _build_tools_payload_cached(self, tools: list[Any] | None) -> list[Any]:
        return list(tools or [])

    def _record_provider_request(self, **kw: Any) -> None:
        self.provider_requests.append(kw)

    def _complete_provider_request(self) -> None:
        self.completed += 1

    def _record_first_chunk(self) -> None:
        self.first_chunks += 1

    def _record_visible_output(self, text: str) -> None:
        self.visible_outputs.append(text)

    def _record_provider_usage(self, chunk: dict[str, Any]) -> None:
        self.usages.append(chunk)

    def _sanitize_thinking(self, text: str) -> str:
        return text

    def _extract_request_reasoning(self, _raw: str, parser_mode: str = "") -> Any:
        return None

    def _create_request_reasoning_parser(self) -> Any:
        return self._reasoning_parser

    def _thinking_token_headroom(self) -> int:
        return 1000

    def _log_reasoning_parser_fallback(self, **kw: Any) -> None:
        self.reasoning_fallback_calls.append(kw)

    def _request_id(self) -> str:
        return "req-1"

    def _post(self, _path: str, _data: dict[str, Any]) -> dict[str, Any]:
        if callable(self._post_response):
            return self._post_response(_path, _data)
        return self._post_response  # type: ignore[return-value]

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


def _patch_urlopen(monkeypatch, lines: list[bytes]) -> None:
    monkeypatch.setattr(urllib.request, "urlopen", lambda _req, timeout=None: FakeResponse(lines))


def _collect_stream(gen) -> tuple[list[Any], Any]:
    """Drain a generator; return (events_list, return_value)."""
    events: list[Any] = []
    result = None
    try:
        while True:
            events.append(next(gen))
    except StopIteration as stop:
        result = stop.value
    return events, result


# ---------------------------------------------------------------------------
# _raise_stream_transport_error (line 59)
# ---------------------------------------------------------------------------


def test_raise_stream_transport_error_wraps_in_engine_connection_error():
    engine = FakeEngine()
    with pytest.raises(EngineConnectionError, match="interrupted during streaming"):
        _raise_stream_transport_error(engine, ConnectionResetError("reset"))


# ---------------------------------------------------------------------------
# _register_response_cancel_callback (lines 141-146)
# ---------------------------------------------------------------------------


def test_register_response_cancel_callback_closes_response_when_cancelled():
    resp = FakeResponse([])
    callbacks: list[Any] = []

    class CancelHandle:
        def register_cancel_callback(self, cb: Any) -> None:
            callbacks.append(cb)

    _register_response_cancel_callback(CancelHandle(), resp)
    assert len(callbacks) == 1
    # Invoke the registered callback — should call resp.close()
    callbacks[0]("user_cancel")
    assert resp.closed is True


def test_register_response_cancel_callback_skips_if_no_register():
    # No register_cancel_callback attribute — should be a no-op.
    resp = FakeResponse([])
    _register_response_cancel_callback(object(), resp)
    assert not resp.closed


def test_register_response_cancel_callback_skips_if_not_callable():
    resp = FakeResponse([])

    class BadHandle:
        register_cancel_callback = "not_callable"

    _register_response_cancel_callback(BadHandle(), resp)
    assert not resp.closed


# ---------------------------------------------------------------------------
# _extract_content_and_thinking (lines 185-186) — reasoning fallback path
# ---------------------------------------------------------------------------


class _FakeExtracted:
    """Return value of engine._extract_request_reasoning."""

    def __init__(self, visible: str, reasoning: str) -> None:
        self.visible_text = visible
        self.reasoning_text = reasoning


def test_extract_content_and_thinking_uses_reasoning_fallback():
    """When thinking is absent but _extract_request_reasoning returns an object,
    content and thinking should come from that extracted result."""

    class EngineWithExtract(FakeEngine):
        def _extract_request_reasoning(self, raw: str, parser_mode: str = "") -> Any:
            return _FakeExtracted(visible="visible part", reasoning="reasoning part")

    engine = EngineWithExtract()
    message = {"content": "thought reasoning part\n\nvisible part", "thinking": ""}
    content, thinking = _extract_content_and_thinking(engine, message)
    assert "visible part" in content
    assert "reasoning part" in thinking


def test_extract_content_and_thinking_no_fallback_when_thinking_present():
    """Native thinking field should skip _extract_request_reasoning entirely."""

    class EngineWithExtract(FakeEngine):
        def _extract_request_reasoning(self, raw: str, parser_mode: str = "") -> Any:
            raise AssertionError("should not be called")

    engine = EngineWithExtract()
    message = {"content": "answer", "thinking": "my reasoning"}
    content, thinking = _extract_content_and_thinking(engine, message)
    assert thinking == "my reasoning"
    assert "answer" in content


# ---------------------------------------------------------------------------
# generate — timeout on generic exception (line 261)
# ---------------------------------------------------------------------------


def test_generate_maps_generic_timeout_to_generation_error():
    def _post(_path, _data):
        raise OSError("timed out")

    engine = FakeEngine(post_response=_post)
    engine._is_timeout_error = lambda _e: True
    with pytest.raises(GenerationError, match="timed out"):
        generate(engine, prompt="hi")
    assert engine.completed == 1


def test_generate_wraps_generic_non_timeout_exception():
    def _post(_path, _data):
        raise RuntimeError("something random")

    engine = FakeEngine(post_response=_post)
    with pytest.raises(GenerationError, match="Generation failed"):
        generate(engine, prompt="hi")


def test_reasoning_effort_http_400_preserves_tool_schema_fallback() -> None:
    error = urllib.error.HTTPError(
        url="http://localhost:11434/api/chat",
        code=400,
        msg="bad request",
        hdrs=None,
        fp=None,
    )

    _raise_reasoning_effort_rejection(
        error,
        {"think": "medium", "tools": [{"type": "function"}]},
    )
    with pytest.raises(GenerationError, match="string-valued think levels"):
        _raise_reasoning_effort_rejection(error, {"think": "medium"})


def test_request_telemetry_uses_actual_final_allowance() -> None:
    engine = FakeEngine()

    record_ollama_chat_request(
        engine,
        {
            "think": "medium",
            "options": {"num_predict": 40_960, "temperature": 1.0},
        },
        [{"role": "user", "content": "hello"}],
        final_output_tokens=8_192,
    )

    assert engine.provider_requests[0]["final_output_tokens"] == 8_192
    assert engine.provider_requests[0]["thinking_headroom_tokens"] == 32_768

    invalid_engine = FakeEngine()
    record_ollama_chat_request(
        invalid_engine,
        {
            "think": False,
            "options": {"num_predict": "40960", "temperature": 1.0},
        },
        [],
        final_output_tokens=8_192,
    )
    assert invalid_engine.provider_requests[0]["num_predict"] is None
    assert invalid_engine.provider_requests[0]["thinking_headroom_tokens"] == 0


# ---------------------------------------------------------------------------
# stream — think_value + format flag propagation (lines 302, 304)
# ---------------------------------------------------------------------------


def test_stream_sets_think_and_json_format_in_request(monkeypatch):
    captured: dict[str, Any] = {}
    original_urlopen = urllib.request.urlopen

    def _fake_open(req: urllib.request.Request, timeout: Any = None) -> FakeResponse:
        captured["body"] = json.loads(req.data)
        return FakeResponse(
            [
                json.dumps({"message": {"content": "ok"}, "done": True}).encode() + b"\n",
            ]
        )

    monkeypatch.setattr(urllib.request, "urlopen", _fake_open)
    engine = FakeEngine(think_value=True)
    list(stream(engine, prompt="hi", response_format=_JsonFormat()))
    assert captured["body"]["think"] is True
    assert captured["body"]["format"] == "json"


# ---------------------------------------------------------------------------
# stream — empty line skipped (line 337)
# ---------------------------------------------------------------------------


def test_stream_skips_empty_lines(monkeypatch):
    lines = [
        b"",
        json.dumps({"message": {"content": "hello"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    events = list(stream(engine, prompt="hi"))
    assert any(e.kind == "content" for e in events)


# ---------------------------------------------------------------------------
# stream — thinking suppression (lines 352, 355-363)
# ---------------------------------------------------------------------------


def test_stream_suppresses_repeated_thinking_after_guard_trips(monkeypatch, caplog):
    """Deliver cumulative growing thinking snapshots with repetitive content to trip
    the guard, verifying subsequent chunks are suppressed and logged once."""
    # Each chunk grows by appending the same phrase and is forwarded verbatim to
    # the repetition guard, which trips on the 'repetition' or 'char_limit' stop
    # reasons.
    chunk = "repeat loop " * 5  # 60 chars per delta
    n = 80
    lines = []
    cumulative = ""
    for _ in range(n):
        cumulative += chunk
        lines.append(
            json.dumps({"message": {"thinking": cumulative, "content": ""}}).encode() + b"\n"
        )
    lines.append(json.dumps({"message": {"content": "answer"}, "done": True}).encode() + b"\n")
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(think_value=True)
    with caplog.at_level("INFO", logger="sidecar.ai.engines.ollama_runtime"):
        events = list(stream(engine, prompt="hi"))
    thinking_events = [e for e in events if e.kind == "thinking"]
    content_events = [e for e in events if e.kind == "content"]
    # Guard should have tripped — not ALL 80 chunks should yield thinking events.
    assert len(thinking_events) < n
    assert content_events  # answer still emitted
    # Suppression log should appear exactly once.
    suppression_logs = [r for r in caplog.records if "Suppressing" in r.message]
    assert len(suppression_logs) == 1


# ---------------------------------------------------------------------------
# stream — repeated thinking chunks are real deltas, never deduplicated
# ---------------------------------------------------------------------------


def test_stream_forwards_repeated_thinking_chunks_verbatim(monkeypatch):
    """Ollama streams thinking per token; an identical chunk twice is two tokens
    (``"0","0"`` in ``800``), so both must reach the consumer."""
    snapshot = "same chunk repeated by the provider"
    lines = [
        json.dumps({"message": {"thinking": snapshot, "content": ""}}).encode() + b"\n",
        json.dumps({"message": {"thinking": snapshot, "content": ""}}).encode() + b"\n",
        json.dumps({"message": {"content": "final"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(think_value=True)
    events = list(stream(engine, prompt="hi"))
    thinking_events = [e for e in events if e.kind == "thinking"]
    assert [e.text for e in thinking_events] == [snapshot, snapshot]


# ---------------------------------------------------------------------------
# stream — reasoning parser path with used_markers (lines 371-375)
# ---------------------------------------------------------------------------


class _FakeReasoningParser:
    """Stub incremental reasoning parser."""

    def __init__(self, *, used_markers: bool = False) -> None:
        self.used_markers = used_markers
        self._feed_results: list[tuple[str, str]] = []
        self._flush_result: tuple[str, str] = ("", "")

    def feed(self, text: str) -> tuple[str, str]:
        if self._feed_results:
            return self._feed_results.pop(0)
        return ("", text)

    def flush(self) -> tuple[str, str]:
        return self._flush_result


def test_stream_reasoning_parser_logs_fallback_when_used_markers(monkeypatch):
    """When the parser returns reasoning text AND used_markers is True, the engine's
    _log_reasoning_parser_fallback should be called."""
    parser = _FakeReasoningParser(used_markers=True)
    parser._feed_results = [("reasoning from parser", "visible text")]

    lines = [
        json.dumps({"message": {"content": "<think>reasoning</think>visible"}}).encode() + b"\n",
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(think_value=True, reasoning_parser=parser)
    events = list(stream(engine, prompt="hi"))
    thinking_events = [e for e in events if e.kind == "thinking"]
    assert thinking_events
    assert engine.reasoning_fallback_calls


def test_stream_reasoning_parser_no_log_when_no_markers(monkeypatch):
    """When used_markers is False, no fallback log call should happen."""
    parser = _FakeReasoningParser(used_markers=False)
    parser._feed_results = [("some reasoning", "some visible")]

    lines = [
        json.dumps({"message": {"content": "content chunk"}}).encode() + b"\n",
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(reasoning_parser=parser)
    list(stream(engine, prompt="hi"))
    assert not engine.reasoning_fallback_calls


# ---------------------------------------------------------------------------
# stream — reasoning_text suppression via parser path (lines 381-393)
# ---------------------------------------------------------------------------


def test_stream_suppresses_parser_reasoning_after_guard_trips(monkeypatch, caplog):
    """When the reasoning parser returns reasoning_text but the guard has already
    tripped, the reasoning event should be suppressed and logged once."""
    guard = ThinkingRepetitionGuard(max_chars=1)  # tiny limit → trips immediately
    guard.feed("x" * 10)  # pre-trip the guard
    assert guard.should_stop

    parser = _FakeReasoningParser(used_markers=False)
    parser._feed_results = [("more reasoning", "visible")]

    lines = [
        json.dumps({"message": {"content": "content"}}).encode() + b"\n",
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)

    engine = FakeEngine(reasoning_parser=parser, think_value=True)
    # The shared resolver floors engine-supplied budgets at 16,384 chars, so the
    # old `_thinking_token_headroom = lambda: 1` knob is dead; patch the resolver
    # at the consuming module. Abort is disabled so this test keeps exercising
    # the suppress-log path it was written for.
    monkeypatch.setattr(
        ollama_runtime, "resolve_thinking_budget_chars", lambda _engine, _max_tokens: 4
    )
    monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", "0")

    with caplog.at_level("INFO"):
        events = list(stream(engine, prompt="hi"))

    thinking_events = [e for e in events if e.kind == "thinking"]
    # Parser text gets suppressed by the guard — no thinking events from parser.
    # (The guard built by stream() has max_chars=4 and reasoning text "more reasoning"=14 chars,
    # so the guard must trip and log exactly once.)
    suppression_logs = [r for r in caplog.records if "Suppressing" in r.message]
    assert suppression_logs  # guard must have tripped and suppression must be logged


# ---------------------------------------------------------------------------
# stream — reasoning_parser flush on done chunk (lines 399-417)
# ---------------------------------------------------------------------------


def test_stream_flushes_reasoning_parser_on_done(monkeypatch):
    """On the done chunk, any buffered reasoning/visible in the parser should be
    flushed and yielded as events."""
    parser = _FakeReasoningParser(used_markers=False)
    parser._flush_result = ("flushed_reasoning", "flushed_visible")

    lines = [
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(reasoning_parser=parser)
    events = list(stream(engine, prompt="hi"))
    kinds = [e.kind for e in events]
    assert "thinking" in kinds
    assert "content" in kinds
    texts = {e.kind: e.text for e in events}
    assert texts["thinking"] == "flushed_reasoning"


def test_stream_flushes_reasoning_parser_logs_fallback_on_done(monkeypatch):
    """Flush path with used_markers=True should call _log_reasoning_parser_fallback."""
    parser = _FakeReasoningParser(used_markers=True)
    parser._flush_result = ("flush_reasoning", "flush_visible")

    lines = [
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(reasoning_parser=parser)
    list(stream(engine, prompt="hi"))
    assert engine.reasoning_fallback_calls


# ---------------------------------------------------------------------------
# stream — error paths (lines 425, 430-439)
# ---------------------------------------------------------------------------


def test_stream_maps_url_timeout_to_generation_error(monkeypatch):
    def _boom(_req, timeout=None):
        raise urllib.error.URLError("timed out")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    engine = FakeEngine()
    engine._is_timeout_url_error = lambda _e: True
    with pytest.raises(GenerationError, match="timed out"):
        list(stream(engine, prompt="hi"))
    assert engine.completed == 1


def test_stream_reraises_engine_connection_error(monkeypatch):
    def _boom(_req, timeout=None):
        raise EngineConnectionError("already wrapped")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    engine = FakeEngine()
    with pytest.raises(EngineConnectionError):
        list(stream(engine, prompt="hi"))
    assert engine.completed == 1


def test_stream_reraises_model_not_loaded(monkeypatch):
    def _boom(_req, timeout=None):
        raise ModelNotLoadedError("no model")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    engine = FakeEngine()
    with pytest.raises(ModelNotLoadedError):
        list(stream(engine, prompt="hi"))
    assert engine.completed == 1


def test_stream_maps_generic_timeout_exception(monkeypatch):
    def _boom(_req, timeout=None):
        raise OSError("socket timed out")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    engine = FakeEngine()
    engine._is_timeout_error = lambda _e: True
    with pytest.raises(GenerationError, match="timed out"):
        list(stream(engine, prompt="hi"))
    assert engine.completed == 1


def test_stream_maps_retryable_transport_error_to_engine_connection_error(monkeypatch):
    def _boom(_req, timeout=None):
        raise ConnectionResetError("peer reset")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    engine = FakeEngine()
    with pytest.raises(EngineConnectionError, match="interrupted during streaming"):
        list(stream(engine, prompt="hi"))
    assert engine.completed == 1


def test_stream_wraps_non_retryable_generic_exception(monkeypatch):
    def _boom(_req, timeout=None):
        raise ValueError("unexpected")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    engine = FakeEngine()
    with pytest.raises(GenerationError, match="Streaming generation failed"):
        list(stream(engine, prompt="hi"))
    assert engine.completed == 1


# ---------------------------------------------------------------------------
# stream_with_tools — think / format flags (lines 497, 499)
# ---------------------------------------------------------------------------


def test_stream_with_tools_sets_think_and_format_flags(monkeypatch):
    captured: dict[str, Any] = {}

    def _fake_open(req: urllib.request.Request, timeout: Any = None) -> FakeResponse:
        captured["body"] = json.loads(req.data)
        return FakeResponse(
            [
                json.dumps({"message": {"content": "ok"}, "done": True}).encode() + b"\n",
            ]
        )

    monkeypatch.setattr(urllib.request, "urlopen", _fake_open)
    engine = FakeEngine(think_value=True)
    gen = stream_with_tools(engine, prompt="hi", tools=[], response_format=_JsonFormat())
    _collect_stream(gen)
    assert captured["body"]["think"] is True
    assert captured["body"]["format"] == "json"


# ---------------------------------------------------------------------------
# stream_with_tools — empty line (line 545) + malformed line (549-553)
# ---------------------------------------------------------------------------


def test_stream_with_tools_skips_empty_lines(monkeypatch):
    lines = [
        b"",
        json.dumps({"message": {"content": "hi"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    events, result = _collect_stream(gen)
    assert result is not None
    assert result.finish_reason == "stop"


def test_stream_with_tools_skips_malformed_lines(monkeypatch, caplog):
    lines = [
        b"{bad json\n",
        b"also bad\n",
        json.dumps({"message": {"content": "ok"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    with caplog.at_level("WARNING"):
        gen = stream_with_tools(engine, prompt="hi", tools=[])
        events, result = _collect_stream(gen)
    assert result is not None
    assert result.content == "ok"
    # Warning logged for malformed lines.
    warnings = [r for r in caplog.records if "malformed" in r.message.lower()]
    assert warnings


# ---------------------------------------------------------------------------
# stream_with_tools — normalizer.feed exception swallowed (lines 556-557)
# ---------------------------------------------------------------------------


def test_stream_with_tools_swallows_normalizer_feed_exception(monkeypatch):
    """If the normalizer raises on feed(), streaming should continue normally."""
    lines = [
        json.dumps({"message": {"content": "answer"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    # Patch the normalizer class to inject a broken feed().
    from sidecar.ai.routing import provider_stream_normalizer as psn_mod

    original_cls = psn_mod.ProviderStreamNormalizer

    class BrokenNormalizer(original_cls):
        def feed(self, chunk):
            raise RuntimeError("normalizer explodes")

    import sidecar.ai.routing.provider_stream_normalizer as psn

    monkeypatch.setattr(psn, "ProviderStreamNormalizer", BrokenNormalizer)
    import importlib

    import sidecar.ai.engines.ollama_runtime as orm

    # Patch at the module level where stream_with_tools uses it.
    monkeypatch.setattr(orm, "ProviderStreamNormalizer", BrokenNormalizer)

    gen = stream_with_tools(engine, prompt="hi", tools=[])
    events, result = _collect_stream(gen)
    assert result is not None  # didn't crash


# ---------------------------------------------------------------------------
# stream_with_tools — native thinking + dedup + suppression (lines 561-578)
# ---------------------------------------------------------------------------


def test_stream_with_tools_native_thinking_yields_thinking_events(monkeypatch):
    lines = [
        json.dumps({"message": {"thinking": "step 1", "content": ""}}).encode() + b"\n",
        json.dumps({"message": {"thinking": "step 2", "content": ""}}).encode() + b"\n",
        json.dumps({"message": {"content": "answer"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(think_value=True)
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    events, result = _collect_stream(gen)
    thinking_events = [e for e in events if e.kind == "thinking"]
    # Ollama streams ``message.thinking`` as per-token deltas: both chunks are
    # emitted verbatim. Pin the whole sequence so a delta heuristic that drops
    # or merges the second chunk cannot pass on the first chunk alone.
    assert [e.text for e in thinking_events] == ["step 1", "step 2"]


def test_stream_with_tools_suppresses_repeated_thinking(monkeypatch, caplog):
    # Growing chunks with repetitive content, forwarded verbatim, trip the guard.
    chunk = "repeat loop " * 5
    n = 80
    lines = []
    cumulative = ""
    for _ in range(n):
        cumulative += chunk
        lines.append(
            json.dumps({"message": {"thinking": cumulative, "content": ""}}).encode() + b"\n"
        )
    lines.append(json.dumps({"message": {"content": "done"}, "done": True}).encode() + b"\n")
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(think_value=True)
    with caplog.at_level("INFO", logger="sidecar.ai.engines.ollama_runtime"):
        gen = stream_with_tools(engine, prompt="hi", tools=[])
        events, result = _collect_stream(gen)
    thinking_events = [e for e in events if e.kind == "thinking"]
    assert len(thinking_events) < n
    suppression_logs = [r for r in caplog.records if "Suppressing" in r.message]
    assert len(suppression_logs) == 1


def test_stream_with_tools_forwards_repeated_thinking_verbatim(monkeypatch):
    # A repeated chunk is a real per-token delta; both copies must be emitted.
    snapshot = "same chunk repeated by the provider"
    lines = [
        json.dumps({"message": {"thinking": snapshot}}).encode() + b"\n",
        json.dumps({"message": {"thinking": snapshot}}).encode() + b"\n",
        json.dumps({"message": {"content": "final"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(think_value=True)
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    events, _ = _collect_stream(gen)
    thinking_events = [e for e in events if e.kind == "thinking"]
    assert [e.text for e in thinking_events] == [snapshot, snapshot]


# ---------------------------------------------------------------------------
# stream_with_tools — bare-thought mode (lines 588-619)
# ---------------------------------------------------------------------------


def test_stream_with_tools_bare_thought_with_paragraph_break(monkeypatch):
    """Content starting with 'thought ' followed by \\n\\n should be split
    into a thinking event and a content event."""
    parser = _FakeReasoningParser(used_markers=False)
    lines = [
        json.dumps({"message": {"content": "thought step one\n\nThe answer is 42"}}).encode()
        + b"\n",
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(reasoning_parser=parser)
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    events, result = _collect_stream(gen)
    thinking_events = [e for e in events if e.kind == "thinking"]
    content_events = [e for e in events if e.kind == "content"]
    assert thinking_events
    assert "step one" in thinking_events[0].text
    assert content_events


def test_stream_with_tools_bare_thought_across_two_chunks(monkeypatch):
    """Bare thought prefix split across two content chunks."""
    parser = _FakeReasoningParser(used_markers=False)
    lines = [
        json.dumps({"message": {"content": "thought step one"}}).encode() + b"\n",
        json.dumps({"message": {"content": "\n\nThe answer"}}).encode() + b"\n",
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(reasoning_parser=parser)
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    events, _ = _collect_stream(gen)
    thinking_events = [e for e in events if e.kind == "thinking"]
    content_events = [e for e in events if e.kind == "content"]
    assert thinking_events
    # The "thought " prefix must be stripped and only the payload text kept.
    assert "step one" in thinking_events[0].text
    assert content_events
    # The answer after the \n\n separator must appear in content.
    assert "The answer" in content_events[0].text


def test_stream_with_tools_bare_thought_no_paragraph_break_flushed_on_done(monkeypatch):
    """Bare thought buffer with no \\n\\n separator should be flushed as thinking
    on the done chunk (lines 658-668)."""
    parser = _FakeReasoningParser(used_markers=False)
    lines = [
        json.dumps({"message": {"content": "thought pondering without break"}}).encode() + b"\n",
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(reasoning_parser=parser)
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    events, result = _collect_stream(gen)
    thinking_events = [e for e in events if e.kind == "thinking"]
    # Buffer flushed on done → thinking event emitted.
    assert thinking_events
    assert "pondering" in thinking_events[0].text


def test_stream_with_tools_bare_thought_content_on_done_chunk_reaches_terminal(monkeypatch):
    """A done chunk that still carries bare-thought content must not skip the
    terminal block: the turn ends cleanly (never finish_reason="incomplete")
    and the buffered thought is flushed, not discarded."""
    parser = _FakeReasoningParser(used_markers=False)
    lines = [
        json.dumps({"message": {"content": "thought pondering without"}}).encode() + b"\n",
        json.dumps({"message": {"content": " break"}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(reasoning_parser=parser)
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    events, result = _collect_stream(gen)
    thinking_events = [e for e in events if e.kind == "thinking"]
    assert thinking_events
    assert "pondering without break" in thinking_events[0].text
    assert result.finish_reason == "stop"


# ---------------------------------------------------------------------------
# stream_with_tools — reasoning parser path in stream_with_tools (623-646)
# ---------------------------------------------------------------------------


def test_stream_with_tools_reasoning_parser_feeds_and_logs_fallback(monkeypatch):
    parser = _FakeReasoningParser(used_markers=True)
    parser._feed_results = [("parser reasoning", "parser visible")]

    lines = [
        json.dumps(
            {"message": {"content": "<think>parser reasoning</think>parser visible"}}
        ).encode()
        + b"\n",
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(reasoning_parser=parser, think_value=True)
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    events, _ = _collect_stream(gen)
    thinking_events = [e for e in events if e.kind == "thinking"]
    assert thinking_events
    assert engine.reasoning_fallback_calls


def test_stream_with_tools_reasoning_parser_suppresses_thinking(monkeypatch, caplog):
    """Parser reasoning text suppressed by guard → log message emitted."""
    parser = _FakeReasoningParser(used_markers=False)
    parser._feed_results = [("long reasoning " * 20, "visible")]

    lines = [
        json.dumps({"message": {"content": "content"}}).encode() + b"\n",
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    # Very small budget → guard trips immediately on parser reasoning. The
    # shared resolver floors engine budgets at 16,384 chars, so patch it at the
    # consuming module; abort stays off to keep exercising the suppress log.
    engine = FakeEngine(reasoning_parser=parser, think_value=True)
    monkeypatch.setattr(
        ollama_runtime, "resolve_thinking_budget_chars", lambda _engine, _max_tokens: 4
    )
    monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", "0")

    with caplog.at_level("INFO"):
        gen = stream_with_tools(engine, prompt="hi", tools=[])
        events, _ = _collect_stream(gen)

    suppression_logs = [r for r in caplog.records if "Suppressing" in r.message]
    # Guard must have tripped: reasoning_text "long reasoning "*20 (300 chars) far exceeds
    # max_chars=4, so suppression must be logged.
    assert suppression_logs  # guard must have tripped and suppression must be logged


# ---------------------------------------------------------------------------
# stream_with_tools — reasoning_parser flush on done (lines 670-690)
# ---------------------------------------------------------------------------


def test_stream_with_tools_flushes_reasoning_parser_on_done(monkeypatch):
    parser = _FakeReasoningParser(used_markers=False)
    parser._flush_result = ("flush_think", "flush_vis")

    lines = [
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(reasoning_parser=parser)
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    events, result = _collect_stream(gen)
    kinds = [e.kind for e in events]
    assert "thinking" in kinds
    assert "content" in kinds
    thinking_texts = [e.text for e in events if e.kind == "thinking"]
    assert "flush_think" in thinking_texts


def test_stream_with_tools_flush_logs_fallback_with_used_markers(monkeypatch):
    parser = _FakeReasoningParser(used_markers=True)
    parser._flush_result = ("flush_reasoning", "flush_visible")

    lines = [
        json.dumps({"message": {"content": ""}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine(reasoning_parser=parser)
    gen = stream_with_tools(engine, prompt="hi", tools=[])
    _collect_stream(gen)
    assert engine.reasoning_fallback_calls


# ---------------------------------------------------------------------------
# stream_with_tools — error paths (lines 738-755)
# ---------------------------------------------------------------------------


def test_stream_with_tools_maps_url_timeout(monkeypatch):
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda _req, timeout=None: (_ for _ in ()).throw(urllib.error.URLError("slow")),
    )
    engine = FakeEngine()
    engine._is_timeout_url_error = lambda _e: True
    with pytest.raises(GenerationError, match="timed out"):
        gen = stream_with_tools(engine, prompt="hi", tools=[])
        _collect_stream(gen)
    assert engine.completed == 1


def test_stream_with_tools_maps_url_error_to_connection_error(monkeypatch):
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda _req, timeout=None: (_ for _ in ()).throw(urllib.error.URLError("refused")),
    )
    engine = FakeEngine()
    with pytest.raises(EngineConnectionError):
        gen = stream_with_tools(engine, prompt="hi", tools=[])
        _collect_stream(gen)
    assert engine.completed == 1


def test_stream_with_tools_reraises_engine_connection_error(monkeypatch):
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda _req, timeout=None: (_ for _ in ()).throw(EngineConnectionError("already")),
    )
    engine = FakeEngine()
    with pytest.raises(EngineConnectionError):
        gen = stream_with_tools(engine, prompt="hi", tools=[])
        _collect_stream(gen)
    assert engine.completed == 1


def test_stream_with_tools_reraises_model_not_loaded(monkeypatch):
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda _req, timeout=None: (_ for _ in ()).throw(ModelNotLoadedError("no model")),
    )
    engine = FakeEngine()
    with pytest.raises(ModelNotLoadedError):
        gen = stream_with_tools(engine, prompt="hi", tools=[])
        _collect_stream(gen)
    assert engine.completed == 1


def test_stream_with_tools_maps_generic_timeout_exception(monkeypatch):
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda _req, timeout=None: (_ for _ in ()).throw(OSError("socket timed out")),
    )
    engine = FakeEngine()
    engine._is_timeout_error = lambda _e: True
    with pytest.raises(GenerationError, match="timed out"):
        gen = stream_with_tools(engine, prompt="hi", tools=[])
        _collect_stream(gen)
    assert engine.completed == 1


def test_stream_with_tools_maps_retryable_transport_error(monkeypatch):
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda _req, timeout=None: (_ for _ in ()).throw(ConnectionResetError("peer reset")),
    )
    engine = FakeEngine()
    with pytest.raises(EngineConnectionError, match="interrupted during streaming"):
        gen = stream_with_tools(engine, prompt="hi", tools=[])
        _collect_stream(gen)
    assert engine.completed == 1


def test_stream_with_tools_wraps_non_retryable_exception(monkeypatch):
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda _req, timeout=None: (_ for _ in ()).throw(ValueError("unexpected")),
    )
    engine = FakeEngine()
    with pytest.raises(GenerationError, match="Streaming generation failed"):
        gen = stream_with_tools(engine, prompt="hi", tools=[])
        _collect_stream(gen)
    assert engine.completed == 1


# ---------------------------------------------------------------------------
# stream_with_tools — extract_inband_tool_calls fallback (lines 723-724)
# ---------------------------------------------------------------------------


def test_stream_with_tools_extracts_inband_tool_calls_from_content(monkeypatch):
    """When no native tool calls are returned but content contains inband XML
    tool call markers, extract_inband_tool_calls should fire and set finish_reason
    to 'tool_calls'."""
    known_tool = "my_tool"
    # Format 1 (XML) accepted by extract_inband_tool_calls in sidecar/ai/tools/inband_parser.py:
    # <tool_call>{"name": "<name>", "arguments": {...}}</tool_call>
    inband = (
        f"<tool_call>{json.dumps({'name': known_tool, 'arguments': {'key': 'val'}})}</tool_call>"
    )
    lines = [
        json.dumps({"message": {"content": inband}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()
    tools = [{"function": {"name": known_tool}}]
    gen = stream_with_tools(engine, prompt="hi", tools=tools)
    events, result = _collect_stream(gen)
    assert result is not None
    # The inband parser must have fired — finish_reason must be "tool_calls".
    assert result.finish_reason == "tool_calls"
    assert result.tool_calls
    assert result.tool_calls[0].tool_id == known_tool


def test_stream_with_tools_reports_failed_inband_parse(monkeypatch):
    malformed = "<tool_call>\n{not valid json}\n</tool_call>"
    lines = [
        json.dumps({"message": {"content": malformed}, "done": True}).encode() + b"\n",
    ]
    _patch_urlopen(monkeypatch, lines)
    engine = FakeEngine()

    _events, result = _collect_stream(
        stream_with_tools(
            engine,
            prompt="hi",
            tools=[{"function": {"name": "my_tool"}}],
        )
    )

    assert result is not None
    assert result.content == malformed
    assert result.inband_tool_call_parse_failed is True


# ---------------------------------------------------------------------------
# generate_with_tools_impl — think + format flags (lines 796, 798)
# ---------------------------------------------------------------------------


def _run_impl(engine: FakeEngine, tools: list | None = None):
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


def test_generate_with_tools_impl_sets_think_and_format_flags():
    captured: dict[str, Any] = {}

    def _post(_path: str, data: dict[str, Any]) -> dict[str, Any]:
        captured.update(data)
        return {"message": {"content": "ok", "thinking": ""}}

    engine = FakeEngine(post_response=_post, think_value=True)
    engine._post_response = _post  # override default
    # Patch _post to intercept.
    engine._post = _post

    # Add response_format override by wrapping.
    result = generate_with_tools_impl(
        engine,
        prompt="hi",
        tools=[],
        max_tokens=128,
        temperature=0.5,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system="",
        messages=None,
        response_format=_JsonFormat(),
    )
    assert captured.get("think") is True
    assert captured.get("format") == "json"


# ---------------------------------------------------------------------------
# generate_with_tools_impl — extract_inband_tool_calls (lines 838-839)
# ---------------------------------------------------------------------------


def test_generate_with_tools_impl_extracts_inband_tool_calls():
    """When no native tool calls but inband XML in content, extract them and set
    finish_reason to 'tool_calls'."""
    known_tool = "file_tool"
    # Format 1 (XML) accepted by extract_inband_tool_calls in sidecar/ai/tools/inband_parser.py:
    # <tool_call>{"name": "<name>", "arguments": {...}}</tool_call>
    inband = f"<tool_call>{json.dumps({'name': known_tool, 'arguments': {'f': 'x'}})}</tool_call>"

    engine = FakeEngine(post_response={"message": {"content": inband, "thinking": ""}})
    tools = [{"function": {"name": known_tool}}]
    result = _run_impl(engine, tools=tools)
    # The inband parser must have fired — finish_reason must be "tool_calls".
    assert result.finish_reason == "tool_calls"
    assert result.tool_calls
    assert result.tool_calls[0].tool_id == known_tool


def test_generate_with_tools_impl_reports_failed_inband_parse():
    malformed = "<tool_call>\n{not valid json}\n</tool_call>"
    engine = FakeEngine(post_response={"message": {"content": malformed, "thinking": ""}})

    result = _run_impl(engine, tools=[{"function": {"name": "file_tool"}}])

    assert result.content == malformed
    assert result.inband_tool_call_parse_failed is True


# ---------------------------------------------------------------------------
# generate_with_tools_impl — error paths (lines 851-865)
# ---------------------------------------------------------------------------


def test_generate_with_tools_impl_maps_url_timeout():
    def _post(_path, _data):
        raise urllib.error.URLError("slow")

    engine = FakeEngine(post_response=_post)
    engine._post = _post
    engine._is_timeout_url_error = lambda _e: True
    with pytest.raises(GenerationError, match="timed out"):
        _run_impl(engine)
    assert engine.completed == 1


def test_generate_with_tools_impl_maps_url_error_to_connection_error():
    def _post(_path, _data):
        raise urllib.error.URLError("refused")

    engine = FakeEngine()
    engine._post = _post
    with pytest.raises(EngineConnectionError):
        _run_impl(engine)
    assert engine.completed == 1


def test_generate_with_tools_impl_reraises_engine_connection_error():
    def _post(_path, _data):
        raise EngineConnectionError("already")

    engine = FakeEngine()
    engine._post = _post
    with pytest.raises(EngineConnectionError):
        _run_impl(engine)
    assert engine.completed == 1


def test_generate_with_tools_impl_reraises_model_not_loaded():
    def _post(_path, _data):
        raise ModelNotLoadedError("none")

    engine = FakeEngine()
    engine._post = _post
    with pytest.raises(ModelNotLoadedError):
        _run_impl(engine)
    assert engine.completed == 1


def test_generate_with_tools_impl_maps_generic_timeout():
    def _post(_path, _data):
        raise OSError("timed out")

    engine = FakeEngine()
    engine._post = _post
    engine._is_timeout_error = lambda _e: True
    with pytest.raises(GenerationError, match="timed out"):
        _run_impl(engine)
    assert engine.completed == 1


def test_generate_with_tools_impl_wraps_generic_exception():
    def _post(_path, _data):
        raise RuntimeError("boom")

    engine = FakeEngine()
    engine._post = _post
    with pytest.raises(GenerationError, match="Generation failed"):
        _run_impl(engine)
    assert engine.completed == 1
