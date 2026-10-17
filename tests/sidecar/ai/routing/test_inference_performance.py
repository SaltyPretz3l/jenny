"""Deterministic consumer cadence and terminal cleanup across physical attempts."""

from dataclasses import replace
from types import SimpleNamespace

import pytest

from sidecar.ai.engines.engine_events import ENGINE_EVENT_INFERENCE_PERFORMANCE, EngineEvent
from sidecar.ai.engines.provider_metrics import ProviderMetrics
from sidecar.ai.routing.inference_performance import GenerationStatus, InferencePerformanceStatus


def _status():
    now, emitted = [0.0], []
    runtime = SimpleNamespace(
        request_id="request", logical_turn_id="turn", emit_safe=emitted.append
    )
    return InferencePerformanceStatus(runtime, clock=lambda: now[0]), now, emitted


def _event(sample, sequence, phase="decode", generated=1):
    return EngineEvent(
        kind=ENGINE_EVENT_INFERENCE_PERFORMANCE,
        performance=replace(
            sample,
            sequence=sequence,
            phase=phase,
            generated_tokens=generated,
        ),
    )


def test_four_per_second_latest_cumulative_wins():
    status, now, emitted = _status()
    start = ProviderMetrics(provider_kind="ninfer", live=True).start_events()[0]
    status.accept(start)
    sample = start.performance
    status.accept(_event(sample, 1))  # phase transition is immediate
    for sequence in range(2, 102):
        now[0] = sequence / 1000
        status.accept(_event(sample, sequence, generated=sequence))
    assert len(emitted) == 2
    now[0] = 0.25
    status.flush()
    assert emitted[-1].observation.generated_tokens == 101
    for index in range(1, 4):
        now[0] = 0.25 + index * 0.25
        status.accept(_event(sample, 101 + index, generated=101 + index))
    assert len(emitted) == 6  # waiting + decode transitions and four timed samples
    assert [event.observation.sequence for event in emitted] == list(range(6))


def test_immediate_phase_and_terminal_transitions():
    status, _, emitted = _status()
    start = ProviderMetrics(provider_kind="ninfer", live=True).start_events()[0]
    status.accept(start)
    for sequence, phase in enumerate(("prefill", "decode", "finished"), 1):
        status.accept(_event(start.performance, sequence, phase))
    assert [event.observation.phase for event in emitted] == [
        "waiting",
        "prefill",
        "decode",
        "finished",
    ]
    status.finish()
    assert len(emitted) == 4


@pytest.mark.parametrize("phase", ["finished", "failed", "cancelled"])
def test_finish_once_keeps_latest_pending(phase):
    status, _, emitted = _status()
    start = ProviderMetrics(provider_kind="ninfer", live=True).start_events()[0]
    status.accept(start)
    status.accept(_event(start.performance, 1))
    status.accept(_event(start.performance, 2, generated=40))
    status.finish(phase)
    status.finish("failed")
    status.flush(100)
    assert [event.observation.phase for event in emitted] == ["waiting", "decode", phase]
    assert emitted[-1].observation.generated_tokens == 40


def test_new_attempt_resets_sequence_and_rejects_retired_samples():
    status, _, emitted = _status()
    first, second = (ProviderMetrics().start_events()[0] for _ in range(2))
    status.accept(first)
    status.finish()
    status.accept(second)
    status.accept(_event(first.performance, 100))
    assert emitted[-1].observation.attempt_id == second.performance.attempt_id
    assert emitted[-1].observation.sequence == 0
    status.finish("cancelled")
    assert emitted[-1].observation.sequence == 1


@pytest.mark.parametrize(
    "reason,cancelled,phase",
    [
        ("provider_terminal", False, "finished"),
        ("provider_failure", False, "failed"),
        ("request_interrupted", True, "cancelled"),
        ("provider_stalled", False, "failed"),
    ],
)
def test_generation_cleanup_paths(reason, cancelled, phase):
    emitted = []
    runtime = SimpleNamespace(
        request_id="request",
        emit_safe=emitted.append,
        emit=lambda _: None,
        cancel_handle=SimpleNamespace(cancelled=cancelled),
    )
    status = GenerationStatus(runtime, "thinking")
    status.accept(ProviderMetrics().start_events()[0], 0)
    terminal = type("_StreamTerminal", (), {"result": SimpleNamespace(finish_reason="stop")})()
    if reason == "provider_terminal":
        status.accept(terminal, 0)
    status.finish(reason)
    status.finish(reason)
    assert [event.observation.phase for event in emitted] == ["waiting", phase]


def test_metric_frames_do_not_retire_llama_prefill():
    runtime = SimpleNamespace(request_id="request", emit_safe=lambda _: None, emit=lambda _: None)
    status = GenerationStatus(runtime, "thinking")
    status.prefill.active = True
    status.accept(ProviderMetrics().start_events()[0], 0)
    assert status.prefill.active


def test_failed_subscriber_does_not_fail_generation():
    status = InferencePerformanceStatus(
        SimpleNamespace(
            emit_safe=lambda _: (_ for _ in ()).throw(RuntimeError("subscriber failed")),
        )
    )
    assert status.accept(ProviderMetrics().start_events()[0])
    status.finish()
