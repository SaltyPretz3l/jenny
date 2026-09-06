"""Red-first: the durable operation ledger (W5, spec Part 3).

Semantic port of services/plugins/store/operation-receipts.js (design
reference only — no cross-boundary import). The entire value of this store is
the honesty of `indeterminate`: every pin below exists to prove the ledger
cannot claim more certainty than it has evidence for.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.runtime.operation_ledger import (
    LEDGER_OPERATIONS_DIR,
    PENDING_RETAIN_UNTIL,
    OperationLedger,
    OperationLedgerUnavailable,
)

NOW = "2026-08-28T12:00:00Z"
LATER = "2026-08-28T12:05:00Z"
AFTER_RETENTION = "2026-10-30T12:00:00Z"  # > 30 days past NOW


def _ledger(tmp_path: Path) -> OperationLedger:
    return OperationLedger(tmp_path / "runtime-root")


def _create(ledger: OperationLedger, op_id: str = "idem_abc123", **overrides):
    payload = {
        "operation_id": op_id,
        "request_fingerprint": "fp_1",
        "generation_id": "gen_live",
        "now_iso": NOW,
    }
    payload.update(overrides)
    return ledger.create_pending(**payload)


class TestCreateAndSettle:
    def test_create_writes_pending_receipt_under_operations_dir(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        result = _create(ledger)
        assert result["ok"] is True
        assert result["outcome"] == "created"
        receipt_path = ledger.root / LEDGER_OPERATIONS_DIR / "idem_abc123.json"
        assert receipt_path.is_file()
        stored = json.loads(receipt_path.read_text(encoding="utf-8"))
        assert stored["status"] == "pending"
        assert stored["generation_id"] == "gen_live"
        assert stored["retain_until"] == PENDING_RETAIN_UNTIL

    def test_create_same_fingerprint_joins_existing(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        result = _create(ledger)
        assert result["ok"] is True
        assert result["outcome"] == "joined"

    def test_create_different_fingerprint_refuses(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        result = _create(ledger, request_fingerprint="fp_other")
        assert result["ok"] is False
        assert result["reason"] == "fingerprint_mismatch"

    def test_settle_committed_replaces_retention_sentinel(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        result = ledger.settle(
            operation_id="idem_abc123",
            status="committed",
            terminal_result_digest="sha256:beef",
            now_iso=LATER,
        )
        assert result["ok"] is True
        receipt = result["receipt"]
        assert receipt["status"] == "committed"
        assert receipt["terminal_result_digest"] == "sha256:beef"
        assert receipt["retain_until"] != PENDING_RETAIN_UNTIL
        assert receipt["retain_until"] > LATER  # real deadline, in the future

    def test_settle_rejects_invalid_terminal_status(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        result = ledger.settle(operation_id="idem_abc123", status="pending", now_iso=LATER)
        assert result["ok"] is False

    def test_settle_same_status_twice_is_idempotent(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        ledger.settle(operation_id="idem_abc123", status="failed", now_iso=LATER)
        result = ledger.settle(operation_id="idem_abc123", status="failed", now_iso=LATER)
        assert result["ok"] is True
        assert result["outcome"] == "already_settled"

    def test_settle_conflicting_status_refuses(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        ledger.settle(operation_id="idem_abc123", status="failed", now_iso=LATER)
        result = ledger.settle(operation_id="idem_abc123", status="committed", now_iso=LATER)
        assert result["ok"] is False

    def test_settle_unknown_operation_refuses(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        result = ledger.settle(operation_id="idem_ghost", status="failed", now_iso=NOW)
        assert result["ok"] is False


class TestIdempotencyDecision:
    def test_fresh_id_proceeds(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        decision = ledger.evaluate_idempotency(
            operation_id="idem_new", request_fingerprint="fp_1", now_iso=NOW
        )
        assert decision["decision"] == "proceed_new"

    def test_pending_same_fingerprint_joins(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        decision = ledger.evaluate_idempotency(
            operation_id="idem_abc123", request_fingerprint="fp_1", now_iso=NOW
        )
        assert decision["decision"] == "join_pending"

    def test_terminal_same_fingerprint_returns_recorded_outcome(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        ledger.settle(operation_id="idem_abc123", status="committed", now_iso=LATER)
        decision = ledger.evaluate_idempotency(
            operation_id="idem_abc123", request_fingerprint="fp_1", now_iso=LATER
        )
        assert decision["decision"] == "return_recorded_outcome"
        assert decision["receipt"]["status"] == "committed"

    def test_fingerprint_mismatch_rejects(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        decision = ledger.evaluate_idempotency(
            operation_id="idem_abc123", request_fingerprint="fp_evil", now_iso=NOW
        )
        assert decision["decision"] == "reject_fingerprint_mismatch"

    def test_expired_terminal_rejects_expired(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        ledger.settle(operation_id="idem_abc123", status="committed", now_iso=NOW)
        decision = ledger.evaluate_idempotency(
            operation_id="idem_abc123", request_fingerprint="fp_1", now_iso=AFTER_RETENTION
        )
        assert decision["decision"] == "reject_expired"

    def test_corrupt_receipt_rejects_indeterminate(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        receipt_path = ledger.root / LEDGER_OPERATIONS_DIR / "idem_abc123.json"
        receipt_path.write_text("{not json", encoding="utf-8")
        decision = ledger.evaluate_idempotency(
            operation_id="idem_abc123", request_fingerprint="fp_1", now_iso=NOW
        )
        assert decision["decision"] == "reject_indeterminate"


class TestStatusQueryFailClosed:
    """Verbatim doctrine: a status query may reference only an existing id and
    never authorizes re-execution. Unknown/expired/corrupt classify fail-closed."""

    def test_unknown_id_classifies_expired_never_proceed(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        result = ledger.evaluate_status_query(operation_id="idem_ghost", now_iso=NOW)
        assert result["classification"] == "idempotency_expired"

    def test_corrupt_classifies_indeterminate(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        (ledger.root / LEDGER_OPERATIONS_DIR / "idem_abc123.json").write_text(
            "\x00garbage", encoding="utf-8"
        )
        result = ledger.evaluate_status_query(operation_id="idem_abc123", now_iso=NOW)
        assert result["classification"] == "outcome_indeterminate"

    def test_pending_classifies_pending(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        result = ledger.evaluate_status_query(operation_id="idem_abc123", now_iso=NOW)
        assert result["classification"] == "pending"

    def test_expired_terminal_classifies_expired(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        ledger.settle(operation_id="idem_abc123", status="committed", now_iso=NOW)
        result = ledger.evaluate_status_query(
            operation_id="idem_abc123", now_iso=AFTER_RETENTION
        )
        assert result["classification"] == "idempotency_expired"


class TestRestartDetection:
    """A pending receipt from another SERVER_GENERATION_ID is provably an
    operation interrupted by process death — exact, no heartbeat, no clock."""

    def test_pending_from_other_generation_is_reported(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger, op_id="idem_dead1", generation_id="gen_dead")
        _create(ledger, op_id="idem_live1", generation_id="gen_live")
        interrupted = ledger.pending_from_other_generations("gen_live")
        assert [r["operation_id"] for r in interrupted] == ["idem_dead1"]

    def test_settled_receipts_are_not_reported_as_interrupted(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger, op_id="idem_dead2", generation_id="gen_dead")
        ledger.settle(operation_id="idem_dead2", status="failed", now_iso=NOW)
        assert ledger.pending_from_other_generations("gen_live") == []


class TestCompaction:
    def test_compaction_never_destroys_pending_or_corrupt(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger, op_id="idem_pending")
        _create(ledger, op_id="idem_corrupt")
        corrupt_path = ledger.root / LEDGER_OPERATIONS_DIR / "idem_corrupt.json"
        corrupt_path.write_text("{broken", encoding="utf-8")
        _create(ledger, op_id="idem_old")
        ledger.settle(operation_id="idem_old", status="committed", now_iso=NOW)

        report = ledger.compact(now_iso=AFTER_RETENTION)

        ops_dir = ledger.root / LEDGER_OPERATIONS_DIR
        assert (ops_dir / "idem_pending.json").is_file()
        assert corrupt_path.is_file()
        assert not (ops_dir / "idem_old.json").is_file()  # expired terminal removed
        assert report["pending_count"] == 1
        assert report["corrupt_count"] == 1

    def test_cap_evicts_oldest_terminal_only(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        for index in range(3):
            _create(ledger, op_id=f"idem_t{index}")
            ledger.settle(
                operation_id=f"idem_t{index}",
                status="failed",
                now_iso=f"2026-08-28T12:0{index}:00Z",
            )
        report = ledger.compact(now_iso=LATER, max_terminal=1)
        ops_dir = ledger.root / LEDGER_OPERATIONS_DIR
        assert not (ops_dir / "idem_t0.json").is_file()
        assert not (ops_dir / "idem_t1.json").is_file()
        assert (ops_dir / "idem_t2.json").is_file()
        assert report["cap_evicted_count"] == 2


class TestCrossProcessSafety:
    def test_two_ledger_instances_agree_on_join(self, tmp_path: Path) -> None:
        # Two OperationLedger instances over the same root simulate the
        # cross-process case: the second creator must join, never overwrite.
        first = OperationLedger(tmp_path / "runtime-root")
        second = OperationLedger(tmp_path / "runtime-root")
        assert _create(first)["outcome"] == "created"
        result = _create(second)
        assert result["ok"] is True
        assert result["outcome"] == "joined"

    def test_receipt_write_is_atomic_no_partial_file_on_disk(self, tmp_path: Path) -> None:
        ledger = _ledger(tmp_path)
        _create(ledger)
        ops_dir = ledger.root / LEDGER_OPERATIONS_DIR
        # Atomic write discipline: no temp/partial artifacts left beside the receipt.
        leftovers = [p.name for p in ops_dir.iterdir() if not p.name.endswith(".json")]
        assert leftovers == []


class TestDegradedRoot:
    def test_unavailable_root_raises_ledger_unavailable(self, tmp_path: Path) -> None:
        blocker = tmp_path / "blocked"
        blocker.write_text("a file where the root dir must go", encoding="utf-8")
        with pytest.raises(OperationLedgerUnavailable):
            OperationLedger(blocker / "runtime-root")
