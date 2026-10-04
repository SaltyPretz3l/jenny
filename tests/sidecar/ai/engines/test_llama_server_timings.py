"""llama-server ``timings`` reach usage history and turn diagnostics.

llama-server (the managed runtime behind Bonsai 2 and GGUF models) reports
decode/prefill timing in a top-level ``timings`` object beside ``usage``, not
inside it. Without reading it every OpenAI-compatible turn recorded a zero
generation duration, so the Usage page could not compute tokens/second.
"""

from __future__ import annotations

import contextlib
import json
from contextlib import contextmanager
from typing import Any

import pytest

from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.provider_http import ProviderHttpService
from sidecar.ai.engines.vllm_sse_stream import (
    _parse_usage,
    provider_prompt_cache_counts,
    provider_timings,
)
from sidecar.runtime.local_engine.request_context import (
    clear_request_context,
    current_time_to_first_visible_token_ms,
    install_request_context,
)
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore

_MODEL = "ternary-bonsai-2-27b-pq2_0"
_USAGE = {"prompt_tokens": 8467, "completion_tokens": 197, "total_tokens": 8664}
# Shape of llama-server's final include_usage chunk: empty choices, usage and
# timings side by side.
_TIMINGS = {
    "prompt_n": 120,
    "prompt_ms": 480.5,
    "prompt_per_second": 249.7,
    "predicted_n": 197,
    "predicted_ms": 4925.0,
    "predicted_per_second": 40.0,
}


@pytest.fixture
def engine(monkeypatch: pytest.MonkeyPatch):
    def _get_json(self: ProviderHttpService, path: str, **_kwargs: Any) -> dict[str, Any]:
        return {"data": [{"id": _MODEL}]}

    monkeypatch.setattr(ProviderHttpService, "get_json", _get_json)
    built = OpenAICompatibleEngine(host="http://127.0.0.1:8033")
    built.load_model(_MODEL)
    yield built
    with contextlib.suppress(Exception):
        built.clear_request_context()
    with contextlib.suppress(Exception):
        built.close()


class _FakeSSEStream:
    def __init__(self, lines: list[str]) -> None:
        self._lines = lines
        self.status_code = 200

    def iter_lines(self) -> list[str]:
        return self._lines

    def raise_for_status(self) -> None:
        pass


def _patch_stream(monkeypatch: pytest.MonkeyPatch, lines: list[str]) -> None:
    @contextmanager
    def _stream_response(_self: ProviderHttpService, _method: str, _path: str, **_kwargs: Any):
        yield _FakeSSEStream(lines)

    monkeypatch.setattr(ProviderHttpService, "stream_response", _stream_response)


def _final_lines(*, content: str = "ok") -> list[str]:
    return [
        f"data: {json.dumps({'choices': [{'delta': {'content': content}}]})}",
        f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}]})}",
        f"data: {json.dumps({'choices': [], 'usage': _USAGE, 'timings': _TIMINGS})}",
        "data: [DONE]",
    ]


def _bind_diagnostics(engine: OpenAICompatibleEngine, request_id: str) -> TurnDiagnosticsStore:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id=request_id, session_id="session-1", mode="assist")
    engine.set_turn_diagnostics_store(store)
    engine.begin_request_context(request_id=request_id, diagnostics_store=store)
    return store


def _drain(generator: Any) -> tuple[list[Any], Any]:
    chunks: list[Any] = []
    while True:
        try:
            chunks.append(next(generator))
        except StopIteration as stop:
            return chunks, stop.value


class TestParseUsage:
    def test_timings_supply_generation_and_prompt_durations(self) -> None:
        usage = _parse_usage(
            {"usage": _USAGE, "timings": _TIMINGS},
            model_name=_MODEL,
            provider="openai-compatible",
        )

        assert usage is not None
        assert usage.output_tokens == 197
        assert usage.generation_tokens == 197
        assert usage.generation_duration_ms == pytest.approx(4925.0)
        assert usage.prompt_eval_duration_ms == pytest.approx(480.5)
        assert usage.raw_usage == _USAGE

    def test_duration_pairs_with_the_count_it_was_measured_over(self) -> None:
        usage = _parse_usage(
            {"usage": _USAGE, "timings": {**_TIMINGS, "predicted_n": 150}},
            model_name=_MODEL,
        )

        assert usage is not None
        assert usage.output_tokens == 197
        assert usage.generation_tokens == 150

    def test_explicit_usage_durations_win_over_timings(self) -> None:
        body = {
            "usage": {**_USAGE, "generation_duration_ms": 250, "prompt_eval_duration_ms": 40},
            "timings": _TIMINGS,
        }

        usage = _parse_usage(body, model_name=_MODEL)

        assert usage is not None
        assert usage.generation_duration_ms == pytest.approx(250)
        assert usage.generation_tokens == 197
        assert usage.prompt_eval_duration_ms == pytest.approx(40)

    @pytest.mark.parametrize("timings", [None, "bad", {}, {"predicted_ms": -5, "prompt_ms": "x"}])
    def test_missing_or_malformed_timings_leave_durations_unset(self, timings: Any) -> None:
        body: dict[str, Any] = {"usage": _USAGE}
        if timings is not None:
            body["timings"] = timings

        usage = _parse_usage(body, model_name=_MODEL)

        assert usage is not None
        assert usage.generation_duration_ms == 0
        assert usage.prompt_eval_duration_ms == 0
        assert usage.generation_tokens == 197

    def test_measured_ttft_fills_in_when_usage_has_none(self) -> None:
        measured = _parse_usage({"usage": _USAGE}, model_name=_MODEL, time_to_first_token_ms=321)
        reported = _parse_usage(
            {"usage": {**_USAGE, "time_to_first_token_ms": 80}},
            model_name=_MODEL,
            time_to_first_token_ms=321,
        )

        assert measured is not None and measured.time_to_first_token_ms == pytest.approx(321)
        assert reported is not None and reported.time_to_first_token_ms == pytest.approx(80)

    def test_provider_timings_rejects_non_dict_bodies(self) -> None:
        assert provider_timings(None) == (0, 0, 0)
        assert provider_timings({"timings": _TIMINGS}) == (480.5, 4925.0, 197)


class TestEnginePaths:
    def test_plain_stream_done_usage_carries_timings_and_ttft(
        self, engine: OpenAICompatibleEngine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(engine, "_current_time_to_first_token_ms", lambda: 321)
        _patch_stream(monkeypatch, _final_lines())

        done = list(engine.stream(prompt="hi"))[-1]

        assert done.usage is not None
        assert done.usage.provider == "openai-compatible"
        assert done.usage.generation_duration_ms == pytest.approx(4925.0)
        assert done.usage.generation_tokens == 197
        assert done.usage.time_to_first_token_ms == pytest.approx(321)

    def test_tool_stream_result_usage_carries_timings(
        self, engine: OpenAICompatibleEngine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(engine, "_current_time_to_first_token_ms", lambda: 321)
        _patch_stream(monkeypatch, _final_lines())

        _chunks, result = _drain(
            engine.stream_with_tools(
                prompt="hi",
                tools=[{"name": "read_file", "parameters": {"type": "object"}}],
            )
        )

        assert result.usage is not None
        assert result.usage.generation_duration_ms == pytest.approx(4925.0)
        assert result.usage.time_to_first_token_ms == pytest.approx(321)

    def test_non_streaming_completion_usage_carries_timings(
        self, engine: OpenAICompatibleEngine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        body = {
            "choices": [{"message": {"content": "ok"}}],
            "usage": _USAGE,
            "timings": _TIMINGS,
        }
        monkeypatch.setattr(engine._service, "post_json", lambda _path, _payload: body)

        result = engine.generate_with_tools(prompt="hi", tools=[])

        assert result.usage is not None
        assert result.usage.generation_duration_ms == pytest.approx(4925.0)
        assert result.usage.prompt_eval_duration_ms == pytest.approx(480.5)

    def test_turn_diagnostics_derive_provider_tokens_per_second(
        self, engine: OpenAICompatibleEngine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store = _bind_diagnostics(engine, "req_llama_timings")
        _patch_stream(monkeypatch, _final_lines())

        list(engine.stream(prompt="hi"))
        snapshot = store.snapshot()

        assert snapshot is not None
        assert snapshot["provider_eval_count"] == 197
        assert snapshot["provider_eval_duration_ms"] == 4925
        assert snapshot["provider_prompt_eval_duration_ms"] == 480
        assert snapshot["provider_tokens_per_second"] == pytest.approx(40.0)
        assert snapshot["provider_usage_source"] == "openai-compatible"

    def test_turn_diagnostics_without_timings_stay_count_only(
        self, engine: OpenAICompatibleEngine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store = _bind_diagnostics(engine, "req_vllm_shape")
        _patch_stream(
            monkeypatch,
            [
                f"data: {json.dumps({'choices': [{'delta': {'content': 'ok'}}]})}",
                f"data: {json.dumps({'choices': [], 'usage': _USAGE})}",
                "data: [DONE]",
            ],
        )

        list(engine.stream(prompt="hi"))
        snapshot = store.snapshot()

        assert snapshot is not None
        assert snapshot["provider_eval_count"] == 197
        assert "provider_tokens_per_second" not in snapshot
        assert "provider_eval_duration_ms" not in snapshot


class TestMeasuredTimeToFirstToken:
    class _Store:
        def __init__(self, snapshot: Any) -> None:
            self._snapshot = snapshot

        def get_snapshot_for_request(self, request_id: str) -> Any:
            assert request_id == "req-1"
            return self._snapshot

    @pytest.mark.parametrize(
        ("snapshot", "expected"),
        [
            ({"request_id": "req-1", "time_to_first_visible_token_ms": 321}, 321),
            ({"request_id": "req-other", "time_to_first_visible_token_ms": 321}, 0),
            ({"request_id": "req-1", "time_to_first_visible_token_ms": float("nan")}, 0),
            ({"request_id": "req-1", "time_to_first_visible_token_ms": "bad"}, 0),
            (None, 0),
        ],
    )
    def test_reads_only_the_active_requests_positive_value(
        self, snapshot: Any, expected: float
    ) -> None:
        owner = object()
        install_request_context(owner, request_id="req-1", diagnostics_store=self._Store(snapshot))
        try:
            assert current_time_to_first_visible_token_ms(owner) == expected
        finally:
            clear_request_context(owner)

    def test_unbound_engine_reports_zero(self) -> None:
        assert current_time_to_first_visible_token_ms(object()) == 0


class TestPromptCacheCounts:
    """``timings.prompt_n``/``cache_n`` feed the prefix-cache meter."""

    def test_reads_evaluated_and_reused_counts(self) -> None:
        assert provider_prompt_cache_counts({"timings": {"prompt_n": 120, "cache_n": 8347}}) == (
            120,
            8347,
        )

    def test_unreported_is_none_not_zero(self) -> None:
        assert provider_prompt_cache_counts({"timings": {"prompt_n": 120}}) == (120, None)
        assert provider_prompt_cache_counts({"usage": _USAGE}) == (None, None)
        assert provider_prompt_cache_counts({"timings": {"cache_n": True}}) == (None, None)

    def test_reported_zero_cache_stays_zero(self) -> None:
        assert provider_prompt_cache_counts({"timings": {"prompt_n": 8467, "cache_n": 0}}) == (
            8467,
            0,
        )

    def test_turn_diagnostics_record_cache_split_per_call(
        self, engine: OpenAICompatibleEngine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store = _bind_diagnostics(engine, "req_llama_cache")
        timings = {**_TIMINGS, "cache_n": 8347}
        _patch_stream(
            monkeypatch,
            [
                f"data: {json.dumps({'choices': [{'delta': {'content': 'ok'}}]})}",
                f"data: {json.dumps({'choices': [], 'usage': _USAGE, 'timings': timings})}",
                "data: [DONE]",
            ],
        )

        list(engine.stream(prompt="hi"))
        snapshot = store.snapshot()

        assert snapshot is not None
        assert snapshot["provider_cached_tokens"] == 8347
        assert snapshot["provider_prompt_tokens_evaluated"] == 120
        assert snapshot["provider_prompt_cache_hit_ratio"] == pytest.approx(0.9858, abs=1e-4)
        assert snapshot["provider_calls"][-1]["usage"] == {
            "prompt_eval_count": 8467,
            "eval_count": 197,
            "cached_tokens": 8347,
            "prompt_tokens_evaluated": 120,
        }

    def test_openai_cached_tokens_win_over_timings(
        self, engine: OpenAICompatibleEngine, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store = _bind_diagnostics(engine, "req_openai_cached")
        usage = {**_USAGE, "prompt_tokens_details": {"cached_tokens": 8000}}
        timings = {**_TIMINGS, "cache_n": 8347}
        _patch_stream(
            monkeypatch,
            [
                f"data: {json.dumps({'choices': [], 'usage': usage, 'timings': timings})}",
                "data: [DONE]",
            ],
        )

        list(engine.stream(prompt="hi"))
        snapshot = store.snapshot()

        assert snapshot is not None
        assert snapshot["provider_cached_tokens"] == 8000
