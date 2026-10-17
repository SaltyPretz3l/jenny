"""A22 coverage admission: hashless receipts, caps after freshness, truncation and failures."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from sidecar.ai.semantic import evidence as evidence_module
from sidecar.ai.semantic import extract as extract_module
from sidecar.ai.semantic import reader
from sidecar.ai.semantic.catalog import CatalogRootSpec, SemanticCatalog
from sidecar.ai.semantic.store import CatalogStore
from sidecar.ai.tools.builtins.knowledge import (
    configure_knowledge_tools,
    knowledge_search_tool,
    semantic_fusion,
)
from sidecar.ai.tools.workspace import WorkspaceGuard
from tests.sidecar.ai.semantic.fakes import FakeProvider

REPO = Path(__file__).resolve().parents[4]
TABLES_PDF = REPO / "tests/fixtures/retrieval-1-5/tables.pdf"
SCAN_PDF = REPO / "tests/fixtures/documents/scanned-text.pdf"


@pytest.fixture
def folder(tmp_path):
    root = tmp_path / "pdfs"
    root.mkdir()
    yield root
    configure_knowledge_tools(None)
    reader.configure_catalog_reader(None)


def _settle(catalog, root, *, rescan=False):
    for _ in range(60):
        step = catalog.index_step([CatalogRootSpec(str(root))], max_chunks=64, max_seconds=5.0,
                                  rescan=rescan)
        rescan = False
        assert step.error is None
        if not step.more:
            return
    pytest.fail("catalog did not settle")


def _catalog(root, tmp_path, provider=None):
    store = CatalogStore(tmp_path / "catalog.db")
    catalog = SemanticCatalog(store, provider or FakeProvider(), model_key="test",
                              query_template="{text}", document_template="{text}", dims=64)
    _settle(catalog, root)
    return catalog


def _search(catalog, monkeypatch, root, arguments):
    monkeypatch.setattr(semantic_fusion, "search_catalog", catalog.search)
    configure_knowledge_tools({"knowledge_roots": [str(root)]})
    result = knowledge_search_tool(arguments, WorkspaceGuard(None))
    return result, json.loads(result.output)


def _statuses(body):
    return {row["path"]: row["extraction"] for row in body.get("source_statuses", [])}


def test_hashless_too_large_receipt_is_revalidated_against_the_current_file(
    folder, tmp_path, monkeypatch
):
    monkeypatch.setattr(extract_module, "MAX_CONTAINER_FILE_BYTES", 4096)
    monkeypatch.setattr(evidence_module, "MAX_SOURCE_BYTES", 4096)
    (folder / "big.pdf").write_bytes(b"%PDF-1.4\n" + b"0" * 5000)
    catalog = _catalog(folder, tmp_path)
    try:
        _result, body = _search(catalog, monkeypatch, folder, {"pattern": "zzz"})
        receipt = _statuses(body)["pdfs/big.pdf"]
        assert (receipt["status"], receipt["reason"], receipt["source_hash"]) == (
            "unavailable", "too_large", None)
        # Replaced by a small readable PDF before the next scan: the old failure is obsolete.
        shutil.copyfile(TABLES_PDF, folder / "big.pdf")
        _result, body = _search(catalog, monkeypatch, folder, {"pattern": "zzz"})
        assert "pdfs/big.pdf" not in _statuses(body)
        _settle(catalog, folder, rescan=True)
        _result, body = _search(catalog, monkeypatch, folder, {"pattern": "zzz"})
        assert "pdfs/big.pdf" not in _statuses(body)
    finally:
        catalog.close()


def _write_paragraphs(path, words, count):
    path.write_text("\n\n".join(" ".join([words] * 90) for _ in range(count)) + "\n",
                    encoding="utf-8")


def test_stale_hits_do_not_consume_the_result_cap(folder, tmp_path, monkeypatch):
    _write_paragraphs(folder / "a-stale.md", "orbital transfer", 14)
    (folder / "current.md").write_text(
        "orbital transfer windows open when the planets align for the crew\n", encoding="utf-8")
    catalog = _catalog(folder, tmp_path)
    try:
        assert len(catalog.search("orbital transfer", root_paths=[str(folder)], limit=12).hits) == 12
        (folder / "a-stale.md").unlink()  # deleted before the next scan removes its chunks
        result, body = _search(catalog, monkeypatch, folder, {"query": "orbital transfer"})
        assert [p["path"] for p in body.get("passages", [])] == ["pdfs/current.md"]
        assert result.metadata["semantic_partial"] is False
    finally:
        catalog.close()


def test_stale_hits_beyond_the_admission_budget_mark_the_search_partial(
    folder, tmp_path, monkeypatch
):
    from sidecar.ai.semantic import catalog as catalog_module
    for name in ("a1.md", "a2.md", "a3.md"):
        _write_paragraphs(folder / name, "orbital transfer", 1)
    (folder / "current.md").write_text(
        "orbital transfer windows open when the planets align for the crew\n", encoding="utf-8")
    catalog = _catalog(folder, tmp_path)
    try:
        for name in ("a1.md", "a2.md", "a3.md"):
            (folder / name).unlink()
        monkeypatch.setattr(catalog_module, "MAX_ADMISSION_CHECKS", 2)
        result, body = _search(catalog, monkeypatch, folder, {"query": "orbital transfer"})
        assert not body.get("passages")
        assert result.metadata["semantic_partial"] is True
    finally:
        catalog.close()


def test_stale_statuses_do_not_consume_the_notice_cap(folder, tmp_path, monkeypatch):
    for index in range(8):
        shutil.copyfile(SCAN_PDF, folder / f"a{index}.pdf")
    shutil.copyfile(REPO / "tests/fixtures/retrieval-1-5/mixed.pdf", folder / "z-current.pdf")
    catalog = _catalog(folder, tmp_path)
    try:
        for index in range(8):
            (folder / f"a{index}.pdf").unlink()
        _result, body = _search(catalog, monkeypatch, folder, {"pattern": "zzz"})
        statuses = _statuses(body)
        assert list(statuses) == ["pdfs/z-current.pdf"]
        assert statuses["pdfs/z-current.pdf"]["pages_without_text"] == [2]
    finally:
        catalog.close()


class _Page:
    def __init__(self, number):
        self._text = f"Page {number} heading.\n" + f"Ledger entry for page {number}. " * 50

    def get_text(self, _mode):
        return self._text


class _ManyPagePdf:
    needs_pass = False

    def __init__(self, pages):
        self._pages = [_Page(n) for n in range(1, pages + 1)]

    def __len__(self):
        return len(self._pages)

    def __getitem__(self, index):
        return self._pages[index]

    def close(self):
        pass


def test_chunk_cap_truncation_is_disclosed_as_indexed_coverage(folder, tmp_path, monkeypatch):
    pdf = _ManyPagePdf(450)  # within the 500-page and text extraction limits
    monkeypatch.setattr(extract_module, "_load_fitz", lambda: type(
        "Fitz", (), {"open": staticmethod(lambda *_a, **_kw: pdf)}))
    (folder / "ledger.pdf").write_bytes(b"%PDF-1.4\n")
    catalog = _catalog(folder, tmp_path)
    try:
        assert catalog._store.counts("test")["chunks"] == 400
        _result, body = _search(catalog, monkeypatch, folder, {"pattern": "zzz"})
        receipt = _statuses(body)["pdfs/ledger.pdf"]
        assert (receipt["status"], receipt["examined_pages"]) == ("complete", 450)
        truncation = receipt["index_truncation"]
        assert truncation["max_chunks"] == 400
        last_page = int(truncation["indexed_through"].split("-")[-1].lstrip("p"))
        assert last_page < 450
    finally:
        catalog.close()


def test_embedding_failure_of_a_complete_native_pdf_is_a_failure_notice(
    folder, tmp_path, monkeypatch
):
    from tests.sidecar.ai.semantic.fakes import refused
    shutil.copyfile(TABLES_PDF, folder / "tables.pdf")
    provider = FakeProvider()
    provider.fail_with = refused()  # the reachable embedder rejects the document's chunks
    catalog = _catalog(folder, tmp_path, provider)
    try:
        counts = catalog._store.counts("test")
        assert (counts["failed"], counts["chunks"]) == (1, 0)
        provider.fail_with = None  # query embedding succeeds
        result, body = _search(catalog, monkeypatch, folder, {"query": "quarterly revenue table"})
        assert not body.get("passages")
        receipt = _statuses(body)["pdfs/tables.pdf"]
        assert receipt["status"] == "complete"  # the native-text receipt stays truthful
        assert receipt["index_failure"] == "embed_failed"
        assert result.metadata["semantic_passages"] == 0
    finally:
        catalog.close()


@pytest.mark.parametrize("index", ["missing", "schema_mismatch"])
def test_regex_only_search_discloses_an_unreadable_coverage_index(
    folder, tmp_path, monkeypatch, index
):
    import sqlite3

    from sidecar.ai.config_models import SemanticCatalogConfig
    from sidecar.ai.error_codes import CMP_CATALOG_INDEX_UNAVAILABLE
    shutil.copyfile(SCAN_PDF, folder / "scan.pdf")
    db_path = tmp_path / "catalog.db"
    if index == "schema_mismatch":
        CatalogStore(db_path).close()
        with sqlite3.connect(db_path) as db:
            db.execute("UPDATE meta SET value='99' WHERE key='schema_version'")
    provider = FakeProvider()
    provider.fail_with = AssertionError("Regex coverage lookup must not embed")
    monkeypatch.setattr(reader, "OpenAICompatibleEmbeddingProvider", lambda *_a, **_kw: provider)
    reader.configure_catalog_reader(SemanticCatalogConfig(
        enabled=True, db_path=str(db_path), base_url="http://127.0.0.1:50123/v1",
        model_key="test", query_template="{text}", document_template="{text}", dims=64))
    configure_knowledge_tools({"knowledge_roots": [str(folder)]})
    result = knowledge_search_tool({"pattern": "balance", "path": "pdfs/scan.pdf"},
                                   WorkspaceGuard(None))
    body = json.loads(result.output)
    assert not body.get("source_statuses")
    assert semantic_fusion.NOTE_COVERAGE_UNAVAILABLE in body["note"]
    assert result.metadata["semantic_reason"] == CMP_CATALOG_INDEX_UNAVAILABLE
    assert provider.calls == []


class _RefreshDuringQuery(FakeProvider):
    """Runs ``refresh`` once inside the next query embedding, like the background writer."""

    def __init__(self):
        super().__init__()
        self.refresh = None

    def embed_many(self, texts, *, timeout_seconds):
        refresh, self.refresh = self.refresh, None
        if refresh is not None:
            refresh()
        return super().embed_many(texts, timeout_seconds=timeout_seconds)


def test_a_document_rewritten_between_coverage_and_ranking_is_admitted(
    folder, tmp_path, monkeypatch
):
    shutil.copyfile(REPO / "tests/fixtures/retrieval-1-5/mixed.pdf", folder / "report.pdf")
    provider = _RefreshDuringQuery()
    catalog = _catalog(folder, tmp_path, provider)
    try:
        # The file now holds version B; the catalog's coverage receipt still describes A.
        shutil.copyfile(TABLES_PDF, folder / "report.pdf")
        provider.refresh = lambda: _settle(catalog, folder, rescan=True)  # B indexed mid-search
        result, body = _search(catalog, monkeypatch, folder, {"query": "quarterly revenue table"})
        # A22 review R3: A's failed freshness verdict was reused for B's ranked chunks.
        assert "pdfs/report.pdf" in [p["path"] for p in body.get("passages", [])]
        assert result.metadata["semantic_passages"] > 0
        assert "pdfs/report.pdf" not in _statuses(body)  # A's stale receipt stays hidden
    finally:
        catalog.close()


# The exact schema-2 tables (before A22): no new fields are smuggled into the fixture.
_V2_TABLES = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('schema_version','2');
CREATE TABLE roots (root_key TEXT PRIMARY KEY, path TEXT NOT NULL, scan_complete_at TEXT);
CREATE TABLE documents (doc_id INTEGER PRIMARY KEY,
  root_key TEXT NOT NULL REFERENCES roots(root_key) ON DELETE CASCADE,
  rel_path TEXT NOT NULL, size INTEGER, mtime_ns INTEGER, sha256 TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','indexed','failed','skipped')),
  extraction_json TEXT, reason TEXT, seen_scan INTEGER NOT NULL DEFAULT 0, updated_at TEXT,
  UNIQUE(root_key, rel_path));
CREATE TABLE chunks (chunk_id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, locator TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(doc_id, ordinal));
CREATE TABLE vectors (chunk_id INTEGER NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  model_key TEXT NOT NULL, dim INTEGER NOT NULL, norm REAL NOT NULL, blob BLOB NOT NULL,
  PRIMARY KEY(chunk_id, model_key));
"""


def _legacy_v2_catalog(db_path, root, documents):
    """``documents``: ``{rel_path: (legacy chunk locators, extraction receipt)}`` as stored."""
    import hashlib
    import sqlite3

    from sidecar.ai.semantic.evidence import root_key_for
    from sidecar.ai.semantic.vectors import pack_vector
    from tests.sidecar.ai.semantic.fakes import bag_of_words
    key = root_key_for(str(root))
    with sqlite3.connect(db_path) as db:
        db.executescript(_V2_TABLES)
        db.execute("INSERT INTO roots VALUES (?, ?, 'done')", (key, os.path.realpath(root)))
        for rel, (locators, receipt) in documents.items():
            source = root / rel
            stat = source.stat()
            doc_id = db.execute(
                "INSERT INTO documents (root_key, rel_path, size, mtime_ns, sha256, status,"
                " extraction_json, seen_scan, updated_at) VALUES (?,?,?,?,?,'indexed',?,1,'old')",
                (key, rel, stat.st_size, stat.st_mtime_ns,
                 hashlib.sha256(source.read_bytes()).hexdigest(),
                 json.dumps(receipt) if receipt else None)).lastrowid
            for ordinal, locator in enumerate(locators):
                chunk_id = db.execute(
                    "INSERT INTO chunks (doc_id, ordinal, locator, text) VALUES (?,?,?,?)",
                    (doc_id, ordinal, locator, f"legacy {rel} {ordinal}")).lastrowid
                blob, dim, norm = pack_vector(bag_of_words(f"legacy {rel} {ordinal}"))
                db.execute("INSERT INTO vectors VALUES (?, 'test', ?, ?, ?)",
                           (chunk_id, dim, norm, blob))


def _locators(store, rel):
    return [row[0] for row in store._connection.execute(
        "SELECT c.locator FROM chunks c JOIN documents d ON d.doc_id = c.doc_id"
        " WHERE d.rel_path = ? ORDER BY c.ordinal", (rel,))]


def test_a_schema_2_catalog_reindexes_overlap_locators_and_truncation_once(
    folder, tmp_path, monkeypatch
):
    import hashlib

    from sidecar.ai.semantic.evidence import pdf_evidence
    pdf = _ManyPagePdf(450)
    monkeypatch.setattr(extract_module, "_load_fitz", lambda: type(
        "Fitz", (), {"open": staticmethod(lambda *_a, **_kw: pdf)}))
    (folder / "ledger.pdf").write_bytes(b"%PDF-1.4\n")
    (folder / "notes.md").write_text(
        ("alpha " * 170).strip() + "\n\n" + ("omega " * 170).strip() + "\n", encoding="utf-8")
    (folder / "small.md").write_text("one short line\n", encoding="utf-8")
    db_path = tmp_path / "catalog.db"
    pdf_hash = hashlib.sha256(b"%PDF-1.4\n").hexdigest()
    _legacy_v2_catalog(db_path, folder, {
        # Pre-A22: the overlap chunk's locator left out the line its tail came from.
        "notes.md": (["L1-1", "L3-3"], None),
        # Pre-A22: 400 chunks, a complete receipt and no disclosed index truncation.
        "ledger.pdf": ([f"p{n}" for n in range(1, 401)], pdf_evidence(
            source_hash=pdf_hash, total_pages=450, examined_pages=450)),
        "small.md": (["L1-1"], None),  # one chunk: no overlap, nothing to redo
    })
    store = CatalogStore(db_path)
    kept = store._connection.execute(
        "SELECT c.chunk_id FROM chunks c JOIN documents d ON d.doc_id = c.doc_id"
        " WHERE d.rel_path = 'small.md'").fetchall()
    catalog = SemanticCatalog(store, FakeProvider(), model_key="test",
                              query_template="{text}", document_template="{text}", dims=64)
    try:
        _settle(catalog, folder, rescan=True)  # unchanged source bytes, size and mtime
        # A22 review R1: the same-hash early return kept every legacy row forever.
        assert _locators(store, "notes.md") == ["L1-1", "L1-3"]
        _result, body = _search(catalog, monkeypatch, folder, {"pattern": "zzz"})
        truncation = _statuses(body)["pdfs/ledger.pdf"]["index_truncation"]
        assert truncation["max_chunks"] == 400
        assert store._connection.execute(
            "SELECT chunk_id FROM chunks c JOIN documents d ON d.doc_id = c.doc_id"
            " WHERE d.rel_path = 'small.md'").fetchall() == kept
        counts = store.counts("test")
        assert counts["embedded"] == counts["chunks"]
        assert not store._connection.execute(
            "SELECT 1 FROM chunks WHERE text LIKE 'legacy notes.md%'"
            " OR text LIKE 'legacy ledger.pdf%'").fetchall()
        rebuilt = store._connection.execute("SELECT chunk_id FROM chunks").fetchall()
        catalog.close()
        reopened = CatalogStore(db_path)  # schema 3 now: the migration does not run again
        assert reopened.schema_version == 3
        assert reopened._connection.execute("SELECT chunk_id FROM chunks").fetchall() == rebuilt
        reopened.close()
    finally:
        catalog.close()


@pytest.mark.parametrize("refresh", [False, True], ids=["catalog_behind", "catalog_caught_up"])
def test_a_current_pdf_replaced_during_query_embedding_is_judged_by_its_new_bytes(
    folder, tmp_path, monkeypatch, refresh
):
    import hashlib
    shutil.copyfile(REPO / "tests/fixtures/retrieval-1-5/mixed.pdf", folder / "report.pdf")
    old_hash = hashlib.sha256((folder / "report.pdf").read_bytes()).hexdigest()
    provider = _RefreshDuringQuery()
    catalog = _catalog(folder, tmp_path, provider)
    try:
        def replace_during_embedding():
            shutil.copyfile(TABLES_PDF, folder / "report.pdf")  # version A -> B mid-search
            if refresh:
                _settle(catalog, folder, rescan=True)
        provider.refresh = replace_during_embedding
        _result, body = _search(catalog, monkeypatch, folder, {"query": "shipment code kestrel"})
        # A22 review w2g2-R1: A's verdict, taken before the embedding wait, was reused.
        assert [p for p in body.get("passages", [])
                if p["path"] == "pdfs/report.pdf" and p.get("source_hash") in (old_hash, None)] == []
        assert "pdfs/report.pdf" not in _statuses(body)
    finally:
        catalog.close()
