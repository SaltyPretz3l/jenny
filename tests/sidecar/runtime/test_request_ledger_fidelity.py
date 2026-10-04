"""Request-specific measurements and bounded retained terminal evidence."""

from types import SimpleNamespace

import pytest

import sidecar.runtime.turn_diagnostics as diagnostics
from sidecar.runtime.local_engine.request_context import (
    clear_request_context,
    current_time_to_first_visible_token_ms,
    install_request_context,
)
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore


def test_first_visible_measurement_survives_another_request_becoming_latest(monkeypatch):
    clock = [1.0]
    monkeypatch.setattr(diagnostics.time, "monotonic", lambda: clock[0])
    store = TurnDiagnosticsStore()
    engine = SimpleNamespace()
    store.begin_turn(request_id="req-a", session_id="sess", mode="chat")
    store.record_provider_request(request_id="req-a", think_enabled=False, num_predict=8, temperature=0.7, message_count=1, tool_count=0, tool_capable=False)
    install_request_context(engine, request_id="req-a", diagnostics_store=store)
    try:
        clock[0] += 0.042
        store.record_visible_output(request_id="req-a", text="hello")
        assert current_time_to_first_visible_token_ms(engine) == 42
        store.begin_turn(request_id="req-b", session_id="sess", mode="chat")
        snapshot = store.get_snapshot_for_request("req-a")
        assert snapshot is not None
        assert snapshot["time_to_first_visible_token_ms"] == 42
        assert current_time_to_first_visible_token_ms(engine) == 42
    finally:
        clear_request_context(engine)


@pytest.mark.parametrize("reason", ["stop", "length", "tool_calls", "incomplete", "error", "reasoning_only", "thinking_budget"])
def test_ledger_retains_allowlisted_finish_reason(reason):
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req", session_id="sess", mode="chat")
    store.record_provider_request(request_id="req", think_enabled=False, num_predict=8, temperature=0.7, message_count=1, tool_count=0, tool_capable=False)
    store.complete_provider_request(request_id="req", finish_reason=reason)
    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["provider_calls"][0]["finish_reason"] == reason


@pytest.mark.parametrize("reason", ["secret payload", "stop" + "x" * 1000])
def test_ledger_rejects_unrecognized_finish_reason(reason):
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req", session_id="sess", mode="chat")
    store.record_provider_request(request_id="req", think_enabled=False, num_predict=8, temperature=0.7, message_count=1, tool_count=0, tool_capable=False)
    store.complete_provider_request(request_id="req", finish_reason=reason)
    snapshot = store.snapshot()
    assert snapshot is not None
    assert "finish_reason" not in snapshot["provider_calls"][0]
