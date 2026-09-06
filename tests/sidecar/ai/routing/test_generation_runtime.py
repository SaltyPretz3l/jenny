from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai import engine_liveness
from sidecar.ai.config import FallbackModelConfig, RuntimeConfig
from sidecar.ai.context.request_fingerprint import PROMPT_VERSION
from sidecar.ai.engines.engine_events import EngineEvent
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.error_codes import CMP_LOOP_ENGINE_STALLED, CMP_LOOP_INVALID_TOOL_CALL
from sidecar.ai.exceptions import EngineConnectionError
from sidecar.ai.routing import generation_runtime, generation_runtime_stream
from sidecar.ai.routing.engine_messages import engine_messages
from sidecar.ai.routing.generation_diagnostics import record_request_fingerprint_if_available
from sidecar.ai.routing.generation_runtime import (
    _to_generation_result,
    attempt_fallback_generation,
    generate_step,
    stream_generate_with_tools,
)
from sidecar.ai.routing.loop_events import (
    FallbackTriggeredEvent,
    StopEvent,
    ThinkingEvent,
    TokenDeltaEvent,
    ToolCallCompletedEvent,
    ToolCallDeltaEvent,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.vision_turn import VisionAnchorError
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import (
    GenerationResult,
    GenerationUsage,
    StreamingEvent,
    ThinkingDelta,
    ToolCallRequest,
)
from sidecar.protocol import CHAT_THINKING_KIND_REASONING, CHAT_THINKING_KIND_STATUS
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.local_engine.request_context import (
    clear_request_context,
    current_request_context,
    install_request_context,
)
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_TIMEOUT_TURN,
    TURN_STATE_CANCELLED,
    TURN_STATE_TIMEOUT,
)


def _reset_engine_liveness_state() -> None:
    with engine_liveness._state.lock:  # noqa: SLF001
        engine_liveness._state.last_activity_monotonic = None  # noqa: SLF001
        engine_liveness._state.active_generations = 0  # noqa: SLF001


@pytest.fixture(autouse=True)
def _drain_stray_stream_readers() -> Iterator[None]:
    # Stream-reader accounting (_live_stream_reader_count, quarantine names,
    # engine-liveness generations) is process-global and only settles once
    # every router-stream-reader thread has exited. Earlier test files may
    # legitimately leave a time-bounded quarantined reader behind (e.g. a
    # stall-abort test whose provider block is still draining), so wait for
    # strays to finish before tests here assert on thread and slot counts.
    _reset_engine_liveness_state()
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline and any(
        thread.name == "router-stream-reader" and thread.is_alive()
        for thread in threading.enumerate()
    ):
        time.sleep(0.01)
    stray = [
        thread
        for thread in threading.enumerate()
        if thread.name == "router-stream-reader" and thread.is_alive()
    ]
    if stray:
        raise RuntimeError(
            "stream-reader threads leaked by an earlier test are still alive "
            f"after the drain grace: {stray!r}"
        )
    try:
        yield
    finally:
        _reset_engine_liveness_state()


class _DiagnosticsStore:
    def __init__(self) -> None:
        self.buffered: list[dict[str, Any]] = []

    def record_buffered_visible_output(
        self,
        *,
        request_id: str,
        text: str,
        reason: str,
    ) -> None:
        self.buffered.append(
            {
                "request_id": request_id,
                "text": text,
                "reason": reason,
            }
        )


class _StreamingToolEngine:
    def __init__(self, diagnostics: _DiagnosticsStore) -> None:
        self._turn_diagnostics_store = diagnostics

    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="content", text="Buffered visible text.")
        return GenerationResult(
            content="",
            finish_reason="tool_calls",
            tool_calls=(
                ToolCallRequest(
                    tool_id="read_file",
                    arguments={"path": "README.md"},
                    call_id="call_readme",
                ),
            ),
        )


class _ChunkOnlyFailedInbandEngine:
    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(
            kind="content",
            text="<tool_call>\n{not valid json}\n</tool_call>",
        )
        return GenerationResult(
            content="",
            finish_reason="stop",
            inband_tool_call_parse_failed=True,
        )


class _TerminalOnlyToolEngine:
    """Yields no chunks; content + tool calls arrive only in the terminal result."""

    def __init__(self, diagnostics: _DiagnosticsStore) -> None:
        self._turn_diagnostics_store = diagnostics

    def stream_with_tools(self, **_kwargs: Any):
        return GenerationResult(
            content="Let me read the file first.",
            finish_reason="tool_calls",
            tool_calls=(
                ToolCallRequest(
                    tool_id="read_file",
                    arguments={"path": "README.md"},
                    call_id="call_terminal_only",
                ),
            ),
        )
        yield  # pragma: no cover — generator shape without any chunks


class _StreamingMidstreamToolEngine:
    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="content", text="Looking at it...")
        yield ToolCallRequest(
            tool_id="read_file",
            arguments={"path": "app.py"},
            call_id="call_inspect",
        )
        yield StreamingEvent(kind="content", text="Done.")
        return GenerationResult(
            content="",
            finish_reason="tool_calls",
            tool_calls=(
                ToolCallRequest(
                    tool_id="read_file",
                    arguments={"path": "app.py"},
                    call_id="call_inspect",
                ),
            ),
        )


class _FailingStreamEngine:
    def __init__(self, diagnostics: _DiagnosticsStore) -> None:
        self._turn_diagnostics_store = diagnostics

    def get_model_max_output_tokens(self) -> int:
        return 512

    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="content", text="Buffered visible text.")
        error = EngineConnectionError(
            "Connection to Ollama was interrupted during streaming: WinError 10054",
            retryable=True,
        )
        raise error


class _FailingAfterMidstreamFlushEngine:
    def __init__(self, diagnostics: _DiagnosticsStore) -> None:
        self._turn_diagnostics_store = diagnostics

    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="content", text="Visible before tool.")
        yield ToolCallRequest(
            tool_id="read_file",
            arguments={"path": "app.py"},
            call_id="call_before_failure",
        )
        yield StreamingEvent(kind="content", text="Hidden after tool.")
        raise EngineConnectionError(
            "Connection to Ollama was interrupted during streaming: WinError 10054",
            retryable=True,
        )


class _ClosableBlockingStream:
    def __init__(self) -> None:
        self.entered = threading.Event()
        self.closed = threading.Event()

    def __iter__(self) -> "_ClosableBlockingStream":
        return self

    def __next__(self) -> object:
        self.entered.set()
        while not self.closed.is_set():
            time.sleep(0.005)
        raise StopIteration

    def close(self) -> None:
        self.closed.set()


class _BlockingStreamEngine:
    def __init__(self) -> None:
        self.stream = _ClosableBlockingStream()

    def stream_with_tools(self, **_kwargs: Any):
        return self.stream


class _FingerprintStore:
    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []

    def record_request_fingerprint(self, *, request_id: str, fingerprint: dict[str, Any]) -> None:
        self.records.append({"request_id": request_id, "fingerprint": fingerprint})


def test_stream_generate_with_tools_emits_streamed_text_before_terminal_tool_calls() -> None:
    diagnostics = _DiagnosticsStore()
    kernel = SimpleNamespace(
        _engine=_StreamingToolEngine(diagnostics),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda value: str(value),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_buffered",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted_event_types = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Inspect the repo.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[{"type": "function", "function": {"name": "read_file"}}],
    )

    assert result.tool_calls[0].tool_id == "read_file"
    assert "chat.token" in emitted_event_types
    assert "tool.executing" not in emitted_event_types
    assert runtime.pre_dispatch_emitted_call_ids == set()
    assert diagnostics.buffered == []
    assert any(isinstance(e, TokenDeltaEvent) and e.delta == "Buffered visible text." for e in events)


def test_stream_rebuild_preserves_failed_inband_parse_signal() -> None:
    kernel = SimpleNamespace(
        _engine=_ChunkOnlyFailedInbandEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda value: str(value),
    )
    runtime = LoopRuntime(
        emit=lambda _event: None,
        request_id="req_inband_signal",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, _event_types = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Use the tool.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[{"type": "function", "function": {"name": "read_file"}}],
    )

    assert result.content == "<tool_call>\n{not valid json}\n</tool_call>"
    assert result.inband_tool_call_parse_failed is True


def test_stream_generate_with_tools_emits_terminal_only_preamble_before_tool_calls() -> None:
    diagnostics = _DiagnosticsStore()
    kernel = SimpleNamespace(
        _engine=_TerminalOnlyToolEngine(diagnostics),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda value: str(value),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_terminal_preamble",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted_event_types = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Inspect the repo.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[{"type": "function", "function": {"name": "read_file"}}],
    )

    assert result.content == "Let me read the file first."
    assert result.tool_calls[0].tool_id == "read_file"
    assert "chat.token" in emitted_event_types
    assert [
        event.delta
        for event in events
        if isinstance(event, TokenDeltaEvent)
    ] == ["Let me read the file first."]
    assert runtime.last_iteration_unflushed == []
    assert diagnostics.buffered == []


def test_stream_generate_with_tools_flushes_midstream_text_before_terminal_tool_calls() -> None:
    kernel = SimpleNamespace(
        _engine=_StreamingMidstreamToolEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda value: str(value),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_midstream",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted_event_types = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Inspect the repo.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[{"type": "function", "function": {"name": "read_file"}}],
    )

    assert result.content == "Looking at it...Done."
    assert emitted_event_types == {"chat.token"}
    event_summary = [
        (type(event).__name__, getattr(event, "delta", None))
        for event in events
        if isinstance(event, TokenDeltaEvent)
    ]
    assert event_summary == [
        ("TokenDeltaEvent", "Looking at it..."),
        ("TokenDeltaEvent", "Done."),
    ]


def test_generate_step_preserves_retryable_stream_failure_and_dropped_buffer() -> None:
    diagnostics = _DiagnosticsStore()
    engine = _FailingStreamEngine(diagnostics)
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            max_tokens=128,
            feature_flags={},
            engine_type="ollama",
            model="test-model",
            fallback_models=[],
        ),
        _engine_messages=lambda messages, primary_system_text: messages,
        _system_prompt_for_engine=lambda value: str(value),
    )
    runtime = LoopRuntime(
        emit=lambda _event: None,
        request_id="req_reset",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    with pytest.raises(ToolExecutionFailure) as exc_info:
        generate_step(
            kernel,
            latest_user_content="hello",
            working_messages=[{"role": "user", "content": "hello"}],
            reasoning_effort=None,
            prompt_cache_enabled=False,
            source_key="main",
            system_prompt="You are Jenny.",
            tool_schemas=[],
            cache_break_detector=None,
            runtime=runtime,
        )

    assert exc_info.value.retryable is True
    assert exc_info.value.category == "provider"
    assert exc_info.value.error_type == "EngineConnectionError"
    assert diagnostics.buffered == []


def test_stream_failure_records_only_unflushed_tail_after_midstream_flush() -> None:
    diagnostics = _DiagnosticsStore()
    kernel = SimpleNamespace(
        _engine=_FailingAfterMidstreamFlushEngine(diagnostics),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda value: str(value),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_tail_failure",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    with pytest.raises(EngineConnectionError):
        stream_generate_with_tools(
            kernel,
            runtime=runtime,
            latest_user_content="Inspect the repo.",
            prompt_messages=[],
            max_tokens=128,
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system_prompt="You are Jenny.",
            tool_schemas=[{"type": "function", "function": {"name": "read_file"}}],
        )

    assert [
        event.delta
        for event in events
        if isinstance(event, TokenDeltaEvent)
    ] == ["Visible before tool.", "Hidden after tool."]
    assert runtime.last_iteration_unflushed == []
    assert diagnostics.buffered == []


def test_stream_generate_with_tools_closes_provider_stream_on_model_load_timeout() -> None:
    # The first chunk never arrives (the model "load" blocks forever), so the
    # model-load grace governs this wait — not the inter-token inactivity window.
    engine = _BlockingStreamEngine()
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda value: str(value),
    )
    runtime = LoopRuntime(
        emit=lambda _event: None,
        request_id="req_stream_timeout",
        streaming=True,
        chunk_inactivity_seconds=0.05,
        model_load_grace_seconds=0.05,
    )

    result, _emitted_event_types = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Block forever.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[],
    )

    assert result.finish_reason == "timeout"
    # No chunk ever arrived → the watchdog fired in the load phase.
    assert runtime.stall_phase == "model_load"
    assert engine.stream.entered.wait(0.5)
    assert engine.stream.closed.is_set()


class _SlowLoadStreamEngine:
    """Sleeps (model loading, no output) past the inactivity window, then streams.

    Models the real local-engine first-chunk wait: the provider blocks while the
    model loads into VRAM and emits nothing, then begins streaming tokens.
    """

    def __init__(self, load_delay: float) -> None:
        self._load_delay = load_delay

    def stream_with_tools(self, **_kwargs: Any):
        time.sleep(self._load_delay)
        yield StreamingEvent(kind="content", text="Loaded and answering.")
        return GenerationResult(content="Loaded and answering.", finish_reason="stop")


class _FirstChunkThenBlockStream:
    """Yields one chunk (model is alive), then stalls between tokens until closed."""

    def __init__(self, first_chunk: object) -> None:
        self._first_chunk = first_chunk
        self._yielded = False
        self.entered = threading.Event()
        self.closed = threading.Event()

    def __iter__(self) -> "_FirstChunkThenBlockStream":
        return self

    def __next__(self) -> object:
        if not self._yielded:
            self._yielded = True
            return self._first_chunk
        self.entered.set()
        while not self.closed.is_set():
            time.sleep(0.005)
        raise StopIteration

    def close(self) -> None:
        self.closed.set()


class _FirstChunkThenBlockEngine:
    def __init__(self, first_chunk: object) -> None:
        self.stream = _FirstChunkThenBlockStream(first_chunk)

    def stream_with_tools(self, **_kwargs: Any):
        return self.stream


def test_stream_generate_with_tools_does_not_abort_during_slow_model_load() -> None:
    # The model "load" emits no output for longer than the inter-token inactivity
    # window (0.1s) but well under the model-load grace (5.0s). The turn must NOT
    # be aborted: the first-chunk (load) wait is exempt from the no-output
    # watchdog. This is the reported "reopened the app / came back after idle"
    # path where a (re)load legitimately outlasts the 120s default.
    engine = _SlowLoadStreamEngine(load_delay=0.3)
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(temperature=0.0, reasoning_effort=None, feature_flags={}),
        _system_prompt_for_engine=lambda value: str(value),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_slow_load",
        streaming=True,
        chunk_inactivity_seconds=0.1,
        model_load_grace_seconds=5.0,
    )

    result, _emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Hello.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[],
    )

    assert result.finish_reason == "stop"
    assert runtime.stall_phase is None
    assert not [event for event in events if isinstance(event, StopEvent)]
    assert [
        event.delta for event in events if isinstance(event, TokenDeltaEvent)
    ] == ["Loaded and answering."]


def test_stream_generate_with_tools_aborts_on_stall_after_first_token() -> None:
    # The first chunk arrives immediately (model already loaded), then the stream
    # stalls between tokens past the inactivity window (0.1s). The watchdog MUST
    # still fire — in the inactivity phase — even with a generous model-load
    # grace (5.0s): the load exemption must not mask a genuine post-token stall.
    engine = _FirstChunkThenBlockEngine(StreamingEvent(kind="content", text="Hi"))
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(temperature=0.0, reasoning_effort=None, feature_flags={}),
        _system_prompt_for_engine=lambda value: str(value),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_post_token_stall",
        streaming=True,
        chunk_inactivity_seconds=0.1,
        model_load_grace_seconds=5.0,
    )

    result, _emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Hello.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[],
    )

    assert result.finish_reason == "timeout"
    assert runtime.stall_phase == "inactivity"
    # The first token surfaced before the stall.
    assert [
        event.delta for event in events if isinstance(event, TokenDeltaEvent)
    ][0] == "Hi"
    stop_events = [event for event in events if isinstance(event, StopEvent)]
    assert stop_events and stop_events[-1].code == CMP_LOOP_ENGINE_STALLED
    assert engine.stream.closed.is_set()


class _SilentComposeEngine:
    """First chunk immediately, then a silent gap longer than the inactivity
    window, then the final chunk.

    Models Ollama composing a buffered tool call (2026-07-11 CMP-LOOP-0015
    RCA): the provider decodes healthily for minutes but streams nothing until
    the call is fully parsed.
    """

    def __init__(self, gap_seconds: float) -> None:
        self._gap = gap_seconds

    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="content", text="Hi")
        time.sleep(self._gap)
        yield StreamingEvent(kind="content", text="Done")
        return GenerationResult(content="HiDone", finish_reason="stop")


def _liveness_kernel(engine: Any) -> SimpleNamespace:
    return SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(temperature=0.0, reasoning_effort=None, feature_flags={}),
        _system_prompt_for_engine=lambda value: str(value),
    )


def test_stream_generate_with_tools_defers_stall_while_engine_reports_activity() -> None:
    # The stream goes silent past the inactivity window (0.1s) mid-turn, but
    # the shell has stamped the engine-liveness clock (managed engine decode
    # telemetry): the watchdog must DEFER the stall verdict and let the
    # generation finish instead of killing a healthy engine.
    engine = _SilentComposeEngine(gap_seconds=0.4)
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_liveness_defer",
        streaming=True,
        chunk_inactivity_seconds=0.1,
        model_load_grace_seconds=5.0,
    )
    engine_liveness.record_engine_activity()
    result, _emitted = stream_generate_with_tools(
        _liveness_kernel(engine),
        runtime=runtime,
        latest_user_content="Compose a huge tool call.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[],
    )

    assert result.finish_reason == "stop"
    assert runtime.stall_phase is None
    assert not [event for event in events if isinstance(event, StopEvent)]
    assert [
        event.delta for event in events if isinstance(event, TokenDeltaEvent)
    ] == ["Hi", "Done"]


def test_stream_generate_with_tools_never_defers_while_a_sibling_generation_is_in_flight() -> None:
    # The activity clock is process-wide: with a CONCURRENT generation running
    # (foreground turn + background.run worker), a healthy sibling's telemetry
    # must not mask THIS request being wedged. Attribution is ambiguous, so
    # the watchdog must fall back to the plain fixed window and stall.
    engine = _FirstChunkThenBlockEngine(StreamingEvent(kind="content", text="Hi"))
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_liveness_sibling",
        streaming=True,
        chunk_inactivity_seconds=0.1,
        model_load_grace_seconds=5.0,
    )
    engine_liveness.record_engine_activity()
    engine_liveness.begin_generation()  # the healthy sibling
    result, _emitted = stream_generate_with_tools(
        _liveness_kernel(engine),
        runtime=runtime,
        latest_user_content="Hello.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[],
    )

    assert result.finish_reason == "timeout"
    assert runtime.stall_phase == "inactivity"
    assert engine.stream.closed.is_set()


def test_stream_generate_with_tools_stalls_when_engine_activity_is_stale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A stamp OLDER than the freshness window is not liveness: the watchdog
    # must fire exactly as if the clock were never stamped.
    monkeypatch.setattr(generation_runtime_stream, "_ENGINE_ACTIVITY_FRESH_SECONDS", 0.01)
    engine = _FirstChunkThenBlockEngine(StreamingEvent(kind="content", text="Hi"))
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_liveness_stale",
        streaming=True,
        chunk_inactivity_seconds=0.1,
        model_load_grace_seconds=5.0,
    )
    engine_liveness.record_engine_activity()
    result, _emitted = stream_generate_with_tools(
        _liveness_kernel(engine),
        runtime=runtime,
        latest_user_content="Hello.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[],
    )

    assert result.finish_reason == "timeout"
    assert runtime.stall_phase == "inactivity"
    assert engine.stream.closed.is_set()


def test_stream_generate_with_tools_liveness_deferral_respects_silence_ceiling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Fresh engine activity defers the verdict, but never past the absolute
    # silence ceiling — a runaway decode that never yields a chunk must still
    # be bounded. The stall reason records the deferrals for diagnosability.
    monkeypatch.setattr(generation_runtime_stream, "_ENGINE_LIVENESS_RECHECK_SECONDS", 0.05)
    monkeypatch.setattr(generation_runtime_stream, "_ENGINE_SILENCE_CEILING_SECONDS", 0.25)
    engine = _FirstChunkThenBlockEngine(StreamingEvent(kind="content", text="Hi"))
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_liveness_ceiling",
        streaming=True,
        chunk_inactivity_seconds=0.1,
        model_load_grace_seconds=5.0,
    )
    engine_liveness.record_engine_activity()
    result, _emitted = stream_generate_with_tools(
        _liveness_kernel(engine),
        runtime=runtime,
        latest_user_content="Hello.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="You are Jenny.",
        tool_schemas=[],
    )

    assert result.finish_reason == "timeout"
    assert runtime.stall_phase == "inactivity"
    stop_events = [event for event in events if isinstance(event, StopEvent)]
    assert stop_events and stop_events[-1].code == CMP_LOOP_ENGINE_STALLED
    assert "engine-liveness deferrals" in stop_events[-1].reason
    assert engine.stream.closed.is_set()


def test_generation_diagnostics_records_request_fingerprint_without_runtime_dependency() -> None:
    store = _FingerprintStore()
    kernel = SimpleNamespace(_engine=SimpleNamespace(_turn_diagnostics_store=store))

    record_request_fingerprint_if_available(
        kernel,
        request_id="req_fingerprint",
        system_prompt="You are Jenny.",
        tool_schemas=[{"type": "function", "function": {"name": "read_file"}}],
    )

    assert store.records
    assert store.records[0]["request_id"] == "req_fingerprint"
    assert store.records[0]["fingerprint"]["prefix_hash"]
    assert store.records[0]["fingerprint"]["tool_schema_hash"]
    assert store.records[0]["fingerprint"]["prompt_version"] == PROMPT_VERSION


# ---------------------------------------------------------------------------
# EngineEvent stream paths (lines 604-699)
# ---------------------------------------------------------------------------


class _ReasoningEngineEventEngine:
    """Yields an ENGINE_EVENT_REASONING_DELTA followed by done + terminal."""

    def stream_with_tools(self, **_kwargs: Any):
        yield EngineEvent(kind="reasoning_delta", text="Let me think...", is_complete=True)
        yield EngineEvent(kind="text_delta", text="Answer here.")
        yield EngineEvent(kind="done")
        return GenerationResult(content="Answer here.", finish_reason="stop")


def test_engine_event_reasoning_delta_emits_thinking_event() -> None:
    engine = _ReasoningEngineEventEngine()
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_reasoning_delta",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Think first.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    assert result.finish_reason == "stop"
    assert "chat.thinking" in emitted
    thinking_events = [e for e in events if isinstance(e, ThinkingEvent)]
    assert len(thinking_events) == 1
    assert thinking_events[0].delta == "Let me think..."
    assert thinking_events[0].persist is True


class _ToolBoundaryEngineEventEngine:
    """Yields text, then a tool_call_boundary (to flush), then done."""

    def stream_with_tools(self, **_kwargs: Any):
        yield EngineEvent(kind="text_delta", text="Pre-tool text.")
        yield EngineEvent(kind="tool_call_boundary")
        yield EngineEvent(kind="done")
        return GenerationResult(content="Pre-tool text.", finish_reason="stop")


def test_engine_event_tool_call_boundary_flushes_content() -> None:
    kernel = SimpleNamespace(
        _engine=_ToolBoundaryEngineEventEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_tool_boundary",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Do something.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    assert result.content == "Pre-tool text."
    token_deltas = [e.delta for e in events if isinstance(e, TokenDeltaEvent)]
    # Text must have been flushed before the boundary event processed
    assert "Pre-tool text." in token_deltas
    assert "chat.token" in emitted


class _ToolCallDeltaCompletedEngineEventEngine:
    """Yields ENGINE_EVENT_TOOL_CALL_DELTA and ENGINE_EVENT_TOOL_CALL_COMPLETED."""

    def stream_with_tools(self, **_kwargs: Any):
        yield EngineEvent(
            kind="tool_call_delta",
            tool_call_id="call_tc_01",
            tool_name="read_file",
            arguments_delta='{"path"',
            sequence=7,
        )
        yield EngineEvent(
            kind="tool_call_completed",
            tool_call_id="call_tc_01",
            tool_name="read_file",
            arguments={"path": "README.md"},
            sequence=9,
        )
        yield EngineEvent(kind="done")
        return GenerationResult(
            content="",
            finish_reason="tool_calls",
            tool_calls=(
                ToolCallRequest(
                    tool_id="read_file",
                    arguments={"path": "README.md"},
                    call_id="call_tc_01",
                ),
            ),
        )


def test_engine_event_tool_call_delta_and_completed_emitted() -> None:
    kernel = SimpleNamespace(
        _engine=_ToolCallDeltaCompletedEngineEventEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_tc_delta",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, _emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Read a file.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    assert result.tool_calls[0].call_id == "call_tc_01"
    delta_events = [e for e in events if isinstance(e, ToolCallDeltaEvent)]
    assert len(delta_events) == 1
    assert delta_events[0].call_id == "call_tc_01"
    assert delta_events[0].tool_name == "read_file"
    assert delta_events[0].arguments_delta == '{"path"'
    assert delta_events[0].sequence == 7

    completed_events = [e for e in events if isinstance(e, ToolCallCompletedEvent)]
    assert len(completed_events) == 1
    assert completed_events[0].call_id == "call_tc_01"
    assert completed_events[0].tool_name == "read_file"
    assert completed_events[0].arguments == {"path": "README.md"}
    assert completed_events[0].sequence == 9


class _EngineEventFailedEngine:
    """Yields ENGINE_EVENT_FAILED then a clean terminal."""

    def stream_with_tools(self, **_kwargs: Any):
        yield EngineEvent(kind="failed", text="upstream failed")
        yield EngineEvent(kind="done")
        return GenerationResult(content="", finish_reason="stop")


def test_engine_event_failed_emits_stop_event() -> None:
    kernel = SimpleNamespace(
        _engine=_EngineEventFailedEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_event_failed",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, _emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Try something.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    stop_events = [e for e in events if isinstance(e, StopEvent)]
    assert len(stop_events) == 1
    assert stop_events[0].reason == "upstream failed"
    assert stop_events[0].code == generation_runtime.CMP_LOOP_GENERATION_FAILED


# ---------------------------------------------------------------------------
# ThinkingDelta chunk path (line 701) and StreamingEvent thinking (line 712)
# ---------------------------------------------------------------------------


class _ThinkingDeltaChunkEngine:
    """Yields ThinkingDelta objects (not EngineEvents)."""

    def stream_with_tools(self, **_kwargs: Any):
        yield ThinkingDelta(text="Intermediate reasoning.", is_complete=False)
        yield ThinkingDelta(text=" Final reasoning.", is_complete=True)
        return GenerationResult(
            content="Done.",
            finish_reason="stop",
        )


def test_thinking_delta_chunks_emit_thinking_events() -> None:
    kernel = SimpleNamespace(
        _engine=_ThinkingDeltaChunkEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_thinking_delta",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Think.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    assert result.content == "Done."
    assert "chat.thinking" in emitted
    thinking_events = [e for e in events if isinstance(e, ThinkingEvent)]
    assert len(thinking_events) == 2
    assert thinking_events[0].delta == "Intermediate reasoning."
    assert thinking_events[0].persist is False
    assert thinking_events[1].delta == " Final reasoning."
    assert thinking_events[1].persist is True


class _StreamingEventThinkingEngine:
    """Yields a StreamingEvent(kind='thinking') chunk."""

    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="thinking", text="I am thinking.")
        return GenerationResult(
            content="Result.",
            finish_reason="stop",
        )


def test_streaming_event_thinking_kind_emits_thinking_event() -> None:
    kernel = SimpleNamespace(
        _engine=_StreamingEventThinkingEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_se_thinking",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="Think.",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    assert result.content == "Result."
    assert "chat.thinking" in emitted
    thinking_events = [e for e in events if isinstance(e, ThinkingEvent)]
    assert len(thinking_events) == 1
    assert thinking_events[0].delta == "I am thinking."
    # StreamingEvent thinking path always uses persist=True
    assert thinking_events[0].persist is True


# ---------------------------------------------------------------------------
# attempt_fallback_generation paths (lines 885-901, 947-981)
# ---------------------------------------------------------------------------


@dataclass
class _FallbackModelConfig:
    engine_type: str
    model: str
    max_context_tokens: int | None = None
    reasoning_effort: str | None = None


def _make_fallback_kernel(
    *,
    fallback_models: list[_FallbackModelConfig],
    fallback_engine: Any = None,
) -> SimpleNamespace:
    """Build a minimal kernel namespace suitable for attempt_fallback_generation."""
    return SimpleNamespace(
        _engine=SimpleNamespace(_turn_diagnostics_store=None),
        _config=SimpleNamespace(
            engine_type="ollama",
            model="primary-model",
            temperature=0.0,
            reasoning_effort=None,
            max_tokens=128,
            feature_flags={},
            fallback_models=fallback_models,
        ),
        _engine_messages=lambda msgs, primary_system_text: msgs,
        _system_prompt_for_engine=lambda v: str(v),
        _cache_usage_tokens=lambda raw, *keys: raw.get(keys[0], raw.get(keys[1], 0)),
    )


def test_attempt_fallback_skips_removed_cloud_engine_via_local_first_allowlist(
    monkeypatch, caplog
) -> None:
    kernel = _make_fallback_kernel(
        fallback_models=[
            _FallbackModelConfig(engine_type="anthropic", model="claude-example"),
        ]
    )
    events: list[object] = []
    runtime = LoopRuntime(emit=events.append, request_id="req_archived")

    with caplog.at_level(logging.WARNING, logger="sidecar.ai.routing.generation_runtime"):
        result = attempt_fallback_generation(
            kernel,
            original_error=RuntimeError("primary failed"),
            latest_user_content="hello",
            working_messages=[],
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system_prompt="sys",
            tool_schemas=[],
            runtime=runtime,
        )

    assert result is None
    assert events == []  # no FallbackTriggeredEvent for a skipped engine
    skip_events = [
        getattr(record, "event", None) for record in caplog.records
    ]
    assert "ai.router.fallback_non_local_skipped" in skip_events


def test_attempt_fallback_skips_non_local_engine(monkeypatch, caplog) -> None:
    """Non-local engines are skipped before engine creation is attempted."""
    create_calls: list[Any] = []

    def _boom(cfg: Any) -> Any:
        create_calls.append(cfg)
        raise AssertionError("_create_engine must not be called for a non-local engine")

    monkeypatch.setattr(generation_runtime, "_create_engine", _boom)

    kernel = _make_fallback_kernel(
        fallback_models=[
            _FallbackModelConfig(engine_type="unknown-cloud", model="some-model"),
        ]
    )

    with caplog.at_level(logging.WARNING, logger="sidecar.ai.routing.generation_runtime"):
        result = attempt_fallback_generation(
            kernel,
            original_error=RuntimeError("primary failed"),
            latest_user_content="hello",
            working_messages=[],
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system_prompt="sys",
            tool_schemas=[],
            runtime=None,
        )

    assert result is None
    # The local-first gate short-circuited before engine creation.
    assert create_calls == []
    skip_events = [getattr(record, "event", None) for record in caplog.records]
    assert "ai.router.fallback_non_local_skipped" in skip_events


def test_attempt_fallback_skips_init_failed_engine(monkeypatch, caplog) -> None:
    """When _create_engine returns a selection with fallback_from set, skip it via the
    init-failed guard specifically — never attempting generation on the None engine."""
    class _FailedSelection:
        fallback_from = "init_error"
        fallback_reason = "model not found"
        engine = None

    monkeypatch.setattr(generation_runtime, "_create_engine", lambda _cfg: _FailedSelection())

    kernel = SimpleNamespace(
        _engine=SimpleNamespace(_turn_diagnostics_store=None),
        _config=RuntimeConfig(
            engine_type="ollama",
            model="primary-model",
            fallback_models=(
                FallbackModelConfig(engine_type="ollama", model="fallback-model"),
            ),
        ),
        _engine_messages=lambda msgs, primary_system_text: msgs,
        _system_prompt_for_engine=lambda v: str(v),
    )

    with caplog.at_level(logging.WARNING, logger="sidecar.ai.routing.generation_runtime"):
        result = attempt_fallback_generation(
            kernel,
            original_error=RuntimeError("primary failed"),
            latest_user_content="hello",
            working_messages=[],
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system_prompt="sys",
            tool_schemas=[],
            runtime=None,
        )

    assert result is None
    # The init-failed guard fired and short-circuited the candidate. If it were
    # removed, the code would dereference the None engine and surface a generic
    # ``fallback_failed`` instead — pin the exact event so that flip is caught.
    events = [getattr(record, "event", None) for record in caplog.records]
    assert "ai.router.fallback_engine_init_failed" in events
    assert "ai.router.fallback_failed" not in events


def test_attempt_fallback_succeeds_and_emits_fallback_triggered_event(monkeypatch) -> None:
    """A successful fallback returns the result and emits FallbackTriggeredEvent."""
    fallback_result = GenerationResult(content="Fallback answer.", finish_reason="stop")

    class _FallbackEngine:
        def __init__(self) -> None:
            self.unload_calls = 0
            self.close_calls = 0

        def generate_with_tools(self, **_kw: Any) -> GenerationResult:
            return fallback_result

        def stream_with_tools(self, **_kw: Any):
            yield fallback_result.content
            return fallback_result

        def get_model_max_output_tokens(self) -> int:
            return 512

        def unload_model(self) -> None:
            self.unload_calls += 1

        def close(self) -> None:
            self.close_calls += 1

    class _GoodSelection:
        fallback_from = None
        fallback_reason = None
        engine = _FallbackEngine()

    monkeypatch.setattr(generation_runtime, "_create_engine", lambda _cfg: _GoodSelection())
    monkeypatch.setattr(generation_runtime, "strip_thinking_from_all_messages", lambda msgs: msgs)

    original_error = ConnectionError("primary failed")

    # RuntimeConfig is a frozen dataclass — _dataclass_replace works on it.
    runtime_config = RuntimeConfig(
        engine_type="ollama",
        model="primary-model",
        temperature=0.5,
        fallback_models=(
            FallbackModelConfig(engine_type="ollama", model="fallback-7b"),
        ),
    )

    kernel = SimpleNamespace(
        _engine=SimpleNamespace(_turn_diagnostics_store=None),
        _config=runtime_config,
        _engine_messages=lambda msgs, primary_system_text: msgs,
        _system_prompt_for_engine=lambda v: str(v),
    )

    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_fallback_ok",
        streaming=False,
    )

    result = attempt_fallback_generation(
        kernel,
        original_error=original_error,
        latest_user_content="hello",
        working_messages=[{"role": "user", "content": "hello"}],
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
        runtime=runtime,
    )

    assert result is not None
    gen_result, event_types = result
    assert gen_result.content == "Fallback answer."
    assert gen_result.finish_reason == "stop"
    assert event_types == set()

    fallback_events = [e for e in events if isinstance(e, FallbackTriggeredEvent)]
    assert len(fallback_events) == 1
    assert fallback_events[0].fallback_model == "ollama/fallback-7b"
    assert fallback_events[0].original_model == "ollama/primary-model"
    # Reason should mention the error class
    assert "ConnectionError" in fallback_events[0].reason
    assert _GoodSelection.engine.unload_calls == 1
    assert _GoodSelection.engine.close_calls == 1


@pytest.mark.parametrize(
    ("primary_engine", "fallback_engine", "expected_api_url"),
    [
        ("openai-compatible", "ollama", None),
        ("vllm", "ollama", None),
        ("vllm", "vllm", "http://127.0.0.1:8123/v1"),
    ],
)
def test_attempt_fallback_resolves_endpoint_by_engine_identity(
    monkeypatch: pytest.MonkeyPatch,
    primary_engine: str,
    fallback_engine: str,
    expected_api_url: str | None,
) -> None:
    class _FallbackEngine:
        def generate_with_tools(self, **_kwargs: Any) -> GenerationResult:
            return GenerationResult(content="fallback", finish_reason="stop")

        def stream_with_tools(self, **_kwargs: Any):
            result = GenerationResult(content="fallback", finish_reason="stop")
            yield result.content
            return result

        def get_model_max_output_tokens(self) -> int:
            return 512

    captured_configs: list[RuntimeConfig] = []

    def create_engine(config: RuntimeConfig) -> SimpleNamespace:
        captured_configs.append(config)
        return SimpleNamespace(
            fallback_from=None,
            fallback_reason=None,
            engine=_FallbackEngine(),
        )

    monkeypatch.setattr(generation_runtime, "_create_engine", create_engine)
    monkeypatch.setattr(
        generation_runtime,
        "strip_thinking_from_all_messages",
        lambda messages: messages,
    )
    config = RuntimeConfig(
        engine_type=primary_engine,
        model="primary",
        api_url="http://127.0.0.1:8123/v1",
        fallback_models=(
            FallbackModelConfig(engine_type=fallback_engine, model="fallback"),
        ),
    )
    kernel = SimpleNamespace(
        _engine=SimpleNamespace(_turn_diagnostics_store=None),
        _config=config,
        _engine_messages=lambda messages, primary_system_text: messages,
        _system_prompt_for_engine=lambda value: str(value),
    )

    result = attempt_fallback_generation(
        kernel,
        original_error=ConnectionError("primary failed"),
        latest_user_content="hello",
        working_messages=[],
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="system",
        tool_schemas=[],
        runtime=None,
    )

    assert result is not None
    assert captured_configs[0].api_url == expected_api_url


def test_attempt_fallback_continues_when_fallback_engine_raises(monkeypatch) -> None:
    """When the fallback engine itself throws, we continue and eventually return None."""
    class _ErrorEngine:
        def __init__(self) -> None:
            self.unload_calls = 0
            self.close_calls = 0

        def generate_with_tools(self, **_kw: Any) -> GenerationResult:
            raise RuntimeError("fallback also broken")

        def stream_with_tools(self, **_kw: Any):
            raise RuntimeError("fallback also broken")
            yield  # pragma: no cover

        def get_model_max_output_tokens(self) -> int:
            return 512

        def unload_model(self) -> None:
            self.unload_calls += 1

        def close(self) -> None:
            self.close_calls += 1

    class _GoodSelection:
        fallback_from = None
        fallback_reason = None
        engine = _ErrorEngine()

    monkeypatch.setattr(generation_runtime, "_create_engine", lambda _cfg: _GoodSelection())
    monkeypatch.setattr(generation_runtime, "strip_thinking_from_all_messages", lambda msgs: msgs)

    runtime_config = RuntimeConfig(
        engine_type="ollama",
        model="primary-model",
        temperature=0.5,
        fallback_models=(
            FallbackModelConfig(engine_type="ollama", model="bad-fallback"),
        ),
    )

    kernel = SimpleNamespace(
        _engine=SimpleNamespace(_turn_diagnostics_store=None),
        _config=runtime_config,
        _engine_messages=lambda msgs, primary_system_text: msgs,
        _system_prompt_for_engine=lambda v: str(v),
    )

    result = attempt_fallback_generation(
        kernel,
        original_error=RuntimeError("primary failed"),
        latest_user_content="hello",
        working_messages=[],
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
        runtime=None,
    )

    # All fallback candidates failed — must return None, not propagate
    assert result is None
    assert _GoodSelection.engine.unload_calls == 1
    assert _GoodSelection.engine.close_calls == 1


def test_attempt_fallback_cancel_propagates_and_closes_engine_once(monkeypatch) -> None:
    class _FallbackEngine:
        def __init__(self) -> None:
            self.unload_calls = 0
            self.close_calls = 0

        def stream_with_tools(self, **_kwargs: Any):
            yield "must not be promoted"
            return GenerationResult(content="must not be promoted", finish_reason="stop")

        def get_model_max_output_tokens(self) -> int:
            return 512

        def unload_model(self) -> None:
            self.unload_calls += 1

        def close(self) -> None:
            self.close_calls += 1

    fallback_engine = _FallbackEngine()
    monkeypatch.setattr(
        generation_runtime,
        "_create_engine",
        lambda _config: SimpleNamespace(
            fallback_from=None,
            fallback_reason=None,
            engine=fallback_engine,
        ),
    )
    config = RuntimeConfig(
        engine_type="ollama",
        model="primary",
        fallback_models=(FallbackModelConfig(engine_type="ollama", model="fallback"),),
    )
    kernel = SimpleNamespace(
        _engine=SimpleNamespace(_turn_diagnostics_store=None),
        _config=config,
        _engine_messages=lambda messages, primary_system_text: messages,
        _system_prompt_for_engine=lambda value: str(value),
    )
    cancel_handle = TurnCancellationHandle(request_id="req-fallback-cancel")
    cancel_handle.cancel(reason="sidecar_cancel")
    runtime = LoopRuntime(
        request_id="req-fallback-cancel",
        cancel_handle=cancel_handle,
    )

    with pytest.raises(TerminalChatStateError):
        attempt_fallback_generation(
            kernel,
            original_error=ConnectionError("primary failed"),
            latest_user_content="hello",
            working_messages=[],
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system_prompt="system",
            tool_schemas=[],
            runtime=runtime,
        )

    assert fallback_engine.unload_calls == 1
    assert fallback_engine.close_calls == 1


def test_attempt_fallback_binds_request_context_inside_stream_reader(monkeypatch) -> None:
    class _FallbackEngine:
        def __init__(self) -> None:
            self.observed_request_id = ""

        def begin_request_context(self, **kwargs: Any) -> None:
            install_request_context(self, **kwargs)

        def clear_request_context(self, *, request_id: str | None = None) -> None:
            clear_request_context(self, request_id=request_id)

        def stream_with_tools(self, **_kwargs: Any):
            context = current_request_context(self)
            self.observed_request_id = str((context or {}).get("request_id") or "")
            result = GenerationResult(content="context-bound", finish_reason="stop")
            yield result.content
            return result

        def get_model_max_output_tokens(self) -> int:
            return 512

        def unload_model(self) -> None:
            pass

        def close(self) -> None:
            pass

    fallback_engine = _FallbackEngine()
    monkeypatch.setattr(
        generation_runtime,
        "_create_engine",
        lambda _config: SimpleNamespace(
            fallback_from=None,
            fallback_reason=None,
            engine=fallback_engine,
        ),
    )
    config = RuntimeConfig(
        engine_type="ollama",
        model="primary",
        fallback_models=(FallbackModelConfig(engine_type="ollama", model="fallback"),),
    )
    kernel = SimpleNamespace(
        _engine=SimpleNamespace(_turn_diagnostics_store="primary-diagnostics"),
        _config=config,
        _engine_messages=lambda messages, primary_system_text: messages,
        _system_prompt_for_engine=lambda value: str(value),
    )
    runtime = LoopRuntime(
        request_id="req-fallback-context",
        trace_id="trace-fallback-context",
        request_context=SimpleNamespace(
            request_id="req-fallback-context",
            trace_id="trace-fallback-context",
            debug_options={},
            mode="assist",
            agent_id=None,
        ),
    )

    result = attempt_fallback_generation(
        kernel,
        original_error=ConnectionError("primary failed"),
        latest_user_content="hello",
        working_messages=[],
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="system",
        tool_schemas=[],
        runtime=runtime,
    )

    assert result is not None
    assert fallback_engine.observed_request_id == "req-fallback-context"
    assert current_request_context(fallback_engine) is None


# ---------------------------------------------------------------------------
# generate_step cache-break detection path (lines 884-916)
# ---------------------------------------------------------------------------


class _StaticNonStreamingEngine:
    """Minimal non-streaming engine returning a fixed GenerationResult with usage."""

    def __init__(self, usage: GenerationUsage) -> None:
        self._usage = usage

    def generate_with_tools(self, **_kw: Any) -> GenerationResult:
        return GenerationResult(content="OK", finish_reason="stop", usage=self._usage)

    def get_model_max_output_tokens(self) -> int:
        return 512


class _VisionRecordingEngine:
    capabilities = {"vision": True}

    def __init__(self) -> None:
        self.message_calls: list[list[dict[str, object]]] = []

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.message_calls.append([dict(row) for row in kwargs["messages"]])
        return GenerationResult(content="OK", finish_reason="stop")

    def stream_with_tools(self, **kwargs: Any):
        self.message_calls.append([dict(row) for row in kwargs["messages"]])
        return GenerationResult(content="OK", finish_reason="stop")
        yield  # pragma: no cover - generator shape without chunks

    def get_model_max_output_tokens(self) -> int:
        return 512

    def unload_model(self) -> None:
        return None

    def close(self) -> None:
        return None


@dataclass
class _CacheBreakResult:
    detected: bool
    reason: str = ""
    changed_categories: frozenset[str] = field(default_factory=frozenset)


class _CacheBreakDetector:
    def __init__(self, *, detected: bool) -> None:
        self._detected = detected
        self.recorded: list[dict[str, Any]] = []
        self.checked: list[dict[str, Any]] = []

    def record_prompt_state(self, source_key: Any, system_prompt: Any, tool_schemas: Any) -> None:
        self.recorded.append({"source_key": source_key})

    def check_response_for_cache_break(
        self,
        source_key: str,
        cache_read_tokens: int,
    ) -> _CacheBreakResult:
        self.checked.append(
            {
                "source_key": source_key,
                "cache_read_tokens": cache_read_tokens,
            }
        )
        return _CacheBreakResult(
            detected=self._detected,
            reason="prompt_changed" if self._detected else "",
            changed_categories=frozenset({"system_prompt"}) if self._detected else frozenset(),
        )


def _make_non_streaming_kernel(engine: Any) -> SimpleNamespace:
    return SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            engine_type="ollama",
            model="test-model",
            temperature=0.0,
            reasoning_effort=None,
            max_tokens=128,
            feature_flags={},
            fallback_models=[],
        ),
        _engine_messages=lambda msgs, primary_system_text: msgs,
        _system_prompt_for_engine=lambda v: str(v),
        _cache_usage_tokens=lambda raw, *keys: raw.get(keys[0], raw.get(keys[1], 0)),
    )


def test_vision_anchor_is_stable_across_resume_and_fallback(monkeypatch) -> None:
    image = VisionImage(
        mime_type="image/png",
        width=64,
        height=48,
        frame_count=1,
        data=b"vision-payload",
    )
    working_messages: list[dict[str, object]] = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "<user content>"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call-1", "name": "read_file", "arguments": {}}],
        },
        {"role": "tool", "content": "result", "tool_call_id": "call-1"},
    ]
    request_context = SimpleNamespace(
        request_id="req-vision-anchor",
        vision_images=(image,),
        vision_anchor_text="<user content>",
    )
    runtime = LoopRuntime(
        request_id="req-vision-anchor", request_context=request_context
    )
    primary_engine = _VisionRecordingEngine()
    primary_kernel = _make_non_streaming_kernel(primary_engine)
    primary_kernel._engine_messages = engine_messages

    generate_step(
        primary_kernel,
        latest_user_content="<user content>",
        working_messages=working_messages,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        source_key="main",
        system_prompt="sys",
        tool_schemas=[],
        cache_break_detector=None,
        runtime=runtime,
    )
    working_messages.append({"role": "user", "content": "nudge"})
    resumed_runtime = LoopRuntime(
        request_id="req-vision-anchor",
        request_context=request_context,
        iteration_base=2,
    )
    generate_step(
        primary_kernel,
        latest_user_content="<user content>",
        working_messages=working_messages,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        source_key="main",
        system_prompt="sys",
        tool_schemas=[],
        cache_break_detector=None,
        runtime=resumed_runtime,
    )

    assert [
        [index for index, row in enumerate(call) if "images" in row]
        for call in primary_engine.message_calls
    ] == [[0], [0]]

    fallback_engine = _VisionRecordingEngine()
    fallback_config = RuntimeConfig(
        engine_type="ollama",
        model="primary-model",
        fallback_models=(FallbackModelConfig(engine_type="ollama", model="fallback-model"),),
    )
    fallback_kernel = SimpleNamespace(
        _engine=primary_engine,
        _config=fallback_config,
        _engine_messages=engine_messages,
        _system_prompt_for_engine=str,
    )
    monkeypatch.setattr(
        generation_runtime,
        "_create_engine",
        lambda _config: SimpleNamespace(
            engine=fallback_engine,
            fallback_from=None,
            fallback_reason=None,
        ),
    )
    fallback_result = attempt_fallback_generation(
        fallback_kernel,
        original_error=ConnectionError("primary failed"),
        latest_user_content="<user content>",
        working_messages=working_messages,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
        runtime=resumed_runtime,
    )

    assert fallback_result is not None
    assert [index for index, row in enumerate(fallback_engine.message_calls[0]) if "images" in row] == [0]


def _runtime_with_compacted_vision_anchor(*, iteration: int) -> LoopRuntime:
    image = VisionImage(
        mime_type="image/png",
        width=64,
        height=48,
        frame_count=1,
        data=b"vision-payload",
    )
    return LoopRuntime(
        request_id="req-compacted-vision-anchor",
        current_iteration=iteration,
        request_context=SimpleNamespace(
            vision_images=(image,),
            vision_anchor_text="describe the image",
        ),
    )


def test_first_generation_still_rejects_a_missing_vision_anchor() -> None:
    engine = _VisionRecordingEngine()
    kernel = _make_non_streaming_kernel(engine)
    kernel._engine_messages = engine_messages

    with pytest.raises(VisionAnchorError, match="could not be attached"):
        generate_step(
            kernel,
            latest_user_content="describe the image",
            working_messages=[
                {"role": "system", "content": "[Original request summarized above]"}
            ],
            reasoning_effort=None,
            prompt_cache_enabled=False,
            source_key="main",
            system_prompt="sys",
            tool_schemas=[],
            cache_break_detector=None,
            runtime=_runtime_with_compacted_vision_anchor(iteration=1),
        )

    assert engine.message_calls == []


def test_later_generation_degrades_once_when_compaction_loses_vision_anchor(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING, logger=generation_runtime.__name__)
    engine = _VisionRecordingEngine()
    kernel = _make_non_streaming_kernel(engine)
    kernel._engine_messages = engine_messages

    generate_step(
        kernel,
        latest_user_content="describe the image",
        working_messages=[
            {"role": "system", "content": "[Original request summarized above]"}
        ],
        reasoning_effort=None,
        prompt_cache_enabled=False,
        source_key="main",
        system_prompt="sys",
        tool_schemas=[],
        cache_break_detector=None,
        runtime=_runtime_with_compacted_vision_anchor(iteration=2),
    )

    assert engine.message_calls and all("images" not in row for row in engine.message_calls[0])
    records = [r for r in caplog.records if getattr(r, "event", "") == "ai.router.vision_anchor_lost"]
    assert len(records) == 1
    assert records[0].data == {"iteration": 2, "image_count": 1}


def test_fallback_generation_degrades_once_when_compaction_loses_vision_anchor(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING, logger=generation_runtime.__name__)
    fallback_engine = _VisionRecordingEngine()
    config = RuntimeConfig(
        engine_type="ollama",
        model="primary-model",
        fallback_models=(FallbackModelConfig(engine_type="ollama", model="fallback-model"),),
    )
    kernel = SimpleNamespace(
        _engine=_VisionRecordingEngine(),
        _config=config,
        _engine_messages=engine_messages,
        _system_prompt_for_engine=str,
    )
    monkeypatch.setattr(
        generation_runtime,
        "_create_engine",
        lambda _config: SimpleNamespace(
            engine=fallback_engine,
            fallback_from=None,
            fallback_reason=None,
        ),
    )

    result = attempt_fallback_generation(
        kernel,
        original_error=ConnectionError("primary failed"),
        latest_user_content="describe the image",
        working_messages=[
            {"role": "system", "content": "[Original request summarized above]"}
        ],
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
        runtime=_runtime_with_compacted_vision_anchor(iteration=2),
    )

    assert result is not None
    assert fallback_engine.message_calls
    assert all("images" not in row for row in fallback_engine.message_calls[0])
    records = [r for r in caplog.records if getattr(r, "event", "") == "ai.router.vision_anchor_lost"]
    assert len(records) == 1
    assert records[0].data == {"iteration": 2, "image_count": 1}


def test_generate_step_checks_cache_break_when_raw_usage_present() -> None:
    usage = GenerationUsage(
        input_tokens=10,
        output_tokens=5,
        raw_usage={"cache_read_input_tokens": 8, "cache_creation_input_tokens": 2},
    )
    engine = _StaticNonStreamingEngine(usage)
    kernel = _make_non_streaming_kernel(engine)
    detector = _CacheBreakDetector(detected=False)
    runtime = LoopRuntime(
        emit=lambda _e: None,
        request_id="req_cache_ok",
        streaming=False,
    )

    result, event_types = generate_step(
        kernel,
        latest_user_content="hello",
        working_messages=[{"role": "user", "content": "hello"}],
        reasoning_effort=None,
        prompt_cache_enabled=True,
        source_key="main",
        system_prompt="sys",
        tool_schemas=[],
        cache_break_detector=detector,
        runtime=runtime,
    )

    assert result.content == "OK"
    assert len(detector.recorded) == 1
    assert len(detector.checked) == 1
    assert detector.checked[0]["cache_read_tokens"] == 8


def test_generate_step_logs_cache_break_when_detected(caplog) -> None:
    usage = GenerationUsage(
        input_tokens=10,
        output_tokens=5,
        raw_usage={"cache_read_input_tokens": 0, "cache_creation_input_tokens": 10},
    )
    engine = _StaticNonStreamingEngine(usage)
    kernel = _make_non_streaming_kernel(engine)
    detector = _CacheBreakDetector(detected=True)
    runtime = LoopRuntime(
        emit=lambda _e: None,
        request_id="req_cache_break",
        streaming=False,
    )

    with caplog.at_level(logging.WARNING, logger="sidecar.ai.routing.generation_runtime"):
        result, _event_types = generate_step(
            kernel,
            latest_user_content="hello",
            working_messages=[{"role": "user", "content": "hello"}],
            reasoning_effort=None,
            prompt_cache_enabled=True,
            source_key="main",
            system_prompt="sys",
            tool_schemas=[],
            cache_break_detector=detector,
            runtime=runtime,
        )

    assert result.content == "OK"
    # The detector was queried and reported a break
    assert detector.checked[0]["cache_read_tokens"] == 0
    # The detected break must actually surface as a logged warning event — pin the
    # exact event + code so removing the ``if cache_break.detected`` log branch is caught.
    break_records = [
        record
        for record in caplog.records
        if getattr(record, "event", None) == "ai.router.prompt_cache_break_detected"
    ]
    assert len(break_records) == 1
    logged = break_records[0]
    assert logged.data["code"] == generation_runtime.CMP_CACHE_BREAK_DETECTED
    assert logged.data["cache_creation_tokens"] == 10
    assert logged.data["cache_read_tokens"] == 0
    assert logged.data["reason"] == "prompt_changed"


# ---------------------------------------------------------------------------
# generate_step ToolExecutionFailure re-raise path (line 843)
# ---------------------------------------------------------------------------


class _AlwaysThrowsToolFailureEngine:
    """Raises ToolExecutionFailure directly (not wrapped by generate_step)."""

    def generate_with_tools(self, **_kw: Any) -> GenerationResult:
        raise ToolExecutionFailure(
            code="CMP-LOOP-0001",
            message="tool execution failed internally",
            retryable=False,
        )

    def get_model_max_output_tokens(self) -> int:
        return 512


def test_generate_step_reraises_tool_execution_failure_without_wrapping() -> None:
    engine = _AlwaysThrowsToolFailureEngine()
    kernel = _make_non_streaming_kernel(engine)
    runtime = LoopRuntime(
        emit=lambda _e: None,
        request_id="req_tef_reraise",
        streaming=False,
    )

    with pytest.raises(ToolExecutionFailure) as exc_info:
        generate_step(
            kernel,
            latest_user_content="hello",
            working_messages=[],
            reasoning_effort=None,
            prompt_cache_enabled=False,
            source_key="main",
            system_prompt="sys",
            tool_schemas=[],
            cache_break_detector=None,
            runtime=runtime,
        )

    # Must be the original error, not a new wrapper
    assert exc_info.value.code == "CMP-LOOP-0001"
    assert exc_info.value.message == "tool execution failed internally"


# ---------------------------------------------------------------------------
# Cancellation during stream: lines 488-493
# ---------------------------------------------------------------------------


class _SlowStreamEngine:
    """Yields one text delta then hangs until close is called."""

    def __init__(self) -> None:
        self._closed = threading.Event()

    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="content", text="Partial text.")
        # Block until cancelled
        self._closed.wait(timeout=5.0)
        return GenerationResult(content="Partial text.", finish_reason="stop")


def test_stream_generate_cancelled_after_first_chunk_records_unflushed_content() -> None:
    engine = _SlowStreamEngine()
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    cancel_handle = TurnCancellationHandle(request_id="req_cancel")
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_cancel",
        streaming=True,
        chunk_inactivity_seconds=5.0,
        cancel_handle=cancel_handle,
    )

    def _cancel_after_delay() -> None:
        time.sleep(0.05)
        cancel_handle.cancel(reason="sidecar_cancel")
        engine._closed.set()

    t = threading.Thread(target=_cancel_after_delay, daemon=True)
    t.start()

    with pytest.raises(TerminalChatStateError) as exc_info:
        stream_generate_with_tools(
            kernel,
            runtime=runtime,
            latest_user_content="hello",
            prompt_messages=[],
            max_tokens=128,
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system_prompt="sys",
            tool_schemas=[],
        )

    t.join(timeout=2.0)
    # Must propagate the cancellation as a TerminalChatStateError carrying the
    # cancelled status and the exact cancel reason — not swallow or remap it.
    assert exc_info.value.status == TURN_STATE_CANCELLED
    assert exc_info.value.terminal_subcode == "sidecar_cancel"
    # The first content chunk is flushed inline (StreamingEvent content path)
    # BEFORE the engine blocks, so it surfaces as a TokenDeltaEvent prior to
    # cancellation — the cancel branch must preserve, not discard, that emission.
    token_deltas = [e.delta for e in events if isinstance(e, TokenDeltaEvent)]
    assert token_deltas == ["Partial text."]
    # Because that chunk was already flushed, record_unflushed_content finds an
    # empty tail and stashes nothing — pin that so a regression that re-stashes
    # already-flushed text (double-surfacing the preamble) is caught.
    assert runtime.last_iteration_unflushed == []


class _EndlessTinyStream:
    def __init__(self) -> None:
        self.closed = threading.Event()

    def __iter__(self):
        return self

    def __next__(self):
        if self.closed.is_set():
            raise StopIteration
        time.sleep(0.001)
        return StreamingEvent(kind="content", text="x")

    def close(self) -> None:
        self.closed.set()


class _EndlessTinyStreamEngine:
    def __init__(self) -> None:
        self.stream = _EndlessTinyStream()
        self.wall_clock_deadline: float | None = None

    def stream_with_tools(self, **kwargs: Any):
        self.wall_clock_deadline = kwargs.get("wall_clock_deadline")
        return self.stream


def test_stream_absolute_deadline_stops_endless_tiny_chunks_and_reclaims_reader() -> None:
    engine = _EndlessTinyStreamEngine()
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda value: str(value),
    )
    runtime = LoopRuntime(
        request_id="req-deadline",
        wall_clock_deadline=time.monotonic() + 0.04,
        chunk_inactivity_seconds=5.0,
        model_load_grace_seconds=5.0,
    )

    started = time.monotonic()
    with pytest.raises(TerminalChatStateError) as excinfo:
        stream_generate_with_tools(
            kernel,
            runtime=runtime,
            latest_user_content="hello",
            prompt_messages=[],
            max_tokens=128,
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system_prompt="sys",
            tool_schemas=[],
        )

    assert excinfo.value.status == TURN_STATE_TIMEOUT
    assert excinfo.value.terminal_subcode == TERMINAL_SUBCODE_TIMEOUT_TURN
    assert time.monotonic() - started < 0.5
    assert engine.wall_clock_deadline == runtime.wall_clock_deadline
    assert engine.stream.closed.is_set()
    assert not any(
        thread.name == "router-stream-reader" and thread.is_alive()
        for thread in threading.enumerate()
    )


class _UncooperativeStream:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.close_calls = 0

    def __iter__(self):
        return self

    def __next__(self):
        self.started.set()
        self.release.wait(timeout=2.0)
        raise StopIteration

    def close(self) -> None:
        self.close_calls += 1


def test_stream_reader_capacity_bounds_live_and_quarantined_threads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generation_runtime_stream._reset_zombie_reader_count_for_tests()
    monkeypatch.setattr(generation_runtime_stream, "_STREAM_READER_CAP", 1)
    stream = _UncooperativeStream()
    reader = generation_runtime_stream._spawn_stream_reader(stream)
    assert stream.started.wait(timeout=1.0)
    assert generation_runtime_stream.live_stream_reader_count() == 1

    with pytest.raises(
        generation_runtime_stream._StreamReaderCapacityExceeded,
        match="capacity exhausted",
    ):
        generation_runtime_stream._spawn_stream_reader(iter(()))

    reader.close()
    stream.release.set()
    reader.join(timeout_seconds=1.0)
    assert generation_runtime_stream.live_stream_reader_count() == 0


def test_stream_reader_capacity_failure_closes_provider_and_returns_resource_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stream = _UncooperativeStream()
    events: list[object] = []
    kernel = SimpleNamespace(
        _engine=SimpleNamespace(stream_with_tools=lambda **_kwargs: stream),
        _config=SimpleNamespace(temperature=0.0, reasoning_effort=None, feature_flags={}),
        _system_prompt_for_engine=lambda value: str(value),
    )
    runtime = LoopRuntime(request_id="req-reader-capacity", emit=events.append)
    monkeypatch.setattr(
        generation_runtime_stream,
        "_spawn_stream_reader",
        lambda _stream: (_ for _ in ()).throw(
            generation_runtime_stream._StreamReaderCapacityExceeded("capacity exhausted")
        ),
    )

    result, emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    assert stream.close_calls == 1
    assert result.finish_reason == "error"
    assert result.content.startswith("Generation could not start")
    assert any(
        isinstance(event, StopEvent) and event.code == generation_runtime_stream.CMP_RESOURCE_EXCEEDED
        for event in events
    )
    assert "chat.token" in emitted


def test_stream_reader_cleanup_warns_when_iterator_close_cannot_reclaim_thread(
    caplog: pytest.LogCaptureFixture,
) -> None:
    stream = _UncooperativeStream()
    kernel = SimpleNamespace(
        _engine=SimpleNamespace(stream_with_tools=lambda **_kwargs: stream),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda value: str(value),
    )
    runtime = LoopRuntime(
        request_id="req-uncooperative-reader",
        wall_clock_deadline=time.monotonic() + 0.03,
        chunk_inactivity_seconds=5.0,
        model_load_grace_seconds=5.0,
    )

    try:
        with caplog.at_level(
            logging.WARNING,
            logger="sidecar.ai.routing.generation_runtime",
        ):
            with pytest.raises(TerminalChatStateError):
                stream_generate_with_tools(
                    kernel,
                    runtime=runtime,
                    latest_user_content="hello",
                    prompt_messages=[],
                    max_tokens=128,
                    reasoning_effort=None,
                    prompt_cache_enabled=False,
                    system_prompt="sys",
                    tool_schemas=[],
                )

        assert stream.started.is_set()
        assert stream.close_calls == 1
        assert any(
            getattr(record, "event", "")
            == "generation.stream_reader_cleanup_incomplete"
            for record in caplog.records
        )
    finally:
        stream.release.set()
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline and any(
            thread.name == "router-stream-reader" and thread.is_alive()
            for thread in threading.enumerate()
        ):
            time.sleep(0.01)

    assert not any(
        thread.name == "router-stream-reader" and thread.is_alive()
        for thread in threading.enumerate()
    )


def test_stream_reader_cleanup_incomplete_increments_zombie_reader_counter(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # L1 diagnostics (SP-15 zombie-reader signal): every
    # generation.stream_reader_cleanup_incomplete warn must bump a monotonic
    # counter and stamp its running total on the log record, ahead of the L7
    # accounting fix that will consume it.
    generation_runtime_stream._reset_zombie_reader_count_for_tests()
    stream = _UncooperativeStream()
    kernel = SimpleNamespace(
        _engine=SimpleNamespace(stream_with_tools=lambda **_kwargs: stream),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda value: str(value),
    )
    runtime = LoopRuntime(
        request_id="req-zombie-reader-counter",
        wall_clock_deadline=time.monotonic() + 0.03,
        chunk_inactivity_seconds=5.0,
        model_load_grace_seconds=5.0,
    )

    try:
        with caplog.at_level(
            logging.WARNING,
            logger="sidecar.ai.routing.generation_runtime",
        ):
            with pytest.raises(TerminalChatStateError):
                stream_generate_with_tools(
                    kernel,
                    runtime=runtime,
                    latest_user_content="hello",
                    prompt_messages=[],
                    max_tokens=128,
                    reasoning_effort=None,
                    prompt_cache_enabled=False,
                    system_prompt="sys",
                    tool_schemas=[],
                )

        assert generation_runtime_stream.zombie_reader_count() == 1
        assert generation_runtime_stream.quarantined_reader_count() == 1
        assert engine_liveness.active_generation_count() == 1
        cleanup_records = [
            record
            for record in caplog.records
            if getattr(record, "event", "") == "generation.stream_reader_cleanup_incomplete"
        ]
        assert cleanup_records
        assert getattr(cleanup_records[0], "zombie_reader_count", None) == 1
    finally:
        stream.release.set()
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline and any(
            thread.name == "router-stream-reader" and thread.is_alive()
            for thread in threading.enumerate()
        ):
            time.sleep(0.01)

    assert not any(
        thread.name == "router-stream-reader" and thread.is_alive()
        for thread in threading.enumerate()
    )
    assert generation_runtime_stream.quarantined_reader_count() == 0
    assert engine_liveness.active_generation_count() == 0


# ---------------------------------------------------------------------------
# Line 175: _to_generation_result with non-GenerationResult candidate
# ---------------------------------------------------------------------------


def test_to_generation_result_wraps_non_generation_result_string() -> None:
    """_to_generation_result must wrap a plain string into GenerationResult."""
    result = _to_generation_result("plain string answer")

    assert isinstance(result, GenerationResult)
    assert result.content == "plain string answer"
    assert result.finish_reason == "stop"


def test_to_generation_result_wraps_none_as_empty_content() -> None:
    """None candidate must produce an empty-content GenerationResult."""
    result = _to_generation_result(None)

    assert isinstance(result, GenerationResult)
    assert result.content == ""
    assert result.finish_reason == "stop"


# ---------------------------------------------------------------------------
# Line 336: buffer_content strips visible thought sentinel to empty on first chunk
# ---------------------------------------------------------------------------


class _VisibleThoughtSentinelOnlyEngine:
    """Yields a StreamingEvent whose text reduces to empty after sentinel stripping."""

    def stream_with_tools(self, **_kwargs: Any):
        # "thought:" is a visible thought sentinel that gets stripped
        yield StreamingEvent(kind="content", text="thought:")
        return GenerationResult(content="", finish_reason="stop")
        yield  # pragma: no cover


def test_buffer_content_sentinel_stripped_to_empty_produces_no_token_events() -> None:
    """When the first delta reduces to '' after sentinel stripping, nothing is emitted."""
    kernel = SimpleNamespace(
        _engine=_VisibleThoughtSentinelOnlyEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_sentinel_strip",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    # Sentinel stripped to empty — no token events should be emitted
    token_events = [e for e in events if isinstance(e, TokenDeltaEvent)]
    assert token_events == []
    assert "chat.token" not in emitted


# ---------------------------------------------------------------------------
# Line 354: flush_content skips empty string deltas in content_parts
# ---------------------------------------------------------------------------


class _EmptyDeltaEngine:
    """Yields empty-string content deltas (no-ops) followed by real content."""

    def stream_with_tools(self, **_kwargs: Any):
        # Empty content strings: buffer_content with "" is a no-op, so content_parts stays [].
        # But we can directly force an empty delta in content_parts via the raw-chunk fallback
        # (line 713): yielding an empty-string object goes through buffer_content("")
        # which does nothing. Then we yield "Real answer." to produce a token.
        yield StreamingEvent(kind="content", text="")
        yield StreamingEvent(kind="content", text="Real answer.")
        return GenerationResult(content="Real answer.", finish_reason="stop")
        yield  # pragma: no cover


def test_flush_content_skips_empty_deltas_and_emits_only_real_text() -> None:
    """flush_content must skip empty-string parts without crashing or double-emitting."""
    kernel = SimpleNamespace(
        _engine=_EmptyDeltaEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_empty_delta",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    # Only "Real answer." should surface
    token_deltas = [e.delta for e in events if isinstance(e, TokenDeltaEvent)]
    assert token_deltas == ["Real answer."]
    assert "chat.token" in emitted


# ---------------------------------------------------------------------------
# Lines 370-374: record_unflushed_content stores to diagnostics when unflushed
# content exists and the engine has a valid diagnostics store
# ---------------------------------------------------------------------------


class _MalformedToolCallWithPreambleEngine:
    """Returns finish_reason='tool_calls' but no parsed tool_calls (malformed args),
    with preamble text in the terminal result so unflushed content exists."""

    def __init__(self, diagnostics: _DiagnosticsStore) -> None:
        self._turn_diagnostics_store = diagnostics

    def stream_with_tools(self, **_kwargs: Any):
        # No streaming chunks — all content arrives in the terminal result
        return GenerationResult(
            content="Preamble before failed tool call.",
            finish_reason="tool_calls",
            tool_calls=(),  # empty tuple — malformed_tool_arguments path
        )
        yield  # pragma: no cover


def test_record_unflushed_content_stores_to_diagnostics_store_on_failure() -> None:
    """When terminal result has content but finish_reason='tool_calls' with no calls,
    record_unflushed_content must call store.record_buffered_visible_output (lines 370-374)."""
    diagnostics = _DiagnosticsStore()
    kernel = SimpleNamespace(
        _engine=_MalformedToolCallWithPreambleEngine(diagnostics),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_unflushed_diag",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, _emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    # finish_reason="tool_calls" with no tool_calls → StopEvent(CMP_LOOP_INVALID_TOOL_CALL)
    stop_events = [e for e in events if isinstance(e, StopEvent)]
    assert len(stop_events) == 1
    assert stop_events[0].code == CMP_LOOP_INVALID_TOOL_CALL

    # The unflushed preamble was stashed on runtime (line 370)
    assert runtime.last_iteration_unflushed == ["Preamble before failed tool call."]
    # AND recorded in the diagnostics store (lines 371-377)
    assert len(diagnostics.buffered) == 1
    assert diagnostics.buffered[0]["text"] == "Preamble before failed tool call."
    assert diagnostics.buffered[0]["request_id"] == "req_unflushed_diag"
    assert diagnostics.buffered[0]["reason"] == "malformed_tool_arguments"


# ---------------------------------------------------------------------------
# Lines 383, 385-386, 400-401: emit_thinking whitespace-only and guard trip
# ---------------------------------------------------------------------------


class _WhitespaceThinkingEngine:
    """Yields only a whitespace ThinkingDelta."""

    def stream_with_tools(self, **_kwargs: Any):
        yield ThinkingDelta(text="   ", is_complete=True)
        return GenerationResult(content="Done.", finish_reason="stop")
        yield  # pragma: no cover


def test_emit_thinking_drops_phase_leading_whitespace_only_delta() -> None:
    kernel = SimpleNamespace(
        _engine=_WhitespaceThinkingEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_ws_thinking",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    thinking_events = [e for e in events if isinstance(e, ThinkingEvent)]
    assert thinking_events == []
    assert result.thinking_text in (None, "")
    assert "chat.thinking" not in emitted


class _ThinkingGuardTripEngine:
    """Yields enough repetitive thinking to trip the char-limit guard."""

    def stream_with_tools(self, **_kwargs: Any):
        # max_tokens=1 → max_chars=4; send 10+ chars to blow past the limit
        yield ThinkingDelta(text="x" * 10, is_complete=False)
        # second delta: guard should already be tripped, suppression_logged=True
        yield ThinkingDelta(text="y" * 10, is_complete=False)
        return GenerationResult(content="Done.", finish_reason="stop")
        yield  # pragma: no cover


class _ThinkingRepetitionTripEngine:
    """Yields repeated windows until the repetition guard trips."""

    def stream_with_tools(self, **_kwargs: Any):
        repeated_window = "repeat pattern with the same reasoning tokens " * 30
        for _ in range(4):
            yield ThinkingDelta(text=repeated_window, is_complete=False)
        return GenerationResult(content="Done.", finish_reason="stop")
        yield  # pragma: no cover


def test_emit_thinking_surfaces_repetition_suppression_once() -> None:
    kernel = SimpleNamespace(
        _engine=_ThinkingRepetitionTripEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
            engine_type="ollama",
            model="test-model",
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_repetition_trip",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=20_000,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    suppression_events = [
        event
        for event in events
        if isinstance(event, ThinkingEvent)
        and event.delta == "Reasoning hidden - repetition detected"
    ]
    assert len(suppression_events) == 1
    assert suppression_events[0].kind == CHAT_THINKING_KIND_STATUS
    assert suppression_events[0].persist is False


class _OneThinkingDeltaEngine:
    """Yields a single reasoning delta then finishes cleanly."""

    def stream_with_tools(self, **_kwargs: Any):
        yield ThinkingDelta(text="Budget-tagged thinking.", is_complete=False)
        return GenerationResult(content="Done.", finish_reason="stop")
        yield  # pragma: no cover


class _ContentOnlyEngine:
    """Finishes with visible content and no reasoning at all."""

    def stream_with_tools(self, **_kwargs: Any):
        return GenerationResult(content="Just an answer.", finish_reason="stop")
        yield  # pragma: no cover


def _budget_test_kernel(engine: Any) -> SimpleNamespace:
    return SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
            engine_type="ollama",
            model="test-model",
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )


def test_reasoning_thinking_events_carry_resolved_budget(monkeypatch) -> None:
    """The resolver value rides every reasoning ThinkingEvent so Electron can
    scale its persisted-reasoning cap on the tool-loop path too."""
    from sidecar.ai.routing import generation_runtime_stream as _grs

    monkeypatch.setattr(
        _grs, "resolve_thinking_budget_chars", lambda _engine, _max_tokens: 123_456
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_budget_tag",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    stream_generate_with_tools(
        _budget_test_kernel(_OneThinkingDeltaEngine()),
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    reasoning_events = [
        event
        for event in events
        if isinstance(event, ThinkingEvent) and event.kind == CHAT_THINKING_KIND_REASONING
    ]
    assert reasoning_events
    assert all(event.thinking_budget_chars == 123_456 for event in reasoning_events)


def test_stale_checkpoint_phase_summary_cannot_leak_past_its_generation() -> None:
    """A staged checkpoint summary is popped per generation: when the
    post-checkpoint generation emits no reasoning, the summary must not
    survive to label a later, unrelated reasoning phase."""
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_summary_leak",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )
    runtime.next_reasoning_phase_summary = "Checkpoint 1 - reasoning continues"

    stream_generate_with_tools(
        _budget_test_kernel(_ContentOnlyEngine()),
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    assert getattr(runtime, "next_reasoning_phase_summary", None) is None


def test_emit_thinking_logs_guard_trip_once_and_suppresses_subsequent(
    caplog, monkeypatch
) -> None:
    """First guard trip logs the warning event (lines 385-386); second trip skips log (400-401)."""
    # The shared resolver floors the no-engine fallback at 65,536 chars, so the
    # max_tokens=1 knob no longer yields a 4-char budget on its own; patch the
    # resolver at the consuming module. Abort is disabled so this test keeps
    # exercising the suppress-only path it was written for.
    from sidecar.ai.routing import generation_runtime_stream as _grs

    monkeypatch.setattr(_grs, "resolve_thinking_budget_chars", lambda _engine, _max_tokens: 4)
    monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", "0")
    kernel = SimpleNamespace(
        _engine=_ThinkingGuardTripEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
            engine_type="ollama",
            model="test-model",
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_guard_trip",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    with caplog.at_level(logging.INFO, logger="sidecar.ai.routing.generation_runtime"):
        result, emitted = stream_generate_with_tools(
            kernel,
            runtime=runtime,
            latest_user_content="hello",
            prompt_messages=[],
            max_tokens=1,  # → max_chars=4; 10 chars trips the char_limit guard
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system_prompt="sys",
            tool_schemas=[],
        )

    # Guard was tripped — no thinking events should be emitted
    thinking_events = [e for e in events if isinstance(e, ThinkingEvent)]
    assert thinking_events == []
    assert all(
        event.delta != "Reasoning hidden - repetition detected"
        for event in thinking_events
    )
    assert "chat.thinking" not in emitted

    # The guard-trip log event must appear exactly once (lines 385-386)
    trip_records = [
        r for r in caplog.records
        if getattr(r, "event", None) == "ai.router.thinking_guard_tripped"
    ]
    assert len(trip_records) == 1, "guard-trip log must fire exactly once (lines 385-400)"
    assert trip_records[0].data["provider"] == "ollama"
    assert trip_records[0].data["model"] == "test-model"


# ---------------------------------------------------------------------------
# Line 504: terminal result carries thinking_text but thinking_parts is empty
# ---------------------------------------------------------------------------


class _TerminalThinkingOnlyEngine:
    """Yields no thinking deltas; thinking arrives only in the terminal result."""

    def stream_with_tools(self, **_kwargs: Any):
        return GenerationResult(
            content="Answer.",
            thinking_text="Terminal reasoning text.",
            finish_reason="stop",
        )
        yield  # pragma: no cover


def test_terminal_thinking_text_emitted_when_no_streaming_thinking_parts() -> None:
    """When final_thinking is non-empty but thinking_parts is empty, emit_thinking
    must be called with persist=True (line 504)."""
    kernel = SimpleNamespace(
        _engine=_TerminalThinkingOnlyEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_terminal_thinking",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    assert result.content == "Answer."
    assert "chat.thinking" in emitted
    thinking_events = [e for e in events if isinstance(e, ThinkingEvent)]
    assert len(thinking_events) == 1
    assert thinking_events[0].delta == "Terminal reasoning text."
    assert thinking_events[0].persist is True


# ---------------------------------------------------------------------------
# Line 656: EngineEvent unknown kind falls through to final continue
# ---------------------------------------------------------------------------


class _UnknownEngineEventKindEngine:
    """Yields an EngineEvent with an unknown kind, verifying it is safely ignored."""

    def stream_with_tools(self, **_kwargs: Any):
        yield EngineEvent(kind="UNKNOWN_FUTURE_KIND", text="ignored")
        yield EngineEvent(kind="done")
        return GenerationResult(content="", finish_reason="stop")


def test_engine_event_unknown_kind_is_safely_ignored() -> None:
    """An EngineEvent with an unrecognised kind must not crash — falls to final continue (line 656)."""
    kernel = SimpleNamespace(
        _engine=_UnknownEngineEventKindEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_unknown_kind",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    # Completed without error; unknown kind was silently skipped
    assert result.finish_reason == "stop"
    # Empty content — the unknown kind must not have added any token events
    token_events = [e for e in events if isinstance(e, TokenDeltaEvent)]
    assert token_events == []
    assert "chat.token" not in emitted


# ---------------------------------------------------------------------------
# Line 712: StreamingEvent with unknown kind falls through safely
# ---------------------------------------------------------------------------


class _UnknownStreamingEventKindEngine:
    """Yields a StreamingEvent with an unrecognised kind."""

    def stream_with_tools(self, **_kwargs: Any):
        yield StreamingEvent(kind="unknown_future_kind", text="ignored content")
        yield StreamingEvent(kind="content", text="Real content.")
        return GenerationResult(content="Real content.", finish_reason="stop")
        yield  # pragma: no cover


def test_streaming_event_unknown_kind_is_safely_ignored() -> None:
    """StreamingEvent with an unrecognised kind must be skipped without crashing (line 712)."""
    kernel = SimpleNamespace(
        _engine=_UnknownStreamingEventKindEngine(),
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=lambda v: str(v),
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_se_unknown_kind",
        streaming=True,
        chunk_inactivity_seconds=0.5,
    )

    result, emitted = stream_generate_with_tools(
        kernel,
        runtime=runtime,
        latest_user_content="hello",
        prompt_messages=[],
        max_tokens=128,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
    )

    # Only the real content event should produce a token, not the unknown-kind one
    token_deltas = [e.delta for e in events if isinstance(e, TokenDeltaEvent)]
    assert token_deltas == ["Real content."]
    assert "chat.token" in emitted


# ---------------------------------------------------------------------------
# Line 964: attempt_fallback_generation with max_context_tokens not None
# (sets overrides["context_length"])
# ---------------------------------------------------------------------------


def test_attempt_fallback_sets_context_length_when_max_context_tokens_is_set(monkeypatch) -> None:
    """When a fallback model has max_context_tokens set, attempt_fallback_generation
    must include context_length in the config overrides (line 964)."""
    applied_configs: list[Any] = []
    fallback_result = GenerationResult(content="Fallback OK.", finish_reason="stop")

    class _FallbackEngine:
        def generate_with_tools(self, **_kw: Any) -> GenerationResult:
            return fallback_result

        def stream_with_tools(self, **_kw: Any):
            yield fallback_result.content
            return fallback_result

        def get_model_max_output_tokens(self) -> int:
            return 512

    class _GoodSelection:
        fallback_from = None
        fallback_reason = None
        engine = _FallbackEngine()

    def _create_and_record(cfg: Any) -> Any:
        applied_configs.append(cfg)
        return _GoodSelection()

    monkeypatch.setattr(generation_runtime, "_create_engine", _create_and_record)
    monkeypatch.setattr(
        generation_runtime,
        "strip_thinking_from_all_messages",
        lambda msgs: msgs,
    )

    runtime_config = RuntimeConfig(
        engine_type="ollama",
        model="primary-model",
        fallback_models=(
            FallbackModelConfig(
                engine_type="ollama",
                model="fallback-small",
                max_context_tokens=4096,  # triggers line 964
            ),
        ),
    )

    kernel = SimpleNamespace(
        _engine=SimpleNamespace(_turn_diagnostics_store=None),
        _config=runtime_config,
        _engine_messages=lambda msgs, primary_system_text: msgs,
        _system_prompt_for_engine=lambda v: str(v),
    )

    result = attempt_fallback_generation(
        kernel,
        original_error=ConnectionError("primary failed"),
        latest_user_content="hello",
        working_messages=[],
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="sys",
        tool_schemas=[],
        runtime=None,
    )

    assert result is not None
    gen_result, _event_types = result
    assert gen_result.content == "Fallback OK."

    # _create_engine must have been called with a config that has context_length set
    assert len(applied_configs) == 1
    applied = applied_configs[0]
    assert applied.context_length == 4096, (
        "When max_context_tokens is set, context_length override must be applied (line 964)"
    )


# ---------------------------------------------------------------------------
# Provider classification passthrough (M2): Electron's one-shot auth retry needs
# to distinguish a 401 from any other CMP-CLOUD-1003.
# ---------------------------------------------------------------------------


class _AlwaysThrowsProviderHttpEngine:
    def __init__(self, classification: str, status_code: int) -> None:
        self._classification = classification
        self._status_code = status_code

    def get_model_max_output_tokens(self) -> int:
        return 4096

    def generate_with_tools(self, **_kwargs: Any) -> Any:
        raise generation_runtime.ProviderHttpError(
            provider="chatgpt",
            status_code=self._status_code,
            code="CMP-CLOUD-1003",
            message="ChatGPT credentials were rejected",
            retryable=False,
            classification=self._classification,
        )


def _run_generate_step_expecting_failure(engine: Any, request_id: str) -> ToolExecutionFailure:
    kernel = _make_non_streaming_kernel(engine)
    runtime = LoopRuntime(emit=lambda _e: None, request_id=request_id, streaming=False)
    with pytest.raises(ToolExecutionFailure) as exc_info:
        generate_step(
            kernel,
            latest_user_content="hello",
            working_messages=[],
            reasoning_effort=None,
            prompt_cache_enabled=False,
            source_key="main",
            system_prompt="sys",
            tool_schemas=[],
            cache_break_detector=None,
            runtime=runtime,
        )
    return exc_info.value


def test_provider_http_401_carries_classification_into_tool_failure_error_data() -> None:
    failure = _run_generate_step_expecting_failure(
        _AlwaysThrowsProviderHttpEngine("invalid_api_key", 401),
        "req_classification_401",
    )

    data = failure.to_error_data()
    assert data["classification"] == "invalid_api_key"
    # provider_code alone cannot identify a 401 -- it also covers 5xx and
    # context_overflow -- so the existing keys must survive alongside it.
    assert data["provider_code"] == "CMP-CLOUD-1003"
    assert data["category"] == "provider"
    assert data["error_type"] == "ProviderHttpError"


def test_provider_http_server_error_reports_its_own_classification() -> None:
    failure = _run_generate_step_expecting_failure(
        _AlwaysThrowsProviderHttpEngine("server_error", 500),
        "req_classification_500",
    )

    assert failure.to_error_data()["classification"] == "server_error"


def test_non_provider_generation_failure_carries_no_classification_key() -> None:
    failure = _run_generate_step_expecting_failure(
        _AlwaysThrowsToolFailureEngine(),
        "req_classification_absent",
    )

    assert "classification" not in failure.to_error_data()
