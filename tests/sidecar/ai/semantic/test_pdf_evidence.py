"""R1 PDF evidence: completeness, cache migration and real knowledge boundaries."""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from pathlib import Path

import pytest

from sidecar.ai.semantic import extract as extract_module
from sidecar.ai.semantic import reader
from sidecar.ai.semantic.catalog import CatalogRootSpec, SemanticCatalog
from sidecar.ai.semantic.extract import extract_document
from sidecar.ai.semantic.store import CatalogStore, CatalogStoreError
from sidecar.ai.tools.builtins.knowledge import (
    configure_knowledge_tools,
    knowledge_search_tool,
    knowledge_view_tool,
)
from sidecar.ai.tools.builtins.rich_files.pdf import pdf_inspect_tool
from sidecar.ai.tools.workspace import WorkspaceGuard
from tests.sidecar.ai.semantic.fakes import FakeProvider

REPO = Path(__file__).resolve().parents[4]

@pytest.fixture
def pdfs(tmp_path):
    root = tmp_path / "pdfs"
    root.mkdir()
    shutil.copyfile(REPO / "tests/fixtures/retrieval-1-5/mixed.pdf", root / "mixed.pdf")
    shutil.copyfile(REPO / "tests/fixtures/documents/scanned-text.pdf", root / "scan.pdf")
    (root / "broken.pdf").write_bytes(b"%PDF-1.4 broken")
    yield root
    configure_knowledge_tools(None)
    reader.configure_catalog_reader(None)


def test_mixed_and_unavailable_pdf_evidence_preserves_page_identity(pdfs):
    guard = WorkspaceGuard(str(pdfs))
    mixed = extract_document(pdfs / "mixed.pdf", guard)
    info = mixed.extraction
    assert mixed.status == "ok"
    assert info["status"] == "partial"
    assert info["total_pages"] == info["examined_pages"] == 2
    assert info["pages_without_text"] == [2]
    assert info["reason"] == "missing_text_layer"
    assert info["source_hash"] == hashlib.sha256((pdfs / "mixed.pdf").read_bytes()).hexdigest()
    assert info["parser_version"] == 2
    assert [s[0] for s in mixed.sections] == ["p1"]
    for name, reason in [("scan.pdf", "needs_ocr"), ("broken.pdf", "pdf_unreadable")]:
        result = extract_document(pdfs / name, guard)
        assert result.extraction["status"] == "unavailable"
        assert result.extraction["reason"] == reason
        assert result.extraction["source_hash"] == result.sha256


@pytest.mark.parametrize("budget", ["pages", "time", "text"])
def test_pdf_budget_stop_never_claims_complete(pdfs, monkeypatch, budget):
    if budget == "pages":
        monkeypatch.setattr(extract_module, "MAX_PDF_PAGES", 1)
    elif budget == "time":
        ticks = iter([0.0, 10.0, 20.0, 30.0])
        monkeypatch.setattr(extract_module.time, "monotonic", lambda: next(ticks))
    else:
        monkeypatch.setattr(extract_module, "MAX_PDF_TEXT_CHARS", 1)
    info = extract_document(pdfs / "mixed.pdf", WorkspaceGuard(str(pdfs))).extraction
    assert info["status"] == "partial"
    assert info["examined_pages"] == 1
    assert info["total_pages"] == 2
    assert info["budget_truncation"] == budget


def test_v1_cache_requires_writer_migration_and_reextraction(tmp_path):
    path = tmp_path / "old.db"
    # Exact legacy tables; no new fields are smuggled into the migration fixture.
    with sqlite3.connect(path) as db:
        db.executescript("""
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta VALUES ('schema_version','1');
        CREATE TABLE roots (root_key TEXT PRIMARY KEY,path TEXT NOT NULL,scan_complete_at TEXT);
        CREATE TABLE documents (doc_id INTEGER PRIMARY KEY,root_key TEXT NOT NULL REFERENCES roots(root_key) ON DELETE CASCADE,
          rel_path TEXT NOT NULL,size INTEGER,mtime_ns INTEGER,sha256 TEXT,status TEXT NOT NULL,reason TEXT,
          seen_scan INTEGER NOT NULL DEFAULT 0,updated_at TEXT,UNIQUE(root_key,rel_path));
        CREATE TABLE chunks (chunk_id INTEGER PRIMARY KEY,doc_id INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,locator TEXT NOT NULL,text TEXT NOT NULL,UNIQUE(doc_id,ordinal));
        CREATE TABLE vectors (chunk_id INTEGER NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
          model_key TEXT NOT NULL,dim INTEGER NOT NULL,norm REAL NOT NULL,blob BLOB NOT NULL,PRIMARY KEY(chunk_id,model_key));
        INSERT INTO roots VALUES ('k','/r','done');
        INSERT INTO documents VALUES(1,'k','mixed.pdf',1,1,'old','indexed',NULL,1,'old');
        INSERT INTO chunks VALUES(1,1,0,'p1','stale');
        """)
    with pytest.raises(CatalogStoreError):
        CatalogStore(path, read_only=True)
    store = CatalogStore(path)
    assert store.schema_version == 3  # v1 migrates straight to the current schema
    assert store.counts("m")["chunks"] == 0
    assert store.pending_documents(1)[0].rel_path == "mixed.pdf"
    assert store.roots()[0].scan_complete_at is None
    store.close()
    CatalogStore(path, read_only=True).close()


def _catalog(pdfs, tmp_path):
    store = CatalogStore(tmp_path / "catalog.db")
    catalog = SemanticCatalog(store, FakeProvider(), model_key="test", query_template="{text}",
                              document_template="{text}", dims=64)
    for _ in range(30):
        step = catalog.index_step([CatalogRootSpec(str(pdfs))], max_chunks=16, max_seconds=1.5, rescan=False)
        assert step.error is None
        if not step.more:
            break
    else:
        pytest.fail("catalog did not settle")
    return catalog


def test_search_view_and_changed_citation_keep_the_same_source(pdfs, tmp_path, monkeypatch):
    catalog = _catalog(pdfs, tmp_path)
    monkeypatch.setattr(reader, "search_catalog", catalog.search)
    # Fusion imports the reader call by name, retaining its admitted-root arguments.
    from sidecar.ai.tools.builtins.knowledge import semantic_fusion
    monkeypatch.setattr(semantic_fusion, "search_catalog", catalog.search)
    configure_knowledge_tools({"tools_knowledge_enabled": True, "knowledge_roots": [str(pdfs)]},
                              rich_adapters={"pdf": pdf_inspect_tool})
    try:
        found = json.loads(knowledge_search_tool({"query":"invoice total"}, WorkspaceGuard(None)).output)
        notices = {row["path"]:row for row in found["source_statuses"]}
        assert notices["pdfs/scan.pdf"]["extraction"]["reason"] == "needs_ocr"
        source = next(s for s in found["sources"] if s["path"] == "pdfs/mixed.pdf")
        assert source["extraction"]["pages_without_text"] == [2]
        args = {"path":source["path"],"expected_source_hash":source["source_hash"]}
        viewed = knowledge_view_tool(args, WorkspaceGuard(None))
        body = json.loads(viewed.output)
        assert body["extraction"]["status"] == "partial"
        assert body["extraction"]["pages_without_text"] == [2]
        assert body["source_hash"] == source["source_hash"]
        (pdfs / "mixed.pdf").write_bytes(b"%PDF-1.4 changed")
        stale = knowledge_view_tool(args, WorkspaceGuard(None))
        assert not stale.success
        assert json.loads(stale.output)["reason"] == "source_changed"
        found = json.loads(knowledge_search_tool({"query":"invoice total"}, WorkspaceGuard(None)).output)
        assert all(s["path"] != "pdfs/mixed.pdf" for s in found["sources"])
        (pdfs / "scan.pdf").unlink()
        found = json.loads(knowledge_search_tool({"query":"invoice total"}, WorkspaceGuard(None)).output)
        assert all(s["path"] != "pdfs/scan.pdf" for s in found["source_statuses"])
    finally:
        catalog.close()



def test_unavailable_status_survives_embedder_failure_but_not_scope_filters(pdfs, tmp_path, monkeypatch):
    from sidecar.ai.tools.builtins.knowledge import semantic_fusion
    catalog = _catalog(pdfs, tmp_path)
    catalog._provider.fail_with = RuntimeError("offline")
    monkeypatch.setattr(semantic_fusion, "search_catalog", catalog.search)
    configure_knowledge_tools({"knowledge_roots": [str(pdfs)]})
    try:
        args = {"query": "invoice", "include_glob": "scan.pdf"}
        body = json.loads(knowledge_search_tool(args, WorkspaceGuard(None)).output)
        assert [r["path"] for r in body["source_statuses"]] == ["pdfs/scan.pdf"]
        assert body["source_statuses"][0]["extraction"]["status"] == "unavailable"
        args["path"] = "pdfs/mixed.pdf"
        body = json.loads(knowledge_search_tool(args, WorkspaceGuard(None)).output)
        assert not body.get("source_statuses")
    finally:
        catalog.close()


def test_view_detects_source_change_during_adapter_read(pdfs):
    from sidecar.ai.tools.contracts import ToolHandlerResult
    path = pdfs / "mixed.pdf"
    expected = hashlib.sha256(path.read_bytes()).hexdigest()
    def changing(_args, _guard):
        path.write_bytes(b"changed while reading")
        return ToolHandlerResult(output=json.dumps({"summary":{"page_count":1,"pages":[]}}))
    configure_knowledge_tools({"knowledge_roots":[str(pdfs)]}, rich_adapters={"pdf":changing})
    result = knowledge_view_tool({"path":"pdfs/mixed.pdf","expected_source_hash":expected}, WorkspaceGuard(None))
    assert not result.success
    assert json.loads(result.output)["sources"] == []
    assert json.loads(result.output)["reason"] == "source_changed"


def test_pdf_view_window_and_output_budget_remain_explicit(pdfs):
    configure_knowledge_tools({"knowledge_roots":[str(pdfs)]}, rich_adapters={"pdf":pdf_inspect_tool})
    result = knowledge_view_tool({"path":"pdfs/mixed.pdf","pages":"1"}, WorkspaceGuard(None))
    receipt = json.loads(result.output)
    assert receipt["extraction"]["status"] == "partial"
    assert receipt["extraction"]["budget_truncation"] == "view_window"
    assert receipt["extraction"]["examined_pages"] == 1
    assert len(result.output.encode()) <= 20000


def test_embedding_failure_retains_pdf_completeness(pdfs, tmp_path):
    catalog = _catalog(pdfs, tmp_path)
    store = catalog._store
    try:
        root = store.roots()[0].root_key
        with store._lock:
            doc_id = store._connection.execute("SELECT doc_id FROM documents WHERE rel_path='mixed.pdf'").fetchone()[0]
        store.mark_document(doc_id, "failed", "embed_failed")
        notices = {rel: json.loads(info) for _, rel, info in store.incomplete_sources([root])}
        assert notices["mixed.pdf"]["pages_without_text"] == [2]
        assert notices["mixed.pdf"]["source_hash"] == hashlib.sha256((pdfs / "mixed.pdf").read_bytes()).hexdigest()
    finally:
        catalog.close()


def test_view_distinguishes_existing_ocr_from_missing_native_text(pdfs):
    from sidecar.ai.tools.contracts import ToolHandlerResult
    def inspected(_args, _guard):
        return ToolHandlerResult(output=json.dumps({"summary": {
            "page_count": 2, "truncated": True, "pages": [{"page": 2,
            "text_layer": False, "ocr": True, "ocr_engine": "tesseract",
            "text_excerpt": "Invoice total 44.25 USD"}]}}))
    configure_knowledge_tools({"knowledge_roots": [str(pdfs)]}, rich_adapters={"pdf": inspected})
    result = knowledge_view_tool({"path": "pdfs/mixed.pdf", "pages": "2"}, WorkspaceGuard(None))
    info = json.loads(result.output)["extraction"]
    assert info["status"] == "partial"
    assert info["reason"] == "budget_truncated"
    assert info["content_kind"] == "pdf_text_with_ocr"
    assert info["pages_without_text"] == [2]
    assert info["supplemental_ocr"] == [{"page": 2, "engine": "tesseract"}]


@pytest.mark.parametrize("scope", [
    {"path": "pdfs/scan.pdf"},
    {"root": "pdfs", "include_glob": "scan.pdf"},
])
def test_regex_search_retains_scoped_pdf_status_without_embedding(pdfs, tmp_path, monkeypatch, scope):
    from sidecar.ai.config_models import SemanticCatalogConfig

    catalog = _catalog(pdfs, tmp_path)
    catalog.close()
    provider = FakeProvider()
    provider.fail_with = AssertionError("Regex status lookup must not embed")
    monkeypatch.setattr(reader, "OpenAICompatibleEmbeddingProvider", lambda *_args, **_kw: provider)
    reader.configure_catalog_reader(SemanticCatalogConfig(
        enabled=True, db_path=str(tmp_path / "catalog.db"),
        base_url="http://127.0.0.1:50123/v1", model_key="test",
        query_template="{text}", document_template="{text}", dims=64))
    configure_knowledge_tools({"knowledge_roots": [str(pdfs)]})
    args = {"pattern": "balance", **scope}
    body = json.loads(knowledge_search_tool(args, WorkspaceGuard(None)).output)
    assert [r["path"] for r in body["source_statuses"]] == ["pdfs/scan.pdf"]
    assert body["source_statuses"][0]["extraction"]["reason"] == "needs_ocr"
    assert body["sources"] == []  # A coverage notice is not a match/citation.
    assert not body.get("passages")
    assert "Regex matching skips binary files" in body["note"]
    assert "not OCR availability" in body["note"]
    assert "knowledge_view" in body["note"]
    assert provider.calls == []
    (pdfs / "scan.pdf").write_bytes(b"changed source")
    body = json.loads(knowledge_search_tool(args, WorkspaceGuard(None)).output)
    assert not body.get("source_statuses")
    (pdfs / "scan.pdf").unlink()
    if "path" in scope:
        from sidecar.ai.tools.contracts import ToolExecutionFailure
        with pytest.raises(ToolExecutionFailure, match="path does not exist"):
            knowledge_search_tool(args, WorkspaceGuard(None))
    else:
        body = json.loads(knowledge_search_tool(args, WorkspaceGuard(None)).output)
        assert not body.get("source_statuses")
    assert provider.calls == []


def _citation_check():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "r1_citation_check", REPO / "scripts/eval/retrieval-baseline/citation_check.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_lexical_only_source_carries_identity_and_locator_kind(pdfs):
    (pdfs / "notes.md").write_text("invoice total 12 USD\n", encoding="utf-8")
    configure_knowledge_tools({"knowledge_roots": [str(pdfs)]})
    body = json.loads(knowledge_search_tool({"pattern": "invoice"}, WorkspaceGuard(None)).output)
    source = next(s for s in body["sources"] if s["path"] == "pdfs/notes.md")
    assert source["source_hash"] == hashlib.sha256((pdfs / "notes.md").read_bytes()).hexdigest()
    assert source["locator_kind"] == "lines"
    assert "identity_truncated" not in body


def test_lexical_identity_is_capped_and_reports_truncation(pdfs):
    from sidecar.ai.tools.builtins.knowledge import search as search_module
    assert search_module.MAX_LEXICAL_SOURCE_HASHES == 16
    for index in range(18):
        (pdfs / f"note-{index:02d}.md").write_text(f"needle {index}\n", encoding="utf-8")
    configure_knowledge_tools({"knowledge_roots": [str(pdfs)]})
    body = json.loads(knowledge_search_tool(
        {"pattern": "needle", "max_results": 500}, WorkspaceGuard(None)).output)
    assert len(body["sources"]) == 18
    pinned = [s for s in body["sources"] if "source_hash" in s]
    assert len(pinned) == 16
    assert all(s["locator_kind"] == "lines" for s in pinned)
    assert not any("locator_kind" in s for s in body["sources"] if "source_hash" not in s)
    assert body["identity_truncated"] is True


def test_page_locator_view_keeps_needs_ocr_and_an_ocr_claim_is_rejected(pdfs, monkeypatch):
    # Q46 shape: page 2 of mixed.pdf has no native text; with OCR unavailable the
    # receipt says needs_ocr, so an answer claiming OCR provenance must fail.
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR", "0")
    configure_knowledge_tools({"knowledge_roots": [str(pdfs)]}, rich_adapters={"pdf": pdf_inspect_tool})
    viewed = knowledge_view_tool({"path": "pdfs/mixed.pdf", "locator": "p2"}, WorkspaceGuard(None))
    receipt = json.loads(viewed.output)
    assert receipt["summary"]["selected_pages"] == [2]
    assert receipt["extraction"]["reason"] == "needs_ocr"
    assert receipt["extraction"]["pages_without_text"] == [2]
    assert "supplemental_ocr" not in receipt["extraction"]
    checker = _citation_check()
    # The view part the model receives carries the summary (answers.context shape).
    parts = [{"passages": []}, {"path": "pdfs/mixed.pdf", "success": viewed.success,
                                "content": json.dumps(receipt["summary"]), "truncated": False}]
    claim = [{"path": "pdfs/mixed.pdf", "locator": "p2", "provenance": "OCR"}]
    verdict = checker.check_answer_sources(claim, checker.supplied_evidence(parts))
    assert verdict["status"] == "invalid"
    assert [p["problem"] for p in verdict["problems"]] == ["ocr_claim_unsupported"]
    plain = checker.check_answer_sources(["pdfs/mixed.pdf:p2"], checker.supplied_evidence(parts))
    assert plain["status"] == "ok"
    beyond = knowledge_view_tool({"path": "pdfs/mixed.pdf", "locator": "p9"}, WorkspaceGuard(None))
    assert json.loads(beyond.output)["reason"] == "locator_out_of_range"
