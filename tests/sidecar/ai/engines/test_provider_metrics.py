"""Physical-attempt metrics: provider counters, never character estimates."""

import json
from pathlib import Path

import pytest

from sidecar.ai.engines.provider_metrics import ProviderMetrics


def test_think_off_timings_without_usage():
    metrics = ProviderMetrics(provider_kind="ninfer", live=True, clock=lambda: 1.0)
    for line in (Path(__file__).parent / "fixtures/ninfer/think_off.sse").read_text().splitlines():
        if line.startswith("data: {"):
            metrics.feed(json.loads(line[6:]))
    sample = metrics.finish().performance
    assert sample.generated_tokens == 8
    assert sample.decode_interval_tokens == 7
    assert sample.terminal_decode_tps == pytest.approx(124.18, abs=0.01)
    assert sample.prompt_tokens == 18
    assert sample.cached_prompt_tokens == 0
    assert sample.prefill_elapsed_ms is None


def test_progress_bad_field_stays_null_for_attempt():
    metrics = ProviderMetrics(provider_kind="ninfer", live=True)
    metrics.feed({"prompt_progress": {"total": 100, "cache": 20, "processed": 30, "time_ms": 5}})
    metrics.feed({"prompt_progress": {"total": 100, "cache": 20, "processed": 29, "time_ms": 6}})
    sample = metrics.feed(
        {
            "prompt_progress": {
                "total": 100,
                "cache": 20,
                "processed": 90,
                "time_ms": 7,
            }
        }
    )[-1].performance
    assert sample.processed_prompt_tokens is None
    assert sample.prefill_elapsed_ms == 7


@pytest.mark.parametrize("bad", [-1, 1_048_577, 1.5, True, "3", float("nan")])
def test_invalid_token_ranges(bad):
    metrics = ProviderMetrics(provider_kind="ninfer", live=True)
    metrics.feed({"timings": {"predicted_n": bad, "predicted_ms": 3}})
    metrics.feed({"timings": {"predicted_n": 4, "predicted_ms": 4}})
    sample = metrics.finish().performance
    assert sample.generated_tokens is None
    assert sample.decode_interval_tokens is None
    assert sample.decode_elapsed_ms == 4


@pytest.mark.parametrize(
    "delta",
    [
        {"content": "x"},
        {"reasoning_content": "x"},
        {"tool_calls": [{"function": {"arguments": "{"}}]},
    ],
)
def test_ttft_uses_dispatch_and_first_generated_delta(delta):
    now = [10.0]
    metrics = ProviderMetrics(provider_kind="ninfer", live=True, clock=lambda: now[0])
    metrics.feed({"choices": [{"delta": {"role": "assistant"}}]})
    now[0] = 10.125
    sample = metrics.feed({"choices": [{"delta": delta}]})[-1].performance
    assert sample.time_to_first_generated_token_ms == 125
    now[0] = 12
    assert metrics.finish().performance.time_to_first_generated_token_ms == 125


@pytest.mark.parametrize(
    "garbage",
    [
        None,
        [],
        "bad",
        5,
        {"timings": []},
        {
            "prompt_progress": {"total": {}, "processed": [], "time_ms": object()},
            "choices": [None, {"delta": []}],
        },
    ],
)
def test_garbage_never_raises(garbage):
    metrics = ProviderMetrics()
    metrics.feed(garbage)
    assert metrics.finish().performance.phase == "finished"


@pytest.mark.parametrize("bad", [-1, 86_400_001, float("nan"), float("inf"), True, "2"])
def test_invalid_or_regressing_duration_is_null_for_attempt(bad):
    metrics = ProviderMetrics(provider_kind="ninfer", live=True)
    metrics.feed({"timings": {"predicted_n": 4, "predicted_ms": 10}})
    metrics.feed({"timings": {"predicted_ms": bad}})
    metrics.feed({"timings": {"predicted_ms": 20}})
    sample = metrics.finish().performance
    assert sample.decode_elapsed_ms is None
    assert sample.terminal_decode_tps is None
    assert sample.generated_tokens == 4


@pytest.mark.parametrize(
    "raw,field",
    [
        ({"total": 10, "cache": 11, "processed": 11}, "cached_prompt_tokens"),
        ({"total": 10, "cache": 3, "processed": 2}, "processed_prompt_tokens"),
        ({"total": 10, "cache": 3, "processed": 11}, "processed_prompt_tokens"),
        ({"total": 1_048_577, "cache": 0, "processed": 0}, "prompt_tokens"),
    ],
)
def test_progress_relationship_and_range_checks(raw, field):
    metrics = ProviderMetrics(provider_kind="ninfer", live=True)
    metrics.feed({"prompt_progress": raw})
    metrics.feed({"prompt_progress": {"total": 20, "cache": 4, "processed": 15}})
    assert getattr(metrics.finish().performance, field) is None


def test_ollama_terminal_uses_ns_and_never_claims_cached_or_total_prompt():
    now = [1.0]
    metrics = ProviderMetrics(provider_kind="ollama", clock=lambda: now[0])
    metrics.start_events()
    metrics.feed_ollama({"message": {"role": "assistant"}})
    now[0] = 1.125
    metrics.feed_ollama({"message": {"thinking": "reasoning"}})
    metrics.ollama_done(
        {
            "eval_count": 8,
            "eval_duration": 56_368_100,
            "prompt_eval_count": 18,
            "prompt_eval_duration": 96_035_000,
        }
    )
    sample = metrics.finish().performance
    assert sample.generated_tokens == 8 and sample.decode_interval_tokens == 7
    assert sample.decode_elapsed_ms == 56.3681
    assert sample.terminal_decode_tps == pytest.approx(124.18, abs=0.01)
    assert sample.terminal_prefill_tps == pytest.approx(18 / 96.035 * 1000)
    assert sample.prompt_tokens is None and sample.cached_prompt_tokens is None
    assert sample.time_to_first_generated_token_ms == 125


@pytest.mark.parametrize("provider", ["llama-server", "ollama", "other"])
def test_other_providers_have_no_live_phases(provider):
    metrics = ProviderMetrics(provider_kind=provider, live=True)
    events = metrics.start_events()
    events += metrics.feed({"prompt_progress": {"total": 18, "cache": 0, "processed": 8}})
    events += metrics.feed({"choices": [{"delta": {"content": "x"}}]})
    assert all(event.performance.phase == "waiting" for event in events)
    assert metrics.finish().performance.phase == "finished"


def test_nonstream_body_measures_first_generated_output():
    now = [10.0]
    metrics = ProviderMetrics(clock=lambda: now[0])
    now[0] = 10.5
    metrics.feed(
        {
            "choices": [{"message": {"content": "x"}}],
            "timings": {"predicted_n": 8, "predicted_ms": 56.3681},
        },
        non_stream=True,
    )
    sample = metrics.finish().performance
    assert sample.time_to_first_generated_token_ms == 500
    assert sample.generated_tokens == 8


def test_unmeasured_deltas_never_refresh_the_metric_observation():
    metrics = ProviderMetrics(provider_kind="ninfer", live=True)
    assert metrics.feed({"choices": [{"delta": {"content": "first"}}]})
    assert metrics.feed({"choices": [{"delta": {"content": "second"}}]}) == []
    assert metrics.feed({"choices": [], "timings": {"predicted_n": 2, "predicted_ms": 1}})
    assert metrics.feed({"choices": [], "timings": {"predicted_n": 2, "predicted_ms": 1}}) == []


def test_invalid_prompt_component_nulls_a_derived_total():
    metrics = ProviderMetrics(provider_kind="ninfer", live=True)
    metrics.feed({"timings": {"prompt_n": 18, "cache_n": 0}})
    metrics.feed({"timings": {"prompt_n": 17, "cache_n": 0}})
    assert metrics.finish().performance.prompt_tokens is None


@pytest.mark.parametrize(
    "raw",
    [
        None,
        False,
        [],
        "bad",
        {},
        {"live": True},
        {
            "live": 1,
            "provider_kind": "ninfer",
        },
        {"live": True, "provider_kind": "unknown"},
        {
            "live": True,
            "provider_kind": "ninfer",
            "extra": True,
        },
    ],
)
def test_chat_send_ignores_invalid_closed_metrics_field(raw):
    from sidecar.runtime.chat_models import inference_performance_from_params

    assert inference_performance_from_params({"inference_performance": raw}) is None


@pytest.mark.parametrize("provider", ["ninfer", "llama-server", "ollama", "other"])
@pytest.mark.parametrize("live", [False, True])
def test_chat_send_accepts_and_copies_the_closed_metrics_field(provider, live):
    from sidecar.runtime.chat_models import inference_performance_from_params

    raw = {"live": live, "provider_kind": provider}
    normalized = inference_performance_from_params({"inference_performance": raw})
    assert normalized == raw
    assert normalized is not raw
