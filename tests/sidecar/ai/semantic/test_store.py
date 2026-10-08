from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

import sidecar.ai.semantic.store as store_module
from sidecar.ai.error_codes import CMP_CATALOG_INDEX_UNAVAILABLE
from sidecar.ai.semantic.store import (
    SEMANTIC_CATALOG_SCHEMA_VERSION,
    CatalogStore,
    CatalogStoreError,
    ChunkInput,
    ScanEntry,
)


def test_schema_version_wal_and_foreign_keys(tmp_path: Path) -> None:
    store = CatalogStore(tmp_path / "c.db")
    try:
        assert store.schema_version == SEMANTIC_CATALOG_SCHEMA_VERSION
        connection = store._connection
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    finally:
        store.close()


def test_newer_schema_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "c.db"
    CatalogStore(path).close()
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("UPDATE meta SET value = '99' WHERE key = 'schema_version'")
        connection.commit()

    with pytest.raises(CatalogStoreError) as error:
        CatalogStore(path)

    assert error.value.code == CMP_CATALOG_INDEX_UNAVAILABLE
    assert path.exists()  # never set aside: it may belong to a newer app
    assert not list(tmp_path.glob("c.db.corrupt-*"))


def test_corrupt_file_is_set_aside_and_rebuilt(tmp_path: Path) -> None:
    path = tmp_path / "c.db"
    path.write_bytes(b"this is not a sqlite database at all" * 100)

    store = CatalogStore(path)
    try:
        assert store.schema_version == SEMANTIC_CATALOG_SCHEMA_VERSION
        aside = list(tmp_path.glob("c.db.corrupt-*"))
        assert len(aside) == 1
        assert aside[0].read_bytes().startswith(b"this is not")
    finally:
        store.close()


def test_root_delete_cascades_to_documents_chunks_and_vectors(tmp_path: Path) -> None:
    store = CatalogStore(tmp_path / "c.db")
    try:
        assert store.add_root("k", "/r")
        store.apply_scan("k", [ScanEntry("a.md", 1, 1)])
        doc = store.pending_documents(5)[0]
        assert store.replace_chunks(doc.doc_id, [ChunkInput(0, "L1-1", "hello")], "sha")
        chunk = store.chunks_missing_vectors("m", 5)[0]
        assert store.store_vectors("m", [(chunk.chunk_id, [1.0, 0.0])]) == 1

        assert store.delete_roots(["k"]) == 1

        counts = store.counts("m")
        assert (counts["documents"], counts["chunks"], counts["embedded"]) == (0, 0, 0)
        assert store._connection.execute("SELECT COUNT(*) FROM vectors").fetchone()[0] == 0
    finally:
        store.close()


def test_root_cap_stops_additions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store_module, "MAX_CATALOG_ROOTS", 1)
    store = CatalogStore(tmp_path / "c.db")
    try:
        assert store.add_root("a", "/a") is True
        assert store.add_root("b", "/b") is False
        assert store.add_root("a", "/a2") is True  # existing roots stay updatable
    finally:
        store.close()


def test_close_is_idempotent_and_releases_the_file(tmp_path: Path) -> None:
    path = tmp_path / "c.db"
    store = CatalogStore(path)
    store.close()
    store.close()

    assert store.closed
    path.rename(tmp_path / "moved.db")
