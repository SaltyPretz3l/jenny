"""Knowledge PDF pagination through the real read-only adapter."""

from __future__ import annotations

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
