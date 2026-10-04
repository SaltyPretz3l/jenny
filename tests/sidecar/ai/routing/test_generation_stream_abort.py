"""Watchdog and interrupt paths must tear down the provider transport (ELC-12).

The engines register their "close the HTTP response" callback on the handle they
are given. A watchdog timeout must not cancel the turn's own handle (the turn
ends as a timeout, not a user cancellation), so the provider stream gets its own
stream-scoped child handle that the reader cleanup can cancel on its own.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai import engine_liveness
from sidecar.ai.error_codes import CMP_LOOP_ENGINE_STALLED
from sidecar.ai.routing import generation_runtime_stream
from sidecar.ai.routing.generation_runtime import stream_generate_with_tools
from sidecar.ai.routing.loop_events import StopEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult, StreamingEvent
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle


def _reader_threads() -> list[threading.Thread]:
    return [
        thread
        for thread in threading.enumerate()
        if thread.name == "router-stream-reader" and thread.is_alive()
    ]


def _join_readers(timeout_seconds: float = 2.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline and _reader_threads():
        time.sleep(0.01)


@pytest.fixture(autouse=True)
def _clean_reader_state() -> Iterator[None]:
    _join_readers(10.0)
    generation_runtime_stream._reset_zombie_reader_count_for_tests()
    with engine_liveness._state.lock:
        engine_liveness._state.last_activity_monotonic = None
        engine_liveness._state.active_generations = 0
    yield
    _join_readers()


class _TransportEngine:
    """Provider fake whose blocked read is released only by closing its transport."""

    def __init__(self, *, parent: TurnCancellationHandle | None = None) -> None:
        self._parent = parent
        self.handles: list[Any] = []
        self.child_registered_with_parent: list[bool] = []
        self.entered = threading.Event()
        self.transport_closed = threading.Event()
        self.generator_finished = threading.Event()
        self.block = True

    def stream_with_tools(self, **kwargs: Any):
        handle = kwargs.get("cancel_handle")
        self.handles.append(handle)
        if self._parent is not None:
            self.child_registered_with_parent.append(
                any(child is handle for child in self._parent._children)
            )
        if handle is not None:
            handle.register_cancel_callback(lambda _reason: self.transport_closed.set())
        return self._stream()

    def _stream(self):
        self.entered.set()
        try:
            if self.block:
                self.transport_closed.wait(timeout=5.0)
            else:
                yield StreamingEvent(kind="content", text="ok")
        finally:
            self.generator_finished.set()
        return GenerationResult(content="ok", finish_reason="stop")


def _call(engine: Any, runtime: LoopRuntime) -> Any:
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(temperature=0.0, reasoning_effort=None, feature_flags={}),
        _system_prompt_for_engine=str,
    )
    return stream_generate_with_tools(
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


def test_watchdog_timeout_closes_provider_transport_without_cancelling_the_turn() -> None:
    parent = TurnCancellationHandle(request_id="req-abort-watchdog")
    engine = _TransportEngine(parent=parent)
    events: list[object] = []
    runtime = LoopRuntime(
        request_id="req-abort-watchdog",
        emit=events.append,
        cancel_handle=parent,
        chunk_inactivity_seconds=0.05,
        model_load_grace_seconds=0.05,
    )

    try:
        result, _emitted = _call(engine, runtime)
        assert engine.entered.is_set()
        # The reader was released by the transport close, not by the 5 s fallback.
        assert engine.transport_closed.is_set()
        assert engine.generator_finished.wait(timeout=2.0)
        _join_readers()
        assert generation_runtime_stream.quarantined_reader_count() == 0
    finally:
        engine.transport_closed.set()

    assert result.finish_reason == "timeout"
    assert any(
        isinstance(event, StopEvent) and event.code == CMP_LOOP_ENGINE_STALLED
        for event in events
    )
    # A timeout is not a user cancellation: the turn's own handle is untouched.
    assert parent.cancelled is False
    # The provider got a stream-scoped child, which is detached on the way out.
    assert engine.handles[0] is not parent
    assert engine.child_registered_with_parent == [True]
    assert parent._children == []  # no public accessor for the child list


def test_user_cancel_still_reaches_the_provider_transport_callback() -> None:
    parent = TurnCancellationHandle(request_id="req-abort-user-cancel")
    engine = _TransportEngine(parent=parent)
    runtime = LoopRuntime(
        request_id="req-abort-user-cancel",
        emit=lambda _event: None,
        cancel_handle=parent,
        chunk_inactivity_seconds=5.0,
        model_load_grace_seconds=5.0,
    )
    canceller = threading.Thread(
        target=lambda: (engine.entered.wait(timeout=2.0), parent.cancel(reason="chat_cancelled"))
    )
    canceller.start()
    try:
        with pytest.raises(TerminalChatStateError):
            _call(engine, runtime)
    finally:
        engine.transport_closed.set()
        canceller.join(timeout=2.0)

    assert not canceller.is_alive()
    assert engine.transport_closed.is_set()
    assert parent.cancelled is True
    assert parent._children == []


def test_children_are_detached_after_each_generation() -> None:
    parent = TurnCancellationHandle(request_id="req-abort-detach")
    engine = _TransportEngine(parent=parent)
    engine.block = False
    runtime = LoopRuntime(
        request_id="req-abort-detach",
        emit=lambda _event: None,
        cancel_handle=parent,
        chunk_inactivity_seconds=5.0,
        model_load_grace_seconds=5.0,
    )

    for _ in range(2):
        result, _emitted = _call(engine, runtime)
        assert result.finish_reason == "stop"
        assert parent._children == []  # no public accessor for the child list

    assert engine.child_registered_with_parent == [True, True]


def test_runtime_without_a_cancel_handle_passes_none_to_the_provider() -> None:
    engine = _TransportEngine()
    engine.block = False
    runtime = LoopRuntime(
        request_id="req-abort-no-handle",
        emit=lambda _event: None,
        chunk_inactivity_seconds=5.0,
        model_load_grace_seconds=5.0,
    )

    result, _emitted = _call(engine, runtime)

    assert result.finish_reason == "stop"
    assert engine.handles == [None]
