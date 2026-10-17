"""A background job handed off across a normal sidecar restart keeps its running status."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import shell_background as shell_background_module
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore
from sidecar.runtime import owned_process_handoff as handoff
from sidecar.runtime import owned_process_tracking
from sidecar.runtime.owned_process_handoff import adopt, prepare
from sidecar.runtime.owned_process_ledger import OwnedProcessLedger
from tests.sidecar.runtime.test_owned_process_ledger import identity

JOB_ID = "abcdef012345"
JOB_PID = 5
OLD, GUARDIAN, NEW, HOST = 1, 2, 3, 4
STALE_SECONDS = shell_background_module.RUNNING_PID_REUSE_MAX_SECONDS + 1


def _write_running_status(
    root: Path, age_seconds: float, *, job_id: str = JOB_ID, ledger_entry: str | None = None
) -> Path:
    status_dir = root / ".jenny" / "tool-results" / job_id
    status_dir.mkdir(parents=True)
    status_file = status_dir / "status.json"
    status: dict[str, object] = {
        "schema_version": 1,
        "job_id": job_id,
        "state": "running",
        "pid": JOB_PID,
    }
    if ledger_entry is not None:
        status["ledger_entry"] = ledger_entry
    status_file.write_text(json.dumps(status), encoding="utf-8")
    stamp = time.time() - age_seconds
    os.utime(status_file, (stamp, stamp))
    return status_file


def _hand_off(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, live: dict, jobs: list[tuple]):
    """Record each (process identity, launch time) job on OLD, then hand OLD's work to NEW."""

    def read(pid):
        found = live.get(pid)
        return {"state": "alive", "identity": found} if found else {"state": "missing"}

    ledger = OwnedProcessLedger(tmp_path / "owned.json")
    keys = []
    for process, launched_at in jobs:
        with monkeypatch.context() as clock:
            clock.setattr(time, "time", lambda at=launched_at: at)
            keys.append(
                ledger.record(identity(OLD), process, "background_job", host=identity(HOST))
            )
    ledger.record(identity(OLD), identity(HOST), "mcp_stdio")
    prepare(ledger, identity(OLD), identity(GUARDIAN), "t" * 32, read=read)
    adopt(ledger, identity(NEW), identity(GUARDIAN), "t" * 32, read=read)
    monkeypatch.setattr(handoff, "read_identity", read)
    monkeypatch.setattr(owned_process_tracking, "_ledger", ledger)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    return workspace, ledger, keys


@pytest.fixture
def restarted_host(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """The new builtin host after a trusted restart: the job moved to the new sidecar."""
    live = {pid: identity(pid) for pid in (OLD, GUARDIAN, NEW, HOST, JOB_PID)}
    # The spawn records the ledger entry before the job writes its running status.
    workspace, ledger, (key,) = _hand_off(
        monkeypatch, tmp_path, live, [(identity(JOB_PID), time.time() - STALE_SECONDS - 1)]
    )
    assert ledger.snapshot()[key]["handoff"]
    return workspace, live, key


def test_transferred_job_older_than_pid_reuse_window_stays_running(restarted_host):
    workspace, _live, key = restarted_host
    status_file = _write_running_status(workspace, STALE_SECONDS, ledger_entry=key)

    status = shell_background_module.read_background_job(workspace, JOB_ID)

    assert status["state"] == "running"
    assert "ledger_entry" not in status, "the binding is internal, never model-facing"
    assert json.loads(status_file.read_text(encoding="utf-8"))["state"] == "running"

    # The original host still supervises the job and publishes its genuine result.
    store = GuardedWorkspaceStore(workspace.resolve())
    shell_background_module._publish_terminal_status(
        store,
        shell_background_module._job_ref(store, JOB_ID),
        {"job_id": JOB_ID, "state": "completed", "exit_code": 0, "stdout": "done", "stderr": ""},
    )
    final = shell_background_module.read_background_job(workspace, JOB_ID)
    assert final["state"] == "completed"
    assert final["exit_code"] == 0
    assert final["stdout"] == "done"


def test_reused_pid_of_transferred_job_still_reconciles_as_lost(restarted_host):
    workspace, live, key = restarted_host
    live[JOB_PID] = identity(JOB_PID, start="boot:reused")
    _write_running_status(workspace, STALE_SECONDS, ledger_entry=key)

    status = shell_background_module.read_background_job(workspace, JOB_ID)

    assert status["state"] == "failed"
    assert "ownership was lost" in str(status["error"])


def test_transferred_job_with_dead_owner_is_not_treated_as_handed_off(restarted_host):
    workspace, live, key = restarted_host
    del live[NEW]
    _write_running_status(workspace, STALE_SECONDS, ledger_entry=key)

    assert shell_background_module.read_background_job(workspace, JOB_ID)["state"] == "failed"


def test_transferred_job_whose_original_host_died_reconciles_as_lost(restarted_host):
    """The host is the terminal-status writer: process and owner alive are not enough."""
    workspace, live, key = restarted_host
    del live[HOST]
    status_file = _write_running_status(workspace, STALE_SECONDS, ledger_entry=key)

    status = shell_background_module.read_background_job(workspace, JOB_ID)

    assert status["state"] == "failed"
    assert json.loads(status_file.read_text(encoding="utf-8"))["state"] == "failed"


def test_legacy_running_record_without_a_binding_reconciles_conservatively(restarted_host):
    workspace, _live, _key = restarted_host
    _write_running_status(workspace, STALE_SECONDS)

    assert shell_background_module.read_background_job(workspace, JOB_ID)["state"] == "failed"


def test_without_a_configured_ledger_a_stale_running_status_reconciles(
    restarted_host, monkeypatch: pytest.MonkeyPatch
):
    workspace, _live, key = restarted_host
    monkeypatch.setattr(owned_process_tracking, "_ledger", None)
    _write_running_status(workspace, STALE_SECONDS, ledger_entry=key)

    assert shell_background_module.read_background_job(workspace, JOB_ID)["state"] == "failed"


def test_recycled_pid_inside_the_mtime_slack_never_vouches_for_another_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Job A's host died leaving a stale running record; its pid was recycled to job B one
    second later and B was handed off normally. Only A's own ledger entry can vouch for A."""
    job_b = "0123456789ab"
    live = {pid: identity(pid) for pid in (OLD, GUARDIAN, NEW, HOST)}
    live[JOB_PID] = identity(JOB_PID, start="boot:job-b")
    a_status_at = time.time() - 2 * STALE_SECONDS
    workspace, _ledger, (key_a, key_b) = _hand_off(
        monkeypatch,
        tmp_path,
        live,
        [
            (identity(JOB_PID, start="boot:job-a"), a_status_at - 1),
            (live[JOB_PID], a_status_at + 1),
        ],
    )
    status_a = _write_running_status(workspace, 2 * STALE_SECONDS, ledger_entry=key_a)
    status_b = _write_running_status(
        workspace, 2 * STALE_SECONDS - 1.5, job_id=job_b, ledger_entry=key_b
    )

    lost = shell_background_module.read_background_job(workspace, JOB_ID)
    kept = shell_background_module.read_background_job(workspace, job_b)

    assert lost["state"] == "failed"
    assert "ownership was lost" in str(lost["error"])
    assert json.loads(status_a.read_text(encoding="utf-8"))["state"] == "failed"
    assert kept["state"] == "running"
    assert json.loads(status_b.read_text(encoding="utf-8"))["state"] == "running"


def test_initial_running_status_persists_the_jobs_own_ledger_entry(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = GuardedWorkspaceStore(workspace.resolve())
    job_ref = shell_background_module._job_ref(store, JOB_ID)
    entry_id = "op_" + "0123456789abcdef" * 2
    job = SimpleNamespace(
        process=SimpleNamespace(pid=JOB_PID),
        owned_process=SimpleNamespace(_ledger_ticket=(None, entry_id, {})),
    )

    shell_background_module._publish_initial_status_or_refuse(
        store=store, job_ref=job_ref, job_id=JOB_ID, job=job
    )

    status_file = workspace / ".jenny" / "tool-results" / JOB_ID / "status.json"
    persisted = json.loads(status_file.read_text(encoding="utf-8"))
    assert persisted["ledger_entry"] == entry_id
    assert persisted["state"] == "running"
    assert "ledger_entry" not in shell_background_module.read_background_job(workspace, JOB_ID)


def test_a_malformed_ledger_binding_is_a_corrupt_status(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _write_running_status(workspace, 0, ledger_entry="op_../../escape")

    status = shell_background_module.read_background_job(workspace, JOB_ID)

    assert status["state"] != "running"
    assert status["reason_code"] == "invalid_ledger_entry"
