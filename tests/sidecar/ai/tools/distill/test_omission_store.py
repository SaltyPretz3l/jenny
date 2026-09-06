"""Tests for the tool-output omission store (reversible distillation backing).

RED-FIRST: authored before ``sidecar/ai/tools/distill/omission_store.py`` exists;
the import fails for the right reason until the module is implemented.
"""

from __future__ import annotations

import re
import secrets
import sqlite3
import time
import zlib
from pathlib import Path

from sidecar.ai.tools.distill import omission_store_migrations as migrations
from sidecar.ai.tools.distill.omission_store import OmissionStore

_REF_RE = re.compile(r"^[0-9a-f]{12}$")


def _backdate(db_path: Path, ref: str, created_at: float) -> None:
    """Rewrite a row's created_at via a second connection (WAL allows it)."""
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            "UPDATE omissions SET created_at=? WHERE ref=?",
            (created_at, ref),
        )
        conn.commit()
    finally:
        conn.close()


def _row_count(db_path: Path) -> int:
    conn = sqlite3.connect(str(db_path))
    try:
        return int(conn.execute("SELECT COUNT(*) FROM omissions").fetchone()[0])
    finally:
        conn.close()


def _stored_content(db_path: Path, ref: str) -> str | None:
    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute("SELECT content FROM omissions WHERE ref=?", (ref,)).fetchone()
        return None if row is None else zlib.decompress(row[0]).decode("utf-8")
    finally:
        conn.close()


def test_put_returns_stable_12hex_ref(tmp_path: Path) -> None:
    store = OmissionStore(tmp_path / "omissions.db")
    ref1 = store.put("hello world", source="stdout")
    ref2 = store.put("hello world", source="stdout")
    assert _REF_RE.match(ref1), ref1
    assert ref1 == ref2  # content-addressed → stable + idempotent
    assert _row_count(tmp_path / "omissions.db") == 1


def test_ttl_prune_drops_rows_older_than_ttl(tmp_path: Path) -> None:
    db = tmp_path / "omissions.db"
    store = OmissionStore(db, ttl_days=7.0)
    old_ref = store.put("stale content", source="stdout")
    _backdate(db, old_ref, time.time() - 8 * 86400)  # older than 7 days
    fresh_ref = store.put("fresh content", source="stdout")  # opportunistic prune
    assert _stored_content(db, old_ref) is None
    assert _stored_content(db, fresh_ref) == "fresh content"


def test_size_cap_prune_evicts_oldest_but_keeps_newest(tmp_path: Path) -> None:
    db = tmp_path / "omissions.db"
    store = OmissionStore(db, max_mb=0.0005)  # 500 bytes cap
    big = secrets.token_hex(2000)  # 4000 hex chars → well over the cap even compressed
    old_ref = store.put(big + "OLD", source="stdout")
    _backdate(db, old_ref, time.time() - 100.0)
    new_ref = store.put(big + "NEW", source="stdout")  # prune evicts the oldest
    assert _stored_content(db, old_ref) is None
    assert _stored_content(db, new_ref) is not None  # never evicts the row just written


def test_size_cap_keeps_a_single_over_cap_entry(tmp_path: Path) -> None:
    db = tmp_path / "omissions.db"
    store = OmissionStore(db, max_mb=0.0005)
    big = secrets.token_hex(2000)
    ref = store.put(big, source="stdout")
    # A lone entry that exceeds the cap is retained (never evict the last row).
    assert _stored_content(db, ref) is not None


def test_put_refreshes_liveness_of_existing_content(tmp_path: Path) -> None:
    # Regression pin (review C1): INSERT OR IGNORE left a stale created_at, so
    # re-putting identical content and then TTL-pruning in the SAME put could
    # delete the row the fresh marker points to. put() must refresh created_at.
    db = tmp_path / "omissions.db"
    store = OmissionStore(db, ttl_days=7.0)
    ref = store.put("recurring parade", source="stdout")
    _backdate(db, ref, time.time() - 8 * 86400)  # older than the TTL
    ref_again = store.put("recurring parade", source="stdout")  # prune runs inside
    assert ref_again == ref
    assert _stored_content(db, ref) == "recurring parade"  # still resolvable — not TTL-pruned


def test_size_cap_prune_evicts_multiple_oldest_incrementally(tmp_path: Path) -> None:
    db = tmp_path / "omissions.db"
    store = OmissionStore(db, max_mb=0.0005)  # 500 bytes
    olds = []
    for i in range(5):
        ref = store.put(secrets.token_hex(200) + str(i), source="s", prune=False)
        _backdate(db, ref, time.time() - (100 - i))  # refs[0] oldest
        olds.append(ref)
    new_ref = store.put(secrets.token_hex(200) + "new", source="s")  # prune runs
    assert _stored_content(db, new_ref) is not None
    # Multiple oldest rows evicted in one prune (incremental-total loop).
    assert _stored_content(db, olds[0]) is None
    assert _stored_content(db, olds[1]) is None
    assert _stored_content(db, olds[2]) is None


def test_prune_protect_refs_survive_size_cap(tmp_path: Path) -> None:
    # Batch-protection contract (review C2): protected refs are never victims;
    # a protected-only over-cap store overshoots transiently instead.
    db = tmp_path / "omissions.db"
    store = OmissionStore(db, max_mb=0.0001)  # 100 bytes
    a = store.put(secrets.token_hex(300), source="s", prune=False)
    b = store.put(secrets.token_hex(300), source="s", prune=False)
    store.prune(protect=(a, b))
    assert _stored_content(db, a) is not None
    assert _stored_content(db, b) is not None


def test_schema_version_journal_mode_and_index(tmp_path: Path) -> None:
    db = tmp_path / "omissions.db"
    store = OmissionStore(db)
    assert store.journal_mode == "wal"
    conn = sqlite3.connect(str(db))
    try:
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        indexes = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            ).fetchall()
        }
    finally:
        conn.close()
    assert version == migrations.SCHEMA_VERSION == 1
    assert "idx_omissions_created" in indexes
