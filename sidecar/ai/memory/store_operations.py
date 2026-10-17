"""The memory operations ledger: idempotent replay, undo records and stubs.

Every successful v9 write records one row keyed by its caller-supplied
``operation_id``. A retry with the same id replays the stored response when
the action, scope and payload digest match, and is refused otherwise; an id
past its 24-hour retry window, or whose content was erased, is refused and
never re-executed. Erase, session purge and retention keep a content-free
stub (``stub=1``, no prior or response JSON) until ``expires_at`` so an old
id can never be re-enabled.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sidecar.ai.error_codes import (
    CMP_MEMORY_ALWAYS_ON_FULL,
    CMP_MEMORY_CAPACITY_EXCEEDED,
    CMP_MEMORY_FAILED,
    CMP_MEMORY_FINGERPRINT_CONFLICT,
    CMP_MEMORY_NOT_FOUND,
    CMP_MEMORY_OPERATION_EXPIRED,
    CMP_MEMORY_OPERATION_MISMATCH,
    CMP_MEMORY_PROJECT_ARCHIVED,
    CMP_MEMORY_PROTECTED,
    CMP_MEMORY_SESSION_PURGED,
    CMP_MEMORY_STALE_REVISION,
    CMP_MEMORY_SUPPRESSED,
)
from sidecar.ai.memory.contracts import (
    CONTENT_DIGEST_PREFIX,
    MAX_OPERATION_ID_CHARS,
    MAX_OPERATION_JSON_CHARS,
    OPERATION_RETRY_SECONDS,
)
from sidecar.ai.memory.datetime_utils import parse_iso_datetime
from sidecar.ai.memory.store_shared import ApprovedMemory, MemoryWriteResult
from sidecar.exceptions import MemoryStoreError

_OPERATION_ID_RE = re.compile(rf"^[A-Za-z0-9_.:-]{{1,{MAX_OPERATION_ID_CHARS}}}$")
STUB_GRACE = timedelta(hours=24)

REASON_CODES = {
    "suppressed": CMP_MEMORY_SUPPRESSED,
    "protected": CMP_MEMORY_PROTECTED,
    "stale_revision": CMP_MEMORY_STALE_REVISION,
    "not_found": CMP_MEMORY_NOT_FOUND,
    "project_archived": CMP_MEMORY_PROJECT_ARCHIVED,
    "session_purged": CMP_MEMORY_SESSION_PURGED,
    "already_remembered": CMP_MEMORY_FINGERPRINT_CONFLICT,
    "operation_mismatch": CMP_MEMORY_OPERATION_MISMATCH,
    "operation_expired": CMP_MEMORY_OPERATION_EXPIRED,
    "always_on_full": CMP_MEMORY_ALWAYS_ON_FULL,
    "capacity": CMP_MEMORY_CAPACITY_EXCEEDED,
}


def timestamp(moment: datetime) -> str:
    """One sortable text format for every v9 lifecycle timestamp."""

    return moment.astimezone(UTC).isoformat(timespec="microseconds")


def require_operation_id(value: Any) -> str:
    if not isinstance(value, str) or not _OPERATION_ID_RE.fullmatch(value):
        raise MemoryStoreError(CMP_MEMORY_FAILED, "operation_id is invalid")
    return value


def scope_key(project_id: str, scope_session_id: str) -> str:
    return f"{project_id}\u0000{scope_session_id}"


def project_scope_range(project_id: str) -> tuple[str, str]:
    """Bounds for ``lower <= scope_key < upper`` over one project's keys.

    A range compare, not ``substr``: SQLite text functions stop at the NUL
    separator, while BINARY comparison sees the whole key.
    """

    return f"{project_id}\u0000", f"{project_id}\u0001"


def payload_digest(action: str, payload: dict[str, Any]) -> str:
    material = json.dumps(
        {"action": action, **payload},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8", errors="strict")
    return f"{CONTENT_DIGEST_PREFIX}{hashlib.sha256(material).hexdigest()}"


def refusal(
    reason: str,
    *,
    status: str = "refused",
    memory: ApprovedMemory | None = None,
    always_on_lines: tuple[str, ...] = (),
) -> MemoryWriteResult:
    return MemoryWriteResult(
        status=status,  # type: ignore[arg-type]
        memory=memory,
        operation_id=None,
        reason=reason,
        code=REASON_CODES[reason],
        always_on_lines=always_on_lines,
    )


def memory_to_dict(memory: ApprovedMemory) -> dict[str, Any]:
    payload = asdict(memory)
    payload["source_message_ids"] = list(memory.source_message_ids)
    return payload


def memory_from_dict(payload: dict[str, Any]) -> ApprovedMemory:
    values = dict(payload)
    values["source_message_ids"] = tuple(values.get("source_message_ids") or ())
    values["protected"] = bool(values.get("protected"))
    values["always_on"] = bool(values.get("always_on"))
    return ApprovedMemory(**values)


def bounded_json(payload: dict[str, Any], *, droppable: tuple[str, ...]) -> str:
    """Serialize under the ledger cap, emptying the largest optional fields first."""

    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    trimmed = dict(payload)
    for key in droppable:
        if len(text) <= MAX_OPERATION_JSON_CHARS:
            break
        if isinstance(trimmed.get("memory"), dict) and key in trimmed["memory"]:
            empty: list[str] | str = [] if key == "source_message_ids" else ""
            trimmed["memory"] = {**trimmed["memory"], key: empty}
        elif key in trimmed:
            trimmed[key] = [] if key == "source_message_ids" else ""
        text = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"))
    if len(text) > MAX_OPERATION_JSON_CHARS:
        raise MemoryStoreError(CMP_MEMORY_FAILED, "memory operation record is too large")
    return text


def result_to_json(result: MemoryWriteResult) -> str:
    payload = {
        "status": result.status,
        "memory": memory_to_dict(result.memory) if result.memory is not None else None,
        "duplicate": result.duplicate,
        "undoable": result.undoable,
        "reason": result.reason,
        "code": result.code,
        "always_on_lines": list(result.always_on_lines),
    }
    return bounded_json(payload, droppable=("source_excerpt", "source_message_ids"))


def result_from_json(text: str, *, operation_id: str) -> MemoryWriteResult:
    payload = json.loads(text)
    memory = payload.get("memory")
    return MemoryWriteResult(
        status=payload["status"],
        memory=memory_from_dict(memory) if isinstance(memory, dict) else None,
        operation_id=operation_id,
        duplicate=bool(payload.get("duplicate")),
        replayed=True,
        undoable=bool(payload.get("undoable")),
        reason=payload.get("reason"),
        code=payload.get("code"),
        always_on_lines=tuple(payload.get("always_on_lines") or ()),
    )


@dataclass(frozen=True)
class OperationRow:
    operation_id: str
    action: str
    scope_key: str
    payload_digest: str
    memory_id: int | None
    op: str
    origin: str
    prior_json: str
    prior_suppression: str | None
    result_revision: int | None
    response_json: str
    created_at: str
    expires_at: str
    undone_at: str | None
    stub: bool

    def expired(self, now: datetime) -> bool:
        expires = parse_iso_datetime(self.expires_at)
        return self.stub or expires is None or expires <= now


_OPERATION_SELECT = """
SELECT operation_id, action, scope_key, payload_digest, memory_id, op, origin,
       prior_json, prior_suppression, result_revision, response_json,
       created_at, expires_at, undone_at, stub
FROM memory_operations
"""


def load_operation(connection: sqlite3.Connection, operation_id: str) -> OperationRow | None:
    row = connection.execute(
        f"{_OPERATION_SELECT} WHERE operation_id = ?", (operation_id,)
    ).fetchone()
    if row is None:
        return None
    return OperationRow(
        operation_id=str(row[0]),
        action=str(row[1]),
        scope_key=str(row[2]),
        payload_digest=str(row[3]),
        memory_id=None if row[4] is None else int(row[4]),
        op=str(row[5]),
        origin=str(row[6]),
        prior_json=str(row[7] or ""),
        prior_suppression=None if row[8] is None else str(row[8]),
        result_revision=None if row[9] is None else int(row[9]),
        response_json=str(row[10] or ""),
        created_at=str(row[11]),
        expires_at=str(row[12]),
        undone_at=None if row[13] is None else str(row[13]),
        stub=bool(row[14]),
    )


def check_replay(  # noqa: PLR0913 - the replay tuple is (id, action, scope, digest).
    connection: sqlite3.Connection,
    operation_id: str,
    *,
    action: str,
    scope: str,
    digest: str,
    now: datetime,
) -> MemoryWriteResult | None:
    """Return the replayed or refused result for a known id; None to execute."""

    existing = load_operation(connection, operation_id)
    if existing is None:
        return None
    if existing.expired(now) or not existing.response_json:
        return refusal("operation_expired")
    if (existing.action, existing.scope_key, existing.payload_digest) != (action, scope, digest):
        return refusal("operation_mismatch")
    return result_from_json(existing.response_json, operation_id=operation_id)


def insert_operation(  # noqa: PLR0913 - one ledger row has this many facts.
    connection: sqlite3.Connection,
    *,
    operation_id: str,
    action: str,
    scope: str,
    digest: str,
    memory_id: int | None,
    op: str,
    origin: str,
    prior: dict[str, Any] | None,
    prior_suppression: dict[str, Any] | None,
    result: MemoryWriteResult,
    now: datetime,
) -> None:
    connection.execute(
        """
        INSERT INTO memory_operations (
            operation_id, action, scope_key, payload_digest, memory_id, op, origin,
            prior_json, prior_suppression, result_revision, response_json,
            created_at, expires_at, undone_at, stub
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
        """,
        (
            operation_id,
            action,
            scope,
            digest,
            memory_id,
            op,
            origin,
            "" if prior is None else bounded_json(prior, droppable=("source_excerpt",)),
            None if prior_suppression is None else json.dumps(prior_suppression, sort_keys=True),
            None if result.memory is None else result.memory.revision,
            result_to_json(result),
            timestamp(now),
            timestamp(now + timedelta(seconds=OPERATION_RETRY_SECONDS)),
        ),
    )


def stub_operations(
    connection: sqlite3.Connection,
    *,
    where: str,
    params: tuple[Any, ...],
) -> int:
    """Turn matching ops into content-free stubs (retention deletes them later)."""

    cursor = connection.execute(
        f"""
        UPDATE memory_operations
        SET stub = 1, prior_json = '', response_json = '', prior_suppression = NULL,
            memory_id = NULL
        WHERE ({where})
        """,
        params,
    )
    return int(cursor.rowcount or 0)


def maintain_operations(connection: sqlite3.Connection, *, now: datetime) -> int:
    """Stub ops past their retry window; delete stubs a day after expiry."""

    stubbed = connection.execute(
        """
        UPDATE memory_operations
        SET stub = 1, prior_json = '', response_json = '', prior_suppression = NULL
        WHERE stub = 0 AND expires_at <= ?
        """,
        (timestamp(now),),
    ).rowcount
    deleted = connection.execute(
        "DELETE FROM memory_operations WHERE stub = 1 AND expires_at <= ?",
        (timestamp(now - STUB_GRACE),),
    ).rowcount
    return int(stubbed or 0) + int(deleted or 0)


__all__ = [
    "REASON_CODES",
    "OperationRow",
    "check_replay",
    "insert_operation",
    "load_operation",
    "maintain_operations",
    "memory_from_dict",
    "memory_to_dict",
    "payload_digest",
    "project_scope_range",
    "refusal",
    "require_operation_id",
    "result_from_json",
    "result_to_json",
    "scope_key",
    "stub_operations",
    "timestamp",
]
