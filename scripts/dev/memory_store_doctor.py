"""Offline inspection and explicit repair utility for the sidecar memory store."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any, Sequence

from sidecar.ai.memory.contracts import (
    MAX_QUARANTINE_PAYLOAD_CHARS,
    MAX_QUARANTINE_ROWS,
)
from sidecar.ai.memory.store_migrations import SCHEMA_VERSION

_COUNT_TABLES = {
    "approved": "memories",
    "pending": "pending_memory_candidates",
    "suppressions": "memory_suppressions",
    "quarantined": "memory_quarantine",
    "extraction_runs": "memory_extraction_runs",
}
_MAX_IMPORT_ROWS = MAX_QUARANTINE_ROWS


def _safe_quarantine_payload(value: object) -> str:
    raw = str(value or "")[:MAX_QUARANTINE_PAYLOAD_CHARS]
    try:
        parsed = json.loads(raw)
    except ValueError:
        parsed = None
    allowed_keys = {"row_digest", "value_count", "value_types", "column_types"}
    if isinstance(parsed, dict) and set(parsed).issubset(allowed_keys):
        safe_payload = {
            key: parsed[key]
            for key in ("row_digest", "value_count", "value_types", "column_types")
            if key in parsed
        }
        return json.dumps(safe_payload, ensure_ascii=False, sort_keys=True)[
            :MAX_QUARANTINE_PAYLOAD_CHARS
        ]
    digest = hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()
    return json.dumps({"redacted_digest": f"sha256:{digest}"}, sort_keys=True)


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def inspect_store(db_path: Path) -> dict[str, Any]:
    """Inspect without creating, migrating, checkpointing, or exposing content."""

    resolved = db_path.resolve(strict=True)
    connection = sqlite3.connect(f"file:{resolved.as_posix()}?mode=ro", uri=True)
    try:
        version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        integrity_rows = connection.execute("PRAGMA quick_check(1)").fetchall()
        counts = {
            label: (
                int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
                if _table_exists(connection, table)
                else 0
            )
            for label, table in _COUNT_TABLES.items()
        }
        fts_available = _table_exists(connection, "memory_fts")
    finally:
        connection.close()
    physical_bytes = sum(
        candidate.stat().st_size
        for candidate in (resolved, Path(f"{resolved}-wal"), Path(f"{resolved}-shm"))
        if candidate.exists()
    )
    return {
        "available": True,
        "schema_version": version,
        "supported_schema_version": SCHEMA_VERSION,
        "future_schema": version > SCHEMA_VERSION,
        "integrity": "ok" if integrity_rows == [("ok",)] else "degraded",
        "recall_index": "fts5" if fts_available else "bounded_scan",
        "counts": counts,
        "physical_bytes": physical_bytes,
    }


def backup_store(db_path: Path, backup_path: Path) -> None:
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    if backup_path.exists():
        raise ValueError("backup path already exists")
    source = sqlite3.connect(str(db_path.resolve(strict=True)))
    destination = sqlite3.connect(str(backup_path.resolve(strict=False)))
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()


def export_quarantine(db_path: Path, export_path: Path) -> int:
    connection = sqlite3.connect(
        f"file:{db_path.resolve(strict=True).as_posix()}?mode=ro",
        uri=True,
    )
    try:
        if not _table_exists(connection, "memory_quarantine"):
            rows: list[tuple[Any, ...]] = []
        else:
            rows = connection.execute(
                """
                SELECT source_table, source_row_id, reason_code, raw_payload
                FROM memory_quarantine ORDER BY id ASC LIMIT ?
                """,
                (_MAX_IMPORT_ROWS,),
            ).fetchall()
    finally:
        connection.close()
    payload = [
        {
            "source_table": str(row[0])[:64],
            "source_row_id": str(row[1])[:256],
            "reason_code": str(row[2])[:64],
            "raw_payload": _safe_quarantine_payload(row[3]),
        }
        for row in rows
    ]
    export_path.parent.mkdir(parents=True, exist_ok=True)
    export_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(payload)


def repair_store(
    db_path: Path,
    backup_path: Path,
    *,
    restore_path: Path | None = None,
    delete_quarantine: bool = False,
    compact: bool = False,
) -> dict[str, int | bool]:
    if restore_path is not None and delete_quarantine:
        raise ValueError("quarantine restore and delete are mutually exclusive")
    backup_store(db_path, backup_path)
    connection = sqlite3.connect(str(db_path.resolve(strict=True)), timeout=10.0)
    connection.execute("PRAGMA busy_timeout=10000")
    try:
        version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if version > SCHEMA_VERSION:
            raise ValueError("future schema is not repairable by this doctor")
        restored = 0
        deleted = 0
        if restore_path is not None:
            payload = json.loads(restore_path.read_text(encoding="utf-8"))
            if not isinstance(payload, list) or len(payload) > _MAX_IMPORT_ROWS:
                raise ValueError("quarantine restore payload is invalid or oversized")
            connection.execute("BEGIN IMMEDIATE")
            for item in payload:
                if not isinstance(item, dict):
                    raise ValueError("quarantine restore row must be an object")
                values = (
                    str(item.get("source_table") or "")[:64],
                    str(item.get("source_row_id") or "")[:256],
                    str(item.get("reason_code") or "")[:64],
                    _safe_quarantine_payload(item.get("raw_payload")),
                )
                if not all(values[:3]):
                    raise ValueError("quarantine restore row is missing identity metadata")
                connection.execute(
                    """
                    INSERT INTO memory_quarantine (
                        source_table, source_row_id, reason_code, raw_payload
                    ) VALUES (?, ?, ?, ?)
                    """,
                    values,
                )
                restored += 1
            connection.execute(
                """
                DELETE FROM memory_quarantine
                WHERE id NOT IN (
                    SELECT id FROM memory_quarantine
                    ORDER BY quarantined_at DESC, id DESC
                    LIMIT ?
                )
                """,
                (MAX_QUARANTINE_ROWS,),
            )
            connection.commit()
        if delete_quarantine:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute("DELETE FROM memory_quarantine")
            deleted = max(int(cursor.rowcount), 0)
            connection.commit()
        if compact:
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            connection.execute("VACUUM")
        return {"backup_created": True, "restored": restored, "deleted": deleted}
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    finally:
        connection.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("db", type=Path)
    parser.add_argument("--export-quarantine", type=Path)
    quarantine_repair = parser.add_mutually_exclusive_group()
    quarantine_repair.add_argument("--restore-quarantine", type=Path)
    quarantine_repair.add_argument("--delete-quarantine", action="store_true")
    parser.add_argument("--compact", action="store_true")
    parser.add_argument("--backup", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result: dict[str, Any] = {"inspection": inspect_store(args.db)}
    if args.export_quarantine is not None:
        result["exported_quarantine"] = export_quarantine(args.db, args.export_quarantine)
    wants_repair = bool(args.restore_quarantine or args.delete_quarantine or args.compact)
    if wants_repair:
        if args.backup is None:
            raise SystemExit("--backup is required for repair operations")
        result["repair"] = repair_store(
            args.db,
            args.backup,
            restore_path=args.restore_quarantine,
            delete_quarantine=args.delete_quarantine,
            compact=args.compact,
        )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
