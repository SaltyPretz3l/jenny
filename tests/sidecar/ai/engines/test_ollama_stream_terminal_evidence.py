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
import urllib.request
from typing import Any

import pytest

from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.ollama_telemetry import resolve_ollama_stream_finish_reason
from sidecar.ai.error_codes import CMP_STREAM_INCOMPLETE
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
)


def _build_engine() -> OllamaEngine:
    engine = object.__new__(OllamaEngine)
    engine.host = "http://localhost:11434"
    engine._request_timeout_seconds = 300  # noqa: SLF001
    engine.model_name = "test-model"
    engine._ready = True  # noqa: SLF001
    engine._vision = False  # noqa: SLF001
    engine._thinking = False  # noqa: SLF001
    engine._tool_calls_enabled = True  # noqa: SLF001
    engine._tool_call_http_400_streak = 0  # noqa: SLF001
    engine._context_length = None  # noqa: SLF001
    engine._configured_context_length = None  # noqa: SLF001
    engine._thinking_capability_source = "unsupported"  # noqa: SLF001
    engine._cached_tools_key = None  # noqa: SLF001
    engine._cached_tools_payload = None  # noqa: SLF001
    engine._request_context_lock = threading.Lock()  # noqa: SLF001
    return engine


class _FakeStreamingResponse:
    def __init__(self, chunks: list[dict[str, Any]]) -> None:
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
        # resolver to the consumers (tool_loop_finalize / chat_streaming).
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
        assert incomplete[0].code == CMP_STREAM_INCOMPLETE
        assert incomplete[0].finish_reason == FINISH_REASON_INCOMPLETE

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
