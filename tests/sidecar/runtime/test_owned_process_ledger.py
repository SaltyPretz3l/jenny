"""Durable ownership cannot turn missing identity into cleanup proof."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

from sidecar.runtime.owned_process_ledger import OwnedProcessLedger


def identity(pid=123, start="boot:42"):
    return {"pid": pid, "pgid": pid, "start": start, "uid": 1000,
            "exe": "/usr/bin/python3", "command_hash": "a" * 64}


def test_records_actual_launch_and_forgets_only_matching_entry(tmp_path):
    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    entry = ledger.record(identity(1), identity(2), "owned_process")
    assert ledger.snapshot()[entry]["process"] == identity(2)
    assert ledger.snapshot()[entry]["owner"] == identity(1)
    assert not ledger.forget(entry, {"wrong": True})
    assert ledger.forget(entry, ledger.snapshot()[entry])
    assert ledger.snapshot() == {}


def test_serialized_updates_do_not_lose_other_owners(tmp_path):
    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda n: ledger.record(identity(1), identity(n+2), "mcp_stdio"), range(40)))
    assert len(ledger.snapshot()) == 40
    assert json.loads((tmp_path / "owned.json").read_text())["version"] == 1


def test_write_failure_warns_without_raising(tmp_path, caplog):
    target = tmp_path / "blocked"
    target.write_text("not a directory")
    assert OwnedProcessLedger(target / "owned.json").record(identity(1), identity(2), "mcp_stdio") is None
    assert "runtime.owned_ledger.write_failed" in caplog.text


def test_only_unconfirmed_entries_are_capped(tmp_path, caplog):
    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    live = ledger.record(identity(1), identity(2), "background_job")
    for n in range(52):
        key = ledger.record(identity(1), identity(n+3), "owned_process")
        entry = ledger.snapshot()[key]
        assert ledger.mark_unconfirmed(key, entry)
    entries = ledger.snapshot()
    assert live in entries
    assert len(entries) == 51
    assert "owned_ledger.retention_dropped" in caplog.text


def test_invalid_version_preserved(tmp_path, caplog):
    target=tmp_path / "owned.json"
    target.write_text('{"version":99,"entries":{}}')
    ledger=OwnedProcessLedger(target)
    assert ledger.record(identity(1),identity(2),"mcp_stdio") is None
    assert json.loads(target.read_text())["version"] == 99
    assert "runtime.owned_ledger.write_failed" in caplog.text


def test_eviction_keeps_a_possible_live_leak_over_routine_gone_receipts(tmp_path, monkeypatch):
    from sidecar.runtime import owned_process_identity

    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    leak = ledger.record(identity(1), identity(2), "background_job")
    assert ledger.mark_unconfirmed(leak, ledger.snapshot()[leak])
    monkeypatch.setattr(
        owned_process_identity,
        "read_identity",
        lambda pid: {"state": "alive", "identity": identity(2)} if pid == 2 else {"state": "missing"},
    )
    for n in range(55):
        key = ledger.record(identity(1), identity(n + 3), "python_sandbox")
        assert ledger.mark_unconfirmed(key, ledger.snapshot()[key])
    entries = ledger.snapshot()
    assert leak in entries
    assert len(entries) == 50


def test_corrupt_or_mistyped_ledger_fails_closed(tmp_path):
    target = tmp_path / "owned.json"
    target.write_text('{"version":1,"entries":' + "[" * 100000 + "]" * 100000 + "}")
    ledger = OwnedProcessLedger(target)
    assert ledger.snapshot() == {}
    assert ledger.record(identity(1), identity(2), "mcp_stdio") is None
    entry = {"id": "op_x", "owner": identity(1), "process": identity(2), "kind": "mcp_stdio",
             "created_at": 1.0, "state": "active", "handoff": "x"}
    target.write_text(json.dumps({"version": 1, "entries": {"op_x": entry}}))
    assert ledger.snapshot() == {}
    assert ledger.mark_unconfirmed("op_x", entry) is False


def test_lock_error_other_than_contention_fails_fast(tmp_path, monkeypatch):
    import errno
    import os
    import time

    def unsupported(*_args):
        raise OSError(errno.ENOSYS, "unsupported")

    if os.name == "nt":
        import msvcrt

        monkeypatch.setattr(msvcrt, "locking", unsupported)
    else:
        import fcntl

        monkeypatch.setattr(fcntl, "flock", unsupported)
    started = time.monotonic()
    assert OwnedProcessLedger(tmp_path / "owned.json").record(identity(1), identity(2), "mcp_stdio") is None
    assert time.monotonic() - started < 0.5
