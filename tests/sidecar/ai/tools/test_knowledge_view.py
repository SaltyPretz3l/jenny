"""Knowledge view: PDF pagination through the real adapter, source identity and locators."""

from __future__ import annotations

import json

import fitz
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


def _rewrite(path, text: str) -> None:
    """Change content AND mtime, so a stat-keyed memo cannot mask the edit."""
    import os

    previous = path.stat().st_mtime_ns
    path.write_text(text, encoding="utf-8")
    os.utime(path, ns=(previous + 2_000_000_000, previous + 2_000_000_000))


def test_text_view_rejects_a_source_changed_since_the_first_view(corpus):
    first = _payload(knowledge_view_tool({"path": "project-x/spec.md"}, _WORKSPACE))
    _rewrite(corpus["root_a"] / "spec.md", "rewritten\n")
    stale = knowledge_view_tool(
        {"path": "project-x/spec.md", "expected_source_hash": first["source_hash"]}, _WORKSPACE)
    body = _payload(stale)
    assert stale.success is False
    assert body["reason"] == "source_changed"
    assert body["sources"] == []
    assert "rewritten" not in stale.output


def test_paging_an_unchanged_source_hashes_it_once(corpus, monkeypatch):
    from sidecar.ai.tools.builtins.knowledge import view as view_module

    path = corpus["root_a"] / "paged.md"
    path.write_text("".join(f"line {n}\n" for n in range(1, 30)), encoding="utf-8")
    real_hash = view_module.source_hash
    calls: list[object] = []

    def counting_hash(*args, **kwargs):
        calls.append(args[0])
        return real_hash(*args, **kwargs)

    monkeypatch.setattr(view_module, "source_hash", counting_hash)
    first = _payload(knowledge_view_tool({"path": "project-x/paged.md", "limit": 10}, _WORKSPACE))
    second = _payload(knowledge_view_tool(
        {"path": "project-x/paged.md", "offset": 10, "limit": 10,
         "expected_source_hash": first["source_hash"]}, _WORKSPACE))

    assert second["content"].startswith("line 11")
    assert second["source_hash"] == first["source_hash"] == _sha256(path)
    assert len(calls) == 1

    _rewrite(path, "changed\n")
    third = _payload(knowledge_view_tool({"path": "project-x/paged.md"}, _WORKSPACE))
    assert third["source_hash"] == _sha256(path)
    assert len(calls) == 2


def test_a_source_rewritten_during_the_read_is_rejected(corpus, monkeypatch):
    from sidecar.ai.tools.builtins.knowledge import view as view_module

    path = corpus["root_a"] / "spec.md"
    real_view_text = view_module._view_text

    def rewriting_read(*args, **kwargs):
        result = real_view_text(*args, **kwargs)
        _rewrite(path, "rewritten mid-read\n")
        return result

    monkeypatch.setattr(view_module, "_view_text", rewriting_read)
    result = knowledge_view_tool({"path": "project-x/spec.md"}, _WORKSPACE)

    assert result.success is False
    assert _payload(result)["reason"] == "source_changed"


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


def test_knowledge_docx_cursor_reaches_the_adapter_and_names_knowledge_view(corpus):
    from sidecar.ai.tools.contracts import ToolHandlerResult

    (corpus["root_a"] / "memo.docx").write_bytes(b"fake-docx-bytes")
    seen: list[dict[str, object]] = []

    def document(arguments, _guard):
        seen.append(dict(arguments))
        hint = "To continue, call read_file again with the same path and cursor=docx:x:41."
        return ToolHandlerResult(output=json.dumps(
            {"summary": {"paragraph_count": 60, "continuation_hint": hint}}))

    configure_knowledge_tools({"knowledge_roots": [str(corpus["root_a"])]},
                              rich_adapters={"document": document})
    result = knowledge_view_tool(
        {"path": "project-x/memo.docx", "cursor": "docx:0123456789abcdef:41", "pages": "1"},
        _WORKSPACE,
    )

    assert seen == [{"path": "memo.docx", "cursor": "docx:0123456789abcdef:41"}]
    assert "call knowledge_view again" in _payload(result)["summary"]["continuation_hint"]
