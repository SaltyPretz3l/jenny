from __future__ import annotations

import threading
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.engines.admitted import (
    InferenceAttemptContext,
    InferenceAttemptOutcome,
    execute_admitted_provider_attempt,
)
from sidecar.ai.routing import generation_runtime_stream as streams
from sidecar.ai.routing.generation_runtime import stream_generate_with_tools
from sidecar.ai.routing.loop_events import (
    PhaseCompletedEvent,
    PhaseStartedEvent,
    ThinkingEvent,
    TokenDeltaEvent,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult, StreamingEvent
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle


class _NotificationFailure(RuntimeError):
    pass


class _Provider:
    def __init__(self, *, thinking_first: bool = False, blocked: bool = False) -> None:
        self.thinking_first = thinking_first
        self.blocked = blocked
        self.finalized = threading.Event()
        self.inside_next = threading.Event()
        self.release = threading.Event()
        self.aborted = threading.Event()

    def stream_with_tools(self, **kwargs: Any) -> Iterator[StreamingEvent]:
        handle = kwargs["cancel_handle"]
        handle.register_cancel_callback(lambda _reason: self.aborted.set())
        return self._generate()

    def _generate(self) -> Iterator[StreamingEvent]:
        try:
            for index in range(100):
                if self.blocked and index == 1:
                    self.inside_next.set()
                    assert self.release.wait(timeout=5.0), "test provider was not released"
                kind = "thinking" if self.thinking_first and index == 0 else "content"
                yield StreamingEvent(kind=kind, text=f"delta {index}. ")
            return GenerationResult(content="done", finish_reason="stop")
        finally:
            self.finalized.set()


class _ParentHandle(TurnCancellationHandle):
    def __init__(self, readers: list[Any], provider: _Provider) -> None:
        super().__init__(request_id="reader-ownership")
        self.readers = readers
        self.provider = provider
        self.retired_at_detach: list[bool] = []

    def detach_child(self, child: TurnCancellationHandle) -> bool:
        self.retired_at_detach.append(
            self.provider.finalized.is_set() and not self.readers[0].thread.is_alive()
        )
        return super().detach_child(child)


class _Lease:
    def __init__(self) -> None:
        self.outcomes: list[InferenceAttemptOutcome] = []

    def settle(self, outcome: InferenceAttemptOutcome) -> None:
        self.outcomes.append(outcome)


@pytest.fixture
def readers(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[Any]]:
    captured: list[Any] = []
    spawn = streams._spawn_stream_reader

    def capture(stream: Any) -> Any:
        reader = spawn(stream)
        captured.append(reader)
        return reader

    monkeypatch.setattr(streams, "_spawn_stream_reader", capture)
    try:
        yield captured
    finally:
        # Keep the red run isolated: assertions happen before this safety net.
        for reader in captured:
            reader.close()
            reader.join(timeout_seconds=2.0)
            reader.close()
            assert not reader.thread.is_alive(), "test leaked a provider reader"


def _call(provider: _Provider, runtime: LoopRuntime, lease: _Lease) -> Any:
    kernel = SimpleNamespace(
        _engine=provider,
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={"phase_events": True},
        ),
        _system_prompt_for_engine=str,
    )
    return execute_admitted_provider_attempt(
        admission=lambda _context: lease,
        context=InferenceAttemptContext(
            request_id=runtime.request_id,
            session_id="session",
            provider="fake",
            model="finite",
            request_source="chat_send",
            attempt=1,
            streaming=True,
        ),
        operation=lambda: stream_generate_with_tools(
            kernel,
            runtime=runtime,
            latest_user_content="hello",
            prompt_messages=[],
            max_tokens=128,
            reasoning_effort=None,
            prompt_cache_enabled=False,
            system_prompt="system",
            tool_schemas=[],
        ),
    )


@pytest.mark.parametrize(
    "event_type",
    [TokenDeltaEvent, PhaseStartedEvent, PhaseCompletedEvent, ThinkingEvent],
    ids=["token", "phase-start", "phase-end", "thinking"],
)
def test_notification_failure_retires_reader_before_detaching_child(
    readers: list[Any], event_type: type[Any],
) -> None:
    baseline = streams.live_stream_reader_count()
    provider = _Provider(thinking_first=event_type in (PhaseCompletedEvent, ThinkingEvent))
    parent = _ParentHandle(readers, provider)
    original = _NotificationFailure(f"backpressure on {event_type.__name__}")
    lease = _Lease()

    def emit(event: Any) -> None:
        if isinstance(event, event_type):
            assert readers, "notification failure must follow reader admission"
            assert parent._children, "provider child must still be attached"
            raise original

    runtime = LoopRuntime(
        request_id=parent.request_id,
        emit=emit,
        cancel_handle=parent,
        chunk_inactivity_seconds=2.0,
    )
    with pytest.raises(_NotificationFailure) as raised:
        _call(provider, runtime, lease)

    assert raised.value is original
    assert str(raised.value) == f"backpressure on {event_type.__name__}"
    assert provider.finalized.is_set(), "provider finally did not run"
    assert streams.live_stream_reader_count() == baseline
    assert not readers[0].thread.is_alive()
    assert parent.retired_at_detach == [True]
    assert parent._children == []
    assert not parent.cancelled
    assert provider.aborted.wait(timeout=1.0)
    assert lease.outcomes == [InferenceAttemptOutcome(status="failed", cleanup="confirmed")]


@pytest.mark.parametrize("log_raises", [False, True], ids=["logged", "broken-log"])
def test_notification_failure_quarantines_unretired_reader_and_preserves_error(
    readers: list[Any], monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture, log_raises: bool,
) -> None:
    baseline = streams.live_stream_reader_count()
    quarantined = streams.quarantined_reader_count()
    zombies = streams.zombie_reader_count()
    provider = _Provider(blocked=True)
    parent = _ParentHandle(readers, provider)
    original = _NotificationFailure("token transport backpressure")
    lease = _Lease()

    def emit(event: Any) -> None:
        if isinstance(event, TokenDeltaEvent):
            assert readers
            assert provider.inside_next.wait(timeout=1.0)
            raise original

    def broken_warning(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("cleanup log transport failed")

    if log_raises:
        monkeypatch.setattr(streams.logger, "warning", broken_warning)
    runtime = LoopRuntime(
        request_id=parent.request_id, emit=emit, cancel_handle=parent,
        chunk_inactivity_seconds=2.0,
    )
    try:
        with pytest.raises(_NotificationFailure) as raised:
            _call(provider, runtime, lease)
        assert raised.value is original
        assert str(raised.value) == "token transport backpressure"
        assert readers[0].thread.is_alive()
        assert streams.live_stream_reader_count() == baseline + 1
        assert streams.quarantined_reader_count() == quarantined + 1
        assert streams.zombie_reader_count() == zombies + 1
        assert provider.aborted.is_set()
        assert parent._children == []
        assert lease.outcomes == [InferenceAttemptOutcome(status="failed", cleanup="uncertain")]
        if not log_raises:
            assert any(
                getattr(record, "event", "") == "generation.stream_reader_cleanup_incomplete"
                for record in caplog.records
            )
    finally:
        provider.release.set()
        if readers:
            readers[0].close()
            readers[0].join(timeout_seconds=2.0)
            readers[0].close()
    assert provider.finalized.is_set()
    assert not readers[0].thread.is_alive()
    assert streams.live_stream_reader_count() == baseline
    assert streams.quarantined_reader_count() == quarantined


def test_cleanup_phase_notification_failure_preserves_cancellation(
    readers: list[Any],
) -> None:
    baseline = streams.live_stream_reader_count()
    provider = _Provider(thinking_first=True)
    parent = _ParentHandle(readers, provider)
    lease = _Lease()
    cleanup_attempted: list[object] = []

    def emit(event: Any) -> None:
        if isinstance(event, ThinkingEvent):
            parent.cancel(reason="chat_cancelled")
        if isinstance(event, PhaseCompletedEvent):
            cleanup_attempted.append(event)
            raise _NotificationFailure("cleanup phase backpressure")

    runtime = LoopRuntime(
        request_id=parent.request_id, emit=emit, cancel_handle=parent,
        chunk_inactivity_seconds=2.0,
    )
    with pytest.raises(TerminalChatStateError) as raised:
        _call(provider, runtime, lease)
    assert raised.value.status == "cancelled"
    assert str(raised.value) == "chat.send cancelled"
    assert cleanup_attempted
    assert provider.finalized.is_set()
    assert not readers[0].thread.is_alive()
    assert streams.live_stream_reader_count() == baseline
    assert parent.retired_at_detach == [True]
    assert lease.outcomes == [InferenceAttemptOutcome(status="failed", cleanup="confirmed")]


def test_blocked_abort_callback_marks_cleanup_uncertain_after_reader_exits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()
    marks: list[bool] = []
    monkeypatch.setattr(streams, "mark_provider_cleanup_uncertain", lambda: marks.append(True))
    monkeypatch.setattr(streams, "_STREAM_READER_SHUTDOWN_GRACE_SECONDS", 0.05)
    finished = threading.Thread(target=lambda: None)
    finished.start()
    finished.join()
    reader = SimpleNamespace(
        close=lambda: None,
        abort_transport=lambda: release.wait(5.0),
        join=lambda timeout_seconds: None,
        thread=finished,
        mark_quarantined_once=lambda: False,
    )
    try:
        streams._close_stream_reader(reader, runtime=SimpleNamespace(request_id="r"), reason="test")
        assert marks == [True], "a blocked abort callback must not read as confirmed cleanup"
    finally:
        release.set()


def test_prompt_abort_callback_keeps_cleanup_confirmed(monkeypatch: pytest.MonkeyPatch) -> None:
    marks: list[bool] = []
    monkeypatch.setattr(streams, "mark_provider_cleanup_uncertain", lambda: marks.append(True))
    finished = threading.Thread(target=lambda: None)
    finished.start()
    finished.join()
    reader = SimpleNamespace(
        close=lambda: None,
        abort_transport=lambda: None,
        join=lambda timeout_seconds: None,
        thread=finished,
        mark_quarantined_once=lambda: False,
    )
    streams._close_stream_reader(reader, runtime=SimpleNamespace(request_id="r"), reason="test")
    assert marks == []
