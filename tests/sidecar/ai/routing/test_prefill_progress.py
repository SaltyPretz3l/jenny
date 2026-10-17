"""Transient measured progress must never become output, history, or a heartbeat."""
from types import SimpleNamespace

from sidecar.ai.engines.engine_events import EngineEvent, PrefillProgress
from sidecar.ai.routing.prefill_progress import PrefillStatus
from sidecar.runtime.chat_serialization import _serialize_loop_event


def event(state="sample", sequence=2, attempt="a" * 32, **counts):
    total, cache, processed = (counts.get("total", 10000), counts.get("cache", 0),
                               counts.get("processed", 0))
    return EngineEvent(kind="prefill", prefill_state=state, attempt_id=attempt, sequence=sequence,
                       prefill=PrefillProgress(total, cache, processed) if state == "sample" else None)


def setup():
    emitted = []
    return PrefillStatus(SimpleNamespace(emit=emitted.append), "think_req_iter1"), emitted


def test_coalesces_latest_at_four_hz_and_preserves_wire_scope_without_history():
    status, emitted = setup()
    status.accept(event("start", 1), 0)
    for index in range(100):
        assert status.accept(event(sequence=index + 2, processed=index * 10), index / 100) == (True, index > 0)
    samples = [item for item in emitted if item.progress["state"] == "sample"]
    assert len(samples) == 4
    assert samples[-1].progress["processed_tokens"] == 750
    assert status.wait_timeout(0.99, 60) < 0.011
    status.flush(1.0)
    assert emitted[-1].progress["processed_tokens"] == 990
    wire = _serialize_loop_event(emitted[-1], "request", trace_id="trace", session_id="session")
    assert wire["params"]["session_id"] == "session"
    assert wire["params"]["request_id"] == "request"
    assert wire["params"]["persist"] is False
    assert wire["params"]["kind"] == "status"


def test_cached_short_request_is_suppressed_and_pending_is_dropped_on_output():
    status, emitted = setup()
    status.accept(event("start", 1), 0)
    status.accept(event(total=10000, cache=9999, processed=9999), 0.015)
    status.accept(event(sequence=3, total=10000, cache=9999, processed=10000), 0.104)
    assert len(emitted) == 1
    assert status.accept(EngineEvent(kind="text_delta", text="answer"), 0.105) == (False, False)
    status.flush(2)
    assert len(emitted) == 2 and emitted[-1].progress["state"] == "unavailable"
    assert status.accept(event(sequence=4), 3) == (True, False)


def test_retry_rejects_old_attempt_and_invalidation_never_extends_liveness():
    status, emitted = setup()
    status.accept(event("start", 1), 0)
    status.accept(event(processed=100), 0.1)
    status.accept(event("start", 1, attempt="b" * 32), 0.2)
    assert status.accept(event(sequence=3, processed=500), 0.3) == (True, False)
    assert status.accept(event("start", 1), 0.4) == (True, False)
    assert status.accept(event("unavailable", 2, attempt="b" * 32), 0.5) == (True, False)
    assert emitted[-1].progress["state"] == "unavailable"
    assert status.accept(event(sequence=3, attempt="b" * 32), 0.6) == (True, False)


def test_failed_or_cancelled_attempt_retires_visible_progress_before_quiet_retry():
    status, emitted = setup()
    status.accept(event("start", 1), 0)
    status.accept(event(processed=2000), 0.1)
    status.accept(event(sequence=3, processed=4000), 0.2)
    status.finish()
    retired = emitted[-1].progress
    assert retired["state"] == "unavailable"
    assert retired["attempt_id"] == "a" * 32 and retired["sequence"] == 4
    before = len(emitted)
    status.finish()
    status.flush(10)
    assert len(emitted) == before


def test_real_stream_failure_retires_before_exception_reaches_retry_owner():
    import pytest

    from sidecar.ai.routing.generation_runtime import stream_generate_with_tools
    from sidecar.ai.routing.loop_runtime import LoopRuntime

    class FailingEngine:
        def stream_with_tools(self, **_kwargs):
            yield event("start", 1)
            yield event(processed=2000)
            raise RuntimeError("provider disconnected")

    events = []
    kernel = SimpleNamespace(_engine=FailingEngine(),
        _config=SimpleNamespace(temperature=0.0, reasoning_effort=None, feature_flags={}),
        _system_prompt_for_engine=str)
    runtime = LoopRuntime(emit=events.append, request_id="req_prefill_failure", streaming=True,
                          chunk_inactivity_seconds=0.5)
    with pytest.raises(RuntimeError, match="provider disconnected"):
        stream_generate_with_tools(kernel, runtime=runtime, latest_user_content="Read.",
            prompt_messages=[], max_tokens=128, reasoning_effort=None, prompt_cache_enabled=False,
            system_prompt="You are Jenny.", tool_schemas=[])
    progress = [item.progress for item in events if getattr(item, "progress", None)]
    assert [item["state"] for item in progress] == ["start", "sample", "unavailable"]
    assert progress[-1]["sequence"] > progress[-2]["sequence"]


def test_progress_before_the_first_token_keeps_the_first_token_window():
    import time

    from sidecar.ai.routing.generation_runtime import stream_generate_with_tools
    from sidecar.ai.routing.loop_runtime import LoopRuntime
    from sidecar.ai.tools.models import GenerationResult, StreamingEvent

    class Engine:
        def stream_with_tools(self, **_kwargs):
            yield event("start", 1)
            yield event(processed=2000)
            time.sleep(1.0)
            yield StreamingEvent(kind="content", text="hi")
            return GenerationResult(content="hi", finish_reason="stop")

    kernel = SimpleNamespace(_engine=Engine(), _system_prompt_for_engine=str,
                             _config=SimpleNamespace(temperature=0.0, reasoning_effort=None,
                                                     feature_flags={}))
    runtime = LoopRuntime(emit=lambda _event: None, request_id="req_window", streaming=True,
                          chunk_inactivity_seconds=0.5, model_load_grace_seconds=3.0)
    result, _types = stream_generate_with_tools(
        kernel, runtime=runtime, latest_user_content="Read.", prompt_messages=[],
        max_tokens=128, reasoning_effort=None, prompt_cache_enabled=False,
        system_prompt="You are Jenny.", tool_schemas=[])
    assert result.finish_reason == "stop"
