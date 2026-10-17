"""R0 packet integrity and real search/view contracts with deterministic embeddings."""

from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path

import pytest

from tests.sidecar.ai.semantic.fakes import FakeProvider

REPO = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location(
    "retrieval_baseline", REPO / "scripts/eval/retrieval-baseline/run.py"
)
assert SPEC and SPEC.loader
BASELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASELINE)



@pytest.fixture
def snapshot_root():
    # The production runner intentionally refuses snapshots outside repo .tmp.
    parent = REPO / ".tmp"
    parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="retrieval-contract-", dir=parent) as directory:
        yield Path(directory)


def test_packet_has_sixty_questions_and_thirty_six_disjoint_cases():
    packet = json.loads((BASELINE.FIXTURES / "packet.json").read_text(encoding="utf-8"))
    assert len(packet["questions"]) == 60
    assert len({q["id"] for q in packet["questions"]}) == 60
    assert len({q["case"] for q in packet["questions"]}) == 36
    assert {
        lane: len({q["case"] for q in packet["questions"] if q["case"].startswith(lane)})
        for lane in ("P", "C", "D", "V", "I")
    } == {"P": 8, "C": 8, "D": 8, "V": 6, "I": 6}


def test_generated_snapshots_cannot_escape_ignored_output():
    with pytest.raises(ValueError, match="repository .tmp"):
        BASELINE.prepare(REPO / ".tmp" / ".." / "outside")


def test_fixture_tampering_is_rejected_before_indexing(tmp_path, snapshot_root, monkeypatch):
    packet = json.loads((BASELINE.FIXTURES / "packet.json").read_text(encoding="utf-8"))
    packet["source_files"] = {}
    packet["fixture_files"] = {"tampered.txt": "0" * 64}
    fixture = tmp_path / "fixtures"
    fixture.mkdir()
    (fixture / "packet.json").write_text(json.dumps(packet), encoding="utf-8")
    (fixture / "tampered.txt").write_text("changed", encoding="utf-8")
    monkeypatch.setattr(BASELINE, "FIXTURES", fixture)
    with pytest.raises(ValueError, match="Fixture hash mismatch"):
        BASELINE.prepare(snapshot_root / "snapshot")


def test_real_catalog_reader_preserves_freshness_deletion_and_scope(snapshot_root, monkeypatch):
    from sidecar.ai.semantic import reader

    monkeypatch.setattr(
        BASELINE,
        "OpenAICompatibleEmbeddingProvider",
        lambda *_args, **_kwargs: FakeProvider(dim=256),
    )
    monkeypatch.setattr(
        reader, "OpenAICompatibleEmbeddingProvider", lambda *_args, **_kwargs: FakeProvider(dim=256)
    )
    output = snapshot_root / "deterministic"
    output.mkdir()
    summary = BASELINE.run(output, "http://127.0.0.1:1/v1", {"Q55", "Q56", "Q57", "Q59", "Q60"})
    assert summary["hard_failures"] == []
    rows = json.loads((output / "results.json").read_text(encoding="utf-8"))
    assert len(rows) == 5
    assert all(not row["views"][-1]["success"] for row in rows if row["id"] in {"Q57", "Q59"})
    assert "NEW-TAG" in json.dumps(rows[0])
    assert all(
        "integrity/deleted.md" not in source["path"] for source in rows[1]["search"]["sources"]
    )



def _answer_module():
    spec = importlib.util.spec_from_file_location(
        "retrieval_answers", REPO / "scripts/eval/retrieval-baseline/answers.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_answer_context_selects_late_query_evidence_without_gold_and_keeps_caps():
    module = _answer_module()
    lines = ["Unrelated opening material " * 10 for _ in range(60)]
    lines[43] = "tool.request_approval blocks until explicit approve/deny."
    row = {"question": "When does tool.request_approval unblock?", "expected": "GOLD-SECRET",
           "required_terms": ["GOLD-SECRET"], "search": {"passages": [],
           "result": "corpus/policy.md:44:tool.request_approval requires explicit approval."},
           "views": [{"path": "corpus/policy.md", "success": True,
                      "receipt": {"offset": 0, "content": "\n".join(lines)}}]}
    encoded = module.context(row)
    assert "explicit approve/deny" in encoded
    assert "L44" in encoded
    assert "requires explicit approval" in encoded
    assert "GOLD-SECRET" not in encoded
    assert len(encoded) <= 28000
    parts = json.loads(encoded)
    assert all(len(part["content"]) <= 3500 for part in parts if "content" in part)
    assert module.context({**row, "expected": "DIFFERENT", "required_terms": []}) == encoded


def test_context_overflow_remains_valid_json_and_reports_omitted_views():
    module = _answer_module()
    row = {"question": "alpha", "search": {"passages": []},
           "views": [{"path": f"corpus/{i}.txt", "success": True,
                      "receipt": {"content": ("alpha " * 30 + "\n") * 100}} for i in range(40)]}
    encoded = module.context(row)
    parts = json.loads(encoded)
    assert len(encoded) <= 28000
    assert any(part.get("omitted_parts", 0) > 0 for part in parts)
    assert all(len(part["content"]) <= 3500 for part in parts if "content" in part)


def test_expansion_uses_returned_locator_without_changing_top_five_or_gold(tmp_path, monkeypatch):
    from types import SimpleNamespace

    payload = {"sources": [{"path": f"corpus/{i}.txt"} for i in range(7)],
               "passages": [{"path": "corpus/0.txt", "locator": "L140-145", "text": "alpha"}]}
    monkeypatch.setattr(BASELINE, "knowledge_search_tool",
                        lambda *_: SimpleNamespace(output=json.dumps(payload)))
    calls = []
    def view(arguments):
        calls.append(dict(arguments))
        return {"success": True, "receipt": {"content": "alpha"}}
    monkeypatch.setattr(BASELINE, "invoke_view", view)
    question = {"id": "Q-test", "case": "P-test", "question": "alpha", "path": "6.txt",
                "required_terms": [], "expected": "GOLD-SECRET", "outcome": "answer"}
    result = BASELINE.evaluate(question, tmp_path)
    assert len(calls) == 5
    assert [call["path"] for call in calls] == [f"corpus/{i}.txt" for i in range(5)]
    assert 0 < calls[0]["offset"] < 140
    assert calls[0]["limit"] == 500
    assert result["recall_at_5"] == 0



def test_answer_excerpt_keeps_declaration_for_referenced_budget_constant(snapshot_root):
    module = _answer_module()
    packet, root = BASELINE.prepare(snapshot_root / "snapshot")
    question = next(row["question"] for row in packet["questions"] if row["id"] == "Q26")
    path = "services/semantic-catalog-service.js"
    lines = (root / path).read_text(encoding="utf-8").splitlines()[:500]
    row = {"question": question, "search": {"passages": [
        {"path": path, "locator": "L1-29"}, {"path": path, "locator": "L426-455"},
        {"path": path, "locator": "L547-580"},
    ]}, "views": [{"path": path, "success": True,
                    "receipt": {"offset": 0, "content": "\n".join(lines)}}]}
    encoded = module.context(row)
    assert "const STEP_MAX_SECONDS = 1.5;" in encoded
    assert "const STEP_MAX_CHUNKS = 16;" in encoded
    assert len(json.loads(encoded)[1]["content"]) <= 3500
