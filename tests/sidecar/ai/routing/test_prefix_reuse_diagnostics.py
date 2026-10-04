"""The prefix meter pairs the client divergence verdict with the server's reused tokens."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.context import prefix_stability as ps
from sidecar.ai.routing import generation_diagnostics as gd
from sidecar.ai.routing.generation_runtime import generate_step
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore


def _turn(usage: dict[str, int], *, source: str, prefill_ms: int | None = 480) -> dict[str, Any]:
    snapshot: dict[str, Any] = {
        "provider_usage_source": source,
        "provider_calls": [{"ordinal": 1, "purpose": "turn", "usage": usage}],
    }
    if prefill_ms is not None:
        snapshot["provider_prompt_eval_duration_ms"] = prefill_ms
    return snapshot


class TestServerPrefixReading:
    def test_llama_server_split_is_provider_truth(self) -> None:
        reading = gd.server_prefix_reading(
            _turn(
                {"prompt_eval_count": 8467, "cached_tokens": 8347, "prompt_tokens_evaluated": 120},
                source="openai-compatible",
            )
        )

        assert reading["prompt_tokens"] == 8467
        assert reading["reused_tokens"] == 8347
        assert reading["evaluated_tokens"] == 120
        assert reading["reuse_ratio"] == pytest.approx(0.9858, abs=1e-4)
        assert reading["ratio_basis"] == "provider"
        assert reading["prefill_ms"] == 480
        assert reading["purpose"] == "turn"

    def test_timings_split_wins_over_a_disagreeing_usage_total(self) -> None:
        reading = gd.server_prefix_reading(
            _turn(
                {"prompt_eval_count": 120, "cached_tokens": 8347, "prompt_tokens_evaluated": 120},
                source="openai-compatible",
            )
        )

        assert reading["prompt_tokens"] == 8467
        assert reading["usage_prompt_tokens"] == 120

    def test_openai_cached_tokens_derive_the_evaluated_count(self) -> None:
        reading = gd.server_prefix_reading(
            _turn({"prompt_eval_count": 1000, "cached_tokens": 600}, source="vllm")
        )

        assert reading["evaluated_tokens"] == 400
        assert reading["reuse_ratio"] == 0.6

    def test_ollama_ratio_is_a_labelled_client_estimate(self) -> None:
        reading = gd.server_prefix_reading(
            _turn({"prompt_eval_count": 100, "prompt_tokens_evaluated": 100}, source="ollama"),
            client_total_chars=4000,
        )

        assert reading["reused_tokens"] is None
        assert reading["evaluated_tokens"] == 100
        assert reading["prompt_tokens"] == 1000
        assert reading["reuse_ratio"] == 0.9
        assert reading["ratio_basis"] == "client_estimate"

    def test_nothing_reported(self) -> None:
        reading = gd.server_prefix_reading(None)

        assert reading["source"] == "none"
        assert reading["reuse_ratio"] is None
        assert reading["ratio_basis"] == "unreported"


def _observation() -> ps.PrefixObservation:
    return ps.compare_layouts(
        ps.request_layout(system_prompt="s", tool_schemas=None, messages=[]),
        ps.request_layout(
            system_prompt="s", tool_schemas=None, messages=[{"role": "user", "content": "hi"}]
        ),
    )


def _store_with_call(request_id: str) -> TurnDiagnosticsStore:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id=request_id, session_id="session-1", mode="assist")
    store.record_provider_request(
        request_id=request_id,
        think_enabled=False,
        num_predict=None,
        temperature=0.0,
        message_count=2,
        tool_count=0,
        tool_capable=False,
    )
    store.record_provider_usage(
        request_id=request_id,
        prompt_eval_count=8467,
        eval_count=10,
        cached_tokens=8347,
        prompt_tokens_evaluated=120,
        provider_label="openai-compatible",
    )
    return store


def test_record_attaches_to_the_call_and_logs_one_event(caplog: pytest.LogCaptureFixture) -> None:
    store = _store_with_call("req_pair")

    with caplog.at_level(logging.INFO, logger=gd.logger.name):
        gd.record_prefix_reuse(
            store,
            gd.PrefixReuseRecord(
                request_id="req_pair",
                observation=_observation(),
                engine_type="openai-compatible",
                model="bonsai",
                iteration=2,
            ),
        )

    snapshot = store.snapshot()
    assert snapshot is not None
    call_reading = snapshot["provider_calls"][-1]["prefix_reuse"]
    assert call_reading == snapshot["prefix_reuse"]
    assert call_reading["client"]["divergence"] == ps.DIVERGENCE_APPEND
    assert call_reading["server"]["reused_tokens"] == 8347
    assert call_reading["iteration"] == 2
    events = [r for r in caplog.records if getattr(r, "event", "") == "ai.router.prefix_reuse"]
    assert len(events) == 1
    assert events[0].getMessage() == "prefix reused 8347 of 8467 tokens; client append"


def test_next_provider_call_resets_the_turn_level_reading() -> None:
    store = _store_with_call("req_reset")
    gd.record_prefix_reuse(store, gd.PrefixReuseRecord("req_reset", _observation()))

    store.record_provider_request(
        request_id="req_reset",
        think_enabled=False,
        num_predict=None,
        temperature=0.0,
        message_count=4,
        tool_count=0,
        tool_capable=False,
    )

    snapshot = store.snapshot()
    assert snapshot is not None
    assert "prefix_reuse" not in snapshot
    assert "prefix_reuse" in snapshot["provider_calls"][0]
    assert "prefix_reuse" not in snapshot["provider_calls"][1]


def test_meter_failure_never_raises(caplog: pytest.LogCaptureFixture) -> None:
    class _BrokenStore:
        def get_snapshot_for_request(self, _request_id: str) -> Any:
            raise RuntimeError("boom")

    with caplog.at_level(logging.WARNING, logger=gd.logger.name):
        gd.record_prefix_reuse(_BrokenStore(), gd.PrefixReuseRecord("req", _observation()))

    assert any(
        getattr(r, "event", "") == "ai.routing.generation_diagnostics.prefix_meter_failed"
        for r in caplog.records
    )


class _RecordingEngine:
    """Non-streaming engine double that reports a llama-server usage split."""

    def __init__(self, store: TurnDiagnosticsStore, request_id: str) -> None:
        self._turn_diagnostics_store = store
        self._request_id = request_id
        self.cached = 0

    def get_model_max_output_tokens(self) -> int:
        return 512

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self._turn_diagnostics_store.record_provider_request(
            request_id=self._request_id,
            think_enabled=False,
            num_predict=None,
            temperature=0.0,
            message_count=len(kwargs["messages"]),
            tool_count=0,
            tool_capable=True,
        )
        self._turn_diagnostics_store.record_provider_usage(
            request_id=self._request_id,
            prompt_eval_count=1000,
            eval_count=5,
            cached_tokens=self.cached,
            prompt_tokens_evaluated=1000 - self.cached,
            provider_label="openai-compatible",
        )
        return GenerationResult(content="done", finish_reason="stop")


def test_generate_step_meters_each_provider_call(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ps, "_SHARED_METER", ps.PrefixStabilityMeter())
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_step", session_id="session-1", mode="assist")
    engine = _RecordingEngine(store, "req_step")
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            max_tokens=128,
            feature_flags={},
            engine_type="openai-compatible",
            model="bonsai",
            fallback_models=[],
        ),
        _engine_messages=lambda messages, primary_system_text: messages,
        _system_prompt_for_engine=str,
    )
    runtime = LoopRuntime(emit=lambda _event: None, request_id="req_step", streaming=False)
    history: list[dict[str, object]] = [{"role": "user", "content": "hello"}]

    def step() -> dict[str, Any]:
        generate_step(
            kernel,
            latest_user_content="hello",
            working_messages=list(history),
            reasoning_effort=None,
            prompt_cache_enabled=False,
            source_key="session-1",
            system_prompt="You are Jenny.",
            tool_schemas=[],
            cache_break_detector=None,
            runtime=runtime,
        )
        snapshot = store.snapshot()
        assert snapshot is not None
        return snapshot["provider_calls"][-1]["prefix_reuse"]

    first = step()
    history.append({"role": "assistant", "content": "done"})
    history.append({"role": "user", "content": "again"})
    engine.cached = 900
    second = step()

    assert first["client"]["divergence"] == ps.DIVERGENCE_FIRST
    assert second["client"]["divergence"] == ps.DIVERGENCE_APPEND
    assert second["server"]["reused_tokens"] == 900
    assert second["server"]["reuse_ratio"] == 0.9
    assert second["engine"] == "openai-compatible"


def test_generate_step_skips_the_meter_behind_the_kill_switch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JENNY_ENABLE_PREFIX_METER", "0")
    assert (
        gd.observe_prefix(
            source_key="session-1", system_prompt="s", tool_schemas=None, prompt_messages=[]
        )
        is None
    )
