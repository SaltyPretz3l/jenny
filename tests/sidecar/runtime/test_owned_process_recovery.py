"""Shared refusal/recovery fixtures; no disappearance is full-tree proof."""

import json
from pathlib import Path

import pytest

from sidecar.runtime.owned_process_ledger import OwnedProcessLedger
from sidecar.runtime.owned_process_recovery import decide, recover

CASES = json.loads((Path(__file__).parents[2] / "fixtures/owned-process-recovery.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_shared_decision(case):
    assert decide(case["entry"], case["owner"], case["process"], case["uid"]) == case["expected"]


def test_rechecks_identity_before_escalation_and_retains_missing_proof(tmp_path):
    case = CASES[2]
    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    key = ledger.record(case["entry"]["owner"], case["entry"]["process"], "owned_process")
    sent = []

    def read(pid):
        if pid == 101:
            return {"state": "missing"}
        return case["process"] if not sent else {"state": "missing"}

    recover(
        ledger,
        read=read,
        send=lambda pid, sig: sent.append((pid, sig)),
        uid=1000,
        wait=lambda _: None,
    )
    assert len(sent) == 1
    assert sent[0][0] == 202
    assert ledger.snapshot()[key]["state"] == "unconfirmed"


def test_handoff_during_wait_prevents_second_signal(tmp_path):
    case = CASES[2]
    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    key = ledger.record(case["entry"]["owner"], case["entry"]["process"], "owned_process")
    sent = []

    def wait(_):
        ledger.forget(key, ledger.snapshot()[key])

    recover(
        ledger,
        read=lambda pid: case["process"] if pid == 202 else {"state": "missing"},
        send=lambda pid, sig: sent.append((pid, sig)),
        uid=1000,
        wait=wait,
    )
    assert len(sent) == 1
    assert ledger.snapshot() == {}


def test_initialize_recovers_before_constructing_runtime(monkeypatch):
    from types import SimpleNamespace

    from sidecar.runtime import owned_process_tracking
    from sidecar.runtime.capabilities import initialize_response

    calls = []
    monkeypatch.setattr(
        owned_process_tracking, "configure_managed", lambda raw: calls.append("recover")
    )

    def configure(*args, **kwargs):
        calls.append("runtime")
        raise RuntimeError("stop after construction boundary")

    with pytest.raises(RuntimeError, match="construction boundary"):
        initialize_response(
            1,
            {"config": {}},
            api_version="2026-03-06",
            brain_container=SimpleNamespace(configure=configure),
        )
    assert calls == ["recover", "runtime"]


def test_budget_bounds_uncertain_mutations_and_leaves_unvisited_entries(tmp_path, monkeypatch):
    from sidecar.runtime import owned_process_recovery as recovery

    case = CASES[2]
    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    for _ in range(10):
        ledger.record(case["entry"]["owner"], case["entry"]["process"], "owned_process")
    clock = [0.0]
    monkeypatch.setattr(recovery.time, "monotonic", lambda: clock[0])
    original = ledger.mark_unconfirmed
    budgets = []

    def slow(key, entry, **kwargs):
        budgets.append(kwargs.get("deadline"))
        result = original(key, entry, **kwargs)
        clock[0] += 4.0
        return result

    monkeypatch.setattr(ledger, "mark_unconfirmed", slow)
    recovery.recover(ledger, read=lambda _: {"state": "unknown"})
    assert len(budgets) == 2
    assert budgets == [8.0, 8.0]
    assert sum(e["state"] == "active" for e in ledger.snapshot().values()) == 8


def test_already_unconfirmed_retain_needs_no_mutation(tmp_path, monkeypatch):
    case = CASES[2]
    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    key = ledger.record(case["entry"]["owner"], case["entry"]["process"], "owned_process")
    assert ledger.mark_unconfirmed(key, ledger.snapshot()[key])
    calls = []
    monkeypatch.setattr(ledger, "mark_unconfirmed", lambda *a, **k: calls.append(a))
    assert recover(ledger, read=lambda _: {"state": "unknown"})["retain"] == 1
    assert calls == []
