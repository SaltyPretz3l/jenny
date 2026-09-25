"""Red-first: ledger hardening from the W5 adversarial review.

Three confirmed defect classes: (1) releasing the advisory lock unconditionally
can delete a successor's lock after a stale steal, re-opening the mutual
exclusion it exists for; (2) `_valid_receipt` accepts unparseable timestamps, so
a tampered `retain_until` neutralizes expiry and a structurally corrupt receipt
can still authorize a `committed` replay — the JS reference schema-validates
timestamps at read; (3) compaction sorts `updated_at` lexically, which orders
`...00.100Z` before the chronologically earlier `...00Z` and evicts the wrong
receipt (the JS reference sorts by parsed time).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.runtime import operation_ledger as ledger_module
from sidecar.runtime.operation_ledger import LEDGER_OPERATIONS_DIR, OperationLedger

NOW = "2026-08-28T12:00:00Z"


def _ledger(tmp_path: Path) -> OperationLedger:
    return OperationLedger(tmp_path / "runtime-root")


def _operations_dir(tmp_path: Path) -> Path:
    return tmp_path / "runtime-root" / LEDGER_OPERATIONS_DIR


class TestLockReleaseOwnership:
    def test_release_leaves_a_stolen_successor_lock_in_place(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        lock_path = _operations_dir(tmp_path) / ".lock"
        with ledger._locked():  # noqa: SLF001 - the lock protocol is the unit under test
            # Simulate a successor that (rightly or wrongly) stole the lock while
            # this holder stalled: our lock file is gone, theirs is in place.
            lock_path.unlink()
            lock_path.write_text("successor-token", encoding="utf-8")
        assert lock_path.exists(), "release must never delete a lock it does not own"
        assert lock_path.read_text(encoding="utf-8") == "successor-token"

    def test_release_removes_its_own_lock(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        lock_path = _operations_dir(tmp_path) / ".lock"
        with ledger._locked():  # noqa: SLF001
            assert lock_path.exists()
        assert not lock_path.exists()


    def test_a_lock_file_pending_deletion_is_waited_out(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Windows refuses O_EXCL creation of a file another process is still
        # deleting with PermissionError, not FileExistsError. That is the
        # previous holder releasing the lock, so the writer must retry instead
        # of reporting the ledger unavailable (seen under contention in CI).
        ledger = _ledger(tmp_path)
        real_open = ledger_module.os.open
        refusals = []

        def open_once_pending_delete(path, flags, *args, **kwargs):
            if str(path).endswith(".lock") and not refusals:
                refusals.append(path)
                raise PermissionError(13, "Permission denied", str(path))
            return real_open(path, flags, *args, **kwargs)

        monkeypatch.setattr(ledger_module.os, "open", open_once_pending_delete)
        created = ledger.create_pending(
            operation_id="idem_eeeeeeeeeeeeeeeeeeeeeeee",
            request_fingerprint="fp_pending_delete",
            generation_id="gen_live",
            now_iso=NOW,
        )
        assert refusals, "the pending-delete refusal was exercised"
        assert created["ok"] is True, created


class TestCorruptReceiptsNeverAuthorize:
    def _write_receipt(self, tmp_path: Path, overrides: dict) -> str:
        ledger = _ledger(tmp_path)
        key = "idem_ffffffffffffffffffffffff"
        created = ledger.create_pending(
            operation_id=key,
            request_fingerprint="fp_hard",
            generation_id="gen_live",
            now_iso=NOW,
        )
        assert created["ok"]
        settled = ledger.settle(operation_id=key, status="committed", now_iso=NOW)
        assert settled["ok"]
        path = _operations_dir(tmp_path) / f"{key}.json"
        receipt = json.loads(path.read_text(encoding="utf-8"))
        receipt.update(overrides)
        path.write_text(json.dumps(receipt), encoding="utf-8")
        return key

    def test_garbage_retain_until_classifies_corrupt_not_committed(
        self, tmp_path: Path
    ) -> None:
        key = self._write_receipt(tmp_path, {"retain_until": "garbage"})
        decision = _ledger(tmp_path).evaluate_idempotency(
            operation_id=key, request_fingerprint="fp_hard", now_iso=NOW
        )
        assert decision["decision"] == "reject_indeterminate"

    def test_garbage_updated_at_classifies_corrupt(self, tmp_path: Path) -> None:
        key = self._write_receipt(tmp_path, {"updated_at": "not-a-time"})
        decision = _ledger(tmp_path).evaluate_idempotency(
            operation_id=key, request_fingerprint="fp_hard", now_iso=NOW
        )
        assert decision["decision"] == "reject_indeterminate"


class TestCompactionSortsByParsedTime:
    def test_cap_evicts_the_chronologically_oldest_receipt(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        # Chronological order: oldest -> newest. The fractional stamp sorts
        # LEXICALLY before the plain one ('.' < 'Z'), inverting a naive sort.
        stamps = {
            "idem_111111111111111111111111": "2026-08-28T00:00:00Z",
            "idem_222222222222222222222222": "2026-08-28T00:00:00.100Z",
            "idem_333333333333333333333333": "2026-08-28T00:00:01.000Z",
        }
        for key, stamp in stamps.items():
            assert ledger.create_pending(
                operation_id=key,
                request_fingerprint="fp_sort",
                generation_id="gen_live",
                now_iso=stamp,
            )["ok"]
            assert ledger.settle(operation_id=key, status="committed", now_iso=stamp)["ok"]
        report = ledger.compact(now_iso=NOW, max_terminal=2)
        assert report["cap_evicted_count"] == 1
        survivors = sorted(p.stem for p in _operations_dir(tmp_path).glob("idem_*.json"))
        assert survivors == [
            "idem_222222222222222222222222",
            "idem_333333333333333333333333",
        ], "the plain-format stamp is the oldest and must be the one evicted"
