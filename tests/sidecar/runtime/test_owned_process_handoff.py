"""Only a live trusted guardian and matching token can transfer background jobs."""

from sidecar.runtime.owned_process_handoff import adopt, prepare
from sidecar.runtime.owned_process_ledger import OwnedProcessLedger
from tests.sidecar.runtime.test_owned_process_ledger import identity


def test_handoff_only_background_and_its_actual_host(tmp_path):
    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    old, guardian, new = identity(1), identity(2), identity(3)
    host = identity(4)
    bg = ledger.record(old, identity(5), "background_job", host=host)
    mcp = ledger.record(old, host, "mcp_stdio")
    foreground = ledger.record(old, identity(6), "owned_process")

    def read(pid):
        return {
            "state": "alive",
            "identity": {1: old, 2: guardian, 3: new, 4: host, 5: identity(5)}[pid],
        }

    assert prepare(ledger, old, guardian, "t" * 32, read=read) == 2
    assert ledger.snapshot()[foreground]["owner"] == old
    assert adopt(ledger, new, guardian, "wrong", read=read) == 0
    assert adopt(ledger, new, guardian, "t" * 32, read=read) == 2
    assert ledger.snapshot()[bg]["owner"] == new
    assert ledger.snapshot()[mcp]["owner"] == new


def test_dead_or_changed_guardian_cannot_handoff(tmp_path):
    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    old, guardian = identity(1), identity(2)
    key = ledger.record(old, identity(3), "background_job")
    assert prepare(ledger, old, guardian, "t" * 32, read=lambda _: {"state": "unknown"}) == -1
    assert ledger.snapshot()[key]["owner"] == old


def test_original_host_settles_after_two_restarts(tmp_path):
    from sidecar.runtime.owned_process_tracking import settle

    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    old, guardian, second, third = (identity(n) for n in (1, 2, 3, 4))
    host, process = identity(5), identity(6)
    key = ledger.record(old, process, "background_job", host=host)
    ledger.record(old, host, "mcp_stdio")
    ticket = (ledger, key, ledger.snapshot()[key])

    def read(pid):
        return {"state": "alive", "identity": identity(pid)}

    for before, after in ((old, second), (second, third)):
        assert prepare(ledger, before, guardian, "t" * 32, read=read) == 2
        assert adopt(ledger, after, guardian, "t" * 32, read=read) == 2
    settle(ticket, confirmed=True)
    assert key not in ledger.snapshot()


def test_launch_after_prepare_inherits_restart_intent(tmp_path, monkeypatch):
    from sidecar.runtime import owned_process_handoff as handoff

    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    old, guardian, new, host = (identity(n) for n in (1, 2, 3, 4))

    def read(pid):
        return {"state": "alive", "identity": identity(pid)}

    monkeypatch.setattr(handoff, "read_identity", read)
    host_key = ledger.record(old, host, "mcp_stdio", handoff_host=True)
    assert prepare(ledger, old, guardian, "t" * 32, read=read) >= 0
    key = ledger.record(old, identity(5), "background_job", host=host)
    foreground = ledger.record(old, identity(6), "owned_process")
    external = ledger.record(old, identity(7), "mcp_stdio")
    assert ledger.snapshot()[key]["owner"] == guardian
    assert ledger.snapshot()[host_key]["owner"] == guardian
    assert ledger.snapshot()[foreground]["owner"] == old
    assert ledger.snapshot()[external]["owner"] == old
    assert adopt(ledger, new, guardian, "t" * 32, read=read) == 2
    assert ledger.snapshot()[key]["owner"] == new


def test_empty_snapshot_still_transfers_late_builtin_host_and_job(tmp_path, monkeypatch):
    from sidecar.runtime import owned_process_handoff as handoff

    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    old, guardian, host = (identity(n) for n in (1, 2, 4))

    def read(pid):
        return {"state": "alive", "identity": identity(pid)}

    monkeypatch.setattr(handoff, "read_identity", read)
    assert prepare(ledger, old, guardian, "t" * 32, read=read) == 0
    host_key = ledger.record(old, host, "mcp_stdio", handoff_host=True)
    job_key = ledger.record(old, identity(5), "background_job", host=host)
    assert all(ledger.snapshot()[k]["owner"] == guardian for k in (host_key, job_key))


def test_onefile_bootloader_resolves_to_its_single_interpreter_child(tmp_path):
    from sidecar.runtime.owned_process_handoff import frozen_owner

    proc = tmp_path / "proc"
    for pid, ppid in ((10, 1), (11, 10), (12, 99)):
        (proc / str(pid)).mkdir(parents=True)
        (proc / str(pid) / "stat").write_text(f"{pid} (jenny sidecar) S {ppid} {pid} 0")
    boot, child = identity(10), {**identity(11), "exe": identity(10)["exe"]}
    table = {10: boot, 11: child, 12: identity(12)}

    def read(pid):
        return {"state": "alive", "identity": table[pid]}

    assert frozen_owner(10, read=read, proc_root=proc) == child
    table[11] = {**child, "exe": "/other"}
    assert frozen_owner(10, read=read, proc_root=proc) == boot


def test_drain_matches_a_host_recorded_by_its_bootloader_pid(tmp_path, monkeypatch):
    from sidecar.runtime import owned_process_handoff as handoff

    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    old, guardian, host = identity(1), identity(2), identity(4)
    key = ledger.record(old, host, "mcp_stdio", handoff_host=True)
    monkeypatch.setattr(handoff, "read_identity", lambda pid: {"state": "alive", "identity": {1: old, 2: guardian, 4: host}[pid]})
    assert handoff.prepare(ledger, old, guardian, "t" * 32, read=handoff.read_identity) == 1
    polls = []
    handoff.drain_handed_off_host(ledger, {5, 4}, lambda: not polls.append(1) and len(polls) < 2)
    assert polls
    assert ledger.snapshot()[key]["state"] == "unconfirmed"
