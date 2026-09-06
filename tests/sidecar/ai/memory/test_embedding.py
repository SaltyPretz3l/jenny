from __future__ import annotations

import json
import math
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

import sidecar.ai.memory.embedding as embedding_module
from sidecar.ai.memory.embedding import (
    EmbeddingStore,
    SemanticRecallService,
)
from sidecar.exceptions import MemoryStoreError


def test_embedding_store_roundtrip():
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            store.store_embedding(1, [0.1, 0.2, 0.3], model_name="test-model")
            result = store.get_embedding(1)
            assert result is not None
            assert len(result) == 3
            assert math.isclose(result[0], 0.1, rel_tol=1e-6)
            assert store.count() == 1
        finally:
            store.close()


def test_embedding_store_delete():
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            store.store_embedding(1, [0.1, 0.2])
            store.delete_embedding(1)
            assert store.get_embedding(1) is None
            assert store.count() == 0
        finally:
            store.close()


def test_embedding_delete_failure_rolls_back_and_allows_next_write(tmp_path: Path) -> None:
    store = EmbeddingStore(tmp_path / "test.db")
    try:
        store.store_embedding(1, [0.1, 0.2])
        store._connection.execute(  # noqa: SLF001
            """
            CREATE TRIGGER fail_embedding_delete
            BEFORE DELETE ON memory_embeddings
            BEGIN
                SELECT RAISE(ABORT, 'injected delete failure');
            END
            """
        )
        store._connection.commit()  # noqa: SLF001

        with pytest.raises(sqlite3.IntegrityError, match="injected delete failure"):
            store.delete_embedding(1)

        assert store._connection.in_transaction is False  # noqa: SLF001
        assert store.get_embedding(1) is not None
        store._connection.execute("DROP TRIGGER fail_embedding_delete")  # noqa: SLF001
        store._connection.commit()  # noqa: SLF001
        store.store_embedding(2, [0.3, 0.4])
        assert store.get_embedding(2) is not None
    finally:
        store.close()


def test_embedding_store_find_similar():
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            store.store_embedding(1, [1.0, 0.0, 0.0])
            store.store_embedding(2, [0.9, 0.1, 0.0])
            store.store_embedding(3, [0.0, 0.0, 1.0])
            scan = store.find_similar([1.0, 0.0, 0.0], limit=2, min_similarity=0.5)
            assert len(scan.matches) == 2
            assert scan.matches[0].memory_id == 1
            assert scan.matches[0].similarity > scan.matches[1].similarity
            assert scan.aborted_by_scan_cap is False
            assert scan.scanned_rows == 3
        finally:
            store.close()


def test_find_similar_excludes_other_model_vectors():
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            store.store_embedding(1, [1.0, 0.0], model_name="model-a")
            store.store_embedding(2, [1.0, 0.0], model_name="model-b")
            store.store_embedding(3, [0.9, 0.1], model_name="model-a")
            scan = store.find_similar(
                [1.0, 0.0], limit=5, min_similarity=0.0, model_name="model-a"
            )
            assert sorted(m.memory_id for m in scan.matches) == [1, 3]
            assert scan.scanned_rows == 2
        finally:
            store.close()


def test_find_similar_excludes_mismatched_dimensions():
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            store.store_embedding(1, [1.0, 0.0])
            store.store_embedding(2, [1.0, 0.0, 0.0])
            scan = store.find_similar([1.0, 0.0], limit=5, min_similarity=0.0)
            assert [m.memory_id for m in scan.matches] == [1]
        finally:
            store.close()


def test_find_similar_scan_cap_is_observable():
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            for memory_id in range(1, 6):
                store.store_embedding(memory_id, [1.0, 0.0])
            scan = store.find_similar(
                [1.0, 0.0], limit=10, min_similarity=0.0, scan_cap=3
            )
            assert scan.aborted_by_scan_cap is True
            assert scan.scanned_rows == 3
            assert len(scan.matches) == 3
            uncapped = store.find_similar([1.0, 0.0], limit=10, min_similarity=0.0)
            assert uncapped.aborted_by_scan_cap is False
            assert uncapped.scanned_rows == 5
        finally:
            store.close()


def test_find_similar_zero_query_returns_empty():
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            store.store_embedding(1, [1.0, 0.0])
            scan = store.find_similar([0.0, 0.0])
            assert scan.matches == []
            assert scan.scanned_rows == 0
        finally:
            store.close()


@pytest.mark.parametrize(
    "vector",
    [[], [float("nan")], [float("inf")], [True], ["1"]],
)
def test_embedding_store_rejects_malformed_vectors(vector):
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            with pytest.raises(ValueError):
                store.store_embedding(1, vector)
        finally:
            store.close()


def test_embedding_store_rejects_invalid_ids_limits_and_thresholds():
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            with pytest.raises(ValueError):
                store.store_embedding(-1, [1.0])
            with pytest.raises(ValueError):
                store.find_similar([1.0], limit=-1)
            with pytest.raises(ValueError):
                store.find_similar([1.0], scan_cap=0)
            with pytest.raises(ValueError):
                store.find_similar([1.0], min_similarity=float("nan"))
        finally:
            store.close()


def test_embedding_store_future_schema_is_preserved_and_refused(tmp_path: Path):
    db_path = tmp_path / "future.db"
    connection = sqlite3.connect(db_path)
    connection.execute(
        "CREATE TABLE embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    connection.execute(
        "INSERT INTO embedding_meta (key, value) VALUES ('schema_version', '999')"
    )
    connection.execute("CREATE TABLE future_marker (value TEXT NOT NULL)")
    connection.execute("INSERT INTO future_marker VALUES ('preserve-me')")
    connection.commit()
    connection.close()

    with pytest.raises(MemoryStoreError, match="future embedding schema"):
        EmbeddingStore(db_path)

    connection = sqlite3.connect(db_path)
    try:
        assert connection.execute("SELECT value FROM future_marker").fetchone() == (
            "preserve-me",
        )
        assert connection.execute(
            "SELECT value FROM embedding_meta WHERE key = 'schema_version'"
        ).fetchone() == ("999",)
    finally:
        connection.close()


def test_embedding_store_concurrent_writes_and_orphan_cleanup(tmp_path: Path):
    store = EmbeddingStore(tmp_path / "concurrent.db")
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda memory_id: store.store_embedding(memory_id, [1.0]), range(1, 21)))
        assert store.count() == 20
        assert store.purge_orphans({1, 2, 3}) == 17
        assert store.count() == 3
    finally:
        store.close()


def test_embedding_store_retention_only_deletes_derived_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(embedding_module, "MAX_EMBEDDING_ROWS", 3)
    store = EmbeddingStore(tmp_path / "retention.db")
    try:
        for memory_id in range(1, 6):
            store.store_embedding(memory_id, [1.0])
        assert store.count() == 3
        assert store.get_embedding(1) is None
        assert store.get_embedding(5) == [1.0]
    finally:
        store.close()


def _create_v1_db(db_path: Path, vectors: dict[int, list[float]]) -> None:
    connection = sqlite3.connect(str(db_path))
    connection.execute(
        "CREATE TABLE embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    connection.execute("""
        CREATE TABLE memory_embeddings (
            memory_id  INTEGER PRIMARY KEY,
            embedding  TEXT NOT NULL,
            model_name TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT ''
        )
    """)
    connection.execute(
        "INSERT INTO embedding_meta (key, value) VALUES ('schema_version', '1')"
    )
    for memory_id, vector in vectors.items():
        connection.execute(
            "INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)",
            (memory_id, json.dumps(vector)),
        )
    connection.commit()
    connection.close()


class _MappingProvider:
    """Provider stub that embeds each known text to a fixed vector."""

    def __init__(self, vectors_by_text):
        self._vectors_by_text = vectors_by_text

    def embed(self, text, *, timeout_seconds):
        assert timeout_seconds > 0
        return self._vectors_by_text[text]


def test_v1_migration_preserves_top_k_after_reembed():
    vectors = {
        1: [1.0, 0.0, 0.0],
        2: [0.9, 0.1, 0.0],
        3: [0.5, 0.5, 0.0],
        4: [0.0, 0.0, 1.0],
    }
    query = [1.0, 0.0, 0.0]
    query_norm = math.sqrt(sum(value * value for value in query))
    reference = sorted(
        (
            (
                memory_id,
                sum(left * right for left, right in zip(query, vector, strict=True))
                / (query_norm * math.sqrt(sum(value * value for value in vector))),
            )
            for memory_id, vector in vectors.items()
            if sum(left * right for left, right in zip(query, vector, strict=True))
            / (query_norm * math.sqrt(sum(value * value for value in vector)))
            >= 0.3
        ),
        key=lambda pair: pair[1],
        reverse=True,
    )
    reference_top_k = [memory_id for memory_id, _ in reference[:3]]

    with TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        _create_v1_db(db_path, vectors)

        store = EmbeddingStore(db_path)
        try:
            # Migration preserves the v1 rows for re-embedding; the new
            # table starts empty.
            assert store.count() == 0
            assert sorted(store.legacy_memory_ids()) == [1, 2, 3, 4]

            texts = {memory_id: f"memory-{memory_id}" for memory_id in vectors}
            provider = _MappingProvider(
                {texts[memory_id]: vector for memory_id, vector in vectors.items()}
            )
            service = SemanticRecallService(store, provider=provider)
            reembedded = service.reembed_legacy(texts.get, model_name="m")
            assert reembedded == 4
            assert store.legacy_memory_ids() == []

            scan = store.find_similar(
                query, limit=3, min_similarity=0.3, model_name="m"
            )
            assert [m.memory_id for m in scan.matches] == reference_top_k
            for match, (_, expected_sim) in zip(scan.matches, reference, strict=False):
                assert math.isclose(match.similarity, expected_sim, rel_tol=1e-5)
        finally:
            store.close()


def test_reembed_legacy_keeps_failed_rows_for_retry():
    with TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        _create_v1_db(db_path, {1: [1.0, 0.0], 2: [0.0, 1.0], 3: [0.5, 0.5]})

        store = EmbeddingStore(db_path)
        try:
            texts = {1: "one", 2: "two", 3: None}
            # Provider only knows "one": memory 2 hits a transient failure
            # (KeyError inside embed), memory 3 has no text (memory gone).
            provider = _MappingProvider({"one": [1.0, 0.0]})
            service = SemanticRecallService(store, provider=provider)
            assert service.reembed_legacy(texts.get, model_name="m") == 1
            # The failed row stays pending for retry; the text-less row is
            # discarded; the table survives because a row remains.
            assert store.legacy_memory_ids() == [2]

            provider._vectors_by_text["two"] = [0.0, 1.0]
            assert service.reembed_legacy(texts.get, model_name="m") == 1
            assert store.legacy_memory_ids() == []
            assert store.count() == 2
        finally:
            store.close()


def test_v1_migration_without_provider_keeps_legacy_rows():
    with TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        _create_v1_db(db_path, {1: [1.0, 0.0], 2: [0.0, 1.0]})

        store = EmbeddingStore(db_path)
        try:
            service = SemanticRecallService(store, provider=None)
            assert service.reembed_legacy(lambda memory_id: "text") == 0
            # Legacy rows survive so a later provider config can recover.
            assert sorted(store.legacy_memory_ids()) == [1, 2]
        finally:
            store.close()

        # Reopening the migrated store must not clobber the pending rows.
        reopened = EmbeddingStore(db_path)
        try:
            assert sorted(reopened.legacy_memory_ids()) == [1, 2]
        finally:
            reopened.close()


class _StubProvider:
    def __init__(self, embedding):
        self._embedding = embedding

    def embed(self, text, *, timeout_seconds):
        assert timeout_seconds > 0
        return self._embedding


class _ProviderWithoutDeadline:
    def embed(self, text):
        return [1.0]


def test_semantic_recall_service_available():
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            service = SemanticRecallService(store, provider=_StubProvider([1.0, 0.0]))
            assert service.available is True

            service_no_provider = SemanticRecallService(store, provider=None)
            assert service_no_provider.available is False
            unsupported = SemanticRecallService(store, provider=_ProviderWithoutDeadline())
            assert unsupported.available is False
        finally:
            store.close()


def test_semantic_recall_service_embed_and_recall():
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            provider = _StubProvider([0.8, 0.2])
            service = SemanticRecallService(store, provider=provider)
            assert service.embed_memory(1, "test text") is True
            results = service.recall_similar("query", limit=5)
            assert len(results) == 1
            assert results[0].memory_id == 1
        finally:
            store.close()


def test_semantic_recall_service_filters_by_model_name():
    with TemporaryDirectory() as tmpdir:
        store = EmbeddingStore(Path(tmpdir) / "test.db")
        try:
            provider = _StubProvider([0.8, 0.2])
            service = SemanticRecallService(store, provider=provider)
            assert service.embed_memory(1, "text", model_name="model-a") is True
            assert service.recall_similar("query", model_name="model-a") != []
            assert service.recall_similar("query", model_name="model-b") == []
        finally:
            store.close()


def test_semantic_recall_partial_scan_cannot_influence_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(embedding_module, "MAX_SIMILARITY_SCAN_ROWS", 2)
    store = EmbeddingStore(tmp_path / "partial.db")
    try:
        for memory_id in range(1, 4):
            store.store_embedding(memory_id, [1.0, 0.0])
        service = SemanticRecallService(store, provider=_StubProvider([1.0, 0.0]))
        assert service.recall_similar("query") == []
        assert service.last_recall_partial is True
    finally:
        store.close()
