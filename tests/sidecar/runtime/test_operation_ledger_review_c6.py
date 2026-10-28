"""Operation-ledger review C6 hardening: surrogates, refused settles, replace races,
a lock that age never grants and per-file compaction."""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from sidecar.runtime import operation_ledger as ledger_module
from sidecar.runtime import runtime_ids
from sidecar.runtime.operation_ledger import (
    LEDGER_OPERATIONS_DIR,
    OperationLedger,
    OperationLedgerCall,
)
from sidecar.runtime.runtime_ids import RuntimeFileChangedError

NOW = "2026-08-28T12:00:00Z"
LATER = "2026-08-28T12:05:00Z"


def _ledger(tmp_path: Path) -> OperationLedger:
    return OperationLedger(tmp_path / "runtime-root")


def _create(ledger: OperationLedger, op_id: str = "idem_abc123") -> dict:
    return ledger.create_pending(
        operation_id=op_id, request_fingerprint="fp_1", generation_id="gen_live", now_iso=NOW
    )


def _ops(ledger: OperationLedger) -> Path:
    return ledger.root / LEDGER_OPERATIONS_DIR


class TestLoneSurrogates:
    def test_settle_result_digests_output_with_a_lone_surrogate(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        status, settled = ledger.settle_result(
            operation_id="idem_abc123", success=True, output_text="x\ud800",
            now_iso=LATER, evidence={},
        )
        assert (status, settled) == ("committed", True)
        receipt = ledger.evaluate_status_query(operation_id="idem_abc123", now_iso=LATER)
        assert receipt["classification"] == "terminal"

    def test_settle_writes_evidence_with_a_lone_surrogate(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        result = ledger.settle(
            operation_id="idem_abc123", status="committed", now_iso=LATER,
            evidence={"relative_path": "a\ud800"},
        )
        assert result["ok"] is True
        raw = (_ops(ledger) / "idem_abc123.json").read_bytes()
        assert raw.isascii()
        query = ledger.evaluate_status_query(operation_id="idem_abc123", now_iso=LATER)
        assert query["receipt"]["evidence"] == {"relative_path": "a\ud800"}

    def test_create_with_unencodable_evidence_refuses_instead_of_raising(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ledger = _ledger(tmp_path)

        def explode(*_args: object, **_kwargs: object) -> None:
            raise UnicodeEncodeError("utf-8", "x", 0, 1, "surrogates not allowed")

        monkeypatch.setattr(ledger, "_write_receipt", explode)
        assert _create(ledger) == {"ok": False, "reason": "operation_ledger_unavailable"}


class TestRefusedSettleIsVisible:
    def test_failure_settle_refusal_marks_effects_unknown_and_warns(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        call = OperationLedgerCall(
            ledger=_ledger(tmp_path), key="idem_missing", evidence={}, operation_id="op_1"
        )
        error_data = {"effects": "none"}
        with caplog.at_level(logging.WARNING):
            call.settle_failure("write_file", error_data, RuntimeError("boom"))
        assert error_data["effects"] == "unknown"
        refused = [r for r in caplog.records
                   if getattr(r, "event", "") == "runtime.operation_ledger.settle_refused"]
        assert refused and refused[0].data["reason"] == "operation_receipt_not_found"

    def test_settled_failure_keeps_asserted_no_effects(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        call = OperationLedgerCall(ledger=ledger, key="idem_abc123", evidence={}, operation_id="o")
        error_data = {"effects": "none"}
        call.settle_failure("write_file", error_data, RuntimeError("boom"))
        assert error_data["effects"] == "none"

    def test_unexpected_settle_refusal_warns(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        call = OperationLedgerCall(
            ledger=_ledger(tmp_path), key="idem_missing", evidence={}, operation_id="op_1"
        )
        with caplog.at_level(logging.WARNING):
            call.settle_unexpected()
        assert any(getattr(r, "event", "") == "runtime.operation_ledger.settle_refused"
                   for r in caplog.records)


class TestReplaceRaces:
    def test_write_retries_a_transient_replace_permission_error(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ledger = _ledger(tmp_path)
        real_replace = os.replace
        calls: list[object] = []

        def flaky(source: object, target: object) -> None:
            calls.append(target)
            if len(calls) == 1:
                raise PermissionError("target held open by a reader")
            real_replace(source, target)

        monkeypatch.setattr(runtime_ids.os, "replace", flaky)
        assert _create(ledger)["outcome"] == "created"
        assert len(calls) == 2

    def test_persistent_replace_failure_still_fails_closed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ledger = _ledger(tmp_path)

        def denied(_source: object, _target: object) -> None:
            raise PermissionError("denied")

        monkeypatch.setattr(runtime_ids.os, "replace", denied)
        monkeypatch.setattr(runtime_ids, "_REPLACE_RETRY_DELAYS", (0.0, 0.0))
        assert _create(ledger) == {"ok": False, "reason": "operation_ledger_unavailable"}

    def test_read_racing_a_replace_rereads_instead_of_reporting_corruption(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        operations = ledger._operations
        real_read = type(operations).read_bytes
        attempts: list[str] = []

        def racing(self: object, name: str, **kwargs: object) -> object:
            attempts.append(name)
            if len(attempts) == 1:
                raise RuntimeFileChangedError("runtime file changed before read")
            return real_read(self, name, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(type(operations), "read_bytes", racing)
        decision = ledger.evaluate_idempotency(
            operation_id="idem_abc123", request_fingerprint="fp_1", now_iso=LATER
        )
        assert decision["decision"] == "join_pending"
        assert len(attempts) == 2


def _age(path: Path, seconds: float) -> None:
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


class TestLockHasNoAgeTakeover:
    # The ledger lock used to be an O_EXCL file that a waiter could take over
    # once its mtime looked 30 s old. Two waiters racing that takeover (or a
    # holder that simply outlived 30 s) let two writers in at once. The lock is
    # now an OS advisory lock the kernel drops when its holder dies, so age
    # never grants it.
    def test_an_old_lock_file_of_a_live_holder_is_never_taken_over(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ledger = _ledger(tmp_path)
        monkeypatch.setattr(ledger_module, "_LOCK_TIMEOUT_SECONDS", 0.3)
        lock = _ops(ledger) / ".lock"
        entered = []
        with ledger._locked():
            _age(lock, 120)  # the holder outlived the old staleness rule
            with pytest.raises(TimeoutError):
                with ledger._locked():
                    entered.append("second writer")
        assert entered == []

    def test_a_leftover_lock_file_does_not_block_a_writer(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        lock = _ops(ledger) / ".lock"
        lock.write_text("left by an older build", encoding="ascii")
        with ledger._locked():
            pass
        assert _create(ledger)["ok"] is True

    def test_the_lock_is_reusable_after_release(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        with ledger._locked():
            pass
        with ledger._locked():
            pass
        assert [p.name for p in _ops(ledger).iterdir()] == [".lock"]


class TestCompactionPerFile:
    def test_one_unlink_failure_does_not_abort_the_sweep(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ledger = _ledger(tmp_path)
        for name in ("idem_a", "idem_b", "idem_c"):
            _create(ledger, op_id=name)
            ledger.settle(operation_id=name, status="committed", now_iso=NOW)
        stuck = _ops(ledger) / "idem_a.json"
        real_unlink = Path.unlink

        def unlink(self: Path, *args: object, **kwargs: object) -> None:
            if self == stuck:
                raise PermissionError("held open")
            real_unlink(self, *args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(Path, "unlink", unlink)
        report = ledger.compact(now_iso="2026-10-30T12:00:00Z")
        assert report["expired_removed_count"] == 2
        assert report["unlink_failed_count"] == 1
        assert stuck.is_file()
        assert not (_ops(ledger) / "idem_b.json").exists()

    def test_cap_eviction_still_runs_after_an_expiry_unlink_failure(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger, op_id="idem_old")
        ledger.settle(operation_id="idem_old", status="failed", now_iso="2026-07-01T00:00:00Z")
        for index in range(3):
            _create(ledger, op_id=f"idem_t{index}")
            ledger.settle(operation_id=f"idem_t{index}", status="failed",
                          now_iso=f"2026-08-28T12:0{index}:00Z")
        stuck = _ops(ledger) / "idem_old.json"
        real_unlink = Path.unlink

        def unlink(self: Path, *args: object, **kwargs: object) -> None:
            if self == stuck:
                raise PermissionError("held open")
            real_unlink(self, *args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(Path, "unlink", unlink)
        report = ledger.compact(now_iso="2026-08-28T13:00:00Z", max_terminal=1)
        assert report["unlink_failed_count"] == 1
        assert report["cap_evicted_count"] == 2
        assert (_ops(ledger) / "idem_t2.json").is_file()

    def test_corrupt_receipts_age_out_by_file_mtime(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        old = _ops(ledger) / "idem_old_corrupt.json"
        fresh = _ops(ledger) / "idem_fresh_corrupt.json"
        old.write_text("{broken", encoding="utf-8")
        fresh.write_text("{broken", encoding="utf-8")
        now = datetime.now(timezone.utc)
        _age(old, 31 * 24 * 3600)
        report = ledger.compact(now_iso=now.isoformat(timespec="seconds").replace("+00:00", "Z"))
        assert report["corrupt_count"] == 2
        assert report["corrupt_removed_count"] == 1
        assert not old.exists()
        assert fresh.is_file()
