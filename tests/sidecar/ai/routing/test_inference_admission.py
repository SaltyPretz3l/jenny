from __future__ import annotations

import asyncio
import logging
import threading
import time
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.engines.admitted import (
    InferenceAdmissionDeferred,
    InferenceAdmissionRefused,
    InferenceAttemptContext,
    InferenceAttemptOutcome,
    execute_admitted_provider_attempt,
)
from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.routing import generation_runtime, retry
from sidecar.ai.routing.generation_runtime_stream import stream_generate_with_tools
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.retry import QUERY_SOURCE_CHAT_SEND, execute_with_provider_retry
from sidecar.ai.routing.sub_agent_invocation import _child_loop_runtime
from sidecar.runtime.chat_models import ChatRequestContext, TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle


class RecordingLease:
    def __init__(self, events: list[Any]) -> None:
        self.events = events
        self.outcomes: list[InferenceAttemptOutcome] = []

    def settle(self, outcome: InferenceAttemptOutcome) -> None:
        self.outcomes.append(outcome)
        self.events.append(("settle", outcome.status, outcome.cleanup))


def _unused_admission(_context: InferenceAttemptContext) -> None:
    return None


def _provider_error() -> ProviderHttpError:
    return ProviderHttpError(
        provider="ollama",
        status_code=503,
        code="CMP-CLOUD-TEST",
        message="provider unavailable",
        retryable=True,
        classification="server_error",
    )


def _execute(operation: Any, **overrides: Any) -> Any:
    options = {
        "operation": operation,
        "logger": logging.getLogger("test.inference_admission"),
        "component": "test.inference_admission",
        "event_prefix": "test.inference_admission.retry",
        "request_source": QUERY_SOURCE_CHAT_SEND,
        "provider": "ollama",
        "model": "trusted-model",
        "initial_max_tokens": 4096,
        "feature_flags": {"api_retry": True},
    }
    options.update(overrides)
    return execute_with_provider_retry(**options)


@pytest.mark.parametrize("ceilings", [None, (32768, 32768)])
def test_each_provider_retry_attempt_settles_before_backoff(
    monkeypatch: pytest.MonkeyPatch, ceilings,
) -> None:
    events: list[Any] = []
    leases: list[RecordingLease] = []
    contexts: list[InferenceAttemptContext] = []

    def admit(context: InferenceAttemptContext) -> dict[str, Any]:
        contexts.append(context)
        lease = RecordingLease(events)
        leases.append(lease)
        events.append(("admit", context.attempt))
        return {"status": "granted", "lease": lease}

    def operation(context: Any) -> str:
        events.append(("operation", context.attempt))
        if context.attempt == 1:
            raise _provider_error()
        return "ok"

    monkeypatch.setattr(
        retry,
        "_wait_retry_delay",
        lambda *_args, **_kwargs: events.append("backoff"),
    )
    runtime = LoopRuntime(
        request_id="request-1",
        session_id="session-1",
        inference_admission=admit,
    )

    assert _execute(operation, runtime=runtime, inference_token_ceilings=ceilings) == "ok"
    assert events == [
        ("admit", 1),
        ("operation", 1),
        ("settle", "failed", "confirmed"),
        "backoff",
        ("admit", 2),
        ("operation", 2),
        ("settle", "succeeded", "confirmed"),
    ]
    assert [context.attempt for context in contexts] == [1, 2]
    assert contexts[0] == InferenceAttemptContext(
        request_id="request-1",
        session_id="session-1",
        provider="ollama",
        model="trusted-model",
        request_source=QUERY_SOURCE_CHAT_SEND,
        attempt=1,
        streaming=False,
        input_token_ceiling=ceilings[0] if ceilings else None,
        output_token_ceiling=ceilings[1] if ceilings else None,
    )
    assert [(c.input_token_ceiling, c.output_token_ceiling) for c in contexts] == [
        ceilings or (None, None), ceilings or (None, None)]
    assert not hasattr(contexts[0], "prompt")
    assert not hasattr(contexts[0], "hostname")
    assert all(
        lease.outcomes[0].consumption == "unknown"
        and lease.outcomes[0].charge_consumption is True
        for lease in leases
    )


def test_missing_callback_preserves_one_shot_behavior_when_retry_is_disabled() -> None:
    calls: list[int] = []

    result = _execute(
        lambda context: calls.append(context.attempt) or "legacy",
        feature_flags={"api_retry": False},
    )

    assert result == "legacy"
    assert calls == [1]


def test_direct_callback_receives_explicit_request_identity() -> None:
    contexts: list[InferenceAttemptContext] = []
    lease = RecordingLease([])

    assert _execute(
        lambda _context: "vision",
        request_id="vision-request",
        session_id="vision-session",
        inference_admission=lambda context: contexts.append(context) or lease,
    ) == "vision"

    assert contexts[0].request_id == "vision-request"
    assert contexts[0].session_id == "vision-session"
    assert lease.outcomes == [
        InferenceAttemptOutcome(status="succeeded", cleanup="confirmed")
    ]


@pytest.mark.parametrize(
    ("status", "error_type"),
    [("waiting", InferenceAdmissionDeferred), ("rejected", InferenceAdmissionRefused)],
)
def test_waiting_and_rejected_admission_never_invoke_provider(
    status: str,
    error_type: type[Exception],
) -> None:
    with pytest.raises(error_type):
        _execute(
            lambda _context: pytest.fail("provider must not run without a lease"),
            inference_admission=lambda _context: {
                "status": status,
                "reason": f"capacity_{status}",
            },
        )


def test_one_retry_seam_does_not_double_account_nested_engine_calls() -> None:
    events: list[Any] = []
    lease = RecordingLease(events)

    class Engine:
        def generate(self) -> str:
            return self._request()

        def _request(self) -> str:
            events.append("provider")
            return "ok"

    assert _execute(
        lambda _context: Engine().generate(),
        inference_admission=lambda _context: events.append("admit") or lease,
    ) == "ok"
    assert events == ["admit", "provider", ("settle", "succeeded", "confirmed")]


def test_sync_stream_lease_lives_until_generator_close_and_settles_once() -> None:
    events: list[Any] = []
    lease = RecordingLease(events)

    def source() -> Any:
        try:
            yield "chunk"
            yield "later"
        finally:
            events.append("producer_closed")

    stream = _execute(
        lambda _context: source(),
        inference_admission=lambda _context: events.append("admit") or lease,
    )
    assert events == ["admit"]
    assert next(stream) == "chunk"
    assert events == ["admit"]

    stream.close()
    stream.close()

    assert events == [
        "admit",
        "producer_closed",
        ("settle", "cancelled", "confirmed"),
    ]
    assert len(lease.outcomes) == 1


def test_async_stream_cancellation_settles_after_producer_close() -> None:
    events: list[Any] = []
    lease = RecordingLease(events)

    async def source() -> Any:
        try:
            yield "chunk"
            yield "later"
        finally:
            events.append("producer_closed")

    async def scenario() -> None:
        stream = _execute(
            lambda _context: source(),
            inference_admission=lambda _context: events.append("admit") or lease,
        )
        assert await anext(stream) == "chunk"
        assert events == ["admit"]
        await stream.aclose()
        await stream.aclose()

    asyncio.run(scenario())
    assert events == [
        "admit",
        "producer_closed",
        ("settle", "cancelled", "confirmed"),
    ]
    assert len(lease.outcomes) == 1


def test_cancelled_async_iteration_closes_producer_before_settlement() -> None:
    events: list[Any] = []
    lease = RecordingLease(events)

    async def source() -> Any:
        try:
            yield "chunk"
            await asyncio.Event().wait()
        finally:
            events.append("producer_closed")

    async def scenario() -> None:
        stream = _execute(
            lambda _context: source(),
            inference_admission=lambda _context: events.append("admit") or lease,
        )
        assert await anext(stream) == "chunk"
        pending = asyncio.create_task(anext(stream))
        await asyncio.sleep(0)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending

    asyncio.run(scenario())
    assert events == [
        "admit",
        "producer_closed",
        ("settle", "cancelled", "confirmed"),
    ]


def test_stream_without_close_reports_uncertain_cleanup() -> None:
    events: list[Any] = []
    lease = RecordingLease(events)

    class UncloseableIterator:
        def __iter__(self) -> UncloseableIterator:
            return self

        def __next__(self) -> str:
            return "chunk"

    stream = _execute(
        lambda _context: UncloseableIterator(),
        inference_admission=lambda _context: lease,
    )
    assert next(stream) == "chunk"
    stream.close()

    assert lease.outcomes == [
        InferenceAttemptOutcome(status="cancelled", cleanup="uncertain")
    ]


@pytest.mark.parametrize("required", [False, True])
def test_compaction_runtime_inherits_parent_inference_admission(
    monkeypatch: pytest.MonkeyPatch, required,
) -> None:
    def callback(_context):
        return None
    callback.requires_budget = required
    captured: list[Any] = []
    kernel = SimpleNamespace(
        _engine=SimpleNamespace(get_inference_budget_context_length=lambda: 32768),
        _config=SimpleNamespace(
            engine_type="ollama",
            model="local",
            feature_flags={},
        )
    )
    monkeypatch.setattr(
        generation_runtime,
        "execute_with_provider_retry",
        lambda **kwargs: captured.append(kwargs) or SimpleNamespace(content="ok"),
    )

    generate = generation_runtime.build_compaction_generate_fn(
        kernel,
        request_id="request-compact",
        max_tokens=512,
        prompt_cache_enabled=False,
        runtime=LoopRuntime(inference_admission=callback),
    )

    assert generate([]) == "ok"
    assert captured[0]["runtime"].inference_admission is callback
    assert captured[0]["inference_token_ceilings"] == ((32768, 32768) if required else None)


@pytest.mark.parametrize("required", [False, True])
def test_fallback_runtime_inherits_parent_inference_admission(
    monkeypatch: pytest.MonkeyPatch, required,
) -> None:
    events: list[Any] = []
    lease = RecordingLease(events)

    def callback(context: InferenceAttemptContext) -> RecordingLease:
        events.append(("admit", context.provider))
        assert (context.input_token_ceiling, context.output_token_ceiling) == (
            (65536, 65536) if required else (None, None))
        return lease
    callback.requires_budget = required
    captured: list[Any] = []
    fallback_model = SimpleNamespace(
        engine_type="ollama",
        model="fallback",
        max_context_tokens=None,
    )
    fallback_config = SimpleNamespace(
        engine_type="ollama",
        model="fallback",
        fallback_models=(),
        max_tokens=128,
        resolved_user_max_output_tokens=None,
    )
    fallback_engine = SimpleNamespace(
        get_inference_budget_context_length=lambda: 65536,
        get_model_max_output_tokens=lambda: 512,
        close=lambda: None,
    )
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            engine_type="ollama",
            model="primary",
            fallback_models=(fallback_model,),
        ),
        _engine_messages=[],
        _engine=SimpleNamespace(),
        _system_prompt_for_engine=str,
    )
    monkeypatch.setattr(generation_runtime, "_dataclass_replace", lambda *_args, **_kwargs: fallback_config)
    monkeypatch.setattr(
        generation_runtime,
        "_create_engine",
        lambda _config: SimpleNamespace(engine=fallback_engine, fallback_from=None),
    )
    monkeypatch.setattr(
        generation_runtime._vision_turn,
        "engine_messages_with_vision_degradation",
        lambda *_args, **_kwargs: [],
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.preview_vision.prepare_preview_messages",
        lambda _kernel, _runtime, messages, **kwargs: (messages, kwargs["max_tokens"]),
    )
    monkeypatch.setattr(
        generation_runtime,
        "stream_generate_with_tools",
        lambda _kernel, **kwargs: captured.append(kwargs["runtime"]) or ("ok", set()),
    )

    result = generation_runtime.attempt_fallback_generation(
        kernel,
        original_error=_provider_error(),
        latest_user_content="hello",
        working_messages=[],
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system_prompt="system",
        tool_schemas=[],
        runtime=LoopRuntime(inference_admission=callback),
    )

    assert result is not None
    assert captured[0].inference_admission is callback
    assert events == [
        ("admit", "ollama"),
        ("settle", "succeeded", "confirmed"),
    ]


def test_child_runtime_refuses_an_unbindable_parent_admission() -> None:
    callback = _unused_admission
    child_context = ChatRequestContext(
        request_id="child-request",
        trace_id="trace",
        session_id="session",
        mode="chat",
        approvals_pre_granted=False,
    )

    child = _child_loop_runtime(
        parent_runtime=LoopRuntime(inference_admission=callback),
        child_context=child_context,
        child_cancel=TurnCancellationHandle("child-request"),
        max_runtime_ms=None,
    )

    assert child.inference_admission is not callback
    assert child.inference_admission is not None
    with pytest.raises(InferenceAdmissionRefused, match="child_binding_unavailable"):
        child.inference_admission(
            InferenceAttemptContext(
                request_id="child-request",
                session_id="session",
                provider="ollama",
                model="model",
                request_source="chat_send",
                attempt=1,
                streaming=True,
            )
        )


class _UncooperativeProviderStream:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def __iter__(self):
        return self

    def __next__(self):
        self.started.set()
        self.release.wait(timeout=2.0)
        raise StopIteration

    def close(self) -> None:
        return None


def test_quarantined_provider_reader_settles_cleanup_as_uncertain() -> None:
    stream = _UncooperativeProviderStream()
    lease = RecordingLease([])
    kernel = SimpleNamespace(
        _engine=SimpleNamespace(stream_with_tools=lambda **_kwargs: stream),
        _config=SimpleNamespace(
            engine_type="ollama",
            model="model",
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
        ),
        _system_prompt_for_engine=str,
    )
    runtime = LoopRuntime(
        request_id="request-quarantine",
        session_id="session",
        wall_clock_deadline=time.monotonic() + 0.03,
        chunk_inactivity_seconds=5.0,
        model_load_grace_seconds=5.0,
    )

    try:
        with pytest.raises(TerminalChatStateError, match="working-time limit"):
            execute_admitted_provider_attempt(
                admission=lambda _context: lease,
                context=InferenceAttemptContext(
                    request_id=runtime.request_id,
                    session_id=runtime.session_id,
                    provider="ollama",
                    model="model",
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
        assert stream.started.is_set()
        assert lease.outcomes == [
            InferenceAttemptOutcome(status="failed", cleanup="uncertain")
        ]
    finally:
        stream.release.set()
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline and any(
            thread.name == "router-stream-reader" and thread.is_alive()
            for thread in threading.enumerate()
        ):
            time.sleep(0.01)
