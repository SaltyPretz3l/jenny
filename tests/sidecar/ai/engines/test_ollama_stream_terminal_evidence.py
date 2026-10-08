"""F10 -- an Ollama stream must not fail OPEN when it never terminates cleanly.

``stream``/``stream_with_tools`` broke out of the NDJSON read loop only on
``chunk["done"]`` and then yielded ``StreamingEvent(kind="done",
finish_reason="stop")`` UNCONDITIONALLY after the ``urlopen`` block. A stream
that EOF'd with no ``done`` chunk -- a killed runner, a truncated body, a proxy
cutting the connection -- produced the IDENTICAL success event (just with
``usage=None``), so a silently truncated answer was indistinguishable from a
complete one. In-band ``{"error": ...}`` frames were not classified at all.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from typing import Any

import pytest

from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.ollama_telemetry import resolve_ollama_stream_finish_reason
from sidecar.ai.error_codes import CMP_STREAM_INCOMPLETE
from sidecar.ai.exceptions import EngineConnectionError
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
    FINISH_REASON_THINKING_BUDGET,
)
from sidecar.ai.tools.models import GenerationUsage, StreamingEvent


def _build_engine() -> OllamaEngine:
    engine = object.__new__(OllamaEngine)
    engine.host = "http://localhost:11434"
    engine._request_timeout_seconds = 300
    engine.model_name = "test-model"
    engine._ready = True
    engine._vision = False
    engine._thinking = False
    engine._tool_calls_enabled = True
    engine._tool_call_http_400_streak = 0
    engine._context_length = None
    engine._configured_context_length = None
    engine._thinking_capability_source = "unsupported"
    engine._cached_tools_key = None
    engine._cached_tools_payload = None
    engine._request_context_lock = threading.Lock()
    return engine


class _FakeStreamingResponse:
    def __init__(self, chunks: list[dict[str, Any]]) -> None:
        self._lines = [json.dumps(chunk).encode("utf-8") for chunk in chunks]
        self.closed = threading.Event()

    def __enter__(self) -> "_FakeStreamingResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def __iter__(self):
        return iter(self._lines)

    def close(self) -> None:
        self.closed.set()


def _patch_stream(monkeypatch: pytest.MonkeyPatch, chunks: list[dict[str, Any]]) -> None:
    response = _FakeStreamingResponse(chunks)
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_a, **_kw: response)


def _terminal_event(events: list[Any]) -> Any:
    return next(event for event in events if getattr(event, "kind", "") == "done")


# ---------------------------------------------------------------------------
# The pure resolver
# ---------------------------------------------------------------------------


class TestResolveFinishReason:
    def test_missing_terminal_is_incomplete(self) -> None:
        assert (
            resolve_ollama_stream_finish_reason(
                saw_terminal=False, done_reason="", has_tool_calls=False
            )
            == FINISH_REASON_INCOMPLETE
        )

    def test_missing_terminal_is_incomplete_even_with_tool_calls(self) -> None:
        # Tool calls parsed out of a TRUNCATED stream are not trustworthy
        # evidence that the provider finished.
        assert (
            resolve_ollama_stream_finish_reason(
                saw_terminal=False, done_reason="", has_tool_calls=True
            )
            == FINISH_REASON_INCOMPLETE
        )

    def test_clean_terminal_with_tool_calls_is_tool_calls(self) -> None:
        assert (
            resolve_ollama_stream_finish_reason(
                saw_terminal=True, done_reason="stop", has_tool_calls=True
            )
            == "tool_calls"
        )

    def test_inband_error_wins_over_tool_calls(self) -> None:
        assert (
            resolve_ollama_stream_finish_reason(
                saw_terminal=True, done_reason="error", has_tool_calls=True
            )
            == FINISH_REASON_PROVIDER_ERROR
        )

    def test_length_surfaces_verbatim(self) -> None:
        # Contract updated 2026-08-31 (BENCH-3D silent-stop fix): "length" now
        # surfaces verbatim so the routing fence can fail-close the
        # empty-usable shape (all tokens spent on thinking/tool args, nothing
        # produced). A length-terminated turn WITH visible text or tool calls
        # still settles as success — that classification moved from this
        # resolver to the consumer (tool_loop_finalize).
        assert (
            resolve_ollama_stream_finish_reason(
                saw_terminal=True, done_reason="length", has_tool_calls=False
            )
            == "length"
        )


# ---------------------------------------------------------------------------
# stream()
# ---------------------------------------------------------------------------


class TestPlainStreamTerminalEvidence:
    def test_clean_done_chunk_still_reports_stop(self, monkeypatch) -> None:
        engine = _build_engine()
        _patch_stream(
            monkeypatch,
            [
                {"message": {"content": "hello"}, "done": False},
                {"message": {}, "done": True},
            ],
        )

        events = list(engine.stream(prompt="hi", max_tokens=8))

        assert _terminal_event(events).finish_reason == "stop"

    def test_partial_stream_then_eof_reports_incomplete(self, monkeypatch) -> None:
        engine = _build_engine()
        _patch_stream(monkeypatch, [{"message": {"content": "half an ans"}, "done": False}])

        events = list(engine.stream(prompt="hi", max_tokens=8))

        assert [event.kind for event in events] == ["content", "done"]
        assert _terminal_event(events).finish_reason == FINISH_REASON_INCOMPLETE

    def test_completely_empty_stream_reports_incomplete(self, monkeypatch) -> None:
        engine = _build_engine()
        _patch_stream(monkeypatch, [])

        events = list(engine.stream(prompt="hi", max_tokens=8))

        assert _terminal_event(events).finish_reason == FINISH_REASON_INCOMPLETE

    def test_inband_error_frame_reports_error_and_stops_reading(self, monkeypatch) -> None:
        engine = _build_engine()
        _patch_stream(
            monkeypatch,
            [
                {"message": {"content": "start"}, "done": False},
                {"error": "model runner exited unexpectedly"},
                {"message": {"content": "never read"}, "done": True},
            ],
        )

        events = list(engine.stream(prompt="hi", max_tokens=8))

        texts = [event.text for event in events if event.kind == "content"]
        assert texts == ["start"], "reading must stop at the error frame"
        assert _terminal_event(events).finish_reason == FINISH_REASON_PROVIDER_ERROR

    def test_duplicate_done_chunks_still_emit_exactly_one_terminal(
        self, monkeypatch
    ) -> None:
        engine = _build_engine()
        _patch_stream(
            monkeypatch,
            [
                {"message": {}, "done": True},
                {"message": {}, "done": True},
            ],
        )

        events = list(engine.stream(prompt="hi", max_tokens=8))

        assert sum(event.kind == "done" for event in events) == 1
        assert _terminal_event(events).finish_reason == "stop"

    def test_incomplete_stream_logs_the_actionable_event(
        self, monkeypatch, caplog
    ) -> None:
        engine = _build_engine()
        _patch_stream(monkeypatch, [{"message": {"content": "cut"}, "done": False}])

        with caplog.at_level("WARNING"):
            list(engine.stream(prompt="hi", max_tokens=8))

        incomplete = [
            record
            for record in caplog.records
            if getattr(record, "event", "") == "ai.engines.ollama.stream_incomplete"
        ]
        assert len(incomplete) == 1
        assert incomplete[0].data["code"] == CMP_STREAM_INCOMPLETE
        assert incomplete[0].data["finish_reason"] == FINISH_REASON_INCOMPLETE

    def test_clean_stream_logs_no_incomplete_event(self, monkeypatch, caplog) -> None:
        engine = _build_engine()
        _patch_stream(monkeypatch, [{"message": {"content": "ok"}, "done": True}])

        with caplog.at_level("WARNING"):
            list(engine.stream(prompt="hi", max_tokens=8))

        assert not [
            record
            for record in caplog.records
            if getattr(record, "event", "") == "ai.engines.ollama.stream_incomplete"
        ]


# ---------------------------------------------------------------------------
# stream_with_tools()
# ---------------------------------------------------------------------------


def _drain_tool_stream(generator: Any) -> tuple[list[Any], Any]:
    chunks: list[Any] = []
    while True:
        try:
            chunks.append(next(generator))
        except StopIteration as stop:
            return chunks, stop.value


class TestToolStreamTerminalEvidence:
    def test_partial_tool_stream_then_eof_reports_incomplete(self, monkeypatch) -> None:
        engine = _build_engine()
        _patch_stream(monkeypatch, [{"message": {"content": "partial"}, "done": False}])

        _chunks, result = _drain_tool_stream(
            engine.stream_with_tools(prompt="hi", tools=[], max_tokens=8)
        )

        assert result.finish_reason == FINISH_REASON_INCOMPLETE
        assert result.content == "partial", "the salvaged text still rides the result"

    def test_clean_tool_stream_reports_tool_calls(self, monkeypatch) -> None:
        engine = _build_engine()
        _patch_stream(
            monkeypatch,
            [
                {
                    "message": {
                        "tool_calls": [
                            {"function": {"name": "read_file", "arguments": {"path": "R"}}}
                        ]
                    },
                    "done": False,
                },
                {"message": {}, "done": True},
            ],
        )

        _chunks, result = _drain_tool_stream(
            engine.stream_with_tools(
                prompt="hi",
                tools=[{"name": "read_file", "parameters": {"type": "object"}}],
                max_tokens=8,
            )
        )

        assert result.finish_reason == "tool_calls"

    def test_clean_tool_free_stream_reports_stop(self, monkeypatch) -> None:
        engine = _build_engine()
        _patch_stream(
            monkeypatch,
            [
                {"message": {"content": "answer"}, "done": False},
                {"message": {}, "done": True},
            ],
        )

        _chunks, result = _drain_tool_stream(
            engine.stream_with_tools(prompt="hi", tools=[], max_tokens=8)
        )

        assert result.finish_reason == "stop"

    def test_inband_error_frame_reports_error(self, monkeypatch) -> None:
        engine = _build_engine()
        _patch_stream(
            monkeypatch,
            [
                {"message": {"content": "start"}, "done": False},
                {"error": "runner crashed"},
            ],
        )

        _chunks, result = _drain_tool_stream(
            engine.stream_with_tools(prompt="hi", tools=[], max_tokens=8)
        )

        assert result.finish_reason == FINISH_REASON_PROVIDER_ERROR


class TestFallbackStreamTerminals:
    tools = [{"name": "read_file", "parameters": {"type": "object"}}]
    call_text = '<tool_call>{"name":"read_file","arguments":{"path":"R"}}</tool_call>'

    @pytest.mark.parametrize("content", ["half an ans", call_text])
    def test_partial_stream_then_eof_reports_incomplete(self, monkeypatch, content) -> None:
        engine = _build_engine()
        engine._tool_calls_enabled = False
        _patch_stream(monkeypatch, [{"message": {"content": content}, "done": False}])

        chunks, result = _drain_tool_stream(
            engine.stream_with_tools(prompt="hi", tools=self.tools, max_tokens=8)
        )

        assert result.finish_reason == FINISH_REASON_INCOMPLETE
        assert result.tool_calls == ()
        assert result.inband_tool_call_parse_failed is False
        assert result.content == content
        assert result.usage is None
        assert result.degraded_tool_transport is False
        assert chunks == [content]

    def test_thinking_budget_terminal_is_kept_without_tool_parsing(self, monkeypatch) -> None:
        from types import SimpleNamespace

        from sidecar.ai.engines import ollama_generation

        engine = _build_engine()
        engine._tool_calls_enabled = False

        def fake_stream(*_args, **_kwargs):
            yield SimpleNamespace(kind="content", text=self.call_text)
            yield SimpleNamespace(
                kind="done", finish_reason=FINISH_REASON_THINKING_BUDGET, usage={"total": 3}
            )

        monkeypatch.setattr(ollama_generation, "_ollama_stream", fake_stream)

        chunks, result = _drain_tool_stream(
            engine.stream_with_tools(prompt="hi", tools=self.tools, max_tokens=8)
        )

        assert result.finish_reason == FINISH_REASON_THINKING_BUDGET
        assert result.tool_calls == ()
        assert result.inband_tool_call_parse_failed is False
        assert result.content == self.call_text
        assert result.usage == {"total": 3}
        assert chunks == [self.call_text]

    @pytest.mark.parametrize("content", ["start", call_text, '<tool_call>{"name":'])
    def test_inband_error_frame_reports_error(self, monkeypatch, content) -> None:
        engine = _build_engine()
        engine._tool_calls_enabled = False
        _patch_stream(
            monkeypatch,
            [
                {"message": {"content": content}, "done": False},
                {"error": "runner crashed"},
                {"message": {"content": "never read"}, "done": True},
            ],
        )

        chunks, result = _drain_tool_stream(
            engine.stream_with_tools(prompt="hi", tools=self.tools, max_tokens=8)
        )

        assert result.finish_reason == FINISH_REASON_PROVIDER_ERROR
        assert result.tool_calls == ()
        assert result.inband_tool_call_parse_failed is False
        assert result.content == content
        assert result.usage is None
        assert chunks == [content]

    @pytest.mark.parametrize("done_reason", ["stop", "length"])
    @pytest.mark.parametrize("has_call", [False, True])
    def test_clean_terminal_preserves_parsing_and_usage(
        self, monkeypatch, done_reason, has_call
    ) -> None:
        engine = _build_engine()
        engine._tool_calls_enabled = False
        content = "answer " + self.call_text if has_call else "answer"
        _patch_stream(
            monkeypatch,
            [
                {"message": {"content": content}, "done": False},
                {
                    "message": {},
                    "done": True,
                    "done_reason": done_reason,
                    "prompt_eval_count": 3,
                    "eval_count": 2,
                },
            ],
        )

        chunks, result = _drain_tool_stream(
            engine.stream_with_tools(prompt="hi", tools=self.tools, max_tokens=8)
        )

        assert result.finish_reason == ("tool_calls" if has_call else done_reason)
        assert len(result.tool_calls) == int(has_call)
        if has_call:
            assert result.tool_calls[0].tool_id == "read_file"
            assert result.tool_calls[0].arguments == {"path": "R"}
        assert result.content == "answer"
        assert result.inband_tool_call_parse_failed is False
        assert result.usage is not None
        assert result.usage.input_tokens == 3
        assert result.usage.output_tokens == 2
        assert result.usage.total_tokens == 5
        assert chunks == ["answer"]

    def test_http_400_fallback_then_eof_reports_degraded_incomplete(
        self, monkeypatch
    ) -> None:
        engine = _build_engine()
        requests = []
        response = _FakeStreamingResponse(
            [{"message": {"content": self.call_text}, "done": False}]
        )

        def urlopen(request, **_kwargs):
            requests.append(json.loads(request.data))
            if len(requests) == 1:
                raise EngineConnectionError("tool payload rejected") from urllib.error.HTTPError(
                    request.full_url, 400, "Bad Request", {}, None
                )
            return response

        monkeypatch.setattr(urllib.request, "urlopen", urlopen)
        chunks, result = _drain_tool_stream(
            engine.stream_with_tools(prompt="hi", tools=self.tools, max_tokens=8)
        )

        assert result.finish_reason == FINISH_REASON_INCOMPLETE
        assert result.degraded_tool_transport is True
        assert result.tool_calls == ()
        assert result.inband_tool_call_parse_failed is False
        assert result.content == self.call_text
        assert result.usage is None
        assert chunks == [self.call_text]
        assert len(requests) == 2
        assert requests[0]["tools"]
        assert "tools" not in requests[1]
        assert engine._tool_calls_enabled is True
        assert engine._tool_call_http_400_streak == 1

    @pytest.mark.parametrize(
        "finish_reason",
        [None, FINISH_REASON_INCOMPLETE, FINISH_REASON_PROVIDER_ERROR, "stop", "length", ""],
    )
    def test_missing_or_last_done_event_controls_result(self, monkeypatch, finish_reason) -> None:
        engine = _build_engine()
        engine._tool_calls_enabled = False
        usage = GenerationUsage(input_tokens=3, output_tokens=2, total_tokens=5)
        events = [StreamingEvent(kind="content", text="  answer  ")]
        if finish_reason is not None:
            events.extend(
                [
                    StreamingEvent(kind="done", finish_reason="stop"),
                    StreamingEvent(kind="done", finish_reason=finish_reason, usage=usage),
                ]
            )
        monkeypatch.setattr(
            "sidecar.ai.engines.ollama_generation._ollama_stream",
            lambda *_args, **_kwargs: iter(events),
        )

        chunks, result = _drain_tool_stream(
            engine.stream_with_tools(prompt="hi", tools=self.tools, max_tokens=8)
        )

        expected = FINISH_REASON_INCOMPLETE if finish_reason is None else finish_reason or "stop"
        assert result.finish_reason == expected
        assert result.usage is (None if finish_reason is None else usage)
        assert result.content == "answer"
        assert result.tool_calls == ()
        assert result.inband_tool_call_parse_failed is False
        assert chunks == ["answer"]
