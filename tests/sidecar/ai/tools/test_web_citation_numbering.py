"""Turn-wide web citation numbering: the pure rewrite of a web tool's JSON output."""

from __future__ import annotations

import json

from sidecar.ai.tools.builtins.web_citation_numbering import offset_web_citations


def _payload(*ids: str) -> dict[str, object]:
    return {
        "query": "q",
        "sources": [
            {"url": f"https://example.com/{i}", "title": f"T{i}"} for i, _ in enumerate(ids)
        ],
        "citations": [
            {"id": cid, "url": f"https://example.com/{i}", "title": f"T{i}"}
            for i, cid in enumerate(ids)
        ],
    }


def test_offset_zero_keeps_text_and_reports_the_highest_number() -> None:
    text = json.dumps(_payload("web:1", "web:2", "web:3"))

    rewritten, highest = offset_web_citations(text, 0)

    assert rewritten == text
    assert highest == 3


def test_offset_shifts_every_id_and_records_the_offset() -> None:
    text = json.dumps(_payload("web:1", "web:2"))

    rewritten, highest = offset_web_citations(text, 3)

    data = json.loads(rewritten)
    assert [c["id"] for c in data["citations"]] == ["web:4", "web:5"]
    assert data["citation_offset"] == 3
    assert highest == 5
    # Nothing else moved.
    assert data["sources"] == json.loads(text)["sources"]
    assert [c["url"] for c in data["citations"]] == [
        c["url"] for c in json.loads(text)["citations"]
    ]


def test_non_ascii_text_stays_unescaped() -> None:
    payload = _payload("web:1")
    payload["answer"] = "café"

    rewritten, _highest = offset_web_citations(json.dumps(payload, ensure_ascii=False), 2)

    assert "café" in rewritten


def test_a_gap_in_ids_counts_the_highest_one() -> None:
    text = json.dumps(_payload("web:2", "web:5"))

    rewritten, highest = offset_web_citations(text, 4)

    assert [c["id"] for c in json.loads(rewritten)["citations"]] == ["web:6", "web:9"]
    assert highest == 9


def test_citation_free_and_non_json_output_comes_back_unchanged() -> None:
    for text in (
        json.dumps({"ok": False, "error": "boom", "citations": [], "sources": []}),
        json.dumps({"ok": True}),
        json.dumps(["not", "an", "object"]),
        "Tool 'web_search' failed: timeout.",
        '{"citations": [{"id": "web:1", "url": "https://e',  # truncated, invalid JSON
        "",
    ):
        assert offset_web_citations(text, 7) == (text, 7)


def test_ids_that_are_not_web_markers_are_left_alone() -> None:
    payload = {"citations": [{"id": "web:1", "url": "u"}, {"id": "doc:9"}, {"id": 4}, "x"]}

    rewritten, highest = offset_web_citations(json.dumps(payload), 2)

    ids = [c.get("id") for c in json.loads(rewritten)["citations"] if isinstance(c, dict)]
    assert ids == ["web:3", "doc:9", 4]
    assert highest == 3


def test_a_payload_with_only_foreign_ids_is_unchanged() -> None:
    text = json.dumps({"citations": [{"id": "doc:9"}]})

    assert offset_web_citations(text, 5) == (text, 5)
