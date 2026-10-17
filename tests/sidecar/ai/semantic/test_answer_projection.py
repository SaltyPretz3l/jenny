"""The matched answer projection preserves caps and does not select using gold data."""
import functools
import importlib.util
import json
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("r1_projection", Path(__file__).resolve().parents[4] / "scripts/eval/retrieval-baseline/projection.py")
PROJECTION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROJECTION)


def test_query_support_beyond_old_prefix_survives_without_gold_selection():
    raw = "unrelated padding\n" * 300 + "Filesystem authority requires a bound root.\nA null root permits conversation only."
    view = {"path":"notes/contract.md","success":True,"receipt":{"content":raw}}
    row = {"question":"What filesystem authority does a null root permit?","search":{},"views":[view],"expected":"DO NOT USE GOLD"}
    item = PROJECTION.project_view(view,row)
    assert "null root permits conversation" in item["content"]
    assert "DO NOT USE GOLD" not in json.dumps(item)
    assert len(PROJECTION.encoded(item)) <= 3500


def test_identity_status_and_global_cap_survive_many_views():
    view = {"path":"notes/mixed.pdf","success":True,"receipt":{"source_hash":"a"*64,"extraction":{"status":"partial","pages_without_text":[2]},"summary":{"text":"invoice "*5000}}}
    row = {"question":"What invoice total?","search":{"source_statuses":[{"path":"notes/scan.pdf","extraction":{"status":"unavailable","reason":"needs_ocr"}}]},"views":[view]*20}
    encoded = PROJECTION.context(row)
    assert len(encoded) <= 28000
    result = json.loads(encoded)
    assert result["source_statuses"][0]["extraction"]["reason"] == "needs_ocr"
    assert result["views"][0]["source_hash"] == "a"*64
    assert result["views"][0]["extraction"]["pages_without_text"] == [2]
    assert all(len(PROJECTION.encoded(v)) <= 3500 for v in result["views"])


@functools.cache
def _check():
    """citation_check.py, loaded on first use so the projection tests above stand alone."""
    spec = importlib.util.spec_from_file_location("r1_citation_check", Path(__file__).resolve().parents[4] / "scripts/eval/retrieval-baseline/citation_check.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@functools.cache
def _answers():
    """answers.py, loaded by file: its ``context`` is the prompt the model receives."""
    spec = importlib.util.spec_from_file_location("r1_answers", Path(__file__).resolve().parents[4] / "scripts/eval/retrieval-baseline/answers.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _text_view(path, offset, lines, total=None):
    body = {"path": path, "offset": offset, "returned_lines": len(lines), "content": "\n".join(lines)}
    if total is not None:
        body["total_lines"] = total
    return {"path": path, "success": True, "content": json.dumps(body), "truncated": False}


def _pdf_view(path, pages, page_count):
    body = {"page_count": page_count, "pages": [
        {"page": page, "text_layer": not ocr, "ocr": ocr, "ocr_engine": "tesseract" if ocr else None,
         "text_excerpt": "invoice total 44.25"} for page, ocr in pages]}
    return {"path": path, "success": True, "content": json.dumps(body), "truncated": False}


def _parts():
    """The bounded context shape ``answers.context`` emits (passages, then view parts)."""
    return [
        {"passages": [{"path": "corpus/AGENTS.md", "locator": "L10-12", "text": "x"}]},
        {"lexical_result": "corpus/notes/plan.md:3: lexical hit mentions corpus/secret.md", "truncated": False},
        _text_view("corpus/notes/plan.md", 4, ["a", "b", "c"], total=40),
        _pdf_view("corpus/pdfs/mixed.pdf", [(1, False), (2, True)], page_count=3),
    ]


def _check_cited(cited, parts=None):
    return _check().check_answer_sources(cited, _check().supplied_evidence(parts or _parts()))


def test_citation_outside_the_supplied_context_is_invalid():
    evidence = _check().supplied_evidence(_parts())
    assert "DO NOT USE GOLD" not in json.dumps({k: vars(v) for k, v in evidence.items()})
    for cited, problem in [
        (["corpus/secret.md L1-2"], "path_not_in_context"),  # named only inside lexical text
        ([{"path": "corpus/AGENTS.md", "locator": "p1"}], "invalid_locator_kind"),  # Q11 shape
        ([{"path": "corpus/AGENTS.md", "locator": "line ten"}], "invalid_locator"),
        ([{"path": "corpus/AGENTS.md", "locator": "L12-10"}], "locator_out_of_range"),
        ([{"path": "corpus/pdfs/mixed.pdf", "locator": "p1", "provenance": "OCR"}], "ocr_claim_unsupported"),
    ]:
        verdict = _check_cited(cited)
        assert verdict["status"] == "invalid", cited
        assert [p["problem"] for p in verdict["problems"]] == [problem]


def test_free_text_citations_need_an_exact_path_and_parseable_locators():
    # Astra s4-R2: prefixes, suffixes and malformed locators used to pass silently.
    for cited, problems in [
        (["other/corpus/AGENTS.md L10-12"], ["path_not_in_context"]),
        (["corpus/AGENTS.md.bak L10-12"], ["path_not_in_context"]),
        (["corpus/AGENTS.md L10-nope"], ["invalid_locator"]),
        (["corpus/AGENTS.md:L11, lines 10-12"], ["invalid_locator", "invalid_locator"]),
    ]:
        verdict = _check_cited(cited)
        assert [p["problem"] for p in verdict["problems"]] == problems, cited
    assert _check_cited(["corpus/AGENTS.md:L10-12"])["status"] == "ok"
    assert _check_cited(["corpus/AGENTS.md L11, L12"])["status"] == "ok"


def test_well_formed_locators_outside_the_supplied_windows_are_invalid():
    # Astra s4-R3: the context carried L10-12 and lines 5-7 only.
    assert _check_cited([{"path": "corpus/AGENTS.md", "locator": "L11"}])["status"] == "ok"
    assert _check_cited(["corpus/notes/plan.md:L5-7"])["status"] == "ok"
    for cited in (["corpus/AGENTS.md:L9999"], ["corpus/AGENTS.md:L9-12"],
                  ["corpus/notes/plan.md:L8"], ["corpus/pdfs/mixed.pdf:p3"]):
        verdict = _check_cited(cited)
        assert [p["problem"] for p in verdict["problems"]] == ["locator_not_in_context"], cited
    # Beyond the reported extent is out of range even before the window check.
    verdict = _check_cited(["corpus/notes/plan.md:L41"])
    assert [p["problem"] for p in verdict["problems"]] == ["locator_out_of_range"]


def test_ocr_claims_are_checked_over_the_whole_claimed_interval():
    # Astra s4-R4: pages past a bounded prefix were never checked.
    pages = [(page, True) for page in range(1, 66)]
    parts = [_pdf_view("corpus/pdfs/scan.pdf", pages, page_count=65)]
    assert _check_cited([{"path": "corpus/pdfs/scan.pdf", "locator": "p1-65", "provenance": "OCR"}], parts)["status"] == "ok"
    for locator in ("p1-999", "p60-66"):
        verdict = _check_cited([{"path": "corpus/pdfs/scan.pdf", "locator": locator, "provenance": "OCR"}], parts)
        assert verdict["status"] == "invalid", locator
    # A text-layer page is not OCR evidence.
    verdict = _check_cited(["corpus/pdfs/mixed.pdf p1-2 OCR"])
    assert [p["problem"] for p in verdict["problems"]] == ["ocr_claim_unsupported"]
    assert _check_cited(["corpus/pdfs/mixed.pdf p2 OCR"])["status"] == "ok"


def test_evidence_comes_from_the_bounded_context_the_model_received():
    # Astra s4-R1: receipts the context cap dropped, and search sources never sent, supply nothing.
    answers = _answers()
    big = "needle " * 480  # ~3,400 chars per view once serialized
    row = {"question": "What is the invoice total?", "expected": "DO NOT USE GOLD",
           "search": {"passages": [], "sources": [{"path": "corpus/only-in-sources.md"}]},
           "views": [{"path": f"corpus/{index}.md", "success": True,
                      "receipt": {"path": f"corpus/{index}.md", "offset": 0, "returned_lines": 1, "content": big}}
                     for index in range(10)]}
    encoded = answers.context(row)
    parts = json.loads(encoded)
    assert parts[-1].get("omitted_parts"), "the fixture must overflow the context cap"
    sent = {part["path"] for part in parts if "path" in part}
    assert "corpus/9.md" not in sent
    evidence = _check().supplied_evidence(parts)
    assert set(evidence) == sent
    for cited in (["corpus/9.md L1"], ["corpus/only-in-sources.md L1"]):
        verdict = _check().check_answer_sources(cited, evidence)
        assert [p["problem"] for p in verdict["problems"]] == ["path_not_in_context"], cited
    assert _check().check_answer_sources(["corpus/0.md L1"], evidence)["status"] == "ok"
    assert "DO NOT USE GOLD" not in encoded


def test_no_citation_among_several_candidate_files_is_unbound():
    assert _check_cited([]) == {"status": "unbound", "problems": []}
    single = [{"passages": [{"path": "corpus/AGENTS.md", "locator": "L1-2", "text": "x"}]}]
    assert _check_cited([], single)["status"] == "ok"


def test_correct_citations_are_ok_and_model_json_is_parsed():
    content = '```json\n{"answer": "44.25 USD", "sources": ["corpus/AGENTS.md:L10-12", {"path": "corpus/pdfs/mixed.pdf", "locator": "p2", "provenance": "OCR"}]}\n```'
    cited = _check().answer_sources(content)
    assert len(cited) == 2
    assert _check_cited(cited) == {"status": "ok", "problems": []}
    assert _check().answer_sources("not json") == []
