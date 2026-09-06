"""Durable receipts for idempotent side-effecting tool operations."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from sidecar.runtime.runtime_ids import GuardedRuntimeDirectory, RuntimePathError

LEDGER_OPERATIONS_DIR = "operations"
PENDING_RETAIN_UNTIL = "9999-12-31T23:59:59Z"
DEFAULT_MAX_TERMINAL_RECEIPTS = 4096
_DEFAULT_RETENTION_DAYS = 30
_TERMINAL_STATUSES = frozenset({"committed", "failed", "indeterminate", "expired"})
_REQUIRED_STRING_FIELDS = (
    "operation_id",
    "request_fingerprint",
    "generation_id",
    "status",
    "created_at",
    "updated_at",
    "retain_until",
)
_MAX_RECEIPT_BYTES = 256 * 1024
_LOCK_TIMEOUT_SECONDS = 5.0
_LOCK_POLL_SECONDS = 0.05
_STALE_LOCK_SECONDS = 30.0
_TIMESTAMP_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$"
)


class OperationLedgerUnavailable(Exception):
    """The configured durable ledger root cannot be used safely."""


class OperationLedger:
    """Synchronous, cross-process-safe operation receipt store."""

    def __init__(self, runtime_root: Path | str) -> None:
        try:
            trusted_root = GuardedRuntimeDirectory.create_trusted_root(runtime_root)
            operations_root = trusted_root.child_directory(LEDGER_OPERATIONS_DIR, create=True)
            if operations_root is None:  # pragma: no cover - create=True is exhaustive
                raise RuntimePathError("operation ledger directory is unavailable")
        except (RuntimePathError, OSError) as error:
            raise OperationLedgerUnavailable("operation ledger root is unavailable") from error
        self._root = trusted_root
        self._operations = operations_root

    @property
    def root(self) -> Path:
        return self._root.path

    def create_pending(
        self, *, operation_id: str, request_fingerprint: str, generation_id: str, now_iso: str,
        evidence: dict[str, str] | None = None,
    ) -> dict[str, object]:
        try:
            with self._locked():
                existing = self._get_receipt(operation_id)
                if existing["corrupted"]:
                    return self._refusal("operation_receipt_corrupted")
                receipt = existing.get("receipt")
                if isinstance(receipt, dict):
                    if receipt["request_fingerprint"] != request_fingerprint:
                        return self._refusal("fingerprint_mismatch")
                    return {"ok": True, "outcome": "joined", "receipt": receipt}
                candidate: dict[str, object] = {
                    "operation_id": operation_id,
                    "request_fingerprint": request_fingerprint,
                    "generation_id": generation_id,
                    "status": "pending",
                    "created_at": now_iso,
                    "updated_at": now_iso,
                    "retain_until": PENDING_RETAIN_UNTIL,
                }
                if evidence is not None:
                    candidate["evidence"] = dict(evidence)
                if not self._valid_receipt(candidate):
                    return self._refusal("invalid_receipt")
                self._write_receipt(operation_id, candidate)
                return {"ok": True, "outcome": "created", "receipt": candidate}
        except (OSError, RuntimePathError, TimeoutError):
            return self._refusal("operation_ledger_unavailable")

    def settle(  # noqa: PLR0911
        self, *, operation_id: str, status: str,
        terminal_result_digest: str | None = None, now_iso: str,
        evidence: dict[str, str] | None = None,
    ) -> dict[str, object]:
        if status not in _TERMINAL_STATUSES:
            return self._refusal("invalid_terminal_status")
        try:
            with self._locked():
                existing = self._get_receipt(operation_id)
                if existing["corrupted"]:
                    return self._refusal("operation_receipt_corrupted")
                receipt = existing.get("receipt")
                if not isinstance(receipt, dict):
                    return self._refusal("operation_receipt_not_found")
                if receipt["status"] != "pending":
                    if receipt["status"] == status:
                        return {"ok": True, "outcome": "already_settled", "receipt": receipt}
                    return self._refusal(
                        "already_settled_with_different_status",
                        detail={"existing": receipt["status"]},
                    )
                retain_until = _default_retain_until(now_iso)
                if retain_until is None:
                    return self._refusal("invalid_retention_deadline")
                updated = dict(receipt)
                updated.update(
                    status=status,
                    updated_at=now_iso,
                    retain_until=retain_until,
                )
                if terminal_result_digest:
                    updated["terminal_result_digest"] = terminal_result_digest
                if evidence is not None:
                    updated["evidence"] = dict(evidence)
                if not self._valid_receipt(updated):
                    return self._refusal("invalid_receipt")
                self._write_receipt(operation_id, updated)
                return {"ok": True, "outcome": "settled", "receipt": updated}
        except (OSError, RuntimePathError, TimeoutError):
            return self._refusal("operation_ledger_unavailable")

    def settle_failure(
        self, *, operation_id: str, effects: str, now_iso: str, evidence: dict[str, str],
        rollback_status: object = None,
    ) -> str:
        status = (
            ledger_status_for_rollback(rollback_status)
            if rollback_status is not None
            else ("failed" if effects == "none" else "indeterminate")
        )
        settled_evidence = dict(evidence)
        if status == "failed" and effects == "none":
            settled_evidence["effects"] = "none"
        self.settle(
            operation_id=operation_id,
            status=status,
            now_iso=now_iso,
            evidence=settled_evidence,
        )
        return status

    def settle_result(  # noqa: PLR0913
        self, *, operation_id: str, success: bool, output_text: str,
        now_iso: str, evidence: dict[str, str], asserted_effects: object = None,
        rollback_status: object = None,
    ) -> tuple[str, bool]:
        status = (
            "committed"
            if success
            else (
                ledger_status_for_rollback(rollback_status)
                if rollback_status is not None
                else ("failed" if asserted_effects == "none" else "indeterminate")
            )
        )
        settled_evidence = dict(evidence)
        if status == "failed":
            settled_evidence["effects"] = "none"
        result = self.settle(
            operation_id=operation_id,
            status=status,
            terminal_result_digest="sha256:" + hashlib.sha256(output_text.encode()).hexdigest(),
            now_iso=now_iso,
            evidence=settled_evidence,
        )
        return status, bool(result.get("ok"))

    def evaluate_idempotency(  # noqa: PLR0911
        self, *, operation_id: str, request_fingerprint: str, now_iso: str,
    ) -> dict[str, object]:
        try:
            existing = self._get_receipt(operation_id)
        except (OSError, RuntimePathError):
            return {"decision": "reject_indeterminate", "reason": "operation_ledger_unavailable"}
        if existing["corrupted"]:
            return {"decision": "reject_indeterminate", "reason": "operation_receipt_corrupted"}
        receipt = existing.get("receipt")
        if not isinstance(receipt, dict):
            return {"decision": "proceed_new"}
        if receipt["request_fingerprint"] != request_fingerprint:
            return {"decision": "reject_fingerprint_mismatch", "receipt": receipt}
        if _is_expired(receipt, now_iso):
            return {"decision": "reject_expired", "receipt": receipt}
        if receipt["status"] == "pending":
            return {"decision": "join_pending", "receipt": receipt}
        return {"decision": "return_recorded_outcome", "receipt": receipt}

    def evaluate_status_query(self, *, operation_id: str, now_iso: str) -> dict[str, object]:
        try:
            existing = self._get_receipt(operation_id)
        except (OSError, RuntimePathError):
            return {
                "classification": "outcome_indeterminate",
                "reason": "operation_ledger_unavailable",
            }
        if existing["corrupted"]:
            return {
                "classification": "outcome_indeterminate",
                "reason": "operation_receipt_corrupted",
            }
        receipt = existing.get("receipt")
        if not isinstance(receipt, dict):
            return {
                "classification": "idempotency_expired",
                "reason": "operation_receipt_unknown",
            }
        if receipt["status"] == "pending":
            return {"classification": "pending", "receipt": receipt}
        if _is_expired(receipt, now_iso):
            return {
                "classification": "idempotency_expired",
                "reason": "retain_until_elapsed",
                "receipt": receipt,
            }
        return {"classification": "terminal", "receipt": receipt}

    def pending_from_other_generations(self, current_generation_id: str) -> list[dict]:
        pending, _ = self.pending_receipts()
        return [
            receipt
            for receipt in pending
            if receipt["generation_id"] != current_generation_id
        ]

    def pending_receipts(self) -> tuple[list[dict], int]:
        pending: list[dict] = []
        corrupt_count = 0
        for path in self._operations.path.glob("*.json"):
            operation_id = path.name[: -len(".json")]
            try:
                existing = self._get_receipt(operation_id)
            except (OSError, RuntimePathError):
                corrupt_count += 1
                continue
            if existing["corrupted"]:
                corrupt_count += 1
                continue
            receipt = existing.get("receipt")
            if (
                isinstance(receipt, dict)
                and receipt["status"] == "pending"
            ):
                pending.append(receipt)
        return sorted(pending, key=lambda item: str(item["operation_id"])), corrupt_count

    def compact(
        self, *, now_iso: str,
        max_terminal: int = DEFAULT_MAX_TERMINAL_RECEIPTS,
    ) -> dict[str, int]:
        pending_count = 0
        corrupt_count = 0
        expired_removed_count = 0
        terminals: list[dict] = []
        try:
            with self._locked():
                for path in self._operations.path.glob("*.json"):
                    operation_id = path.name[: -len(".json")]
                    existing = self._get_receipt(operation_id)
                    if existing["corrupted"]:
                        corrupt_count += 1
                        continue
                    receipt = existing.get("receipt")
                    if not isinstance(receipt, dict):
                        continue
                    if receipt["status"] in _TERMINAL_STATUSES:
                        if _is_expired(receipt, now_iso):
                            path.unlink()
                            expired_removed_count += 1
                        else:
                            terminals.append(receipt)
                    else:
                        pending_count += 1
                terminals.sort(
                    key=lambda item: (
                        _parse_iso(item["updated_at"])
                        or datetime.min.replace(tzinfo=timezone.utc),
                        str(item["operation_id"]),
                    )
                )
                cap_evicted_count = 0
                valid_cap = isinstance(max_terminal, int) and not isinstance(max_terminal, bool)
                if valid_cap and max_terminal >= 0:
                    overflow = max(0, len(terminals) - max_terminal)
                    for receipt in terminals[:overflow]:
                        self._receipt_path(str(receipt["operation_id"])).unlink()
                        cap_evicted_count += 1
        except (OSError, RuntimePathError, TimeoutError):
            cap_evicted_count = 0
        return {
            "pending_count": pending_count,
            "corrupt_count": corrupt_count,
            "cap_evicted_count": cap_evicted_count,
            "expired_removed_count": expired_removed_count,
        }

    @staticmethod
    def _refusal(reason: str, *, detail: object | None = None) -> dict[str, object]:
        result: dict[str, object] = {"ok": False, "reason": reason}
        if detail is not None:
            result["detail"] = detail
        return result

    def _receipt_path(self, operation_id: str) -> Path:
        return self._operations.validate_file_target(f"{operation_id}.json")

    def _get_receipt(self, operation_id: str) -> dict[str, object]:
        name = f"{operation_id}.json"
        try:
            read = self._operations.read_bytes(
                name,
                max_bytes=_MAX_RECEIPT_BYTES,
                missing_ok=True,
            )
        except RuntimePathError:
            return {"found": False, "corrupted": True}
        if read is None:
            return {"found": False, "corrupted": False}
        try:
            receipt = json.loads(read.data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {"found": False, "corrupted": True}
        if not self._valid_receipt(receipt) or receipt["operation_id"] != operation_id:
            return {"found": False, "corrupted": True}
        return {"found": True, "corrupted": False, "receipt": receipt}

    @staticmethod
    def _valid_receipt(receipt: object) -> bool:
        if not isinstance(receipt, dict):
            return False
        if any(
            not isinstance(receipt.get(key), str) or not receipt[key]
            for key in _REQUIRED_STRING_FIELDS
        ):
            return False
        if receipt["status"] not in _TERMINAL_STATUSES | {"pending"}:
            return False
        if any(
            _TIMESTAMP_RE.fullmatch(receipt[key]) is None
            for key in ("created_at", "updated_at", "retain_until")
        ):
            return False
        digest = receipt.get("terminal_result_digest")
        if digest is not None and not isinstance(digest, str):
            return False
        evidence = receipt.get("evidence")
        return evidence is None or (
            isinstance(evidence, dict)
            and all(
                isinstance(key, str) and isinstance(value, str)
                for key, value in evidence.items()
            )
        )

    def _write_receipt(self, operation_id: str, receipt: dict[str, object]) -> None:
        payload = json.dumps(
            receipt,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        self._operations.write_bytes_atomic(
            f"{operation_id}.json",
            payload,
            max_bytes=_MAX_RECEIPT_BYTES,
        )
        if os.name != "nt":
            # Windows cannot reliably open directories for fsync; the receipt
            # file itself was fsync'd by write_bytes_atomic before os.replace.
            directory_fd = os.open(str(self._operations.path), os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self._operations.validate()
        lock_path = self._operations.path / ".lock"
        deadline = time.monotonic() + _LOCK_TIMEOUT_SECONDS
        lock_fd: int | None = None
        lock_token = uuid4().hex
        while lock_fd is None:
            try:
                lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
            except FileExistsError:
                try:
                    age_seconds = time.time() - lock_path.stat().st_mtime
                    if age_seconds >= _STALE_LOCK_SECONDS:
                        lock_path.unlink()
                        continue
                except FileNotFoundError:
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        "timed out waiting for operation ledger lock"
                    ) from None
                time.sleep(_LOCK_POLL_SECONDS)
        try:
            written = os.write(lock_fd, lock_token.encode("ascii"))
            if written != len(lock_token):
                raise OSError("failed to write operation ledger lock token")
            os.fsync(lock_fd)
        except OSError:
            os.close(lock_fd)
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass
            raise
        os.close(lock_fd)
        try:
            yield
        finally:
            _release_lock_if_owned(lock_path, lock_token)


def ledger_status_for_rollback(status: object) -> str:
    return {
        "not_needed": "committed",
        "restored": "failed",
        "partial": "indeterminate",
        "failed": "indeterminate",
    }.get(str(status), "indeterminate")


def _release_lock_if_owned(lock_path: Path, lock_token: str) -> None:
    try:
        current_token = lock_path.read_text(encoding="ascii")
    except (OSError, UnicodeDecodeError):
        return
    if current_token != lock_token:
        return
    try:
        lock_path.unlink()
    except FileNotFoundError:
        pass


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_expired(receipt: dict, now_iso: str) -> bool:
    retain_until = _parse_iso(receipt.get("retain_until"))
    now = _parse_iso(now_iso)
    return retain_until is not None and now is not None and now >= retain_until


def _default_retain_until(now_iso: str) -> str | None:
    now = _parse_iso(now_iso)
    if now is None:
        return None
    deadline = now + timedelta(days=_DEFAULT_RETENTION_DAYS)
    return deadline.isoformat(timespec="milliseconds").replace("+00:00", "Z")


# Stable re-exports: the call-side helpers moved to operation_ledger_calls to
# keep this store under the 600-line ratchet; every consumer imports them from
# here.
from sidecar.runtime.operation_ledger_calls import (  # noqa: E402, F401
    OperationLedgerCall,
    derive_idempotency_key,
    inject_idempotency_key,
    ledger_request_fingerprint,
    operation_timestamp,
    reconcile_content_addressed_pending,
    recorded_operation_outcome,
    render_operation_status,
)
