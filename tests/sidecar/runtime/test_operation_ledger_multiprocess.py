"""W8-S3(b): true multi-process barrier / fault-injection coverage (W5 deferral).

Every lock/crash test that existed before this file exercises the protocol
in-process (one interpreter, one `_locked()` implementation talking to itself).
The W5 adversarial review flagged that as insufficient substantiation for a
cross-process-safe store. These tests spawn REAL child interpreters against a
shared ledger root: concurrent writers contending the advisory lock, a live
foreign holder that must be honored, a dead holder whose stale lock must be
stolen, and a process that dies between create_pending and settle — the exact
interruption the overlay/status story exists to disclose.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from sidecar.runtime import operation_ledger as ledger_module
from sidecar.runtime.operation_ledger import LEDGER_OPERATIONS_DIR, OperationLedger

_REPO_ROOT = Path(__file__).resolve().parents[3]
NOW = "2026-08-29T12:00:00Z"


def _child_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(_REPO_ROOT)
    return env


def _operations_dir(root: Path) -> Path:
    return root / LEDGER_OPERATIONS_DIR


_WRITER_SCRIPT = """
import sys
from sidecar.runtime.operation_ledger import OperationLedger

root, worker, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
ledger = OperationLedger(root)
now = "2026-08-29T12:00:00Z"
for index in range(count):
    op_id = f"idem_{worker}{index:022d}"[:29]
    created = ledger.create_pending(
        operation_id=op_id,
        request_fingerprint=f"fp_{worker}_{index}",
        generation_id=f"gen_{worker}",
        now_iso=now,
        evidence={"tool": "write_file", "relative_path": f"src/{worker}_{index}.py"},
    )
    if not created.get("ok"):
        print(f"create_pending refused: {created}", file=sys.stderr)
        sys.exit(1)
    settled = ledger.settle(operation_id=op_id, status="committed", now_iso=now)
    if not settled.get("ok"):
        print(f"settle refused: {settled}", file=sys.stderr)
        sys.exit(1)
sys.exit(0)
"""


def test_concurrent_writers_lose_no_receipts(tmp_path: Path) -> None:
    root = tmp_path / "shared-root"
    workers, ops_per_worker = 4, 5
    processes = [
        subprocess.Popen(
            [sys.executable, "-c", _WRITER_SCRIPT, str(root), f"w{index}", str(ops_per_worker)],
            env=_child_env(),
            cwd=str(_REPO_ROOT),
            stderr=subprocess.PIPE,
            text=True,
        )
        for index in range(workers)
    ]
    for process in processes:
        _, stderr = process.communicate(timeout=120)
        assert process.returncode == 0, f"writer failed under contention: {stderr}"
    receipt_paths = sorted(_operations_dir(root).glob("idem_*.json"))
    assert len(receipt_paths) == workers * ops_per_worker
    for path in receipt_paths:
        receipt = json.loads(path.read_text(encoding="utf-8"))
        assert receipt["status"] == "committed", f"torn/incoherent receipt: {path.name}"
        assert receipt["operation_id"] == path.name[: -len(".json")]
    assert not (_operations_dir(root) / ".lock").exists()


_HOLDER_SCRIPT = """
import os, sys, time

lock_path, release_path, mode = sys.argv[1], sys.argv[2], sys.argv[3]
fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
os.write(fd, b"foreign-child-token")
os.fsync(fd)
os.close(fd)
print("HELD", flush=True)
if mode == "die":
    os._exit(0)  # crash while holding: the lock file stays behind
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    if os.path.exists(release_path):
        os.unlink(lock_path)
        sys.exit(0)
    time.sleep(0.02)
sys.exit(2)
"""


def _spawn_holder(root: Path, release_path: Path, mode: str) -> subprocess.Popen:
    # Instantiating the ledger first creates the operations dir the lock lives in.
    OperationLedger(root)
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            _HOLDER_SCRIPT,
            str(_operations_dir(root) / ".lock"),
            str(release_path),
            mode,
        ],
        env=_child_env(),
        cwd=str(_REPO_ROOT),
        stdout=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    assert process.stdout.readline().strip() == "HELD"
    return process


def test_live_foreign_lock_is_honored_not_stolen(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "shared-root"
    release_path = tmp_path / "release-now"
    holder = _spawn_holder(root, release_path, "hold")
    try:
        monkeypatch.setattr(ledger_module, "_LOCK_TIMEOUT_SECONDS", 0.5)
        refused = OperationLedger(root).create_pending(
            operation_id="idem_aaaaaaaaaaaaaaaaaaaaaaaa",
            request_fingerprint="fp_live",
            generation_id="gen_parent",
            now_iso=NOW,
        )
        assert refused.get("ok") is not True, "a live foreign lock must block writes"
        assert "operation_ledger_unavailable" in json.dumps(refused)
        # The foreign lock must survive our timed-out attempt untouched.
        lock_path = _operations_dir(root) / ".lock"
        assert lock_path.read_text(encoding="ascii") == "foreign-child-token"
    finally:
        release_path.write_text("go", encoding="utf-8")
        holder.wait(timeout=30)
    assert holder.returncode == 0
    monkeypatch.setattr(ledger_module, "_LOCK_TIMEOUT_SECONDS", 5.0)
    created = OperationLedger(root).create_pending(
        operation_id="idem_aaaaaaaaaaaaaaaaaaaaaaaa",
        request_fingerprint="fp_live",
        generation_id="gen_parent",
        now_iso=NOW,
    )
    assert created["ok"] is True and created["outcome"] == "created"


def test_stale_lock_of_dead_process_is_stolen(tmp_path: Path) -> None:
    root = tmp_path / "shared-root"
    holder = _spawn_holder(root, tmp_path / "unused-release", "die")
    holder.wait(timeout=30)
    lock_path = _operations_dir(root) / ".lock"
    assert lock_path.exists(), "the dead child must leave its lock behind"
    # A real steal waits _STALE_LOCK_SECONDS (30s); backdate the orphan instead.
    stale = time.time() - 120
    os.utime(lock_path, (stale, stale))
    created = OperationLedger(root).create_pending(
        operation_id="idem_bbbbbbbbbbbbbbbbbbbbbbbb",
        request_fingerprint="fp_steal",
        generation_id="gen_parent",
        now_iso=NOW,
    )
    assert created["ok"] is True and created["outcome"] == "created"
    assert not lock_path.exists()


_DIER_SCRIPT = """
import os, sys
from sidecar.runtime.operation_ledger import OperationLedger

root = sys.argv[1]
created = OperationLedger(root).create_pending(
    operation_id="idem_cccccccccccccccccccccccc",
    request_fingerprint="fp_crash",
    generation_id="gen_dead_child",
    now_iso="2026-08-29T12:00:00Z",
    evidence={"tool": "write_file", "relative_path": "src/half-done.py"},
)
if not created.get("ok"):
    sys.exit(1)
os._exit(0)  # dies before settling — a mid-operation process death
"""


def test_process_death_between_pending_and_settle_is_visible_across_processes(
    tmp_path: Path,
) -> None:
    root = tmp_path / "shared-root"
    dier = subprocess.Popen(
        [sys.executable, "-c", _DIER_SCRIPT, str(root)],
        env=_child_env(),
        cwd=str(_REPO_ROOT),
    )
    dier.wait(timeout=60)
    assert dier.returncode == 0
    survivors = OperationLedger(root).pending_from_other_generations("gen_parent")
    assert len(survivors) == 1
    receipt = survivors[0]
    assert receipt["operation_id"] == "idem_cccccccccccccccccccccccc"
    assert receipt["generation_id"] == "gen_dead_child"
    assert receipt["evidence"]["relative_path"] == "src/half-done.py"
    # The dead child's lock did not leak: the settle path stays writable.
    settled = OperationLedger(root).settle(
        operation_id="idem_cccccccccccccccccccccccc", status="indeterminate", now_iso=NOW
    )
    assert settled["ok"] is True
