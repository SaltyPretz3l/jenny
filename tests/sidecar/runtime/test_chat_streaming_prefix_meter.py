"""The live chat lane meters prefix reuse like the routed tool loop does."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.context import prefix_stability as ps
from sidecar.runtime.chat_streaming import build_live_streaming_chat_response
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore
from tests.sidecar.runtime.test_chat_streaming import _make_brain_container, _make_engine


class _UsageEngine:
    """Streams one answer and reports a llama-server usage split into the store."""

    def __init__(self, store: TurnDiagnosticsStore, cached: int) -> None:
        self._inner = _make_engine(
            [
                SimpleNamespace(kind="content", text="Hello."),
                SimpleNamespace(kind="done", text="", finish_reason="stop"),
            ]
        )
        self._store = store
        self._cached = cached
        self.request_id = ""

    def stream(self, **kwargs: object) -> object:
        self._store.record_provider_request(
            request_id=self.request_id,
            think_enabled=False,
            num_predict=None,
            temperature=0.0,
            message_count=2,
            tool_count=0,
            tool_capable=False,
        )
        self._store.record_provider_usage(
            request_id=self.request_id,
            prompt_eval_count=500,
            eval_count=3,
            cached_tokens=self._cached,
            prompt_tokens_evaluated=500 - self._cached,
            provider_label="openai-compatible",
        )
        return self._inner.stream(**kwargs)

    def __getattr__(self, name: str) -> object:
        return getattr(self._inner, name)


def _send(
    store: TurnDiagnosticsStore,
    engine: _UsageEngine,
    request_id: str,
    messages: list[dict[str, object]],
) -> dict[str, object]:
    store.begin_turn(request_id=request_id, session_id="session-live", mode="chat")
    engine.request_id = request_id
    build_live_streaming_chat_response(
        request_id=request_id,
        trace_id=None,
        session_id="session-live",
        latest_user_content=str(messages[-1]["content"]),
        messages=messages,
        brain_container=_make_brain_container(engine, turn_diagnostics=store),
        reasoning_effort=None,
        learned_lessons=None,
        max_tokens=256,
    )
    snapshot = store.snapshot()
    assert snapshot is not None
    return snapshot["provider_calls"][-1]["prefix_reuse"]


def test_second_chat_turn_reports_an_append_and_the_server_reuse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ps, "_SHARED_METER", ps.PrefixStabilityMeter())
    store = TurnDiagnosticsStore()
    history: list[dict[str, object]] = [{"role": "user", "content": "hi"}]

    first = _send(store, _UsageEngine(store, cached=0), "req-live-1", history)
    history += [{"role": "assistant", "content": "Hello."}, {"role": "user", "content": "more"}]
    second = _send(store, _UsageEngine(store, cached=450), "req-live-2", history)

    assert first["client"]["divergence"] == ps.DIVERGENCE_FIRST
    assert second["client"]["divergence"] == ps.DIVERGENCE_APPEND
    assert second["server"]["reused_tokens"] == 450
    assert second["server"]["reuse_ratio"] == 0.9
