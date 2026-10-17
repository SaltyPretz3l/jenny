"""Pinned llama-server progress is data, never generated output or terminal proof."""

from types import SimpleNamespace

import pytest

from sidecar.ai.engines.vllm_sse_stream import LlamaPrefillStream, has_generated_delta


def stream(enabled=True, limit=16384):
    return LlamaPrefillStream(
        SimpleNamespace(
            _prefill_progress_enabled=enabled,
            get_configured_context_length=lambda: limit,
        )
    )


def chunk(total=10312, cache=0, processed=0, time_ms=0):
    return {
        "prompt_progress": {
            "total": total,
            "cache": cache,
            "processed": processed,
            "time_ms": time_ms,
        },
        "choices": [{"delta": {"role": "assistant", "content": None}, "finish_reason": None}],
    }


def test_only_qualified_stream_requests_opt_in_and_start_with_unique_attempts():
    for enabled, limit in [(False, 16384), (True, None), (True, 0)]:
        parser = stream(enabled, limit)
        payload = {"stream": True}
        parser.configure_request(payload)
        assert payload == {"stream": True}
        assert parser.start_events() == []
        assert parser.feed(chunk()) == []
    first, second = stream(), stream()
    payload = {"stream": True}
    first.configure_request(payload)
    assert payload["return_progress"] is True
    assert first.start_events()[0].prefill_state == "start"
    assert first.attempt_id != second.attempt_id


def test_cold_cached_and_missing_time_samples_preserve_counter_meaning():
    parser = stream()
    initial = parser.feed(chunk())[0]
    final = parser.feed(chunk(processed=10312, time_ms=2888))[0]
    assert initial.prefill.processed_tokens == 0
    assert final.prefill.total_tokens == final.prefill.processed_tokens == 10312
    assert final.sequence > initial.sequence
    cached = stream()
    sample = chunk(cache=10311, processed=10311)
    del sample["prompt_progress"]["time_ms"]
    event = cached.feed(sample)[0]
    assert event.prefill.cached_tokens == 10311 and event.prefill.elapsed_ms is None
    assert stream().feed(chunk(cache=10312, processed=10312))[0].prefill.cached_tokens == 10312


@pytest.mark.parametrize(
    "patch",
    [
        {"total": True},
        {"total": 16385},
        {"total": 0},
        {"total": "12"},
        {"processed": -1},
        {"processed": 10313},
        {"processed": 1.5},
        {"cache": 1},
        {"time_ms": float("nan")},
        {"time_ms": float("inf")},
        {"time_ms": -1},
        {"time_ms": True},
    ],
)
def test_bad_sample_invalidates_only_progress_and_never_reenables(patch):
    parser = stream()
    parser.feed(chunk())
    bad = chunk()
    bad["prompt_progress"].update(patch)
    invalid = parser.feed(bad)
    assert len(invalid) == 1 and invalid[0].prefill_state == "unavailable"
    assert parser.feed(chunk(processed=500)) == []


@pytest.mark.parametrize(
    "next_sample",
    [
        chunk(processed=99, time_ms=101),
        chunk(total=10311, processed=101, time_ms=101),
        chunk(cache=1, processed=101, time_ms=101),
        chunk(processed=101, time_ms=99),
    ],
)
def test_regressing_or_changed_attempt_counters_fail_closed(next_sample):
    parser = stream()
    parser.feed(chunk(processed=100, time_ms=100))
    assert parser.feed(next_sample)[0].prefill_state == "unavailable"


def test_duplicate_heartbeats_do_not_create_progress_events():
    parser = stream()
    parser.feed(chunk(processed=100, time_ms=100))
    assert parser.feed(chunk(processed=100, time_ms=200)) == []
    assert parser.feed(chunk(processed=101, time_ms=201))[0].prefill.processed_tokens == 101


def test_mixed_content_survives_and_late_progress_after_output_is_ignored():
    parser = stream()
    mixed = chunk(processed=10312, time_ms=2888)
    mixed["choices"][0]["delta"]["content"] = "visible"
    assert parser.feed(mixed)[0].prefill.processed_tokens == 10312
    assert mixed["choices"][0]["delta"]["content"] == "visible"
    assert has_generated_delta(mixed)
    assert parser.feed(chunk(processed=10312, time_ms=3000)) == []
    assert not has_generated_delta(chunk())
    assert has_generated_delta({"choices": [{"delta": {"reasoning_content": "thinking"}}]})
    assert has_generated_delta(
        {"choices": [{"delta": {"tool_calls": [{"function": {"arguments": "{"}}]}}]}
    )
    assert not has_generated_delta({"choices": [{"delta": {"tool_calls": [{"id": "server-id"}]}}]})


def test_hidden_generated_reasoning_retires_the_attempt_once():
    adapter = stream()
    adapter.start_events()
    assert [e.prefill_state for e in adapter.feed(chunk(processed=10312))] == ["sample"]
    hidden = {"choices": [{"delta": {"reasoning_content": "step"}, "finish_reason": None}]}
    assert [e.prefill_state for e in adapter.feed(hidden)] == ["unavailable"]
    assert adapter.feed(hidden) == []
