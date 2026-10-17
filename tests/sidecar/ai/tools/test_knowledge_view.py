"""Knowledge view: PDF pagination through the real adapter, source identity and locators."""

from __future__ import annotations

import json

import pytest

from sidecar.ai.tools.builtins.knowledge import configure_knowledge_tools, knowledge_view_tool
from tests.sidecar.ai.tools.test_knowledge import (
    _WORKSPACE,
    _payload,
    _reset_knowledge_state,  # noqa: F401 - autouse pytest fixture
)
from tests.sidecar.ai.tools.test_knowledge import (
    corpus as corpus,  # noqa: PLC0414 - pytest fixture re-export
)


def test_knowledge_pdf_pages_and_cursor_reach_real_adapter(corpus):
    fitz = pytest.importorskip("fitz")
    from sidecar.ai.tools.builtins.rich_files.pdf import pdf_inspect_tool
    path = corpus["root_a"] / "report.pdf"
    document = fitz.open()
    for page_number in range(1, 5):
        page = document.new_page()
        for line in range(1, 61):
            page.insert_text((72, 30 + line * 12), f"page {page_number} line {line} " + "text " * 8)
    document.save(path)
    document.close()
    configure_knowledge_tools({"knowledge_roots": [str(corpus["root_a"])]},
                              rich_adapters={"pdf": pdf_inspect_tool})
    first = knowledge_view_tool({"path": "project-x/report.pdf", "pages": "4",
                                 "create_preview": True, "_jenny_session_id": "forbidden"}, _WORKSPACE)
    summary = _payload(first)["summary"]
    assert summary["selected_pages"] == [4]
    assert first.generated_artifacts == ()
    assert "call knowledge_view again" in summary["continuation_hint"]
    assert first.metadata["summary"]["continuation_hint"] == summary["continuation_hint"]
    second = knowledge_view_tool({"path": "project-x/report.pdf", "cursor": summary["cursor"]}, _WORKSPACE)
    following = _payload(second)["summary"]["pages"][0]
    assert following["page"] == 4
    assert following["lines_from"] == summary["pages"][0]["lines_to"] + 1
    assert _payload(second)["sources"][0]["path"] == "project-x/report.pdf"



@pytest.mark.parametrize("controls", [
    {"pages": 4}, {"cursor": 123}, {"cursor": "bad"},
    {"pages": "1", "cursor": "pdf:0123456789abcdef:1:1"},
])
def test_knowledge_pdf_validates_pagination_controls(corpus, controls):
    from sidecar.ai.tools.builtins.rich_files.pdf import pdf_inspect_tool
    from sidecar.ai.tools.contracts import ToolExecutionFailure

    fitz = pytest.importorskip("fitz")
    document = fitz.open()
    document.new_page().insert_text((72, 72), "PDF content")
    document.save(corpus["root_a"] / "report.pdf")
    document.close()
    configure_knowledge_tools({"knowledge_roots": [str(corpus["root_a"])]},
                              rich_adapters={"pdf": pdf_inspect_tool})
    with pytest.raises(ToolExecutionFailure):
        knowledge_view_tool({"path": "project-x/report.pdf", **controls}, _WORKSPACE)


def _sha256(path) -> str:
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_text_view_returns_its_source_hash(corpus):
    result = knowledge_view_tool({"path": "project-x/spec.md"}, _WORKSPACE)
    payload = _payload(result)
    assert result.success is True
    assert payload["source_hash"] == _sha256(corpus["root_a"] / "spec.md")
    assert payload["sources"][0]["source_hash"] == payload["source_hash"]


def test_text_view_rejects_a_source_changed_since_the_first_view(corpus):
    first = _payload(knowledge_view_tool({"path": "project-x/spec.md"}, _WORKSPACE))
    (corpus["root_a"] / "spec.md").write_text("rewritten\n", encoding="utf-8")
    stale = knowledge_view_tool(
        {"path": "project-x/spec.md", "expected_source_hash": first["source_hash"]}, _WORKSPACE)
    body = _payload(stale)
    assert stale.success is False
    assert body["reason"] == "source_changed"
    assert body["sources"] == []
    assert "rewritten" not in stale.output


def test_page_locator_on_a_text_file_fails_typed_before_any_read(corpus, monkeypatch):
    from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
    from sidecar.ai.tools.builtins.knowledge import view as view_module

    def no_read(*_args, **_kwargs):
        raise AssertionError("an invalid locator must not read the source")

    monkeypatch.setattr(view_module, "open_regular_file", no_read)
    monkeypatch.setattr(view_module, "source_hash", no_read)
    result = knowledge_view_tool({"path": "project-x/spec.md", "locator": "p1"}, _WORKSPACE)
    body = _payload(result)
    assert result.success is False
    assert result.error_code == CMP_TOOL_INVALID_PATH
    assert body["reason"] == "invalid_locator_kind"
    assert body["locator"] == "p1"
    assert body["expected_locator_kind"] == "lines"
    assert body["status"] == "unavailable"
    assert body["sources"] == []
    assert body["missing_source_metadata"] is True
    assert "knowledge_search" in body["message"]
    assert "alpha" not in result.output


def test_line_locator_without_offset_reads_exactly_those_lines(corpus):
    path = corpus["root_a"] / "lines.txt"
    path.write_text("".join(f"line {n}\n" for n in range(1, 6)), encoding="utf-8")
    result = knowledge_view_tool({"path": "project-x/lines.txt", "locator": "L2-3"}, _WORKSPACE)
    body = _payload(result)
    assert result.success is True
    assert body["content"] == "line 2\nline 3"
    assert (body["offset"], body["limit"], body["total_lines"]) == (1, 2, 5)
    assert body["source_hash"] == _sha256(path)


def test_line_locator_past_the_end_fails_after_the_read_without_content(corpus):
    path = corpus["root_a"] / "lines.txt"
    path.write_text("".join(f"line {n}\n" for n in range(1, 41)), encoding="utf-8")
    derived = knowledge_view_tool(
        {"path": "project-x/lines.txt", "locator": "L9999-9999"}, _WORKSPACE)
    explicit = knowledge_view_tool(
        {"path": "project-x/lines.txt", "locator": "L39-45", "offset": 0, "limit": 5}, _WORKSPACE)
    for result in (derived, explicit):
        assert result.success is False
        assert _payload(result)["reason"] == "locator_out_of_range"
        assert "line 1" not in result.output


def test_paragraph_locator_is_checked_against_the_reported_paragraph_count(corpus):
    from sidecar.ai.tools.contracts import ToolHandlerResult

    (corpus["root_a"] / "report.docx").write_bytes(b"fake-docx-bytes")

    def document(_arguments, _guard):
        return ToolHandlerResult(output=json.dumps(
            {"summary": {"paragraph_count": 3, "paragraphs": [{"index": 1, "text_excerpt": "x"}]}}))

    configure_knowledge_tools({"knowledge_roots": [str(corpus["root_a"])]},
                              rich_adapters={"document": document})
    ok = knowledge_view_tool({"path": "project-x/report.docx", "locator": "para3"}, _WORKSPACE)
    assert ok.success is True
    assert _payload(ok)["source_hash"] == _sha256(corpus["root_a"] / "report.docx")
    beyond = knowledge_view_tool({"path": "project-x/report.docx", "locator": "para4"}, _WORKSPACE)
    assert _payload(beyond)["reason"] == "locator_out_of_range"
    kind = knowledge_view_tool({"path": "project-x/report.docx", "locator": "L1-2"}, _WORKSPACE)
    assert _payload(kind)["expected_locator_kind"] == "paragraphs"


@pytest.mark.parametrize("blank", ["", "   "])
def test_a_supplied_blank_locator_is_invalid_before_any_read(corpus, monkeypatch, blank):
    # Astra s4-R5: an explicit empty locator used to count as omitted and read the file.
    from sidecar.ai.tools.builtins.knowledge import view as view_module

    def no_read(*_args, **_kwargs):
        raise AssertionError("a blank locator must not read the source")

    monkeypatch.setattr(view_module, "open_regular_file", no_read)
    monkeypatch.setattr(view_module, "source_hash", no_read)
    result = knowledge_view_tool({"path": "project-x/spec.md", "locator": blank}, _WORKSPACE)
    body = _payload(result)
    assert result.success is False
    assert body["reason"] == "invalid_locator"
    assert body["sources"] == []
    assert "alpha" not in result.output
